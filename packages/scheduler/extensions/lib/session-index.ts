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

/** The strongest wake level among a session's tasks: still a future brief's input. */
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
    && (entry.wake === undefined || entry.wake === "crash" || entry.wake === "always");
}

/** True when this process started the pid that wrote the entry, so it is still that pi. */
function sameProcess(entry: SessionIndexEntry, pid: number): boolean {
  if (entry.pid !== pid) return false;
  // No recorded start means it predates the field; the pid alone is as good as it gets.
  if (entry.pidStart === undefined) return true;
  return processStart(pid) === entry.pidStart;
}

export interface ReadIndexResult {
  index: SessionIndex;
  /** Present when the file existed but could not be trusted. */
  corrupt?: string;
}

/**
 * Read the index without locking.
 *
 * A corrupt file is reported, not repaired: the next writer moves it aside and
 * starts empty, and a reader that silently treated it as empty would tell the
 * caller "nothing is due" when the truth is "unknown".
 */
export function readSessionIndex(): ReadIndexResult {
  let raw: string;
  try {
    raw = readFileSync(indexPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { index: emptyIndex() };
    return { index: emptyIndex(), corrupt: String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { index: emptyIndex(), corrupt: error instanceof Error ? error.message : "invalid JSON" };
  }
  const candidate = parsed as Partial<SessionIndex>;
  if (candidate?.v !== INDEX_VERSION || !candidate.sessions || typeof candidate.sessions !== "object") {
    return { index: emptyIndex(), corrupt: `unsupported version ${String(candidate?.v)}` };
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
  // Paused-only: keep the entry (it still says "this session has timers"), but
  // with nothing due, so a reader never wakes it.
  if (input.nextDueAt !== undefined) entry.nextDueAt = input.nextDueAt;
  if (input.nextWakeDueAt !== undefined) entry.nextWakeDueAt = input.nextWakeDueAt;
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
 * Is the session held by a different live pi?
 *
 * Two pi processes on one session (the same file opened twice, or a resume in
 * a second terminal) would each catch up the same missed timer and each fire
 * it. The pid plus its lstart is the identity: a matching pid on this host
 * whose start time also matches is that process, still running.
 */
export function sessionHeldElsewhere(sessionId: string, pid = process.pid): boolean {
  const { index } = readSessionIndex();
  const entry = index.sessions[sessionId];
  if (!entry || entry.pid === undefined || entry.pid === pid) return false;
  if (entry.host !== hostname()) return false;
  return sameProcess(entry, entry.pid);
}

export interface IndexWriteResult {
  written: boolean;
  /** Present when the write failed; the caller warns once and carries on. */
  error?: string;
}

export interface UpdateIndexOptions {
  /** Prune an entry only when its session file is gone *and* its pi is not running. */
  fileExists?: (path: string) => boolean;
  now?: number;
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

  try {
    const written = withLockedFile(indexPath(), readSessionIndex, ({ index, corrupt }) => {
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
      for (const [id, candidate] of Object.entries(index.sessions)) {
        if (id === sessionId) continue;
        // Check the cheap condition first: resolving a pid is a `ps` call, and
        // this runs under the lock every other session is waiting on.
        if (fileExists(candidate.sessionFile)) continue;
        if (candidate.pid !== undefined && candidate.host === hostname() && sameProcess(candidate, candidate.pid)) continue;
        delete index.sessions[id];
        dirty = true;
      }

      const current = index.sessions[sessionId];
      if (entry === undefined) {
        if (current !== undefined) {
          delete index.sessions[sessionId];
          dirty = true;
        }
      } else if (!sameEntry(current, entry)) {
        index.sessions[sessionId] = entry;
        dirty = true;
      }

      if (!dirty) return false;
      writeIndex(index);
      return true;
    });
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
