/**
 * The subagent tool's cursor agent: Cursor's agent CLI in place of a pi child,
 * through the cursor-agent extension's run.ts and runner.ts.
 *
 * Never runs the real cursor-agent or touches the network: PI_CURSOR_AGENT_BIN
 * points at a fake that prints recorded stream-json events, the charge lookup
 * is injected (or the fake run has no session id, so there is none), and a
 * failing `security` shim goes first on PATH in case anything reaches the
 * Keychain. pi children are a fake child script (process.argv[1]). The bg
 * extension is a fake listener, except in one end-to-end test that loads the
 * real one to check the completion message.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "subagent-cursor-test-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

process.env.BOEHSLINE_CONFIG = path.join(scratch, "none.json");
process.env.BOEHSLINE_ENABLE = "cursor-agent";
process.env.PI_BG_DIR = path.join(scratch, "bg");
process.env.PI_BG_WAKE = "followUp";
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
delete process.env.PI_SUBAGENT_CHILD;
for (const k of Object.keys(process.env)) if (k.startsWith("PI_CURSOR_")) delete process.env[k];

// A failing Keychain shim, so nothing can read a real Cursor token.
const shims = path.join(scratch, "shims");
mkdirSync(shims);
writeFileSync(path.join(shims, "security"), "#!/bin/sh\nexit 44\n");
chmodSync(path.join(shims, "security"), 0o755);
process.env.PATH = `${shims}${path.delimiter}${process.env.PATH}`;

// The fake cursor-agent: FAKE_CURSOR_* env vars pick what it prints; each run
// records its argv in FAKE_CURSOR_ARGS_DIR (parallel runs each get a file).
const argsDir = path.join(scratch, "args");
mkdirSync(argsDir);
const fake = path.join(scratch, "fake-cursor-agent");
writeFileSync(
	fake,
	`#!${process.execPath}
const fs = require("node:fs");
const e = process.env;
const out = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
fs.writeFileSync(${JSON.stringify(argsDir)} + "/" + process.pid + ".json", JSON.stringify(process.argv.slice(2)));
out({ type: "system", subtype: "init", ...(e.FAKE_CURSOR_SESSION ? { session_id: e.FAKE_CURSOR_SESSION } : {}), model: "Composer Two", cwd: e.FAKE_CURSOR_WS || process.cwd() });
out({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "npm test" } } } });
const until = Date.now() + 60; while (Date.now() < until); // a separate chunk, like a real step
out({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { shellToolCall: { args: { command: "npm test" }, result: { success: { exitCode: 0 } } } } });
out({ type: "assistant", message: { content: [{ text: e.FAKE_CURSOR_ANSWER ?? "Fixed the bug." }] } });
out({ type: "result", subtype: "success", duration_ms: 185000, usage: { inputTokens: 1000, outputTokens: 200 } });
if (e.FAKE_CURSOR_STDERR) process.stderr.write(e.FAKE_CURSOR_STDERR);
process.exitCode = Number(e.FAKE_CURSOR_EXIT ?? 0);
`,
);
chmodSync(fake, 0o755);
process.env.PI_CURSOR_AGENT_BIN = fake;

const fakeEnv = (vars = {}) => {
	for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_CURSOR_")) delete process.env[k];
	Object.assign(process.env, vars);
};

/** Every cursor-agent argv since the last call, then forget them. */
function cursorRuns() {
	const runs = readdirSync(argsDir).map((f) => JSON.parse(readFileSync(path.join(argsDir, f), "utf8")));
	for (const f of readdirSync(argsDir)) rmSync(path.join(argsDir, f));
	return runs;
}

// A repo with a commit, and a worktree of it with one changed file (what Cursor leaves).
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
const repo = path.join(scratch, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "fizz.rb"), "puts 1\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");
const wt = path.join(scratch, "wt");
git(repo, "worktree", "add", "-q", "-b", "pi-test-branch", wt);
writeFileSync(path.join(wt, "fizz.rb"), "puts 2\n");

// An agent file that picks the cursor runner, with its own defaults.
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "agents"), { recursive: true });
writeFileSync(
	path.join(process.env.PI_CODING_AGENT_DIR, "agents", "cursor-reviewer.md"),
	"---\nname: cursor-reviewer\nrunner: cursor\nmodel: composer-2\nmode: ask\nworktree: false\nnetwork: true\n---\nReview the diff and list risks.\n",
);

const { subagentExtension } = await import("../extensions/subagent/index.ts");
const { WAKE_CHARS } = await import("../extensions/opt-in/cursor-agent/runner.ts");

/** Load the extension with an injected charge lookup; `run` calls the latest registered subagent tool. */
function mount({ findCharge, cwd = repo } = {}) {
	const stub = stubPi();
	Object.assign(stub.pi, { getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {} });
	const lookups = [];
	subagentExtension({
		findCharge: async (sessionId, since) => {
			lookups.push(sessionId);
			return findCharge?.(sessionId, since);
		},
	})(stub.pi);
	const { ctx } = stubCtx({ cwd, model: { provider: "anthropic", id: "claude-opus-5.5" } });
	const tool = () => stub.tools.findLast((t) => t.name === "subagent");
	const run = (params, onUpdate) => tool().execute("call-1", params, undefined, onUpdate, ctx);
	return { ...stub, tool, ctx, run, lookups };
}

const textOf = (result) => result.content.map((p) => p.text ?? "").join("\n");
const charge = async () => ({ timestamp: "0", model: "composer-2", chargedCents: 42.5, cursorTokenFee: 2.5, tokenUsage: { inputTokens: 1000, outputTokens: 200 } });

/** Run with process.argv[1] (the child pi script) swapped for one that answers `reply`. */
async function withPiChild(reply, fn) {
	const file = path.join(mkdtempSync(path.join(scratch, "child-")), "child.mjs");
	const turn = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }], usage: { input: 10, output: 5 } } };
	writeFileSync(file, `process.stdout.write(${JSON.stringify(JSON.stringify(turn))} + "\\n");\n`);
	const saved = process.argv[1];
	process.argv[1] = file;
	try {
		return await fn();
	} finally {
		process.argv[1] = saved;
	}
}

test("cursor is a built-in agent, with its own params and the safety notes in the description", async (t) => {
	const h = mount();
	assert.match(textOf(await h.run({})), /Agents: .*\bcursor\b/);
	const p = h.tool().parameters.properties;
	for (const key of ["cursorMode", "worktree"]) {
		assert.ok(p[key], `single ${key}`);
		assert.ok(p.tasks.items.properties[key], `per-task ${key}`);
	}
	assert.ok(p.tasks.items.properties.model, "per-task model");
	assert.match(h.tool().description, /cursor=Cursor's agent CLI/);
	assert.match(h.tool().description, /never contain PII, PHI, secrets/);

	// The cursor-agent settings' note and rules (a work seat's) join at session_start.
	process.env.PI_CURSOR_NOTE = "VA Cursor pilot seat (temporary ATO). Never send PII, PHI, Veteran data or secrets.";
	process.env.PI_CURSOR_RULES = "The cursor tool's prompt must not contain PII, PHI, Veteran data or secrets; this is a VA pilot.";
	t.after(() => {
		delete process.env.PI_CURSOR_NOTE;
		delete process.env.PI_CURSOR_RULES;
	});
	await h.fire("session_start", { type: "session_start" }, h.ctx);
	const d = h.tool().description;
	assert.ok(d.includes("Cursor rules: VA Cursor pilot seat (temporary ATO). Never send PII, PHI, Veteran data or secrets."), d);
	assert.ok(d.includes("this is a VA pilot."), d);
	assert.equal(h.tools.filter((x) => x.name === "subagent").length, 2, "re-registered under the same name");
});

test("foreground: the result block and details carry answer, model, duration, dollars, worktree and exit code", async () => {
	const h = mount({ findCharge: charge });
	fakeEnv({ FAKE_CURSOR_SESSION: "sess-42", FAKE_CURSOR_WS: wt, FAKE_CURSOR_ANSWER: "Fixed fizz.rb; tests pass." });
	cursorRuns();
	const updates = [];
	const result = await h.run({ agent: "cursor", task: "Fix fizz", model: "composer-2" }, (u) => updates.push(u));

	const text = textOf(result);
	assert.match(text, /^── cursor result · done · composer-2 · 3m05s · \$0\.4250 \(incl\. \$0\.0250 Cursor fee\) · 1K tokens ──\nFixed fizz\.rb; tests pass\.\n/);
	assert.match(text, /Model: composer-2 \(Composer Two\)/);
	assert.match(text, /Duration: 3m05s · 1 step\(s\)/);
	assert.match(text, /Charged: \$0\.4250 \(chargedCents 42\.5\)/);
	assert.ok(text.includes(`Worktree: ${wt} (branch pi-test-branch), 1 changed file(s)\n   M fizz.rb`), text);
	assert.match(text, /Session: sess-42/);
	assert.match(text, /Exit code: 0/);
	assert.deepEqual(h.lookups, ["sess-42"]);

	assert.deepEqual(result.details.results, [
		{
			agent: "cursor",
			ok: true,
			cursor: {
				model: "composer-2",
				durationMs: 185000,
				exitCode: 0,
				chargedCents: 42.5,
				charged: "$0.4250",
				sessionId: "sess-42",
				worktree: { path: wt, branch: "pi-test-branch", changed: [" M fizz.rb"] },
			},
		},
	]);
	assert.equal(result.usage, undefined, "Cursor's tokens are not pi usage");
	assert.ok(updates.some((u) => /▶ cursor · step 1/.test(textOf(u))), "live progress per Cursor step");

	const [argv] = cursorRuns();
	assert.deepEqual(argv.slice(0, 9), ["-p", "--trust", "--output-format", "stream-json", "--stream-partial-output", "--sandbox", "enabled", "--model", "composer-2"]);
	assert.match(argv.at(-1), /^You are a subagent\. Your final message goes to another AI agent/);
	assert.match(argv.at(-1), /\n\nTask: Fix fizz$/);
});

test("defaults: the cursor-agent settings model (not the parent's pi model), agent mode, a new worktree", async (t) => {
	process.env.PI_CURSOR_MODEL = "composer-2.5";
	t.after(() => delete process.env.PI_CURSOR_MODEL);
	const h = mount();
	fakeEnv({ FAKE_CURSOR_WS: wt });
	cursorRuns();
	const result = await h.run({ agent: "cursor", task: "Fix fizz" });
	assert.equal(result.details.results[0].ok, true);
	assert.equal(result.details.results[0].cursor.model, "composer-2.5");
	const [argv] = cursorRuns();
	assert.deepEqual(argv.slice(7, 9), ["--model", "composer-2.5"]);
	assert.ok(!argv.includes("--mode"), "agent mode is cursor-agent's default");
	assert.match(argv[argv.indexOf("--worktree") + 1], /^pi-/, "worktree on by default");
	assert.equal(h.lookups.length, 0, "no session id, no cost lookup");
});

test("overrides: model, cursorMode and worktree on the single call and per task", async () => {
	const h = mount();
	fakeEnv();
	cursorRuns();
	const single = await h.run({ agent: "cursor", task: "Plan it", model: "gpt-5.6", cursorMode: "plan", worktree: false });
	assert.equal(single.details.results[0].ok, true);
	assert.equal(single.details.results[0].cursor.worktree, undefined);
	let [argv] = cursorRuns();
	assert.deepEqual(argv.slice(7, 11), ["--model", "gpt-5.6", "--mode", "plan"]);
	assert.ok(!argv.includes("--worktree"));

	const perTask = await h.run({ model: "ignored-by-task", tasks: [{ agent: "cursor", task: "Ask it", model: "composer-2", cursorMode: "ask", worktree: false }] });
	assert.equal(perTask.details.results[0].ok, true);
	[argv] = cursorRuns();
	assert.deepEqual(argv.slice(7, 11), ["--model", "composer-2", "--mode", "ask"]);
	assert.ok(!argv.includes("--worktree"));
});

test("an agents/*.md file with runner: cursor sets model, mode, worktree and network; the call still overrides", async () => {
	const h = mount();
	fakeEnv();
	cursorRuns();
	assert.equal((await h.run({ agent: "cursor-reviewer", task: "Review" })).details.results[0].ok, true);
	let [argv] = cursorRuns();
	assert.deepEqual(argv.slice(5, 11), ["--sandbox", "disabled", "--model", "composer-2", "--mode", "ask"]);
	assert.ok(!argv.includes("--worktree"));
	assert.match(argv.at(-1), /Review the diff and list risks\.\n\nTask: Review$/);

	await h.run({ agent: "cursor-reviewer", task: "Fix", model: "composer-2.5", cursorMode: "agent", worktree: true });
	[argv] = cursorRuns();
	assert.deepEqual(argv.slice(7, 9), ["--model", "composer-2.5"]);
	assert.ok(!argv.includes("--mode"));
	assert.ok(argv.includes("--worktree"));
});

test("a failed run is not ok and keeps the exit code and stderr", async () => {
	const h = mount();
	fakeEnv({ FAKE_CURSOR_EXIT: "2", FAKE_CURSOR_STDERR: "bad thing" });
	const result = await h.run({ agent: "cursor", task: "x", worktree: false });
	const r = result.details.results[0];
	assert.equal(r.ok, false);
	assert.equal(r.cursor.exitCode, 2);
	assert.equal(r.cursor.error, "bad thing");
	assert.match(textOf(result), /── cursor result · exit 2 · auto ·/);
	assert.match(textOf(result), /Exit code: 2\nError: bad thing/);
	cursorRuns();
});

test("parallel tasks mix scout, worker and cursor", async () => {
	const h = mount();
	fakeEnv({ FAKE_CURSOR_WS: wt, FAKE_CURSOR_ANSWER: "Cursor did it." });
	cursorRuns();
	const result = await withPiChild("pi child report", () =>
		h.run({ tasks: [{ agent: "scout", task: "look" }, { agent: "cursor", task: "fix" }, { agent: "worker", task: "edit" }, { agent: "cursor", task: "fix too" }] }),
	);
	const text = textOf(result);
	assert.match(text, /^4\/4 succeeded/);
	assert.match(text, /### \[scout\] ok\n\npi child report/);
	assert.match(text, /### \[worker\] ok\n\npi child report/);
	assert.match(text, /### \[cursor\] ok\n\n── cursor result · done · auto · 3m05s · cost not found ──\nCursor did it\./);
	assert.deepEqual(result.details.results.map((r) => [r.agent, r.ok, !!r.cursor]), [["scout", true, false], ["cursor", true, true], ["worker", true, false], ["cursor", true, true]]);
	assert.equal(result.details.turns, 2, "the pi children's turns");
	assert.equal(result.usage.input, 20, "the pi children's usage only");
	const runs = cursorRuns();
	assert.equal(runs.length, 2);
	const names = runs.map((argv) => argv[argv.indexOf("--worktree") + 1]);
	assert.notEqual(names[0], names[1], "each cursor task gets its own worktree");
});

test("background: a cursor task is the cursor runner as a bg job, next to pi children", async () => {
	const h = mount();
	const reqs = [];
	h.pi.events.on("bg:start", (r) => {
		r.accepted = true;
		reqs.push(r);
		queueMicrotask(() => r.reply({ id: `job${reqs.length}`, logPath: `/tmp/pi-bg-test/job${reqs.length}.log` }));
	});
	fakeEnv();
	cursorRuns();
	const result = await h.run({ tasks: [{ agent: "scout", task: "look" }, { agent: "cursor", task: "Fix it's bug", model: "composer-2" }], background: true });

	const text = textOf(result);
	assert.match(text, /\[scout\] bg job1 · log \/tmp\/pi-bg-test\/job1\.log/);
	assert.match(text, /\[cursor\] bg job2 · log \/tmp\/pi-bg-test\/job2\.log · composer-2 · new worktree/);
	assert.deepEqual(result.details, { results: [], background: true });
	assert.equal(cursorRuns().length, 0, "cursor-agent was not started by the tool");

	const [pi, cursor] = reqs;
	assert.ok(pi.command.startsWith("PI_SUBAGENT_CHILD=1 "));
	assert.equal(cursor.name, "sa:cursor");
	assert.equal(cursor.summary, "subagent cursor: Fix it's bug");
	assert.equal(cursor.cwd, repo);
	assert.equal(cursor.tailMaxChars, WAKE_CHARS);
	assert.match(cursor.command, /runner\.ts' '/);
	const specPath = cursor.command.match(/'([^']+spec\.json)'$/)[1];
	const spec = JSON.parse(readFileSync(specPath, "utf8"));
	assert.equal(spec.model, "composer-2");
	assert.equal(spec.worktree, true);
	assert.equal(spec.bin, fake);
	assert.ok(spec.cliArgs.includes("--worktree"));
	assert.match(spec.cliArgs.at(-1), /Task: Fix it's bug$/);
	rmSync(path.dirname(specPath), { recursive: true, force: true });
});

test("background end to end through the real bg extension: the wake carries the cursor result block", async () => {
	const h = mount();
	const { default: bg } = await import("../extensions/bg/index.ts");
	bg(h.pi);
	await h.fire("session_start", { type: "session_start" }, { ...h.ctx, mode: "print", hasUI: false });
	fakeEnv({ FAKE_CURSOR_WS: wt, FAKE_CURSOR_ANSWER: "All done in the worktree." });

	const started = Date.now();
	const result = await h.run({ agent: "cursor", task: "Do the thing", background: true });
	assert.ok(Date.now() - started < 5_000, "returns before the run finishes");
	const id = textOf(result).match(/\[cursor\] bg (\S+) · log/)[1];

	const deadline = Date.now() + 20_000;
	let wake;
	while (!(wake = h.sent.find((s) => s.message?.customType === "bg")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	assert.ok(wake, "bg sent a completion message");
	const msg = wake.message.content;
	assert.match(msg, new RegExp(`^\\[bg ${id}\\] \`subagent cursor: Do the thing\` succeeded`));
	assert.match(msg, /── cursor result · done · auto · 3m05s · cost not found ──\nAll done in the worktree\./);
	assert.ok(msg.includes(`Worktree: ${wt} (branch pi-test-branch), 1 changed file(s)`));
	assert.match(msg, /Exit code: 0/);
	cursorRuns();
});

test("cursor-agent not enabled: a clear error for the cursor task only", async (t) => {
	process.env.BOEHSLINE_ENABLE = "";
	t.after(() => (process.env.BOEHSLINE_ENABLE = "cursor-agent"));
	const h = mount();
	fakeEnv();
	cursorRuns();

	const single = await h.run({ agent: "cursor", task: "x" });
	assert.match(textOf(single), /^The cursor agent needs the cursor-agent extension, which is opt-in and not enabled\. Turn it on with \/boehsline enable cursor-agent\.$/);
	assert.deepEqual(single.details.results, [{ agent: "cursor", ok: false }]);

	const mixed = await withPiChild("scout report", () => h.run({ tasks: [{ agent: "scout", task: "look" }, { agent: "cursor", task: "fix" }] }));
	assert.match(textOf(mixed), /^1\/2 succeeded/);
	assert.match(textOf(mixed), /### \[scout\] ok\n\nscout report/);
	assert.match(textOf(mixed), /### \[cursor\] FAILED\n\nThe cursor agent needs the cursor-agent extension/);

	const reqs = [];
	h.pi.events.on("bg:start", (r) => {
		r.accepted = true;
		reqs.push(r);
		r.reply({ id: "j1", logPath: "/tmp/j1.log" });
	});
	const bgResult = await h.run({ tasks: [{ agent: "scout", task: "look" }, { agent: "cursor", task: "fix" }], background: true });
	assert.match(textOf(bgResult), /\[scout\] bg j1/);
	assert.match(textOf(bgResult), /\[cursor\] The cursor agent needs the cursor-agent extension/);
	assert.equal(reqs.length, 1, "only the pi child was started");
	assert.equal(cursorRuns().length, 0);
});

test("cursor-agent CLI missing: a clear error, nothing started", async (t) => {
	t.after(() => (process.env.PI_CURSOR_AGENT_BIN = fake));
	const h = mount();
	process.env.PI_CURSOR_AGENT_BIN = path.join(scratch, "no-such-cursor-agent");
	assert.match(textOf(await h.run({ agent: "cursor", task: "x" })), /needs Cursor's CLI, and .*no-such-cursor-agent was not found\. Install it from https:\/\/cursor\.com\/cli/);

	process.env.PI_CURSOR_AGENT_BIN = "cursor-agent-not-on-path";
	let bgCalls = 0;
	h.pi.events.on("bg:start", () => bgCalls++);
	assert.match(textOf(await h.run({ agent: "cursor", task: "x", background: true })), /\[cursor\] The cursor agent needs Cursor's CLI, and cursor-agent-not-on-path was not found/);
	assert.equal(bgCalls, 0);
});

test("the default worktree needs a git repo; the error says how to run without one", async () => {
	const plain = mkdtempSync(path.join(scratch, "plain-"));
	const h = mount({ cwd: plain });
	const result = await h.run({ agent: "cursor", task: "x" });
	assert.match(textOf(result), /worktree needs a git repo with at least one commit: .* \(or pass worktree: false\)/);
	assert.equal(existsSync(path.join(plain, ".git")), false);
});
