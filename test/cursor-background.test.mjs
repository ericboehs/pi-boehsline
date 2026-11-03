/**
 * The cursor tool's background mode, and that the foreground path is unchanged.
 *
 * Never runs the real cursor-agent or touches the network: PI_CURSOR_AGENT_BIN
 * points at a fake that prints recorded stream-json events, the fake runs carry
 * no session id (so there is no cost lookup) or get an injected lookup, and a
 * failing `security` shim goes first on PATH in case anything reaches the
 * Keychain. The bg extension is a fake listener, except in one end-to-end test
 * that loads the real one to check the completion message.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "cursor-bg-test-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

process.env.BOEHSLINE_CONFIG = path.join(scratch, "none.json");
process.env.BOEHSLINE_ENABLE = "cursor-agent";
process.env.PI_BG_DIR = path.join(scratch, "bg");
process.env.PI_BG_WAKE = "followUp";
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
for (const k of Object.keys(process.env)) if (k.startsWith("PI_CURSOR_") && k !== "PI_CURSOR_AGENT_BIN") delete process.env[k];

// A failing Keychain shim, so nothing can read a real Cursor token.
const shims = path.join(scratch, "shims");
mkdirSync(shims);
writeFileSync(path.join(shims, "security"), "#!/bin/sh\nexit 44\n");
chmodSync(path.join(shims, "security"), 0o755);
process.env.PATH = `${shims}${path.delimiter}${process.env.PATH}`;

// The fake cursor-agent: FAKE_CURSOR_* env vars pick what it prints.
const fake = path.join(scratch, "fake-cursor-agent");
writeFileSync(
	fake,
	`#!${process.execPath}
const fs = require("node:fs");
const e = process.env;
const out = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
fs.writeFileSync(e.FAKE_CURSOR_ARGS ?? "/dev/null", JSON.stringify(process.argv.slice(2)));
if (e.FAKE_CURSOR_PIDFILE) {
  fs.writeFileSync(e.FAKE_CURSOR_PIDFILE, String(process.pid));
  setInterval(() => {}, 1000); // run until killed
} else {
  out({ type: "system", subtype: "init", ...(e.FAKE_CURSOR_SESSION ? { session_id: e.FAKE_CURSOR_SESSION } : {}), model: "Composer Two", cwd: e.FAKE_CURSOR_WS || process.cwd() });
  out({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "npm test" } } } });
  const until = Date.now() + 60; while (Date.now() < until); // a separate chunk, like a real step
  out({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { shellToolCall: { args: { command: "npm test" }, result: { success: { exitCode: 0 } } } } });
  out({ type: "assistant", message: { content: [{ text: e.FAKE_CURSOR_ANSWER ?? "Fixed the bug." }] } });
  out({ type: "result", subtype: "success", duration_ms: 185000, usage: { inputTokens: 1000, outputTokens: 200 } });
  if (e.FAKE_CURSOR_STDERR) process.stderr.write(e.FAKE_CURSOR_STDERR);
  process.exitCode = Number(e.FAKE_CURSOR_EXIT ?? 0);
}
`,
);
chmodSync(fake, 0o755);
process.env.PI_CURSOR_AGENT_BIN = fake;

const fakeEnv = (vars) => {
	for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_CURSOR_")) delete process.env[k];
	Object.assign(process.env, vars);
};

// A repo with a commit, and a worktree of it with one changed file (what Cursor leaves).
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
const repo = path.join(scratch, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "fizz.rb"), "puts 1\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");
const wt = path.join(scratch, "wt");
git(repo, "worktree", "add", "-q", "-b", "pi-test-branch", wt);
writeFileSync(path.join(wt, "fizz.rb"), "puts 2\n");

const { default: cursorAgent } = await import("../extensions/opt-in/cursor-agent/index.ts");
const { runBackground, WAKE_CHARS, ANSWER_CHARS } = await import("../extensions/opt-in/cursor-agent/runner.ts");

/** Load the extension and register its tool (it registers at session_start). */
async function mount() {
	const stub = stubPi();
	await cursorAgent(stub.pi);
	const { ctx } = stubCtx({ cwd: repo });
	await stub.fire("session_start", { type: "session_start" }, ctx);
	const tool = stub.tools.find((t) => t.name === "cursor");
	assert.ok(tool, "cursor tool registered");
	const run = (params, onUpdate) => tool.execute("call-1", params, undefined, onUpdate, ctx);
	return { ...stub, tool, ctx, run };
}

const textOf = (result) => result.content.map((p) => p.text ?? "").join("\n");

test("declares background and documents it in the prompt", async () => {
	const { tool } = await mount();
	assert.ok(tool.parameters.properties.background);
	assert.match(tool.parameters.properties.background.description, /bg extension.*message when Cursor finishes.*few minutes.*worktree/s);
	assert.match(tool.promptSnippet, /background/);
	assert.match(tool.description, /background: true/);
});

test("background returns at once with the bg job id and log, without running Cursor", async () => {
	const h = await mount();
	let req;
	h.pi.events.on("bg:start", (r) => {
		r.accepted = true;
		req = r;
		queueMicrotask(() => r.reply({ id: "abc123", logPath: "/tmp/pi-bg-501/abc123.log" }));
	});
	fakeEnv({ FAKE_CURSOR_ARGS: path.join(scratch, "never.json") });
	const result = await h.run({ prompt: "Fix it's bug", model: "composer-2", worktree: true, background: true });

	assert.equal(result.isError, undefined);
	assert.match(textOf(result), /Started in background: cursor composer-2 · bg abc123 · log \/tmp\/pi-bg-501\/abc123\.log/);
	assert.match(textOf(result), /arrives as a message when Cursor finishes/);
	assert.deepEqual(result.details, { background: true, id: "abc123", logPath: "/tmp/pi-bg-501/abc123.log", model: "composer-2" });
	assert.equal(existsSync(path.join(scratch, "never.json")), false, "cursor-agent was not started by the tool");
	assert.equal(req.name, "cursor");
	assert.equal(req.summary, "cursor composer-2: Fix it's bug");
	assert.equal(req.cwd, repo);
	assert.equal(req.tailMaxChars, WAKE_CHARS);
	assert.ok(req.tailLines >= 100);
	assert.match(req.command, /runner\.ts' '/);

	// Same args as the foreground path, handed over in a private spec file.
	const specPath = req.command.match(/'([^']+spec\.json)'$/)[1];
	const spec = JSON.parse(readFileSync(specPath, "utf8"));
	assert.equal(spec.model, "composer-2");
	assert.equal(spec.cwd, repo);
	assert.equal(spec.worktree, true);
	assert.equal(spec.bin, fake);
	assert.deepEqual(spec.cliArgs.slice(0, 9), ["-p", "--trust", "--output-format", "stream-json", "--stream-partial-output", "--sandbox", "enabled", "--model", "composer-2"]);
	assert.ok(spec.cliArgs.includes("--worktree"));
	assert.equal(spec.cliArgs.at(-1), "Fix it's bug");
	rmSync(path.dirname(specPath), { recursive: true, force: true });
});

test("background without the bg extension says to rerun without it", async () => {
	const h = await mount();
	const result = await h.run({ prompt: "hi", background: true });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /needs the bg extension \(extensions\/bg\).*Rerun without background/);
});

test("background still refuses a blocked model up front", async (t) => {
	process.env.PI_CURSOR_BLOCKED_MODELS = "fable";
	t.after(() => delete process.env.PI_CURSOR_BLOCKED_MODELS);
	const h = await mount();
	await assert.rejects(h.run({ prompt: "hi", model: "fable-1", background: true }), /fable-1 is blocked/);
});

test("the result block: answer, cost in dollars, model, duration, worktree, exit code", async () => {
	fakeEnv({ FAKE_CURSOR_SESSION: "sess-42", FAKE_CURSOR_WS: wt, FAKE_CURSOR_ANSWER: "Fixed fizz.rb; tests pass." });
	const lines = [];
	const lookups = [];
	const code = await runBackground(
		{ model: "composer-2", cwd: repo, cliArgs: ["-p", "x"], worktree: true, bin: fake },
		{
			write: (...l) => lines.push(...l),
			findCharge: async (sessionId) => {
				lookups.push(sessionId);
				return { timestamp: "0", model: "composer-2", chargedCents: 42.5, cursorTokenFee: 2.5, tokenUsage: { inputTokens: 1000, outputTokens: 200 } };
			},
		},
	);
	const log = lines.join("\n");
	assert.equal(code, 0);
	assert.deepEqual(lookups, ["sess-42"]);
	assert.match(log, /^→ shell npm test$/m, "progress: the step as it starts");
	assert.match(log, /^✓ shell npm test$/m, "progress: the step when it finishes");
	assert.match(log, /── cursor result · done · composer-2 · 3m05s · \$0\.4250 \(incl\. \$0\.0250 Cursor fee\) · 1K tokens ──/);
	assert.match(log, /Fixed fizz\.rb; tests pass\./);
	assert.match(log, /Model: composer-2 \(Composer Two\)/);
	assert.match(log, /Duration: 3m05s · 1 step\(s\)/);
	assert.match(log, /Charged: \$0\.4250 \(chargedCents 42\.5\)/);
	assert.ok(log.includes(`Worktree: ${wt} (branch pi-test-branch), 1 changed file(s)`));
	assert.match(log, /^ {2} M fizz\.rb$/m);
	assert.match(log, /Session: sess-42/);
	assert.match(log, /Exit code: 0/);
	assert.ok(log.slice(log.indexOf("── cursor result")).length < WAKE_CHARS, "the result block fits in the completion message");
});

test("the result block: a long answer is shortened, with the full text earlier in the log; failures carry the error", async () => {
	const answer = `${"x".repeat(ANSWER_CHARS)}END-OF-ANSWER`;
	fakeEnv({ FAKE_CURSOR_ANSWER: answer, FAKE_CURSOR_EXIT: "3", FAKE_CURSOR_STDERR: "boom: model overloaded" });
	const lines = [];
	const code = await runBackground({ model: "auto", cwd: repo, cliArgs: [], worktree: false, bin: fake }, { write: (...l) => lines.push(...l) });
	const log = lines.join("\n");
	assert.equal(code, 3);
	const block = log.slice(log.indexOf("── cursor result"));
	assert.ok(log.indexOf("── full answer") < log.indexOf("── cursor result"));
	assert.ok(log.includes(answer), "the full answer is in the log");
	assert.ok(!block.includes("END-OF-ANSWER"), "the result block has the shortened answer");
	assert.match(block, /answer truncated at 6000 of 6013 chars; the full text is above in this log/);
	assert.match(block, /── cursor result · exit 3 · auto · 3m05s · cost not found ──/);
	assert.match(block, /Exit code: 3/);
	assert.match(block, /Error: boom: model overloaded/);
	assert.ok(block.length < WAKE_CHARS);
});

test("end to end through the real bg extension: the completion message carries the result", async () => {
	const h = await mount();
	const { default: bg } = await import("../extensions/bg/index.ts");
	bg(h.pi);
	await h.fire("session_start", { type: "session_start" }, { ...h.ctx, mode: "print", hasUI: false });
	fakeEnv({ FAKE_CURSOR_WS: wt, FAKE_CURSOR_ANSWER: "All done in the worktree." });

	const started = Date.now();
	const result = await h.run({ prompt: "Do the thing", model: "composer-2", worktree: true, background: true });
	assert.ok(Date.now() - started < 5_000, "returns before the run finishes");
	const id = result.details.id;
	assert.match(textOf(result), new RegExp(`bg ${id} · log ${process.env.PI_BG_DIR}/${id}\\.log`));

	const deadline = Date.now() + 20_000;
	let wake;
	while (!(wake = h.sent.find((s) => s.message?.customType === "bg")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	assert.ok(wake, "bg sent a completion message");
	const msg = wake.message.content;
	assert.match(msg, new RegExp(`^\\[bg ${id}\\] \`cursor composer-2: Do the thing\` succeeded`));
	assert.match(msg, /── cursor result · done · composer-2 · 3m05s · cost not found ──/);
	assert.match(msg, /All done in the worktree\./);
	assert.ok(msg.includes(`Worktree: ${wt} (branch pi-test-branch), 1 changed file(s)`));
	assert.match(msg, /Exit code: 0/);
	assert.match(readFileSync(`${process.env.PI_BG_DIR}/${id}.log`, "utf8"), /✓ shell npm test/);
});

test("stopping the job kills cursor-agent with it", async () => {
	const pidfile = path.join(scratch, "cursor.pid");
	const specDir = mkdtempSync(path.join(scratch, "spec-"));
	const specPath = path.join(specDir, "spec.json");
	writeFileSync(specPath, JSON.stringify({ model: "auto", cwd: repo, cliArgs: [], worktree: false, bin: fake }));
	const runner = new URL("../extensions/opt-in/cursor-agent/runner.ts", import.meta.url).pathname;
	const child = spawn(process.execPath, [runner, specPath], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, FAKE_CURSOR_PIDFILE: pidfile },
	});
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	const exited = new Promise((r) => child.on("close", (code, sig) => r({ code, sig })));
	const deadline = Date.now() + 10_000;
	while (!existsSync(pidfile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	const pid = Number(readFileSync(pidfile, "utf8"));
	assert.equal(existsSync(specDir), false, "the runner deletes its spec on start");

	// Only the runner gets the signal: it must take cursor-agent down itself.
	child.kill("SIGTERM");
	const { code } = await exited;
	assert.equal(code, 143);
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
	assert.equal(alive(), false, "cursor-agent is gone");
	assert.match(out, /cursor result · stopped/);
});

test("foreground is unchanged: blocks until Cursor finishes and returns the answer, steps and worktree", async () => {
	const h = await mount();
	let bgCalls = 0;
	h.pi.events.on("bg:start", () => bgCalls++);
	const argsFile = path.join(scratch, "fg-args.json");
	fakeEnv({ FAKE_CURSOR_WS: wt, FAKE_CURSOR_ANSWER: "Foreground answer.", FAKE_CURSOR_ARGS: argsFile });
	const updates = [];
	const result = await h.run({ prompt: "Fix fizz", model: "composer-2", network: true, mode: "plan", worktree: true }, (u) => updates.push(u));

	assert.equal(bgCalls, 0);
	assert.equal(result.isError, false);
	const text = textOf(result);
	assert.match(text, /^Foreground answer\./);
	assert.match(text, /Cursor's steps:\n- shell npm test/);
	assert.ok(text.includes(`Worktree: ${wt} (branch pi-test-branch), 1 changed file(s):\n   M fizz.rb`));
	assert.match(text, /\[composer-2 · 185\.0s · 1K tokens \(CLI count\) · cost not found\]/);
	assert.ok(updates.length > 0, "live updates while it runs");
	const s = result.structuredContent;
	assert.equal(s.answer, "Foreground answer.");
	assert.deepEqual(s.steps, [{ kind: "shell", summary: "shell npm test", ok: true }]);
	assert.equal(s.exitCode, 0);
	assert.equal(s.durationMs, 185000);
	assert.equal(s.tokens, 1200);
	assert.deepEqual(s.worktree, { path: wt, branch: "pi-test-branch", changed: [" M fizz.rb"] });
	const argv = JSON.parse(readFileSync(argsFile, "utf8"));
	assert.deepEqual(argv.slice(0, 9), ["-p", "--trust", "--output-format", "stream-json", "--stream-partial-output", "--sandbox", "disabled", "--model", "composer-2"]);
	assert.deepEqual(argv.slice(9, 11), ["--mode", "plan"]);
	assert.equal(argv[11], "--worktree");
	assert.equal(argv.at(-1), "Fix fizz");
	assert.equal(result.details.done, true);
});

test("foreground failure keeps the exit code and stderr", async () => {
	const h = await mount();
	fakeEnv({ FAKE_CURSOR_EXIT: "2", FAKE_CURSOR_STDERR: "bad thing" });
	const result = await h.run({ prompt: "x" });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /^Cursor exited with code 2\./);
	assert.match(textOf(result), /stderr:\nbad thing/);
	assert.equal(result.structuredContent.error, "bad thing");
});
