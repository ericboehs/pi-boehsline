/**
 * codemode_bg: run a codemode script detached. The tool returns a run id at
 * once; the script's result arrives later as one message that wakes the
 * model, like a bg job's completion. So a long workflow (await coop workers,
 * subagent reviews, fix rounds) no longer holds the session's turn.
 *
 * Mainline pi only: codemode is `model-only` (scripts must not start
 * scripts), so ctx.executeTool("codemode") is refused. Instead this builds
 * its own codemode definition with the exported createCodemodeExtension()
 * and runs its execute() with the calling tool's ctx; the script's tools.*
 * calls then go through ctx.executeTool and the session's tool_call hooks
 * (the guardian) like a foreground script's.
 *
 * The script outlives the tool call that started it: it gets its own abort
 * signal, not the call's. It counts against codemode's worker limit for its
 * whole run.
 */
import { randomBytes } from "node:crypto";
import { createCodemodeExtension, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The longest result text delivered in the message; codemode keeps the full output in a temp file past its own cap. */
export const RESULT_MAX_CHARS = 8000;
export const CUSTOM_TYPE = "bg-codemode";
/** At most this many runs at once: codemode has two workers per process, and a run holds one throughout. */
export const MAX_RUNS = 1;
/** A script that sets no timeout_ms gets this one (2 h), so a hung run frees its worker. */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

interface Run {
	id: string;
	name: string;
	startedAt: number;
	abort: AbortController;
	stopped?: boolean;
}

type Content = Array<{ type: string; text?: string }>;
/** A tool result as execute() returns it ({content, isError}), or wrapped as executeTool returns it ({result, isError}). */
type Outcome = { content?: Content; result?: { content?: Content }; isError?: boolean };
type ToolCtx = { executeTool?: unknown };
type Runner = (code: string, toolCallId: string, signal: AbortSignal, ctx: unknown) => Promise<Outcome>;
type Reach = (input: Record<string, unknown>) => "all" | readonly string[];

/** The script with a timeout_ms in its options line, unless it sets one. */
export function withTimeout(code: string, timeoutMs = DEFAULT_TIMEOUT_MS): string {
	const match = /^\/\/ @options:(.*)$/m.exec(code.split("\n", 1)[0] ?? "");
	if (!match) return `// @options: ${JSON.stringify({ timeout_ms: timeoutMs })}\n${code}`;
	let options: unknown;
	try {
		options = JSON.parse(match[1] ?? "");
	} catch {
		return code; // codemode reports a bad options line itself
	}
	if (!options || typeof options !== "object" || Array.isArray(options) || "timeout_ms" in options) return code;
	const rest = code.slice(code.indexOf("\n") === -1 ? code.length : code.indexOf("\n"));
	return `// @options: ${JSON.stringify({ ...options, timeout_ms: timeoutMs })}${rest}`;
}

/**
 * codemode's own tool definition, captured from the exported factory: its execute() runs a
 * script with the ctx it is given, and its reachesTools names the tools a script may call (so
 * pi waits for MCP servers a script uses). pi's settings reach it through the real
 * ExtensionAPI. registerTool is caught, and appendEntry dropped: a script's store() would be
 * written whenever it ends, into whatever session or branch is current then.
 */
export function codemodeRunner(
	pi: ExtensionAPI,
	factory: (pi: ExtensionAPI) => unknown = createCodemodeExtension(),
): { run: Runner; reach?: Reach } | undefined {
	let definition: ToolDefinition | undefined;
	const capture = new Proxy(pi, {
		get(target, key, receiver) {
			if (key === "registerTool") return (def: ToolDefinition) => void (definition = def);
			if (key === "appendEntry") return () => {};
			return Reflect.get(target, key, receiver);
		},
	});
	try {
		factory(capture);
	} catch {
		return undefined;
	}
	const def = definition;
	if (!def) return undefined;
	return {
		run: (code, toolCallId, signal, ctx) =>
			// biome-ignore lint/suspicious/noExplicitAny: codemode's execute takes the tool ctx pi gave this call
			def.execute(toolCallId, { code } as any, signal, undefined, ctx as any) as Promise<Outcome>,
		...(def.reachesTools ? { reach: def.reachesTools as Reach } : {}),
	};
}

function textOf(outcome: Outcome | undefined): string {
	return (outcome?.content ?? outcome?.result?.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function cap(text: string): string {
	if (text.length <= RESULT_MAX_CHARS) return text;
	const half = Math.floor(RESULT_MAX_CHARS / 2);
	return `${text.slice(0, half)}\n… ${text.length - RESULT_MAX_CHARS} chars omitted …\n${text.slice(-half)}`;
}

function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: undefined, ...(isError ? { isError: true } : {}) };
}

export function registerBgCodemode(
	pi: ExtensionAPI,
	options: { now?: () => number; runner?: Runner } = {},
): { runs: Map<string, Run> } {
	const now = options.now ?? Date.now;
	const codemode = options.runner ? { run: options.runner } : codemodeRunner(pi);
	const runner = codemode?.run;
	const reach = codemode && "reach" in codemode ? codemode.reach : undefined;
	const runs = new Map<string, Run>();
	let disposed = false;

	function deliver(run: Run, outcome: Outcome | undefined, thrown?: unknown): void {
		runs.delete(run.id);
		if (disposed) return;
		const failed = thrown !== undefined || outcome?.isError === true;
		const verb = run.stopped ? "stopped" : failed ? "failed" : "succeeded";
		const body = thrown !== undefined ? String((thrown as Error)?.message ?? thrown) : textOf(outcome);
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: `[codemode_bg ${run.id}] \`${run.name}\` ${verb} after ${duration(now() - run.startedAt)}\n${cap(body) || "(no output)"}`,
				display: true,
				details: { id: run.id, name: run.name, failed, stopped: run.stopped === true },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	pi.registerTool({
		name: "codemode_bg",
		label: "codemode (background)",
		description:
			"Run a codemode script detached: same JavaScript and `tools.*` as the codemode tool, but this returns a run id at once " +
			"and the script's output arrives later as one message. For long workflows (awaiting coop workers, subagent reviews, " +
			"fix rounds) that would otherwise hold the turn. `stop: <id>` cancels a run. A run holds one of codemode's workers " +
			"until it ends.",
		parameters: Type.Object({
			code: Type.Optional(Type.String({ description: "The codemode script (raw JavaScript, as for codemode)" })),
			name: Type.Optional(Type.String({ description: "A short label for the completion message" })),
			stop: Type.Optional(Type.String({ description: "A run id to cancel instead of starting one" })),
		}),
		reachesTools: (input) => reach?.({ code: input.code }) ?? [],
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as { code?: string; name?: string; stop?: string };
			if (input.stop !== undefined) {
				const run = runs.get(input.stop);
				if (!run) return textResult(`no running codemode_bg run ${input.stop}`, true);
				run.stopped = true;
				run.abort.abort(new Error("stopped"));
				return textResult(`codemode_bg ${run.id} stopping`);
			}
			const code = input.code?.trim();
			if (!code) return textResult("codemode_bg needs code (or stop)", true);
			const tc = ctx as unknown as ToolCtx;
			if (typeof tc.executeTool !== "function") return textResult("this pi has no ctx.executeTool", true);
			if (!runner) return textResult("this pi does not export createCodemodeExtension", true);
			if (runs.size >= MAX_RUNS) {
				return textResult(`codemode_bg ${[...runs.keys()].join(", ")} is still running (at most ${MAX_RUNS} at once)`, true);
			}
			const run: Run = {
				id: randomBytes(3).toString("hex"),
				name: (input.name ?? code.split("\n").find((line) => line.trim() && !line.startsWith("// @options"))?.trim() ?? "script").slice(0, 60),
				startedAt: now(),
				abort: new AbortController(),
			};
			runs.set(run.id, run);
			// Not awaited: the tool returns now and the script reports when it ends.
			Promise.resolve()
				.then(() => runner(withTimeout(code), toolCallId, run.abort.signal, ctx))
				.then(
				(outcome) => deliver(run, outcome),
				(error) => deliver(run, undefined, error ?? new Error("codemode rejected")),
			);
			return textResult(`codemode_bg ${run.id} started; its result arrives as a message`);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		disposed = true;
		const ended = [...runs.values()];
		for (const run of ended) run.abort.abort(new Error("session ended"));
		runs.clear();
		// No result will arrive: the run dies with the session (unlike a bg job, a script is in-process).
		if (ended.length > 0 && ctx?.hasUI) {
			ctx.ui.notify(`codemode_bg stopped with the session: ${ended.map((run) => `${run.id} ${run.name}`).join(", ")}`, "warning");
		}
	});

	return { runs };
}
