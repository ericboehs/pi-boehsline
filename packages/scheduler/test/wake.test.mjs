// The test environment first: every scheduler file goes to a temp dir. See helpers/env.mjs.
import { schedulerDir } from "./helpers/env.mjs";

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GRACE_MS,
  REBOOT_WINDOW_MS,
  SETTLE_MS,
  STUCK_MS,
  appendWakeLog,
  classifyClose,
  readWakeState,
  resetWake,
  runWakePhase,
  wakeExec,
  wakeLogPath,
  wakeStatePath,
} from "../extensions/lib/wake.ts";
import { readLifecycle, writeLifecycle } from "../extensions/lib/lifecycle.ts";
import { indexPath } from "../extensions/lib/session-index.ts";

const MIN = 60_000;
const HOST = "test-host";
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const ME = process.getuid();
const scratch = mkdtempSync(join(tmpdir(), "wake-test-"));
const BG_STATE = join(scratch, "pi-bg-state");
const BG_LOGS = join(scratch, "pi-bg-logs");
mkdirSync(BG_STATE, { recursive: true, mode: 0o700 });
mkdirSync(BG_LOGS, { recursive: true, mode: 0o700 });
const NODE = "/abs/bin/node";
const SELF = "/abs/pi-scheduler/bin/pi-scheduler";

/** An executable that is never run (deps.run is faked), only resolved. */
function fakeExecutable(name) {
  const path = join(scratch, name);
  writeFileSync(path, "#!/bin/sh\nexit 99\n");
  chmodSync(path, 0o755);
  return path;
}
const TMUX = fakeExecutable("tmux");
const PI = fakeExecutable("pi");

/** Start each test from an empty scheduler dir, and the tests' own wake.json. */
function fresh(config = {}) {
  for (const name of readdirSync(schedulerDir)) rmSync(join(schedulerDir, name), { recursive: true, force: true });
  for (const name of readdirSync(BG_STATE)) rmSync(join(BG_STATE, name), { force: true });
  writeFileSync(join(schedulerDir, "wake.json"), JSON.stringify({ enabled: true, tmux: TMUX, pi: PI, ...config }));
}

let sessionCounter = 0;
/** A session file with a real header, in a real cwd. Returns its id and path. */
function makeSession({ cwd = mkdtempSync(join(scratch, "cwd-")), headerId } = {}) {
  sessionCounter += 1;
  const id = `0193${String(sessionCounter).padStart(4, "0")}-aaaa-bbbb-cccc-${String(sessionCounter).padStart(12, "0")}`;
  const dir = mkdtempSync(join(scratch, "sessions-"));
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: headerId ?? id, timestamp: new Date(NOW).toISOString(), cwd })}\n`);
  return { id, file, cwd };
}

function writeIndex(entries) {
  writeFileSync(indexPath(), JSON.stringify({ v: 1, sessions: entries }));
}

function indexEntry(session, fields = {}) {
  return {
    sessionFile: session.file,
    cwd: session.cwd,
    host: HOST,
    liveSince: NOW - 60 * MIN,
    closedAt: NOW - 30 * MIN,
    count: 1,
    updatedAt: NOW - 30 * MIN,
    wake: "crash",
    nextWakeDueAt: NOW - MIN,
    ...fields,
  };
}

function lifecycle(session, fields = {}) {
  const record = {
    v: 1,
    sessionFile: session.file,
    cwd: session.cwd,
    host: HOST,
    pid: 5000 + sessionCounter,
    pidStart: "Sun Nov 22 10:00:00 2026",
    liveSince: NOW - 60 * MIN,
    lastSeen: NOW - 30 * MIN,
    state: "closed",
    how: "crash",
    closedAt: NOW - 30 * MIN,
    opener: "manual",
    ...fields,
  };
  for (const [key, value] of Object.entries(record)) if (value === undefined) delete record[key];
  writeLifecycle(session.id, record);
  return record;
}

/** A crash-closed session with a due crash timer: the plain wake case. */
function crashedWithTimer(fields = {}, indexFields = {}) {
  const session = makeSession();
  lifecycle(session, fields);
  return { session, entry: indexEntry(session, indexFields) };
}

/**
 * A fake machine. `procs` maps pid → start (alive), or "unknown"; anything
 * else is dead. The fake tmux keeps sessions and windows in memory.
 */
function machine({
  now = NOW,
  boot = NOW - 7 * 24 * 60 * MIN,
  procs = {},
  platform = "darwin",
  serverRunning = true,
  tmuxVersion = "tmux 3.4",
  sessions = ["main"],
  attached = [],
  env = {},
} = {}) {
  const calls = [];
  const tmux = { serverRunning, sessions: new Set(sessions), attached: new Set(attached), windows: [], next: 1 };
  const clock = { now };
  const handleTmux = (args) => {
    const [verb] = args;
    switch (verb) {
      case "-V":
        return { status: 0, stdout: `${tmuxVersion}\n`, stderr: "" };
      case "list-windows":
        if (!tmux.serverRunning) return { status: 1, stdout: "", stderr: "no server running on /tmp/tmux-501/default\n" };
        return {
          status: 0,
          stdout: tmux.windows.map((w) => `${w.id}\t${w.piSession}\t${w.paneDead ? 1 : 0}\n`).join(""),
          stderr: "",
        };
      case "list-sessions":
        if (!tmux.serverRunning) return { status: 1, stdout: "", stderr: "no server running\n" };
        return { status: 0, stdout: [...tmux.sessions].map((s) => `${tmux.attached.has(s) ? 1 : 0}\t${s}\n`).join(""), stderr: "" };
      case "has-session": {
        const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
        return { status: tmux.serverRunning && tmux.sessions.has(name) ? 0 : 1, stdout: "", stderr: "" };
      }
      case "new-session":
        tmux.serverRunning = true;
        tmux.sessions.add(args[args.indexOf("-s") + 1]);
        return { status: 0, stdout: "", stderr: "" };
      case "new-window": {
        const id = `@${tmux.next++}`;
        tmux.windows.push({ id, piSession: "", paneDead: false });
        return { status: 0, stdout: `${id}\n`, stderr: "" };
      }
      case "set-option": {
        const window = tmux.windows.find((w) => w.id === args[args.indexOf("-t") + 1]);
        if (window && args.includes("@pi-session")) window.piSession = args.at(-1);
        return { status: 0, stdout: "", stderr: "" };
      }
      case "display-message":
        return { status: 0, stdout: "4242\n", stderr: "" };
      default:
        return { status: 1, stdout: "", stderr: `fake tmux: ${verb}` };
    }
  };
  const deps = {
    now: () => clock.now,
    hostname: () => HOST,
    bootTime: () => boot,
    probe: (pid) => {
      const value = procs[pid];
      if (value === "unknown") return { state: "unknown" };
      if (typeof value === "string") return { state: "alive", start: value, args: "pi" };
      return { state: "dead" };
    },
    run: (file, args) => {
      calls.push([file, ...args]);
      if (file === TMUX) return handleTmux(args);
      if (file === "/bin/launchctl" || file.endsWith("systemd-run")) {
        const at = args.indexOf(TMUX);
        return at >= 0 ? handleTmux(args.slice(at + 1)) : { status: 1, stdout: "", stderr: "" };
      }
      if (file === "/usr/sbin/taskpolicy") return { status: 0, stdout: "", stderr: "" };
      return { status: 127, stdout: "", stderr: "", error: "not faked" };
    },
    platform,
    uid: ME,
    env: { PATH: "/usr/bin:/bin", HOME: scratch, PI_BG_STATE_DIR: BG_STATE, PI_SCHEDULER_DIR: schedulerDir, ...env },
    node: NODE,
    self: SELF,
  };
  const newWindows = () => calls.filter((call) => call[0] === TMUX && call[1] === "new-window");
  return { deps, calls, tmux, clock, newWindows };
}

const log = () => (existsSync(wakeLogPath()) ? readFileSync(wakeLogPath(), "utf8") : "");
const state = () => readWakeState().state;

// ── the basic wake ──

test("a due wake timer on a crashed session spawns exactly one tmux window", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const m = machine();

  const result = runWakePhase(m.deps);
  assert.equal(result.spawned.length, 1);
  assert.equal(m.newWindows().length, 1);
  const wakes = Object.values(state().wakes);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].sessionId, session.id);
  assert.equal(wakes[0].reason, "timer");
  assert.match(log(), new RegExp(`wake ${session.id} reason=timer close=crash`));

  // The next tick sees it in flight and spawns nothing more.
  m.clock.now += MIN;
  runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 1);
});

test("the spawn is argv form with absolute paths, -e PATH and the wake id, and tags the window", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const m = machine();
  runWakePhase(m.deps);

  const [call] = m.newWindows();
  const args = call.slice(1);
  const wakeId = Object.keys(state().wakes)[0];
  assert.equal(args[0], "new-window");
  assert.ok(args.includes("-d"));
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "pi-wake:"]);
  assert.equal(args[args.indexOf("-n") + 1], `wake:${session.id.slice(0, 8)}`);
  assert.equal(args[args.indexOf("-c") + 1], session.cwd);
  const envs = args.flatMap((arg, i) => (arg === "-e" ? [args[i + 1]] : []));
  const path = envs.find((e) => e.startsWith("PATH="));
  assert.ok(path, "-e PATH=…");
  assert.ok(path.startsWith("PATH=/abs/bin:"), "node's own dir leads PATH so the pi wrapper's `exec node` resolves");
  assert.ok(envs.includes(`PI_WAKE_ID=${wakeId}`));
  // Everything after `--` is the program's argv: absolute node, absolute script, the wake id — never a shell string or a session id.
  assert.deepEqual(args.slice(args.indexOf("--") + 1), [NODE, SELF, "wake-exec", wakeId]);
  assert.ok(!args.some((arg) => /&&|;\s|\bcd\b/.test(arg)), "no shell string anywhere");
  assert.ok(!args.slice(args.indexOf("--") + 1).includes(session.id), "never the session id");

  const tag = m.calls.find((c) => c[0] === TMUX && c[1] === "set-option" && c.includes("@pi-session"));
  assert.deepEqual(tag.slice(1), ["set-option", "-w", "-t", "@1", "@pi-session", session.id]);
});

// ── liveness ──

test("a live session is never spawned", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ state: "live", how: undefined, closedAt: undefined });
  writeIndex({ [session.id]: entry });
  const record = readLifecycle(session.id);
  const m = machine({ procs: { [record.pid]: record.pidStart } });
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.equal(result.decisions[0].reason, "live");
});

test("pid reuse does not count as live: same pid, different start", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ state: "live", how: undefined, closedAt: undefined });
  writeIndex({ [session.id]: entry });
  const record = readLifecycle(session.id);
  const m = machine({ procs: { [record.pid]: "Mon Nov 23 09:00:00 2026" } });
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 1, "a reused pid is a vanished session");
  assert.equal(result.spawned[0].close, "vanished");
});

test("when ps cannot tell, the session is not woken", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ state: "live", how: undefined, closedAt: undefined });
  writeIndex({ [session.id]: entry });
  const m = machine({ procs: { [readLifecycle(session.id).pid]: "unknown" } });
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.equal(result.decisions[0].reason, "ps-unknown");
});

test("no lifecycle record means no wake", () => {
  fresh();
  const session = makeSession();
  writeIndex({ [session.id]: indexEntry(session) });
  const m = machine();
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.equal(result.decisions[0].reason, "no-record");
  assert.doesNotMatch(log(), /skip/, "no-record is quiet: print-mode and subagent sessions never have one");
});

test("a record from another host is never acted on", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ host: "other-host" });
  writeIndex({ [session.id]: entry });
  const m = machine();
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.equal(result.decisions[0].reason, "host-mismatch");
});

// ── classification ──

test("a user quit is skipped, and the skip is logged", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ how: "user" });
  writeIndex({ [session.id]: entry });
  const m = machine();
  runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.match(log(), new RegExp(`skip ${session.id} reason=user-closed close=user`));
});

test("switched (/new, /resume, /fork away) is not eligible", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ how: "switched" });
  writeIndex({ [session.id]: entry });
  const m = machine();
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.equal(result.decisions[0].close, "switched");
});

test("a SIGHUP whose tmux server outlived it is a user close, even after that server dies", () => {
  fresh();
  const tmuxServer = { pid: 777, start: "Sat Nov 21 08:00:00 2026" };
  const { session, entry } = crashedWithTimer({
    how: "signal:SIGHUP", tmux: tmuxServer, closeVerdict: "user", decidedAt: NOW - 30 * MIN,
  });
  writeIndex({ [session.id]: entry });
  // The server is dead now (killed later, for some other reason): the close
  // was decided when it happened, not by what the server does afterwards.
  const m = machine({ procs: {} });
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.equal(result.decisions[0].close, "signal");
  assert.equal(result.decisions[0].reason, "user-closed");

  // Nor a reboot right after.
  fresh();
  const later = crashedWithTimer({ how: "signal:SIGHUP", tmux: tmuxServer, closeVerdict: "user", decidedAt: NOW - 30 * MIN });
  writeIndex({ [later.session.id]: later.entry });
  const rebooted = machine({ boot: NOW - 25 * MIN });
  runWakePhase(rebooted.deps);
  assert.equal(rebooted.newWindows().length, 0, "the server outlived the close: a reboot after it is not why it closed");
});

test("a SIGHUP whose tmux server was gone at the close is not woken: it may have been the last window", () => {
  fresh();
  const tmuxServer = { pid: 777, start: "Sat Nov 21 08:00:00 2026" };
  const { session, entry } = crashedWithTimer({
    how: "signal:SIGHUP", tmux: tmuxServer, closeVerdict: "tmux-gone", decidedAt: NOW - 30 * MIN,
  });
  writeIndex({ [session.id]: entry });
  const m = machine();
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0, "kill-server, a crash and closing the last window look the same");
  assert.equal(result.decisions[0].reason, "user-closed");
  assert.equal(result.decisions[0].close, "tmux-gone");
  assert.match(log(), new RegExp(`skip ${session.id} reason=user-closed close=tmux-gone`));
});

test("an older record with no verdict is never judged by the tmux server as it is now", () => {
  const record = { v: 1, how: "signal:SIGHUP", closedAt: NOW, lastSeen: NOW, tmux: { pid: 777, start: "x" } };
  const probe = () => assert.fail("the tick must not probe the server");
  assert.deepEqual(classifyClose(record, { bootTime: () => NOW - 60 * MIN, probe }), { crash: false, why: "signal" });
});

test("a SIGTERM or SIGHUP the machine rebooted right after is a reboot: eligible", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ how: "signal:SIGTERM", closedAt: NOW - 30 * MIN });
  writeIndex({ [session.id]: entry });
  const m = machine({ boot: NOW - 20 * MIN });
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 1);
  assert.equal(result.spawned[0].close, "reboot");

  // tmux-gone at the close, then the reboot: the shutdown took the server down.
  const gone = { v: 1, how: "signal:SIGHUP", closedAt: NOW - 30 * MIN, lastSeen: NOW - 30 * MIN, closeVerdict: "tmux-gone" };
  assert.deepEqual(classifyClose(gone, { bootTime: () => NOW - 28 * MIN }), { crash: true, why: "reboot" });
});

test("a reboot long after a signal close is not why it closed", () => {
  for (const closeVerdict of [undefined, "tmux-gone"]) {
    const record = { v: 1, how: "signal:SIGHUP", closedAt: NOW - 20 * 60 * MIN, lastSeen: NOW - 20 * 60 * MIN, closeVerdict };
    assert.equal(classifyClose(record, { bootTime: () => NOW - 2 * 60 * MIN }).crash, false, String(closeVerdict));
    assert.equal(classifyClose(record, { bootTime: () => NOW - 20 * 60 * MIN + REBOOT_WINDOW_MS }).crash, true, "within the window");
  }
});

test("SIGHUP, no tmux, booted before the close: a user close", () => {
  const record = { v: 1, how: "signal:SIGHUP", closedAt: NOW, lastSeen: NOW };
  const close = classifyClose(record, { bootTime: () => NOW - 60 * MIN });
  assert.deepEqual(close, { crash: false, why: "signal" });
});

test("an always timer still wakes after any close, tmux-gone and user verdicts included", () => {
  for (const fields of [
    { how: "signal:SIGHUP", closeVerdict: "tmux-gone", tmux: { pid: 777, start: "x" } },
    { how: "signal:SIGHUP", closeVerdict: "user", tmux: { pid: 777, start: "x" } },
    { how: "signal:SIGTERM" },
    { how: "user" },
    { how: "switched" },
  ]) {
    fresh();
    const { session, entry } = crashedWithTimer(fields, { wake: "always", nextWakeDueAt: NOW - MIN, nextAlwaysDueAt: NOW - MIN });
    writeIndex({ [session.id]: entry });
    const m = machine();
    const result = runWakePhase(m.deps);
    assert.equal(m.newWindows().length, 1, JSON.stringify(fields));
    assert.equal(result.spawned[0].reason, "always");
  }
});

// ── always vs crash timers ──

test("a crash timer never wakes a user-closed session; only a due always timer does", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ how: "user" }, {
    wake: "always",
    nextWakeDueAt: NOW - 5 * MIN,
    nextAlwaysDueAt: NOW + 30 * MIN,
  });
  writeIndex({ [session.id]: entry });
  const m = machine();
  runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0, "the due timer is a crash one");

  m.clock.now = NOW + 31 * MIN;
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 1);
  assert.equal(result.spawned[0].reason, "always");
});

test("a due time more than 24 h old is past the misfire window: no wake", () => {
  fresh();
  const { session, entry } = crashedWithTimer({}, { nextWakeDueAt: NOW - 25 * 60 * MIN });
  writeIndex({ [session.id]: entry });
  const m = machine();
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.equal(result.decisions[0].reason, "stale");
});

// ── caps ──

test("at most perTick spawns per tick, oldest due first", () => {
  fresh();
  const sessions = {};
  const due = [NOW - 3 * MIN, NOW - 10 * MIN, NOW - 5 * MIN];
  const ids = due.map((dueAt) => {
    const { session, entry } = crashedWithTimer({}, { nextWakeDueAt: dueAt });
    sessions[session.id] = entry;
    return session.id;
  });
  writeIndex(sessions);
  const m = machine();
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 1);
  assert.equal(result.spawned[0].sessionId, ids[1], "the oldest due");
  assert.equal(result.decisions.filter((d) => d.reason === "per-tick").length, 2);
  assert.doesNotMatch(log(), /per-tick/, "a deferral is not worth a log line");

  // perTick: 2 takes two.
  fresh({ perTick: 2 });
  writeIndex(sessions);
  for (const id of ids) lifecycle({ id, file: sessions[id].sessionFile, cwd: sessions[id].cwd });
  const m2 = machine();
  runWakePhase(m2.deps);
  assert.equal(m2.newWindows().length, 2);
});

test("the hourly caps: per session (keyed host+session) and global", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const ledger = [1, 2, 3].map((n) => ({ host: HOST, sessionId: session.id, at: NOW - n * 10 * MIN }));
  // Another host's spawns of the same session do not count here.
  ledger.push({ host: "other-host", sessionId: session.id, at: NOW - MIN });
  writeFileSync(wakeStatePath(), JSON.stringify({ v: 1, wakes: {}, failures: {}, ledger, logged: {} }));
  const m = machine();
  let result = runWakePhase(m.deps);
  assert.equal(result.decisions[0].reason, "cap-session");

  fresh({ globalHourly: 2 });
  lifecycle(session);
  writeIndex({ [session.id]: entry });
  writeFileSync(wakeStatePath(), JSON.stringify({
    v: 1, wakes: {}, failures: {}, logged: {},
    ledger: [{ host: HOST, sessionId: "a", at: NOW - MIN }, { host: HOST, sessionId: "b", at: NOW - MIN }],
  }));
  result = runWakePhase(machine().deps);
  assert.equal(result.decisions[0].reason, "cap-global");
});

// ── pre-spawn skips ──

test("an existing @pi-session window for the session means no spawn", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const m = machine();
  m.tmux.windows.push({ id: "@9", piSession: session.id, paneDead: false });
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 0);
  assert.equal(result.decisions[0].reason, "window-exists");
});

test("pre-spawn skips: file missing, header mismatch, cwd missing, tmux missing or old", () => {
  const cases = [
    ["file-missing", (s) => rmSync(s.file), {}],
    ["header-mismatch", null, { headerId: "0193ffff-not-this-one" }],
    ["cwd-missing", (s) => rmSync(s.cwd, { recursive: true }), {}],
  ];
  for (const [reason, mutate, sessionOptions] of cases) {
    fresh();
    const session = makeSession(sessionOptions);
    lifecycle(session);
    writeIndex({ [session.id]: indexEntry(session) });
    mutate?.(session);
    const m = machine();
    const result = runWakePhase(m.deps);
    assert.equal(result.decisions[0].reason, reason);
    assert.equal(m.newWindows().length, 0, reason);
  }

  fresh({ tmux: join(scratch, "no-such-tmux") });
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  assert.equal(runWakePhase(machine().deps).decisions[0].reason, "tmux-missing");

  fresh();
  lifecycle(session);
  writeIndex({ [session.id]: entry });
  const old = machine({ tmuxVersion: "tmux 2.9a" });
  assert.equal(runWakePhase(old.deps).decisions[0].reason, "tmux-old");
  assert.equal(old.newWindows().length, 0);
});

test("user-closed and stale skips are logged once per due time; others at most once an hour", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ how: "user" });
  writeIndex({ [session.id]: entry });
  const m = machine();
  const skips = () => log().split("\n").filter((line) => line.includes(" skip ")).length;
  runWakePhase(m.deps);
  m.clock.now += MIN;
  runWakePhase(m.deps);
  m.clock.now += 3 * 60 * MIN;
  runWakePhase(m.deps);
  assert.equal(skips(), 1, "the same due time is never logged again");
  writeIndex({ [session.id]: { ...entry, nextWakeDueAt: m.clock.now - MIN } });
  runWakePhase(m.deps);
  assert.equal(skips(), 2, "a new due time is");

  // ps-unknown is not tied to a due time: hourly.
  fresh();
  const other = crashedWithTimer({ state: "live", how: undefined, closedAt: undefined });
  writeIndex({ [other.session.id]: other.entry });
  const u = machine({ procs: { [5000 + sessionCounter]: "unknown" } });
  runWakePhase(u.deps);
  u.clock.now += 30 * MIN;
  runWakePhase(u.deps);
  assert.equal(skips(), 1);
  u.clock.now += 31 * MIN;
  runWakePhase(u.deps);
  assert.equal(skips(), 2);
});

test("a stale due time is dropped on its own: a fresher always timer still wakes", () => {
  fresh();
  const { session, entry } = crashedWithTimer({}, {
    wake: "always",
    nextWakeDueAt: NOW - 25 * 60 * MIN,
    nextAlwaysDueAt: NOW - 2 * MIN,
  });
  writeIndex({ [session.id]: entry });
  const m = machine();
  const result = runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 1);
  assert.equal(result.spawned[0].reason, "always");
  assert.equal(result.spawned[0].dueAt, NOW - 2 * MIN);
});

// ── grace, stuck, failures, backoff ──

function spawnOne(m, session, entry) {
  writeIndex({ [session.id]: entry });
  runWakePhase(m.deps);
  const [wake] = Object.values(state().wakes);
  assert.ok(wake, "spawned");
  return wake;
}

test("grace: a wake with no live record and no pane fails after 3 minutes, not before", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  const m = machine();
  const wake = spawnOne(m, session, entry);
  m.tmux.windows = [];

  m.clock.now = NOW + GRACE_MS - 1000;
  runWakePhase(m.deps);
  assert.ok(state().wakes[wake.wakeId], "still in grace");

  m.clock.now = NOW + GRACE_MS + 1000;
  runWakePhase(m.deps);
  assert.equal(state().wakes[wake.wakeId], undefined);
  assert.equal(state().failures[`${HOST}:${session.id}`].count, 1);
  assert.match(log(), new RegExp(`fail ${session.id} reason=no-start`));
});

test("grace stretches across a sleep: the time asleep does not count", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  const m = machine();
  const wake = spawnOne(m, session, entry);
  // The lid closes right after the spawn for an hour; on wake the pane is alive and pi is still booting.
  m.clock.now = NOW + 61 * MIN;
  runWakePhase(m.deps);
  assert.ok(state().wakes[wake.wakeId], "not stuck: most of that hour was sleep");
});

test("a pane alive but never live after 10 minutes is stuck: a failure, and never killed", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  const m = machine();
  const wake = spawnOne(m, session, entry);
  for (let t = 1; t <= 11; t += 1) {
    m.clock.now = NOW + t * MIN;
    runWakePhase(m.deps);
  }
  assert.ok(NOW + 11 * MIN - NOW >= STUCK_MS);
  assert.equal(state().wakes[wake.wakeId], undefined);
  assert.match(log(), /reason=stuck/);
  assert.ok(!m.calls.some((c) => c[1] === "kill-window" || c[1] === "kill-pane"), "never killed");
  // Its window is still there, so the next tick will not open a second.
  const result = runWakePhase(m.deps);
  assert.equal(result.decisions[0]?.reason, "window-exists");
});

test("a woken session live for 10 minutes is a success, and clears earlier failures", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  const m = machine();
  const prior = { count: 1, lastAt: NOW - 2 * 60 * MIN, lastReason: "no-start" };
  writeFileSync(wakeStatePath(), JSON.stringify({ v: 1, wakes: {}, failures: { [`${HOST}:${session.id}`]: prior }, ledger: [], logged: {} }));
  const wake = spawnOne(m, session, entry);
  const pidStart = "Sun Nov 22 12:00:30 2026";
  lifecycle(session, { state: "live", how: undefined, closedAt: undefined, pid: 9100, pidStart, liveSince: NOW + 30_000, lastSeen: NOW + 30_000, wakeId: wake.wakeId, opener: "wake" });
  m.deps.probe = (pid) => (pid === 9100 ? { state: "alive", start: pidStart, args: "pi" } : { state: "dead" });

  m.clock.now = NOW + 5 * MIN;
  runWakePhase(m.deps);
  assert.ok(state().wakes[wake.wakeId], "live, but not yet settled");
  m.clock.now = NOW + SETTLE_MS + MIN;
  runWakePhase(m.deps);
  assert.equal(state().wakes[wake.wakeId], undefined);
  assert.equal(state().failures[`${HOST}:${session.id}`], undefined, "the streak is broken");
  assert.match(log(), new RegExp(`ok ${session.id}`));
});

test("a crash within 10 minutes of going live is a failure; two in a row back off until a manual open", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  const m = machine();
  const key = `${HOST}:${session.id}`;

  for (let round = 0; round < 2; round += 1) {
    m.tmux.windows = [];
    const base = m.clock.now;
    const wake = spawnOne(m, session, { ...entry, nextWakeDueAt: base - MIN });
    // It came up, then crashed 2 minutes later.
    lifecycle(session, { state: "closed", how: "crash", liveSince: base + 20_000, closedAt: base + 2 * MIN, lastSeen: base + 2 * MIN, wakeId: wake.wakeId, opener: "wake" });
    m.clock.now = base + 3 * MIN;
    runWakePhase(m.deps);
    assert.equal(state().failures[key].count, round + 1);
    m.clock.now += 20 * MIN;
  }
  assert.ok(state().failures[key].backoffSince, "backed off");
  assert.match(log(), new RegExp(`backoff ${session.id}`));

  // Still crashed and due: no wake while backed off.
  m.tmux.windows = [];
  writeIndex({ [session.id]: { ...entry, nextWakeDueAt: m.clock.now - MIN } });
  let result = runWakePhase(m.deps);
  assert.equal(result.decisions[0].reason, "backoff");

  // A manual open after the backoff, then a crash: wakes resume.
  m.clock.now += MIN;
  lifecycle(session, { state: "closed", how: "crash", liveSince: m.clock.now - 30_000, closedAt: m.clock.now - 10_000, lastSeen: m.clock.now - 10_000, opener: "manual" });
  result = runWakePhase(m.deps);
  assert.equal(result.spawned.length, 1);
  assert.equal(state().failures[key], undefined);
});

test("wake reset clears a backoff", () => {
  fresh();
  const session = makeSession();
  writeFileSync(wakeStatePath(), JSON.stringify({
    v: 1, wakes: {}, ledger: [], logged: {},
    failures: { [`${HOST}:${session.id}`]: { count: 2, lastAt: NOW, lastReason: "stuck", backoffSince: NOW } },
  }));
  assert.deepEqual(resetWake(session.id.slice(0, 12), HOST), [session.id]);
  assert.deepEqual(state().failures, {});
});

// ── bg-finished wakes ──

let jobCounter = 0;
/** A bg job registered as running whose wrapper has since written its exit file. */
function bgJob(session, { exitAt = NOW - 5 * MIN, fields = {}, finished = true } = {}) {
  jobCounter += 1;
  const id = jobCounter.toString(16).padStart(6, "0");
  const logPath = join(BG_LOGS, `${id}.log`);
  writeFileSync(logPath, "");
  if (finished) {
    writeFileSync(`${logPath}.exit`, "0\n", { mode: 0o600 });
    utimesSync(`${logPath}.exit`, exitAt / 1000, exitAt / 1000);
  }
  const job = {
    id, name: "SECRET-NAME", command: "echo SECRET-COMMAND", cwd: "/somewhere/job-cwd",
    logPath, pid: 4321, pidStart: "x", sessionId: session.id, startedAt: NOW - 60 * MIN,
    killedByUser: false, summary: "SECRET-SUMMARY", meta: { task: "SECRET-META" }, seenAt: NOW - 30 * MIN,
    ...fields,
  };
  const file = join(BG_STATE, `${session.id}.json`);
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).jobs : [];
  writeFileSync(file, JSON.stringify({ v: 1, sessionId: session.id, savedAt: NOW, jobs: [...existing, job] }), { mode: 0o600 });
  return job;
}

test("a bg job that finished after a crash wakes its session, resolved from the lifecycle record", () => {
  fresh();
  const session = makeSession();
  lifecycle(session, { closedAt: NOW - 30 * MIN });
  bgJob(session, { exitAt: NOW - 5 * MIN });
  const m = machine();
  const result = runWakePhase(m.deps);
  assert.equal(result.spawned.length, 1);
  assert.equal(result.spawned[0].reason, "bg");
  const [call] = m.newWindows();
  assert.equal(call[call.indexOf("-c") + 1], session.cwd, "the session's cwd, never the job's");
});

test("bg wakes skip: a user close, an exit before the close, reported, wake:false, still running", () => {
  const cases = [
    ["user close", { how: "user" }, {}],
    ["exit before close", {}, { exitAt: NOW - 40 * MIN }],
    ["exit older than 24h", { closedAt: NOW - 30 * 60 * MIN }, { exitAt: NOW - 25 * 60 * MIN }],
    ["reported", {}, { fields: { reported: true } }],
    ["ended", {}, { fields: { endedAt: NOW - MIN } }],
    ["wake:false", {}, { fields: { wake: false } }],
    ["running", {}, { finished: false }],
  ];
  for (const [label, record, job] of cases) {
    fresh();
    const session = makeSession();
    lifecycle(session, record);
    bgJob(session, job);
    const m = machine();
    runWakePhase(m.deps);
    assert.equal(m.newWindows().length, 0, label);
  }
});

test("bg wake is skipped when PI_BG_WAKE is off or nextTurn, or turned off in wake.json or by PI_SCHEDULER_WAKE_BG=0", () => {
  for (const [config, env] of [
    [{}, { PI_BG_WAKE: "off" }],
    [{}, { PI_BG_WAKE: "nextTurn" }],
    [{ bg: false }, {}],
    [{}, { PI_SCHEDULER_WAKE_BG: "0" }],
  ]) {
    fresh(config);
    const session = makeSession();
    lifecycle(session);
    bgJob(session);
    const m = machine({ env });
    runWakePhase(m.deps);
    assert.equal(m.newWindows().length, 0, JSON.stringify({ config, env }));
  }
  // Control: followUp (the default) wakes.
  fresh();
  const session = makeSession();
  lifecycle(session);
  bgJob(session);
  const m = machine({ env: { PI_BG_WAKE: "followUp" } });
  runWakePhase(m.deps);
  assert.equal(m.newWindows().length, 1);
});

// ── privacy and the log ──

test("nothing private reaches wake.log or wake-state.json", () => {
  fresh();
  const woken = makeSession();
  lifecycle(woken);
  bgJob(woken);
  const skipped = makeSession();
  lifecycle(skipped, { how: "user" });
  bgJob(skipped);
  const m = machine({ procs: {} });
  runWakePhase({ ...m.deps });
  m.clock.now += 5 * MIN;
  runWakePhase(m.deps);
  const written = log() + readFileSync(wakeStatePath(), "utf8");
  assert.match(log(), /wake /);
  assert.match(log(), /skip /);
  for (const secret of ["SECRET-NAME", "SECRET-COMMAND", "SECRET-SUMMARY", "SECRET-META", "job-cwd"]) {
    assert.ok(!written.includes(secret), secret);
  }
  assert.equal(statSync(wakeLogPath()).mode & 0o777, 0o600);
  assert.equal(statSync(wakeStatePath()).mode & 0o777, 0o600);
});

test("wake.log rotates at 1 MB, keeping one .1", () => {
  fresh();
  writeFileSync(wakeLogPath(), "x".repeat(1024 * 1024), { mode: 0o600 });
  appendWakeLog("skip", "abc", { reason: "user-closed" });
  assert.equal(statSync(`${wakeLogPath()}.1`).size, 1024 * 1024);
  assert.match(readFileSync(wakeLogPath(), "utf8"), /^\S+ skip abc reason=user-closed\n$/);
  assert.equal(statSync(wakeLogPath()).mode & 0o777, 0o600);
});

// ── switches and side effects ──

test("an idle tick writes nothing; a dry run changes nothing; wake off does nothing", () => {
  fresh();
  const m = machine();
  runWakePhase(m.deps);
  assert.deepEqual(readdirSync(schedulerDir).sort(), ["wake.json"], "idle: no state, no log, no lock left");
  assert.equal(m.calls.length, 0, "idle: no tmux call");

  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const dry = machine();
  const result = runWakePhase(dry.deps, { dryRun: true });
  assert.equal(result.spawned.length, 1, "would wake");
  assert.equal(existsSync(wakeStatePath()), false);
  assert.equal(existsSync(wakeLogPath()), false);
  assert.ok(dry.calls.every((c) => ["-V", "list-windows"].includes(c[1])), "only read-only tmux calls");

  writeFileSync(join(schedulerDir, "wake.json"), JSON.stringify({ tmux: TMUX, pi: PI, enabled: false }));
  const off = machine();
  assert.equal(runWakePhase(off.deps).idle, "off");
  assert.equal(off.calls.length, 0);
});

test("the pi-wake session is created when missing: through launchctl asuser + taskpolicy on macOS", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const m = machine({ serverRunning: false, sessions: [] });
  runWakePhase(m.deps);
  const asuser = m.calls.find((c) => c[0] === "/bin/launchctl");
  assert.deepEqual(asuser.slice(0, 3), ["/bin/launchctl", "asuser", String(ME)]);
  assert.ok(asuser.includes("/usr/sbin/taskpolicy"));
  assert.deepEqual(asuser.slice(asuser.indexOf(TMUX) + 1, asuser.indexOf(TMUX) + 5), ["new-session", "-d", "-s", "pi-wake"]);
  assert.ok(m.calls.some((c) => c[0] === "/usr/sbin/taskpolicy" && c[1] === "-B" && c[3] === "4242"), "moved out of the background band");
  assert.equal(m.newWindows().length, 1);
});

test("on Linux the server is started in its own systemd scope", (t) => {
  fresh();
  const bin = mkdtempSync(join(scratch, "bin-"));
  const systemdRun = join(bin, "systemd-run");
  writeFileSync(systemdRun, "#!/bin/sh\nexit 99\n");
  chmodSync(systemdRun, 0o755);
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const m = machine({ platform: "linux", serverRunning: false, sessions: [], env: { PATH: `${bin}:/usr/bin:/bin` } });
  runWakePhase(m.deps);
  const scope = m.calls.find((c) => c[0] === systemdRun);
  assert.ok(scope, "systemd-run was used");
  assert.deepEqual(scope.slice(1, 3), ["--user", "--scope"]);
  assert.equal(m.newWindows().length, 1);
  t.diagnostic("tmux server created via systemd-run --user --scope");
});

test("an existing server just gets the session; tmuxTarget attached uses the attached session", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const m = machine({ serverRunning: true, sessions: ["main"] });
  runWakePhase(m.deps);
  assert.ok(!m.calls.some((c) => c[0] === "/bin/launchctl"), "no asuser when the server is up");
  assert.ok(m.calls.some((c) => c[0] === TMUX && c[1] === "new-session"));

  fresh({ tmuxTarget: "attached" });
  lifecycle(session);
  writeIndex({ [session.id]: entry });
  const a = machine({ sessions: ["main", "work"], attached: ["work"] });
  runWakePhase(a.deps);
  const [call] = a.newWindows();
  assert.equal(call[call.indexOf("-t") + 1], "work:");
});

// ── wake-exec ──

function inFlight(session, fields = {}) {
  const wake = {
    wakeId: "0123456789abcdef", sessionId: session.id, host: HOST, sessionFile: session.file,
    cwd: session.cwd, reason: "timer", dueAt: NOW - MIN, at: NOW, ...fields,
  };
  writeFileSync(wakeStatePath(), JSON.stringify({ v: 1, wakes: { [wake.wakeId]: wake }, failures: {}, ledger: [], logged: {} }));
  return wake;
}

function execDeps(m, spawned) {
  return {
    ...m.deps,
    spawnPi: async (pi, args, options) => {
      spawned.push({ pi, args, options });
      return { code: 0, stderrTail: [] };
    },
  };
}

test("wake-exec refuses when the session is live, its file is missing or its cwd is missing", async () => {
  // live
  fresh();
  let session = makeSession();
  const record = lifecycle(session, { state: "live", how: undefined, closedAt: undefined });
  let wake = inFlight(session);
  let m = machine({ procs: { [record.pid]: record.pidStart } });
  let spawned = [];
  assert.notEqual(await wakeExec(wake.wakeId, execDeps(m, spawned)), 0);
  assert.equal(spawned.length, 0);
  assert.match(log(), /refuse \S+ reason=live/);
  assert.equal(state().wakes[wake.wakeId], undefined, "a refused wake leaves the in-flight list");

  for (const [reason, mutate] of [
    ["file-missing", (s) => rmSync(s.file)],
    ["cwd-missing", (s) => rmSync(s.cwd, { recursive: true })],
  ]) {
    fresh();
    session = makeSession();
    lifecycle(session);
    wake = inFlight(session);
    mutate(session);
    m = machine();
    spawned = [];
    assert.notEqual(await wakeExec(wake.wakeId, execDeps(m, spawned)), 0, reason);
    assert.equal(spawned.length, 0, reason);
    assert.match(log(), new RegExp(`refuse \\S+ reason=${reason}`));
  }
});

test("wake-exec starts pi with the absolute session file, never the id, and logs a failed exit", async () => {
  fresh();
  const session = makeSession();
  lifecycle(session);
  const wake = inFlight(session);
  const m = machine();
  const spawned = [];
  const deps = {
    ...m.deps,
    spawnPi: async (pi, args, options) => {
      spawned.push({ pi, args, options });
      return { code: 1, stderrTail: ["Error: boom", "    at somewhere"] };
    },
  };
  assert.equal(await wakeExec(wake.wakeId, deps), 1);
  assert.deepEqual(spawned[0].args, ["--session", session.file]);
  assert.equal(spawned[0].pi, PI);
  assert.equal(spawned[0].options.cwd, session.cwd);
  assert.equal(spawned[0].options.env.PI_WAKE_ID, wake.wakeId);
  assert.ok(state().wakes[wake.wakeId].execAt, "marked as exec'd");
  assert.match(log(), new RegExp(`exit ${session.id} code=1`));
  assert.match(log(), /stderr \S+ wakeId=\S+ line="Error: boom"/);
});

test("wake-exec with an unknown wake id does nothing", async () => {
  fresh();
  const spawned = [];
  assert.notEqual(await wakeExec("feedfacefeedface", execDeps(machine(), spawned)), 0);
  assert.equal(spawned.length, 0);
});

// ── review round: pruning, failures, lock timeouts, server creation ──

/** A wake-state.json with nothing in it but what is given: enough to make the tick take its lock. */
function seedState(fields = {}) {
  writeFileSync(wakeStatePath(), JSON.stringify({ v: 1, wakes: {}, failures: {}, ledger: [], logged: {}, ...fields }));
}

test("lifecycle pruning keeps records a pending timer needs, and drops long-dead live ones", () => {
  fresh();
  const DAY = 24 * 60 * MIN;
  const needed = makeSession();
  lifecycle(needed, { how: "user", closedAt: NOW - 8 * DAY, lastSeen: NOW - 8 * DAY });
  const old = makeSession();
  lifecycle(old, { how: "user", closedAt: NOW - 8 * DAY, lastSeen: NOW - 8 * DAY });
  const deadLive = makeSession();
  const deadRecord = lifecycle(deadLive, { state: "live", how: undefined, closedAt: undefined, lastSeen: NOW - 8 * DAY });
  const aliveLive = makeSession();
  const aliveRecord = lifecycle(aliveLive, { state: "live", how: undefined, closedAt: undefined, lastSeen: NOW - 8 * DAY });
  const recentLive = makeSession();
  lifecycle(recentLive, { state: "live", how: undefined, closedAt: undefined, lastSeen: NOW - DAY });
  // A 30-day always timer after a /quit: not due yet, but it will need the record.
  writeIndex({ [needed.id]: indexEntry(needed, { wake: "always", nextWakeDueAt: NOW + 22 * DAY, nextAlwaysDueAt: NOW + 22 * DAY }) });
  seedState();
  const m = machine({ procs: { [aliveRecord.pid]: aliveRecord.pidStart } });
  runWakePhase(m.deps);
  assert.ok(readLifecycle(needed.id), "kept: a pending always timer needs it");
  assert.equal(readLifecycle(old.id), undefined, "a closed record past 7 days goes");
  assert.equal(readLifecycle(deadLive.id), undefined, `a live record whose pid ${deadRecord.pid} is dead goes`);
  assert.ok(readLifecycle(aliveLive.id), "a live record whose pi is still running stays");
  assert.ok(readLifecycle(recentLive.id), "a live record seen recently stays");
});

test("a manual open after a failure (short of a backoff) resets the count", () => {
  fresh();
  const { session, entry } = crashedWithTimer({ liveSince: NOW - 5 * MIN, closedAt: NOW - 2 * MIN, lastSeen: NOW - 2 * MIN });
  writeIndex({ [session.id]: entry });
  seedState({ failures: { [`${HOST}:${session.id}`]: { count: 1, lastAt: NOW - 30 * MIN, lastReason: "no-start" } } });
  runWakePhase(machine().deps);
  assert.equal(state().failures[`${HOST}:${session.id}`], undefined);

  // Not opened since the failure: the count stays.
  fresh();
  const later = crashedWithTimer({ liveSince: NOW - 90 * MIN });
  writeIndex({ [later.session.id]: later.entry });
  seedState({ failures: { [`${HOST}:${later.session.id}`]: { count: 1, lastAt: NOW - 30 * MIN, lastReason: "no-start" } } });
  runWakePhase(machine().deps);
  assert.equal(state().failures[`${HOST}:${later.session.id}`].count, 1);
});

test("another host's in-flight wakes are pruned after 24 h", () => {
  fresh();
  const session = makeSession();
  const wake = (id, at) => ({ wakeId: id, sessionId: session.id, host: "elsewhere", sessionFile: session.file, cwd: session.cwd, reason: "timer", dueAt: at, at });
  seedState({ wakes: { aaaa: wake("aaaa", NOW - 25 * 60 * MIN), bbbb: wake("bbbb", NOW - 60 * MIN) } });
  runWakePhase(machine().deps);
  assert.deepEqual(Object.keys(state().wakes), ["bbbb"]);
});

test("wake-exec: a refusal is not a failure, except pi-missing", async () => {
  fresh();
  let session = makeSession();
  const record = lifecycle(session, { state: "live", how: undefined, closedAt: undefined });
  let wake = inFlight(session);
  await wakeExec(wake.wakeId, execDeps(machine({ procs: { [record.pid]: record.pidStart } }), []));
  assert.deepEqual(state().failures, {}, "live: the check working");

  fresh({ pi: join(scratch, "no-such-pi") });
  session = makeSession();
  lifecycle(session);
  wake = inFlight(session);
  const spawned = [];
  assert.notEqual(await wakeExec(wake.wakeId, execDeps(machine(), spawned)), 0);
  assert.equal(spawned.length, 0);
  assert.equal(state().failures[`${HOST}:${session.id}`].count, 1);
  assert.equal(state().failures[`${HOST}:${session.id}`].lastReason, "pi-missing");
});

test("wake-exec logs a lock timeout instead of crashing", async () => {
  fresh();
  const session = makeSession();
  lifecycle(session);
  const wake = inFlight(session);
  mkdirSync(`${wakeStatePath()}.lock`);
  try {
    const spawned = [];
    const code = await wakeExec(wake.wakeId, { ...execDeps(machine(), spawned), lockAttempts: 2 });
    assert.notEqual(code, 0);
    assert.equal(spawned.length, 0);
    assert.match(log(), /refuse - reason=lock-timeout wakeId=0123456789abcdef/);
  } finally {
    rmSync(`${wakeStatePath()}.lock`, { recursive: true, force: true });
  }
});

test("on Linux a failed systemd-run never falls back to a plain server", () => {
  fresh();
  const bin = mkdtempSync(join(scratch, "bin-"));
  const systemdRun = join(bin, "systemd-run");
  writeFileSync(systemdRun, "#!/bin/sh\nexit 99\n");
  chmodSync(systemdRun, 0o755);
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const m = machine({ platform: "linux", serverRunning: false, sessions: [], env: { PATH: `${bin}:/usr/bin:/bin` } });
  const run = m.deps.run;
  m.deps.run = (file, args) => (file === systemdRun ? { status: 1, stdout: "", stderr: "" } : run(file, args));
  runWakePhase(m.deps);
  assert.ok(!m.calls.some((c) => c[0] === TMUX && c[1] === "new-session"), "no plain new-session");
  assert.equal(m.newWindows().length, 0);
  assert.match(log(), /spawn-failed \S+ why=tmux-target/);
});

test("on macOS a failed launchctl asuser falls back to a plain server, still moved out of the background band", () => {
  fresh();
  const { session, entry } = crashedWithTimer();
  writeIndex({ [session.id]: entry });
  const m = machine({ serverRunning: false, sessions: [] });
  const run = m.deps.run;
  m.deps.run = (file, args) => {
    if (file === "/bin/launchctl") {
      m.calls.push([file, ...args]);
      return { status: 1, stdout: "", stderr: "" };
    }
    return run(file, args);
  };
  runWakePhase(m.deps);
  assert.ok(m.calls.some((c) => c[0] === TMUX && c[1] === "new-session"), "plain new-session");
  assert.ok(m.calls.some((c) => c[0] === "/usr/sbin/taskpolicy" && c[1] === "-B" && c[3] === "4242"));
  assert.equal(m.newWindows().length, 1);
});
