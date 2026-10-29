// The live meeting feed: meeting-capture's files, read by the canvas daemon for
// the Meeting card (every session's side panel) and the /meeting page.
//
// The contract (meeting-capture docs/canvas-contract.md), all read-only here:
//   <state>/state.json  { v, pid, app, app_id, meeting, started_at, jsonl, txt,
//                         slides_dir, live, ended, ended_at?, duration? }
//                       written atomically; kept after the meeting ends
//                       (ended: true) until the next one starts.
//   live.json           { lines: [{ speaker, text, ts }] }, in-progress captions
//   <jsonl>             append-only, final records (metadata, caption, chat,
//                       people, slide)
//   <slides_dir>/index.jsonl  { n, at, file, thumb?, reason, width, height }
//
// And one file of pi's, the /meeting copilot's rolling notes
// (extensions/opt-in/meeting, notes.ts): <canvas root>/.meeting-notes.json, or
// PI_MEETING_NOTES_FILE. Topics, decisions, action items, alerts and a suggested
// reply. It counts only while it names this meeting (meeting.started_at equals
// state.json's) and its session is still there (pid alive) or it says ended.
//
// Nothing here touches the network or copies a file: the daemon serves slides
// straight from slides_dir, and only names listed in index.jsonl.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export const MEETING_STATE_DIR = resolve(process.env.MEETING_CAPTURE_STATE_DIR || join(homedir(), ".local", "state", "meeting-capture"));

/** The copilot's notes file: PI_MEETING_NOTES_FILE, else .meeting-notes.json in the canvas root. */
export const notesFilePath = (root) => resolve(process.env.PI_MEETING_NOTES_FILE || join(root, ".meeting-notes.json"));

/** How long an ended meeting keeps its card in the side panel. */
export const CARD_AFTER_END_MS = 15 * 60_000;

const TEXT_MAX = 4_000;
const SLIDE_FILE = /^\d{4}-\d{6}(\.thumb)?\.jpg$/;
const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");
const absOrNull = (v) => (typeof v === "string" && isAbsolute(v) ? v : null);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * state.json, checked: null when missing or unusable. A meeting not marked
 * ended whose pid is gone crashed: it reads as ended (crashed: true), from the
 * file's mtime.
 */
export function parseState(raw, { mtimeMs = Date.now(), alive = pidAlive } = {}) {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const crashed = !raw.ended && !alive(raw.pid);
  const ended = Boolean(raw.ended) || crashed;
  return {
    app: str(raw.app, 80),
    appId: str(raw.app_id, 40),
    title: str(raw.meeting, 300),
    startedAt: str(raw.started_at, 40),
    jsonl: absOrNull(raw.jsonl),
    txt: absOrNull(raw.txt),
    slidesDir: absOrNull(raw.slides_dir),
    live: absOrNull(raw.live),
    recording: !ended,
    ended,
    crashed,
    endedAt: ended ? str(raw.ended_at, 40) || new Date(mtimeMs).toISOString() : "",
    duration: str(raw.duration, 20),
  };
}

const NOTE_LIMITS = { topics: 8, decisions: 20, actions: 20, questions: 2, alerts: 20, me: 8 };
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/**
 * The copilot's notes file, checked: { pid, notes } or null. Bounded strings and
 * lists, only fields the page shows; no pid, session id or path reaches the page.
 */
export function normalizeNotes(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== 1 || !Number.isInteger(raw.pid)) return null;
  const meeting = raw.meeting && typeof raw.meeting === "object" ? raw.meeting : {};
  const reply = raw.reply && typeof raw.reply === "object" && typeof raw.reply.text === "string" && raw.reply.text.trim() ? { to: str(raw.reply.to, 100), text: str(raw.reply.text, 500), at: str(raw.reply.at, 40) } : null;
  const objs = (v, max) => list(v, max).filter((x) => x && typeof x === "object");
  const alerts = (Array.isArray(raw.alerts) ? raw.alerts : [])
    .filter((a) => a && typeof a === "object" && (a.kind === "name" || a.kind === "action") && typeof a.text === "string")
    .map((a) => ({ id: str(a.id, 40), kind: a.kind, who: str(a.who, 100), text: str(a.text, 400), at: str(a.at, 40) }))
    .slice(-NOTE_LIMITS.alerts); // newest last: keep the newest
  return {
    pid: raw.pid,
    startedAt: str(meeting.started_at, 40),
    notes: {
      session: str(raw.session?.name, 100),
      at: str(raw.at, 40),
      ended: raw.ended === true,
      me: (Array.isArray(raw.me) ? raw.me : []).filter((t) => typeof t === "string").map((t) => t.slice(0, 40)).slice(0, NOTE_LIMITS.me),
      topics: objs(raw.topics, NOTE_LIMITS.topics).map((t) => ({ title: str(t.title, 120), summary: str(t.summary, 400) })).filter((t) => t.title || t.summary),
      decisions: objs(raw.decisions, NOTE_LIMITS.decisions).map((d) => ({ text: str(d.text, 400), at: str(d.at, 40) })).filter((d) => d.text),
      actions: objs(raw.actions, NOTE_LIMITS.actions).map((a) => ({ who: str(a.who, 100), what: str(a.what, 400), mine: a.mine === true, at: str(a.at, 40) })).filter((a) => a.what),
      questions: objs(raw.questions, NOTE_LIMITS.questions).map((q) => ({ q: str(q.q, 300), why: str(q.why, 200) })).filter((q) => q.q),
      reply,
      alerts,
    },
  };
}

/** One transcript record as the page sees it (no absolute paths), or null to skip it. */
export function normalizeRecord(r) {
  if (!r || typeof r !== "object") return null;
  const ts = str(r.ts, 40);
  switch (r.type) {
    case "caption":
    case "chat":
      if (typeof r.text !== "string" || !r.text.trim()) return null;
      return { type: r.type, speaker: str(r.speaker, 120), text: str(r.text, TEXT_MAX), ts };
    case "people": {
      const people = Array.isArray(r.people) ? r.people.filter((p) => typeof p === "string").slice(0, 300).map((p) => p.slice(0, 120)) : [];
      return { type: "people", count: people.length, people, text: str(r.text, 400), ts };
    }
    case "slide":
    case "revisit": // back to a frame saved earlier: nothing new in slides_dir, n is the original
      if (!Number.isInteger(r.slide) || r.slide < 0) return null;
      return { type: r.type, n: r.slide, reason: str(r.reason, 40), ts };
    case "metadata":
      if (r.event === "stopped") return { type: "stopped", duration: str(r.duration, 20), ts };
      return null; // the header: state.json already carries app, title and start
    default:
      return null;
  }
}

/** Complete lines of jsonl text: { records, rest } (rest: a trailing partial line, still being written). */
export function parseLines(text) {
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  const records = [];
  for (const line of parts) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  return { records, rest };
}

/** An index.jsonl entry, checked: file names only, never a path. */
export function normalizeSlide(s) {
  if (!s || typeof s !== "object" || !Number.isInteger(s.n) || s.n < 0) return null;
  const file = typeof s.file === "string" ? s.file.split("/").pop() : "";
  if (!SLIDE_FILE.test(file)) return null;
  const thumb = typeof s.thumb === "string" && SLIDE_FILE.test(s.thumb) ? s.thumb : null;
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  return { n: s.n, at: str(s.at, 40), file, thumb, reason: str(s.reason, 40), width: num(s.width), height: num(s.height) };
}

/** live.json's in-progress lines, oldest first (at most 6). */
export function normalizeLive(raw) {
  const lines = Array.isArray(raw?.lines) ? raw.lines : [];
  return lines
    .filter((l) => l && typeof l.text === "string" && l.text.trim())
    .slice(-6)
    .map((l) => ({ speaker: str(l.speaker, 120), text: str(l.text, TEXT_MAX), ts: str(l.ts, 40) }));
}

const sig = (path) => {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** Bytes [from, to) of a file as utf8 (a Buffer, so a split multibyte char waits for the rest). */
function readRange(path, from, to) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(to - from);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * Tails one append-only jsonl file by byte offset. Only whole lines count; a
 * partial last line waits. A file that shrank or was replaced starts over.
 */
export class JsonlTail {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.ino = 0;
    this.pending = Buffer.alloc(0);
  }
  /** New records since the last call; reset: true when it started over. */
  read() {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      return { records: [], reset: false };
    }
    let reset = false;
    if ((this.ino && st.ino !== this.ino) || st.size < this.offset) {
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      reset = true;
    }
    this.ino = st.ino;
    if (st.size === this.offset) return { records: [], reset };
    const chunk = Buffer.concat([this.pending, readRange(this.path, this.offset, st.size)]);
    this.offset = st.size;
    const nl = chunk.lastIndexOf(0x0a);
    this.pending = nl < 0 ? chunk : chunk.subarray(nl + 1);
    if (nl < 0) return { records: [], reset };
    return { records: parseLines(chunk.subarray(0, nl + 1).toString("utf8")).records, reset };
  }
}

/** A meeting's short id: the page's cursor and the slide URLs' cache key. */
export const meetingId = (state) => (state ? createHash("sha1").update(`${state.appId}|${state.startedAt}`).digest("hex").slice(0, 12) : "");

/**
 * The live meeting, kept current by poll(): the daemon calls it on a timer
 * (fast while recording) and tells pages what changed.
 */
export class MeetingFeed {
  constructor(dir = MEETING_STATE_DIR, { now = Date.now, alive = pidAlive, notesFile = "" } = {}) {
    this.dir = dir;
    this.now = now;
    this.alive = alive;
    this.notesFile = notesFile;
    this.rawNotes = null; // the file as read: { pid, startedAt, notes }
    this.notes = null; // what counts: it names this meeting and its session is there, or it ended
    this.state = null;
    this.id = "";
    this.entries = [];
    this.slides = [];
    this.live = [];
    this.changedAt = "";
    this.sigs = { state: "", live: "", index: "", notes: "" };
    this.tail = null;
    this.indexTail = null;
  }

  /** Re-read whatever changed. Returns { final, live }: which kinds of change there were. */
  poll() {
    let final = false;
    let live = false;
    const statePath = join(this.dir, "state.json");
    const sState = sig(statePath);
    // A dead pid flips the state without the file changing: recheck while recording.
    if (sState !== this.sigs.state || (this.state?.recording && !this.alive(this.rawPid))) {
      this.sigs.state = sState;
      const raw = sState ? readJson(statePath) : null;
      this.rawPid = raw?.pid;
      let mtimeMs = this.now();
      try {
        mtimeMs = statSync(statePath).mtimeMs;
      } catch {}
      const next = parseState(raw, { mtimeMs, alive: this.alive });
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        const id = meetingId(next);
        if (id !== this.id) {
          this.entries = [];
          this.slides = [];
          this.live = [];
          this.tail = null;
          this.indexTail = null;
          this.sigs.live = "";
          this.sigs.index = "";
        }
        this.state = next;
        this.id = id;
        final = true;
      }
    }
    const st = this.state;
    if (this.syncNotes()) final = true;
    if (!st) return this.mark(final, live);

    if (st.jsonl && (!this.tail || this.tail.path !== st.jsonl)) this.tail = new JsonlTail(st.jsonl);
    if (this.tail) {
      const { records, reset } = this.tail.read();
      if (reset) this.entries = [];
      const add = records.map(normalizeRecord).filter(Boolean);
      if (add.length || reset) {
        this.entries.push(...add);
        final = true;
      }
    }

    if (st.slidesDir) {
      const index = join(st.slidesDir, "index.jsonl");
      if (!this.indexTail || this.indexTail.path !== index) this.indexTail = new JsonlTail(index);
      const { records, reset } = this.indexTail.read();
      if (reset) this.slides = [];
      const add = records.map(normalizeSlide).filter(Boolean);
      if (add.length || reset) {
        for (const s of add) {
          const i = this.slides.findIndex((x) => x.n === s.n);
          if (i >= 0) this.slides[i] = s;
          else this.slides.push(s);
        }
        final = true;
      }
    }

    const livePath = st.recording ? st.live : null;
    const sLive = livePath ? sig(livePath) : "";
    if (sLive !== this.sigs.live) {
      this.sigs.live = sLive;
      const next = sLive ? normalizeLive(readJson(livePath)) : [];
      if (JSON.stringify(next) !== JSON.stringify(this.live)) {
        this.live = next;
        live = true;
      }
    } else if (!st.recording && this.live.length) {
      this.live = [];
      live = true;
    }
    return this.mark(final, live);
  }

  /**
   * The notes file, re-read when its stat changes and re-judged every poll (a
   * dead session's notes stop counting, a new meeting's started_at drops the
   * old ones). True when what counts changed.
   */
  syncNotes() {
    if (this.notesFile) {
      const s = sig(this.notesFile);
      if (s !== this.sigs.notes) {
        this.sigs.notes = s;
        this.rawNotes = s ? normalizeNotes(readJson(this.notesFile)) : null;
      }
    }
    const raw = this.rawNotes;
    const ok = raw && this.state && raw.startedAt === this.state.startedAt && (raw.notes.ended || this.alive(raw.pid));
    const next = ok ? raw.notes : null;
    if (JSON.stringify(next) === JSON.stringify(this.notes)) return false;
    this.notes = next;
    return true;
  }

  mark(final, live) {
    if (final) this.changedAt = new Date(this.now()).toISOString();
    return { final, live };
  }

  /** Who is in the meeting: the newest people record. */
  people() {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].type === "people") return this.entries[i];
    return null;
  }

  /** The slide on screen now: the newest slide or revisit event (else the newest saved frame). */
  current() {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if ((e.type === "slide" || e.type === "revisit") && this.slides.some((s) => s.n === e.n)) return this.slides.find((s) => s.n === e.n);
    }
    return this.slides[this.slides.length - 1] || null;
  }

  /** The page's view: entries after `since` (all of them when `id` is another meeting's). */
  snapshot(since = 0, id = "") {
    if (!this.state) return { id: "", state: null, entries: [], total: 0, from: 0, slides: [], live: [], people: null, notes: null };
    const from = id === this.id && Number.isInteger(since) && since >= 0 && since <= this.entries.length ? since : 0;
    const p = this.people();
    const { jsonl: _j, txt: _t, slidesDir: _s, live: _l, ...state } = this.state;
    return {
      id: this.id,
      state: { ...state, hasTranscript: Boolean(this.state.jsonl), hasSlides: Boolean(this.state.slidesDir) },
      entries: this.entries.slice(from),
      total: this.entries.length,
      from,
      slides: this.slides.map(({ n, at, reason, width, height, thumb }) => ({ n, at, reason, width, height, thumb: Boolean(thumb) })),
      live: this.live,
      people: p ? { count: p.count, people: p.people } : null,
      notes: this.notes,
    };
  }

  /** The side panel card's data, or null when there's nothing to show (no meeting, or ended a while ago). */
  summary() {
    const st = this.state;
    if (!st) return null;
    if (st.ended) {
      const end = Date.parse(st.endedAt);
      if (!Number.isFinite(end) || this.now() - end > CARD_AFTER_END_MS) return null;
    }
    const recent = this.entries.filter((e) => e.type === "caption" || e.type === "chat").slice(-4);
    const last = this.current();
    const p = this.people();
    return {
      id: this.id,
      title: st.title,
      app: st.app,
      startedAt: st.startedAt,
      recording: st.recording,
      ended: st.ended,
      crashed: st.crashed,
      endedAt: st.endedAt,
      duration: st.duration,
      people: p?.count ?? null,
      captions: this.entries.filter((e) => e.type === "caption").length,
      slides: this.slides.length,
      slide: last ? { n: last.n, thumb: Boolean(last.thumb) } : null,
      recent,
      notes: this.notesSummary(),
      at: this.changedAt,
    };
  }

  /** The card's slice of the notes: the alert count, the newest alert's id and the newest 3 (newest last), Eric's open actions, questions, the reply. */
  notesSummary() {
    const n = this.notes;
    if (!n) return null;
    return {
      ended: n.ended,
      alertCount: n.alerts.length,
      lastAlertId: n.alerts.at(-1)?.id ?? "", // the count stops at the cap; the newest id keeps changing
      alerts: n.alerts.slice(-3),
      actions: n.actions.filter((a) => a.mine),
      questions: n.questions,
      reply: n.reply,
    };
  }

  /**
   * A slide's file on disk, or null. Only names index.jsonl listed, and only
   * inside slides_dir once symlinks are resolved. thumb falls back to the full image.
   */
  slideFile(id, n, thumb = false) {
    const st = this.state;
    if (!st?.slidesDir || id !== this.id) return null;
    const s = this.slides.find((x) => x.n === n);
    if (!s) return null;
    const name = thumb && s.thumb ? s.thumb : s.file;
    if (!SLIDE_FILE.test(name)) return null;
    try {
      const root = realpathSync(st.slidesDir);
      const path = realpathSync(join(st.slidesDir, name));
      return path.startsWith(root + sep) && existsSync(path) ? path : null;
    } catch {
      return null;
    }
  }
}
