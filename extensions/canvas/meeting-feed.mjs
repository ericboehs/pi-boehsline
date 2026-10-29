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
// PI_MEETING_NOTES_FILE. Topics, decisions, action items, alerts, a suggested
// reply and the slide summaries (a vision model's title, what, why, points and
// numbers per slide, by slide number). It counts only while it names this meeting (meeting.started_at equals
// state.json's) and its session is still there (pid alive) or it says ended.
//
// History (the /meetings page, the card's recent list): meeting-capture's data
// directory, one <base>.jsonl (+ <base>.slides/) per meeting, and the copilot's
// archived notes, <canvas root>/meetings/<id>.json (PI_MEETING_NOTES_DIR). The
// live meeting and its history entry share one id, sha1(app_id|started_at).
// Real data is untidy: app_id comes from the metadata's app_id, else its source
// without a trailing -ax, else the file name's token (teams|zoom|meet|slack;
// older names have none); a <base>-merged.jsonl hides the fragments it lists
// (merged_from) and takes their slides, numbered consecutively in fragment order;
// a title like "Meeting join…" is replaced by the file name's slug; files under
// 300 bytes and the Slack notification captures are not meetings.
//
// Nothing here touches the network or copies a file: the daemon serves slides
// straight from slides_dir, and only names listed in index.jsonl.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const MEETING_STATE_DIR = resolve(process.env.MEETING_CAPTURE_STATE_DIR || join(homedir(), ".local", "state", "meeting-capture"));

/** The copilot's notes file: PI_MEETING_NOTES_FILE, else .meeting-notes.json in the canvas root. */
export const notesFilePath = (root) => resolve(process.env.PI_MEETING_NOTES_FILE || join(root, ".meeting-notes.json"));

/** The copilot's archived notes, one <meeting id>.json each: PI_MEETING_NOTES_DIR, else meetings/ in the canvas root. Kept forever. */
export const notesDirPath = (root) => resolve(process.env.PI_MEETING_NOTES_DIR || join(root, "meetings"));

/**
 * Where meeting-capture keeps its transcripts. An explicit dir (the daemon's
 * --meeting-data) or MEETING_CAPTURE_DATA_DIR wins, then the folder of the live
 * state's jsonl, then the last one seen (state.json may be gone), then the XDG default.
 */
export function meetingDataDir({ explicit = "", jsonl = null, last = "", env = process.env } = {}) {
  const e = explicit || env.MEETING_CAPTURE_DATA_DIR;
  if (e) return resolve(e);
  if (jsonl) return dirname(jsonl);
  if (last) return last;
  return resolve(env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "meeting-capture") : join(homedir(), ".local", "share", "meeting-capture"));
}

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

const NOTE_LIMITS = { topics: 8, decisions: 20, actions: 20, questions: 2, alerts: 20, me: 8, slides: 120, points: 4, numbers: 4 };
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/** The copilot's slide summaries, checked: n an integer of 1 or more, one per n (the last wins), sorted by n, bounded strings and lists. */
export function normalizeSlideSummaries(raw) {
  if (!Array.isArray(raw)) return [];
  const byN = new Map();
  const texts = (v, max, n) => (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && x.trim()).slice(0, max).map((x) => x.slice(0, n));
  for (const s of raw) {
    if (!s || typeof s !== "object" || !Number.isInteger(s.n) || s.n < 1) continue;
    const title = str(s.title, 120);
    const what = str(s.what, 500);
    if (!title.trim() && !what.trim()) continue;
    byN.set(s.n, { n: s.n, title, what, why: str(s.why, 400), points: texts(s.points, NOTE_LIMITS.points, 200), numbers: texts(s.numbers, NOTE_LIMITS.numbers, 100), at: str(s.at, 40) });
  }
  return [...byN.values()].sort((a, b) => a.n - b.n).slice(-NOTE_LIMITS.slides);
}

/** Summaries by slide number, as the page wants them (no `n` or `at` inside). */
const summaryMap = (n) => Object.fromEntries((n?.slides ?? []).map(({ n: k, title, what, why, points, numbers }) => [k, { title, what, why, points, numbers }]));

/** The notes without the summaries: those travel as a map by slide number. */
const withoutSlides = (n) => {
  if (!n) return null;
  const { slides: _s, ...rest } = n;
  return rest;
};

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
      slides: normalizeSlideSummaries(raw.slides),
      slidesOn: raw.slidesOn === true,
      slidesFailed: [...new Set((Array.isArray(raw.slidesFailed) ? raw.slidesFailed : []).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b).slice(-NOTE_LIMITS.slides),
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

// ── history ──

const SCAN_MS = 10_000;
const SEARCH_MAX_FILE = 20 * 1024 * 1024; // over this: the list reads the head and tail only, search skips the lines, /meeting?id= shows the end
const LINES_CACHE_BYTES = 50 * 1024 * 1024;
const SEARCH_READ_BYTES = 25 * 1024 * 1024; // one search reads at most this much from disk; with the cache's own cap it bounds the cache during a search
const SEARCH_BUDGET_MS = 150; // one search runs for about this long, then stops and says partial
const ID_HEAD_BYTES = 8 * 1024; // find() reads this much of a file to learn its id: the header line
const SCAN_BUDGET_MS = 50; // one scan() call parses files for about this long, then returns what is ready
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const PAST_TAIL_BYTES = 8 * 1024 * 1024; // a past meeting over 20 MB loads this much of its end
const LOADED_KEEP = 3;
const LOADED_BYTES = 48 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{12}$/;
const FILE_RE = /^(\d{8})_(\d{6})-(.+)\.jsonl$/;
const APP_TOKENS = new Set(["teams", "zoom", "meet", "slack"]);
const MIN_BYTES = 300; // a smaller file is a stub, not a meeting
const NOISE_RE = /-slack-notifications(-|\.)/;
const FRAGMENT_RE = /^\d{8}_\d{6}-[\w.-]+$/;

/**
 * A data folder listing, newest first, with the merged files ahead of the rest: a time-capped scan then reads
 * a merged file (which hides its fragments) before it can list a fragment, and find() meets "X-merged" before "X".
 */
function newestFirst(names) {
  const sorted = [...names].sort().reverse();
  return [...sorted.filter((f) => /-merged\.jsonl$/.test(f)), ...sorted.filter((f) => !/-merged\.jsonl$/.test(f))];
}

/**
 * A data folder's file name as [file, date, time, app token, slug], or null. Newer names are
 * <date>_<time>-<app>-<slug>.jsonl; older ones omit the app (<date>_<time>-<slug>), so the token
 * is only taken when it is teams, zoom, meet or slack, else "" and the whole rest is the slug.
 * Noise (the Slack notification captures) is null too.
 */
function splitName(f) {
  const m = FILE_RE.exec(f);
  if (!m || NOISE_RE.test(f)) return null;
  const rest = m[3];
  const i = rest.indexOf("-");
  const tok = (i < 0 ? rest : rest.slice(0, i)).toLowerCase();
  return APP_TOKENS.has(tok) ? [f, m[1], m[2], tok, i < 0 ? "" : rest.slice(i + 1)] : [f, m[1], m[2], "", rest];
}

/** The app id for the history: the metadata's app_id, else its source without a trailing -ax, else the file name's token. */
const appIdOf = (meta, name) => str(meta?.app_id, 40) || str(meta?.source, 40).replace(/-ax$/, "") || name[3];

/** A slug as a title: "weekly-sync-merged" is "Weekly sync". */
function slugTitle(slug) {
  const t = String(slug || "").replace(/-merged$/, "").replace(/-/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The title shown: the metadata's meeting unless it is empty or junk ("Meeting join…"), then the slug. */
function titleOf(meta, name) {
  const t = str(meta?.meeting, 300).trim();
  return t && !/^Meeting join/i.test(t) ? t : slugTitle(name[4]) || t;
}
const pad2 = (n) => String(n).padStart(2, "0");
/** "1:02:03" from milliseconds, "" for nonsense. */
const hms = (ms) => {
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
};
const fileSig = (st) => `${st.size}:${st.mtimeMs}`;

/** A slides folder's index.jsonl as normalized slides (one per n, the last wins). */
function readSlideIndex(slidesDir) {
  let text = "";
  try {
    text = readFileSync(join(slidesDir, "index.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const s of parseLines(text.endsWith("\n") ? text : `${text}\n`).records.map(normalizeSlide).filter(Boolean)) {
    const i = out.findIndex((x) => x.n === s.n);
    if (i >= 0) out[i] = s;
    else out.push(s);
  }
  return out;
}

/** Whole lines of the end of a file: the bytes from `from` on, minus the (probably cut) first line. */
function tailRecords(path, from, size) {
  const buf = readRange(path, from, size);
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return [];
  const text = buf.subarray(nl + 1).toString("utf8");
  return parseLines(text.endsWith("\n") ? text : `${text}\n`).records;
}

/**
 * A <base>-merged.jsonl's parts: metadata.merged_from names the fragments (base names). Only bases that
 * exist in the same data folder count, and every path is built from the folder and the base, never taken
 * from the file. Its slides are the fragments' slides, numbered consecutively in fragment order; `map`
 * turns a slide event's (fragment base, image name) or (fragment base, old number) into the new number.
 * null for a file that merges nothing here.
 */
function mergedOf(path, meta) {
  if (!Array.isArray(meta?.merged_from)) return null;
  const dir = dirname(path);
  const own = path.split(sep).pop().replace(/\.jsonl$/, "");
  const bases = [];
  for (const v of meta.merged_from) {
    if (typeof v !== "string") continue;
    const b = v.split("/").pop().replace(/\.jsonl$/, "");
    if (b === own || !FRAGMENT_RE.test(b) || b.includes("..") || bases.includes(b) || !existsSync(join(dir, `${b}.jsonl`))) continue;
    bases.push(b);
  }
  if (!bases.length) return null;
  const slides = [];
  const map = new Map();
  for (const base of bases) {
    const sdir = join(dir, `${base}.slides`);
    for (const s of readSlideIndex(sdir).sort((a, b) => a.n - b.n)) {
      const n = slides.length + 1;
      slides.push({ ...s, n, dir: sdir });
      map.set(`${base}/${s.file}`, n);
      map.set(`${base}#${s.n}`, n);
    }
  }
  return { bases, slides, map };
}

/** A merged meeting's slide or revisit record with its slide number mapped to the merged numbering (null: not one of the fragments' slides). Other records pass through. */
function remapMerged(r, merged) {
  if (!merged || (r?.type !== "slide" && r?.type !== "revisit")) return r;
  const parts = (typeof r.file === "string" ? r.file : "").split("/");
  const file = parts.pop();
  const dir = parts.pop() ?? "";
  const base = dir.endsWith(".slides") ? dir.slice(0, -7) : "";
  const n = merged.map.get(`${base}/${file}`) ?? merged.map.get(`${base}#${r.slide}`);
  return n ? { ...r, slide: n } : null;
}

/** A transcript's meeting id from its first line only (the metadata header), like parseMeetingFile derives it. "" when unreadable. */
function headId(path, name) {
  let meta = null;
  try {
    const head = readRange(path, 0, ID_HEAD_BYTES).toString("utf8");
    const nl = head.indexOf("\n");
    const r = nl < 0 ? null : parseLines(head.slice(0, nl + 1)).records[0];
    if (r?.type === "metadata" && r.event !== "stopped") meta = r;
  } catch {
    return "";
  }
  const stampMs = new Date(+name[1].slice(0, 4), +name[1].slice(4, 6) - 1, +name[1].slice(6, 8), +name[2].slice(0, 2), +name[2].slice(2, 4), +name[2].slice(4, 6)).getTime();
  return meetingId({ appId: appIdOf(meta, name), startedAt: str(meta?.recorded_at, 40) || new Date(stampMs).toISOString() });
}

/**
 * One finished-or-abandoned transcript, for the list: what the file says. null
 * when empty. A file over 20 MB is read in part: its first line (the header)
 * and its last 64 KB (people, stopped, the last ts); its caption count then
 * only covers that tail.
 */
function parseMeetingFile(path, name, size = 0) {
  let records;
  const partial = size > SEARCH_MAX_FILE;
  try {
    if (partial) {
      const head = readRange(path, 0, HEAD_BYTES).toString("utf8");
      const nl = head.indexOf("\n");
      records = [...(nl < 0 ? [] : parseLines(head.slice(0, nl + 1)).records), ...tailRecords(path, Math.max(0, size - TAIL_BYTES), size)];
    } else {
      const text = readFileSync(path, "utf8");
      records = parseLines(text.endsWith("\n") ? text : `${text}\n`).records;
    }
  } catch {
    return null;
  }
  if (!records.length) return null;
  const merged = mergedOf(path, records.find((r) => r?.type === "metadata" && r.event !== "stopped"));
  let meta = null;
  let stopped = null;
  let people = null;
  let lastTs = "";
  let captions = 0;
  const slideSet = new Set();
  for (const r of records) {
    if (r && typeof r === "object" && typeof r.ts === "string" && r.ts) lastTs = r.ts.slice(0, 40);
    if (r?.type === "metadata") {
      if (r.event === "stopped") stopped = r;
      else if (!meta) meta = r;
      continue;
    }
    const e = normalizeRecord(remapMerged(r, merged));
    if (!e) continue;
    if (e.type === "caption") captions++;
    else if (e.type === "people") people = e;
    else if (e.type === "slide") slideSet.add(e.n);
  }
  const stampMs = new Date(+name[1].slice(0, 4), +name[1].slice(4, 6) - 1, +name[1].slice(6, 8), +name[2].slice(0, 2), +name[2].slice(2, 4), +name[2].slice(4, 6)).getTime();
  const startedAt = str(meta?.recorded_at, 40) || new Date(stampMs).toISOString();
  const startedMs = Date.parse(startedAt) || stampMs;
  const appId = appIdOf(meta, name);
  const endedAt = stopped ? str(stopped.stopped_at, 40) || lastTs : lastTs;
  const slidesDir = path.replace(/\.jsonl$/, ".slides");
  const slideIndex = merged ? merged.slides : readSlideIndex(slidesDir);
  return {
    id: meetingId({ appId, startedAt }),
    path,
    slidesDir,
    app: str(meta?.app, 80),
    appId,
    title: titleOf(meta, name),
    startedAt,
    startedMs,
    endedAt,
    duration: (stopped && str(stopped.duration, 20)) || hms(Date.parse(endedAt) - startedMs),
    stopped: Boolean(stopped),
    live: false,
    partial,
    people: people?.people ?? [],
    captions,
    slideCount: slideIndex.length || slideSet.size,
    thumb: slideIndex.some((s) => s.n === 1),
    slideIndex,
    merged,
    fragments: merged ? merged.bases : [],
    size: 0,
  };
}

/** The list's one-line notes: counts and up to four topic titles. null without notes. */
const notesBrief = (n) => (n ? { actions: n.actions.length, mine: n.actions.filter((a) => a.mine).length, topics: n.topics.map((t) => t.title).filter(Boolean).slice(0, 4) } : null);

/** A matching line, cut to a window around the first term when it is long. */
function snippet(text, terms) {
  if (text.length <= 400) return text;
  const low = text.toLowerCase();
  const found = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0);
  const at = found.length ? Math.min(...found) : 0; // a term can match only the speaker
  const from = Math.max(0, at - 120);
  return `${from ? "…" : ""}${text.slice(from, from + 400)}…`;
}

/**
 * The live meeting, kept current by poll(): the daemon calls it on a timer
 * (fast while recording) and tells pages what changed.
 */
export class MeetingFeed {
  constructor(dir = MEETING_STATE_DIR, { now = Date.now, alive = pidAlive, notesFile = "", notesDir = "", dataDir = "", scanBudgetMs = SCAN_BUDGET_MS, searchBytes = SEARCH_READ_BYTES, searchBudgetMs = SEARCH_BUDGET_MS, linesCacheBytes = LINES_CACHE_BYTES } = {}) {
    this.dir = dir;
    this.notesDir = notesDir; // the archived notes: <id>.json
    this.dataDirOpt = dataDir; // --meeting-data; MEETING_CAPTURE_DATA_DIR is read when needed
    this.lastDataDir = ""; // the last transcript folder state.json named
    this.scanBudgetMs = scanBudgetMs;
    this.searchBytes = searchBytes;
    this.searchBudgetMs = searchBudgetMs;
    this.linesCacheBytes = linesCacheBytes;
    this.searchGen = 0; // the current search: the lines cache keeps what it used
    this.scanned = null; // { dir, at, list, byId, partial }
    this.infos = new Map(); // path → { sig, info }
    this.headIds = new Map(); // path → { sig, id }: find()'s ids from file headers, for files not parsed yet
    this.linesCache = new Map(); // path → { sig, lines, bytes, gen } (LRU by bytes)
    this.linesBytes = 0;
    this.loaded = new Map(); // id → { sig, p, bytes } (LRU, 3 and a byte budget)
    this.archive = new Map(); // id → { sig, notes }
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
        if (next?.jsonl) this.lastDataDir = dirname(next.jsonl);
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

  /**
   * The page's view: entries after `since`. `id` picks the meeting: empty or the
   * live one's id is the live meeting, another is a past one (ended, or
   * notFound). `cur` is the id the caller's cursor belongs to (default `id`).
   */
  snapshot(since = 0, id = "", cur = id) {
    if (id && !(this.state && id === this.id)) return this.pastSnapshot(since, id, cur);
    if (!this.state) return { id: "", state: null, entries: [], total: 0, from: 0, slides: [], live: [], people: null, notes: null, summaries: {} };
    const from = cur === this.id && Number.isInteger(since) && since >= 0 && since <= this.entries.length ? since : 0;
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
      notes: withoutSlides(this.notes),
      summaries: summaryMap(this.notes),
    };
  }

  /** The card's light poll (/api/meeting?tail=1): only the new entries and the in-progress lines, none of the slide list, notes, people or summaries. */
  tailSnapshot(since = 0, id = "", cur = id) {
    const { id: sid, from, total, entries, live } = this.snapshot(since, id, cur);
    return { id: sid, from, total, entries, live };
  }

  /** A past meeting for /meeting?id=: its whole transcript from the data folder (by id, never a client path), or notFound. */
  pastSnapshot(since, id, cur) {
    const p = this.loadPast(id);
    if (!p) return { id: "", state: null, entries: [], total: 0, from: 0, slides: [], live: [], people: null, notes: null, summaries: {}, notFound: true };
    const { info, entries, slides } = p;
    const from = cur === id && Number.isInteger(since) && since >= 0 && since <= entries.length ? since : 0;
    let people = null;
    for (let i = entries.length - 1; i >= 0 && !people; i--) if (entries[i].type === "people") people = { count: entries[i].count, people: entries[i].people };
    return {
      id,
      state: { app: info.app, appId: info.appId, title: info.title, startedAt: info.startedAt, recording: false, ended: true, crashed: !info.stopped, endedAt: info.endedAt, duration: info.duration, hasTranscript: true, hasSlides: slides.length > 0 },
      entries: entries.slice(from),
      total: entries.length,
      from,
      slides: slides.map(({ n, at, reason, width, height, thumb }) => ({ n, at, reason, width, height, thumb: Boolean(thumb) })),
      live: [],
      people,
      notes: withoutSlides(this.notesOf(info)),
      summaries: summaryMap(this.notesOf(info)),
      ...(p.partial ? { partial: true } : {}),
    };
  }

  /**
   * The side panel card's data, or null when there's nothing to show. kind:
   * "live" (recording), "ended" (within 15 minutes of the end: the card keeps
   * the alerts and your action items) or "list" (just the recent meetings).
   * `recent` is the newest four meetings, the live one among them.
   */
  summary() {
    const st = this.state;
    let kind = "list";
    if (st) {
      if (!st.ended) kind = "live";
      else {
        const end = Date.parse(st.endedAt);
        if (Number.isFinite(end) && this.now() - end <= CARD_AFTER_END_MS) kind = "ended";
      }
    }
    // The live card never shows the list; the other two do.
    const recent = kind === "live" ? [] : this.history({ limit: 4 });
    // `at` is what the page re-renders on: the feed's last change, the card's kind (the 15 minutes
    // run out with no feed change) and what the list shows (new meetings, new ★ counts).
    const at = `${this.changedAt}|${kind}|${recent.map((e) => `${e.id}.${e.live ? 1 : 0}.${e.duration}.${e.notes?.mine ?? ""}`).join(",")}`;
    if (kind === "list") return recent.length ? { kind, id: "", recording: false, ended: false, recent, notes: null, at } : null;
    // Enough lines for four speaker blocks on the card; it tails /api/meeting from `total` on.
    const lines = this.entries.filter((e) => e.type === "caption" || e.type === "chat").slice(-12);
    const last = this.current();
    const p = this.people();
    return {
      kind,
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
      slide: last ? { n: last.n, thumb: Boolean(last.thumb), ...this.slideSummaryOf(last.n) } : null,
      lines,
      live: this.live,
      total: this.entries.length,
      recent,
      notes: this.notesSummary(),
      at,
    };
  }

  /** { summary: { title, what, why } } for slide n when the copilot has summarized it, else {}: the card shows only this much of it. */
  slideSummaryOf(n) {
    const s = this.notes?.slides.find((x) => x.n === n);
    return s ? { summary: { title: s.title, what: s.what, why: s.why } } : {};
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

  // ── history: every meeting in the data folder, newest first ──

  /** The transcript folder now (see meetingDataDir). */
  dataDir() {
    return meetingDataDir({ explicit: this.dataDirOpt, jsonl: this.state?.jsonl ?? null, last: this.lastDataDir });
  }

  /** Drop the scan cache: the next history, search or lookup lists the folder again. */
  rescan() {
    this.scanned = null;
  }

  /**
   * The folder's meetings, listed at most every 10 s; a file is parsed again
   * only when its size or mtime changed. The live meeting's own file is the
   * feed's, not parsed here. Newest files first, and a call parses for about
   * 50 ms: with a big cold archive it returns what is ready with partial: true
   * (and is not cached, so the next call goes on). `full` ignores the budget.
   */
  scan(full = false) {
    const dir = this.dataDir();
    const t = this.now();
    if (this.scanned && this.scanned.dir === dir && !this.scanned.partial && t - this.scanned.at < SCAN_MS) return this.scanned;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {}
    names = newestFirst(names); // <YYYYMMDD_HHMMSS>-…: newest first, merged files before the fragments they hide
    const all = [];
    const seen = new Set();
    const t0 = performance.now();
    let parsed = 0;
    let partial = false;
    for (const f of names) {
      const m = splitName(f);
      if (!m) continue;
      const path = join(dir, f);
      if (this.state?.jsonl === path) continue;
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size < MIN_BYTES) continue;
      seen.add(path);
      const sig = fileSig(st);
      let c = this.infos.get(path);
      if (!c || c.sig !== sig) {
        if (!full && parsed > 0 && performance.now() - t0 >= this.scanBudgetMs) {
          partial = true; // out of time: the next call goes on from here (a changed file keeps its old row meanwhile)
        } else {
          const info = parseMeetingFile(path, m, st.size);
          parsed++;
          if (info) Object.assign(info, { size: st.size, sig });
          c = { sig, info };
          this.infos.set(path, c);
        }
      }
      if (c?.info) all.push(c.info);
    }
    // A merged file stands in for the fragments it lists.
    const hidden = new Set(all.flatMap((i) => i.fragments.map((b) => join(dir, `${b}.jsonl`))));
    const list = all.filter((i) => !hidden.has(i.path));
    const byId = new Map();
    for (const i of list) if (!byId.has(i.id)) byId.set(i.id, i);
    for (const k of [...this.infos.keys()]) if (!seen.has(k)) this.infos.delete(k);
    for (const k of [...this.headIds.keys()]) if (!seen.has(k)) this.headIds.delete(k);
    this.scanned = { dir, at: t, list, byId, partial };
    return this.scanned;
  }

  /**
   * A past meeting's scan entry by id. An id the half-done scan has not reached
   * is looked up without finishing the scan: the id is sha1(app_id|started_at),
   * so each file not parsed yet gets its id from its header line (cached by
   * size and mtime), and only the file that matches is parsed.
   */
  find(id) {
    const s = this.scan();
    const known = s.byId.get(id);
    // A half-done scan may know only a fragment under the id its merged file shares: look for the merged file first.
    if (!s.partial || (known && known.merged)) return known;
    const dir = s.dir;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {}
    names = newestFirst(names);
    // A fragment a merged file already read says it replaces is not an answer.
    const hidden = new Set([...this.infos.values()].flatMap((c) => c.info?.fragments ?? []).map((b) => join(dir, `${b}.jsonl`)));
    for (const f of names) {
      const m = splitName(f);
      if (!m) continue;
      const path = join(dir, f);
      if (this.state?.jsonl === path || hidden.has(path)) continue;
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size < MIN_BYTES) continue;
      const sig = fileSig(st);
      if (this.infos.get(path)?.sig === sig) continue; // parsed: byId already had it
      let h = this.headIds.get(path);
      if (!h || h.sig !== sig) {
        h = { sig, id: headId(path, m) };
        this.headIds.set(path, h);
      }
      if (h.id !== id) continue;
      const info = parseMeetingFile(path, m, st.size);
      if (info) Object.assign(info, { size: st.size, sig });
      this.infos.set(path, { sig, info });
      if (info?.id === id) return info;
    }
    return known;
  }

  /** The live (or just ended) meeting as a list item, from memory. null before it has a transcript or while only a stale state is left. */
  liveInfo() {
    const st = this.state;
    if (!st || (!st.jsonl && !st.recording)) return null;
    const p = this.people();
    const startedMs = Date.parse(st.startedAt) || 0;
    return {
      id: this.id,
      fromFeed: true,
      live: st.recording,
      app: st.app,
      appId: st.appId,
      title: st.title,
      startedAt: st.startedAt,
      startedMs,
      endedAt: st.ended ? st.endedAt : "",
      duration: st.ended ? st.duration || hms(Date.parse(st.endedAt) - startedMs) : "",
      stopped: !st.crashed,
      people: p?.people ?? [],
      captions: this.entries.filter((e) => e.type === "caption").length,
      slideCount: this.slides.length,
      thumb: this.slides.some((s) => s.n === 1),
    };
  }

  /** Every meeting, newest first: the live one (from memory) plus the scanned files. */
  ordered() {
    const lv = this.liveInfo();
    const all = lv ? [lv, ...this.scan().list.filter((i) => i.id !== lv.id)] : [...this.scan().list];
    return all.sort((a, b) => b.startedMs - a.startedMs);
  }

  /** One meeting as the pages' list item. No paths. */
  entryOf(info, notes = this.notesOf(info)) {
    return {
      id: info.id,
      title: info.title,
      app: info.app,
      started_at: info.startedAt,
      ...(info.endedAt ? { ended_at: info.endedAt } : {}),
      duration: info.duration,
      live: info.live,
      people: info.people.length,
      names: info.people.slice(0, 8),
      slides: info.slideCount,
      captions: info.captions,
      thumb: info.thumb,
      notes: notesBrief(notes),
    };
  }

  /** One page of the list, newest first, with the total and whether older meetings are still being read (partial). */
  listing({ limit = 50, offset = 0 } = {}) {
    const from = Math.max(0, Number(offset) || 0);
    const all = this.ordered();
    return {
      meetings: all.slice(from, from + Math.max(0, Number(limit) || 0)).map((i) => this.entryOf(i)),
      total: all.length,
      partial: Boolean(this.scanned?.partial),
    };
  }

  /** Newest first. */
  history(opts) {
    return this.listing(opts).meetings;
  }

  /** How many meetings there are (for "more"). */
  total() {
    return this.ordered().length;
  }

  /** The notes that belong to a meeting: the live logic for the live one, else the archive. */
  notesOf(info) {
    if (info.fromFeed && this.notes) return this.notes;
    return this.archived(info.id);
  }

  /** <notes dir>/<id>.json, validated and bounded like the live notes; kept forever by the copilot. */
  archived(id) {
    const dir = this.notesDir || (process.env.PI_MEETING_NOTES_DIR ? resolve(process.env.PI_MEETING_NOTES_DIR) : "");
    if (!dir || !ID_RE.test(String(id))) return null;
    const path = join(dir, `${id}.json`);
    let st;
    try {
      st = statSync(path);
    } catch {
      this.archive.delete(id);
      return null;
    }
    const sg = fileSig(st);
    const c = this.archive.get(id);
    if (c && c.sig === sg) return c.notes;
    const notes = normalizeNotes(readJson(path))?.notes ?? null;
    if (this.archive.size > 500) this.archive.clear();
    this.archive.set(id, { sig: sg, notes });
    return notes;
  }

  /**
   * A past meeting's transcript and slide index, 3 kept within a byte budget
   * (revalidated by size and mtime). A file over 20 MB loads only its last 8 MB
   * (partial: true). null for an unknown id.
   */
  loadPast(id) {
    if (!ID_RE.test(String(id))) return null;
    const info = this.find(id);
    if (!info) return null;
    let st;
    try {
      st = statSync(info.path);
    } catch {
      return null;
    }
    const sig = fileSig(st);
    const hit = this.loaded.get(id);
    if (hit && hit.sig === sig) {
      this.loaded.delete(id);
      this.loaded.set(id, hit);
      return hit.p;
    }
    const partial = st.size > SEARCH_MAX_FILE;
    let records;
    try {
      if (partial) records = tailRecords(info.path, st.size - PAST_TAIL_BYTES, st.size);
      else {
        const text = readFileSync(info.path, "utf8");
        records = parseLines(text.endsWith("\n") ? text : `${text}\n`).records;
      }
    } catch {
      return null;
    }
    const p = { info, entries: records.map((r) => normalizeRecord(remapMerged(r, info.merged))).filter(Boolean), slides: info.merged ? info.slideIndex : readSlideIndex(info.slidesDir), partial };
    this.loaded.set(id, { sig, p, bytes: partial ? PAST_TAIL_BYTES : st.size });
    let total = 0;
    for (const v of this.loaded.values()) total += v.bytes;
    for (const [k, v] of this.loaded) {
      if (this.loaded.size <= 1 || (this.loaded.size <= LOADED_KEEP && total <= LOADED_BYTES)) break;
      this.loaded.delete(k);
      total -= v.bytes;
    }
    return p;
  }

  /** Is this meeting's line list in the cache (so searching it reads nothing)? */
  linesCached(info) {
    const hit = this.linesCache.get(info.path);
    return Boolean(hit && hit.sig === info.sig);
  }

  /** A meeting's caption and chat lines for searching: { i (entry index), type (caption | chat), ts, speaker, text, lower }. null when the file is too big. */
  linesOf(info) {
    const make = (entries) =>
      entries.flatMap((e, i) => (e.type === "caption" || e.type === "chat" ? [{ i, type: e.type, ts: e.ts, speaker: e.speaker, text: e.text, lower: `${e.speaker} ${e.text}`.toLowerCase() }] : []));
    if (info.fromFeed) return make(this.entries);
    if (info.size > SEARCH_MAX_FILE) return null;
    const hit = this.linesCache.get(info.path);
    if (hit && hit.sig === info.sig) {
      this.linesCache.delete(info.path);
      this.linesCache.set(info.path, { ...hit, gen: this.searchGen });
      return hit.lines;
    }
    let text;
    try {
      text = readFileSync(info.path, "utf8");
    } catch {
      return null;
    }
    const lines = make(parseLines(text.endsWith("\n") ? text : `${text}\n`).records.map((r) => normalizeRecord(remapMerged(r, info.merged))).filter(Boolean));
    const bytes = lines.reduce((n, l) => n + l.text.length * 4 + l.speaker.length * 2 + 120, 0);
    if (hit) this.linesBytes -= hit.bytes;
    this.linesCache.delete(info.path);
    this.linesCache.set(info.path, { sig: info.sig, lines, bytes, gen: this.searchGen });
    this.linesBytes += bytes;
    // Oldest first, but never what the current search has already used: a corpus bigger than the cache
    // would otherwise evict each entry just before the next search wanted it.
    for (const [k, v] of this.linesCache) {
      if (this.linesBytes <= this.linesCacheBytes || this.linesCache.size <= 1) break;
      if (v.gen === this.searchGen) continue;
      this.linesCache.delete(k);
      this.linesBytes -= v.bytes;
    }
    return lines;
  }

  /** Evict the oldest cached line lists until the cache is back within its byte cap (a search may exceed it while it runs). */
  trimLines() {
    for (const [k, v] of this.linesCache) {
      if (this.linesBytes <= this.linesCacheBytes || this.linesCache.size <= 1) break;
      this.linesCache.delete(k);
      this.linesBytes -= v.bytes;
    }
  }

  /**
   * Meetings matching every whitespace-separated term, case-insensitively: in one
   * transcript line, or in the meeting's title, people and notes. Newest first,
   * `limit` meetings at most, each with up to 3 matching lines (i: the entry's
   * index, so the page can jump to it), hits (all matching lines) and fields.
   * A search reads at most searchBytes (25 MB) of transcripts that are not cached
   * and runs for about 150 ms. What it uses of the lines cache (hits too) is held
   * for the search and may not pass linesCacheBytes + searchBytes; the cache is
   * trimmed back to linesCacheBytes afterwards. Past any of these (or while the
   * folder is still being listed) it stops and says partial, with how many
   * meetings it got through.
   */
  searchResult(q, { limit = 30 } = {}) {
    const text = String(q ?? "").trim();
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (text.length < 2 || !terms.length) return { results: [], partial: false, searched: 0 };
    this.searchGen++;
    const all = this.ordered();
    let partial = Boolean(this.scanned?.partial);
    let budget = this.searchBytes;
    let held = 0; // cache bytes this search has used: protected from eviction
    const cap = this.linesCacheBytes + this.searchBytes;
    const t0 = performance.now();
    let searched = 0;
    const results = [];
    for (const info of all) {
      if (results.length >= limit) break;
      if (searched > 0 && performance.now() - t0 >= this.searchBudgetMs) {
        partial = true;
        break;
      }
      if (!info.fromFeed && info.size <= SEARCH_MAX_FILE) {
        const hit = this.linesCached(info) ? this.linesCache.get(info.path) : null;
        if (hit ? held + hit.bytes > cap : info.size > budget || held + info.size > cap) {
          partial = true;
          break;
        }
        if (!hit) budget -= info.size;
      }
      searched++;
      const notes = this.notesOf(info);
      const n = notes ? [...notes.topics.flatMap((t) => [t.title, t.summary]), ...notes.decisions.map((d) => d.text), ...notes.actions.flatMap((a) => [a.who, a.what]), ...notes.questions.map((x) => x.q)] : [];
      const sl = notes ? notes.slides.flatMap((x) => [x.title, x.what, x.why, ...x.points]) : [];
      const fields = { title: info.title.toLowerCase(), people: info.people.join("\n").toLowerCase(), notes: n.join("\n").toLowerCase(), slides: sl.join("\n").toLowerCase() };
      const metaHit = terms.every((t) => `${fields.title}\n${fields.people}\n${fields.notes}\n${fields.slides}`.includes(t));
      let hits = 0;
      let chatHits = 0;
      const lines = [];
      const found = this.linesOf(info);
      if (!info.fromFeed) held += this.linesCache.get(info.path)?.bytes ?? 0;
      for (const l of found ?? []) {
        if (!terms.every((t) => l.lower.includes(t))) continue;
        hits++;
        if (l.type === "chat") chatHits++;
        if (lines.length < 3) lines.push({ type: l.type, ts: l.ts, speaker: l.speaker, text: snippet(l.text, terms), i: l.i });
      }
      if (!hits && !metaHit) continue;
      const matched = metaHit ? ["title", "people", "notes", "slides"].filter((f) => terms.some((t) => fields[f].includes(t))) : [];
      if (hits > chatHits) matched.push("transcript");
      if (chatHits) matched.push("chat");
      results.push({ ...this.entryOf(info, notes), hits, fields: matched, lines });
    }
    this.trimLines();
    return { results, partial, searched };
  }

  /** searchResult's matches. */
  search(q, opts) {
    return this.searchResult(q, opts).results;
  }

  /**
   * A slide's file on disk, or null. Only names index.jsonl listed, and only
   * inside the slides folder once symlinks are resolved; the folder comes from
   * the live state or the meeting id, never from the client. thumb falls back to
   * the full image.
   */
  slideFile(id, n, thumb = false) {
    if (!ID_RE.test(String(id))) return null;
    const st = this.state;
    if (st && id === this.id) return st.slidesDir ? resolveSlide(st.slidesDir, this.slides, n, thumb) : null;
    const info = this.find(id);
    return info ? resolveSlide(info.slidesDir, info.slideIndex, n, thumb) : null;
  }
}

function resolveSlide(dir, slides, n, thumb) {
  const s = slides.find((x) => x.n === n);
  if (!s) return null;
  const name = thumb && s.thumb ? s.thumb : s.file;
  if (!SLIDE_FILE.test(name)) return null;
  const from = s.dir || dir; // a merged meeting's slides each sit in their fragment's folder (set by mergedOf, never by the client)
  try {
    const root = realpathSync(from);
    const path = realpathSync(join(from, name));
    return path.startsWith(root + sep) && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}
