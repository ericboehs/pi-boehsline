/**
 * One cursor-agent run, shared by the foreground tool and background jobs
 * (runner.ts): argument checks, the CLI args, the spawn and stream-json
 * reduction, the worktree's state afterwards and the cost lookup.
 *
 * Pure node (no pi imports): runner.ts runs this under plain `node` as a bg job.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { findUsageEvent, type UsageEvent } from "./api.ts";
import { RunReducer, type RunState } from "./events.ts";
import { blockedBy, type CursorSettings } from "./settings.ts";
import { git } from "./worktrees.ts";

export interface CursorArgs {
	prompt: string;
	model?: string;
	mode?: string;
	cwd?: string;
	network?: boolean;
	worktree?: boolean;
	worktreeBase?: string;
}

/** Everything a run needs, JSON-safe so a background job can take it from a file. */
export interface RunSpec {
	model: string;
	cwd: string;
	cliArgs: string[];
	worktree: boolean;
	/** The cursor-agent binary: PI_CURSOR_AGENT_BIN, else `cursor-agent` on PATH. */
	bin: string;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	/** `git status --short` lines: what Cursor changed, left uncommitted for review. */
	changed: string[];
}

export interface RunOutcome {
	state: RunState;
	exitCode: number | null;
	durationMs: number;
	started: number;
	stderr?: string;
	worktree?: WorktreeInfo;
}

/** Check the call and build cursor-agent's arguments. Throws on a blocked model or a bad cwd. */
export async function prepareRun(args: CursorArgs, sessionCwd: string, settings: CursorSettings): Promise<RunSpec> {
	const model = args.model?.trim() || settings.defaultModel;
	const blocked = blockedBy(model, settings);
	if (blocked) throw new Error(`${model} is blocked (matches "${blocked}"): ${settings.blockedReason}`);
	const cwd = resolve(sessionCwd, (args.cwd ?? ".").replace(/^@/, "").replace(/^~(?=$|\/)/, homedir()));
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
	if (args.worktree) {
		await git(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => {
			throw new Error(`worktree needs a git repo with at least one commit: ${cwd}`);
		});
	}

	const cliArgs = ["-p", "--trust", "--output-format", "stream-json", "--stream-partial-output"];
	cliArgs.push("--sandbox", args.network ? "disabled" : "enabled", "--model", model);
	if (args.mode && args.mode !== "agent") cliArgs.push("--mode", args.mode);
	if (args.worktree) {
		// --worktree takes an optional name, so without one it would swallow the prompt.
		cliArgs.push("--worktree", `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
		if (args.worktreeBase) cliArgs.push("--worktree-base", args.worktreeBase);
	}
	cliArgs.push(args.prompt);
	return { model, cwd, cliArgs, worktree: !!args.worktree, bin: process.env.PI_CURSOR_AGENT_BIN?.trim() || "cursor-agent" };
}

/** Whether `bin` (a RunSpec's) is an executable file: the path as given, else a file on PATH. */
export function binFound(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const executable = (p: string) => {
		try {
			accessSync(p, constants.X_OK);
			return statSync(p).isFile();
		} catch {
			return false;
		}
	};
	if (bin.includes("/")) return executable(bin);
	return (env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && executable(join(dir, bin)));
}

/** The last `maxLines` lines and `maxBytes` bytes of stderr. */
export function stderrTail(text: string, maxLines = 40, maxBytes = 4_000): string {
	let out = text.split("\n").slice(-maxLines).join("\n");
	if (Buffer.byteLength(out) > maxBytes) out = `…${Buffer.from(out).subarray(-maxBytes).toString("utf8")}`;
	return out.trim();
}

/**
 * Run cursor-agent to completion. `onEvent` gets the reducer after each stdout
 * chunk (`changed` when a tool step started or finished). Aborting `signal`
 * stops the process (SIGTERM, then SIGKILL after 3s).
 */
export async function runCursor(
	spec: RunSpec,
	opts: { signal?: AbortSignal; onEvent?: (run: RunReducer, changed: boolean) => void } = {},
): Promise<RunOutcome> {
	const { signal, onEvent } = opts;
	const run = new RunReducer(spec.cwd);
	const started = Date.now();
	const stderr: string[] = [];
	const exitCode = await new Promise<number | null>((done, fail) => {
		const proc = spawn(spec.bin, spec.cliArgs, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"] });
		proc.stdout.on("data", (chunk: Buffer) => onEvent?.(run, run.feed(chunk.toString())));
		proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
		proc.on("error", (err: NodeJS.ErrnoException) =>
			fail(err.code === "ENOENT" ? new Error(`${spec.bin} not found; install it from https://cursor.com/cli`) : err),
		);
		proc.on("close", (code) => {
			onEvent?.(run, run.feed("\n"));
			done(code);
		});
		const kill = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}, 3_000).unref();
		};
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });
	});

	const out: RunOutcome = {
		state: { ...run.state, tools: [...run.state.tools] },
		exitCode,
		durationMs: run.state.durationMs ?? Date.now() - started,
		started,
	};
	if (stderr.length) out.stderr = stderrTail(stderr.join(""));
	const ws = out.state.workspace;
	if (spec.worktree && ws && ws !== spec.cwd) {
		const [branch, status] = await Promise.all([
			git(ws, ["branch", "--show-current"]).catch(() => ""),
			git(ws, ["status", "--short"]).catch(() => ""),
		]);
		out.worktree = { path: ws, branch: branch.trim(), changed: status.split("\n").filter(Boolean) };
	}
	return out;
}

export type ChargeLookup = (sessionId: string, sinceMs: number, signal?: AbortSignal) => Promise<UsageEvent | undefined>;

/** The run's server-side charge, or why it couldn't be found. */
export async function lookupCharge(
	sessionId: string | undefined,
	started: number,
	signal?: AbortSignal,
	find: ChargeLookup = findUsageEvent,
): Promise<{ charge?: UsageEvent; chargeError?: string }> {
	if (!sessionId) return {};
	try {
		const charge = await find(sessionId, started, signal);
		return charge ? { charge } : { chargeError: "no usage event yet" };
	} catch (err) {
		return { chargeError: (err as Error).message };
	}
}

/** "42s", "3m07s", "1h02m". */
export function humanDuration(ms: number): string {
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	if (m < 60) return `${m}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
