/**
 * Agent-facing context tools for pi-context.
 *
 *   - `context_usage`   — the agent reads current context usage on demand.
 *   - `compact_context` — the agent requests compaction, with optional focus
 *     instructions. It is queued; the agent finishes its response, and the
 *     compaction runs once pi is idle (`agent_settled`). Pi does not resume
 *     work afterwards.
 *   - Threshold nudge   — once usage crosses a configurable token count
 *     (default 250k), a single notice is appended to the session. It re-arms
 *     after the next compaction.
 *   - Post-compaction note — after a compaction the agent didn't ask for
 *     (/compact, idle cache-warm compaction, threshold or overflow), one line
 *     tells it the new usage, so it doesn't compact again on a stale nudge.
 *
 * Threshold config, first match wins:
 *   PI_CONTEXT_NUDGE_TOKENS env var, then `nudgeTokens` in
 *   ~/.pi-context/config.json, then 250000. 0 disables the nudge.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const CONFIG_PATH = join(homedir(), ".pi-context", "config.json");
const DEFAULT_NUDGE_TOKENS = 250_000;
const NUDGE_TYPE = "pi-context-nudge";
const COMPACTED_TYPE = "pi-context-compacted";

/**
 * pi-context's own estimate of the context (system prompt, tools, messages):
 * `raw` is characters / CPT, `total` is that scaled to the measured number or
 * the model's learned scale.
 */
export type EstimateTokens = (ctx: ExtensionContext) => { raw: number; total: number } | undefined;

const REASON_TEXT = {
	manual: "compacted",
	threshold: "auto-compacted near the context limit",
	overflow: "compacted after overflowing the context window",
} as const;

function nudgeTokens(): number {
	const env = process.env.PI_CONTEXT_NUDGE_TOKENS;
	if (env != null && env.trim() !== "" && Number.isFinite(Number(env))) return Math.max(0, Number(env));
	try {
		const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { nudgeTokens?: unknown };
		if (typeof cfg.nudgeTokens === "number" && Number.isFinite(cfg.nudgeTokens)) return Math.max(0, cfg.nudgeTokens);
	} catch {
		// No config file or invalid JSON: use the default.
	}
	return DEFAULT_NUDGE_TOKENS;
}

function k(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function usageText(ctx: ExtensionContext): string {
	const u = ctx.getContextUsage();
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model";
	if (!u) return `Context usage unavailable (${model}).`;
	const threshold = nudgeTokens();
	const lines = [
		u.tokens == null
			? `Context: unknown tokens (just compacted; measured after the next response) of a ${u.contextWindow.toLocaleString()}-token window.`
			: `Context: ${u.tokens.toLocaleString()} tokens of ${u.contextWindow.toLocaleString()} (${(u.percent ?? 0).toFixed(1)}%).`,
		`Model: ${model}`,
		threshold > 0 ? `Nudge threshold: ${threshold.toLocaleString()} tokens.` : "Nudge threshold: disabled.",
	];
	if (u.tokens != null) lines.push(`Remaining: ${(u.contextWindow - u.tokens).toLocaleString()} tokens.`);
	return lines.join("\n");
}

/** True when a nudge was already sent since the last compaction on this branch. */
function nudgedSinceCompaction(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as { type: string; customType?: string };
		if (e.type === "compaction") return false;
		if (e.type === "custom_message" && e.customType === NUDGE_TYPE) return true;
	}
	return false;
}

export function registerSelfCompact(pi: ExtensionAPI, estimate?: EstimateTokens): void {
	let pending: { instructions?: string } | undefined;
	// True from the agent-requested ctx.compact() call until its session_compact(_failed).
	let agentCompacting = false;
	// Measured / raw-estimate tokens for this session, taken just before a compaction,
	// so the post-compaction estimate uses this session's own scale.
	let scaleBefore: number | undefined;

	pi.registerTool({
		name: "context_usage",
		label: "Context Usage",
		description: "Show context window usage.",
		promptSnippet: "Show context window usage",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: usageText(ctx) }], details: ctx.getContextUsage() ?? null };
		},
	});

	pi.registerTool({
		name: "compact_context",
		label: "Compact Context",
		description:
			"Compact the session after this response; pi then waits for the user. Call it last, at a natural break.",
		promptSnippet: "Compact the session after this response",
		parameters: Type.Object({
			instructions: Type.Optional(Type.String({ description: "What the summary must keep" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const instructions = params.instructions?.trim() || undefined;
			pending = { instructions };
			const u = ctx.getContextUsage();
			const at = u?.tokens != null ? ` (currently ${k(u.tokens)} tokens)` : "";
			return {
				content: [
					{
						type: "text",
						text: `Compaction queued${at}. It runs when this response finishes, so wrap up now: say what you did and what comes next. The session waits for the user afterwards.`,
					},
				],
				details: { instructions: instructions ?? null },
			};
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!pending) return;
		const { instructions } = pending;
		pending = undefined;
		const before = ctx.getContextUsage()?.tokens;
		agentCompacting = true;
		ctx.compact({
			customInstructions: instructions,
			onComplete: () => {
				ctx.ui.notify(`Agent compacted the session${before != null ? ` (was ${k(before)} tokens)` : ""}.`, "info");
			},
			onError: (err) => {
				ctx.ui.notify(`Agent compaction failed: ${err.message}`, "error");
			},
		});
	});

	// Drop a queued request if the session changes underneath it.
	pi.on("session_start", async () => {
		pending = undefined;
		agentCompacting = false;
	});

	pi.on("session_compact_failed", async () => {
		agentCompacting = false;
		scaleBefore = undefined;
	});

	// Returns nothing, so another extension's compaction result is kept.
	pi.on("session_before_compact", async (_event, ctx) => {
		scaleBefore = undefined;
		const measured = ctx.getContextUsage()?.tokens;
		if (measured == null || agentCompacting) return;
		try {
			const raw = estimate?.(ctx)?.raw;
			if (raw && raw > 0) scaleBefore = measured / raw;
		} catch {
			// No estimate: fall back to the learned scale after compaction.
		}
	});

	// Tell the agent where usage stands after a compaction it didn't ask for.
	// getContextUsage() has no number until the next response, so the "after"
	// figure is pi-context's own estimate. Steering without triggerTurn: a
	// running agent reads it before its next model call; an idle session just
	// stores it for the next prompt.
	pi.on("session_compact", async (event, ctx) => {
		if (agentCompacting) {
			agentCompacting = false;
			return;
		}
		const before = event.compactionEntry.tokensBefore;
		const window = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
		const scale = scaleBefore;
		scaleBefore = undefined;
		let after = ctx.getContextUsage()?.tokens ?? undefined;
		if (after == null) {
			try {
				const e = estimate?.(ctx);
				if (e) after = scale ? Math.round(e.raw * scale) : e.total;
			} catch {
				after = undefined;
			}
		}
		const parts = [`[pi-context] Session ${REASON_TEXT[event.reason] ?? "compacted"}`];
		if (before > 0 || after != null) {
			const from = before > 0 ? `${k(before)}` : "?";
			const to = after != null ? `~${k(after)}` : "?";
			const pct = after != null && window ? ` (${((after / window) * 100).toFixed(0)}% of ${k(window)})` : "";
			parts[0] += `: ${from} → ${to} tokens${pct}`;
		}
		pi.sendMessage({
			customType: COMPACTED_TYPE,
			content: `${parts[0]}. No need to compact again.`,
			display: true,
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		const threshold = nudgeTokens();
		if (threshold <= 0 || event.outcome !== "completed") return;
		const u = ctx.getContextUsage();
		if (u?.tokens == null || u.tokens < threshold) return;
		if (nudgedSinceCompaction(ctx)) return;
		if (event.entries.some((e) => e.type === "custom_message" && e.customType === NUDGE_TYPE)) return;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: NUDGE_TYPE,
					content:
						`[pi-context] Context is at ${u.tokens.toLocaleString()} tokens ` +
						`(${(u.percent ?? 0).toFixed(1)}% of ${k(u.contextWindow)}), past the ${k(threshold)} threshold. ` +
						"At the next natural break, consider calling compact_context with instructions on what to keep.",
					display: true,
				},
			],
		};
	});
}
