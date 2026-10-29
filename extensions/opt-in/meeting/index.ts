/**
 * meeting.ts — live meeting copilot: rolling notes, a few alerts, answers in chat.
 *
 *   /meeting watch [off]    arm this session: it takes over the copilot now, and
 *                           runs every meeting that starts (off disarms)
 *   /meeting replay [speed] [path] [--model provider/id]
 *                           play a finished transcript back, for testing
 *   /meeting ask            run the notes scout right now
 *   /meeting notes          post the current notes to chat
 *   /meeting focus <text>   what you want out of this meeting (fed to the scout)
 *   /meeting recap          post the recap so far and update the daily note
 *   /meeting stop           stop this meeting (it won't restart)
 *   /meeting                status: armed, owner setting, lock holder, live meeting
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
 * Tails the transcript state.json names (finished caption lines only). ONE model
 * call, the notes scout (meeting.model, default github-copilot/claude-haiku-5.5;
 * PI_MEETING_MODEL overrides; called through the in-process model registry),
 * keeps rolling notes: topics, decisions, action items (Eric's marked), at most
 * two questions worth asking out loud, and a reply when someone is waiting on
 * him. It is told who Eric is (meeting-context.md, his name), the meeting
 * (title, app, /meeting focus, people), a digest of THIS pi session (its name,
 * the last ~5 user messages, the last assistant message: what he is working on
 * right now), the OCR text of the slides shown so far, the previous notes and
 * the transcript. No model is polled on a timer: code decides when to call
 * (notes.ts shouldCall): about 3 min of new caption talk, or sooner (at most
 * once a minute) on a new slide or a name alert, never while a call is in
 * flight, and once at the end before the recap. /meeting ask forces one. Each
 * call stays under PROMPT_MAX_TOKENS by trimming the oldest transcript first.
 * With no usable model, name alerts (code rules) still work; no notes appear.
 *
 * Alerts, the only two kinds:
 *   name     someone other than Eric says his name (code rule, immediate, no
 *            model; one per speaker per 2 min). It also asks for an early scout
 *            call so a reply can follow.
 *   action   the scout reports a new action with mine:true (not in the
 *            previous notes, by normalized text).
 * Each is one chat message (a custom "meeting" message, triggerTurn:false:
 * `🔔 Ada said your name (14:12): "…"`, `✅ Action on you: … (Ada, 14:12)`; a
 * reply that arrives later is its own `↳ Katherine is waiting on you. You could
 * say: "…"`, once per reply) and is recorded in the notes file. Nothing else
 * posts during the meeting; the start and stop messages are one line.
 *
 * Output:
 *   widget above the editor   ONE line: `● Weekly Sync · 16m · slide 4 · 2
 *                             alerts · 1 question` (zero parts left out)
 *   notes file for the canvas ~/.pi/canvas/.meeting-notes.json
 *                             (PI_MEETING_NOTES_FILE; PI_CANVAS_ROOT moves the
 *                             default): atomic, mode 600, rewritten whenever
 *                             notes or alerts change. Removed when pi quits
 *                             mid-meeting or the copilot stops for any
 *                             reason but the meeting ending; kept over a
 *                             reload (the new instance reads it back) and at
 *                             the end (ended:true). The canvas daemon shows it on
 *                             the Meeting card and /meeting (extensions/canvas)
 *   /meeting notes            the current notes, as one chat message
 *   recap                     at the end: Topics, Decisions, Action items
 *                             (Eric's first, starred), Open questions: posted
 *                             to the session and upserted as a ### block at the
 *                             end of "## Meetings" in the daily note for the
 *                             capture's date (never for a replay)
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
 * minutes round down to 5, "just started" under 5). The tool hands the
 * transcript and slide images to whatever model the session uses (Eric's
 * choice), as does the notes scout, which no longer has a work-models-only rule.
 *
 * Scout context: a fixed system prompt (cached) with ~/.pi/agent/meeting-context.md
 * (who you are), the tail of the previous transcript of the same meeting, and
 * `qmd search` hits for the meeting title; then the per-call user prompt.
 *
 * Teams writes a caption only when it scrolls out of its ~3-line window, so the
 * transcript trails the room by a couple of utterances.
 *
 * Settings: Boehsline config block "meeting" (watch/settings.ts), e.g.
 *      "meeting": { "model": "github-copilot/claude-haiku-5.5", "qmdCollections": ["notes", "team-docs"], "dailyDir": "~/Notes/daily", "owner": "earl" }
 *
 * Env (overrides settings):
 *      PI_MEETING_MODEL=provider/<id>[,…]  PI_MEETING_REASONING=off|low|…
 *      PI_MEETING_ME="First Last"  PI_MEETING_ABOUT=<file>
 *      PI_MEETING_OWNER=<session name>  PI_MEETING_WATCH=1 (arm)  PI_MEETING_LOCK=<file>
 *      PI_MEETING_NOTES_FILE=<file>  PI_CANVAS_ROOT (where the notes file defaults to)
 *      MEETING_CAPTURE_STATE_DIR  PI_MEETING_DIR (where /meeting replay looks for a transcript)
 *      PI_MEETING_QMD_COLLECTIONS=notes,team-docs ("" disables)
 *      PI_MEETING_DAILY_DIR=~/Notes/daily ("" disables the daily-note recap)
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { applyWorkSettings, modelSpecs } from "../watch/models.ts";
import { compileRedactions, MEETING_DEFAULTS, type MeetingSettings, meetingSettings, type WorkSettings, workSettings } from "../watch/settings.ts";
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
import {
	type Alert,
	actionAlertText,
	buildNotesFile,
	buildSystemPrompt,
	CADENCE,
	type Cadence,
	emptyNotes,
	fitNotesPrompt,
	freshCadence,
	hasNotes,
	mergeNotes,
	nameAlertText,
	normText,
	type Notes,
	parseScoutReply,
	pushAlert,
	type Reply,
	recapBlock,
	recapBody,
	recapMarker,
	removeNotesFile,
	replyDue,
	replyText,
	restoreNotes,
	retryWait,
	sameAction,
	scaleCadence,
	type ScoutUpdate,
	type SentReply,
	type SessionDigest,
	sessionDigest,
	shouldCall,
	type SlideText,
	takeNameAlert,
	widgetLines,
	type WidgetView,
	writeNotesFile,
} from "./notes.ts";

export * from "./capture.ts";
export * from "./notes.ts";

// ── config ───────────────────────────────────────────────────────────────────

/** Where /meeting replay looks for a transcript when given no path. */
const DIR = process.env.PI_MEETING_DIR || path.join(os.homedir(), ".local/share/meeting-capture");
const REASONING = process.env.PI_MEETING_REASONING || "low";
// Settings resolve at session_start (applyMeetingSettings); see watch/settings.ts.
let QMD_COLLECTIONS: string[] = MEETING_DEFAULTS.qmdCollections;
const ABOUT_FILE = process.env.PI_MEETING_ABOUT || path.join(os.homedir(), ".pi/agent/meeting-context.md");

let DAILY_DIR = MEETING_DEFAULTS.dailyDir;
let OWNER = MEETING_DEFAULTS.owner;
let MODEL = MEETING_DEFAULTS.model;
/** work.redact, compiled: applied to what the notes scout is told about this session. */
let REDACTIONS: { re: RegExp; replace: string }[] = [];
const redactText = (s: string) => REDACTIONS.reduce((t, r) => t.replace(r.re, r.replace), s);

/** Refresh settings (and models.ts) from env + Boehsline config. */
export function applyMeetingSettings(m: MeetingSettings = meetingSettings(), work: WorkSettings = workSettings()): void {
	QMD_COLLECTIONS = m.qmdCollections;
	DAILY_DIR = m.dailyDir;
	OWNER = m.owner;
	MODEL = m.model;
	REDACTIONS = compileRedactions(work.redact ?? []);
	applyWorkSettings(work);
}

const POLL_MS = 1000;
const STATE_POLL_MS = 2000;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const OCR_MAX_CHARS = 8000;
const RENDER_MS = 10_000;
const PREV_TRANSCRIPT_CHARS = 16_000;
const CALL_TIMEOUT_MS = 60_000;
const BACKGROUND_WAIT_MS = 10_000;
const SLIDES_READ = 20; // newest slides whose OCR a call reads
const MSG_TYPE = "meeting";
const WIDGET_KEY = "meeting";

// ── transcript parsing ───────────────────────────────────────────────────────

export type MeetingEvent =
	| { kind: "meta"; title?: string; app?: string; startedAt?: string; stopped: boolean }
	| { kind: "line"; ts: string; speaker: string; text: string; chat: boolean }
	| { kind: "people"; people: string[] }
	| { kind: "slide"; ts: string; n: number; revisit: boolean }; // a new slide, or back to an earlier one

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
		case "slide":
		case "revisit":
			return typeof ev.slide === "number" && Number.isFinite(ev.slide) ? { kind: "slide", ts: str(ev.ts), n: ev.slide, revisit: ev.type === "revisit" } : null;
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

/**
 * Whether a line is aimed at you: it says one of your name tokens, and that token
 * isn't also another participant's. With an "Eric Smith" in the meeting, "Eric,"
 * is ambiguous and stays quiet; "Eric Boehs" or "Boehs" still counts.
 */
export function addressesMe(text: string, me: string[], people: readonly string[] = []): boolean {
	const others = people.filter((p) => !isMe(p, me)).map(nameTokens);
	return mentionsMe(
		text,
		me.filter((t) => !others.some((o) => o.includes(t))),
	);
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

// ── args ─────────────────────────────────────────────────────────────────────

export type Args = {
	sub: "status" | "watch" | "replay" | "start" | "stop" | "ask" | "focus" | "notes" | "recap" | "unknown";
	target: string; // replay: the transcript path, "" for the newest
	rest: string;
	replay?: number; // replay speed
	model?: string; // replay: the scout model
};

export function parseArgs(raw: string): Args {
	const trimmed = raw.trim();
	const first = trimmed.split(/\s+/)[0] ?? "";
	const known = ["watch", "replay", "start", "stop", "ask", "focus", "status", "notes", "recap"] as const;
	const sub = (known as readonly string[]).includes(first) ? (first as Args["sub"]) : trimmed ? "unknown" : "status";
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

// ── runtime ──────────────────────────────────────────────────────────────────

type Meeting = {
	phase: WidgetView["phase"];
	auto?: { startedAt: string; slidesDir: string | null; appId: string; via: Via }; // started from state.json, not a replay
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
	firstFile: string; // the capture the meeting started in; keys the daily-note recap
	sentUpTo: number; // lines the scout has seen
	trig: Cadence;
	notes: Notes; // the scout's rolling notes
	reply: { to: string; text: string; at: string } | null; // someone is waiting on you
	sentReplies: SentReply[];
	alerts: Alert[];
	alertSeq: number;
	nameAlertAt: Map<string, number>; // per speaker, for the 2 min limit
	alerted: Set<string>; // normalized actions already alerted
	focus: string;
	me: string;
	meTokens: string[];
	models: Model<Api>[];
	modelLabel: string;
	system: string;
	backgroundReady?: Promise<void>;
	sessionId: string;
	checks: number; // scout calls that answered
	cost: number;
	busy: boolean;
	forceNext: boolean;
	errStreak: number; // scout calls that failed in a row
	finalTried: boolean; // the end-of-meeting call was made (or can't be)
	error: string;
	abort?: AbortController;
	endedAt: number;
	lastRender: number;
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
	/** The meeting that just finished: /meeting notes can still post its notes. */
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
	pi.on("session_shutdown", (e) => {
		gen++;
		if (stateTimer) clearInterval(stateTimer);
		stateTimer = undefined;
		// Quitting mid-meeting still leaves the recap in the daily note.
		if (st && !st.replay && hasNotes(st.notes)) writeRecap(st);
		if (st && !st.replay) pi.events.emit("meeting:state", { active: false, title: st.title });
		// A meeting that ended keeps its final notes for the canvas; a reload, resume or fork keeps the file for the instance that picks the meeting up.
		const keepNotes = e?.reason !== "quit" || (!st && last?.phase === "ended" && !last.replay);
		teardown();
		if (!keepNotes) dropNotesFile();
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
					? `${theme.fg("accent", "◆")} ${/^(🔔|✅)/u.test(l) ? theme.fg("warning", l) : theme.fg("dim", l)}`
					: l.startsWith("↳")
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
		if (st) last = st;
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
			updates: m.checks,
			notes: m.notes,
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
		const note = hasNotes(m.notes) ? writeRecap(m) : undefined;
		pi.sendMessage(
			{
				customType: MSG_TYPE,
				content: [`${headline}${note ? ` · recap in ${tilde(note)}` : ""}`, ...recapBody(m.notes)].join("\n"),
				display: true,
				details: { kind: "recap", notes: m.notes, note },
			},
			{ triggerTurn: false },
		);
	}

	/** The notes file the canvas reads (see notes.ts). Never for a replay: it has no state.json to match. */
	function writeNotes(m: Meeting, ended = false) {
		if (m.replay || !m.auto) return;
		try {
			const file = buildNotesFile({
				pid: process.pid,
				sessionId: lockMe("watch").sessionId,
				sessionName: sessionName() ?? "",
				startedAt: m.auto.startedAt,
				appId: m.auto.appId,
				title: m.title,
				at: new Date().toISOString(),
				ended,
				me: m.meTokens,
				notes: m.notes,
				reply: m.reply,
				alerts: m.alerts,
				alertSeq: m.alertSeq,
			});
			writeNotesFile(file);
		} catch {
			// the canvas just doesn't see the notes; the chat still has them
		}
	}

	/** Remove the notes file if this session wrote it. */
	const dropNotesFile = () => removeNotesFile({ pid: process.pid, sessionId: lockMe("watch").sessionId });

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
			postRecap(m, `Meeting copilot stopped (${reason})`);
		} else if (ctxRef?.hasUI) {
			ctxRef.ui.notify(`Meeting copilot stopped (${reason})`, "info");
		}
		// The canvas keeps the final notes of a meeting that ended; any other stop takes the file away.
		if (m.auto && !m.replay) {
			if (reason === "meeting ended") writeNotes(m, true);
			else dropNotesFile();
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
		const view: WidgetView = {
			phase: m.phase,
			title: m.title,
			startedMs: m.startedMs,
			slide: m.slideOn,
			alerts: m.alerts.length,
			questions: m.notes.questions.length,
			hasLines: m.lines.length > 0,
			busy: m.busy,
			error: m.error,
			replay: !!m.replay,
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
		if (ev.kind === "slide") {
			if (!ev.revisit) m.slides++;
			m.slideOn = ev.n;
			if (!history) wantEarly(m, now); // a new slide is worth a look, within the 60 s floor
			return;
		}
		m.lines.push(formatLine(ev));
		if (!m.trig.unsent) m.trig.firstUnsentAt = history ? 0 : now;
		m.trig.unsent++;
		m.trig.lastLineAt = history ? 0 : now;
		if (history || isMe(ev.speaker, m.meTokens) || !addressesMe(ev.text, m.meTokens, m.people)) return;
		// The line's own time keeps the 2 min rule honest in a fast replay.
		if (takeNameAlert(m.nameAlertAt, ev.speaker, Date.parse(ev.ts) || now)) nameAlert(m, ev, now);
	}

	/** Ask for a scout call sooner than the 3 min of talk. */
	function wantEarly(m: Meeting, now: number) {
		if (m.trig.early) return;
		m.trig.early = true;
		m.trig.earlyAt = now;
	}

	/** One short chat message: it lands in the session and the main model's context, and starts no turn. */
	function say(text: string, details: Record<string, unknown>) {
		pi.sendMessage({ customType: MSG_TYPE, content: text, display: true, details }, { triggerTurn: false });
	}

	function addAlert(m: Meeting, kind: Alert["kind"], who: string, text: string): Alert {
		const alert: Alert = { id: `a${++m.alertSeq}`, kind, who, text: text.replace(/\s+/g, " ").trim().slice(0, 300), at: new Date().toISOString() };
		m.alerts = pushAlert(m.alerts, alert);
		return alert;
	}

	/** Someone else said your name: tell the chat now (no model), and ask for a call so a reply can follow. */
	function nameAlert(m: Meeting, ev: { ts: string; speaker: string; text: string }, now: number) {
		const alert = addAlert(m, "name", ev.speaker, ev.text);
		say(nameAlertText(ev.speaker, clock(ev.ts), ev.text), { kind: "alert", alert });
		wantEarly(m, now);
		writeNotes(m);
		render(true);
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
			say(`Meeting copilot on "${m.title}"${m.app ? ` (${m.app})` : ""} via ${m.modelLabel}`, { kind: "start", file });
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
		m.system = buildSystemPrompt(m.me, m.meTokens, about, bg);
	}

	// ── the notes scout ──

	/** OCR text of the slides shown so far, oldest first (a replay shows only what has played). */
	async function slideTexts(m: Meeting): Promise<SlideText[]> {
		const state = m.auto ? readState() : null;
		const dir = m.replay ? m.replay.slidesDir : state && state.startedAt === m.auto?.startedAt ? state.slidesDir : (m.auto?.slidesDir ?? null);
		if (!dir) return [];
		const index = parseIndex(await fs.promises.readFile(path.join(dir, "index.jsonl"), "utf8").catch(() => ""));
		const r = m.replay;
		const seen = r ? Math.min(r.t0 + (Date.now() - r.startedAt) * r.speed, r.last) : undefined;
		const shown = index.filter((e) => seen === undefined || !Date.parse(e.at) || Date.parse(e.at) <= seen).slice(-SLIDES_READ);
		return Promise.all(
			shown.map(async (e) => ({
				n: e.n,
				at: clock(e.at),
				text: await fs.promises.readFile(ocrPath(dir, e), "utf8").then((t) => t.slice(0, 4000), () => ""),
				onScreen: e.n === m.slideOn,
			})),
		);
	}

	const markSent = (m: Meeting, r: Reply, now: number) => {
		m.sentReplies = [...m.sentReplies, { key: normText(r.text), to: normText(r.to), at: now }].slice(-20);
	};

	/** One scout call: fold its notes in, raise the alerts that are new, post the reply once. */
	async function check() {
		const m = st;
		const ctx = ctxRef;
		if (!m || !ctx || m.busy) return;
		const registry = ctx.modelRegistry;
		const newFrom = m.sentUpTo;
		const upTo = m.lines.length;
		const saved = { ...m.trig };
		m.trig = { ...freshCadence(), lastLineAt: m.trig.lastLineAt, lastCallAt: Date.now() };
		if (m.models.length === 0) {
			// No notes model: name alerts (code rules) still reach the chat, nothing else.
			m.sentUpTo = upTo;
			render(true);
			return;
		}
		m.busy = true;
		m.abort = new AbortController();
		render(true);
		try {
			if (m.backgroundReady) await Promise.race([m.backgroundReady, new Promise((r) => setTimeout(r, BACKGROUND_WAIT_MS))]);
			const system = m.system || buildSystemPrompt(m.me, m.meTokens, "", "");
			let digest: SessionDigest | undefined;
			try {
				digest = sessionDigest(ctx.sessionManager.getBranch(), sessionName() ?? "", redactText);
			} catch {
				// no session digest this time
			}
			const user = fitNotesPrompt(system, {
				title: m.title,
				app: m.app,
				people: m.people,
				lines: m.lines.slice(0, upTo),
				newFrom,
				focus: m.focus,
				me: m.me,
				now: new Date(),
				digest,
				slides: await slideTexts(m),
				prev: m.notes,
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
			m.errStreak = 0;
			m.sentUpTo = upTo;
			// Stamp with meeting time (the last line seen), not wall time.
			applyNotes(m, update, lineClock(m.lines[upTo - 1]) || new Date().toTimeString().slice(0, 5));
		} catch (e) {
			if (st !== m) return;
			m.error = String((e as Error)?.message ?? e).slice(0, 120);
			// Nothing was consumed: put the lines back for the next call.
			if (saved.unsent) m.trig.firstUnsentAt = saved.firstUnsentAt;
			m.trig.unsent += saved.unsent;
			m.trig.early = m.trig.early || saved.early;
			m.trig.earlyAt = m.trig.earlyAt || saved.earlyAt;
			// Wait longer after each failure in a row, so a broken model isn't retried every minute with a bigger prompt.
			m.trig.retryMs = retryWait(++m.errStreak, m.replay ? scaleCadence(m.replay.speed) : CADENCE, m.replay?.speed ?? 1);
		} finally {
			if (st === m) {
				m.busy = false;
				m.abort = undefined;
				render(true);
			}
		}
	}

	/** What a scout answer changes: the notes, the alerts for new actions on you, a reply once. */
	function applyNotes(m: Meeting, update: ScoutUpdate, at: string) {
		const before = JSON.stringify([m.notes, m.reply, m.alerts]);
		const now = Date.now();
		const iso = new Date(now).toISOString();
		const merged = mergeNotes(m.notes, update, iso);
		m.notes = merged.notes;
		const prevReply = m.reply;
		m.reply = update.reply ? { ...update.reply, at: prevReply && normText(prevReply.text) === normText(update.reply.text) ? prevReply.at : iso } : null;
		let waiting = update.reply && replyDue(m.sentReplies, update.reply, now) ? update.reply : null;
		for (const a of merged.newMine) {
			if ([...m.alerted].some((k) => sameAction(k, a.what))) continue;
			m.alerted.add(normText(a.what));
			const alert = addAlert(m, "action", a.by || a.who, a.what);
			// A reply that came with it rides along on this message instead of posting twice.
			say(actionAlertText(a.what, a.by ?? "", at, waiting), { kind: "alert", alert });
			if (waiting) markSent(m, waiting, now);
			waiting = null;
		}
		if (waiting) {
			say(replyText(waiting), { kind: "reply", reply: waiting });
			markSent(m, waiting, now);
		}
		if (JSON.stringify([m.notes, m.reply, m.alerts]) !== before) writeNotes(m);
	}

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
				// One last call at the end, before the recap; if it fails, the recap goes out without it.
				const why = m.forceNext ? "ask" : shouldCall(m.trig, now, { final }, m.replay ? scaleCadence(m.replay.speed) : CADENCE);
				if (why && !(final && m.finalTried)) {
					m.forceNext = false;
					if (final) m.finalTried = true;
					void check();
				} else if (final) {
					return finish(m.replay ? "replay finished" : "meeting ended");
				}
			}
			render();
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
		dropNotesFile();
	}

	/** Scout models, who you are, and an empty meeting. */
	async function newMeeting(ctx: ExtensionContext, modelArg?: string): Promise<Meeting> {
		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		const registry = ctx.modelRegistry;
		// The notes scout (meeting.model, PI_MEETING_MODEL, or --model for a replay), through the in-process registry.
		const specs = modelArg ? [modelArg] : modelSpecs(MODEL);
		const models = specs
			.map((spec) => registry.find(spec.slice(0, spec.indexOf("/")), spec.slice(spec.indexOf("/") + 1)))
			.filter((m): m is Model<Api> => !!m && registry.hasConfiguredAuth(m));
		if (models.length === 0)
			notify(`The meeting notes model isn't available (${specs.join(", ") || "none set"}): no notes, only name alerts. Set meeting.model or PI_MEETING_MODEL`, "warning");

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
			trig: freshCadence(),
			notes: emptyNotes(),
			reply: null,
			sentReplies: [],
			alerts: [],
			alertSeq: 0,
			nameAlertAt: new Map(),
			alerted: new Set(),
			firstFile: "",
			focus: "",
			me: who,
			meTokens: nameTokens(who),
			models,
			modelLabel: models.map((m) => m.name || m.id).join(" → ") || "name alerts only",
			system: "",
			sessionId: randomUUID(),
			checks: 0,
			cost: 0,
			busy: false,
			forceNext: false,
			errStreak: 0,
			finalTried: false,
			error: "",
			endedAt: 0,
			lastRender: 0,
			announced: false,
		};
	}

	/** A live meeting from state.json, now that this session holds the lock. */
	async function startAuto(s: CaptureState, via: Via, ctx: ExtensionContext) {
		const g = gen;
		const m = await newMeeting(ctx);
		if (st) return; // a replay began while the scout was being set up
		if (g !== gen || !holding) return; // shut down, or the lock was let go, while the scout was being set up
		m.auto = { startedAt: s.startedAt, slidesDir: s.slidesDir, appId: s.appId, via };
		m.title = s.title;
		m.app = s.app;
		m.startedMs = s.startedMs;
		// After a /reload, /resume or /fork, pick the notes up where the last instance left them: no re-alerting for what it already said.
		const back = restoreNotes(s.startedAt);
		if (back) {
			m.notes = back.notes;
			m.reply = back.reply;
			m.alerts = back.alerts;
			m.alertSeq = back.alertSeq;
			m.alerted = back.alerted;
			if (back.reply) m.sentReplies.push({ key: normText(back.reply.text), to: normText(back.reply.to), at: Date.parse(back.reply.at) || Date.now() });
		}
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
				// The lock moved: stop at once, even in the ended phase, so a final call
				// still pending is dropped (the new owner starts fresh). The other way
				// round, a new started_at can't start until the old meeting's final call
				// is done and tick() releases it.
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
			if (ev.kind === "line" || ev.kind === "slide") at = Date.parse(ev.ts) || at;
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
		say(`Meeting copilot replaying "${m.title}" at ${speed}× via ${m.modelLabel}`, { kind: "start", file, replay: speed });
		timer = setInterval(() => void tick(), POLL_MS);
		timer.unref?.();
		render(true);
	}

	pi.registerCommand("meeting", {
		description: "Live meeting copilot: rolling notes and alerts from the meeting-capture transcript",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
			[
				{ value: "watch", label: "watch", description: "Arm this session to run the copilot for every meeting (watch off to disarm)" },
				{ value: "ask", label: "ask", description: "Run the notes scout right now" },
				{ value: "notes", label: "notes", description: "Post the current notes to chat" },
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
					return void notify(`Unknown: /meeting ${raw.trim().split(/\s+/)[0]}. Try watch, replay, ask, notes, focus, recap, stop`, "warning");
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
				case "notes": {
					const m = st ?? last;
					if (!m) return void notify(idle, "warning");
					return void say([`Meeting notes · ${m.title}${m.alerts.length ? ` · ${m.alerts.length} alert${m.alerts.length === 1 ? "" : "s"}` : ""}`, ...recapBody(m.notes, m.reply)].join("\n"), { kind: "notes", notes: m.notes, reply: m.reply });
				}
				case "recap":
					if (!st) return void notify(idle, "warning");
					return void postRecap(st, `Meeting copilot recap so far · ${st.title}`);
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
						lines.push(
							`Copilot: ${where} · ${st.phase}${st.replay ? " (replay)" : ""} · ${st.lines.length} lines · ${st.checks} notes updates · ${st.alerts.length} alerts · ${st.notes.questions.length} questions · ${st.modelLabel}${st.error ? ` · error: ${st.error}` : ""}`,
						);
					}
					return void notify(lines.join("\n"));
				}
			}
		},
	});
}

export default optIn("meeting", "Live meeting copilot: rolling notes and alerts from the transcript", main);
