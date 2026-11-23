#!/usr/bin/env node
// Nightly cleanup for the session canvas: keeps long-running pi sessions from
// piling up thousands of files in ~/.pi/canvas/<session-id>/ (one session hit
// 917 files / 39 MB, which made the daemon's tree reads slow).
//
//   node extensions/canvas/prune.mjs [--dry-run] [--days N] [--root DIR] [--now TIME]
//
// Rules, per session folder under the canvas root:
//
//   1. Whole folder: gone when its pi is not running (daemon.mjs's own
//      liveness: meta.json's `ended` and pid) and neither the folder nor its
//      pi session transcript has changed in --days (default 30, else
//      PI_CANVAS_RETAIN_DAYS). No transcript found counts as stale, so a
//      folder whose session file was deleted doesn't live forever. The
//      daemon's own 6-hourly prune(ROOT) uses the same test (folderDead), so
//      there is one rule, not two.
//   2. Sections: a section the agent made (not `by: "auto"`, not an auto-*
//      id, not kind `tracker`) whose file is older than 14 days goes, from
//      sections.json (written atomically) and from disk, with its `extra`
//      media. A section's age is the newer of its file's and its `at`: the
//      canvas tool copies a file into the folder with copyFileSync, which
//      keeps the source's mtime, so a section posted today from a file last
//      edited months ago has an old mtime and a fresh `at`. Only folders whose
//      pi is gone are pruned this way: a live session may still be showing
//      them, and its own writes race ours.
//   3. Files changed tracking: an entry in auto-files.json / auto-diffs.json /
//      auto-copies.json untouched for 7 days (the entry's own time if it has
//      one, else its patch or copy file's mtime) goes, with its base-, cur-
//      and diff- files. Empty tracking JSONs are removed; when auto-files.json
//      ends empty, the "Files changed" card (auto-files) goes too.
//   4. Orphans: a file in the folder that no section, tracking entry or
//      bookkeeping name references goes, but only when its name is one this
//      extension writes (a section file, base-*/cur-*/diff-*/shot-*, or a
//      *.tmp older than an hour), and only in a folder whose pi is gone and
//      whose every text section could be read (an unread body may be the only
//      thing naming a file). Anything unrecognized stays.
//   5. One line per session is appended to the canvas log (<root>/.daemon.log).
//
// Busy sessions are left alone entirely: a turn running, or a live session
// with anything written in its folder in the last ten minutes (the extension's
// settle work runs for seconds after turn.ended, and a section posted a minute
// ago is not stale). File ages are max(mtime, ctime): ctime is set when a file
// is created or renamed into place, which is when a copy of an old file
// actually arrived.
//
// The daemon runs it once, 10 minutes after it starts, then daily at 04:00
// local (see schedulePrune). It is async: it yields between sessions so the
// daemon keeps serving pages. --dry-run changes nothing on disk, not even the
// log, and prints every line it would have written.

import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionState, folderDead, sessionFileTimes, sessionsDir } from "./daemon.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How long things are kept. `dirDays` can be overridden per run or by env. */
export const RETENTION = Object.freeze({
  dirDays: 30,
  sectionDays: 14,
  trackDays: 7,
  tmpHours: 1,
  busyMs: 10 * 60_000,
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

/**
 * When a file last arrived or changed: the newer of its mtime and its ctime.
 * copyFileSync (the canvas tool copying a source in, and every base-/cur-/
 * shot- copy) keeps the source's mtime, so an mtime alone says a file posted
 * today is months old; ctime is set when the file is created or renamed into
 * place. Reading a side effect of metadata changes (a chmod) as "fresh" is
 * the safe direction: it keeps a file too long, never deletes one too soon.
 */
export function fileTime(path) {
  try {
    const st = statSync(path);
    return Math.max(st.mtimeMs, st.ctimeMs);
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
      bump(fileTime(path));
      const sub = folderStats(path);
      bytes += sub.bytes;
      bump(sub.newest);
      continue;
    }
    bytes += sizeOf(path);
    bump(fileTime(path));
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

/**
 * Session transcripts by id: pi's sessions folder (daemon.mjs, which shares the
 * whole-folder rule with this file through folderDead). Imported rather than
 * duplicated, so the daemon's 6-hourly prune(ROOT) and this nightly one can
 * never disagree about a folder.
 */
export { sessionFileTimes, sessionsDir };

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

/**
 * When a section last changed: the newer of its file's time and its `at`.
 * Both matter: the file's ctime catches a copy of an old source, its `at`
 * catches a section whose file was rewritten from an older body.
 */
function sectionTime(dir, section) {
  const file = typeof section.file === "string" ? fileTime(join(dir, section.file)) : undefined;
  const at = timeOf(section.at);
  if (file === undefined) return at;
  if (at === undefined) return file;
  return Math.max(file, at);
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
    // The source file's own mtime at its last diff (index.ts's DiffEntry): a
    // file that was diffed a minute ago is not a stale entry.
    bump(timeOf(diff.mtimeMs));
    if (typeof diff.patch === "string") bump(fileTime(join(dir, diff.patch)));
    if (typeof diff.base === "string") bump(fileTime(join(dir, diff.base)));
  }
  const copy = copies[abs];
  if (isMap(copy)) {
    if (typeof copy.file === "string") bump(fileTime(join(dir, copy.file)));
    bump(timeOf(copy.mtimeMs));
  }
  return newest;
}

/**
 * Section files with a text body that can name media (index.ts's kinds and
 * daemon.mjs's FILE_NAME). Only these are read -- never a base-/cur-/diff-/
 * shot- copy or an image, which would spend the budget without naming
 * anything.
 */
export const TEXT_SECTION_RE = /\.(md|mmd|html|htm|svg|chart|term|stats|table|compare|steps|pipe|kanban|jsonv|timeline|jobs|code|tree|options|tracker)$/i;

/**
 * Every file name a surviving section or tracking entry points at, and whether
 * that answer is complete.
 *
 * Names are collected from the entries themselves, then from the body of every
 * text section among them (an image section names its media in its body). A
 * body skipped for size or budget, or one that can't be read, makes the whole
 * answer incomplete: a media name may be in it, so orphans must not be judged.
 */
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

  let incomplete = false;
  let budget = BODY_BUDGET;
  for (const name of [...refs]) {
    if (!TEXT_SECTION_RE.test(name) || TMP_RE.test(name)) continue;
    const path = join(dir, name);
    const size = sizeOf(path);
    if (!existsSync(path)) continue;
    if (size > MAX_BODY || size > budget) {
      // It names media we will never see: nothing is judged an orphan this run.
      incomplete = true;
      continue;
    }
    budget -= size;
    const body = readBody(path);
    if (body === null) {
      incomplete = true;
      continue;
    }
    for (const m of body.matchAll(NAME_RE)) if (m[0] !== name) refs.add(m[0]);
  }
  return { refs, incomplete };
}

/** A file's text, or null when it can't be read (kept apart from "" for a blank file). */
function readBody(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
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
 * A sections list after this run's removals, applied to the copy re-read just
 * before the write. Only the dropped sections (by id, else by file) and the
 * Files changed card go: a section a canvas tool posted while the scan ran is
 * in that copy and stays, and one the extension rewrote keeps its own body.
 */
export function sectionsAfterRemovals(fresh, { droppedIds = new Set(), droppedFiles = new Set(), dropTracking = false } = {}) {
  return fresh.filter((section) => {
    if (!section || typeof section !== "object") return true;
    if (typeof section.id === "string" && droppedIds.has(section.id)) return false;
    if (typeof section.file === "string" && droppedFiles.has(section.file)) return false;
    if (dropTracking && section.id === "auto-files") return false;
    return true;
  });
}

/**
 * Remove the stale keys from one tracking JSON's fresh copy, in place, and say
 * how many it actually had. An entry the extension added or refreshed between
 * the scan and this write is not in `stale`, so it survives.
 */
export function trackingAfterRemovals(fresh, stale) {
  let lost = 0;
  if (!isMap(fresh)) return lost;
  for (const abs of stale) {
    if (!(abs in fresh)) continue;
    delete fresh[abs];
    lost++;
  }
  return lost;
}

/**
 * Prune one session folder. Returns a summary:
 *   { id, live, busy, activeTurn, removedDir, sections: [ids], tracked: [paths],
 *     trackedFiles, orphans: [names], bytes, kept }
 * The folder cutoff is `opts.dirDays` (or `opts.days`), else the retention default.
 */
export function pruneSession(root, id, opts = {}) {
  const now = opts.now ?? Date.now();
  const dryRun = Boolean(opts.dryRun);
  const days = opts.dirDays ?? opts.days ?? retentionDays();
  const sessionFiles = opts.sessionFiles ?? new Map();
  const dir = join(root, id);
  const state = sessionState(root, id);
  const live = Boolean(state.live);
  const activeTurn = Boolean(live && state.turn?.started && !state.turn?.ended);
  const summary = { id, live, busy: false, activeTurn, removedDir: false, sections: [], tracked: [], trackedFiles: 0, orphans: [], bytes: 0, kept: "", error: "" };
  const removed = new Set();
  const remove = (name) => {
    if (!name || removed.has(name)) return;
    removed.add(name);
    summary.bytes += sizeOf(join(dir, name));
    if (!dryRun) rmSync(join(dir, name), { force: true });
  };

  // 0. Busy: left alone entirely. A turn is running, or the session is live and
  // something in its folder moved in the last ten minutes -- the extension's
  // settle work (the diffs, the copies, the tracking JSONs) runs for seconds
  // after turn.ended, and a section posted a minute ago is not stale.
  const stats = folderStats(dir);
  const folderAt = stats.newest ?? fileTime(dir) ?? 0;
  const quietFor = now - Math.max(folderAt, timeOf(state.turn?.ended) ?? 0);
  const busy = activeTurn || (live && quietFor < RETENTION.busyMs);
  summary.busy = busy;
  if (busy) {
    summary.kept = activeTurn ? "active turn, left alone" : "live and busy, left alone";
    return summary;
  }

  // 1. The whole folder: not running, and nothing has moved in `days`.
  if (!live) {
    if (folderDead(root, id, { days, now, sessionFiles, updated: folderAt })) {
      summary.bytes = stats.bytes;
      summary.removedDir = true;
      summary.kept = `not running, idle ${days}d`;
      if (!dryRun) rmSync(dir, { recursive: true, force: true });
      return summary;
    }
    const fileAt = sessionFiles.get(id);
    summary.kept = fileAt === undefined ? `not running, folder in use ${days}d` : `not running, transcript in use ${days}d`;
  }

  // 2. Sections older than 14 days, never the extension's own, and only in a
  // folder whose pi is gone: a live session may still show them, and what it
  // writes now would be undone by a list we read a moment ago.
  const listPath = join(dir, "sections.json");
  let list = [];
  const kept = [];
  const dropped = [];
  if (!live) {
    const stored = readList(listPath);
    if (stored.broken) {
      summary.kept = [summary.kept, "sections.json unreadable, left alone"].filter(Boolean).join(", ");
      return summary;
    }
    list = stored.value;
    for (const section of list) {
      if (isProtectedSection(section)) {
        kept.push(section);
        continue;
      }
      const at = sectionTime(dir, section);
      if (at === undefined || now - at < RETENTION.sectionDays * DAY_MS) kept.push(section);
      else dropped.push(section);
    }
  } else {
    summary.kept = "live, Files changed tracking only";
  }

  // 3. Files changed tracking (a busy session never gets here: see 0).
  const filesPath = join(dir, "auto-files.json");
  const diffsPath = join(dir, "auto-diffs.json");
  const copiesPath = join(dir, "auto-copies.json");
  const storedFiles = readTracking(filesPath);
  const storedDiffs = readTracking(diffsPath);
  const storedCopies = readTracking(copiesPath);
  let files = storedFiles.value ? { ...storedFiles.value } : {};
  let diffs = storedDiffs.value ? { ...storedDiffs.value } : {};
  let copies = storedCopies.value ? { ...storedCopies.value } : {};
  let dropTracking = false;
  const trackingBroken = storedFiles.broken || storedDiffs.broken || storedCopies.broken;

  if (!trackingBroken) {
    const cutoff = now - RETENTION.trackDays * DAY_MS;
    const all = new Set([...Object.keys(files), ...Object.keys(diffs), ...Object.keys(copies)]);
    const stale = new Set();
    for (const abs of all) {
      const at = trackedTime(dir, abs, files, diffs, copies);
      if (at === undefined || at < cutoff) stale.add(abs);
    }
    if (stale.size) {
      // Each JSON is read again right before the write: the extension adds
      // entries while we work (a file the agent edited a second ago), and those
      // must survive. Only the stale keys are removed, from the fresh copy.
      const freshFiles = readTracking(filesPath);
      const freshDiffs = readTracking(diffsPath);
      const freshCopies = readTracking(copiesPath);
      if (freshFiles.broken || freshDiffs.broken || freshCopies.broken) {
        summary.kept = [summary.kept, "a tracking file is unreadable, orphans left alone"].filter(Boolean).join(", ");
        return summary;
      }
      const touched = { [filesPath]: false, [diffsPath]: false, [copiesPath]: false };
      const drop = (path, map, abs) => {
        if (!trackingAfterRemovals(map, [abs])) return;
        touched[path] = true;
      };
      const doomed = new Set();
      for (const abs of stale) {
        for (const name of [freshDiffs.value?.[abs]?.base, freshDiffs.value?.[abs]?.patch, freshCopies.value?.[abs]?.file, freshFiles.value?.[abs]?.patch]) {
          if (typeof name === "string" && name) doomed.add(name);
        }
        drop(filesPath, freshFiles.value, abs);
        drop(diffsPath, freshDiffs.value, abs);
        drop(copiesPath, freshCopies.value, abs);
        summary.tracked.push(abs);
      }
      // A file a surviving entry still names stays (two paths can share a base).
      const named = new Set();
      for (const map of [freshFiles.value, freshDiffs.value, freshCopies.value]) {
        for (const entry of Object.values(map ?? {})) {
          for (const key of ["base", "patch", "file"]) if (typeof entry?.[key] === "string") named.add(entry[key]);
        }
      }
      for (const name of doomed) {
        if (named.has(name)) continue;
        if (fileTime(join(dir, name)) !== undefined) summary.trackedFiles++;
        remove(name);
      }
      files = freshFiles.value ?? {};
      diffs = freshDiffs.value ?? {};
      copies = freshCopies.value ?? {};
      if (!dryRun) {
        for (const [path, value] of [[filesPath, files], [diffsPath, diffs], [copiesPath, copies]]) {
          if (!touched[path]) continue;
          if (!Object.keys(value).length) rmSync(path, { force: true });
          else writeJsonAtomic(path, value);
        }
      }
    }
  }

  // An empty Files changed list takes its tracking files (and its card) with it.
  // Only a dead session: a live one's sections are never rewritten here, so its
  // card stays for the next turn to redraw. And only when there was a list: a
  // session that never tracked files keeps its card (nothing says it is stale).
  dropTracking = !live && Boolean(storedFiles.value) && !Object.keys(files).length && !Object.keys(diffs).length && !Object.keys(copies).length;
  let finalKept = kept;
  if (dropTracking) {
    const card = kept.find((s) => s?.id === "auto-files");
    if (card) finalKept = kept.filter((s) => s !== card);
    if (card?.file) remove(card.file);
    if (!dryRun) for (const path of [filesPath, diffsPath, copiesPath]) rmSync(path, { force: true });
  }

  // The sections list, re-read at the last moment: a canvas tool call during
  // the scan may have posted a section (with its media), and it must not be
  // dropped from the list we write. Only the dropped ids are removed, from the
  // fresh copy; a list that no longer parses is left as it is.
  const droppedIds = new Set();
  const droppedFiles = new Set();
  for (const section of dropped) {
    if (typeof section?.id === "string") droppedIds.add(section.id);
    else if (typeof section?.file === "string") droppedFiles.add(section.file);
  }
  const changed = finalKept.length !== list.length;
  if (changed && !dryRun) {
    const fresh = readList(listPath);
    if (fresh.broken) summary.kept = [summary.kept, "sections.json unreadable on the re-read, left alone"].filter(Boolean).join(", ");
    else {
      const next = sectionsAfterRemovals(fresh.value, { droppedIds, droppedFiles, dropTracking });
      if (next.length !== fresh.value.length) writeJsonAtomic(listPath, next);
    }
  }
  for (const section of dropped) {
    if (typeof section.id === "string") summary.sections.push(section.id);
  }
  if (dropTracking) summary.sections.push("auto-files");

  // A live session's remaining rules are not ours to run: the extension writes
  // its media, sections and tracking mid-turn, and its page may show anything.
  if (live) return summary;

  // 4. Orphans, in a dead folder whose references are all known. Not when a
  // tracking JSON is unreadable (the files it names would look unreferenced),
  // and not when a text section's body could not be read or fit the budget: it
  // may be the only thing naming a file, and a file kept by mistake costs
  // nothing.
  const shotsFile = readList(join(dir, "auto-shots.json"));
  const shots = shotsFile.value;
  const unsafe = trackingBroken || shotsFile.broken;
  const { refs, incomplete } = referenced(dir, finalKept, files, diffs, copies, shots);
  // A dropped section's own files go with it, unless something kept still names them.
  for (const section of dropped) {
    for (const name of [section.file, ...(Array.isArray(section.extra) ? section.extra : [])]) {
      if (typeof name === "string" && name && !refs.has(name)) remove(name);
    }
  }
  if (unsafe) summary.kept = [summary.kept, "a tracking file is unreadable, orphans left alone"].filter(Boolean).join(", ");
  if (incomplete) summary.kept = [summary.kept, "a section body could not be read, orphans left alone"].filter(Boolean).join(", ");

  if (!unsafe && !incomplete) {
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
      if (TMP_RE.test(name) && now - (fileTime(join(dir, name)) ?? now) < RETENTION.tmpHours * HOUR_MS) continue;
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
  const why = !summary.removedDir && summary.kept ? ` · ${summary.kept}` : "";
  return `${summary.id}: ${what.join(", ")}${why}`;
}

/** Append one line to the canvas log, the file the daemon's own lines go to. */
export function logLine(root, text, now = Date.now()) {
  try {
    appendFileSync(join(root, LOG_NAME), `${new Date(now).toISOString()} canvas prune: ${text}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * Prune every session folder under `root`. Async: it yields between sessions,
 * so the daemon keeps answering pages while a folder's bodies are read.
 *   { root, now, dryRun, days, sessions: [summary] }
 */
export async function pruneCanvas(opts = {}) {
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
  // One folder's body scan is up to 8 MB of reads: a macrotask between folders
  // lets the daemon's server and SSE timers run (pruneSession itself is sync).
  const yieldTurn = () => new Promise((done) => setImmediate(done));
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
    await yieldTurn();
    let summary;
    try {
      summary = pruneSession(root, id, { now, dirDays: days, dryRun, sessionFiles });
    } catch (error) {
      summary = { id, error: error instanceof Error ? error.message : String(error), live: false, busy: false, activeTurn: false, removedDir: false, sections: [], tracked: [], trackedFiles: 0, orphans: [], bytes: 0, kept: "" };
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
  const run = async (why) => {
    try {
      const res = await pruneCanvas({ root, days: opts.days });
      const what = `${res.sessions.length} session(s)`;
      log(`${new Date().toISOString()} canvas daemon: prune (${why}) ${what}`);
      return res;
    } catch (error) {
      log(`${new Date().toISOString()} canvas daemon: prune (${why}) failed: ${error?.message || error}`);
      return undefined;
    }
  };
  const timer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    timers.push(t);
    return t;
  };
  timer(() => void run("startup"), firstDelayMs);
  const arm = () => {
    timer(() => {
      void run("daily");
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

const USAGE = `usage: node extensions/canvas/prune.mjs [--dry-run] [--days N] [--root DIR] [--now TIME] [--quiet]

  --dry-run   print what would go; change nothing, not even the log
  --days N    whole-folder retention (default ${RETENTION.dirDays}, else PI_CANVAS_RETAIN_DAYS)
  --root DIR  canvas root (default PI_CANVAS_ROOT or ~/.pi/canvas)
  --now TIME  judge ages as of this time (ISO or epoch ms), not right now
  --quiet     only the totals, not one line per session`;

function parseArgs(argv) {
  const out = { dryRun: false, quiet: false, days: undefined, root: undefined, now: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "-n") out.dryRun = true;
    else if (arg === "--quiet" || arg === "-q") out.quiet = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--days") out.days = Number(argv[++i]);
    else if (arg.startsWith("--days=")) out.days = Number(arg.slice("--days=".length));
    else if (arg === "--root") out.root = argv[++i];
    else if (arg.startsWith("--root=")) out.root = arg.slice("--root=".length);
    else if (arg === "--now") out.now = argv[++i];
    else if (arg.startsWith("--now=")) out.now = arg.slice("--now=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** An ISO time or epoch ms as a number, or undefined. */
function parseTime(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
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
  const now = parseTime(opts.now);
  if (opts.now !== undefined && now === undefined) {
    console.error(`canvas prune: --now needs an ISO time or epoch ms\n\n${USAGE}`);
    process.exit(2);
  }
  const result = await pruneCanvas({ root: opts.root, days: opts.days, now, dryRun: opts.dryRun });
  const prefix = opts.dryRun ? "canvas prune (dry run): " : "canvas prune: ";
  if (!opts.quiet) for (const s of result.sessions) console.log(prefix + summaryLine(s));
  const freed = result.sessions.reduce((n, s) => n + (s.bytes || 0), 0);
  console.log(`${prefix}${result.sessions.length} session(s), ${humanBytes(freed)} ${opts.dryRun ? "would be freed" : "freed"} (${result.days}d folders)`);
}
