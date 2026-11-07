/**
 * Cursor refusing its own tools: outside the sandbox (network: true) cursor-agent
 * asks before every shell command, print mode can't answer, and each call comes
 * back as `result.rejected`. Checks that refused steps aren't counted as
 * successes, that a run is stopped after REFUSAL_LIMIT refusals with a message
 * naming the fix, and that `force` (and only `force`) passes --force, on the
 * cursor tool and on the subagent's cursor runner.
 *
 * Never runs the real cursor-agent or touches the network: PI_CURSOR_AGENT_BIN
 * points at a fake, and a failing `security` shim keeps the Keychain out of reach.
 * REJECTED is the event shape recorded from a real composer-2.5 run with
 * `--sandbox disabled` and no --force (prompt: run `echo ok`).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "cursor-refusals-test-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

process.env.BOEHSLINE_CONFIG = path.join(scratch, "none.json");
process.env.BOEHSLINE_ENABLE = "cursor-agent";
process.env.PI_BG_DIR = path.join(scratch, "bg");
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
delete process.env.PI_SUBAGENT_CHILD;
for (const k of Object.keys(process.env)) if (k.startsWith("PI_CURSOR_")) delete process.env[k];

const shims = path.join(scratch, "shims");
mkdirSync(shims);
writeFileSync(path.join(shims, "security"), "#!/bin/sh\nexit 44\n");
chmodSync(path.join(shims, "security"), 0o755);
process.env.PATH = `${shims}${path.delimiter}${process.env.PATH}`;

/** One refused shell call, as cursor-agent streams it (trimmed to the fields we read). */
const rejected = (id, command = "echo ok") => [
	{ type: "tool_call", subtype: "started", call_id: id, tool_call: { shellToolCall: { args: { command } } } },
	{
		type: "tool_call",
		subtype: "completed",
		call_id: id,
		tool_call: {
			shellToolCall: {
				args: { command },
				result: { rejected: { command, workingDirectory: "/private/tmp/cursor-refuse", reason: "", isReadonly: false } },
			},
		},
	},
];

// FAKE_REFUSE=twice replays the recorded run (two refusals, then Cursor gives up and answers);
// FAKE_REFUSE=forever keeps refusing until it is killed, writing its pid to FAKE_PIDFILE.
const fake = path.join(scratch, "fake-cursor-agent");
writeFileSync(
	fake,
	`#!${process.execPath}
const fs = require("node:fs");
const e = process.env;
const out = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
const rejected = ${rejected.toString()};
if (e.FAKE_ARGS) fs.writeFileSync(e.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
out({ type: "system", subtype: "init", session_id: "", model: "Composer 2.5", cwd: process.cwd() });
if (e.FAKE_REFUSE === "forever") {
  if (e.FAKE_PIDFILE) fs.writeFileSync(e.FAKE_PIDFILE, String(process.pid));
  let n = 0;
  setInterval(() => rejected("t" + n++).forEach(out), 20);
} else if (e.FAKE_REFUSE === "twice") {
  [...rejected("a"), ...rejected("b")].forEach(out);
  out({ type: "assistant", message: { content: [{ text: "The shell run was rejected in this environment, so echo ok never executed." }] } });
  out({ type: "result", subtype: "success", duration_ms: 9000, usage: { inputTokens: 10, outputTokens: 5 } });
} else {
  out({ type: "tool_call", subtype: "completed", call_id: "s", tool_call: { shellToolCall: { args: { command: "echo ok" }, result: { success: { exitCode: 0, stdout: "ok\\n" } } } } });
  out({ type: "assistant", message: { content: [{ text: "It printed ok." }] } });
  out({ type: "result", subtype: "success", duration_ms: 3000, usage: { inputTokens: 10, outputTokens: 5 } });
}
`,
);
chmodSync(fake, 0o755);
process.env.PI_CURSOR_AGENT_BIN = fake;

const fakeEnv = (vars = {}) => {
	for (const k of ["FAKE_REFUSE", "FAKE_PIDFILE", "FAKE_ARGS"]) delete process.env[k];
	Object.assign(process.env, vars);
};
const argsFile = path.join(scratch, "argv.json");
const lastArgv = () => JSON.parse(readFileSync(argsFile, "utf8"));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
const repo = path.join(scratch, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "a.txt"), "hi\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");

const { describeTool, RunReducer } = await import("../extensions/opt-in/cursor-agent/events.ts");
const { prepareRun, runCursor, REFUSAL_LIMIT } = await import("../extensions/opt-in/cursor-agent/run.ts");
const { resultBlock } = await import("../extensions/opt-in/cursor-agent/runner.ts");
const { loadSettings } = await import("../extensions/opt-in/cursor-agent/settings.ts");
const { default: cursorAgent } = await import("../extensions/opt-in/cursor-agent/index.ts");
const { subagentExtension } = await import("../extensions/subagent/index.ts");

const textOf = (result) => result.content.map((p) => p.text ?? "").join("\n");

test("a rejected result is a refused, failed step, not a success", () => {
	const [, done] = rejected("x");
	assert.deepEqual(describeTool(done.tool_call, "/tmp/cursor-refuse"), { kind: "shell", summary: "shell echo ok", ok: false, refused: true });
	const r = new RunReducer("/tmp/cursor-refuse");
	for (const ev of [...rejected("a"), ...rejected("b")]) r.apply(ev);
	assert.equal(r.state.refusals, 2);
	assert.deepEqual(
		r.state.tools.map((t) => [t.ok, t.refused]),
		[
			[false, true],
			[false, true],
		],
	);
});

test("force, and only force, passes --force; network alone never does", async () => {
	const s = loadSettings();
	const argv = async (args) => (await prepareRun({ prompt: "p", ...args }, repo, s)).cliArgs;
	assert.ok(!(await argv({})).includes("--force"));
	assert.ok(!(await argv({ network: true })).includes("--force"), "network doesn't imply force");
	const both = await argv({ network: true, force: true });
	assert.ok(both.includes("--force"));
	assert.deepEqual(both.slice(both.indexOf("--sandbox"), both.indexOf("--sandbox") + 2), ["--sandbox", "disabled"]);
	assert.equal(both.at(-1), "p", "the prompt stays last");
	const spec = await prepareRun({ prompt: "p", network: true, force: true }, repo, s);
	assert.equal(spec.network, true);
	assert.equal(spec.force, true);
});

test(`a run that keeps refusing is stopped after ${REFUSAL_LIMIT} refusals, with the fix in the message`, async () => {
	const pidfile = path.join(scratch, "forever.pid");
	fakeEnv({ FAKE_REFUSE: "forever", FAKE_PIDFILE: pidfile });
	const spec = await prepareRun({ prompt: "p", network: true }, repo, loadSettings());
	const t0 = Date.now();
	const outcome = await runCursor(spec);
	assert.ok(Date.now() - t0 < 5_000, "stops promptly instead of spinning");
	assert.ok(outcome.state.refusals >= REFUSAL_LIMIT);
	assert.match(outcome.refused, new RegExp(`^Stopped: Cursor refused its own shell calls ${outcome.state.refusals} times, so nothing ran\\.`));
	assert.match(outcome.refused, /sandbox off \(network: true\).*Pass force: true/);
	assert.match(outcome.refused, /cli-config\.json/);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(alive(Number(readFileSync(pidfile, "utf8"))), false, "cursor-agent was killed");
	const block = resultBlock(spec, { outcome, stopped: false, usage: Promise.resolve() }).join("\n");
	assert.match(block, /── cursor result · refused \d+× ·/);
	assert.match(block, /^Error: Stopped: Cursor refused/m);
});

test("a few refusals that Cursor gives up on by itself aren't stopped; refusalLimit 0 turns the stop off", async () => {
	fakeEnv({ FAKE_REFUSE: "twice" });
	const spec = await prepareRun({ prompt: "p", network: true }, repo, loadSettings());
	const outcome = await runCursor(spec);
	assert.equal(outcome.state.refusals, 2);
	assert.equal(outcome.refused, undefined);
	assert.equal(outcome.exitCode, 0);
	assert.match(outcome.state.answer, /never executed/, "the stream is read even without an onEvent callback");
	const block = resultBlock(spec, { outcome, stopped: false, usage: Promise.resolve() }).join("\n");
	assert.match(block, /^Note: Cursor refused 2 of its own tool call\(s\), which never ran; to allow them, pass force: true \(or drop network: true\)\.$/m);
	assert.match(block, /── cursor result · done ·/, "not a failure: Cursor finished on its own");

	const pidfile = path.join(scratch, "off.pid");
	fakeEnv({ FAKE_REFUSE: "forever", FAKE_PIDFILE: pidfile });
	const stop = new AbortController();
	const pending = runCursor(spec, { refusalLimit: 0, signal: stop.signal });
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(alive(Number(readFileSync(pidfile, "utf8"))), true, "still running with the stop off");
	stop.abort();
	assert.equal((await pending).refused, undefined);
});

async function mountTool() {
	const stub = stubPi();
	await cursorAgent(stub.pi);
	const { ctx } = stubCtx({ cwd: repo });
	await stub.fire("session_start", { type: "session_start" }, ctx);
	const tool = stub.tools.find((t) => t.name === "cursor");
	return { tool, run: (params) => tool.execute("call-1", params, undefined, undefined, ctx) };
}

test("cursor tool: declares force, warns about it, and passes --force", async () => {
	const { tool, run } = await mountTool();
	assert.match(tool.parameters.properties.force.description, /--force.*network: true.*trusted/s);
	assert.match(tool.parameters.properties.network.description, /refused unless force/);
	const theme = { fg: (_c, s) => s, bold: (s) => s };
	const header = tool.renderCall({ prompt: "p", network: true, force: true }, theme).text ?? "";
	assert.match(header, /\[no sandbox\] \[run everything\]/);
	fakeEnv({ FAKE_ARGS: argsFile });
	const result = await run({ prompt: "Run echo ok", network: true, force: true });
	assert.equal(result.isError, false);
	assert.ok(lastArgv().includes("--force"));
	assert.equal(result.structuredContent.error, undefined);
});

test("cursor tool: a refusing run is an error result that says how to fix it", async () => {
	const { run } = await mountTool();
	fakeEnv({ FAKE_REFUSE: "forever" });
	const result = await run({ prompt: "Run echo ok", network: true });
	const text = textOf(result);
	assert.equal(result.isError, true);
	assert.match(text, /^Stopped: Cursor refused its own shell calls \d+ times/);
	assert.match(text, /- shell echo ok \(refused\)/);
	assert.match(result.structuredContent.error, /Pass force: true/);
	assert.equal(result.structuredContent.steps[0].ok, false);
});

test("cursor tool: a run with a couple of refusals finishes, with a note naming the fix", async () => {
	const { run } = await mountTool();
	fakeEnv({ FAKE_REFUSE: "twice" });
	const result = await run({ prompt: "Run echo ok", network: true });
	assert.equal(result.isError, false);
	assert.match(textOf(result), /Note: Cursor refused 2 of its own tool call\(s\).*pass force: true/);
});

// A user-scope agent file that turns the sandbox off and approvals off.
const userAgents = path.join(process.env.PI_CODING_AGENT_DIR, "agents");
mkdirSync(userAgents, { recursive: true });
writeFileSync(path.join(userAgents, "cursor-net.md"), "---\nname: cursor-net\nrunner: cursor\nnetwork: true\nforce: true\nworktree: false\n---\nDo it.\n");

function mountSubagent(cwd = repo) {
	const stub = stubPi();
	Object.assign(stub.pi, { getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {} });
	subagentExtension({ findCharge: async () => undefined })(stub.pi);
	const { ctx } = stubCtx({ cwd, model: { provider: "anthropic", id: "claude-opus-5.5" } });
	const tool = () => stub.tools.findLast((t) => t.name === "subagent");
	return { tool, run: (params) => tool().execute("call-1", params, undefined, undefined, ctx) };
}

test("subagent cursor runner: per-call force and user-scope force pass --force; a repo agent file can't", async () => {
	const repoAgents = path.join(repo, ".pi", "agents");
	mkdirSync(repoAgents, { recursive: true });
	writeFileSync(path.join(repoAgents, "cursor-repo.md"), "---\nname: cursor-repo\nrunner: cursor\nnetwork: true\nforce: true\nworktree: false\n---\nDo it.\n");

	const h = mountSubagent();
	assert.match(h.tool().parameters.properties.force.description, /--force.*network: true/s);
	fakeEnv({ FAKE_ARGS: argsFile });

	await h.run({ agent: "cursor", task: "t", worktree: false, force: true });
	assert.ok(lastArgv().includes("--force"), "per-call force");
	await h.run({ agent: "cursor", task: "t", worktree: false });
	assert.ok(!lastArgv().includes("--force"), "off by default");
	await h.run({ agent: "cursor-net", task: "t" });
	assert.ok(lastArgv().includes("--force") && lastArgv().includes("disabled"), "user-scope agent file");
	await h.run({ agent: "cursor-repo", task: "t", agentScope: "project" });
	const repoArgv = lastArgv();
	assert.ok(!repoArgv.includes("--force"), "a repo agent file never turns approvals off");
	assert.ok(!repoArgv.includes("disabled"), "nor the sandbox");
	rmSync(path.join(repo, ".pi"), { recursive: true, force: true });
});

test("subagent cursor runner: a refusing run fails with the refusal message", async () => {
	const h = mountSubagent();
	fakeEnv({ FAKE_REFUSE: "forever" });
	const result = await h.run({ agent: "cursor-net", task: "t", force: false });
	const text = textOf(result);
	assert.match(text, /refused \d+×/);
	assert.match(text, /Stopped: Cursor refused its own shell calls/);
	assert.equal(result.details.results[0].ok, false);
	assert.match(result.details.results[0].cursor.error, /Pass force: true/);
});
