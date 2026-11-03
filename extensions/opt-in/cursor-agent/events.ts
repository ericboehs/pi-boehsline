/**
 * Folds cursor-agent's `--output-format stream-json --stream-partial-output`
 * events into one run's state. One JSON object per line; every event has
 * `type` and `session_id`:
 *
 *   system/init          model display name, cwd
 *   thinking/delta       reasoning tokens (not kept, only "thinking…")
 *   assistant            with timestamp_ms, no model_call_id: a text delta
 *                        with model_call_id: a segment flush before a tool call
 *                        no timestamp_ms: the final answer, in full
 *   tool_call/started    tool_call.<kind>ToolCall.args
 *   tool_call/completed  same, plus .result.success | .result.error |
 *                        .result.rejected (approval needed and none possible in
 *                        print mode: the step never ran)
 *   result/success       duration_ms, usage; `result` joins every segment,
 *                        so it's only a fallback for the answer
 *
 * Pure: no pi or node imports, so tests drive it with recorded events.
 */

export interface ToolStep {
	kind: string;
	summary: string;
	ok?: boolean;
	/** Cursor refused to run it (result.rejected): it needed approval that print mode can't give. */
	refused?: boolean;
}

export interface CliUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface RunState {
	sessionId?: string;
	modelName?: string;
	/** Where Cursor actually ran: the init event's cwd (a worktree with -w). */
	workspace?: string;
	tools: ToolStep[];
	/** Completed steps Cursor refused (see ToolStep.refused). */
	refusals: number;
	answer: string;
	/** Streamed text since the last flush, else the last flushed segment. */
	live: string;
	thinking: boolean;
	durationMs?: number;
	cliUsage?: CliUsage;
}

export function short(s: string, n = 80): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** One line for a tool call: "read fizz.rb", "shell ruby fizz_test.rb", "glob *.rb". */
export function describeTool(call: Record<string, any>, cwd: string): ToolStep {
	const key = Object.keys(call).find((k) => k.endsWith("ToolCall")) ?? "tool";
	const kind = key.replace(/ToolCall$/, "");
	const args: Record<string, unknown> = call[key]?.args ?? {};
	// Cursor reports realpaths (/private/tmp/… on macOS); show paths relative to the workspace.
	const unprivate = (p: string) => p.replaceAll("/private/", "/");
	const base = `${unprivate(cwd).replace(/\/$/, "")}/`;
	const rel = (p: string) => unprivate(p).replaceAll(base, "");
	const firstString = Object.values(args).find((v): v is string => typeof v === "string" && v.length > 0);
	let summary = kind;
	if (typeof args.command === "string") summary = `${kind} ${short(rel(args.command), 70)}`;
	else if (typeof args.path === "string") summary = `${kind} ${rel(args.path)}`;
	else if (firstString) summary = `${kind} ${short(rel(firstString), 60)}`;
	const result = call[key]?.result;
	if (result?.rejected) return { kind, summary, ok: false, refused: true };
	const ok = result ? !result.error && (result.success?.exitCode ?? 0) === 0 : undefined;
	return { kind, summary, ok };
}

export class RunReducer {
	readonly state: RunState = { tools: [], refusals: 0, answer: "", live: "", thinking: false };
	private pending = new Map<string, number>();
	private streaming = "";
	private buf = "";
	/** Paths in step summaries are shown relative to this; it moves to the worktree once init names it. */
	private cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** Apply one event. Returns true when a tool step changed (worth an immediate repaint). */
	apply(ev: Record<string, any>): boolean {
		const s = this.state;
		switch (ev.type) {
			case "system":
				if (ev.subtype === "init") {
					s.sessionId = ev.session_id;
					if (typeof ev.model === "string") s.modelName = ev.model;
					if (typeof ev.cwd === "string") {
						s.workspace = ev.cwd;
						this.cwd = ev.cwd;
					}
				}
				return false;
			case "thinking":
				s.thinking = ev.subtype === "delta";
				return false;
			case "assistant": {
				const text = (ev.message?.content ?? []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
				if (ev.timestamp_ms === undefined) s.answer = text;
				else if (ev.model_call_id) {
					this.streaming = "";
					s.live = text;
				} else {
					this.streaming += text;
					s.live = this.streaming;
				}
				s.thinking = false;
				return false;
			}
			case "tool_call": {
				const step = describeTool(ev.tool_call ?? {}, this.cwd);
				if (ev.subtype === "started") {
					this.pending.set(ev.call_id, s.tools.length);
					s.tools.push(step);
				} else {
					if (step.refused) s.refusals++;
					const i = this.pending.get(ev.call_id);
					if (i !== undefined) s.tools[i] = step;
					else s.tools.push(step);
				}
				return true;
			}
			case "result":
				s.cliUsage = ev.usage;
				if (typeof ev.duration_ms === "number") s.durationMs = ev.duration_ms;
				if (!s.answer && typeof ev.result === "string") s.answer = ev.result;
				return false;
			default:
				return false;
		}
	}

	/** Feed raw stdout; complete lines are parsed, the remainder is kept. Returns true if any tool step changed. */
	feed(chunk: string): boolean {
		this.buf += chunk;
		let changed = false;
		let nl = this.buf.indexOf("\n");
		while (nl >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (line.startsWith("{")) {
				try {
					changed = this.apply(JSON.parse(line)) || changed;
				} catch {
					/* not JSON: ignore */
				}
			}
			nl = this.buf.indexOf("\n");
		}
		return changed;
	}
}
