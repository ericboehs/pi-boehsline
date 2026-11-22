/**
 * Process identity via `ps`: which process owns a pid, really.
 *
 * A bare pid proves very little — pids are reused, and after a reboot a stale
 * number can belong to something entirely unrelated. `ps -o lstart` names the
 * wall-clock instant the process started, which plus the pid is a workable
 * identity; pinning the lookup to the C locale and UTC is what makes the same
 * process always print the same string (a localized or DST-shifted lstart
 * would never compare equal to the one that was recorded).
 *
 * Both callers already have a pid and want to know "is this still that
 * process": `extensions/bg` for its job wrapper, and the session-timer index
 * (extension/lib/session-index.ts) for "is another live pi holding this
 * session". It lives here rather than in either of them because the answer has
 * to be identical in both, and a drifting copy of that regex is exactly how one
 * of them ends up silently never matching.
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";

export interface ProcessIdentity {
  /** ps lstart, pinned to C locale and UTC: the same process always reads the same. */
  start: string;
  args: string;
}

const psArgs = (pid: number) => ["-ww", "-o", "lstart=", "-o", "args=", "-p", String(pid)];
const PS_OPTIONS = { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 3000, encoding: "utf8" as const };
/** A synchronous lookup blocks whatever called it: give up sooner. */
const PS_SYNC_TIMEOUT_MS = 1000;
const LSTART_RE = /^\s*([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

export function parsePs(out: string): ProcessIdentity | undefined {
  const match = LSTART_RE.exec(out.split("\n")[0] ?? "");
  return match?.[1] && match[2] !== undefined ? { start: match[1], args: match[2] } : undefined;
}

export function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("ps", psArgs(pid), PS_OPTIONS, (error, stdout) =>
        resolve(error ? undefined : parsePs(String(stdout))),
      );
    } catch {
      resolve(undefined);
    }
  });
}

export function processIdentitySync(pid: number): ProcessIdentity | undefined {
  try {
    return parsePs(
      String(
        execFileSync("ps", psArgs(pid), {
          ...PS_OPTIONS,
          timeout: PS_SYNC_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ),
    );
  } catch {
    return undefined;
  }
}

/**
 * What `ps` can say about a pid, with "I could not tell" kept apart from "there
 * is no such process".
 *
 * The wake tick needs the distinction: a dead holder makes a session wakeable,
 * and an unknown one must not, or a `ps` that times out under load would read
 * as "everything is dead" and reopen every session at once.
 */
export type ProcessProbe =
  | { state: "alive"; start: string; args: string }
  | { state: "dead" }
  | { state: "unknown" };

export function probeProcess(pid: number): ProcessProbe {
  if (!Number.isInteger(pid) || pid <= 0) return { state: "dead" };
  const result = spawnSync("ps", psArgs(pid), {
    ...PS_OPTIONS,
    timeout: PS_SYNC_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error) return { state: "unknown" };
  const identity = parsePs(String(result.stdout ?? ""));
  if (identity) return { state: "alive", ...identity };
  // ps printed nothing usable: confirm with kill(0) rather than trusting an
  // empty answer, which is also what a ps killed by its timeout prints.
  try {
    process.kill(pid, 0);
    return { state: "unknown" };
  } catch (error) {
    // EPERM: the pid belongs to another user now, so it is not our pi.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" || code === "EPERM" ? { state: "dead" } : { state: "unknown" };
  }
}

/** Just the start stamp, for callers that only need to compare identity. */
export function processStart(pid: number): string | undefined {
  return processIdentitySync(pid)?.start;
}
