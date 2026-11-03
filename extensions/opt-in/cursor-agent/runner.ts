/**
 * A background cursor run, started by the cursor tool (`background: true`) as a
 * bg job: `node runner.ts <spec.json>`. Its stdout is the job's log, so it
 * prints one line per Cursor step while it works (what /bg shows live), then a
 * result block: the answer (the full text when it's long, then a shortened copy)
 * and the model, duration, cost, worktree, exit code and error. The bg
 * extension's completion message carries that block back to the session.
 *
 * Stopping the job (/bg, x) sends SIGTERM to the job's process group; this
 * process also forwards it to cursor-agent and SIGKILLs it after 3s.
 *
 * The subagent tool's cursor agent (extensions/subagent) starts the same job
 * with startJob, and its foreground runs use runAndCharge and resultBlock, so
 * both report a run the same way.
 *
 * Pure node (no pi imports): it runs outside pi.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dollars, eventTokens, kfmt, type UsageEvent } from "./api.ts";
import { type RunReducer, short } from "./events.ts";
import { type ChargeLookup, humanDuration, lookupCharge, refusalNote, type RunOutcome, type RunSpec, runCursor } from "./run.ts";
import { refreshUsageCache } from "./usage-cache.ts";

/** The answer in the result block; longer answers are printed in full above it. */
export const ANSWER_CHARS = 6_000;
/** What the completion message carries from the log's end: the result block plus the last steps. */
export const WAKE_CHARS = 16 * 1024;

/** The bg extension's event-bus request (extensions/bg, "bg:start"). */
export interface BgStartRequest {
	command: string;
	cwd: string;
	ctx: unknown;
	name: string;
	summary: string;
	tailLines: number;
	tailMaxChars: number;
	accepted: boolean;
	reply: (result: BgReply) => void;
}

export type BgReply = { id: string; logPath: string } | { error: string };

const RUNNER = fileURLToPath(import.meta.url);
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Start `spec` as a bg job running this file (the cursor tool's `background`
 * and the subagent tool's cursor agent). The spec goes through a private temp
 * file the runner deletes on start, so the job's command line stays short.
 * Resolves to null when the bg extension isn't loaded.
 */
export async function startJob(
	events: { emit(channel: string, data: unknown): void },
	spec: RunSpec,
	job: { ctx: unknown; name: string; summary: string },
): Promise<BgReply | null> {
	const dir = mkdtempSync(join(tmpdir(), "pi-cursor-"));
	const specPath = join(dir, "spec.json");
	writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
	const node = basename(process.execPath).startsWith("node") ? process.execPath : "node";
	const reply = await new Promise<BgReply | null>((done) => {
		const req: BgStartRequest = {
			command: `${q(node)} ${q(RUNNER)} ${q(specPath)}`,
			cwd: spec.cwd,
			ctx: job.ctx,
			name: job.name,
			summary: job.summary,
			tailLines: 1000,
			tailMaxChars: WAKE_CHARS,
			accepted: false,
			reply: done,
		};
		events.emit("bg:start", req);
		if (!req.accepted) done(null); // no listener: the bg extension isn't loaded
	});
	if (reply === null || "error" in reply) rmSync(dir, { recursive: true, force: true });
	return reply;
}

/** A finished run and its charge. */
export interface RunResult {
	outcome: RunOutcome;
	charge?: UsageEvent;
	chargeError?: string;
	/** The signal aborted the run, so there was no cost lookup. */
	stopped: boolean;
	/**
	 * The usage cache refresh (`cursor-usage`, for pi-usage), started once the run and
	 * its cost lookup end, stopped runs included. Never rejects. A short-lived process
	 * (the bg runner) awaits it before exiting; pi itself can let it finish.
	 */
	usage: Promise<void>;
}

/** Run to completion, then look up the charge unless the run was stopped. Rejects when cursor-agent can't start. */
export async function runAndCharge(
	spec: RunSpec,
	opts: {
		signal?: AbortSignal;
		onEvent?: (run: RunReducer, changed: boolean) => void;
		findCharge?: ChargeLookup;
		refreshUsage?: () => Promise<void>;
	} = {},
): Promise<RunResult> {
	const outcome = await runCursor(spec, { signal: opts.signal, onEvent: opts.onEvent });
	const stopped = opts.signal?.aborted === true;
	const { charge, chargeError } = stopped ? {} : await lookupCharge(outcome.state.sessionId, outcome.started, opts.signal, opts.findCharge);
	const refresh = opts.refreshUsage ?? (() => refreshUsageCache());
	const usage = Promise.resolve()
		.then(() => refresh())
		.catch(() => {});
	return { outcome, charge, chargeError, stopped, usage };
}

/**
 * The result block: a banner, the answer (shortened past `answerChars`, with a
 * note that the full text is earlier in the log), then the model, duration,
 * charge, worktree, session, exit code and error.
 */
export function resultBlock(spec: RunSpec, r: RunResult, answerChars = ANSWER_CHARS): string[] {
	const { state, exitCode, durationMs, worktree, stderr, refused } = r.outcome;
	const { charge, chargeError, stopped } = r;
	const answer = state.answer.trim();
	const failed = exitCode !== 0 || !!refused;
	const lines: string[] = [];
	const cost = charge
		? `${dollars(charge.chargedCents ?? 0)}${charge.cursorTokenFee ? ` (incl. ${dollars(charge.cursorTokenFee)} Cursor fee)` : ""} · ${kfmt(eventTokens(charge))} tokens`
		: `cost not found${chargeError ? `: ${chargeError}` : ""}`;
	const status = stopped ? "stopped" : refused ? `refused ${state.refusals}×` : failed ? `exit ${exitCode}` : "done";
	lines.push(`── cursor result · ${status} · ${spec.model} · ${humanDuration(durationMs)} · ${cost} ──`);
	if (answer.length > answerChars) {
		lines.push(`${answer.slice(0, answerChars).trimEnd()}…`, `[answer truncated at ${answerChars} of ${answer.length} chars; the full text is above in this log]`);
	} else {
		lines.push(answer || "(Cursor returned no answer)");
	}
	lines.push("");
	lines.push(`Model: ${spec.model}${state.modelName && state.modelName !== spec.model ? ` (${state.modelName})` : ""}`);
	lines.push(`Duration: ${humanDuration(durationMs)} · ${state.tools.length} step(s)`);
	lines.push(`Charged: ${charge ? `${dollars(charge.chargedCents ?? 0)} (chargedCents ${charge.chargedCents ?? 0})` : cost}`);
	if (worktree) {
		lines.push(`Worktree: ${worktree.path} (branch ${worktree.branch || "?"}), ${worktree.changed.length} changed file(s)`);
		const files = worktree.changed.slice(0, 40).map((l) => `  ${l}`);
		if (worktree.changed.length > files.length) files.push(`  … ${worktree.changed.length - files.length} more`);
		lines.push(...files);
	}
	if (state.sessionId) lines.push(`Session: ${state.sessionId}`);
	lines.push(`Exit code: ${exitCode ?? "none (killed)"}${stopped ? " · stopped" : ""}`);
	if (!refused) {
		const note = refusalNote(state, spec);
		if (note) lines.push(note);
	}
	if (refused) lines.push(`Error: ${refused}`);
	else if (failed && stderr) lines.push(`Error: ${short(stderr, 1_500)}`);
	return lines;
}

export interface BackgroundDeps {
	/** Prints lines to the log (default: stdout). */
	write?: (...lines: string[]) => void;
	findCharge?: ChargeLookup;
	/** Writes the cycle's spend to the usage cache (default: refreshUsageCache). */
	refreshUsage?: () => Promise<void>;
	signal?: AbortSignal;
}

/** Run one background cursor job, printing progress and the result block. Resolves to the exit code. */
export async function runBackground(spec: RunSpec, deps: BackgroundDeps = {}): Promise<number> {
	const write = deps.write ?? ((...lines: string[]) => process.stdout.write(`${lines.join("\n")}\n`));
	const shown = new Map<number, boolean | undefined>(); // step index -> ok as last printed
	let announced = false;
	write(`cursor ${spec.model} · ${spec.cwd}${spec.worktree ? " · new worktree" : ""}`);

	let result: RunResult;
	try {
		result = await runAndCharge(spec, {
			signal: deps.signal,
			findCharge: deps.findCharge,
			refreshUsage: deps.refreshUsage,
			onEvent: (run) => {
				const s = run.state;
				if (!announced && s.sessionId) {
					announced = true;
					write(`session ${s.sessionId}${s.modelName ? ` · ${s.modelName}` : ""}${s.workspace && s.workspace !== spec.cwd ? ` · in ${s.workspace}` : ""}`);
				}
				s.tools.forEach((step, i) => {
					const was = shown.get(i);
					if (shown.has(i) && was === step.ok) return;
					shown.set(i, step.ok);
					const mark = step.ok === undefined ? "→" : step.ok ? "✓" : "✗";
					write(`${mark} ${step.summary}`);
				});
			},
		});
	} catch (err) {
		write(`── cursor result · failed to start ──`);
		write(`Error: ${(err as Error).message}`);
		return 127;
	}

	const answer = result.outcome.state.answer.trim();
	if (answer.length > ANSWER_CHARS) {
		write("", `── full answer (${answer.length} chars) ──`, answer);
	}
	write("", ...resultBlock(spec, result));
	await result.usage; // before the process exits, so the cache write lands
	return result.outcome.exitCode ?? 1;
}

async function main(specPath: string): Promise<void> {
	const spec = JSON.parse(readFileSync(specPath, "utf8")) as RunSpec;
	rmSync(dirname(specPath), { recursive: true, force: true }); // the prompt lives on only in cursor-agent's args
	const stop = new AbortController();
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => stop.abort());
	const code = await runBackground(spec, { signal: stop.signal });
	process.exitCode = stop.signal.aborted ? 143 : code;
}

const entry = process.argv[1];
if (entry && process.argv[2] && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
	main(process.argv[2]).catch((err) => {
		process.stdout.write(`cursor runner: ${(err as Error).message}\n`);
		process.exitCode = 1;
	});
}
