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
import { captureBase, captureChanges, type LargeFile, type RunDiff } from "./diff.ts";
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
	/**
	 * Pass cursor-agent --force: run every command without asking. Print mode can't
	 * approve anything, so without it a command Cursor wants approved (every shell
	 * command once the sandbox is off) is refused. Never implied by `network`.
	 */
	force?: boolean;
}

/** Everything a run needs, JSON-safe so a background job can take it from a file. */
export interface RunSpec {
	model: string;
	cwd: string;
	cliArgs: string[];
	worktree: boolean;
	/** The cursor-agent binary: PI_CURSOR_AGENT_BIN, else `cursor-agent` on PATH. */
	bin: string;
	/** Whether the sandbox is off and --force is on, for messages (the flags themselves are in cliArgs). */
	network?: boolean;
	force?: boolean;
	/** Commit (worktree) or tree (in place) the run's diff is measured from. Recorded before spawn. */
	base?: string;
	baseKind?: "commit" | "tree";
	/** Untracked files too big for the base tree, as they were (unchanged ones are not the run's). */
	baseLarge?: LargeFile[];
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	/** `git status --short` lines: what Cursor changed, left uncommitted for review. */
	changed: string[];
}

export type { RunDiff };

export interface RunOutcome {
	state: RunState;
	exitCode: number | null;
	durationMs: number;
	started: number;
	stderr?: string;
	worktree?: WorktreeInfo;
	/** The run's changes, when it ran in a git repo. Set on success, failure and stop. */
	diff?: RunDiff;
	/** Set when the run was stopped early because Cursor kept refusing its own tools: why, for the caller to show. */
	refused?: string;
}

/** Refused steps before a run is stopped: by then it is spinning, not working. */
export const REFUSAL_LIMIT = 3;

/** For a run that finished with some refused steps (below the stop limit): what happened, and the fix. */
export function refusalNote(state: Pick<RunState, "refusals">, spec: Pick<RunSpec, "network" | "force">): string | undefined {
	if (!state.refusals) return undefined;
	const fix = spec.network ? "pass force: true (or drop network: true)" : "pass force: true";
	return `Note: Cursor refused ${state.refusals} of its own tool call(s), which never ran; to allow them, ${fix}.`;
}

/** Why a run stopped after refusals, and how to fix it. */
export function refusalMessage(state: RunState, spec: Pick<RunSpec, "network" | "force">): string {
	const kinds = [...new Set(state.tools.filter((t) => t.refused).map((t) => t.kind))].join(", ") || "tool";
	const why = spec.network
		? "With the sandbox off (network: true), cursor-agent asks before every command, and print mode can't answer."
		: "cursor-agent wanted approval for them, and print mode can't answer.";
	const fix = spec.network
		? "Pass force: true to let it run commands without asking (only for trusted prompts and workspaces), drop network: true so commands run in the sandbox, or add an allow rule to ~/.cursor/cli-config.json."
		: "Pass force: true to let it run them without asking, or add an allow rule to ~/.cursor/cli-config.json.";
	return `Stopped: Cursor refused its own ${kinds} calls ${state.refusals} times, so nothing ran. ${why} ${fix}`;
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
	if (args.force) cliArgs.push("--force");
	if (args.mode && args.mode !== "agent") cliArgs.push("--mode", args.mode);
	if (args.worktree) {
		// --worktree takes an optional name, so without one it would swallow the prompt.
		cliArgs.push("--worktree", `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
		if (args.worktreeBase) cliArgs.push("--worktree-base", args.worktreeBase);
	}
	cliArgs.push(args.prompt);
	// Recorded before spawn, so an in-place run's pre-existing dirt is not its diff.
	const base = await captureBase(cwd, !!args.worktree, args.worktreeBase).catch(() => undefined);
	return {
		model,
		cwd,
		cliArgs,
		worktree: !!args.worktree,
		bin: process.env.PI_CURSOR_AGENT_BIN?.trim() || "cursor-agent",
		...(args.network ? { network: true } : {}),
		...(args.force ? { force: true } : {}),
		...(base ? { base: base.base, baseKind: base.kind, ...(base.large ? { baseLarge: base.large } : {}) } : {}),
	};
}

/** The process env without any PI_BG_* variable, so cursor-agent cannot see the job id or the sidecar path. */
function agentEnv(): NodeJS.ProcessEnv {
	if (!Object.keys(process.env).some((k) => k.startsWith("PI_BG_"))) return process.env;
	const env = { ...process.env };
	for (const k of Object.keys(env)) if (k.startsWith("PI_BG_")) delete env[k];
	return env;
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
	opts: { signal?: AbortSignal; onEvent?: (run: RunReducer, changed: boolean) => void; refusalLimit?: number } = {},
): Promise<RunOutcome> {
	const { signal, onEvent } = opts;
	const refusalLimit = opts.refusalLimit ?? REFUSAL_LIMIT;
	let refusedStop = false;
	const run = new RunReducer(spec.cwd);
	const started = Date.now();
	const stderr: string[] = [];
	const exitCode = await new Promise<number | null>((done, fail) => {
		// cursor-agent must not see PI_BG_LOG: it could overwrite the sidecar during the cost lookup.
		const proc = spawn(spec.bin, spec.cliArgs, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], env: agentEnv() });
		proc.stdout.on("data", (chunk: Buffer) => {
			// Feed first: `onEvent?.(run, run.feed(…))` would skip the feed when there is no onEvent.
			const changed = run.feed(chunk.toString());
			onEvent?.(run, changed);
			// A refused step never ran; after a few, Cursor is just spinning (and billing) until it gives up.
			if (!refusedStop && refusalLimit > 0 && run.state.refusals >= refusalLimit) {
				refusedStop = true;
				kill();
			}
		});
		proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
		proc.on("error", (err: NodeJS.ErrnoException) =>
			fail(err.code === "ENOENT" ? new Error(`${spec.bin} not found; install it from https://cursor.com/cli`) : err),
		);
		proc.on("close", (code) => {
			const changed = run.feed("\n");
			onEvent?.(run, changed);
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
	if (refusedStop) out.refused = refusalMessage(out.state, spec);
	const ws = out.state.workspace;
	if (spec.worktree && ws && ws !== spec.cwd) {
		const [branch, status] = await Promise.all([
			git(ws, ["branch", "--show-current"]).catch(() => ""),
			git(ws, ["status", "--short"]).catch(() => ""),
		]);
		out.worktree = { path: ws, branch: branch.trim(), changed: status.split("\n").filter(Boolean) };
	}
	// What the run changed, for the phone: success, failure and stop alike (a stop only re-reads what the base had).
	const diffDir = spec.worktree ? (ws && ws !== spec.cwd ? ws : undefined) : spec.cwd;
	if (diffDir && spec.base) {
		const runId = out.state.sessionId || process.env.PI_BG_JOB_ID;
		const diff = await captureChanges(diffDir, spec.base, {
			...(runId ? { runId } : {}),
			...(spec.baseLarge ? { baseLarge: spec.baseLarge } : {}),
			...(signal?.aborted ? { stopped: true } : {}),
		}).catch(() => undefined);
		if (diff && (diff.full.trim() !== "" || diff.diffStats.files > 0)) out.diff = diff;
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
