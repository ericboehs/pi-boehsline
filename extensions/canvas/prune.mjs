#!/usr/bin/env node
// Nightly cleanup for the session canvas: keeps long-running pi sessions from
// piling up thousands of files in ~/.pi/canvas/<session-id>/ (one session hit
// 917 files / 39 MB, which made the daemon's tree reads slow).
//
//   node extensions/canvas/prune.mjs [--dry-run] [--days N] [--root DIR]
//
// Rules, per session folder under the canvas root:
//
//   1. Whole folder: gone when its pi is not running (daemon.mjs's own
//      liveness: meta.json's `ended` and pid) and neither the folder nor its
//      pi session transcript has changed in --days (default 30, else
//      PI_CANVAS_RETAIN_DAYS). No transcript found counts as stale, so a
//      folder whose session file was deleted doesn't live forever.
//   2. Sections: a section the agent made (not `by: "auto"`, not an auto-*
//      id, not kind `tracker`) whose file is older than 14 days (file mtime,
//      else its `at`) goes, from sections.json (written atomically) and from
//      disk, with its `extra` media.
//   3. Files changed tracking: an entry in auto-files.json / auto-diffs.json /
//      auto-copies.json untouched for 7 days (the entry's own time if it has
//      one, else its patch or copy file's mtime) goes, with its base-, cur-
//      and diff- files. Empty tracking JSONs are removed; when auto-files.json
//      ends empty, the "Files changed" card (auto-files) goes too.
//   4. Orphans: a file in the folder that no section, tracking entry or
//      bookkeeping name references goes, but only when its name is one this
//      extension writes (a section file, base-*/cur-*/diff-*/shot-*, or a
//      *.tmp older than an hour). Anything unrecognized stays.
//   5. One line per session is appended to the canvas log (<root>/.daemon.log).
//
// A session in the middle of a turn only gets rule 1 (never) and rule 2: the
// extension writes the tracking files and media mid-turn, and sections it
// rewrites atomically anyway.
//
// The daemon runs it once, 10 minutes after it starts, then daily at 04:00
// local (see schedulePrune). --dry-run changes nothing on disk, not even the
// log, and prints every line it would have written.

import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionState } from "./daemon.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How long things are kept. `dirDays` can be overridden per run or by env. */
export const RETENTION = Object.freeze({
  dirDays: 30,
  sectionDays: 14,
  trackDays: 7,
  tmpHours: 1,
  firstRunMs: 10 * 60_000,
  hour: 4,
});

// The bookkeeping names, read out of index.ts (writeAtomic/putMarkdown and the
// trackers) and daemon.mjs (the talk-back queue): meta.json, status.json,
// sections.json, reply.json, info.json, activity.json, turn.json,
// inbox-ack.json, the four auto-*.json trackers, and the inbox/ folder (a
// folder, so never looked at here).
export const BOOKKEEPING = new Set([
  "meta.json",
  "sections.json",
  "status.json",
  "reply.json",
  "info.json",
  "activity.json",
  "turn.json",
  "inbox-ack.json",
  "auto-files.json",
  "auto-diffs.json",
  "auto-copies.json",
  "auto-shots.json",
]);

export const LOG_NAME = ".daemon.log";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// What a section's file is called (`<id>.<ext>`, index.ts's SECTION/SPEC_EXT and
// daemon.mjs's FILE_NAME). The extension list is the daemon's, minus `txt`:
// section bodies are never .txt (only cur-<id>.txt, its own pattern below), so
// a stray .txt in the folder is somebody else's and stays.
const SECTION_RE = /^[a-z0-9][a-z0-9-]{0,63}\.(md|mmd|html|png|jpe?g|gif|webp|svg|patch|chart|term|stats|table|compare|steps|pipe|kanban|jsonv|timeline|jobs|code|tree|options|tracker|pdf|mp4|m4v|webm|mov)$/;
// index.ts's fileId(): the first 12 hex of sha1(path).
const HEX = "[0-9a-f]{12}";
const BASE_RE = new RegExp(`^base-${HEX}$`);
const CUR_RE = new RegExp(`^cur-${HEX}\\.txt$`);
const DIFF_RE = new RegExp(`^diff-${HEX}\\.patch$`);
const SHOT_RE = new RegExp(`^shot-${HEX}\\.(png|jpe?g|gif|webp)$`);
// writeAtomic's `${path}.${pid}.tmp`, and the daemon's plain `${path}.tmp`.
const TMP_RE = /\.\d*\.?tmp$/;
const NAME_RE = /[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.[A-Za-z0-9]{1,8}/g;
const MAX_BODY = 1024 * 1024;
/** How many bytes of section bodies one folder's reference scan reads. */
const BODY_BUDGET = 8 * 1024 * 1024;

// ── small helpers ────────────────────────────────────────────────────────────

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

const mtimeOf = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

const sizeOf = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const isMap = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A time in ms from an ISO string or a number, or undefined. */
function timeOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** "39.2 MB", for the log line. */
export function humanBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/**
 * A folder's bytes and when anything in it last moved: the newest file mtime,
 * or a subfolder's own mtime (so inbox/ counts). The folder's own mtime is left
 * out, so our own deletions don't reset its clock; `newest` is then undefined
 * for an empty folder.
 */
function folderStats(dir) {
  let bytes = 0;
  let newest;
  const bump = (t) => {
    if (t !== undefined && (newest === undefined || t > newest)) newest = t;
  };
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes, newest };
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      bump(mtimeOf(path));
      const sub = folderStats(path);
      bytes += sub.bytes;
      bump(sub.newest);
      continue;
    }
    bytes += sizeOf(path);
    bump(mtimeOf(path));
  }
  return { bytes, newest };
}

/**
 * Whether this file name is one the canvas writes, so an unreferenced one is
 * an orphan rather than someone else's file. Anything else returns false and
 * is kept.
 */
export function isArtifactName(name) {
  if (typeof name !== "string" || !name) return false;
  const base = name.replace(TMP_RE, "");
  if (!base) return false;
  return BASE_RE.test(base) || CUR_RE.test(base) || DIFF_RE.test(base) || SHOT_RE.test(base) || SECTION_RE.test(base);
}

// ── where things live ────────────────────────────────────────────────────────

/** The canvas root, resolved the way daemon.mjs and index.ts do. */
export function canvasRoot() {
  const env = process.env.PI_CANVAS_ROOT;
  if (env) return resolve(env.startsWith("~") ? join(homedir(), env.slice(1)) : env);
  return join(homedir(), ".pi", "canvas");
}

/** pi's session storage: <agent dir>/sessions/--<encoded cwd>--/<stamp>_<id>.jsonl. */
export function sessionsDir() {
  const custom = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (custom) return resolve(custom.startsWith("~") ? join(homedir(), custom.slice(1)) : custom);
  const agent = process.env.PI_CODING_AGENT_DIR;
  const base = agent ? resolve(agent.startsWith("~") ? join(homedir(), agent.slice(1)) : agent) : join(homedir(), ".pi", "agent");
  return join(base, "sessions");
}

/**
 * Session transcripts by session id: the newest mtime of every
 * `*_<id>.jsonl` under pi's sessions folder. Built once per run.
 */
export function sessionFileTimes(dir = sessionsDir()) {
  const out = new Map();
  const put = (path, name) => {
    const stem = name.replace(/\.jsonl$/, "");
    // A session id could itself hold an underscore, so register every tail.
    const parts = stem.split("_");
    for (let i = 1; i < parts.length; i++) {
      const id = parts.slice(i).join("_");
      if (!SESSION_ID.test(id)) continue;
      const at = mtimeOf(path);
      if (at === undefined) continue;
      if (!(out.get(id) >= at)) out.set(id, at);
    }
  };
  let dirs = [];
  try {
    dirs = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const sub = join(dir, entry.name);
    let files = [];
    try {
      files = readdirSync(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) if (f.isFile() && f.name.endsWith(".jsonl")) put(join(sub, f.name), f.name);
  }
  // Older layouts kept transcripts straight in the sessions folder.
  for (const f of dirs) if (f.isFile() && f.name.endsWith(".jsonl")) put(join(dir, f.name), f.name);
  return out;
}

// ── what to keep ─────────────────────────────────────────────────────────────

const retentionDays = () => {
  const n = Number(process.env.PI_CANVAS_RETAIN_DAYS);
  return Number.isFinite(n) && n > 0 ? n : RETENTION.dirDays;
};

/** The extension's own cards, and the tracker card, are never aged out. */
export function isProtectedSection(section) {
  if (!section || typeof section !== "object") return true;
  if (section.by === "auto") return true;
  if (typeof section.id === "string" && section.id.startsWith("auto-")) return true;
  return section.kind === "tracker";
}

/** When a section last changed: its file's mtime, else its `at`, else unknown. */
function sectionTime(dir, section) {
  const at = typeof section.file === "string" ? mtimeOf(join(dir, section.file)) : undefined;
  return at ?? timeOf(section.at);
}

/** The newest of everything stored about one tracked path. */
function trackedTime(dir, abs, files, diffs, copies) {
  let newest;
  const bump = (t) => {
    if (t !== undefined && (newest === undefined || t > newest)) newest = t;
  };
  bump(timeOf(files[abs]?.at));
  const diff = diffs[abs];
  if (isMap(diff)) {
    if (typeof diff.patch === "string") bump(mtimeOf(join(dir, diff.patch)));
    if (typeof diff.base === "string") bump(mtimeOf(join(dir, diff.base)));
  }
  const copy = copies[abs];
  if (isMap(copy)) {
    if (typeof copy.file === "string") bump(mtimeOf(join(dir, copy.file)));
    bump(timeOf(copy.mtimeMs));
  }
  return newest;
}

/** Every file name a surviving section or tracking entry points at. */
function referenced(dir, sections, files, diffs, copies, shots) {
  const refs = new Set();
  for (const s of sections) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.file === "string") refs.add(s.file);
    for (const extra of Array.isArray(s.extra) ? s.extra : []) if (typeof extra === "string") refs.add(extra);
  }
  for (const key of Object.keys(diffs)) {
    if (typeof diffs[key]?.patch === "string") refs.add(diffs[key].patch);
    if (typeof diffs[key]?.base === "string") refs.add(diffs[key].base);
  }
  for (const key of Object.keys(copies)) if (typeof copies[key]?.file === "string") refs.add(copies[key].file);
  for (const shot of shots) if (typeof shot?.file === "string") refs.add(shot.file);
  // image and compare sections name their media in the body too; only names
  // that are actually in the folder count, so nothing new is invented. Only
  // the section and tracking files are read (not every file they mention), and
  // at most BODY_BUDGET of them: past that the refs already found stand.
  let budget = BODY_BUDGET;
  for (const name of [...refs]) {
    if (budget <= 0) break;
    if (TMP_RE.test(name) || !mtimeOf(join(dir, name))) continue;
    const size = sizeOf(join(dir, name));
    if (size > budget) continue;
    const body = readBody(join(dir, name));
    budget -= size;
    if (!body) continue;
    for (const m of body.matchAll(NAME_RE)) if (m[0] !== name) refs.add(m[0]);
  }
  return refs;
}

function readBody(path) {
  try {
    if (sizeOf(path) > MAX_BODY) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * A tracking JSON: `{ value, broken }`. A file that is there but doesn't parse
 * to an object marks the whole session unsafe, and nothing is deleted from it.
 */
function readTracking(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { value: null, broken: false };
  }
  try {
    const value = JSON.parse(text);
    return isMap(value) ? { value, broken: false } : { value: null, broken: true };
  } catch {
    return { value: null, broken: true };
  }
}

/** A JSON array file: `{ value, broken }`, same rule. Missing is empty, not broken. */
function readList(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { value: [], broken: false };
  }
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? { value, broken: false } : { value: [], broken: true };
  } catch {
    return { value: [], broken: true };
  }
}

// ── one session ──────────────────────────────────────────────────────────────

/**
 * Prune one session folder. Returns a summary:
 *   { id, live, activeTurn, removedDir, sections: [ids], tracked: [paths],
 *     trackedFiles, orphans: [names], bytes, kept }
 */
export function pruneSession(root, id, opts = {}) {
  const now = opts.now ?? Date.now();
  const dryRun = Boolean(opts.dryRun);
  const days = opts.dirDays ?? retentionDays();
  const sessionFiles = opts.sessionFiles ?? new Map();
  const dir = join(root, id);
  const state = sessionState(root, id);
  const activeTurn = Boolean(state.live && state.turn?.started && !state.turn?.ended);
  const summary = { id, live: Boolean(state.live), activeTurn, removedDir: false, sections: [], tracked: [], trackedFiles: 0, orphans: [], bytes: 0, kept: "", error: "" };
  const removed = new Set();
  const remove = (name) => {
    if (!name || removed.has(name)) return;
    removed.add(name);
    summary.bytes += sizeOf(join(dir, name));
    if (!dryRun) rmSync(join(dir, name), { force: true });
  };

  // 1. The whole folder: not running, and nothing has moved in `days`.
  if (!state.live) {
    const stats = folderStats(dir);
    const folderAt = stats.newest ?? mtimeOf(dir) ?? 0;
    const fileAt = sessionFiles.get(id);
    const stale = now - folderAt >= days * DAY_MS && (fileAt === undefined || now - fileAt >= days * DAY_MS);
    if (stale) {
      summary.bytes = stats.bytes;
      summary.removedDir = true;
      summary.kept = `not running, idle ${days}d`;
      if (!dryRun) rmSync(dir, { recursive: true, force: true });
      return summary;
    }
    summary.kept = fileAt === undefined ? `not running, folder in use ${days}d` : `not running, transcript in use ${days}d`;
  }

  // 2. Sections older than 14 days, never the extension's own. A sections.json
  // that doesn't parse stops the rest: keeping a file it might name is cheap.
  const listPath = join(dir, "sections.json");
  const stored = readList(listPath);
  if (stored.broken) {
    summary.kept = [summary.kept, "sections.json unreadable, left alone"].filter(Boolean).join(", ");
    return summary;
  }
  const list = stored.value;
  const kept = [];
  const dropped = [];
  for (const section of list) {
    if (isProtectedSection(section)) {
      kept.push(section);
      continue;
    }
    const at = sectionTime(dir, section);
    if (at === undefined || now - at < RETENTION.sectionDays * DAY_MS) kept.push(section);
    else dropped.push(section);
  }

  // 3. Files changed tracking (not mid-turn: the extension is writing it).
  const filesPath = join(dir, "auto-files.json");
  const diffsPath = join(dir, "auto-diffs.json");
  const copiesPath = join(dir, "auto-copies.json");
  const storedFiles = readTracking(filesPath);
  const storedDiffs = readTracking(diffsPath);
  const storedCopies = readTracking(copiesPath);
  // Copies: writeOrDrop compares the counts against what was on disk.
  let files = storedFiles.value ? { ...storedFiles.value } : {};
  let diffs = storedDiffs.value ? { ...storedDiffs.value } : {};
  let copies = storedCopies.value ? { ...storedCopies.value } : {};
  let dropTracking = false;
  const trackingBroken = storedFiles.broken || storedDiffs.broken || storedCopies.broken;

  if (!activeTurn && !trackingBroken) {
    const cutoff = now - RETENTION.trackDays * DAY_MS;
    const all = new Set([...Object.keys(files), ...Object.keys(diffs), ...Object.keys(copies)]);
    const stale = [];
    for (const abs of all) {
      const at = trackedTime(dir, abs, files, diffs, copies);
      if (at === undefined || at < cutoff) stale.push(abs);
    }
    if (stale.length) {
      const doomed = new Set();
      for (const abs of stale) {
        for (const name of [diffs[abs]?.base, diffs[abs]?.patch, copies[abs]?.file, files[abs]?.patch]) {
          if (typeof name === "string" && name && !doomed.has(name)) {
            doomed.add(name);
            if (mtimeOf(join(dir, name)) !== undefined) summary.trackedFiles++;
            remove(name);
          }
        }
        delete files[abs];
        delete diffs[abs];
        delete copies[abs];
        summary.tracked.push(abs);
      }
    }
    if (!dryRun) {
      const writeOrDrop = (path, had, next) => {
        if (!isMap(had)) return;
        const before = Object.keys(had).length;
        const after = Object.keys(next).length;
        if (!after) rmSync(path, { force: true });
        else if (after !== before) writeJsonAtomic(path, next);
      };
      writeOrDrop(filesPath, storedFiles.value, files);
      writeOrDrop(diffsPath, storedDiffs.value, diffs);
      writeOrDrop(copiesPath, storedCopies.value, copies);
    }
    // An empty Files changed list takes its tracking files (and its card) with it.
    // Only when there was one: a session that never tracked files keeps its
    // auto-files card (nothing here says the card is stale).
    dropTracking = Boolean(storedFiles.value) && Object.keys(files).length === 0 && Object.keys(diffs).length === 0 && Object.keys(copies).length === 0;
  }

  let finalKept = kept;
  if (dropTracking) {
    const card = kept.find((s) => s?.id === "auto-files");
    if (card) finalKept = kept.filter((s) => s !== card);
    if (card?.file) remove(card.file);
    if (!dryRun) for (const path of [filesPath, diffsPath, copiesPath]) rmSync(path, { force: true });
  }

  const changed = finalKept.length !== list.length;
  if (changed && !dryRun) writeJsonAtomic(listPath, finalKept);
  for (const section of dropped) {
    if (typeof section.id === "string") summary.sections.push(section.id);
  }
  if (dropTracking) summary.sections.push("auto-files");

  // 4. Orphans. Not when a tracking JSON is unreadable: the files it names
  // would look unreferenced, and a file kept by mistake costs nothing.
  const shotsFile = readList(join(dir, "auto-shots.json"));
  const shots = shotsFile.value;
  const unsafe = trackingBroken || shotsFile.broken;
  const refs = referenced(dir, finalKept, files, diffs, copies, shots);
  // A dropped section's own files go with it, unless something kept still names them.
  for (const section of dropped) {
    for (const name of [section.file, ...(Array.isArray(section.extra) ? section.extra : [])]) {
      if (typeof name === "string" && name && !refs.has(name)) remove(name);
    }
  }
  if (unsafe) summary.kept = [summary.kept, "a tracking file is unreadable, orphans left alone"].filter(Boolean).join(", ");

  if (!activeTurn && !unsafe) {
    const present = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    })();
    for (const name of present) {
      if (BOOKKEEPING.has(name) || refs.has(name) || removed.has(name)) continue;
      if (!isArtifactName(name)) continue; // not ours to judge
      if (TMP_RE.test(name) && now - (mtimeOf(join(dir, name)) ?? now) < RETENTION.tmpHours * HOUR_MS) continue;
      summary.orphans.push(name);
      remove(name);
    }
  }

  return summary;
}

// ── all sessions ─────────────────────────────────────────────────────────────

/** A one-line summary per session, the shape that goes in the log. */
export function summaryLine(summary) {
  if (summary.error) return `${summary.id}: skipped (${summary.error})`;
  const what = [];
  if (summary.removedDir) what.push(`removed the folder (${humanBytes(summary.bytes)})`);
  else {
    if (summary.sections.length) what.push(`${summary.sections.length} section(s) (${summary.sections.join(", ")})`);
    if (summary.tracked.length) what.push(`${summary.tracked.length} tracked entr${summary.tracked.length === 1 ? "y" : "ies"}, ${summary.trackedFiles} file(s)`);
    if (summary.orphans.length) what.push(`${summary.orphans.length} orphan(s)`);
    if (!what.length) what.push("nothing to remove");
    if (summary.bytes) what.push(`${humanBytes(summary.bytes)} freed`);
  }
  const why = summary.activeTurn ? " · active turn, sections only" : summary.live ? " · live" : summary.kept ? ` · ${summary.kept}` : "";
  return `${summary.id}: ${what.join(", ")}${why}`;
}

/** Append one line to the canvas log, the file the daemon's own lines go to. */
export function logLine(root, text, now = Date.now()) {
  try {
    appendFileSync(join(root, LOG_NAME), `${new Date(now).toISOString()} canvas prune: ${text}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * Prune every session folder under `root`.
 *   { root, now, dryRun, days, sessions: [summary] }
 */
export function pruneCanvas(opts = {}) {
  const root = resolve(opts.root ?? canvasRoot());
  const now = opts.now ?? Date.now();
  const dryRun = Boolean(opts.dryRun);
  const days = opts.days ?? retentionDays();
  const out = { root, now, dryRun, days, sessions: [] };
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  const sessionFiles = opts.sessionFiles ?? sessionFileTimes(opts.sessionsDir);
  for (const id of names.sort()) {
    if (id.startsWith(".") || !SESSION_ID.test(id)) continue;
    const dir = join(root, id);
    const stats = (() => {
      try {
        return statSync(dir);
      } catch {
        return undefined;
      }
    })();
    // Root folders that aren't sessions (meetings/, a stray file) are left alone.
    if (!stats?.isDirectory() || !existsSync(join(dir, "meta.json"))) continue;
    let summary;
    try {
      summary = pruneSession(root, id, { now, days, dryRun, sessionFiles });
    } catch (error) {
      summary = { id, error: error instanceof Error ? error.message : String(error), live: false, activeTurn: false, removedDir: false, sections: [], tracked: [], trackedFiles: 0, orphans: [], bytes: 0, kept: "" };
    }
    out.sessions.push(summary);
    if (!dryRun) logLine(root, summaryLine(summary), now);
  }
  return out;
}

// ── schedule ─────────────────────────────────────────────────────────────────

/** Milliseconds to the next `hour:00` local time (04:00 by default). */
export function nextRunDelay(hour = RETENTION.hour, now = new Date()) {
  const next = new Date(now.getTime());
  next.setHours(hour, 0, 0, 0);
  while (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Run the prune once soon after startup, then daily at `hour` local. Timers
 * are unref'd, so they never hold the daemon open, and every run is caught:
 * a prune that throws must not take the daemon (and every canvas tab) down.
 */
export function schedulePrune(opts = {}) {
  const root = opts.root ?? canvasRoot();
  const hour = opts.hour ?? RETENTION.hour;
  const firstDelayMs = opts.firstDelayMs ?? RETENTION.firstRunMs;
  const log = opts.log ?? ((line) => console.error(line));
  const timers = [];
  const run = (why) => {
    try {
      const res = pruneCanvas({ root, days: opts.days });
      const what = `${res.sessions.length} session(s)`;
      log(`${new Date().toISOString()} canvas daemon: prune (${why}) ${what}`);
    } catch (error) {
      log(`${new Date().toISOString()} canvas daemon: prune (${why}) failed: ${error?.message || error}`);
    }
  };
  const timer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    timers.push(t);
    return t;
  };
  timer(() => run("startup"), firstDelayMs);
  const arm = () => {
    timer(() => {
      run("daily");
      arm();
    }, nextRunDelay(hour));
  };
  arm();
  return {
    run,
    timers,
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}

// ── cli ──────────────────────────────────────────────────────────────────────

const USAGE = `usage: node extensions/canvas/prune.mjs [--dry-run] [--days N] [--root DIR] [--quiet]

  --dry-run   print what would go; change nothing, not even the log
  --days N    whole-folder retention (default ${RETENTION.dirDays}, else PI_CANVAS_RETAIN_DAYS)
  --root DIR  canvas root (default PI_CANVAS_ROOT or ~/.pi/canvas)
  --quiet     only the totals, not one line per session`;

function parseArgs(argv) {
  const out = { dryRun: false, quiet: false, days: undefined, root: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "-n") out.dryRun = true;
    else if (arg === "--quiet" || arg === "-q") out.quiet = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--days") out.days = Number(argv[++i]);
    else if (arg.startsWith("--days=")) out.days = Number(arg.slice("--days=".length));
    else if (arg === "--root") out.root = argv[++i];
    else if (arg.startsWith("--root=")) out.root = arg.slice("--root=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`canvas prune: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (opts.days !== undefined && !(Number.isFinite(opts.days) && opts.days > 0)) {
    console.error(`canvas prune: --days needs a number of days\n\n${USAGE}`);
    process.exit(2);
  }
  const result = pruneCanvas({ root: opts.root, days: opts.days, dryRun: opts.dryRun });
  const prefix = opts.dryRun ? "canvas prune (dry run): " : "canvas prune: ";
  if (!opts.quiet) for (const s of result.sessions) console.log(prefix + summaryLine(s));
  const freed = result.sessions.reduce((n, s) => n + (s.bytes || 0), 0);
  console.log(`${prefix}${result.sessions.length} session(s), ${humanBytes(freed)} ${opts.dryRun ? "would be freed" : "freed"} (${result.days}d folders)`);
}
