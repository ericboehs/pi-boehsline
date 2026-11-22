/**
 * Session lifecycle records: how each interactive session last closed.
 *
 * The wake tick (lib/wake.ts) reopens a closed session only when it can tell
 * the close was not on purpose. pi itself says almost nothing about that:
 * `session_shutdown` reads `quit` for Ctrl+C, Ctrl+D, `/quit`, SIGHUP and
 * SIGTERM alike, and nothing at all is emitted for SIGKILL, an OOM kill, a
 * panic or a power loss. So session-scheduler.ts (always loaded) writes one
 * small record per session:
 *
 *   ~/.pi/agent/scheduler/sessions/<sessionId>.json   (dir 0700, file 0600)
 *
 *   - `state: "live"` at session_start, TUI mode only, with this pi's pid and
 *     ps lstart (so a reused pid is not mistaken for it);
 *   - `state: "closed"` plus `how` at session_shutdown;
 *   - `how: "crash"` from a synchronous `process.on("exit")` when the process
 *     exits without a shutdown (pi's uncaughtCrash, a dead terminal).
 *
 * A session with no record is unknown, and unknown is never woken: print
 * mode, `--no-session`, subagent children and an older pi never write one.
 *
 * Ids, paths, pids and times only. Never a prompt, a command or a summary:
 * the tick that reads these runs unattended and logs what it decides.
 */

import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { schedulerDir } from "./task-registry.ts";

export const LIFECYCLE_VERSION = 1;

/**
 * How a session closed:
 *  - `user`: an interactive quit (/quit, Ctrl+C, Ctrl+D). Never woken except
 *    for an `always` timer.
 *  - `switched`: /new, /resume or /fork moved this process to another
 *    session. The same as `user` for waking.
 *  - `signal:SIGHUP` / `signal:SIGTERM`: a signal reached pi. Crash-class only
 *    when the machine rebooted since, or the tmux server pi ran in is gone;
 *    otherwise it is someone closing the window, which is `user`.
 *  - `crash`: the process exited without a shutdown.
 */
export type CloseHow = "user" | "switched" | "signal:SIGHUP" | "signal:SIGTERM" | "crash";

export interface TmuxServerIdentity {
  pid: number;
  /** ps lstart of the server, so a reused pid is not read as the same server. */
  start: string;
}

export interface LifecycleRecord {
  v: number;
  sessionFile: string;
  cwd: string;
  host: string;
  pid: number;
  pidStart?: string;
  liveSince: number;
  lastSeen: number;
  state: "live" | "closed";
  how?: CloseHow;
  closedAt?: number;
  /** Set when this process was started by a wake; the tick matches it to its own record. */
  wakeId?: string;
  opener: "wake" | "manual";
  /** The tmux server pi ran under ($TMUX), so a SIGHUP can be told from a dead server. */
  tmux?: TmuxServerIdentity;
}

const HOWS: CloseHow[] = ["user", "switched", "signal:SIGHUP", "signal:SIGTERM", "crash"];
/** Session ids name files here: no separators, no leading dot. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function lifecycleDir(): string {
  return join(schedulerDir(), "sessions");
}

export function lifecyclePath(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`not a session id: ${JSON.stringify(sessionId)}`);
  return join(lifecycleDir(), `${sessionId}.json`);
}

export function isLifecycleRecord(value: unknown): value is LifecycleRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<LifecycleRecord>;
  const time = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return record.v === LIFECYCLE_VERSION
    && typeof record.sessionFile === "string"
    && typeof record.cwd === "string"
    && typeof record.host === "string"
    && Number.isInteger(record.pid)
    && (record.pidStart === undefined || typeof record.pidStart === "string")
    && time(record.liveSince)
    && time(record.lastSeen)
    && (record.state === "live" || record.state === "closed")
    && (record.how === undefined || HOWS.includes(record.how))
    && (record.closedAt === undefined || time(record.closedAt))
    && (record.wakeId === undefined || typeof record.wakeId === "string")
    && (record.opener === "wake" || record.opener === "manual")
    && (record.tmux === undefined
      || (typeof record.tmux === "object" && record.tmux !== null
        && Number.isInteger(record.tmux.pid) && typeof record.tmux.start === "string"));
}

/** The record for a session, or undefined when there is none or it is unreadable. */
export function readLifecycle(sessionId: string): LifecycleRecord | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(lifecyclePath(sessionId), "utf8"));
    return isLifecycleRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replace a session's record atomically (0600 temp file + rename).
 *
 * Synchronous, because one caller is a `process.on("exit")` listener, where
 * nothing asynchronous ever runs. Throws; callers decide whether that matters.
 */
export function writeLifecycle(sessionId: string, record: LifecycleRecord): void {
  const path = lifecyclePath(sessionId);
  mkdirSync(lifecycleDir(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Every record's session id. */
export function listLifecycleIds(): string[] {
  try {
    return readdirSync(lifecycleDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => SESSION_ID_RE.test(id));
  } catch {
    return [];
  }
}

/**
 * Drop closed records older than `maxAgeMs`. A closed session that old has
 * nothing left to wake for (timer catch-ups and bg exits both stop at 24h),
 * unless a timer still pending in the index will want it: those ids come in
 * `keep` and are never pruned. A `live` record not seen for `maxAgeMs` goes
 * too, when `isDead` says its pi is gone (a SIGKILL or power loss leaves no
 * close behind).
 */
export function pruneLifecycle(
  now: number,
  maxAgeMs: number,
  { keep, isDead }: { keep?: Set<string>; isDead?: (record: LifecycleRecord) => boolean } = {},
): number {
  let removed = 0;
  for (const id of listLifecycleIds()) {
    if (keep?.has(id)) continue;
    const record = readLifecycle(id);
    let stale: boolean;
    if (record?.state === "closed") {
      stale = now - (record.closedAt ?? record.lastSeen) > maxAgeMs;
    } else if (record) {
      stale = now - record.lastSeen > maxAgeMs && isDead?.(record) === true;
    } else {
      // Unreadable: age it by mtime so a torn or foreign file does not live forever.
      try {
        stale = now - statSync(lifecyclePath(id)).mtimeMs > maxAgeMs;
      } catch {
        stale = false;
      }
    }
    if (!stale) continue;
    try {
      rmSync(lifecyclePath(id), { force: true });
      removed += 1;
    } catch {
      // best-effort
    }
  }
  return removed;
}

/** What `session_shutdown`'s reason (plus any signal seen first) makes of a close. */
export function closeHow(reason: string | undefined, signal: string | undefined): CloseHow | "reload" {
  if (reason === "reload") return "reload";
  if (reason === "new" || reason === "resume" || reason === "fork") return "switched";
  if (signal === "SIGHUP" || signal === "SIGTERM") return `signal:${signal}`;
  return "user";
}

/** The tmux server's pid from `$TMUX` (`socket,pid,session`), if pi runs inside tmux. */
export function tmuxServerPid(tmuxEnv: string | undefined): number | undefined {
  if (!tmuxEnv) return undefined;
  const pid = Number(tmuxEnv.split(",")[1]);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}
