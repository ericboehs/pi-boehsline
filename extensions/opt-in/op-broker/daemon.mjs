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
import { chmodSync, mkdirSync, appendFileSync, unlinkSync, lstatSync, statSync } from "node:fs";
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

// Which file a path is: device, inode and birth time (ctime where the filesystem has none). An
// inode alone can be reused once its file is gone (ext4 does it at once), so a newer socket at the
// path could look like ours.
export const fileId = (st) => ({ dev: st.dev, ino: st.ino, born: st.birthtimeMs || st.ctimeMs });
export const sameFile = (st, id) => !!id && st.dev === id.dev && st.ino === id.ino && (st.birthtimeMs || st.ctimeMs) === id.born;

// Our folder deleted, or our socket gone or replaced (another daemon bound a new one): nobody can
// reach this daemon any more, so it exits instead of holding an authorization for no one.
function orphaned() {
	if (sockId === undefined) return false; // not listening yet
	try {
		if (!statSync(DIR).isDirectory()) return true;
		return !sameFile(lstatSync(SOCK), sockId);
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
let sockId; // the socket this daemon bound (fileId): shutdown removes only that one
function shutdown() {
	// No server.close(): Node unlinks the socket's path on close, which may be another daemon's by
	// now. Exiting closes it; the path is removed only if it's still the one this daemon bound.
	try {
		if (sameFile(lstatSync(SOCK), sockId)) unlinkSync(SOCK);
	} catch {}
	log("stopped");
	process.exit(0);
}

// Another daemon already answering means this one isn't needed.
function alive(sock = SOCK) {
	return new Promise((resolve) => {
		const c = createConnection(sock);
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

// A path in use with nobody answering: remove it only if it's a socket, still nobody answers on a
// second look (a slow daemon, or another starter that just bound it), and it's still the same file
// first judged stale (another starter may have removed it and bound its own meanwhile).
// "alive" | "removed" | "replaced" | "gone" | "not-socket" | "error".
export async function clearStale(sock, isAlive) {
	if (await isAlive()) return "alive";
	let first;
	try {
		first = lstatSync(sock, { bigint: true });
	} catch (e) {
		return e?.code === "ENOENT" ? "gone" : "error";
	}
	if (!first.isSocket()) return "not-socket";
	if (await isAlive()) return "alive";
	try {
		// Linux hands a just-freed inode number to the next file, so a socket another
		// starter bound in between can share dev+ino. Its change time can't match.
		const now = lstatSync(sock, { bigint: true });
		if (now.dev !== first.dev || now.ino !== first.ino || now.ctimeNs !== first.ctimeNs) return "replaced";
		unlinkSync(sock);
		return "removed";
	} catch (e) {
		return e?.code === "ENOENT" ? "gone" : "error";
	}
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
		const r = await clearStale(SOCK, () => alive());
		if (r === "alive") return process.exit(0);
		if (retry && (r === "removed" || r === "gone" || r === "replaced")) return listen(false);
		log(`can't listen: ${SOCK} is in use and isn't a daemon answering${r === "not-socket" ? " (not a socket: left alone)" : ""}`);
		process.exit(1);
	});
	server.listen(SOCK, () => {
		chmodSync(SOCK, 0o600); // the folder is 0700 already
		sockId = fileId(lstatSync(SOCK));
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
