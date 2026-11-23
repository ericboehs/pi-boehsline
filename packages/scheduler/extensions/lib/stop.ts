/**
 * Ending a running durable run: `pi-scheduler stop <id>` and `/schedule stop <id>`.
 *
 * SIGTERM to the run's child's process group (the runner spawns each child
 * detached, so its pid is its group), then SIGKILL after a grace period if the
 * group is still there: the same escalation the runner's timeout uses.
 *
 * Only a claim this machine wrote (runnerHost), only the child that claim
 * recorded (runChildPid: set while it runs, cleared when it exits), and only
 * while the claim's runner (runnerPid) is alive and is that child's parent. A
 * runner that crashed leaves its runChildPid behind until a tick notices, and
 * the OS may hand that number to an unrelated group leader in the meantime.
 * The SIGKILL re-reads the claim under the lock and goes only if it is still
 * the same run (runningSince), so a pid the OS has since handed to something
 * else is never signalled. The runner then settles the run as "stopped"
 * (stopRequestedAt), which is written only once the SIGTERM went through.
 *
 * Not running, or between children: `{ stopped: false }`, not an error. Botsun's
 * info sheet can be a couple of seconds stale, so a run that just ended is fine.
 */

import { spawnSync } from "node:child_process";
import { hostname } from "node:os";

import { type DurableTask, findTask, requestStop, withRegistry, writeRegistry } from "./task-registry.ts";

export const STOP_GRACE_MS = 5_000;

export interface StopResult {
  task: string;
  stopped: boolean;
  reason?: string;
}

export interface StopOptions {
  graceMs?: number;
  /** Match the task by its exact id only (`stop --id`), never by name or id prefix. */
  exactId?: boolean;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether `runnerPid` is a live process this user can signal. EPERM counts as
 * not: a process that isn't ours isn't our runner either.
 */
export function runnerAlive(runnerPid: unknown): runnerPid is number {
  if (typeof runnerPid !== "number" || !Number.isInteger(runnerPid) || runnerPid <= 1) return false;
  try {
    process.kill(runnerPid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `ps -o ppid= -o pgid=` output: the process's parent and its process group. */
export function parsePpidPgid(out: string): { ppid: number; pgid: number } | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(out.split("\n")[0] ?? "");
  return match ? { ppid: Number(match[1]), pgid: Number(match[2]) } : undefined;
}

function ppidPgid(pid: number): { ppid: number; pgid: number } | undefined {
  try {
    const result = spawnSync("ps", ["-o", "ppid=", "-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    return parsePpidPgid(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Whether `pgid` is still the run's child: a live process whose parent is the
 * runner and that leads its own group. Anything else means the recorded pid is
 * stale and `kill(-pgid)` could end an unrelated process group.
 */
export function isRunnerChild(
  pgid: number,
  runnerPid: number,
  lookup: (pid: number) => { ppid: number; pgid: number } | undefined = ppidPgid,
): boolean {
  const info = lookup(pgid);
  return info !== undefined && info.ppid === runnerPid && info.pgid === pgid;
}

function selectTask(tasks: DurableTask[], selector: string, exactId: boolean): DurableTask {
  if (!exactId) return findTask(tasks, selector);
  const task = tasks.find((candidate) => candidate.id === selector);
  if (!task) throw new Error(`No scheduled task has the id ${selector}`);
  return task;
}

/** Throws for a task that doesn't exist or runs on another machine. */
export async function stopRun(selector: string, options: StopOptions | number = {}): Promise<StopResult> {
  const { graceMs = STOP_GRACE_MS, exactId = false } = typeof options === "number" ? { graceMs: options } : options;
  const first = withRegistry((registry) => {
    const existing = selectTask(registry.tasks, selector, exactId);
    const label = existing.name ?? existing.id;
    if (existing.runningSince === undefined) return { task: label, stopped: false, reason: "not running" } as const;
    if (existing.runnerHost !== hostname()) {
      throw new Error(`${label} is running on ${existing.runnerHost ?? "an unknown host"}, not this one; stop it there`);
    }
    const pgid = existing.runChildPid;
    if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 1) {
      return { task: label, stopped: false, reason: "no child running" } as const;
    }
    if (!runnerAlive(existing.runnerPid)) {
      return { task: label, stopped: false, reason: "its runner is gone" } as const;
    }
    if (!isRunnerChild(pgid, existing.runnerPid)) {
      return { task: label, stopped: false, reason: "its child had already exited" } as const;
    }
    // Signal first, then record the stop: a run that ended on its own (ESRCH)
    // must not be reported "stopped" with its failure alert swallowed. The
    // lock is still held, and the runner records its child's exit under this
    // same lock before it asks whether it was stopped, so it reads the mark.
    try {
      process.kill(-pgid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { task: label, stopped: false, reason: "its child had already exited" } as const;
      }
      throw error;
    }
    const index = registry.tasks.indexOf(existing);
    registry.tasks[index] = requestStop(existing, Date.now());
    writeRegistry(registry);
    return { task: label, stopped: true, id: existing.id, pgid, claimedAt: existing.runningSince } as const;
  });
  if (!first.stopped) return { task: first.task, stopped: false, reason: first.reason };

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(first.pgid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (groupAlive(first.pgid)) {
    withRegistry((registry) => {
      const current = registry.tasks.find((candidate) => candidate.id === first.id);
      // Still the same run, or nothing: never a reused pid. Its child may have
      // exited (runChildPid cleared) leaving grandchildren in the group, and a
      // pgid isn't reused while its group has a member; a different child
      // recorded means the run moved on, so that one is left alone.
      if (!current || current.runningSince !== first.claimedAt) return;
      if (current.runChildPid !== undefined && current.runChildPid !== first.pgid) return;
      try {
        process.kill(-first.pgid, "SIGKILL");
      } catch {
        // Gone in the meantime.
      }
    });
  }
  return { task: first.task, stopped: true };
}
