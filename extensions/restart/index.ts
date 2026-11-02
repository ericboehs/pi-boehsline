/**
 * restart: lets bin/pi-restart-all restart every pi in tmux and resume it where it was.
 *
 * Each interactive session keeps a small record in ~/.local/state/pi-restart/live/<pid>.json
 * (0600): its session file, cwd, tmux pane and socket, whether the approval guardian is
 * bypassed, and whether it is idle. SIGUSR2 asks pi to shut down; ctx.shutdown() waits until
 * the agent is idle, so a running turn finishes first. The script then starts
 * `pi --session <file>` in the same pane and, if the guardian was bypassed, types
 * `/approval-guardian bypass` into the new pi: the guardian's own command, never a flag or a
 * file that could start pi bypassed.
 */

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** approval-guardian's state event (packages/approval-guardian): { active: boolean }. */
const GUARDIAN_BYPASS_STATE_EVENT = "approval-guardian:temporary-bypass-state";
/** approval-guardian's process slot ({ sessionFile }) while this process is bypassed. */
const GUARDIAN_BYPASS_SLOT = Symbol.for("pi-approval-guardian.temporary-bypass");

/** Whether the guardian is bypassed for this session file (its process slot names it). */
export function guardianBypassed(sessionFile: string | undefined, global: object = globalThis): boolean {
	const value = Reflect.get(global, GUARDIAN_BYPASS_SLOT);
	return !!sessionFile && !!value && typeof value === "object" && (value as { sessionFile?: unknown }).sessionFile === sessionFile;
}

export const liveDir = (env: NodeJS.ProcessEnv = process.env): string =>
	join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-restart", "live");

export type LiveRecord = {
	pid: number;
	sessionFile: string;
	cwd: string;
	pane: string;
	/** The tmux server socket ($TMUX's first field), so the script talks to the right server. */
	socket: string;
	bypass: boolean;
	idle: boolean;
	/** Written by session_shutdown: the state pi left with (the script reads bypass from it). */
	exiting?: boolean;
	at: string;
};

/**
 * SIGUSR2 is handled once per process (Symbol.for survives /reload's re-import): between one
 * runtime's shutdown and the next one's start there is no ctx, and the default action would
 * kill pi on the spot. A signal then is kept and acted on at the next session_start.
 */
type SignalSlot = { shutdown?: () => void; pending: boolean; installed: boolean };
const SIGNAL_SLOT = Symbol.for("pi-boehsline.restart.signal");
export function signalSlot(global: object = globalThis): SignalSlot {
	let slot = Reflect.get(global, SIGNAL_SLOT) as SignalSlot | undefined;
	if (!slot) {
		slot = { pending: false, installed: false };
		Reflect.set(global, SIGNAL_SLOT, slot);
	}
	return slot;
}
export function onRestartSignal(slot: SignalSlot): void {
	if (slot.shutdown) slot.shutdown();
	else slot.pending = true;
}

export function liveRecord(o: {
	pid: number;
	sessionFile: string | undefined;
	cwd: string;
	env: NodeJS.ProcessEnv;
	bypass: boolean;
	idle: boolean;
	now?: Date;
}): LiveRecord | null {
	const pane = o.env.TMUX_PANE ?? "";
	const socket = (o.env.TMUX ?? "").split(",")[0] ?? "";
	// Only a pi in a tmux pane with a session file can be restarted and resumed.
	if (!o.sessionFile || !/^%\d+$/.test(pane) || !socket) return null;
	return {
		pid: o.pid,
		sessionFile: o.sessionFile,
		cwd: o.cwd,
		pane,
		socket,
		bypass: o.bypass,
		idle: o.idle,
		at: (o.now ?? new Date()).toISOString(),
	};
}

export default function restart(pi: ExtensionAPI) {
	const file = join(liveDir(), `${process.pid}.json`);
	let ctx: ExtensionContext | undefined;
	let idle = true;
	// The bypass as last seen while running: on a real exit the guardian may clear its slot in its
	// own session_shutdown before this one runs (package order), so the exiting record keeps this.
	let lastBypass = false;

	const write = (exiting = false) => {
		if (!ctx || ctx.mode !== "tui") return;
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		const record = liveRecord({
			pid: process.pid,
			sessionFile,
			cwd: ctx.cwd,
			env: process.env,
			bypass: exiting ? lastBypass || guardianBypassed(sessionFile) : (lastBypass = guardianBypassed(sessionFile)),
			idle,
		});
		if (record && exiting) record.exiting = true;
		try {
			if (!record) {
				unlinkSync(file);
				return;
			}
			mkdirSync(liveDir(), { recursive: true, mode: 0o700 });
			chmodSync(liveDir(), 0o700);
			const tmp = `${file}.tmp`;
			try {
				unlinkSync(tmp); // never write through something planted there
			} catch {
				// none
			}
			writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
			renameSync(tmp, file);
		} catch {
			// best effort: a missing record only means pi-restart-all skips this session
		}
	};
	const slot = signalSlot();
	if (!slot.installed) {
		slot.installed = true;
		process.on("SIGUSR2", () => onRestartSignal(slot));
	}

	// The slot is set before the event; the event only says when to look again.
	pi.events?.on(GUARDIAN_BYPASS_STATE_EVENT, () => write());
	pi.on("session_start", (_event, c) => {
		ctx = c;
		idle = true;
		lastBypass = false;
		slot.shutdown = () => c.shutdown();
		write();
		// The guardian may clear its slot in its own session_start, after this one (/resume of
		// the same file): look again once every handler ran.
		setTimeout(() => write(), 0);
		if (slot.pending) {
			slot.pending = false;
			setTimeout(() => c.shutdown(), 0); // after every extension's session_start
		}
	});
	pi.on("agent_start", () => {
		idle = false;
		write();
	});
	pi.on("agent_end", () => {
		idle = true;
		write();
	});
	pi.on("session_shutdown", () => {
		slot.shutdown = undefined;
		// The state pi leaves with: pi-restart-all reads bypass from it after the pid is gone
		// (and removes it); /reload's next session_start writes over it.
		write(true);
		ctx = undefined;
	});
}
