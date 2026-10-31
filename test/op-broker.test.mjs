/**
 * op-broker: the op shim's parsing and fall-through, the broker's cards and grants, the daemon
 * (with a fake op that records its arguments), and the extension end to end through the shim.
 * HOME and the broker dir are temp dirs; no real 1Password is touched.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

const root = mkdtempSync(join(tmpdir(), "op-broker-"));
process.env.HOME = root;
process.env.BOEHSLINE_CONFIG = join(root, "boehsline.json");
process.env.BOEHSLINE_ENABLE = "op-broker";
after(() => rmSync(root, { recursive: true, force: true }));

const EXT = join(import.meta.dirname, "..", "extensions", "opt-in", "op-broker");
const { parse } = await import(join(EXT, "shim.mjs"));
const { Broker, cardTitle, grantKey } = await import(join(EXT, "broker.ts"));
const { argvFor } = await import(join(EXT, "daemon.mjs"));

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
  "item get") case "$*" in *--otp*) echo 123456 ;; *) echo 'user,pa55' ;; esac ;;
  "whoami "*|"whoami") echo 'me@example.com' ;;
  *) echo "real op: $*" ;;
esac
`);
	chmodSync(bin, 0o755);
	return bin;
}
const calls = (dir) => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []);

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

function startDaemon(dir, opBin) {
	const child = spawn(process.execPath, [join(EXT, "daemon.mjs")], {
		env: { ...process.env, PI_OP_BROKER_DIR: dir, PI_OP_BROKER_OP: opBin, PI_OP_BROKER_KEEPALIVE_MS: "200" },
		stdio: "ignore",
	});
	after(() => child.kill());
	return child;
}

test("a second daemon defers to the first; the shim never runs itself as the real op", async () => {
	const { daemonRequest } = await import(join(EXT, "index.ts"));
	const dir = join(root, "d2");
	const fake = join(root, "fake4");
	const first = startDaemon(dir, fakeOp(fake));
	const sock = join(dir, "daemon.sock");
	await until(async () => (await daemonRequest(sock, { cmd: "status" }, 500))?.ok);
	const pid = (await daemonRequest(sock, { cmd: "status" })).pid;
	const second = startDaemon(dir, fakeOp(fake));
	const code = await new Promise((r) => second.on("exit", r));
	assert.equal(code, 0, "the second exits");
	assert.equal(readFileSync(join(dir, "daemon.lock"), "utf8").trim(), String(pid), "and leaves the first's lock alone");
	assert.equal((await daemonRequest(sock, { cmd: "status" })).pid, pid, "the first still answers on its socket");
	first.kill();
	await until(() => !existsSync(sock));

	// A lock left by a pid now reused by something else (this test process): taken over.
	writeFileSync(join(dir, "daemon.lock"), String(process.pid));
	startDaemon(dir, fakeOp(fake));
	await until(async () => (await daemonRequest(sock, { cmd: "status" }, 500))?.ok);
	await daemonRequest(sock, { cmd: "stop" });
	await until(() => !existsSync(sock));

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
	assert.equal(readFileSync(join(dir, "daemon.lock"), "utf8").trim().length > 0, true, "it holds the lock");

	writeFileSync(join(fake, "locked"), "");
	await until(async () => (await daemonRequest(sock, { cmd: "status" })).armed.length === 0, 3000); // the keep-alive notices
	assert.ok(calls(fake).some((c) => c.startsWith("whoami")), "kept warm with whoami");
	const r = await daemonRequest(sock, { cmd: "op", kind: "read", ref: "op://P/GitHub/token" });
	assert.deepEqual(r, { ok: false, error: "account is not signed in" });
	await daemonRequest(sock, { cmd: "stop" });
	await until(() => !existsSync(sock));
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
			c.end(`${JSON.stringify(req.item === "Nope" ? { ok: false, error: "op-broker: not approved" } : { ok: true, value: "v4lue" })}\n`);
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
});

test("the extension: a card in the session, then the daemon's value through the shim", async () => {
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
	const sock = process.env.PI_OP_BROKER_SOCK;
	assert.ok(sock?.endsWith(`s-${process.pid}.sock`));
	assert.ok(process.env.PATH.startsWith(`${EXT}:`), "the shim goes first");
	after(async () => {
		const { daemonRequest } = await import(join(EXT, "index.ts"));
		await daemonRequest(join(dir, "daemon.sock"), { cmd: "stop" }, 1000);
	});

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
