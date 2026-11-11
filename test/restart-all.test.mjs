import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../bin/pi-restart-all", import.meta.url));

const quote = (value) =>
	spawnSync("bash", ["-c", 'printf %q "$1"', "_", value], { encoding: "utf8" }).stdout;

/** A fake PATH with tmux and ps answers matching the record we write. */
function fakeCommands(root) {
	const bin = path.join(root, "bin");
	mkdirSync(bin);
	writeFileSync(
		path.join(bin, "tmux"),
		'#!/bin/sh\ncase "$*" in\n  *pane_tty*) printf \'/dev/ttys999\\n\' ;;\n  *) exit 1 ;;\nesac\n',
		{ mode: 0o755 },
	);
	writeFileSync(
		path.join(bin, "ps"),
		'#!/bin/sh\ncase "$*" in\n  *"-o args="*) echo pi ;;\n  *"-o tty="*) echo ttys999 ;;\n  *) exit 1 ;;\nesac\n',
		{ mode: 0o755 },
	);
	chmodSync(path.join(bin, "tmux"), 0o755);
	chmodSync(path.join(bin, "ps"), 0o755);
	return bin;
}

/** A record pi-restart-all trusts, for a pid that is alive (a sleeper), on a live unix socket. */
async function restartFixture() {
	const root = mkdtempSync(path.join(tmpdir(), "pi-restart-all-test-"));
	const state = path.join(root, "state");
	const live = path.join(state, "pi-restart", "live");
	mkdirSync(live, { recursive: true });
	const socket = path.join(root, "tmux.sock");
	const server = createServer(() => {});
	await new Promise((done) => server.listen(socket, done));
	const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
	const sessionFile = path.join(root, "session file.jsonl");
	writeFileSync(sessionFile, '{"type":"session"}\n');
	const target = path.join(root, "target dir");
	mkdirSync(target);
	writeFileSync(
		path.join(live, `${sleeper.pid}.json`),
		JSON.stringify({
			pid: sleeper.pid,
			sessionFile,
			cwd: root,
			pane: "%12",
			socket,
			bypass: false,
			idle: true,
			at: "",
		}),
	);
	const bin = fakeCommands(root);
	return {
		root,
		state,
		socket,
		server,
		sleeper,
		sessionFile,
		target: realpathSync(target),
		bin,
		async cleanup() {
			sleeper.kill("SIGKILL");
			await new Promise((done) => server.close(done));
			rmSync(root, { recursive: true, force: true });
		},
	};
}


test("pi-restart-all --dry-run --only --session --cd prints the command it would type", async (t) => {
	const f = await restartFixture();
	t.after(() => f.cleanup());
	const result = spawnSync(
		SCRIPT,
		["--dry-run", "--only", "%12", "--session", f.sessionFile, "--cd", f.target],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, XDG_STATE_HOME: f.state },
		},
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.ok(
		result.stdout.includes(
			`would type: cd -- ${quote(f.target)} && pi --session ${quote(f.sessionFile)}`,
		),
		result.stdout,
	);
});

test("pi-restart-all refuses --cd (and --session) without --only", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-restart-all-test-"));
	try {
		const target = path.join(root, "target");
		mkdirSync(target);
		const session = path.join(root, "session.jsonl");
		writeFileSync(session, "");
		const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state") };
		const noOnly = spawnSync(SCRIPT, ["--dry-run", "--cd", target, "--session", session], { encoding: "utf8", env });
		assert.equal(noOnly.status, 2);
		assert.match(noOnly.stderr, /--session and --cd need --only/);
		assert.equal(existsSync(path.join(root, "state")), false, "nothing written before the refusal");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi-restart-all refuses --cd without --session, and control characters in either", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-restart-all-test-"));
	try {
		const target = path.join(root, "target");
		mkdirSync(target);
		const odd = path.join(root, "a\nb");
		mkdirSync(odd);
		const session = path.join(root, "session.jsonl");
		writeFileSync(session, "");
		const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state") };
		const alone = spawnSync(SCRIPT, ["--dry-run", "--only", "%12", "--cd", target], { encoding: "utf8", env });
		assert.equal(alone.status, 2);
		assert.match(alone.stderr, /--cd needs --session/);
		const ctrl = spawnSync(SCRIPT, ["--dry-run", "--only", "%12", "--session", session, "--cd", odd], { encoding: "utf8", env });
		assert.equal(ctrl.status, 2);
		assert.match(ctrl.stderr, /control characters/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi-restart-all checks --session is a regular file and --cd a directory", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-restart-all-test-"));
	try {
		const target = path.join(root, "target");
		mkdirSync(target);
		const file = path.join(root, "a-file");
		writeFileSync(file, "");
		const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state") };
		const badSession = spawnSync(SCRIPT, ["--dry-run", "--only", "%12", "--session", path.join(root, "missing")], { encoding: "utf8", env });
		assert.equal(badSession.status, 2);
		assert.match(badSession.stderr, /--session is not a regular file/);
		const badDir = spawnSync(SCRIPT, ["--dry-run", "--only", "%12", "--session", file, "--cd", file], { encoding: "utf8", env });
		assert.equal(badDir.status, 2);
		assert.match(badDir.stderr, /--cd is not a directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pi-restart-all resumes a pi whose pane closed with it in a new window, secrets loaded first", async (t) => {
	const f = await restartFixture();
	const next = spawn("sleep", ["60"], { stdio: "ignore" }); // the resumed pi
	t.after(async () => { next.kill("SIGKILL"); await f.cleanup(); });
	const log = path.join(f.root, "tmux.log");
	const live = path.join(f.state, "pi-restart", "live");
	// The pi to stop: not node's own child, which would linger as a zombie (still "alive") under a
	// blocked spawnSync, but an orphan launchd reaps as soon as SIGUSR2 ends it.
	const old = Number(spawnSync("bash", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
	t.after(() => { try { process.kill(old, "SIGKILL"); } catch {} });
	const record = JSON.parse(readFileSync(path.join(live, `${f.sleeper.pid}.json`), "utf8"));
	rmSync(path.join(live, `${f.sleeper.pid}.json`));
	writeFileSync(path.join(live, `${old}.json`), JSON.stringify({ ...record, pid: old }));
	// A tmux where pane %12 is gone once pi leaves; new-window opens %99, and the "pi" in it writes
	// its record as the restart extension would.
	writeFileSync(
		path.join(f.bin, "tmux"),
		`#!/bin/bash
printf '%s\\n' "$*" >> ${quote(log)}
case "$*" in
  *pane_tty*) printf '/dev/ttys999\\n' ;;
  *session_name*) [ -e ${quote(log)}.gone ] && exit 1; printf 'code\\tbotsun\\n' ;;
  *new-window*)
    printf '{"pid":${next.pid},"sessionFile":%s,"cwd":"/tmp","pane":"%%99","socket":%s,"bypass":false,"idle":true}' \\
      ${quote(JSON.stringify(f.sessionFile))} ${quote(JSON.stringify(f.socket))} > ${quote(live)}/${next.pid}.json
    echo %99 ;;
  *pane_id*) touch ${quote(log)}.gone; exit 1 ;; # pi left, and its pane closed with it
  *) exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	const result = spawnSync(SCRIPT, ["--foreground", "--wait", "10"], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, XDG_STATE_HOME: f.state, SHELL: "/bin/zsh" },
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /the pane closed with pi: resuming in a new window code:botsun \(%99\)/);
	assert.match(result.stdout, new RegExp(`resumed as pid ${next.pid}`));
	// As tmux got it, its %q escapes taken out.
	const call = spawnSync("grep", ["new-window", log], { encoding: "utf8" }).stdout.replaceAll("\\", "");
	assert.match(call, /-t code: -n botsun/);
	assert.match(call, /fnox hook-env -s zsh/, "the secrets load before pi");
	assert.ok(call.indexOf("fnox hook-env") < call.indexOf("pi --session"), call);
});
