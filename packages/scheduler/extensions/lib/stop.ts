/**
 * Ending a running durable run: `pi-scheduler stop <id>` and `/schedule stop <id>`.
 *
 * SIGTERM to the run's child's process group (the runner spawns each child
 * detached, so its pid is its group), then SIGKILL after a grace period if the
 * group is still there: the same escalation the runner's timeout uses.
 *
 * Only a claim this machine wrote (runnerHost), and only the child that claim
 * recorded (runChildPid: set while it runs, cleared when it exits). The SIGKILL
 * re-reads the claim under the lock and goes only if it is still the same run
 * (runningSince), so a pid the OS has since handed to something else is never
 * signalled. The runner then settles the run as "stopped" (stopRequestedAt).
 *
 * Not running, or between children: `{ stopped: false }`, not an error. Botsun's
 * info sheet can be a couple of seconds stale, so a run that just ended is fine.
 */

import { hostname } from "node:os";

import { findTask, requestStop, withRegistry, writeRegistry } from "./task-registry.ts";

export const STOP_GRACE_MS = 5_000;

export interface StopResult {
  task: string;
  stopped: boolean;
  reason?: string;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Throws for a task that doesn't exist or runs on another machine. */
export async function stopRun(selector: string, graceMs = STOP_GRACE_MS): Promise<StopResult> {
  const first = withRegistry((registry) => {
    const existing = findTask(registry.tasks, selector);
    const label = existing.name ?? existing.id;
    if (existing.runningSince === undefined) return { task: label, stopped: false, reason: "not running" } as const;
    if (existing.runnerHost !== hostname()) {
      throw new Error(`${label} is running on ${existing.runnerHost ?? "an unknown host"}, not this one; stop it there`);
    }
    const pgid = existing.runChildPid;
    if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 1) {
      return { task: label, stopped: false, reason: "no child running" } as const;
    }
    const index = registry.tasks.indexOf(existing);
    registry.tasks[index] = requestStop(existing, Date.now());
    writeRegistry(registry);
    try {
      process.kill(-pgid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { task: label, stopped: false, reason: "its child had already exited" } as const;
      }
      throw error;
    }
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
