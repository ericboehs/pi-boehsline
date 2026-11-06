/**
 * The subagents a pi session is running, as one list: the subagent tool's foreground children
 * (pi and Cursor), its background ones (bg jobs), and the cursor tool's runs. Each is tracked
 * from where it starts; botsun-owner sends the list to Eric's phone, which draws them under
 * their session on Home and can stop one.
 *
 * One store per process (globalThis + Symbol.for, so a /reload's fresh modules share it), each
 * child tagged with the pi session it was started in: a session only ever lists, and stops,
 * its own. A finished child stays 10 minutes, then goes.
 *
 * Every change is also emitted as "subagents:update" ({ children }) on each pi.events bus that
 * called bindChildren.
 *
 * What a child is doing comes from its output: a foreground pi child's JSON events, a Cursor
 * run's reducer state, a background job's log (the subagent progress filter's lines, or the
 * cursor runner's). The log parse is best effort: a line it doesn't know is skipped.
 */

import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { maskSecrets } from "../extensions/opt-in/op-broker/broker.ts";

export type ChildKind = "pi" | "cursor";
export type ChildState = "running" | "done" | "failed" | "stopped";

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Dollars. */
	cost: number;
}

/** One child as other extensions see it ("subagents:update", listChildren). */
export interface ChildInfo {
	id: string;
	kind: ChildKind;
	agent: string;
	/** The first 200 characters, likely secrets masked. */
	task: string;
	model?: string;
	state: ChildState;
	startedAt: number;
	endedAt?: number;
	turns: number;
	/** What it is doing now ("Read foo.rb", "Ran bin/test", "Thinking…"); "" once it ended. */
	activity: string;
	/** Its latest text (the answer once done), about 600 characters. */
	lastText: string;
	/** Its last work lines, oldest first. A failed step starts with "✗ ", a note with "> ". */
	tail: string[];
	usage?: ChildUsage;
	/** A Cursor run's worktree. */
	worktree?: string;
	/** The pi session it was started in. */
	sessionId: string | null;
}

export const KEEP_MS = 10 * 60_000;
export const MAX_CHILDREN = 16;
export const TAIL_LINES = 30;
const TASK_MAX = 200;
const LINE_MAX = 160;
const ACTIVITY_MAX = 120;
const TEXT_MAX = 600;
const POLL_MS = 2_000;
const READ_MAX = 256 * 1024;

export const THINKING = "Thinking…";
export const WRITING = "Writing…";

interface BgSource {
	id: string;
	logPath: string;
	offset: number;
	carry: string;
	/** In the result block (pi: after the banner; cursor: the answer under its banner). */
	result: boolean;
	resultLines: string[];
	/** cursor: inside "── full answer ──", before the result block. */
	full: boolean;
	/** cursor: the full answer came first, so the result block's shortened one is skipped. */
	keep: boolean;
}

interface Rec extends ChildInfo {
	stop?: () => void;
	bg?: BgSource;
	/** A stop was asked (from the phone): its end is "stopped" whatever its exit. */
	stopping?: boolean;
}

type Listener = (immediate: boolean) => void;
interface Bus {
	on?(channel: string, handler: (data: unknown) => void): unknown;
	emit(channel: string, data: unknown): void;
}

interface Store {
	children: Map<string, Rec>;
	listeners: Set<Listener>;
	/** The latest bus bound: a background child's kill goes there (an older one may be stale). */
	events?: Bus;
	bound: WeakSet<object>;
	poll?: ReturnType<typeof setInterval>;
	sweep?: ReturnType<typeof setTimeout>;
}

const KEY = Symbol.for("pi-boehsline.children");

function store(): Store {
	const g = globalThis as unknown as { [KEY]?: Store };
	g[KEY] ??= { children: new Map(), listeners: new Set(), bound: new WeakSet() };
	return g[KEY];
}

// ---- text

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

function cap(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One line, likely inline secrets masked, at most n characters. */
export function clean(s: unknown, n: number): string {
	return cap(maskSecrets(oneLine(String(s ?? ""))), n);
}

/** Text kept as written (its newlines), masked and capped. */
function cleanText(s: unknown): string {
	const text = maskSecrets(String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim());
	return cap(text, TEXT_MAX);
}

const base = (p: string) => {
	const parts = p.replace(/\/+$/, "").split("/");
	return parts.at(-1) || p;
};

/** A pi tool call as a work line: "Read foo.rb", "Ran bin/test", "Searched for TODO". */
export function toolLabel(name: string, args: Record<string, unknown> = {}): string {
	const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
	const path = str("path") || str("file_path");
	const firstLine = (s: string) => s.split("\n")[0] ?? "";
	let label: string;
	switch (name) {
		case "read":
			label = `Read ${base(path) || "a file"}`;
			break;
		case "bash":
			label = `Ran ${firstLine(str("command")) || "a command"}`;
			break;
		case "edit":
			label = `Edited ${base(path) || "a file"}`;
			break;
		case "write":
			label = `Wrote ${base(path) || "a file"}`;
			break;
		case "grep":
			label = `Searched for ${str("pattern") || "text"}`;
			break;
		case "find":
			label = `Searched files ${str("pattern")}`.trim();
			break;
		case "ls":
			label = `Listed ${base(path) || "."}`;
			break;
		case "web_fetch":
			label = `Fetched ${str("url")}`.trim();
			break;
		case "web_search":
			label = `Searched the web for ${str("query")}`.trim();
			break;
		default:
			label = `Called ${name}`;
	}
	return clean(label, ACTIVITY_MAX);
}

/** A Cursor step summary ("read src/a.rb", "shell bin/test") as a work line. */
export function cursorLabel(summary: string): string {
	const s = oneLine(summary);
	const space = s.indexOf(" ");
	const kind = space < 0 ? s : s.slice(0, space);
	const rest = space < 0 ? "" : s.slice(space + 1);
	const verbs: Record<string, (r: string) => string> = {
		read: (r) => `Read ${base(r)}`,
		shell: (r) => `Ran ${r}`,
		edit: (r) => `Edited ${base(r)}`,
		write: (r) => `Wrote ${base(r)}`,
		delete: (r) => `Deleted ${base(r)}`,
		glob: (r) => `Searched files ${r}`,
		grep: (r) => `Searched for ${r}`,
		ls: (r) => `Listed ${base(r) || "."}`,
	};
	const label = verbs[kind] && rest ? verbs[kind](rest) : s;
	return clean(label, ACTIVITY_MAX);
}

// ---- the store

function notify(immediate: boolean): void {
	for (const fn of [...store().listeners]) {
		try {
			fn(immediate);
		} catch {}
	}
}

/** Drops what ended more than KEEP_MS ago; says so when any went. */
function prune(now = Date.now()): boolean {
	const s = store();
	let dropped = false;
	for (const [id, c] of s.children) {
		if (c.endedAt !== undefined && now - c.endedAt >= KEEP_MS) {
			s.children.delete(id);
			dropped = true;
		}
	}
	return dropped;
}

/** The next expiry, as a timer (unref'd): the list changes then without anything else moving. */
function scheduleSweep(): void {
	const s = store();
	clearTimeout(s.sweep);
	s.sweep = undefined;
	const ends = [...s.children.values()].map((c) => c.endedAt).filter((t): t is number => t !== undefined);
	if (ends.length === 0) return;
	const wait = Math.max(0, Math.min(...ends) + KEEP_MS - Date.now()) + 50;
	s.sweep = setTimeout(() => {
		s.sweep = undefined;
		if (prune()) notify(true);
		scheduleSweep();
	}, wait);
	s.sweep.unref?.();
}

function info(c: Rec): ChildInfo {
	const { stop: _stop, bg: _bg, stopping: _stopping, ...rest } = c;
	return { ...rest, tail: [...c.tail], ...(c.usage ? { usage: { ...c.usage } } : {}) };
}

/** Every child this process tracks (or only one session's), oldest first. */
export function listChildren(sessionId?: string | null): ChildInfo[] {
	if (prune()) scheduleSweep();
	return [...store().children.values()].filter((c) => sessionId === undefined || c.sessionId === sessionId).map(info);
}

/** Called after every change: immediate when a child started, ended or went. Returns the unsubscribe. */
export function onChildrenChange(fn: Listener): () => void {
	const s = store();
	s.listeners.add(fn);
	return () => s.listeners.delete(fn);
}

export interface ChildStart {
	kind: ChildKind;
	agent: string;
	task: string;
	model?: string;
	sessionId: string | null;
	worktree?: string;
	/** Aborts a foreground child (its own AbortController). */
	stop?: () => void;
	/** A background child: its bg job, followed through the log and bg:jobs. */
	bg?: { id: string; logPath: string };
}

/** What a child's tracker can do: its source feeds it, then it ends. */
export interface ChildHandle {
	readonly id: string;
	/** One line of a pi child's `--mode json` output. */
	piLine(line: string): void;
	/** A pi child's parsed event (what piLine does after JSON.parse). */
	piEvent(ev: unknown): void;
	/** A Cursor run's reducer state, after each of its events. */
	cursorState(state: CursorStateLike, worktree?: string): void;
	/** A note of its own (e.g. "Looking up the run's cost…"). */
	set(patch: Partial<Pick<ChildInfo, "activity" | "lastText" | "worktree" | "usage" | "model">>): void;
	/** It ended: done, failed, or stopped (a stop asked through stopChild always says stopped). */
	finish(state: Exclude<ChildState, "running">, patch?: Partial<Pick<ChildInfo, "lastText" | "worktree" | "usage">>): void;
	/** A stop was asked of it (its own abort, from the phone). */
	readonly stopping: boolean;
}

/** The fields of cursor-agent's RunState the list reads. */
export interface CursorStateLike {
	tools: { summary: string; ok?: boolean }[];
	live?: string;
	answer?: string;
	thinking?: boolean;
	workspace?: string;
}

function makeId(kind: ChildKind): string {
	return `${kind === "cursor" ? "c" : "p"}-${randomBytes(5).toString("hex")}`;
}

/** Start tracking a child. The oldest finished one goes past MAX_CHILDREN (the oldest at all, if none has). */
export function trackChild(start: ChildStart): ChildHandle {
	const s = store();
	prune();
	while (s.children.size >= MAX_CHILDREN) {
		const all = [...s.children.values()];
		const victim = all.find((c) => c.state !== "running") ?? all[0];
		if (!victim) break;
		s.children.delete(victim.id);
	}
	const rec: Rec = {
		id: makeId(start.kind),
		kind: start.kind,
		agent: clean(start.agent, 40) || "subagent",
		task: clean(start.task, TASK_MAX),
		...(start.model ? { model: clean(start.model, 80) } : {}),
		state: "running",
		startedAt: Date.now(),
		turns: 0,
		activity: start.bg ? "Starting…" : THINKING,
		lastText: "",
		tail: [],
		...(start.worktree ? { worktree: clean(start.worktree, 300) } : {}),
		sessionId: start.sessionId,
		...(start.stop ? { stop: start.stop } : {}),
	};
	if (start.bg) {
		rec.bg = { id: start.bg.id, logPath: start.bg.logPath, offset: 0, carry: "", result: false, resultLines: [], full: false, keep: false };
	}
	s.children.set(rec.id, rec);
	notify(true);
	if (rec.bg) startPolling();
	return handle(rec);
}

/** What the list shows of a child, cheaply: a pi child's events come at every streamed token. */
function sig(rec: Rec): string {
	return [rec.activity, rec.turns, rec.tail.length, rec.tail.at(-1) ?? "", rec.lastText, rec.worktree ?? "", rec.model ?? "", JSON.stringify(rec.usage ?? null)].join("\u0000");
}

function handle(rec: Rec): ChildHandle {
	const live = () => store().children.get(rec.id) === rec && rec.state === "running";
	const changed = (before: string) => {
		if (sig(rec) !== before) notify(false);
	};
	const pi = new PiParser(rec);
	return {
		id: rec.id,
		get stopping() {
			return rec.stopping === true;
		},
		piLine(line) {
			if (!live() || !line.trim()) return;
			let ev: unknown;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			this.piEvent(ev);
		},
		piEvent(ev) {
			if (!live()) return;
			const before = sig(rec);
			pi.feed(ev);
			changed(before);
		},
		cursorState(state, worktree) {
			if (!live()) return;
			const before = sig(rec);
			applyCursorState(rec, state, worktree);
			changed(before);
		},
		set(patch) {
			if (!live()) return;
			const before = sig(rec);
			applyPatch(rec, patch);
			changed(before);
		},
		finish(state, patch = {}) {
			if (store().children.get(rec.id) !== rec || rec.state !== "running") return;
			end(rec, state, patch);
		},
	};
}

function applyPatch(rec: Rec, patch: Partial<Pick<ChildInfo, "activity" | "lastText" | "worktree" | "usage" | "model">>): void {
	if (patch.activity !== undefined) rec.activity = clean(patch.activity, ACTIVITY_MAX);
	if (patch.lastText !== undefined) rec.lastText = cleanText(patch.lastText);
	if (patch.worktree !== undefined) rec.worktree = clean(patch.worktree, 300);
	if (patch.model !== undefined) rec.model = clean(patch.model, 80);
	if (patch.usage) rec.usage = { ...patch.usage };
}

function end(rec: Rec, state: Exclude<ChildState, "running">, patch: Partial<Pick<ChildInfo, "lastText" | "worktree" | "usage">>): void {
	applyPatch(rec, patch);
	rec.state = rec.stopping ? "stopped" : state;
	rec.endedAt = Date.now();
	rec.activity = "";
	delete rec.stop;
	notify(true);
	scheduleSweep();
}

function pushTail(rec: Rec, line: string): void {
	const l = clean(line, LINE_MAX);
	if (!l) return;
	rec.tail.push(l);
	if (rec.tail.length > TAIL_LINES) rec.tail.splice(0, rec.tail.length - TAIL_LINES);
}

/** Marks the latest work line `label` failed ("✗ " in front), else adds it so. */
function failTail(rec: Rec, label: string): void {
	const l = clean(label, LINE_MAX);
	for (let i = rec.tail.length - 1; i >= Math.max(0, rec.tail.length - 8); i--) {
		if (rec.tail[i] === l) {
			rec.tail[i] = clean(`✗ ${l}`, LINE_MAX);
			return;
		}
	}
	pushTail(rec, `✗ ${l}`);
}

// ---- a pi child's JSON events (pi --mode json)

type Part = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type PiMessage = { role?: string; content?: Part[] | string; usage?: Record<string, unknown> };
type PiEvent = {
	type?: string;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	isError?: boolean;
	message?: PiMessage;
	assistantMessageEvent?: { type?: string };
};

/** Reads a pi child's AgentEvents into its record: turns, the tool it runs, its text and usage. */
class PiParser {
	private labels = new Map<string, string>();
	private rec: Rec;
	constructor(rec: Rec) {
		this.rec = rec;
	}

	feed(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const ev = raw as PiEvent;
		const rec = this.rec;
		switch (ev.type) {
			case "turn_start":
				rec.activity = THINKING;
				break;
			case "tool_execution_start": {
				const label = toolLabel(String(ev.toolName ?? "tool"), ev.args && typeof ev.args === "object" ? ev.args : {});
				if (ev.toolCallId) this.labels.set(ev.toolCallId, label);
				rec.activity = label;
				pushTail(rec, label);
				break;
			}
			case "tool_execution_end": {
				const label = (ev.toolCallId && this.labels.get(ev.toolCallId)) || toolLabel(String(ev.toolName ?? "tool"));
				if (ev.toolCallId) this.labels.delete(ev.toolCallId);
				if (ev.isError) failTail(rec, label);
				if (this.labels.size === 0) rec.activity = THINKING;
				break;
			}
			case "message_update": {
				if (ev.message?.role !== "assistant" || this.labels.size > 0) break;
				const kind = ev.assistantMessageEvent?.type ?? "";
				if (kind.startsWith("thinking")) rec.activity = THINKING;
				else if (kind.startsWith("text")) rec.activity = WRITING;
				break;
			}
			case "message_end": {
				const m = ev.message;
				if (m?.role !== "assistant") break;
				rec.turns++;
				const u = m.usage ?? {};
				const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
				const cost = (u.cost as { total?: unknown } | undefined)?.total;
				const usage = rec.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				usage.input += n(u.input);
				usage.output += n(u.output);
				usage.cacheRead += n(u.cacheRead);
				usage.cacheWrite += n(u.cacheWrite);
				usage.cost += n(cost);
				rec.usage = usage;
				const parts = Array.isArray(m.content) ? m.content : [];
				let text = typeof m.content === "string" ? m.content : "";
				for (const p of parts) if (p?.type === "text" && p.text) text = p.text;
				if (text.trim()) {
					rec.lastText = cleanText(text);
					pushTail(rec, `> ${text}`);
				}
				break;
			}
		}
	}
}

// ---- a Cursor run's state (cursor-agent's RunReducer)

function applyCursorState(rec: Rec, state: CursorStateLike, worktree?: string): void {
	const tools = Array.isArray(state.tools) ? state.tools : [];
	rec.turns = tools.length;
	rec.tail = tools.slice(-TAIL_LINES).map((t) => clean(`${t.ok === false ? "✗ " : ""}${cursorLabel(t.summary)}`, LINE_MAX));
	const running = tools.at(-1)?.ok === undefined ? tools.at(-1) : undefined;
	rec.activity = running ? cursorLabel(running.summary) : state.thinking ? THINKING : state.live ? WRITING : THINKING;
	const text = state.live || state.answer;
	if (text) rec.lastText = cleanText(text);
	if (worktree) rec.worktree = clean(worktree, 300);
}

// ---- background children: their bg job's log

/** "12.3k" → 12300. */
const kNum = (s: string | undefined) => {
	if (!s) return 0;
	const n = Number.parseFloat(s);
	return Number.isFinite(n) ? Math.round(s.endsWith("k") ? n * 1000 : n) : 0;
};

const PI_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "web_fetch", "web_search", "subagent", "cursor"]);
const PI_RESULT = /^── result · (\d+) turns · ([\d.]+k?) in \(([\d.]+k?) cached\) \/ ([\d.]+k?) out(?: · \$([\d.]+))? ──$/;

/** One line of the subagent progress filter's output (a background pi child's log). */
function piLogLine(rec: Rec, line: string): void {
	const bg = rec.bg;
	if (!bg) return;
	if (bg.result) {
		bg.resultLines.push(line);
		rec.lastText = cleanText(bg.resultLines.join("\n"));
		return;
	}
	const banner = PI_RESULT.exec(line);
	if (banner) {
		bg.result = true;
		rec.turns = Number(banner[1]);
		rec.usage = { input: kNum(banner[2]), cacheRead: kNum(banner[3]), output: kNum(banner[4]), cacheWrite: 0, cost: Number(banner[5] ?? 0) || 0 };
		rec.activity = WRITING;
		return;
	}
	const turn = /^· turn (\d+) · (.*)$/.exec(line);
	if (!turn) return;
	rec.turns = Number(turn[1]);
	const body = turn[2] ?? "";
	const calls = body.split(" | ");
	const first = body.split(" ")[0] ?? "";
	if (PI_TOOLS.has(first)) {
		let last = THINKING;
		for (const call of calls) {
			const sp = call.indexOf(" ");
			const name = sp < 0 ? call : call.slice(0, sp);
			const arg = sp < 0 ? "" : call.slice(sp + 1);
			const key = name === "bash" ? "command" : name === "grep" || name === "find" ? "pattern" : name === "web_fetch" ? "url" : "path";
			last = toolLabel(name, { [key]: arg });
			pushTail(rec, last);
		}
		rec.activity = last;
	} else if (body && body !== "(no text)") {
		rec.lastText = cleanText(body);
		pushTail(rec, `> ${body}`);
		rec.activity = THINKING;
	}
}

const CURSOR_RESULT = /^── cursor result · (.+?) · /;

/** One line of the cursor runner's log (a background Cursor run's). */
function cursorLogLine(rec: Rec, line: string): void {
	const bg = rec.bg;
	if (!bg) return;
	const banner = CURSOR_RESULT.exec(line) ?? (/^── cursor result · failed to start ──$/.test(line) ? [line, "failed"] : null);
	if (banner) {
		bg.result = true;
		bg.keep = bg.full && bg.resultLines.length > 0;
		bg.full = false;
		if (!bg.keep) bg.resultLines = [];
		rec.activity = "";
		return;
	}
	if (/^── full answer \(\d+ chars\) ──$/.test(line)) {
		bg.full = true;
		bg.resultLines = [];
		return;
	}
	if (bg.result) {
		// The answer runs from the banner to "Model:"; the facts after it only name the worktree.
		const wt = /^Worktree: (.+?) \(branch /.exec(line);
		if (wt?.[1]) rec.worktree = clean(wt[1], 300);
		if (/^Model: /.test(line)) bg.keep = true;
		if (bg.keep || /^\[answer truncated at /.test(line)) return;
		bg.resultLines.push(line);
		rec.lastText = cleanText(bg.resultLines.join("\n"));
		return;
	}
	if (bg.full) {
		bg.resultLines.push(line);
		rec.lastText = cleanText(bg.resultLines.join("\n"));
		return;
	}
	const session = /^session \S+(?: · [^·]+)?(?: · in (.+))?$/.exec(line);
	if (session) {
		if (session[1]) rec.worktree = clean(session[1], 300);
		rec.activity = THINKING;
		return;
	}
	const step = /^([→✓✗]) (.+)$/.exec(line);
	if (!step?.[2]) return;
	const label = cursorLabel(step[2]);
	if (step[1] === "→") {
		rec.turns++;
		pushTail(rec, label);
		rec.activity = label;
	} else {
		const recent = rec.tail.slice(-8).includes(clean(label, LINE_MAX));
		if (!recent) {
			rec.turns++;
			pushTail(rec, label);
		}
		if (step[1] === "✗") failTail(rec, label);
		rec.activity = THINKING;
	}
}

/** What's new in a background child's log, parsed. */
function readLog(rec: Rec): void {
	const bg = rec.bg;
	if (!bg) return;
	let fd: number | undefined;
	try {
		fd = openSync(bg.logPath, "r");
		const buf = Buffer.alloc(READ_MAX);
		const n = readSync(fd, buf, 0, READ_MAX, bg.offset);
		if (n <= 0) return;
		bg.offset += n;
		const lines = (bg.carry + buf.subarray(0, n).toString("utf8")).split("\n");
		bg.carry = lines.pop() ?? "";
		if (bg.carry.length > READ_MAX) bg.carry = "";
		for (const l of lines) (rec.kind === "cursor" ? cursorLogLine : piLogLine)(rec, l.replace(/\r$/, ""));
	} catch {
		// Not there yet, or gone: the next read tries again.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

type BgJob = { id?: string; endedAt?: number; exitCode?: number | null; signal?: string | null; killedByUser?: boolean };

/** A background child's bg job ended (as bg:jobs or bg:list says). */
function bgEnded(rec: Rec, job: BgJob): void {
	if (rec.state !== "running" || !rec.bg) return;
	readLog(rec);
	if (rec.bg.carry) {
		(rec.kind === "cursor" ? cursorLogLine : piLogLine)(rec, rec.bg.carry);
		rec.bg.carry = "";
	}
	const state = job.killedByUser || job.signal ? "stopped" : job.exitCode === 0 ? "done" : "failed";
	end(rec, state, {});
}

function onBgJobs(jobs: unknown): void {
	if (!Array.isArray(jobs)) return;
	for (const rec of store().children.values()) {
		if (!rec.bg || rec.state !== "running") continue;
		const job = (jobs as BgJob[]).find((j) => j?.id === rec.bg?.id);
		if (job && job.endedAt !== undefined) bgEnded(rec, job);
	}
}

function startPolling(): void {
	const s = store();
	if (s.poll) return;
	s.poll = setInterval(pollOnce, POLL_MS);
	s.poll.unref?.();
}

/** Every running background child's log, then bg's own list (its exits). */
export function pollOnce(): void {
	const s = store();
	const running = [...s.children.values()].filter((c) => c.bg && c.state === "running");
	if (running.length === 0) {
		clearInterval(s.poll);
		s.poll = undefined;
		return;
	}
	for (const rec of running) {
		const before = sig(rec);
		readLog(rec);
		if (sig(rec) !== before) notify(false);
	}
	try {
		s.events?.emit("bg:list", { reply: onBgJobs });
	} catch {}
}

/**
 * Follow this bus: bg's exits (bg:jobs), background kills, and "subagents:update" on every
 * change. Idempotent per bus; the latest one bound is where kills go.
 */
export function bindChildren(events: Bus | undefined): void {
	if (!events) return;
	const s = store();
	s.events = events;
	if (s.bound.has(events)) return;
	s.bound.add(events);
	try {
		events.on?.("bg:jobs", onBgJobs);
	} catch {}
	const off = onChildrenChange(() => {
		try {
			events.emit("subagents:update", { children: listChildren() });
		} catch {
			off(); // a bus from before a /reload: pi refuses it now
		}
	});
}

export type StopResult = "stopped" | "not_found" | "ended" | "unstoppable";

/**
 * Stop one of this session's children: its own abort (foreground) or its bg job's kill
 * (background). Anything not in `sessionId`'s list is not found.
 */
export function stopChild(sessionId: string | null, id: string): StopResult {
	const rec = store().children.get(id);
	if (!rec || sessionId === null || rec.sessionId !== sessionId) return "not_found";
	if (rec.state !== "running") return "ended";
	if (rec.bg) {
		const events = store().events;
		if (!events) return "unstoppable";
		let killed = false;
		const req = { id: rec.bg.id, wake: true, accepted: false, reply: (r: { killed: boolean }) => { killed = r.killed; } };
		try {
			events.emit("bg:kill", req);
		} catch {
			return "unstoppable";
		}
		if (!req.accepted) return "unstoppable";
		// Its job had already exited (the next poll reads how): it ended on its own, not stopped.
		if (!killed) return "ended";
		rec.stopping = true;
		return "stopped";
	}
	if (!rec.stop) return "unstoppable";
	rec.stopping = true;
	try {
		rec.stop();
	} catch {}
	return "stopped";
}

/** The pi session a tool call runs in (its context's session id), or null. */
export function sessionOf(ctx: unknown): string | null {
	try {
		const id = (ctx as { sessionManager?: { getSessionId?: () => string | undefined } })?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? id : null;
	} catch {
		return null;
	}
}

/** Tests only: forget every child and timer. */
export function resetChildren(): void {
	const s = store();
	clearInterval(s.poll);
	clearTimeout(s.sweep);
	s.poll = undefined;
	s.sweep = undefined;
	s.children.clear();
	s.events = undefined;
}
