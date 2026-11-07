import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import cd, { resolveTarget, shortSessionId } from "../extensions/cd/index.ts";

const dirs = [];
function tempDir(prefix = "pi-cd-test-") {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
process.on("exit", () => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Mount /cd with fake deps, as bg.test.mjs mounts an extension's tools. */
function mount({ cwd, source = "/sessions/old.jsonl", env = {}, pid = 4242, forkFrom, spawnRestart } = {}) {
	const commands = new Map();
	const pi = {
		registerCommand: (name, options) => commands.set(name, options),
		registerTool: () => {},
		registerShortcut: () => {},
		on: () => {},
		sendMessage: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	const calls = [];
	const notes = [];
	const forked = [];
	const spawned = [];
	const resolvedEnv = {
		TMUX: "/tmp/pi-cd-test/tmux.sock,1,0",
		TMUX_PANE: "%12",
		XDG_STATE_HOME: tempDir("pi-cd-state-"),
		...env,
	};
	cd(pi, {
		env: resolvedEnv,
		pid,
		forkFrom: (from, to) => {
			forked.push([from, to]);
			return forkFrom ? forkFrom(from, to) : { getSessionFile: () => `${to}/new.jsonl`, getSessionId: () => "abcdef12-3456" };
		},
		spawnRestart: (args) => {
			spawned.push(args);
			spawnRestart?.(args);
		},
	});
	const ctx = {
		cwd,
		sessionManager: { getSessionFile: () => source },
		ui: { notify: (text, type) => notes.push({ text, type }) },
		waitForIdle: async () => calls.push("wait"),
	};
	return { handler: commands.get("cd").handler, ctx, calls, notes, forked, spawned, env: resolvedEnv, pid };
}

function writeRecord({ env, pid, pane = "%12", socket = "/tmp/pi-cd-test/tmux.sock", over = {} }) {
	const live = path.join(env.XDG_STATE_HOME, "pi-restart", "live");
	mkdirSync(live, { recursive: true });
	writeFileSync(
		path.join(live, `${pid}.json`),
		JSON.stringify({ pid, sessionFile: "/sessions/old.jsonl", cwd: "/old", pane, socket, bypass: false, idle: true, at: "", ...over }),
	);
}

test("/cd with no argument shows the usage, and changes nothing", async () => {
	const work = tempDir();
	const m = mount({ cwd: work });
	await m.handler("   ", m.ctx);
	assert.deepEqual(m.notes, [{ text: "Usage: /cd <dir>", type: "info" }]);
	assert.deepEqual(m.forked, []);
	assert.deepEqual(m.spawned, []);
	assert.deepEqual(m.calls, [], "nothing waited on");
});

test("/cd with a missing or non-directory path says why and changes nothing", async () => {
	const work = tempDir();
	const file = path.join(work, "a-file");
	writeFileSync(file, "");
	const m = mount({ cwd: work });
	writeRecord({ env: m.env, pid: m.pid });

	const missing = path.join(work, "nope");
	await m.handler(missing, m.ctx);
	assert.deepEqual(m.notes.at(-1), { text: `/cd: no such directory: ${missing}`, type: "error" });
	await m.handler(file, m.ctx);
	assert.deepEqual(m.notes.at(-1), { text: `/cd: not a directory: ${file}`, type: "error" });
	assert.deepEqual(m.forked, []);
	assert.deepEqual(m.spawned, []);
	assert.deepEqual(m.calls, []);
});

test("/cd in the current directory says so and changes nothing", async () => {
	const work = tempDir();
	const m = mount({ cwd: work });
	writeRecord({ env: m.env, pid: m.pid });
	await m.handler(".", m.ctx);
	assert.equal(m.notes.length, 1);
	assert.match(m.notes[0].text, /^Already in /);
	assert.deepEqual(m.forked, []);
	assert.deepEqual(m.spawned, []);
	assert.deepEqual(m.calls, []);
});

test("/cd outside tmux, or without the restart extension's live record, needs tmux", async () => {
	const work = tempDir();
	const target = path.join(work, "target");
	mkdirSync(target);

	const outside = mount({ cwd: work, env: { TMUX: "", TMUX_PANE: "" } });
	await outside.handler(target, outside.ctx);
	assert.deepEqual(outside.notes, [{ text: "/cd needs pi running in tmux", type: "error" }]);

	const noRecord = mount({ cwd: work });
	await noRecord.handler(target, noRecord.ctx);
	assert.deepEqual(noRecord.notes, [{ text: "/cd needs pi running in tmux", type: "error" }]);

	const otherPane = mount({ cwd: work });
	writeRecord({ env: otherPane.env, pid: otherPane.pid, pane: "%13" });
	await otherPane.handler(target, otherPane.ctx);
	assert.deepEqual(otherPane.notes, [{ text: "/cd needs pi running in tmux", type: "error" }]);

	for (const m of [outside, noRecord, otherPane]) {
		assert.deepEqual(m.forked, []);
		assert.deepEqual(m.spawned, []);
		assert.deepEqual(m.calls, []);
	}
});

test("/cd forks into the target and runs pi-restart-all --only this pane on the new session", async () => {
	const work = tempDir();
	const target = path.join(work, "target");
	mkdirSync(target);
	const m = mount({ cwd: work, source: "/sessions/old.jsonl" });
	writeRecord({ env: m.env, pid: m.pid });

	await m.handler(target, m.ctx);

	assert.deepEqual(m.forked, [["/sessions/old.jsonl", target]]);
	assert.deepEqual(m.calls, ["wait"], "waits for idle before forking");
	assert.deepEqual(m.spawned, [["--only", "%12", "--session", `${target}/new.jsonl`, "--cd", target]]);
	assert.deepEqual(m.notes, [
		{
			text: `Continuing in ${target} (new session abcdef12; if pi does not come back, run: pi --session ${target}/new.jsonl)`,
			type: "info",
		},
	]);
});

test("/cd drops one pair of outer quotes around the directory", async () => {
	const work = tempDir();
	const target = path.join(work, "a b");
	mkdirSync(target);
	for (const quoted of [`"${target}"`, `'${target}'`]) {
		const m = mount({ cwd: work, source: "/sessions/old.jsonl" });
		writeRecord({ env: m.env, pid: m.pid });
		await m.handler(quoted, m.ctx);
		assert.deepEqual(m.forked, [["/sessions/old.jsonl", target]], quoted);
	}
});

test("/cd expands ~ and resolves a relative path against the session cwd", async () => {
	const root = tempDir();
	const home = path.join(root, "home");
	const work = path.join(root, "work");
	const inHome = path.join(home, "there");
	const relative = path.join(work, "here");
	for (const dir of [inHome, relative, home]) mkdirSync(dir, { recursive: true });

	const saved = process.env.HOME;
	process.env.HOME = home;
	try {
		const fromHome = mount({ cwd: work });
		writeRecord({ env: fromHome.env, pid: fromHome.pid });
		await fromHome.handler("~/there", fromHome.ctx);
		assert.deepEqual(fromHome.forked, [["/sessions/old.jsonl", inHome]]);

		const fromCwd = mount({ cwd: work });
		writeRecord({ env: fromCwd.env, pid: fromCwd.pid });
		await fromCwd.handler("here", fromCwd.ctx);
		assert.deepEqual(fromCwd.forked, [["/sessions/old.jsonl", relative]]);
	} finally {
		if (saved === undefined) delete process.env.HOME;
		else process.env.HOME = saved;
	}
});

test("path helpers: ~, a relative path, and a short session id", () => {
	assert.equal(resolveTarget("~", "/work", "/home/me"), "/home/me");
	assert.equal(resolveTarget("~/Code", "/work", "/home/me"), "/home/me/Code");
	assert.equal(resolveTarget("project", "/work", "/home/me"), "/work/project");
	assert.equal(resolveTarget("../up", "/work/a", "/home/me"), "/work/up");
	assert.equal(shortSessionId("abcdef12-3456"), "abcdef12");
	assert.equal(shortSessionId(undefined), "?");
});
