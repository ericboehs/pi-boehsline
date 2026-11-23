/**
 * lib/stop.ts in-process: which pids `stop` will signal, and that the stop is
 * recorded only once the signal went through. The CLI's end-to-end stop is in
 * cli.test.mjs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

const { stopRun, runnerAlive, isRunnerChild, parsePpidPgid } = await import("../extensions/lib/stop.ts");

function withTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sched-stop-"));
  const previous = process.env.PI_SCHEDULER_DIR;
  process.env.PI_SCHEDULER_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SCHEDULER_DIR;
    else process.env.PI_SCHEDULER_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

/** A detached sleeper: its own group, and this test process is its parent (as the runner is its child's). */
function victim(t) {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  return child;
}

function seed(dir, claim) {
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    version: 1,
    tasks: [{
      id: "aaaa1111",
      name: "nightly",
      kind: "interval",
      intervalMs: 3_600_000,
      prompt: "say something",
      createdAt: 1_000,
      nextRunAt: 100_000,
      runningSince: 5_000,
      runnerHost: hostname(),
      ...claim,
    }],
  }));
}

const stored = (dir) => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks[0];

test("parsePpidPgid reads ps's two columns, and nothing else", () => {
  assert.deepEqual(parsePpidPgid("  123   456\n"), { ppid: 123, pgid: 456 });
  assert.equal(parsePpidPgid(""), undefined);
  assert.equal(parsePpidPgid("123\n"), undefined);
  assert.equal(parsePpidPgid("PPID PGID\n"), undefined);
});

test("isRunnerChild: the recorded pid must be the runner's child and lead its own group", () => {
  assert.equal(isRunnerChild(50, 10, () => ({ ppid: 10, pgid: 50 })), true);
  assert.equal(isRunnerChild(50, 10, () => ({ ppid: 1, pgid: 50 })), false, "a reused pid under someone else");
  assert.equal(isRunnerChild(50, 10, () => ({ ppid: 10, pgid: 49 })), false, "not a group leader");
  assert.equal(isRunnerChild(50, 10, () => undefined), false, "gone");
});

test("runnerAlive: only a live process this user can signal", async () => {
  assert.equal(runnerAlive(process.pid), true);
  assert.equal(runnerAlive(await deadPid()), false);
  assert.equal(runnerAlive(undefined), false);
  assert.equal(runnerAlive(1), false, "never pid 1");
});

test("a crashed runner's leftover pid is never signalled, even when it names a live group", async (t) => {
  const dir = withTempDir(t);
  const child = victim(t);
  seed(dir, { runnerPid: await deadPid(), runChildPid: child.pid });
  const result = await stopRun("nightly", { graceMs: 0 });
  assert.deepEqual(result, { task: "nightly", stopped: false, reason: "its runner is gone" });
  process.kill(child.pid, 0); // still alive
  assert.equal(stored(dir).stopRequestedAt, undefined);
});

test("a live runner that isn't the pid's parent: the pid was reused, so it is left alone", async (t) => {
  const dir = withTempDir(t);
  const child = victim(t);
  // Alive and ours, but not the sleeper's parent (this process is).
  seed(dir, { runnerPid: process.ppid, runChildPid: child.pid });
  const result = await stopRun("nightly", { graceMs: 0 });
  assert.equal(result.stopped, false);
  assert.match(result.reason, /already exited/);
  process.kill(child.pid, 0);
  assert.equal(stored(dir).stopRequestedAt, undefined);
});

test("the SIGTERM goes first; a run that ended on its own is not marked stopped", async (t) => {
  const dir = withTempDir(t);
  const child = victim(t);
  seed(dir, { runnerPid: process.pid, runChildPid: child.pid });
  const realKill = process.kill;
  t.after(() => { process.kill = realKill; });

  // ESRCH at the SIGTERM: it exited between the check and the signal.
  process.kill = (pid, signal) => {
    if (pid === -child.pid && signal === "SIGTERM") throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    return realKill.call(process, pid, signal);
  };
  const missed = await stopRun("nightly", { graceMs: 0 });
  assert.equal(missed.stopped, false);
  assert.equal(stored(dir).stopRequestedAt, undefined, "its failure still alerts, not swallowed as 'stopped'");

  // A real SIGTERM: the registry has no mark yet at the moment of the kill, and has one after.
  let markedAtKill;
  process.kill = (pid, signal) => {
    if (pid === -child.pid && signal === "SIGTERM") markedAtKill = stored(dir).stopRequestedAt;
    return realKill.call(process, pid, signal);
  };
  const result = await stopRun("nightly", { graceMs: 2_000 });
  assert.deepEqual(result, { task: "nightly", stopped: true });
  assert.equal(markedAtKill, undefined, "killed before it was marked");
  assert.ok(Number.isFinite(stored(dir).stopRequestedAt), "marked once the signal went through");
});

test("exactId matches the id only: never a name or a prefix", async (t) => {
  const dir = withTempDir(t);
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    version: 1,
    tasks: [
      { id: "aaaa1111", name: "nightly", kind: "interval", intervalMs: 3_600_000, prompt: "p", createdAt: 1, nextRunAt: 2 },
      // Named after the other's id: a name-first lookup would pick this one.
      { id: "bbbb2222", name: "aaaa1111", kind: "interval", intervalMs: 3_600_000, prompt: "p", createdAt: 1, nextRunAt: 2 },
    ],
  }));
  assert.equal((await stopRun("aaaa1111")).task, "aaaa1111", "by selector, the name wins");
  assert.equal((await stopRun("aaaa1111", { exactId: true })).task, "nightly", "by --id, the id does");
  await assert.rejects(stopRun("aaaa", { exactId: true }), /No scheduled task has the id aaaa/);
  await assert.rejects(stopRun("nightly", { exactId: true }), /No scheduled task has the id nightly/);
});
