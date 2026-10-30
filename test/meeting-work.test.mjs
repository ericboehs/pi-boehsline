/**
 * meeting.ts end to end: the notes scout (a scripted model), alerts, the notes
 * file, the one-line status, the recap, and the code rules that carry on when
 * no model answers; plus auto start, ownership and the meeting tool.
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

const { default: meeting, meetingId, buildNotesFile, emptyNotes, writeNotesFile } = await import("../extensions/opt-in/meeting/index.ts");
const { isWorkModel, modelSpecs, PERSONAL_MODELS, WORK_MODELS, workOnly } = await import(
	"../extensions/opt-in/watch/models.ts"
);

const plain = { fg: (_color, s) => s };

// ── which models ──

test("only Acme Copilot may read work text", () => {
	assert.deepEqual(WORK_MODELS, ["github-copilot/claude-haiku-5.5"]);
	assert.ok(WORK_MODELS.every(isWorkModel));
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

// ── the extension ──

/** A model registry whose scout answers from a script, one reply per call. */
function scripted(replies, { auth = true, fail = false } = {}) {
	const calls = [];
	return {
		calls,
		find: (provider, id) => ({ provider, id, name: "Claude Haiku 5.5" }),
		hasConfiguredAuth: () => auth,
		streamSimple: (model, context) => {
			calls.push({ model: `${model.provider}/${model.id}`, system: context.systemPrompt, user: context.messages[0].content });
			return {
				result: async () =>
					fail
						? { stopReason: "error", errorMessage: "429 rate limited", content: [], usage: { cost: { total: 0 } } }
						: { stopReason: "stop", content: [{ type: "text", text: typeof replies === "function" ? replies(calls.length) : (replies.shift() ?? "{}") }], usage: { cost: { total: 0.002 } } },
			};
		},
	};
}

function replayFixture(name, started, lines) {
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(file, [{ type: "metadata", meeting: lines.title, app: "Teams", meeting_started_at: started }, ...lines.records].map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
}

async function replaySession(t, registry) {
	const commands = {};
	const sent = [];
	const notes = [];
	const widgets = [];
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
		model: { provider: "opencode-go", id: "whatever" },
		sessionManager: { getBranch: () => [] },
		modelRegistry: registry,
		ui: {
			notify: (m, level) => notes.push(`${level ?? "info"}: ${m}`),
			setWidget: (_key, factory) => widgets.push(factory ? factory(null, plain).render(200) : undefined),
		},
	};
	t.after(() => commands.meeting.handler("stop", ctx));
	return { commands, ctx, sent, notes, widgets };
}

test("/meeting replay with no usable notes model: warns, calls nothing, and a name still alerts by code rule", async (t) => {
	const file = replayFixture("20261007_100000-teams-team-weekly-sync", "2026-10-07T10:00:00-05:00", {
		title: "CORE Weekly Sync",
		records: [
			{ type: "caption", ts: "2026-10-07T10:00:01-05:00", speaker: "Jordan Blake", text: "Runner migration is on track." },
			{ type: "caption", ts: "2026-10-07T10:00:02-05:00", speaker: "Sam Rivera", text: "Eric, can you take the Dynatrace piece?" },
		],
	});
	const registry = scripted([], { auth: false });
	registry.streamSimple = () => assert.fail("no model may be called");
	const s = await replaySession(t, registry);
	await s.commands.meeting.handler(`replay 100 ${file}`, s.ctx);

	await until(() => s.sent.some((m) => m.content.startsWith("🔔")), "the name alert");
	assert.ok(s.notes.some((n) => n.startsWith("warning: The meeting notes model isn't available (github-copilot/claude-haiku-5.5): no notes, only name alerts")), s.notes.join(" | "));
	assert.match(s.sent[0].content, /^Meeting copilot replaying "CORE Weekly Sync" at 100× via name alerts only$/);
	const alert = s.sent.find((m) => m.content.startsWith("🔔"));
	assert.equal(alert.content, '🔔 Sam Rivera said your name (10:00): "Eric, can you take the Dynatrace piece?"');
	assert.deepEqual([alert.customType, alert.display], ["meeting", true]);
	await until(() => s.widgets.some((w) => /^● CORE Weekly Sync \(replay\) · \d+m · 1 alert · name alerts only$/.test(w?.[0] ?? "")), "the status line", 4000);
	assert.ok(s.widgets.filter(Boolean).every((w) => w.length === 1), "one line");
});

test("/meeting replay with the scout failing: only the notes model is tried, the name alert stands, the error says why", async (t) => {
	const file = replayFixture("20261007_110000-teams-platform-sync", "2026-10-07T11:00:00-05:00", {
		title: "Platform Sync",
		records: [
			{ type: "caption", ts: "2026-10-07T11:00:01-05:00", speaker: "Jordan Blake", text: "That's the plan." },
			{ type: "caption", ts: "2026-10-07T11:00:02-05:00", speaker: "Jordan Blake", text: "Eric, does that work for you?" },
		],
	});
	const registry = scripted([], { fail: true });
	const s = await replaySession(t, registry);
	await s.commands.meeting.handler(`replay 100 ${file}`, s.ctx);

	await until(() => s.widgets.some((w) => w?.[0]?.includes("error: github-copilot/claude-haiku-5.5: 429 rate limited")), "the error in the status line");
	assert.ok(registry.calls.length >= 1 && registry.calls.every((c) => c.model === "github-copilot/claude-haiku-5.5"), registry.calls.map((c) => c.model).join(", "));
	assert.ok(s.sent.some((m) => m.content === '🔔 Jordan Blake said your name (11:00): "Eric, does that work for you?"'));
});

test("/meeting replay: a slide asks for an early call, notes come back, a name alert is rate limited, nothing else posts", async (t) => {
	const file = replayFixture("20261007_120000-teams-notes-sync", "2026-10-07T12:00:00-05:00", {
		title: "Notes Sync",
		records: [
			{ type: "caption", ts: "2026-10-07T12:00:01-05:00", speaker: "Ada Lovelace", text: "Let's start with the cert." },
			{ type: "slide", slide: 1, ts: "2026-10-07T12:00:02-05:00" },
			{ type: "caption", ts: "2026-10-07T12:00:03-05:00", speaker: "Ada Lovelace", text: "Eric, are you there?" },
			{ type: "caption", ts: "2026-10-07T12:00:30-05:00", speaker: "Ada Lovelace", text: "Eric? Hello?" },
			{ type: "caption", ts: "2026-10-07T12:03:40-05:00", speaker: "Ada Lovelace", text: "Eric, one more thing." },
		],
	});
	const registry = scripted(() => JSON.stringify({ topics: [{ title: "Cert", summary: "Rotation Thursday." }], decisions: [], actions: [], questions: [], reply: null }));
	const s = await replaySession(t, registry);
	await s.commands.meeting.handler(`replay 400 ${file}`, s.ctx);

	await until(() => registry.calls.length >= 1 && s.widgets.some((w) => w?.[0]?.includes("slide 1")), "the first call and the slide in the status line");
	assert.match(registry.calls[0].user, /<previous_notes>\n\(none yet/);
	await until(() => s.sent.filter((m) => m.content.startsWith("🔔")).length >= 2, "two name alerts");
	await wait(300);
	const names = s.sent.filter((m) => m.content.startsWith("🔔")).map((m) => m.content);
	assert.equal(names.length, 2, "Ada's second 'Eric' inside two minutes (meeting time) was collapsed");
	assert.match(names[0], /\(12:00\): "Eric, are you there\?"$/);
	assert.match(names[1], /\(12:03\): "Eric, one more thing\."$/);
	// Only the start line and the alerts: no per-question or "check" messages.
	assert.ok(s.sent.every((m) => m.content.startsWith("Meeting copilot replaying") || m.content.startsWith("🔔") || m.content.startsWith("Meeting copilot stopped")), s.sent.map((m) => m.content).join(" | "));
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
	const saved = Object.fromEntries(["MEETING_CAPTURE_STATE_DIR", "PI_MEETING_LOCK", "PI_MEETING_OWNER", "PI_MEETING_WATCH", "PI_MEETING_NOTES_FILE", "PI_MEETING_NOTES_DIR"].map((k) => [k, process.env[k]]));
	process.env.MEETING_CAPTURE_STATE_DIR = path.join(root, "state");
	process.env.PI_MEETING_LOCK = path.join(root, "meeting-owner.json");
	process.env.PI_MEETING_OWNER = owner;
	process.env.PI_MEETING_NOTES_FILE = path.join(root, "canvas", ".meeting-notes.json");
	process.env.PI_MEETING_NOTES_DIR = path.join(root, "canvas", "meetings");
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
		notesFile: process.env.PI_MEETING_NOTES_FILE,
		/** The archived notes of a meeting from w.capture (state.started_at, app "teams"). */
		archive: (state) => path.join(process.env.PI_MEETING_NOTES_DIR, `${meetingId("teams", state.started_at)}.json`),
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
		session(name, id = `${name}-id`, entries = [], { registry } = {}) {
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
				modelRegistry: registry ?? { find: () => undefined, hasConfiguredAuth: () => false, streamSimple: () => assert.fail("no model may be called") },
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
	assert.match(earl.showing(), /^● Weekly Sync · 16m · slide 2 · name alerts only$/, "one status line for an auto-started meeting");
	assert.equal(earl.sent[0].content, 'Meeting copilot on "Weekly Sync" (Microsoft Teams) via name alerts only', "one line");
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
	await until(() => earl.showing().startsWith("◌ Weekly Sync · waiting for captions"), "waiting for captions");
	assert.match(await earl.toolText({ action: "transcript" }), /has no transcript yet/);
	assert.match(await earl.prompt(), /^A meeting is live: Weekly Sync \(Microsoft Teams\), just started\. Use/, "no slide named until there is one");

	w.capture({}, { startedAt });
	await until(() => earl.started() === 1, "captions to attach");
	assert.match(earl.showing(), /^● Weekly Sync/);

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

// ── the notes scout, alerts, the notes file and the recap, end to end ──

test("a live meeting: notes, alerts, the reply once, the notes file, /meeting notes, a last call at the end, and the file goes with the session", async (t) => {
	const w = world(t);
	const startedAt = Date.now() - 16 * 60_000;
	const state = w.capture({}, { startedAt });
	const stamp = (min) => iso(startedAt + min * 60_000).slice(11, 16); // the meeting's own clock, as the transcript shows it (the last line before the call is the chat at minute 6)
	const note = (extra = {}) =>
		JSON.stringify({
			topics: [{ title: "Cert rotation", summary: "Rotate Thursday, Amy owns it." }],
			decisions: ["Rotate the cert Thursday"],
			actions: [{ who: "Eric Boehs", what: "own moving the legacy services onto canary", mine: true, by: "Ada Lovelace" }, { who: "Amy", what: "rotate the cert", mine: false }],
			questions: [{ q: "Who signs off before Thursday?", why: "no approver named" }],
			reply: null,
			...extra,
		});
	const replies = [
		note({ reply: { to: "Alan Turing", text: "The runbook is in the wiki; I'll drop the link." } }),
		note({ reply: { to: "Katherine", text: "I can have a plan by Friday." } }),
		note({ reply: { to: "Katherine", text: "I can have a plan by Friday." } }),
		note({ topics: [{ title: "Cert rotation", summary: "Final." }], reply: null }),
	];
	const registry = scripted(replies);
	const branch = [
		{ type: "message", message: { role: "user", content: "can you check the canary rollout config?" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "The canary config lives in deploy/canary.yml." }] } },
	];
	const earl = w.session("earl", "earl-id", branch, { registry });
	await earl.fire("session_start");
	await until(() => earl.started() === 1, "the copilot to start");
	assert.equal(earl.sent[0].content, 'Meeting copilot on "Weekly Sync" (Microsoft Teams) via Claude Haiku 5.5');

	// First call: caught up on the history, so it goes at once. The reply for Alan rides on the action alert.
	await until(() => registry.calls.length === 1 && earl.sent.some((m) => m.content.startsWith("✅")), "the first notes");
	const first = registry.calls[0];
	assert.equal(first.model, "github-copilot/claude-haiku-5.5");
	assert.match(first.system, /live meeting copilot for Eric Boehs/);
	assert.match(first.user, /^Meeting: Weekly Sync \(Microsoft Teams\)\nPeople: Ada Lovelace; Smith, Amy \(ORG\); Alan Turing\n/);
	assert.match(first.user, /<session>\nWhat the user is working on right now, from their pi session "earl":\nTheir last messages:\n- can you check the canary rollout config\?\nThe assistant's last message:\nThe canary config lives in deploy\/canary\.yml\.\n<\/session>/);
	assert.match(first.user, /<slides>[\s\S]*Cert rotation plan\nOwner: Amy[\s\S]*<\/slides>/, "OCR of the slides shown");
	assert.match(first.user, /<previous_notes>\n\(none yet/);
	assert.match(first.user, /\] Smith, Amy \(ORG\): The cert expires on Friday/);

	const action = earl.sent.find((m) => m.content.startsWith("✅"));
	assert.equal(action.content, `✅ Action on you: own moving the legacy services onto canary (Ada Lovelace, ${stamp(6)})\n↳ You could say: "The runbook is in the wiki; I'll drop the link."`);
	assert.equal(action.display, true);
	assert.ok(!earl.sent.some((m) => m.content.startsWith("↳")), "the reply rode along: no second message for it");

	// The notes file the canvas reads.
	const file = JSON.parse(fs.readFileSync(w.notesFile, "utf8"));
	assert.equal(fs.statSync(w.notesFile).mode & 0o777, 0o600);
	assert.deepEqual([file.v, file.pid, file.session, file.ended], [1, process.pid, { id: "earl-id", name: "earl" }, false]);
	assert.deepEqual(file.meeting, { started_at: state.started_at, app_id: "teams", title: "Weekly Sync" });
	assert.deepEqual(file.me, ["eric", "boehs"]);
	assert.deepEqual(file.topics, [{ title: "Cert rotation", summary: "Rotate Thursday, Amy owns it." }]);
	assert.deepEqual(file.actions.map((a) => [a.who, a.mine]), [["Eric Boehs", true], ["Amy", false]]);
	assert.deepEqual(file.questions, [{ q: "Who signs off before Thursday?", why: "no approver named" }]);
	assert.deepEqual([file.reply.to, file.reply.text], ["Alan Turing", "The runbook is in the wiki; I'll drop the link."]);
	assert.deepEqual(file.alerts.map((a) => [a.kind, a.who]), [["action", "Ada Lovelace"]]);
	assert.match(earl.showing(), /^● Weekly Sync · 16m · slide 2 · 1 alert · 1 question$/);

	// Someone says his name: an immediate chat alert with no model; the same speaker again inside 2 min collapses.
	const at = (ms) => iso(ms);
	const say = (speaker, text, ms = Date.now()) => fs.appendFileSync(state.jsonl, JSON.stringify({ type: "caption", speaker, text, ts: at(ms) }) + "\n");
	say("Ada Lovelace", "Eric, are you still with us?");
	await until(() => earl.sent.some((m) => m.content.startsWith("🔔")), "the name alert");
	say("Ada Lovelace", "Eric? Hello?");
	say("Eric Boehs", "Sorry, I'm here. Eric here.");
	await wait(1500);
	const names = earl.sent.filter((m) => m.content.startsWith("🔔"));
	assert.equal(names.length, 1, "a repeat and Eric's own words don't alert");
	assert.match(names[0].content, /^🔔 Ada Lovelace said your name \(\d\d:\d\d\): "Eric, are you still with us\?"$/);
	const nameAlertAt = earl.sent.indexOf(names[0]);
	assert.ok(nameAlertAt > earl.sent.findIndex((m) => m.content.startsWith("✅")));
	await until(() => JSON.parse(fs.readFileSync(w.notesFile, "utf8")).alerts.length === 2, "the name alert in the notes file");
	assert.deepEqual(JSON.parse(fs.readFileSync(w.notesFile, "utf8")).alerts.map((a) => a.kind), ["action", "name"]);

	// The name alert asked for an early call (after the 60 s floor, which a test can't wait for): /meeting ask forces one.
	assert.equal(registry.calls.length, 1, "the 60 s floor holds the early call back");
	await earl.command("ask");
	await until(() => registry.calls.length === 2, "the second call");
	assert.match(registry.calls[1].user, /<previous_notes>\n\{"topics":\[\{"title":"Cert rotation"/, "it updates the previous notes");
	assert.match(registry.calls[1].user, /── new since your last update ──\n.*Ada Lovelace: Eric, are you still with us\?/s);
	await until(() => earl.sent.some((m) => m.content.startsWith("↳")), "the reply on its own");
	const reply = earl.sent.find((m) => m.content.startsWith("↳"));
	assert.equal(reply.content, '↳ Katherine is waiting on you. You could say: "I can have a plan by Friday."');
	assert.equal(earl.sent.filter((m) => m.content.startsWith("✅")).length, 1, "the same action isn't alerted twice");

	// The same reply again: once per reply.
	say("Katherine Johnson", "So, Friday?");
	await earl.command("ask");
	await until(() => registry.calls.length === 3, "the third call");
	await wait(200);
	assert.equal(earl.sent.filter((m) => m.content.startsWith("↳")).length, 1, "once per reply");

	// Nothing but start, alerts and replies posted during the meeting.
	assert.ok(earl.sent.every((m) => /^(Meeting copilot on |🔔|✅|↳)/.test(m.content)), earl.sent.map((m) => m.content).join(" | "));

	// On request only: the current notes as one message.
	const before = earl.sent.length;
	await earl.command("notes");
	assert.equal(earl.sent.length, before + 1);
	const posted = earl.sent.at(-1).content;
	assert.match(posted, /^Meeting notes · Weekly Sync · 2 alerts\nTopics:\n- Cert rotation: Rotate Thursday, Amy owns it\.\n\nDecisions:\n- Rotate the cert Thursday\n\nAction items:\n- ★ Eric Boehs: own moving the legacy services onto canary \(from Ada Lovelace\)\n- Amy: rotate the cert\n\nOpen questions:\n- Who signs off before Thursday\? \(no approver named\)\n\nSuggested reply to Katherine: I can have a plan by Friday\.$/);

	// The meeting ends: one final call for what's left, then the one-line stop message with the recap; the file stays, ended.
	say("Alan Turing", "That's all from me.");
	w.state({ ...state, ended: true, ended_at: iso(Date.now()), duration: "0:16:00" });
	await until(() => earl.stopped(), "the copilot to stop");
	assert.equal(registry.calls.length, 4, "one last call before the recap");
	assert.match(registry.calls[3].user, /That's all from me\./);
	const stop = earl.sent.at(-1).content;
	assert.match(stop, /^Meeting copilot stopped \(meeting ended\)\nTopics:\n- Cert rotation: Final\./);
	assert.match(stop, /Action items:\n- ★ Eric Boehs: own moving/);
	const ended = JSON.parse(fs.readFileSync(w.notesFile, "utf8"));
	assert.equal(ended.ended, true, "the final notes stay for the canvas");
	// The same notes are archived under the meeting's id, mode 600 in a 700 folder, no temp file left.
	const archived = w.archive(state);
	assert.deepEqual(JSON.parse(fs.readFileSync(archived, "utf8")), ended, "the archive has the live file's shape and content");
	assert.equal(fs.statSync(archived).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.dirname(archived)).mode & 0o777, 0o700);
	assert.deepEqual(fs.readdirSync(path.dirname(archived)), [path.basename(archived)]);
	assert.equal(ended.topics[0].summary, "Final.");
	assert.equal(earl.showing(), "", "the status line is gone");

	// Quitting right after the call leaves the final notes for the canvas.
	await earl.fire("session_shutdown", { reason: "quit" });
	assert.equal(JSON.parse(fs.readFileSync(w.notesFile, "utf8")).ended, true);
	assert.equal(JSON.parse(fs.readFileSync(archived, "utf8")).ended, true);
});

test("a /reload mid-meeting keeps the notes file; the new instance picks the notes up and doesn't alert again, and quitting takes the file away", async (t) => {
	const w = world(t);
	const startedAt = Date.now() - 16 * 60_000;
	const state = w.capture({}, { startedAt });
	const note = (what) => JSON.stringify({ topics: [{ title: "Canary", summary: "Legacy services." }], decisions: [], actions: [{ who: "Eric Boehs", what, mine: true, by: "Ada Lovelace" }], questions: [], reply: null });
	const first = scripted([note("own moving the legacy services onto canary")]);
	const before = w.session("earl", "earl-id", [], { registry: first });
	await before.fire("session_start");
	await until(() => before.sent.some((m) => m.content.startsWith("✅")), "the action alert");
	await before.fire("session_shutdown", { reason: "reload" });
	assert.ok(fs.existsSync(w.notesFile), "a reload keeps the file");

	// The scout words the same task differently on its first look at the whole history.
	const second = scripted([note("own migrating legacy services to canary")]);
	const after = w.session("earl", "earl-id", [], { registry: second });
	await after.fire("session_start");
	await until(() => after.started() === 1 && second.calls.length === 1, "the new instance's first call");
	assert.match(second.calls[0].user, /<previous_notes>\n\{"topics":\[\{"title":"Canary"/, "it starts from the restored notes");
	await wait(300);
	assert.deepEqual(after.sent.filter((m) => !m.content.startsWith("Meeting copilot on ")), [], "nothing is said again");

	// New alerts keep counting from where the file left off.
	fs.appendFileSync(state.jsonl, JSON.stringify({ type: "caption", speaker: "Ada Lovelace", text: "Eric, are you there?", ts: iso(Date.now()) }) + "\n");
	await until(() => after.sent.some((m) => m.content.startsWith("🔔")), "a name alert");
	await until(() => JSON.parse(fs.readFileSync(w.notesFile, "utf8")).alerts.length === 2, "both alerts in the file");
	assert.deepEqual(JSON.parse(fs.readFileSync(w.notesFile, "utf8")).alerts.map((x) => x.id), ["a1", "a2"]);

	await after.fire("session_shutdown", { reason: "quit" });
	assert.equal(fs.existsSync(w.notesFile), false, "quitting mid-meeting takes it away");
	const kept = JSON.parse(fs.readFileSync(w.archive(state), "utf8"));
	assert.deepEqual([kept.alerts.length, kept.ended, kept.topics[0].title], [2, false, "Canary"], "the archive is never dropped, quit or not");
});

test("the live notes file is gone (quit, /meeting watch off): the archive brings the notes back, nothing is alerted twice, and the next archive write keeps them", async (t) => {
	const w = world(t);
	const startedAt = Date.now() - 16 * 60_000;
	const state = w.capture({}, { startedAt });
	const note = (what) => JSON.stringify({ topics: [{ title: "Canary", summary: "Legacy services." }], decisions: ["Cut over Thursday"], actions: [{ who: "Eric Boehs", what, mine: true, by: "Ada Lovelace" }], questions: [{ q: "Who owns the rollback?", why: "No owner yet" }], reply: null });
	const first = scripted([note("own moving the legacy services onto canary")]);
	const before = w.session("earl", "earl-id", [], { registry: first });
	await before.fire("session_start");
	await until(() => before.sent.some((m) => m.content.startsWith("✅")), "the action alert");
	await until(() => fs.existsSync(w.archive(state)) && JSON.parse(fs.readFileSync(w.archive(state), "utf8")).alerts.length === 1, "the archive has the alert");
	await before.fire("session_shutdown", { reason: "quit" });
	assert.equal(fs.existsSync(w.notesFile), false, "the live file went with the session");
	assert.equal(JSON.parse(fs.readFileSync(w.archive(state), "utf8")).alerts.length, 1, "the archive stays");

	// A second session starts with only the archive: no live file. Its scout leaves every field out, so what the notes hold is what was restored.
	const second = scripted([JSON.stringify({ reply: null })]);
	const after = w.session("earl", "earl-id", [], { registry: second });
	await after.fire("session_start");
	await until(() => after.started() === 1 && second.calls.length === 1, "the new instance's first call");
	assert.match(second.calls[0].user, /<previous_notes>\n\{"topics":\[\{"title":"Canary"/, "it starts from the archived notes");
	await wait(300);
	assert.deepEqual(after.sent.filter((m) => !m.content.startsWith("Meeting copilot on ")), [], "no alert again for what the archive already had");

	// The next alert counts on from the archive's, and the archive keeps what was there.
	fs.appendFileSync(state.jsonl, JSON.stringify({ type: "caption", speaker: "Ada Lovelace", text: "Eric, are you there?", ts: iso(Date.now()) }) + "\n");
	await until(() => after.sent.some((m) => m.content.startsWith("🔔")), "a name alert");
	await until(() => JSON.parse(fs.readFileSync(w.archive(state), "utf8")).alerts.length === 2, "both alerts in the archive");
	const kept = JSON.parse(fs.readFileSync(w.archive(state), "utf8"));
	assert.deepEqual(kept.alerts.map((x) => x.id), ["a1", "a2"], "alertSeq carried on");
	assert.deepEqual([kept.topics[0]?.title, kept.decisions[0]?.text, kept.questions[0]?.q], ["Canary", "Cut over Thursday", "Who owns the rollback?"]);
	await after.fire("session_shutdown", { reason: "quit" });
});

test("the daily-note recap lists topics, decisions, action items and open questions, and a replay never writes one", async (t) => {
	const w = world(t);
	const daily = path.join(w.root, "daily");
	fs.mkdirSync(daily);
	process.env.PI_MEETING_DAILY_DIR = daily;
	t.after(() => (process.env.PI_MEETING_DAILY_DIR = ""));
	const startedAt = Date.now() - 16 * 60_000;
	const state = w.capture({}, { startedAt });
	const registry = scripted([
		JSON.stringify({ topics: [{ title: "Canary", summary: "Legacy services next." }], decisions: ["Canary first"], actions: [{ who: "Eric Boehs", what: "move the services", mine: true }], questions: [], reply: null }),
	]);
	const earl = w.session("earl", "earl-id", [], { registry });
	await earl.fire("session_start");
	await until(() => earl.started() === 1, "the copilot to start");
	await until(() => registry.calls.length === 1, "the notes");
	w.state({ ...state, ended: true, ended_at: iso(Date.now()), duration: "0:16:00" });
	await until(() => earl.stopped(), "the copilot to stop");
	const noteFile = path.join(daily, "2026-10-28.md");
	const text = fs.readFileSync(noteFile, "utf8");
	assert.match(text, /^## Meetings\n\n### \d\d:\d\d–\d\d:\d\d Weekly Sync · copilot notes\n<!-- meeting-copilot:20261028_140000-teams-weekly-sync -->\nTranscript: `.*20261028_140000-teams-weekly-sync\.txt` · 1 notes update\n\nTopics:\n- Canary: Legacy services next\.\n\nDecisions:\n- Canary first\n\nAction items:\n- ★ Eric Boehs: move the services\n$/);
	assert.match(earl.sent.at(-1).content, /^Meeting copilot stopped \(meeting ended\) · recap in .*2026-10-28\.md\nTopics:/);

	// A replay of the same capture adds nothing to the note.
	const before = fs.readFileSync(noteFile, "utf8");
	const archiveBefore = fs.readFileSync(w.archive(state), "utf8");
	const s = w.session("solo", "solo-id", [], { registry: scripted([JSON.stringify({ topics: [{ title: "Replay", summary: "x" }], reply: null })]) });
	await s.fire("session_start");
	await s.command(`replay 100000 ${state.jsonl}`);
	await until(() => s.stopped(), "the replay to finish", 12000);
	assert.equal(fs.readFileSync(noteFile, "utf8"), before, "no recap for a replay");
	assert.equal(fs.readFileSync(w.archive(state), "utf8"), archiveBefore, "a replay never writes or touches the archive");
	assert.equal(fs.readdirSync(path.dirname(w.archive(state))).length, 1);
	assert.deepEqual([JSON.parse(fs.readFileSync(w.notesFile, "utf8")).session.id, JSON.parse(fs.readFileSync(w.notesFile, "utf8")).ended], ["earl-id", true], "and the replay left the notes file alone");
});

test("when the copilot stops for any reason but the meeting ending, the notes file goes", async (t) => {
	const w = world(t, { owner: "" });
	const startedAt = Date.now() - 16 * 60_000;
	w.capture({}, { startedAt });
	const registry = scripted([JSON.stringify({ topics: [{ title: "T", summary: "s" }], reply: null })]);
	const s = w.session("anyone", "a1", [], { registry });
	await s.fire("session_start");
	await s.command("watch");
	await until(() => fs.existsSync(w.notesFile), "the notes file");
	await s.command("stop");
	assert.equal(fs.existsSync(w.notesFile), false, "/meeting stop removes it");
	assert.equal(fs.readdirSync(process.env.PI_MEETING_NOTES_DIR).length, 1, "but not the archive");
});

test("/q research is gone: no /q command, no input hook, no /meeting list", async (t) => {
	const commands = {};
	const hooks = [];
	meeting({
		on: (e) => hooks.push(e),
		events: { on: () => {}, emit: () => {} },
		registerCommand: (name, def) => (commands[name] = def),
		registerMessageRenderer: () => {},
		registerTool: () => {},
		sendMessage: () => {},
	});
	assert.deepEqual(Object.keys(commands), ["meeting"]);
	assert.ok(!hooks.includes("input"), "nothing intercepts /q3 any more");
	const notes = [];
	const ctx = { hasUI: true, mode: "tui", ui: { notify: (m) => notes.push(m), setWidget() {} } };
	await commands.meeting.handler("list", ctx);
	assert.match(notes.at(-1), /^Unknown: \/meeting list\. Try watch, replay, ask, notes, focus, recap, stop$/);
	assert.deepEqual(
		commands.meeting.getArgumentCompletions("").map((c) => c.value),
		["watch", "ask", "notes", "recap", "focus ", "stop", "replay"],
	);
});

// ── slide summaries, end to end ──

/**
 * A registry whose model reads images. Slide calls (their content is a list with the image) answer from
 * `slide(n, k)` (k: how many calls that slide has had before this one); scout calls answer with some notes.
 * `slide` may return {error} to fail the call.
 */
function vision({ images = true, slide } = {}) {
	const calls = [];
	const reply =
		slide ??
		((n) => JSON.stringify({ title: `Title ${n}`, what: `What ${n} shows.`, why: n === 3 ? "Your canary move is on it." : "", points: [`point ${n}`], numbers: [`${n}0 ms`] }));
	return {
		calls,
		slideCalls: () => calls.filter((c) => c.slide !== undefined),
		noteCalls: () => calls.filter((c) => c.slide === undefined),
		find: (provider, id) => ({ provider, id, name: "Claude Haiku 5.5", ...(images ? { input: ["text", "image"] } : {}) }),
		hasConfiguredAuth: () => true,
		streamSimple: (model, context) => {
			const content = context.messages[0].content;
			const isSlide = Array.isArray(content);
			const text = isSlide ? content.find((c) => c.type === "text").text : content;
			const n = isSlide ? Number(/This is slide (\d+)/.exec(text)[1]) : undefined;
			const k = isSlide ? calls.filter((c) => c.slide === n).length : 0;
			calls.push({ model: `${model.provider}/${model.id}`, system: context.systemPrompt, user: text, image: isSlide ? content.find((c) => c.type === "image") : undefined, slide: n, at: Date.now() });
			const answer = isSlide ? reply(n, k) : JSON.stringify({ topics: [{ title: "Canary", summary: "Rollout." }], decisions: [], actions: [], questions: [], reply: null });
			return {
				result: async () =>
					typeof answer === "object"
						? { stopReason: "error", errorMessage: answer.error, content: [], usage: { cost: { total: 0 } } }
						: { stopReason: "stop", content: [{ type: "text", text: answer }], usage: { cost: { total: 0.001 } } },
			};
		},
	};
}

const T0 = "2026-10-28T14:00:00-05:00";
const tsAt = (hms) => `2026-10-28T${hms}-05:00`;

/** A finished capture to replay: three slides at once (with OCR), a revisit, captions around them, a late caption to keep the replay running. */
function slideReplayFixture(name, { ocr = true } = {}) {
	const base = path.join(dir, `20261028_140000-teams-${name}`);
	const slides = `${base}.slides`;
	fs.mkdirSync(slides, { recursive: true });
	const files = [1, 2, 3].map((n) => `000${n}-14010${n}.jpg`);
	files.forEach((f) => fs.writeFileSync(path.join(slides, f), SMALL_JPG));
	fs.writeFileSync(path.join(slides, "index.jsonl"), files.map((file, i) => JSON.stringify({ n: i + 1, at: tsAt(`14:01:0${i + 1}`), file, reason: "change", width: 1382, height: 863 })).join("\n") + "\n");
	if (ocr) {
		fs.writeFileSync(path.join(slides, "0001-140101.txt"), "Agenda\nCanary rollout\n");
		fs.writeFileSync(path.join(slides, "0002-140102.txt"), "");
		fs.writeFileSync(path.join(slides, "0003-140103.txt"), "Shared content | Canary.pptx\nCanary Thursday\n12\n");
	}
	const cap = (hms, text) => ({ type: "caption", ts: tsAt(hms), speaker: "Ada Lovelace", text });
	const recs = [
		{ type: "metadata", meeting: "Canary Plan", app: "Teams", meeting_started_at: T0 },
		cap("14:00:10", "Welcome, today is the canary plan."),
		cap("14:00:50", "Next, the rollout."),
		...files.map((file, i) => ({ type: "slide", slide: i + 1, file: path.join(slides, file), ts: tsAt(`14:01:0${i + 1}`) })),
		cap("14:01:20", "So canary goes Thursday."),
		{ type: "revisit", slide: 1, file: path.join(slides, files[0]), reason: "revisit", ts: tsAt("14:02:00") },
		cap("14:04:00", "Questions about the rest later."),
		cap("14:20:00", "That is all."),
	];
	fs.writeFileSync(`${base}.jsonl`, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
	return `${base}.jsonl`;
}

const asked = [{ type: "message", message: { role: "user", content: "fix the canary config" } }];

test("slide summaries in a replay: a burst goes newest first, one at a time and paced; the prompt has everything; a revisit reuses; nothing is written", async (t) => {
	const w = world(t);
	const file = slideReplayFixture("replay-burst");
	const registry = vision();
	const s = w.session("solo", "solo-id", asked, { registry });
	await s.command(`replay 300 ${file}`);

	await until(() => registry.slideCalls().length === 3, "three slide calls", 12000);
	const calls = registry.slideCalls();
	assert.deepEqual(calls.map((c) => c.slide), [3, 2, 1], "the newest first, then backwards");
	assert.ok(calls[1].at - calls[0].at >= 25 && calls[2].at - calls[1].at >= 25, "paced: 10 s scaled by the replay's speed (33 ms here)");

	const first = calls[0];
	assert.equal(first.model, "github-copilot/claude-haiku-5.5", "the notes model");
	assert.match(first.system, /You describe one slide from a meeting Eric Boehs is sitting in/);
	assert.match(first.user, /^Meeting: Canary Plan \(Teams\)\n/);
	assert.match(first.user, /<session>[\s\S]*- fix the canary config[\s\S]*<\/session>/, "what he is working on");
	assert.match(first.user, /<ocr>\nCanary Thursday\n12\n<\/ocr>/, "OCR, the window title line stripped");
	assert.doesNotMatch(first.user, /Shared content/);
	assert.match(first.user, /<said_before>\n\[14:00:10\] Ada Lovelace: Welcome, today is the canary plan\.\n\[14:00:50\] Ada Lovelace: Next, the rollout\.\n<\/said_before>/, "the 90 s before");
	assert.match(first.user, /<said_after>\n\[14:01:20\] Ada Lovelace: So canary goes Thursday\.\n<\/said_after>/, "and after, what had been said by call time; 14:04 is too far");
	assert.doesNotMatch(first.user, /<previous_slides>/, "the first one has no earlier titles");
	assert.equal(first.image.mimeType, "image/jpeg");
	assert.equal(first.image.data, SMALL_JPG.toString("base64"), "the full jpg goes out (through the resize path)");
	assert.match(calls[1].user, /<ocr>\n\(the OCR found no text on this slide\)\n<\/ocr>/, "a 0 byte OCR file means no text");
	assert.match(calls[2].user, /<ocr>\nAgenda\nCanary rollout\n<\/ocr>/);

	// The session model can read them (the replay's summaries live in memory), and the revisit asked for nothing more.
	await until(async () => (await s.toolText({ action: "slides" })).includes("Slide 1: Title 1"), "all three summaries");
	assert.equal(registry.slideCalls().length, 3, "a revisit reuses its slide's summary: no call");
	const all = await s.toolText({ action: "slides" });
	assert.match(all, /^This is a replay of Canary Plan \(Teams\), as far as it has played\.\n\nSlide summaries: 3\nSlide 1: Title 1\n {2}What: What 1 shows\.\nSlide 2: Title 2\n {2}What: What 2 shows\.\nSlide 3: Title 3\n {2}What: What 3 shows\.\n {2}Why it matters to you: Your canary move is on it\.$/);
	assert.match(await s.toolText({ action: "status" }), /Slide summaries:\n1\. Title 1\n2\. Title 2\n3\. Title 3$/);

	await until(() => s.stopped(), "the replay to finish", 12000);
	assert.equal(fs.existsSync(w.notesFile), false, "a replay writes no notes file");
	assert.equal(fs.existsSync(process.env.PI_MEETING_NOTES_DIR), false, "and no archive");
});

test("slide summaries when a model fails: back off, retry, and give up on a slide after three failures", async (t) => {
	const w = world(t);
	const file = slideReplayFixture("replay-failing");
	// Slide 3 never works; slide 2 fails once; slide 1 is fine.
	const registry = vision({
		slide: (n, k) => (n === 3 ? { error: "429 rate limited" } : n === 2 && k === 0 ? { error: "overloaded" } : JSON.stringify({ title: `Title ${n}`, what: `What ${n}.`, why: "", points: [], numbers: [] })),
	});
	const s = w.session("solo", "solo-id", asked, { registry });
	// 300×: the backoffs scale with speed, so a slower replay leaves real headroom for a slow CI runner before the meeting ends.
	await s.command(`replay 300 ${file}`);
	await until(() => s.stopped(), "the replay to finish", 12000);
	assert.deepEqual(registry.slideCalls().map((c) => c.slide), [3, 3, 3, 2, 2, 1], "slide 3 three tries then given up (no fourth), slide 2 retried once, slide 1 still got its turn");
	const at = registry.slideCalls().map((c) => c.at);
	assert.ok(at[1] - at[0] >= 50 && at[2] - at[1] >= 100, "each failure waits longer (the scout's backoff, scaled by the replay's speed)");
	await wait(400);
	assert.equal(registry.slideCalls().length, 6, "no retry storm after the give-up");
	assert.ok(registry.noteCalls().length >= 1, "the notes scout is not held up by it");
});

test("slide summaries in a live meeting: restored ones are kept and never called again, the newest slide waits for its OCR, the file and archive carry them, the scout and the tool use them, the recap lists what matters", async (t) => {
	const w = world(t);
	// Slide 3 came up a few seconds ago: its OCR wait runs from then, not from when the worker picks it.
	const startedAt = Date.now() - 14 * 60_000 - 5000;
	const state = w.capture({}, { startedAt });
	const slides = path.join(w.root, "data", "20261028_140000-teams-weekly-sync.slides");
	fs.writeFileSync(path.join(slides, "0003-141400.jpg"), SMALL_JPG);
	// Slide 1 was summarized before a /reload: it is in the notes file.
	writeNotesFile(
		buildNotesFile({
			pid: process.pid,
			sessionId: "earl-id",
			sessionName: "earl",
			startedAt: state.started_at,
			appId: "teams",
			title: "Weekly Sync",
			at: "A",
			ended: false,
			me: [],
			notes: emptyNotes(),
			reply: null,
			alerts: [],
			alertSeq: 0,
			slides: [{ n: 1, title: "Agenda", what: "The meeting agenda.", why: "", points: [], numbers: [], at: iso(startedAt + 60_000) }],
		}),
	);
	const registry = vision({
		slide: (n) => JSON.stringify({ title: `Q3 canary plan`, what: "Canary rollout dates.", why: "Your canary move is on it.", points: ["Thursday cutover"], numbers: ["Oct 28 cutover"] }),
	});
	const earl = w.session("earl", "earl-id", asked, { registry });
	await earl.fire("session_start");
	await until(() => earl.started() === 1, "the copilot to start");
	// The newest slide's OCR is not there yet: it waits, and goes on when the file lands.
	await wait(700);
	assert.equal(registry.slideCalls().length, 0, "waiting for the OCR file");
	setTimeout(() => fs.writeFileSync(path.join(slides, "0003-141400.txt"), "Shared content | Teams\nRaw canary OCR words\n"), 300);
	await until(() => registry.slideCalls().length === 1, "the slide call once its OCR exists", 12000);
	const call = registry.slideCalls()[0];
	assert.equal(call.slide, 3, "the newest slide, not slide 2 and never the restored slide 1");
	assert.match(call.user, /<previous_slides>\nTitles of the slides before this one, for continuity:\n1\. Agenda\n<\/previous_slides>/);
	assert.match(call.user, /<ocr>\nRaw canary OCR words\n<\/ocr>/);
	assert.equal(call.image.data, SMALL_JPG.toString("base64"));

	// Cached by slide number, in memory and in the notes file and the archive.
	await until(() => JSON.parse(fs.readFileSync(w.notesFile, "utf8")).slides?.length === 2, "the summary in the notes file");
	const file = JSON.parse(fs.readFileSync(w.notesFile, "utf8"));
	assert.deepEqual(file.slides.map((x) => [x.n, x.title, x.why]), [[1, "Agenda", ""], [3, "Q3 canary plan", "Your canary move is on it."]]);
	assert.deepEqual(file.slides[1], { n: 3, title: "Q3 canary plan", what: "Canary rollout dates.", why: "Your canary move is on it.", points: ["Thursday cutover"], numbers: ["Oct 28 cutover"], at: file.slides[1].at });
	assert.deepEqual(JSON.parse(fs.readFileSync(w.archive(state), "utf8")).slides, file.slides, "the archive carries them too");
	assert.equal(file.slidesOn, true, "the canvas is told summaries are running");
	assert.deepEqual(file.slidesFailed, []);

	// The notes scout reads summaries instead of raw OCR where it has them, raw OCR for the rest.
	await earl.command("ask");
	await until(() => registry.noteCalls().length >= 2, "the next scout call");
	const scout = registry.noteCalls().at(-1).user;
	assert.match(scout, /Slide 3 \(\d\d:\d\d:\d\d\) \(summary\):\nQ3 canary plan: Canary rollout dates\. Why it matters: Your canary move is on it\./);
	assert.match(scout, /Slide 1 \(\d\d:\d\d:\d\d\) \(summary\):\nAgenda: The meeting agenda\./);
	assert.match(scout, /Slide 2 \(\d\d:\d\d:\d\d\), on screen now:\nCert rotation plan\nOwner: Amy/, "slide 2 has no summary yet: its OCR");
	assert.doesNotMatch(scout, /Raw canary OCR words/);
	assert.equal(registry.slideCalls().length, 1, "at most one slide call per 10 s");

	// No chat noise for summaries.
	assert.ok(earl.sent.every((m) => /^(Meeting copilot on |🔔|✅|↳)/.test(m.content)), earl.sent.map((m) => m.content).join(" | "));
	assert.match(earl.showing(), /^● Weekly Sync · 14m · slide 2( ·|$)/, "and no new part in the status line");

	// The tool: the session that runs it (memory) and another session (the archive) both see them.
	const reader = w.session("reader");
	for (const who of [earl, reader]) {
		const slide3 = await who.tool({ action: "slide", slide: 3 });
		const text = slide3.content[0].text;
		assert.match(text, /First shown at [^\n]*\n\nSummary: Q3 canary plan\nWhat it shows: Canary rollout dates\.\nWhy it matters to you: Your canary move is on it\.\nKey points:\n- Thursday cutover\nNumbers:\n- Oct 28 cutover\n\nOCR text:\nShared content \| Teams\nRaw canary OCR words/, "the summary sits above the OCR text");
		assert.equal(slide3.content[1].type, "image");
		assert.match(await who.toolText({ action: "status" }), /Slide summaries:\n1\. Agenda\n3\. Q3 canary plan$/);
		assert.match(await who.toolText({ action: "slides" }), /^Slide summaries: 2\nSlide 1: Agenda\n {2}What: The meeting agenda\.\nSlide 3: Q3 canary plan\n {2}What: Canary rollout dates\.\n {2}Why it matters to you: Your canary move is on it\.$/);
		assert.match(await who.toolText({ action: "slides", query: "CUTOVER canary" }), /^Slide summaries: 1 of 2\nSlide 3: Q3 canary plan/);
		assert.match(await who.toolText({ action: "slides", query: "kubernetes" }), /^No slide summary matches "kubernetes"\. 2 slides are summarized\.$/);
		assert.doesNotMatch(await who.toolText({ action: "slide", slide: 2 }), /Summary:/, "a slide without one shows only its OCR");
	}

	// The meeting ends: the recap lists the slides that matter to him (those with a why).
	w.state({ ...state, ended: true, ended_at: iso(Date.now()), duration: "0:16:00" });
	await until(() => earl.stopped(), "the copilot to stop");
	assert.match(earl.sent.at(-1).content, /\nSlides:\n3\. Q3 canary plan — Your canary move is on it\.$/);
	assert.doesNotMatch(earl.sent.at(-1).content, /1\. Agenda/, "no why, not listed");
	assert.equal(JSON.parse(fs.readFileSync(w.notesFile, "utf8")).slides.length, 2);
});

test("slide summaries off: PI_MEETING_SLIDES=0 means no slide call, and the tool says so", async (t) => {
	const w = world(t);
	w.capture({}, { startedAt: Date.now() - 16 * 60_000 });
	process.env.PI_MEETING_SLIDES = "0";
	t.after(() => delete process.env.PI_MEETING_SLIDES);
	const registry = vision();
	const earl = w.session("earl", "earl-id", asked, { registry });
	await earl.fire("session_start");
	await until(() => registry.noteCalls().length >= 1, "the notes scout");
	await wait(1800);
	assert.equal(registry.slideCalls().length, 0);
	assert.ok(!earl.notes.some((n) => /read images/.test(n)), "off is quiet");
	assert.match(await earl.toolText({ action: "slides" }), /Slide summaries are off/);
});

test("no vision model: slide summaries are skipped, with one hint; notes carry on", async (t) => {
	const w = world(t);
	w.capture({}, { startedAt: Date.now() - 16 * 60_000 });
	const registry = vision({ images: false });
	const earl = w.session("earl", "earl-id", asked, { registry });
	await earl.fire("session_start");
	await until(() => registry.noteCalls().length >= 1, "the notes scout");
	await wait(1800);
	assert.equal(registry.slideCalls().length, 0);
	assert.equal(earl.notes.filter((n) => /can't read images/.test(n)).length, 1, "one hint, not one per slide");
	assert.match(earl.notes.find((n) => /can't read images/.test(n)), /Claude Haiku 5\.5.*no slide summaries/);
	assert.match(await earl.toolText({ action: "slides" }), /^No slide summaries yet/);
});

test("the OCR wait runs from when the slide appeared: a slide shown minutes ago with no OCR file is not waited for", async (t) => {
	const w = world(t);
	const state = w.capture({}, { startedAt: Date.now() - 16 * 60_000 });
	const slides = path.join(w.root, "data", "20261028_140000-teams-weekly-sync.slides");
	fs.writeFileSync(path.join(slides, "0003-141400.jpg"), SMALL_JPG);
	const registry = vision();
	const earl = w.session("earl", "earl-id", asked, { registry });
	const t0 = Date.now();
	await earl.fire("session_start");
	await until(() => registry.slideCalls().length >= 1, "the first slide call, without a 90 s wait", 6000);
	assert.ok(Date.now() - t0 < 6000);
	const call = registry.slideCalls()[0];
	assert.equal(call.slide, 3);
	assert.match(call.user, /<ocr>\n\(the OCR text was not ready: go by the image\)\n<\/ocr>/);
	assert.ok(state);
});

test("after /meeting watch off the archive still holds the summaries: they come back and are not made again", async (t) => {
	const w = world(t);
	const state = w.capture({}, { startedAt: Date.now() - 16 * 60_000 });
	const slides = path.join(w.root, "data", "20261028_140000-teams-weekly-sync.slides");
	fs.writeFileSync(path.join(slides, "0003-141400.jpg"), SMALL_JPG);
	// Only the archive is left (no live notes file): slides 1 and 3 were summarized earlier.
	writeNotesFile(
		buildNotesFile({
			pid: process.pid,
			sessionId: "earl-id",
			sessionName: "earl",
			startedAt: state.started_at,
			appId: "teams",
			title: "Weekly Sync",
			at: "A",
			ended: false,
			me: [],
			notes: emptyNotes(),
			reply: null,
			alerts: [],
			alertSeq: 0,
			slides: [1, 3].map((n) => ({ n, title: `Old ${n}`, what: `Old what ${n}.`, why: "", points: [], numbers: [], at: iso(Date.now()) })),
		}),
	);
	fs.mkdirSync(path.dirname(w.archive(state)), { recursive: true });
	fs.copyFileSync(w.notesFile, w.archive(state));
	fs.rmSync(w.notesFile);
	const registry = vision();
	const earl = w.session("earl", "earl-id", asked, { registry });
	await earl.fire("session_start");
	await until(() => registry.slideCalls().length >= 1, "the one slide still without a summary");
	assert.deepEqual([...new Set(registry.slideCalls().map((c) => c.slide))], [2], "only slide 2: 1 and 3 came back from the archive");
	const status = await earl.toolText({ action: "status" });
	assert.match(status, /\n1\. Old 1\n/);
	assert.match(status, /\n3\. Old 3(\n|$)/);
});

test("the notes file says whether slide summaries run: off by setting, or without an image model, it says no", async (t) => {
	for (const mode of ["setting", "novision"]) {
		const w = world(t);
		w.capture({}, { startedAt: Date.now() - 16 * 60_000 });
		if (mode === "setting") process.env.PI_MEETING_SLIDES = "0";
		t.after(() => delete process.env.PI_MEETING_SLIDES);
		const registry = vision({ images: mode !== "novision" });
		const earl = w.session("earl", "earl-id", asked, { registry });
		await earl.fire("session_start");
		await until(() => registry.noteCalls().length >= 1 && fs.existsSync(w.notesFile), "the notes file");
		const file = JSON.parse(fs.readFileSync(w.notesFile, "utf8"));
		assert.equal(file.slidesOn, false, mode);
		assert.deepEqual(file.slidesFailed, []);
		delete process.env.PI_MEETING_SLIDES;
	}
});
