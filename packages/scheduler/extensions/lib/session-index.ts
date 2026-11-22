/**
 * The session-timer due index: which sessions have timers, and when they are
 * next due.
 *
 * Session timers live in the session's own JSONL (`session-scheduler:snapshot`),
 * which is the right home for them but tells nothing outside that process
 * anything. An outside process — the pi-scheduler tick that may want to wake a
 * session — cannot read every session file to find out, so this small index
 * says, per session, "there are timers, the earliest is due at T".
 *
 * It is metadata only: prompts stay in the session file, because the index is
 * written by every pi and read by processes that have no business seeing what
 * the user scheduled. That is also why it must never grow into a task store.
 *
 * Layout, mode 0700/0600 like the registry:
 *
 *   ~/.pi/agent/scheduler/
 *     session-timers.json        the index (atomically replaced)
 *     session-timers.json.lock/  a mkdir mutex held across read-modify-write
 *
 * Every write is a read-modify-write under that mutex, because a dozen open
 * sessions all write this one file; and every member is either this process's
 * own entry or one being pruned, so a write never resurrects someone else's
 * stale view.
 */

import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { withLockedFile } from "./locked-file.ts";
import { processStart } from "./process-identity.ts";
import { schedulerDir } from "./task-registry.ts";

export const INDEX_VERSION = 1;

/** The strongest wake level among a session's tasks: what the wake tick (lib/wake.ts) reads. */
export type WakeLevel = "crash" | "always";

export interface SessionIndexEntry {
  /** The session JSONL. Only indexed once it exists on disk. */
  sessionFile: string;
  cwd: string;
  /** This pi's pid while the session is live; absent once it has shut down. */
  pid?: number;
  /** ps lstart for `pid`, so a reused pid is not mistaken for this process. */
  pidStart?: string;
  host: string;
  /** When this process opened the session. */
  liveSince: number;
  /** When it last let go of it, for any reason. */
  closedAt?: number;
  /** Earliest unpaused task, or absent when every task is paused. */
  nextDueAt?: number;
  /** Earliest due time among the tasks that carry a `wake` level. */
  nextWakeDueAt?: number;
  /**
   * Earliest due time among the `wake: "always"` tasks only. The wake tick may
   * reopen a session the user quit on purpose for these and nothing else, so
   * it needs them apart from the `crash` ones.
   */
  nextAlwaysDueAt?: number;
  /** `always` > `crash` > absent, over the unpaused tasks. */
  wake?: WakeLevel;
  /** Unpaused tasks. Zero means the entry is removed. */
  count: number;
  updatedAt: number;
}

export interface SessionIndex {
  v: number;
  sessions: Record<string, SessionIndexEntry>;
}

export function indexPath(): string {
  return join(schedulerDir(), "session-timers.json");
}

function emptyIndex(): SessionIndex {
  return { v: INDEX_VERSION, sessions: {} };
}

function isEntry(value: unknown): value is SessionIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SessionIndexEntry>;
  return typeof entry.sessionFile === "string"
    && typeof entry.cwd === "string"
    && typeof entry.host === "string"
    && Number.isFinite(entry.count)
    && Number.isFinite(entry.updatedAt)
    && Number.isFinite(entry.liveSince)
    && (entry.pid === undefined || Number.isFinite(entry.pid))
    && (entry.pidStart === undefined || typeof entry.pidStart === "string")
    && (entry.nextDueAt === undefined || Number.isFinite(entry.nextDueAt))
    && (entry.nextWakeDueAt === undefined || Number.isFinite(entry.nextWakeDueAt))
    && (entry.nextAlwaysDueAt === undefined || Number.isFinite(entry.nextAlwaysDueAt))
    && (entry.wake === undefined || entry.wake === "crash" || entry.wake === "always");
}

/** True when this process started the pid that wrote the entry, so it is still that pi. */
function sameProcess(entry: SessionIndexEntry, pid: number): boolean {
  if (entry.pid !== pid) return false;
  // No recorded start means we cannot prove it is the same process: a reused
  // pid is exactly what the field is for, and guessing "still alive" there
  // would skip a catch-up and then silently drop the fire.
  if (entry.pidStart === undefined) return false;
  return processStart(pid) === entry.pidStart;
}

/** A live pi on this host holding the session that is not us (`pid`). */
function liveOtherHolder(entry: SessionIndexEntry | undefined, pid = process.pid): boolean {
  if (!entry || entry.pid === undefined || entry.pid === pid) return false;
  // Another host cannot be probed from here; assume it is alive rather than
  // unseat a session we cannot see.
  if (entry.host !== hostname()) return true;
  return sameProcess(entry, entry.pid);
}

export interface ReadIndexResult {
  index: SessionIndex;
  /**
   * Present when the file exists but is malformed: the next writer moves it
   * aside and starts empty.
   */
  corrupt?: string;
  /**
   * Present when the index must not be rewritten at all — a newer pi's format,
   * or a file we could not even read. Rewriting either would lose entries this
   * version cannot represent.
   */
  error?: string;
}

/**
 * Read the index without locking.
 *
 * A corrupt file is reported, not repaired: the next writer moves it aside and
 * starts empty, and a reader that silently treated it as empty would tell the
 * caller "nothing is due" when the truth is "unknown". A file from a newer pi,
 * or one we lack permission to read, is reported as an error instead: it is not
 * corrupt, and clobbering it would lose entries the newer version understands.
 */
export function readSessionIndex(): ReadIndexResult {
  let raw: string;
  try {
    raw = readFileSync(indexPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { index: emptyIndex() };
    return { index: emptyIndex(), error: String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { index: emptyIndex(), corrupt: error instanceof Error ? error.message : "invalid JSON" };
  }
  const candidate = parsed as Partial<SessionIndex> | null;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { index: emptyIndex(), corrupt: "not a JSON object" };
  }
  if (typeof candidate.v === "number" && candidate.v > INDEX_VERSION) {
    return {
      index: emptyIndex(),
      error: `the session-timer index is version ${candidate.v}; this pi writes version ${INDEX_VERSION}`,
    };
  }
  if (candidate.v !== INDEX_VERSION || !candidate.sessions || typeof candidate.sessions !== "object") {
    return { index: emptyIndex(), corrupt: `unexpected shape (v ${String(candidate.v)})` };
  }
  const sessions: Record<string, SessionIndexEntry> = {};
  for (const [id, entry] of Object.entries(candidate.sessions)) {
    if (isEntry(entry)) sessions[id] = entry;
  }
  return { index: { v: INDEX_VERSION, sessions } };
}

function writeIndex(index: SessionIndex): void {
  const path = indexPath();
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(index, undefined, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Move an unreadable index aside rather than deleting evidence, and start empty. */
function quarantineIndex(): void {
  const path = indexPath();
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      // Nothing to do; the next write replaces it anyway.
    }
  }
}

export interface IndexPlanInput {
  sessionFile: string;
  cwd: string;
  pid?: number;
  pidStart?: string;
  host?: string;
  liveSince: number;
  closedAt?: number;
  nextDueAt?: number;
  nextWakeDueAt?: number;
  nextAlwaysDueAt?: number;
  wake?: WakeLevel;
  count: number;
}

/**
 * The entry for this session, or nothing when it should not be indexed.
 *
 * No timers means no entry: a session with nothing armed has no reason to be
 * in a file the tick reads, and a still-open session that is simply idle would
 * otherwise sit there forever.
 */
export function planIndexEntry(input: IndexPlanInput, now = Date.now()): SessionIndexEntry | undefined {
  // Nothing armed means nothing to index: a session with no unpaused timers has
  // no reason to be in a file the tick reads, and an idle-but-open one would
  // otherwise sit there forever.
  if (!input.sessionFile || input.count <= 0) return undefined;
  const entry: SessionIndexEntry = {
    sessionFile: input.sessionFile,
    cwd: input.cwd,
    host: input.host ?? hostname(),
    liveSince: input.liveSince,
    count: input.count,
    updatedAt: now,
  };
  if (input.pid !== undefined) entry.pid = input.pid;
  if (input.pidStart !== undefined) entry.pidStart = input.pidStart;
  if (input.closedAt !== undefined) entry.closedAt = input.closedAt;
  if (input.nextDueAt !== undefined) entry.nextDueAt = input.nextDueAt;
  if (input.nextWakeDueAt !== undefined) entry.nextWakeDueAt = input.nextWakeDueAt;
  if (input.nextAlwaysDueAt !== undefined) entry.nextAlwaysDueAt = input.nextAlwaysDueAt;
  if (input.wake !== undefined) entry.wake = input.wake;
  return entry;
}

function sameEntry(a: SessionIndexEntry | undefined, b: SessionIndexEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const { updatedAt: _a, ...left } = a;
  const { updatedAt: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The pid of a different live pi holding this session, if there is one.
 *
 * Two pi processes on one session (the same file opened twice, or a resume in
 * a second terminal) would each catch up the same missed timer and each fire
 * it. The pid plus its lstart is the identity: a matching pid on this host
 * whose start time also matches is that process, still running.
 */
export function sessionHolder(sessionId: string, pid = process.pid): number | undefined {
  const { index } = readSessionIndex();
  const entry = index.sessions[sessionId];
  if (!liveOtherHolder(entry, pid)) return undefined;
  return entry?.pid;
}

export function sessionHeldElsewhere(sessionId: string, pid = process.pid): boolean {
  return sessionHolder(sessionId, pid) !== undefined;
}

export interface IndexWriteResult {
  written: boolean;
  /** Present when the write failed; the caller warns once and carries on. */
  error?: string;
}

/**
 * Who is writing this entry:
 *  - `claim`: this pi now holds the session, so its pid goes in.
 *  - `release`: this pi is letting go. The pid is cleared only when it is ours
 *    (or its holder is dead), so a `pi -p --session X` that runs while a TUI
 *    holds X cannot mark X closed on its way out.
 *  - `passive`: print mode, or a restore that found another live holder. The
 *    timing fields are updated; the pid is left alone while someone else holds
 *    the session.
 */
export type IndexOwner = "claim" | "release" | "passive";

export interface UpdateIndexOptions {
  /** Prune an entry only when its session file is gone *and* its pi is not running. */
  fileExists?: (path: string) => boolean;
  now?: number;
  owner?: IndexOwner;
}

/** How many `ps` probes one write may make while pruning. */
export const MAX_PRUNE_PROBES = 4;

/**
 * The entry as this writer is allowed to leave it: a live holder we are not
 * keeps its pid identity, and only a release that owns the entry marks it
 * closed.
 */
function entryForOwner(
  current: SessionIndexEntry | undefined,
  entry: SessionIndexEntry,
  owner: IndexOwner,
  now: number,
): SessionIndexEntry {
  const next: SessionIndexEntry = { ...entry };
  if (owner === "claim") return next;
  if (liveOtherHolder(current)) {
    next.pid = current?.pid;
    if (current?.pidStart !== undefined) next.pidStart = current.pidStart;
    else delete next.pidStart;
    delete next.closedAt;
    return next;
  }
  if (owner === "release") {
    delete next.pid;
    delete next.pidStart;
    next.closedAt = entry.closedAt ?? now;
  }
  return next;
}

/**
 * Set (or, with `entry === undefined`, remove) this session's index entry.
 *
 * Returns whether anything was written. Nothing is written when the entry is
 * unchanged, which matters: a one-minute loop persists every minute, and the
 * index would otherwise be rewritten at the same rate for no new information.
 *
 * Never throws: this runs from `persist()` and from timer callbacks.
 */
export function updateSessionIndex(
  sessionId: string,
  entry: SessionIndexEntry | undefined,
  options: UpdateIndexOptions = {},
): IndexWriteResult {
  const now = options.now ?? Date.now();
  const fileExists = options.fileExists ?? existsByStat;
  const owner = options.owner ?? "claim";

  try {
    const written = withLockedFile(indexPath(), readSessionIndex, (result) => {
      if (result.error !== undefined) {
        // Refuse to write: a newer pi's format (or a file we cannot read) is
        // not ours to replace. The caller reports it and carries on.
        throw new Error(result.error);
      }
      const { index, corrupt } = result;
      let dirty = false;
      if (corrupt !== undefined) {
        quarantineIndex();
        for (const key of Object.keys(index.sessions)) delete index.sessions[key];
        dirty = true;
      }

      // Prune before upserting, so a dead session's entry never survives a
      // write by anyone. Both conditions are required: the file can be missing
      // because pi has not flushed a brand-new session yet, and the pid can be
      // absent because that pi simply finished with it.
      let probes = 0;
      for (const [id, candidate] of Object.entries(index.sessions)) {
        if (id === sessionId) continue;
        // Check the cheap condition first: resolving a pid is a `ps` call, and
        // this runs under the lock every other session is waiting on. At most
        // four per write; the rest wait for a later one.
        if (fileExists(candidate.sessionFile)) continue;
        if (candidate.pid !== undefined && candidate.host === hostname()) {
          if (probes >= MAX_PRUNE_PROBES) continue;
          probes += 1;
          if (sameProcess(candidate, candidate.pid)) continue;
        }
        delete index.sessions[id];
        dirty = true;
      }

      const current = index.sessions[sessionId];
      if (entry === undefined) {
        // Removing is this session's own business: a passive writer (or a
        // release) must not delete an entry a live holder still owns.
        if (current !== undefined && !(owner !== "claim" && liveOtherHolder(current))) {
          delete index.sessions[sessionId];
          dirty = true;
        }
      } else {
        const next = entryForOwner(current, entry, owner, now);
        if (!sameEntry(current, next)) {
          index.sessions[sessionId] = next;
          dirty = true;
        }
      }

      if (!dirty) return false;
      writeIndex(index);
      return true;
    }, { attempts: 10 });
    return { written };
  } catch (error) {
    // The index is an optimization for an outside process; losing an update is
    // survivable, throwing out of persist() or a timer is not. The caller warns.
    return { written: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function existsByStat(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
