/**
 * cursor-agent: a `cursor` tool that hands a coding task to Cursor's agent
 * (`cursor-agent -p`) and reports what it did and what the run cost.
 *
 * Cursor runs its own agent loop and tools (read, edit, shell) in the given
 * directory, sandboxed by default (workspace writes only, no network). The
 * tool streams Cursor's stream-json events into a live view, returns Cursor's
 * final answer, then looks up the run's usage event on Cursor's dashboard API
 * (GetFilteredUsageEvents, matched by session id) for the cents charged.
 * A footer status shows this billing cycle's Cursor spend (same figure as
 * pi-usage), optionally with this session's tool runs appended, and
 * /cursor-usage shows the full breakdown against the per-user limit.
 *
 * `background: true` hands the same run to the bg extension as a job running
 * runner.ts, returns at once, and the bg completion message carries the result
 * (run.ts holds the code both paths share).
 *
 * Neutral by default. Org rules (a default model, blocked models, a note in the
 * tool description, extra prompt rules) come from Boehsline config or
 * PI_CURSOR_* env vars; see settings.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { optIn } from "../../../lib/opt-in.ts";
import {
	applyCursorStatusChip,
	cursorChipSession,
	cycleText,
	recordCycleUsage,
	refreshCursorStatusChip,
	syncChipFromCacheFile,
} from "./usage-cache.ts";
import { cycleUsage, dollars, eventTokens, kfmt, type UsageEvent } from "./api.ts";
import { type CliUsage, short, type ToolStep } from "./events.ts";
import { lookupCharge, prepareRun, refusalNote, type RunSpec, runCursor, type WorktreeInfo } from "./run.ts";
import { startJob } from "./runner.ts";
import { type CursorSettings, loadSettings } from "./settings.ts";
import { applyToRepo, type CursorWorktree, describe, listWorktrees, removeWorktree } from "./worktrees.ts";

interface CursorDetails {
	model: string;
	modelName?: string;
	cwd: string;
	workspace?: string;
	worktree?: WorktreeInfo;
	sessionId?: string;
	tools: ToolStep[];
	refusals?: number;
	answer: string;
	live: string;
	thinking: boolean;
	durationMs?: number;
	exitCode?: number | null;
	cliUsage?: CliUsage;
	charge?: UsageEvent;
	chargeError?: string;
	stderr?: string;
	/** The run was stopped because Cursor kept refusing its own tools: why, and the fix. */
	refused?: string;
	done: boolean;
}

function params(s: CursorSettings) {
	return Type.Object({
		prompt: Type.String({ description: "The task for Cursor's agent, self-contained: it does not see this conversation" }),
		model: Type.Optional(
			Type.String({ description: `Cursor model id (default ${s.defaultModel}); see \`cursor-agent --list-models\`` }),
		),
		mode: Type.Optional(
			StringEnum(["agent", "plan", "ask"] as const, {
				description: "agent (default) may edit and run commands; plan and ask are read-only",
			}),
		),
		cwd: Type.Optional(Type.String({ description: "Workspace directory (default: the session's cwd)" })),
		network: Type.Optional(
			Type.Boolean({
				description:
					"Run without Cursor's sandbox so commands can reach the network (default false). Outside the sandbox cursor-agent asks before every shell command and print mode can't answer, so commands are refused unless force is also true.",
			}),
		),
		force: Type.Optional(
			Type.Boolean({
				description:
					"Let Cursor run every command without asking (cursor-agent --force; default false). Needed for shell commands with network: true. Only for trusted prompts and workspaces: with the sandbox off, commands run with your full access.",
			}),
		),
		worktree: Type.Optional(
			Type.Boolean({
				description:
					"Run in a new git worktree (~/.cursor/worktrees/<repo>/<name>, on its own branch) so parallel calls can't overwrite each other; cwd must be a git repo with a commit. Changes stay uncommitted there for review.",
			}),
		),
		worktreeBase: Type.Optional(
			Type.String({ description: "Branch or ref the worktree starts from (default: the repo's current HEAD)" }),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Run detached via the bg extension: returns a job id at once, and the result (answer, cost, worktree) arrives as a message when Cursor finishes. Recommended for anything longer than a few minutes; pairs with worktree.",
			}),
		),
	});
}

/** What codemode scripts and other programmatic callers receive instead of the text. */
const outputSchema = Type.Object({
	answer: Type.String({ description: "Cursor's final answer" }),
	steps: Type.Array(
		Type.Object({ kind: Type.String(), summary: Type.String(), ok: Type.Optional(Type.Boolean()) }),
		{ description: "Cursor's tool calls, in order" },
	),
	chargedCents: Type.Optional(Type.Number({ description: "Server-side charge in cents; absent when it couldn't be found" })),
	tokens: Type.Number({ description: "Total tokens (server count when found, else the CLI's)" }),
	sessionId: Type.Optional(Type.String()),
	model: Type.String(),
	exitCode: Type.Union([Type.Number(), Type.Null()]),
	durationMs: Type.Number(),
	worktree: Type.Optional(
		Type.Object({ path: Type.String(), branch: Type.String(), changed: Type.Array(Type.String()) }),
	),
	error: Type.Optional(Type.String({ description: "Why the run failed (stderr tail), when exitCode is not 0" })),
});

type CursorOutput = Static<typeof outputSchema>;

function cliTokens(u?: CliUsage): number {
	return u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0;
}

function structured(d: CursorDetails): CursorOutput {
	return {
		answer: d.answer,
		steps: d.tools.map((t) => ({ kind: t.kind, summary: t.summary, ...(t.ok === undefined ? {} : { ok: t.ok }) })),
		...(d.charge ? { chargedCents: d.charge.chargedCents ?? 0 } : {}),
		tokens: d.charge ? eventTokens(d.charge) : cliTokens(d.cliUsage),
		...(d.sessionId ? { sessionId: d.sessionId } : {}),
		model: d.model,
		exitCode: d.exitCode ?? null,
		durationMs: d.durationMs ?? 0,
		...(d.refused ? { error: d.refused } : d.exitCode !== 0 && d.stderr ? { error: d.stderr } : {}),
		...(d.worktree ? { worktree: { path: d.worktree.path, branch: d.worktree.branch, changed: [...d.worktree.changed] } } : {}),
	};
}

function costLine(d: CursorDetails): string {
	const secs = d.durationMs ? `${(d.durationMs / 1000).toFixed(1)}s` : "";
	if (d.charge) {
		const fee = d.charge.cursorTokenFee ? `, incl. ${dollars(d.charge.cursorTokenFee)} Cursor fee` : "";
		return `${d.model} · ${secs} · ${dollars(d.charge.chargedCents ?? 0)}${fee} · ${kfmt(eventTokens(d.charge))} tokens`;
	}
	const u = d.cliUsage;
	const tok = cliTokens(u);
	const why = d.chargeError ? `: ${d.chargeError}` : "";
	return [d.model, secs, tok ? `${kfmt(tok)} tokens (CLI count)` : "", `cost not found${why}`].filter(Boolean).join(" · ");
}

interface BackgroundDetails {
	background: true;
	id: string;
	logPath: string;
	model: string;
}

/**
 * Hand the run to the bg extension as a job running runner.ts, which prints
 * Cursor's steps into the job log and ends with a result block that the
 * completion message carries back.
 */
async function startBackground(pi: ExtensionAPI, spec: RunSpec, prompt: string, ctx: ExtensionContext) {
	const reply = await startJob(pi.events, spec, { ctx, name: "cursor", summary: `cursor ${spec.model}: ${prompt}` });
	if (reply === null) {
		return {
			content: [
				{ type: "text" as const, text: "background needs the bg extension (extensions/bg), which is not loaded. Rerun without background." },
			],
			details: undefined,
			isError: true,
		};
	}
	if ("error" in reply) {
		return { content: [{ type: "text" as const, text: `Cursor background job failed to start: ${reply.error}` }], details: undefined, isError: true };
	}
	const details: BackgroundDetails = { background: true, id: reply.id, logPath: reply.logPath, model: spec.model };
	return {
		content: [
			{
				type: "text" as const,
				text: `Started in background: cursor ${spec.model} · bg ${reply.id} · log ${reply.logPath}\nThe result (answer, cost, worktree) arrives as a message when Cursor finishes. /bg watches or stops it.`,
			},
		],
		details,
	};
}

function registerCursorTool(pi: ExtensionAPI, s: CursorSettings, addCents: (cents: number, ctx: ExtensionContext) => void) {
	const description = [
		"Delegate a coding task to Cursor's agent (cursor-agent CLI). Cursor reads, edits and runs commands in the workspace with its own tools, sandboxed by default (workspace writes only, no network), and returns its final answer plus the server-side charged cost. The prompt must be self-contained. Runs can take many minutes; background: true returns at once and delivers the result as a message when Cursor finishes.",
		s.note,
	]
		.filter(Boolean)
		.join(" ");

	pi.registerTool({
		name: "cursor",
		label: "Cursor",
		description,
		promptSnippet:
			"Delegate a self-contained coding task to Cursor's agent; returns its answer and the run's cost (background: true for long runs, result arrives as a message)",
		promptGuidelines: [
			"Use the cursor tool only when the user asks for Cursor or a Cursor model; every run is billed to their Cursor account.",
			"After the cursor tool edits files, review its changes (git diff) before reporting them as done.",
			"Never put secrets in the cursor tool's prompt.",
			...s.rules,
		],
		parameters: params(s),
		outputSchema,
		executionMode: "sequential",

		async execute(_id, args, signal, onUpdate, ctx) {
			// pi-ai 1.5's StringEnum is a plain Schema, which Type.Static widens to {}.
			const mode = args.mode as "agent" | "plan" | "ask" | undefined;
			// Fresh settings, so a config edit applies without /reload.
			const spec = await prepareRun({ ...args, mode }, ctx.cwd, loadSettings());
			if (args.background) return startBackground(pi, spec, args.prompt, ctx);
			const { model, cwd } = spec;

			let lastEmit = 0;
			const outcome = await runCursor(spec, {
				signal,
				onEvent: (run, changed) => {
					const now = Date.now();
					if (!changed && now - lastEmit < 150) return;
					lastEmit = now;
					const text = short(run.state.live, 200) || "Cursor is working…";
					onUpdate?.({
						content: [{ type: "text", text }],
						details: { model, cwd, ...run.state, tools: [...run.state.tools], done: false },
					});
				},
			});

			const d: CursorDetails = { model, cwd, ...outcome.state, done: false };
			d.exitCode = outcome.exitCode;
			d.durationMs = outcome.durationMs;
			if (outcome.stderr) d.stderr = outcome.stderr;
			if (outcome.worktree) d.worktree = outcome.worktree;
			if (outcome.refused) d.refused = outcome.refused;
			const exitCode = outcome.exitCode;

			if (signal?.aborted) {
				d.done = true;
				return {
					content: [{ type: "text", text: "Cursor run cancelled." }],
					details: d,
					structuredContent: structured(d),
					isError: true,
				};
			}

			if (d.sessionId) {
				onUpdate?.({ content: [{ type: "text", text: "Looking up the run's cost…" }], details: { ...d } });
				const { charge, chargeError } = await lookupCharge(d.sessionId, outcome.started, signal);
				if (charge) {
					d.charge = charge;
					addCents(charge.chargedCents ?? 0, ctx);
				} else if (chargeError) d.chargeError = chargeError;
			}
			d.done = true;
			void refreshCursorStatusChip(ctx); // pi-usage cache + footer chip; errors swallowed

			const failed = exitCode !== 0 || !!d.refused;
			const steps = d.tools.map((t) => `- ${t.summary}${t.refused ? " (refused)" : t.ok === false ? " (failed)" : ""}`).join("\n");
			const wt = d.worktree
				? `\nWorktree: ${d.worktree.path} (branch ${d.worktree.branch || "?"}), ${d.worktree.changed.length} changed file(s)${d.worktree.changed.length ? `:\n${d.worktree.changed.map((l) => `  ${l}`).join("\n")}` : ""}`
				: "";
			const text = truncateTail(
				[
					d.refused ?? (failed ? `Cursor exited with code ${exitCode}.` : ""),
					d.refused ? "" : (refusalNote({ refusals: d.refusals ?? 0 }, spec) ?? ""),
					d.answer || "(Cursor returned no answer)",
					steps ? `\nCursor's steps:\n${steps}` : "",
					wt,
					failed && d.stderr ? `\nstderr:\n${d.stderr}` : "",
					`\n[${costLine(d)}${d.sessionId ? ` · session ${d.sessionId}` : ""}]`,
				]
					.filter(Boolean)
					.join("\n"),
				{ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES },
			).content;
			return { content: [{ type: "text", text }], details: d, structuredContent: structured(d), isError: failed };
		},

		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("cursor "));
			t += theme.fg("accent", args.model || s.defaultModel);
			if (args.mode && args.mode !== "agent") t += theme.fg("muted", ` [${args.mode}]`);
			if (args.network) t += theme.fg("warning", " [no sandbox]");
			if (args.force) t += theme.fg("warning", " [run everything]");
			if (args.worktree) t += theme.fg("muted", " [worktree]");
			if (args.background) t += theme.fg("muted", " [background]");
			if (args.prompt) t += ` ${theme.fg("dim", short(args.prompt, 90))}`;
			return new Text(t, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const raw = result.details as CursorDetails | BackgroundDetails | undefined;
			if (!raw || "background" in raw) {
				const text = result.content?.[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "";
				return new Text(text ? theme.fg(raw ? "muted" : "error", `  ${text}`) : "", 0, 0);
			}
			const d = raw;
			const lines: string[] = [];
			const steps = expanded ? d.tools : d.tools.slice(-5);
			if (d.tools.length > steps.length) lines.push(theme.fg("dim", `  … ${d.tools.length - steps.length} earlier steps`));
			for (const step of steps) {
				const mark =
					step.ok === undefined ? theme.fg("dim", "…") : step.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
				lines.push(`  ${mark} ${theme.fg("muted", step.summary)}`);
			}
			if (isPartial || !d.done) {
				const tail = result.content?.[0]?.type === "text" ? result.content[0].text : "";
				const status = d.thinking ? "thinking…" : "working…";
				lines.push(theme.fg("dim", `  ${tail && tail !== "Cursor is working…" ? short(tail, 120) : status}`));
				return new Text(lines.join("\n"), 0, 0);
			}
			if (expanded && d.answer) lines.push("", d.answer);
			else if (d.answer) lines.push(theme.fg("text", `  ${short(d.answer, 160)}`));
			if (d.worktree) {
				lines.push(
					theme.fg("muted", `  worktree ${d.worktree.branch || "?"} · ${d.worktree.changed.length} changed · ${d.worktree.path}`),
				);
			}
			lines.push(
				(d.refused
					? theme.fg("error", `  ✗ refused ${d.refusals}× · `)
					: d.exitCode === 0
						? theme.fg("success", "  ✓ ")
						: theme.fg("error", `  ✗ exit ${d.exitCode} · `)) +
					theme.fg(d.charge ? "accent" : "warning", costLine(d)),
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

export default optIn("cursor-agent", "A cursor tool that delegates tasks to Cursor's agent CLI and reports each run's cost", (pi) => {
	const addCents = (cents: number, ctx: ExtensionContext) => {
		cursorChipSession.sessionCents += cents;
		applyCursorStatusChip(ctx);
	};

	// Register at session_start, not load: config sources (a work package)
	// may load after this one, and the description and rules come from them.
	pi.on("session_start", (_event, ctx) => {
		cursorChipSession.sessionCents = 0;
		registerCursorTool(pi, loadSettings(), addCents);
		void syncChipFromCacheFile(ctx);
		void refreshCursorStatusChip(ctx);
	});

	// Background cursor jobs (and subagent cursor tasks) refresh the cache in runner.ts;
	// re-read the file when a turn ends so the chip catches up without blocking startup.
	pi.on("turn_end", (_event, ctx) => {
		void syncChipFromCacheFile(ctx);
	});

	pi.registerCommand("cursor-usage", {
		description: "Cursor spend this billing cycle against the per-user limit",
		handler: async (_args, ctx) => {
			try {
				const u = await cycleUsage(ctx.signal);
				ctx.ui.notify(cycleText(u, Date.now(), cursorChipSession.sessionCents), "info");
				void recordCycleUsage(u).then(() => refreshCursorStatusChip(ctx, undefined, { fetch: false }));
			} catch (err) {
				ctx.ui.notify(`cursor-usage: ${(err as Error).message}`, "error");
			}
		},
	});
	pi.registerCommand("cursor-worktrees", {
		description: "Review the pi-* worktrees Cursor left behind: apply their changes to the repo, or remove them",
		handler: async (args, ctx) => {
			try {
				await reviewWorktrees(ctx, args.trim() === "list" || !ctx.hasUI);
			} catch (err) {
				ctx.ui.notify(`cursor-worktrees: ${(err as Error).message}`, "error");
			}
		},
	});
});

const APPLY_REMOVE = "Apply changes to the repo, then remove the worktree";
const APPLY_KEEP = "Apply changes to the repo, keep the worktree";
const REMOVE = "Remove the worktree (discard its changes)";
const SKIP = "Skip";
const DONE = "Done";

function details(wt: CursorWorktree): string {
	const lines = [wt.path, `branch ${wt.branch || "?"} · repo ${wt.repo ?? "unknown"}`];
	if (wt.ahead) lines.push(`${wt.ahead} commit(s) not in the repo's HEAD`);
	const shown = wt.changed.slice(0, 15).map((l) => `  ${l}`);
	if (wt.changed.length > shown.length) shown.push(`  … ${wt.changed.length - shown.length} more`);
	lines.push(...(shown.length ? shown : ["  (no uncommitted changes)"]));
	return lines.join("\n");
}

async function reviewWorktrees(ctx: ExtensionContext, listOnly: boolean): Promise<void> {
	let worktrees = await listWorktrees();
	if (!worktrees.length) {
		ctx.ui.notify("No pi-* Cursor worktrees left behind.", "info");
		return;
	}
	if (listOnly) {
		ctx.ui.notify(worktrees.map((wt) => `${describe(wt)}\n${details(wt)}`).join("\n\n"), "info");
		return;
	}
	const skipped = new Set<string>();
	for (;;) {
		const open = worktrees.filter((wt) => !skipped.has(wt.path));
		if (!open.length) return;
		const labels = open.map(describe);
		const pick = await ctx.ui.select(`Cursor worktrees (${open.length})`, [...labels, DONE]);
		if (!pick || pick === DONE) return;
		const wt = open[labels.indexOf(pick)];
		if (!wt) return;
		const canApply = !!wt.repo && !wt.problem && (wt.changed.length > 0 || wt.ahead > 0);
		const actions = canApply ? [APPLY_REMOVE, APPLY_KEEP, REMOVE, SKIP] : [REMOVE, SKIP];
		const action = await ctx.ui.select(`${describe(wt)}\n${details(wt)}`, actions);
		if (!action || action === SKIP) {
			skipped.add(wt.path);
			continue;
		}
		if (action === APPLY_REMOVE || action === APPLY_KEEP) {
			try {
				const { files } = await applyToRepo(wt);
				ctx.ui.notify(`Applied ${files} file(s) to ${wt.repo} (uncommitted).`, "info");
			} catch (err) {
				ctx.ui.notify(`Kept ${wt.name}: ${(err as Error).message}`, "error");
				skipped.add(wt.path);
				continue;
			}
			if (action === APPLY_KEEP) skipped.add(wt.path);
			else await removeWorktree(wt);
		} else {
			const lost = wt.changed.length + wt.ahead;
			if (lost && !(await ctx.ui.confirm(`Remove ${wt.name}?`, `This discards ${wt.changed.length} uncommitted change(s)${wt.ahead ? ` and ${wt.ahead} commit(s)` : ""}.`))) {
				continue;
			}
			await removeWorktree(wt);
			ctx.ui.notify(`Removed ${wt.name}.`, "info");
		}
		worktrees = await listWorktrees();
	}
}
