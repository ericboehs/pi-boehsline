/**
 * meeting.ts on Acme Copilot only: the scout, /q research, the prompt cap, and
 * the code rules that carry on when no Acme Copilot model answers.
 *
 * Its own file so the env is set before meeting.ts reads it at import.
 *
 * Run: node --test .pi-agent/test/meeting-work.test.mjs
 */

import "./helpers/acme-settings.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-work-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(process.env, {
	PI_MEETING_DIR: dir,
	PI_MEETING_QMD_COLLECTIONS: "",
	PI_MEETING_DAILY_DIR: "",
	PI_MEETING_ABOUT: path.join(dir, "no-about.md"),
	PI_MEETING_ME: "Eric Boehs",
});
delete process.env.PI_MEETING_MODEL;
delete process.env.PI_MEETING_RESEARCH_MODEL;

const { default: meeting, buildUserPrompt, fitUserPrompt, researchModel, ruleAlert, widgetLines } = await import("../extensions/opt-in/meeting/index.ts");
const { estTokens, isWorkModel, modelSpecs, PERSONAL_MODELS, PROMPT_MAX_TOKENS, WORK_MODELS, WORK_RESEARCH_MODEL, workOnly } = await import(
	"../extensions/opt-in/watch/models.ts"
);

const plain = { fg: (_color, s) => s };

// ── which models ──

test("only Acme Copilot may read work text", () => {
	assert.deepEqual(WORK_MODELS, ["github-copilot/claude-haiku-5.5"]);
	assert.ok(WORK_MODELS.every(isWorkModel) && isWorkModel(WORK_RESEARCH_MODEL));
	assert.ok(!PERSONAL_MODELS.some(isWorkModel), "DeepSeek and GLM are personal only");
	assert.deepEqual(workOnly(["opencode-go/deepseek-v4.1-flash", "github-copilot/claude-haiku-5.5", "openrouter/anthropic/claude"]), {
		ok: ["github-copilot/claude-haiku-5.5"],
		refused: ["opencode-go/deepseek-v4.1-flash", "openrouter/anthropic/claude"],
	});
	assert.ok(isWorkModel("GitHub-Copilot/claude-haiku-5.5"));
	assert.ok(!isWorkModel("claude-haiku-5.5"), "no provider, no pass");
	assert.deepEqual(modelSpecs(" a/b, c  d/e "), ["a/b", "d/e"]);
	assert.deepEqual(modelSpecs(undefined), []);
});

test("meeting.ts names no model outside Acme Copilot", () => {
	const src = fs.readFileSync(fileURLToPath(new URL("../extensions/opt-in/meeting/index.ts", import.meta.url)), "utf8");
	assert.doesNotMatch(src, /deepseek|opencode|glm-|openrouter/i);
});

test("/q research: the configured model or the session's if on Acme Copilot, else Opus there", () => {
	assert.deepEqual(researchModel("github-copilot/claude-haiku-5.5", "github-copilot/claude-opus-5.5"), { model: "github-copilot/claude-haiku-5.5", refused: "" });
	assert.deepEqual(researchModel("", "github-copilot/claude-opus-5.5"), { model: "github-copilot/claude-opus-5.5", refused: "" });
	assert.deepEqual(researchModel("", "opencode-go/deepseek-v4.1-flash"), { model: WORK_RESEARCH_MODEL, refused: "opencode-go/deepseek-v4.1-flash" });
	assert.deepEqual(researchModel("anthropic/claude-opus-5.5", "github-copilot/claude-opus-5.5"), { model: WORK_RESEARCH_MODEL, refused: "anthropic/claude-opus-5.5" });
	assert.deepEqual(researchModel("", ""), { model: WORK_RESEARCH_MODEL, refused: "" });
});

// ── the prompt cap ──

const input = (lines) => ({
	title: "CORE Weekly Sync",
	app: "Teams",
	people: [],
	lines,
	newFrom: Math.max(0, lines.length - 5),
	open: [],
	focus: "",
	cue: null,
	me: "Eric Boehs",
	now: new Date(2026, 9, 7, 10, 30),
});
const talk = (n) => Array.from({ length: n }, (_, i) => `[10:${String(i % 60).padStart(2, "0")}:00] Speaker ${i % 7}: ${"some words here ".repeat(5)}line ${i}`);

test("a short meeting's prompt is untouched", () => {
	const p = input(talk(10));
	assert.equal(fitUserPrompt("system", p), buildUserPrompt(p));
});

test("a long meeting keeps its newest lines and stays under the cap", () => {
	const p = input(talk(4000));
	const system = "s".repeat(120_000); // a big background: ~40k tokens
	const user = fitUserPrompt(system, p);
	assert.ok(estTokens(system) + estTokens(user) <= PROMPT_MAX_TOKENS, `${estTokens(system) + estTokens(user)} tokens`);
	assert.match(user, /line 3999\n<\/transcript>/, "the newest line stays");
	assert.match(user, /<transcript>\n\[… earlier lines omitted …\]\n/);
	assert.ok(estTokens(buildUserPrompt(p)) > estTokens(user), "trimmed below the plain cap");
});

test("when even the background is too big, the transcript shrinks to its marker", () => {
	const user = fitUserPrompt("s".repeat(120_000), input(talk(50)), 1000);
	assert.match(user, /<transcript>\n\[… earlier lines omitted …\]\n<\/transcript>/);
});

// ── rules ──

test("ruleAlert says who named you or asked for questions, clipped", () => {
	assert.equal(ruleAlert("mention", { speaker: "Sam Rivera", text: "Eric, can you  take this one?" }), 'Sam Rivera named you: "Eric, can you take this one?"');
	assert.equal(ruleAlert("invite", { speaker: "Jordan Blake", text: "Any questions?" }), 'Jordan Blake asked for questions: "Any questions?"');
	assert.equal(ruleAlert("mention", undefined), "Someone named you");
	assert.equal(ruleAlert(null, { speaker: "A", text: "b" }), "");
	const long = ruleAlert("mention", { speaker: "A", text: "x".repeat(300) });
	assert.ok(long.endsWith('…"') && long.length < 170);
});

test("widget: rules only in place of the check count, and the alert below", () => {
	const view = {
		phase: "live",
		title: "CORE Weekly Sync",
		startedMs: 0,
		topic: "",
		checks: 0,
		cost: 0,
		busy: false,
		error: "",
		questions: [],
		shown: [],
		expanded: false,
		reply: "",
		replay: false,
		endsAt: 0,
		rulesOnly: true,
		alert: 'Jordan Blake asked for questions: "Any questions?"',
	};
	assert.deepEqual(widgetLines(view, plain, 120), [
		"● meeting · CORE Weekly Sync · rules only · /meeting stop",
		'  ! Jordan Blake asked for questions: "Any questions?"',
	]);
});

// ── the extension ──

test("/meeting replay with a DeepSeek --model and no Acme Copilot credentials: refused, rules only, no model called", async (t) => {
	const file = path.join(dir, "20261007_100000-teams-team-weekly-sync.jsonl");
	fs.writeFileSync(
		file,
		[
			{ type: "metadata", meeting: "CORE Weekly Sync", app: "Teams", meeting_started_at: "2026-10-07T10:00:00-05:00" },
			{ type: "caption", ts: "2026-10-07T10:00:01-05:00", speaker: "Jordan Blake", text: "Runner migration is on track." },
			{ type: "caption", ts: "2026-10-07T10:00:02-05:00", speaker: "Sam Rivera", text: "Eric, can you take the Dynatrace piece?" },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);
	const commands = {};
	const sent = [];
	const notes = [];
	const found = [];
	const widgets = [];
	let called = 0;
	meeting({
		on: () => {},
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name, def) => (commands[name] = def),
		registerMessageRenderer: () => {},
		registerTool: () => {},
		sendMessage: (m) => sent.push(m),
	});
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: dir,
		model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
		modelRegistry: {
			find: (provider, id) => (found.push(`${provider}/${id}`), { provider, id, name: id }),
			hasConfiguredAuth: () => false,
			streamSimple: () => {
				called++;
				throw new Error("no model may be called");
			},
		},
		ui: {
			notify: (m, level) => notes.push(`${level ?? "info"}: ${m}`),
			setWidget: (_key, factory) => widgets.push(factory ? factory(null, plain).render(160) : undefined),
		},
	};
	t.after(() => commands.meeting.handler("stop", ctx));
	await commands.meeting.handler(`replay 100 ${file} --model opencode-go/deepseek-v4.1-flash`, ctx);

	const alert = '  ! Sam Rivera named you: "Eric, can you take the Dynatrace piece?"';
	const end = Date.now() + 8000;
	while (!widgets.some((w) => w?.includes(alert))) {
		assert.ok(Date.now() < end, `no alert in the widget; notes: ${notes.join(" | ")}`);
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(notes.includes("warning: Not Acme Copilot, so never given meeting text: opencode-go/deepseek-v4.1-flash"), notes.join(" | "));
	assert.ok(notes.some((n) => n.startsWith("warning: No Acme Copilot scout with credentials (none given); cues by rule only")), notes.join(" | "));
	assert.deepEqual(found, [], "the registry was never asked for a non-work model");
	assert.equal(called, 0, "no model call in rules-only mode");
	assert.match(sent[0].content, /via rules only/);
	assert.match(widgets.find((w) => w?.includes(alert))[0], /rules only/);
});

test("/meeting replay with Haiku failing: only Haiku is tried, the cue still shows by rule, the error says why", async (t) => {
	const file = path.join(dir, "20261007_110000-teams-platform-sync.jsonl");
	fs.writeFileSync(
		file,
		[
			{ type: "metadata", meeting: "Platform Sync", app: "Teams", meeting_started_at: "2026-10-07T11:00:00-05:00" },
			{ type: "caption", ts: "2026-10-07T11:00:01-05:00", speaker: "Jordan Blake", text: "That's the plan. Any questions?" },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);
	const commands = {};
	const asked = [];
	const widgets = [];
	meeting({
		on: () => {},
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name, def) => (commands[name] = def),
		registerMessageRenderer: () => {},
		registerTool: () => {},
		sendMessage: () => {},
	});
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: dir,
		model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
		modelRegistry: {
			find: (provider, id) => ({ provider, id, name: id }),
			hasConfiguredAuth: (m) => m.provider === "github-copilot",
			streamSimple: (m) => {
				asked.push(`${m.provider}/${m.id}`);
				return { result: async () => ({ stopReason: "error", errorMessage: "429 rate limited", content: [], usage: { cost: { total: 0 } } }) };
			},
		},
		ui: { notify: () => {}, setWidget: (_key, factory) => widgets.push(factory ? factory(null, plain).render(200) : undefined) },
	};
	t.after(() => commands.meeting.handler("stop", ctx));
	await commands.meeting.handler(`replay 100 ${file}`, ctx);

	const alert = '  ! Jordan Blake asked for questions: "That\'s the plan. Any questions?"';
	const end = Date.now() + 8000;
	while (!widgets.some((w) => w?.includes(alert))) {
		assert.ok(Date.now() < end, "no alert in the widget");
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(asked.length >= 1 && asked.every((s) => s === "github-copilot/claude-haiku-5.5"), asked.join(", "));
	assert.match(widgets.find((w) => w?.includes(alert))[0], /error: github-copilot\/claude-haiku-5\.5: 429 rate limited/);
});

// ── auto start, ownership and the meeting tool ──
//
// Sessions here share one process, so they tell each other apart by session id,
// the way two real sessions would by pid. State, lock and data live in a temp
// dir per test; nothing touches the real ~/.local/state or ~/.pi/agent.

const iso = (ms) => {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
};
const until = async (fn, what, ms = 9000) => {
	const end = Date.now() + ms;
	while (!fn()) {
		assert.ok(Date.now() < end, `timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 40));
	}
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** A pid nobody holds: the child has already exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const BIG = 4 * 1024 * 1024 + 10;
// Real jpegs, since the slide tool scales them like the read tool: 16x16, and 2400x16 (over the 2000 px side it allows).
const SMALL_JPG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCaAohj/9k=", "base64");
const WIDE_JPG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQCWADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCAJa0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//Z", "base64");

/** A temp world: capture state dir, data dir and lock file, env pointed at it. */
function world(t, { owner = "earl" } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-auto-"));
	const saved = Object.fromEntries(["MEETING_CAPTURE_STATE_DIR", "PI_MEETING_LOCK", "PI_MEETING_OWNER", "PI_MEETING_WATCH"].map((k) => [k, process.env[k]]));
	process.env.MEETING_CAPTURE_STATE_DIR = path.join(root, "state");
	process.env.PI_MEETING_LOCK = path.join(root, "meeting-owner.json");
	process.env.PI_MEETING_OWNER = owner;
	delete process.env.PI_MEETING_WATCH;
	fs.mkdirSync(path.join(root, "state"));
	fs.mkdirSync(path.join(root, "data"));
	const sessions = [];
	t.after(async () => {
		for (const s of sessions) await s.fire("session_shutdown");
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
		fs.rmSync(root, { recursive: true, force: true });
	});
	const statePath = path.join(root, "state", "state.json");
	const lockPath = process.env.PI_MEETING_LOCK;
	const w = {
		root,
		lockPath,
		lock: () => JSON.parse(fs.readFileSync(lockPath, "utf8")),
		/** A finished-or-running capture: captions, chat, people, 3 slides, a revisit. Returns the state record. */
		capture(over = {}, { startedAt = Date.now() - 16 * 60_000, name = "weekly-sync" } = {}) {
			const base = path.join(root, "data", `20261028_140000-teams-${name}`);
			const slides = `${base}.slides`;
			fs.mkdirSync(slides, { recursive: true });
			const at = (min) => iso(startedAt + min * 60_000);
			const jpg = (n, file, bytes) => fs.writeFileSync(path.join(slides, file), bytes);
			jpg(1, "0001-140100.jpg", WIDE_JPG);
			jpg(2, "0002-141000.jpg", SMALL_JPG);
			jpg(3, "0003-141400.jpg", Buffer.alloc(BIG, 1));
			fs.writeFileSync(path.join(slides, "0002-141000.txt"), "Cert rotation plan\nOwner: Amy\n");
			fs.writeFileSync(
				path.join(slides, "index.jsonl"),
				[1, 2, 3].map((n) => JSON.stringify({ n, at: at([0, 1, 10, 14][n]), file: `000${n}-14${["", "0100", "1000", "1400"][n]}.jpg`, reason: "change", width: 2880, height: 2560 })).join("\n") + "\n",
			);
			fs.writeFileSync(
				`${base}.jsonl`,
				[
					{ type: "metadata", meeting: "Weekly Sync", app: "Microsoft Teams", meeting_started_at: at(0) },
					{ type: "caption", speaker: "Ada Lovelace", text: "Morning everyone, let's start.", ts: at(0.5) },
					{ type: "people", count: 3, people: ["Ada Lovelace", "Smith, Amy (ORG)", "Alan Turing"], ts: at(0.6) },
					{ type: "slide", slide: 1, file: "0001-140100.jpg", ts: at(1) },
					{ type: "caption", speaker: "Smith, Amy (ORG)", text: "The cert expires on Friday so we rotate it Thursday.", ts: at(5) },
					{ type: "chat", speaker: "Alan Turing", text: "Link to the runbook?", ts: at(6) },
					{ type: "slide", slide: 2, file: "0002-141000.jpg", ts: at(10) },
					{ type: "slide", slide: 3, file: "0003-141400.jpg", ts: at(14) },
					{ type: "revisit", slide: 2, reason: "revisit", file: "0002-141000.jpg", ts: at(15) },
				]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n",
			);
			return w.state({ jsonl: `${base}.jsonl`, txt: `${base}.txt`, slides_dir: slides, started_at: at(0), ...over });
		},
		/** state.json, written atomically like meeting-capture does. */
		state(over = {}) {
			const s = {
				v: 1,
				pid: process.pid,
				app: "Microsoft Teams",
				app_id: "teams",
				meeting: "Weekly Sync",
				started_at: iso(Date.now() - 16 * 60_000),
				jsonl: null,
				txt: null,
				slides_dir: null,
				live: path.join(root, "state", "live.json"),
				ended: false,
				...over,
			};
			fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(s));
			fs.renameSync(`${statePath}.tmp`, statePath);
			return s;
		},
		session(name, id = `${name}-id`, entries = []) {
			const handlers = new Map();
			const tools = {};
			const commands = {};
			const sent = [];
			const notes = [];
			const widgets = [];
			const emits = [];
			const pi = {
				on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
				events: { on: () => {}, emit: (name, data) => emits.push([name, data]) },
				registerCommand: (n, d) => (commands[n] = d),
				registerMessageRenderer: () => {},
				registerTool: (tool) => (tools[tool.name] = tool),
				sendMessage: (m) => sent.push(m),
				appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
				getSessionName: () => name,
			};
			meeting(pi);
			const ctx = {
				hasUI: true,
				mode: "tui",
				cwd: root,
				sessionManager: { getSessionId: () => id, getBranch: () => entries },
				modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, streamSimple: () => assert.fail("no model may be called") },
				ui: { notify: (m) => notes.push(m), setWidget: (_k, f) => widgets.push(f ? f(null, plain).render(200) : undefined) },
			};
			const s = {
				name,
				sent,
				notes,
				widgets,
				emits,
				entries,
				fire: async (event, e = {}) => {
					for (const fn of handlers.get(event) ?? []) await fn(e, ctx);
				},
				command: (raw) => commands.meeting.handler(raw, ctx),
				tool: async (params) => tools.meeting.execute("id", params, undefined, undefined, ctx),
				toolText: async (params) => (await s.tool(params)).content.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n"),
				prompt: async () => {
					const e = { systemPromptOptions: { sections: {} } };
					await s.fire("before_agent_start", e);
					return e.systemPromptOptions.sections.meeting;
				},
				started: () => sent.filter((m) => /^Meeting copilot on "/.test(m.content)).length,
				stopped: () => sent.some((m) => /^Meeting copilot stopped/.test(m.content)),
				showing: () => widgets.at(-1)?.[0] ?? "",
				tools,
			};
			sessions.push(s);
			return s;
		},
	};
	return w;
}

test("an owner-named session starts on a live meeting, holds the lock, and finishes when it ends", async (t) => {
	const w = world(t);
	w.capture();
	const earl = w.session("Earl");
	assert.equal(await earl.prompt(), undefined, "no meeting yet: nothing in the system prompt");
	await earl.fire("session_start");
	await until(() => earl.started() === 1, "the copilot to start");

	const lock = w.lock();
	assert.deepEqual([lock.pid, lock.sessionId, lock.name, lock.via], [process.pid, "Earl-id", "Earl", "owner"]);
	assert.equal(fs.statSync(w.lockPath).mode & 0o777, 0o600);
	assert.match(earl.showing(), /^● meeting · Weekly Sync · 16m · /, "the header shows an auto-started meeting");
	assert.match(earl.sent[0].content, /Meeting copilot on "Weekly Sync" \(Microsoft Teams\) via rules only/);
	assert.match(await earl.prompt(), /^A meeting is live: Weekly Sync \(Microsoft Teams\), 15 min in, slide 2 on screen\. Use the meeting tool for anything about it\.$/);

	// The meeting ends: the recap goes out, the prompt line goes away, and it does not restart.
	w.state({ ...JSON.parse(fs.readFileSync(path.join(w.root, "state", "state.json"), "utf8")), ended: true, ended_at: iso(Date.now()), duration: "0:16:00" });
	await until(() => earl.stopped(), "the copilot to stop");
	assert.match(earl.sent.at(-1).content, /^Meeting copilot stopped \(meeting ended\)/);
	assert.equal(await earl.prompt(), undefined);
	await wait(2600);
	assert.equal(earl.started(), 1, "the same started_at never restarts after it ended");
	await earl.command("");
	assert.match(earl.notes.at(-1), /Copilot: not running/);
	assert.match(earl.notes.at(-1), /Meeting: none live; the last was Weekly Sync \(Microsoft Teams\), ended, 0:16:00/);

	await earl.fire("session_shutdown");
	assert.equal(fs.existsSync(w.lockPath), false, "shutdown releases the lock");
});

test("a session that is neither armed nor the owner stays out of it, but can read the meeting", async (t) => {
	const w = world(t);
	w.capture();
	const bob = w.session("bob");
	await bob.fire("session_start");
	await wait(600);
	assert.equal(fs.existsSync(w.lockPath), false, "no lock taken");
	assert.deepEqual([bob.sent.length, bob.widgets.length], [0, 0]);
	assert.equal(await bob.prompt(), undefined, "no prompt line for a meeting it doesn't run");
	assert.match(await bob.toolText({ action: "status" }), /Meeting: Weekly Sync \(Microsoft Teams\)\nState: live\n/);
});

test("/meeting watch takes the lock from a running owner; the owner steps aside and returns only when the lock frees", async (t) => {
	const w = world(t);
	w.capture();
	const earl = w.session("earl");
	await earl.fire("session_start");
	await until(() => earl.started() === 1, "the owner to start");

	const other = w.session("other");
	await other.fire("session_start");
	await other.command("watch");
	assert.ok(other.notes.some((n) => n === "Meeting watch on: this session runs the copilot, taking over from earl"), other.notes.join(" | "));
	assert.deepEqual(other.entries, [{ type: "custom", customType: "meeting-watch", data: { armed: true } }], "armed is saved in the session");
	assert.deepEqual([w.lock().name, w.lock().via], ["other", "watch"], "the lock is overwritten at once");
	await until(() => other.started() === 1, "the watcher to start");
	await until(() => earl.notes.includes("Meeting copilot moved to other"), "the owner to notice");
	assert.equal(earl.widgets.at(-1), undefined, "its widget is cleared");
	assert.equal(earl.stopped(), false, "it stops quietly: no recap message");
	assert.equal(earl.notes.filter((n) => n.startsWith("Meeting copilot moved")).length, 1, "one notify");
	await wait(2600);
	assert.equal(w.lock().name, "other", "the owner doesn't take it back");
	assert.equal(earl.started(), 1);

	// Disarming frees the lock; the owner picks the same meeting up again.
	await other.command("watch off");
	assert.deepEqual(other.entries.at(-1), { type: "custom", customType: "meeting-watch", data: { armed: false } });
	assert.ok(other.notes.includes("Meeting watch off"), other.notes.join(" | "));
	assert.equal(other.stopped(), true, "the disarmed copilot finishes");
	await until(() => earl.started() === 2, "the owner to start again once the lock freed");
	assert.deepEqual([w.lock().name, w.lock().via], ["earl", "owner"]);
});

test("/meeting watch off then on again in the same meeting resumes the copilot", async (t) => {
	const w = world(t, { owner: "" });
	w.capture();
	const s = w.session("anyone", "a1");
	await s.fire("session_start");
	await s.command("watch");
	await until(() => s.started() === 1, "the watcher to start");
	await s.command("watch off");
	assert.equal(s.stopped(), true);
	await s.command("watch");
	await until(() => s.started() === 2, "the copilot to resume for the same meeting");
	assert.equal(w.lock().sessionId, "a1");
});

test("an unreadable lock file that was only just created is left alone; a stale one is taken over", async (t) => {
	const w = world(t);
	w.capture();
	fs.writeFileSync(w.lockPath, ""); // another session between create and write
	const s = w.session("earl", "earl-1");
	await s.fire("session_start");
	await wait(600);
	assert.equal(s.started(), 0, "backed off");
	assert.equal(fs.readFileSync(w.lockPath, "utf8"), "");
	const old = new Date(Date.now() - 10_000);
	fs.utimesSync(w.lockPath, old, old);
	await until(() => s.started() === 1, "the stale file to be taken over");
	assert.equal(w.lock().sessionId, "earl-1");
});

test("armed is restored from the session, and PI_MEETING_WATCH arms too", async (t) => {
	const w = world(t, { owner: "" });
	w.capture();
	const resumed = w.session("anyone", "r1", [
		{ type: "custom", customType: "meeting-watch", data: { armed: true } },
		{ type: "custom", customType: "other", data: {} },
	]);
	await resumed.fire("session_start");
	await until(() => resumed.started() === 1, "a resumed armed session to start");
	assert.equal(w.lock().via, "watch");
	await resumed.command("");
	assert.match(resumed.notes.at(-1), /^Armed: yes \(\/meeting watch\)\nOwner setting: \(none\) · this session is anyone\nLock: this session \(via watch/);
	await resumed.fire("session_shutdown");

	const off = w.session("anyone", "r2", [
		{ type: "custom", customType: "meeting-watch", data: { armed: true } },
		{ type: "custom", customType: "meeting-watch", data: { armed: false } },
	]);
	await off.fire("session_start");
	await wait(500);
	assert.equal(off.started(), 0, "the last entry wins: disarmed");

	process.env.PI_MEETING_WATCH = "1";
	const env = w.session("anyone", "r3");
	await env.fire("session_start");
	await until(() => env.started() === 1, "an env-armed session to start");
});

test("/meeting stop ends it for good; a new started_at is a new meeting. Captions can arrive late", async (t) => {
	const w = world(t);
	const startedAt = Date.now() - 60_000;
	w.state({ started_at: iso(startedAt), jsonl: null });
	const earl = w.session("earl");
	await earl.fire("session_start");
	await until(() => earl.showing().startsWith("◌ meeting · Weekly Sync · waiting for captions"), "waiting for captions");
	assert.match(await earl.toolText({ action: "transcript" }), /has no transcript yet/);
	assert.match(await earl.prompt(), /^A meeting is live: Weekly Sync \(Microsoft Teams\), just started\. Use/, "no slide named until there is one");

	w.capture({}, { startedAt });
	await until(() => earl.started() === 1, "captions to attach");
	assert.match(earl.showing(), /^● meeting · Weekly Sync/);

	await earl.command("stop");
	assert.match(earl.sent.at(-1).content, /^Meeting copilot stopped \(\/meeting stop\)/);
	await wait(2600);
	assert.equal(earl.started(), 1, "stopped means stopped");

	w.capture({ started_at: iso(startedAt + 1000) }, { startedAt: startedAt + 1000, name: "retro" });
	await until(() => earl.started() === 2, "a new meeting to start");
});

test("/meeting stop survives /reload, a new session and an armed watcher; only a new started_at starts again", async (t) => {
	const w = world(t);
	const startedAt = Date.now() - 60_000;
	w.capture({}, { startedAt });
	const first = w.session("earl", "earl-1");
	await first.fire("session_start");
	await until(() => first.started() === 1, "the copilot to start");
	await first.command("stop");
	assert.match(first.sent.at(-1).content, /^Meeting copilot stopped \(\/meeting stop\)/);
	const file = path.join(w.root, "meeting-stopped.json");
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).stopped, [iso(startedAt)], "shared file beside the lock");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	await first.fire("session_shutdown");

	// /reload: a fresh extension instance for the same session name, and one armed with /meeting watch.
	const reloaded = w.session("earl", "earl-2");
	const watcher = w.session("other", "other-1", [{ type: "custom", customType: "meeting-watch", data: { armed: true } }]);
	await reloaded.fire("session_start");
	await watcher.fire("session_start");
	await wait(2600);
	assert.deepEqual([reloaded.started(), watcher.started()], [0, 0], "a stopped meeting stays stopped");
	assert.equal(fs.existsSync(w.lockPath), false, "nobody took the lock for it");

	// Ended meetings need no entry (ended:true blocks them), and a new started_at is a new meeting.
	w.capture({ started_at: iso(startedAt + 5000) }, { startedAt: startedAt + 5000, name: "retro" });
	await until(() => reloaded.started() + watcher.started() === 1, "a new meeting to start");
});

test("shutdown while the copilot is still starting leaves nothing running and no lock behind", async (t) => {
	const w = world(t);
	w.capture();
	process.env.PI_MEETING_ME = ""; // make newMeeting look up git's user.name: a real async wait
	t.after(() => (process.env.PI_MEETING_ME = "Eric Boehs"));
	const gone = w.session("earl", "earl-1");
	await gone.fire("session_start"); // claimed (created the lock), now waiting in newMeeting
	assert.equal(w.lock().sessionId, "earl-1");
	await gone.fire("session_shutdown");
	assert.equal(fs.existsSync(w.lockPath), false, "shutdown released the lock");
	await wait(900);
	assert.equal(gone.started(), 0, "the old instance doesn't start a copilot");
	assert.equal(gone.emits.some(([, d]) => d?.active === true), false, "and doesn't hold watch.ts's digests");
	assert.equal(gone.widgets.some(Boolean), false);
	assert.equal(fs.existsSync(w.lockPath), false, "or take the lock again");

	// The reloaded instance starts it, once.
	process.env.PI_MEETING_ME = "Eric Boehs";
	const fresh = w.session("earl", "earl-2");
	await fresh.fire("session_start");
	await until(() => fresh.started() === 1, "the new instance to start");
	await wait(2300);
	assert.equal(fresh.started(), 1);
	assert.equal(w.lock().sessionId, "earl-2");
});

test("shutdown while a takeover waits for its re-read leaves no lock either", async (t) => {
	const w = world(t);
	w.capture();
	fs.writeFileSync(w.lockPath, JSON.stringify({ pid: deadPid(), sessionId: "ghost", name: "ghost", via: "owner", at: iso(Date.now()) }));
	const gone = w.session("earl", "earl-1");
	await gone.fire("session_start"); // wrote its lock over the dead holder's, now in the 100-300 ms wait
	assert.equal(w.lock().sessionId, "earl-1");
	await gone.fire("session_shutdown");
	await wait(500);
	assert.equal(gone.started(), 0);
	assert.equal(fs.existsSync(w.lockPath), false, "its half-claimed lock was taken back");
});

test("two sessions claiming back to back in one process: with a dead holder or none, exactly one starts and the lock names it", async (t) => {
	for (const holder of ["dead", "none"]) {
		const w = world(t);
		w.capture();
		if (holder === "dead") fs.writeFileSync(w.lockPath, JSON.stringify({ pid: deadPid(), sessionId: "ghost", name: "ghost", via: "owner", at: iso(Date.now()) }));
		const a = w.session("earl", "a-id");
		const b = w.session("earl", "b-id");
		await Promise.all([a.fire("session_start"), b.fire("session_start")]);
		await until(() => a.started() + b.started() >= 1, `one of two to start (${holder})`);
		await wait(2600);
		assert.equal(a.started() + b.started(), 1, `exactly one copilot (${holder} holder)`);
		assert.equal(w.lock().sessionId, a.started() ? "a-id" : "b-id", "the lock names the one that started");
		assert.equal(a.notes.concat(b.notes).filter((n) => n.startsWith("Meeting copilot moved")).length, 0, "the loser never started, so nothing moved");
	}
});

test("a session that loses the lock write during its re-read delay doesn't start", async (t) => {
	const w = world(t);
	w.capture();
	fs.writeFileSync(w.lockPath, JSON.stringify({ pid: deadPid(), sessionId: "ghost", name: "ghost", via: "owner", at: iso(Date.now()) }));
	const loser = w.session("earl", "a-id");
	const winner = w.session("earl", "b-id");
	await loser.fire("session_start"); // wrote its lock, waiting 100-300 ms
	// The other session's write lands after ours (another process, in real life).
	fs.writeFileSync(w.lockPath, JSON.stringify({ pid: process.pid, sessionId: "b-id", name: "earl", via: "owner", at: iso(Date.now()) }));
	await winner.fire("session_start");
	await until(() => winner.started() === 1, "the winner to start");
	await wait(2600);
	assert.equal(loser.started(), 0, "the loser read the lock back as not its own");
	assert.equal(w.lock().sessionId, "b-id");
	assert.equal(loser.widgets.some(Boolean), false);
});

test("/meeting start points at watch; unknown words say so; replay still plays a finished transcript", async (t) => {
	const w = world(t, { owner: "" });
	const state = w.capture();
	const s = w.session("solo");
	await s.fire("session_start");
	await s.command("start");
	assert.match(s.notes.at(-1), /Meetings start by themselves now: \/meeting watch arms this session\. To test, \/meeting replay/);
	await s.command("whatever");
	assert.match(s.notes.at(-1), /^Unknown: \/meeting whatever\./);

	await s.command(`replay 100000 ${state.jsonl}`);
	assert.match(s.sent[0].content, /^Meeting copilot replaying/);
	assert.equal(fs.existsSync(w.lockPath), false, "a replay takes no lock");
	assert.match(await s.prompt(), /^A meeting replay is running: /);
	assert.match(await s.toolText({ action: "status" }), /^This is a replay of .*\n\nMeeting: /);
	await s.command("stop");
	assert.equal(await s.prompt(), undefined);
});

test("meeting tool: transcript filters, markers, live lines, and the cut header", async (t) => {
	const w = world(t);
	const state = w.capture();
	const reader = w.session("reader");
	const ask = (params) => reader.toolText({ action: "transcript", ...params });

	const all = await ask({});
	assert.match(all, /^Meeting: Weekly Sync \(Microsoft Teams\) · started \d\d:\d\d:\d\d · 8 lines match\n/);
	assert.match(all, /\] Ada Lovelace: Morning everyone, let's start\.\n/);
	assert.match(all, /\] 👥 3 in the meeting\n/);
	assert.match(all, /\] ▣ slide 1\n/);
	assert.match(all, /\] \(chat\) Alan Turing: Link to the runbook\?\n/);
	assert.match(all, /\] ↺ back to slide 2$/);

	assert.match(await ask({ speaker: "amy", query: "CERT friday" }), /1 line match\n\[\d\d:\d\d:\d\d\] Smith, Amy \(ORG\): The cert expires on Friday/);
	assert.match(await ask({ speaker: "amy", query: "kubernetes" }), /^No transcript lines match\.$/);
	const recent = await ask({ minutes: 3 });
	assert.match(recent, /slide 3\n.*back to slide 2$/s);
	assert.doesNotMatch(recent, /Morning everyone/, "only the last 3 minutes");
	assert.match(await ask({ since: "nope" }), /^Can't read since "nope"/);
	assert.match(await ask({ limit: 2 }), /\[… 6 earlier lines cut, over 2 lines; narrow with minutes/);

	// Words still being spoken come last, marked, unless the window ends before now.
	fs.writeFileSync(state.live, JSON.stringify({ lines: [{ speaker: "Grace Hopper", text: "the deploy is green", ts: iso(Date.now()) }] }));
	assert.match(await ask({}), /Grace Hopper: the deploy is green \(still speaking\)$/);
	assert.doesNotMatch(await ask({ until: iso(Date.now()) }), /still speaking/);
	assert.doesNotMatch(await ask({ speaker: "amy" }), /still speaking/);
});

test("meeting tool: status and slides (OCR, image, revisits, a missing OCR, a huge image)", async (t) => {
	const w = world(t);
	w.capture();
	const reader = w.session("reader");

	assert.equal(
		await reader.toolText({ action: "status" }),
		[
			"Meeting: Weekly Sync (Microsoft Teams)",
			"State: live",
			`Started: ${clockOf(Date.now() - 16 * 60_000)}`,
			"Elapsed: 16 min",
			"People: 3: Ada Lovelace, Smith, Amy (ORG), Alan Turing",
			"Slides: 3, slide 2 on screen",
			"OCR: 1 of 3 slides",
		].join("\n"),
	);

	const onScreen = await reader.tool({ action: "slide" });
	assert.equal(onScreen.content.length, 2, "text, then the picture");
	assert.equal(onScreen.content[1].type, "image");
	assert.equal(onScreen.content[1].mimeType, "image/jpeg");
	assert.equal(onScreen.content[1].data, SMALL_JPG.toString("base64"), "a small slide goes out as it is");
	assert.match(onScreen.content[0].text, /^Slide 2 \(on screen now\) of 3: 0002-141000\.jpg · 2880×2560 · change\nFirst shown at \d\d:\d\d:\d\d; back on screen at \d\d:\d\d:\d\d\n\nOCR text:\nCert rotation plan\nOwner: Amy$/);
	assert.equal(onScreen.details.slide, 2);

	const first = await reader.tool({ action: "slide", slide: 1 });
	assert.match(first.content[0].text, /^Slide 1 of 3: .*OCR text:\nOCR not ready yet\n\n\[Image: original 2400x16, displayed at 2000x13\. Multiply coordinates by 1\.20 to map to original image\.\]$/s);
	assert.equal(first.content[1].type, "image");
	assert.notEqual(first.content[1].data, WIDE_JPG.toString("base64"), "scaled down to the 2000 px limit");

	const huge = await reader.tool({ action: "slide", slide: 3 });
	assert.equal(huge.content.length, 1, "no image over 4 MB");
	assert.match(huge.content[0].text, /\(image skipped: 4\.0 MB is over the 4 MB limit\)$/);
	fs.writeFileSync(path.join(w.root, "data", "20261028_140000-teams-weekly-sync.slides", "0001-140100.jpg"), "not a picture");
	const broken = await reader.tool({ action: "slide", slide: 1 });
	assert.equal(broken.content.length, 1, "an image that can't be decoded or shrunk is left out");
	assert.match(broken.content[0].text, /\(image omitted: could not be resized below the inline image size limit\)$/);
	assert.match(await reader.toolText({ action: "slide", slide: 9 }), /^No slide 9\. Saved slides: 1 to 3\.$/);
});

test("meeting tool: an ended meeting says so; nothing at all says that; slides off says that", async (t) => {
	const w = world(t);
	const reader = w.session("reader");
	assert.match(await reader.toolText({ action: "status" }), /^No meeting-capture state at .*state\.json: no meeting has been captured/);

	w.capture({ ended: true, ended_at: iso(Date.now()), duration: "0:16:00" });
	const text = await reader.toolText({ action: "transcript", speaker: "amy" });
	assert.match(text, /^Nothing is live right now\. This is the most recent meeting, Weekly Sync \(Microsoft Teams\), which ended at \d\d:\d\d:\d\d\.\n\nMeeting: /);
	assert.match(text, /Smith, Amy \(ORG\): The cert/);
	const past = await reader.toolText({ action: "transcript", minutes: 1 });
	assert.match(past, /back to slide 2/, "minutes count back from the end of a finished meeting");
	assert.match(await reader.toolText({ action: "status" }), /State: ended at \d\d:\d\d:\d\d\n.*Ran: 16 min/s);

	w.capture({ slides_dir: null });
	assert.match(await reader.toolText({ action: "slide" }), /This meeting has no slides/);
	w.state({ pid: 2 ** 22 + 7, jsonl: JSON.parse(fs.readFileSync(path.join(w.root, "state", "state.json"), "utf8")).jsonl });
	assert.match(await reader.toolText({ action: "status" }), /^Nothing is live right now/, "a dead pid mid-meeting is a crash: not live");
});

test("meeting tool: registered read-only with guidelines", async (t) => {
	const w = world(t);
	const s = w.session("reader");
	const tool = s.tools.meeting;
	assert.equal(tool.name, "meeting");
	assert.equal(tool.annotations.readOnlyHint, true);
	assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["action", "limit", "minutes", "query", "since", "slide", "speaker", "until"]);
	assert.deepEqual(tool.parameters.required, ["action"]);
	assert.ok(tool.promptGuidelines.length >= 1 && tool.promptSnippet);
});

const clockOf = (ms) => iso(ms).slice(11, 19);
