/**
 * capture.ts — what meeting.ts takes from meeting-capture, and who may run the copilot.
 *
 * Pure parts and small file helpers, all re-exported by index.ts. Not an
 * extension: pi loads only top-level files and folders with an index.ts.
 *
 * Reads, never writes, meeting-capture's files (its docs/canvas-contract.md):
 *   $MEETING_CAPTURE_STATE_DIR/state.json  the meeting now or last, written atomically
 *   live.json                              caption lines still being spoken
 *   <jsonl>                                transcript: caption, chat, people, slide, revisit
 *   <slides_dir>/index.jsonl, NNNN-HHMMSS.jpg and .txt (OCR, a few seconds late)
 *
 * The files this writes sit side by side in ~/.pi/agent: the owner lock,
 * meeting-owner.json (several pi sessions run at once and exactly one may run
 * the copilot), and meeting-stopped.json (which meetings /meeting stop ended,
 * so no session restarts them).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── state.json ───────────────────────────────────────────────────────────────

export const stateDir = () => process.env.MEETING_CAPTURE_STATE_DIR || path.join(os.homedir(), ".local/state/meeting-capture");
export const statePath = () => path.join(stateDir(), "state.json");

export type CaptureState = {
	pid: number;
	app: string;
	appId: string;
	title: string;
	startedAt: string; // identifies the meeting: a new one has a different value
	startedMs: number;
	jsonl: string | null; // null until the first caption is written
	txt: string | null;
	slidesDir: string | null; // null with slides off or nothing to capture
	livePath: string;
	ended: boolean;
	endedAt: string;
	duration: string;
};

const str = (v: unknown, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");
const abs = (v: unknown) => (typeof v === "string" && path.isAbsolute(v) ? v : null);

/** state.json, checked: null unless it is a version 1 record with a pid. */
export function parseState(raw: unknown): CaptureState | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1 || !Number.isInteger(r.pid)) return null;
	const startedAt = str(r.started_at, 40);
	return {
		pid: r.pid as number,
		app: str(r.app, 80),
		appId: str(r.app_id, 40),
		title: str(r.meeting, 300),
		startedAt,
		startedMs: Date.parse(startedAt) || 0,
		jsonl: abs(r.jsonl),
		txt: abs(r.txt),
		slidesDir: abs(r.slides_dir),
		livePath: abs(r.live) ?? path.join(stateDir(), "live.json"),
		ended: r.ended === true,
		endedAt: str(r.ended_at, 40),
		duration: str(r.duration, 20),
	};
}

/** Whether a process exists. EPERM means it does, and belongs to someone else. */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Live: not marked ended, and the daemon still runs (a dead pid mid-meeting is a crash). */
export const isLive = (s: CaptureState | null, alive: (pid: number) => boolean = pidAlive): s is CaptureState =>
	!!s && !s.ended && alive(s.pid);

/** state.json read only when its stat changed; checking pid liveness is the caller's. */
export function stateReader(file: () => string = statePath) {
	let key = "";
	let cached: CaptureState | null = null;
	return (): CaptureState | null => {
		const f = file();
		let k: string;
		try {
			const s = fs.statSync(f);
			k = `${f}:${s.mtimeMs}:${s.ino}:${s.size}`;
		} catch {
			key = "";
			return (cached = null);
		}
		if (k === key) return cached;
		try {
			cached = parseState(JSON.parse(fs.readFileSync(f, "utf8")));
			key = k;
		} catch {
			cached = null; // half-written or unreadable: try again next time
			key = "";
		}
		return cached;
	};
}

// ── the owner lock ───────────────────────────────────────────────────────────

export type Via = "watch" | "owner";
export type Lock = { pid: number; sessionId: string; name: string; via: Via; at: string };
export type Me = { pid: number; sessionId: string; name: string; via: Via };

export const lockPath = () => process.env.PI_MEETING_LOCK || path.join(os.homedir(), ".pi/agent/meeting-owner.json");

export function parseLock(raw: unknown): Lock | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (!Number.isInteger(r.pid)) return null;
	return {
		pid: r.pid as number,
		sessionId: str(r.sessionId, 100),
		name: str(r.name, 100),
		via: r.via === "watch" ? "watch" : "owner",
		at: str(r.at, 40),
	};
}

export function readLock(): Lock | null {
	try {
		return parseLock(JSON.parse(fs.readFileSync(lockPath(), "utf8")));
	} catch {
		return null;
	}
}

export const isMine = (lock: Lock | null, me: Pick<Me, "pid" | "sessionId">): boolean =>
	!!lock && lock.pid === me.pid && lock.sessionId === me.sessionId;

/**
 * May `me` take the lock on its own? Yes when nobody holds it, the holder is
 * gone, the holder is me, or I was armed with /meeting watch and the holder only
 * matches the owner setting. `/meeting watch` itself skips this and overwrites.
 */
export function canClaim(lock: Lock | null, me: Pick<Me, "pid" | "sessionId" | "via">, alive: (pid: number) => boolean = pidAlive): boolean {
	if (!lock) return true;
	if (isMine(lock, me)) return true;
	if (!alive(lock.pid)) return true;
	return me.via === "watch" && lock.via === "owner";
}

const lockBody = (me: Me): string => `${JSON.stringify({ pid: me.pid, sessionId: me.sessionId, name: me.name, via: me.via, at: new Date().toISOString() } satisfies Lock)}\n`;

/** Write `body` to `file` atomically (tmp + rename), mode 600; the tmp file never outlives a failure. */
export function writeAtomic(file: string, body: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		fs.writeFileSync(tmp, body, { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

/** Overwrite the lock, whoever holds it: atomic (tmp + rename), mode 600. */
export function writeLock(me: Me): void {
	writeAtomic(lockPath(), lockBody(me));
}

/**
 * Create the lock only if no file exists (O_EXCL), mode 600. False when one
 * does, even an empty or unreadable one: that is a takeover, see writeLock.
 */
export function createLock(me: Me): boolean {
	const file = lockPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let fd: number;
	try {
		fd = fs.openSync(file, "wx", 0o600);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
	try {
		fs.writeSync(fd, lockBody(me));
	} catch (e) {
		fs.rmSync(file, { force: true });
		throw e;
	} finally {
		fs.closeSync(fd);
	}
	return true;
}

/**
 * Delete the lock if it is mine. The read sits right before the delete, but
 * they are two steps: another session writing in between loses its lock. That
 * window is microseconds and the loser notices on its next 2 s tick, so there
 * is no cross-process mutex for it.
 */
export function releaseLock(me: Pick<Me, "pid" | "sessionId">): void {
	if (!isMine(readLock(), me)) return;
	try {
		fs.rmSync(lockPath(), { force: true });
	} catch {
		// already gone
	}
}

// ── meetings stopped by hand ─────────────────────────────────────────────────

/** Beside the lock, so PI_MEETING_LOCK moves both. */
export const stoppedPath = () => path.join(path.dirname(lockPath()), "meeting-stopped.json");
const STOPPED_KEEP = 5;

/** The started_at of the meetings /meeting stop ended, oldest first. Ended meetings need no entry: ended:true blocks them. */
export function readStopped(): string[] {
	try {
		const raw = JSON.parse(fs.readFileSync(stoppedPath(), "utf8")) as { stopped?: unknown };
		return Array.isArray(raw.stopped) ? raw.stopped.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** Remember a stopped meeting for every session and every /reload; only the last few are kept. */
export function markStopped(startedAt: string): void {
	if (!startedAt) return;
	const stopped = [...readStopped().filter((x) => x !== startedAt), startedAt].slice(-STOPPED_KEEP);
	writeAtomic(stoppedPath(), `${JSON.stringify({ stopped })}\n`);
}

/** The owner setting names this session: trimmed, case-insensitive, never empty. */
export const nameMatches = (owner: string, name: string | undefined) => {
	const o = owner.trim().toLowerCase();
	return !!o && o === (name ?? "").trim().toLowerCase();
};

// ── transcript records ───────────────────────────────────────────────────────

/** "HH:MM:SS" straight from the ISO string, so it stays in the meeting's local time. */
export const clock = (ts: string) => /T(\d\d:\d\d:\d\d)/.exec(ts)?.[1] ?? "";

export type Rec = {
	kind: "caption" | "chat" | "people" | "slide" | "revisit";
	ts: string;
	ms: number;
	speaker: string;
	text: string;
	slide: number; // slide and revisit: the slide's number
	count: number; // people
	names: string[]; // people
};

/** One transcript record as the tool sees it; null for metadata and anything unusable. */
export function parseRecord(raw: string): Rec | null {
	let r: Record<string, unknown>;
	try {
		r = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!r || typeof r !== "object") return null;
	const kind = r.type;
	if (kind !== "caption" && kind !== "chat" && kind !== "people" && kind !== "slide" && kind !== "revisit") return null;
	const ts = str(r.ts, 40);
	const rec: Rec = { kind, ts, ms: Date.parse(ts) || 0, speaker: "", text: "", slide: 0, count: 0, names: [] };
	if (kind === "caption" || kind === "chat") {
		rec.text = str(r.text, 4000).replace(/\s+/g, " ").trim();
		if (!rec.text) return null;
		rec.speaker = str(r.speaker, 120) || "Unknown";
	} else if (kind === "people") {
		rec.names = Array.isArray(r.people) ? r.people.filter((p): p is string => typeof p === "string").map((p) => p.slice(0, 120)) : [];
		rec.count = typeof r.count === "number" ? r.count : rec.names.length;
	} else {
		if (typeof r.slide !== "number" || !Number.isFinite(r.slide)) return null;
		rec.slide = r.slide;
	}
	return rec;
}

export const parseRecords = (text: string): Rec[] =>
	text
		.split("\n")
		.map((l) => (l.trim() ? parseRecord(l) : null))
		.filter((r): r is Rec => !!r);

/** `[HH:MM:SS] Speaker: text`, chat marked, slide markers and headcounts as one-liners. */
export function formatRec(r: Rec): string {
	const t = `[${clock(r.ts)}]`;
	switch (r.kind) {
		case "caption":
			return `${t} ${r.speaker}: ${r.text}`;
		case "chat":
			return `${t} (chat) ${r.speaker}: ${r.text}`;
		case "slide":
			return `${t} ▣ slide ${r.slide}`;
		case "revisit":
			return `${t} ↺ back to slide ${r.slide}`;
		case "people":
			return `${t} 👥 ${r.count} in the meeting`;
	}
}

/** A caption line from live.json, still growing. */
export type LiveLine = { speaker: string; text: string; ts: string };

export function parseLive(raw: unknown): LiveLine[] {
	const lines = (raw as { lines?: unknown } | null)?.lines;
	if (!Array.isArray(lines)) return [];
	return lines
		.map((l: unknown) => {
			const r = (l ?? {}) as Record<string, unknown>;
			return { speaker: str(r.speaker, 120) || "Unknown", text: str(r.text, 4000).replace(/\s+/g, " ").trim(), ts: str(r.ts, 40) };
		})
		.filter((l) => l.text);
}

export const formatLive = (l: LiveLine) => `[${clock(l.ts)}] ${l.speaker}: ${l.text} (still speaking)`;

// ── filters ──────────────────────────────────────────────────────────────────

export type Filter = { minutes?: number; since?: string; until?: string; speaker?: string; query?: string };

/** Minutes east of UTC in an ISO timestamp's own offset ("-05:00" is -300, "Z" is 0); undefined with none. */
export function isoOffsetMin(iso: string): number | undefined {
	if (/Z$/i.test(iso)) return 0;
	const m = /([+-])(\d\d):?(\d\d)$/.exec(iso);
	return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : undefined;
}

/**
 * "HH:MM" or "HH:MM:SS" or an ISO timestamp, as epoch ms. A bare time is read in
 * the meeting's own offset (taken from `startedAt`, so it matches the [HH:MM:SS]
 * the transcript shows whatever TZ pi runs in; this machine's offset when
 * `startedAt` has none) on the day the meeting started, or the next day if that
 * is more than 12 h before the start. An `end` bound without seconds covers its
 * whole minute. Undefined when unreadable.
 */
export function parseTimeSpec(spec: string, startMs: number, end = false, startedAt = ""): number | undefined {
	const s = spec.trim();
	const m = /^(\d{1,2}):(\d\d)(?::(\d\d))?$/.exec(s);
	if (m) {
		const base = startMs || Date.now();
		const off = isoOffsetMin(startedAt) ?? -new Date(base).getTimezoneOffset();
		const day = new Date(base + off * 60_000); // its UTC fields are the meeting's local clock
		let ms = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(m[1]), Number(m[2]), Number(m[3] ?? 0)) - off * 60_000;
		if (ms < base - 12 * 3_600_000) ms += 86_400_000;
		return end && m[3] === undefined ? ms + 59_999 : ms;
	}
	const iso = Date.parse(s);
	return Number.isFinite(iso) ? iso : undefined;
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);

/** A case-insensitive substring of the name, or every word of it a name part ("amy" in "Smith, Amy (ORG)"). */
export function speakerMatches(speaker: string, wanted: string): boolean {
	const w = wanted.trim().toLowerCase();
	if (!w) return true;
	if (speaker.toLowerCase().includes(w)) return true;
	const parts = new Set(words(speaker));
	const need = words(w);
	return need.length > 0 && need.every((x) => parts.has(x));
}

/** Every word appears somewhere in the text, in any order. */
export function queryMatches(text: string, query: string): boolean {
	const need = query.toLowerCase().split(/\s+/).filter(Boolean);
	const t = text.toLowerCase();
	return need.every((w) => t.includes(w));
}

/**
 * The records inside the filter. `ref` is "now" for `minutes`: the wall clock
 * during a meeting, the last record after it. A speaker or query leaves only
 * what people said, with no slide or headcount markers. Throws on a time it
 * can't read.
 */
export function filterRecords(recs: Rec[], f: Filter, ref: number, startMs: number, startedAt = ""): Rec[] {
	let from = -Infinity;
	let to = Infinity;
	if (typeof f.minutes === "number" && f.minutes > 0) from = ref - f.minutes * 60_000;
	if (f.since?.trim()) {
		const t = parseTimeSpec(f.since, startMs, false, startedAt);
		if (t === undefined) throw new Error(`Can't read since "${f.since}": use HH:MM, HH:MM:SS or an ISO time`);
		from = Math.max(from, t);
	}
	if (f.until?.trim()) {
		const t = parseTimeSpec(f.until, startMs, true, startedAt);
		if (t === undefined) throw new Error(`Can't read until "${f.until}": use HH:MM, HH:MM:SS or an ISO time`);
		to = t;
	}
	const talk = !!(f.speaker?.trim() || f.query?.trim());
	return recs.filter((r) => {
		if (r.ms && (r.ms < from || r.ms > to)) return false;
		if (!talk) return true;
		if (r.kind !== "caption" && r.kind !== "chat") return false;
		return speakerMatches(r.speaker, f.speaker ?? "") && queryMatches(r.text, f.query ?? "");
	});
}

/** Live lines pass the same speaker, query and since filters; they are happening now. */
export function filterLive(lines: LiveLine[], f: Filter, startMs: number, startedAt = ""): LiveLine[] {
	const since = f.since?.trim() ? parseTimeSpec(f.since, startMs, false, startedAt) : undefined;
	return lines.filter(
		(l) => (since === undefined || !Date.parse(l.ts) || Date.parse(l.ts) >= since) && speakerMatches(l.speaker, f.speaker ?? "") && queryMatches(l.text, f.query ?? ""),
	);
}

export const TOOL_LIMIT = 400;
export const TOOL_MAX_CHARS = 16_000;

/** Keep the newest lines under both caps; say what was cut at the top. */
export function truncateLines(lines: string[], limit = TOOL_LIMIT, maxChars = TOOL_MAX_CHARS): { text: string; cut: number } {
	const cap = limit > 0 ? limit : TOOL_LIMIT;
	let keep = lines.slice(-cap);
	const byLimit = lines.length - keep.length;
	let size = keep.reduce((n, l) => n + l.length + 1, 0);
	while (keep.length > 1 && size > maxChars) {
		size -= (keep[0] as string).length + 1;
		keep = keep.slice(1);
	}
	const cut = lines.length - keep.length;
	const why = cut > byLimit ? `over ~${Math.round(maxChars / 1000)}k characters` : `over ${cap} lines`;
	const head = cut > 0 ? [`[… ${cut} earlier line${cut === 1 ? "" : "s"} cut, ${why}; narrow with minutes, since, until, speaker or query …]`] : [];
	return { text: [...head, ...keep].join("\n"), cut };
}

// ── slides ───────────────────────────────────────────────────────────────────

/** The slide on screen: the last slide or revisit event. */
export function currentSlide(recs: Rec[]): number | undefined {
	for (let i = recs.length - 1; i >= 0; i--) {
		const r = recs[i] as Rec;
		if (r.kind === "slide" || r.kind === "revisit") return r.slide;
	}
	return undefined;
}

/** Distinct frames: revisits don't count. */
export const slideCount = (recs: Rec[]) => recs.filter((r) => r.kind === "slide").length;

export const lastPeople = (recs: Rec[]): Rec | undefined => recs.findLast((r) => r.kind === "people");

/** When slide `n` first came up, and every time the screen went back to it. */
export function slideTimes(recs: Rec[], n: number): { first?: Rec; again: Rec[] } {
	return { first: recs.find((r) => r.kind === "slide" && r.slide === n), again: recs.filter((r) => r.kind === "revisit" && r.slide === n) };
}

export type SlideEntry = { n: number; at: string; file: string; thumb: string; reason: string; width: number; height: number };

/** index.jsonl: one entry per saved frame. */
export function parseIndex(text: string): SlideEntry[] {
	const out: SlideEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as Record<string, unknown>;
			if (typeof r.n !== "number" || typeof r.file !== "string") continue;
			out.push({
				n: r.n,
				at: str(r.at, 40),
				file: path.basename(r.file),
				thumb: str(r.thumb, 100),
				reason: str(r.reason, 40),
				width: typeof r.width === "number" ? r.width : 0,
				height: typeof r.height === "number" ? r.height : 0,
			});
		} catch {
			// a half-written line: the next read has it
		}
	}
	return out;
}

export const slideFile = (dir: string, e: Pick<SlideEntry, "file">) => path.join(dir, path.basename(e.file));

/** The OCR text sits beside the jpg: 0003-141210.jpg → 0003-141210.txt. */
export const ocrPath = (dir: string, e: Pick<SlideEntry, "file">) => slideFile(dir, e).replace(/\.jpe?g$/i, ".txt");

// ── tool text ────────────────────────────────────────────────────────────────

/** "16 min" under an hour, "1h05m" after. */
export function elapsedLabel(ms: number): string {
	const m = Math.max(0, Math.floor(ms / 60_000));
	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m} min`;
}

export type StatusInfo = {
	title: string;
	app: string;
	startedAt: string;
	elapsedMs: number;
	live: boolean;
	endedAt?: string;
	people?: Rec;
	slides: number;
	slideOn?: number;
	ocr?: { done: number; total: number };
};

export function formatStatus(i: StatusInfo): string {
	const peopleNames = i.people?.names.length ? `: ${i.people.names.slice(0, 30).join(", ")}${i.people.names.length > 30 ? ", …" : ""}` : "";
	return [
		`Meeting: ${i.title || "(untitled)"}${i.app ? ` (${i.app})` : ""}`,
		`State: ${i.live ? "live" : `ended${i.endedAt ? ` at ${clock(i.endedAt) || i.endedAt}` : ""}`}`,
		`Started: ${clock(i.startedAt) || i.startedAt || "unknown"}`,
		`${i.live ? "Elapsed" : "Ran"}: ${elapsedLabel(i.elapsedMs)}`,
		i.people ? `People: ${i.people.count}${peopleNames}` : "People: not listed yet",
		`Slides: ${i.slides}${i.slideOn !== undefined ? `, slide ${i.slideOn} on screen` : ""}`,
		i.ocr ? `OCR: ${i.ocr.total === 0 ? "no slides yet" : i.ocr.done === 0 ? "none ready yet" : `${i.ocr.done} of ${i.ocr.total} slides`}` : "OCR: no slides directory",
	].join("\n");
}

/**
 * How far in, in steps of 5 min: the line is rebuilt every turn, so a number
 * that moved every minute would change the system prompt every turn.
 */
export function roundedElapsed(elapsedMs: number): string {
	const min = Math.floor(Math.max(0, elapsedMs) / 60_000);
	return min < 5 ? "just started" : `${min - (min % 5)} min in`;
}

/** The one line added to the session's system prompt while a meeting runs. */
export function promptLine(i: { title: string; app: string; elapsedMs: number; slide?: number; replay?: boolean }): string {
	const slide = i.slide !== undefined ? `, slide ${i.slide} on screen` : "";
	return `A meeting ${i.replay ? "replay is running" : "is live"}: ${i.title || "untitled"}${i.app ? ` (${i.app})` : ""}, ${roundedElapsed(i.elapsedMs)}${slide}. Use the meeting tool for anything about it.`;
}

/** `/meeting` with no arguments. */
export function statusReport(i: {
	armed: boolean;
	armedBy: string; // "/meeting watch", "PI_MEETING_WATCH", or ""
	owner: string;
	name: string;
	lock: Lock | null;
	lockAlive: boolean;
	mine: boolean;
	state: CaptureState | null;
	stateLive: boolean;
	nowMs: number;
}): string[] {
	const holder = !i.lock
		? "free"
		: `${i.mine ? "this session" : i.lock.name || `pid ${i.lock.pid}`} (via ${i.lock.via}, pid ${i.lock.pid}${i.lockAlive ? "" : ", gone"})`;
	const s = i.state;
	const meeting = !s
		? "none seen"
		: i.stateLive
			? `${s.title || "untitled"}${s.app ? ` (${s.app})` : ""}, live, ${elapsedLabel(i.nowMs - s.startedMs)} in`
			: `none live; the last was ${s.title || "untitled"}${s.app ? ` (${s.app})` : ""}, ${s.ended ? `ended${s.duration ? `, ${s.duration}` : ""}` : "its recorder is gone"}`;
	return [
		`Armed: ${i.armed ? `yes (${i.armedBy})` : "no (/meeting watch arms this session)"}`,
		`Owner setting: ${i.owner ? `${i.owner}${nameMatches(i.owner, i.name) ? " (this session)" : ""}` : "(none)"}${i.name ? ` · this session is ${i.name}` : ""}`,
		`Lock: ${holder}`,
		`Meeting: ${meeting}`,
	];
}
