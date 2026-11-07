/**
 * cd: /cd <dir> continues this conversation in another directory, like a shell cd.
 *
 * It forks the session file into the target directory (`SessionManager.forkFrom`), leaving the
 * source session where it is, then lets bin/pi-restart-all relaunch this pi in the same tmux pane
 * on the new session. The restart extension's live record is the proof that this pi is in tmux and
 * that pi-restart-all can find the pane; the script sends SIGUSR2, this pi shuts down once idle,
 * and the new pi starts in the target directory with the guardian's bypass restored as usual.
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { liveDir } from "../restart/index.ts";

/** This package's restart script: botsun-owner's Restart runs the same file the same way. */
export const RESTART_ALL = fileURLToPath(new URL("../../bin/pi-restart-all", import.meta.url));

/** The parts of the restart extension's live record /cd needs. */
export type RestartRecord = {
	pid?: number;
	pane: string;
	socket: string;
	exiting?: boolean;
};

/** A forked session (SessionManager.forkFrom's result). */
export type ForkedSession = {
	getSessionFile?: () => string | undefined;
	getSessionId?: () => string | undefined;
};

/** The command's outside world, so tests can mount it without a real pi or a real script. */
export type CdDeps = {
	env: NodeJS.ProcessEnv;
	pid: number;
	forkFrom: (sourcePath: string, targetCwd: string) => ForkedSession;
	spawnRestart: (args: string[]) => void;
};

export type CdContext = Pick<ExtensionCommandContext, "cwd" | "sessionManager" | "ui" | "waitForIdle">;

/** `~` and `~/…` expand; anything relative resolves against the session's cwd. */
export function resolveTarget(input: string, cwd: string, home: string = homedir()): string {
	const expanded = /^~(?=$|\/)/.test(input) ? home + input.slice(1) : input;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Whether two existing paths name the same directory, symlinks included. */
export function sameDirectory(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
}

/** The restart extension's live record for this pid, or null when this pi isn't restartable. */
export function restartRecord(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): RestartRecord | null {
	const pane = env.TMUX_PANE ?? "";
	const socket = (env.TMUX ?? "").split(",")[0] ?? "";
	if (!/^%\d+$/.test(pane) || !socket) return null;
	try {
		const record = JSON.parse(readFileSync(join(liveDir(env), `${pid}.json`), "utf8")) as RestartRecord;
		if (record?.pid !== pid || record.pane !== pane || record.socket !== socket || record.exiting === true) return null;
		return record;
	} catch {
		return null;
	}
}

/** A session id's short form for the notice: the first eight characters. */
export function shortSessionId(id: string | undefined): string {
	return id?.trim().slice(0, 8) || "?";
}

/**
 * `pi-restart-all --only <pane> …`, detached and handed to the tmux server like botsun-owner's
 * Restart: it outlives this pi, which the script then asks to stop with SIGUSR2.
 */
export function spawnRestartAll(args: string[]): void {
	const child = spawn(RESTART_ALL, args, { detached: true, stdio: "ignore" });
	child.on("error", () => {}); // a spawn failure leaves this pi running; the notice names the session to resume
	child.unref();
}

const defaultDeps: CdDeps = {
	env: process.env,
	pid: process.pid,
	forkFrom: (sourcePath, targetCwd) => SessionManager.forkFrom(sourcePath, targetCwd),
	spawnRestart: spawnRestartAll,
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The command itself: resolve, check, fork, notify, relaunch. */
export async function runCd(rawArgs: string, ctx: CdContext, deps: CdDeps = defaultDeps): Promise<void> {
	let arg = rawArgs.trim();
	// /cd "/a b" or '/a b': one pair of matching outer quotes is not part of the path.
	if (arg.length >= 2 && (arg[0] === '"' || arg[0] === "'") && arg.at(-1) === arg[0]) arg = arg.slice(1, -1);
	if (!arg) {
		ctx.ui.notify("Usage: /cd <dir>", "info");
		return;
	}

	const target = resolveTarget(arg, ctx.cwd);
	let targetStat;
	try {
		targetStat = statSync(target);
	} catch {
		ctx.ui.notify(`/cd: no such directory: ${target}`, "error");
		return;
	}
	if (!targetStat.isDirectory()) {
		ctx.ui.notify(`/cd: not a directory: ${target}`, "error");
		return;
	}
	if (sameDirectory(target, ctx.cwd)) {
		ctx.ui.notify(`Already in ${target}`, "info");
		return;
	}

	const record = restartRecord(deps.env, deps.pid);
	if (!record) {
		ctx.ui.notify("/cd needs pi running in tmux", "error");
		return;
	}

	const source = ctx.sessionManager.getSessionFile?.();
	if (!source) {
		ctx.ui.notify("/cd needs a saved session: send a message first", "error");
		return;
	}

	await ctx.waitForIdle();

	let forked: ForkedSession;
	try {
		forked = deps.forkFrom(source, target);
	} catch (error) {
		ctx.ui.notify(`/cd: couldn't continue in ${target}: ${messageOf(error)}`, "error");
		return;
	}
	const sessionFile = forked.getSessionFile?.();
	if (!sessionFile) {
		ctx.ui.notify(`/cd: couldn't continue in ${target}: the fork has no session file`, "error");
		return;
	}

	ctx.ui.notify(`Continuing in ${target} (new session ${shortSessionId(forked.getSessionId?.())}; if pi does not come back, run: pi --session ${sessionFile})`, "info");
	try {
		deps.spawnRestart(["--only", record.pane, "--session", sessionFile, "--cd", target]);
	} catch (error) {
		ctx.ui.notify(`/cd: couldn't restart pi in ${target}: ${messageOf(error)}`, "error");
	}
}

export default function cd(pi: ExtensionAPI, overrides: Partial<CdDeps> = {}): void {
	const deps: CdDeps = { ...defaultDeps, ...overrides };
	pi.registerCommand("cd", {
		description: "Continue this conversation in another directory (/cd <dir>)",
		handler: async (args, ctx) => runCd(args, ctx, deps),
	});
}
