/**
 * extensions/subagent/sandbox.ts: a subagent task that runs in Botsun's workers VM
 * (docs/plans/sandbox-workers.md Part 1 Phase 2, in the Botsun repo).
 *
 * Nothing here starts a VM. The one subprocess is a stand-in for `bin/botsun worker
 * exec` — a shell script that records its argv and prints the JSONL a guest pi
 * would — so the fake `limactl`/systemd half stays in Botsun's own Ruby tests and
 * this file proves the host side of the contract: the invocation, the refusals,
 * and that the extension parses what comes back exactly as for a host child.
 *
 *   node scripts/test.mjs -- test/subagent-sandbox.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.PI_CODING_AGENT_DIR ??= mkdtempSync(path.join(tmpdir(), "pi-agent-sandbox-test-"));
delete process.env.PI_SUBAGENT_CHILD;

const { default: subagent } = await import("../extensions/subagent/index.ts");
const { CHILD_ID, DEFAULT_BOTSUN, sandboxBin, sandboxInvocation, SANDBOX_AGENTS, READ_ONLY_TOOLS, unsandboxable } = await import("../extensions/subagent/sandbox.ts");
const { listChildren, newChildId } = await import("../lib/children.ts");

function mount({ agents = {} } = {}) {
	const handlers = new Map();
	let tool;
	let bgListener;
	const state = { active: ["read", "bash", "tool_search"] };
	const agentDir = mkdtempSync(path.join(tmpdir(), "pi-agent-sandbox-dir-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (Object.keys(agents).length) {
		const dir = path.join(agentDir, "agents");
		execFileSync("mkdir", ["-p", dir]);
		for (const [name, frontmatter] of Object.entries(agents)) {
			writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter}\n---\n\nYou are a ${name}.\n`);
		}
	}
	subagent({
		registerTool: (definition) => (tool = definition),
		on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getActiveTools: () => state.active,
		getAllTools: () => state.active.map((name) => ({ name })),
		setActiveTools: (names) => (state.active = names),
		events: { on: () => () => {}, emit: (channel, data) => channel === "bg:start" && bgListener?.(data) },
	});
	const ctx = { cwd: mkdtempSync(path.join(tmpdir(), "pi-subagent-sandbox-cwd-")), model: undefined };
	return {
		tool,
		ctx,
		run: (params) => tool.execute("test-call", params, undefined, undefined, ctx),
		onBgStart: (listener) => (bgListener = listener),
	};
}

const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

/** A stand-in for bin/botsun: records argv, answers one turn like a guest pi. */
function fakeBotsun({ answer = "the VM saw it", exit = 0 } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-fake-botsun-"));
	const bin = path.join(dir, "botsun");
	const argsFile = path.join(dir, "args.json");
	writeFileSync(
		bin,
		`#!/bin/sh
node -e 'require("fs").writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(1)))' -- "$@"
printf '%s\\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], usage: { input: 12, output: 3 } } })}'
exit ${exit}
`,
	);
	chmodSync(bin, 0o755);
	return { bin, argsFile, argv: () => JSON.parse(readFileSync(argsFile, "utf8")) };
}

test("a sandboxed scout's child is Botsun's worker exec, with the task and the prompt in its argv", async () => {
	const fake = fakeBotsun();
	const saved = { BOTSUN_BIN: process.env.BOTSUN_BIN, ARGS_FILE: process.env.ARGS_FILE };
	process.env.BOTSUN_BIN = fake.bin;
	process.env.ARGS_FILE = fake.argsFile;
	try {
		const h = mount();
		const result = await h.run({ agent: "scout", task: "map lib/botsun", sandbox: true });
		assert.match(textOf(result), /the VM saw it/);
		assert.equal(result.details?.results?.[0]?.ok, true);

		const argv = fake.argv();
		assert.deepEqual(argv.slice(0, 3), ["worker", "exec", "--cwd"]);
		assert.equal(argv[3], h.ctx.cwd, "the folder to copy in is the task's cwd");
		assert.equal(argv[argv.indexOf("--agent") + 1], "scout");
		assert.equal(argv[argv.indexOf("--task") + 1], "map lib/botsun");
		assert.match(argv[argv.indexOf("--prompt") + 1], /You are a subagent\./);
		assert.match(argv[argv.indexOf("--prompt") + 1], /read-only recon scout/);
		assert.ok(argv.includes("--pi-version"), "the VM's pi is checked against this one");
		// The guest invocation (and the readonly tool set) is composed on the host side, in
		// Botsun, not here: nothing of it may be passed from the extension.
		for (const flag of ["--tools", "-ne", "-na", "--mode"]) assert.ok(!argv.includes(flag), `${flag} is Botsun's to decide`);
		assert.equal(READ_ONLY_TOOLS, "read,grep,find,ls");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("a sandboxed run names its pi child: --child is appended for a real id, dropped for a bad one", () => {
	const id = newChildId("pi");
	assert.match(id, CHILD_ID);
	const withChild = sandboxInvocation({ cwd: "/x", task: "t", prompt: "p", agent: "scout", child: id }, {});
	assert.deepEqual(withChild.args.slice(-2), ["--child", id]);
	const withoutChild = sandboxInvocation({ cwd: "/x", task: "t", prompt: "p", agent: "scout" }, {});
	assert.equal(withoutChild.args.includes("--child"), false, "no id, no flag");
	for (const bad of ["bad/id", "-leading", "x".repeat(65), ""]) {
		const dropped = sandboxInvocation({ cwd: "/x", task: "t", prompt: "p", agent: "scout", child: bad }, {});
		assert.equal(dropped.args.includes("--child"), false, `${JSON.stringify(bad)} is dropped, not refused`);
		assert.equal("error" in dropped, false, "a bad id is never an error");
	}
});

test("the --child a sandboxed run gets is the id of the child row trackChild made for it", async () => {
	const fake = fakeBotsun();
	const saved = { BOTSUN_BIN: process.env.BOTSUN_BIN, ARGS_FILE: process.env.ARGS_FILE };
	process.env.BOTSUN_BIN = fake.bin;
	process.env.ARGS_FILE = fake.argsFile;
	try {
		const h = mount();
		const result = await h.run({ agent: "scout", task: "look", sandbox: true });
		assert.equal(result.details?.results?.[0]?.ok, true);
		const argv = fake.argv();
		const childId = argv[argv.indexOf("--child") + 1];
		assert.match(childId, CHILD_ID, "Botsun would take this id");
		const tracked = listChildren().find((c) => c.id === childId);
		assert.ok(tracked, "the id names this job's tracked child");
		assert.equal(tracked.agent, "scout");
		assert.equal(tracked.task, "look");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("a write-capable agent is refused with one line, and nothing is spawned", async () => {
	const fake = fakeBotsun();
	const saved = { BOTSUN_BIN: process.env.BOTSUN_BIN, ARGS_FILE: process.env.ARGS_FILE };
	process.env.BOTSUN_BIN = fake.bin;
	process.env.ARGS_FILE = fake.argsFile;
	try {
		const h = mount();
		const result = await h.run({ agent: "worker", task: "edit a file", sandbox: true });
		assert.match(textOf(result), /readonly agents only \(scout\)/);
		assert.match(textOf(result), /patch gate/);
		assert.equal(result.details?.results?.[0]?.ok, false);
		assert.equal(existsSync(fake.argsFile), false, "the worker exec never ran");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("sandbox: true in an agent file's frontmatter takes the same path (scout only, Phase 2)", async () => {
	const fake = fakeBotsun({ answer: "from the file" });
	const saved = { BOTSUN_BIN: process.env.BOTSUN_BIN, ARGS_FILE: process.env.ARGS_FILE };
	process.env.BOTSUN_BIN = fake.bin;
	process.env.ARGS_FILE = fake.argsFile;
	try {
		const h = mount({ agents: { scout: 'tools: "read,grep"\nsandbox: true' } });
		const result = await h.run({ agent: "scout", task: "look" });
		assert.match(textOf(result), /from the file/);
		assert.equal(fake.argv()[fake.argv().indexOf("--agent") + 1], "scout");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("background hands bg.ts the same sandboxed command, so its log is the guest's JSONL", async () => {
	const fake = fakeBotsun();
	const saved = { BOTSUN_BIN: process.env.BOTSUN_BIN, ARGS_FILE: process.env.ARGS_FILE };
	process.env.BOTSUN_BIN = fake.bin;
	process.env.ARGS_FILE = fake.argsFile;
	try {
		const h = mount();
		let req;
		h.onBgStart((r) => {
			r.accepted = true;
			req = r;
			r.reply({ id: "sb1", logPath: "/tmp/pi-bg-test/sb1.log" });
		});
		const result = await h.run({ agent: "scout", task: "it's 'quoted'", sandbox: true, background: true });
		assert.match(textOf(result), /\[scout\] bg sb1/);
		assert.ok(req.command.startsWith("PI_SUBAGENT_CHILD=1 "));
		assert.match(req.command, /'worker' 'exec' '--cwd'/);
		assert.match(req.command, /--task' 'it'\\''s '\\''quoted'/, "the task survives the shell quoting");
		assert.match(req.command, / -e /, "the same progress filter as a host child");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("the invocation is refused, not left to the child, for a missing piece", () => {
	assert.deepEqual(SANDBOX_AGENTS, ["scout"]);
	assert.match(sandboxInvocation({ cwd: "/x", task: "t", prompt: "p", agent: "worker" }).error, /patch gate/);
	assert.match(sandboxInvocation({ cwd: "", task: "t", prompt: "p", agent: "scout" }).error, /needs a folder/);
	assert.match(sandboxInvocation({ cwd: "/x", task: " ", prompt: "p", agent: "scout" }).error, /needs a task/);
	const ok = sandboxInvocation({ cwd: "/x", task: "t", prompt: "p", agent: "scout", model: "anthropic/x", version: "1.5.0" }, {});
	assert.equal(ok.cmd, DEFAULT_BOTSUN, "no $BOTSUN_BIN: the checkout beside ~/Code");
	assert.equal(sandboxBin({}, () => false), "botsun", "no $BOTSUN_BIN and no checkout: PATH's botsun");
	assert.deepEqual(ok.args, ["worker", "exec", "--cwd", "/x", "--agent", "scout", "--task", "t", "--prompt", "p", "--model", "anthropic/x", "--pi-version", "1.5.0"]);
	assert.equal(sandboxInvocation({ cwd: "/x", task: "t", prompt: "p", agent: "scout" }, { BOTSUN_BIN: "/opt/botsun" }).cmd, "/opt/botsun");
	// A non-pi runner has no VM path at all: the refusal names it (subagent/index.ts checks it
	// before the cursor branch, in both the foreground and the background path).
	assert.match(unsandboxable("cursor"), /runs Cursor on this Mac/);
});

test("a cursor agent asked for the sandbox is refused with one line and nothing is spawned", async () => {
	const fake = fakeBotsun();
	const saved = { BOTSUN_BIN: process.env.BOTSUN_BIN, ARGS_FILE: process.env.ARGS_FILE };
	process.env.BOTSUN_BIN = fake.bin;
	process.env.ARGS_FILE = fake.argsFile;
	try {
		const h = mount();
		const result = await h.run({ agent: "cursor", task: "edit a file", sandbox: true });
		assert.equal(result.details?.results?.[0]?.ok, false);
		assert.match(textOf(result), /runs Cursor on this Mac/);
		assert.equal(textOf(result).trim().split("\n").length, 1, "one line, not a run");
		assert.equal(existsSync(fake.argsFile), false, "neither Botsun nor cursor-agent ran");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("background refuses a sandboxed cursor agent too, before bg.ts sees a command", async () => {
	const fake = fakeBotsun();
	const saved = { BOTSUN_BIN: process.env.BOTSUN_BIN, ARGS_FILE: process.env.ARGS_FILE };
	process.env.BOTSUN_BIN = fake.bin;
	process.env.ARGS_FILE = fake.argsFile;
	try {
		const h = mount();
		let started = false;
		h.onBgStart((r) => {
			started = true;
			r.accepted = true;
			r.reply({ id: "cb1", logPath: "/tmp/pi-bg-test/cb1.log" });
		});
		const result = await h.run({ agent: "cursor", task: "edit a file", sandbox: true, background: true });
		assert.equal(started, false, "no shell job: the refusal happens before the spawn");
		assert.match(textOf(result), /\[cursor\] sandbox: true runs the VM's pi/);
		assert.equal(existsSync(fake.argsFile), false);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("a sandboxed child that fails says so, and its output is not the answer", async () => {
	const fake = fakeBotsun({ answer: "", exit: 1 });
	const saved = { BOTSUN_BIN: process.env.BOTSUN_BIN, ARGS_FILE: process.env.ARGS_FILE };
	process.env.BOTSUN_BIN = fake.bin;
	process.env.ARGS_FILE = fake.argsFile;
	try {
		const h = mount();
		const result = await h.run({ agent: "scout", task: "look", sandbox: true });
		assert.equal(result.details?.results?.[0]?.ok, false);
		assert.match(textOf(result), /exit 1/);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
