// op-broker's daemon: one per user, holding one 1Password CLI authorization for every pi session.
//
// The CLI authorizes a terminal (tty + start time), so the extension starts this inside a
// pseudo-terminal of its own (`script`), and every op it runs shares that one Touch ID. It stays
// warm with `op whoami` every few minutes (whoami never prompts), until 1Password's 12-hour limit
// or the app locks.
//
// Socket: <dir>/daemon.sock (dir 0700, socket 0600), one JSON line each way. It takes only:
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

import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, appendFileSync, unlinkSync, existsSync, lstatSync, statSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const brokerDir = (env = process.env) => env.PI_OP_BROKER_DIR || join(homedir(), ".local", "state", "pi-op-broker");

const DIR = brokerDir();
const SOCK = join(DIR, "daemon.sock");
const LOG = join(DIR, "daemon.log");
const LOCK = join(DIR, "daemon.lock");
const KEEPALIVE_MS = Number(process.env.PI_OP_BROKER_KEEPALIVE_MS) || 4 * 60_000; // inside the CLI's 10-minute idle window
const IDLE_EXIT_MS = Number(process.env.PI_OP_BROKER_IDLE_MS) || 30 * 60_000;     // unarmed and unused this long: exit
const OP_TIMEOUT_MS = 90_000; // a Touch ID prompt waits 60 s
const MAX_LINE = 16 * 1024;
const ACCOUNT = /^(?!-)[\w.@-]{1,100}$/;
const NAME = /^(?!-)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,200}$/u; // as the shim: no leading "-", nothing invisible
const SEG = "[^/?\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]+"; // no "?": the only query taken is ?attribute=otp
const REF = new RegExp(`^op://${SEG}/${SEG}(/${SEG}){1,2}(\\?attribute=(otp|totp))?$`, "u");

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

// The argv for a request, or null if it isn't one we run.
export function argvFor(req) {
	const acct = req.account === undefined ? [] : ACCOUNT.test(req.account) ? ["--account", req.account] : null;
	if (!acct) return null;
	const vault = req.vault === undefined ? [] : typeof req.vault === "string" && NAME.test(req.vault) ? ["--vault", req.vault] : null;
	if (!vault) return null;
	switch (req.kind) {
		case "whoami": return ["whoami", ...acct];
		case "read": return typeof req.ref === "string" && REF.test(req.ref) ? ["read", "--no-newline", req.ref, ...acct] : null;
		case "otp": return typeof req.item === "string" && NAME.test(req.item) ? ["item", "get", req.item, ...vault, "--otp", ...acct] : null;
		case "fields":
			if (typeof req.item !== "string" || !NAME.test(req.item)) return null;
			if (!Array.isArray(req.fields) || req.fields.length < 1 || req.fields.length > 10 || !req.fields.every((f) => typeof f === "string" && NAME.test(f) && !f.includes(","))) return null;
			return ["item", "get", req.item, ...vault, "--fields", req.fields.join(","), "--reveal", ...acct];
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

async function keepAlive() {
	for (const key of [...armed]) {
		const r = await run(["whoami", ...(key ? ["--account", key] : [])]);
		if (!r.ok) {
			armed.delete(key);
			log(`disarmed ${key || "(default)"}: ${r.error}`);
		}
	}
	if (armed.size === 0 && Date.now() - lastUse > IDLE_EXIT_MS) shutdown();
}

let server;
let sockIno; // the socket this daemon bound: shutdown removes only that one
let haveLock = false;
function shutdown() {
	try {
		server?.close();
		if (sockIno !== undefined && existsSync(SOCK) && statSync(SOCK).ino === sockIno) unlinkSync(SOCK);
		if (haveLock && readFileSync(LOCK, "utf8").trim() === String(process.pid)) unlinkSync(LOCK);
	} catch {}
	log("stopped");
	process.exit(0);
}

function isDaemon(pid) {
	try {
		process.kill(pid, 0);
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).includes("daemon.mjs");
	} catch {
		return false;
	}
}

// One daemon at a time: a lock file holding its pid. A dead holder's lock is taken over.
function lock() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(LOCK, "wx", 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return true;
		} catch (e) {
			if (e.code !== "EEXIST") return false;
			const pid = Number(readFileSync(LOCK, "utf8").trim());
			if (pid > 0 && isDaemon(pid)) return false; // the daemon is running
			// A dead holder, or a reused pid that isn't a daemon: take it over.
			try {
				unlinkSync(LOCK);
			} catch {}
		}
	}
	return false;
}

// Another daemon already answering means this one isn't needed.
function alive() {
	return new Promise((resolve) => {
		const c = createConnection(SOCK);
		c.on("connect", () => { c.destroy(); resolve(true); });
		c.on("error", () => resolve(false));
	});
}

async function main() {
	mkdirSync(DIR, { recursive: true, mode: 0o700 });
	chmodSync(DIR, 0o700);
	if (!lock()) process.exit(0);
	haveLock = true;
	if (existsSync(SOCK)) {
		if (await alive()) {
			try {
				unlinkSync(LOCK); // ours, just taken: the answering daemon's pid isn't ours to record
			} catch {}
			process.exit(0);
		}
		if (lstatSync(SOCK).isSocket()) unlinkSync(SOCK);
	}
	server = createServer((conn) => {
		let buf = "";
		conn.setEncoding("utf8");
		conn.on("data", async (d) => {
			buf += d;
			if (buf.length > MAX_LINE) return conn.destroy();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			let req;
			try {
				req = JSON.parse(buf.slice(0, nl));
			} catch {}
			buf = "";
			const reply = await handle(req).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
			conn.end(`${JSON.stringify(reply)}\n`);
		});
		conn.on("error", () => {});
	});
	server.on("error", (e) => {
		log(`can't listen: ${e.message}`);
		shutdown();
	});
	server.listen(SOCK, () => {
		chmodSync(SOCK, 0o600); // the folder is 0700 already
		sockIno = statSync(SOCK).ino;
		log(`started pid ${process.pid}`);
	});
	setInterval(keepAlive, KEEPALIVE_MS).unref?.();
	setInterval(() => armed.size === 0 && Date.now() - lastUse > IDLE_EXIT_MS && shutdown(), 60_000);
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
