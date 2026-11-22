/**
 * Serialized read-modify-write over one small JSON file.
 *
 * Two different stores need exactly this: the durable task registry
 * (`tasks.json`, written by the `/schedule` command, the CLI and every tick)
 * and the session-timer index (`session-timers.json`, written by every pi that
 * has timers). Many processes write each one, so a read-write pair that is not
 * under a shared lock loses updates.
 *
 * mkdir is the one filesystem primitive that is atomic on every macOS
 * filesystem including network volumes, which is why the mutex is a directory
 * rather than an O_EXCL file. It is held only for the JSON round trip plus
 * whatever `mutate` does, so keep that short and never do I/O that might block
 * for long inside it.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_STALE_MS = 60_000;

/** How long to wait between attempts, and how many: ~2s of contention. */
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 100;

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function lockPathOf(path: string): string {
  return `${path}.lock`;
}

function lockAgeMs(path: string): number | undefined {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Take the lock for `path`, read the current value, hand it to `mutate`, and
 * return whatever `mutate` returns.
 *
 * Synchronous on purpose: its two callers are `appendEntry` in `persist()` and
 * a `setTimeout` callback, both of which have to finish in the tick they
 * started in. Contention is therefore paid with `Atomics.wait` on a throwaway
 * buffer — at most a couple of milliseconds in practice, since every critical
 * section here is one small JSON read and write.
 */
export function withLockedFile<V, R>(
  path: string,
  read: () => V,
  mutate: (value: V) => R,
): R {
  ensureDir(dirname(path));
  const lockPath = lockPathOf(path);

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = lockAgeMs(lockPath);
      if (age !== undefined && age > LOCK_STALE_MS) {
        // The holder died mid-write. Files here are only ever replaced by
        // rename, so the worst case is a lost concurrent edit, not a torn file.
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      continue;
    }

    // A `process.exit` from inside `mutate` would skip the finally below and
    // strand this lock for the full stale window, blocking every other
    // invocation. Belt and braces: release it on the way out too.
    const release = () => rmSync(lockPath, { recursive: true, force: true });
    process.once("exit", release);
    try {
      return mutate(read());
    } finally {
      process.removeListener("exit", release);
      release();
    }
  }

  throw new Error(`Could not lock ${lockPath}; remove it if no scheduler is running`);
}
