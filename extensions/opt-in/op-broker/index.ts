/**
 * op-broker: agents read 1Password through an approval card in the session, and every session
 * shares one 1Password CLI authorization (one Touch ID per 12 hours, not one per command).
 *
 * - The `op` shim (this folder) goes first on PATH for everything pi runs, so the bash tool's
 *   `op read …`, `op item get … --otp` and `op item get … --fields … --reveal` come here over
 *   this session's socket ($PI_OP_BROKER_SOCK). Every other op command is the real op.
 * - This session shows the card (Allow once / 1 hour / 8 hours / Deny) and keeps the grants.
 * - The daemon (daemon.mjs, one per user, inside a pseudo-terminal of its own) runs the read.
 *
 * Interactive TUI sessions only: a card needs someone at the keyboard.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { optIn } from "../../../lib/opt-in.ts";
import { offerPrompt } from "../../../lib/remote-prompts.ts";
import { Broker, CHOICES, type Decision, type OpRequest, type Reply } from "./broker.ts";
import { brokerDir, validRequest } from "./validate.mjs";

export { brokerDir };

// The real path: the shim compares PATH entries by real path, so a symlinked install can't loop.
const HERE = realpathSync(dirname(fileURLToPath(import.meta.url)));
const CARD_MS = 5 * 60_000; // an unanswered card is a deny
const MAX_LINE = 16 * 1024;
const KINDS = new Set(["read", "otp", "fields", "whoami"]);
// The daemon gives op OP_TIMEOUT_MS (90 s, daemon.mjs) before killing it; waiting 10 s more lets
// its own "op failed" reply arrive rather than a vaguer "didn't answer". Keep the two in step.
export const OP_TIMEOUT_MS = 90_000;
export const DAEMON_REPLY_MS = OP_TIMEOUT_MS + 10_000;

/** One request to the daemon's socket, one reply; null if nothing is listening. */
export function daemonRequest(sock: string, request: object, timeoutMs = DAEMON_REPLY_MS): Promise<Reply & Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const conn = createConnection(sock);
		let buf = "";
		let settled = false;
		const done = (v: (Reply & Record<string, unknown>) | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			conn.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => done({ ok: false, error: "op-broker: the daemon didn't answer" }), timeoutMs);
		conn.setEncoding("utf8");
		conn.on("connect", () => conn.write(`${JSON.stringify(request)}\n`));
		conn.on("data", (d: string) => {
			buf += d;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				done(JSON.parse(buf.slice(0, nl)));
			} catch {
				done({ ok: false, error: "op-broker: a bad reply from the daemon" });
			}
		});
		conn.on("error", () => done(null));
		conn.on("close", () => done({ ok: false, error: "op-broker: the daemon hung up" }));
	});
}

/** Start the daemon inside a pseudo-terminal of its own, so one Touch ID covers every op it runs. */
function startDaemon(dir: string): void {
	const env: NodeJS.ProcessEnv = { ...process.env, PI_OP_BROKER_DIR: dir, PI_OP_BROKER_SHIM_DIR: HERE };
	delete env.PI_OP_BROKER_SOCK;
	env.PATH = (env.PATH ?? "").split(delimiter).filter((p) => p && p !== HERE).join(delimiter);
	const daemon = join(HERE, "daemon.mjs");
	if (platform() !== "darwin") env.SHELL = "/bin/sh"; // util-linux script runs -c through $SHELL
	const args = platform() === "darwin"
		? ["-q", "/dev/null", process.execPath, daemon]
		: ["-q", "-c", `'${process.execPath.replace(/'/g, "'\\''")}' '${daemon.replace(/'/g, "'\\''")}'`, "/dev/null"];
	const child = spawn(env.PI_OP_BROKER_SCRIPT || "script", args, { detached: true, stdio: "ignore", env });
	child.on("error", () => {});
	child.unref();
}

/** The daemon's status, starting it first if nothing answers; null if it won't start. */
async function ensureDaemon(dir: string): Promise<(Reply & Record<string, unknown>) | null> {
	const sock = join(dir, "daemon.sock");
	const status = await daemonRequest(sock, { cmd: "status" }, 3000);
	if (status) return status;
	startDaemon(dir);
	for (let i = 0; i < 50; i++) {
		await new Promise((r) => setTimeout(r, 100));
		const started = await daemonRequest(sock, { cmd: "status" }, 3000);
		if (started) return started;
	}
	return null;
}

/**
 * A request from the shim, checked by the shim's and daemon's own rules (validate.mjs); null if it
 * isn't one. Any process running as this user can reach the session's socket, not only the shim,
 * so nothing reaches a card (newlines, bidi, a leading "-") that the shim wouldn't have sent.
 */
export function cleanRequest(msg: unknown): OpRequest | null {
	if (!msg || typeof msg !== "object") return null;
	const m = msg as Record<string, unknown>;
	if (m.v !== 1 || typeof m.kind !== "string" || !KINDS.has(m.kind)) return null;
	const req: OpRequest = { kind: m.kind as OpRequest["kind"] };
	for (const k of ["ref", "item", "vault", "account"] as const) {
		const v = m[k];
		if (v === undefined) continue;
		if (typeof v !== "string") return null;
		req[k] = v;
	}
	if (m.fields !== undefined) {
		if (!Array.isArray(m.fields)) return null;
		req.fields = m.fields as string[];
	}
	if (!validRequest(req)) return null;
	if (typeof m.command === "string") req.command = m.command.slice(0, 2000); // the card flattens and trims it (broker.ts)
	return req;
}

export default optIn("op-broker", "1Password reads for agents: an approval card per item, one shared Touch ID", (pi: ExtensionAPI) => {
	const dir = brokerDir();
	const daemonSock = join(dir, "daemon.sock");
	let ctxRef: ExtensionContext | undefined;
	let server: Server | undefined;
	let sockPath: string | undefined;
	const openCards = new Set<AbortController>(); // closed with the session
	// This session: a connection belongs to the session it arrived in, and once that session ends
	// (/new, /resume, /fork) its requests are refused, never carded in the next one.
	let session = { closed: true };

	// The card is also offered as a remote prompt, so botsun-owner can put it on the phone, where
	// the answer is signed by the device and checked again here. Whichever answers first wins and
	// the other closes; free text (no pick) is a deny.
	const ask = async (title: string): Promise<Decision | undefined> => {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return undefined;
		const labels = CHOICES.map(([label]) => label);
		const ctl = new AbortController();
		openCards.add(ctl);
		const timer = setTimeout(() => ctl.abort(), CARD_MS);
		// Sensitive: it guards a secret, so a device-signed tap or the keyboard answers it, never voice.
		const remote = offerPrompt([{ question: title, options: labels.map((label) => ({ label })) }], { sensitive: true });
		const closed = new Promise<undefined>((r) => ctl.signal.addEventListener("abort", () => r(undefined), { once: true }));
		try {
			return await Promise.race([
				closed, // timed out, or the session ended: a deny
				ctx.ui.select(title, labels, { signal: ctl.signal }).then((pick) => CHOICES.find(([label]) => label === pick)?.[1]),
				remote.answered.then((answers) => {
					const pick = answers[0]?.picks[0];
					return pick === undefined ? "deny" : CHOICES[pick]?.[1];
				}),
			]);
		} finally {
			ctl.abort(); // closes the TUI card if the phone answered
			openCards.delete(ctl);
			clearTimeout(timer);
			remote.dispose();
		}
	};

	const daemon = async (req: OpRequest): Promise<Reply> => {
		// One status round trip: it finds (or starts) the daemon and says whether this read will
		// need the Touch ID, so the notice shows only then.
		const status = await ensureDaemon(dir);
		if (!status) return { ok: false, error: `op-broker: couldn't start its daemon (see ${join(dir, "daemon.log")})` };
		const armed = Array.isArray(status.armed) && (status.armed as string[]).includes(req.account ?? "");
		if (req.kind !== "whoami" && !armed) ctxRef?.ui.notify("1Password: approve Touch ID on the Mac to unlock op-broker (once, for up to 12 hours)", "info");
		const { command: _command, ...rest } = req;
		return (await daemonRequest(daemonSock, { cmd: "op", ...rest })) ?? { ok: false, error: "op-broker: the daemon went away" };
	};

	const broker = new Broker({ ask, daemon });

	// One request per connection, in the session it connected in; anything after the first line is ignored.
	function serve(conn: Socket) {
		const mine = session;
		let buf = "";
		let done = false;
		conn.setEncoding("utf8");
		conn.on("data", async (d: string) => {
			if (done) return;
			buf += d;
			if (buf.length > MAX_LINE) return conn.destroy();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			done = true;
			if (mine.closed) return void conn.end(`${JSON.stringify({ ok: false, error: "op-broker: that session ended" })}\n`);
			let msg: unknown;
			try {
				msg = JSON.parse(buf.slice(0, nl));
			} catch {}
			buf = "";
			const req = cleanRequest(msg);
			const reply = req ? await broker.handle(req).catch((e) => ({ ok: false, error: String(e?.message ?? e) })) : { ok: false, error: "op-broker: a bad request" };
			if (!conn.destroyed) conn.end(`${JSON.stringify(reply)}\n`);
		});
		conn.on("error", () => {});
	}

	function listen() {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		sockPath = join(dir, `s-${process.pid}.sock`);
		if (existsSync(sockPath) && lstatSync(sockPath).isSocket()) unlinkSync(sockPath);
		server = createServer(serve);
		server.listen(sockPath, () => {
			if (sockPath) chmodSync(sockPath, 0o600); // the folder is 0700 already
		});
		server.on("error", (e) => ctxRef?.ui.notify(`op-broker: ${e.message}`, "error"));
		// Everything pi runs from here on finds the shim first and this session's socket.
		const path = (process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== HERE);
		process.env.PATH = [HERE, ...path].join(delimiter);
		process.env.PI_OP_BROKER_SOCK = sockPath;
		process.env.PI_OP_BROKER_NODE = process.execPath;
		delete process.env.PI_OP_BROKER_PASSTHRU; // a pi started under the real op (op run -- pi) starts fresh
	}

	function close() {
		session.closed = true;
		broker.revoke(); // grants belong to this session: not to the next one after /new, /resume or /fork
		for (const ctl of openCards) ctl.abort(); // and its open cards close, on the phone too
		server?.close();
		server = undefined;
		if (sockPath && existsSync(sockPath)) {
			try {
				unlinkSync(sockPath);
			} catch {}
		}
		process.env.PATH = (process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== HERE).join(delimiter);
		delete process.env.PI_OP_BROKER_SOCK;
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctxRef = ctx;
		if (session.closed) session = { closed: false };
		if (!server) listen();
	});

	pi.on("session_shutdown", () => {
		close();
		ctxRef = undefined;
	});

	pi.registerCommand("op-broker", {
		description: "1Password broker: status, revoke (this session's grants), stop (the daemon)",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "revoke") {
				ctx.ui.notify(`op-broker: revoked ${broker.revoke()} grant(s) in this session`, "info");
			} else if (sub === "stop") {
				const r = await daemonRequest(daemonSock, { cmd: "stop" }, 3000);
				ctx.ui.notify(r ? "op-broker: daemon stopped (1Password access dropped)" : "op-broker: no daemon running", "info");
			} else {
				const status = await daemonRequest(daemonSock, { cmd: "status" }, 3000);
				const armed = Array.isArray(status?.armed) ? (status.armed as string[]) : [];
				const lines = [
					status ? `daemon: running, ${armed.length ? `unlocked for ${armed.map((a) => a || "default account").join(", ")}` : "not unlocked yet"}` : "daemon: not running",
					...broker.list().map(([k, ms]) => `grant: ${(JSON.parse(k) as Array<string | null>).filter(Boolean).join(" / ")} · ${Math.ceil(ms / 60_000)} min left`),
				];
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});
});
