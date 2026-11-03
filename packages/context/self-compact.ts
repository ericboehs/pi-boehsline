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

export function registerSelfCompact(pi: ExtensionAPI): void {
	let pending: { instructions?: string } | undefined;

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
