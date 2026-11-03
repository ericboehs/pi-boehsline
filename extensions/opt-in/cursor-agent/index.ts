/**
 * cursor-agent: a `cursor` tool that hands a coding task to Cursor's agent
 * (`cursor-agent -p`) and reports what it did and what the run cost.
 *
 * Cursor runs its own agent loop and tools (read, edit, shell) in the given
 * directory, sandboxed by default (workspace writes only, no network). The
 * tool streams Cursor's stream-json events into a live view, returns Cursor's
 * final answer, then looks up the run's usage event on Cursor's dashboard API
 * (GetFilteredUsageEvents, matched by session id) for the cents charged.
 * A footer status keeps the session's running Cursor spend, and /cursor-usage
 * shows the billing cycle against the per-user limit.
 *
 * Neutral by default. Org rules (a default model, blocked models, a note in the
 * tool description, extra prompt rules) come from Boehsline config or
 * PI_CURSOR_* env vars; see settings.ts.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { optIn } from "../../../lib/opt-in.ts";
import { cycleUsage, dollars, eventTokens, findUsageEvent, kfmt, type UsageEvent } from "./api.ts";
import { type CliUsage, RunReducer, short, type ToolStep } from "./events.ts";
import { blockedBy, type CursorSettings, loadSettings } from "./settings.ts";

interface CursorDetails {
	model: string;
	modelName?: string;
	cwd: string;
	sessionId?: string;
	tools: ToolStep[];
	answer: string;
	live: string;
	thinking: boolean;
	durationMs?: number;
	exitCode?: number | null;
	cliUsage?: CliUsage;
	charge?: UsageEvent;
	chargeError?: string;
	stderr?: string;
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
			Type.Boolean({ description: "Run without Cursor's sandbox so commands can reach the network (default false)" }),
		),
	});
}

function costLine(d: CursorDetails): string {
	const secs = d.durationMs ? `${(d.durationMs / 1000).toFixed(1)}s` : "";
	if (d.charge) {
		const fee = d.charge.cursorTokenFee ? `, incl. ${dollars(d.charge.cursorTokenFee)} Cursor fee` : "";
		return `${d.model} · ${secs} · ${dollars(d.charge.chargedCents ?? 0)}${fee} · ${kfmt(eventTokens(d.charge))} tokens`;
	}
	const u = d.cliUsage;
	const tok = u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0;
	const why = d.chargeError ? `: ${d.chargeError}` : "";
	return [d.model, secs, tok ? `${kfmt(tok)} tokens (CLI count)` : "", `cost not found${why}`].filter(Boolean).join(" · ");
}

function registerCursorTool(pi: ExtensionAPI, s: CursorSettings, addCents: (cents: number, ctx: ExtensionContext) => void) {
	const description = [
		"Delegate a coding task to Cursor's agent (cursor-agent CLI). Cursor reads, edits and runs commands in the workspace with its own tools, sandboxed by default (workspace writes only, no network), and returns its final answer plus the server-side charged cost. The prompt must be self-contained.",
		s.note,
	]
		.filter(Boolean)
		.join(" ");

	pi.registerTool({
		name: "cursor",
		label: "Cursor",
		description,
		promptSnippet: "Delegate a self-contained coding task to Cursor's agent; returns its answer and the run's cost",
		promptGuidelines: [
			"Use the cursor tool only when the user asks for Cursor or a Cursor model; every run is billed to their Cursor account.",
			"After the cursor tool edits files, review its changes (git diff) before reporting them as done.",
			"Never put secrets in the cursor tool's prompt.",
			...s.rules,
		],
		parameters: params(s),
		executionMode: "sequential",

		async execute(_id, args, signal, onUpdate, ctx) {
			const settings = loadSettings(); // fresh, so a config edit applies without /reload
			const model = args.model?.trim() || settings.defaultModel;
			const blocked = blockedBy(model, settings);
			if (blocked) throw new Error(`${model} is blocked (matches "${blocked}"): ${settings.blockedReason}`);
			const cwd = resolve(ctx.cwd, (args.cwd ?? ".").replace(/^@/, "").replace(/^~(?=$|\/)/, homedir()));
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);

			const cliArgs = ["-p", "--trust", "--output-format", "stream-json", "--stream-partial-output"];
			cliArgs.push("--sandbox", args.network ? "disabled" : "enabled", "--model", model);
			if (args.mode && args.mode !== "agent") cliArgs.push("--mode", args.mode);
			cliArgs.push(args.prompt);

			const run = new RunReducer(cwd);
			const started = Date.now();
			const details = (): CursorDetails => ({ model, cwd, ...run.state, tools: [...run.state.tools], done: false });
			let lastEmit = 0;
			const emit = (force: boolean) => {
				const now = Date.now();
				if (!force && now - lastEmit < 150) return;
				lastEmit = now;
				const text = short(run.state.live, 200) || "Cursor is working…";
				onUpdate?.({ content: [{ type: "text", text }], details: details() });
			};

			const stderr: string[] = [];
			const exitCode = await new Promise<number | null>((done, fail) => {
				const proc = spawn("cursor-agent", cliArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
				proc.stdout.on("data", (chunk: Buffer) => emit(run.feed(chunk.toString())));
				proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
				proc.on("error", (err: NodeJS.ErrnoException) =>
					fail(err.code === "ENOENT" ? new Error("cursor-agent not found; install it from https://cursor.com/cli") : err),
				);
				proc.on("close", (code) => {
					run.feed("\n");
					done(code);
				});
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => proc.killed || proc.kill("SIGKILL"), 3_000);
				};
				if (signal?.aborted) kill();
				else signal?.addEventListener("abort", kill, { once: true });
			});

			const d = details();
			d.exitCode = exitCode;
			d.durationMs ??= Date.now() - started;
			if (stderr.length) d.stderr = truncateTail(stderr.join(""), { maxLines: 40, maxBytes: 4_000 }).content;

			if (signal?.aborted) {
				d.done = true;
				return { content: [{ type: "text", text: "Cursor run cancelled." }], details: d, isError: true };
			}

			if (d.sessionId) {
				onUpdate?.({ content: [{ type: "text", text: "Looking up the run's cost…" }], details: { ...d } });
				try {
					d.charge = await findUsageEvent(d.sessionId, started, signal);
					if (d.charge) addCents(d.charge.chargedCents ?? 0, ctx);
					else d.chargeError = "no usage event yet";
				} catch (err) {
					d.chargeError = (err as Error).message;
				}
			}
			d.done = true;

			const failed = exitCode !== 0;
			const steps = d.tools.map((t) => `- ${t.summary}${t.ok === false ? " (failed)" : ""}`).join("\n");
			const text = truncateTail(
				[
					failed ? `Cursor exited with code ${exitCode}.` : "",
					d.answer || "(Cursor returned no answer)",
					steps ? `\nCursor's steps:\n${steps}` : "",
					failed && d.stderr ? `\nstderr:\n${d.stderr}` : "",
					`\n[${costLine(d)}${d.sessionId ? ` · session ${d.sessionId}` : ""}]`,
				]
					.filter(Boolean)
					.join("\n"),
				{ maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES },
			).content;
			return { content: [{ type: "text", text }], details: d, isError: failed };
		},

		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("cursor "));
			t += theme.fg("accent", args.model || s.defaultModel);
			if (args.mode && args.mode !== "agent") t += theme.fg("muted", ` [${args.mode}]`);
			if (args.network) t += theme.fg("warning", " [no sandbox]");
			if (args.prompt) t += ` ${theme.fg("dim", short(args.prompt, 90))}`;
			return new Text(t, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const d = result.details as CursorDetails | undefined;
			if (!d) return new Text("", 0, 0);
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
			lines.push(
				(d.exitCode === 0 ? theme.fg("success", "  ✓ ") : theme.fg("error", `  ✗ exit ${d.exitCode} · `)) +
					theme.fg(d.charge ? "accent" : "warning", costLine(d)),
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

export default optIn("cursor-agent", "A cursor tool that delegates tasks to Cursor's agent CLI and reports each run's cost", (pi) => {
	let sessionCents = 0;
	const addCents = (cents: number, ctx: ExtensionContext) => {
		sessionCents += cents;
		if (sessionCents > 0) ctx.ui.setStatus("cursor", `cursor ${dollars(sessionCents)}`);
	};

	// Register at session_start, not load: config sources (a work package)
	// may load after this one, and the description and rules come from them.
	pi.on("session_start", () => registerCursorTool(pi, loadSettings(), addCents));

	pi.registerCommand("cursor-usage", {
		description: "Cursor spend this billing cycle against the per-user limit",
		handler: async (_args, ctx) => {
			try {
				const u = await cycleUsage(ctx.signal);
				const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
				const left = Math.max(0, Math.ceil((u.end - Date.now()) / 86_400_000));
				const limit = u.limitDollars
					? ` of $${u.limitDollars} (${((u.spentCents / (u.limitDollars * 100)) * 100).toFixed(1)}%)`
					: "";
				const models = (u.aggregate.aggregations ?? [])
					.sort((a, b) => b.totalCents - a.totalCents)
					.map((m) => `${m.modelIntent} ${dollars(m.totalCents)}`)
					.join(", ");
				const session = sessionCents ? ` · this session ${dollars(sessionCents)}` : "";
				ctx.ui.notify(
					`Cursor ${day(u.start)}–${day(u.end)} (${left}d left): ${dollars(u.spentCents)}${limit}${session}${models ? `\n${models}` : ""}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`cursor-usage: ${(err as Error).message}`, "error");
			}
		},
	});
});
