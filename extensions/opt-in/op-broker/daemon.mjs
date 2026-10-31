// op-broker's daemon: one per user, holding one 1Password CLI authorization for every pi session.
//
// The CLI authorizes a terminal (tty + start time), so the extension starts this inside a
// pseudo-terminal of its own (`script`), and every op it runs shares that one Touch ID. It stays
// warm with `op whoami` every few minutes (whoami never prompts), until 1Password's 12-hour limit
// or the app locks.
//
// Socket: <dir>/daemon.sock (dir 0700, socket 0600), one JSON line each way, one request per
// connection. It takes only:
//   {cmd:"status"}                         → {ok, armed: [accounts], pid}
//   {cmd:"op", kind:"read", ref}           → op read --no-newline <ref>
//   {cmd:"op", kind:"otp", item, vault?}   → op item get <item> [--vault V] --otp
//   {cmd:"op", kind:"fields", item, vault?, fields} → op item get … --fields f,g --reveal
//   {cmd:"op", kind:"whoami"}              → op whoami
//   {cmd:"stop"}
// each with an optional account. No shell, nothing else. Values go back on the socket only:
// never to a file or the log.
//
// Approval happens in the sessions (the card), not here: any process running as this user can
// talk to this socket. That's the accepted risk (README).

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, appendFileSync, unlinkSync, existsSync, lstatSync, statSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { delimiter, join } from "node:path";
import { brokerDir, validRequest } from "./validate.mjs";

export { brokerDir };

const DIR = brokerDir();
const SOCK = join(DIR, "daemon.sock");
const LOG = join(DIR, "daemon.log");
const KEEPALIVE_MS = Number(process.env.PI_OP_BROKER_KEEPALIVE_MS) || 4 * 60_000; // inside the CLI's 10-minute idle window
const IDLE_EXIT_MS = Number(process.env.PI_OP_BROKER_IDLE_MS) || 30 * 60_000;     // unarmed and unused this long: exit
export const OP_TIMEOUT_MS = 90_000; // a Touch ID prompt waits 60 s (index.ts's daemonRequest waits a little longer)
// PI_OP_BROKER_TTL_MS (tests only; unset in production): exit this long after starting, armed or
// not, so a test run killed before its cleanup can't leave a daemon behind for good.
const TTL_MS = Number(process.env.PI_OP_BROKER_TTL_MS) || 0;
const STARTED = Date.now();
const MAX_LINE = 16 * 1024;

// The op binary: an override (tests), else op on PATH minus the shim's folder.
const OP = process.env.PI_OP_BROKER_OP || "op";
const shimDir = process.env.PI_OP_BROKER_SHIM_DIR;
const PATH = (process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== shimDir).join(delimiter);
// Not the starting session's 1Password settings (a token or session from its shell would apply to
// every session for hours): op uses the desktop app's authorization only.
// OP_CONFIG_DIR and OP_BIOMETRIC_UNLOCK_ENABLED are how op finds the desktop app: they stay.
const KEEP_OP = new Set(["OP_CONFIG_DIR", "OP_BIOMETRIC_UNLOCK_ENABLED"]);
const opEnv = Object.fromEntries(Object.entries({ ...process.env, PATH }).filter(([k]) => (KEEP_OP.has(k) || !k.startsWith("OP_")) && !k.startsWith("PI_OP_BROKER_")));

const armed = new Set(); // account keys ("" = op's default) whose authorization is live
let lastUse = Date.now();

const log = (msg) => {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
	} catch {}
};

// The argv for a request, or null if it isn't one we run (validate.mjs: the session's rules too).
export function argvFor(req) {
	if (!validRequest(req)) return null;
	const acct = req.account === undefined ? [] : ["--account", req.account];
	const vault = req.vault === undefined ? [] : ["--vault", req.vault];
	switch (req.kind) {
		case "whoami": return ["whoami", ...acct];
		case "read": return ["read", "--no-newline", req.ref, ...acct];
		case "otp": return ["item", "get", req.item, ...vault, "--otp", ...acct];
		case "fields": return ["item", "get", req.item, ...vault, "--fields", req.fields.join(","), "--reveal", ...acct];
		default: return null;
	}
}

function run(argv) {
	return new Promise((resolve) => {
		const child = execFile(OP, argv, { env: opEnv, timeout: OP_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
			const first = String(stderr ?? "").split("\n").find((l) => l.trim()) ?? "";
			resolve(err ? { ok: false, error: first.replace(/^\[ERROR\]\s*\S+\s+\S+\s*/, "").slice(0, 200) || `op failed (${err.code ?? err.signal})` } : { ok: true, out: stdout });
		});
		child.stdin?.end();
	});
}

async function handle(req) {
	if (req?.cmd === "status") return { ok: true, armed: [...armed], pid: process.pid };
	if (req?.cmd === "stop") {
		setTimeout(shutdown, 10);
		return { ok: true };
	}
	if (req?.cmd !== "op") return { ok: false, error: "unknown command" };
	const argv = argvFor(req);
	if (!argv) return { ok: false, error: "not a request op-broker runs" };
	lastUse = Date.now();
	const key = req.account ?? "";
	const r = await run(argv);
	if (r.ok) armed.add(key);
	else if (/not signed in|authorization|locked/i.test(r.error)) armed.delete(key);
	const what = req.kind === "read" ? req.ref.replace(/\/[^/]*$/, "/…") : `${req.vault ? `${req.vault}/` : ""}${req.item ?? ""}`;
	log(`${req.kind} ${what} ${r.ok ? "ok" : `failed: ${r.error}`}`); // never the value
	if (!r.ok) return r;
	if (req.kind === "whoami") return { ok: true, value: r.out.trim() };
	return { ok: true, value: req.kind === "read" ? r.out : r.out.replace(/\n$/, "") };
}

// Our folder deleted, or our socket gone or replaced (another daemon bound a new one): nobody can
// reach this daemon any more, so it exits instead of holding an authorization for no one.
function orphaned() {
	if (sockIno === undefined) return false; // not listening yet
	try {
		if (!statSync(DIR).isDirectory()) return true;
		return statSync(SOCK).ino !== sockIno;
	} catch {
		return true;
	}
}

// Every tick: should this daemon go?
function tick() {
	if (orphaned()) {
		log("socket or folder gone: exiting");
		return shutdown(), true;
	}
	if (TTL_MS && Date.now() - STARTED > TTL_MS) return shutdown(), true;
	if (armed.size === 0 && Date.now() - lastUse > IDLE_EXIT_MS) return shutdown(), true;
	return false;
}

async function keepAlive() {
	if (tick()) return;
	for (const key of [...armed]) {
		const r = await run(["whoami", ...(key ? ["--account", key] : [])]);
		if (!r.ok) {
			armed.delete(key);
			log(`disarmed ${key || "(default)"}: ${r.error}`);
		}
	}
	tick();
}

let server;
let sockIno; // the socket this daemon bound: shutdown removes only that one
function shutdown() {
	// No server.close(): Node unlinks the socket's path on close, which may be another daemon's by
	// now. Exiting closes it; the path is removed only if it's still the one this daemon bound.
	try {
		if (sockIno !== undefined && existsSync(SOCK) && statSync(SOCK).ino === sockIno) unlinkSync(SOCK);
	} catch {}
	log("stopped");
	process.exit(0);
}

// Another daemon already answering means this one isn't needed.
function alive() {
	return new Promise((resolve) => {
		const c = createConnection(SOCK);
		c.on("connect", () => { c.destroy(); resolve(true); });
		c.on("error", () => resolve(false));
	});
}

// One request per connection, one reply: anything after the first line is ignored.
function serve(conn) {
	let buf = "";
	let done = false;
	conn.setEncoding("utf8");
	conn.on("data", async (d) => {
		if (done) return;
		buf += d;
		if (buf.length > MAX_LINE) return conn.destroy();
		const nl = buf.indexOf("\n");
		if (nl < 0) return;
		done = true;
		let req;
		try {
			req = JSON.parse(buf.slice(0, nl));
		} catch {}
		buf = "";
		const reply = await handle(req).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
		conn.end(`${JSON.stringify(reply)}\n`);
	});
	conn.on("error", () => {});
}

// One daemon at a time: whoever binds daemon.sock. A path in use is a live daemon (this one isn't
// needed), a stale socket left by a dead one (taken over, once), or something else (left alone).
function listen(retry) {
	server = createServer(serve);
	server.once("error", async (e) => {
		if (e.code !== "EADDRINUSE") {
			log(`can't listen: ${e.message}`);
			return process.exit(1);
		}
		if (await alive()) return process.exit(0);
		let stale = false;
		try {
			stale = lstatSync(SOCK).isSocket();
		} catch (err) {
			stale = err?.code === "ENOENT"; // gone meanwhile: just try again
		}
		if (retry && stale) {
			try {
				unlinkSync(SOCK);
			} catch {}
			return listen(false);
		}
		log(`can't listen: ${SOCK} is in use and isn't a daemon answering${stale ? "" : " (not a socket: left alone)"}`);
		process.exit(1);
	});
	server.listen(SOCK, () => {
		chmodSync(SOCK, 0o600); // the folder is 0700 already
		sockIno = statSync(SOCK).ino;
		server.on("error", (e) => {
			log(`server error: ${e.message}`);
			shutdown();
		});
		log(`started pid ${process.pid}`);
	});
}

async function main() {
	mkdirSync(DIR, { recursive: true, mode: 0o700 });
	chmodSync(DIR, 0o700);
	listen(true);
	setInterval(keepAlive, KEEPALIVE_MS).unref?.();
	setInterval(tick, Math.min(60_000, KEEPALIVE_MS, TTL_MS || Infinity));
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
