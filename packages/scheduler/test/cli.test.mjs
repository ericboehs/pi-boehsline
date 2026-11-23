/**
 * End-to-end tests for bin/pi-scheduler, run as a real subprocess.
 *
 * The in-process tests cover the slash command; these cover the half that
 * launchd actually invokes, where the interesting failures live: two ticks
 * overlapping, a claim written before pi is spawned, and flags that should be
 * refused rather than quietly ignored.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "pi-scheduler");

function withTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sched-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A pid that is definitely not running.
 *
 * Taken from a process we watched exit, rather than a large constant: a made-up
 * pid may happen to be in use, and on a busy machine 999999 is not the safe bet
 * it looks like. The kernel will not reuse this one for a while.
 */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

/**
 * A fake `pi` that records every invocation.
 *
 * It appends one line per run before doing anything else, so the count is
 * exact even if two copies overlap, and it lingers long enough for a
 * concurrent tick to observe the claim rather than a finished run.
 */
function fakePi(dir, { lingerSeconds = 1 } = {}) {
  const log = join(dir, "invocations");
  const bin = join(dir, "fake-pi");
  writeFileSync(bin, [
    "#!/bin/sh",
    "cat > /dev/null",
    `echo run >> ${JSON.stringify(log)}`,
    `sleep ${lingerSeconds}`,
    "echo output",
  ].join("\n"), { mode: 0o700 });
  chmodSync(bin, 0o700);
  return { bin, invocations: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0) };
}

function cli(dir, args, extraEnv = {}) {
  return run(process.execPath, [CLI, ...args], {
    // The bg registry too: `check`'s wake phase reads it, and a test must
    // never read (let alone act on) the developer's real one.
    env: { ...process.env, PI_SCHEDULER_DIR: dir, PI_BG_STATE_DIR: join(dir, "pi-bg"), ...extraEnv },
    cwd: dir,
  });
}

function seed(dir, task) {
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    version: 1,
    tasks: [{
      id: "aaaa1111",
      name: "nightly",
      kind: "interval",
      intervalMs: 3_600_000,
      prompt: "say something",
      cwd: dir,
      createdAt: Date.now() - 10_000,
      nextRunAt: Date.now() - 1_000,
      ...task,
    }],
  }));
}

test("two overlapping ticks run a due task exactly once", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir);
  seed(dir);

  // The whole point of the claim fields. Without them both ticks would spawn
  // pi and both would call settleRun, advancing the schedule twice and paying
  // for the model twice.
  const [first, second] = await Promise.allSettled([
    cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin }),
    cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin }),
  ]);

  assert.equal(first.status, "fulfilled", first.reason?.message);
  assert.equal(second.status, "fulfilled", second.reason?.message);
  assert.equal(pi.invocations(), 1, "exactly one agent process for one due slot");

  const stored = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks[0];
  assert.equal(stored.runningSince, undefined, "the claim is released once the run settles");
  assert.equal(stored.lastStatus, "ok");
  assert.ok(stored.nextRunAt > Date.now(), "the schedule advanced once, not twice");

  const history = readFileSync(join(dir, "runs", "aaaa1111.jsonl"), "utf8").trim().split("\n");
  assert.equal(history.length, 1, "one run, one record");
});

test("`run` claims too, so a manual run and a tick cannot overlap", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir);
  seed(dir);

  const [manual, tick] = await Promise.allSettled([
    cli(dir, ["run", "nightly"], { PI_SCHEDULER_PI_BIN: pi.bin }),
    cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin }),
  ]);

  assert.ok(manual.status === "fulfilled" || tick.status === "fulfilled", "at least one succeeded");
  assert.equal(pi.invocations(), 1, "one prompt, however the two raced");
});

test("a task claimed by a runner that is still alive is not started again", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir);
  // A pid that genuinely exists, so the liveness probe says "alive" rather
  // than the claim merely being too fresh to have aged out. The test runner
  // itself qualifies: alive, and not the pid the CLI subprocess will see as
  // its own.
  seed(dir, { runningSince: Date.now(), runnerPid: process.pid });

  await cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin });
  assert.equal(pi.invocations(), 0, "someone else owns this run");
});

test("a fresh claim from a runner that has died is taken over at once", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir);
  // Claimed a second ago, so the six-hour age rule says "not stale" — but
  // nothing holds that pid, so the run was abandoned and waiting six hours to
  // notice is six hours of a daily task silently not running.
  seed(dir, { runningSince: Date.now() - 1_000, runnerPid: await deadPid() });

  await cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin });
  assert.equal(pi.invocations(), 1, "the abandoned claim did not block the run");
});

test("check spawns nothing for a task past its catch-up window, and says so", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir);
  seed(dir, { nextRunAt: Date.now() - 86_400_000, misfire: "skip" });

  await cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin });
  assert.equal(pi.invocations(), 0, "a missed slot is not replayed");

  const [record] = readFileSync(join(dir, "runs", "aaaa1111.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(record).status, "skipped", "the misfire is still recorded");
});

test("a corrupt registry stops the CLI instead of being overwritten", async (t) => {
  const dir = withTempDir(t);
  const path = join(dir, "tasks.json");
  writeFileSync(path, '{"version": 1, "tasks": [ truncated');

  await assert.rejects(cli(dir, ["add", "daily", "9a", "::", "x"]), (error) => {
    assert.match(error.stderr, /Cannot read/);
    return true;
  });
  assert.equal(readFileSync(path, "utf8"), '{"version": 1, "tasks": [ truncated');
});

test("an unknown flag is refused rather than silently ignored", async (t) => {
  const dir = withTempDir(t);

  // --modle would otherwise create a task on the default model, and you would
  // find out from the bill.
  await assert.rejects(cli(dir, ["add", "--modle", "gpt-5", "daily", "9a", "::", "x"]), (error) => {
    assert.match(error.stderr, /unknown flag --modle/);
    return true;
  });
  assert.equal(existsSync(join(dir, "tasks.json")), false, "nothing was created");
});

test("-n wants a positive whole number", async (t) => {
  const dir = withTempDir(t);
  seed(dir);
  for (const value of ["banana", "-3", "0"]) {
    await assert.rejects(cli(dir, ["runs", "nightly", "-n", value]), (error) => {
      assert.match(error.stderr, /-n wants a positive whole number/);
      return true;
    });
  }
});

test("an edit that would invalidate the task is refused, not written", async (t) => {
  const dir = withTempDir(t);
  seed(dir);

  // An empty prompt used to be accepted and then dropped by the next read,
  // which looks exactly like `edit` having deleted the task.
  await assert.rejects(cli(dir, ["edit", "nightly", "--prompt="]), (error) => {
    assert.match(error.stderr, /would leave the task invalid/);
    return true;
  });

  const stored = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks[0];
  assert.equal(stored.prompt, "say something", "the original survived");
});

test("renaming cannot create an ambiguous or unselectable task", async (t) => {
  const dir = withTempDir(t);
  seed(dir);
  await cli(dir, ["add", "--name", "other", "daily", "9a", "::", "x"]);

  await assert.rejects(cli(dir, ["edit", "other", "--name", "NIGHTLY"]), (error) => {
    assert.match(error.stderr, /already exists/);
    return true;
  });
  await assert.rejects(cli(dir, ["edit", "other", "--name", "all"]), (error) => {
    assert.match(error.stderr, /cannot be named all/);
    return true;
  });
  await assert.rejects(cli(dir, ["add", "--name", "Nightly", "daily", "9a", "::", "x"]), (error) => {
    assert.match(error.stderr, /already exists/);
    return true;
  });
});

/**
 * Put a fake `launchctl`/`systemctl` first on PATH.
 *
 * The installer shells out to the real service manager, which a test must not
 * do: it would register a per-minute job on the machine running the suite.
 */
function fakeServiceManager(dir, name, body) {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(dir, "calls"))}\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return { binDir, calls: () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "") };
}

test("uninstall reports a failure to stop the timer and leaves the units in place", { skip: process.platform !== "linux" }, async (t) => {
  const dir = withTempDir(t);
  const home = join(dir, "home");
  const units = join(home, ".config", "systemd", "user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "pi-scheduler.timer"), "[Timer]\n");
  writeFileSync(join(units, "pi-scheduler.service"), "[Service]\n");

  const fake = fakeServiceManager(dir, "systemctl", 'echo "Failed to disable unit: connection refused" >&2; exit 1');

  await assert.rejects(
    cli(dir, ["uninstall"], { HOME: home, PATH: `${fake.binDir}:${process.env.PATH}` }),
    (error) => {
      assert.match(error.stderr, /systemctl disable failed/);
      assert.doesNotMatch(error.stdout ?? "", /Removed the scheduler tick/);
      return true;
    },
  );

  // Deleting the unit files under a timer that is still armed leaves it firing
  // every minute with nothing left to stop it by name.
  assert.ok(existsSync(join(units, "pi-scheduler.timer")), "the timer unit survives a failed stop");
  assert.ok(existsSync(join(units, "pi-scheduler.service")));
});

test("the installed unit recovers a registry path containing a space", { skip: process.platform !== "linux" }, async (t) => {
  const dir = withTempDir(t);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const spaced = join(dir, "Application Support", "scheduler");
  mkdirSync(spaced, { recursive: true });
  const fake = fakeServiceManager(dir, "systemctl", "exit 0");

  await cli(dir, ["install"], {
    HOME: home,
    PATH: `${fake.binDir}:${process.env.PATH}`,
    PI_SCHEDULER_DIR: spaced,
  });

  const unit = readFileSync(join(home, ".config", "systemd", "user", "pi-scheduler.service"), "utf8");
  const line = unit.split("\n").find((entry) => entry.includes("PI_SCHEDULER_DIR="));

  // systemd splits an unquoted value on whitespace, so the service would read a
  // registry at the truncated path — not the default, not anything that exists
  // — and appear to do nothing at all. Quotes wrap the whole assignment, which
  // is the form systemd.exec(5) documents.
  assert.equal(line, `Environment="PI_SCHEDULER_DIR=${spaced}"`);
  assert.doesNotMatch(unit, /Persistent=/, "OnUnitActiveSec= timers ignore it");
  // A tmux server the wake phase starts must not die with the oneshot's cgroup.
  assert.match(unit, /^KillMode=process$/m);
});

test("runs still finds the history of a one-shot that has already retired", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir, { lingerSeconds: 0 });
  seed(dir, { kind: "once", intervalMs: undefined, id: "1122aabb", name: "reminder" });

  await cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin });

  const registry = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
  assert.deepEqual(registry.tasks, [], "the one-shot retired");

  // The run log is the only surviving trace of a reminder that failed, which
  // is exactly when someone goes looking for it.
  const { stdout } = await cli(dir, ["runs", "1122aabb"]);
  assert.match(stdout, /ok/);

  await assert.rejects(cli(dir, ["runs", "reminder"]), /No scheduled task matches/);
});

test("resuming a durable one-shot whose time has passed does not fire it", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir);
  seed(dir, {
    kind: "once",
    intervalMs: undefined,
    paused: true,
    nextRunAt: Date.now() - 86_400_000,
  });

  await cli(dir, ["resume", "nightly"]).catch((error) => {
    // Exits nonzero to flag that nothing was resumed.
    assert.match(error.stdout, /stays paused/);
  });

  const stored = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks[0];
  assert.equal(stored.paused, true, "a one-shot has no next slot to move to");

  await cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin });
  assert.equal(pi.invocations(), 0, "and resuming must not fire it immediately");
});

test("flags are checked against the command, not just against the whole CLI", async (t) => {
  const dir = withTempDir(t);
  seed(dir);

  for (const args of [["list", "--model", "x"], ["add", "-n", "5"], ["run", "nightly", "--all"]]) {
    await assert.rejects(cli(dir, args), (error) => {
      assert.match(error.stderr, /is not a flag this command takes/);
      return true;
    });
  }
});

test("remove says so when the run history could not actually be deleted", async (t) => {
  const dir = withTempDir(t);
  seed(dir);
  const runs = join(dir, "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "aaaa1111.jsonl"), "{}\n");
  chmodSync(runs, 0o500);
  if (process.getuid?.() === 0) return;

  // Prompts and outputs are private data. "Removed" while they are still on
  // disk is the one answer that must not happen.
  try {
    await assert.rejects(cli(dir, ["remove", "nightly"]), (error) => {
      assert.match(error.stderr, /could not delete the run history/);
      return true;
    });
  } finally {
    chmodSync(runs, 0o700);
  }
});

test("uninstall keeps the plist when the job could not be unloaded", { skip: process.platform !== "darwin" }, async (t) => {
  const dir = withTempDir(t);
  const home = join(dir, "home");
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, "com.ericboehs.pi-scheduler.plist");
  writeFileSync(plist, "<plist/>\n");

  const fake = fakeServiceManager(dir, "launchctl", 'echo "Operation not permitted" >&2; exit 1');

  await assert.rejects(
    cli(dir, ["uninstall"], { HOME: home, PATH: `${fake.binDir}:${process.env.PATH}` }),
    (error) => {
      assert.match(error.stderr, /launchctl bootout failed/);
      return true;
    },
  );

  // Deleting the plist under a job that is still loaded leaves it firing every
  // minute with nothing left to unload by name.
  assert.ok(existsSync(plist), "the plist survives a failed bootout");
});

test("an unknown short flag is refused rather than taken as a task name", async (t) => {
  const dir = withTempDir(t);
  seed(dir);

  for (const args of [["check", "-x"], ["run", "-x"], ["show", "-v"]]) {
    await assert.rejects(cli(dir, args), (error) => {
      assert.match(error.stderr, /unknown flag -/);
      return true;
    });
  }

  // `--` is still the escape hatch for a selector that starts with a dash.
  await assert.rejects(cli(dir, ["show", "--", "-weird"]), /No scheduled task matches/);
});

test("a manual run prints its result even when the run cannot be recorded", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir, { lingerSeconds: 0 });
  seed(dir);
  // A regular file where runs/ belongs, so every append fails with ENOTDIR.
  writeFileSync(join(dir, "runs"), "");

  // The model result is already paid for; losing it to a bookkeeping failure
  // is the one outcome that must not happen.
  await assert.rejects(cli(dir, ["run", "nightly"], { PI_SCHEDULER_PI_BIN: pi.bin }), (error) => {
    assert.match(error.stdout, /output/, "the result still reaches stdout");
    assert.match(error.stderr, /could not record this run/);
    return true;
  });
});

test("prune reports the logs it could not delete instead of claiming success", async (t) => {
  const dir = withTempDir(t);
  seed(dir);
  const runs = join(dir, "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "orphaned.jsonl"), "{}\n");
  chmodSync(runs, 0o500);
  if (process.getuid?.() === 0) return;

  try {
    await assert.rejects(cli(dir, ["prune"]), (error) => {
      assert.match(error.stdout, /Removed 0 orphaned/);
      assert.match(error.stderr, /could not delete 1 run log\(s\): orphaned/);
      return true;
    });
  } finally {
    chmodSync(runs, 0o700);
  }
});

test("one task failing to settle does not strand the rest of the tick", async (t) => {
  const dir = withTempDir(t);
  const pi = fakePi(dir, { lingerSeconds: 0 });
  const base = {
    kind: "interval",
    intervalMs: 3_600_000,
    prompt: "say something",
    cwd: dir,
    createdAt: Date.now() - 10_000,
    nextRunAt: Date.now() - 1_000,
  };
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    version: 1,
    tasks: [
      { ...base, id: "aaaa1111", name: "first" },
      { ...base, id: "bbbb2222", name: "second" },
    ],
  }));
  // A regular file where runs/ belongs: every settle throws ENOTDIR.
  writeFileSync(join(dir, "runs"), "");

  // The bug this guards: settleRun throwing for task 1 aborted the whole loop,
  // so task 2 never ran *and* task 1 kept its claim — invisible until the
  // stale window, on every tick, forever.
  await assert.rejects(cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin }), (error) => {
    assert.match(error.stderr, /could not settle run/);
    return true;
  });

  assert.equal(pi.invocations(), 2, "both due tasks ran despite the first one failing to settle");
  for (const task of JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")).tasks) {
    assert.equal(task.runningSince, undefined, `${task.name} released its claim`);
    assert.equal(task.runnerPid, undefined, `${task.name} cleared its runner pid`);
  }
});

test("a history line with the wrong type for error does not take down runs", async (t) => {
  const dir = withTempDir(t);
  seed(dir);
  mkdirSync(join(dir, "runs"), { recursive: true });
  // `error: 42` passes a check of only the required fields, then throws a
  // TypeError on .split() and loses the whole history to one bad line.
  writeFileSync(join(dir, "runs", "aaaa1111.jsonl"), [
    JSON.stringify({ runId: "1", startedAt: 1, endedAt: 2, status: "error", error: 42 }),
    JSON.stringify({ runId: "2", startedAt: 3, endedAt: 4, status: "ok", output: "fine" }),
  ].join("\n") + "\n");

  const { stdout } = await cli(dir, ["runs", "nightly"]);
  assert.match(stdout, /ok/, "the good record still lists");
  assert.doesNotMatch(stdout, /42/, "the malformed one is dropped, not rendered");
});

// ── session wake ──

test("wake on|off|bg on|off edit wake.json; status and run --dry-run report without changing anything", async (t) => {
  const dir = withTempDir(t);
  const fresh = (await cli(dir, ["wake", "status"])).stdout;
  assert.match(fresh, /^wake\s+off \(default\) — run `pi-scheduler wake on` after the device test/m, "ships off");
  assert.match(fresh, /^tmux server /m);
  assert.match((await cli(dir, ["wake", "run", "--dry-run"])).stdout, /Session wake is off/);
  assert.match((await cli(dir, ["wake", "off"])).stdout, /Session wake is off/);
  assert.match((await cli(dir, ["wake", "status"])).stdout, /^wake\s+off$/m, "explicitly off: no default note");
  assert.equal(JSON.parse(readFileSync(join(dir, "wake.json"), "utf8")).enabled, false);
  assert.match((await cli(dir, ["wake", "run", "--dry-run"])).stdout, /Session wake is off/);
  assert.match((await cli(dir, ["wake", "on"])).stdout, /Session wake is on/);
  assert.match((await cli(dir, ["wake", "bg", "off"])).stdout, /bg-job wakes are off/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "wake.json"), "utf8")), { enabled: true, bg: false });

  const status = (await cli(dir, ["wake", "status"])).stdout;
  assert.match(status, /^wake\s+on/m);
  assert.match(status, /^bg wake\s+off \(wake\.json bg:false\)/m);
  assert.match(status, /^target\s+tmux session pi-wake/m);
  assert.match(status, /Candidates: none due/);
  assert.match((await cli(dir, ["wake", "run", "--dry-run"])).stdout, /Nothing due/);
  assert.equal(existsSync(join(dir, "wake-state.json")), false, "status and dry runs write no state");
  assert.equal(existsSync(join(dir, "wake.log")), false);

  // bg back on: status names the later of wake.json's bgOnSince and the tick's own.
  const onAt = Date.UTC(2026, 0, 2, 3, 4, 5);
  const tickSawOn = onAt + 3_600_000;
  writeFileSync(join(dir, "wake.json"), JSON.stringify({ enabled: true, bg: true, bgOnSince: onAt }));
  const quiet = (at) => `exits before ${new Date(at).toLocaleString()} stay quiet`;
  assert.ok((await cli(dir, ["wake", "status"])).stdout.includes(quiet(onAt)), "wake.json alone");
  writeFileSync(join(dir, "wake-state.json"), JSON.stringify({ v: 1, ledger: [], bgOnSince: tickSawOn }));
  const later = (await cli(dir, ["wake", "status"])).stdout;
  assert.ok(later.includes(quiet(tickSawOn)), later);
  assert.ok(!later.includes(quiet(onAt)));
  writeFileSync(join(dir, "wake-state.json"), JSON.stringify({ v: 1, ledger: [], bgOnSince: onAt - 3_600_000 }));
  assert.ok((await cli(dir, ["wake", "status"])).stdout.includes(quiet(onAt)), "an older tick sighting does not win");
  rmSync(join(dir, "wake-state.json"));

  await assert.rejects(cli(dir, ["wake", "status", "--dry-run"]), /--dry-run goes with wake run/);
  await assert.rejects(cli(dir, ["wake", "run"]), /only takes --dry-run/);
  await assert.rejects(cli(dir, ["wake", "bg", "maybe"]), /wants on or off/);
  await assert.rejects(cli(dir, ["list", "--dry-run"]), /not a flag this command takes/);
});

/**
 * A fake tmux: records each invocation (args NUL-separated, one per line) and
 * answers the handful of verbs the wake phase uses.
 */
function fakeTmux(dir) {
  const calls = join(dir, "tmux-calls");
  const bin = join(dir, "fake-tmux");
  writeFileSync(bin, [
    "#!/bin/sh",
    `printf '%s\\0' "$@" >> ${JSON.stringify(calls)}; echo >> ${JSON.stringify(calls)}`,
    'case "$1" in',
    "  -V) echo 'tmux 3.4' ;;",
    "  list-sessions) printf '0\\tpi-wake\\n' ;;",
    "  new-window) echo '@7' ;;",
    "esac",
    "exit 0",
  ].join("\n"), { mode: 0o700 });
  chmodSync(bin, 0o700);
  return {
    bin,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => line.split("\0").filter((part, i, all) => i < all.length - 1)) : []),
  };
}

test("check reopens a crashed session through tmux, argv form, before the durable runs", async (t) => {
  const dir = withTempDir(t);
  const tmux = fakeTmux(dir);
  const pi = fakePi(dir, { lingerSeconds: 0 });
  writeFileSync(join(dir, "wake.json"), JSON.stringify({ enabled: true, tmux: tmux.bin, pi: pi.bin }));
  const id = "0193abcd-0000-7000-8000-000000000001";
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const sessionFile = join(dir, `${id}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`);
  const now = Date.now();
  const host = (await run(process.execPath, ["-p", "require('node:os').hostname()"])).stdout.trim();
  mkdirSync(join(dir, "sessions"), { mode: 0o700 });
  writeFileSync(join(dir, "sessions", `${id}.json`), JSON.stringify({
    v: 1, sessionFile, cwd, host, pid: await deadPid(), pidStart: "Sun Nov 22 10:00:00 2026",
    liveSince: now - 3_600_000, lastSeen: now - 600_000, state: "closed", how: "crash", closedAt: now - 600_000, opener: "manual",
  }));
  writeFileSync(join(dir, "session-timers.json"), JSON.stringify({ v: 1, sessions: { [id]: {
    sessionFile, cwd, host, liveSince: now - 3_600_000, closedAt: now - 600_000, count: 1, updatedAt: now,
    wake: "crash", nextDueAt: now - 60_000, nextWakeDueAt: now - 60_000,
  } } }));
  seed(dir);

  const result = await cli(dir, ["check"], { PI_SCHEDULER_PI_BIN: pi.bin });
  const lines = result.stdout.trim().split("\n");
  assert.match(lines[0], new RegExp(`wake ${id} \\(timer\\)`), "the wake phase runs first");
  assert.match(lines[1], /nightly ok/);

  const newWindow = tmux.calls().find((call) => call[0] === "new-window");
  assert.ok(newWindow, "a window was opened");
  const tail = newWindow.slice(newWindow.indexOf("--") + 1);
  assert.equal(tail[0], process.execPath, "absolute node");
  assert.equal(tail[1], CLI, "absolute pi-scheduler");
  assert.equal(tail[2], "wake-exec");
  assert.match(tail[3], /^[0-9a-f]{16}$/);
  assert.equal(tail.length, 4);
  assert.equal(newWindow[newWindow.indexOf("-c") + 1], cwd);
  assert.ok(newWindow.some((arg) => arg.startsWith("PATH=/")), "-e PATH");
  assert.ok(tmux.calls().some((call) => call[0] === "set-option" && call.includes("@pi-session") && call.at(-1) === id));

  const state = JSON.parse(readFileSync(join(dir, "wake-state.json"), "utf8"));
  assert.equal(Object.values(state.wakes)[0].sessionId, id);
  assert.match(readFileSync(join(dir, "wake.log"), "utf8"), new RegExp(`wake ${id} reason=timer`));
  assert.equal(pi.invocations(), 1, "only the durable task ran pi; the wake never did");
});
