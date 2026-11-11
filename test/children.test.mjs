/**
 * lib/children.ts: a session's subagents as one list. Synthetic inputs only: a recorded-style
 * pi JSON stream written for this test (test/fixtures/subagent-child.jsonl), and bg logs made
 * here in a temp dir. No child process, no model.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
	bindChildren,
	childTranscript,
	cursorCall,
	cursorLabel,
	ENTRY_BYTES,
	KEEP_MS,
	listChildren,
	LOG_BYTES,
	LOG_ENTRIES,
	MAX_CHILDREN,
	modelWindow,
	PAGE_BYTES,
	onChildrenChange,
	pollOnce,
	resetChildren,
	sessionOf,
	stopChild,
	toolLabel,
	trackChild,
} from "../lib/children.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-children-"));
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetChildren());

const fixture = readFileSync(new URL("./fixtures/subagent-child.jsonl", import.meta.url), "utf8").split("\n");
const one = (id) => listChildren().find((c) => c.id === id);

/** A bus like pi.events: handlers by channel, and what was emitted. */
function bus({ kill = true, killed = true } = {}) {
	const handlers = new Map();
	const emitted = [];
	return {
		emitted,
		handlers,
		on: (channel, fn) => (handlers.set(channel, fn), () => handlers.delete(channel)),
		emit(channel, data) {
			emitted.push([channel, data]);
			if (channel === "bg:kill" && kill) {
				data.accepted = true;
				data.reply({ killed });
			}
			handlers.get(channel)?.(data);
		},
	};
}

test("a foreground pi child's JSON events: turns, the tool it runs, its text, usage, masked", () => {
	const c = trackChild({ kind: "pi", agent: "scout", task: "look at the widget", model: "anthropic/claude", window: 200_000, sessionId: "s-1" });
	const seen = [];
	for (const line of fixture) {
		c.piLine(line);
		seen.push(one(c.id).activity);
	}
	const k = one(c.id);
	assert.equal(k.state, "running");
	assert.equal(k.turns, 3);
	assert.ok(seen.includes("Read widget.rb"), "a read is its file");
	assert.ok(seen.includes("Ran API_TOKEN=••• bin/test"), "a command is its first line, a likely secret masked");
	assert.ok(seen.includes("Thinking…") && seen.includes("Writing…"));
	assert.deepEqual(k.tail, [
		"Read widget.rb",
		"> Running the tests now.",
		"✗ Ran API_TOKEN=••• bin/test",
		"> The widget test fails on line 12. Fix: return nil.",
	]);
	assert.equal(k.lastText, "The widget test fails on line 12.\nFix: return nil.");
	assert.deepEqual({ ...k.usage, cost: Number(k.usage.cost.toFixed(4)) }, { input: 4400, output: 130, cacheRead: 3000, cacheWrite: 0, context: 2930, cost: 0.0038 });
	assert.equal(k.window, 200_000, "its model's window, for the phone's context bar");
	assert.equal(k.model, "anthropic/claude");
	assert.equal(k.sessionId, "s-1");
	c.finish("done");
	assert.equal(one(c.id).state, "done");
	assert.equal(one(c.id).activity, "");
	assert.ok(one(c.id).endedAt >= k.startedAt);
	c.piLine(fixture[4]);
	assert.equal(one(c.id).turns, 3, "nothing moves once it ended");

	const said = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s-1" });
	said.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Set API_TOKEN=abc123 first." }] } });
	assert.equal(one(said.id).lastText, "Set API_TOKEN=••• first.", "its words are masked too");
});

test("a child's model names its context window, exactly and only", () => {
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
		{ provider: "openrouter", id: "qwen/qwen3-coder:exacto", contextWindow: 262_144 },
		{ provider: "x", id: "no-window" },
	];
	assert.equal(modelWindow("anthropic/claude-sonnet-4-5", models), 200_000, "provider and id");
	assert.equal(modelWindow("claude-sonnet-4-5", models), 200_000, "a bare id");
	assert.equal(modelWindow("anthropic/claude-sonnet-4-5:high", models), 200_000, "a thinking suffix isn't part of it");
	assert.equal(modelWindow("openrouter/qwen/qwen3-coder:exacto", models), 262_144, "an id with a colon keeps it");
	assert.equal(modelWindow("anthropic/claude", models), undefined, "never a fuzzy match: another model's window");
	assert.equal(modelWindow("x/no-window", models), undefined, "a model pi doesn't say the window of");
	assert.equal(modelWindow(undefined, models), undefined);
	assert.equal(modelWindow("", models), undefined);
	// A bare id two providers both offer names neither of them: their windows may differ.
	const shared = [
		{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
		{ provider: "openrouter", id: "claude-sonnet-4-5", contextWindow: 1_000_000 },
	];
	assert.equal(modelWindow("claude-sonnet-4-5", shared), undefined, "an ambiguous bare id");
	assert.equal(modelWindow("openrouter/claude-sonnet-4-5", shared), 1_000_000, "its provider names it exactly");
	assert.equal(modelWindow("anthropic/claude-sonnet-4-5", shared), 200_000);
	const unknown = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s" });
	assert.deepEqual([one(unknown.id).window, one(unknown.id).usage], [undefined, undefined], "nothing known: both absent");
});

test("a usage-less assistant message says nothing about its context, not 0", () => {
	const c = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s" });
	c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
	assert.equal(one(c.id).usage.context, undefined, "no usage at all: no bar's worth of context");
	c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
	assert.deepEqual(one(c.id).usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, "a zeroed usage adds no context, so the phone draws no 0% bar");
	c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 900, output: 100 } } });
	assert.equal(one(c.id).usage.context, 1000, "a turn that says it sets it");
});

test("labels for pi tools and Cursor steps", () => {
	assert.equal(toolLabel("read", { path: "/a/b/c.rb" }), "Read c.rb");
	assert.equal(toolLabel("bash", { command: "bin/test --fast\necho done" }), "Ran bin/test --fast");
	assert.equal(toolLabel("edit", { path: "x/y.ts" }), "Edited y.ts");
	assert.equal(toolLabel("grep", { pattern: "TODO" }), "Searched for TODO");
	assert.equal(toolLabel("mystery"), "Called mystery");
	const auth = ["Author", "ization: Bea", "rer ", "not-a-real-token-1234567890"].join(""); // built at runtime: the masking test needs no real-looking literal
	assert.equal(toolLabel("bash", { command: `curl -H "${auth}"` }), `Ran curl -H "Authorization: •••"`);
	assert.equal(cursorLabel("read src/a.rb"), "Read a.rb");
	assert.equal(cursorLabel("shell bin/test"), "Ran bin/test");
	assert.equal(cursorLabel("glob *.rb"), "Searched files *.rb");
	assert.equal(cursorLabel("mcp thing"), "mcp thing");
	assert.equal(toolLabel("bash", { command: "x".repeat(500) }).length, 120, "capped");
});

test("a task is its first 200 characters, masked, on one line", () => {
	const c = trackChild({ kind: "pi", agent: "worker", task: `Use password=hunter2 then\n${"y".repeat(400)}`, sessionId: "s-1" });
	const { task } = one(c.id);
	assert.equal(task.length, 200);
	assert.match(task, /^Use password=••• then y+…$/);
});

test("states: done, failed, stopped; a stop asked always ends stopped", () => {
	const done = trackChild({ kind: "pi", agent: "a", task: "t", sessionId: "s" });
	const failed = trackChild({ kind: "pi", agent: "b", task: "t", sessionId: "s" });
	let aborted = 0;
	const stopped = trackChild({ kind: "pi", agent: "c", task: "t", sessionId: "s", stop: () => aborted++ });
	done.finish("done", { lastText: "ok" });
	failed.finish("failed", { lastText: "exit 1" });
	assert.equal(stopChild("s", stopped.id), "stopped");
	assert.equal(aborted, 1);
	assert.equal(stopped.stopping, true);
	stopped.finish("failed"); // the abort's exit looks like a failure; it was a stop
	assert.deepEqual(listChildren("s").map((c) => c.state), ["done", "failed", "stopped"]);
	assert.equal(stopChild("s", stopped.id), "ended");
	done.finish("failed");
	assert.equal(one(done.id).state, "done", "an end is final");
});

test("finished children stay 10 minutes, then go (and say so)", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
	const changes = [];
	const off = onChildrenChange((immediate) => changes.push(immediate));
	t.after(off);
	const c = trackChild({ kind: "pi", agent: "a", task: "t", sessionId: "s" });
	const running = trackChild({ kind: "pi", agent: "b", task: "t", sessionId: "s" });
	assert.deepEqual(changes, [true, true], "a start says so at once");
	c.finish("done");
	assert.deepEqual(changes, [true, true, true]);
	assert.equal(KEEP_MS, 10 * 60_000, "ten minutes");
	t.mock.timers.tick(KEEP_MS - 1_000);
	assert.equal(listChildren().length, 2);
	t.mock.timers.tick(2_000);
	assert.deepEqual(listChildren().map((k) => k.id), [running.id], "only the finished one went");
	assert.deepEqual(changes, [true, true, true, true], "its going was told");
	t.mock.timers.tick(KEEP_MS * 3);
	assert.equal(listChildren().length, 1, "a running child never expires");
});

test(`at most ${MAX_CHILDREN}: the oldest finished one goes first`, () => {
	const first = trackChild({ kind: "pi", agent: "a0", task: "t", sessionId: "s" });
	const finished = trackChild({ kind: "pi", agent: "a1", task: "t", sessionId: "s" });
	finished.finish("done");
	assert.equal(MAX_CHILDREN, 16);
	for (let i = 2; i < MAX_CHILDREN; i++) trackChild({ kind: "pi", agent: `a${i}`, task: "t", sessionId: "s" });
	assert.equal(listChildren().length, MAX_CHILDREN);
	trackChild({ kind: "pi", agent: "new", task: "t", sessionId: "s" });
	const ids = listChildren().map((c) => c.id);
	assert.equal(ids.length, MAX_CHILDREN);
	assert.ok(!ids.includes(finished.id) && ids.includes(first.id), "the finished one went, not the oldest running");
	trackChild({ kind: "pi", agent: "newer", task: "t", sessionId: "s" });
	assert.ok(!listChildren().some((c) => c.id === first.id), "none finished: the oldest goes");
	assert.equal(listChildren().length, MAX_CHILDREN);
});

test("stop routing: only this session's children, foreground by its abort, background by bg:kill", () => {
	const events = bus();
	bindChildren(events);
	let aborted = 0;
	const mine = trackChild({ kind: "pi", agent: "a", task: "t", sessionId: "s-mine", stop: () => aborted++ });
	const theirs = trackChild({ kind: "pi", agent: "b", task: "t", sessionId: "s-other", stop: () => assert.fail("never another session's") });
	assert.equal(stopChild("s-mine", theirs.id), "not_found");
	assert.equal(stopChild(null, mine.id), "not_found", "a session without an id stops nothing");
	assert.equal(stopChild("s-mine", "p-nosuchid"), "not_found");
	assert.equal(stopChild("s-mine", mine.id), "stopped");
	assert.equal(aborted, 1);

	const log = join(dir, "kill.log");
	writeFileSync(log, "");
	const bg = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s-mine", bg: { id: "abc123", logPath: log } });
	assert.equal(stopChild("s-other", bg.id), "not_found");
	assert.ok(!events.emitted.some(([ch]) => ch === "bg:kill"));
	assert.equal(stopChild("s-mine", bg.id), "stopped");
	const kill = events.emitted.find(([ch]) => ch === "bg:kill")[1];
	assert.deepEqual([kill.id, kill.wake], ["abc123", true], "its own job, and the parent still hears it ended");
	events.handlers.get("bg:jobs")([{ id: "abc123", endedAt: Date.now(), exitCode: null, signal: "SIGTERM", killedByUser: true }]);
	assert.equal(one(bg.id).state, "stopped");

	const noBg = bus({ kill: false });
	bindChildren(noBg);
	const orphan = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s-mine", bg: { id: "def456", logPath: log } });
	assert.equal(stopChild("s-mine", orphan.id), "unstoppable", "no bg extension took the kill");
	assert.equal(one(orphan.id).state, "running");
	assert.equal(stopChild("s-mine", trackChild({ kind: "pi", agent: "x", task: "t", sessionId: "s-mine" }).id), "unstoppable");

	const late = bus({ killed: false });
	bindChildren(late);
	const done = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s-mine", bg: { id: "ghi789", logPath: log } });
	assert.equal(stopChild("s-mine", done.id), "ended", "its job had exited before the kill");
	late.handlers.get("bg:jobs")([{ id: "ghi789", endedAt: Date.now(), exitCode: 0 }]);
	assert.equal(one(done.id).state, "done", "it finished on its own, not stopped");
});

test("a background pi child: the progress filter's log, then bg's exit", () => {
	const events = bus();
	bindChildren(events);
	const log = join(dir, "pi.log");
	writeFileSync(log, "· turn 1 · read /work/demo/lib/widget.rb\n· turn 2 · bash bin/test | read /work/demo/READ");
	const c = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s", bg: { id: "aa11bb", logPath: log } });
	assert.equal(one(c.id).activity, "Starting…");
	pollOnce();
	assert.deepEqual([one(c.id).turns, one(c.id).tail], [1, ["Read widget.rb"]], "a partial line waits");
	writeFileSync(log, "· turn 1 · read /work/demo/lib/widget.rb\n· turn 2 · bash bin/test | read /work/demo/README.md\n· turn 3 · 4 files look fine\n");
	pollOnce();
	let k = one(c.id);
	assert.equal(k.turns, 3);
	assert.deepEqual(k.tail, ["Read widget.rb", "Ran bin/test", "Read README.md", "> 4 files look fine"]);
	writeFileSync(
		log,
		"· turn 1 · read /work/demo/lib/widget.rb\n· turn 2 · bash bin/test | read /work/demo/README.md\n· turn 3 · 4 files look fine\n" +
			"── result · 3 turns · 4.4k in (3.0k cached) / 130 out · $0.0038 ──\nThe widget is fine.\nSecond line.\n",
	);
	pollOnce();
	k = one(c.id);
	assert.deepEqual(k.usage, { input: 4400, cacheRead: 3000, output: 130, cacheWrite: 0, cost: 0.0038 });
	assert.equal(k.lastText, "The widget is fine.\nSecond line.");
	assert.equal(k.state, "running", "running until bg says it exited");
	const list = events.emitted.findLast(([ch]) => ch === "bg:list");
	assert.ok(list, "each poll asks bg for its jobs");
	list[1].reply([{ id: "aa11bb", endedAt: Date.now(), exitCode: 0, signal: null, killedByUser: false }]);
	assert.equal(one(c.id).state, "done");
	const failed = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s", bg: { id: "cc22dd", logPath: log } });
	events.handlers.get("bg:jobs")([{ id: "cc22dd", endedAt: Date.now(), exitCode: 1, signal: null, killedByUser: false }]);
	assert.equal(one(failed.id).state, "failed");
	const killed = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s", bg: { id: "ee33ff", logPath: log } });
	events.handlers.get("bg:jobs")([{ id: "ee33ff", endedAt: Date.now(), exitCode: null, signal: null, killedByUser: true }]);
	assert.equal(one(killed.id).state, "stopped", "killed from /bg, not the phone");
});

test("a background pi child's commands come whole from the filter's sidecar, not cut to the log line's 110", () => {
	const events = bus();
	bindChildren(events);
	const log = join(dir, "pi-side.log");
	const calls = join(dir, "pi-side.calls.jsonl");
	const long = "cd ~/Code/example/a-very-long-repository-name && git fetch -q origin && git show origin/main:pom.xml | grep -n version";
	writeFileSync(calls, JSON.stringify({ turn: 1, calls: [{ name: "bash", arguments: { command: long } }] }) + "\n");
	writeFileSync(log, `· turn 1 · bash ${long.slice(0, 104)}…\n· turn 2 · bash bin/test\n`);
	const c = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s", bg: { id: "side11", logPath: log, callsPath: calls } });
	pollOnce();
	const page = childTranscript("s", c.id);
	const commands = page.entries.flatMap((e) => (e.message.role === "assistant" ? e.message.content : [])).filter((b) => b.type === "toolCall").map((b) => b.arguments.command);
	assert.deepEqual(commands, [long, "bin/test"], "turn 2 has no sidecar line: the log line's form");
	events.handlers.get("bg:jobs")([{ id: "side11", endedAt: Date.now(), exitCode: 0 }]);
	assert.equal(existsSync(calls), false, "the sidecar goes when the child ends");
});

test("a background pi child says its last turn's context, from a banner that has one", () => {
	const events = bus();
	bindChildren(events);
	const newer = join(dir, "pi-ctx.log");
	writeFileSync(newer, "· turn 1 · 4 files look fine\n── result · 3 turns · 4.4k in (3.0k cached) / 130 out · 1.2k ctx · $0.0038 ──\nFine.\n");
	const c = trackChild({ kind: "pi", agent: "scout", task: "t", model: "anthropic/claude", window: 200_000, sessionId: "s", bg: { id: "aa11bb", logPath: newer } });
	pollOnce();
	const k = one(c.id);
	assert.deepEqual({ ...k.usage, cost: Number(k.usage.cost.toFixed(4)) }, { input: 4400, cacheRead: 3000, output: 130, cacheWrite: 0, context: 1200, cost: 0.0038 });
	assert.equal(k.window, 200_000);
	const older = join(dir, "pi-old.log");
	writeFileSync(older, "── result · 2 turns · 1.3k in (1.0k cached) / 50 out · $0.0010 ──\n4 files\n");
	const o = trackChild({ kind: "pi", agent: "scout", task: "t", sessionId: "s", bg: { id: "bb22cc", logPath: older } });
	pollOnce();
	assert.equal(one(o.id).usage.context, undefined, "an older log says only the run's totals: no context, not theirs");
	assert.deepEqual(one(o.id).usage, { input: 1300, cacheRead: 1000, output: 50, cacheWrite: 0, cost: 0.001 });
});

test("a background Cursor run: steps, its worktree and its answer from the runner's log", () => {
	const events = bus();
	bindChildren(events);
	const log = join(dir, "cursor.log");
	writeFileSync(
		log,
		[
			"cursor gpt-5 · /work/demo · new worktree",
			"session abc-123 · GPT-5 · in /work/demo-wt/cursor-1",
			"→ read lib/widget.rb",
			"✓ read lib/widget.rb",
			"→ shell bin/test",
		].join("\n") + "\n",
	);
	const c = trackChild({ kind: "cursor", agent: "cursor", task: "fix it", model: "gpt-5", sessionId: "s", bg: { id: "ee33ff", logPath: log } });
	pollOnce();
	let k = one(c.id);
	assert.equal(k.worktree, "/work/demo-wt/cursor-1");
	assert.equal(k.activity, "Ran bin/test");
	assert.deepEqual(k.tail, ["Read widget.rb", "Ran bin/test"]);
	writeFileSync(
		log,
		readFileSync(log, "utf8") +
			[
				"✗ shell bin/test",
				"",
				"── cursor result · done · gpt-5 · 1m 2s · $0.42 · 12k tokens ──",
				"Fixed the widget.",
				"",
				"Second paragraph.",
				"",
				"Model: gpt-5",
				"Duration: 1m 2s · 2 step(s)",
				"Worktree: /work/demo-wt/cursor-1b (branch cursor/1), 1 changed file(s)",
				"  M lib/widget.rb",
				"Exit code: 0",
			].join("\n") +
			"\n",
	);
	pollOnce();
	k = one(c.id);
	assert.deepEqual(k.tail, ["Read widget.rb", "✗ Ran bin/test"]);
	assert.equal(k.turns, 2);
	assert.equal(k.lastText, "Fixed the widget.\n\nSecond paragraph.");
	assert.equal(k.worktree, "/work/demo-wt/cursor-1b", "the result's worktree line wins");
	events.handlers.get("bg:jobs")([{ id: "ee33ff", endedAt: Date.now(), exitCode: 0, signal: null, killedByUser: false }]);
	assert.equal(one(c.id).state, "done");
});

test("a foreground Cursor run's reducer state", () => {
	const c = trackChild({ kind: "cursor", agent: "cursor", task: "t", sessionId: "s" });
	c.cursorState({ tools: [{ summary: "read a.rb", ok: true }, { summary: "shell bin/test" }], live: "", thinking: false }, "/wt/one");
	let k = one(c.id);
	assert.deepEqual([k.activity, k.turns, k.tail, k.worktree], ["Ran bin/test", 2, ["Read a.rb", "Ran bin/test"], "/wt/one"]);
	c.cursorState({ tools: [{ summary: "read a.rb", ok: true }, { summary: "shell bin/test", ok: false }], live: "Tests fail", thinking: false });
	k = one(c.id);
	assert.deepEqual([k.activity, k.tail.at(-1), k.lastText], ["Writing…", "✗ Ran bin/test", "Tests fail"]);
});

test("subagents:update goes out on every bound bus; a stale one is dropped", () => {
	const a = bus();
	bindChildren(a);
	bindChildren(a); // once per bus
	const c = trackChild({ kind: "pi", agent: "a", task: "t", sessionId: "s" });
	const updates = a.emitted.filter(([ch]) => ch === "subagents:update");
	assert.equal(updates.length, 1);
	assert.deepEqual(updates[0][1].children.map((k) => k.id), [c.id]);
	let calls = 0;
	const stale = { on() {}, emit() { calls++; throw new Error("This extension ctx is stale"); } };
	bindChildren(stale);
	c.finish("done");
	c.finish("done");
	trackChild({ kind: "pi", agent: "b", task: "t", sessionId: "s" });
	assert.equal(calls, 1, "a stale bus is unsubscribed after its first throw");
});

test("sessionOf reads the tool context's session id", () => {
	assert.equal(sessionOf({ sessionManager: { getSessionId: () => "s-9" } }), "s-9");
	assert.equal(sessionOf({ sessionManager: { getSessionId: () => { throw new Error("gone"); } } }), null);
	assert.equal(sessionOf(undefined), null);
});

// ---- a child's conversation (childTranscript)

/** Its whole conversation, every page. */
function conversation(sessionId, id) {
	const all = [];
	let since = -1;
	for (;;) {
		const page = childTranscript(sessionId, id, since);
		assert.ok(page, "listed");
		all.push(...page.entries);
		if (!page.more) return { entries: all, page };
		since = page.entries.at(-1).seq;
	}
}
/** An entry as role and what it says, for comparing in order. */
const said = (e) => {
	const m = e.message;
	if (m.role === "toolResult") return ["result", m.toolCallId, m.content[0].text, m.isError];
	return [m.role, ...m.content.map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? `(thinking) ${b.thinking}` : `${b.name} ${JSON.stringify(b.arguments)}`))];
};

test("a foreground pi child's conversation from its JSON events: in order, masked, the partial reply live", () => {
	const c = trackChild({ kind: "pi", agent: "scout", task: "look at the widget\nwith password=hunter2", sessionId: "s-1" });
	const lives = [];
	for (const line of fixture) {
		c.piLine(line);
		lives.push(childTranscript("s-1", c.id).live);
	}
	assert.ok(lives.includes("The"), "the reply being written shows as it streams");
	assert.equal(lives.at(-1), "", "and goes once its message ends");
	const { entries } = conversation("s-1", c.id);
	assert.deepEqual(entries.map((e) => e.seq), entries.map((_, i) => i), "numbered from 0, in order");
	assert.deepEqual(entries.map(said), [
		["user", "look at the widget\nwith password=•••"],
		["assistant", 'read {"path":"/work/demo/lib/widget.rb"}'],
		["result", "call-1", "class Widget; end", false],
		["assistant", "Running the tests now.", 'bash {"command":"API_TOKEN=••• bin/test\\nmore"}'],
		["result", "call-2", "1 failure", true],
		["assistant", "The widget test fails on line 12.\nFix: return nil."],
	]);
	assert.ok(entries.every((e) => e.type === "message" && e.id === String(e.seq) && !Number.isNaN(Date.parse(e.timestamp))), "a session file's entries");
	c.finish("done", { lastText: "The widget test fails on line 12.\nFix: return nil." });
	assert.equal(conversation("s-1", c.id).entries.length, 6, "its last message is the final reply: not twice");
	assert.equal(childTranscript("s-other", c.id), null, "only its own session's");
	assert.equal(childTranscript(null, c.id), null);
});

test("a huge tool result is masked from its head, or whole when masking shrank the head away", () => {
	const c = trackChild({ kind: "pi", agent: "worker", task: "t", sessionId: "s" });
	const result = (id, text) => {
		c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "cat" } }] } });
		c.piEvent({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text }] } });
		return conversation("s", c.id).entries.at(-1).message.content[0].text;
	};
	const head = result("t1", `password=hunter2 ${"z".repeat(500_000)}`);
	assert.ok(head.startsWith("password=••• zzz") && head.endsWith("…") && head.length <= 1_000);
	assert.equal(result("t2", `password=${"a".repeat(40_000)} tail`), "password=••• tail", "the whole, when the head's cut would show");
});

test("the conversation's cap: the task and the final reply stay, the oldest work goes first", () => {
	const c = trackChild({ kind: "pi", agent: "worker", task: "the task", sessionId: "s" });
	c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "An early note." }] } });
	for (let i = 0; i < LOG_ENTRIES; i++) {
		c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `step ${i}` } }] } });
		c.piEvent({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "bash", result: { content: [{ type: "text", text: "z".repeat(5000) }] } });
	}
	let { entries } = conversation("s", c.id);
	assert.ok(entries.length <= LOG_ENTRIES);
	assert.deepEqual(said(entries[0]), ["user", "the task"]);
	assert.deepEqual(said(entries[1]), ["assistant", "An early note."], "work went before the note");
	const results = new Set(entries.filter((e) => e.message.role === "toolResult").map((e) => e.message.toolCallId));
	const calls = new Set(entries.flatMap((e) => (e.message.role === "assistant" ? e.message.content.filter((b) => b.type === "toolCall").map((b) => b.id) : [])));
	assert.deepEqual([...results].filter((id) => !calls.has(id)), [], "a call's result goes with it");
	assert.ok(!calls.has("t0") && calls.has(`t${LOG_ENTRIES - 1}`), "the oldest went, the newest stayed");
	c.finish("done", { lastText: "The final answer." });
	({ entries } = conversation("s", c.id));
	assert.deepEqual(said(entries.at(-1)), ["assistant", "The final answer."]);
	assert.deepEqual(said(entries[0]), ["user", "the task"]);

	const big = trackChild({ kind: "pi", agent: "worker", task: "t", sessionId: "s" });
	for (let i = 0; i < 300; i++) {
		big.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `note ${i} ${"w".repeat(4000)}` }] } });
	}
	big.finish("done", { lastText: "done it" });
	({ entries } = conversation("s", big.id));
	const bytes = entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
	assert.ok(bytes <= LOG_BYTES, `${bytes} bytes kept`);
	assert.deepEqual([said(entries[0]), said(entries.at(-1))], [["user", "t"], ["assistant", "done it"]], "no work to drop: the oldest notes go");
	assert.ok(entries.length < 300 && entries.length > 2);
});

test("an entry is at most ENTRY_BYTES; a page at most its bytes, one entry at least, and says there is more", () => {
	const c = trackChild({ kind: "pi", agent: "worker", task: "t", sessionId: "s" });
	c.piEvent({ type: "message_end", message: { role: "assistant", content: Array.from({ length: 10 }, () => ({ type: "text", text: "é".repeat(15000) })) } });
	const one = childTranscript("s", c.id, 0);
	assert.equal(one.entries.length, 1);
	assert.ok(Buffer.byteLength(JSON.stringify(one.entries[0])) <= ENTRY_BYTES);
	const shrunk = one.entries[0].message.content;
	assert.ok(shrunk.length === 10 && shrunk.every((b) => b.text.startsWith("éé") && b.text.endsWith("…")), "each text cut to fit, not the entry replaced");
	for (let i = 0; i < 20; i++) c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${i} ${"x".repeat(3000)}` }] } });
	const first = childTranscript("s", c.id, -1, 10_000);
	assert.ok(first.more && first.entries.length >= 1);
	assert.ok(first.entries.slice(1).reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0) <= 10_000);
	assert.equal(childTranscript("s", c.id, -1, 1).entries.length, 1, "one entry even past the bytes");
	assert.equal(first.last, 21);
	const rest = childTranscript("s", c.id, 21);
	assert.deepEqual([rest.entries.length, rest.more], [0, false], "nothing past the newest");
	assert.ok(PAGE_BYTES < 64 * 1024);
});

test("a finished child's conversation stays its 10 minutes, then goes with it", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2_000_000 });
	const c = trackChild({ kind: "pi", agent: "a", task: "t", sessionId: "s" });
	c.finish("done", { lastText: "ok" });
	t.mock.timers.tick(KEEP_MS - 1_000);
	assert.deepEqual(childTranscript("s", c.id).entries.map(said), [["user", "t"], ["assistant", "ok"]]);
	t.mock.timers.tick(1_010); // past its 10 minutes, before the sweep's timer: the read itself drops it
	assert.equal(childTranscript("s", c.id), null);
});

test("a failure's reason is no reply; calls left open close when it ends", () => {
	const c = trackChild({ kind: "pi", agent: "a", task: "t", sessionId: "s" });
	c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "not for the phone", redacted: true }] } });
	c.piEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "x1", name: "bash", arguments: { command: "sleep 99", token: "abc123", env: { API_KEY: "k-1" } } }] } });
	c.piEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `${"y".repeat(5000)} the end` }] } });
	const { live } = childTranscript("s", c.id);
	assert.ok(live.length === 4000 && live.startsWith("…") && live.endsWith(" the end"), "the reply on its way: its last 4,000 characters");
	c.finish("failed", { lastText: "killed by SIGTERM" });
	const { entries } = conversation("s", c.id);
	assert.deepEqual(entries.map(said), [
		["user", "t"],
		["assistant", 'bash {"command":"sleep 99","token":"•••","env":{"API_KEY":"•••"}}'],
		["result", "x1", "", false],
	]);
});

test("a background pi child's conversation from its log: each turn's calls, its notes, the result as its reply", () => {
	const events = bus();
	bindChildren(events);
	const log = join(dir, "pi-chat.log");
	writeFileSync(log, "· turn 1 · read /work/demo/lib/widget.rb\n· turn 2 · bash bin/test | grep TODO\n· turn 3 · 4 files look fine\n");
	const c = trackChild({ kind: "pi", agent: "scout", task: "check it", sessionId: "s", bg: { id: "bb11cc", logPath: log } });
	pollOnce();
	writeFileSync(log, `${readFileSync(log, "utf8")}── result · 3 turns · 4.4k in (3.0k cached) / 130 out · $0.0038 ──\nThe widget is fine.\nSecond line.\n`);
	pollOnce();
	events.handlers.get("bg:jobs")([{ id: "bb11cc", endedAt: Date.now(), exitCode: 0, signal: null, killedByUser: false }]);
	const { entries } = conversation("s", c.id);
	const ids = entries.filter((e) => e.message.role === "assistant").flatMap((e) => e.message.content.filter((b) => b.type === "toolCall").map((b) => b.id));
	assert.deepEqual(entries.map(said), [
		["user", "check it"],
		["assistant", 'read {"path":"/work/demo/lib/widget.rb"}'],
		["result", ids[0], "", false],
		["assistant", 'bash {"command":"bin/test"}', 'grep {"pattern":"TODO"}'],
		["result", ids[1], "", false],
		["result", ids[2], "", false],
		["assistant", "4 files look fine"],
		["assistant", "The widget is fine.\nSecond line."],
	]);
});

test("a Cursor child's conversation: its steps as calls, a failed one an error, its answer last", () => {
	const events = bus();
	bindChildren(events);
	const log = join(dir, "cursor-chat.log");
	writeFileSync(log, ["session abc · GPT-5", "→ read lib/widget.rb", "✓ read lib/widget.rb", "✗ shell bin/test", "→ ls src", "", "── cursor result · done · gpt-5 · 1m · $0.42 · 12k tokens ──", "Fixed it.", "", "Model: gpt-5", ""].join("\n"));
	const bg = trackChild({ kind: "cursor", agent: "cursor", task: "fix", sessionId: "s", bg: { id: "cc11dd", logPath: log } });
	pollOnce();
	assert.equal(conversation("s", bg.id).entries.at(-1).message.role, "toolResult", "its result banner closes a step left open, before its job ends");
	events.handlers.get("bg:jobs")([{ id: "cc11dd", endedAt: Date.now(), exitCode: 0 }]);
	const steps = conversation("s", bg.id).entries.map(said);
	assert.deepEqual(steps.map((s) => s[0]), ["user", "assistant", "result", "assistant", "result", "assistant", "result", "assistant"]);
	assert.deepEqual([steps[1][1], steps[2][3], steps[3][1], steps[4][3], steps[5][1], steps[7][1]], ['read {"path":"lib/widget.rb"}', false, 'bash {"command":"bin/test"}', true, 'ls {"path":"src"}', "Fixed it."]);

	const fg = trackChild({ kind: "cursor", agent: "cursor", task: "t", sessionId: "s" });
	fg.cursorState({ tools: [{ summary: "read a.rb", ok: true }, { summary: "shell bin/test" }], live: "Look", thinking: false });
	assert.equal(childTranscript("s", fg.id).live, "Look");
	fg.cursorState({ tools: [{ summary: "read a.rb", ok: true }, { summary: "shell bin/test", ok: false }], live: "", thinking: false });
	fg.finish("done", { lastText: "All set." });
	const run = conversation("s", fg.id).entries.map(said);
	assert.deepEqual(run, [
		["user", "t"],
		["assistant", 'read {"path":"a.rb"}'],
		["result", "cursor-0", "", false],
		["assistant", 'bash {"command":"bin/test"}'],
		["result", "cursor-1", "", true],
		["assistant", "All set."],
	]);
	assert.deepEqual(cursorCall("mcp thing"), { name: "mcp", args: { summary: "thing" } });
});
