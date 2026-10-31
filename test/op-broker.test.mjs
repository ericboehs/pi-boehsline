/**
 * op-broker: the op shim's parsing and fall-through, the broker's cards and grants, the daemon
 * (with a fake op that records its arguments), and the extension end to end through the shim.
 * HOME and the broker dir are temp dirs; no real 1Password is touched.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

const root = mkdtempSync(join(tmpdir(), "op-broker-"));
process.env.HOME = root;
process.env.BOEHSLINE_CONFIG = join(root, "boehsline.json");
process.env.BOEHSLINE_ENABLE = "op-broker";
// Every daemon these tests start (directly or through the extension) exits within 30 s even if
// this run is killed before its cleanup: the fake op's whoami always succeeds, so they'd stay armed.
const savedTtl = process.env.PI_OP_BROKER_TTL_MS; // put back by the last test
process.env.PI_OP_BROKER_TTL_MS = "30000";
after(() => rmSync(root, { recursive: true, force: true }));

const EXT = join(import.meta.dirname, "..", "extensions", "opt-in", "op-broker");
const { parse } = await import(join(EXT, "shim.mjs"));
const { Broker, cardTitle, grantKey, maskSecrets, parseRef } = await import(join(EXT, "broker.ts"));
const { NAME, REF } = await import(join(EXT, "validate.mjs"));
const { argvFor, clearStale, fileId, sameFile } = await import(join(EXT, "daemon.mjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await sleep(20);
	}
	assert.fail("timed out waiting");
}

// A fake op: logs each call's arguments, prints by subcommand. $FAKE_OP_DIR/locked makes it fail
// as a locked 1Password does.
function fakeOp(dir) {
	mkdirSync(dir, { recursive: true });
	const bin = join(dir, "op");
	writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
if [ -f "${dir}/locked" ]; then echo "[ERROR] 2026/10/31 12:00:00 account is not signed in" >&2; exit 1; fi
case "$1 $2" in
  "read --no-newline") printf 's3cret-value' ;;
  "item get") case "$*" in *Slow*) sleep 0.2; echo 123456 ;; *--otp*) echo 123456 ;; *) echo 'user,pa55' ;; esac ;;
  "whoami "*|"whoami") echo 'me@example.com' ;;
  *) echo "real op: $*" ;;
esac
`);
	chmodSync(bin, 0o755);
	return bin;
}
const calls = (dir) => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []);

// process.env as it is now; the returned function puts it back (keys added since are removed).
function snapshotEnv() {
	const saved = { ...process.env };
	return () => {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
	};
}

// Lines written raw to a socket (as any same-user process could), one chunk at a time, 30 ms
// apart if more than one; the first reply line, parsed.
function rawRequest(sock, text) {
	const chunks = [text].flat();
	return new Promise((resolve, reject) => {
		const c = createConnection(sock);
		let buf = "";
		c.setEncoding("utf8");
		c.on("connect", async () => {
			for (const [i, chunk] of chunks.entries()) {
				if (i) await sleep(30);
				if (!c.destroyed && c.writable) c.write(chunk);
			}
		});
		c.on("data", (d) => (buf += d));
		c.on("error", reject);
		c.on("close", () => resolve(buf ? JSON.parse(buf.split("\n")[0]) : null));
	});
}

test("the shim takes only the read forms it knows; everything else is the real op", () => {
	assert.deepEqual(parse(["read", "op://Personal/GitHub/token"]), { kind: "read", ref: "op://Personal/GitHub/token", newline: true });
	assert.deepEqual(parse(["read", "-n", "op://Personal/My Item/sec/field", "--account=my"]),
		{ account: "my", kind: "read", ref: "op://Personal/My Item/sec/field", newline: false });
	assert.deepEqual(parse(["item", "get", "Rubygems", "--otp", "--account", "my"]), { account: "my", kind: "otp", item: "Rubygems" });
	assert.deepEqual(parse(["item", "get", "GitHub", "--vault", "Personal", "--fields", "username, password", "--reveal"]),
		{ vault: "Personal", kind: "fields", item: "GitHub", fields: ["username", "password"] });
	assert.deepEqual(parse(["signin", "--account", "my"]), { account: "my", kind: "signin" });
	for (const argv of [
		["read", "op://Personal/GitHub/token", "--out-file", "x"], // writes a file: the real op
		["read", "op://Personal"],
		["read", "-op://x/y/z"],
		["item", "get", "GitHub", "--format", "json"],
		["item", "get", "GitHub", "--fields", "password"], // no --reveal
		["item", "get", "GitHub", "--otp", "--reveal"],
		["item", "list"],
		["vault", "list"],
		["read", "op://P/I/f", "--account", "bad account"],
		["item", "get", "a\nb", "--otp"],
		["item", "get", "Git\u202eHub", "--otp"], // bidi: the card would show another name
		["item", "get", "Git\u200bHub", "--otp"],
		["read", "op://P/Git\u202eHub/token"],
		["item", "get", "--", "--otp"],
		["read", "op://V/SSH/private key?ssh-format=openssh"], // the card would say one-time code
		["read", "op://V/SSH/f?attribute=type"],
		["read", "op://P/I/f", "--account", "--help"],
	]) assert.equal(parse(argv), null, argv.join(" "));
});

test("a card's words name the item, the field and what it's for; grants key on account, vault and item", () => {
	assert.equal(cardTitle({ kind: "read", ref: "op://Personal/GitHub/token", command: "bash -c gh auth login\n--with-token" }),
		"🔑 1Password: GitHub · token (Personal)\nfor: bash -c gh auth login --with-token");
	assert.equal(cardTitle({ kind: "otp", item: "Rubygems", account: "my" }), "🔑 1Password: Rubygems · one-time code [my]");
	assert.equal(cardTitle({ kind: "read", ref: "op://P/Rubygems/one?attribute=otp" }), "🔑 1Password: Rubygems · one-time code (P)");
	assert.match(cardTitle({ kind: "otp", item: "x", command: "y".repeat(500) }), /for: y{199}…$/);
	assert.equal(grantKey({ kind: "read", ref: "op://Personal/GitHub/token" }), grantKey({ kind: "read", ref: "op://personal/github/password" }));
	assert.equal(grantKey({ kind: "otp", item: "GitHub" }), JSON.stringify(["", null, "github"]));
	assert.notEqual(grantKey({ kind: "otp", item: "GitHub" }), grantKey({ kind: "otp", item: "GitHub", vault: "*" }), "no vault named isn't a vault called *");
	assert.notEqual(grantKey({ kind: "otp", item: "x|GitHub", vault: "Work" }), grantKey({ kind: "otp", item: "GitHub", vault: "Work|x" }), "no key collisions");
	assert.equal(cardTitle({ kind: "read", ref: "op://V/SSH/private key?ssh-format=openssh" }),
		"🔑 1Password: op://V/SSH/private key?ssh-format=openssh", "an unknown query is shown raw, never as a one-time code");
	assert.equal(cardTitle({ kind: "read", ref: "op://P/AWS/prod/key" }), "🔑 1Password: AWS · prod › key (P)", "the section shows");
	assert.equal(cardTitle({ kind: "otp", item: "x", command: "a\u202eb\u200bc\u009bd" }), "🔑 1Password: x · one-time code\nfor: a b c d");
	assert.notEqual(grantKey({ kind: "otp", item: "GitHub", account: "work" }), grantKey({ kind: "otp", item: "GitHub" }));
	// The card parses exactly the refs the shim and daemon take (validate.mjs's REF).
	for (const ref of ["op://P/I/f", "op://P/I/s/f", "op://P/I/f?attribute=otp", "op://P/I/s/f/g", "op://P/I", "op://P/Git\u202eHub/f", "op://P/I\u200b/f", "op://P/I/f?x=1", "op://P/I/f\n"])
		assert.equal(parseRef(ref) !== null, REF.test(ref), ref);
});

test("once covers one read, 1 hour covers the item until it lapses, deny and dismiss refuse", async () => {
	let now = 0;
	const answers = [];
	const asked = [];
	const ran = [];
	const broker = new Broker({
		ask: async (title) => (asked.push(title), answers.shift()),
		daemon: async (req) => (ran.push(req.kind), { ok: true, value: "v" }),
		now: () => now,
	});
	const tok = { kind: "read", ref: "op://Personal/GitHub/token" };
	answers.push("once");
	assert.deepEqual(await broker.handle(tok), { ok: true, value: "v" });
	answers.push("deny");
	assert.deepEqual(await broker.handle(tok), { ok: false, error: "op-broker: not approved" }, "once is spent");
	answers.push(undefined);
	assert.equal((await broker.handle(tok)).ok, false, "dismissed or timed out is a deny");
	answers.push("1h");
	assert.equal((await broker.handle(tok)).ok, true);
	assert.equal((await broker.handle({ kind: "read", ref: "op://Personal/GitHub/password" })).ok, true, "the grant covers the item's other fields");
	assert.equal(asked.length, 4, "no card while the grant lives");
	assert.equal(broker.list().length, 1);
	now += 3_600_001;
	answers.push("deny");
	assert.equal((await broker.handle(tok)).ok, false, "it lapsed");
	assert.deepEqual(ran, ["read", "read", "read"]);
	answers.push("8h");
	await broker.handle(tok);
	assert.equal(broker.revoke(), 1);
	assert.equal(broker.list().length, 0);
});

test("a card answered after a revoke leaves no grant", async () => {
	let release;
	const broker = new Broker({ ask: () => new Promise((r) => (release = r)), daemon: async () => ({ ok: true, value: "v" }) });
	const read = broker.handle({ kind: "otp", item: "Rubygems" });
	await sleep(10);
	broker.revoke(); // the session ended while the card was up
	release("8h");
	assert.equal((await read).ok, false);
	assert.equal(broker.list().length, 0);
});

test("a read queued behind a card when the session ends never gets a card of its own", async () => {
	let release;
	const asked = [];
	const broker = new Broker({
		// The first card stays up until released; any later card (the bug) answers at once.
		ask: (title) => (asked.push(title), asked.length === 1 ? new Promise((r) => (release = r)) : Promise.resolve("once")),
		daemon: async () => ({ ok: true, value: "v" }),
	});
	const a = broker.handle({ kind: "otp", item: "Rubygems" });
	const b = broker.handle({ kind: "otp", item: "GitHub" }); // waits behind the first card
	await sleep(10);
	broker.revoke(); // /new: the session that asked is gone
	release("once");
	assert.deepEqual(await Promise.all([a, b]).then((r) => r.map((x) => x.ok)), [false, false]);
	assert.equal(asked.length, 1, "the queued read was refused, not carded in the next session");
	assert.equal((await broker.handle({ kind: "otp", item: "GitHub" })).ok, true);
	assert.equal(asked.length, 2, "a read from the new session gets its card");
});

test("one card at a time; a read waiting behind a card rides the grant it left", async () => {
	let release;
	const asked = [];
	const broker = new Broker({
		ask: (title) => (asked.push(title), new Promise((r) => (release = r))),
		daemon: async () => ({ ok: true, value: "v" }),
	});
	const a = broker.handle({ kind: "otp", item: "Rubygems" });
	const b = broker.handle({ kind: "otp", item: "Rubygems" });
	await sleep(20);
	assert.equal(asked.length, 1, "the second waits behind the first card");
	release("1h");
	assert.deepEqual(await Promise.all([a, b]), [{ ok: true, value: "v" }, { ok: true, value: "v" }]);
	assert.equal(asked.length, 1);
});

test("the daemon runs only what it allows", () => {
	assert.deepEqual(argvFor({ kind: "read", ref: "op://P/I/f", account: "my" }), ["read", "--no-newline", "op://P/I/f", "--account", "my"]);
	assert.deepEqual(argvFor({ kind: "otp", item: "Rubygems", vault: "Personal" }), ["item", "get", "Rubygems", "--vault", "Personal", "--otp"]);
	assert.deepEqual(argvFor({ kind: "fields", item: "G", fields: ["a", "b"] }), ["item", "get", "G", "--fields", "a,b", "--reveal"]);
	for (const bad of [
		{ kind: "read", ref: "--help" },
		{ kind: "otp", item: "x", account: "-x y" },
		{ kind: "fields", item: "G", fields: ["a,b"] },
		{ kind: "fields", item: "G", fields: [] },
		{ kind: "delete", item: "G" },
		{ kind: "otp", item: "x", vault: "a\nb" },
		{ kind: "otp", item: "--format=json" },
		{ kind: "otp", item: "x", vault: "-v" },
		{ kind: "fields", item: "G", fields: ["--share-link"] },
		{ kind: "read", ref: "op://P/I\u202e/f" },
		{ kind: "read", ref: "op://V/SSH/private key?ssh-format=openssh" },
		{ kind: "otp", item: "x", account: "--help" },
	]) assert.equal(argvFor(bad), null, JSON.stringify(bad));
});

test("an OP_ACCOUNT the shim can't pass on sends the read to the real op, never to the default account", () => {
	const restoreEnv = snapshotEnv();
	try {
		process.env.OP_ACCOUNT = "work";
		assert.deepEqual(parse(["item", "get", "Rubygems", "--otp"]), { account: "work", kind: "otp", item: "Rubygems" });
		process.env.OP_ACCOUNT = "bad account";
		assert.equal(parse(["item", "get", "Rubygems", "--otp"]), null);
		assert.equal(parse(["read", "op://P/I/f"]), null);
		assert.deepEqual(parse(["read", "op://P/I/f", "--account", "my"]), { account: "my", kind: "read", ref: "op://P/I/f", newline: true }, "--account wins");
		process.env.OP_ACCOUNT = "";
		assert.deepEqual(parse(["read", "op://P/I/f"]), { kind: "read", ref: "op://P/I/f", newline: true }, "empty is unset");
	} finally {
		restoreEnv();
	}
});

test("names: legit ones pass; surrogates, private use, unassigned, whitespace runs and the card's separators don't", () => {
	for (const ok of ["GitHub", "My Item", "AWS (prod)", "api.example.com", "foo-bar_baz", "Café 日本 Ümläut", "🔑 GitHub", "👍🏽", "x ", "a b c"])
		assert.ok(NAME.test(ok), JSON.stringify(ok));
	for (const bad of ["\ud800x", "x\udc00", "\ue000", "\u{f0000}", "\u0378", "\u{10fffe}", "a  b", "a \u00a0b", "a\u3000\u3000b", "GitHub · token", "AWS › key", "·", "›"])
		assert.equal(NAME.test(bad), false, JSON.stringify(bad));
	// The same in a ref, as the shim, the session and the card's parseRef see it.
	for (const ref of ["op://P/Git·Hub/f", "op://P/I/a›b", "op://P/a  b/f", "op://P/\ue000/f", "op://P/I/\ud800"]) {
		assert.equal(REF.test(ref), false, ref);
		assert.equal(parseRef(ref), null, ref);
		assert.equal(argvFor({ kind: "read", ref }), null, ref);
	}
	assert.ok(REF.test("op://Personal/🔑 My Item (x)/sec/field"));
	assert.equal(parse(["item", "get", "Git·Hub", "--otp"]), null);
	assert.equal(argvFor({ kind: "otp", item: "a  b" }), null);
});

test("the card masks likely secrets in the command line it shows (and sends to the phone)", () => {
	const cases = [
		["GITHUB_TOKEN=ghp_abc123 gh auth status", "GITHUB_TOKEN=••• gh auth status"],
		["curl -H 'Authorization: Bearer eyJhbGc.x.y' https://x", "curl -H 'Authorization: •••' https://x"], // gitleaks:allow (a fake token: the card must mask it)
		['curl -H "authorization:Basic dXNlcjpw" x', 'curl -H "authorization:•••" x'],
		["curl --oauth2-bearer tok -H 'X: Bearer abc.def'", "curl --oauth2-bearer ••• -H 'X: Bearer •••'"],
		["mysql --password=hunter2 -u root", "mysql --password=••• -u root"],
		["API_KEY='a b c' ./run", "API_KEY=••• ./run"],
		['echo {"client_secret": "s3", "id": 1}', 'echo {"client_secret": •••, "id": 1}'],
		["PGPASSWORD=x&&psql; aws --pwd: y", "PGPASSWORD=•••&&psql; aws --pwd: •••"],
		["bash -c gh auth login --with-token", "bash -c gh auth login --with-token"], // nothing inline
		["op read op://P/GitHub/token", "op read op://P/GitHub/token"],
	];
	for (const [cmd, want] of cases) assert.equal(maskSecrets(cmd), want, cmd);
	const title = cardTitle({ kind: "read", ref: "op://P/GitHub/token", command: "env\nSECRET_KEY=abc DB_PASS=ok curl -H 'Authorization: Bearer zzz'" });
	assert.equal(title, "🔑 1Password: GitHub · token (P)\nfor: env SECRET_KEY=••• DB_PASS=ok curl -H 'Authorization: •••'");
	assert.doesNotMatch(title, /abc|zzz/);
});

// A socket file with nobody behind it: a process that bound it, killed outright.
async function staleSocket(path) {
	const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)})`], { stdio: "ignore" });
	after(() => child.kill("SIGKILL"));
	await until(() => existsSync(path));
	child.kill("SIGKILL");
	await exited(child);
	assert.ok(lstatSync(path).isSocket());
}

test("a stale socket is removed only if nobody answers on a second look and it's still the same file", async () => {
	const dir = mkdtempSync(join(root, "stale-"));
	const sock = join(dir, "daemon.sock");
	const never = async () => false;

	await staleSocket(sock);
	assert.equal(await clearStale(sock, never), "removed");
	assert.equal(existsSync(sock), false);

	// A daemon that answers only on the second look (slow, or another starter just bound it): kept.
	await staleSocket(sock);
	const ino = lstatSync(sock).ino;
	let looks = 0;
	assert.equal(await clearStale(sock, async () => ++looks > 1), "alive");
	assert.equal(looks, 2);
	assert.equal(lstatSync(sock).ino, ino, "left in place");

	// Between the two looks another starter removed it and bound its own (still a false "not alive"):
	// the new one isn't the file judged stale, so it stays.
	looks = 0;
	let other;
	const replace = async () => {
		if (++looks === 2) {
			rmSync(sock);
			other = createServer(() => {});
			after(() => other.close()); // closed even if an assertion below fails
			await new Promise((r) => other.listen(sock, r));
		}
		return false;
	};
	assert.equal(await clearStale(sock, replace), "replaced");
	assert.ok(lstatSync(sock).isSocket(), "the other starter's socket is still there");
	await new Promise((r) => other.close(r));

	writeFileSync(sock, "x");
	assert.equal(await clearStale(sock, never), "not-socket");
	assert.equal(readFileSync(sock, "utf8"), "x");
	rmSync(sock);
	assert.equal(await clearStale(sock, never), "gone");
});

test("a daemon knows its socket by device, inode and birth time, not the inode alone (inodes are reused)", () => {
	const f = join(root, "id-file");
	writeFileSync(f, "");
	const st = lstatSync(f);
	const id = fileId(st);
	const born = st.birthtimeMs || st.ctimeMs;
	assert.deepEqual(id, { dev: st.dev, ino: st.ino, born });
	assert.equal(sameFile(st, id), true);
	assert.equal(sameFile(lstatSync(f), id), true, "stable across stats");
	const like = (o) => ({ ...st, birthtimeMs: st.birthtimeMs, ctimeMs: st.ctimeMs, dev: st.dev, ino: st.ino, ...o });
	assert.equal(sameFile(like({ ino: st.ino + 1 }), id), false, "another inode");
	assert.equal(sameFile(like({ dev: st.dev + 1 }), id), false, "same inode, another device");
	assert.equal(sameFile(like({ birthtimeMs: born + 1, ctimeMs: born + 1 }), id), false, "same inode reused: a newer file");
	assert.equal(sameFile(st, undefined), false, "not listening yet: never ours");
});

const exited = (child) => new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r(child.exitCode) : child.on("exit", (code) => r(code))));
async function within(promise, ms, what) {
	let timer;
	const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms)));
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

function startDaemon(dir, opBin, env = {}) {
	const child = spawn(process.execPath, [join(EXT, "daemon.mjs")], {
		env: { ...process.env, PI_OP_BROKER_DIR: dir, PI_OP_BROKER_OP: opBin, PI_OP_BROKER_KEEPALIVE_MS: "200", ...env },
		stdio: "ignore",
	});
	after(() => child.kill());
	return child;
}

test("one daemon: whoever binds the socket; a stale socket is taken over, anything else left alone; the shim never runs itself", async () => {
	const { daemonRequest } = await import(join(EXT, "index.ts"));
	const dir = join(root, "d2");
	const fake = join(root, "fake4");
	const first = startDaemon(dir, fakeOp(fake));
	const sock = join(dir, "daemon.sock");
	await until(async () => (await daemonRequest(sock, { cmd: "status" }, 500))?.ok);
	const pid = (await daemonRequest(sock, { cmd: "status" })).pid;
	const ino = statSync(sock).ino;
	const second = startDaemon(dir, fakeOp(fake));
	assert.equal(await within(exited(second), 3000, "a second daemon"), 0, "a second daemon defers to a live one");
	assert.equal(statSync(sock).ino, ino, "and leaves its socket alone");
	assert.equal((await daemonRequest(sock, { cmd: "status" })).pid, pid, "the first still answers on its socket");
	assert.equal(existsSync(join(dir, "daemon.lock")), false, "no lock file");

	// Killed outright: its socket file stays, with nobody behind it. The next daemon takes it over.
	first.kill("SIGKILL");
	await exited(first);
	assert.ok(lstatSync(sock).isSocket(), "a stale socket is left");
	const third = startDaemon(dir, fakeOp(fake));
	await until(async () => (await daemonRequest(sock, { cmd: "status" }, 500))?.pid === third.pid);
	await daemonRequest(sock, { cmd: "stop" });
	await until(() => !existsSync(sock));

	// Not a socket at the path: never deleted; the daemon says why and gives up.
	writeFileSync(sock, "not mine");
	const fourth = startDaemon(dir, fakeOp(fake));
	assert.notEqual(await within(exited(fourth), 3000, "a non-socket at the path"), 0);
	assert.equal(readFileSync(sock, "utf8"), "not mine", "the file is left alone");
	assert.match(readFileSync(join(dir, "daemon.log"), "utf8"), /can't listen: .*not a socket: left alone/);
	rmSync(sock);

	// Only the shim on PATH (as a looped install would see it): no fork bomb.
	const lonely = await runShim(["vault", "list"], { PATH: `${EXT}:/usr/bin:/bin`, PI_OP_BROKER_PASSTHRU: "1" });
	assert.equal(lonely.code, 127);
	assert.match(lonely.stderr, /found itself/);
});

test("the daemon: values only on the socket, unlocked after a read, locked again when op says so", async () => {
	const { daemonRequest } = await import(join(EXT, "index.ts"));
	const dir = join(root, "d1");
	const fake = join(root, "fake1");
	startDaemon(dir, fakeOp(fake));
	const sock = join(dir, "daemon.sock");
	await until(async () => (await daemonRequest(sock, { cmd: "status" }, 500))?.ok);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal(statSync(sock).mode & 0o777, 0o600);
	assert.deepEqual((await daemonRequest(sock, { cmd: "status" })).armed, []);
	assert.deepEqual(await daemonRequest(sock, { cmd: "op", kind: "read", ref: "op://P/GitHub/token" }), { ok: true, value: "s3cret-value" });
	assert.deepEqual(await daemonRequest(sock, { cmd: "op", kind: "otp", item: "Rubygems", account: "my" }), { ok: true, value: "123456" });
	assert.deepEqual((await daemonRequest(sock, { cmd: "status" })).armed.sort(), ["", "my"]);
	assert.equal((await daemonRequest(sock, { cmd: "op", kind: "read", ref: "--version" })).ok, false);
	assert.equal((await daemonRequest(sock, { cmd: "rm -rf" })).error, "unknown command");
	const log = readFileSync(join(dir, "daemon.log"), "utf8");
	assert.doesNotMatch(log, /s3cret|123456/, "values never reach the log");
	assert.match(log, /read op:\/\/P\/GitHub\/… ok/);

	// One request per connection: a second line on it never runs op.
	const before = calls(fake).length;
	const one = await rawRequest(sock, [
		`${JSON.stringify({ cmd: "op", kind: "otp", item: "Slow" })}\n`, // op takes 200 ms over it
		`${JSON.stringify({ cmd: "op", kind: "otp", item: "Second" })}\n`, // a later chunk, before the reply
	]);
	assert.deepEqual(one, { ok: true, value: "123456" });
	await sleep(100);
	assert.deepEqual(calls(fake).slice(before).filter((c) => !c.startsWith("whoami")), ["item get Slow --otp"], "only the first line ran");
	assert.ok(!calls(fake).some((c) => c.includes("Second")));

	writeFileSync(join(fake, "locked"), "");
	await until(async () => (await daemonRequest(sock, { cmd: "status" })).armed.length === 0, 3000); // the keep-alive notices
	assert.ok(calls(fake).some((c) => c.startsWith("whoami")), "kept warm with whoami");
	const r = await daemonRequest(sock, { cmd: "op", kind: "read", ref: "op://P/GitHub/token" });
	assert.deepEqual(r, { ok: false, error: "account is not signed in" });
	await daemonRequest(sock, { cmd: "stop" });
	await until(() => !existsSync(sock));
});

test("the daemon runs op without the starting session's 1Password settings or op-broker's own", async () => {
	const { daemonRequest } = await import(join(EXT, "index.ts"));
	const dir = join(root, "d9");
	const fake = join(root, "fake9");
	mkdirSync(fake, { recursive: true });
	const bin = join(fake, "op");
	writeFileSync(bin, `#!/bin/sh\nenv > "${fake}/env"\necho me@example.com\n`); // dumps the env op gets
	chmodSync(bin, 0o755);
	startDaemon(dir, bin, { OP_SESSION_x: "leak", OP_SERVICE_ACCOUNT_TOKEN: "leak", PI_OP_BROKER_FOO: "1", OP_CONFIG_DIR: "/x", OP_BIOMETRIC_UNLOCK_ENABLED: "true" });
	const sock = join(dir, "daemon.sock");
	await until(async () => (await daemonRequest(sock, { cmd: "status" }, 500))?.ok);
	assert.deepEqual(await daemonRequest(sock, { cmd: "op", kind: "whoami" }), { ok: true, value: "me@example.com" });
	const env = readFileSync(join(fake, "env"), "utf8").split("\n");
	assert.deepEqual(env.filter((l) => /=leak$/.test(l) || /^OP_SE/.test(l)), [], "no OP_SESSION_* or service account token");
	assert.deepEqual(env.filter((l) => l.startsWith("PI_OP_BROKER_")), [], "none of op-broker's own settings");
	assert.ok(env.includes("OP_CONFIG_DIR=/x"), "OP_CONFIG_DIR stays: it's how op finds the app");
	assert.ok(env.includes("OP_BIOMETRIC_UNLOCK_ENABLED=true"));
	await daemonRequest(sock, { cmd: "stop" });
	await until(() => !existsSync(sock));
});

// Three daemons side by side (each test alone would wait out its own startup and exit).
test("an armed daemon exits when its folder is deleted, its socket is replaced, or PI_OP_BROKER_TTL_MS passes", { concurrency: true }, async (t) => {
	const { daemonRequest } = await import(join(EXT, "index.ts"));
	const fake = join(root, "fake5");
	fakeOp(fake);
	const armedDaemon = async (dir, env) => {
		const child = startDaemon(dir, join(fake, "op"), env);
		const sock = join(dir, "daemon.sock");
		await until(async () => (await daemonRequest(sock, { cmd: "status" }, 500))?.ok);
		assert.equal((await daemonRequest(sock, { cmd: "op", kind: "read", ref: "op://P/GitHub/token" })).ok, true);
		assert.deepEqual((await daemonRequest(sock, { cmd: "status" })).armed, [""], "armed: idle exit alone would never come");
		return { child, sock };
	};
	await Promise.all([
		t.test("folder deleted", async () => {
			const dir = join(root, "d5");
			const { child } = await armedDaemon(dir);
			rmSync(dir, { recursive: true, force: true }); // a test's temp-dir cleanup
			assert.equal(await within(exited(child), 2000, "folder deleted"), 0);
			assert.equal(existsSync(dir), false, "and it doesn't make the folder again");
		}),
		t.test("socket replaced", async () => {
			const { child, sock } = await armedDaemon(join(root, "d6"));
			rmSync(sock);
			const other = createServer(() => {});
			await new Promise((r) => other.listen(sock, r)); // someone else's socket now at the path
			after(() => other.close());
			assert.equal(await within(exited(child), 2000, "socket replaced"), 0);
			assert.ok(existsSync(sock), "it leaves the new socket alone");
		}),
		t.test("TTL", async () => {
			const { child, sock } = await armedDaemon(join(root, "d7"), { PI_OP_BROKER_TTL_MS: "400" });
			assert.equal(await within(exited(child), 2000, "TTL"), 0);
			assert.equal(existsSync(sock), false, "it removes its socket on the way out");
		}),
	]);
});

test("the shim's ask settles once and clears its timer; daemonRequest waits just past op's timeout", async () => {
	const { ask } = await import(join(EXT, "shim.mjs"));
	const { DAEMON_REPLY_MS, OP_TIMEOUT_MS: indexOpTimeout } = await import(join(EXT, "index.ts"));
	const { OP_TIMEOUT_MS } = await import(join(EXT, "daemon.mjs"));
	assert.equal(indexOpTimeout, OP_TIMEOUT_MS, "index.ts and daemon.mjs agree on op's timeout");
	assert.ok(DAEMON_REPLY_MS > OP_TIMEOUT_MS && DAEMON_REPLY_MS - OP_TIMEOUT_MS <= 15_000, "a short margin past op's timeout");

	const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	const sock = join(root, "s-ask.sock");
	let silent = false;
	const server = createServer((c) => {
		c.setEncoding("utf8");
		c.on("data", () => !silent && c.end('{"ok":true,"value":"v"}\n'));
	});
	await new Promise((r) => server.listen(sock, r));
	after(() => server.close());
	const before = timers();
	assert.deepEqual(await ask(sock, { kind: "whoami" }), { ok: true, value: "v" });
	await sleep(10); // the hang-up after the reply
	assert.equal(timers(), before, "the 15-minute timer is cleared with the reply");
	silent = true;
	assert.deepEqual(await ask(sock, { kind: "whoami" }, 50), { ok: false, error: "op-broker: no answer in time" });
	assert.equal(await ask(join(root, "nobody.sock"), { kind: "whoami" }), null, "nothing listening");
	assert.equal(timers(), before);
});

// The shim against a stand-in session socket.
function runShim(args, env) {
	return new Promise((resolve) => {
		execFile(join(EXT, "op"), args, { env: { ...process.env, PI_OP_BROKER_NODE: process.execPath, ...env } }, (err, stdout, stderr) =>
			resolve({ code: err ? err.code : 0, stdout, stderr }));
	});
}

test("the shim: approved reads print the value, refusals fail, unknown forms and no session go to the real op", async () => {
	const fake = join(root, "fake2");
	fakeOp(fake);
	const sock = join(root, "s-test.sock");
	const got = [];
	const server = createServer((c) => {
		c.setEncoding("utf8");
		c.on("data", (d) => {
			const req = JSON.parse(d);
			got.push(req);
			c.end(`${JSON.stringify(req.item === "Nope" ? { ok: false, error: "op-broker: not approved" } : req.item === "Novalue" ? { ok: true } : { ok: true, value: "v4lue" })}\n`);
		});
	});
	await new Promise((r) => server.listen(sock, r));
	after(() => server.close());
	const env = { PI_OP_BROKER_SOCK: sock, PATH: `${EXT}:${fake}:${process.env.PATH}` };

	assert.deepEqual(await runShim(["read", "-n", "op://P/GitHub/token"], env), { code: 0, stdout: "v4lue", stderr: "" });
	assert.equal((await runShim(["item", "get", "Rubygems", "--otp"], env)).stdout, "v4lue\n");
	assert.equal(got[0].v, 1);
	assert.equal(got[0].kind, "read");
	assert.equal(typeof got[0].command, "string");
	const no = await runShim(["item", "get", "Nope", "--otp"], env);
	assert.equal(no.code, 1);
	assert.match(no.stderr, /not approved/);
	assert.deepEqual(await runShim(["item", "get", "Novalue", "--otp"], env), { code: 1, stdout: "", stderr: "[ERROR] op-broker: a reply with no value\n" },
		"ok but no value: an error, never \"undefined\"");
	got.pop();
	assert.deepEqual(await runShim(["signin", "--account", "my"], env), { code: 0, stdout: "", stderr: "" });
	assert.equal((await runShim(["read", "op://P/GitHub/token"], { ...env, OP_SERVICE_ACCOUNT_TOKEN: "x" })).stdout, "real op: read op://P/GitHub/token\n",
		"signed in its own way: the real op");
	assert.equal(got.length, 3, "signin never asks");
	await runShim(["item", "get", "Rubygems", "--otp"], { ...env, OP_ACCOUNT: "work" });
	assert.equal(got.at(-1).account, "work", "OP_ACCOUNT names the account when --account doesn't");
	assert.equal((await runShim(["vault", "list"], env)).stdout, "real op: vault list\n");
	assert.equal((await runShim(["read", "op://P/GitHub/token"], { ...env, PI_OP_BROKER_SOCK: join(root, "gone.sock") })).stdout,
		"real op: read op://P/GitHub/token\n", "no session listening: the real op, same arguments");
	assert.deepEqual(calls(fake), ["read op://P/GitHub/token", "vault list", "read op://P/GitHub/token"], "approved reads never ran the real op here");
	const asks = got.length;
	assert.equal((await runShim(["item", "get", "Rubygems", "--otp"], { ...env, OP_ACCOUNT: "bad account" })).stdout, "123456\n",
		"an OP_ACCOUNT op-broker can't pass on: the real op, not a read from the default account");
	assert.equal(calls(fake).at(-1), "item get Rubygems --otp", "the real op ran it, as typed");
	assert.equal(got.length, asks, "and the session was never asked");
});

test("the extension: a card in the session, then the daemon's value through the shim", async (t) => {
	const restoreEnv = snapshotEnv();
	const dir = join(root, "d3");
	const fake = join(root, "fake3");
	process.env.PI_OP_BROKER_DIR = dir;
	process.env.PI_OP_BROKER_OP = fakeOp(fake);
	process.env.PI_OP_BROKER_SCRIPT = join(root, "noscript.sh"); // no pty in tests: run the daemon directly
	writeFileSync(process.env.PI_OP_BROKER_SCRIPT, '#!/bin/sh\nshift; shift; exec "$@"\n');
	chmodSync(process.env.PI_OP_BROKER_SCRIPT, 0o755);
	const ext = (await import(join(EXT, "index.ts"))).default;
	const stub = stubPi();
	await ext(stub.pi);
	const picks = [];
	const titles = [];
	const keyboard = async (title, options) => (titles.push([title, options]), picks.shift());
	const { ctx, notes } = stubCtx({ mode: "tui", ui: { notify: (t, l) => notes.push([l, t]), select: keyboard } });
	await stub.fire("session_start", {}, ctx);
	// Whatever fails below, the session ends (its socket server and the shims let the file exit),
	// the daemon stops, and the env goes back as it was.
	t.after(async () => {
		await stub.fire("session_shutdown", {}, ctx);
		const { daemonRequest } = await import(join(EXT, "index.ts"));
		await daemonRequest(join(dir, "daemon.sock"), { cmd: "stop" }, 1000);
		restoreEnv();
	});
	const sock = process.env.PI_OP_BROKER_SOCK;
	assert.ok(sock?.endsWith(`s-${process.pid}.sock`));
	assert.ok(process.env.PATH.startsWith(`${EXT}:`), "the shim goes first");

	picks.push("Allow for 1 hour");
	const env = { PI_OP_BROKER_SOCK: sock, PATH: process.env.PATH };
	assert.deepEqual(await runShim(["read", "op://Personal/GitHub/token"], env), { code: 0, stdout: "s3cret-value\n", stderr: "" });
	assert.match(titles[0][0], /^🔑 1Password: GitHub · token \(Personal\)\nfor: /);
	assert.deepEqual(titles[0][1], ["Allow once", "Allow for 1 hour", "Allow for 8 hours", "Deny"]);
	assert.ok(notes.some(([, t]) => /Touch ID on the Mac/.test(t)), "first read: tells him to unlock");
	assert.equal((await runShim(["read", "-n", "op://Personal/GitHub/password"], env)).stdout, "s3cret-value");
	assert.equal(titles.length, 1, "the grant covers it");

	picks.push("Deny");
	const denied = await runShim(["item", "get", "Rubygems", "--otp"], env);
	assert.equal(denied.code, 1);
	assert.equal(calls(fake).filter((c) => c.includes("Rubygems")).length, 0, "a denied read never reaches op");

	// From the phone: the card is a remote prompt (as botsun-owner sees it); its answer closes the TUI card.
	const { openPrompts } = await import(join(import.meta.dirname, "..", "lib", "remote-prompts.ts"));
	let tuiClosed = false;
	ctx.ui.select = (title, options, { signal }) => (titles.push([title, options]), new Promise((r) => signal.addEventListener("abort", () => ((tuiClosed = true), r(undefined)))));
	const fromPhone = runShim(["item", "get", "Rubygems", "--otp", "--vault", "Personal"], env);
	await until(() => openPrompts().length === 1);
	const [prompt] = openPrompts();
	assert.match(prompt.questions[0].question, /^🔑 1Password: Rubygems · one-time code \(Personal\)\nfor: /);
	assert.equal(prompt.sensitive, true, "it guards a secret: never answered by voice");
	assert.deepEqual(prompt.questions[0].options.map((o) => o.label), ["Allow once", "Allow for 1 hour", "Allow for 8 hours", "Deny"]);
	assert.equal(prompt.answer([{ picks: [0] }]), null);
	assert.deepEqual(await fromPhone, { code: 0, stdout: "123456\n", stderr: "" });
	assert.ok(tuiClosed, "the phone's answer closed the TUI card");
	assert.equal(openPrompts().length, 0);

	// The keyboard answers first: the phone's copy goes away.
	ctx.ui.select = async () => "Deny";
	assert.equal((await runShim(["item", "get", "Rubygems", "--otp", "--vault", "Personal"], env)).code, 1);
	assert.equal(openPrompts().length, 0, "the phone's card closed too");

	// Free text from the phone (no pick) is a deny.
	ctx.ui.select = (t, o, { signal }) => new Promise((r) => signal.addEventListener("abort", () => r(undefined)));
	const typed = runShim(["item", "get", "Rubygems", "--otp", "--vault", "Personal"], env);
	await until(() => openPrompts().length === 1);
	openPrompts()[0].answer([{ picks: [], text: "sure" }]);
	assert.equal((await typed).code, 1);
	ctx.ui.select = keyboard; // back to the keyboard's picks

	await stub.commands.get("op-broker").handler("", ctx);
	assert.match(notes.at(-1)[1], /daemon: running, unlocked for default account\ngrant: personal \/ github · 60 min left/);
	await stub.fire("session_shutdown", {}, ctx);
	assert.equal(existsSync(sock), false);
	assert.equal(process.env.PI_OP_BROKER_SOCK, undefined);
	assert.ok(!process.env.PATH.split(":").includes(EXT));
	await stub.fire("session_start", {}, ctx);
	picks.push("Deny");
	assert.equal((await runShim(["read", "op://Personal/GitHub/token"], { PI_OP_BROKER_SOCK: process.env.PI_OP_BROKER_SOCK, PATH: process.env.PATH })).code, 1,
		"a new session starts with no grants");
	assert.match(titles.at(-1)[0], /GitHub · token/, "asked at the keyboard");
	assert.equal(openPrompts().length, 0);

	// The session ends with a card up (one that ignores its signal): closed, on the phone too, and a deny.
	ctx.ui.select = () => new Promise(() => {});
	const orphan = runShim(["item", "get", "Rubygems", "--otp"], { PI_OP_BROKER_SOCK: process.env.PI_OP_BROKER_SOCK, PATH: process.env.PATH });
	await until(() => openPrompts().length === 1);
	await stub.fire("session_shutdown", {}, ctx);
	assert.equal(openPrompts().length, 0);
	assert.equal((await orphan).code, 1);
});

// The session against a stand-in daemon that records what it's asked, and requests written raw to
// the session's socket (any process running as this user can, not only the shim).
test("the extension: the shim's rules on raw requests, one request per connection, one status per read, sessions kept apart", async (t) => {
	const restoreEnv = snapshotEnv();
	const dir = join(root, "d8");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const asked = [];
	let armed = [];
	const daemon = createServer((c) => {
		c.setEncoding("utf8");
		c.once("data", (d) => {
			const req = JSON.parse(d.split("\n")[0]);
			asked.push(req.cmd === "op" ? `op ${req.kind}` : req.cmd);
			const reply = `${JSON.stringify(req.cmd === "status" ? { ok: true, armed, pid: 1 } : { ok: true, value: "v" })}\n`;
			setTimeout(() => c.end(reply), req.cmd === "op" ? 100 : 0); // op takes a moment: a later line arrives first
		});
	});
	await new Promise((r) => daemon.listen(join(dir, "daemon.sock"), r));
	process.env.PI_OP_BROKER_DIR = dir;
	const ext = (await import(join(EXT, "index.ts"))).default;
	const stub = stubPi();
	await ext(stub.pi);
	const picks = [];
	const titles = [];
	const { ctx, notes } = stubCtx({ mode: "tui", ui: { notify: (text, level) => notes.push([level, text]), select: async (title) => (titles.push(title), picks.shift()) } });
	await stub.fire("session_start", {}, ctx);
	t.after(async () => {
		await stub.fire("session_shutdown", {}, ctx);
		await new Promise((r) => daemon.close(r));
		restoreEnv();
	});
	const sock = process.env.PI_OP_BROKER_SOCK;
	const line = (req) => `${JSON.stringify({ v: 1, ...req })}\n`;
	const touchIds = () => notes.filter(([, text]) => /Touch ID on the Mac/.test(text)).length;

	// What the shim would refuse is refused here too, before any card or daemon.
	for (const bad of [
		{ kind: "otp", item: "Git\u202eHub" },
		{ kind: "otp", item: "Rubygems", vault: "a\nb" },
		{ kind: "otp", item: "--format=json" },
		{ kind: "fields", item: "G", fields: ["user\u200b"] },
		{ kind: "read", ref: "op://P/I\u2028x/f" },
		{ kind: "otp", item: "x", account: "bad account" },
		{ kind: "otp", item: "x", fields: 1 },
	]) assert.deepEqual(await rawRequest(sock, line(bad)), { ok: false, error: "op-broker: a bad request" }, JSON.stringify(bad));
	assert.equal(titles.length, 0, "no card for any of them");
	assert.deepEqual(asked, []);

	// One request per connection: the second line is ignored.
	assert.deepEqual(await rawRequest(sock, [line({ kind: "whoami" }) + line({ kind: "whoami" }), line({ kind: "whoami" })]), { ok: true, value: "v" });
	await sleep(50);
	assert.deepEqual(asked, ["status", "op whoami"]);
	assert.equal(touchIds(), 0, "whoami never needs the Touch ID");

	// One status round trip per read, and the Touch ID notice only while the daemon isn't unlocked.
	asked.length = 0;
	picks.push("Allow once");
	assert.deepEqual(await rawRequest(sock, line({ kind: "otp", item: "Rubygems" })), { ok: true, value: "v" });
	assert.deepEqual(asked, ["status", "op otp"]);
	assert.equal(touchIds(), 1, "not unlocked: the notice");
	armed = [""];
	picks.push("Allow once");
	assert.deepEqual(await rawRequest(sock, line({ kind: "otp", item: "Rubygems" })), { ok: true, value: "v" });
	assert.deepEqual(asked, ["status", "op otp", "status", "op otp"]);
	assert.equal(touchIds(), 1, "unlocked: no notice");

	// A connection made in one session, its request sent after /new: refused, no card in the new one.
	const early = createConnection(sock);
	await new Promise((r) => early.on("connect", r));
	await stub.fire("session_shutdown", {}, ctx);
	await stub.fire("session_start", {}, ctx);
	const cards = titles.length;
	const late = await new Promise((resolve) => {
		let buf = "";
		early.setEncoding("utf8");
		early.on("data", (d) => (buf += d));
		early.on("close", () => resolve(buf ? JSON.parse(buf) : null));
		early.write(line({ kind: "otp", item: "Rubygems" }));
	});
	assert.deepEqual(late, { ok: false, error: "op-broker: that session ended" });
	assert.equal(titles.length, cards, "no card in the new session");
});

// Runs last: the extension tests above ended their sessions and put process.env back.
test("the extension tests leave no session socket and process.env as it was", () => {
	for (const d of ["d3", "d8"]) assert.equal(existsSync(join(root, d, `s-${process.pid}.sock`)), false, `${d}: the session's socket is closed`);
	assert.ok(!(process.env.PATH ?? "").split(":").includes(EXT), "the shim is off PATH");
	assert.equal(process.env.PI_OP_BROKER_SOCK, undefined);
	assert.equal(process.env.PI_OP_BROKER_DIR, undefined);
	assert.equal(process.env.BOEHSLINE_ENABLE, "op-broker");
	assert.equal(process.env.PI_OP_BROKER_TTL_MS, "30000", "the file's own TTL survived every snapshot restore");
	if (savedTtl === undefined) delete process.env.PI_OP_BROKER_TTL_MS;
	else process.env.PI_OP_BROKER_TTL_MS = savedTtl;
});
