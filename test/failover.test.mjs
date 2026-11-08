import assert from "node:assert/strict";
import test from "node:test";

import failover, {
	CONTINUE_TEXT,
	DEFAULT_BACKOFF_MS,
	MAX_TIMER_MS,
	WAKE_RETRY_MS,
	cacheEntriesFor,
	cachedSettings,
	classifyUsageLimit,
	lastAssistant,
	parseModelSpec,
	planFailover,
	readFailoverSettings,
	selectNextModel,
	specOf,
	usageExhausted,
	usageResetAt,
	wakeDelayMs,
} from "../extensions/failover/index.ts";
// provider-usage owns the cache's shape: build the entries with its own code so
// these tests read what the real usage-cache.json holds, not a convenient mock.
import { codexDisplay, opencodeGoDisplay, parseOpencodeGoUsage } from "../extensions/provider-usage/index.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-07T12:00:00Z");
const QUIET_STATE = Symbol.for("pi-boehsline.quiet");
const QUIET_ATTENTION_EVENT = "quiet:attention";

/** An assistant message entry as the session stores one. */
const assistant = (over = {}) => ({
	type: "message",
	id: "m1",
	message: {
		role: "assistant",
		content: [],
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage: "GoUsageLimitError: weekly usage limit reached",
		...over,
	},
});

/** provider-usage's cache, keyed per driver, as this extension reads it. */
const limitCache = (resetMs = NOW + 2 * HOUR) => ({
	"claude-window:opus": {
		value: "2.2/7D: 47%",
		resetMs,
		quota: { usedPercent: 47 },
		windows: [
			{ label: "5h", percent: 100, resets_at: new Date(resetMs).toISOString() },
			{ label: "week", percent: 47, resets_at: new Date(NOW + 72 * HOUR).toISOString() },
		],
		fetchedAt: NOW,
	},
});

const iso = (ms) => new Date(ms).toISOString();

/** provider-usage's writeSharedEntry: a display plus when it was fetched. */
const cacheEntry = (display, fetchedAt = NOW) => ({
	value: display.value,
	...(display.commandText !== undefined ? { commandText: display.commandText } : {}),
	...(display.resetMs !== undefined ? { resetMs: display.resetMs } : {}),
	...(display.windows !== undefined ? { windows: display.windows } : {}),
	fetchedAt,
});

/** The opencode-go entry provider-usage writes, from its own usage API shape. */
const opencodeGoCache = ({ percent, resetMs }, weeklyPercent = 42) => ({
	"opencode-go-window": cacheEntry(
		opencodeGoDisplay(
			parseOpencodeGoUsage({
				usage: {
					rolling: { status: "ok", percent, resetsAt: iso(resetMs) },
					weekly: { status: "ok", percent: weeklyPercent, resetsAt: iso(NOW + 72 * HOUR) },
				},
			}),
		),
	),
});

/** The codex entry provider-usage writes, from its own `/usage` shape. */
const codexCache = ({ percent, resetMs }) => ({
	"codex-window": cacheEntry(
		codexDisplay(
			{
				rate_limit: {
					primary_window: {
						used_percent: percent,
						reset_at: Math.floor(resetMs / 1000),
						limit_window_seconds: 5 * 3_600,
					},
				},
			},
			NOW,
		),
	),
});

function stubPi() {
	const handlers = new Map();
	const listeners = new Map();
	const tools = new Map();
	const emitted = [];
	const pi = {
		on(event, handler) {
			const bucket = handlers.get(event) ?? [];
			bucket.push(handler);
			handlers.set(event, bucket);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		sendMessage() {},
		sendUserMessage(text) {
			pi.sent.push(text);
			// pi emits an input event for our own message too, with source "extension";
			// the extension's budget must survive it.
			for (const fn of handlers.get("input") ?? []) {
				fn({ type: "input", text, source: "extension" }, undefined);
			}
			return pi.sendImpl?.();
		},
		sendImpl: undefined,
		setModel: async (model) => {
			pi.setCalls.push(`${model.provider}/${model.id}`);
			return pi.setModelImpl(model);
		},
		setModelImpl: async () => true,
		setCalls: [],
		sent: [],
		events: {
			on(channel, fn) {
				const bucket = listeners.get(channel) ?? new Set();
				bucket.add(fn);
				listeners.set(channel, bucket);
				return () => bucket.delete(fn);
			},
			emit(channel, data) {
				emitted.push({ channel, data });
				for (const fn of [...(listeners.get(channel) ?? [])]) fn(data);
			},
		},
	};
	const fire = async (event, payload, ctx) => {
		const results = [];
		for (const fn of handlers.get(event) ?? []) results.push(await fn(payload, ctx));
		return results;
	};
	return { pi, fire, tools, emitted };
}

const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Mount the extension with fake pi, fake clock, fake cache. `known`/`auth`
 * default to every chain entry, so a test names only the exceptions.
 */
function mount({
	chain = [],
	enabled = true,
	maxSwitches,
	cache = {},
	known,
	auth,
	setFails = [],
	setRejects = [],
	sendRejects = false,
	idle = true,
} = {}) {
	const state = {
		now: NOW,
		idle,
		/** Messages queued in pi, waiting for the current run to end. */
		pending: false,
		/** What Eric has typed but not sent. */
		editor: "",
		model: (() => {
			const spec = parseModelSpec(chain[0]);
			return spec ? { provider: spec.provider, id: spec.model } : undefined;
		})(),
	};
	const knownSpecs = new Set(known ?? chain);
	const authSpecs = new Set(auth ?? chain);
	/** How the outside world misbehaves, and how often settings are re-read. */
	const behavior = { settingsThrows: false, settingsMtime: 1000, settingsReads: 0 };
	const settings = { chain, enabled: enabled && chain.length > 0, maxSwitches: maxSwitches ?? 3 };
	const { pi, fire, emitted } = stubPi();
	pi.setModelImpl = async (model) => {
		const spec = `${model.provider}/${model.id}`;
		if (setRejects.includes(spec)) throw new Error(`no auth for ${spec}`);
		if (setFails.includes(spec)) return false;
		state.model = model;
		return true;
	};
	if (sendRejects) {
		pi.sendImpl = async () => {
			throw new Error("the session went away");
		};
	}

	const timers = [];
	let nextTimer = 1;
	failover(pi, {
		now: () => state.now,
		setTimeout: (handler, delayMs) => {
			const id = nextTimer++;
			timers.push({ id, handler, delayMs, cleared: false });
			return id;
		},
		clearTimeout: (id) => {
			const timer = timers.find((candidate) => candidate.id === id);
			if (timer) timer.cleared = true;
		},
		readUsageCache: () => cache,
		readSettings: () => {
			behavior.settingsReads += 1;
			if (behavior.settingsThrows) throw new Error("boehsline.json is not valid JSON");
			return settings;
		},
		configMtimeMs: () => behavior.settingsMtime,
	});

	/** Every settle gets a fresh entry id, as a real session does. */
	let entrySeq = 0;
	let branch = [];
	const notes = [];
	const ctx = {
		get model() {
			return state.model;
		},
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/work",
		ui: { notify: (text, type) => notes.push({ text, type }), getEditorText: () => state.editor },
		hasPendingMessages: () => state.pending,
		sessionManager: { getBranch: () => branch },
		modelRegistry: {
			find: (provider, id) => (knownSpecs.has(`${provider}/${id}`) ? { provider, id } : undefined),
			hasConfiguredAuth: (model) => authSpecs.has(`${model.provider}/${model.id}`),
		},
		isIdle: () => state.idle,
	};

	const h = {
		pi,
		ctx,
		state,
		notes,
		timers,
		emitted,
		settings,
		behavior,
		/** Let a model that had no auth become usable. */
		allowAuth: (spec) => authSpecs.add(spec),
		setBranch: (entries) => {
			branch = entries;
		},
		setMode: (mode) => {
			ctx.mode = mode;
		},
		advance: (ms) => {
			state.now += ms;
		},
		input: (source) => fire("input", { type: "input", text: "hi", source }, ctx),
		settle: async ({ aborted = false, message } = {}) => {
			const entries = message === undefined ? [assistant()] : message === null ? [] : [message];
			branch = entries.map((entry) => ({ ...entry, id: `e${++entrySeq}` }));
			await fire("agent_settled", { type: "agent_settled", aborted }, ctx);
			await flush();
		},
		shutdown: async () => {
			await fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		},
		start: async () => fire("session_start", { type: "session_start", reason: "startup" }, ctx),
		fireTimers: async () => {
			const pending = timers.filter((timer) => !timer.cleared);
			timers.length = 0;
			for (const timer of pending) timer.handler();
			await flush();
			return pending;
		},
		pendingTimers: () => timers.filter((timer) => !timer.cleared),
		lastNotice: () => notes.at(-1),
		attention: () => globalThis[QUIET_STATE]?.attention ?? null,
	};
	return h;
}

// ---------- classifier ----------

test("classifyUsageLimit matches the non-retryable quota and usage-limit errors", () => {
	for (const errorMessage of [
		"GoUsageLimitError: weekly usage limit reached",
		"FreeUsageLimitError",
		'{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
		"Monthly usage limit reached. To continue, enable available balance usage.",
		"402 quota exceeded",
		"out of budget",
		"subscription_sharing_usage_limit_exceeded",
		"subscription_sharing_workplace_individual_usage_limit_exceeded",
		'{"code": 1308, "msg": "plan limit"}',
		"You have hit your daily usage limit",
		// Copilot's monthly allowance, and the verb/noun order other providers use.
		"You have exceeded your premium requests limit",
		"You have exceeded 300 premium requests this month",
		"exceeded your monthly quota",
		"You have reached your limit for this window",
		// Billing failures that do not clear on their own.
		"billing_hard_limit_reached",
		"Your billing account is suspended",
		// An account that was cancelled is a real failure, not a request abort.
		"subscription cancelled: quota exceeded",
		// Copilot-style machine codes, with an underscore or a hyphen instead of a space.
		'{"code":"quota_exceeded","message":"Quota exceeded"}',
		"quota-exceeded",
	]) {
		assert.equal(classifyUsageLimit({ stopReason: "error", errorMessage }).limited, true, errorMessage);
	}
	assert.equal(
		classifyUsageLimit({ stopReason: "error", errorMessage: "GoUsageLimitError: reached" }).reason,
		"usage limit",
	);
});

test("classifyUsageLimit leaves transient errors, overflows and aborts alone", () => {
	for (const message of [
		null,
		undefined,
		{ stopReason: "stop", errorMessage: "" },
		{ stopReason: "error" },
		{ stopReason: "aborted", errorMessage: "usage limit" },
		{ stopReason: "error", errorMessage: "fetch failed" },
		{ stopReason: "error", errorMessage: "429 Too Many Requests" },
		{ stopReason: "error", errorMessage: "The model is overloaded" },
		{ stopReason: "error", errorMessage: "500 server error" },
		{ stopReason: "error", errorMessage: "prompt is too long: 250000 tokens > 200000 maximum context length" },
		{ stopReason: "error", errorMessage: "context_length_exceeded" },
		{ stopReason: "error", errorMessage: "conversation is too long" },
		// Overflows only pi-ai's own check knows: its list decides, not a copy here.
		{ stopReason: "error", errorMessage: "Requested token count exceeds the model's maximum context length of 131072 tokens" },
		{ stopReason: "error", errorMessage: "This endpoint's maximum context length is 200000 tokens. However, you requested about 250000 tokens" },
		{ stopReason: "error", provider: "cerebras", errorMessage: "400/413 status code (no body)" },
		// Would match the "exceeded … limit" rule; pi's overflow check wins.
		{ stopReason: "error", errorMessage: "invalid params, context window exceeded limit" },
		{ stopReason: "error", errorMessage: "The request was aborted" },
		{ stopReason: "error", errorMessage: "Request cancelled by the user" },
		{ stopReason: "error", errorMessage: "The stream was cancelled" },
		// An abort can carry whatever the stream had already reported, quota wording included.
		{ stopReason: "error", errorMessage: "Request was aborted: quota exceeded" },
		{ stopReason: "error", errorMessage: "Cancelled by user (insufficient_quota)" },
		// Throttles pi retries itself, even when the wording has the limit verb first.
		{ stopReason: "error", errorMessage: "429 rate limit exceeded" },
		{ stopReason: "error", errorMessage: "Number of request tokens has exceeded your per-minute rate limit" },
		{ stopReason: "error", errorMessage: "429 Too Many Requests: retry after 30s" },
		{ stopReason: "error", errorMessage: "exceeded request buffer limit while retrying upstream" },
		// Billing wording unrelated to a usage window.
		{ stopReason: "error", errorMessage: "billing country not enabled" },
		{ stopReason: "error", errorMessage: "billing address invalid" },
	]) {
		assert.equal(classifyUsageLimit(message).limited, false, JSON.stringify(message));
	}
});

test("lastAssistant takes the newest assistant message and its model", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "go" } },
		{ type: "message", message: { role: "assistant", provider: "xai", model: "grok-4", stopReason: "stop" } },
		{ type: "message", message: { role: "toolResult", content: [] } },
		assistant({ provider: "opencode-go", model: "glm-5.3" }),
	];
	const last = lastAssistant(branch);
	assert.equal(last.stopReason, "error");
	assert.equal(specOf(last), "opencode-go/glm-5.3");
	assert.equal(lastAssistant([{ type: "message", message: { role: "user" } }]), null);
	assert.equal(lastAssistant([]), null);
});

// ---------- chain selection ----------

const A = "anthropic/claude-sonnet-4-5";
const B = "opencode-go/glm-5.3";
const C = "xai/grok-4";
const OPUS = "anthropic/claude-opus-4-5";

test("selectNextModel walks the chain after the current model and wraps once", () => {
	assert.equal(selectNextModel({ chain: [A, B, C], current: A }).spec, B);
	assert.equal(selectNextModel({ chain: [A, B, C], current: B }).spec, C);
	assert.equal(selectNextModel({ chain: [A, B, C], current: C }).spec, A, "wraps to the preferred model");
	assert.equal(selectNextModel({ chain: [A, B, C], current: "other/model" }).spec, A);
	assert.equal(selectNextModel({ chain: [A, B, C], current: A, tried: [A, B] }).spec, C);
	assert.equal(selectNextModel({ chain: [B], current: B }), null, "the only model was just tried");
	assert.deepEqual(selectNextModel({ chain: [] }), null);
});

test("selectNextModel skips models with no auth and models the cache shows used up", () => {
	assert.equal(selectNextModel({ chain: [A, B, C], current: A, isAvailable: (spec) => spec.spec !== B }).spec, C);
	assert.equal(selectNextModel({ chain: [A, B, C], current: A, isExhausted: (spec) => spec.spec === B }).spec, C);
	assert.equal(
		selectNextModel({ chain: [A, B], current: A, isAvailable: () => true, isExhausted: () => true }),
		null,
	);
});

test("parseModelSpec splits at the first slash and rejects junk", () => {
	assert.deepEqual(parseModelSpec("openrouter/moonshotai/Kimi-K2"), {
		provider: "openrouter",
		model: "moonshotai/Kimi-K2",
		spec: "openrouter/moonshotai/Kimi-K2",
	});
	for (const value of ["", "no-slash", "/model", "provider/", "  ", 42, null]) {
		assert.equal(parseModelSpec(value), null, JSON.stringify(value));
	}
});

test("readFailoverSettings defaults to on when a chain is set", () => {
	assert.deepEqual(readFailoverSettings({}), { chain: [], enabled: false, maxSwitches: 3 });
	assert.deepEqual(readFailoverSettings({ failover: { chain: [A, A, "bad", B] } }), {
		chain: [A, B],
		enabled: true,
		maxSwitches: 3,
	});
	assert.equal(readFailoverSettings({ failover: { chain: [A], enabled: false } }).enabled, false);
	assert.equal(readFailoverSettings({ failover: { chain: [A], maxSwitches: 0 } }).maxSwitches, 0);
	assert.equal(readFailoverSettings({ failover: { chain: [A], maxSwitches: 2.9 } }).maxSwitches, 2);
	assert.equal(readFailoverSettings({ failover: { chain: [A], maxSwitches: -1 } }).maxSwitches, 0);
	assert.equal(readFailoverSettings({ failover: { chain: [A], maxSwitches: "lots" } }).maxSwitches, 3);
});

// ---------- reset time ----------

test("usageResetAt prefers the reset of the window that is used up", () => {
	const cache = {
		"claude-window": {
			resetMs: NOW + 24 * HOUR,
			windows: [
				{ label: "5h", percent: 12, resets_at: new Date(NOW + HOUR).toISOString() },
				{ label: "week", percent: 100, resets_at: new Date(NOW + 24 * HOUR).toISOString() },
			],
		},
	};
	// The hour-long window has room, so the used-up weekly one decides the wait.
	assert.equal(usageResetAt(cache, "anthropic", NOW), NOW + 24 * HOUR);
	// A provider whose only window has room is not exhausted, so the soonest reset is fine.
	const grok = { "grok-window": { resetMs: NOW + 3 * HOUR, windows: [{ label: "week", percent: 20 }] } };
	assert.equal(usageResetAt(grok, "xai", NOW), NOW + 3 * HOUR);
	assert.equal(usageResetAt(grok, "openrouter", NOW), undefined, "a provider with no cache entry is unknown");
});

test("usageResetAt ignores resets in the past", () => {
	const cache = { "grok-window": { resetMs: NOW - HOUR, windows: [{ label: "5h", percent: 100, resets_at: new Date(NOW - HOUR).toISOString() }] } };
	assert.equal(usageResetAt(cache, "xai", NOW), undefined);
});

test("a Claude family's weekly meter speaks only for that family", () => {
	const cache = {
		"claude-window:opus": {
			value: "0.6/5H: 12% 5.5/7D: 57%",
			resetMs: NOW + 2 * HOUR,
			windows: [
				{ label: "5h", percent: 12, resets_at: iso(NOW + 2 * HOUR) },
				{ label: "week", percent: 100, resets_at: iso(NOW + 72 * HOUR) },
			],
		},
		"claude-window:sonnet": {
			value: "4.4/5H: 10% 5.4/7D: 53%",
			resetMs: NOW + 5 * HOUR,
			windows: [
				{ label: "5h", percent: 10, resets_at: iso(NOW + 5 * HOUR) },
				{ label: "week", percent: 53, resets_at: iso(NOW + 48 * HOUR) },
			],
		},
	};
	assert.equal(usageExhausted(cache, "anthropic", NOW, "claude-opus-4-5"), true);
	assert.equal(
		usageExhausted(cache, "anthropic", NOW, "claude-sonnet-4-5"),
		false,
		"a full Opus week is not Sonnet used up",
	);
	// Each family answers with its own resets, never the other family's.
	assert.equal(usageResetAt(cache, "anthropic", NOW, "claude-opus-4-5"), NOW + 72 * HOUR);
	assert.equal(usageResetAt(cache, "anthropic", NOW, "claude-sonnet-4-5"), NOW + 5 * HOUR);
	assert.deepEqual(cacheEntriesFor(cache, "anthropic", "claude-sonnet-4-5"), [cache["claude-window:sonnet"]]);
	// Without a family entry (an older cache, or a model with no family) the
	// provider's variants are read together, as before.
	const base = { "claude-window": { windows: [{ label: "week", percent: 100, resets_at: iso(NOW + HOUR) }] } };
	assert.equal(usageExhausted(base, "anthropic", NOW, "claude-sonnet-4-5"), true);
});

test("usageExhausted reads quota percent and windows, per model family key", () => {
	const cache = {
		"claude-window:opus": {
			resetMs: NOW + 5 * HOUR,
			windows: [
				{ label: "5h", percent: 100, resets_at: new Date(NOW + 2 * HOUR).toISOString() },
				{ label: "week", percent: 47, resets_at: new Date(NOW + 72 * HOUR).toISOString() },
			],
		},
	};
	assert.equal(usageExhausted(cache, "anthropic", NOW), true);
	// After that 5h window resets there is room again, even though the entry is older.
	assert.equal(usageExhausted(cache, "anthropic", NOW + 3 * HOUR), false);
	assert.equal(usageExhausted(cache, "xai", NOW), false);
	assert.equal(
		usageExhausted({ "copilot-window": { quota: { usedPercent: 100, resetDate: "2026-12-01" } } }, "github-copilot", NOW),
		true,
	);
	assert.equal(
		usageExhausted({ "copilot-window": { quota: { usedPercent: 100, resetDate: "2026-11-01" } } }, "github-copilot", NOW),
		false,
	);
});

test("wakeDelayMs uses the reset, else the backoff, within setTimeout's ceiling", () => {
	assert.equal(wakeDelayMs(NOW + 2 * HOUR, NOW), 2 * HOUR);
	assert.equal(wakeDelayMs(undefined, NOW), DEFAULT_BACKOFF_MS);
	assert.equal(wakeDelayMs(NOW - HOUR, NOW), DEFAULT_BACKOFF_MS);
	assert.equal(wakeDelayMs(Number.NaN, NOW), DEFAULT_BACKOFF_MS);
	assert.equal(wakeDelayMs(NOW + MAX_TIMER_MS + 10 * HOUR, NOW), MAX_TIMER_MS);
});

// ---------- the no-loop guard ----------

test("planFailover switches, then stops: budget, exhausted chain, failed switches", () => {
	const next = parseModelSpec(B);
	assert.deepEqual(planFailover({ switches: 0, failedSwitches: 0 }, 3, next), { action: "switch", next });
	assert.deepEqual(planFailover({ switches: 3, failedSwitches: 0 }, 3, next), { action: "stop", reason: "max-switches" });
	assert.deepEqual(planFailover({ switches: 0, failedSwitches: 0 }, 3, null), { action: "stop", reason: "chain-exhausted" });
	assert.deepEqual(planFailover({ switches: 1, failedSwitches: 1 }, 3, next), { action: "switch", next });
	assert.deepEqual(planFailover({ switches: 1, failedSwitches: 2 }, 3, next), { action: "stop", reason: "switch-failed" });
});

// ---------- mounted extension ----------

test("a usage limit switches to the next model, notices, and continues", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle();
	assert.deepEqual(h.pi.setCalls, [B]);
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT]);
	assert.match(h.notes[0].text, /usage limit/);
	assert.match(h.notes[0].text, /opencode-go\/glm-5\.3/);
	assert.equal(h.state.model.provider, "opencode-go");
	assert.equal(h.timers.filter((timer) => !timer.cleared).length, 1, "one wake for the preferred model");
	assert.equal(h.timers[0].delayMs, 2 * HOUR);
});

test("the switch skips a model with no auth and one the cache shows used up", async () => {
	const h = mount({ chain: [A, B, C], cache: limitCache(), auth: [A, C] });
	await h.settle();
	assert.equal(h.state.model.provider, "xai", "B has no auth, so C");

	const h2 = mount({ chain: [A, B, C], cache: opencodeGoCache({ percent: 100, resetMs: NOW + 2 * HOUR }), auth: [A, B, C] });
	await h2.settle();
	assert.equal(h2.state.model.provider, "xai", "B is used up, so C");
});

test("the opencode-go and codex entries provider-usage writes say used up and when the window opens", async () => {
	// The real cache entry carries `windows`/`resetMs` now; those are the only
	// fields this extension reads, so the entry is built by provider-usage itself.
	const opencodeGo = opencodeGoCache({ percent: 100, resetMs: NOW + 30 * 60_000 });
	assert.equal(usageExhausted(opencodeGo, "opencode-go", NOW), true);
	assert.equal(usageExhausted(opencodeGo, "opencode-go", NOW + 31 * 60_000), false, "that meter is back");

	// The 5h meter has room and resets first; the used-up weekly meter decides the wait.
	const weeklyOnly = opencodeGoCache({ percent: 20, resetMs: NOW + 30 * 60_000 }, 100);
	assert.equal(usageResetAt(weeklyOnly, "opencode-go", NOW), NOW + 72 * HOUR);

	const codex = codexCache({ percent: 100, resetMs: NOW + 2 * HOUR });
	assert.equal(usageExhausted(codex, "openai-codex", NOW), true);
	assert.equal(usageExhausted(codex, "openai-codex", NOW + 2 * HOUR + 1), false);
	assert.equal(usageResetAt(codex, "openai-codex", NOW), NOW + 2 * HOUR);

	// Mounted: a used-up opencode-go backup is skipped, and picked once it reopens.
	const h = mount({ chain: [A, B, C], cache: opencodeGoCache({ percent: 100, resetMs: NOW + 2 * HOUR }) });
	await h.settle();
	assert.deepEqual(h.pi.setCalls, [C], "B is used up, so the walk skips it");
	h.advance(2 * HOUR + 1_000);
	await h.settle({ message: assistant({ provider: "xai", model: "grok-4" }) }); // C limits too
	assert.equal(h.pi.setCalls.at(-1), B, "the window reopened, so B is back in the walk");
});

test("a user abort, an aborted stopReason, and a non-limit error all do nothing", async () => {
	const aborted = mount({ chain: [A, B], cache: limitCache() });
	await aborted.settle({ aborted: true });
	assert.deepEqual(aborted.pi.sent, []);
	assert.equal(aborted.state.model.provider, "anthropic");
	assert.equal(aborted.notes.length, 0);

	const signal = mount({ chain: [A, B], cache: limitCache() });
	await signal.settle({ message: assistant({ stopReason: "aborted" }) });
	assert.deepEqual(signal.pi.sent, []);

	const network = mount({ chain: [A, B], cache: limitCache() });
	await network.settle({ message: assistant({ errorMessage: "fetch failed" }) });
	assert.deepEqual(network.pi.sent, []);
	assert.equal(network.state.model.provider, "anthropic");
});

test("never acts in print or json mode", async () => {
	for (const mode of ["print", "json"]) {
		const h = mount({ chain: [A, B], cache: limitCache() });
		h.setMode(mode);
		await h.settle();
		assert.deepEqual(h.pi.sent, [], mode);
		assert.equal(h.state.model.provider, "anthropic", mode);
		assert.equal(h.notes.length, 0, mode);
	}
});

test("a bare 429 is a throttle pi retries, not a usage limit to fail over on", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle({ message: assistant({ errorMessage: "429 Too Many Requests" }) });
	assert.deepEqual(h.pi.sent, []);
	assert.equal(h.state.model.provider, "anthropic");
});

test("an exhausted chain stops once and asks Eric through quiet's attention", async () => {
	globalThis[QUIET_STATE] = { quiet: true, attention: null };
	const h = mount({ chain: [A], cache: limitCache() });
	await h.settle();
	assert.deepEqual(h.pi.sent, [], "no continue: nothing to continue on");
	assert.equal(h.notes.length, 1);
	assert.match(h.notes[0].text, /^Needs you \(blocked\):/);
	assert.match(h.notes[0].text, /failover chain/);
	const attention = h.attention();
	assert.equal(attention.kind, "blocked");
	assert.ok(h.emitted.some((event) => event.channel === QUIET_ATTENTION_EVENT && event.data.kind === "blocked"));
	// A stop arms no wake: a stop that rescheduled itself would resume its own loop.
	assert.equal(h.pendingTimers().length, 0, "no wake for a chain that cannot continue");
	delete globalThis[QUIET_STATE];
});

test("without quiet the fallback is ctx.ui.notify", async () => {
	delete globalThis[QUIET_STATE];
	const h = mount({ chain: [A] });
	await h.settle();
	assert.equal(h.notes.length, 1);
	assert.match(h.notes[0].text, /^Needs you \(blocked\):/);
	assert.equal(
		h.emitted.some((event) => event.channel === QUIET_ATTENTION_EVENT),
		false,
	);
});

test("a switch that fails twice stops instead of trying the chain forever", async () => {
	const h = mount({ chain: [A, B, C], setFails: [B, C] });
	await h.settle();
	assert.deepEqual(h.pi.sent, []);
	assert.equal(h.state.model.provider, "anthropic");
	assert.match(h.notes.at(-1).text, /^Needs you \(failed\):/);
	assert.match(h.notes.at(-1).text, /couldn't switch/);
});

test("maxSwitches bounds one task, and a user message starts a new one", async () => {
	const h = mount({ chain: [A, B, C], cache: limitCache(), maxSwitches: 1 });
	await h.settle(); // A -> B
	assert.equal(h.state.model.provider, "opencode-go");
	// The run continued on B, so the limit reports B (as a real settle does).
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3" }) });
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT]);
	assert.match(h.notes.at(-1).text, /^Needs you \(blocked\):/);
	assert.match(h.notes.at(-1).text, /after 1 switch/);
	assert.equal(h.state.model.provider, "opencode-go", "no third model was picked");

	await h.input("interactive");
	h.state.model = { provider: "xai", id: "grok-4" };
	// B is still inside its in-memory backoff, so let that pass before the new task.
	h.advance(DEFAULT_BACKOFF_MS + 1_000);
	await h.settle({ message: assistant({ provider: "xai", model: "grok-4" }) }); // C limits: a fresh task may switch again
	assert.equal(h.pi.sent.length, 2);
	// A is skipped: the cache still shows its 5h window used up, so the fresh task goes to B.
	assert.equal(h.state.model.provider, "opencode-go");
});

test("a model that hit its limit stays skipped across tasks until its reset", async () => {
	const h = mount({ chain: [A, B, C] }); // no cache: every wait is the 30 minute backoff
	await h.settle(); // A limits -> B
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3" }) }); // B limits -> C
	assert.deepEqual(h.pi.setCalls, [B, C]);

	// A new task has a fresh budget and an empty tried list, but A and B each
	// returned a limit minutes ago: picking one again only buys a failed request.
	await h.input("interactive");
	await h.settle({ message: assistant({ provider: "xai", model: "grok-4" }) });
	assert.deepEqual(h.pi.setCalls, [B, C], "no switch back onto a model that just hit its limit");
	assert.match(h.notes.at(-1).text, /^Needs you \(blocked\):/);

	// Once the backoff has passed the in-memory limit is no longer a reason to skip it.
	h.advance(DEFAULT_BACKOFF_MS + 1_000);
	await h.input("interactive");
	await h.settle({ message: assistant({ provider: "xai", model: "grok-4" }) });
	assert.equal(h.pi.setCalls.at(-1), A, "A is a candidate again after its backoff");
});

test("the wake switches back to the preferred model without disturbing work that moved on", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle(); // limit on A -> B, continue
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT]);
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3", stopReason: "stop" }) });
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT], "a finished run sends nothing");

	h.advance(2 * HOUR + 1_000);
	await h.fireTimers();
	assert.equal(h.state.model.provider, "anthropic", "back on the preferred model");
	assert.match(h.notes.at(-1).text, /failover: back on anthropic\/claude-sonnet-4-5/);
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT], "work had moved on, so no continue");
});

test("the wake continues work that stopped unfinished", async () => {
	// B has no auth, so the second limit stops there; the wake armed by the first
	// switch is still waiting for A's window.
	const h = mount({ chain: [A, B, C], cache: limitCache(), auth: [A, B] });
	await h.settle(); // limit on A -> B
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT]);
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3" }) }); // B limits, C has no auth
	assert.equal(h.state.model.provider, "opencode-go");
	assert.match(h.notes.at(-1).text, /^Needs you \(blocked\):/);
	h.advance(2 * HOUR + 1_000);
	await h.fireTimers(); // A's window opened: back on A, and the work resumes
	assert.equal(h.state.model.provider, "anthropic");
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT, CONTINUE_TEXT]);
	assert.match(h.notes.at(-1).text, /failover: back on anthropic\/claude-sonnet-4-5/);
});

test("a wake while busy is deferred to the next idle point", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle(); // A -> B
	h.state.idle = false;
	h.advance(2 * HOUR + 1_000);
	await h.fireTimers();
	assert.equal(h.state.model.provider, "opencode-go", "no switch mid-run");
	h.state.idle = true;
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3", stopReason: "stop" }) });
	assert.equal(h.state.model.provider, "anthropic", "switched back at idle");
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT]);
});

test("a wake that finds the session busy retries, so idle compaction cannot delay it", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle(); // A -> B
	h.state.idle = false;
	h.advance(2 * HOUR + 1_000);
	await h.fireTimers(); // the window is open, but pi is compacting
	assert.equal(h.state.model.provider, "opencode-go", "no switch mid-run");
	assert.equal(h.pendingTimers().length, 1, "a retry is armed, not just the settle hook");
	assert.equal(h.pendingTimers()[0].delayMs, WAKE_RETRY_MS);

	// The compaction ends with no agent_settled: only the retry brings the switch back.
	h.state.idle = true;
	await h.fireTimers();
	assert.equal(h.state.model.provider, "anthropic", "back on the preferred model without a whole run in between");
	assert.equal(h.pendingTimers().length, 0, "the retry is spent");
});

test("a Claude family's own window decides the switch, not another family's", async () => {
	const cache = {
		"claude-window:opus": {
			value: "0.6/5H: 12% 5.5/7D: 57%",
			resetMs: NOW + 2 * HOUR,
			windows: [
				{ label: "5h", percent: 12, resets_at: iso(NOW + 2 * HOUR) },
				{ label: "week", percent: 100, resets_at: iso(NOW + 72 * HOUR) },
			],
			fetchedAt: NOW,
		},
		"claude-window:sonnet": {
			value: "4.4/5H: 10% 5.4/7D: 53%",
			resetMs: NOW + 5 * HOUR,
			windows: [
				{ label: "5h", percent: 10, resets_at: iso(NOW + 5 * HOUR) },
				{ label: "week", percent: 53, resets_at: iso(NOW + 48 * HOUR) },
			],
			fetchedAt: NOW,
		},
	};
	const h = mount({ chain: [A, OPUS], cache });
	h.state.model = { provider: "anthropic", id: "claude-opus-4-5" };
	await h.settle({ message: assistant({ provider: "anthropic", model: "claude-opus-4-5" }) });
	assert.deepEqual(h.pi.setCalls, [A], "Opus's full week does not take Sonnet with it");
	assert.equal(h.state.model.id, "claude-sonnet-4-5");
});

test("the notice promises a switch-back time only when the cache has one", async () => {
	const cached = mount({ chain: [A, B], cache: limitCache() });
	await cached.settle();
	assert.match(cached.notes[0].text, /\(back after /);

	const guessed = mount({ chain: [A, B] });
	await guessed.settle();
	assert.match(guessed.notes[0].text, /\(retry ~/);
	assert.doesNotMatch(guessed.notes[0].text, /back after/, "the 30 minute wait is a guess, so do not promise it");
});

test("a wake does not switch back while the cache still shows the window used up", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle(); // A -> B
	h.state.model = { provider: "opencode-go", id: "glm-5.3" };
	// The wake fires early (a stale or misread cache): still 100% used.
	const early = mount({ chain: [A, B], cache: limitCache(NOW + 4 * HOUR) });
	await early.settle();
	await early.fireTimers(); // the reset is 4h away; fired now by hand
	assert.equal(early.state.model.provider, "opencode-go", "stayed on the backup");
	assert.equal(early.pendingTimers().length, 1, "re-scheduled for later");
});

test("timers are cleared on session_shutdown", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle();
	assert.equal(h.timers.length, 1);
	await h.shutdown();
	assert.equal(h.timers[0].cleared, true);
	const fired = await h.fireTimers();
	assert.deepEqual(fired, []);
	assert.equal(h.state.model.provider, "opencode-go", "nothing acted");
});

test("a limit with no cached reset waits the 30 minute backoff", async () => {
	const h = mount({ chain: [A, B] });
	await h.settle();
	assert.equal(h.timers[0].delayMs, DEFAULT_BACKOFF_MS);
});

// ---------- settings cache ----------

test("cachedSettings re-reads only when the config file's mtime changes", () => {
	const state = {};
	let reads = 0;
	const read = () => {
		reads += 1;
		return { chain: [A], enabled: true, maxSwitches: 3 };
	};
	const first = cachedSettings(state, 1000, read);
	assert.equal(cachedSettings(state, 1000, read), first);
	assert.equal(reads, 1, "a settle does not re-read and re-parse boehsline.json");
	cachedSettings(state, 2000, read);
	assert.equal(reads, 2, "an edited file is re-read");
	cachedSettings(state, undefined, read);
	cachedSettings(state, undefined, read);
	assert.equal(reads, 3, "no config file at all: read once");
});

test("settings are read once per session unless boehsline.json changes", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle();
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3", stopReason: "stop" }) });
	assert.equal(h.behavior.settingsReads, 1, "two settles, one read");
	h.behavior.settingsMtime = 2000;
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3", stopReason: "stop" }) });
	assert.equal(h.behavior.settingsReads, 2, "the edited file is picked up");
	await h.start();
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3", stopReason: "stop" }) });
	assert.equal(h.behavior.settingsReads, 3, "a new session starts clean");
});

// ---------- no loop ----------

test("a wake that continues cannot restart the loop: one continue, then a stop", async () => {
	const h = mount({ chain: [A, B] }); // no cache: every wait is the 30 minute backoff
	await h.settle(); // A limits -> B, continue
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3" }) }); // B limits, nothing left
	assert.equal(h.state.model.provider, "opencode-go");
	assert.equal(h.pi.sent.length, 1);
	assert.equal(h.notes.length, 2, "the switch line and the stop line");

	h.advance(DEFAULT_BACKOFF_MS + 1_000);
	await h.fireTimers(); // A's window reopened: back on A, continue once
	assert.equal(h.state.model.provider, "anthropic");
	assert.equal(h.pi.sent.length, 2);

	// The work hits A's limit again. The budget and the tried list survived the wake,
	// so there is nowhere to go: a stop, and a stop arms nothing.
	await h.settle({ message: assistant({ provider: "anthropic", model: "claude-sonnet-4-5" }) });
	assert.equal(h.pi.sent.length, 2, "no further continue");
	assert.match(h.notes.at(-1).text, /^Needs you \(blocked\):/);
	assert.equal(h.pendingTimers().length, 0, "no wake to resume the stop");

	const continues = h.pi.sent.length;
	const notices = h.notes.length;
	for (let i = 0; i < 6; i++) {
		h.advance(DEFAULT_BACKOFF_MS + 1_000);
		await h.fireTimers();
	}
	assert.equal(h.pi.sent.length, continues, "six more backoffs, still two continues");
	assert.equal(h.notes.length, notices, "and no further notices");
});

test("a second wake does not continue the same work twice: it asks instead", async () => {
	const h = mount({ chain: [A, B, C], auth: [A, B] }); // no cache; C has no auth yet
	await h.settle(); // A limits -> B, continue, A's wake armed
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3" }) }); // B limits, C unusable
	assert.equal(h.state.model.provider, "opencode-go");
	h.advance(DEFAULT_BACKOFF_MS + 1_000);
	await h.fireTimers(); // back on A, and the one wake-driven continue
	assert.equal(h.state.model.provider, "anthropic");
	assert.equal(h.pi.sent.length, 2);

	// C gets auth later, so a further limit switches again and arms A's wake again.
	h.allowAuth(C);
	await h.settle({ message: assistant({ provider: "anthropic", model: "claude-sonnet-4-5" }) });
	assert.equal(h.state.model.provider, "xai");
	assert.equal(h.pi.sent.length, 3);
	await h.settle({ message: assistant({ provider: "xai", model: "grok-4" }) }); // C limits: nothing left
	assert.equal(h.pendingTimers().length, 1, "the switch armed A's wake again");

	h.advance(DEFAULT_BACKOFF_MS + 1_000);
	await h.fireTimers();
	assert.equal(h.state.model.provider, "anthropic", "back on the preferred model");
	assert.equal(h.pi.sent.length, 3, "a wake already resumed this work: no second continue");
	assert.match(h.notes.at(-1).text, /^Needs you \(blocked\):/);
	assert.match(h.notes.at(-1).text, /already resumed/);
	assert.equal(h.pendingTimers().length, 0, "and nothing is armed again");
});

// ---------- timer safety ----------

test("a rejecting setModel and a throwing settings read are not unhandled rejections", async () => {
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		// pi.setModel rejects rather than returning false.
		const rejecting = mount({ chain: [A, B, C], setRejects: [B, C] });
		await rejecting.settle();
		assert.equal(rejecting.pi.sent.length, 0);
		assert.match(rejecting.notes.at(-1).text, /^Needs you \(failed\):/);

		// sendUserMessage returns a promise that rejects.
		const gone = mount({ chain: [A, B], cache: limitCache(), sendRejects: true });
		await gone.settle();
		assert.equal(gone.state.model.provider, "opencode-go", "the switch still happened");
		assert.deepEqual(gone.pi.sent, [CONTINUE_TEXT]);

		// The config becomes unreadable by the time the timer fires.
		const broken = mount({ chain: [A, B], cache: limitCache() });
		await broken.settle();
		broken.behavior.settingsThrows = true;
		broken.behavior.settingsMtime = 2000;
		broken.advance(2 * HOUR + 1_000);
		await broken.fireTimers();
		assert.equal(broken.state.model.provider, "opencode-go", "nothing acted on a broken config");

		// Let node deliver anything that did escape.
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("an aborted settle clears a deferred switch back", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle(); // A -> B
	h.state.idle = false;
	h.advance(2 * HOUR + 1_000);
	await h.fireTimers(); // busy: deferred
	assert.equal(h.state.model.provider, "opencode-go");
	await h.settle({ aborted: true }); // Eric hit Escape
	h.state.idle = true;
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3", stopReason: "stop" }) });
	assert.equal(h.state.model.provider, "opencode-go", "no switch back after his abort");
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT]);
});

test("a wake leaves a model Eric picked himself where it is", async () => {
	const h = mount({ chain: [A, B], cache: limitCache() });
	await h.settle(); // A -> B
	h.state.model = { provider: "openai-codex", id: "gpt-5.5-codex" }; // /model
	h.advance(2 * HOUR + 1_000);
	await h.fireTimers();
	assert.equal(h.state.model.provider, "openai-codex", "his choice stands");
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT], "and no continue over it");
	assert.equal(h.notes.filter((note) => /back on/.test(note.text)).length, 0);
});

// ---------- continue only into untouched work ----------

test("a wake does not continue over Eric: a queued message, a draft, or a message since", async () => {
	const stopped = async () => {
		const h = mount({ chain: [A, B, C], cache: limitCache(), auth: [A, B] });
		await h.settle(); // A -> B, continue
		await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3" }) }); // stops unfinished
		h.advance(2 * HOUR + 1_000);
		return h;
	};

	const queued = await stopped();
	queued.state.pending = true;
	await queued.fireTimers();
	assert.deepEqual(queued.pi.sent, [CONTINUE_TEXT], "his queued message continues the run, not ours");
	assert.equal(queued.state.model.provider, "anthropic", "the switch back still happens");

	const drafting = await stopped();
	drafting.state.editor = "before you continue: ";
	await drafting.fireTimers();
	assert.deepEqual(drafting.pi.sent, [CONTINUE_TEXT], "never type over a draft");

	const moved = await stopped();
	moved.setBranch([{ type: "message", id: "user-1", message: { role: "user", content: [] } }]);
	await moved.fireTimers();
	assert.deepEqual(moved.pi.sent, [CONTINUE_TEXT], "the branch moved on");
});

test("a message from Eric after a stop ends that work: the wake switches back but sends nothing", async () => {
	const h = mount({ chain: [A, B, C], cache: limitCache(), auth: [A, B] });
	await h.settle(); // A -> B, continue
	await h.settle({ message: assistant({ provider: "opencode-go", model: "glm-5.3" }) }); // stops unfinished
	await h.input("interactive"); // Eric takes the work back
	h.advance(2 * HOUR + 1_000);
	await h.fireTimers();
	assert.equal(h.state.model.provider, "anthropic", "back on the preferred model");
	assert.deepEqual(h.pi.sent, [CONTINUE_TEXT], "but the stopped work is not resumed");
});
