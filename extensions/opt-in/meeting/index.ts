/**
 * meeting.ts — live meeting copilot.
 *
 *   /meeting watch [off]    arm this session: it takes over the copilot now, and
 *                           runs every meeting that starts (off disarms)
 *   /meeting replay [speed] [path] [--model provider/id]
 *                           play a finished transcript back, for testing
 *   /meeting ask            check right now
 *   /meeting focus <text>   what you want out of this meeting (fed to the scout)
 *   /meeting list           every question in the widget (again to collapse)
 *   /meeting recap          post the recap so far and update the daily note
 *   /meeting stop           stop this meeting (it won't restart)
 *   /meeting                status: armed, owner setting, lock holder, live meeting
 *   /q3 [what to look for]  research Q3 with a subagent (/q 3, or /q to pick)
 *
 * Starts by itself. Every 2s each session checks meeting-capture's state.json
 * ($MEETING_CAPTURE_STATE_DIR, default ~/.local/state/meeting-capture; see its
 * docs/canvas-contract.md). A meeting is live when it isn't marked ended and
 * the recorder's pid is alive. A session may run the copilot when it is
 * eligible: armed with /meeting watch (saved in the session, so /reload and
 * resume keep it; PI_MEETING_WATCH=1 also arms), or named like meeting.owner
 * (its session name, case-insensitive; Eric's chief-of-staff session is
 * "earl"). Several sessions run at once and exactly one may run the copilot,
 * so it holds a lock, ~/.pi/agent/meeting-owner.json (PI_MEETING_LOCK):
 * {pid, sessionId, name, via, at}. A session claims it when there is none, the
 * holder's pid is dead, the holder is itself, or it is armed and the holder
 * only matches the owner setting. /meeting watch overwrites it at once. A
 * holder that finds the lock gone to someone else stops quietly ("Meeting
 * copilot moved to <name>") and doesn't re-claim until the lock frees. The lock
 * is created with O_EXCL when none exists; a takeover (dead or owner-held
 * holder) writes it, waits a random 100-300 ms and starts only if it is still
 * theirs. It is deleted on shutdown and on watch off. A meeting that ended never
 * restarts (ended:true), and /meeting stop is remembered in
 * ~/.pi/agent/meeting-stopped.json beside the lock (the last 5 started_at), so
 * no session or /reload restarts it. A new meeting has a different started_at,
 * and a recorder restart is a new meeting, so there is no wait for a reconnect.
 *
 * Tails the transcript state.json names (finished caption lines only) and,
 * when enough new talk has piled up, asks a small fast work model
 * (work.models) for questions worth asking out loud. No model is polled on a
 * timer: the file is, and code decides when a check is worth a call.
 *
 * Meetings are work text, so only work models run the scout and /q research
 * (watch/models.ts). The `meeting` tool below is NOT limited that way: it hands
 * the transcript and slide images to whatever model the session uses (Eric's
 * choice), so only use it in a session whose model may read work text. Any
 * other model for the scout, from PI_MEETING_MODEL,
 * --model or the session, is refused. With no work model, or while a call
 * fails, code rules carry on: being named and "any questions?" still show in
 * the widget, but no new questions appear. Each scout call stays under
 * PROMPT_MAX_TOKENS by keeping less of the transcript.
 *
 * Triggers: your name said by someone else, or "any questions?", fire after a
 * short pause; otherwise ~6 new lines plus a pause, 45s of unchecked talk, or a
 * flood of lines regardless, and never more than one check per 15s.
 *
 * Output:
 *   widget above the editor   the 3 open questions most worth asking now (new
 *                             ones show at once; the scout's re-ranking only
 *                             swaps one out after 3 min on screen) and a
 *                             suggested reply when someone is waiting on you
 *   session messages          a short custom message whenever a question is
 *                             added or a reply suggested, sent with
 *                             triggerTurn:false — it lands in the transcript and
 *                             the main model's context without starting a turn,
 *                             so the big model only runs when you ask it to.
 *                             No exceptions: the old --wake flag is gone (the
 *                             scout already writes the reply)
 *   recap                     at the end, every question as still open, answered
 *                             or asked: posted to the session and upserted as a
 *                             ### block at the end of "## Meetings" in the daily
 *                             note for the capture's date (never for a replay)
 *   research                  /q3 runs a separate `pi -p` on the session model
 *                             (read-only tools, 3 min cap, at most 2 at once):
 *                             the brief lands as a session message, the answer
 *                             line in the widget and the recap. It works after
 *                             the meeting too, and then rewrites the recap.
 *
 * Questions only leave the list when the scout sees them answered or asked;
 * the rest stay open and drop out of the compact view, not the list.
 *
 * Chat Q&A: the `meeting` tool answers "what did I miss in the last 10 min",
 * "what did Amy say about the cert", "what's this slide about" from the session
 * model, read-only, in any session (no lock needed):
 *   action status | transcript | slide
 *   minutes, since, until (HH:MM[:SS] in the meeting's own offset, or ISO), speaker, query, limit
 *   slide (default: the one on screen; its OCR text and the jpg come back)
 * It reads the live meeting, else the last one in state.json, and says which.
 * While this session runs a live meeting, one line is added to the system
 * prompt per turn ("A meeting is live: Weekly Sync (Microsoft Teams), 16 min
 * in, slide 4 on screen. Use the meeting tool for anything about it."; the
 * minutes round down to 5, "just started" under 5).
 *
 * Scout context: a fixed system prompt (cached) with ~/.pi/agent/meeting-context.md
 * (who you are), the tail of the previous transcript of the same meeting, and
 * `qmd search` hits for the meeting title; then the transcript so far.
 *
 * Teams writes a caption only when it scrolls out of its ~3-line window, so the
 * transcript trails the room by a couple of utterances.
 *
 * Settings: Boehsline config blocks "meeting" and "work" (watch/settings.ts), e.g.
 *      "meeting": { "qmdCollections": ["notes", "team-docs"], "dailyDir": "~/Notes/daily", "codeDir": "~/src", "owner": "earl" }
 *      "work":    { "providers": [...], "models": [...], "researchModel": "...", "ghHost": "github.acme.com" }
 *
 * Env (overrides settings):
 *      PI_MEETING_MODEL=provider/<id>[,…] (work providers only)  PI_MEETING_REASONING=off|low|…
 *      PI_MEETING_RESEARCH_MODEL=provider/<id> (else the session model, if it's a work model)
 *      PI_MEETING_ME="First Last"  PI_MEETING_ABOUT=<file>
 *      PI_MEETING_OWNER=<session name>  PI_MEETING_WATCH=1 (arm)  PI_MEETING_LOCK=<file>
 *      MEETING_CAPTURE_STATE_DIR  PI_MEETING_DIR (where /meeting replay looks for a transcript)
 *      PI_MEETING_QMD_COLLECTIONS=notes,team-docs ("" disables)
 *      PI_MEETING_DAILY_DIR=~/Notes/daily ("" disables the daily-note recap)  PI_MEETING_CODE_DIR=~/src
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { applyWorkSettings, estTokens, isWorkModel, modelSpecs, PROMPT_MAX_TOKENS, WORK_LABEL, WORK_MODELS, WORK_RESEARCH_MODEL, workOnly } from "../watch/models.ts";
import { MEETING_DEFAULTS, type MeetingSettings, meetingSettings, WORK_DEFAULTS, type WorkSettings, workSettings } from "../watch/settings.ts";
import { optIn } from "../../../lib/opt-in.ts";
import {
	type CaptureState,
	canClaim,
	clock,
	createLock,
	currentSlide,
	filterLive,
	filterRecords,
	formatLive,
	formatRec,
	formatStatus,
	isLive,
	isMine,
	type LiveLine,
	lastPeople,
	lockPath,
	markStopped,
	type Me,
	nameMatches,
	ocrPath,
	parseIndex,
	parseLive,
	parseRecord,
	parseRecords,
	pidAlive,
	promptLine,
	readLock,
	readStopped,
	type Rec,
	releaseLock,
	type SlideEntry,
	slideCount,
	slideFile,
	slideTimes,
	stateReader,
	statePath,
	statusReport,
	truncateLines,
	TOOL_LIMIT,
	type Via,
	writeLock,
} from "./capture.ts";

export * from "./capture.ts";

// ── config ───────────────────────────────────────────────────────────────────

/** Where /meeting replay looks for a transcript when given no path. */
const DIR = process.env.PI_MEETING_DIR || path.join(os.homedir(), ".local/share/meeting-capture");
const REASONING = process.env.PI_MEETING_REASONING || "low";
// Settings resolve at session_start (applyMeetingSettings); see watch/settings.ts.
let QMD_COLLECTIONS: string[] = MEETING_DEFAULTS.qmdCollections;
const ABOUT_FILE = process.env.PI_MEETING_ABOUT || path.join(os.homedir(), ".pi/agent/meeting-context.md");

let DAILY_DIR = MEETING_DEFAULTS.dailyDir;
let GH_HOST = WORK_DEFAULTS.ghHost;
let CODE_DIR = MEETING_DEFAULTS.codeDir;
let OWNER = MEETING_DEFAULTS.owner;

/** Refresh settings (and models.ts) from env + Boehsline config. */
export function applyMeetingSettings(m: MeetingSettings = meetingSettings(), work: WorkSettings = workSettings()): void {
	QMD_COLLECTIONS = m.qmdCollections;
	DAILY_DIR = m.dailyDir;
	GH_HOST = work.ghHost;
	CODE_DIR = m.codeDir;
	OWNER = m.owner;
	applyWorkSettings(work);
}
/** Research subagents: the session model unless overridden, read-only tools, a hard time cap. */
const DIG_MODEL = process.env.PI_MEETING_RESEARCH_MODEL || "";
const DIG_THINKING = process.env.PI_MEETING_RESEARCH_THINKING || "medium";
const DIG_TOOLS = "read,bash,web_search,web_fetch";
export const DIG_TIMEOUT_MS = 3 * 60_000;
const MAX_DIGS = 2;
const DIG_TRANSCRIPT_CHARS = 8000;

export const TRIGGER = { batch: 6, quietMs: 2500, maxWaitMs: 45_000, minGapMs: 15_000, flood: 14 };
/** Questions in the compact widget, and the least time one stays there unless answered. */
export const SHOWN = 3;
export const HOLD_MS = 3 * 60_000;
const MAX_ADD = 1;
const MAX_ADD_FIRST = 2;
const EXPANDED_ROWS = 18;
const POLL_MS = 1000;
const STATE_POLL_MS = 2000;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const OCR_MAX_CHARS = 8000;
const RENDER_MS = 10_000;
const MAX_TRANSCRIPT_CHARS = 100_000;
const PREV_TRANSCRIPT_CHARS = 16_000;
const CALL_TIMEOUT_MS = 60_000;
const BACKGROUND_WAIT_MS = 10_000;
const REPLY_TTL_MS = 3 * 60_000;
const NOTIFY_GAP_MS = 30_000;
const MSG_TYPE = "meeting";
const WIDGET_KEY = "meeting";
const INVITE_RE = /\bany (?:other |more |last )?questions\b|\bquestions\s*\?|\bthoughts\s*\?|\banyone (?:else )?(?:have|got) anything\b/i;

// ── transcript parsing ───────────────────────────────────────────────────────

export type MeetingEvent =
	| { kind: "meta"; title?: string; app?: string; startedAt?: string; stopped: boolean }
	| { kind: "line"; ts: string; speaker: string; text: string; chat: boolean }
	| { kind: "people"; people: string[] };

/** One meeting-capture jsonl record, normalized; null for anything unusable. */
export function parseEvent(raw: string): MeetingEvent | null {
	let ev: Record<string, unknown>;
	try {
		ev = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!ev || typeof ev !== "object") return null;
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (ev.type) {
		case "metadata":
			return {
				kind: "meta",
				title: str(ev.meeting) || undefined,
				app: str(ev.app) || undefined,
				startedAt: str(ev.meeting_started_at) || undefined,
				stopped: ev.event === "stopped",
			};
		case "caption":
		case "chat": {
			const text = str(ev.text).replace(/\s+/g, " ").trim();
			if (!text) return null;
			return { kind: "line", ts: str(ev.ts), speaker: str(ev.speaker) || "Unknown", text, chat: ev.type === "chat" };
		}
		case "people":
			return Array.isArray(ev.people)
				? { kind: "people", people: ev.people.filter((p): p is string => typeof p === "string") }
				: null;
		default:
			return null;
	}
}

export const formatLine = (l: { ts: string; speaker: string; text: string; chat: boolean }) =>
	`[${clock(l.ts)}] ${l.chat ? "(chat) " : ""}${l.speaker}: ${l.text}`;

/** Lowercase name parts of 3+ letters: "Rivera, Sam (ORG)" and "Sam Rivera" both → sam, rivera. */
export function nameTokens(name: string): string[] {
	const parts = name
		.replace(/\(.*?\)/g, " ")
		.split(/[^\p{L}'-]+/u)
		.map((s) => s.toLowerCase())
		.filter((s) => s.length >= 3);
	return [...new Set(parts)];
}

export function isMe(speaker: string, me: string[]): boolean {
	if (me.length === 0) return false;
	const sp = new Set(nameTokens(speaker));
	return me.every((t) => sp.has(t));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function mentionsMe(text: string, me: string[]): boolean {
	return me.some((t) => new RegExp(`(^|[^\\p{L}])${escapeRe(t)}($|[^\\p{L}])`, "iu").test(text));
}

export const isInvite = (text: string) => INVITE_RE.test(text);

// ── triggers ─────────────────────────────────────────────────────────────────

export type Cue = "mention" | "invite" | null;
export type TriggerState = {
	unsent: number; // lines since the last check
	firstUnsentAt: number; // arrival of the oldest unchecked line (ms)
	lastLineAt: number; // arrival of the newest line (ms)
	lastCallAt: number; // start of the last check (ms)
	cue: Cue;
};

export const freshTrigger = (): TriggerState => ({ unsent: 0, firstUnsentAt: 0, lastLineAt: 0, lastCallAt: 0, cue: null });

/**
 * Whether to spend a model call now. Pure, so the cadence is testable.
 * `final` (meeting over) drops the batch threshold: whatever is left gets one look.
 */
export function shouldFire(t: TriggerState, now: number, final = false, cfg = TRIGGER): "cue" | "batch" | null {
	if (t.unsent === 0) return null;
	const quiet = now - t.lastLineAt;
	// A cue is a fast path, not a gate: if talk runs on, the normal rules still apply.
	if (t.cue && quiet >= cfg.quietMs / 2) return "cue";
	if (now - t.lastCallAt < cfg.minGapMs) return null;
	if (t.unsent >= cfg.flood) return "batch";
	if (quiet < cfg.quietMs) return null;
	if (final || t.unsent >= cfg.batch || now - t.firstUnsentAt >= cfg.maxWaitMs) return "batch";
	return null;
}

// ── scout replies ────────────────────────────────────────────────────────────

export type Closure = { id: number; by: "asked" | "answered"; note: string };
export type ScoutUpdate = { topic: string; add: { q: string; why: string }[]; closed: Closure[]; top: number[]; reply: string };
export type Question = {
	id: number;
	q: string;
	why: string;
	at: number; // when it was added (ms), for the widget hold
	clock: string; // meeting time it was added, "HH:MM"
	status: "open" | "asked" | "answered";
	closedClock?: string;
	note?: string; // the answer, when one was given
	dig?: Dig; // a research subagent's run on this question
};

export type Dig = {
	state: "running" | "done" | "failed";
	startedAt: number;
	answer?: string; // one line, for the widget and the recap
	brief?: string;
	error?: string;
};

const toId = (v: unknown) => (typeof v === "number" ? v : Number.parseInt(String(v ?? "").replace(/^\s*Q/i, ""), 10));

/** The scout's JSON, tolerant of code fences, prose around it, and loose types. */
export function parseScoutReply(text: string): ScoutUpdate | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;
	const s = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
	const add = (Array.isArray(obj.add) ? obj.add : [])
		.map((a: unknown) => {
			if (typeof a === "string") return { q: s(a, 300), why: "" };
			const r = (a ?? {}) as Record<string, unknown>;
			return { q: s(r.q ?? r.question, 300), why: s(r.why, 200) };
		})
		.filter((a) => a.q);
	const closed = (Array.isArray(obj.closed) ? obj.closed : [])
		.map((c: unknown): Closure => {
			if (typeof c !== "object" || c === null) return { id: toId(c), by: "answered", note: "" };
			const r = c as Record<string, unknown>;
			return { id: toId(r.id), by: /ask/i.test(String(r.by ?? "")) ? "asked" : "answered", note: s(r.note ?? r.answer, 160) };
		})
		.filter((c) => Number.isFinite(c.id));
	const top = (Array.isArray(obj.top) ? obj.top : []).map(toId).filter((n) => Number.isFinite(n));
	return { topic: s(obj.topic, 80), add, closed, top, reply: s(obj.reply, 500) };
}

const normQ = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * Close what was answered or asked, then add (deduped against every question so
 * far, at most `maxAdd`). Nothing else ever leaves the list.
 */
export function applyUpdate(questions: Question[], u: ScoutUpdate, nextId: number, now: number, clock = "", maxAdd = MAX_ADD) {
	const byId = new Map(u.closed.map((c) => [c.id, c]));
	const closed: Question[] = [];
	const next = questions.map((q) => {
		const c = q.status === "open" ? byId.get(q.id) : undefined;
		if (!c) return q;
		const done: Question = { ...q, status: c.by, closedClock: clock, note: c.note };
		closed.push(done);
		return done;
	});
	const seen = new Set(next.map((q) => normQ(q.q)));
	const added: Question[] = [];
	for (const a of u.add.slice(0, maxAdd)) {
		const k = normQ(a.q);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		added.push({ id: nextId++, q: a.q, why: a.why, at: now, clock, status: "open" });
	}
	return { questions: [...next, ...added], added, closed, nextId };
}

export type Shown = { id: number; since: number };

/**
 * Which open questions the compact widget shows. `prefer` is best-first (new
 * questions, then the scout's ranking); the newest fill in after that. A new
 * question (`fresh`) shows at once; otherwise a shown question gives up its
 * slot only once it has had `holdMs` on screen. Either way it stays on the list.
 */
export function pickShown(
	shown: Shown[],
	questions: Question[],
	prefer: number[],
	now: number,
	fresh: number[] = [],
	n = SHOWN,
	holdMs = HOLD_MS,
): Shown[] {
	const open = new Set(questions.filter((q) => q.status === "open").map((q) => q.id));
	const newest = [...open].sort((a, b) => b - a);
	const rank = [...new Set([...prefer, ...newest])].filter((id) => open.has(id));
	const want = rank.slice(0, n);
	const out = shown.filter((s) => open.has(s.id));
	const held = (s: Shown) => now - s.since >= holdMs;
	for (const id of want) {
		if (out.some((s) => s.id === id)) continue;
		if (out.length < n) {
			out.push({ id, since: now });
			continue;
		}
		// Worst-ranked first, and anything past its hold before anything that isn't.
		const victim = out
			.filter((s) => !want.includes(s.id) && (fresh.includes(id) || held(s)))
			.sort((a, b) => Number(held(b)) - Number(held(a)) || rank.indexOf(b.id) - rank.indexOf(a.id))[0];
		if (!victim) continue;
		out[out.indexOf(victim)] = { id, since: now };
	}
	return out.sort((a, b) => a.id - b.id);
}

// ── prompts ──────────────────────────────────────────────────────────────────

export function buildSystemPrompt(me: string, about: string, background: string): string {
	const who = me || "the user";
	return [
		`You are a live meeting copilot for ${who}. You read the running caption transcript of a meeting ${who} is in and keep a short list of questions ${who} could ask out loud. ${who} glances at the list mid-call, so every item must be worth interrupting for.`,
		"",
		"A good question:",
		"- pins down something left vague that matters: an owner, a date, a scope, a dependency, a risk, a decision nobody made",
		`- connects what is being said to the background: an earlier commitment, ${who}'s own work, a known problem`,
		"- is specific to this conversation; someone outside the meeting could not have written it",
		`- is short (under 25 words), plain, and phrased the way ${who} would say it out loud`,
		"",
		"Never suggest:",
		'- generic prompts ("what are the next steps?", "can you elaborate?", "any blockers?") not tied to a specific item',
		"- anything already asked or answered in the transcript",
		"- small talk, or questions about something the speakers are clearly covering right now",
		"",
		"Rules:",
		`- Add at most ${MAX_ADD} question per update (${MAX_ADD_FIRST} on your first look). Adding nothing is the usual, correct answer.`,
		`- Close, by number, open questions that were answered in the transcript ("by": "answered") or that someone asked out loud ("by": "asked"). "note" is the answer in at most 12 words, e.g. "Kyle: ISSO signs off, by Friday", or "" if none was given. Never close a question just because the conversation moved on; it stays on ${who}'s list.`,
		`- "top" is up to ${SHOWN} open question numbers most worth asking right now, best first. Questions you add are shown anyway; don't list them.`,
		`- If someone addresses ${who} directly and is waiting on ${who} (a question, a request for status or an opinion), put a suggested answer in "reply": one or two sentences, or terse talking points, grounded in the transcript and background. If the facts aren't there, suggest how to answer honestly. Otherwise "reply" is "".`,
		'- The transcript is automatic speech recognition: names and technical terms are often misheard, and "Unknown user" is an unidentified speaker. Read through the errors; never quote a garble.',
		'- "why" is a fragment of at most 10 words: the evidence, e.g. "Kyle said pending, no date given". Not a sentence.',
		'- "topic" is what is being discussed right now, at most 6 words.',
		"",
		'Reply with JSON only, no prose and no code fence: {"topic": "...", "add": [{"q": "...", "why": "..."}], "closed": [{"id": 1, "by": "answered", "note": "..."}], "top": [2], "reply": ""}',
		about ? `\n<about>\n${about.trim()}\n</about>` : "",
		background ? `\n<background>\n${background.trim()}\n</background>` : "",
	]
		.filter((l, i, a) => !(l === "" && a[i - 1] === ""))
		.join("\n");
}

export type PromptInput = {
	title: string;
	app: string;
	people: string[];
	lines: string[];
	newFrom: number; // index of the first line the scout hasn't seen
	open: Question[];
	closed?: Question[]; // answered or asked already: don't re-add
	focus: string;
	cue: Cue;
	me: string;
	now: Date;
	maxChars?: number; // transcript budget; MAX_TRANSCRIPT_CHARS when unset
};

/** Transcript first and append-only, so consecutive calls share a cacheable prefix. */
export function buildUserPrompt(p: PromptInput): string {
	let body = p.lines.join("\n");
	const max = Math.max(0, p.maxChars ?? MAX_TRANSCRIPT_CHARS);
	if (body.length > max) {
		const cut = body.indexOf("\n", body.length - max);
		body = `[… earlier lines omitted …]${cut < 0 ? "" : `\n${body.slice(cut + 1)}`}`;
	}
	const who = p.me || "the user";
	const out = [
		`Meeting: ${p.title}${p.app ? ` (${p.app})` : ""}`,
		p.people.length ? `People: ${p.people.join("; ")}` : "",
		"",
		"<transcript>",
		body || "(nothing yet)",
		"</transcript>",
		"",
		`Now: ${p.now.toTimeString().slice(0, 8)}`,
		p.newFrom <= 0 ? "This is your first look." : `New since your last update: the lines from ${(p.lines[p.newFrom] ?? "").slice(0, 60)} on.`,
		"Open questions:",
		...(p.open.length ? p.open.map((q) => `Q${q.id}: ${q.q}${q.why ? ` (${q.why})` : ""}`) : ["(none)"]),
		...(p.closed?.length ? ["Already answered or asked (don't add again):", ...p.closed.map((q) => `Q${q.id}: ${q.q}`)] : []),
	];
	if (p.focus) out.push("", `${who}'s goals for this meeting: ${p.focus}`);
	if (p.cue === "mention") out.push("", `${who} was just named in the new lines. Check whether someone is waiting on ${who}.`);
	if (p.cue === "invite") out.push("", "Someone just invited questions. If one question is clearly the best, make sure it is open.");
	return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/**
 * The user prompt, keeping less of the transcript's start until system + user
 * fit under the cap. The newest lines are what the scout needs most.
 */
export function fitUserPrompt(system: string, p: PromptInput, cap = PROMPT_MAX_TOKENS): string {
	let maxChars = Math.min(p.maxChars ?? MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_CHARS);
	let user = buildUserPrompt({ ...p, maxChars });
	for (let i = 0; i < 8 && maxChars > 0; i++) {
		const over = estTokens(system) + estTokens(user) - cap;
		if (over <= 0) break;
		maxChars = Math.max(0, maxChars - over * 3 - 500);
		user = buildUserPrompt({ ...p, maxChars });
	}
	return user;
}

/** What code says when a cue lands and no scout can: who named you, or who asked for questions. */
export function ruleAlert(cue: Cue, line: { speaker: string; text: string } | undefined): string {
	if (!cue) return "";
	const who = line?.speaker || "Someone";
	const text = (line?.text ?? "").replace(/\s+/g, " ").trim();
	const said = text ? `: "${text.length > 140 ? `${text.slice(0, 139)}…` : text}"` : "";
	return cue === "mention" ? `${who} named you${said}` : `${who} asked for questions${said}`;
}

/** /q research runs only on a work model: PI_MEETING_RESEARCH_MODEL, else the session model, else WORK_RESEARCH_MODEL. */
export function researchModel(configured: string, session: string): { model: string; refused: string } {
	if (configured) return isWorkModel(configured) ? { model: configured, refused: "" } : { model: WORK_RESEARCH_MODEL, refused: configured };
	if (session && isWorkModel(session)) return { model: session, refused: "" };
	return { model: WORK_RESEARCH_MODEL, refused: session };
}

// ── files ────────────────────────────────────────────────────────────────────

/** "20261005_125906-teams-weekly-sync.jsonl" → "teams-weekly-sync". */
export const meetingKey = (name: string) => path.basename(name).replace(/^\d{8}_\d{6}-/, "").replace(/\.(jsonl|txt)$/, "");
const stamp = (name: string) => /^(\d{8}_\d{6})-/.exec(path.basename(name))?.[1] ?? "";

export const isCandidate = (name: string) =>
	/^\d{8}_\d{6}-.+\.jsonl$/.test(name) && !/-slack-notifications-|-test-|-merged\./.test(name);

/** Newest candidate whose name contains `filter`; names sort by capture time. */
export function pickNewest(names: string[], filter = ""): string | undefined {
	const f = filter.toLowerCase();
	return names
		.filter((n) => isCandidate(n) && (!f || n.toLowerCase().includes(f)))
		.sort()
		.pop();
}

/** A capture that began at/after `since`, matching `key` (exact) or `filter` (substring). */
export function pickStartedSince(names: string[], since: string, opts: { key?: string; filter?: string } = {}): string | undefined {
	const f = (opts.filter ?? "").toLowerCase();
	return names
		.filter((n) => isCandidate(n) && stamp(n) >= since)
		.filter((n) => (opts.key ? meetingKey(n) === opts.key : !f || n.toLowerCase().includes(f)))
		.sort()
		.pop();
}

/** Largest .txt over 1 KB of the same meeting from the most recent earlier day. */
export function previousTranscript(files: { name: string; size: number }[], current: string): string | undefined {
	const key = meetingKey(current);
	const day = stamp(current).slice(0, 8);
	const prior = files.filter(
		(f) => f.name.endsWith(".txt") && f.size > 1024 && meetingKey(f.name) === key && stamp(f.name).slice(0, 8) < day && stamp(f.name),
	);
	const lastDay = prior.map((f) => stamp(f.name).slice(0, 8)).sort().pop();
	if (!lastDay) return undefined;
	return prior.filter((f) => stamp(f.name).startsWith(lastDay)).sort((a, b) => b.size - a.size)[0]?.name;
}

/** Local time as a filename stamp, for "captures that started after X". */
export function toStamp(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── recap ────────────────────────────────────────────────────────────────────

const clockSpan = (q: Question) => (q.closedClock && q.closedClock !== q.clock ? `${q.clock}–${q.closedClock}` : q.clock);
const paren = (bits: (string | undefined)[]) => {
	const s = bits.filter(Boolean).join("; ");
	return s ? ` (${s})` : "";
};

/** Every question by outcome: plain markdown that reads the same in a terminal and in Obsidian. */
export function recapBody(questions: Question[]): string[] {
	if (questions.length === 0) return ["No questions came up."];
	const researched = (q: Question) => (q.dig?.state === "done" && q.dig.answer ? [`  - Researched: ${q.dig.answer}`] : []);
	const group = (label: string, qs: Question[], line: (q: Question) => string) =>
		qs.length ? [label, ...qs.flatMap((q) => [line(q), ...researched(q)]), ""] : [];
	const closedLine = (q: Question) => `- Q${q.id} ${q.q}${q.note ? ` → ${q.note}` : ""}${paren([clockSpan(q)])}`;
	const out = [
		...group("Still open (never asked):", questions.filter((q) => q.status === "open"), (q) => `- Q${q.id} ${q.q}${paren([q.clock, q.why])}`),
		...group("Answered:", questions.filter((q) => q.status === "answered"), closedLine),
		...group("Asked:", questions.filter((q) => q.status === "asked"), closedLine),
	];
	while (out.at(-1) === "") out.pop();
	return out;
}

/** Hidden marker that ties a daily-note block to its capture, so a rewrite replaces it. */
export const recapMarker = (file: string) => `<!-- meeting-copilot:${path.basename(file).replace(/\.(jsonl|txt)$/, "")} -->`;

export type RecapInput = { title: string; file: string; from: string; to: string; checks: number; questions: Question[] };

export function recapBlock(r: RecapInput): string {
	const span = [r.from, r.to].filter(Boolean).join("–");
	return [
		`### ${span ? `${span} ` : ""}${r.title} · copilot questions`,
		recapMarker(r.file),
		`Transcript: \`${r.file.replace(/\.jsonl$/, ".txt").replace(os.homedir(), "~")}\` · ${r.checks} check${r.checks === 1 ? "" : "s"}`,
		"",
		...recapBody(r.questions),
	].join("\n");
}

/**
 * Put `block` in `note`: over the block carrying `marker` if there is one, else
 * at the end of the `heading` section, else in a new section at the end. The
 * rest of the note is left byte-for-byte alone.
 */
export function upsertRecap(note: string, block: string, marker: string, heading = "## Meetings"): string {
	const lines = note.replace(/\n+$/, "").split("\n");
	const body = block.replace(/\n+$/, "").split("\n");
	const nextHeading = (from: number, re: RegExp) => {
		const i = lines.findIndex((l, j) => j > from && re.test(l));
		return i < 0 ? lines.length : i;
	};
	const splice = (start: number, end: number) => {
		const tail = lines.slice(end);
		return `${[...lines.slice(0, start), ...body, ...(tail.length ? ["", ...tail] : [])].join("\n")}\n`;
	};
	const mi = lines.findIndex((l) => l.includes(marker));
	if (mi >= 0) return splice(mi > 0 && /^###\s/.test(lines[mi - 1] ?? "") ? mi - 1 : mi, nextHeading(mi, /^#{1,6}\s/));
	const hi = lines.findIndex((l) => l.trim() === heading);
	if (hi < 0) return `${note.trim() ? `${lines.join("\n")}\n\n` : ""}${heading}\n\n${body.join("\n")}\n`;
	const end = nextHeading(hi, /^#{1,2}\s/);
	let at = end;
	while (at > hi + 1 && (lines[at - 1] ?? "").trim() === "") at--;
	const tail = lines.slice(end);
	return `${[...lines.slice(0, at), "", ...body, ...(tail.length ? ["", ...tail] : [])].join("\n")}\n`;
}

/** The daily note for the day the capture started: daily/YYYY-MM-DD.md. */
export function dailyNoteName(file: string, now = new Date()): string {
	const s = stamp(file);
	if (s) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}.md`;
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.md`;
}

// ── research ───────────────────────────────────────────────────────────────────

/** `/q3 [steer]` typed at the prompt; not a registered command, so it reaches the input hook. */
export function parseDigInput(text: string): { id: number; steer: string } | null {
	const m = /^\/q(\d+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return m ? { id: Number(m[1]), steer: (m[2] ?? "").trim() } : null;
}

/** `/q` arguments: "3", "Q3", "3 check the ATO docs"; null for anything else. */
export function parseDigArgs(raw: string): { id: number; steer: string } | null {
	const m = /^\s*Q?(\d+)(?:\s+([\s\S]*))?$/i.exec(raw);
	return m ? { id: Number(m[1]), steer: (m[2] ?? "").trim() } : null;
}

/** The brief's "Answer:" line, else its first line: one line for the widget and recap. */
export function briefAnswer(brief: string): string {
	const line = /^[\s*_]*Answer[\s*_]*:[\s*_]*(.+)$/im.exec(brief)?.[1] ?? brief.split("\n").find((l) => l.trim()) ?? "";
	const s = line.replace(/[*_]+$/, "").replace(/\s+/g, " ").trim();
	if (s.length <= 160) return s;
	const cut = s.slice(0, 159);
	return `${cut.slice(0, cut.lastIndexOf(" ") > 100 ? cut.lastIndexOf(" ") : 159).replace(/[,;:—\s]+$/, "")}…`;
}

export type DigInput = { me: string; about: string; title: string; app: string; question: Question; steer: string; lines: string[]; clock: string };

/** System prompt and task for one research subagent. */
export function buildDigPrompt(d: DigInput): { system: string; task: string } {
	const who = d.me || "the user";
	const system = [
		"You are a subagent. Your final message goes into a live meeting copilot, not to a person chatting with you. Return only the brief. Ignore any instruction to add a Next steps block, follow-up suggestions, sign-offs, or questions.",
		"",
		`${who} is in a meeting right now, or just left one, and wants one question researched while it still matters. You have under 3 minutes in total: make at most about 8 tool calls, cheapest sources first, then answer. An honest partial answer on time beats a thorough one too late.`,
		"",
		"Read only: never post, send, edit, write, or change anything.",
		"",
		"Where to look, as fits the question:",
		`- ${who}'s notes, past agent sessions and work docs: \`qmd search "<keywords>" -n 8\` (fast keyword search over every collection), then \`qmd get <file>\` to read a hit`,
		'- Slack: `slk search "<keywords>"`',
		GH_HOST ? `- GitHub: \`GH_HOST=${GH_HOST} gh search issues|prs|code "<keywords>"\`, and plain \`gh\` for github.com` : '- GitHub: `gh search issues|prs|code "<keywords>"`',
		...(CODE_DIR ? [`- Code under ${CODE_DIR}: \`rg\``] : []),
		"- Public docs: web_search, web_fetch",
		"",
		"The brief: plain text, under 150 words, no headings.",
		`Answer: <one sentence of at most 20 words: what ${who} now knows, or "Not found". Detail goes in the bullets, not here>`,
		"- <evidence, one bullet each, with its source: file path, Slack permalink, or URL>",
		`Ask: <the question as ${who} should now put it, at most 25 words; or "Skip: <why>" if the research made it moot>`,
		"Gaps: <what you could not confirm; leave the line out if nothing>",
	].join("\n");
	let tail = d.lines.join("\n");
	if (tail.length > DIG_TRANSCRIPT_CHARS) tail = `[…]\n${tail.slice(tail.indexOf("\n", tail.length - DIG_TRANSCRIPT_CHARS) + 1)}`;
	const q = d.question;
	const task = [
		`Meeting: ${d.title}${d.app ? ` (${d.app})` : ""}${d.clock ? ` · now ${d.clock}` : ""}`,
		`Research Q${q.id}: ${q.q}`,
		q.why ? `Why it came up: ${q.why}` : "",
		q.note ? `Already said in the meeting: ${q.note}` : "",
		d.steer ? `${who} adds: ${d.steer}` : "",
		d.about ? `\n<about>\n${d.about.trim()}\n</about>` : "",
		`\n<transcript, the latest part>\n${tail || "(empty)"}\n</transcript>`,
	]
		.filter(Boolean)
		.join("\n");
	return { system, task };
}

// ── args ─────────────────────────────────────────────────────────────────────

export type Args = {
	sub: "status" | "watch" | "replay" | "start" | "stop" | "ask" | "focus" | "list" | "recap" | "unknown";
	target: string; // replay: the transcript path, "" for the newest
	rest: string;
	replay?: number; // replay speed
	model?: string; // replay: the scout model
};

export function parseArgs(raw: string): Args {
	const trimmed = raw.trim();
	const first = trimmed.split(/\s+/)[0] ?? "";
	const known = ["watch", "replay", "start", "stop", "ask", "focus", "status", "list", "recap"] as const;
	const word = first === "expand" ? "list" : first;
	const sub = (known as readonly string[]).includes(word) ? (word as Args["sub"]) : trimmed ? "unknown" : "status";
	const rest = trimmed.slice(first.length).trim();
	const out: Args = { sub, target: "", rest };
	if (sub !== "replay") return out;
	const tokens = rest.split(/\s+/).filter(Boolean);
	const target: string[] = [];
	out.replay = 10;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		const n = Number(t);
		if (t === "--model") out.model = tokens[++i];
		else if (target.length === 0 && Number.isFinite(n) && n > 0) out.replay = n;
		else target.push(t);
	}
	out.target = target.join(" ").replace(/^~(?=\/|$)/, os.homedir());
	return out;
}

// ── widget ───────────────────────────────────────────────────────────────────

export type WidgetView = {
	phase: "waiting" | "live" | "ended";
	title: string;
	startedMs: number;
	topic: string;
	checks: number;
	cost: number;
	busy: boolean;
	error: string;
	questions: Question[];
	shown: number[]; // ids for the compact view
	expanded: boolean;
	reply: string;
	replay: boolean;
	endsAt: number; // when an ended call stops, if it is counting down (ms); 0 for none
	alert?: string; // a cue said by code rules, when no scout could
	rulesOnly?: boolean; // no work model: cues only, no questions
};

export function humanElapsed(ms: number): string {
	const m = Math.max(0, Math.floor(ms / 60_000));
	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

const mmss = (ms: number) => {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const mmssSince = (t: number) => mmss(Date.now() - t);

export function widgetLines(v: WidgetView, theme: Pick<Theme, "fg">, width: number, now = Date.now()): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const fit = (s: string) => truncateToWidth(s, width);
	if (v.phase === "waiting") {
		return [fit(`${dim("◌")} ${dim(["meeting", v.title, "waiting for captions", "/meeting stop"].filter(Boolean).join(" · "))}`)];
	}
	const digging = v.questions.some((q) => q.dig?.state === "running");
	const ended = v.replay
		? digging
			? "replay done · finishing research"
			: "replay done"
		: v.endsAt > now
			? `call ended · stopping in ${mmss(v.endsAt - now)} unless it resumes`
			: digging
				? "call ended · finishing research"
				: "call ended";
	const icon = v.error ? theme.fg("warning", "✕") : v.busy ? theme.fg("accent", "◐") : theme.fg("accent", "●");
	const bits = [
		`meeting${v.replay ? " (replay)" : ""}`,
		v.title,
		v.startedMs ? humanElapsed(now - v.startedMs) : "",
		v.phase === "ended" ? ended : v.topic,
		v.rulesOnly ? "rules only" : `${v.checks} check${v.checks === 1 ? "" : "s"}${v.cost > 0 ? ` $${v.cost.toFixed(3)}` : ""}`,
		v.busy ? "checking…" : "",
		v.error ? `error: ${v.error}` : "",
		"/meeting stop",
	].filter(Boolean);
	const lines = [fit(`${icon} ${dim(bits.join(" · "))}`)];
	const inner = Math.max(10, width - 4);
	const open = v.questions.filter((q) => q.status === "open");
	const done = v.questions.filter((q) => q.status !== "open");
	const digTag = (q: Question) =>
		q.dig?.state === "running"
			? theme.fg("warning", ` 🔎 ${mmss(now - q.dig.startedAt)}`)
			: q.dig?.state === "failed"
				? theme.fg("warning", " 🔎✕")
				: q.dig?.state === "done"
					? theme.fg("success", " 🔎✓")
					: "";
	const id = (q: Question) => theme.fg("accent", `Q${q.id}`) + digTag(q);
	if (v.expanded) {
		// One line each: all open questions, then the closed ones while they fit.
		const openRows = open.length > EXPANDED_ROWS ? EXPANDED_ROWS - 1 : open.length;
		for (const q of open.slice(0, openRows)) lines.push(fit(`  ${id(q)} ${q.q}${q.why ? dim(` — ${q.why}`) : ""}`));
		if (open.length > openRows) lines.push(fit(dim(`  +${open.length - openRows} more open · /meeting recap`)));
		const room = EXPANDED_ROWS - Math.min(open.length, EXPANDED_ROWS);
		const doneRows = done.length > room ? Math.max(0, room - 1) : done.length;
		for (const q of doneRows ? done.slice(-doneRows) : [])
			lines.push(fit(dim(`  ✓ Q${q.id} ${q.q}${q.note ? ` → ${q.note}` : ` (${q.status})`}`)));
		if (done.length > doneRows) lines.push(fit(dim(`  ✓ ${done.length - doneRows} more answered or asked · /meeting recap`)));
		if (v.questions.length === 0) lines.push(fit(dim("  no questions yet")));
		else lines.push(fit(dim("  /meeting list to collapse")));
	} else {
		const shown = open.filter((q) => v.shown.includes(q.id));
		for (const q of shown) {
			const wrapped = wrapTextWithAnsi(`${id(q)} ${q.q}${q.why ? dim(` — ${q.why}`) : ""}`, inner);
			for (const l of wrapped.slice(0, 3)) lines.push(fit(`  ${l}`));
			if (q.dig?.state === "done" && q.dig.answer) lines.push(fit(`    ${theme.fg("success", `→ ${q.dig.answer}`)}`));
		}
		const more = open.length - shown.length;
		const bits2 = [more > 0 ? `+${more} more open` : "", done.length ? `${done.length} answered or asked` : ""].filter(Boolean);
		if (bits2.length) lines.push(fit(dim(`  ${bits2.join(" · ")} · /meeting list`)));
	}
	if (v.reply) {
		for (const l of wrapTextWithAnsi(theme.fg("success", `↳ say: ${v.reply}`), inner).slice(0, 4)) lines.push(fit(`  ${l}`));
	}
	if (v.alert) {
		for (const l of wrapTextWithAnsi(theme.fg("warning", `! ${v.alert}`), inner).slice(0, 3)) lines.push(fit(`  ${l}`));
	}
	return lines;
}

// ── runtime ──────────────────────────────────────────────────────────────────

type Meeting = {
	phase: WidgetView["phase"];
	auto?: { startedAt: string; slidesDir: string | null; via: Via }; // started from state.json, not a replay
	file: string; // current .jsonl, "" while waiting for captions
	offset: number;
	partial: string;
	replay?: {
		speed: number;
		events: { at: number; ev: MeetingEvent }[];
		next: number;
		t0: number;
		startedAt: number;
		recs: Rec[]; // every record, for the meeting tool (it shows only what has played)
		first: string; // ts of the first record
		last: number; // ms of the last
		slidesDir: string | null;
	};
	title: string;
	app: string;
	startedMs: number;
	people: string[];
	slides: number; // distinct slide events seen
	slideOn?: number; // the slide on screen
	lines: string[];
	sentUpTo: number;
	trig: TriggerState;
	questions: Question[]; // every question so far; only answered/asked ones close
	shown: Shown[];
	expanded: boolean;
	firstFile: string; // the capture the meeting started in; keys the daily-note recap
	nextId: number;
	topic: string;
	reply: string;
	replyAt: number;
	cueLine?: { speaker: string; text: string }; // the line behind the pending cue
	alert: string; // from code rules; shown like a reply
	alertAt: number;
	focus: string;
	me: string;
	meTokens: string[];
	models: Model<Api>[];
	modelLabel: string;
	system: string;
	backgroundReady?: Promise<void>;
	sessionId: string;
	checks: number;
	cost: number;
	busy: boolean;
	forceNext: boolean;
	error: string;
	abort?: AbortController;
	endedAt: number;
	lastRender: number;
	lastNotify: number;
	announced: boolean;
};

const run = (cmd: string, args: string[], timeout: number) =>
	new Promise<string>((resolve) => {
		execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
	});

async function readTail(file: string, max: number): Promise<string> {
	try {
		const fh = await fs.promises.open(file, "r");
		try {
			const { size } = await fh.stat();
			const len = Math.min(size, max);
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, size - len);
			const text = buf.toString("utf8");
			return len < size ? text.slice(text.indexOf("\n") + 1) : text;
		} finally {
			await fh.close();
		}
	} catch {
		return "";
	}
}

async function qmdNotes(title: string): Promise<string> {
	if (QMD_COLLECTIONS.length === 0 || title.replace(/\W/g, "").length < 4) return "";
	const args = ["search", title, ...QMD_COLLECTIONS.flatMap((c) => ["-c", c]), "-n", "6", "--json"];
	const out = await run("qmd", args, 8000);
	try {
		const hits = JSON.parse(out) as { file?: string; title?: string; snippet?: string }[];
		return hits
			.map((h) => {
				const snippet = String(h.snippet ?? "")
					.replace(/^@@[^\n]*\n/, "")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 600);
				return `- ${String(h.file ?? "").replace(/^qmd:\/\//, "")}: ${snippet}`;
			})
			.join("\n");
	} catch {
		return "";
	}
}

function main(pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;
	let st: Meeting | undefined;
	/** The meeting that just finished: /q can still research its questions. */
	let last: Meeting | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ticking = false;

	// Auto start and ownership (see the header). `armed` is /meeting watch, saved
	// in the session; PI_MEETING_WATCH=1 arms without saving.
	let armed = false;
	let holding = false; // this session has written the lock and not released it
	let yielded = false; // the lock went to someone else: no re-claim until it frees
	let stateTimer: ReturnType<typeof setInterval> | undefined;
	let stateTicking = false;
	/** Bumped on shutdown: an await that finds it changed belongs to a dead instance and must do nothing more. */
	let gen = 0;
	const readState = stateReader();
	const doneStarts = new Set<string>(); // started_at of meetings that ended or were stopped
	const ENTRY = "meeting-watch";
	const envArmed = () => /^(1|true|yes|on)$/i.test(process.env.PI_MEETING_WATCH ?? "");
	const isArmed = () => armed || envArmed();
	const sessionName = () => pi.getSessionName?.();
	const eligibleVia = (): Via | undefined => (isArmed() ? "watch" : nameMatches(OWNER, sessionName()) ? "owner" : undefined);
	const lockMe = (via: Via): Me => ({ pid: process.pid, sessionId: ctxRef?.sessionManager?.getSessionId?.() ?? "", name: sessionName() ?? "", via });

	type DigRun = { m: Meeting; id: number; proc: ChildProcess; cancelled: boolean };
	const digRuns = new Set<DigRun>();
	const digging = (m: Meeting) => m.questions.some((q) => q.dig?.state === "running");
	const cancelDigs = (m?: Meeting) => {
		for (const r of digRuns) {
			if (m && r.m !== m) continue;
			r.cancelled = true;
			r.proc.kill("SIGTERM");
			digRuns.delete(r);
			setDig(r.m, r.id, { state: "failed", startedAt: r.m.questions.find((q) => q.id === r.id)?.dig?.startedAt ?? 0, error: "cancelled" });
		}
	};
	function setDig(m: Meeting, id: number, dig: Dig) {
		m.questions = m.questions.map((q) => (q.id === id ? { ...q, dig } : q));
	}

	// Timers outlive the command that started them, so they use the session's
	// own context rather than a command context.
	/** Whether /meeting watch was last on or off in this branch. */
	function restoreArmed(ctx: ExtensionContext) {
		armed = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY) armed = (entry.data as { armed?: boolean } | undefined)?.armed === true;
		}
	}
	pi.on("session_start", (_e, ctx) => {
		ctxRef = ctx;
		applyMeetingSettings();
		restoreArmed(ctx);
		if (stateTimer) clearInterval(stateTimer);
		stateTimer = setInterval(() => void stateTick(), STATE_POLL_MS);
		stateTimer.unref?.();
		void stateTick();
	});
	pi.on("session_tree", (_e, ctx) => restoreArmed(ctx));
	pi.on("session_shutdown", () => {
		gen++;
		if (stateTimer) clearInterval(stateTimer);
		stateTimer = undefined;
		// Quitting mid-meeting still leaves the recap in the daily note.
		if (st && !st.replay && st.questions.length) writeRecap(st);
		if (st && !st.replay) pi.events.emit("meeting:state", { active: false, title: st.title });
		teardown();
		cancelDigs();
		release();
		ctxRef = undefined;
	});
	// watch.ts holds its digests during a live meeting; it asks when it starts.
	pi.events.on("meeting:query", () => {
		if (st && !st.replay && st.phase === "live") pi.events.emit("meeting:state", { active: true, title: st.title });
	});

	pi.registerMessageRenderer(MSG_TYPE, (message, options, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		const styled = text
			.split("\n")
			.map((l, i) =>
				i === 0
					? `${theme.fg("accent", "◆")} ${theme.fg("dim", l)}`
					: l.startsWith("−") || l.startsWith("✓")
						? theme.fg("dim", l)
						: l.startsWith("↳") || l.startsWith("Answer:")
							? theme.fg("success", l)
							: l,
			)
			.join("\n");
		return new Text(styled, options.outputPad ?? 1, 0);
	});

	// ── lifecycle ──

	/** `done`: this meeting is over, so its started_at never starts again. */
	function teardown(done = true) {
		if (timer) clearInterval(timer);
		timer = undefined;
		st?.abort?.abort();
		if (st?.auto && done) doneStarts.add(st.auto.startedAt);
		if (st) {
			cancelDigs(st); // only /meeting stop gets here with research running; a natural end waits
			last = st;
		}
		st = undefined;
		if (ctxRef?.mode === "tui") ctxRef.ui.setWidget(WIDGET_KEY, undefined);
	}

	const lineClock = (l?: string) => /^\[(\d\d:\d\d)/.exec(l ?? "")?.[1] ?? "";
	const tilde = (p: string) => p.replace(os.homedir(), "~");

	function notePath(m: Meeting): string | undefined {
		if (m.replay || !DAILY_DIR || !fs.existsSync(DAILY_DIR)) return undefined;
		return path.join(DAILY_DIR, dailyNoteName(m.firstFile || m.file));
	}

	/** Write or rewrite this meeting's block under ## Meetings. Sync: it also runs from session_shutdown. */
	function writeRecap(m: Meeting): string | undefined {
		const file = notePath(m);
		if (!file) return undefined;
		const source = m.firstFile || m.file;
		const block = recapBlock({
			title: m.title,
			file: source,
			from: lineClock(m.lines[0]),
			to: lineClock(m.lines.at(-1)),
			checks: m.checks,
			questions: m.questions,
		});
		try {
			const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
			fs.writeFileSync(file, upsertRecap(before, block, recapMarker(source)));
			return file;
		} catch (e) {
			if (ctxRef?.hasUI) ctxRef.ui.notify(`Meeting recap not written to ${tilde(file)}: ${(e as Error).message}`, "error");
			return undefined;
		}
	}

	/** Post the recap to the session (and the daily note, unless it's a replay or empty). */
	function postRecap(m: Meeting, headline: string) {
		const note = m.questions.length ? writeRecap(m) : undefined;
		pi.sendMessage(
			{
				customType: MSG_TYPE,
				content: [`${headline}${note ? ` · recap in ${tilde(note)}` : ""}`, ...recapBody(m.questions)].join("\n"),
				display: true,
				details: { kind: "recap", questions: m.questions, note },
			},
			{ triggerTurn: false },
		);
	}

	function finish(reason: string) {
		const m = st;
		if (!m) return;
		if (!m.replay) pi.events.emit("meeting:state", { active: false, title: m.title });
		if (reason === "/meeting stop" && m.auto) {
			// Shared, so another session or a /reload doesn't start it again.
			try {
				markStopped(m.auto.startedAt);
			} catch {
				// this session still won't restart it: teardown remembers it
			}
		}
		if (m.announced) {
			postRecap(m, `Meeting copilot stopped (${reason}) · ${m.checks} checks · transcript: ${tilde(m.file.replace(/\.jsonl$/, ".txt"))}`);
		} else if (ctxRef?.hasUI) {
			ctxRef.ui.notify(`Meeting copilot stopped (${reason})`, "info");
		}
		// Only an ended or stopped meeting is done; "watch off" / "no longer armed" can be armed again mid-meeting.
		teardown(reason === "meeting ended" || reason === "/meeting stop");
	}

	function render(force = false) {
		const m = st;
		const ctx = ctxRef;
		if (!m || ctx?.mode !== "tui") return;
		const now = Date.now();
		if (!force && now - m.lastRender < RENDER_MS) return;
		m.lastRender = now;
		if (m.reply && now - m.replyAt > REPLY_TTL_MS) m.reply = "";
		if (m.alert && now - m.alertAt > REPLY_TTL_MS) m.alert = "";
		const view: WidgetView = {
			phase: m.phase,
			title: m.title,
			startedMs: m.startedMs,
			topic: m.topic,
			checks: m.checks,
			cost: m.cost,
			busy: m.busy,
			error: m.error,
			questions: m.questions,
			shown: m.shown.map((s) => s.id),
			expanded: m.expanded,
			reply: m.reply,
			replay: !!m.replay,
			endsAt: 0,
			alert: m.alert,
			rulesOnly: m.models.length === 0,
		};
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({ render: (width: number) => widgetLines(view, theme, width), invalidate() {} }),
			{ placement: "aboveEditor" },
		);
	}

	// ── ingest ──

	function ingest(ev: MeetingEvent, now: number, history: boolean) {
		const m = st;
		if (!m) return;
		if (ev.kind === "meta") {
			if (ev.title) m.title = ev.title;
			if (ev.app) m.app = ev.app;
			if (ev.startedAt) m.startedMs = Date.parse(ev.startedAt) || m.startedMs;
			if (ev.stopped) {
				m.phase = "ended";
				m.endedAt = now;
			}
			return;
		}
		if (ev.kind === "people") {
			m.people = ev.people;
			return;
		}
		m.lines.push(formatLine(ev));
		if (!m.trig.unsent) m.trig.firstUnsentAt = history ? 0 : now;
		m.trig.unsent++;
		m.trig.lastLineAt = history ? 0 : now;
		if (history || isMe(ev.speaker, m.meTokens)) return;
		if (mentionsMe(ev.text, m.meTokens)) {
			m.trig.cue = "mention";
			m.cueLine = { speaker: ev.speaker, text: ev.text };
			if (ctxRef?.hasUI && now - m.lastNotify > NOTIFY_GAP_MS) {
				m.lastNotify = now;
				ctxRef.ui.notify(`Meeting: ${ev.speaker}: ${ev.text.slice(0, 140)}`, "info");
			}
		} else if (!m.trig.cue && isInvite(ev.text)) {
			m.trig.cue = "invite";
			m.cueLine = { speaker: ev.speaker, text: ev.text };
		}
	}

	async function attach(file: string, history: boolean, title = "") {
		const m = st;
		if (!m) return;
		const continuing = m.file !== "" && meetingKey(m.file) === meetingKey(file);
		m.file = file;
		if (!m.firstFile) m.firstFile = file;
		m.offset = 0;
		m.partial = "";
		m.phase = "live";
		if (!continuing) m.title = title || meetingKey(file);
		pi.events.emit("meeting:state", { active: true, title: m.title });
		await pollFile(history); // reads the metadata line, so the title is real for qmd
		if (st !== m) return; // stopped or shut down while reading
		if (!continuing) m.backgroundReady = buildBackground(file);
		if (!m.announced && st === m) {
			m.announced = true;
			pi.sendMessage(
				{
					customType: MSG_TYPE,
					content: `Meeting copilot on "${m.title}"${m.app ? ` (${m.app})` : ""} via ${m.modelLabel}. Live transcript: ${file.replace(/\.jsonl$/, ".txt")}. These updates are context for later; they need no reply.`,
					display: true,
					details: { kind: "start", file },
				},
				{ triggerTurn: false },
			);
		}
		render(true);
	}

	async function pollFile(history = false) {
		const m = st;
		if (!m || !m.file) return;
		let size: number;
		try {
			size = (await fs.promises.stat(m.file)).size;
		} catch {
			return;
		}
		if (size < m.offset) {
			m.offset = 0;
			m.partial = "";
		}
		if (size === m.offset) return;
		const fh = await fs.promises.open(m.file, "r");
		let chunk: string;
		try {
			const buf = Buffer.alloc(size - m.offset);
			await fh.read(buf, 0, buf.length, m.offset);
			chunk = buf.toString("utf8");
		} finally {
			await fh.close();
		}
		m.offset = size;
		const parts = (m.partial + chunk).split("\n");
		m.partial = parts.pop() ?? "";
		const now = Date.now();
		for (const raw of parts) {
			if (!raw.trim()) continue;
			const ev = parseEvent(raw);
			if (ev) ingest(ev, now, history);
			else {
				// Slides aren't scout input; they only feed the one prompt line.
				const rec = parseRecord(raw);
				if (rec?.kind === "slide") m.slides++;
				if (rec?.kind === "slide" || rec?.kind === "revisit") m.slideOn = rec.slide;
			}
		}
	}

	async function listNames(dir = DIR): Promise<string[]> {
		try {
			return await fs.promises.readdir(dir);
		} catch {
			return [];
		}
	}

	async function buildBackground(file: string): Promise<void> {
		const m = st;
		if (!m) return;
		// The transcript's own folder: earlier ones of the same meeting sit beside it.
		const dir = path.dirname(file);
		const [about, names] = await Promise.all([
			fs.promises.readFile(ABOUT_FILE, "utf8").then((s) => s.slice(0, 4000), () => ""),
			listNames(dir),
		]);
		const txts = await Promise.all(
			names
				.filter((n) => n.endsWith(".txt") && meetingKey(n) === meetingKey(file))
				.map(async (name) => ({ name, size: (await fs.promises.stat(path.join(dir, name)).catch(() => ({ size: 0 }))).size })),
		);
		const prev = previousTranscript(txts, path.basename(file));
		const [prevText, notes] = await Promise.all([
			prev ? readTail(path.join(dir, prev), PREV_TRANSCRIPT_CHARS) : Promise.resolve(""),
			qmdNotes(m.title),
		]);
		if (st !== m) return;
		const bg = [
			prevText ? `## The previous "${m.title}" (${prev}), last part\n${prevText.trim()}` : "",
			notes ? `## Notes that mention "${m.title}" (qmd search)\n${notes}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
		m.system = buildSystemPrompt(m.me, about, bg);
	}

	// ── checks ──

	async function check() {
		const m = st;
		const ctx = ctxRef;
		if (!m || !ctx || m.busy) return;
		const registry = ctx.modelRegistry;
		const newFrom = m.sentUpTo;
		const upTo = m.lines.length;
		const cue = m.trig.cue;
		const cueLine = m.cueLine;
		const saved = { ...m.trig };
		m.trig = { unsent: 0, firstUnsentAt: 0, lastLineAt: m.trig.lastLineAt, lastCallAt: Date.now(), cue: null };
		if (m.models.length === 0) {
			// Rules only: no model reads the meeting, but a cue still reaches the user.
			m.sentUpTo = upTo;
			if (cue) raiseAlert(m, ruleAlert(cue, cueLine));
			render(true);
			return;
		}
		m.busy = true;
		m.abort = new AbortController();
		render(true);
		try {
			if (m.backgroundReady) await Promise.race([m.backgroundReady, new Promise((r) => setTimeout(r, BACKGROUND_WAIT_MS))]);
			const system = m.system || buildSystemPrompt(m.me, "", "");
			const user = fitUserPrompt(system, {
				title: m.title,
				app: m.app,
				people: m.people,
				lines: m.lines.slice(0, upTo),
				newFrom,
				open: m.questions.filter((q) => q.status === "open"),
				closed: m.questions.filter((q) => q.status !== "open"),
				focus: m.focus,
				cue,
				me: m.me,
				now: new Date(),
			});
			let res: AssistantMessage | undefined;
			const errors: string[] = [];
			for (const model of m.models) {
				const stream = registry.streamSimple(
					model,
					{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
					{
						...(REASONING === "off" ? {} : { reasoning: REASONING as ThinkingLevel }),
						maxTokens: 4000,
						cacheRetention: "short",
						sessionId: m.sessionId,
						signal: AbortSignal.any([m.abort.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
					},
				);
				const r = await stream.result();
				m.cost += r.usage?.cost?.total ?? 0;
				if (r.stopReason === "error" || r.stopReason === "aborted") {
					errors.push(`${model.provider}/${model.id}: ${(r.errorMessage || r.stopReason).slice(0, 80)}`);
					if (m.abort.signal.aborted) break;
					continue;
				}
				res = r;
				break;
			}
			if (st !== m) return;
			m.checks++;
			if (!res) throw new Error(errors.join("; ") || "no model answered");
			const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			const update = parseScoutReply(text);
			if (!update) throw new Error(`unparseable reply: ${text.replace(/\s+/g, " ").slice(0, 60)}`);
			m.error = "";
			m.alert = ""; // the scout is back and has judged the cue itself
			m.sentUpTo = upTo;
			if (update.topic) m.topic = update.topic;
			// Stamp with meeting time (the last line checked), not wall time.
			const at = lineClock(m.lines[upTo - 1]) || new Date().toTimeString().slice(0, 5);
			const now = Date.now();
			const applied = applyUpdate(m.questions, update, m.nextId, now, at, newFrom === 0 ? MAX_ADD_FIRST : MAX_ADD);
			m.questions = applied.questions;
			m.nextId = applied.nextId;
			const addedIds = applied.added.map((q) => q.id);
			m.shown = pickShown(m.shown, m.questions, [...addedIds].reverse().concat(update.top), now, addedIds);
			if (update.reply) {
				m.reply = update.reply;
				m.replyAt = now;
			}
			deliver(m, applied.added, applied.closed, update.reply, at);
		} catch (e) {
			if (st !== m) return;
			m.error = String((e as Error)?.message ?? e).slice(0, 120);
			// Nothing was consumed: put the lines and the cue back for the next trigger.
			m.trig.unsent += saved.unsent;
			m.trig.firstUnsentAt = saved.firstUnsentAt || Date.now();
			m.trig.cue = m.trig.cue ?? saved.cue;
			// The scout is down: say the cue by rule now rather than wait for a retry.
			if (cue) raiseAlert(m, ruleAlert(cue, cueLine));
		} finally {
			if (st === m) {
				m.busy = false;
				m.abort = undefined;
				render(true);
			}
		}
	}

	function raiseAlert(m: Meeting, text: string) {
		if (!text) return;
		m.alert = text;
		m.alertAt = Date.now();
	}

	function deliver(m: Meeting, added: Question[], closed: Question[], reply: string, at: string) {
		// Close-only changes stay in the widget (and the recap); the session hears about new things.
		if (added.length === 0 && !reply) return;
		const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
		const lines = [`Meeting copilot · ${m.title} · ${at}${m.topic ? ` · ${m.topic}` : ""}`];
		for (const q of added) lines.push(`+ Q${q.id} ${q.q}${q.why ? ` (${q.why})` : ""}`);
		for (const q of closed) lines.push(`✓ Q${q.id} ${short(q.q, 80)}${q.note ? ` → ${q.note}` : ` (${q.status})`}`);
		if (reply) lines.push(`↳ suggested reply: ${reply}`);
		pi.sendMessage(
			{ customType: MSG_TYPE, content: lines.join("\n"), display: true, details: { kind: "update", added, closed, reply } },
			{ triggerTurn: false },
		);
	}

	// ── research ──

	const piInvocation = (args: string[]) => {
		const script = process.argv[1];
		return script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)
			? { cmd: process.execPath, args: [script, ...args] }
			: { cmd: "pi", args };
	};

	/**
	 * Research one question in a separate `pi -p` subprocess: nothing runs in the
	 * main session, and the brief arrives as a meeting message (triggerTurn:false).
	 */
	async function research(id: number, steer: string, ctx: ExtensionContext): Promise<void> {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		const m = st ?? last;
		if (!m) return notify("No meeting to research. /meeting watch arms this session", "warning");
		const q = m.questions.find((x) => x.id === id);
		if (!q) return notify(`No Q${id} in "${m.title}"`, "warning");
		if (q.dig?.state === "running") return notify(`Already researching Q${id} (${mmssSince(q.dig.startedAt)})`);
		if (q.dig?.state === "done" && !steer) return notify(`Q${id}: ${q.dig.answer} · brief is above · /q${id} <what else> digs again`);
		const running = m.questions.filter((x) => x.dig?.state === "running").length;
		if (running >= MAX_DIGS) return notify(`${running} research runs already going; try again when one lands`, "warning");

		// Claim it before any await, so a double /q3 can't start two runs.
		const startedAt = Date.now();
		setDig(m, id, { state: "running", startedAt });
		if (m === st && q.status === "open") m.shown = pickShown(m.shown, m.questions, [id], startedAt, [id]);
		if (m === st) render(true);
		const picked = researchModel(DIG_MODEL, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
		const model = picked.model;
		let tmpDir = "";
		try {
			const about = await fs.promises.readFile(ABOUT_FILE, "utf8").then(
				(s) => s.slice(0, 4000),
				() => "",
			);
			const { system, task } = buildDigPrompt({
				me: m.me,
				about,
				title: m.title,
				app: m.app,
				question: q,
				steer,
				lines: m.lines,
				clock: lineClock(m.lines.at(-1)),
			});
			tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-meeting-dig-"));
			const sysFile = path.join(tmpDir, "system.md");
			await fs.promises.writeFile(sysFile, system, { mode: 0o600 });
			const args = ["--mode", "json", "-p", "--no-session", ...(model ? ["--model", model] : [])];
			args.push("--thinking", DIG_THINKING, "--tools", DIG_TOOLS, "--append-system-prompt", sysFile, task);
			const inv = piInvocation(args);
			const proc = spawn(inv.cmd, inv.args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_SUBAGENT_CHILD: "1" } });
			const run: DigRun = { m, id, proc, cancelled: false };
			digRuns.add(run);
			notify(`Researching Q${id} with ${model}${picked.refused ? ` (${picked.refused} is not ${WORK_LABEL})` : ""}; the brief lands here within 3 min`);

			let final = "";
			let cost = 0;
			let buf = "";
			const stderr: string[] = [];
			const onLine = (line: string) => {
				let ev: { type?: string; message?: { role?: string; content?: { type: string; text?: string }[]; usage?: { cost?: { total?: number } } } };
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}
				const msg = ev.type === "message_end" ? ev.message : undefined;
				if (msg?.role !== "assistant") return;
				cost += msg.usage?.cost?.total ?? 0;
				const text = (msg.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
				if (text.trim()) final = text;
			};
			proc.stdout?.on("data", (d) => {
				buf += String(d);
				const parts = buf.split("\n");
				buf = parts.pop() ?? "";
				for (const l of parts) if (l.trim()) onLine(l);
			});
			proc.stderr?.on("data", (d) => stderr.push(String(d)));
			let timedOut = false;
			const killer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
			}, DIG_TIMEOUT_MS);
			const code = await new Promise<number>((resolve) => {
				proc.on("close", (c) => resolve(c ?? 1));
				proc.on("error", () => resolve(1));
			});
			clearTimeout(killer);
			if (buf.trim()) onLine(buf);
			digRuns.delete(run);
			if (run.cancelled) return;
			m.cost += cost;
			if (timedOut || !final.trim()) {
				const reason = stderr.join("").trim().split("\n").at(-1) || `exit ${code}`;
				const error = timedOut ? "timed out after 3 min" : reason.slice(0, 120);
				setDig(m, id, { state: "failed", startedAt, error });
				notify(`Q${id} research failed: ${error}`, "warning");
			} else {
				const brief = final.trim();
				const answer = briefAnswer(brief);
				setDig(m, id, { state: "done", startedAt, answer, brief });
				pi.sendMessage(
					{
						customType: MSG_TYPE,
						content: [`Meeting copilot · Q${id} research · ${mmssSince(startedAt)}${cost > 0 ? ` · $${cost.toFixed(3)}` : ""}`, `Q${id} ${q.q}`, brief].join("\n"),
						display: true,
						details: { kind: "research", id, answer, brief },
					},
					{ triggerTurn: false },
				);
				notify(`Q${id}: ${answer}`);
				// After the meeting the recap is already written; refresh it with the answer.
				if (m !== st) writeRecap(m);
			}
		} catch (e) {
			setDig(m, id, { state: "failed", startedAt, error: String((e as Error)?.message ?? e).slice(0, 120) });
			notify(`Q${id} research failed: ${(e as Error)?.message ?? e}`, "warning");
		} finally {
			if (tmpDir) fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			if (m === st) render(true);
		}
	}

	// /q3 isn't a registered command, so pi hands it to input handlers.
	pi.on("input", (event, ctx) => {
		const hit = parseDigInput(event.text);
		if (!hit) return { action: "continue" as const };
		ctxRef ??= ctx;
		void research(hit.id, hit.steer, ctx);
		return { action: "handled" as const };
	});

	pi.registerCommand("q", {
		description: "Research a meeting question with a subagent: /q 3 [what to look for], /q3, or /q to pick",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
			const m = st ?? last;
			const p = prefix.replace(/^q/i, "");
			return (m?.questions ?? [])
				.filter((q) => String(q.id).startsWith(p))
				.map((q) => ({ value: `${q.id} `, label: `Q${q.id}`, description: q.q.slice(0, 90) }));
		},
		handler: async (raw, ctx) => {
			ctxRef ??= ctx;
			const a = parseDigArgs(raw);
			if (a) return research(a.id, a.steer, ctx);
			const notify = (msg: string, level: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
			};
			if (raw.trim()) return notify("Usage: /q 3 [what to look for], /q3, or /q to pick", "warning");
			const m = st ?? last;
			if (!m?.questions.length) return notify("No meeting questions to research", "warning");
			if (!ctx.hasUI) return;
			const ordered = [...m.questions.filter((q) => q.status === "open"), ...m.questions.filter((q) => q.status !== "open")];
			const tag = (q: Question) => (q.dig?.state === "done" ? " 🔎✓" : q.dig?.state === "running" ? " 🔎" : q.status !== "open" ? ` (${q.status})` : "");
			const pick = await ctx.ui.select("Research which question?", ordered.map((q) => `Q${q.id}${tag(q)} ${q.q}`));
			const id = Number(/^Q(\d+)/.exec(pick ?? "")?.[1]);
			if (id) return research(id, "", ctx);
		},
	});

	// ── tick ──

	async function tick() {
		const m = st;
		if (!m || ticking) return;
		ticking = true;
		try {
			const now = Date.now();
			if (m.replay) {
				const r = m.replay;
				while (r.next < r.events.length && r.events[r.next]!.at - r.t0 <= (now - r.startedAt) * r.speed) {
					ingest(r.events[r.next++]!.ev, now, false);
				}
				if (r.next >= r.events.length && m.phase === "live") {
					m.phase = "ended";
					m.endedAt = now;
				}
			} else if (m.file) {
				// stateTick starts, attaches and ends a meeting; this only reads it.
				await pollFile();
			}
			if (st !== m) return;
			if (!m.busy) {
				const final = m.phase === "ended";
				if (m.forceNext || shouldFire(m.trig, now, final)) {
					m.forceNext = false;
					void check();
				} else if (final && m.trig.unsent === 0 && !digging(m)) {
					return finish(m.replay ? "replay finished" : "meeting ended");
				}
			}
			// While a call has ended or research runs, redraw every tick so the timers move.
			render(m.phase === "ended" || digging(m));
		} catch (e) {
			if (st) st.error = String((e as Error)?.message ?? e).slice(0, 120);
		} finally {
			ticking = false;
		}
	}

	// ── auto start and ownership ──

	/** Let go of the lock if this session holds it. */
	function release() {
		if (!holding) return;
		holding = false;
		releaseLock(lockMe("watch"));
	}

	/** The lock file exists with an mtime over 5 s old (or can't be stat'ed): a leftover, not a write in progress. */
	function staleFile(): boolean {
		try {
			return Date.now() - fs.statSync(lockPath()).mtimeMs > 5000;
		} catch {
			return true;
		}
	}

	/**
	 * Take the lock. With none, create it exclusively (O_EXCL): the winner is
	 * decided by the file system. Taking over a dead or owner-held lock can't be
	 * exclusive, so write it (tmp + rename), wait a short random 100-300 ms and
	 * read it back: if another session wrote after us, it is theirs and we don't
	 * start. False if the lock isn't ours, or this instance shut down meanwhile.
	 */
	async function claim(via: Via): Promise<boolean> {
		const me = lockMe(via);
		const g = gen;
		try {
			if (!readLock()) {
				if (createLock(me)) return (holding = true);
				// Lost the create: the other session may be between creating the file and writing it.
				// An unreadable file is only a takeover once it is stale.
				if (!readLock() && !staleFile()) return false;
			}
			const now = readLock();
			if (now && !canClaim(now, me)) return false; // someone created it between our read and our create
			writeLock(me);
		} catch {
			return false;
		}
		await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
		if (g !== gen) {
			releaseLock(me); // shut down while waiting: don't leave our lock behind
			return false;
		}
		return (holding = isMine(readLock(), me));
	}

	/** Stop without a recap or a message: the lock moved on, and the new owner takes it from here. */
	function quietStop() {
		const m = st;
		if (!m) return;
		if (!m.replay) pi.events.emit("meeting:state", { active: false, title: m.title });
		teardown(false);
	}

	/** Scout models, who you are, and an empty meeting. */
	async function newMeeting(ctx: ExtensionContext, modelArg?: string): Promise<Meeting> {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		const registry = ctx.modelRegistry;
		const specs = modelArg ? [modelArg] : modelSpecs(process.env.PI_MEETING_MODEL);
		const work = workOnly(specs.length ? specs : WORK_MODELS);
		if (work.refused.length) notify(`Not ${WORK_LABEL}, so never given meeting text: ${work.refused.join(", ")}`, "warning");
		const models = work.ok
			.map((spec) => registry.find(spec.slice(0, spec.indexOf("/")), spec.slice(spec.indexOf("/") + 1)))
			.filter((m): m is Model<Api> => !!m && registry.hasConfiguredAuth(m));
		if (models.length === 0)
			notify(`No ${WORK_LABEL} scout with credentials (${work.ok.join(", ") || "none given"}); cues by rule only, no new questions`, "warning");

		const who = process.env.PI_MEETING_ME || (await run("git", ["config", "--global", "--includes", "user.name"], 3000)).trim();
		return {
			phase: "waiting",
			file: "",
			offset: 0,
			partial: "",
			title: "",
			app: "",
			startedMs: 0,
			people: [],
			slides: 0,
			lines: [],
			sentUpTo: 0,
			trig: freshTrigger(),
			questions: [],
			shown: [],
			expanded: false,
			firstFile: "",
			nextId: 1,
			topic: "",
			reply: "",
			replyAt: 0,
			alert: "",
			alertAt: 0,
			focus: "",
			me: who,
			meTokens: nameTokens(who),
			models,
			modelLabel: models.map((m) => m.name || m.id).join(" → ") || "rules only",
			system: "",
			sessionId: randomUUID(),
			checks: 0,
			cost: 0,
			busy: false,
			forceNext: false,
			error: "",
			endedAt: 0,
			lastRender: 0,
			lastNotify: 0,
			announced: false,
		};
	}

	/** A live meeting from state.json, now that this session holds the lock. */
	async function startAuto(s: CaptureState, via: Via, ctx: ExtensionContext) {
		const g = gen;
		const m = await newMeeting(ctx);
		if (st) return; // a replay began while the scout was being set up
		if (g !== gen || !holding) return; // shut down, or the lock was let go, while the scout was being set up
		m.auto = { startedAt: s.startedAt, slidesDir: s.slidesDir, via };
		m.title = s.title;
		m.app = s.app;
		m.startedMs = s.startedMs;
		st = m;
		timer = setInterval(() => void tick(), POLL_MS);
		timer.unref?.();
		if (s.jsonl) await attach(s.jsonl, true, s.title);
		else if (ctx.hasUI) ctx.ui.notify(`Meeting copilot on "${s.title}": waiting for captions`);
		if (g !== gen) return;
		render(true);
	}

	/** Every 2s: the lock, then state.json. See the header for the rules. */
	async function stateTick() {
		if (stateTicking) return;
		stateTicking = true;
		const g = gen;
		try {
			const ctx = ctxRef;
			if (!ctx) return;
			const via = eligibleVia();
			if (!via && !holding && !st?.auto) return;
			if (!via) {
				// No longer armed, and the name doesn't match: let go.
				if (st?.auto) finish("no longer armed");
				release();
				return;
			}
			const lock = readLock();
			const mine = isMine(lock, lockMe(via));
			holding = mine; // the file says so, whoever wrote it
			if (!lock || !pidAlive(lock.pid)) yielded = false;
			const s = readState();
			const live = isLive(s);
			const m = st;
			if (m?.auto) {
				// The lock moved: stop at once, even in the ended phase, so a recap still
				// waiting on its research digs is dropped (the new owner starts fresh). The
				// other way round, a new started_at can't start until the old meeting's digs
				// finish and tick() releases it.
				if (!mine && !canClaim(lock, lockMe(via))) {
					yielded = true;
					holding = false;
					if (ctx.hasUI) ctx.ui.notify(`Meeting copilot moved to ${lock?.name || `pid ${lock?.pid}`}`, "info");
					return quietStop();
				}
				if (!mine) {
					await claim(via);
					if (g !== gen) return;
					if (st !== m) return;
				}
				m.auto.via = via;
				if (!live || s.startedAt !== m.auto.startedAt) {
					// Over: tick() gives the leftover lines a last look, then finishes.
					if (m.phase !== "ended") {
						m.phase = "ended";
						m.endedAt = Date.now();
					}
					return;
				}
				if (m.phase === "waiting" && s.jsonl) await attach(s.jsonl, true, s.title);
				return;
			}
			if (m) return; // a replay
			if (!live || yielded || doneStarts.has(s.startedAt) || readStopped().includes(s.startedAt)) return;
			if (!mine) {
				if (!canClaim(lock, lockMe(via))) return;
				const won = await claim(via);
				if (g !== gen || !won || !holding || st) return;
			}
			await startAuto(s, via, ctx);
		} catch (e) {
			if (st) st.error = String((e as Error)?.message ?? e).slice(0, 120);
		} finally {
			stateTicking = false;
		}
	}

	// ── the meeting tool ──

	/** What a tool call reads: the replay if one is playing, else state.json (live or the last one). */
	type Source = {
		title: string;
		app: string;
		startedAt: string;
		startedMs: number;
		jsonl: string | null;
		slidesDir: string | null;
		livePath: string | null;
		live: boolean;
		ended: boolean; // marked ended in state.json; else a dead recorder
		endedAt: string;
		replayNow?: number; // epoch ms the replay has reached
		replayRecs?: Rec[];
	};

	function toolSource(): Source | undefined {
		const m = st;
		if (m?.replay) {
			const r = m.replay;
			const now = Math.min(r.t0 + (Date.now() - r.startedAt) * r.speed, r.last);
			return {
				title: m.title,
				app: m.app,
				startedAt: r.first,
				startedMs: r.t0,
				jsonl: m.file,
				slidesDir: r.slidesDir,
				livePath: null,
				live: m.phase !== "ended",
				ended: m.phase === "ended",
				endedAt: "",
				replayNow: now,
				replayRecs: r.recs.filter((x) => !x.ms || x.ms <= now),
			};
		}
		const s = readState();
		if (!s) return undefined;
		return {
			title: s.title,
			app: s.app,
			startedAt: s.startedAt,
			startedMs: s.startedMs,
			jsonl: s.jsonl,
			slidesDir: s.slidesDir,
			livePath: s.livePath,
			live: isLive(s),
			ended: s.ended,
			endedAt: s.endedAt,
		};
	}

	const readIndex = async (src: Source): Promise<SlideEntry[]> => {
		if (!src.slidesDir) return [];
		const text = await fs.promises.readFile(path.join(src.slidesDir, "index.jsonl"), "utf8").catch(() => "");
		const seen = src.replayNow;
		return parseIndex(text).filter((e) => seen === undefined || !Date.parse(e.at) || Date.parse(e.at) <= seen);
	};

	const MeetingParams = Type.Object({
		action: Type.Union([Type.Literal("status"), Type.Literal("transcript"), Type.Literal("slide")], {
			description: "status: title, people, slides; transcript: what was said; slide: one slide's time, OCR text and image",
		}),
		minutes: Type.Optional(Type.Number({ description: "transcript: only the last N minutes" })),
		since: Type.Optional(Type.String({ description: 'transcript: from this time, "HH:MM" or "HH:MM:SS" as the transcript shows them, or ISO' })),
		until: Type.Optional(Type.String({ description: "transcript: up to this time, same formats" })),
		speaker: Type.Optional(Type.String({ description: "transcript: only this person (case-insensitive part of the name, first name works)" })),
		query: Type.Optional(Type.String({ description: "transcript: only lines with all these words (case-insensitive)" })),
		limit: Type.Optional(Type.Number({ description: `transcript: most lines to return, newest kept (default ${TOOL_LIMIT})` })),
		slide: Type.Optional(Type.Number({ description: "slide: the slide number (default: the one on screen)" })),
	});

	type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
	const result = (content: ToolContent[], details: Record<string, unknown>) => ({ content, details });

	async function meetingTool(p: Static<typeof MeetingParams>) {
		const src = toolSource();
		if (!src) return result([{ type: "text", text: `No meeting-capture state at ${statePath()}: no meeting has been captured on this Mac yet.` }], { action: p.action, found: false });
		const replaying = src.replayNow !== undefined;
		const name = `${src.title || "untitled"}${src.app ? ` (${src.app})` : ""}`;
		const note = replaying
			? `This is a replay of ${name}, as far as it has played.`
			: src.live
				? ""
				: `Nothing is live right now. This is the most recent meeting, ${name}, ${src.ended ? `which ended${src.endedAt ? ` at ${clock(src.endedAt) || src.endedAt}` : ""}` : "whose recorder stopped"}.`;
		const out = (t: string, details: Record<string, unknown> = {}, extra: ToolContent[] = []) =>
			result([{ type: "text", text: note ? `${note}\n\n${t}` : t }, ...extra], { action: p.action, live: src.live, ...details });
		if (!src.jsonl && !src.replayRecs) return out(`${name} has no transcript yet: the first captions haven't been written.`);

		let recs: Rec[];
		try {
			recs = src.replayRecs ?? parseRecords(await fs.promises.readFile(src.jsonl as string, "utf8"));
		} catch (e) {
			return out(`Couldn't read the transcript ${src.jsonl}: ${(e as Error).message}`);
		}
		const last = recs.at(-1)?.ms ?? 0;
		const ref = replaying ? (src.replayNow as number) : src.live ? Date.now() : last || Date.now();
		const slideOn = currentSlide(recs);

		if (p.action === "status") {
			const index = await readIndex(src);
			const done = src.slidesDir ? index.filter((e) => fs.existsSync(ocrPath(src.slidesDir as string, e))).length : 0;
			const end = !src.live && src.endedAt ? Date.parse(src.endedAt) || last : last;
			return out(
				formatStatus({
					title: src.title,
					app: src.app,
					startedAt: src.startedAt,
					elapsedMs: (src.live ? ref : end) - src.startedMs,
					live: src.live,
					endedAt: src.live ? undefined : src.endedAt,
					people: lastPeople(recs),
					slides: slideCount(recs),
					slideOn,
					ocr: src.slidesDir ? { done, total: index.length } : undefined,
				}),
			);
		}

		if (p.action === "transcript") {
			let list: Rec[];
			try {
				list = filterRecords(recs, p, ref, src.startedMs, src.startedAt);
			} catch (e) {
				return out((e as Error).message);
			}
			let liveLines: LiveLine[] = [];
			if (!p.until?.trim() && src.live && src.livePath) {
				try {
					liveLines = filterLive(parseLive(JSON.parse(await fs.promises.readFile(src.livePath, "utf8"))), p, src.startedMs, src.startedAt);
				} catch {
					// no live.json: nobody is mid-sentence
				}
			}
			const lines = [...list.map(formatRec), ...liveLines.map(formatLive)];
			if (lines.length === 0) return out("No transcript lines match.");
			const { text: body } = truncateLines(lines, p.limit);
			return out(`Meeting: ${name}${src.startedAt ? ` · started ${clock(src.startedAt)}` : ""} · ${lines.length} line${lines.length === 1 ? "" : "s"} match\n${body}`);
		}

		// slide
		if (!src.slidesDir) return out("This meeting has no slides: capture ran without slides, or nothing capturable was shared.");
		const index = await readIndex(src);
		const n = p.slide ?? slideOn;
		if (n === undefined) return out(index.length ? "No slide is on screen yet." : "No slides have been saved yet.");
		const entry = index.find((e) => e.n === n);
		if (!entry) return out(index.length ? `No slide ${n}. Saved slides: 1 to ${index.at(-1)?.n}.` : `No slide ${n}: none saved yet.`);
		const times = slideTimes(recs, n);
		const shown = times.first ? clock(times.first.ts) : clock(entry.at);
		const again = times.again.map((r) => clock(r.ts)).filter(Boolean);
		const file = slideFile(src.slidesDir, entry);
		let ocr: string;
		try {
			const raw = (await fs.promises.readFile(ocrPath(src.slidesDir, entry), "utf8")).trim();
			ocr = !raw ? "(OCR found no text)" : raw.length > OCR_MAX_CHARS ? `${raw.slice(0, OCR_MAX_CHARS)}\n[… cut]` : raw;
		} catch {
			ocr = "OCR not ready yet";
		}
		const head = [
			`Slide ${n}${n === slideOn ? " (on screen now)" : ""} of ${index.length}: ${entry.file}${entry.width ? ` · ${entry.width}×${entry.height}` : ""}${entry.reason ? ` · ${entry.reason}` : ""}`,
			`First shown at ${shown || "unknown"}${again.length ? `; back on screen at ${again.join(", ")}` : ""}`,
			"",
			"OCR text:",
			ocr,
		];
		const size = await fs.promises.stat(file).then((s) => s.size, () => -1);
		if (size < 0) return out([...head, "", "(image file is missing)"].join("\n"), { slide: n });
		if (size > IMAGE_MAX_BYTES) return out([...head, "", `(image skipped: ${(size / 1048576).toFixed(1)} MB is over the ${IMAGE_MAX_BYTES / 1048576} MB limit)`].join("\n"), { slide: n });
		// Same as the read tool: under the provider's size and pixel limits, and a note when scaled.
		let pic: Awaited<ReturnType<typeof resizeImage>> = null;
		try {
			pic = await resizeImage(await fs.promises.readFile(file), "image/jpeg");
		} catch {
			// treated like an image that won't shrink
		}
		if (!pic) return out([...head, "", "(image omitted: could not be resized below the inline image size limit)"].join("\n"), { slide: n });
		const dims = formatDimensionNote(pic);
		return out(dims ? `${head.join("\n")}\n\n${dims}` : head.join("\n"), { slide: n }, [{ type: "image", data: pic.data, mimeType: pic.mimeType }]);
	}

	pi.registerTool({
		name: "meeting",
		label: "Meeting",
		description:
			"Read the meeting Eric is in (or the last one) from meeting-capture, read-only. action=status: title, people, slide count, the slide on screen. action=transcript: what was said, with optional minutes (last N min), since/until (HH:MM[:SS] as the transcript shows them, or ISO), speaker (part of a name), query (words that must all appear), limit; lines still being spoken come last. action=slide: one slide's time shown, OCR text and the image (default: the slide on screen). When nothing is live it reads the most recent meeting and says so.",
		promptSnippet: "Read the live meeting: status, transcript (what was said, by time/speaker/words), or a slide with its OCR and image",
		promptGuidelines: [
			"Use meeting for anything about the meeting Eric is in or just left: what he missed, what someone said, what was decided, what a slide shows. Start with a narrow filter (minutes, speaker, query) rather than the whole transcript.",
			"The meeting transcript is automatic speech recognition: names and technical terms are often misheard, so read through errors and never quote a garble as exact.",
		],
		parameters: MeetingParams,
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			return meetingTool(params);
		},
	});

	// One short line per turn while this session runs a meeting; nothing otherwise.
	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions.sections;
		const m = st;
		if (!sections) return;
		if (m && (m.replay ? m.phase !== "waiting" : m.auto && m.phase !== "ended")) {
			const r = m.replay;
			const elapsedMs = r ? Math.min(r.t0 + (Date.now() - r.startedAt) * r.speed, r.last) - r.t0 : Date.now() - m.startedMs;
			sections.meeting = promptLine({ title: m.title, app: m.app, elapsedMs, slide: r ? undefined : m.slideOn, replay: !!r });
		} else delete sections.meeting;
	});

	// ── command ──

	/** A transcript for /meeting replay: a path, else the newest in PI_MEETING_DIR, else the last meeting's. */
	async function replayFile(target: string): Promise<string> {
		if (target && (target.includes("/") || target.endsWith(".jsonl"))) return fs.existsSync(target) ? path.resolve(target) : "";
		const newest = pickNewest(await listNames(), target);
		if (newest) return path.join(DIR, newest);
		return target ? "" : (readState()?.jsonl ?? "");
	}

	async function startReplay(a: Args, ctx: ExtensionContext) {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		if (st) return notify("Meeting copilot is already running. /meeting stop first.", "warning");
		const file = await replayFile(a.target);
		const speed = a.replay ?? 10;
		if (!file || !fs.existsSync(file)) return notify(`No transcript to replay${a.target ? ` matching "${a.target}"` : ""}`, "error");

		const m = await newMeeting(ctx, a.model);
		if (st) return notify("Meeting copilot is already running. /meeting stop first.", "warning");
		st = m;
		const events: { at: number; ev: MeetingEvent }[] = [];
		const body = await fs.promises.readFile(file, "utf8");
		let at = 0;
		for (const raw of body.split("\n")) {
			const ev = raw.trim() ? parseEvent(raw) : null;
			if (!ev) continue;
			if (ev.kind === "line") at = Date.parse(ev.ts) || at;
			if (ev.kind === "meta" && ev.stopped) continue;
			events.push({ at, ev });
		}
		const t0 = events.find((e) => e.at > 0)?.at ?? 0;
		for (const e of events) if (!e.at) e.at = t0;
		const recs = parseRecords(body);
		const slides = file.replace(/\.jsonl$/, ".slides");
		m.file = file;
		m.firstFile = file;
		m.phase = "live";
		m.title = meetingKey(file);
		m.replay = {
			speed,
			events,
			next: 0,
			t0,
			startedAt: Date.now(),
			recs,
			first: recs[0]?.ts ?? "",
			last: recs.reduce((n, r) => Math.max(n, r.ms), t0),
			slidesDir: fs.existsSync(slides) ? slides : null,
		};
		// Metadata first so the title is real before the background search runs.
		while (m.replay.next < events.length && events[m.replay.next]!.ev.kind !== "line") ingest(events[m.replay.next++]!.ev, Date.now(), true);
		m.startedMs = Date.now();
		m.backgroundReady = buildBackground(file);
		m.announced = true;
		pi.sendMessage(
			{
				customType: MSG_TYPE,
				content: `Meeting copilot replaying "${m.title}" at ${speed}× via ${m.modelLabel}. Transcript: ${file.replace(/\.jsonl$/, ".txt")}. These updates are context for later; they need no reply.`,
				display: true,
				details: { kind: "start", file, replay: speed },
			},
			{ triggerTurn: false },
		);
		timer = setInterval(() => void tick(), POLL_MS);
		timer.unref?.();
		render(true);
	}

	pi.registerCommand("meeting", {
		description: "Live meeting copilot: suggested questions from the meeting-capture transcript",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
			[
				{ value: "watch", label: "watch", description: "Arm this session to run the copilot for every meeting (watch off to disarm)" },
				{ value: "ask", label: "ask", description: "Check for questions right now" },
				{ value: "list", label: "list", description: "Show every question in the widget (again to collapse)" },
				{ value: "recap", label: "recap", description: "Post the recap so far and update the daily note" },
				{ value: "focus ", label: "focus", description: "Tell the scout what you want out of this meeting" },
				{ value: "stop", label: "stop", description: "Stop the copilot for this meeting" },
				{ value: "replay", label: "replay", description: "Play back a finished transcript, to test: [speed] [path]" },
			].filter((i) => i.value.startsWith(prefix)),
		handler: async (raw, ctx) => {
			ctxRef ??= ctx;
			const a = parseArgs(raw);
			const notify = (msg: string, level: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
			};
			const idle = "Meeting copilot isn't running. It starts by itself in an armed or owner session: /meeting watch";
			switch (a.sub) {
				case "watch": {
					if (/^off$/i.test(a.rest)) {
						armed = false;
						pi.appendEntry(ENTRY, { armed: false });
						release();
						const still = eligibleVia();
						if (st?.auto && !still) finish("watch off");
						return void notify(
							envArmed() ? "Watch off, but PI_MEETING_WATCH is set, so this session stays armed" : still ? "Watch off; this session still matches meeting.owner" : "Meeting watch off",
						);
					}
					if (a.rest) return void notify("Usage: /meeting watch, or /meeting watch off", "warning");
					armed = true;
					yielded = false;
					pi.appendEntry(ENTRY, { armed: true });
					const before = readLock();
					const taken = before && !isMine(before, lockMe("watch")) && pidAlive(before.pid) ? before : undefined;
					try {
						writeLock(lockMe("watch"));
						holding = true;
					} catch (e) {
						return void notify(`Meeting watch: couldn't write the lock: ${(e as Error).message}`, "warning");
					}
					notify(`Meeting watch on: this session runs the copilot${taken ? `, taking over from ${taken.name || `pid ${taken.pid}`}` : ""}`);
					return void stateTick();
				}
				case "replay":
					return startReplay(a, ctx);
				case "start":
					return void notify("Meetings start by themselves now: /meeting watch arms this session. To test, /meeting replay [speed] [path]", "warning");
				case "unknown":
					return void notify(`Unknown: /meeting ${raw.trim().split(/\s+/)[0]}. Try watch, replay, ask, focus, list, recap, stop`, "warning");
				case "stop":
					return st ? finish("/meeting stop") : void notify("Meeting copilot isn't running");
				case "ask":
					if (!st) return void notify(idle, "warning");
					if (st.lines.length === 0) return void notify("Nothing in the transcript yet");
					st.forceNext = true;
					return void tick();
				case "focus":
					if (!st) return void notify(idle, "warning");
					st.focus = a.rest;
					return void notify(a.rest ? `Meeting focus: ${a.rest}` : "Meeting focus cleared");
				case "list":
					if (!st) return void notify(idle, "warning");
					st.expanded = !st.expanded;
					return void render(true);
				case "recap":
					if (!st) return void notify(idle, "warning");
					return void postRecap(st, `Meeting copilot recap so far · ${st.title} · ${st.checks} checks`);
				default: {
					const state = readState();
					const lock = readLock();
					const via = eligibleVia();
					const lines = statusReport({
						armed: isArmed(),
						armedBy: armed ? "/meeting watch" : "PI_MEETING_WATCH",
						owner: OWNER,
						name: sessionName() ?? "",
						lock,
						lockAlive: !!lock && pidAlive(lock.pid),
						mine: isMine(lock, lockMe(via ?? "watch")),
						state,
						stateLive: isLive(state),
						nowMs: Date.now(),
					});
					if (!st) lines.push("Copilot: not running");
					else {
						const where = st.file ? path.basename(st.file) : "waiting for captions";
						const open = st.questions.filter((q) => q.status === "open").length;
						lines.push(
							`Copilot: ${where} · ${st.phase}${st.replay ? " (replay)" : ""} · ${st.lines.length} lines · ${st.checks} checks · ${open} open, ${st.questions.length - open} answered or asked · ${st.modelLabel}${st.error ? ` · error: ${st.error}` : ""}`,
						);
					}
					return void notify(lines.join("\n"));
				}
			}
		},
	});
}

export default optIn("meeting", "Live meeting copilot: questions from the transcript", main);
