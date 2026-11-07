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
 * Pure aside from secret masking: no pi imports, so tests drive it with recorded events.
 */

import { fileURLToPath } from "node:url";
import { isSensitivePath, maskDiffSecrets, pathsInText } from "../../../lib/cursor-diff.ts";

export interface ToolStep {
	kind: string;
	summary: string;
	ok?: boolean;
	/** Cursor refused to run it (result.rejected): it needed approval that print mode can't give. */
	refused?: boolean;
	/**
	 * Edit content when the event carried a patch or old/new text (EditSuccess
	 * diffString, or old_string / new_string), masked and capped. Never whole
	 * files; absent when the event only named a path, or the path is sensitive.
	 */
	edit?: { diff?: string; old?: string; new?: string };
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

const EDIT_KEEP = 8_000;

function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	if (!obj) return undefined;
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

function kept(s: string | undefined): string | undefined {
	if (!s) return undefined;
	const masked = maskDiffSecrets(s);
	return masked.length > EDIT_KEEP ? `${masked.slice(0, EDIT_KEEP - 1)}…` : masked;
}

/** A key that names a file, in either camelCase or snake_case (`file_path`, `targetFile`, `old_path`, …). */
function isPathKey(key: string): boolean {
	const n = key.replace(/[_-]/g, "").toLowerCase();
	return (
		n === "path" ||
		n === "file" ||
		n === "filename" ||
		n === "filepath" ||
		n === "targetfile" ||
		n === "targetpath" ||
		n === "oldpath" ||
		n === "newpath" ||
		n === "oldfile" ||
		n === "newfile" ||
		n === "sourcepath" ||
		n === "destpath" ||
		n === "destinationpath" ||
		n === "srcpath" ||
		n === "uri" ||
		n === "fileuri" ||
		n.endsWith("fileuri") ||
		n.endsWith("filepath") ||
		n.endsWith("filename") ||
		(n.endsWith("path") && n.length > 4)
	);
}

/** A path string, or a `file://` URI decoded to a filesystem path (`%2F` included). */
function asPath(v: string): string {
	if (!/^file:/i.test(v)) return v;
	try {
		return fileURLToPath(v);
	} catch {
		try {
			return decodeURIComponent(new URL(v).pathname);
		} catch {
			return v;
		}
	}
}

function pathValues(obj: Record<string, unknown> | undefined): string[] {
	if (!obj) return [];
	const out: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (!isPathKey(k)) continue;
		if (typeof v === "string" && v) out.push(asPath(v));
		else if (Array.isArray(v)) for (const item of v) if (typeof item === "string" && item) out.push(asPath(item));
	}
	return out;
}

const PATCH_HEADER = /^(?:rename|copy) |^--- |^\+\+\+ |^\*\*\* (?:Update|Add|Delete) File:|^\*\*\* Move to:|^diff --git /m;

/** Diff/patch strings on a tool call, plus any string that itself carries a patch header. */
function patchTexts(obj: Record<string, unknown> | undefined): string[] {
	if (!obj) return [];
	const out: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (typeof v !== "string" || !v) continue;
		const n = k.replace(/[_-]/g, "").toLowerCase();
		if (n.includes("diff") || n.includes("patch") || PATCH_HEADER.test(v)) out.push(v);
	}
	return out;
}

/** Every path an edit event names: each path key on args and on success, and every patch header. */
export function editPaths(node: Record<string, any> | undefined): string[] {
	if (!node || typeof node !== "object") return [];
	const args = (node.args ?? {}) as Record<string, unknown>;
	const success = (node.result?.success ?? {}) as Record<string, unknown>;
	return [
		...pathValues(args),
		...pathValues(success),
		...patchTexts(args).flatMap(pathsInText),
		...patchTexts(success).flatMap(pathsInText),
	];
}

/**
 * Patch or old/new text from a tool call, when Cursor sent it: EditSuccess's
 * `diffString`, or the call's `old_string` / `new_string`. Whole-file content
 * (before/afterFullFileContent, a write's fileText, a delete's prevContent) is
 * never kept. If any path is sensitive (.env, a key, .npmrc …) — on any path key,
 * or inside a diff/patch header (rename/copy, ---/+++, ApplyPatch) — keep nothing
 * but the path. Started events usually name only a path, so this is set on the
 * completed event. Both camelCase (stream-json) and snake_case (the proto names).
 */
export function editOf(node: Record<string, any> | undefined): ToolStep["edit"] {
	if (!node || typeof node !== "object") return undefined;
	const args = (node.args ?? {}) as Record<string, unknown>;
	const success = (node.result?.success ?? {}) as Record<string, unknown>;
	if (editPaths(node).some(isSensitivePath)) return undefined;
	const diff = kept(pick(success, "diffString", "diff_string") ?? pick(args, "diff", "patch", "diffString", "diff_string"));
	const old = kept(pick(args, "oldString", "old_string"));
	const neu = kept(pick(args, "newString", "new_string"));
	if (!diff && !old && !neu) return undefined;
	return { ...(diff ? { diff } : {}), ...(old ? { old } : {}), ...(neu ? { new: neu } : {}) };
}

/** One line for a tool call: "read fizz.rb", "shell ruby fizz_test.rb", "glob *.rb". */
export function describeTool(call: Record<string, any>, cwd: string): ToolStep {
	const key = Object.keys(call).find((k) => k.endsWith("ToolCall")) ?? "tool";
	const kind = key.replace(/ToolCall$/, "");
	const node = call[key];
	const args: Record<string, unknown> = node?.args ?? {};
	const edit = editOf(node);
	// Cursor reports realpaths (/private/tmp/… on macOS); show paths relative to the workspace.
	const unprivate = (p: string) => p.replaceAll("/private/", "/");
	const base = `${unprivate(cwd).replace(/\/$/, "")}/`;
	const rel = (p: string) => unprivate(p).replaceAll(base, "");
	const shownPath = (typeof args.path === "string" && args.path) || editPaths(node)[0];
	const skipSummary = (k: string) => {
		const n = k.replace(/[_-]/g, "").toLowerCase();
		return n.includes("diff") || n.includes("patch") || n === "oldstring" || n === "newstring" || n === "filetext" || n === "streamcontent";
	};
	const firstString = Object.entries(args).find((e): e is [string, string] => !skipSummary(e[0]) && typeof e[1] === "string" && e[1].length > 0)?.[1];
	const maskedRel = (s: string) => maskDiffSecrets(rel(s));
	let summary = maskDiffSecrets(kind);
	if (typeof args.command === "string") summary = `${kind} ${short(maskedRel(args.command), 70)}`;
	else if (shownPath) summary = `${kind} ${maskedRel(shownPath)}`;
	else if (firstString) summary = `${kind} ${short(maskedRel(firstString), 60)}`;
	const result = call[key]?.result;
	const withEdit = edit ? { edit } : {};
	if (result?.rejected) return { kind, summary, ok: false, refused: true, ...withEdit };
	const ok = result ? !result.error && (result.success?.exitCode ?? 0) === 0 : undefined;
	return { kind, summary, ok, ...withEdit };
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
