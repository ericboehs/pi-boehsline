// The `op` that pi's bash tool finds first (op-broker puts this folder's `op` on PATH).
//
// The reads op-broker knows go to this session's extension, which shows an approval card and,
// once approved, asks the shared daemon (one 1Password authorization for every session):
//
//   op read <op://ref> [-n|--no-newline] [--account A]
//   op item get <item> [--vault V] [--account A] --otp
//   op item get <item> [--vault V] [--account A] --fields <f[,f]> --reveal
//   op signin [--account A]      answered here: the daemon unlocks on the first approved read
//   op whoami [--account A]      the daemon's answer
//
// Anything else runs the real op, unchanged (Touch ID as before). Plain JS so it starts fast.

import { spawn, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Item, vault, field, account and ref rules: the same ones the session and daemon check.
import { ACCOUNT, NAME, REF } from "./validate.mjs";

// Split "--flag=value" and pull --account out (it may come anywhere). null for any form we don't take.
export function parse(argv) {
	const args = [];
	let account;
	for (let i = 0; i < argv.length; i++) {
		let a = argv[i];
		let value;
		const eq = a.startsWith("--") ? a.indexOf("=") : -1;
		if (eq > 0) [a, value] = [a.slice(0, eq), a.slice(eq + 1)];
		if (a === "--account") {
			value ??= argv[++i];
			if (typeof value !== "string" || !ACCOUNT.test(value)) return null;
			account = value;
		} else args.push(value === undefined ? a : `${a}=${value}`);
	}
	// OP_ACCOUNT names the account when --account doesn't. One we can't pass on as it is: the real
	// op, never a read from the default account instead.
	if (account === undefined && process.env.OP_ACCOUNT) {
		if (!ACCOUNT.test(process.env.OP_ACCOUNT)) return null;
		account = process.env.OP_ACCOUNT;
	}
	const base = account ? { account } : {};
	const [cmd, ...rest] = args;
	if (cmd === "signin" && rest.length === 0) return { ...base, kind: "signin" };
	if (cmd === "whoami" && rest.length === 0) return { ...base, kind: "whoami" };
	if (cmd === "read") {
		const ref = rest.filter((a) => a !== "-n" && a !== "--no-newline");
		if (ref.length !== 1 || !REF.test(ref[0])) return null;
		return { ...base, kind: "read", ref: ref[0], newline: rest.length === 1 };
	}
	if (cmd === "item" && rest[0] === "get") return itemGet(rest.slice(1), base);
	return null;
}

function itemGet(rest, base) {
	let item, vault, fields, otp = false, reveal = false;
	for (let i = 0; i < rest.length; i++) {
		let a = rest[i];
		let value;
		const eq = a.startsWith("--") ? a.indexOf("=") : -1;
		if (eq > 0) [a, value] = [a.slice(0, eq), a.slice(eq + 1)];
		if (a === "--vault") vault = value ?? rest[++i];
		else if (a === "--fields") fields = value ?? rest[++i];
		else if (a === "--otp" && value === undefined) otp = true;
		else if (a === "--reveal" && value === undefined) reveal = true;
		else if (!a.startsWith("-") && item === undefined && value === undefined) item = a;
		else return null; // --format, --share-link and the rest: the real op
	}
	if (typeof item !== "string" || !NAME.test(item)) return null;
	if (vault !== undefined && (typeof vault !== "string" || !NAME.test(vault))) return null;
	const v = vault === undefined ? {} : { vault };
	if (otp && fields === undefined && !reveal) return { ...base, ...v, kind: "otp", item };
	if (!otp && reveal && typeof fields === "string") {
		const list = fields.split(",").map((f) => f.trim());
		if (list.length > 10 || list.some((f) => !NAME.test(f))) return null;
		return { ...base, ...v, kind: "fields", item, fields: list };
	}
	return null;
}

// The command this read is for (the bash tool's line), shown on the card. Best effort.
function parentCommand() {
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 2000 }).trim().slice(0, 300);
	} catch {
		return "";
	}
}

const real = (p) => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

// The real op: this folder off PATH (compared by real path, so a symlinked install can't find
// itself), same arguments, same stdio, same exit. PI_OP_BROKER_PASSTHRU stops a loop for good.
function realOp(argv) {
	if (process.env.PI_OP_BROKER_PASSTHRU) {
		process.stderr.write("op: op-broker's shim found itself instead of the real op; check PATH\n");
		return process.exit(127);
	}
	const here = real(dirname(fileURLToPath(import.meta.url)));
	const PATH = (process.env.PATH ?? "").split(delimiter).filter((p) => p && real(p) !== here).join(delimiter);
	const child = spawn("op", argv, { stdio: "inherit", env: { ...process.env, PATH, PI_OP_BROKER_PASSTHRU: "1" } });
	child.on("error", (e) => {
		process.stderr.write(`op: ${e.code === "ENOENT" ? "1Password CLI (op) isn't installed" : e.message}\n`);
		process.exit(127);
	});
	child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
}

const WAIT_MS = 15 * 60_000; // cards queue one at a time (5 minutes each) plus a Touch ID; the bash tool's own timeout usually ends it first

// One reply, settled once: whichever of reply, error, hang-up or timeout comes first; the timer is
// cleared with it. null means nothing is listening.
export function ask(sock, request, waitMs = WAIT_MS) {
	return new Promise((resolve) => {
		const conn = createConnection(sock);
		let settled = false;
		const done = (v) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			conn.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => done({ ok: false, error: "op-broker: no answer in time" }), waitMs);
		let buf = "";
		conn.setEncoding("utf8");
		conn.on("connect", () => conn.write(`${JSON.stringify({ v: 1, ...request })}\n`));
		conn.on("data", (d) => {
			buf += d;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			let reply;
			try {
				reply = JSON.parse(buf.slice(0, nl));
			} catch {
				reply = { ok: false, error: "op-broker: a bad reply" };
			}
			done(reply);
		});
		conn.on("error", () => done(null));
		conn.on("close", () => done({ ok: false, error: "op-broker: the session went away" }));
	});
}

async function main() {
	const argv = process.argv.slice(2);
	const req = parse(argv);
	const sock = process.env.PI_OP_BROKER_SOCK;
	// A caller signed in some other way (service account, Connect, a manual session) keeps it.
	const ownAuth = process.env.OP_SERVICE_ACCOUNT_TOKEN || process.env.OP_CONNECT_HOST || Object.keys(process.env).some((k) => k.startsWith("OP_SESSION_"));
	if (!req || !sock || ownAuth) return realOp(argv);
	if (req.kind === "signin") return process.exit(0);
	const reply = await ask(sock, { ...req, command: parentCommand() });
	if (reply === null) return realOp(argv); // no extension listening (the session reloaded without it)
	if (!reply.ok) {
		process.stderr.write(`[ERROR] ${reply.error ?? "op-broker: not approved"}\n`);
		return process.exit(1);
	}
	if (typeof reply.value !== "string") {
		process.stderr.write("[ERROR] op-broker: a reply with no value\n");
		return process.exit(1);
	}
	process.stdout.write(req.kind === "read" && !req.newline ? reply.value : `${reply.value}\n`);
	process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
