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
 * Pure node (no pi imports): it runs outside pi.
 */

import { readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { dollars, eventTokens, kfmt } from "./api.ts";
import { short } from "./events.ts";
import { type ChargeLookup, humanDuration, lookupCharge, type RunSpec, runCursor } from "./run.ts";

/** The answer in the result block; longer answers are printed in full above it. */
export const ANSWER_CHARS = 6_000;
/** What the completion message carries from the log's end: the result block plus the last steps. */
export const WAKE_CHARS = 16 * 1024;

export interface BackgroundDeps {
	/** Prints lines to the log (default: stdout). */
	write?: (...lines: string[]) => void;
	findCharge?: ChargeLookup;
	signal?: AbortSignal;
}

/** Run one background cursor job, printing progress and the result block. Resolves to the exit code. */
export async function runBackground(spec: RunSpec, deps: BackgroundDeps = {}): Promise<number> {
	const write = deps.write ?? ((...lines: string[]) => process.stdout.write(`${lines.join("\n")}\n`));
	const shown = new Map<number, boolean | undefined>(); // step index -> ok as last printed
	let announced = false;
	write(`cursor ${spec.model} · ${spec.cwd}${spec.worktree ? " · new worktree" : ""}`);

	let outcome: Awaited<ReturnType<typeof runCursor>>;
	try {
		outcome = await runCursor(spec, {
			signal: deps.signal,
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

	const { state, exitCode, durationMs, worktree, stderr } = outcome;
	const stopped = deps.signal?.aborted === true;
	const { charge, chargeError } = stopped ? {} : await lookupCharge(state.sessionId, outcome.started, undefined, deps.findCharge);
	const answer = state.answer.trim();
	const failed = exitCode !== 0;

	if (answer.length > ANSWER_CHARS) {
		write("", `── full answer (${answer.length} chars) ──`, answer);
	}
	const cost = charge
		? `${dollars(charge.chargedCents ?? 0)}${charge.cursorTokenFee ? ` (incl. ${dollars(charge.cursorTokenFee)} Cursor fee)` : ""} · ${kfmt(eventTokens(charge))} tokens`
		: `cost not found${chargeError ? `: ${chargeError}` : ""}`;
	const status = stopped ? "stopped" : failed ? `exit ${exitCode}` : "done";
	write("", `── cursor result · ${status} · ${spec.model} · ${humanDuration(durationMs)} · ${cost} ──`);
	if (answer.length > ANSWER_CHARS) {
		write(`${answer.slice(0, ANSWER_CHARS).trimEnd()}…`, `[answer truncated at ${ANSWER_CHARS} of ${answer.length} chars; the full text is above in this log]`);
	} else {
		write(answer || "(Cursor returned no answer)");
	}
	write("");
	write(`Model: ${spec.model}${state.modelName && state.modelName !== spec.model ? ` (${state.modelName})` : ""}`);
	write(`Duration: ${humanDuration(durationMs)} · ${state.tools.length} step(s)`);
	write(`Charged: ${charge ? `${dollars(charge.chargedCents ?? 0)} (chargedCents ${charge.chargedCents ?? 0})` : cost}`);
	if (worktree) {
		write(`Worktree: ${worktree.path} (branch ${worktree.branch || "?"}), ${worktree.changed.length} changed file(s)`);
		const files = worktree.changed.slice(0, 40).map((l) => `  ${l}`);
		if (worktree.changed.length > files.length) files.push(`  … ${worktree.changed.length - files.length} more`);
		if (files.length) write(...files);
	}
	if (state.sessionId) write(`Session: ${state.sessionId}`);
	write(`Exit code: ${exitCode ?? "none (killed)"}${stopped ? " · stopped" : ""}`);
	if (failed && stderr) write(`Error: ${short(stderr, 1_500)}`);
	return exitCode ?? 1;
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
