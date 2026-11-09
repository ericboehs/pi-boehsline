/**
 * Botsun's side of the `computer` tool: the `desk session` CLI, the JSON line it
 * prints, the socket-path check, and the keep-alive that stops a desk looking
 * idle (Botsun stops one after 30 minutes unused, and a phone's viewer plus this
 * tool's own asks are what move its last-used time).
 *
 * Pure node, no pi imports: tests run it (and inject the CLI runner and timers)
 * under plain `node --test`.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/** One CLI call at most (Botsun's own lease work is the slow part). */
export const CLI_TIMEOUT_MS = 120_000;
/** How often the desk must be touched while in use (Botsun's idle rule is 2 minutes). */
export const KEEPALIVE_MS = 90_000;

/** `desk session`'s one JSON line. `--release` answers {desk_id, display, released} instead. */
export interface DeskLine {
	desk_id?: string;
	display?: number | string;
	vnc_socket?: string;
	cdp_socket?: string;
	released?: boolean;
}

/** Runs the Botsun CLI: its stdout, or a one-line rejection. Injected in tests. */
export type DeskRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

/** The last non-empty line of stdout, parsed as JSON; null when that isn't a JSON object. */
export function parseDeskOutput(stdout: string): DeskLine | null {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines.at(-1);
	if (!last || !last.startsWith("{")) return null;
	try {
		const value: unknown = JSON.parse(last);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as DeskLine) : null;
	} catch {
		return null;
	}
}

/**
 * A CDP socket this tool may connect to: absolute, under the user's home, and
 * named like Botsun's tunnels (`desk-<vm>-<display>.cdp.sock`). Anything else
 * would let a bad CLI answer point the tool at an arbitrary path.
 */
export function validCdpSocket(value: unknown, home: string = homedir()): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	if (!isAbsolute(value)) return null;
	const sock = resolve(value);
	const base = resolve(home);
	if (sock !== base && !sock.startsWith(base + sep)) return null;
	if (!sock.endsWith(".cdp.sock")) return null;
	return sock;
}

/** A CLI error as one line: the last thing the CLI said, or execFile's message. */
function oneLine(err: unknown): string {
	const e = err as { stderr?: string | Buffer; message?: string };
	const said = String(e?.stderr ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	const text = said || e?.message || "the Botsun CLI failed";
	return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** The real CLI: no shell, a timeout, and stdout's full JSON line. */
export const runCli: DeskRunner = (cmd, args, timeoutMs) =>
	new Promise((ok, fail) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
			if (err) fail(new Error(oneLine(err)));
			else ok(String(stdout ?? ""));
		});
	});

export interface DeskDeps {
	/** Where the Botsun CLI is. */
	bin: string;
	run?: DeskRunner;
	timeoutMs?: number;
	/** The home a cdp_socket must sit under (tests); default os.homedir(). */
	home?: string;
}

export interface DeskSession {
	bin: string;
	sessionId: string;
	deskId?: string;
	display?: string;
	cdpSocket: string;
}

export type OpenResult = { desk: DeskSession } | { error: string };

/** `desk session --session ID`: lease (or reuse) the session's desktop and read its JSON line. */
export async function openDesk(sessionId: string, deps: DeskDeps): Promise<OpenResult> {
	const args = ["desk", "session", "--session", sessionId];
	let stdout: string;
	try {
		stdout = await (deps.run ?? runCli)(deps.bin, args, deps.timeoutMs ?? CLI_TIMEOUT_MS);
	} catch (err) {
		return { error: `computer: Botsun could not open the desk: ${(err as Error).message}` };
	}
	const line = parseDeskOutput(stdout);
	if (!line) return { error: "computer: Botsun's desk session printed no JSON line." };
	const cdpSocket = validCdpSocket(line.cdp_socket, deps.home);
	if (!cdpSocket) return { error: "computer: Botsun's desk session gave no usable cdp_socket." };
	const display = line.display === undefined || line.display === null ? undefined : String(line.display);
	return {
		desk: {
			bin: deps.bin,
			sessionId,
			...(typeof line.desk_id === "string" && line.desk_id ? { deskId: line.desk_id } : {}),
			...(display ? { display } : {}),
			cdpSocket,
		},
	};
}

/** `desk session --session ID --release`: stop the desk (its Chromium profile stays). */
export async function releaseDesk(sessionId: string, deps: DeskDeps): Promise<{ ok: true } | { error: string }> {
	try {
		const stdout = await (deps.run ?? runCli)(deps.bin, ["desk", "session", "--session", sessionId, "--release"], deps.timeoutMs ?? CLI_TIMEOUT_MS);
		if (!parseDeskOutput(stdout)) return { error: "computer: Botsun's release printed no JSON line." };
		return { ok: true };
	} catch (err) {
		return { error: `computer: Botsun could not release the desk: ${(err as Error).message}` };
	}
}

/** The timer functions the keep-alive uses; tests pass fakes. */
export interface TimerFns {
	set: (fn: () => void, ms: number) => { unref?: () => void };
	clear: (handle: unknown) => void;
}

export interface KeepAliveOptions {
	intervalMs?: number;
	timers?: TimerFns;
}

/**
 * Re-asks `desk session --session ID` every 90 s while the desk is in use, so
 * Botsun keeps seeing an active session. An unref'd timer: it never holds pi
 * open. A failed ask is ignored (the next one may work; the tool's own calls
 * still lease).
 */
export class KeepAlive {
	private readonly tick: () => void;
	private readonly intervalMs: number;
	private readonly timers: TimerFns;
	private handle: { unref?: () => void } | undefined;

	constructor(tick: () => void, options: KeepAliveOptions = {}) {
		this.tick = tick;
		this.intervalMs = options.intervalMs ?? KEEPALIVE_MS;
		this.timers = options.timers ?? {
			set: (fn, ms) => setInterval(fn, ms),
			clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
		};
	}

	get running(): boolean {
		return this.handle !== undefined;
	}

	start(): void {
		if (this.handle) return;
		this.handle = this.timers.set(() => this.tick(), this.intervalMs);
		this.handle.unref?.();
	}

	stop(): void {
		if (!this.handle) return;
		this.timers.clear(this.handle);
		this.handle = undefined;
	}
}
