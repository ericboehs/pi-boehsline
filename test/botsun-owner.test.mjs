/**
 * botsun-owner: the client side of the botsun-owner v1 socket protocol.
 *
 * A temp Unix socket server stands in for Botsun; a stub pi/ctx drives the
 * extension's handlers. HOME is a temp dir, so the default socket path and the
 * agent-link registry (~/.claude/sessions) never touch the real ones.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { stubPi } from "./helpers/stub-pi.mjs";

const home = mkdtempSync(join(tmpdir(), "botsun-owner-"));
process.env.HOME = home;
process.env.BOEHSLINE_CONFIG = join(home, "boehsline.json");
process.env.BOTSUN_OWNER_RETRY_MS = "50";
delete process.env.BOTSUN_OWNER_DEBUG;
// Never the real tmux or restart records (restartEnv below fakes both).
delete process.env.TMUX;
delete process.env.TMUX_PANE;
process.env.XDG_STATE_HOME = join(home, "state");
// At exit, not in a root after(): with --test-name-pattern the root's after
// can run before tests registered past a top-level await, deleting HOME under them.
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 2000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await sleep(10);
	}
	assert.fail("timed out waiting");
}

const cleanups = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()();
});

let n = 0;
/** A server on a fresh socket path that records parsed lines. */
async function server(path = join(home, `s${++n}.sock`)) {
	const lines = [];
	const conns = new Set();
	const srv = createServer((c) => {
		conns.add(c);
		// Bytes, not strings: a chunk can end inside a multi-byte character, and one decoded on its own
		// would come out as a replacement character.
		let buf = Buffer.alloc(0);
		c.on("data", (d) => {
			buf = Buffer.concat([buf, d]);
			let i;
			while ((i = buf.indexOf(0x0a)) >= 0) {
				lines.push(JSON.parse(buf.subarray(0, i).toString("utf8")));
				buf = buf.subarray(i + 1);
			}
		});
		c.on("close", () => conns.delete(c));
	});
	await new Promise((r) => srv.listen(path, r));
	const stop = () => new Promise((r) => { for (const c of conns) c.destroy(); srv.close(() => r()); });
	cleanups.push(() => srv.listening && stop());
	return { path, lines, conns, stop, types: () => lines.map((l) => l.type) };
}

/** One line down to the session, as Botsun writes one (a features line, a color, an icon). */
function down(srv, msg) {
	for (const c of srv.conns) c.write(`${JSON.stringify(msg)}\n`);
}

async function mount({ ctx: over = {}, sessionName } = {}) {
	process.env.BOEHSLINE_ENABLE = "botsun-owner";
	const mod = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const s = stubPi();
	s.pi.getSessionName = () => sessionName;
	await mod.default(s.pi);
	const ctx = {
		cwd: "/tmp/work/proj",
		hasUI: true,
		mode: "tui",
		// pi is idle unless a test says otherwise (its compaction controller is set, a turn runs).
		isIdle: () => true,
		sessionManager: { getSessionFile: () => "/tmp/sessions/a.jsonl", getSessionId: () => "sid-a" },
		...over,
	};
	const fire = (event, payload = {}, c = ctx) => s.fire(event, payload, c);
	// A failed assertion must not leave a connection retrying past the test.
	cleanups.push(() => fire("session_shutdown", { reason: "quit" }));
	return { ...s, ctx, fire, mod };
}

// Device key pins (pins.ts): each test pairs fresh keys, so each starts with none.
const pinDir = join(home, "pins");
process.env.BOTSUN_OWNER_PIN_DIR = pinDir;

beforeEach(() => {
	delete process.env.PI_SUBAGENT_CHILD;
	delete globalThis[Symbol.for("botsun-owner.launch")]; // pi's startup session, once per process
	delete globalThis[Symbol.for("pi-boehsline.quiet")];
	rmSync(join(home, ".claude"), { recursive: true, force: true });
	rmSync(pinDir, { recursive: true, force: true });
});

test("hello on connect, then busy/idle/prompt/prompt_end/bye", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	const hello = srv.lines[0];
	assert.equal(hello.type, "hello");
	assert.equal(hello.v, 1);
	assert.equal(hello.pid, process.pid);
	assert.match(hello.at, /^\d{4}-\d\d-\d\dT.*Z$/);
	assert.equal(hello.name, "proj", "falls back to basename(cwd)");
	assert.equal(hello.cwd, "/tmp/work/proj");
	assert.equal(hello.session_file, "/tmp/sessions/a.jsonl");
	assert.equal(hello.session_id, "sid-a");
	assert.equal(hello.busy, false);
	assert.equal(hello.prompt, null);

	await m.fire("agent_start");
	await m.fire("ui_prompt_start", { reason: "ui_prompt", kind: "select", title: "x".repeat(900) });
	await m.fire("ui_prompt_end", { reason: "ui_prompt" });
	await m.fire("agent_settled");
	await m.fire("session_shutdown", { reason: "quit" });
	await until(() => srv.lines.length >= 6);
	assert.deepEqual(srv.types(), ["hello", "busy", "prompt", "prompt_end", "idle", "bye"]);
	assert.equal(srv.lines[2].kind, "select");
	assert.equal(srv.lines[2].title.length, 500);
	await until(() => srv.conns.size === 0);
	await srv.stop();
});

// The done signal's stamp: busy, stream_end and idle say when they were written in epoch ms, and
// idle says how long pi took to settle after agent_end. Botsun subtracts its own clock from at
// (lag_ms) and reads settle_ms, to see a slow settle chain (the canvas extension's runs first).
test("busy, stream_end and idle are stamped in ms; idle carries the settle gap", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const before = Date.now();
	await m.fire("agent_start");
	await m.fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
	await m.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
	await m.fire("agent_end");
	// A settle chain that takes a moment (canvas's writes run before this handler in the real one).
	await sleep(60);
	await m.fire("agent_settled");
	await until(() => srv.types().includes("idle"));
	const line = (type) => srv.lines.find((l) => l.type === type);
	const busy = line("busy");
	const streamEnd = line("stream_end");
	const idle = line("idle");
	assert.equal(typeof busy.at, "number", "busy: epoch ms, not the ISO at every other line has");
	assert.equal(typeof streamEnd.at, "number");
	assert.equal(typeof idle.at, "number");
	assert.ok(busy.at >= before && streamEnd.at >= before && idle.at >= before);
	assert.ok(idle.at >= busy.at, "idle is written after the run it ends");
	assert.ok(idle.settle_ms >= 50 && idle.settle_ms < 5_000, `settle_ms spans agent_end to idle (got ${idle.settle_ms})`);
	assert.equal(typeof idle.pid, "number", "the usual fields are still there");
	assert.equal(typeof idle.name, "string");
	// A run whose agent_end this extension never saw says so rather than sending a nonsense gap.
	await m.fire("agent_start");
	await m.fire("agent_settled");
	await until(() => srv.lines.filter((l) => l.type === "idle").length >= 2);
	assert.equal(srv.lines.filter((l) => l.type === "idle")[1].settle_ms, null);
	// Nor does a gap from an earlier run leak into a later one that ends without an agent_end (agent
	// start clears it).
	await m.fire("agent_end");
	await m.fire("agent_start");
	await m.fire("agent_settled");
	await until(() => srv.lines.filter((l) => l.type === "idle").length >= 3);
	assert.equal(srv.lines.filter((l) => l.type === "idle")[2].settle_ms, null, "agent_start cleared the stale gap");
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

// The quiet split settles his part of a run and starts a quiet one: its idle and busy are the
// phone's done signal too, so they carry the same epoch-ms at (an ISO string would give
// owner_lag_ms nil).
test("a quiet split's idle and busy are stamped in ms too", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	await m.fire("agent_start");
	const before = Date.now();
	m.pi.events.emit("quiet:split", { quiet: true });
	await until(() => srv.lines.filter((l) => l.type === "busy").length >= 2);
	const [first, split] = srv.lines.filter((l) => l.type === "busy");
	const idle = srv.lines.find((l) => l.type === "idle");
	assert.equal(typeof first.at, "number");
	assert.equal(typeof idle.at, "number", "the split's idle: epoch ms");
	assert.equal(typeof split.at, "number", "the split's quiet busy: epoch ms");
	assert.ok(idle.at >= before && split.at >= idle.at);
	assert.equal(split.quiet, true);
	assert.equal(split.split, true);
	assert.equal(idle.settle_ms, null, "no agent_end yet, so no gap to report");
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

test("name: agent-link registry, else pi session name; re-read per line", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ sessionName: "my-session" });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	assert.equal(srv.lines[0].name, "my-session");
	mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
	writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "vic", nameSource: "user", entrypoint: "pi" }));
	await m.fire("agent_start");
	writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), "{\"name\": \"par"); // partial write
	await m.fire("agent_settled");
	await until(() => srv.lines.length >= 3);
	assert.equal(srv.lines[1].name, "vic");
	assert.equal(srv.lines[2].name, "my-session", "a torn registry file falls back");
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

// The registry (~/.claude/sessions) is keyed by pid and shared with Claude Code: only this pi's own
// entry is this session's. Another pid's (a crashed process's, its pid reused) or another tool's
// file names nothing, and a folder-derived name is agent-link's, not the session's own.
test("only this pi's own registry entry names the session on the phone", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ sessionName: "my-session" });
	mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
	const registry = (entry) => writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify(entry));
	// The next line's name, once the connection has written it.
	const named = async (fire, expected) => {
		const before = srv.lines.length;
		await fire();
		await until(() => srv.lines.length > before);
		return srv.lines.at(-1).name;
	};
	registry({ pid: process.pid, name: "vic", nameSource: "user", entrypoint: "pi" });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	assert.equal(srv.lines[0].name, "vic", "this pi's own entry names it");
	// A dead pi whose pid this one reused: the file still says this pid, so its start time is what
	// tells it apart from a session that is really ours.
	registry({ pid: process.pid, name: "ghost", nameSource: "user", entrypoint: "pi", startedAt: Date.now() - 3_600_000 });
	assert.equal(await named(() => m.fire("agent_start")), "my-session", "a dead pi's file (same pid, an hour old) names nothing");
	registry({ pid: process.pid + 1, name: "other", nameSource: "user", entrypoint: "pi", startedAt: Date.now() });
	assert.equal(await named(() => m.fire("agent_settled")), "my-session", "another pid's file names nothing");
	registry({ pid: process.pid, name: "claude-session", nameSource: "user", entrypoint: "claude" });
	assert.equal(await named(() => m.fire("agent_start")), "my-session", "Claude Code's file names nothing");
	registry({ pid: process.pid, name: "pi-proj", nameSource: "derived", entrypoint: "pi" });
	assert.equal(await named(() => m.fire("agent_settled")), "pi-proj", "a derived name is still what the phone shows");
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

// Botsun's rename (the phone's info sheet): into pi's session name, only for this session and only
// a clean name; a features line then carries it, and it beats agent-link's older name.
test("Botsun's name line renames this session in pi and is said back at once", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ sessionName: "old" });
	let piName = "old";
	const sets = [];
	m.pi.getSessionName = () => piName;
	m.pi.setSessionName = (name) => { sets.push(name); piName = name; };
	mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
	writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "vic", nameSource: "user", entrypoint: "pi" }));
	await sleep(20); // the registry file is older than the rename
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const hello = srv.lines.find((l) => l.type === "hello");
	assert.equal(hello.name, "vic", "agent-link's name while nothing renamed it");
	assert.ok(hello.features.includes("name"), "Botsun sends the line, not /name");
	const [botsun] = srv.conns;
	const send = (over) => botsun.write(`${JSON.stringify({ v: 1, type: "name", session_id: "sid-a", name: "Billing fix", ...over })}\n`);

	for (const bad of [{ session_id: "sid-b" }, { name: 7 }, { name: "   " }, { name: "a\u0007b" }, { name: "evil\u202Etxt" }, { name: "two\nlines" }]) send(bad);
	await sleep(80);
	assert.deepEqual(sets, [], "another session's, a non-string, an empty one, a control character or a direction mark: nothing");
	const before = srv.lines.length;

	send({ name: "  Billing fix  " });
	await until(() => sets.length === 1 && srv.lines.length > before);
	assert.deepEqual(sets, ["Billing fix"], "trimmed");
	const said = srv.lines.slice(before).find((l) => l.type === "features");
	assert.equal(said?.name, "Billing fix", "the next line carries the rename, over agent-link's older name");

	writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "vic2", nameSource: "user", entrypoint: "pi" }));
	await m.fire("agent_start");
	await until(() => srv.lines.at(-1).type === "busy" || srv.lines.at(-1).name === "vic2");
	assert.equal(srv.lines.at(-1).name, "vic2", "agent-link naming it again afterwards wins again");
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

test("cleanName refuses control characters and direction marks, trims and caps", async () => {
	process.env.BOEHSLINE_ENABLE = "botsun-owner";
	const { cleanName } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	assert.equal(cleanName("  ok  "), "ok");
	assert.equal(cleanName("x".repeat(250)).length, 200);
	for (const bad of [undefined, 3, "", "  ", "a\tb", "a\u2028b", "a\u200Fb", "a\u2066b", "a\u061Cb", "a\u007Fb"]) assert.equal(cleanName(bad), undefined, JSON.stringify(bad));
	assert.equal(cleanName("Café ☕ 日本"), "Café ☕ 日本", "other text is kept");
});

test("reconnect resends hello with the current state", async () => {
	let srv = await server();
	const path = srv.path;
	process.env.BOTSUN_OWNER_SOCK = path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	await srv.stop();
	// While disconnected: state changes are tracked, not sent.
	await m.fire("agent_start");
	await m.fire("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Proceed?" });
	srv = await server(path);
	await until(() => srv.lines.length >= 1);
	assert.equal(srv.lines[0].type, "hello");
	assert.equal(srv.lines[0].busy, true);
	assert.deepEqual(srv.lines[0].prompt, { kind: "confirm", title: "Proceed?" });
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

test("session change keeps the connection and sends a session line", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const a = await mount();
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	await a.fire("session_shutdown", { reason: "new" });
	const b = await mount({
		ctx: { sessionManager: { getSessionFile: () => "/tmp/sessions/b.jsonl", getSessionId: () => "sid-b" } },
	});
	await b.fire("session_start", { reason: "new" });
	await until(() => srv.lines.length >= 2);
	assert.deepEqual(srv.types(), ["hello", "session", "features", "context", "stash"]);
	assert.equal(srv.lines[1].session_file, "/tmp/sessions/b.jsonl");
	assert.equal(srv.lines[1].session_id, "sid-b");
	assert.equal(srv.lines[1].cwd, "/tmp/work/proj");
	assert.equal(srv.conns.size, 1, "same connection");
	await b.fire("session_shutdown", { reason: "quit" });
	await until(() => srv.types().includes("bye"));
	await srv.stop();
});

test("launchOf and helloOnSwitch: a hello only on a switch back to a sandbox template's own conversation", async () => {
	const { launchOf, helloOnSwitch } = await import(`../extensions/opt-in/botsun-owner/index.ts?l=${Math.random()}`);
	const own = { sessionId: "sandbox-pal", sessionFile: "/s/pal.jsonl" };
	const launch = launchOf(own);
	assert.deepEqual(launch, { id: "sandbox-pal", file: "/s/pal.jsonl" });
	assert.equal(launchOf({ sessionId: "0193-mac", sessionFile: "/s/m.jsonl" }), null, "a Mac pi has none, even one started with --session-id");
	assert.equal(launchOf({ sessionId: null, sessionFile: null }), null);
	const other = { sessionId: "sandbox-other", sessionFile: "/s/other.jsonl" };
	assert.equal(helloOnSwitch(other, own, launch), true);
	assert.equal(helloOnSwitch(own, own, launch), false, "no switch");
	assert.equal(helloOnSwitch(own, other, launch), false, "leaving keeps the session line");
	assert.equal(helloOnSwitch(other, { sessionId: "sandbox-pal", sessionFile: "/elsewhere/pal.jsonl" }, launch), false, "the same id in another folder isn't its own");
	assert.equal(helloOnSwitch(other, own, null), false, "not a sandbox template's pi");
});

test("switching back to its own conversation says hello again, fresh, on the same connection", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const at = (id) => ({ ctx: { sessionManager: { getSessionFile: () => `/tmp/sessions/${id}.jsonl`, getSessionId: () => id } } });
	const get = () => globalThis[Symbol.for("botsun.sessionToken")]?.();
	const a = await mount(at("sandbox-pal"));
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	const [bridge] = srv.conns;
	const token = `sandbox.${"A1_-".repeat(10)}xyz`;
	bridge.write(`${JSON.stringify({ v: 1, type: "sandbox_token", token, expires_in: 60 })}\n`);
	await until(() => get() === token);
	await a.fire("agent_start");
	await a.fire("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Other conversation's question?" });
	await a.fire("session_shutdown", { reason: "resume" });
	const b = await mount(at("sid-other"));
	await b.fire("session_start", { reason: "resume" });
	await until(() => srv.types().includes("session"));
	assert.equal(get(), undefined, "the token was for its own conversation");
	bridge.write(`${JSON.stringify({ v: 1, type: "sandbox_token", token, expires_in: 60 })}\n`); // a renewal already on its way
	await sleep(50);
	assert.equal(get(), undefined, "a token for a conversation pi has left isn't kept");
	await b.fire("agent_start");
	await b.fire("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Other conversation's question?" });
	await until(() => srv.types().filter((t) => t === "prompt").length >= 2);
	await b.fire("session_shutdown", { reason: "resume" });
	const mark = srv.lines.length;
	const c = await mount(at("sandbox-pal"));
	await c.fire("session_start", { reason: "resume" });
	await until(() => srv.types().filter((t) => t === "hello").length >= 2);
	await sleep(50);
	const after = srv.lines.slice(mark);
	assert.deepEqual(after.map((l) => l.type), ["hello"], "one hello carries it all: no idle, prompt_end or session line");
	assert.equal(after[0].session_id, "sandbox-pal");
	assert.equal(after[0].busy, false, "nothing of the conversation it left");
	assert.equal(after[0].prompt, null);
	assert.equal(srv.types().filter((t) => t === "session").length, 1, "only the switch away sends a session line");
	assert.equal(srv.conns.size, 1, "same connection");
	bridge.write(`${JSON.stringify({ v: 1, type: "sandbox_token", token, expires_in: 60 })}\n`);
	await until(() => get() === token);
	await c.fire("session_shutdown", { reason: "quit" });
	await until(() => srv.types().includes("bye"));
	await srv.stop();
});

/** The color extension's events (extensions/color), as it answers them: state is what /color is. */
function fakeColor(pi, state = { spec: null, at: null }) {
	const sets = [];
	const fail = []; // errors for the next sets, in turn
	pi.events.on("color:query", (d) => d.reply({ ...state }));
	pi.events.on("color:set", (req) => {
		req.handled = true;
		sets.push({ spec: req.spec, at: req.at, from: req.from });
		if (fail.length) {
			req.error = fail.shift();
			return;
		}
		Object.assign(state, { spec: req.spec, at: req.at });
		pi.events.emit("color:state", { ...state, source: "set" });
	});
	const command = (spec, at) => {
		Object.assign(state, { spec, at });
		pi.events.emit("color:state", { ...state, source: "command" });
	};
	return { sets, state, command, fail };
}

test("/color goes to Botsun on hello, on a session line and on each change, as Botsun's name", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const a = await mount();
	const color = fakeColor(a.pi, { spec: "#ff0000", at: 100 });
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const hello = srv.lines.find((l) => l.type === "hello");
	assert.deepEqual([hello.color, hello.color_at], ["red", 100]);

	color.command("indigo", 200);
	await until(() => srv.types().includes("color"));
	assert.deepEqual(srv.lines.filter((l) => l.type === "color").map((l) => [l.color, l.color_at]), [["indigo", 200]]);
	color.command("indigo", 200); // the same again (a repaint): nothing new to say
	color.command(null, 300); // /color off
	await until(() => srv.types().filter((t) => t === "color").length >= 2);
	await sleep(30);
	assert.deepEqual(srv.lines.filter((l) => l.type === "color").map((l) => [l.color, l.color_at]), [["indigo", 200], [null, 300]]);

	await a.fire("session_shutdown", { reason: "new" });
	const b = await mount({ ctx: { sessionManager: { getSessionFile: () => "/tmp/sessions/b.jsonl", getSessionId: () => "sid-b" } } });
	fakeColor(b.pi, color.state);
	await b.fire("session_start", { reason: "new" });
	await until(() => srv.types().includes("session"));
	const session = srv.lines.find((l) => l.type === "session");
	assert.deepEqual([session.session_id, session.color, session.color_at], ["sid-b", null, 300], "pi's color is the process's");
});

test("without the color extension, no color is said and none is taken", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const a = await mount();
	const sets = [];
	a.pi.events.on("color:set", (req) => sets.push(req)); // something listening, but not answering
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const hello = srv.lines.find((l) => l.type === "hello");
	assert.ok(!("color" in hello) && !("color_at" in hello));
	const [botsun] = srv.conns;
	botsun.write(`${JSON.stringify({ v: 1, type: "color", session_id: "sid-a", color: "teal", at: 5 })}\n`);
	await sleep(50);
	assert.equal(sets.length, 1, "asked");
	assert.ok(!srv.types().includes("color"), "nothing said back");
});

// Botsun's saved color: into /color for the session pi is in, and not said back (no echo).
test("Botsun's color goes into /color, only for this session, and isn't reported back", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const a = await mount();
	const color = fakeColor(a.pi);
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const [botsun] = srv.conns;
	const push = (over) => botsun.write(`${JSON.stringify({ v: 1, type: "color", session_id: "sid-a", color: "teal", at: 900, ...over })}\n`);
	push({ session_id: "sid-old" }); // for a session pi has left
	push({ color: "#ff0000" }); // not a Botsun name
	push({ color: "chartreuse" });
	push({ at: -5 });
	push({ type: "colour" });
	push();
	await until(() => color.sets.length >= 1);
	push({ color: "pink", at: 950 });
	await until(() => color.sets.length >= 2);
	await sleep(50);
	assert.deepEqual(color.sets, [{ spec: "#12b5b0", at: 900, from: "Botsun" }, { spec: "pink", at: 950, from: "Botsun" }]);
	assert.ok(!srv.types().includes("color"), "what Botsun sent isn't news to it");

	color.command("pink", 960); // and a /color after it is
	await until(() => srv.types().includes("color"));
	assert.deepEqual(srv.lines.filter((l) => l.type === "color").map((l) => [l.color, l.color_at]), [["pink", 960]]);
});

// A color /color refused (older than its own, say) was never taken: pi's own is still news to Botsun.
test("a color /color refused leaves pi's own to report", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const a = await mount();
	const color = fakeColor(a.pi);
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const [botsun] = srv.conns;
	color.fail.push("older than the color now");
	botsun.write(`${JSON.stringify({ v: 1, type: "color", session_id: "sid-a", color: "teal", at: 900 })}\n`);
	await until(() => color.sets.length >= 1);
	color.command("#12b5b0", 900); // what pi has, which happens to be what Botsun sent
	await until(() => srv.types().includes("color"));
	assert.deepEqual(srv.lines.filter((l) => l.type === "color").map((l) => [l.color, l.color_at]), [["teal", 900]]);
});

// pi's events throw once the instance is stale (a /reload mid-handoff): a push then must not end pi.
test("a color that comes while pi's events throw is dropped, and the connection reads on", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const a = await mount();
	const color = fakeColor(a.pi);
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const [botsun] = srv.conns;
	const emit = a.pi.events.emit;
	a.pi.events.emit = () => { throw new Error("stale extension instance"); };
	botsun.write(`${JSON.stringify({ v: 1, type: "color", session_id: "sid-a", color: "teal", at: 900 })}\n`);
	await sleep(50);
	a.pi.events.emit = emit;
	botsun.write(`${JSON.stringify({ v: 1, type: "color", session_id: "sid-a", color: "pink", at: 950 })}\n`);
	await until(() => color.sets.length >= 1);
	assert.deepEqual(color.sets, [{ spec: "pink", at: 950, from: "Botsun" }]);
});

// /color keeps its color through a /new; Botsun's color for the session left isn't the next one's pick.
test("a color Botsun gave one session is said as carried in the next, and a /color there is not", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const a = await mount();
	const color = fakeColor(a.pi, { spec: "teal", at: 100 });
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	assert.ok(!("color_carried" in srv.lines.find((l) => l.type === "hello")), "pi's own");
	const [botsun] = srv.conns;
	botsun.write(`${JSON.stringify({ v: 1, type: "color", session_id: "sid-a", color: "pink", at: 900 })}\n`);
	await until(() => color.sets.length >= 1);
	botsun.destroy(); // Botsun restarting: its own color, said back in the session it went to
	await until(() => srv.types().filter((t) => t === "hello").length >= 2);
	const again = srv.lines.filter((l) => l.type === "hello").at(-1);
	assert.deepEqual([again.color, again.color_at, "color_carried" in again], ["pink", 900, false]);

	await a.fire("session_shutdown", { reason: "new" });
	const b = await mount({ ctx: { sessionManager: { getSessionFile: () => "/tmp/sessions/b.jsonl", getSessionId: () => "sid-b" } } });
	const carried = fakeColor(b.pi, color.state);
	await b.fire("session_start", { reason: "new" });
	await until(() => srv.types().includes("session"));
	const session = srv.lines.find((l) => l.type === "session");
	assert.deepEqual([session.session_id, session.color, session.color_at, session.color_carried], ["sid-b", "pink", 900, true]);

	carried.command("pink", 1000); // the same color, picked here
	await until(() => srv.types().includes("color"));
	const line = srv.lines.find((l) => l.type === "color");
	assert.deepEqual([line.color, line.color_at, "color_carried" in line], ["pink", 1000, false]);
});

test("a /reload in its own conversation keeps the token and says no hello; so does a connection from before boundId", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const at = (id) => ({ ctx: { sessionManager: { getSessionFile: () => `/tmp/sessions/${id}.jsonl`, getSessionId: () => id } } });
	const get = () => globalThis[Symbol.for("botsun.sessionToken")]?.();
	const a = await mount(at("sandbox-pal"));
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	const [bridge] = srv.conns;
	const token = `sandbox.${"A1_-".repeat(10)}xyz`;
	const send = () => bridge.write(`${JSON.stringify({ v: 1, type: "sandbox_token", token, expires_in: 60 })}\n`);
	send();
	await until(() => get() === token);
	await a.fire("session_shutdown", { reason: "reload" });
	const b = await mount(at("sandbox-pal"));
	await b.fire("session_start", { reason: "reload" });
	await sleep(50);
	assert.equal(get(), token, "kept across a reload");
	assert.equal(srv.types().filter((t) => t === "hello").length, 1, "no second hello");
	assert.ok(!srv.types().includes("session"));
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	delete conn.boundId; // as made by the version before boundId
	await b.fire("session_shutdown", { reason: "reload" });
	const c = await mount(at("sandbox-pal"));
	await c.fire("session_start", { reason: "reload" });
	await sleep(50);
	assert.equal(get(), token, "an upgraded connection keeps its token");
	conn.sandboxToken = undefined;
	send();
	await until(() => get() === token);
	await c.fire("session_shutdown", { reason: "quit" });
	await until(() => srv.types().includes("bye"));
	await srv.stop();
});

test("a new connection after pi left its startup conversation doesn't take the current one as its own", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const at = (id) => ({ ctx: { sessionManager: { getSessionFile: () => `/tmp/sessions/${id}.jsonl`, getSessionId: () => id } } });
	const a = await mount(at("sandbox-pal"));
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	await a.fire("session_shutdown", { reason: "quit" }); // the connection goes (a slow handoff closes it the same way)
	await until(() => srv.types().includes("bye"));
	const b = await mount(at("sandbox-other"));
	await b.fire("session_start", { reason: "resume" });
	await until(() => srv.types().filter((t) => t === "hello").length >= 2);
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	assert.deepEqual(conn.launch, { id: "sandbox-pal", file: "/tmp/sessions/sandbox-pal.jsonl" }, "still pi's startup session");
	await b.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

test("a Mac pi switching back to its first conversation keeps the session line", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const at = (id) => ({ ctx: { sessionManager: { getSessionFile: () => `/tmp/sessions/${id}.jsonl`, getSessionId: () => id } } });
	const a = await mount(at("sid-a"));
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	await a.fire("session_shutdown", { reason: "resume" });
	const b = await mount(at("sid-b"));
	await b.fire("session_start", { reason: "resume" });
	await b.fire("session_shutdown", { reason: "resume" });
	const c = await mount(at("sid-a"));
	await c.fire("session_start", { reason: "resume" });
	await until(() => srv.types().filter((t) => t === "session").length >= 2);
	assert.equal(srv.types().filter((t) => t === "hello").length, 1);
	await c.fire("session_shutdown", { reason: "quit" });
	await until(() => srv.types().includes("bye"));
	await srv.stop();
});

test("subagent children and sessions without a TUI send nothing", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;

	process.env.PI_SUBAGENT_CHILD = "1";
	const child = await mount();
	assert.deepEqual(child.names(), [], "a subagent child registers nothing");
	delete process.env.PI_SUBAGENT_CHILD;

	for (const over of [{ hasUI: false, mode: "print" }, { hasUI: true, mode: "rpc" }, { hasUI: false, mode: "json" }]) {
		const m = await mount({ ctx: over });
		await m.fire("session_start", { reason: "startup" });
		await m.fire("agent_start");
		await m.fire("ui_prompt_start", { reason: "ui_prompt", kind: "input", title: "" });
		await m.fire("session_shutdown", { reason: "quit" });
	}
	await sleep(150);
	assert.equal(srv.lines.length, 0);
	assert.equal(srv.conns.size, 0);
	await srv.stop();
});

test("a steer is marked in the session file (text only, ≤ 200 chars); other input isn't", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await m.fire("session_start", { reason: "new" }); // registers once
	const image = { type: "image", data: "QUJD", mimeType: "image/png" };
	await m.fire("input", { type: "input", text: "plain", source: "interactive" });
	await m.fire("input", { type: "input", text: "later", source: "interactive", streamingBehavior: "followUp" });
	assert.equal(m.entries.length, 0);
	const before = Date.now();
	await m.fire("input", { type: "input", text: "x".repeat(300), images: [image], source: "extension", streamingBehavior: "steer" });
	assert.equal(m.entries.length, 1);
	const [e] = m.entries;
	assert.equal(e.customType, "botsun-steer");
	assert.deepEqual(Object.keys(e.data).sort(), ["at", "text"]);
	assert.equal(e.data.text, "x".repeat(200));
	assert.ok(e.data.at >= before && e.data.at <= Date.now());
	m.pi.appendEntry = () => { throw new Error("boom"); };
	await m.fire("input", { type: "input", text: "y", source: "interactive", streamingBehavior: "steer" }); // never throws
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

test("a missing socket doesn't throw, retries quietly, and stops on shutdown", async () => {
	const path = join(home, `missing${++n}.sock`);
	process.env.BOTSUN_OWNER_SOCK = path;
	const count = () => process.getActiveResourcesInfo().filter((r) => r === "PipeWrap" || r === "Timeout").length;
	const before = count();
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await m.fire("agent_start");
	await sleep(200); // a few retries at the 50ms test backoff
	await m.fire("session_shutdown", { reason: "quit" });
	await sleep(20);
	assert.ok(count() <= before, "no sockets or ref'd timers left behind");
	// Botsun coming up after shutdown must not get a connection.
	const srv = await server(path);
	await sleep(400);
	assert.equal(srv.lines.length, 0);
	assert.equal(srv.conns.size, 0);
});

test("the default path is under HOME/.local/state/botsun", async () => {
	delete process.env.BOTSUN_OWNER_SOCK;
	process.env.BOEHSLINE_ENABLE = "botsun-owner";
	const { sockPath } = await import(`../extensions/opt-in/botsun-owner/index.ts?p=${Math.random()}`);
	assert.equal(sockPath(), join(home, ".local", "state", "botsun", "owner.sock"));
});

// ---- T2: reply as Eric over the session's own owner socket ----------------

import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createConnection } from "node:net";

const ownerDir = join(home, "owner");
const keysFile = join(home, "owner-keys.json");
process.env.BOTSUN_OWNER_DIR = ownerDir;
process.env.BOTSUN_OWNER_KEYS = keysFile;

function phoneKey() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-65); // the uncompressed point
	return { privateKey, raw };
}

function writeKeys(devices, mode = 0o600) {
	writeFileSync(keysFile, JSON.stringify({ devices }));
	chmodSync(keysFile, mode);
}

function signed(key, deviceId, nonce, sessionId, text) {
	const digest = createHash("sha256").update(text, "utf8").digest("hex");
	const msg = ["botsun-decide-v1", String(deviceId), nonce, "session", sessionId, "say", digest].join("\n");
	return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
}

function ask(req) {
	return new Promise((resolve, reject) => {
		const c = createConnection(join(ownerDir, `${process.pid}.sock`));
		let buf = "";
		c.on("data", (d) => { buf += d; });
		c.on("end", () => resolve(JSON.parse(buf)));
		c.on("error", reject);
		c.write(`${JSON.stringify(req)}\n`);
	});
}

async function owner() {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	return m;
}

/** Fake ffmpeg / ffprobe first on PATH (never the real ones), PATH restored after the test. With a
 * `gate`, ffmpeg touches `marker` and then waits for that file before writing its frame, so a test
 * can hold the frames still and see what queues behind them. */
function fakeFfmpeg(gate) {
	const bin = join(home, `fakebin-${process.pid}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\ncase "$*" in *stream=width,height*) echo 1920x1080 ;; *) echo 192.4 ;; esac\n`, { mode: 0o755 });
	const hold = gate ? `touch '${gate.marker}'\nwhile [ ! -f '${gate.gate}' ]; do sleep 0.02; done\n` : "";
	writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\n${hold}for a; do out=$a; done\nprintf '\\377\\330\\377frame' > "$out"\n`, { mode: 0o755 });
	const path0 = process.env.PATH;
	const dirs0 = process.env.BOTSUN_OWNER_FFMPEG_DIRS;
	cleanups.push(() => {
		process.env.PATH = path0;
		if (dirs0 === undefined) delete process.env.BOTSUN_OWNER_FFMPEG_DIRS; else process.env.BOTSUN_OWNER_FFMPEG_DIRS = dirs0;
	});
	// Never leave a held ffmpeg waiting: a failure must not keep the test process alive.
	if (gate) cleanups.push(() => { try { writeFileSync(gate.gate, "go"); } catch {} });
	// The fake first, and the real PATH behind it: the fake scripts need touch and sleep.
	process.env.PATH = `${bin}${delimiter}${path0 ?? ""}`;
	process.env.BOTSUN_OWNER_FFMPEG_DIRS = "";
}

/** An MP4-looking head: a real "ftyp" box, so the extension wants frames from it. */
const fakeMp4 = (size = 2000) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(size, 7)]);
/** An upload's own name as Botsun mints it: 16 random bytes in hex, so `.part` is taken. */
const fakeUploadName = () => Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
/** The upload record Botsun hands on: the signed size and sha256 over exactly these bytes. */
const fakeUpload = (dir, bytes, name = "Clip.mp4") => {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${fakeUploadName()}.part`);
	writeFileSync(path, bytes, { mode: 0o600 });
	return { path, name, mime: "video/mp4", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
/** What a sent message says, whether it went in as plain words or with photos/frames. */
const sentText = (sent) => typeof sent.content === "string" ? sent.content
	: sent.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

test("a signed reply goes in as Eric's message; the nonce is single use", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const { nonce, session_id } = await ask({ type: "nonce" });
	assert.equal(session_id, "sid-a");
	assert.ok((await ask({ type: "nonce" })).features.includes("images"));
	const text = "Approved: run the migration";
	const signature = signed(key, 7, nonce, "sid-a", text);
	assert.deepEqual(await ask({ type: "say", text, nonce, device_id: 7, signature }), { ok: true, delivered: "prompt" });
	assert.deepEqual(m.sent.at(-1), { content: text, options: undefined });
	const again = await ask({ type: "say", text, nonce, device_id: 7, signature });
	assert.equal(again.error, "nonce is expired or used");
	assert.equal(m.sent.length, 1);
});

test("while busy the reply steers into the running turn", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	await m.fire("agent_start");
	const { nonce } = await ask({ type: "nonce" });
	const text = "stop and run the tests first";
	const res = await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	assert.equal(res.delivered, "steer");
	assert.deepEqual(m.sent.at(-1).options, { deliverAs: "steer" });
});

test("wrong key, wrong session, changed text, unknown device and a loose key file are refused", async () => {
	const key = phoneKey();
	const other = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const tries = [
		["other device's key", (n) => ({ text: "hi", device_id: 7, signature: signed(other, 7, n, "sid-a", "hi") })],
		["signed for another session", (n) => ({ text: "hi", device_id: 7, signature: signed(key, 7, n, "sid-b", "hi") })],
		["text changed after signing", (n) => ({ text: "rm -rf", device_id: 7, signature: signed(key, 7, n, "sid-a", "hi") })],
		["unknown device", (n) => ({ text: "hi", device_id: 8, signature: signed(key, 8, n, "sid-a", "hi") })],
	];
	for (const [why, build] of tries) {
		const { nonce } = await ask({ type: "nonce" });
		const res = await ask({ type: "say", nonce, ...build(nonce) });
		assert.ok(res.error, why);
	}
	writeKeys({ 7: key.raw.toString("base64") }, 0o666);
	const { nonce } = await ask({ type: "nonce" });
	const res = await ask({ type: "say", text: "hi", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "hi") });
	assert.match(res.error, /only Eric can write/);
	assert.equal(m.sent.length, 0, "nothing reached the session");
});

test("the owner socket is 0600 and goes away on quit", async () => {
	const m = await owner();
	const path = join(ownerDir, `${process.pid}.sock`);
	const { statSync } = await import("node:fs");
	await until(() => (statSync(path).mode & 0o777) === 0o600);
	await m.fire("session_shutdown", { reason: "quit" });
	await until(() => !existsSync(path));
});

test("/reload over a connection from the T1 extension upgrades it in place", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const first = await mount();
	await first.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	// What a T1-era instance left on globalThis: no nonce map, no owner socket.
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	conn.server.close();
	rmSync(join(ownerDir, `${process.pid}.sock`), { force: true });
	delete conn.server;
	delete conn.nonces;
	delete conn.inject;
	await first.fire("session_shutdown", { reason: "reload" });
	const second = await mount();
	await second.fire("session_start", { reason: "reload" }); // threw "reading 'clear'" before the fix
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	const { nonce } = await ask({ type: "nonce" });
	assert.ok(nonce, "the upgraded session takes replies");
});

// A sandbox session (Botsun's lib/botsun/sandbox_tokens.rb): the VM's owner bridge writes its
// VM-tool token down this session's own connection; it lives in this process only, for the VM
// extensions' turnHeader. Never from <pid>.sock, which any process of the user can open.
test("a sandbox session token comes only down Botsun's connection, kept in memory while it is up", async () => {
	const { lstatSync, readFileSync } = await import("node:fs");
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	const get = () => globalThis[Symbol.for("botsun.sessionToken")]?.();
	assert.equal(typeof globalThis[Symbol.for("botsun.sessionToken")], "function");
	assert.equal(get(), undefined, "none until Botsun sends one");
	const [bridge] = srv.conns;
	const send = (line) => bridge.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
	const settle = () => new Promise((r) => setTimeout(r, 50));

	const token = `sandbox.${"A1_-".repeat(10)}xyz`;
	assert.deepEqual(await ask({ type: "sandbox_token", token, expires_in: 60 }), { error: "unknown request" }, "never over <pid>.sock");
	assert.equal(get(), undefined, "a process that connects to <pid>.sock can't plant one");
	const sets = [];
	m.pi.events.on("color:set", (req) => { req.handled = true; sets.push(req); });
	assert.deepEqual(await ask({ v: 1, type: "color", session_id: "sid-a", color: "teal", at: 900 }), { error: "unknown request" }, "nor a color");
	assert.equal(sets.length, 0, "nothing reached /color");

	for (const bad of [{ token: "sandbox.short", expires_in: 60 }, { token: `${token}x`, expires_in: 60 }, { token: token.replace("sandbox.", "turn."), expires_in: 60 },
		{ token, expires_in: 0 }, { token, expires_in: 12 * 3600 + 1 }, { token, expires_in: "60" }, { token }]) {
		send({ v: 1, type: "sandbox_token", ...bad });
	}
	send({ v: 2, type: "sandbox_token", token, expires_in: 60 });
	send({ v: 1, type: "say", token, expires_in: 60 });
	send("not json");
	send(`{"v":1,"type":"sandbox_token","token":"${token}","expires_in":60,"pad":"${"x".repeat(5000)}"}`);
	await settle();
	assert.equal(get(), undefined, "a malformed, other or oversized line is never kept");

	bridge.write(`{"v":1,"type":"sandbox_token","tok`); // split across writes, as a socket may
	await settle();
	bridge.write(`en":"${token}","expires_in":60}\n`);
	await until(() => get() === token);
	const renewed = `sandbox.${"b".repeat(43)}`;
	send({ v: 1, type: "sandbox_token", token: renewed, expires_in: 12 * 3600 });
	await until(() => get() === renewed);

	// Never sent back to Botsun, never written under HOME (pins, inbox, keys, sockets dir...).
	assert.ok(!JSON.stringify(srv.lines).includes("sandbox."), "not in any line to Botsun");
	const walk = (dir) => readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		const st = lstatSync(p);
		return st.isDirectory() ? walk(p) : st.isFile() ? [p] : [];
	});
	for (const f of walk(home)) assert.ok(!readFileSync(f, "utf8").includes("sandbox."), `not in ${f}`);

	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	conn.sandboxToken.expiresAt = Date.now() - 1;
	assert.equal(get(), undefined, "an expired one is gone");

	send({ v: 1, type: "sandbox_token", token, expires_in: 60 });
	await until(() => get() === token);
	await srv.stop(); // Botsun (the bridge) hung up: it revoked the token with the connection
	await until(() => get() === undefined);
	assert.equal(conn.sandboxToken, undefined, "dropped, not just hidden");
	await m.fire("session_shutdown", { reason: "quit" });
	assert.equal(get(), undefined);
});

test("assistant text streams (throttled) and ends with stream_end", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const msg = (text) => ({ message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text }] } });
	await m.fire("message_update", msg("Now"));
	await m.fire("message_update", msg("Now checking"));
	await m.fire("message_update", { message: { role: "user", content: "ignored" } });
	await until(() => srv.types().includes("stream"));
	await sleep(300);
	const streams = srv.lines.filter((l) => l.type === "stream");
	assert.equal(streams.at(-1).text, "Now checking", "the latest text, thinking left out");
	assert.ok(streams.length <= 2, "throttled");
	await m.fire("message_end", msg("Now checking the logs."));
	await until(() => srv.types().includes("stream_end"));
});

function signedImages(key, deviceId, nonce, sessionId, text, images) {
	const hex = (b) => createHash("sha256").update(b).digest("hex");
	const digest = hex([hex(Buffer.from(text, "utf8")), ...images.map((i) => hex(Buffer.from(i.data, "base64")))].join("\n"));
	const msg = ["botsun-decide-v1", String(deviceId), nonce, "session", sessionId, "say_images", digest].join("\n");
	return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
}

test("a reply with photos goes in as text + image blocks, bound to those exact photos", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const photo = { data: Buffer.from("fake jpeg bytes").toString("base64"), mime_type: "image/jpeg" };
	const other = { data: Buffer.from("another photo").toString("base64"), mime_type: "image/jpeg" };
	let { nonce } = await ask({ type: "nonce" });
	let res = await ask({ type: "say", text: "what's this error?", images: [photo], nonce, device_id: 7,
		signature: signedImages(key, 7, nonce, "sid-a", "what's this error?", [photo]) });
	assert.deepEqual(res, { ok: true, delivered: "prompt" });
	assert.deepEqual(m.sent.at(-1).content, [
		{ type: "text", text: "what's this error?" },
		{ type: "image", data: photo.data, mimeType: "image/jpeg" },
	]);

	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "hi", images: [other], nonce, device_id: 7, signature: signedImages(key, 7, nonce, "sid-a", "hi", [photo]) });
	assert.equal(res.error, "signature does not verify", "a swapped photo");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "hi", images: [photo], nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "hi") });
	assert.equal(res.error, "signature does not verify", "a text-only signature with a photo added");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "", images: [photo], nonce, device_id: 7, signature: signedImages(key, 7, nonce, "sid-a", "", [photo]) });
	assert.equal(res.ok, true, "a photo alone is fine");
	assert.deepEqual(m.sent.at(-1).content, [{ type: "image", data: photo.data, mimeType: "image/jpeg" }]);
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "x", images: [{ data: photo.data, mime_type: "application/pdf" }], nonce, device_id: 7, signature: "AA==" });
	assert.match(res.error, /JPEG/);
	assert.equal(m.sent.length, 2);
});

test("a call's utterance is checked against the phone's call key and its audio hash", async () => {
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	const wav = createHash("sha256").update("RIFF…audio").digest("hex");
	const sig = (key, nonce, hash = wav) => cryptoSign("sha256",
		Buffer.from(["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", hash].join("\n")), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	let { nonce } = await ask({ type: "nonce" });
	let res = await ask({ type: "say_audio", text: "what's the status", nonce, device_id: 7, wav_sha256: wav, signature: sig(call, nonce) });
	assert.deepEqual(res, { ok: true, delivered: "prompt" });
	assert.equal(m.sent.at(-1).content, "what's the status");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, wav_sha256: wav, signature: sig(decide, nonce) });
	assert.equal(res.error, "signature does not verify", "the decision key isn't the call key");
	({ nonce } = await ask({ type: "nonce" }));
	const other = createHash("sha256").update("other audio").digest("hex");
	res = await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, wav_sha256: other, signature: sig(call, nonce) });
	assert.equal(res.error, "signature does not verify", "signed for different audio");
	assert.equal(m.sent.length, 1);
});

test("a locked phone's text reply: call key, v2, decision say_call, text only; keys and decisions never cross", async () => {
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	const payload = (text) => `botsun-propose-text-v1\n${text}`;
	const callSay = async (text, { key = call, decision = "say_call", extra = {} } = {}) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", key: "call", text, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", decision, payload(text)), ...extra });
	};
	assert.ok((await ask({ type: "nonce" })).features.includes("say_call"));
	assert.deepEqual(await callSay("ship it"), { ok: true, delivered: "prompt" });
	assert.equal(m.sent.at(-1).content, "ship it");
	assert.equal((await callSay("hi", { key: decide })).error, "signature does not verify", "the main key isn't the call key");
	assert.equal((await callSay("hi", { decision: "say" })).error, "signature does not verify", "a say signature isn't a say_call one");
	const jpeg = Buffer.from("\xff\xd8jpeg").toString("base64");
	assert.equal((await callSay("look", { extra: { images: [{ data: jpeg, mime_type: "image/jpeg" }] } })).error, "a call-key reply is text only");
	assert.equal((await callSay("look", { extra: { files: [{ name: "a.txt", data: jpeg }] } })).error, "a call-key reply is text only");
	assert.equal((await callSay("hi", { extra: { sig_v: 1 } })).error, "a call-key reply must be signed v2");
	assert.equal((await callSay("hi", { extra: { key: "main" } })).error, "bad request");
	assert.match((await callSay("  ")).error, /^text must be/);
	// Words only: no command, skill, template or bash prefix from a locked phone.
	for (const cmd of ["/bypass on", "  /model x", "\n/skill:review", "!ls", " !!rm -rf x", "\uFEFF/bypass on", "\u200B/model x"]) {
		assert.equal((await callSay(cmd)).error, "a locked-phone reply can't run commands", JSON.stringify(cmd));
	}
	assert.deepEqual(await callSay("use /tmp, not !important"), { ok: true, delivered: "prompt" }, "a slash or bang later on is just text");
	// The other way round: a say_call signature by the call key, sent as a main-key say.
	let { nonce } = await ask({ type: "nonce" });
	let res = await ask({ type: "say", text: "hi", nonce, device_id: 7, sig_v: 2, signature: signV2(call, nonce, "session", "say_call", payload("hi")) });
	assert.equal(res.error, "signature does not verify");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "hi", nonce, device_id: 7, sig_v: 2, signature: signV2(call, nonce, "session", "say", payload("hi")) });
	assert.equal(res.error, "signature does not verify", "the call key never signs a main-key say");
	// A say_call signature is no good for any other request.
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "stop", key: "call", nonce, device_id: 7, sig_v: 2, signature: signV2(call, nonce, "session", "say_call", payload("stop")) });
	assert.ok(res.error);
	// Spent nonces stay spent.
	({ nonce } = await ask({ type: "nonce" }));
	const signature = signV2(call, nonce, "session", "say_call", payload("once"));
	assert.equal((await ask({ type: "say", key: "call", text: "once", nonce, device_id: 7, sig_v: 2, signature })).ok, true);
	assert.equal((await ask({ type: "say", key: "call", text: "once", nonce, device_id: 7, sig_v: 2, signature })).error, "nonce is expired or used");
	assert.deepEqual(m.sent.map((s) => s.content), ["ship it", "use /tmp, not !important", "once"]);
});

test("attached files are saved for the agent, named in the message, and bound by the signature", async () => {
	const { readFileSync, statSync } = await import("node:fs");
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const hex = (b) => createHash("sha256").update(b).digest("hex");
	const file = { name: "report.csv", data: Buffer.from("a,b\n1,2\n").toString("base64") };
	const sign = (nonce, text, files) => {
		const digest = hex([hex(Buffer.from(text, "utf8")), ...files.map((f) => `file ${hex(Buffer.from(f.name, "utf8"))} ${hex(Buffer.from(f.data, "base64"))}`)].join("\n"));
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_attach", digest].join("\n");
		return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	};
	let { nonce } = await ask({ type: "nonce" });
	const renamed = { ...file, name: "evil.sh" };
	let res = await ask({ type: "say", text: "look", files: [renamed], nonce, device_id: 7, signature: sign(nonce, "look", [file]) });
	assert.equal(res.error, "signature does not verify", "a renamed file");

	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "look", files: [file], nonce, device_id: 7, signature: sign(nonce, "look", [file]) });
	assert.equal(res.ok, true);
	const said = m.sent.at(-1).content;
	const path = said.match(/📎 Attached: (\S+) \(8 B\)/)[1];
	assert.ok(said.startsWith("look\n\n📎 Attached: "));
	assert.equal(readFileSync(path, "utf8"), "a,b\n1,2\n");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.ok(path.startsWith(join(home, "inbox", String(process.pid))));

	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "x", files: [{ name: "../up.txt", data: "" }], nonce, device_id: 7, signature: "AA==" });
	assert.equal(res.error, "bad file name");
	// 25 MB a file; 40 MB a message, together (both checked before the signature).
	const b64 = (mb) => "A".repeat(Math.ceil((mb * 1024 * 1024) / 3) * 4);
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "x", files: [{ name: "big.mp4", data: b64(25.01) }], nonce, device_id: 7, signature: "AA==" });
	assert.equal(res.error, "a file is too big (25 MB) or not base64");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "x", files: [{ name: "a.mp4", data: b64(24) }, { name: "b.mp4", data: b64(16.01) }], nonce, device_id: 7, signature: "AA==" });
	assert.equal(res.error, "attachments are over 40 MB together");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "x", files: [{ name: "a.mp4", data: b64(24) }, { name: "b.mp4", data: b64(15.9) }], nonce, device_id: 7, signature: "AA==" });
	assert.equal(res.error, "signature does not verify", "40 MB together is taken (then checked)");
	assert.equal(m.sent.length, 1);
});

test("a video's frames go to the agent as images, with a note of when; none without ffmpeg", async () => {
	const { readdirSync: ls, statSync } = await import("node:fs");
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const hex = (b) => createHash("sha256").update(b).digest("hex");
	const sign = (nonce, text, files) => {
		const digest = hex([hex(Buffer.from(text, "utf8")), ...files.map((f) => `file ${hex(Buffer.from(f.name, "utf8"))} ${hex(Buffer.from(f.data, "base64"))}`)].join("\n"));
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_attach", digest].join("\n");
		return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	};
	// Fake ffprobe / ffmpeg on PATH (never the real ones): a 42.5 s clip; each frame a tiny "JPEG"
	// with its -ss in it; argv logged one per line, to show there's no shell in between.
	const bin = join(home, "fakebin");
	const log = join(home, "ffmpeg.log");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "ffprobe"), "#!/bin/sh\necho 42.5\n", { mode: 0o755 });
	writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\nfor a; do printf '%s\\n' "$a" >> '${log}'; out=$a; done\nsleep 0.05\nprintf '\\377\\330\\377frame %s' "$9" > "$out"\n`, { mode: 0o755 });
	const path0 = process.env.PATH;
	const dirs0 = process.env.BOTSUN_OWNER_FFMPEG_DIRS;
	cleanups.push(() => { process.env.PATH = path0; if (dirs0 === undefined) delete process.env.BOTSUN_OWNER_FFMPEG_DIRS; else process.env.BOTSUN_OWNER_FFMPEG_DIRS = dirs0; });
	process.env.PATH = bin;
	process.env.BOTSUN_OWNER_FFMPEG_DIRS = "";
	const m = await owner();
	const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(32)]);
	const video = { name: "IMG_1234.mp4", data: mp4.toString("base64") };

	let { nonce } = await ask({ type: "nonce" });
	let res = await ask({ type: "say", text: "watch", files: [video], nonce, device_id: 7, signature: sign(nonce, "watch", [video]) });
	assert.deepEqual(res, { ok: true, delivered: "prompt" });
	await until(() => m.sent.length === 1, 10_000); // 8 fake ffmpeg runs a video, maybe two
	const [first, ...frames] = m.sent[0].content;
	assert.equal(frames.length, 8);
	assert.ok(frames.every((f) => f.type === "image" && f.mimeType === "image/jpeg"));
	assert.equal(Buffer.from(frames[1].data, "base64").subarray(3).toString(), "frame 5.31");
	const saved = first.text.match(/📎 Attached: (\S+) \(44 B\)/)[1];
	assert.ok(first.text.startsWith("watch\n\n📎 Attached: "));
	assert.ok(first.text.includes(`🎞️ Video ${saved} (0:42): 8 frames at 0:00, 0:05, 0:10, 0:15, 0:21, 0:26, 0:31, 0:37`));
	const argv = (await import("node:fs")).readFileSync(log, "utf8").split("\n");
	assert.deepEqual(argv.slice(0, 16), ["-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-ss", "0", "-i", saved, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v"]);
	assert.equal(ls(tmpdir()).filter((d) => d.startsWith("botsun-frames-")).length, 0, "the frames' temp dir is removed");
	assert.equal(statSync(saved).mode & 0o777, 0o600);

	// A .mp4 that isn't one (no ftyp box) isn't handed to ffmpeg; it's just a file.
	const fake = { name: "x.mp4", data: Buffer.from("#!/bin/sh\nrm -rf /\n").toString("base64") };
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "", files: [fake], nonce, device_id: 7, signature: sign(nonce, "", [fake]) });
	assert.equal(res.ok, true);
	assert.match(m.sent[1].content, /^📎 Attached: \S+-x\.mp4 \(19 B\)$/);

	// No ffmpeg: the file note says so, and no frames.
	process.env.PATH = join(home, "nothing-here");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "", files: [video], nonce, device_id: 7, signature: sign(nonce, "", [video]) });
	assert.equal(res.ok, true);
	await until(() => m.sent.length === 3, 10_000); // 8 fake ffmpeg runs a video, maybe two
	assert.match(m.sent[2].content, /^📎 Attached: \S+-IMG_1234\.mp4 \(44 B\) \(no frames: ffmpeg unavailable\)$/);

	// Replies sent while frames are pending wait behind them, in order.
	process.env.PATH = bin;
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "v", files: [video], nonce, device_id: 7, signature: sign(nonce, "v", [video]) });
	assert.equal(res.ok, true, "the same file again, at once: its own name (no collision)");
	({ nonce } = await ask({ type: "nonce" }));
	await ask({ type: "say", text: "after", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "after") });
	await until(() => m.sent.length === 5, 10_000);
	assert.ok(Array.isArray(m.sent[3].content));
	assert.equal(m.sent[4].content, "after");
});

test("the model and thinking level go in hello and follow /model", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ ctx: { model: { provider: "github-copilot", id: "claude-opus-5.5", name: "Claude Opus 5.5" }, thinkingLevel: "medium" } });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	assert.deepEqual(srv.lines[0].model, { name: "Claude Opus 5.5", provider: "github-copilot", id: "claude-opus-5.5", thinking: "medium" });
	await m.fire("model_select", { model: { provider: "anthropic", id: "claude-haiku-5.5", name: "Claude Haiku 5.5" } });
	await until(() => srv.types().includes("model"));
	assert.equal(srv.lines.find((l) => l.type === "model").model.name, "Claude Haiku 5.5");
});

test("an open ask question goes to Botsun and takes a signed answer from the phone", async () => {
	const { offerPrompt, canonicalAnswer } = await import("../lib/remote-prompts.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	const offered = offerPrompt([{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }]);
	await until(() => srv.types().includes("ask"));
	const line = srv.lines.find((l) => l.type === "ask");
	assert.equal(line.ask.id, offered.id);
	assert.equal(line.ask.questions[0].options[1].label, "Mushrooms");

	const sign = (nonce, answers, id = offered.id) => {
		const digest = createHash("sha256").update(canonicalAnswer(id, answers)).digest("hex");
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "answer", digest].join("\n");
		return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	};
	let { nonce } = await ask({ type: "nonce" });
	let res = await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [0] }], nonce, device_id: 7, signature: sign(nonce, [{ picks: [1] }]) });
	assert.equal(res.error, "signature does not verify", "a different pick than signed");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [1] }], nonce, device_id: 7, signature: sign(nonce, [{ picks: [1] }]) });
	assert.deepEqual(res, { ok: true });
	assert.deepEqual(await offered.answered, [{ picks: [1] }]);
	await until(() => srv.types().includes("ask_end"));
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [1] }], nonce, device_id: 7, signature: sign(nonce, [{ picks: [1] }]) });
	assert.equal(res.error, "that question was already answered");
	offered.dispose();
});

test("slashCommand and findModel", async () => {
	const { slashCommand, findModel } = await import("../extensions/opt-in/botsun-owner/index.ts");
	assert.deepEqual(slashCommand("/compact keep the plan"), { name: "compact", args: "keep the plan" });
	assert.deepEqual(slashCommand(" /review "), { name: "review", args: "" });
	assert.equal(slashCommand("/Users/eric/notes.md"), null, "a path is not a command");
	assert.equal(slashCommand("hello /compact"), null);
	const models = [
		{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
		{ provider: "github-copilot", id: "claude-opus-5", name: "Claude Opus 5" },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
	];
	assert.equal(findModel(models, "haiku").id, "claude-haiku-4-5");
	assert.equal(findModel(models, "github-copilot/claude-opus-5").provider, "github-copilot");
	assert.match(findModel(models, "opus"), /matches 2 models/);
	assert.match(findModel(models, "gpt"), /no model matches/);
});

test("slash commands from the phone run instead of reaching the model", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const ran = [];
	// pi's own idle flag: the phone's compact looks at it before holding a /compact for the settle.
	let idle = true;
	const m = await mount({ ctx: {
		compact: (o) => ran.push(["compact", o.customInstructions]),
		isIdle: () => idle,
		modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] },
		ui: { notify: () => {} },
	} });
	m.pi.setModel = async (model) => { ran.push(["model", model.id]); return true; };
	m.pi.setThinkingLevel = (level) => ran.push(["thinking", level]);
	m.pi.setSessionName = (name) => ran.push(["name", name]);
	m.pi.getCommands = () => [{ name: "review", source: "extension" }];
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	};
	assert.deepEqual(await say("/compact keep the plan"), { ok: true, delivered: "command" });
	assert.deepEqual(await say("/model haiku"), { ok: true, delivered: "command" });
	assert.deepEqual(await say("/thinking high"), { ok: true, delivered: "command" });
	assert.deepEqual(await say("/name billing fix"), { ok: true, delivered: "command" });
	await until(() => ran.length === 4);
	assert.deepEqual(ran, [["compact", "keep the plan"], ["model", "claude-haiku-4-5"], ["thinking", "high"], ["name", "billing fix"]]);
	assert.equal(m.sent.length, 0, "none of them reached the model");

	assert.equal((await say("/model")).error, "say which model, e.g. /model opus (the picker needs the keyboard)");
	assert.equal((await say("/reload")).error, "/reload only works at the keyboard");
	assert.deepEqual(await say("/review src/a.ts"), { ok: true, delivered: "command" });
	assert.deepEqual(m.sent.at(-1), { content: "/review src/a.ts", options: { expandPromptTemplates: true } });
	assert.deepEqual(await say("/Users/eric/a.md is the file"), { ok: true, delivered: "prompt" }, "a path goes in as text");
	assert.deepEqual(await say("/whatever"), { ok: true, delivered: "prompt" }, "unknown commands go in as typed");

	await m.fire("agent_start", {});
	idle = false; // a turn is running, so pi says so too
	// Busy: as typed mid-turn. pi runs an extension command's handler at once, and a template or skill
	// is queued as a steer (deliverAs), so none of them is refused any more.
	assert.deepEqual(await say("/compact"), { ok: true, delivered: "held" }, "waits for the settle; nothing lands in the thread");
	assert.deepEqual(await say("/review"), { ok: true, delivered: "command" }, "an extension command runs at once, as typed mid-turn");
	assert.deepEqual(m.sent.at(-1), { content: "/review", options: { expandPromptTemplates: true, deliverAs: "steer" } });
	// And /model, /thinking and /name still run now, mid-turn as before.
	assert.deepEqual(await say("/thinking high"), { ok: true, delivered: "command" });
	assert.deepEqual(await say("/model haiku"), { ok: true, delivered: "command" });
	assert.equal((await say("/reload")).error, "/reload only works at the keyboard", "built-ins that need the keyboard stay refused");
});

test("a template or a skill from the phone while pi is busy goes in as a steer too", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	m.pi.getCommands = () => [{ name: "deploy", source: "prompt" }, { name: "skill:lint", source: "skill" }];
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	};
	// Idle: a plain prompt, as before.
	assert.deepEqual(await say("/deploy staging"), { ok: true, delivered: "command" });
	assert.deepEqual(m.sent.at(-1), { content: "/deploy staging", options: { expandPromptTemplates: true } });
	await m.fire("agent_start", {});
	assert.deepEqual(await say("/deploy production"), { ok: true, delivered: "steer" });
	assert.deepEqual(m.sent.at(-1), { content: "/deploy production", options: { expandPromptTemplates: true, deliverAs: "steer" } });
	assert.deepEqual(await say("/skill:lint src"), { ok: true, delivered: "steer" });
	assert.deepEqual(m.sent.at(-1), { content: "/skill:lint src", options: { expandPromptTemplates: true, deliverAs: "steer" } });
});

test("a /compact from the phone while pi is busy waits for the settle, runs once, and the last one wins", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const ran = [];
	let idle = true;
	const m = await mount({ ctx: { compact: (o) => ran.push(o.customInstructions ?? null), isIdle: () => idle, ui: { notify: () => {} } } });
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	};
	await m.fire("agent_start", {});
	idle = false;
	assert.deepEqual(await say("/compact keep the plan"), { ok: true, delivered: "held" }, "held: it hasn't run yet");
	assert.deepEqual(await say("/compact actually the tests"), { ok: true, delivered: "held" }, "replaces the earlier one");
	assert.deepEqual(ran, [], "not mid-turn: pi refuses a compaction then");
	await m.fire("agent_settled", { aborted: false });
	idle = true;
	assert.deepEqual(ran, ["actually the tests"], "run once, at the settle, with the last notes");
	await m.fire("agent_settled", { aborted: false });
	assert.deepEqual(ran, ["actually the tests"], "and only once");
	// Idle again: /compact runs at once, as before.
	assert.deepEqual(await say("/compact"), { ok: true, delivered: "command" });
	assert.deepEqual(ran, ["actually the tests", null]);
});

test("a /compact sent to a busy-looking session that is really idle runs now, not at a settle that won't come", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const ran = [];
	const m = await mount({ ctx: { compact: (o) => ran.push(o.customInstructions ?? null), ui: { notify: () => {} } } });
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	// conn.busy says a turn is running, but pi is idle (a stale flag: the turn's end was missed).
	await m.fire("agent_start", {});
	m.ctx.isIdle = () => true;
	const { nonce } = await ask({ type: "nonce" });
	assert.deepEqual(await ask({ type: "say", text: "/compact", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "/compact") }),
		{ ok: true, delivered: "command" });
	assert.deepEqual(ran, [null], "run at once, never held for a settle that never comes");
});

test("a /compact queued in one conversation is dropped, not run against the next one", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const ran = [];
	let sessionId = "sid-a";
	let idle = false;
	const m = await mount({ ctx: {
		compact: (o) => ran.push(o.customInstructions ?? null),
		isIdle: () => idle,
		ui: { notify: () => {} },
		sessionManager: { getSessionFile: () => `/tmp/sessions/${sessionId}.jsonl`, getSessionId: () => sessionId },
	} });
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	await m.fire("agent_start", {});
	const tell = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, sessionId, text) });
	};
	assert.deepEqual(await tell("/compact keep the plan"), { ok: true, delivered: "held" });
	// /new and /resume carry a session_shutdown and a session_start of their own; the run this /compact
	// waited for settles in the one that took its place.
	await m.fire("session_start", { reason: "new" });
	sessionId = "sid-b";
	idle = true;
	await m.fire("agent_settled", { aborted: false });
	assert.deepEqual(ran, [], "the conversation it was sent in is gone: nothing runs here");
});

test("hello lists the commands the phone can run; a reload sends the list again", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	m.pi.getCommands = () => [
		{ name: "review", description: "Review a diff", source: "extension" },
		{ name: "skill:lint", source: "skill" },
		{ name: "reload", source: "extension" }, // a built-in name: never listed
	];
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const names = srv.lines.find((l) => l.type === "hello").commands.map((c) => c.name);
	assert.deepEqual(names, ["compact", "model", "thinking", "name", "review", "skill:lint"]);
	m.pi.getCommands = () => [{ name: "deploy", source: "prompt" }];
	await m.fire("session_start", { reason: "reload" });
	await until(() => srv.types().includes("commands"));
	await until(() => srv.types().includes("context") && srv.types().includes("stash"));
	assert.deepEqual(srv.lines.find((l) => l.type === "commands").commands.map((c) => c.name).slice(4), ["deploy"]);
});

test("hello carries the nonce reply's features (no nonce minted); a reload sends them again", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	m.pi.getCommands = () => [];
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello") && existsSync(join(ownerDir, `${process.pid}.sock`)));
	const hello = srv.lines.find((l) => l.type === "hello");
	assert.ok(hello.features.includes("close"));
	assert.ok(hello.features.includes("say_id"), "a say may carry the phone's own id");
	assert.ok(!hello.features.includes("stash"));
	assert.deepEqual(hello.features, (await ask({ type: "nonce" })).features, "the same list the nonce reply advertises");
	m.pi.getCommands = () => [{ name: "stash", source: "extension" }];
	await m.fire("session_start", { reason: "reload" });
	await until(() => srv.types().includes("features"));
	assert.ok(srv.lines.find((l) => l.type === "features").features.includes("stash"));
});

test("hello carries the model id and the first page of the models the phone's picker offers", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ ctx: {
		model: { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
		modelRegistry: { getAvailable: () => [
			{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true },
			{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
		] },
		// The session's scoped models (the enabledModels setting or --models): the picker's Scoped tab.
		scopedModels: [{ model: { provider: "anthropic", id: "claude-haiku-4-5" } }],
	} });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const hello = srv.lines.find((l) => l.type === "hello");
	assert.equal(hello.model.id, "claude-opus-5-5");
	assert.deepEqual(hello.models.map((x) => [x.id, x.reasoning, x.scoped]),
		[["claude-haiku-4-5", false, true], ["claude-opus-5-5", true, false]]);
	await sleep(100);
	assert.deepEqual(srv.types(), ["hello"], "nothing more without the host's features line");

	// The host says it takes pages: the whole list follows, scoped ones first whichever way the
	// registry lists them, and the one page says it is the last.
	down(srv, { v: 1, type: "features", features: ["model_pages"] });
	await until(() => srv.types().includes("models"));
	const page = srv.lines.find((l) => l.type === "models");
	assert.deepEqual(page.models.map((x) => [x.id, x.scoped]), [["claude-haiku-4-5", true], ["claude-opus-5-5", false]]);
	assert.equal(page.first, true);
	assert.equal(page.last, true);
	assert.equal(srv.lines.filter((l) => l.type === "models").length, 1);
});

test("a catalogue goes in pages only when the host takes them; the last page says so", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const many = Array.from({ length: 400 }, (_, i) => ({
		provider: "openrouter", id: `model-${i}`, name: `مدل رقم ${i} — 模型 №${i} – modèle numéro ${i}`,
	}));
	const m = await mount({ ctx: {
		modelRegistry: { getAvailable: () => many },
		scopedModels: [{ model: { provider: "openrouter", id: "model-390" } }],
	} });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const hello = srv.lines.find((l) => l.type === "hello");
	assert.ok(Buffer.byteLength(JSON.stringify(hello.models)) <= 24 * 1024, "hello's page fits its own budget");
	assert.equal(hello.models[0].id, "model-390", "the scoped model comes first in hello's page too");
	await sleep(100);
	assert.equal(srv.lines.filter((l) => l.type === "models").length, 0, "no host features, no pages");

	down(srv, { v: 1, type: "features", features: ["model_pages"] });
	await until(() => srv.lines.some((l) => l.type === "models" && l.last === true));
	const pages = srv.lines.filter((l) => l.type === "models");
	assert.ok(pages.length > 1, "400 multi-byte names are more than one page");
	for (const page of pages) {
		assert.ok(Buffer.byteLength(JSON.stringify(page.models)) <= 48 * 1024, "a page is under the byte budget");
	}
	assert.deepEqual(pages.map((p) => p.first), pages.map((_, i) => i === 0), "only the first says first");
	assert.deepEqual(pages.map((p) => p.last), pages.map((_, i) => i === pages.length - 1), "only the last says last");
	assert.equal(pages.flatMap((p) => p.models).length, 400, "none is cut");
	assert.equal(pages.flatMap((p) => p.models)[0].id, "model-390", "the scoped model comes first");
});

test("a host from before the pages gets one page, scoped models first, and never a second", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const many = Array.from({ length: 900 }, (_, i) => ({
		provider: "openrouter", id: `model-${i}`, name: `模型 ${i} – ${'é'.repeat(40)}`,
	}));
	const m = await mount({ ctx: { modelRegistry: { getAvailable: () => many } } });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	// Its features line names other things: it doesn't take pages.
	down(srv, { v: 1, type: "features", features: ["images", "files"] });
	await sleep(100);
	assert.equal(srv.lines.filter((l) => l.type === "models").length, 0, "hello's page is all it gets on connect");

	await m.fire("session_start", { reason: "reload" });
	await until(() => srv.types().includes("models"));
	const pages = srv.lines.filter((l) => l.type === "models");
	assert.equal(pages.length, 1, "one line, so an old host keeps a list and not just its tail");
	assert.ok(Buffer.byteLength(JSON.stringify(pages[0].models)) <= 48 * 1024, "that page is under the byte budget");
	assert.ok(pages[0].models.length < 900, "which is a page, not the catalogue");
	assert.equal(pages[0].first, true);
	assert.equal(pages[0].last, true);
	assert.equal(Buffer.byteLength(JSON.stringify(pages[0].models)) > 40 * 1024, true, "and it is not trimmed past need");
});

test("a hello sends the catalogue once: the host's features line is the only sender for a host that takes pages", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const many = Array.from({ length: 400 }, (_, i) => ({
		provider: "openrouter", id: `model-${i}`, name: `模型 ${i} – ${'é'.repeat(40)}`,
	}));
	const at = (id) => ({ ctx: {
		sessionManager: { getSessionFile: () => `/tmp/sessions/${id}.jsonl`, getSessionId: () => id },
		modelRegistry: { getAvailable: () => many },
	} });
	const models = () => srv.lines.filter((l) => l.type === "models");
	const a = await mount(at("sandbox-pal"));
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	down(srv, { v: 1, type: "features", features: ["model_pages"] });
	await until(() => models().some((l) => l.last === true));
	const pagesPerSend = models().length;
	assert.ok(pagesPerSend > 1, "400 multi-byte names are more than one page");

	// It leaves that conversation and comes back: a hello again, on the same connection.
	await a.fire("session_shutdown", { reason: "resume" });
	const b = await mount(at("sid-other"));
	await b.fire("session_start", { reason: "resume" });
	await until(() => srv.types().includes("session"));
	await b.fire("session_shutdown", { reason: "resume" });
	await sleep(100); // the switch away sent the catalogue for its own conversation (one send)
	const mark = srv.lines.length;
	const before = models().length;
	const c = await mount(at("sandbox-pal"));
	await c.fire("session_start", { reason: "resume" });
	await until(() => srv.types().filter((t) => t === "hello").length >= 2);
	await sleep(100);
	assert.equal(models().length, before, "hello alone sends no page: this host answers it with its features line");

	down(srv, { v: 1, type: "features", features: ["model_pages"] });
	await until(() => srv.lines.slice(mark).some((l) => l.type === "models" && l.last === true));
	await sleep(50);
	const sent = srv.lines.slice(mark).filter((l) => l.type === "models");
	assert.equal(sent.length, pagesPerSend, "one sequence, not two: the features line's send is the hello's catalogue");
	assert.equal(sent.flatMap((p) => p.models).length, 400, "the whole catalogue, once");
});

test("modelPages budgets a page by its bytes, not its count", async () => {
	const { modelPages, PHONE_MODELS_BYTES, HELLO_MODELS_BYTES } = await import("../extensions/opt-in/botsun-owner/index.ts");
	// 80 characters, but 220 bytes: the field caps are characters, so a page of these holds a
	// fraction of the models a page of ASCII names does.
	const name = `${'模'.repeat(60)}${'é'.repeat(20)}`;
	assert.equal(name.length, 80);
	assert.equal(Buffer.byteLength(name), 220);
	const list = Array.from({ length: 900 }, (_, i) => ({ provider: "openrouter", id: `model-${i}`, name, reasoning: true, scoped: false }));
	const pages = modelPages(list);
	assert.ok(pages.length > 1, "900 of them is more than one page");
	for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) <= PHONE_MODELS_BYTES, "a page is under the budget");
	assert.equal(pages.flat().length, 900, "none is cut");
	assert.ok(pages[0].length < 200, "far fewer than 100 per page: it is measured, not counted");
	assert.ok(Buffer.byteLength(JSON.stringify([...pages[0], list[0]])) > PHONE_MODELS_BYTES, "one more model would have overrun the page");
	assert.deepEqual(modelPages([]).map((p) => p.length), [0], "no models is one empty page");
	assert.deepEqual(modelPages(list.slice(0, 3), HELLO_MODELS_BYTES).map((p) => p.length), [3], "hello's smaller budget holds a few");
});

test("the phone pushes, takes and drops the session's message stash, signed", async () => {
	const { stashStack, pushStash } = await import("../lib/stash-store.ts");
	stashStack("sid-a").length = 0;
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	m.pi.getCommands = () => [{ name: "stash", source: "extension" }];
	pushStash("sid-a", "typed at the keyboard");
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	assert.deepEqual(srv.lines.find((l) => l.type === "hello").stash.map((e) => e.text), ["typed at the keyboard"]);

	const sign = (nonce, payload) => {
		const digest = createHash("sha256").update(payload).digest("hex");
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "stash", digest].join("\n");
		return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	};
	const hex = (t) => createHash("sha256").update(t).digest("hex");
	let { nonce, features } = await ask({ type: "nonce" });
	assert.ok(features.includes("stash"));
	let res = await ask({ type: "stash", op: "push", text: "from the phone", nonce, device_id: 7, signature: sign(nonce, `push\n${hex("other")}`) });
	assert.equal(res.error, "signature does not verify");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "stash", op: "push", text: "from the phone", nonce, device_id: 7, signature: sign(nonce, `push\n${hex("from the phone")}`) });
	assert.equal(res.ok, true);
	await until(() => srv.lines.some((l) => l.type === "stash" && l.stash.length === 2));
	const [first, second] = stashStack("sid-a");
	assert.equal(second.text, "from the phone");

	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "stash", op: "take", id: first.id, nonce, device_id: 7, signature: sign(nonce, `take\n${first.id}`) });
	assert.deepEqual(res, { ok: true, text: "typed at the keyboard" });
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "stash", op: "drop", id: second.id, nonce, device_id: 7, signature: sign(nonce, `drop\n${second.id}`) });
	assert.deepEqual(res, { ok: true });
	assert.equal(stashStack("sid-a").length, 0);
	await until(() => srv.lines.at(-1).type === "stash" && srv.lines.at(-1).stash.length === 0);
});

test("context use goes in hello and after each run", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	let tokens = 12_000;
	const m = await mount({ ctx: { getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: (tokens / 200_000) * 100 }) } });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	assert.deepEqual(srv.lines.find((l) => l.type === "hello").context, { tokens: 12_000, window: 200_000, percent: 6 });
	tokens = 50_000;
	await m.fire("agent_start", {});
	await m.fire("agent_settled", {});
	await until(() => srv.types().includes("context"));
	assert.deepEqual(srv.lines.find((l) => l.type === "context").context, { tokens: 50_000, window: 200_000, percent: 25 });
});

test("context use follows /model: the new model's window, at once", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	let window = 200_000;
	const m = await mount({ ctx: { getContextUsage: () => ({ tokens: 50_000, contextWindow: window, percent: (50_000 / window) * 100 }) } });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	window = 1_000_000;
	await m.fire("model_select", { model: { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" } });
	await until(() => srv.types().includes("context"));
	assert.deepEqual(srv.lines.find((l) => l.type === "context").context, { tokens: 50_000, window: 1_000_000, percent: 5 });
});

test("the footer's chips go to the phone, only the ones it shows, at most once a second", async () => {
	const { publishFooter } = await import("../lib/footer-snapshot.ts");
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	publishFooter([{ id: "dir", text: "botsun" }, { id: "model", text: "opus" }, { id: "context", text: "\x1b[32m42k\x1b[0m/1m" }]);
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	assert.deepEqual(srv.lines.find((l) => l.type === "hello").footer.map((c) => c.id), ["dir", "context"]);
	publishFooter([{ id: "dir", text: "botsun" }, { id: "git", text: "main*" }]);
	await until(() => srv.types().includes("footer"), 3000);
	assert.deepEqual(srv.lines.find((l) => l.type === "footer").footer.map((c) => c.id), ["dir", "git"]);
});

test("the provider's usage windows go in hello and on change, whether or not the footer shows the chip", async () => {
	const { publishUsage } = await import("../lib/usage-snapshot.ts");
	const { publishFooter } = await import("../lib/footer-snapshot.ts");
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	publishFooter([{ id: "dir", text: "botsun" }]); // no usage chip painted (hidden on pace)
	const first = { provider: "Claude", windows: [{ label: "5h", percent: 47, resets_at: "2026-05-01T12:00:00.000Z" }, { label: "week", percent: 23 }] };
	publishUsage(first);
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	assert.deepEqual(srv.lines.find((l) => l.type === "hello").usage, first);
	publishUsage({ ...first, windows: [{ label: "5h", percent: 92 }], extra_usage: true });
	await until(() => srv.types().includes("usage"));
	assert.deepEqual(srv.lines.find((l) => l.type === "usage").usage, { provider: "Claude", windows: [{ label: "5h", percent: 92 }], extra_usage: true });
	publishUsage(null);
	await until(() => srv.lines.filter((l) => l.type === "usage").length === 2);
	assert.equal(srv.lines.filter((l) => l.type === "usage")[1].usage, null);
});

test("a chip tap from the phone flips the footer's display, display chips only", async () => {
	const { onFooterTap, publishFooter } = await import("../lib/footer-snapshot.ts");
	const tapped = [];
	// The footer flips the chip and repaints: the reply waits for that and carries the new row.
	const stop = onFooterTap((id) => (tapped.push(id), setTimeout(() => publishFooter([{ id: "context", text: "23%" }]), 20), true));
	await owner();
	assert.deepEqual(await ask({ type: "footer_tap", chip: "context" }), { ok: true, footer: [{ id: "context", segments: [{ text: "23%" }] }] });
	assert.equal((await ask({ type: "footer_tap", chip: "git" })).error, "that chip doesn't flip");
	assert.deepEqual(tapped, ["context"]);
	stop();
});

// The held words go out a tick after session_compact (releaseHeld), once pi takes a prompt again.
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("compaction: held words wait until pi stops counting the compaction as running", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	// pi emits session_compact while isIdle() is still false (its compaction controller is still set),
	// and a prompt then is refused. The words must wait, and then go in as a prompt, not a steer.
	let idle = false;
	m.ctx.isIdle = () => idle;
	await m.fire("session_before_compact", { reason: "manual" });
	const { nonce } = await ask({ type: "nonce" });
	const text = "the share sheet one";
	assert.deepEqual(await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) }), { ok: true, delivered: "held" });
	await m.fire("session_compact", { reason: "manual" });
	await settle(20);
	assert.equal(m.sent.length, 0, "not while pi still counts the compaction");
	idle = true;
	await settle(400);
	assert.deepEqual(m.sent.at(-1), { content: text, options: undefined });
});

test("compaction: the phone hears of it, and a reply meanwhile waits for it to end", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	m.ctx.isIdle = () => true;
	await m.fire("session_before_compact", { reason: "threshold" });
	const { nonce } = await ask({ type: "nonce" });
	const text = "and then the docs";
	assert.deepEqual(await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) }), { ok: true, delivered: "held" });
	assert.equal(m.sent.length, 0, "pi refuses a prompt mid-compaction");
	await m.fire("session_compact", { reason: "threshold" }); await settle();
	assert.deepEqual(m.sent.at(-1), { content: text, options: undefined });
});

test("compaction: a say that arrives before this extension hears of it is held, then goes in once as a prompt", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	// pi set its compaction controller, so it refuses prompts; another extension's session_before_compact
	// is still running, so this one's `compacting` is still null.
	let idle = false;
	m.ctx.isIdle = () => idle;
	const { nonce } = await ask({ type: "nonce" });
	const text = "the share sheet one";
	assert.deepEqual(await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) }), { ok: true, delivered: "held" });
	assert.equal(m.sent.length, 0, "never a prompt pi would refuse");
	await m.fire("session_before_compact", { reason: "manual" });
	await m.fire("session_compact", { reason: "manual" });
	await settle(20);
	assert.equal(m.sent.length, 0, "not while pi still counts the compaction");
	idle = true;
	await settle(400);
	assert.deepEqual(m.sent, [{ content: text, options: undefined }], "once, as a prompt");
});

test("compaction: words held for one pi never announced go in when it turns idle (a poll, no events)", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	let idle = false;
	m.ctx.isIdle = () => idle;
	const { nonce } = await ask({ type: "nonce" });
	const text = "after the summary";
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) })).delivered, "held");
	assert.equal(m.sent.length, 0);
	// The compaction finished inside another extension's handler: no session_before_compact, no
	// session_compact, nothing to start a release but the poll its hold started.
	idle = true;
	await settle(400);
	assert.deepEqual(m.sent, [{ content: text, options: undefined }]);
});

test("compaction: a send pi's own refusal would swallow is never made, and the words wait for it", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	let takes = false;
	m.ctx.isIdle = () => takes;
	// pi's refusal is asynchronous: the send returns, then the error goes to the runner's error
	// listeners (send_user_message), which no extension can hear. A send pi refuses here is a send lost.
	const refused = [];
	m.pi.sendUserMessage = async (content, options) => {
		if (!takes) { refused.push(content); return; }
		m.sent.push({ content, options });
	};
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const { nonce } = await ask({ type: "nonce" });
	const text = "sent while it compacts";
	assert.deepEqual(await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) }), { ok: true, delivered: "held" });
	assert.deepEqual(refused, [], "never sent blind: the check before it is the guard");
	// The compaction ends and its handlers run: the release sends what was held, once pi takes it.
	await m.fire("session_before_compact", { reason: "manual" });
	await m.fire("session_compact", { reason: "manual" });
	await settle(20);
	assert.equal(m.sent.length, 0, "pi still counts the compaction as running");
	takes = true;
	await settle(400);
	assert.deepEqual(m.sent, [{ content: text, options: undefined }], "in once, as a prompt");
	assert.deepEqual(refused, [], "and never into a refusal");
});

test("compaction: a running turn's steer and a prompt on its way in are not held, the latter as a follow-up", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	m.ctx.isIdle = () => false;
	await m.fire("agent_start"); // a turn runs: not idle, but Botsun's busy explains it
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	};
	assert.equal((await say("steer this")).delivered, "steer");
	assert.deepEqual(m.sent.at(-1).options, { deliverAs: "steer" });
	await m.fire("agent_settled");
	// A prompt sent, its turn not started: pi's input handler marks the moment (inputAt). pi reads as
	// idle then, but it is already streaming (its turn's start, or a compaction's own check): a bare
	// prompt would be refused, asynchronously, past any try/catch. A follow-up waits for the turn.
	await m.fire("input", { type: "input", text: "typed at the Mac", source: "interactive" });
	assert.equal((await say("right after your prompt")).delivered, "prompt");
	assert.deepEqual(m.sent.at(-1), { content: "right after your prompt", options: { deliverAs: "followUp" } });
});

test("compaction: a session ending with words held stops the poll and hands them back", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	let stale = false;
	// A compaction pi never announces: the release poll waits for it, ten minutes at most.
	m.ctx.isIdle = () => {
		if (stale) throw new Error("ctx is stale");
		return false;
	};
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const { nonce } = await ask({ type: "nonce" });
	const text = "the share sheet one";
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) })).delivered, "held");
	// A quit aborts the compaction and takes the session down: a tick after it reaches pi's stale ctx,
	// and a throw inside a timer is uncaught, which takes pi down (interactive-mode exits on those).
	stale = true;
	await m.fire("session_shutdown", { reason: "quit" });
	await until(() => srv.lines.some((l) => l.type === "returned"));
	assert.deepEqual(srv.lines.find((l) => l.type === "returned").steers.map((s) => [s.text, s.why]), [[text, "stopped"]]);
	await settle(600); // no tick of its own comes: the poll was stopped, not left to throw
	assert.equal(m.sent.length, 0, "never into a session that left");
});

test("compaction: words held for ten minutes go back to the phone, not into the void", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	m.ctx.isIdle = () => false; // a compaction that never ends: pi never takes a prompt again
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const realNow = Date.now;
	try {
		const { nonce } = await ask({ type: "nonce" });
		const text = "are you stuck?";
		assert.equal((await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) })).delivered, "held");
		Date.now = () => realNow() + 11 * 60_000; // past the hold's cap (HELD_MAX_MS)
		await settle(400); // the poll its hold started sees the cap
		assert.deepEqual(srv.lines.find((l) => l.type === "returned").steers.map((s) => [s.text, s.why]), [[text, "withdrawn"]]);
		assert.equal(m.sent.length, 0, "never into a compaction");
	} finally {
		Date.now = realNow;
	}
});

test("bypass: the phone hears the guardian's state, and a signed /bypass flips it", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const asked = [];
	m.pi.events.on("approval-guardian:set-temporary-bypass", (request) => {
		asked.push(request.active);
		request.handled = true;
	});
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	};
	assert.deepEqual(await say("/bypass on"), { ok: true, delivered: "command" });
	assert.equal((await say("/bypass maybe")).error, "say /bypass on or /bypass off");
	assert.deepEqual(asked, [true]);
	assert.equal(m.sent.length, 0, "nothing went to the model");
});

// Session voice, phase 1: a call's words are verified on arrival, held, and released by the helper.
async function heldCall() {
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	let idle = true;
	let aborts = 0;
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => aborts++;
	const wav = createHash("sha256").update("RIFF…audio").digest("hex");
	// proposal: the hash of the answer read back to him, signed with his reply; signedFor: what the
	// phone actually signed (a forged request claims one hash, signed another).
	const hold = async (text, proposal, signedFor = proposal) => {
		const { nonce } = await ask({ type: "nonce" });
		const lines = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav, ...(signedFor ? [signedFor] : [])];
		const signature = cryptoSign("sha256", Buffer.from(lines.join("\n")), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
		return ask({ type: "say_audio", text, nonce, device_id: 7, wav_sha256: wav, signature, hold: true,
			...(proposal ? { proposal_sha256: proposal } : {}) });
	};
	// A turn is running only when pi says so (agent_start): not idle and not busy is a compaction's
	// shape, which the extension holds for (pendingCompact).
	const busy = async (b) => {
		idle = !b;
		await m.fire(b ? "agent_start" : "agent_settled");
	};
	// Said, not held: released at once (a compaction can still hold it, as it holds the phone's says).
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		const lines = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav];
		const signature = cryptoSign("sha256", Buffer.from(lines.join("\n")), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
		return ask({ type: "say_audio", text, nonce, device_id: 7, wav_sha256: wav, signature });
	};
	return { m, hold, say, busy, setIdle: (v) => { idle = v; }, aborts: () => aborts };
}

test("say_audio: a compaction holds the call's words too, and the phone hears held", async () => {
	const { m, say, setIdle } = await heldCall();
	// A compaction pi hasn't announced: not idle, no turn running, so a prompt would be refused.
	setIdle(false);
	assert.deepEqual(await say("and the linter too"), { ok: true, delivered: "held" });
	assert.deepEqual(m.sent, [], "never a prompt into a compaction");
	setIdle(true);
	await settle(400); // the hold's poll releases it once pi takes prompts
	assert.deepEqual(m.sent, [{ content: "and the linter too", options: undefined }]);
});

test("held call words go in only when released: queued after the turn, or steered in", async () => {
	const { m, hold, busy } = await heldCall();
	assert.ok((await ask({ type: "nonce" })).features.includes("hold"));
	const a = await hold("run the tests");
	const b = await hold("and then lint");
	assert.match(a.held, /^[0-9a-f]{12}$/);
	assert.equal(m.sent.length, 0, "held, not put in");
	await busy(true);
	assert.deepEqual(await ask({ type: "release", ids: [a.held, b.held], mode: "queue" }), { ok: true, delivered: "queue" });
	assert.deepEqual(m.sent.at(-1), { content: "run the tests\n\nand then lint", options: { deliverAs: "followUp" } });
	assert.equal((await ask({ type: "release", ids: [a.held], mode: "queue" })).error, `not waiting: ${a.held}`, "each goes in once");
	const c = await hold("use the staging config");
	assert.deepEqual(await ask({ type: "release", ids: [c.held], mode: "steer" }), { ok: true, delivered: "steer" });
	assert.deepEqual(m.sent.at(-1).options, { deliverAs: "steer" });
	assert.equal((await ask({ type: "release", ids: ["nope"], mode: "sideways" })).error, "mode must be queue, steer or interrupt");
});

test("interrupt stops the run only when Eric's own words say stop", async () => {
	const { m, hold, busy, aborts } = await heldCall();
	await busy(true);
	const look = await hold("look at the failing spec instead");
	assert.deepEqual(await ask({ type: "release", ids: [look.held], mode: "interrupt" }), { ok: true, delivered: "steer" });
	assert.equal(aborts(), 0, "the helper's judgment alone never aborts");
	const button = await hold("add a cancel button");
	assert.deepEqual(await ask({ type: "release", ids: [button.held], mode: "interrupt" }), { ok: true, delivered: "steer" });
	assert.equal(aborts(), 0, "mentioning cancel isn't asking to stop");
	const stop = await hold("stop, that's the wrong branch");
	assert.deepEqual(await ask({ type: "release", ids: [stop.held], mode: "interrupt" }), { ok: true, delivered: "stopped" });
	assert.equal(aborts(), 1);
	const before = m.sent.length;
	await busy(false);
	assert.equal(m.sent.length, before + 1, "sent once the aborted run settled");
	assert.deepEqual(m.sent.at(-1), { content: "stop, that's the wrong branch", options: undefined });
});

test("the phone's Stop ends the running turn as Esc does, signed", async () => {
	const decide = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	let idle = false;
	let aborts = 0;
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => aborts++;
	const stop = async (key = decide) => {
		const { nonce, features } = await ask({ type: "nonce" });
		assert.ok(features.includes("stop"));
		const digest = createHash("sha256").update("stop", "utf8").digest("hex");
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "stop", digest].join("\n");
		const signature = cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
		return ask({ type: "stop", nonce, device_id: 7, signature });
	};
	assert.deepEqual(await stop(), { ok: true, stopped: true });
	assert.equal(aborts, 1);
	assert.equal((await stop(phoneKey())).error, "signature does not verify");
	assert.equal(aborts, 1, "only Eric's phone");
	idle = true;
	assert.deepEqual(await stop(), { ok: true, stopped: false }, "nothing running");
	assert.equal(aborts, 1);
	assert.equal(m.sent.length, 0);
});

test("takeQueued: the phone's steers come back out of the editor; the TUI's own text stays", async () => {
	const { takeQueued } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	// pi's TUI on an abort: the queue's texts joined by blank lines, then what was typed.
	assert.deepEqual(takeQueued("phone one\n\ntui typed queue\n\nphone two\n\ndraft", ["phone one", "phone two"]),
		{ editor: "tui typed queue\n\ndraft", taken: ["phone one", "phone two"] });
	assert.deepEqual(takeQueued("phone one\n\nphone two", ["phone one", "phone two"]), { editor: "", taken: ["phone one", "phone two"] });
	assert.deepEqual(takeQueued("draft", ["not there", ""]), { editor: "draft", taken: [] }, "only what's there");
	assert.deepEqual(takeQueued("a\n\na", ["a"]), { editor: "a", taken: ["a"] }, "each once");
});

test("takeQueued: only whole blocks, in queue order from the front; never part of Eric's own text", async () => {
	const { takeQueued } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	// A phone text that's a word in what Eric typed: not a block, stays.
	assert.deepEqual(takeQueued("looks ok to me", ["ok"]), { editor: "looks ok to me", taken: [] }, "substring of a word");
	assert.deepEqual(takeQueued("okay", ["ok"]), { editor: "okay", taken: [] });
	// A phone text inside Eric's draft (a line of it, not a block of its own): stays.
	assert.deepEqual(takeQueued("my draft\nyes\nmore", ["yes"]), { editor: "my draft\nyes\nmore", taken: [] }, "inside his draft");
	assert.deepEqual(takeQueued("tui queue\n\nsay yes then", ["yes"]), { editor: "tui queue\n\nsay yes then", taken: [] });
	// Delivered but not matched (message_start's text didn't match): still in queuedSteers, not in the
	// editor. Nothing of Eric's that merely contains it is cut.
	assert.deepEqual(takeQueued("tui queued\n\nlooks ok to me", ["ok", "phone two"]), { editor: "tui queued\n\nlooks ok to me", taken: [] }, "delivered, not matched");
	assert.deepEqual(takeQueued("phone two\n\nlooks ok to me", ["ok", "phone two"]), { editor: "looks ok to me", taken: ["phone two"] });
	// Queue order from the front: the first match of each, after the one before it.
	assert.deepEqual(takeQueued("x\n\ny\n\nx", ["x", "y"]), { editor: "x", taken: ["x", "y"] }, "the queued x, not the draft's");
	assert.deepEqual(takeQueued("y\n\nx", ["x", "y"]), { editor: "y", taken: ["x"] }, "y before x: not in queue order, stays");
	// A phone text with blank lines of its own is one block.
	assert.deepEqual(takeQueued("one\n\ntwo\n\ndraft", ["one\n\ntwo"]), { editor: "draft", taken: ["one\n\ntwo"] });
	assert.deepEqual(takeQueued("tui\n\nphone", ["phone"]), { editor: "tui", taken: ["phone"] }, "last block, with its blank line");
});

test("the phone's Stop returns the phone's queued steers (out of the TUI editor) as dropped; ids go on steer marks", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	await m.fire("agent_start");
	const say = async (text, clientId) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(key, nonce, "session", "say", botsunSayPayload(text, clientId));
		return ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature, ...(clientId ? { client_id: clientId } : {}) });
	};
	assert.equal((await say("based on your last question", SAID)).delivered, "steer");
	assert.equal((await say("I would like that")).delivered, "steer");
	// pi's input event for each (the stub's sendUserMessage doesn't emit it), and one typed in the TUI.
	await m.fire("input", { type: "input", text: "based on your last question", source: "extension", streamingBehavior: "steer" });
	await m.fire("input", { type: "input", text: "I would like that", source: "extension", streamingBehavior: "steer" });
	await m.fire("input", { type: "input", text: "typed at the Mac", source: "interactive", streamingBehavior: "steer" });
	assert.deepEqual(m.entries.map((e) => e.data.client_id), [SAID, undefined, undefined], "the phone's id on its own steer's mark only");

	// pi's TUI abort: every queued message into the editor, ahead of what was typed.
	let editor = "half a thought";
	let queued = ["based on your last question", "I would like that", "typed at the Mac"];
	let aborts = 0;
	m.ctx.isIdle = () => false;
	m.ctx.hasPendingMessages = () => queued.length > 0;
	m.ctx.abort = () => {
		aborts++;
		editor = [...queued, editor].filter((t) => t.trim()).join("\n\n");
		queued = [];
	};
	m.ctx.ui = { getEditorText: () => editor, setEditorText: (t) => (editor = t) };
	const stop = async () => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "stop", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stop", "stop") });
	};
	assert.deepEqual(await stop(), { ok: true, stopped: true, dropped: ["based on your last question", "I would like that"] });
	assert.equal(aborts, 1);
	assert.equal(editor, "typed at the Mac\n\nhalf a thought", "the Mac's own queued and typed text stays in its editor");

	// Delivered steers aren't the phone's to take back.
	await say("one more", SAID.replace("0b9e", "1b9e"));
	await m.fire("input", { type: "input", text: "one more", source: "extension", streamingBehavior: "steer" });
	await m.fire("message_start", { message: { role: "user", content: [{ type: "text", text: "one more" }] } });
	queued = ["one more"]; // (as if pi still had a copy queued: only the phone's undelivered ones are taken)
	editor = "";
	assert.deepEqual(await stop(), { ok: true, stopped: true });
	assert.equal(editor, "one more");
});

test("a phone say's id and Stop take only an extension's input: the same words typed at the keyboard stay his", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	await m.fire("agent_start");
	const { nonce } = await ask({ type: "nonce" });
	const signature = signV2(key, nonce, "session", "say", botsunSayPayload("yes", SAID));
	assert.equal((await ask({ type: "say", text: "yes", nonce, device_id: 7, sig_v: 2, signature, client_id: SAID })).delivered, "steer");
	// Eric types the same words before pi's input event for the phone's: his keyboard steer.
	await m.fire("input", { type: "input", text: "yes", source: "interactive", streamingBehavior: "steer" });
	assert.equal(m.entries.at(-1).data.client_id, undefined, "not the phone's id on his steer");
	let editor = "";
	let queued = ["yes"];
	m.ctx.isIdle = () => false;
	m.ctx.hasPendingMessages = () => queued.length > 0;
	m.ctx.abort = () => { editor = [...queued, editor].filter((t) => t.trim()).join("\n\n"); queued = []; };
	m.ctx.ui = { getEditorText: () => editor, setEditorText: (t) => (editor = t) };
	const { nonce: n2 } = await ask({ type: "nonce" });
	assert.deepEqual(await ask({ type: "stop", nonce: n2, device_id: 7, sig_v: 2, signature: signV2(key, n2, "session", "stop", "stop") }),
		{ ok: true, stopped: true }, "his typed steer isn't sent to the phone");
	assert.equal(editor, "yes", "it stays in his editor");
	// The phone's own input event still finds its say.
	await m.fire("input", { type: "input", text: "yes", source: "extension", streamingBehavior: "steer" });
	assert.equal(m.entries.at(-1).data.client_id, SAID);
});

test("close: the phone's steers a non-idle Close takes out of the editor come back in its reply", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	await m.fire("agent_start");
	const { nonce } = await ask({ type: "nonce" });
	const signature = signV2(key, nonce, "session", "say", botsunSayPayload("also check the logs", SAID));
	assert.equal((await ask({ type: "say", text: "also check the logs", nonce, device_id: 7, sig_v: 2, signature, client_id: SAID })).delivered, "steer");
	await m.fire("input", { type: "input", text: "also check the logs", source: "extension", streamingBehavior: "steer" });
	let editor = "draft";
	let queued = ["also check the logs"];
	const log = [];
	m.ctx.isIdle = () => false;
	m.ctx.hasPendingMessages = () => queued.length > 0;
	m.ctx.abort = () => { log.push("abort"); editor = [...queued, editor].filter((t) => t.trim()).join("\n\n"); queued = []; };
	m.ctx.shutdown = () => log.push("shutdown");
	m.ctx.ui = { getEditorText: () => editor, setEditorText: (t) => (editor = t) };
	const { nonce: n2 } = await ask({ type: "nonce" });
	assert.deepEqual(await ask({ type: "close", nonce: n2, device_id: 7, sig_v: 2, signature: signV2(key, n2, "session", "close", "close") }),
		{ ok: true, dropped: ["also check the logs"] });
	assert.equal(editor, "draft");
	await until(() => log.includes("shutdown"));
	assert.deepEqual(log, ["abort", "shutdown"]);
});

test("interrupt: the phone's steers the abort dropped go again first, then the words", async () => {
	const { m, hold, busy } = await heldCall();
	await busy(true);
	let editor = "";
	let queued = [];
	m.ctx.hasPendingMessages = () => queued.length > 0;
	m.ctx.abort = () => { editor = [...queued, editor].filter(Boolean).join("\n\n"); queued = []; };
	m.ctx.ui = { getEditorText: () => editor, setEditorText: (t) => (editor = t) };
	const steer = await hold("use the staging config");
	assert.deepEqual(await ask({ type: "release", ids: [steer.held], mode: "steer" }), { ok: true, delivered: "steer" });
	await m.fire("input", { type: "input", text: "use the staging config", source: "extension", streamingBehavior: "steer" });
	queued = ["use the staging config"];
	const stop = await hold("stop, that's the wrong branch");
	assert.deepEqual(await ask({ type: "release", ids: [stop.held], mode: "interrupt" }), { ok: true, delivered: "stopped" });
	assert.equal(editor, "", "not left in the Mac's editor");
	await busy(false);
	assert.deepEqual(m.sent.at(-1), { content: "use the staging config\n\nstop, that's the wrong branch", options: undefined });
});

test("close: Eric's phone aborts a running turn, gets {ok} at once, then pi shuts down", async () => {
	const decide = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	let idle = false;
	const log = [];
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => log.push("abort");
	m.ctx.shutdown = () => log.push("shutdown");
	const close = async (key = decide) => {
		const { nonce, features } = await ask({ type: "nonce" });
		assert.ok(features.includes("close"));
		return ask({ type: "close", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "close", "close") });
	};
	assert.equal((await close(phoneKey())).error, "signature does not verify");
	// v1 (a signature that verifies, from a device that hasn't ratcheted): refused, nonce spent.
	const { nonce: n1 } = await ask({ type: "nonce" });
	const digest = createHash("sha256").update("close", "utf8").digest("hex");
	const msg = ["botsun-decide-v1", "7", n1, "session", "sid-a", "close", digest].join("\n");
	const v1 = { type: "close", nonce: n1, device_id: 7, signature: cryptoSign("sha256", Buffer.from(msg), { key: decide.privateKey, dsaEncoding: "der" }).toString("base64") };
	assert.match((await ask(v1)).error ?? "", /^close needs a v2 signature/);
	assert.equal((await ask({ ...v1, sig_v: 1 })).error, "nonce is expired or used", "spent");
	assert.equal((await ask({ type: "close" })).error, "bad request", "unsigned");
	assert.deepEqual(log, [], "only Eric's phone, signed");
	const reply = close();
	assert.deepEqual(await reply, { ok: true });
	await until(() => log.includes("shutdown"));
	assert.deepEqual(log, ["abort", "shutdown"], "aborted first, shut down after the reply");
	idle = true;
	log.length = 0;
	assert.deepEqual(await close(), { ok: true });
	await until(() => log.includes("shutdown"));
	assert.deepEqual(log, ["shutdown"], "nothing running: no abort");
	assert.equal(m.sent.length, 0);
});

// ---- The phone's Reload and Restart ----------------------------------------

/** A v1 signature over a session decision whose digest is sha256(decision). */
function signV1(key, nonce, decision) {
	const digest = createHash("sha256").update(decision, "utf8").digest("hex");
	const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", decision, digest].join("\n");
	return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
}

/** pi-restart-all's view of this pi: titled "pi", in tmux pane %12 (a tmux server socket that is
 * there), with the restart extension's record (or not). */
async function restartEnv() {
	const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
	const title = process.title;
	const state = mkdtempSync(join(home, "state-"));
	const live = join(state, "pi-restart", "live");
	const socket = join(state, "tmux.sock");
	const tmux = createServer(() => {});
	await new Promise((r) => tmux.listen(socket, r));
	process.env.XDG_STATE_HOME = state;
	process.title = "pi";
	cleanups.push(() => {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
		process.title = title;
		return new Promise((r) => tmux.close(() => r()));
	});
	return {
		inTmux: () => { process.env.TMUX = `${socket},1234,0`; process.env.TMUX_PANE = "%12"; },
		record: (over = {}) => {
			mkdirSync(live, { recursive: true });
			writeFileSync(join(live, `${process.pid}.json`),
				JSON.stringify({ pid: process.pid, sessionFile: "/tmp/sessions/a.jsonl", cwd: "/tmp/work/proj", pane: "%12", socket, bypass: false, idle: true, at: "", ...over }));
		},
		noRecord: () => rmSync(join(live, `${process.pid}.json`), { force: true }),
	};
}

test("reload: v2 only, its own decision; refused while a turn runs (nonce spent); then pi's reload through its command", async () => {
	const decide = phoneKey();
	writeKeys({ 7: decide.raw.toString("base64") });
	const m = await owner();
	const { RELOAD_BUSY, RELOAD_COMMAND } = m.mod;
	let idle = true;
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => assert.fail("a reload never aborts");
	m.ctx.shutdown = () => assert.fail("a reload never shuts pi down");
	const reload = async ({ key = decide, decision = "reload", payload = decision, type = "reload", nonce } = {}) => {
		if (!nonce) {
			let features;
			({ nonce, features } = await ask({ type: "nonce" }));
			assert.ok(features.includes("reload"));
		}
		return ask({ type, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", decision, payload) });
	};
	assert.equal((await reload({ key: phoneKey() })).error, "signature does not verify");
	assert.equal((await reload({ decision: "close", payload: "close" })).error, "signature does not verify", "a close signature isn't a reload one");
	assert.equal((await reload({ decision: "restart", payload: "restart" })).error, "signature does not verify", "nor a restart one");
	assert.equal((await reload({ payload: "close" })).error, "signature does not verify", "over its own payload");
	assert.equal((await reload({ type: "close" })).error, "signature does not verify", "and a reload one isn't a close");
	// v1 (a signature that verifies, from a device that hasn't ratcheted): refused, nonce spent.
	const { nonce: n1 } = await ask({ type: "nonce" });
	const v1 = { type: "reload", nonce: n1, device_id: 7, signature: signV1(decide, n1, "reload") };
	assert.equal((await ask(v1)).error, "reload needs a v2 signature: v1 is refused (update Botsun and the app)");
	assert.equal((await ask({ ...v1, sig_v: 1 })).error, "nonce is expired or used", "spent");
	assert.equal((await ask({ type: "reload" })).error, "bad request", "unsigned");
	assert.equal(m.sent.length, 0);
	// A running turn: refused after the check, so the nonce is spent and it can't land once the turn ends.
	idle = false;
	const { nonce: busy } = await ask({ type: "nonce" });
	assert.equal((await reload({ nonce: busy })).error, RELOAD_BUSY);
	idle = true;
	assert.equal((await reload({ nonce: busy })).error, "nonce is expired or used", "no replay");
	await m.fire("agent_start");
	assert.equal((await reload()).error, RELOAD_BUSY, "busy as Botsun sees it");
	await m.fire("agent_settled");
	// A dialog open at the keyboard (a reload would dismiss it).
	await m.fire("ui_prompt_start", { kind: "select", title: "Pick one" });
	assert.equal((await reload()).error, m.mod.dialogOpen("reload"));
	await m.fire("ui_prompt_end", {});
	assert.equal(m.sent.length, 0);

	const reloads = [];
	const notes = [];
	const cmdCtx = { reload: async () => reloads.push(1), ui: { notify: (text) => notes.push(text) } };
	const { handler } = m.commands.get(RELOAD_COMMAND);
	await handler("", cmdCtx);
	assert.equal(reloads.length, 0, "typed by hand it doesn't reload");
	assert.match(notes[0], /type \/reload instead/);
	assert.deepEqual(await reload(), { ok: true });
	await until(() => m.sent.length === 1);
	const sent = m.sent[0];
	assert.deepEqual(sent.options, { expandPromptTemplates: true });
	const [, token] = sent.content.match(new RegExp(`^/${RELOAD_COMMAND} ([\\w-]{24})$`)) ?? [];
	assert.ok(token, sent.content);
	// pi runs that command with a command context (its reload() is /reload's): once, with that request's token.
	await handler("not-the-token", cmdCtx);
	assert.equal(reloads.length, 0, "another token doesn't");
	assert.deepEqual(await reload(), { ok: true });
	await until(() => m.sent.length === 2);
	const token2 = m.sent[1].content.split(" ")[1];
	assert.notEqual(token2, token, "a fresh token each time");
	await handler(token, cmdCtx);
	assert.equal(reloads.length, 0, "nor a spent one");
	assert.deepEqual(await reload(), { ok: true });
	await until(() => m.sent.length === 3);
	const token3 = m.sent[2].content.split(" ")[1];
	await handler(token3, cmdCtx);
	assert.equal(reloads.length, 1);
	await handler(token3, cmdCtx);
	assert.equal(reloads.length, 1, "once");
	assert.ok(!m.mod.phoneCommands({ getCommands: () => [{ name: RELOAD_COMMAND }, { name: "goal" }] }).some((c) => c.name === RELOAD_COMMAND),
		"not on the phone's / list");
	assert.deepEqual(m.mod.phoneCommands({ getCommands: () => [{ name: "agent-link-reload" }, { name: "agent-link" }] }).filter((c) => c.name.startsWith("agent-link")).map((c) => c.name),
		["agent-link"], "nor agent-link's internal reload command");
});

test("reload and restart reply first and act after; a turn started in between stops them", async () => {
	const decide = phoneKey();
	writeKeys({ 7: decide.raw.toString("base64") });
	const env = await restartEnv();
	env.inTmux();
	env.record();
	const m = await owner();
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	const spawned = [];
	conn.spawnRestart = (pane) => spawned.push(pane);
	let idle = true;
	m.ctx.isIdle = () => idle;
	const request = (type) => {
		const { nonce } = m.mod.handleOwnerRequest(conn, { type: "nonce" });
		return m.mod.handleOwnerRequest(conn, { type, nonce, device_id: 7, sig_v: 2, signature: signV2(decide, nonce, "session", type, type) });
	};
	for (const [type, done] of [["reload", () => m.sent.length], ["restart", () => spawned.length]]) {
		let reply = request(type);
		assert.equal(reply.ok, true, type);
		assert.equal(done(), 0, `${type}: nothing before the reply is written`);
		reply[m.mod.AFTER_REPLY]();
		assert.equal(done(), 1, `${type}: done after it`);
		reply = request(type);
		idle = false; // a typed prompt started meanwhile
		reply[m.mod.AFTER_REPLY]();
		assert.equal(done(), 1, `${type}: skipped`);
		idle = true;
	}
	assert.deepEqual(spawned, ["%12"]);
});

test("restart: only in tmux with the restart extension's record; pi-restart-all --only this pane, after the reply", async () => {
	const decide = phoneKey();
	writeKeys({ 7: decide.raw.toString("base64") });
	const env = await restartEnv();
	const m = await owner();
	const { RESTART_BUSY, RESTART_NO_TMUX } = m.mod;
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	const spawned = [];
	conn.spawnRestart = (pane) => spawned.push(pane);
	let idle = true;
	m.ctx.isIdle = () => idle;
	m.ctx.shutdown = () => assert.fail("pi-restart-all ends pi, not this");
	const features = async () => (await ask({ type: "nonce" })).features;
	const restart = async ({ key = decide, decision = "restart", nonce } = {}) => {
		nonce ??= (await ask({ type: "nonce" })).nonce;
		return ask({ type: "restart", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", decision, decision) });
	};
	// v1 (verifies, the device not ratcheted yet): refused, nonce spent.
	const { nonce: n1 } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "restart", nonce: n1, device_id: 7, signature: signV1(decide, n1, "restart") })).error,
		"restart needs a v2 signature: v1 is refused (update Botsun and the app)");
	assert.equal((await restart({ nonce: n1 })).error, "nonce is expired or used");
	// Not in tmux: not offered, refused after the check (nonce spent).
	assert.ok((await features()).includes("reload"));
	assert.ok(!(await features()).includes("restart"));
	const { nonce: outside } = await ask({ type: "nonce" });
	assert.equal((await restart({ nonce: outside })).error, RESTART_NO_TMUX);
	assert.equal((await restart({ nonce: outside })).error, "nonce is expired or used");
	assert.equal((await restart({ key: phoneKey() })).error, "signature does not verify", "verified first");
	// In tmux, but no record, another pane's, another server's, or one on its way out.
	env.inTmux();
	assert.ok(!(await features()).includes("restart"), "no record");
	assert.equal((await restart()).error, RESTART_NO_TMUX);
	for (const over of [{ pane: "%13" }, { socket: join(home, "other.sock") }, { pid: process.pid + 1 }, { exiting: true }]) {
		env.record(over);
		assert.ok(!(await features()).includes("restart"), JSON.stringify(over));
	}
	assert.equal((await restart()).error, RESTART_NO_TMUX);
	env.record();
	assert.ok((await features()).includes("restart"));
	assert.ok(m.mod.restartTarget(process.env, process.pid));
	// pi-restart-all also skips a pane whose tmux server socket isn't there, or a process not titled "pi".
	const gone = join(home, "gone.sock");
	env.record({ socket: gone });
	assert.equal(m.mod.restartTarget({ ...process.env, TMUX: `${gone},1,0` }, process.pid), null, "no tmux server");
	env.record();
	process.title = "node";
	assert.ok(!(await features()).includes("restart"), "not titled pi");
	process.title = "pi";
	assert.equal(m.mod.restartTarget(process.env, process.pid, join(home, "no-such-pi-restart-all")), null, "nor without the script");
	// Signing: its own decision.
	assert.equal((await restart({ decision: "reload" })).error, "signature does not verify", "a reload signature isn't a restart one");
	assert.equal((await restart({ decision: "close" })).error, "signature does not verify");
	// A running turn.
	idle = false;
	assert.equal((await restart()).error, RESTART_BUSY);
	idle = true;
	assert.deepEqual(spawned, []);
	assert.deepEqual(await restart(), { ok: true });
	await until(() => spawned.length === 1);
	assert.deepEqual(spawned, ["%12"]);
	assert.equal(m.sent.length, 0);
});

test("features: restart is said when it becomes possible, after every session_start handler ran", async () => {
	const env = await restartEnv();
	env.inTmux();
	const { m, srv } = await ownerWith({});
	const hello = srv.lines.find((l) => l.type === "hello");
	assert.ok(hello.features.includes("reload"));
	assert.ok(!hello.features.includes("restart"));
	// /reload: this extension's session_start runs, then the restart extension's writes its record.
	await m.fire("session_shutdown", { reason: "reload" });
	const started = m.fire("session_start", { reason: "reload" });
	env.record();
	await started;
	await until(() => srv.lines.filter((l) => l.type === "features").length === 2);
	const [forced, changed] = srv.lines.filter((l) => l.type === "features");
	assert.ok(!forced.features.includes("restart"));
	assert.ok(changed.features.includes("restart"));
	// Unchanged: no line.
	await m.fire("session_shutdown", { reason: "reload" });
	await m.fire("session_start", { reason: "reload" });
	await sleep(30);
	assert.equal(srv.lines.filter((l) => l.type === "features").length, 3, "the forced one only");
	env.noRecord();
	assert.ok(!(await ask({ type: "nonce" })).features.includes("restart"), "gone with the record");
});

test("a locked phone's close: call key, v2, decision close_call, this session only; never ends a running turn", async () => {
	const { CLOSE_CALL_BUSY } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	let idle = true;
	const log = [];
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => log.push("abort");
	m.ctx.shutdown = () => log.push("shutdown");
	const callClose = async ({ key = call, decision = "close_call", scope = "sid-a", extra = {} } = {}) => {
		const { nonce, features } = await ask({ type: "nonce" });
		assert.ok(features.includes("close_call"));
		return ask({ type: "close", key: "call", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", decision, "close", { scope }), ...extra });
	};
	assert.equal((await callClose({ key: decide })).error, "signature does not verify", "the main key isn't the call key");
	assert.equal((await callClose({ decision: "close" })).error, "signature does not verify", "a close signature isn't a close_call one");
	assert.equal((await callClose({ decision: "say_call" })).error, "signature does not verify", "nor a locked reply's");
	assert.equal((await callClose({ scope: "sid-b" })).error, "signature does not verify", "this session only");
	assert.equal((await callClose({ extra: { sig_v: 1 } })).error, "a call-key close must be signed v2");
	assert.equal((await callClose({ extra: { key: "main" } })).error, "bad request");
	// The other way round: a close_call signature sent as a main-key close.
	let { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "close", nonce, device_id: 7, sig_v: 2, signature: signV2(call, nonce, "session", "close_call", "close") })).error,
		"signature does not verify");
	assert.deepEqual(log, []);
	// A running turn (or Botsun's busy): refused, nothing aborted, and the nonce stays spent once it settles.
	idle = false;
	({ nonce } = await ask({ type: "nonce" }));
	const signature = signV2(call, nonce, "session", "close_call", "close");
	assert.equal((await ask({ type: "close", key: "call", nonce, device_id: 7, sig_v: 2, signature })).error, CLOSE_CALL_BUSY);
	idle = true;
	assert.equal((await ask({ type: "close", key: "call", nonce, device_id: 7, sig_v: 2, signature })).error, "nonce is expired or used", "no replay");
	await m.fire("agent_start");
	assert.equal((await callClose()).error, CLOSE_CALL_BUSY, "busy as Botsun sees it");
	await m.fire("agent_settled");
	assert.deepEqual(log, [], "never aborted");
	assert.deepEqual(await callClose(), { ok: true });
	await until(() => log.includes("shutdown"));
	assert.deepEqual(log, ["shutdown"]);
	assert.equal(m.sent.length, 0);
});

test("a locked phone's close waits out a compaction, even one that runs while pi is idle", async () => {
	const { CLOSE_CALL_BUSY } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	const log = [];
	m.ctx.isIdle = () => true;
	m.ctx.abort = () => log.push("abort");
	m.ctx.shutdown = () => log.push("shutdown");
	const callClose = async () => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "close", key: "call", nonce, device_id: 7, sig_v: 2, signature: signV2(call, nonce, "session", "close_call", "close") });
	};
	await m.fire("session_before_compact", { reason: "threshold" });
	assert.equal((await callClose()).error, CLOSE_CALL_BUSY);
	await m.fire("session_compact", { reason: "threshold" }); await settle();
	await sleep(50);
	assert.deepEqual(log, [], "nothing aborted, nothing shut down");
	assert.deepEqual(await callClose(), { ok: true });
	await until(() => log.includes("shutdown"));
	assert.deepEqual(log, ["shutdown"]);
});

test("a locked phone's close counts a sent prompt that hasn't started, or pi's queue, as running", async () => {
	const { CLOSE_CALL_BUSY } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	const log = [];
	let pending = false;
	m.ctx.isIdle = () => true; // pi's input and before_agent_start handlers still running
	m.ctx.hasPendingMessages = () => pending;
	m.ctx.abort = () => log.push("abort");
	m.ctx.shutdown = () => log.push("shutdown");
	const callClose = async () => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "close", key: "call", nonce, device_id: 7, sig_v: 2, signature: signV2(call, nonce, "session", "close_call", "close") });
	};
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	await m.fire("input", { text: "run the tests", source: "interactive" });
	assert.equal((await callClose()).error, CLOSE_CALL_BUSY, "sent, not started");
	await m.fire("agent_start");
	await m.fire("agent_settled");
	// Sent after the reply: the shutdown is skipped.
	const closing = conn.close({ idleOnly: true });
	await m.fire("input", { text: "one more thing", source: "extension" });
	closing.shutdown();
	await m.fire("agent_settled");
	pending = true;
	assert.equal((await callClose()).error, CLOSE_CALL_BUSY, "messages in pi's queue");
	pending = false;
	await m.fire("input", { text: "a prompt another extension handled", source: "interactive" });
	const realNow = Date.now;
	try {
		Date.now = () => realNow() + 9_000;
		assert.equal(conn.close({ idleOnly: true }), null, "still within its 10 s");
		Date.now = () => realNow() + 10_001;
		await sleep(50);
		assert.deepEqual(log, [], "nothing aborted, nothing shut down");
		assert.deepEqual(await callClose(), { ok: true }, "a prompt that never started stops counting after 10 s");
	} finally {
		Date.now = realNow;
	}
	await until(() => log.includes("shutdown"));
	assert.deepEqual(log, ["shutdown"]);
});

test("a locked phone's close counts words this extension released after a stop or a compaction as on their way in", async () => {
	const { CLOSE_CALL_BUSY } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	const log = [];
	let idle = false;
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => log.push("abort");
	m.ctx.shutdown = () => log.push("shutdown");
	const callClose = async () => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "close", key: "call", nonce, device_id: 7, sig_v: 2, signature: signV2(call, nonce, "session", "close_call", "close") });
	};
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	const realNow = Date.now;
	const later = (ms) => { Date.now = () => realNow() + ms; };
	try {
		// A turn running (not just !isIdle: that alone is a compaction's shape now).
		await m.fire("agent_start");
		// Stop, then the words once pi settles: sent by this extension, pi's input event not yet run.
		assert.equal(conn.deliver("try the other fix", "stop"), "stopped");
		idle = true;
		await m.fire("agent_settled");
		assert.deepEqual(m.sent.map((s) => s.content), ["try the other fix"]);
		assert.equal((await callClose()).error, CLOSE_CALL_BUSY, "released after a stop");
		later(10_001);
		// Held through a compaction, then released at its end.
		await m.fire("session_before_compact", { reason: "threshold" });
		conn.inject("and this", false);
		await m.fire("session_compact", { reason: "threshold" }); await settle();
		assert.deepEqual(m.sent.map((s) => s.content), ["try the other fix", "and this"]);
		assert.equal((await callClose()).error, CLOSE_CALL_BUSY, "released after a compaction");
		later(20_002);
		assert.equal(conn.deliver("a released call's words", "queue"), "prompt");
		assert.equal((await callClose()).error, CLOSE_CALL_BUSY, "a released call's words");
		// pi's before_agent_start: a slow input handler doesn't let the close in before the turn.
		later(30_003);
		await m.fire("before_agent_start", { prompt: "and this" });
		later(39_000);
		assert.equal((await callClose()).error, CLOSE_CALL_BUSY, "refreshed as the turn starts");
		await m.fire("agent_start");
		await m.fire("input", { text: "typed mid-turn", source: "interactive" }); // taken by the turn
		await m.fire("agent_settled");
		assert.deepEqual(log, ["abort"], "only the stop's abort");
		assert.deepEqual(await callClose(), { ok: true });
	} finally {
		Date.now = realNow;
	}
	await until(() => log.includes("shutdown"));
	assert.deepEqual(log, ["abort", "shutdown"]);
});

test("a locked phone's close checks again at shutdown: a turn started since its reply keeps the session", async () => {
	const m = await owner();
	let idle = true;
	const log = [];
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => log.push("abort");
	m.ctx.shutdown = () => log.push("shutdown");
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	// What closeCall replies with: its shutdown runs once the reply is out, and something starts first.
	let closing = conn.close({ idleOnly: true });
	await m.fire("agent_start"); // a typed prompt, a follow-up, a trigger (Botsun's busy)
	closing.shutdown();
	await m.fire("agent_settled");
	closing = conn.close({ idleOnly: true });
	idle = false; // pi's own word
	closing.shutdown();
	idle = true;
	closing = conn.close({ idleOnly: true });
	await m.fire("session_before_compact", { reason: "threshold" });
	closing.shutdown();
	await m.fire("session_compact", { reason: "threshold" }); await settle();
	closing = conn.close({ idleOnly: true });
	conn.framing = new Promise(() => {}); // a video reply on its way in
	assert.equal(conn.close({ idleOnly: true }), null, "refused while its frames are extracted");
	closing.shutdown();
	conn.framing = undefined;
	assert.deepEqual(log, [], "nothing aborted, nothing shut down");
	conn.close({ idleOnly: true }).shutdown();
	assert.deepEqual(log, ["shutdown"], "still idle at shutdown: closed");
});

test("a yes on the call answers the ask only with the read-back answer's hash, and never a no", async () => {
	const { offerPrompt, canonicalAnswer } = await import("../lib/remote-prompts.ts");
	const { m, hold } = await heldCall();
	assert.ok((await ask({ type: "nonce" })).features.includes("confirm"));
	const offered = offerPrompt([{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }]);
	const mushrooms = [{ picks: [1] }];
	const sha = createHash("sha256").update(canonicalAnswer(offered.id, mushrooms)).digest("hex");
	const other = createHash("sha256").update(canonicalAnswer(offered.id, [{ picks: [0] }])).digest("hex");
	const confirm = (id, answers = mushrooms) => ask({ type: "confirm", id, ask_id: offered.id, answers });

	const plain = await hold("yeah send it");
	assert.equal((await confirm(plain.held)).error, "his words weren't a reply to a proposal");
	assert.equal((await hold("yes", sha, other)).error, "signature does not verify", "the hash is in the signature");
	const no = await hold("no, the other one", sha);
	assert.equal((await confirm(no.held)).error, "his words say no");
	assert.equal((await confirm(no.held)).error, `not waiting: ${no.held}`, "a failed confirm spends them");
	const hmm = await hold("hmm which one is safer", sha);
	assert.equal((await confirm(hmm.held)).error, "his words don't say yes", "a misled helper can't confirm on any words");
	const wrong = await hold("yes", sha);
	assert.equal((await confirm(wrong.held, [{ picks: [0] }])).error, "his yes was for a different answer");
	const yes = await hold("yeah that's fine, send it over", sha);
	assert.deepEqual(await confirm(yes.held), { ok: true });
	assert.deepEqual(await offered.answered, mushrooms);
	assert.equal((await confirm(yes.held)).error, `not waiting: ${yes.held}`, "used once");
	assert.equal(m.sent.length, 0, "an answer, not words for the model");
	offered.dispose();
});

test("a reworded message goes in only with his signed yes to that exact text", async () => {
	const { proposalTextHash } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const { m, hold, busy } = await heldCall();
	assert.ok((await ask({ type: "nonce" })).features.includes("confirm_text"));
	const text = "Run the tests, then lint the changed files.";
	const sha = proposalTextHash(text);
	const confirm = (id, t = text, mode = "steer") => ask({ type: "confirm", id, text: t, mode });

	const swapped = await hold("yeah send it", sha);
	assert.equal((await confirm(swapped.held, "Delete the branch.")).error, "his yes was for a different message");
	const hmm = await hold("hmm", sha);
	assert.equal((await confirm(hmm.held)).error, "his words don't say yes");
	assert.equal((await confirm((await hold("sure", sha)).held, text, "interrupt")).error, "bad request", "never a stop");
	const long = "x".repeat(601);
	assert.equal((await confirm((await hold("sure", proposalTextHash(long))).held, long)).error, "bad request", "no longer than Botsun reads back");
	assert.equal(m.sent.length, 0);
	await busy(true);
	const yes = await hold("yeah send it", sha);
	assert.deepEqual(await confirm(yes.held), { ok: true, delivered: "steer" });
	assert.deepEqual(m.sent.at(-1), { content: text, options: { deliverAs: "steer" } });
	const later = await hold("yep", sha);
	assert.deepEqual(await confirm(later.held, text, "queue"), { ok: true, delivered: "queue" });
	assert.deepEqual(m.sent.at(-1).options, { deliverAs: "followUp" });
	assert.notEqual(proposalTextHash("x"), createHash("sha256").update("x").digest("hex"), "its own namespace");
});

test("saysNo leans to no, and saysYes takes a short yes in so many words", async () => {
	const { saysNo, saysYes } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	for (const t of ["no", "No, the other one", "nope", "wait", "don't", "dont", "not that", "I'm not sure", "cancel it", "hold on", "never mind",
		"no problem", "actually the first one", "scratch that", "yes, no wait"]) assert.equal(saysNo(t), true, t);
	for (const t of ["yes", "yeah that's fine, send it over", "sure", "go ahead", "I know, send it", "do it"]) assert.equal(saysNo(t), false, t);
	for (const t of ["yes", "Yeah.", "yeah that's fine, send it over", "sure, send it", "go ahead", "ok do it", "that's it", "sounds good", "uh huh", "mm-hmm", "please do", "send", "yes sir", "ship it"]) {
		assert.equal(saysYes(t), true, t);
	}
	for (const t of ["hmm", "which one is safer?", "read the question again", "say yes to send it?", "yes, no wait", "I'm not sure",
		"tell it to also run the linter on the whole repo before pushing anything at all please"]) assert.equal(saysYes(t), false, t);
});

test("saysStop: stop words, not their negations or lookalikes", async () => {
	const { saysStop } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	for (const t of ["stop", "Stop!", "cancel that", "abort it", "halt", "ok stop the build", "wait, cancel that", "stop, that's the wrong branch", "make it stop", "tell it to stop"]) {
		assert.equal(saysStop(t), true, t);
	}
	for (const t of ["don't stop", "do not cancel it", "never stop", "unstoppable", "the bus stops here", "keep going", "no need to stop",
		"add a cancel button", "the halt flag is wrong", "can't stop thinking about it", "make it stop retrying the spec", "please make it stop retrying the flaky spec when the network is down"]) {
		assert.equal(saysStop(t), false, t);
	}
});

test("drop forgets the ids given; call_end forgets them all", async () => {
	const { m, hold } = await heldCall();
	const a = await hold("one");
	const b = await hold("two");
	const c = await hold("three");
	assert.deepEqual(await ask({ type: "drop", ids: [a.held] }), { ok: true });
	assert.equal((await ask({ type: "release", ids: [a.held], mode: "steer" })).error, `not waiting: ${a.held}`);
	assert.deepEqual(await ask({ type: "call_end" }), { ok: true });
	assert.match((await ask({ type: "release", ids: [b.held, c.held], mode: "steer" })).error, /^not waiting/);
	assert.equal(m.sent.length, 0);
});

test("a sensitive prompt is flagged to Botsun and refuses a spoken yes and a v1 tap, not a v2-signed tap", async () => {
	const { offerPrompt, canonicalAnswer } = await import("../lib/remote-prompts.ts");
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	const askFor = (id) => srv.lines.find((l) => l.type === "ask" && l.ask.id === id)?.ask;
	const plain = offerPrompt([{ question: "Pizza?", options: [{ label: "Pepperoni" }] }]);
	await until(() => askFor(plain.id));
	assert.equal("sensitive" in askFor(plain.id), false);
	plain.dispose();
	const offered = offerPrompt([{ question: "Allow the read?", options: [{ label: "Allow" }, { label: "Deny" }] }], { sensitive: true });
	await until(() => askFor(offered.id));
	assert.equal(askFor(offered.id).sensitive, true);

	const allow = [{ picks: [0] }];
	const sha = createHash("sha256").update(canonicalAnswer(offered.id, allow)).digest("hex");
	const wav = createHash("sha256").update("RIFF…audio").digest("hex");
	let { nonce } = await ask({ type: "nonce" });
	const spoken = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav, sha].join("\n");
	const sig = cryptoSign("sha256", Buffer.from(spoken), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
	const held = await ask({ type: "say_audio", text: "yes", nonce, device_id: 7, wav_sha256: wav, signature: sig, hold: true, proposal_sha256: sha });
	assert.ok(held.held);
	const confirm = () => ask({ type: "confirm", id: held.held, ask_id: offered.id, answers: allow });
	assert.equal((await confirm()).error, "answer this one on the phone screen or the keyboard");
	assert.equal((await confirm()).error, `not waiting: ${held.held}`, "spent");

	({ nonce } = await ask({ type: "nonce" }));
	const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "answer", sha].join("\n");
	const signature = cryptoSign("sha256", Buffer.from(msg), { key: decide.privateKey, dsaEncoding: "der" }).toString("base64");
	assert.match((await ask({ type: "answer", ask_id: offered.id, answers: allow, nonce, device_id: 7, signature })).error ?? "",
		/^this one needs a v2-signed answer/, "a v1 tap doesn't bind the card's text, even before the ratchet");
	assert.equal((await ask({ type: "stop", nonce, device_id: 7, signature })).error, "nonce is expired or used", "the refusal spent the nonce");
	({ nonce } = await ask({ type: "nonce" }));
	const { canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const payload = canonicalAnswerV2(offered.id, [{ question: "Allow the read?", options: [{ label: "Allow" }, { label: "Deny" }] }], allow);
	const v2msg = ["botsun-sign-v2", "7", nonce, "answer", "sid-a", "answer", createHash("sha256").update(payload).digest("hex")].join("\n");
	const v2sig = cryptoSign("sha256", Buffer.from(v2msg), { key: decide.privateKey, dsaEncoding: "der" }).toString("base64");
	assert.deepEqual(await ask({ type: "answer", ask_id: offered.id, answers: allow, nonce, device_id: 7, sig_v: 2, signature: v2sig }), { ok: true });
	assert.deepEqual(await offered.answered, allow);
	assert.equal(m.sent.length, 0);
	offered.dispose();
});

test("every signed request type refuses alike: bad request, used nonce, unknown device, loose key file, bad signature", async () => {
	const decide = phoneKey();
	const call = phoneKey();
	const keys = (mode = 0o600) => {
		writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
		chmodSync(keysFile, mode);
	};
	keys();
	await owner();
	const bodies = {
		say: { type: "say", text: "hi" },
		say_audio: { type: "say_audio", text: "hi", wav_sha256: "a".repeat(64) },
		answer: { type: "answer", ask_id: "nope", answers: [] },
		stash: { type: "stash", op: "drop", id: "x1" },
		stop: { type: "stop" },
		unsteer: { type: "unsteer" },
		close: { type: "close" },
	};
	for (const [name, body] of Object.entries(bodies)) {
		assert.equal((await ask({ ...body, nonce: "n", device_id: "x", signature: "s" })).error, "bad request", name);
		assert.equal((await ask({ ...body, nonce: "n", device_id: 7 })).error, "bad request", `${name}: no signature`);
		assert.equal((await ask({ ...body, nonce: "unissued", device_id: 7, signature: "s" })).error, "nonce is expired or used", name);
		let { nonce } = await ask({ type: "nonce" });
		assert.equal((await ask({ ...body, nonce, device_id: 8, signature: "s" })).error, "unknown device", name);
		assert.equal((await ask({ ...body, nonce, device_id: 7, signature: "s" })).error, "nonce is expired or used", `${name}: spent on a failure`);
		({ nonce } = await ask({ type: "nonce" }));
		assert.equal((await ask({ ...body, nonce, device_id: 7, signature: "AAAA" })).error, "signature does not verify", name);
		keys(0o666);
		({ nonce } = await ask({ type: "nonce" }));
		assert.match((await ask({ ...body, nonce, device_id: 7, signature: "s" })).error, /^owner-keys\.json must be/, name);
		keys();
	}
});

// ---- Signing v2 (sig_v: 2) and device key pinning --------------------------

const sha = (s) => createHash("sha256").update(s).digest("hex");
const UNSTEER_V1 = "unsteer needs a v2 signature: v1 is refused (update Botsun and the app)";
/** A v2 signature: "botsun-sign-v2" … kind, scope (the session id), decision, sha256(payload). */
function signV2(key, nonce, kind, decision, payload, { scope = "sid-a", deviceId = "7" } = {}) {
	const msg = ["botsun-sign-v2", deviceId, nonce, kind, scope, decision, sha(payload)].join("\n");
	return cryptoSign("sha256", Buffer.from(msg, "utf8"), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
}

async function ownerWith(ctx) {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ ctx });
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	return { m, srv };
}

test("v2: the nonce reply advertises sign_v2 and ask_v2; say, stash and stop verify v2, v1 still works", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	// Idle for the says below (a session that isn't idle and isn't running is a compaction's shape),
	// then busy for the stop.
	let idle = true;
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => {};
	const { features } = await ask({ type: "nonce" });
	assert.ok(features.includes("sign_v2") && features.includes("ask_v2"));

	let { nonce } = await ask({ type: "nonce" });
	const text = "ship it";
	let res = await ask({ type: "say", text: "v1", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "v1") });
	assert.equal(res.ok, true, "v1 verifies before the device has signed v2");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "say", text) });
	assert.equal(res.error, "signature does not verify", "v2 say signs botsun-propose-text-v1\\n<text>, not the bare text");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`) });
	assert.deepEqual(res, { ok: true, delivered: "prompt" });
	assert.equal(m.sent.at(-1).content, text);

	({ nonce } = await ask({ type: "nonce" }));
	const v2sig = signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`);
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, signature: v2sig })).error, "signature does not verify", "a v2 signature isn't a v1 one");
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature: signed(key, 7, nonce, "sid-a", text) })).error,
		"signature does not verify", "nor the other way round");
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, sig_v: 4, signature: v2sig })).error, "bad request");
	({ nonce } = await ask({ type: "nonce" }));
	const other = signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`, { scope: "sid-b" });
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature: other })).error, "signature does not verify", "scoped to this session");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "v1", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "v1") });
	assert.match(res.error ?? "", /^this phone signs v2/, "v1 is refused once the device signed v2");

	({ nonce } = await ask({ type: "nonce" }));
	idle = false;
	assert.deepEqual(await ask({ type: "stop", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stop", "stop") }), { ok: true, stopped: true });
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "close", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stop", "stop") })).error,
		"signature does not verify", "a stop signature isn't a close");
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "close", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "close", "close", { scope: "sid-b" }) })).error,
		"signature does not verify", "close is scoped to this session");
	({ nonce } = await ask({ type: "nonce" }));
	let shutdowns = 0;
	m.ctx.shutdown = () => shutdowns++;
	const closeSig = signV2(key, nonce, "session", "close", "close");
	assert.deepEqual(await ask({ type: "close", nonce, device_id: 7, sig_v: 2, signature: closeSig }), { ok: true });
	assert.equal((await ask({ type: "close", nonce, device_id: 7, sig_v: 2, signature: closeSig })).error, "nonce is expired or used", "no replay");
	await until(() => shutdowns === 1);
	({ nonce } = await ask({ type: "nonce" }));
	const push = `push\n${sha("draft")}`;
	res = await ask({ type: "stash", op: "push", text: "draft", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stash", push) });
	assert.equal(res.ok, true);
	assert.equal(m.sent.length, 2);
});

test("v2 answer: signed over the prompt's own questions, looked up first", async () => {
	const { offerPrompt, canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	await owner();
	const questions = [{ question: "Pizza?", options: [{ label: "Pepperoni", description: "classic" }, { label: "Mushrooms" }] }];
	const offered = offerPrompt(questions);
	const answers = [{ picks: [1] }];
	const send = async (qs, a = answers, extra = {}) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(key, nonce, "answer", "answer", canonicalAnswerV2(offered.id, qs, a));
		return ask({ type: "answer", ask_id: offered.id, answers: a, nonce, device_id: 7, sig_v: 2, signature, ...extra });
	};
	const reworded = [{ ...questions[0], question: "Delete prod?" }];
	assert.equal((await send(reworded, answers, { questions: reworded })).error, "signature does not verify", "a reworded question, even if the request carries it");
	assert.equal((await send([{ ...questions[0], options: [{ label: "Pepperoni" }, { label: "rm -rf" }] }])).error, "signature does not verify", "a swapped option");
	assert.equal((await send(questions, [{ picks: [0, 1] }])).error, "one answer for a single-choice question");
	assert.deepEqual(await send(questions), { ok: true });
	assert.deepEqual(await offered.answered, answers);
	assert.equal((await send(questions)).error, "that question was already answered");
	offered.dispose();
});

test("cancel_ask: the phone's Cancel, v2 over cancel_ask and the id, only for a cancellable prompt", async () => {
	const { offerPrompt, openPrompts } = await import("../lib/remote-prompts.ts");
	const { CANCEL_ASK_REFUSED, CANCEL_ASK_V1_REFUSED } = await import("../extensions/opt-in/botsun-owner/index.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const { srv } = await ownerWith(undefined);
	const askFor = (id) => srv.lines.find((l) => l.type === "ask" && l.ask.id === id)?.ask;
	const questions = [{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }];

	// Not offered cancellable (op-broker's): no flag, and a signed cancel is refused with its nonce spent.
	const plain = offerPrompt(questions, { sensitive: true });
	await until(() => askFor(plain.id));
	assert.equal("cancellable" in askFor(plain.id), false);
	const { nonce } = await ask({ type: "nonce" });
	const plainSig = signV2(key, nonce, "session", "cancel_ask", `cancel_ask\n${plain.id}`);
	assert.equal((await ask({ type: "cancel_ask", ask_id: plain.id, nonce, device_id: 7, sig_v: 2, signature: plainSig })).error, CANCEL_ASK_REFUSED);
	assert.equal((await ask({ type: "stop", nonce, device_id: 7, sig_v: 2, signature: "AAAA" })).error, "nonce is expired or used", "its nonce was spent");
	assert.ok(openPrompts().some((p) => p.id === plain.id), "still open");
	plain.dispose();

	const offered = offerPrompt(questions, { cancellable: true });
	await until(() => askFor(offered.id));
	assert.equal(askFor(offered.id).cancellable, true);
	let cancelled = false;
	offered.cancelled.then(() => (cancelled = true));
	const send = async (payload, extra = {}) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "cancel_ask", ask_id: offered.id, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "cancel_ask", payload), ...extra });
	};
	assert.equal((await send(`cancel_ask\nsomething-else`)).error, "signature does not verify", "signed for another question");
	assert.equal((await send("stop")).error, "signature does not verify", "a stop's payload");
	assert.equal((await send(`cancel_ask\n${offered.id}`, { sig_v: undefined })).error, CANCEL_ASK_V1_REFUSED);
	assert.equal((await send(`cancel_ask\n${offered.id}`, { key: "call" })).error, "bad request", "main key only");
	assert.equal((await send(`cancel_ask\n${offered.id}`, { ask_id: "../x" })).error, "bad request");
	assert.equal(cancelled, false);
	assert.deepEqual(await send(`cancel_ask\n${offered.id}`), { ok: true });
	await offered.cancelled;
	assert.equal(openPrompts().some((p) => p.id === offered.id), false, "withdrawn");
	await until(() => srv.types().includes("ask_end"));
	assert.equal((await send(`cancel_ask\n${offered.id}`)).error, "that question was already answered");
	offered.dispose();
});

test("a locked phone's pick: call key, v2, decision answer_call, one pick of the open single-select question", async () => {
	const { offerPrompt, canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const { ANSWER_CALL_SENSITIVE } = await import("../extensions/opt-in/botsun-owner/index.ts");
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	await owner();
	assert.ok((await ask({ type: "nonce" })).features.includes("answer_call"));
	const questions = [{ question: "Pizza?", options: [{ label: "Pepperoni", description: "classic" }, { label: "Mushrooms" }] }];
	let offered = offerPrompt(questions);
	const send = async ({ pick = 1, key = call, kind = "session", decision = "answer_call", qs = questions, id = offered.id, answers, extra = {} } = {}) => {
		const { nonce } = await ask({ type: "nonce" });
		const a = answers ?? [{ picks: [pick] }];
		const signature = signV2(key, nonce, kind, decision, canonicalAnswerV2(id, qs, [{ picks: [pick] }]));
		return ask({ type: "answer", key: "call", ask_id: id, answers: a, nonce, device_id: 7, sig_v: 2, signature, ...extra });
	};
	// Keys and decisions never cross over.
	assert.equal((await send({ key: decide })).error, "signature does not verify", "the main key isn't the call key");
	assert.equal((await send({ kind: "answer", decision: "answer" })).error, "signature does not verify", "a main-key answer's message by the call key");
	assert.equal((await send({ decision: "say_call" })).error, "signature does not verify");
	assert.equal((await send({ qs: [{ ...questions[0], question: "Delete prod?" }] })).error, "signature does not verify", "a reworded question");
	assert.equal((await send({ pick: 0, answers: [{ picks: [1] }] })).error, "signature does not verify", "signed for another pick");
	{
		// A call-key answer_call signature sent as a main-key answer: checked with the main key, refused.
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(call, nonce, "session", "answer_call", canonicalAnswerV2(offered.id, questions, [{ picks: [1] }]));
		assert.equal((await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [1] }], nonce, device_id: 7, sig_v: 2, signature })).error, "signature does not verify");
	}
	// One pick, no text, v2 only.
	for (const answers of [[{ picks: [1], text: "x" }], [{ picks: [0, 1] }], [{ picks: [] }], [{ picks: ["1"] }], [{ picks: [1] }, { picks: [0] }], [], [{ picks: [1], more: 1 }]]) {
		assert.equal((await send({ answers })).error, "a call-key answer is exactly one pick, no text", JSON.stringify(answers));
	}
	assert.equal((await send({ extra: { sig_v: 1 } })).error, "a call-key answer must be signed v2");
	assert.equal((await send({ extra: { key: "main" } })).error, "bad request");
	assert.equal((await send({ pick: 2 })).error, "a pick isn't one of the options");
	assert.equal((await send({ pick: -1 })).error, "a pick isn't one of the options");
	assert.equal((await send({ id: "q-other1" })).error, "that question was already answered");
	// It goes in exactly as a device-key answer of [1] would.
	assert.deepEqual(await send(), { ok: true });
	assert.deepEqual(await offered.answered, [{ picks: [1] }]);
	assert.equal((await send()).error, "that question was already answered");
	offered.dispose();

	// Only the open one (the newest), only one single-select question, never a sensitive one.
	const older = offerPrompt(questions);
	offered = offerPrompt(questions);
	assert.equal((await send({ id: older.id })).error, "that question was already answered", "not the one the phone was shown");
	older.dispose();
	offered.dispose();
	const two = [questions[0], { question: "Drink?", options: [{ label: "Water" }] }];
	offered = offerPrompt(two);
	assert.equal((await send({ qs: [questions[0]] })).error, "a locked phone can answer only one single-choice question");
	offered.dispose();
	const multi = [{ ...questions[0], multiSelect: true }];
	offered = offerPrompt(multi);
	assert.equal((await send({ qs: multi })).error, "a locked phone can answer only one single-choice question");
	offered.dispose();
	offered = offerPrompt(questions, { sensitive: true });
	assert.equal((await send()).error, ANSWER_CALL_SENSITIVE);
	offered.dispose();
});

test("v2 confirm: a v2-signed yes carries the answer-v2 hash; text proposals keep their own", async () => {
	const { offerPrompt, canonicalAnswer, canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	const wav = sha("RIFF…audio");
	const hold = async (text, proposal) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(call, nonce, "session", "say_audio", [wav, proposal].join("\n"));
		return ask({ type: "say_audio", text, nonce, device_id: 7, sig_v: 2, wav_sha256: wav, signature, hold: true, proposal_sha256: proposal });
	};
	const questions = [{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }];
	const offered = offerPrompt(questions);
	const answers = [{ picks: [1] }];
	const v1 = sha(canonicalAnswer(offered.id, answers));
	const v2 = sha(canonicalAnswerV2(offered.id, questions, answers));
	const confirm = (id) => ask({ type: "confirm", id, ask_id: offered.id, answers });
	assert.equal((await confirm((await hold("yes", v1)).held)).error, "his yes was for a different answer", "a v2 utterance needs the v2 hash");
	const yes = await hold("yeah send it", v2);
	assert.ok(yes.held);
	assert.deepEqual(await confirm(yes.held), { ok: true });
	assert.deepEqual(await offered.answered, answers);
	assert.equal((await confirm((await hold("yes", v2)).held)).error, "that question was already answered");

	m.ctx.isIdle = () => true;
	const { proposalTextHash } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const said = await hold("sure", proposalTextHash("Run the tests."));
	assert.deepEqual(await ask({ type: "confirm", id: said.held, text: "Run the tests.", mode: "steer" }), { ok: true, delivered: "prompt" });
});

const { PIN_COOLDOWN_MS } = await import("../extensions/opt-in/botsun-owner/index.ts");

/** Runs fn with the clock moved on by ms (Date.now only; nonces and timeouts follow it). */
async function later(ms, fn) {
	const real = Date.now;
	Date.now = () => real() + ms;
	try { return await fn(); } finally { Date.now = real; }
}

test("device keys are pinned on first use; a changed key is refused until a keyboard yes", async () => {
	const { readFileSync, statSync } = await import("node:fs");
	const { keyFingerprint, shortFingerprint } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const first = phoneKey();
	const second = phoneKey();
	const asked = [];
	let answer = false;
	let release;
	const confirm = (title, message) => {
		asked.push({ title, message });
		return new Promise((r) => { release = () => r(answer); });
	};
	writeKeys({ 7: first.raw.toString("base64") });
	const { m } = await ownerWith({ ui: { confirm } });
	const say = async (key, text, v = 2) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = v === 2 ? signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`) : signed(key, 7, nonce, "sid-a", text);
		return ask({ type: "say", text, nonce, device_id: 7, ...(v === 2 ? { sig_v: 2 } : {}), signature });
	};
	const pins = () => JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8"));

	assert.equal(existsSync(join(pinDir, "pins.json")), false);
	assert.equal((await say(first, "one")).ok, true, "first use");
	assert.equal(pins().devices["7"].sha256, keyFingerprint(first.raw), "pinned");
	assert.equal(statSync(join(pinDir, "pins.json")).mode & 0o777, 0o600);
	assert.equal(statSync(pinDir).mode & 0o777, 0o700);
	assert.equal((await say(first, "two")).ok, true, "same key passes");

	writeKeys({ 7: second.raw.toString("base64") }); // Botsun (or whatever wrote the file) swapped the key
	assert.equal((await say(second, "three")).error, "this device's key changed: confirm at the keyboard");
	await until(() => asked.length === 1);
	assert.match(asked[0].title, /device 7/);
	assert.ok(asked[0].message.includes(shortFingerprint(keyFingerprint(first.raw))), "names the pinned key");
	assert.ok(asked[0].message.includes(shortFingerprint(keyFingerprint(second.raw))), "names the new key");
	assert.equal((await say(second, "again")).error, "this device's key changed: confirm at the keyboard");
	await sleep(20);
	assert.equal(asked.length, 1, "one dialog while it's open");
	assert.equal((await say(first, "old key")).error, "signature does not verify", "the file's key is the one checked");

	release(); // no
	await sleep(20);
	assert.equal(pins().devices["7"].sha256, keyFingerprint(first.raw), "a no keeps the pin");
	assert.equal((await say(second, "four")).error, "this device's key changed: confirm at the keyboard", "still refused");
	await sleep(20);
	assert.equal(asked.length, 1, "no dialog during the cooldown after a no");
	await later(PIN_COOLDOWN_MS + 1000, async () => {
		assert.equal((await say(second, "four")).error, "this device's key changed: confirm at the keyboard", "still refused");
		await until(() => asked.length === 2);
		answer = true;
		release(); // yes
		await until(() => pins().devices["7"].sha256 === keyFingerprint(second.raw));
		assert.equal((await say(second, "five")).ok, true, "re-pinned at the keyboard");
	});
	assert.deepEqual(m.sent.map((s) => s.content), ["one", "two", "five"]);
});

test("pins: the call key is pinned apart; a loose pin file or no keyboard refuses", async () => {
	const { readFileSync } = await import("node:fs");
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner(); // no ctx.ui: nothing can confirm a change
	const wav = sha("RIFF…audio");
	let { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say", text: "hi", nonce, device_id: 7, signature: signed(decide, 7, nonce, "sid-a", "hi") })).ok, true);
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, sig_v: 2, wav_sha256: wav, signature: signV2(call, nonce, "session", "say_audio", wav) })).ok, true);
	const file = JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8"));
	assert.ok(file.devices["7"] && file.call_devices["7"] && file.devices["7"].sha256 !== file.call_devices["7"].sha256);

	const swapped = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: swapped.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	assert.equal((await sayAs(swapped, 7, "x")).error, "this device's key changed: confirm at the keyboard");
	chmodSync(join(pinDir, "pins.json"), 0o644);
	assert.match((await sayAs(swapped, 7, "x")).error, /^device pins file must be/);
	assert.equal(m.sent.length, 2, "the two first-use requests only");
});

/** A v2 say from device id, signed with key; refused requests come back as {error}. */
async function sayAs(key, deviceId, text) {
	const { nonce } = await ask({ type: "nonce" });
	const signature = signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`, { deviceId: String(deviceId) });
	return ask({ type: "say", text, nonce, device_id: deviceId, sig_v: 2, signature });
}

test("pins: a new device id once others are pinned is refused until a keyboard yes; a no cools down for 10 minutes", async () => {
	const { readFileSync } = await import("node:fs");
	const { keyFingerprint, shortFingerprint } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const phone = phoneKey();
	const rogue = phoneKey();
	const asked = [];
	let answer = false;
	let release;
	const confirm = (title, message) => {
		asked.push({ title, message });
		return new Promise((r) => { release = () => r(answer); });
	};
	writeKeys({ 7: phone.raw.toString("base64") });
	const { m } = await ownerWith({ ui: { confirm } });
	const pins = () => JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8"));
	assert.equal((await sayAs(phone, 7, "one")).ok, true, "the first device pins silently");
	assert.equal(asked.length, 0);

	// A compromised Botsun pairs a device of its own.
	writeKeys({ 7: phone.raw.toString("base64"), 999: rogue.raw.toString("base64") });
	assert.equal((await sayAs(rogue, 999, "rm -rf")).error, "new device: confirm at the keyboard");
	assert.equal(pins().devices["999"], undefined, "not pinned silently");
	await until(() => asked.length === 1);
	assert.match(asked[0].title, /new phone device 999/);
	assert.match(asked[0].message, /Device: 999/);
	assert.match(asked[0].message, /decision key/);
	assert.ok(asked[0].message.includes(shortFingerprint(keyFingerprint(rogue.raw))), "names its key");
	assert.equal((await sayAs(phone, 7, "two")).ok, true, "the pinned device still works meanwhile");

	release(); // no
	await sleep(20);
	assert.equal(pins().devices["999"], undefined, "a no doesn't pin");
	for (const t of ["a", "b", "c"]) assert.equal((await sayAs(rogue, 999, t)).error, "new device: confirm at the keyboard");
	await sleep(20);
	assert.equal(asked.length, 1, "no dialog during the cooldown");
	await later(PIN_COOLDOWN_MS - 5000, async () => {
		assert.equal((await sayAs(rogue, 999, "d")).error, "new device: confirm at the keyboard");
		await sleep(20);
		assert.equal(asked.length, 1, "still cooling down");
	});
	await later(PIN_COOLDOWN_MS + 1000, async () => {
		assert.equal((await sayAs(rogue, 999, "e")).error, "new device: confirm at the keyboard");
		await until(() => asked.length === 2);
		answer = true;
		release(); // yes
		await until(() => pins().devices["999"]?.sha256 === keyFingerprint(rogue.raw));
		assert.equal((await sayAs(rogue, 999, "paired")).ok, true, "pinned by the keyboard yes");
	});
	assert.deepEqual(m.sent.map((s) => s.content), ["one", "two", "paired"]);
});

test("pins: a different key on each request opens one dialog; one dialog at a time across devices", async () => {
	const asked = [];
	const confirm = (title) => { asked.push(title); return new Promise(() => {}); }; // left open
	const first = phoneKey();
	const other = phoneKey();
	writeKeys({ 7: first.raw.toString("base64"), 8: other.raw.toString("base64") });
	await ownerWith({ ui: { confirm } });
	assert.equal((await sayAs(first, 7, "one")).ok, true);
	for (let i = 0; i < 5; i++) {
		const minted = phoneKey();
		writeKeys({ 7: minted.raw.toString("base64"), 8: other.raw.toString("base64") });
		assert.equal((await sayAs(minted, 7, `minted ${i}`)).error, "this device's key changed: confirm at the keyboard");
	}
	assert.equal((await sayAs(other, 8, "new")).error, "new device: confirm at the keyboard");
	await sleep(30);
	assert.deepEqual(asked, ["Botsun: phone device 7's key changed"], "exactly one dialog");
});

test("pins: a malformed entry, a symlinked pin dir or a group-writable pin file refuses", async () => {
	const { mkdirSync: mk, symlinkSync, readFileSync } = await import("node:fs");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	assert.equal((await sayAs(key, 7, "one")).ok, true);
	const file = join(pinDir, "pins.json");
	const good = readFileSync(file, "utf8");

	const bad = JSON.parse(good);
	bad.devices["8"] = { sha256: "not-a-fingerprint" };
	writeFileSync(file, JSON.stringify(bad));
	assert.equal((await sayAs(key, 7, "x")).error, "device pins file is malformed", "not just device 8 as unpinned");
	bad.devices = [];
	writeFileSync(file, JSON.stringify(bad));
	assert.equal((await sayAs(key, 7, "x")).error, "device pins file is malformed");

	writeFileSync(file, good);
	chmodSync(file, 0o620);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins file must be/, "group-writable");
	chmodSync(file, 0o600);

	const real = join(home, "real-pins");
	rmSync(real, { recursive: true, force: true });
	mk(real, { mode: 0o700 });
	writeFileSync(join(real, "pins.json"), good, { mode: 0o600 });
	rmSync(pinDir, { recursive: true, force: true });
	symlinkSync(real, pinDir);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins dir must be/, "symlinked dir");
	rmSync(pinDir, { force: true });
	rmSync(real, { recursive: true, force: true });

	mk(pinDir, { mode: 0o700 });
	writeFileSync(join(home, "elsewhere.json"), good, { mode: 0o600 });
	symlinkSync(join(home, "elsewhere.json"), file);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins file must be/, "symlinked file");
	rmSync(file, { force: true });

	chmodSync(pinDir, 0o750);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins dir must be/, "a loose dir");
	chmodSync(pinDir, 0o700);
	assert.equal(m.sent.length, 1);
});

/**
 * Runs each body (a loop over i, with pin and ratchet imported) in a process of its own, all
 * started at once: each child imports pins.ts, says "ready" on stdout and waits; once every child
 * is ready, the parent writes "go" to each one's stdin.
 */
async function race(bodies) {
	const { spawn } = await import("node:child_process");
	const pinsTs = new URL("../extensions/opt-in/botsun-owner/pins.ts", import.meta.url).href;
	const children = bodies.map((body) => {
		const code = `import { pin, ratchet } from ${JSON.stringify(pinsTs)};
			process.stdout.write("ready\\n");
			await new Promise((go) => process.stdin.once("data", go));
			for (let i = 0; i < 40; i++) ${body};
			process.exit(0);`;
		const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, BOTSUN_OWNER_PIN_DIR: pinDir }, stdio: ["pipe", "pipe", "pipe"] });
		let err = "";
		p.stderr.on("data", (d) => { err += d; });
		const ready = new Promise((resolve, reject) => {
			let out = "";
			p.stdout.on("data", (d) => { out += d; if (out.includes("ready\n")) resolve(); });
			p.on("exit", (c) => reject(new Error(`exit ${c} before ready: ${err}`)));
		});
		const done = new Promise((resolve, reject) => {
			p.on("error", reject);
			p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}: ${err}`))));
		});
		return { p, ready, done };
	});
	await Promise.all(children.map((c) => c.ready));
	for (const c of children) c.p.stdin.write("go\n");
	await Promise.all(children.map((c) => c.done));
}

test("pins: pin() from two processes at once keeps both processes' entries", async () => {
	const { readFileSync } = await import("node:fs");
	await race([`pin("decide", "1" + i, "a".repeat(64))`, `pin("decide", "2" + i, "b".repeat(64))`]);
	const devices = JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8")).devices;
	assert.equal(Object.keys(devices).length, 80, "no lost updates");
	assert.equal(existsSync(join(pinDir, "pins.lock")), false, "the lock is let go");
});

test("pins: with decision keys pinned and no call key yet, only an already-pinned device's call key pins silently", async () => {
	const { readFileSync } = await import("node:fs");
	const decide = phoneKey();
	const call = phoneKey();
	const rogue = phoneKey();
	const asked = [];
	const confirm = (title) => { asked.push(title); return new Promise(() => {}); }; // left open
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: {} }));
	chmodSync(keysFile, 0o600);
	const { m } = await ownerWith({ ui: { confirm } });
	assert.equal((await sayAs(decide, 7, "one")).ok, true, "the first pairing pins silently");
	const pins = () => JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8"));
	assert.deepEqual(pins().call_devices, {}, "Eric never called");

	// A compromised Botsun adds a call key under a device id of its own.
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") },
		call_devices: { 7: call.raw.toString("base64"), 999: rogue.raw.toString("base64") } }));
	const wav = sha("RIFF…audio");
	const callAs = async (key, deviceId, text) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(key, nonce, "session", "say_audio", wav, { deviceId: String(deviceId) });
		return ask({ type: "say_audio", text, nonce, device_id: deviceId, sig_v: 2, wav_sha256: wav, signature });
	};
	assert.equal((await callAs(rogue, 999, "injected")).error, "new device: confirm at the keyboard");
	assert.equal(pins().call_devices["999"], undefined, "not pinned silently");
	await until(() => asked.length === 1);
	assert.match(asked[0], /new phone device 999 \(call key\)/);
	assert.equal((await callAs(call, 7, "hi")).ok, true, "device 7's first call key pins silently");
	assert.ok(pins().call_devices["7"], "pinned");
	assert.deepEqual(m.sent.map((s) => s.content), ["one", "hi"]);
});

test("pins: a stale lock is taken over; a held lock refuses after the wait; a fresh lock moved aside is put back", async () => {
	const { readFileSync, utimesSync, mkdirSync: mk } = await import("node:fs");
	const { breakStaleLock, LOCK_STALE_MS } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	mk(pinDir, { mode: 0o700 });
	const lock = join(pinDir, "pins.lock");
	writeFileSync(lock, "12345 someone\n", { mode: 0o600 });
	assert.equal((await sayAs(key, 7, "held")).error, "couldn't record the device's key pin", "a held lock refuses, never opens");
	assert.equal(existsSync(join(pinDir, "pins.json")), false);
	assert.equal(readFileSync(lock, "utf8"), "12345 someone\n", "the holder's lock is left alone");

	const old = (Date.now() - LOCK_STALE_MS - 5000) / 1000;
	utimesSync(lock, old, old); // its writer crashed
	assert.equal((await sayAs(key, 7, "stale")).ok, true, "a stale lock is broken");
	assert.equal(existsSync(lock), false, "and the new one let go");
	assert.deepEqual(m.sent.map((s) => s.content), ["stale"]);

	// Two waiters judged the same stale lock; the other broke it and took a fresh one meanwhile.
	writeFileSync(lock, "222 fresh\n", { mode: 0o600 });
	assert.equal(breakStaleLock(lock, "111 stale\n"), false, "another lock than the one judged: back off");
	assert.equal(readFileSync(lock, "utf8"), "222 fresh\n", "put back");
	assert.equal(breakStaleLock(lock, "222 fresh\n"), false, "the same lock, but fresh: back off");
	assert.equal(readFileSync(lock, "utf8"), "222 fresh\n", "put back");
	utimesSync(lock, old, old);
	assert.equal(breakStaleLock(lock, "222 fresh\n"), true, "the stale lock judged");
	assert.equal(existsSync(lock), false);
	assert.deepEqual(readdirSync(pinDir).filter((f) => f.includes("stale")), [], "nothing left aside");
});

test("pins: after any no, no pin dialog for 2 minutes; at most 3 pin dialogs per 10 minutes", async () => {
	const { PIN_QUIET_MS, PIN_DIALOG_WINDOW_MS } = await import("../extensions/opt-in/botsun-owner/index.ts");
	const keys = Object.fromEntries([7, 8, 9, 10, 11].map((id) => [id, phoneKey()]));
	const asked = [];
	const answers = [];
	const confirm = (title) => { asked.push(title); return new Promise((r) => answers.push(r)); };
	writeKeys(Object.fromEntries(Object.entries(keys).map(([id, k]) => [id, k.raw.toString("base64")])));
	await ownerWith({ ui: { confirm } });
	assert.equal((await sayAs(keys[7], 7, "one")).ok, true);
	const newDevice = "new device: confirm at the keyboard";

	assert.equal((await sayAs(keys[8], 8, "x")).error, newDevice);
	await until(() => asked.length === 1);
	answers[0](false); // no
	await sleep(20);
	assert.equal((await sayAs(keys[9], 9, "x")).error, newDevice);
	await sleep(20);
	assert.equal(asked.length, 1, "another device gets no dialog right after a no");
	await later(PIN_QUIET_MS - 5000, async () => {
		assert.equal((await sayAs(keys[9], 9, "x")).error, newDevice);
		await sleep(20);
		assert.equal(asked.length, 1, "still quiet");
	});
	await later(PIN_QUIET_MS + 1000, async () => {
		assert.equal((await sayAs(keys[9], 9, "x")).error, newDevice);
		await until(() => asked.length === 2);
		answers[1](true);
		await sleep(20);
		assert.equal((await sayAs(keys[10], 10, "x")).error, newDevice);
		await until(() => asked.length === 3);
		answers[2](true);
		await sleep(20);
		assert.equal((await sayAs(keys[11], 11, "x")).error, newDevice);
		await sleep(20);
		assert.equal(asked.length, 3, "a fourth dialog in 10 minutes is refused without one");
	});
	await later(PIN_DIALOG_WINDOW_MS + 1000, async () => {
		assert.equal((await sayAs(keys[11], 11, "x")).error, newDevice);
		await until(() => asked.length === 4);
	});
	assert.deepEqual(asked.slice(1, 4), ["Botsun: new phone device 9 (key)", "Botsun: new phone device 10 (key)", "Botsun: new phone device 11 (key)"]);
});

test("v2 answer refused before the signature check still spends the nonce", async () => {
	const { offerPrompt, canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	await owner();
	const questions = [{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }];
	const offered = offerPrompt(questions);
	const answers = [{ picks: [1] }];
	const signedAnswer = (nonce) => signV2(key, nonce, "answer", "answer", canonicalAnswerV2(offered.id, questions, answers));

	let { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "answer", ask_id: "gone", answers, nonce, device_id: 7, sig_v: 2, signature: "x" })).error,
		"that question was already answered");
	assert.equal((await ask({ type: "answer", ask_id: offered.id, answers, nonce, device_id: 7, sig_v: 2, signature: signedAnswer(nonce) })).error,
		"nonce is expired or used", "a gone prompt spends it");

	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [0, 1] }], nonce, device_id: 7, sig_v: 2, signature: "x" })).error,
		"one answer for a single-choice question");
	assert.equal((await ask({ type: "answer", ask_id: offered.id, answers, nonce, device_id: 7, sig_v: 2, signature: signedAnswer(nonce) })).error,
		"nonce is expired or used", "an invalid answer spends it");

	({ nonce } = await ask({ type: "nonce" }));
	assert.deepEqual(await ask({ type: "answer", ask_id: offered.id, answers, nonce, device_id: 7, sig_v: 2, signature: signedAnswer(nonce) }), { ok: true });
	offered.dispose();
});

// ---- The v2 ratchet (sign-versions.json) ------------------------------------

const signVersionsFile = () => join(pinDir, "sign-versions.json");
const readSignVersions = async () => JSON.parse((await import("node:fs")).readFileSync(signVersionsFile(), "utf8")).sign_versions;

test("ratchet: after a device's first v2, its v1 (either key) is refused; an un-ratcheted device's v1 still works", async () => {
	const { readFileSync, statSync } = await import("node:fs");
	const { keyFingerprint, pin } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const a = phoneKey();
	const b = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: a.raw.toString("base64"), 8: b.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	pin("decide", "7", keyFingerprint(a.raw));
	pin("decide", "8", keyFingerprint(b.raw));
	pin("call", "7", keyFingerprint(call.raw));
	const m = await owner();
	const v1 = async (key, deviceId, text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: deviceId, signature: signed(key, deviceId, nonce, "sid-a", text) });
	};
	assert.equal((await v1(a, 7, "v1 before")).ok, true);
	assert.equal(existsSync(signVersionsFile()), false, "v1 doesn't ratchet");
	assert.equal((await sayAs(a, 7, "v2")).ok, true);
	assert.equal((await readSignVersions())["7"].sign_version, 2, "recorded in sign-versions.json");
	assert.equal(statSync(signVersionsFile()).mode & 0o777, 0o600);
	assert.equal(JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8")).sign_versions, undefined, "not in pins.json");
	assert.equal((await v1(a, 7, "downgrade")).error, "this phone signs v2: v1 is refused (update Botsun and the app)");
	assert.equal((await v1(b, 8, "other device")).ok, true, "device 8 never signed v2");
	const wav = sha("RIFF…audio");
	const { nonce } = await ask({ type: "nonce" });
	const spoken = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav].join("\n");
	const sig = cryptoSign("sha256", Buffer.from(spoken), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
	assert.match((await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, wav_sha256: wav, signature: sig })).error, /^this phone signs v2/,
		"the call key shares the device's ratchet");
	assert.deepEqual(m.sent.map((s) => s.content), ["v1 before", "v2", "other device"]);
});

test("ratchet: survives a reload and an old session's pins.json rewrite; a malformed or loose file refuses", async () => {
	const { readFileSync } = await import("node:fs");
	const { pin, signVersionOf } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	await owner();
	assert.equal((await sayAs(key, 7, "v2")).ok, true);
	await cleanups.pop()(); // quit this session
	pin("decide", "9", "c".repeat(64)); // another write of pins.json
	// A session still on the pins.ts from before the ratchet rewrites pins.json with only what it knows.
	const pinsFile = join(pinDir, "pins.json");
	const { devices, call_devices } = JSON.parse(readFileSync(pinsFile, "utf8"));
	writeFileSync(pinsFile, JSON.stringify({ version: 1, devices, call_devices }));
	assert.equal(signVersionOf("7"), 2);
	await owner(); // a fresh instance (reload/restart) reads it back
	const { nonce } = await ask({ type: "nonce" });
	assert.match((await ask({ type: "say", text: "x", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "x") })).error, /^this phone signs v2/);
	const file = signVersionsFile();
	const raw = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...raw, sign_versions: { 7: { sign_version: 1 } } }));
	assert.equal((await sayAs(key, 7, "x")).error, "device pins sign-versions file is malformed", "not a quiet un-ratchet");
	writeFileSync(file, "{");
	const { nonce: n2 } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say", text: "x", nonce: n2, device_id: 7, signature: signed(key, 7, n2, "sid-a", "x") })).error,
		"device pins sign-versions file is malformed", "v1 too");
	writeFileSync(file, JSON.stringify(raw));
	chmodSync(file, 0o644);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins sign-versions file must be a regular 0600 file/);
});

test("ratchet: pin() and ratchet() from three processes at once keep every pin and ratchet", async () => {
	const { readFileSync } = await import("node:fs");
	await race([`pin("decide", "p" + i, "a".repeat(64))`, `ratchet("r" + i)`, `ratchet("s" + i)`]);
	assert.equal(Object.keys(JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8")).devices).length, 40, "every pin");
	assert.equal(Object.keys(await readSignVersions()).length, 80, "every ratchet");
	assert.equal(existsSync(join(pinDir, "pins.lock")), false);
});

test("ratchet: a v2 request from a new device (once one is pinned) is refused and ratchets nothing", async () => {
	const a = phoneKey();
	const rogue = phoneKey();
	const asked = [];
	const confirm = (title) => { asked.push(title); return new Promise(() => {}); }; // left open
	writeKeys({ 7: a.raw.toString("base64") });
	const { m } = await ownerWith({ ui: { confirm } });
	const { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say", text: "v1 first", nonce, device_id: 7, signature: signed(a, 7, nonce, "sid-a", "v1 first") })).ok, true,
		"the first pairing (v1: no ratchet)");
	writeKeys({ 7: a.raw.toString("base64"), 9: rogue.raw.toString("base64") });
	assert.equal((await sayAs(rogue, 9, "injected")).error, "new device: confirm at the keyboard");
	await until(() => asked.length === 1);
	assert.equal(existsSync(signVersionsFile()), false, "no ratchet for an unpinned device");
	assert.deepEqual(m.sent.map((s) => s.content), ["v1 first"]);
});

test("ratchet: a ratchet that can't be recorded refuses the v2 request (a held lock, a failed write)", async () => {
	const fs = (await import("node:fs")).default;
	const { syncBuiltinESMExports } = await import("node:module");
	const { keyFingerprint, pin } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	pin("decide", "7", keyFingerprint(key.raw)); // pinned already: the pin check needs no lock
	const m = await owner();
	const lock = join(pinDir, "pins.lock");
	writeFileSync(lock, "12345 someone\n", { mode: 0o600 });
	assert.equal((await sayAs(key, 7, "locked")).error, "couldn't record the device's signing version", "past the lock wait");
	assert.equal(existsSync(signVersionsFile()), false);
	rmSync(lock);

	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (String(to).endsWith("sign-versions.json")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		return rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		assert.equal((await sayAs(key, 7, "unwritable")).error, "couldn't record the device's signing version", "a write that fails");
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
	assert.equal(existsSync(signVersionsFile()), false);
	assert.deepEqual(readdirSync(pinDir).filter((f) => f.endsWith(".tmp")), [], "the temp file is cleaned up");
	assert.equal((await sayAs(key, 7, "ok")).ok, true);
	assert.deepEqual(m.sent.map((s) => s.content), ["ok"]);
});

test("ratchet: a v1 reply held before the device's first v2 can't be confirmed after it", async () => {
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	m.ctx.isIdle = () => true;
	const { proposalTextHash } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const wav = sha("RIFF…audio");
	const proposal = proposalTextHash("Run the tests.");
	const holdV1 = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		const lines = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav, proposal];
		const signature = cryptoSign("sha256", Buffer.from(lines.join("\n")), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
		return ask({ type: "say_audio", text, nonce, device_id: 7, wav_sha256: wav, signature, hold: true, proposal_sha256: proposal });
	};
	const confirm = (id) => ask({ type: "confirm", id, text: "Run the tests.", mode: "steer" });
	const before = await holdV1("yes");
	const stale = await holdV1("yeah do it");
	assert.ok(before.held && stale.held);
	assert.deepEqual(await confirm(before.held), { ok: true, delivered: "prompt" }, "before the ratchet, a v1 yes counts");

	const { nonce } = await ask({ type: "nonce" });
	const signature = signV2(call, nonce, "session", "say_audio", wav);
	assert.equal((await ask({ type: "say_audio", text: "hello", nonce, device_id: 7, sig_v: 2, wav_sha256: wav, signature })).ok, true, "device 7 signs v2");
	assert.equal((await readSignVersions())["7"].sign_version, 2);
	assert.equal((await confirm(stale.held)).error, "this phone signs v2: v1 is refused (update Botsun and the app)");
	assert.equal((await confirm(stale.held)).error, `not waiting: ${stale.held}`, "spent");
});

// ---- v3 (botsun-sign-v3: v2 plus this host's authority) ---------------------

const HOST = "botsun.boehs.com:8443";
/** A v3 signature: "botsun-sign-v3", the host, then v2's lines. */
function signV3(key, nonce, kind, decision, payload, { host = HOST, scope = "sid-a", deviceId = "7" } = {}) {
	const msg = ["botsun-sign-v3", host, deviceId, nonce, kind, scope, decision, sha(payload)].join("\n");
	return cryptoSign("sha256", Buffer.from(msg, "utf8"), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
}

function writeKeysWithHost(devices, host = HOST, extra = {}) {
	writeFileSync(keysFile, JSON.stringify({ ...(host === null ? {} : { host }), devices, ...extra }));
	chmodSync(keysFile, 0o600);
}

/** A v3 say from device id, signed with key for host. */
async function sayV3(key, text, { host = HOST, deviceId = 7 } = {}) {
	const { nonce } = await ask({ type: "nonce" });
	const signature = signV3(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`, { host, deviceId: String(deviceId) });
	return ask({ type: "say", text, nonce, device_id: deviceId, sig_v: 3, signature });
}

test("v3: verifies against owner-keys.json's host; a signature for another host, or as v2, is refused", async () => {
	const key = phoneKey();
	writeKeysWithHost({ 7: key.raw.toString("base64") });
	const m = await owner();
	// Idle for the says below (a session that isn't idle and isn't running is a compaction's shape),
	// then busy for the stop.
	let idle = true;
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => {};
	const { features } = await ask({ type: "nonce" });
	assert.ok(features.includes("sign_v3"));
	assert.equal((await sayV3(key, "elsewhere", { host: "coop.botsun.boehs.com:8443" })).error, "signature does not verify", "another host's signature");
	let { nonce } = await ask({ type: "nonce" });
	const v2sig = signV2(key, nonce, "session", "say", "botsun-propose-text-v1\nas v2");
	assert.equal((await ask({ type: "say", text: "as v2", nonce, device_id: 7, sig_v: 3, signature: v2sig })).error, "signature does not verify", "a v2 signature isn't v3");
	({ nonce } = await ask({ type: "nonce" }));
	const v3sig = signV3(key, nonce, "session", "say", "botsun-propose-text-v1\nas v3");
	assert.equal((await ask({ type: "say", text: "as v3", nonce, device_id: 7, sig_v: 2, signature: v3sig })).error, "signature does not verify", "nor a v3 one v2");
	assert.equal(existsSync(signVersionsFile()), false, "nothing ratcheted yet");
	assert.deepEqual(await sayV3(key, "here"), { ok: true, delivered: "prompt" });
	assert.equal(m.sent.at(-1).content, "here");
	assert.equal((await readSignVersions())["7"].sign_version, 3);
	({ nonce } = await ask({ type: "nonce" }));
	idle = false;
	assert.deepEqual(await ask({ type: "stop", nonce, device_id: 7, sig_v: 3, signature: signV3(key, nonce, "session", "stop", "stop") }), { ok: true, stopped: true });
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "stop", nonce, device_id: 7, sig_v: 3, signature: signV3(key, nonce, "session", "stop", "stop", { scope: "sid-b" }) })).error,
		"signature does not verify", "still scoped to this session");
	let shutdowns = 0;
	m.ctx.shutdown = () => shutdowns++;
	({ nonce } = await ask({ type: "nonce" }));
	assert.deepEqual(await ask({ type: "close", nonce, device_id: 7, sig_v: 3, signature: signV3(key, nonce, "session", "close", "close") }), { ok: true },
		"close's v2-only means v2 or newer");
	await until(() => shutdowns === 1);
});

test("v3: refused when owner-keys.json has no host, or not a valid one (v2 still works)", async () => {
	const key = phoneKey();
	writeKeysWithHost({ 7: key.raw.toString("base64") }, null); // no "host" at all
	const m = await owner();
	assert.equal((await sayV3(key, "x")).error, "owner-keys.json has no valid host: v3 is refused (update Botsun)");
	for (const host of ["Botsun.Boehs.com:8443", "botsun.boehs.com", `${HOST}\nevil.example:8443`, 8443]) {
		writeKeysWithHost({ 7: key.raw.toString("base64") }, host);
		assert.equal((await sayV3(key, "x", { host: String(host) })).error, "owner-keys.json has no valid host: v3 is refused (update Botsun)", String(host));
	}
	assert.equal(existsSync(signVersionsFile()), false, "a refused v3 ratchets nothing");
	assert.equal((await sayAs(key, 7, "v2")).ok, true);
	assert.deepEqual(m.sent.map((s) => s.content), ["v2"]);
});

test("v3 ratchet: 2 goes to 3 on the first verified v3; then v2 and v1 (either key) are refused", async () => {
	const { readFileSync } = await import("node:fs");
	const { keyFingerprint, pin, signVersionOf, ratchet } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const key = phoneKey();
	const call = phoneKey();
	writeKeysWithHost({ 7: key.raw.toString("base64") }, HOST, { call_devices: { 7: call.raw.toString("base64") } });
	pin("decide", "7", keyFingerprint(key.raw));
	pin("call", "7", keyFingerprint(call.raw));
	const m = await owner();
	assert.equal((await sayAs(key, 7, "v2")).ok, true);
	assert.equal((await readSignVersions())["7"].sign_version, 2);
	assert.equal((await sayV3(key, "v3", { host: "coop.botsun.boehs.com:8443" })).error, "signature does not verify");
	assert.equal((await readSignVersions())["7"].sign_version, 2, "a v3 that doesn't verify doesn't ratchet");
	assert.equal((await sayV3(key, "v3")).ok, true);
	assert.equal((await readSignVersions())["7"].sign_version, 3);
	assert.equal((await sayAs(key, 7, "v2 again")).error, "this phone signs v3: v2 is refused (update Botsun and the app)");
	let { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say", text: "v1", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "v1") })).error,
		"this phone signs v3: v1 is refused (update Botsun and the app)");
	({ nonce } = await ask({ type: "nonce" }));
	const wav = sha("RIFF…audio");
	assert.equal((await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, sig_v: 2, wav_sha256: wav, signature: signV2(call, nonce, "session", "say_audio", wav) })).error,
		"this phone signs v3: v2 is refused (update Botsun and the app)", "the call key shares the ratchet");
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, sig_v: 3, wav_sha256: wav, signature: signV3(call, nonce, "session", "say_audio", wav) })).ok, true);
	ratchet("7", 2);
	assert.equal(signVersionOf("7"), 3, "a ratchet never goes down");
	const file = signVersionsFile();
	writeFileSync(file, JSON.stringify({ version: 1, sign_versions: { 7: { sign_version: 4 } } }));
	assert.equal((await sayV3(key, "x")).error, "device pins sign-versions file is malformed");
	assert.equal(JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8")).sign_versions, undefined);
	assert.deepEqual(m.sent.map((s) => s.content), ["v2", "v3", "hi"]);
});

test("v3 ratchet: a v2 reply held before the device's first v3 can't be confirmed after it", async () => {
	const call = phoneKey();
	writeKeysWithHost({}, HOST, { call_devices: { 7: call.raw.toString("base64") } });
	const m = await owner();
	m.ctx.isIdle = () => true;
	const { proposalTextHash } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const wav = sha("RIFF…audio");
	const proposal = proposalTextHash("Run the tests.");
	const holdV2 = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(call, nonce, "session", "say_audio", `${wav}\n${proposal}`);
		return ask({ type: "say_audio", text, nonce, device_id: 7, sig_v: 2, wav_sha256: wav, signature, hold: true, proposal_sha256: proposal });
	};
	const confirm = (id) => ask({ type: "confirm", id, text: "Run the tests.", mode: "steer" });
	const before = await holdV2("yes");
	const stale = await holdV2("yeah do it");
	assert.ok(before.held && stale.held, JSON.stringify(before));
	assert.deepEqual(await confirm(before.held), { ok: true, delivered: "prompt" }, "before the v3 ratchet, a v2 yes counts");
	const { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say_audio", text: "hello", nonce, device_id: 7, sig_v: 3, wav_sha256: wav, signature: signV3(call, nonce, "session", "say_audio", wav) })).ok, true);
	assert.equal((await readSignVersions())["7"].sign_version, 3);
	assert.equal((await confirm(stale.held)).error, "this phone signs v3: v2 is refused (update Botsun and the app)");
	assert.ok(m.sent.length >= 1);
});

// ---- Message ids (say_id): a resend never delivers twice --------------------
// test/fixtures/signing-v2.json is a byte-identical copy of Botsun's vectors: the payloads a say's
// own id is signed over, with an id and without one.
const botsunVectors = JSON.parse(readFileSync(new URL("./fixtures/signing-v2.json", import.meta.url), "utf8"));
const botsunVector = (name) => {
	const v = botsunVectors.vectors.find((x) => x.name === name);
	assert.ok(v, `Botsun's vectors have "${name}"`);
	return v;
};
const vectorImages = (v) => (v.inputs?.images ?? []).map((i) => ({ data: i.data, mime_type: i.mime_type }));
const vectorFiles = (v) => (v.inputs?.files ?? []).map((f) => ({ name: f.name, data: f.data }));
// The phone's own id for a message, as Botsun's vectors make one.
const SAID = "0b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";

/** The payload Botsun's OwnerSessions.signed_payload makes for a say (built here, not by the code
 * under test): the text, or the lines v1 hashes, after a v2 magic and the id when there is one. */
function botsunSayPayload(text, clientId, images = [], files = []) {
	const hex = (b) => createHash("sha256").update(b).digest("hex");
	if (!images.length && !files.length) {
		return clientId ? `botsun-propose-text-v2\n${clientId}\n${text}` : `botsun-propose-text-v1\n${text}`;
	}
	const lines = [hex(Buffer.from(text, "utf8")), ...images.map((i) => hex(Buffer.from(i.data, "base64"))),
		...files.map((f) => `file ${hex(Buffer.from(f.name, "utf8"))} ${hex(Buffer.from(f.data, "base64"))}`)].join("\n");
	return clientId ? `botsun-say-attach-v2\n${clientId}\n${lines}` : lines;
}

test("say_id: the payload is Botsun's, with an id and byte for byte the old one without", async () => {
	const { sayDigest } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const digestOf = (payload) => createHash("sha256").update(payload, "utf8").digest("hex");
	for (const name of ["plain text say", "session say_images", "session say_attach, empty text",
		"session say with the phone's message id", "session say_images with the phone's message id"]) {
		const v = botsunVector(name);
		// The oldest vectors have no inputs: "plain text say" is its payload's own text.
		const text = v.inputs?.text ?? v.expect_payload.split("\n").slice(1).join("\n");
		const { payload } = sayDigest(text, vectorImages(v), vectorFiles(v), v.inputs?.client_id);
		assert.equal(payload, v.expect_payload, name);
		assert.equal(digestOf(payload), v.expect_digest, `${name}: the digest Botsun signs`);
	}
	assert.equal(botsunVector("session say with the phone's message id").inputs.client_id, SAID);
	assert.equal(sayDigest("ship it", [], []).payload, "botsun-propose-text-v1\nship it", "no id: the old bytes exactly");
	assert.equal(sayDigest("ship it", [], [], SAID).payload, `botsun-propose-text-v2\n${SAID}\nship it`);
});

test("say_id: a say carrying the phone's id goes in once; a resend answers duplicate", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	assert.ok((await ask({ type: "nonce" })).features.includes("say_id"), "the nonce reply says it takes ids");
	const say = async (text, clientId, { scope = "sid-a" } = {}) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(key, nonce, "session", "say", botsunSayPayload(text, clientId), { scope });
		return ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature, ...(clientId ? { client_id: clientId } : {}) });
	};
	assert.deepEqual(await say("once", SAID), { ok: true, delivered: "prompt" });
	// The same message again (its first answer was lost on the way to the phone).
	assert.deepEqual(await say("once", SAID), { ok: true, delivered: "duplicate" });
	assert.equal(m.sent.length, 1, "the duplicate put nothing in");
	// Its own id is another message, and one with no id is never a duplicate.
	assert.deepEqual(await say("once", "11111111-2222-4333-8444-555555555555"), { ok: true, delivered: "prompt" });
	assert.deepEqual(await say("again"), { ok: true, delivered: "prompt" });
	assert.deepEqual(await say("again"), { ok: true, delivered: "prompt" });
	assert.equal(m.sent.length, 4);
	// The same id with other words (an app bug) is delivered, never dropped as a repeat.
	assert.deepEqual(await say("other words", SAID), { ok: true, delivered: "prompt" });
	assert.equal(m.sent.length, 5);

	// The id is this conversation's: the same one after a /new is another message.
	await m.fire("session_shutdown", { reason: "new" });
	const b = await mount({
		ctx: { sessionManager: { getSessionFile: () => "/tmp/sessions/b.jsonl", getSessionId: () => "sid-b" } },
	});
	await b.fire("session_start", { reason: "new" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	assert.deepEqual(await say("once", SAID, { scope: "sid-b" }), { ok: true, delivered: "prompt" });
	assert.deepEqual(await say("once", SAID, { scope: "sid-b" }), { ok: true, delivered: "duplicate" });
	assert.equal(b.sent.length, 1);
});

test("say_id: a photo message carrying the phone's id goes in once too", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const photo = { data: Buffer.from("fake jpeg bytes").toString("base64"), mime_type: "image/jpeg" };
	const say = async () => {
		const { nonce } = await ask({ type: "nonce" });
		const payload = botsunSayPayload("what's this?", SAID, [photo]);
		return ask({ type: "say", text: "what's this?", images: [photo], client_id: SAID, nonce, device_id: 7, sig_v: 2,
			signature: signV2(key, nonce, "session", "say_images", payload) });
	};
	assert.deepEqual(await say(), { ok: true, delivered: "prompt" });
	assert.deepEqual(m.sent.at(-1).content, [{ type: "text", text: "what's this?" }, { type: "image", data: photo.data, mimeType: "image/jpeg" }]);
	assert.deepEqual(await say(), { ok: true, delivered: "duplicate" }, "a resend of the same photo message");
	assert.equal(m.sent.length, 1, "the duplicate put nothing in");
});

test("say_id: an id swapped, stripped or added is refused, and so is a bad one or v1's", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const other = "11111111-2222-4333-8444-555555555555";
	const post = async (req, payload, clientId) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", nonce, device_id: 7, ...(clientId === undefined ? {} : { client_id: clientId }),
			sig_v: 2, signature: signV2(key, nonce, "session", "say", payload), ...req });
	};
	// Only v2 carries the id in what the phone signed: a v1 signature's id isn't signed at all.
	let { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say", text: "other", client_id: SAID, nonce, device_id: 7,
		signature: signed(key, 7, nonce, "sid-a", "other") })).error, "a message id is signed with v2 or newer");
	// One id signed, another sent (or the id dropped from, or added to, a signed request).
	assert.equal((await post({ text: "other" }, botsunSayPayload("other", SAID), other)).error, "signature does not verify",
		"an id swapped after signing");
	assert.equal((await post({ text: "other" }, botsunSayPayload("other", SAID))).error, "signature does not verify",
		"an id stripped after signing");
	assert.equal((await post({ text: "other" }, botsunSayPayload("other"), SAID)).error, "signature does not verify",
		"an id added after signing");
	// Its shape is checked before the signature (as Botsun refuses them).
	for (const bad of [SAID.toUpperCase(), "not-a-uuid", "", 7]) {
		({ nonce } = await ask({ type: "nonce" }));
		assert.equal((await ask({ type: "say", text: "other", client_id: bad, nonce, device_id: 7, sig_v: 2,
			signature: signV2(key, nonce, "session", "say", botsunSayPayload("other", SAID)) })).error,
		"client_id must be a lowercase UUID", JSON.stringify(bad));
	}
	assert.equal(m.sent.length, 0, "none of the refused ones went in");
});

test("say_id: an id whose delivery was refused isn't recorded, so the next try goes in", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, client_id: SAID, nonce, device_id: 7, sig_v: 2,
			signature: signV2(key, nonce, "session", "say", botsunSayPayload(text, SAID)) });
	};
	assert.equal((await say("/model")).error, "say which model, e.g. /model opus (the picker needs the keyboard)");
	assert.equal(m.sent.length, 0);
	assert.deepEqual(await say("ship it"), { ok: true, delivered: "prompt" }, "the id wasn't recorded by the refused one");
	assert.deepEqual(await say("ship it"), { ok: true, delivered: "duplicate" });
	assert.equal(m.sent.length, 1);
});

test("say_id: a delivery that throws isn't recorded, so the next try goes in", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, client_id: SAID, nonce, device_id: 7, sig_v: 2,
			signature: signV2(key, nonce, "session", "say", botsunSayPayload(text, SAID)) });
	};
	// pi refuses it outright (a throw, not a sentence back): the phone hears a failed request, and the
	// id mustn't be left behind as delivered.
	const inject = conn.inject;
	conn.inject = () => { throw new Error("pi refused the message"); };
	assert.equal((await say("ship it")).error, "bad request");
	conn.inject = inject;
	assert.deepEqual(await say("ship it"), { ok: true, delivered: "prompt" }, "the failed one forgot its id");
	assert.deepEqual(await say("ship it"), { ok: true, delivered: "duplicate" });
	assert.equal(m.sent.length, 1, "delivered once");
});

test("say_id: a video whose frames can't be delivered isn't recorded either", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads-inject-fail");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	fakeFfmpeg();
	const m = await owner();
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	const up = fakeUpload(updir, fakeMp4());
	const videoSay = async () => ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [up]));
	// The frames are injected from a promise of their own, so a throw there doesn't reach the reply:
	// the id must still be forgotten, or the phone's next try is answered "duplicate" and lost.
	const inject = conn.inject;
	conn.inject = () => { throw new Error("pi refused the message"); };
	assert.deepEqual(await videoSay(), { ok: true, delivered: "prompt" }, "the reply doesn't wait for the frames");
	await until(() => (conn.said?.size ?? 0) === 0, 10_000); // the failure forgot the id
	conn.inject = inject;
	assert.deepEqual(await videoSay(), { ok: true, delivered: "prompt" }, "the forgotten id lets the next try in");
	await until(() => m.sent.length === 1, 10_000);
	assert.equal(m.sent.length, 1, "delivered once");
});

test("say_id: a `files:` video whose frames can't be delivered isn't recorded either", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	fakeFfmpeg();
	const m = await owner();
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	// A short video sent as a file (not a long-video upload): its frames are injected from a promise
	// of their own, so a throw there never reaches the reply.
	const video = { name: "IMG_1234.mp4", data: fakeMp4().toString("base64") };
	const videoSay = async () => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text: "the clip", files: [video], client_id: SAID, nonce, device_id: 7, sig_v: 2,
			signature: signV2(key, nonce, "session", "say_attach", botsunSayPayload("the clip", SAID, [], [video])) });
	};
	const inject = conn.inject;
	conn.inject = () => { throw new Error("pi refused the message"); };
	assert.deepEqual(await videoSay(), { ok: true, delivered: "prompt" }, "the reply doesn't wait for the frames");
	await until(() => (conn.said?.size ?? 0) === 0, 10_000); // the failure forgot the id
	conn.inject = inject;
	assert.deepEqual(await videoSay(), { ok: true, delivered: "prompt" }, "the forgotten id lets the next try in");
	await until(() => m.sent.length === 1, 10_000);
	assert.equal(m.sent.length, 1, "delivered once");
});

// ---- Subagents (lib/children.ts): the session's children to Botsun, and the phone's stop ----

const kids = await import("../lib/children.ts");

test("subagents: a start or an end goes at once, progress at most once a second, only this session's", async () => {
	kids.resetChildren();
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const subs = () => srv.lines.filter((l) => l.type === "subagents");
	assert.equal(subs().length, 0, "nothing to say: no line");
	const c = kids.trackChild({ kind: "pi", agent: "scout", task: "look around", model: "anthropic/claude", sessionId: "sid-a" });
	await until(() => subs().length === 1);
	const [child] = subs()[0].children;
	assert.deepEqual(Object.keys(child).sort(), ["activity", "agent", "id", "kind", "last_text", "model", "started_at", "state", "tail", "task", "title", "turns"]);
	assert.deepEqual([child.id, child.kind, child.agent, child.task, child.state, child.turns], [c.id, "pi", "scout", "look around", "running", 0]);
	assert.equal(child.title, "look around", "no title given: derived from the task");
	assert.equal(typeof child.started_at, "number");
	kids.trackChild({ kind: "pi", agent: "other", task: "t", sessionId: "sid-b" });
	await sleep(50);
	assert.equal(subs().length, 1, "another session's child is not this session's news");
	c.piEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "/x/a.rb" } });
	c.piEvent({ type: "tool_execution_end", toolCallId: "1", toolName: "read" });
	c.piEvent({ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "bin/test" } });
	await sleep(300);
	assert.equal(subs().length, 1, "progress waits for the debounce");
	await until(() => subs().length === 2, 2000);
	const moved = subs()[1].children[0];
	assert.deepEqual([moved.activity, moved.tail], ["Ran bin/test", ["Read a.rb", "Ran bin/test"]], "one line, the latest");
	c.finish("done", { lastText: "All fine" });
	await until(() => subs().length === 3, 300);
	const done = subs()[2].children[0];
	assert.deepEqual([done.state, done.last_text, typeof done.ended_at], ["done", "All fine", "number"]);
	assert.equal(done.usage, undefined);
	// A turn's usage and the model's window ride along, for the phone's context bar.
	const withCtx = kids.trackChild({ kind: "pi", agent: "worker", task: "t", model: "anthropic/claude", window: 200_000, sessionId: "sid-a" });
	withCtx.piEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 } },
	});
	await until(() => subs().some((l) => l.children.some((k) => k.id === withCtx.id && k.context !== undefined)), 3000);
	const moved2 = subs().at(-1).children.find((k) => k.id === withCtx.id);
	assert.deepEqual([moved2.context, moved2.window], [1_000, 200_000], "the last turn's context and its window");
	kids.resetChildren();
});

test("subagentsLine keeps the line under the host's limit, running children's tails last to go", async () => {
	const { subagentsLine, SUBAGENTS_BYTES } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const kid = (i, state) => ({
		id: `p-${String(i).padStart(10, "0")}`, kind: "pi", agent: "worker", task: "t".repeat(200), state, startedAt: 1, turns: 3,
		activity: "a".repeat(120), lastText: "x".repeat(600), tail: Array.from({ length: 30 }, () => "y".repeat(160)), sessionId: "s",
		...(state === "running" ? {} : { endedAt: 2 }), usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, context: 1_234, cost: 0.5 }, window: 200_000,
	});
	const all = [...Array.from({ length: 8 }, (_, i) => kid(i, "done")), ...Array.from({ length: 8 }, (_, i) => kid(i + 8, "running"))];
	const line = subagentsLine(all);
	assert.ok(Buffer.byteLength(JSON.stringify(line)) <= SUBAGENTS_BYTES);
	assert.equal(line.length, 16, "everyone stays; their tails shrink");
	const tails = (state) => line.filter((k) => k.state === state).map((k) => k.tail.length);
	assert.ok(Math.min(...tails("running")) > Math.max(...tails("done")));
	assert.deepEqual(line[0].usage, { input: 1, output: 2, cache_read: 3, cache_write: 4, cost: 0.5 });
	assert.deepEqual([line[0].context, line[0].window], [1_234, 200_000], "what the phone's context bar reads");
	const bare = subagentsLine([{ ...kid(0, "running"), window: undefined, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }])[0];
	assert.deepEqual([bare.context, bare.window], [undefined, undefined], "nothing known: both left out");
	assert.equal(bare.title, undefined, "no title (an older children store): none on the wire");
	const titled = subagentsLine([{ ...kid(0, "running"), title: "Work log order" }])[0];
	assert.deepEqual([titled.title, titled.task], ["Work log order", "t".repeat(200)], "the title rides beside the whole task");
	assert.deepEqual(subagentsLine(all.slice(0, 2)).map((k) => k.tail.length), [30, 30], "a small list goes whole");
	const tiny = subagentsLine(all, 2_000);
	assert.ok(tiny.length > 0 && tiny.length < 16 && tiny.every((k) => k.state === "running"), "past it, finished ones drop first");
});

test("stop_child: Eric's phone, signed v2, stops only this session's child", async () => {
	kids.resetChildren();
	const decide = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	await owner();
	let aborts = 0;
	const mine = kids.trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "sid-a", stop: () => aborts++ });
	const theirs = kids.trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "sid-b", stop: () => assert.fail("another session's child") });
	const stop = async (id, { key = decide, signedId = id } = {}) => {
		const { nonce, features } = await ask({ type: "nonce" });
		assert.ok(features.includes("subagents"));
		return ask({ type: "stop_child", child_id: id, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stop_child", `stop_child\n${signedId}`) });
	};
	assert.equal((await stop(mine.id, { key: phoneKey() })).error, "signature does not verify");
	// v1 (a signature that verifies, from a device that hasn't ratcheted yet): refused, after its check.
	const { nonce: n1 } = await ask({ type: "nonce" });
	const digest = createHash("sha256").update(`stop_child\n${mine.id}`, "utf8").digest("hex");
	const msg = ["botsun-decide-v1", "7", n1, "session", "sid-a", "stop_child", digest].join("\n");
	const v1 = { type: "stop_child", child_id: mine.id, nonce: n1, device_id: 7, signature: cryptoSign("sha256", Buffer.from(msg), { key: decide.privateKey, dsaEncoding: "der" }).toString("base64") };
	assert.match((await ask(v1)).error ?? "", /^stop_child needs a v2 signature/);
	assert.equal((await stop(mine.id, { signedId: theirs.id })).error, "signature does not verify", "signed for another child");
	assert.equal((await stop(theirs.id)).error, "no such subagent in this session");
	assert.equal((await ask({ type: "stop_child", child_id: "../x", nonce: "n", device_id: 7 })).error, "bad request");
	assert.equal((await stop("..")).error, "bad request", "never a path's folder, signed or not");
	assert.equal((await ask({ type: "stop_child", child_id: mine.id })).error, "bad request", "unsigned");
	assert.equal(aborts, 0);
	assert.deepEqual(await stop(mine.id), { ok: true, stopped: true });
	assert.equal(aborts, 1);
	mine.finish("failed");
	assert.equal(kids.listChildren("sid-a")[0].state, "stopped");
	assert.deepEqual(await stop(mine.id), { ok: true, stopped: false }, "already ended");
	kids.resetChildren();
});

test("stop_job: Eric's phone, signed v2, stops only this session's bg job, through bg:kill", async () => {
	const decide = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	// bg.ts's side, as it answers them.
	const jobs = [{ id: "a1b2c3", command: "sleep 99" }, { id: "dddddd", command: "true", endedAt: 5 }];
	const kills = [];
	m.pi.events.on("bg:list", (d) => d.reply(jobs.map((j) => ({ ...j }))));
	m.pi.events.on("bg:kill", (req) => { req.accepted = true; kills.push({ id: req.id, wake: req.wake }); req.reply({ killed: true }); });
	const stop = async (id, { key = decide, signedId = id } = {}) => {
		const { nonce, features } = await ask({ type: "nonce" });
		assert.ok(features.includes("jobs"));
		return ask({ type: "stop_job", job_id: id, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stop_job", `stop_job\n${signedId}`) });
	};
	assert.equal((await stop("a1b2c3", { key: phoneKey() })).error, "signature does not verify");
	const { nonce: n1 } = await ask({ type: "nonce" });
	const digest = createHash("sha256").update("stop_job\na1b2c3", "utf8").digest("hex");
	const msg = ["botsun-decide-v1", "7", n1, "session", "sid-a", "stop_job", digest].join("\n");
	const v1 = { type: "stop_job", job_id: "a1b2c3", nonce: n1, device_id: 7, signature: cryptoSign("sha256", Buffer.from(msg), { key: decide.privateKey, dsaEncoding: "der" }).toString("base64") };
	assert.match((await ask(v1)).error ?? "", /^stop_job needs a v2 signature/);
	assert.equal((await stop("a1b2c3", { signedId: "eeeeee" })).error, "signature does not verify", "signed for another job");
	assert.equal((await stop("eeeeee")).error, "no such job in this session");
	assert.equal((await stop("..")).error, "bad request", "never a path's folder");
	assert.equal((await ask({ type: "stop_job", job_id: "a1b2c3" })).error, "bad request", "unsigned");
	assert.deepEqual(kills, []);
	assert.deepEqual(await stop("dddddd"), { ok: true, stopped: false }, "already ended: not an error, nothing killed");
	assert.deepEqual(kills, []);
	assert.deepEqual(await stop("a1b2c3"), { ok: true, stopped: true });
	assert.deepEqual(kills, [{ id: "a1b2c3", wake: true }], "the model hears it was killed");
	const { nonce } = await ask({ type: "nonce" });
	const sig = signV2(decide, nonce, "session", "stop_job", "stop_job\na1b2c3");
	await ask({ type: "stop_job", job_id: "a1b2c3", nonce, device_id: 7, sig_v: 2, signature: sig });
	assert.equal((await ask({ type: "stop_job", job_id: "a1b2c3", nonce, device_id: 7, sig_v: 2, signature: sig })).error, "nonce is expired or used", "one try per nonce");
});

test("child_transcript: a page of this session's subagent's conversation, unsigned, never another session's", async () => {
	kids.resetChildren();
	await owner();
	const mine = kids.trackChild({ kind: "pi", agent: "scout", task: "look around", sessionId: "sid-a" });
	const theirs = kids.trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "sid-b" });
	mine.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x/a.rb" } }] } });
	mine.piEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] } });
	mine.piEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Half a" }] } });
	assert.ok((await ask({ type: "nonce" })).features.includes("subagent_chats"));
	const page = await ask({ type: "child_transcript", child_id: mine.id, since: -1 });
	assert.deepEqual(Object.keys(page).sort(), ["entries", "last", "live", "more", "ok", "state"]);
	assert.deepEqual([page.ok, page.last, page.more, page.live, page.state], [true, 2, false, "Half a", "running"]);
	assert.deepEqual(page.entries.map((e) => [e.seq, e.message.role]), [[0, "user"], [1, "assistant"], [2, "toolResult"]]);
	assert.deepEqual((await ask({ type: "child_transcript", child_id: mine.id, since: 1 })).entries.map((e) => e.seq), [2], "past since only");
	assert.deepEqual((await ask({ type: "child_transcript", child_id: mine.id, since: "x" })).entries.length, 3, "a bad since is from the start");
	assert.equal((await ask({ type: "child_transcript", child_id: theirs.id })).error, "no such subagent in this session");
	assert.equal((await ask({ type: "child_transcript", child_id: "../x" })).error, "bad request");
	assert.equal((await ask({ type: "child_transcript" })).error, "bad request");

	// The worst a page carries: its entries' bytes and the live reply, all three bytes a character.
	for (let i = 0; i < 40; i++) {
		mine.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `w${i}`, name: "read", arguments: { path: "界".repeat(1_500) } }] } });
		mine.piEvent({ type: "tool_execution_end", toolCallId: `w${i}`, toolName: "read", result: { content: [{ type: "text", text: "界".repeat(5_000) }] } });
	}
	mine.piEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "界".repeat(20_000) }] } });
	const full = await ask({ type: "child_transcript", child_id: mine.id, since: 2 });
	assert.ok(full.more && full.live.length > 3_000);
	assert.ok(Buffer.byteLength(JSON.stringify(full)) < 64 * 1024, "one line under the socket's limit");
	kids.resetChildren();
});

const QUIET_STATE = Symbol.for("pi-boehsline.quiet");

test("busy carries quiet, repeats when a run flips, and an attention line follows quiet:attention", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));

	globalThis[QUIET_STATE] = { quiet: true, attention: null };
	await m.fire("agent_start");
	await until(() => srv.lines.some((line) => line.type === "busy"));
	assert.equal(srv.lines.find((line) => line.type === "busy").quiet, true, "a background run is announced as quiet");

	m.pi.events.emit("quiet:run", { quiet: false });
	await until(() => srv.lines.filter((line) => line.type === "busy").length >= 2);
	assert.equal(srv.lines.filter((line) => line.type === "busy").at(-1).quiet, false, "Eric's steer repeats busy");

	const attention = { kind: "ready", text: "Try the build", at: 1, source: "classifier" };
	m.pi.events.emit("quiet:attention", attention);
	await until(() => srv.lines.some((line) => line.type === "attention"));
	assert.deepEqual(srv.lines.find((line) => line.type === "attention").attention, attention);

	m.pi.events.emit("quiet:attention", null);
	await until(() => srv.lines.filter((line) => line.type === "attention").length >= 2);
	assert.equal(srv.lines.filter((line) => line.type === "attention").at(-1).attention, null, "cleared when Eric's input comes");
	delete globalThis[QUIET_STATE];
});

test("a split settles his run (idle) and starts a quiet one marked split, once", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));

	globalThis[QUIET_STATE] = { quiet: false, attention: null };
	await m.fire("agent_start");
	await until(() => srv.lines.some((line) => line.type === "busy"));
	m.pi.events.emit("quiet:split", { quiet: true });
	m.pi.events.emit("quiet:run", { quiet: true }); // the quiet extension's flip right after: no third busy
	await until(() => srv.lines.filter((line) => line.type === "busy").length >= 2);
	const tail = srv.lines.filter((line) => ["busy", "idle"].includes(line.type)).map((line) => [line.type, line.quiet, line.split]);
	assert.deepEqual(tail, [["busy", false, undefined], ["idle", undefined, undefined], ["busy", true, true]]);
	m.pi.events.emit("quiet:split", { quiet: true });
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(srv.lines.filter((line) => line.type === "busy").length, 2, "an already-quiet run isn't split again");
	delete globalThis[QUIET_STATE];
});

test("every sendUser marks its next input as Eric's before sending it", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const order = [];
	m.pi.events.on("quiet:mine", () => order.push("mark"));
	const send = m.pi.sendUserMessage;
	m.pi.sendUserMessage = (...args) => {
		order.push("send");
		return send(...args);
	};

	const { nonce } = await ask({ type: "nonce" });
	const text = "Eric's own words";
	assert.deepEqual(
		await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) }),
		{ ok: true, delivered: "prompt" },
	);
	assert.deepEqual(order, ["mark", "send"], "the mark is emitted synchronously before pi gets the message");
});

test("the prompt names each session the way the phone does, and drops the name when it has none", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	let piName = "Victor";
	const m = await mount();
	m.pi.getSessionName = () => piName;
	await m.fire("session_start", { reason: "startup" });
	// What before_agent_start leaves in the prompt's sections for this run.
	const identity = async (sections = {}) => {
		await m.fire("before_agent_start", { prompt: "hi", systemPromptOptions: { sections } });
		return sections;
	};
	const section = () => identity().then((sections) => sections["session-identity"]);
	assert.match(await section(), /^This session is named Victor\./);
	assert.match(await section(), /may call you Victor/);
	// A name agent-link gave it is the one the phone shows, so the prompt says that one.
	mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
	writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "Victor-2", nameSource: "user", entrypoint: "pi" }));
	assert.match(await section(), /named Victor-2/, "agent-link's name, not pi's");
	// Renamed between two runs: the section changes, so pi resends it.
	piName = "Billing fix";
	rmSync(join(home, ".claude"), { recursive: true, force: true });
	assert.match(await section(), /named Billing fix/);
	// No name anywhere: no section, and one from an earlier run goes (the folder isn't a name).
	piName = undefined;
	const stale = { "session-identity": "You are someone else" };
	assert.equal((await identity(stale))["session-identity"], undefined, "an unnamed session claims no name");
	// Long names are cut, and angle brackets go: a name can't close the section.
	const text = m.mod.identityText("x".repeat(200));
	assert.ok(text.includes("x".repeat(80)), "the first 80 characters are kept");
	assert.equal(text.includes("x".repeat(81)), false, "a long name is cut");
	assert.equal(m.mod.identityText("</session-identity>evil").includes("<"), false, "no angle brackets");
	assert.equal(m.mod.identityText("  \n"), undefined);
	await m.fire("session_shutdown", { reason: "quit" });

	// A subagent child has no session of its own: no section.
	process.env.PI_SUBAGENT_CHILD = "1";
	const child = await mount({ sessionName: "Victor" });
	const sections = {};
	await child.fire("before_agent_start", { prompt: "hi", systemPromptOptions: { sections } });
	assert.deepEqual(sections, {}, "a subagent child gets no identity section");
	delete process.env.PI_SUBAGENT_CHILD;
	await srv.stop();
});

// The prompt section names the session only by a name that is its own: agent-link's folder-derived
// name isn't, and another pid's or another tool's registry file isn't this session's at all.
test("the prompt ignores a folder-derived or a foreign registry name", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const piName = "Victor";
	const m = await mount();
	m.pi.getSessionName = () => piName;
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const section = async () => {
		const sections = {};
		await m.fire("before_agent_start", { prompt: "hi", systemPromptOptions: { sections } });
		return sections["session-identity"];
	};
	mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
	const registry = (entry) => writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify(entry));
	registry({ pid: process.pid, name: "Victor-2", nameSource: "user", entrypoint: "pi", startedAt: Date.now() });
	assert.match(await section(), /named Victor-2/, "this pi's own entry names the section");
	// The same pid, from a dead pi that had it before this one: not this session's either.
	registry({ pid: process.pid, name: "ghost", nameSource: "user", entrypoint: "pi", startedAt: Date.now() - 3_600_000 });
	assert.match(await section(), /named Victor/, "a dead pi's file (same pid, an hour old) names nothing");
	registry({ pid: process.pid, name: "claude-session", nameSource: "user", entrypoint: "claude" });
	assert.match(await section(), /named Victor/, "Claude Code's name is not this pi's");
	registry({ pid: process.pid, name: "pi-proj", nameSource: "derived", entrypoint: "pi" });
	assert.match(await section(), /named Victor/, "a folder-derived name names no section");
	assert.equal(
		m.mod.currentName({ sessionName: () => undefined, cwd: "/tmp/work/proj" }),
		"pi-proj",
		"the phone still shows the derived name",
	);
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

// ---- Take back a steer (unsteer): held for the turn's end, flushed there, or handed back ----------

const STEER_A = "aaaaaaaa-1111-4222-8333-444444444444";
const STEER_B = "bbbbbbbb-1111-4222-8333-444444444444";
const STEER_C = "cccccccc-1111-4222-8333-444444444444";

/** A session that steers as pi does: sendUserMessage fires pi's input event (a steer only while a
 * run streams, which these tests always are once agent_start fired), so the steer mark lands when
 * pi takes it. */
async function steering({ hostFeatures = ["model_pages", "unsteer"] } = {}) {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	const status = [];
	m.ctx.ui = { setStatus: (k, t) => { if (k === "botsun-steers") status.push(t); } };
	m.ctx.isIdle = () => false;
	m.ctx.abort = () => {};
	let pending = false;
	m.ctx.hasPendingMessages = () => pending;
	m.pi.sendUserMessage = async (content, options) => {
		m.sent.push({ content, options });
		await m.fire("input", { type: "input", text: typeof content === "string" ? content : "", source: "extension", streamingBehavior: options?.deliverAs });
	};
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	// Botsun answers the hello with what it takes: steers wait only for one that lists `unsteer`.
	down(srv, { v: 1, type: "features", features: hostFeatures });
	await until(() => globalThis[Symbol.for("botsun-owner.v1")]?.hostFeatures?.has(hostFeatures[0]));
	await m.fire("agent_start");
	const say = async (text, clientId) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(key, nonce, "session", "say", botsunSayPayload(text, clientId));
		return ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature, ...(clientId ? { client_id: clientId } : {}) });
	};
	const unsteer = async ({ v1 = false } = {}) => {
		const { nonce } = await ask({ type: "nonce" });
		if (v1) {
			const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "unsteer", sha("unsteer")].join("\n");
			const signature = cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
			return ask({ type: "unsteer", nonce, device_id: 7, signature });
		}
		return ask({ type: "unsteer", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "unsteer", "unsteer") });
	};
	const lines = (type) => srv.lines.filter((l) => l.type === type);
	const setPending = (v) => { pending = v; };
	return { key, srv, m, say, unsteer, lines, setPending, status };
}

test("unsteer: a steer mid-turn waits for the turn's end, then goes in as a steer, marked only then", async () => {
	const { m, say, lines } = await steering();
	assert.ok((await ask({ type: "nonce" })).features.includes("unsteer"));
	await m.fire("turn_start", { turnIndex: 0 });
	assert.deepEqual(await say("run the tests first", STEER_A), { ok: true, delivered: "steer" });
	assert.equal(m.sent.length, 0, "held for the turn's end");
	assert.equal(m.entries.length, 0, "no steer mark for words pi hasn't taken");
	await until(() => lines("steers").length >= 1);
	const held = lines("steers").at(-1).steers;
	assert.deepEqual(held.map((s) => [s.id, s.chars, s.photos]), [[STEER_A, 19, 0]]);
	assert.equal(JSON.stringify(lines("steers")).includes("run the tests"), false, "the steers line never carries the words");
	await m.fire("turn_end", { outcome: "completed" });
	assert.deepEqual(m.sent, [{ content: "run the tests first", options: { deliverAs: "steer" } }]);
	assert.deepEqual(m.entries.map((e) => [e.customType, e.data.text]), [["botsun-steer", "run the tests first"]], "marked as pi takes it");
	await until(() => lines("steers").at(-1).steers.length === 0);
	// Outside a turn (after its last turn_end) a steer has no turn_end left: straight in, as before.
	await say("one more thing", STEER_B);
	assert.deepEqual(m.sent.at(-1), { content: "one more thing", options: { deliverAs: "steer" } });
});

test("unsteer: one held steer per turn_end, and none while pi holds one of its own", async () => {
	const { m, say, setPending } = await steering();
	await m.fire("turn_start", { turnIndex: 0 });
	await say("first", STEER_A);
	await say("second", STEER_B);
	setPending(true);
	await m.fire("turn_end", { outcome: "completed" });
	assert.equal(m.sent.length, 0, "pi still has a steer queued: the rest stay withdrawable");
	// Between turns, a new steer waits behind the held ones (never jumps ahead of them).
	await say("third", STEER_C);
	assert.equal(m.sent.length, 0);
	setPending(false);
	await m.fire("turn_start", { turnIndex: 1 });
	await m.fire("turn_end", { outcome: "error" }); // an error's retry reads the queue too: as today
	assert.deepEqual(m.sent.map((s) => s.content), ["first"]);
	await m.fire("turn_start", { turnIndex: 2 });
	await m.fire("turn_end", { outcome: "completed" });
	assert.deepEqual(m.sent.map((s) => s.content), ["first", "second"]);
	// The run settles with one still held (no turn_end left for it): his next prompt, not lost. A
	// follow-up, as a prompt is still on its way in (pi idle takes it as a prompt).
	await m.fire("agent_settled", { aborted: false });
	assert.deepEqual(m.sent.at(-1), { content: "third", options: { deliverAs: "followUp" } });
	assert.equal(m.entries.filter((e) => e.data.text === "third").length, 0, "a prompt is no steer: no mark");
});

test("unsteer: takes back every held steer, oldest first, signed v2; the escrow keeps them until Botsun acks", async () => {
	const { m, srv, say, unsteer, lines } = await steering();
	// Before any v2 from this device (whose first v2 would refuse every v1 after it anyway).
	assert.equal((await unsteer({ v1: true })).error, UNSTEER_V1, "v1 is refused");
	await m.fire("turn_start", { turnIndex: 0 });
	await say("wait, use the staging db", STEER_A);
	await say("and skip the slow specs", STEER_B);
	const res = await unsteer();
	assert.deepEqual(res, { ok: true, withdrawn: [{ id: STEER_A, text: "wait, use the staging db" }, { id: STEER_B, text: "and skip the slow specs" }], kept: 0 });
	await m.fire("turn_end", { outcome: "completed" });
	assert.equal(m.sent.length, 0, "nothing withdrawn reaches pi");
	assert.equal(m.entries.length, 0, "and leaves no steer mark");
	assert.deepEqual(await unsteer(), { ok: true, withdrawn: [], kept: 0 }, "nothing held: says so, and never stops");
	await until(() => lines("returned").length === 2);
	assert.deepEqual(lines("returned").map((l) => [l.session_id, l.steers[0].id, l.steers[0].why]), [["sid-a", STEER_A, "withdrawn"], ["sid-a", STEER_B, "withdrawn"]]);
	// Botsun gone and back: the escrow goes again after the hello, until Botsun's returned_ack.
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	assert.equal(conn.returned.length, 2);
	down(srv, { v: 1, type: "returned_ack", ids: [STEER_A] });
	await until(() => conn.returned.length === 1);
	for (const c of srv.conns) c.destroy();
	await until(() => srv.types().filter((t) => t === "hello").length === 2);
	await until(() => lines("returned").length === 3);
	assert.equal(lines("returned").at(-1).steers[0].id, STEER_B, "only what Botsun hasn't acked");
});

test("unsteer: a reply stays under the cap; the rest stay held for the next press; too big is never held", async () => {
	const { m, say, unsteer } = await steering();
	const { STEER_BYTES_MAX, UNSTEER_REPLY_MAX } = m.mod;
	await m.fire("turn_start", { turnIndex: 0 });
	const big = (c) => c.repeat(STEER_BYTES_MAX - 100);
	const ids = ["11111111-0000-4000-8000-000000000001", "11111111-0000-4000-8000-000000000002", "11111111-0000-4000-8000-000000000003", "11111111-0000-4000-8000-000000000004"];
	for (const [i, id] of ids.entries()) await say(big("abcd"[i]).slice(0, 16_000), id);
	assert.equal(m.sent.length, 0);
	const first = await unsteer();
	assert.ok(Buffer.byteLength(JSON.stringify(first)) <= UNSTEER_REPLY_MAX, "under the cap");
	assert.ok(first.withdrawn.length >= 1 && first.kept >= 1, "the rest stay held");
	assert.equal(first.withdrawn.length + first.kept, 4);
	const second = await unsteer();
	assert.deepEqual([...first.withdrawn, ...second.withdrawn].map((s) => s.id), ids, "in order, none lost");
	// Too big for a reply (in UTF-8): straight in, not withdrawable.
	const wide = "é".repeat(9_000);
	await say(wide, STEER_C);
	assert.deepEqual(m.sent.at(-1), { content: wide, options: { deliverAs: "steer" } });
});

test("unsteer: a photo steer and a compaction's held words go as before, never held", async () => {
	const { m, key } = await steering();
	await m.fire("turn_start", { turnIndex: 0 });
	const images = [{ data: Buffer.from("png").toString("base64"), mime_type: "image/png" }];
	const { nonce } = await ask({ type: "nonce" });
	const text = "like this";
	const signature = signV2(key, nonce, "session", "say_images", botsunSayPayload(text, undefined, images));
	assert.equal((await ask({ type: "say", text, images, nonce, device_id: 7, sig_v: 2, signature })).delivered, "steer");
	assert.equal(m.sent.length, 1, "photos aren't withdrawable yet: straight in");
	assert.equal(m.sent[0].options.deliverAs, "steer");
});

test("unsteer: an aborted turn, a stopped run or a shutdown hands held steers back, never to pi", async () => {
	const { m, srv, say, lines } = await steering();
	await m.fire("turn_start", { turnIndex: 0 });
	await say("held one", STEER_A);
	// Held steers make a locked phone's close wait: they're on their way in.
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	m.ctx.isIdle = () => true;
	await m.fire("agent_settled", { aborted: true }); // settles busy off, and hands it back
	assert.equal(m.sent.length, 0, "an aborted run never restarts the agent");
	await until(() => lines("returned").length === 1);
	assert.deepEqual(lines("returned")[0].steers.map((s) => [s.id, s.text, s.why]), [[STEER_A, "held one", "stopped"]]);

	await m.fire("agent_start");
	await m.fire("turn_start", { turnIndex: 0 });
	await say("held two", STEER_B);
	assert.equal(conn.close({ idleOnly: true }), null, "a held steer counts as running");
	await m.fire("turn_end", { outcome: "aborted" });
	assert.equal(m.sent.length, 0, "an aborted turn never flushes");
	await until(() => lines("returned").length === 2);

	await m.fire("turn_start", { turnIndex: 1 });
	await say("held three", STEER_C);
	await m.fire("session_shutdown", { reason: "quit" });
	await until(() => lines("returned").length === 3 && lines("bye").length === 1);
	assert.equal(m.sent.length, 0);
	const order = srv.lines.map((l) => l.type);
	assert.ok(order.lastIndexOf("returned") < order.indexOf("bye"), "returned goes before the bye");
});

test("unsteer: a steer held over a /new handoff goes back to the phone, in the conversation pi moves to", async () => {
	const { m, srv, say, lines } = await steering();
	await m.fire("turn_start", { turnIndex: 0 });
	await say("keep this", STEER_A);
	await m.fire("session_shutdown", { reason: "new" });
	await until(() => lines("returned").length === 1);
	assert.equal(lines("returned")[0].session_id, "sid-a", "said while still in the old one");
	assert.equal(m.sent.length, 0);
	// The phone follows pi to the new conversation and reads that thread: the escrow goes again,
	// named for it, right after the session line (Botsun takes a line only for the current one).
	const b = await mount({ ctx: { sessionManager: { getSessionFile: () => "/tmp/sessions/b.jsonl", getSessionId: () => "sid-b" } } });
	await b.fire("session_start", { reason: "new" });
	await until(() => lines("returned").length === 2);
	const order = srv.lines.map((l) => l.type);
	assert.ok(order.indexOf("session") < order.lastIndexOf("returned"), "after the session line");
	assert.deepEqual([lines("returned")[1].session_id, lines("returned")[1].steers[0].id], ["sid-b", STEER_A]);
	// And after a reconnect's hello, still the new conversation's, until Botsun acks it.
	for (const c of srv.conns) c.destroy();
	await until(() => lines("returned").length === 3);
	assert.equal(lines("returned")[2].session_id, "sid-b");
	down(srv, { v: 1, type: "returned_ack", ids: [STEER_A] });
	await until(() => globalThis[Symbol.for("botsun-owner.v1")].returned.length === 0);
});

test("unsteer: an older Botsun (no `unsteer` in its features line) gets every steer at once, as before", async () => {
	const { m, say, lines } = await steering({ hostFeatures: ["model_pages"] });
	await m.fire("turn_start", { turnIndex: 0 });
	await say("go now", STEER_A);
	assert.deepEqual(m.sent, [{ content: "go now", options: { deliverAs: "steer" } }], "never held: it could never come back");
	await m.fire("turn_end", { outcome: "aborted" });
	await sleep(30);
	assert.equal(lines("returned").length, 0);
});

test("unsteer: pi's footer shows how many phone steers wait, and clears when none do", async () => {
	const { m, say, unsteer, status } = await steering();
	await m.fire("turn_start", { turnIndex: 0 });
	await say("first", STEER_A);
	await say("second", STEER_B);
	assert.equal(status.at(-1), "📱 2 phone steers waiting for the turn's end");
	await m.fire("turn_end", { outcome: "completed" });
	assert.equal(status.at(-1), "📱 1 phone steer waiting for the turn's end");
	await unsteer();
	assert.equal(status.at(-1), undefined);
	assert.equal(m.mod.steerStatusText(0), undefined);
});

test("unsteer: a photo steer behind a waiting one waits too (his order), and an unsteer leaves it in place", async () => {
	const { m, key, say, unsteer, lines } = await steering();
	await m.fire("turn_start", { turnIndex: 0 });
	await say("first words", STEER_A);
	const images = [{ data: Buffer.from("png").toString("base64"), mime_type: "image/png" }];
	const { nonce } = await ask({ type: "nonce" });
	const signature = signV2(key, nonce, "session", "say_images", botsunSayPayload("this one", undefined, images));
	assert.equal((await ask({ type: "say", text: "this one", images, nonce, device_id: 7, sig_v: 2, signature })).delivered, "steer");
	await say("last words", STEER_C);
	assert.equal(m.sent.length, 0, "the photo waits behind the first words");
	await until(() => lines("steers").at(-1)?.steers.length === 2);
	assert.deepEqual(lines("steers").at(-1).steers.map((s) => s.id), [STEER_A, STEER_C], "only what a Stop can take back is listed");
	const res = await unsteer();
	assert.deepEqual(res.withdrawn.map((s) => s.id), [STEER_A, STEER_C]);
	assert.equal(res.kept, 0);
	await m.fire("turn_end", { outcome: "completed" });
	assert.equal(m.sent.length, 1, "the photo goes in at the turn's end");
	assert.equal(m.sent[0].options.deliverAs, "steer");
	assert.ok(Array.isArray(m.sent[0].content) && m.sent[0].content.some((b) => b.type === "image"));
});

test("unsteer: the phone's Stop hands the waiting steers back by id in its reply, and they never reach pi", async () => {
	const { m, key, say, lines } = await steering();
	await m.fire("turn_start", { turnIndex: 0 });
	await say("not yet read", STEER_A);
	const { nonce } = await ask({ type: "nonce" });
	const res = await ask({ type: "stop", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stop", "stop") });
	assert.equal(res.ok, true);
	assert.deepEqual(res.returned, [{ id: STEER_A, text: "not yet read" }]);
	await m.fire("turn_end", { outcome: "aborted" });
	await m.fire("agent_settled", { aborted: true });
	assert.equal(m.sent.length, 0);
	await until(() => lines("returned").length === 1);
	assert.equal(lines("returned")[0].steers[0].why, "stopped");
});

test("unsteer: a steer that came in during a compaction waits behind the waiting ones once it ends", async () => {
	const { m, say, unsteer } = await steering();
	await m.fire("turn_start", { turnIndex: 0 });
	await say("before", STEER_A);
	await m.fire("session_before_compact", { reason: "threshold" });
	await say("during", STEER_B);
	assert.equal(m.sent.length, 0);
	await m.fire("session_compact", {});
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	await until(() => (conn.steers ?? []).length === 2);
	assert.equal(m.sent.length, 0, "never ahead of the one waiting");
	assert.deepEqual((await unsteer()).withdrawn.map((s) => s.id), [STEER_A, STEER_B]);
});

// ---- Long videos (feature "uploads"): Botsun's file, named by path, hashed again here ---------
// test/fixtures/signing-uploads.json is a byte-identical copy of Botsun's upload vectors.
const uploadVectors = JSON.parse(readFileSync(new URL("./fixtures/signing-uploads.json", import.meta.url), "utf8"));
// Botsun's own copy of the vectors, for the byte-for-byte check: BOTSUN_DIR, else the usual checkout.
const BOTSUN_UPLOADS_FIXTURE = join(process.env.BOTSUN_DIR ?? join(homedir(), "Code/github.com/ericboehs/botsun"), "test/fixtures/signing-uploads.json");

test("uploads: listed as a feature; a say's upload lines are Botsun's, byte for byte", async () => {
	const { sayDigest } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const v = uploadVectors.vectors.find((x) => x.name === "session say_attach with an upload and the phone's message id");
	assert.ok(v, "Botsun's upload vectors have the say");
	const { decision, payload, digest } = sayDigest(v.inputs.text, vectorImages(v), [], v.inputs.client_id, v.inputs.uploads);
	assert.equal(decision, "say_attach");
	assert.equal(payload, v.expect_payload);
	assert.equal(createHash("sha256").update(payload, "utf8").digest("hex"), v.expect_digest);
	assert.match(payload, /\nupload [0-9a-f]{64} [0-9a-f]{64} 201326592$/);
	assert.equal(sayDigest("x", [], [], undefined, []).payload, sayDigest("x", [], []).payload, "no uploads: the old bytes");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	await owner();
	assert.ok((await ask({ type: "nonce" })).features.includes("uploads"));
});

test("uploads: the fixture is byte-identical to Botsun's, when Botsun has it", { skip: !existsSync(BOTSUN_UPLOADS_FIXTURE) && "no Botsun checkout with it" }, () => {
	assert.ok(readFileSync(BOTSUN_UPLOADS_FIXTURE).equals(readFileSync(new URL("./fixtures/signing-uploads.json", import.meta.url))));
});

/** A long video say as Botsun hands it on: v2, an id, the upload lines over what it recorded. */
function uploadSay(key, nonce, text, uploads, clientId = "0b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e", signedAs = uploads) {
	const hex = (b) => createHash("sha256").update(b).digest("hex");
	const lines = [hex(Buffer.from(text, "utf8")), ...signedAs.map((u) => `upload ${hex(Buffer.from(u.name, "utf8"))} ${u.sha256} ${u.bytes}`)].join("\n");
	const payload = `botsun-say-attach-v2\n${clientId}\n${lines}`;
	return { type: "say", text, uploads, client_id: clientId, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "say_attach", payload) };
}

function uploadFile(dir, bytes) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const uid = randomHex(16);
	const path = join(dir, `${uid}.part`);
	writeFileSync(path, bytes, { mode: 0o600 });
	return path;
}
const randomHex = (n) => Array.from({ length: n * 2 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

test("uploads: a long video is copied into the inbox, hashed again, and named with an ffmpeg hint", async () => {
	const { statSync, symlinkSync, unlinkSync: rm } = await import("node:fs");
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	// Fake ffprobe / ffmpeg (never the real ones): a 3m12s 1920x1080 recording.
	const bin = join(home, "fakebin-up");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\ncase "$*" in *stream=width,height*) echo 1920x1080 ;; *) echo 192.4 ;; esac\n`, { mode: 0o755 });
	writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\nfor a; do out=$a; done\nprintf '\\377\\330\\377frame' > "$out"\n`, { mode: 0o755 });
	const path0 = process.env.PATH;
	const dirs0 = process.env.BOTSUN_OWNER_FFMPEG_DIRS;
	cleanups.push(() => { process.env.PATH = path0; if (dirs0 === undefined) delete process.env.BOTSUN_OWNER_FFMPEG_DIRS; else process.env.BOTSUN_OWNER_FFMPEG_DIRS = dirs0; });
	process.env.PATH = bin;
	process.env.BOTSUN_OWNER_FFMPEG_DIRS = "";
	const m = await owner();
	const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4000, 7)]);
	const sha = createHash("sha256").update(mp4).digest("hex");
	const hostPath = uploadFile(updir, mp4);
	const up = { path: hostPath, name: "Screen Recording.mp4", mime: "video/mp4", bytes: mp4.length, sha256: sha };

	let { nonce } = await ask({ type: "nonce" });
	let res = await ask(uploadSay(key, nonce, "it breaks here", [up]));
	assert.deepEqual(res, { ok: true, delivered: "prompt" });
	await until(() => m.sent.length === 1, 10_000);
	const [first, ...frames] = m.sent[0].content;
	assert.equal(frames.length, 8);
	const inbox = first.text.match(/Video: (.+?) \(3m12s, 1920x1080\)\. /)[1];
	assert.ok(inbox.startsWith(join(home, "inbox", String(process.pid))) && inbox.endsWith("-Screen Recording.mp4"));
	assert.ok(first.text.startsWith("it breaks here\n\nVideo: "));
	assert.ok(first.text.includes(`To view it, extract frames, e.g. ffmpeg -i '${inbox}' -vf fps=1 /tmp/frames/%04d.png, then read the PNGs.`));
	assert.ok(first.text.includes(`🎞️ Video ${inbox} (3:12): 8 frames`));
	assert.equal(statSync(inbox).ino === statSync(hostPath).ino, false, "a copy, never a link to Botsun's file");
	assert.ok(readFileSync(inbox).equals(mp4), "the bytes that were signed");
	assert.equal(statSync(hostPath).mode & 0o777, 0o600, "Botsun's own file keeps its mode");
	assert.equal(statSync(inbox).mode & 0o777, 0o600);

	// A hash that isn't the signed one: refused, and nothing is left in the inbox for it.
	const other = uploadFile(updir, mp4);
	const lie = { ...up, path: other, sha256: "ab".repeat(32) };
	({ nonce } = await ask({ type: "nonce" }));
	const before = readdirSync(join(home, "inbox", String(process.pid))).length;
	res = await ask(uploadSay(key, nonce, "x", [lie], "1b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e"));
	assert.equal(res.error, "an upload's sha256 doesn't match what was signed");
	assert.equal(readdirSync(join(home, "inbox", String(process.pid))).length, before);

	// A renamed video under the same signature.
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask(uploadSay(key, nonce, "x", [{ ...up, path: other, name: "evil.mp4" }], undefined, [{ ...up, path: other }]));
	assert.equal(res.error, "signature does not verify");

	// Paths: outside the uploads dir, a link inside it, the wrong size, a name that's a path.
	const outside = uploadFile(join(home, "elsewhere"), mp4);
	const link = join(updir, `${randomHex(16)}.part`);
	symlinkSync(outside, link);
	const refusals = [
		[{ ...up, path: outside }, "an upload must be in Botsun's uploads dir"],
		[{ ...up, path: join(updir, "..", "elsewhere", basenameOf(outside)) }, "an upload must be in Botsun's uploads dir"],
		[{ ...up, path: join(updir, "notauid.mp4") }, "an upload must be in Botsun's uploads dir"],
		[{ ...up, path: link }, "an upload must be a plain file"],
		[{ ...up, path: other, bytes: mp4.length + 1 }, "an upload isn't the size that was signed"],
		[{ ...up, path: other, name: "../x.mp4" }, "bad file name"],
		[{ ...up, path: other, mime: "text/plain" }, "a long video is MP4 or QuickTime"],
	];
	for (const [bad, why] of refusals) {
		({ nonce } = await ask({ type: "nonce" }));
		assert.equal((await ask(uploadSay(key, nonce, "x", [bad]))).error, why, bad.path);
	}
	rm(link);
	// v1 never names one.
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ ...uploadSay(key, nonce, "x", [{ ...up, path: other }]), sig_v: undefined, client_id: undefined });
	assert.equal(res.error, "a long video is signed with v2 or newer");
	assert.equal(m.sent.length, 1);
});

const basenameOf = (p) => p.split("/").pop();

test("uploads: a .part that is a hard link to another file is refused and leaves that file alone", async () => {
	const { linkSync, statSync: st } = await import("node:fs");
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads-hardlink");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	// No "ftyp": a file, not something to pull frames from (this test has no ffmpeg).
	const bytes = Buffer.alloc(600, 3);
	const sha = createHash("sha256").update(bytes).digest("hex");
	const his = join(home, "his-own.mp4");
	writeFileSync(his, bytes);
	chmodSync(his, 0o644);
	mkdirSync(updir, { recursive: true, mode: 0o700 });
	const part = join(updir, `${randomHex(16)}.part`);
	linkSync(his, part);
	assert.equal(st(his).nlink, 2);
	const up = { path: part, name: "his.mp4", mime: "video/mp4", bytes: bytes.length, sha256: sha };
	const clientId = "0b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";

	let { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask(uploadSay(key, nonce, "mine", [up], clientId))).error, "an upload is a link to another file");
	assert.equal(st(his).mode & 0o777, 0o644, "the file it links to keeps its mode, even though it was signed");
	assert.ok(readFileSync(his).equals(bytes), "and its bytes");
	assert.equal(m.sent.length, 0);

	// The same link, written as Botsun's own file: the same message id (fresh nonce) now goes in, so
	// the refused take forgot it rather than leaving it in progress.
	rmSync(part);
	writeFileSync(part, bytes, { mode: 0o600 });
	({ nonce } = await ask({ type: "nonce" }));
	assert.deepEqual(await ask(uploadSay(key, nonce, "mine", [up], clientId)), { ok: true, delivered: "prompt" });
	assert.equal(m.sent.length, 1, "delivered once");
});

test("uploads: an unsigned caller learns nothing about which files are there", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads-noleak");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	await owner();
	const bytes = Buffer.alloc(256, 5);
	const there = uploadFile(updir, bytes);
	const missing = join(updir, `${randomHex(16)}.part`);
	const up = (path, size) => ({ path, name: "a.mp4", mime: "video/mp4", bytes: size, sha256: "ab".repeat(32) });
	const signedOver = up(join(updir, `${randomHex(16)}.part`), 1);
	// A file that is there, one that isn't, and the right file with the wrong size: one answer for all.
	for (const bad of [up(there, bytes.length), up(missing, 4096), up(there, bytes.length + 1)]) {
		const { nonce } = await ask({ type: "nonce" });
		assert.equal((await ask(uploadSay(key, nonce, "x", [bad], undefined, [signedOver]))).error, "signature does not verify", bad.path);
	}
});

test("uploads: a name is capped at 200 bytes of UTF-8, not 200 characters", async () => {
	const { uploadsOf } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const u = (name) => ({ path: `/${randomHex(16)}.part`, name, mime: "video/mp4", bytes: 1, sha256: "ab".repeat(32) });
	assert.equal(uploadsOf([u("é".repeat(100))]).length, 1, "200 bytes in 100 two-byte letters is fine");
	assert.equal(uploadsOf([u("é".repeat(101))]), "bad file name", "202 bytes is not");
	assert.equal(uploadsOf([u("a".repeat(200))]).length, 1, "200 plain characters is");
	assert.equal(uploadsOf([u("a".repeat(201))]), "bad file name");
});

test("uploads: a retry of a video whose frames are still coming waits for it, then is a duplicate", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads-slow");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const marker = join(home, "ffmpeg-started-slow");
	const gate = join(home, "ffmpeg-gate-slow");
	fakeFfmpeg({ marker, gate });
	const m = await owner();
	// The frames are held still, so the delivery is plainly still on its way when the retry arrives:
	// no timing to depend on (a 32 MB hash can finish before a retry on a fast Mac).
	const up = fakeUpload(updir, fakeMp4());
	const clientId = "0b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";
	const first = ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [up], clientId));
	assert.deepEqual(await first, { ok: true, delivered: "prompt" }, "the reply doesn't wait for ffmpeg");
	await until(() => existsSync(marker), 10_000);
	let answered = false;
	const retry = ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [up], clientId)).finally(() => { answered = true; });
	await sleep(200);
	assert.equal(answered, false, "the retry waits for the delivery, never a premature duplicate");
	writeFileSync(gate, "go");
	assert.deepEqual(await retry, { ok: true, delivered: "duplicate" }, "it went in: the retry is a duplicate");
	assert.equal(m.sent.length, 1, "the video once");
	assert.ok(sentText(m.sent[0]).startsWith("the video\n\n"), "and it went in");
});

test("uploads: a retry whose first delivery failed goes in, never lost as a duplicate", async () => {
	const inbox = join(home, "inbox-retry-failed");
	process.env.BOTSUN_OWNER_INBOX = inbox;
	const updir = join(home, "uploads-retry-failed");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const marker = join(home, "ffmpeg-started-retry");
	const gate = join(home, "ffmpeg-gate-retry");
	fakeFfmpeg({ marker, gate });
	const m = await owner();
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	// pi refuses the first video's frames; the second try goes in.
	const inject = conn.inject;
	let tries = 0;
	conn.inject = (...args) => { if (++tries === 1) throw new Error("pi refused the message"); return inject(...args); };
	cleanups.push(() => { conn.inject = inject; });
	const up = fakeUpload(updir, fakeMp4());
	const clientId = "1b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";
	const first = ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [up], clientId));
	assert.deepEqual(await first, { ok: true, delivered: "prompt" });
	await until(() => existsSync(marker), 10_000);
	// A retry while that delivery is still on its way: it must wait for it, and go in when it fails.
	const retry = ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [up], clientId));
	await sleep(100);
	writeFileSync(gate, "go");
	assert.deepEqual(await retry, { ok: true, delivered: "prompt" }, "the first delivery failed, so the retry went in");
	await until(() => m.sent.length === 1, 10_000);
	assert.equal(m.sent.length, 1, "delivered once");
	// The failed take's inbox copy went with it: a retry doesn't leave another behind.
	assert.equal(readdirSync(join(inbox, String(process.pid))).length, 1, "one copy, the one that went in");
});

test("uploads: a retry after Botsun removed its .part is a duplicate, not a missing file", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads-gone");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	// No "ftyp": a file, not something to pull frames from (this test has no ffmpeg).
	const up = fakeUpload(updir, Buffer.alloc(600, 3));
	const clientId = "2b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";
	let { nonce } = await ask({ type: "nonce" });
	assert.deepEqual(await ask(uploadSay(key, nonce, "mine", [up], clientId)), { ok: true, delivered: "prompt" });
	// Botsun keeps its own file only until the say's ok, then cleans up.
	rmSync(up.path);
	({ nonce } = await ask({ type: "nonce" }));
	assert.deepEqual(await ask(uploadSay(key, nonce, "mine", [up], clientId)), { ok: true, delivered: "duplicate" },
		"the duplicate check comes before the disk check");
	assert.equal(m.sent.length, 1, "delivered once");
});

test("uploads: a say pi throws on doesn't hold the framing queue, and leaves no copy behind", async () => {
	const inbox = join(home, "inbox-thrown");
	process.env.BOTSUN_OWNER_INBOX = inbox;
	const updir = join(home, "uploads-thrown");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	// No "ftyp": not a video, so there are no frames to pull, but the take still hands the inject to a
	// promise of its own (it is in order), so a throw there never reaches the reply.
	const up = fakeUpload(updir, Buffer.alloc(600, 3));
	const clientId = "3b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";
	const inject = conn.inject;
	conn.inject = () => { throw new Error("pi refused the message"); };
	cleanups.push(() => { conn.inject = inject; });
	assert.deepEqual(await ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the clip", [up], clientId)),
		{ ok: true, delivered: "prompt" }, "the reply doesn't wait for the inject");
	await until(() => readdirSync(join(inbox, String(process.pid))).length === 0, 5_000);
	assert.deepEqual(readdirSync(join(inbox, String(process.pid))), [], "the copy the take made went with it");
	// The queue the take held must be open: words behind a queue that never opens never go in.
	conn.inject = inject;
	const text = "after it";
	const nonce = (await ask({ type: "nonce" })).nonce;
	assert.deepEqual(await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2,
		signature: signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`) }), { ok: true, delivered: "prompt" });
	await until(() => m.sent.some((x) => sentText(x) === text), 5_000);
	assert.ok(m.sent.some((x) => sentText(x) === text), "the words after it went in");
	// And the id was forgotten: the phone's next try of the clip is delivered, once.
	const retry = uploadSay(key, (await ask({ type: "nonce" })).nonce, "the clip", [up], clientId);
	assert.deepEqual(await ask(retry), { ok: true, delivered: "prompt" }, "the failed try left no id behind");
	await until(() => m.sent.length === 2, 5_000);
	assert.equal(m.sent.length, 2, "the words once, the clip once");
});

test("uploads: a retry that arrives while the video is still being taken waits for that delivery", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox-during-take");
	const updir = join(home, "uploads-during-take");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	// pi refuses the first delivery, so the id is forgotten and the retry belongs in, not "duplicate".
	const inject = conn.inject;
	let tries = 0;
	conn.inject = (...args) => { if (++tries === 1) throw new Error("pi refused the message"); return inject(...args); };
	cleanups.push(() => { conn.inject = inject; });
	// No "ftyp": a file, not a video, so it goes in as the take's reply comes (no ffmpeg here).
	const up = fakeUpload(updir, Buffer.alloc(600, 3));
	const clientId = "4b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";
	const request = async () => uploadSay(key, (await ask({ type: "nonce" })).nonce, "the clip", [up], clientId);
	// Both signed first, then dispatched in one tick: the retry is handled while the first is still
	// copying and hashing (the take has only just started), so it must wait for that delivery rather
	// than take it for a message already in. A slow copy can't be forced here, and mustn't be needed:
	// the take's first await is always still pending when the second request is handled.
	const firstReq = await request();
	const retryReq = await request();
	const first = m.mod.handleOwnerRequest(conn, firstReq);
	assert.equal(typeof first.then, "function", "the take is still running: its reply is a promise");
	assert.deepEqual([...conn.saidPending.keys()], [`sid-a:7:${clientId}`], "on its way from the moment the take starts");
	const retry = m.mod.handleOwnerRequest(conn, retryReq);
	assert.equal(typeof retry.then, "function", "the retry waits for the delivery instead of answering now");
	const firstReply = await first;
	assert.deepEqual([firstReply.ok, firstReply.delivered], [true, "prompt"], "the reply doesn't wait for the inject");
	// pi refused the first inject: the id is forgotten, so the retry goes in instead of being dropped.
	const retryReply = await retry;
	assert.deepEqual([retryReply.ok, retryReply.delivered], [true, "prompt"], "waited for the failed delivery, then went in");
	await until(() => m.sent.length === 1, 5_000);
	assert.equal(m.sent.length, 1, "delivered once");
	assert.equal(readdirSync(join(home, "inbox-during-take", String(process.pid))).length, 1, "one copy, the one that went in");
});

test("uploads: an upload that isn't a movie still waits behind an earlier video's frames", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads-not-a-movie");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const marker = join(home, "ffmpeg-started-not-a-movie");
	const gate = join(home, "ffmpeg-gate-not-a-movie");
	fakeFfmpeg({ marker, gate });
	const m = await owner();
	// The first say is a real video: its frames are held still, so the queue is plainly busy.
	const video = ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [fakeUpload(updir, fakeMp4())]));
	assert.deepEqual(await video, { ok: true, delivered: "prompt" });
	await until(() => existsSync(marker), 10_000);
	// The second is an upload that doesn't start like a movie: no frames of its own, but it was still
	// taken in order, so it must not overtake the video's frames.
	const plain = fakeUpload(updir, Buffer.alloc(600, 3), "Notes.mp4");
	assert.deepEqual(await ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the file", [plain])),
		{ ok: true, delivered: "prompt" });
	await sleep(100);
	assert.equal(m.sent.length, 0, "nothing overtakes the video whose frames are still coming");
	writeFileSync(gate, "go");
	await until(() => m.sent.length === 2, 10_000);
	assert.ok(sentText(m.sent[0]).startsWith("the video\n\n"), "the video first");
	assert.ok(sentText(m.sent[1]).startsWith("the file\n\n"), "then the file behind it, never ahead");
});

test("only a signed say may extend the owner socket's idle timeout", async () => {
	// The owner socket's 5 s idle timeout would drop Botsun's connection while a long video is hashed
	// (or a retry of one waits for its frames, up to 20 s of ffmpeg): such a say gets 35 s, but only
	// once its signature holds, so an unsigned caller can't hold an owner socket open longer.
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	const longer = [];
	const call = (req) => m.mod.handleOwnerRequest(conn, req, { longerTimeout: () => longer.push(req.type) });
	const id = "5b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";
	let { nonce } = await ask({ type: "nonce" });
	assert.ok((await call({ type: "say", text: "hi", client_id: id, nonce, device_id: 7, sig_v: 2, signature: "AAAA" })).error);
	assert.deepEqual(longer, [], "no signature: the short timeout stays");
	nonce = (await ask({ type: "nonce" })).nonce;
	assert.equal((await call({ type: "say", text: "hi", client_id: id, nonce, device_id: 7, sig_v: 2,
		signature: signV2(key, nonce, "session", "say", botsunSayPayload("hi", id)) })).error, undefined);
	assert.deepEqual(longer, ["say"], "a signed say may take a while: the socket waits longer");
});

test("say_id: a settled delivery never unpins a newer message that reuses its id", async () => {
	// A finished older message used to delete the id's pending entry whatever it now held, so a newer
	// message reusing the id lost its "on its way" mark and a retry of it could be answered
	// "duplicate" for a delivery that may still fail.
	const { saidOnItsWay } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const c = { said: new Map(), saidPending: new Map() };
	let finishOld;
	saidOnItsWay(c, "sid-a:7:x", "old", new Promise((r) => { finishOld = r; }));
	let finishNew;
	saidOnItsWay(c, "sid-a:7:x", "new", new Promise((r) => { finishNew = r; }));
	c.said.set("sid-a:7:x", "new");
	finishOld();
	await sleep(20);
	assert.ok(c.saidPending.has("sid-a:7:x"), "the older delivery's end leaves the newer one's mark alone");
	finishNew();
	await sleep(20);
	assert.equal(c.saidPending.has("sid-a:7:x"), false, "the newer one's own end clears it");
});

test("uploads: words sent while the video is still hashing wait behind its frames", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads-frames");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const marker = join(home, "ffmpeg-started");
	const gate = join(home, "ffmpeg-gate");
	fakeFfmpeg({ marker, gate });
	const m = await owner();
	// A real "ftyp" head, and big enough that the take is still hashing when the words arrive: the
	// take's job is the queue, so the words chain onto it and must wait for the frames too.
	const up = fakeUpload(updir, fakeMp4(32 * 1024 * 1024));
	const video = ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [up]));
	// The inbox copy appears before it is hashed: the take is under way, its queue is not done.
	const inbox = join(home, "inbox", String(process.pid));
	const copies = () => { try { return readdirSync(inbox).length; } catch { return 0; } };
	const before = copies();
	await until(() => copies() > before, 10_000);
	const text = "after the video";
	const n2 = (await ask({ type: "nonce" })).nonce;
	const words = await ask({ type: "say", text, nonce: n2, device_id: 7, sig_v: 2,
		signature: signV2(key, n2, "session", "say", `botsun-propose-text-v1\n${text}`) });
	assert.deepEqual(words, { ok: true, delivered: "prompt" });
	// The take's own reply doesn't wait for ffmpeg (the socket and Botsun don't wait); the queue does.
	assert.deepEqual(await video, { ok: true, delivered: "prompt" });
	// ffmpeg is on the video now, with its frames still to come.
	await until(() => existsSync(marker), 10_000);
	await sleep(50);
	assert.equal(m.sent.length, 0, "the words wait for the frames, not just for the take");
	writeFileSync(gate, "go");
	await until(() => m.sent.length === 2, 10_000);
	assert.ok(sentText(m.sent[0]).startsWith("the video\n\n"), "the video first");
	assert.equal(sentText(m.sent[1]), text, "then the words behind it, never ahead");
});

test("uploads: 64 other messages don't evict a video's id while it is still in progress", async () => {
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const updir = join(home, "uploads-evict");
	process.env.BOTSUN_UPLOADS_DIR = updir;
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const marker = join(home, "ffmpeg-started-evict");
	const gate = join(home, "ffmpeg-gate-evict");
	fakeFfmpeg({ marker, gate });
	const m = await owner();
	const up = fakeUpload(updir, fakeMp4());
	const videoId = "0b9e6a4e-1f2c-4c55-9a3e-6d1f2b3c4d5e";
	const video = ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [up], videoId));
	await until(() => existsSync(marker), 10_000);
	// 64 delivered messages after it: one more than the id memory holds, so the oldest would go.
	for (let i = 0; i < 64; i++) {
		const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
		const text = `message ${i}`;
		const { nonce } = await ask({ type: "nonce" });
		assert.deepEqual(await ask({ type: "say", text, client_id: id, nonce, device_id: 7, sig_v: 2,
			signature: signV2(key, nonce, "session", "say", botsunSayPayload(text, id)) }), { ok: true, delivered: "prompt" }, text);
	}
	// The video's id is still on its way, so a retry of it waits for that delivery and is then a
	// duplicate, not a second take.
	const retry = ask(uploadSay(key, (await ask({ type: "nonce" })).nonce, "the video", [up], videoId));
	await sleep(100);
	writeFileSync(gate, "go");
	assert.deepEqual(await video, { ok: true, delivered: "prompt" });
	assert.deepEqual(await retry, { ok: true, delivered: "duplicate" }, "an in-progress id is never evicted");
	await until(() => m.sent.length === 65, 10_000);
	assert.equal(m.sent.filter((x) => sentText(x).startsWith("the video")).length, 1, "the video once");
	assert.ok(sentText(m.sent[0]).startsWith("the video\n\n"), "and first, ahead of the 64 behind it");
});

test("uploads: checkUploads hands back the real uploads dir it checked", async () => {
	const { symlinkSync, realpathSync } = await import("node:fs");
	const { checkUploads } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const updir = join(home, "uploads-checked");
	const linkTo = join(home, "uploads-link");
	mkdirSync(updir, { recursive: true, mode: 0o700 });
	symlinkSync(updir, linkTo);
	cleanups.push(() => { delete process.env.BOTSUN_UPLOADS_DIR; });
	const bytes = Buffer.alloc(64, 1);
	const up = (dir) => ({ path: join(dir, `${randomHex(16)}.part`), name: "a.mp4", mime: "video/mp4", bytes: bytes.length, sha256: "ab".repeat(32) });
	// Both the dir and a link to it: the open names the file in the real directory, never through a link.
	for (const dir of [updir, linkTo]) {
		process.env.BOTSUN_UPLOADS_DIR = dir;
		const u = up(dir);
		writeFileSync(u.path, bytes, { mode: 0o600 });
		assert.deepEqual(checkUploads([u]), { dir: realpathSync(updir) }, dir);
	}
	process.env.BOTSUN_UPLOADS_DIR = updir;
	assert.equal(checkUploads([]), undefined, "nothing to check: nothing to hand back");
	const elsewhere = uploadFile(join(home, "another-dir"), bytes);
	assert.equal(checkUploads([{ ...up(updir), path: elsewhere }]), "an upload must be in Botsun's uploads dir");
});

test("videoNote and span: the length, the size, and a path the shell takes as one word", async () => {
	const { videoNote, span } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	assert.deepEqual([span(42), span(192.4), span(3725), span(0)], ["42s", "3m12s", "1h02m05s", "0s"]);
	assert.equal(videoNote("/tmp/a.mp4", { duration: 192, width: 1920, height: 1080, bytes: 1 }),
		"Video: /tmp/a.mp4 (3m12s, 1920x1080). To view it, extract frames, e.g. ffmpeg -i /tmp/a.mp4 -vf fps=1 /tmp/frames/%04d.png, then read the PNGs.");
	assert.match(videoNote("/tmp/it's here.mp4", { bytes: 3 * 1048576 }), /^Video: \/tmp\/it's here\.mp4 \(3\.0 MB\)\. .* ffmpeg -i '\/tmp\/it'\\''s here\.mp4' -vf/);
});
