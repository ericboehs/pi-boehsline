/**
 * failover: when a model hits its usage limit, continue on the next model in
 * the chain, then come back when the window resets.
 *
 * Stock pi does not retry usage-limit errors: a quota/billing 429 ends the
 * turn with an assistant message whose `stopReason` is "error" (see
 * pi-ai's retry.ts, `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`). This
 * extension reads that message at `agent_settled`, switches to the next model
 * in `failover.chain` and sends "continue".
 *
 * The reset time comes from provider-usage's shared cache
 * (`~/.pi/agent/usage-cache.json`, keyed per provider driver), so when the
 * window reopens a timer switches back to the preferred model. Work that
 * could not continue (the whole chain was exhausted, budget spent) is picked
 * up with one "continue" at that point; a run that moved on to a backup model
 * is not disturbed, and neither is a draft or a queued message of Eric's.
 * Anthropic's cache entry is per model family (`claude-window:opus`), so a full
 * Opus week does not take Sonnet with it.
 *
 * Never acts on a user abort, never in print/json mode, and never loops: a
 * task gets at most `failover.maxSwitches` switches and two failed switch
 * attempts before it stops and asks for Eric through quiet's notify path. A
 * wake neither resets that budget nor continues the same work twice, and only
 * a switch arms a wake (a stop leaves no timer). The reset time the walk uses is
 * the cache's; a model that hit a limit stays skipped until then even into the
 * next task, and a wake that finds the session busy (idle compaction) retries.
 *
 * Everything decision-shaped is a pure function here so it can be tested
 * without pi: classifyUsageLimit, selectNextModel, planFailover,
 * usageExhausted, usageResetAt, cacheEntriesFor, wakeDelayMs, lastAssistant,
 * parseModelSpec, cachedSettings.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig, userConfigPath, type ConfigObject } from "../../lib/config.ts";

/** The message a failover sends to let the new model pick the work up. */
export const CONTINUE_TEXT = "continue";
/** Wait this long when the cache has no reset time for the provider. */
export const DEFAULT_BACKOFF_MS = 30 * 60_000;
/** Switches allowed for one task (a user request plus the continuations it caused). */
export const DEFAULT_MAX_SWITCHES = 3;
/** Continues one limit may be resumed by a wake: more is a loop, so ask Eric instead. */
export const MAX_WAKE_CONTINUES = 1;
/** How long before retrying a wake that found the session busy (idle compaction: no settle follows). */
export const WAKE_RETRY_MS = 60_000;
/** setTimeout's ceiling; a later reset is re-scheduled when the timer fires. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** quiet's documented shared state; presence means notify_user is available. */
const QUIET_STATE = Symbol.for("pi-boehsline.quiet");
const QUIET_ATTENTION_EVENT = "quiet:attention";

export interface FailoverSettings {
	/** A chain is configured and not switched off. */
	enabled: boolean;
	/** Ordered "provider/model" ids, preferred first. */
	chain: string[];
	maxSwitches: number;
}

export interface ModelSpec {
	provider: string;
	model: string;
	/** `provider/model`, as written in the settings. */
	spec: string;
}

export interface UsageLimitVerdict {
	limited: boolean;
	/** Which rule matched, for the notice. */
	reason?: string;
}

/** One assistant message as this extension reads it. */
export interface AssistantSnapshot {
	/** The session entry's id, so a wake can tell this message is still the last one. */
	id?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** The parts of provider-usage's cache entries this extension reads. */
export interface UsageCacheEntry {
	value?: string;
	resetMs?: number;
	resetDate?: string;
	fetchedAt?: number;
	quota?: { usedPercent?: number; remaining?: number; resetDate?: string; cycleEnd?: number };
	windows?: Array<{ label?: string; percent?: number; resets_at?: string }>;
}

export type UsageCache = Record<string, UsageCacheEntry>;

/**
 * Non-retryable quota/usage-limit wording. Mirrors pi-ai's
 * NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN and widens it to any "usage
 * limit" text (weekly/monthly/daily), which providers word differently.
 */
const LIMIT_PATTERNS: Array<{ label: string; pattern: RegExp; throttleSensitive?: boolean }> = [
	{ label: "usage limit", pattern: /usage.?limit/i },
	{ label: "GoUsageLimitError", pattern: /GoUsageLimitError/i },
	{ label: "FreeUsageLimitError", pattern: /FreeUsageLimitError/i },
	{ label: "insufficient_quota", pattern: /insufficient_quota/i },
	{ label: "out of budget", pattern: /out of budget/i },
	{ label: "quota exceeded", pattern: /quota[ _-]?exceeded/i },
	{ label: "available balance", pattern: /available balance/i },
	// GitHub Copilot bills extra usage in "premium requests" per month.
	{ label: "premium requests", pattern: /premium.?requests?/i, throttleSensitive: true },
	// "You have exceeded your premium requests limit", "exceeded your monthly
	// quota", "You have reached your limit for this window": providers put the
	// verb and the noun in either order. Held back when the message is a plain
	// throttle, so a per-minute rate limit is not read as an exhausted window.
	{ label: "exceeded quota", pattern: /(?:exceeded|reached).{0,40}(?:quota|limit)/i, throttleSensitive: true },
	// Billing: the account-level failures that do not clear on their own. Narrow
	// on purpose, so unrelated 400s such as "billing country not enabled" are
	// neither a failover nor a notice.
	{
		label: "billing",
		pattern: /\bbilling[\s_]+(?:[\w]+[\s_]+){0,2}(?:limit|quota|blocked|suspended|required|issue|error)/i,
	},
	{ label: "plan limit 1308", pattern: /"code"\s*:\s*"?1308(?![0-9])/i },
];

/**
 * Throttle wording: pi retries these itself (see pi-ai's retry.ts), so they must
 * not trip the order-insensitive patterns above.
 */
const THROTTLE_PATTERNS: RegExp[] = [
	/rate.?limit/i,
	/too many requests/i,
	/retry.?after/i,
	/per.?minute/i,
	/\b(?:tpm|rpm)\b/i,
];

/**
 * Errors that look quota-ish but are not a subscription window. A context
 * overflow (compaction, not another model, is the fix) is pi-ai's own check, so
 * this list cannot drift from the one pi itself uses; an abort or a cancellation
 * carries whatever wording the stream had already reported. Checked first, so
 * they never fail over.
 */
const IGNORED_PATTERNS: RegExp[] = [
	/\babort(?:ed)?\b/i,
	// Only a request or the user cancelling is not a limit: an account whose
	// subscription was cancelled is a real failure, and may say so alongside quota text.
	/\bcancel(?:l)?ed by (?:the )?(?:user|client|caller)\b/i,
	/^(?:the )?(?:request|call|stream) (?:was )?cancel(?:l)?ed\b/i,
	// pi retries this one itself (pi-ai's retry.ts); "exceeded … limit" would catch it.
	/request buffer/i,
];

/** Whether pi itself reads the message as a context overflow (compaction is the fix). */
function isOverflow(message: AssistantSnapshot): boolean {
	try {
		return isContextOverflow({
			stopReason: "error",
			errorMessage: message.errorMessage,
			...(message.provider === undefined ? {} : { provider: message.provider }),
		} as AssistantMessage);
	} catch {
		return false;
	}
}

/** Which cache key each provider's driver writes (provider-usage's DRIVERS). */
const CACHE_KEYS: Record<string, string[]> = {
	"openai-codex": ["codex-window"],
	anthropic: ["claude-window"],
	"github-copilot": ["copilot-window"],
	xai: ["grok-window"],
	cerebras: ["cerebras-window"],
	"opencode-go": ["opencode-go-window"],
	ollama: ["ollama-usage"],
	baseten: ["baseten-usage"],
	openrouter: ["openrouter-usage"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `provider/model` split at the first slash; anything malformed is ignored. */
export function parseModelSpec(value: unknown): ModelSpec | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return null;
	const provider = text.slice(0, slash).trim();
	const model = text.slice(slash + 1).trim();
	if (!provider || !model) return null;
	return { provider, model, spec: `${provider}/${model}` };
}

/** `failover` from boehsline.json, with the defaults: on when a chain is set. */
export function readFailoverSettings(config: ConfigObject | undefined = loadConfig()): FailoverSettings {
	const block = config?.failover;
	const raw = isPlainObject(block) ? block : {};
	const chain = Array.isArray(raw.chain)
		? [
				...new Set(
					raw.chain.flatMap((value) => {
						const spec = parseModelSpec(value);
						return spec ? [spec.spec] : [];
					}),
				),
			]
		: [];
	const max = typeof raw.maxSwitches === "number" && Number.isFinite(raw.maxSwitches)
		? Math.max(0, Math.floor(raw.maxSwitches))
		: DEFAULT_MAX_SWITCHES;
	return { chain, enabled: chain.length > 0 && raw.enabled !== false, maxSwitches: max };
}

/** Where `cachedSettings` keeps the value it last read. */
export interface SettingsCache {
	value?: FailoverSettings;
	mtimeMs?: number;
}

/**
 * Settings for a settle, read at most once until the file changes or the
 * session restarts: a settle is a hot path and `loadConfig` reads and parses
 * boehsline.json synchronously.
 */
export function cachedSettings(state: SettingsCache, mtimeMs: number | undefined, read: () => FailoverSettings): FailoverSettings {
	if (state.value !== undefined && state.mtimeMs === mtimeMs) return state.value;
	state.value = read();
	state.mtimeMs = mtimeMs;
	return state.value;
}

/** boehsline.json's mtime; undefined when it does not exist (or cannot be read). */
export function configMtimeMs(): number | undefined {
	try {
		return statSync(userConfigPath()).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Run something that may return a promise (pi's sendUserMessage, a timer's
 * wake) without letting a rejection escape: an unhandled rejection at timer
 * time ends the process.
 */
function settleQuietly(run: () => unknown): void {
	try {
		const result = run() as { catch?: (onRejected: () => void) => unknown } | undefined;
		if (result && typeof result.catch === "function") result.catch(() => {});
	} catch {
		// Nothing else to do: the notice already says where the work stands.
	}
}

/**
 * Whether a settled assistant message is a usage-limit stop rather than an
 * ordinary network error (pi retries those itself), a context overflow, or an
 * abort (the user's, or a signal).
 */
export function classifyUsageLimit(message: AssistantSnapshot | null | undefined): UsageLimitVerdict {
	if (!message || message.stopReason !== "error") return { limited: false };
	const text = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	if (!text) return { limited: false };
	if (isOverflow(message) || IGNORED_PATTERNS.some((pattern) => pattern.test(text))) return { limited: false };
	const throttled = THROTTLE_PATTERNS.some((pattern) => pattern.test(text));
	const hit = LIMIT_PATTERNS.find(
		({ pattern, throttleSensitive }) => (!throttleSensitive || !throttled) && pattern.test(text),
	);
	return hit ? { limited: true, reason: hit.label } : { limited: false };
}

/** The newest assistant message on the branch, as the fields this extension needs. */
export function lastAssistant(entries: readonly unknown[]): AssistantSnapshot | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: Record<string, unknown> } | undefined;
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant") continue;
		return {
			...(typeof (entry as { id?: unknown }).id === "string" ? { id: (entry as { id: string }).id } : {}),
			...(typeof message.provider === "string" ? { provider: message.provider } : {}),
			...(typeof message.model === "string" ? { model: message.model } : {}),
			...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
			...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
		};
	}
	return null;
}

/** The `provider/model` an assistant message reports, or undefined. */
export function specOf(message: AssistantSnapshot | null | undefined): string | undefined {
	if (!message?.provider || !message.model) return undefined;
	return `${message.provider}/${message.model}`;
}

/** The model family of an Anthropic model id (provider-usage's `claudeModelFamily`). */
function claudeFamily(model: string | undefined): string | undefined {
	const id = model?.toLowerCase();
	if (!id) return undefined;
	for (const family of ["opus", "sonnet", "haiku"] as const) {
		if (id.includes(family)) return family;
	}
	return undefined;
}

/**
 * The cache entries for one model. Anthropic meters each family's weekly window
 * separately, so `claude-window:<family>` is used on its own when it exists: a
 * full Opus week must not mark Sonnet used up, or hand it Opus's reset. Every
 * other provider publishes one entry (plus any older variant keys).
 */
export function cacheEntriesFor(cache: UsageCache, provider: string, model?: string): UsageCacheEntry[] {
	const keys = CACHE_KEYS[provider] ?? [];
	if (provider === "anthropic") {
		const family = claudeFamily(model);
		const familyEntry = family === undefined ? undefined : cache[`claude-window:${family}`];
		if (isPlainObject(familyEntry)) return [familyEntry as UsageCacheEntry];
	}
	const entries: UsageCacheEntry[] = [];
	for (const [key, entry] of Object.entries(cache)) {
		if (!isPlainObject(entry)) continue;
		const match = key === provider || keys.some((base) => key === base || key.startsWith(`${base}:`));
		if (match) entries.push(entry as UsageCacheEntry);
	}
	return entries;
}

function timeOf(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * When the provider's window reopens, from the cache: the soonest future reset
 * of a window that is used up, else the soonest future reset of any window.
 * Undefined when the cache says nothing about this provider. `model` picks
 * Anthropic's per-family entry.
 */
export function usageResetAt(cache: UsageCache, provider: string, nowMs = Date.now(), model?: string): number | undefined {
	const candidates: Array<{ at: number; percent?: number }> = [];
	const add = (at: number | undefined, percent: number | undefined) => {
		if (at !== undefined) candidates.push({ at, ...(percent === undefined ? {} : { percent }) });
	};
	for (const entry of cacheEntriesFor(cache, provider, model)) {
		const quotaPercent = typeof entry.quota?.usedPercent === "number" ? entry.quota.usedPercent : undefined;
		add(timeOf(entry.resetMs), quotaPercent);
		add(timeOf(entry.resetDate), quotaPercent);
		add(timeOf(entry.quota?.resetDate), quotaPercent);
		add(timeOf(entry.quota?.cycleEnd), quotaPercent);
		for (const window of entry.windows ?? []) {
			add(timeOf(window?.resets_at), typeof window?.percent === "number" ? window.percent : undefined);
		}
	}
	const future = candidates.filter((candidate) => candidate.at > nowMs).sort((a, b) => a.at - b.at);
	const usedUp = future.find((candidate) => candidate.percent !== undefined && candidate.percent >= 100);
	return (usedUp ?? future[0])?.at;
}

/** Whether the cache shows the provider used up, with no reset yet (`model` picks Anthropic's family entry). */
export function usageExhausted(cache: UsageCache, provider: string, nowMs = Date.now(), model?: string): boolean {
	for (const entry of cacheEntriesFor(cache, provider, model)) {
		const used = typeof entry.quota?.usedPercent === "number" ? entry.quota.usedPercent : undefined;
		const reset = timeOf(entry.resetMs) ?? timeOf(entry.resetDate) ?? timeOf(entry.quota?.resetDate) ?? timeOf(entry.quota?.cycleEnd);
		if (used !== undefined && used >= 100 && (reset === undefined || reset > nowMs)) return true;
		for (const window of entry.windows ?? []) {
			if (typeof window?.percent !== "number" || window.percent < 100) continue;
			const at = timeOf(window.resets_at);
			if (at === undefined || at > nowMs) return true;
		}
	}
	return false;
}

export interface SelectionInput {
	chain: readonly string[];
	/** The model that just hit its limit; the walk starts after it, wrapping once. */
	current?: string;
	/** Specs already tried for this task, and so not worth another switch. */
	tried?: Iterable<string>;
	/** Has auth (and exists). Defaults to everything. */
	isAvailable?: (spec: ModelSpec) => boolean;
	/** The cache shows it used up. */
	isExhausted?: (spec: ModelSpec) => boolean;
}

/** The next usable model: chain order from the current one, wrapping once, skipping tried/unauth/exhausted. */
export function selectNextModel(input: SelectionInput): ModelSpec | null {
	const chain = input.chain.flatMap((spec) => {
		const parsed = parseModelSpec(spec);
		return parsed ? [parsed] : [];
	});
	const tried = new Set(input.tried ?? []);
	if (input.current) tried.add(input.current);
	const found = chain.findIndex((spec) => spec.spec === input.current);
	const start = found < 0 ? 0 : found;
	for (const spec of [...chain.slice(start), ...chain.slice(0, start)]) {
		if (tried.has(spec.spec)) continue;
		if (input.isAvailable && !input.isAvailable(spec)) continue;
		if (input.isExhausted?.(spec)) continue;
		return spec;
	}
	return null;
}

export interface FailoverProgress {
	/** Successful switches for this task. */
	switches: number;
	/** setModel attempts that returned false or threw. */
	failedSwitches: number;
}

export type FailoverPlan =
	| { action: "switch"; next: ModelSpec }
	| { action: "stop"; reason: "switch-failed" | "chain-exhausted" | "max-switches" };

/**
 * The no-loop guard: two failed switch attempts, an empty chain, or the
 * per-task switch budget all end the task instead of trying again.
 */
export function planFailover(progress: FailoverProgress, maxSwitches: number, next: ModelSpec | null): FailoverPlan {
	if (progress.failedSwitches >= 2) return { action: "stop", reason: "switch-failed" };
	if (next === null) return { action: "stop", reason: "chain-exhausted" };
	if (progress.switches >= maxSwitches) return { action: "stop", reason: "max-switches" };
	return { action: "switch", next };
}

/** How long to wait for a reset: the reset itself, else the backoff, within setTimeout's ceiling. */
export function wakeDelayMs(resetAt: number | undefined, nowMs: number, backoffMs = DEFAULT_BACKOFF_MS): number {
	const target = resetAt !== undefined && Number.isFinite(resetAt) && resetAt > nowMs ? resetAt : nowMs + backoffMs;
	return Math.min(Math.max(1, target - nowMs), MAX_TIMER_MS);
}

/** A clock for the one-line notice: "14:03" local, or "Nov 21 14:03" when not today. */
export function resetLabel(resetAt: number, nowMs = Date.now()): string {
	const at = new Date(resetAt);
	const now = new Date(nowMs);
	const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "");
	return at.toDateString() === now.toDateString()
		? time
		: `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

/** One line, whitespace collapsed, at most `max` characters (an ellipsis counts). */
function oneLine(value: unknown, max: number): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function usageCachePath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "usage-cache.json");
}

function readUsageCacheFile(): UsageCache {
	try {
		const parsed: unknown = JSON.parse(readFileSync(usageCachePath(), "utf8"));
		return isPlainObject(parsed) ? (parsed as UsageCache) : {};
	} catch {
		return {};
	}
}

/** The outside world, so tests can mount the extension without pi's clock or files. */
export interface FailoverDeps {
	now: () => number;
	setTimeout: (handler: () => void, delayMs: number) => unknown;
	clearTimeout: (handle: unknown) => void;
	readUsageCache: () => UsageCache;
	readSettings: () => FailoverSettings;
	/** boehsline.json's mtime, so settings are re-read only when the file changes. */
	configMtimeMs: () => number | undefined;
}

export default function failover(pi: ExtensionAPI, overrides: Partial<FailoverDeps> = {}): void {
	const deps: FailoverDeps = {
		now: Date.now,
		setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
		clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
		readUsageCache: readUsageCacheFile,
		readSettings: () => readFailoverSettings(),
		configMtimeMs,
		...overrides,
	};

	/** One user request plus the failover continuations it caused. */
	let progress: FailoverProgress = { switches: 0, failedSwitches: 0 };
	const tried = new Set<string>();
	/** Models that hit a limit this episode, and the wake waiting for the preferred one's reset. */
	const limited = new Map<string, { resetAt: number; timer?: unknown }>();
	/** A switch back to the preferred model, put off because the session was busy then. */
	let returnAtIdle = false;
	/** The last run stopped on a usage limit with the work unfinished. */
	let stoppedUnfinished = false;
	/** The entry that ended the last run on a limit, so a wake can tell the branch has not moved on. */
	let lastLimit: { spec: string; entryId?: string } | undefined;
	/** The model failover itself put in place; anything else means Eric picked one by hand. */
	let switchedToSpec: string | undefined;
	/** Continues a wake has sent since Eric last spoke: one per limit, never a loop. */
	let wakeContinues = 0;
	/** The newest context, so a timer can act while the session is idle. */
	let lastCtx: ExtensionContext | undefined;
	/** Settings are re-read on session_start, or when boehsline.json changes. */
	const settingsCache: SettingsCache = {};

	const resetTask = (): void => {
		progress = { switches: 0, failedSwitches: 0 };
		tried.clear();
	};

	const readSettings = (): FailoverSettings => cachedSettings(settingsCache, deps.configMtimeMs(), deps.readSettings);

	/** The usage cache; unreadable means "unknown", which is the backoff path. */
	const readUsageCache = (): UsageCache => {
		try {
			return deps.readUsageCache() ?? {};
		} catch {
			return {};
		}
	};

	const notify = (ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void => {
		try {
			ctx.ui?.notify(text, type);
		} catch {
			// A missing UI only costs the line; nothing else depends on it.
		}
	};

	/**
	 * quiet's notify path when it is loaded: set the shared attention, emit
	 * `quiet:attention` (tmux-attention, botsun-owner), and show the line
	 * notify_user shows. Without quiet, the line alone.
	 */
	const raiseAttention = (ctx: ExtensionContext, kind: "blocked" | "failed", text: string): void => {
		const line = oneLine(text, 140);
		const snapshot = (globalThis as Record<symbol, unknown>)[QUIET_STATE] as { attention?: unknown } | undefined;
		if (snapshot) {
			const attention = { kind, text: line, at: deps.now() };
			snapshot.attention = attention;
			try {
				pi.events.emit(QUIET_ATTENTION_EVENT, attention);
			} catch {
				// A broken subscriber must not break the settle.
			}
		}
		notify(ctx, `Needs you (${kind}): ${line}`, "warning");
	};

	const branchOf = (ctx: ExtensionContext): unknown[] => {
		try {
			return (ctx.sessionManager.getBranch?.() ?? []) as unknown[];
		} catch {
			return [];
		}
	};

	const currentSpec = (ctx: ExtensionContext): string | undefined => {
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		return model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
	};

	const applyModel = async (ctx: ExtensionContext, spec: ModelSpec): Promise<boolean> => {
		let model;
		try {
			model = ctx.modelRegistry.find(spec.provider, spec.model);
		} catch {
			return false;
		}
		if (!model) return false;
		try {
			return await pi.setModel(model);
		} catch {
			return false;
		}
	};

	const continueRun = (): void => {
		// `sendUserMessage` is a promise; a rejection must not reach the process.
		settleQuietly(() => pi.sendUserMessage(CONTINUE_TEXT));
	};

	const clearWake = (spec: string): void => {
		const entry = limited.get(spec);
		if (!entry) return;
		if (entry.timer !== undefined) deps.clearTimeout(entry.timer);
		limited.delete(spec);
	};

	const clearAllWakes = (): void => {
		for (const spec of [...limited.keys()]) clearWake(spec);
		limited.clear();
	};

	/** Remember a model's reset time (no timer yet: see `armWake`). */
	const recordLimited = (spec: string, resetAt: number): void => {
		clearWake(spec);
		limited.set(spec, { resetAt });
	};

	/** Arm (or re-arm) the wake timer for a model's reset. */
	const armWakeAfter = (spec: string, delayMs: number): void => {
		const entry = limited.get(spec);
		if (!entry) return;
		if (entry.timer !== undefined) deps.clearTimeout(entry.timer);
		entry.timer = deps.setTimeout(() => {
			entry.timer = undefined; // this wake is spent
			settleQuietly(() => onWake(spec));
		}, delayMs);
	};

	/**
	 * Arm the one wake that switches back at the preferred model's reset. Only a
	 * switch (or a wake that has to wait for a later window) arms it: a stop must
	 * not leave a timer behind, or the stop would resume itself every backoff.
	 */
	const armWake = (spec: string, settings: FailoverSettings): void => {
		if (settings.chain[0] !== spec) return;
		const entry = limited.get(spec);
		if (!entry) return;
		armWakeAfter(spec, wakeDelayMs(entry.resetAt, deps.now()));
	};

	/** Whether pi has a message queued: then that message, not ours, continues the run. */
	const hasPendingMessages = (ctx: ExtensionContext): boolean => {
		try {
			return typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
		} catch {
			return true;
		}
	};

	/** Whether Eric has unsent text in the editor: never type over a draft. */
	const editorHasText = (ctx: ExtensionContext): boolean => {
		try {
			const text = ctx.ui?.getEditorText?.();
			return typeof text === "string" && text.trim().length > 0;
		} catch {
			return true;
		}
	};

	/** Whether the branch still ends on the entry that hit the limit (nothing ran since). */
	const stillAtLimit = (ctx: ExtensionContext): boolean => {
		const branch = branchOf(ctx);
		const tail = branch.at(-1) as { id?: unknown } | undefined;
		if (lastLimit?.entryId !== undefined && typeof tail?.id === "string") return tail.id === lastLimit.entryId;
		return classifyUsageLimit(lastAssistant(branch)).limited;
	};

	/** Switch back to the preferred model when the session is idle; continue only unfinished work. */
	const backToPreferred = async (ctx: ExtensionContext, settings: FailoverSettings, needsContinue: boolean): Promise<boolean> => {
		const preferred = parseModelSpec(settings.chain[0]);
		if (!preferred) return false;
		const now = deps.now();
		const cache = readUsageCache();
		if (usageExhausted(cache, preferred.provider, now, preferred.model)) {
			// Not actually open yet (an older window, or a cache we read early): wait again.
			recordLimited(
				preferred.spec,
				usageResetAt(cache, preferred.provider, now, preferred.model) ?? now + DEFAULT_BACKOFF_MS,
			);
			armWake(preferred.spec, settings);
			return false;
		}
		if (switchedToSpec !== undefined && currentSpec(ctx) !== switchedToSpec) {
			// Eric picked a model by hand since the switch, so it is his call now.
			clearWake(preferred.spec);
			return false;
		}
		if (currentSpec(ctx) !== preferred.spec) {
			if (!(await applyModel(ctx, preferred))) return false;
			switchedToSpec = preferred.spec;
			notify(ctx, `failover: back on ${preferred.spec}`, "info");
		}
		clearWake(preferred.spec);
		stoppedUnfinished = false;
		if (!needsContinue) return false;
		if (!stillAtLimit(ctx)) return false;
		// Eric is driving: a queued message or a draft in the editor is not ours to interrupt.
		if (hasPendingMessages(ctx) || editorHasText(ctx)) return false;
		if (wakeContinues >= MAX_WAKE_CONTINUES) {
			raiseAttention(
				ctx,
				"blocked",
				`${preferred.spec} hit its limit again after a wake already resumed this work; not continuing`,
			);
			return false;
		}
		// The task was interrupted by the limit, so pick it up again: the switch
		// budget is not reset here, so a wake cannot buy more switches.
		wakeContinues += 1;
		continueRun();
		return true;
	};

	/** A timer fired for a model's reset. Only the preferred model's wake acts. */
	const onWake = async (spec: string): Promise<void> => {
		const settings = readSettings();
		const ctx = lastCtx;
		if (!ctx || !settings.enabled || spec !== settings.chain[0]) return;
		if (ctx.mode === "print" || ctx.mode === "json") return;
		let idle = false;
		try {
			idle = ctx.isIdle();
		} catch {
			return;
		}
		if (!idle) {
			returnAtIdle = true;
			// Idle compaction leaves `isIdle()` false with no `agent_settled` to
			// follow, so retry on a short timer instead of waiting for Eric's next
			// whole run (which would then run on the backup model).
			armWakeAfter(spec, WAKE_RETRY_MS);
			return;
		}
		await backToPreferred(ctx, settings, stoppedUnfinished);
	};

	const stop = (ctx: ExtensionContext, settings: FailoverSettings, reason: "switch-failed" | "chain-exhausted" | "max-switches"): void => {
		stoppedUnfinished = true;
		const chain = settings.chain.join(", ");
		const text =
			reason === "chain-exhausted"
				? `usage limit reached and no model is left in the failover chain (${chain}); the work is unfinished`
				: reason === "max-switches"
					? `hit a usage limit after ${settings.maxSwitches} switch${settings.maxSwitches === 1 ? "" : "es"}; the work is unfinished`
					: "couldn't switch models after a usage limit; the work is unfinished";
		raiseAttention(ctx, reason === "switch-failed" ? "failed" : "blocked", text);
	};

	const handleLimit = async (ctx: ExtensionContext, settings: FailoverSettings, verdict: UsageLimitVerdict): Promise<void> => {
		const now = deps.now();
		const cache = readUsageCache();
		const last = lastAssistant(branchOf(ctx));
		const spec = parseModelSpec(specOf(last) ?? currentSpec(ctx));
		if (!spec) return;
		lastLimit = { spec: spec.spec, ...(last?.id === undefined ? {} : { entryId: last.id }) };
		// A cached reset means a real window; without one the wait is a guess, so
		// the notice says "retry ~" rather than promising a switch-back time.
		const cachedReset = usageResetAt(cache, spec.provider, now, spec.model);
		recordLimited(spec.spec, cachedReset ?? now + DEFAULT_BACKOFF_MS);
		tried.add(spec.spec);

		const pick = (): ModelSpec | null =>
			selectNextModel({
				chain: settings.chain,
				current: spec.spec,
				tried,
				isAvailable: (candidate) => {
					try {
						const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
						if (!model) return false;
						return typeof ctx.modelRegistry.hasConfiguredAuth === "function"
							? ctx.modelRegistry.hasConfiguredAuth(model)
							: true;
					} catch {
						return false;
					}
				},
				// A model that hit a limit stays out of the walk until its reset, even
				// into a new task: another request would only fail again.
				isExhausted: (candidate) =>
					usageExhausted(cache, candidate.provider, now, candidate.model) ||
					(limited.get(candidate.spec)?.resetAt ?? 0) > now,
			});

		let plan = planFailover(progress, settings.maxSwitches, pick());
		while (plan.action === "switch") {
			const target = plan.next;
			if (await applyModel(ctx, target)) {
				progress.switches += 1;
				tried.add(target.spec);
				switchedToSpec = target.spec;
				// A switch leaves a model to come back to; a stop below leaves no timer.
				armWake(spec.spec, settings);
				const resetAt = limited.get(spec.spec)?.resetAt;
				const when =
					resetAt === undefined
						? ""
						: cachedReset === undefined
							? ` (retry ~${resetLabel(resetAt, now)})`
							: ` (back after ${resetLabel(resetAt, now)})`;
				notify(ctx, `failover: ${spec.spec} hit its ${verdict.reason ?? "usage limit"}; continuing on ${target.spec}${when}`, "info");
				stoppedUnfinished = false;
				continueRun();
				return;
			}
			progress.failedSwitches += 1;
			tried.add(target.spec);
			plan = planFailover(progress, settings.maxSwitches, pick());
		}
		stop(ctx, settings, plan.reason);
	};

	pi.on("input", (event) => {
		// Our own "continue" is an extension input; a message from Eric is a new task,
		// with a fresh budget and nobody waiting to type "continue" for him.
		if (event.source === "extension") return;
		resetTask();
		stoppedUnfinished = false;
		returnAtIdle = false;
		wakeContinues = 0;
	});

	const reset = (): void => {
		clearAllWakes();
		returnAtIdle = false;
		stoppedUnfinished = false;
		lastLimit = undefined;
		switchedToSpec = undefined;
		wakeContinues = 0;
		lastCtx = undefined;
		settingsCache.value = undefined;
		settingsCache.mtimeMs = undefined;
		resetTask();
	};

	pi.on("session_start", () => {
		reset();
	});

	/** One settle's worth of work, kept separate so a throw cannot escape into pi. */
	const onSettled = async (event: { aborted?: boolean }, ctx: ExtensionContext): Promise<void> => {
		lastCtx = ctx;
		if (ctx.mode === "print" || ctx.mode === "json") return;
		if (event.aborted) {
			// Eric stopped this himself; a deferred switch-back is not his request any more.
			returnAtIdle = false;
			return;
		}
		const settings = readSettings();
		if (!settings.enabled) {
			clearAllWakes();
			return;
		}
		const last = lastAssistant(branchOf(ctx));
		// An aborted stop is not a limit: `classifyUsageLimit` needs stopReason "error".
		const verdict = classifyUsageLimit(last);

		if (returnAtIdle) {
			returnAtIdle = false;
			let idle = false;
			try {
				idle = ctx.isIdle();
			} catch {
				idle = false;
			}
			if (idle && (await backToPreferred(ctx, settings, stoppedUnfinished))) return;
		}

		if (!verdict.limited) {
			// The work moved on, so a deferred return must not send "continue" later.
			stoppedUnfinished = false;
			return;
		}
		await handleLimit(ctx, settings, verdict);
	};

	pi.on("agent_settled", async (event, ctx) => {
		try {
			await onSettled(event, ctx);
		} catch {
			// A settle must never throw back into pi's runner (a malformed config, a stale ctx).
		}
	});

	pi.on("session_shutdown", () => {
		reset();
	});
}
