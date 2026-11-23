// The test environment first: every scheduler file goes to a temp dir. See helpers/env.mjs.
import { configPath, schedulerDir } from "./helpers/env.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sessionScheduler, { crashRecord } from "../extensions/session-scheduler.ts";
import { closeHow, decideCloseVerdict, lifecyclePath, readLifecycle, tmuxServerPid, writeClosedRecord, writeLifecycle } from "../extensions/lib/lifecycle.ts";
import { classifyClose } from "../extensions/lib/wake.ts";
import { processStart } from "../extensions/lib/process-identity.ts";

// Run from inside pi (a subagent, a bash tool call) these are set, and each
// would change what is under test.
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_WAKE_ID;
// And a test run inside tmux must not probe that server; the tests that want
// one set it.
delete process.env.TMUX;

const SLOT = Symbol.for("pi-boehsline.scheduler.lifecycle");
let counter = 0;

/** A fresh process-wide slot, as a new pi process would have. */
function newProcess() {
  // Keep the exit listener the earlier tests installed from writing anything:
  // it only acts on `current`, which is cleared here.
  const old = globalThis[SLOT];
  if (old) old.current = undefined;
  globalThis[SLOT] = { exitInstalled: true };
}

async function mount({ mode = "tui", sessionId = `sess-${process.pid}-${++counter}`, withFile = true, reason = "startup", afterStart } = {}) {
  writeFileSync(configPath, "{}");
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  const sessionFile = join(dir, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, "");
  const handlers = {};
  const pi = {
    events: { emit() {}, on() {} },
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand() {},
    registerTool() {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    appendEntry() {},
    sendUserMessage() {},
  };
  const ctx = {
    mode,
    hasUI: mode === "tui",
    cwd: dir,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
      ...(withFile ? { getSessionFile: () => sessionFile } : { getSessionFile: () => undefined }),
    },
    ui: { notify: (message, level) => notices.push({ message, level }), confirm: async () => true, setStatus() {} },
  };
  const notices = [];
  sessionScheduler(pi);
  await handlers.session_start({ reason }, ctx);
  afterStart?.(sessionId);
  // The live record is written on the tick after session_start (ps is a sync spawn).
  await new Promise((resolve) => setTimeout(resolve, 30));
  return {
    sessionId,
    sessionFile,
    handlers,
    ctx,
    notices,
    record: () => readLifecycle(sessionId),
    shutdown: (why = "quit") => handlers.session_shutdown({ reason: why }, ctx),
  };
}

test("session_start in the TUI writes a live record: pid, ps start, host, manual opener", async () => {
  newProcess();
  const ui = await mount();
  const record = ui.record();
  assert.equal(record.state, "live");
  assert.equal(record.pid, process.pid);
  assert.equal(record.pidStart, processStart(process.pid));
  assert.equal(record.host, hostname());
  assert.equal(record.sessionFile, ui.sessionFile);
  assert.equal(record.opener, "manual");
  assert.equal(record.wakeId, undefined);
  await ui.shutdown();
});

test("the how matrix: quit → user; new/resume/fork → switched; reload leaves it live", async () => {
  for (const [reason, how] of [["quit", "user"], ["new", "switched"], ["resume", "switched"], ["fork", "switched"]]) {
    newProcess();
    const ui = await mount();
    await ui.shutdown(reason);
    const record = ui.record();
    assert.equal(record.state, "closed", reason);
    assert.equal(record.how, how, reason);
    assert.ok(record.closedAt >= record.liveSince);
  }
  newProcess();
  const ui = await mount();
  await ui.shutdown("reload");
  assert.equal(ui.record().state, "live");
  assert.equal(ui.record().how, undefined);
});

test("closeHow: a signal seen before a quit names the signal", () => {
  assert.equal(closeHow("quit", "SIGHUP"), "signal:SIGHUP");
  assert.equal(closeHow("quit", "SIGTERM"), "signal:SIGTERM");
  assert.equal(closeHow("quit", undefined), "user");
  assert.equal(closeHow("new", "SIGHUP"), "switched");
  assert.equal(closeHow("reload", undefined), "reload");
});

/**
 * pi's own SIGHUP/SIGTERM listener (interactive-mode.ts) is prepended too,
 * and its shutdown awaits before it emits session_shutdown. Whichever order
 * the two listeners were added in, the flag must be set by the time the
 * shutdown handlers run.
 */
for (const order of ["pi's listener first", "pi's listener after ours"]) {
  test(`the signal flag is set before session_shutdown handlers run (${order})`, async () => {
    newProcess();
    let shutdownDone;
    const done = new Promise((resolve) => { shutdownDone = resolve; });
    let ui;
    const piListener = () => {
      void (async () => {
        // pi: runtimeHost.dispose() → teardownCurrent → session.abort(), then the event.
        await Promise.resolve();
        await ui.shutdown("quit");
        shutdownDone();
      })();
    };
    if (order === "pi's listener first") process.prependListener("SIGHUP", piListener);
    ui = await mount();
    if (order !== "pi's listener first") process.prependListener("SIGHUP", piListener);
    try {
      process.emit("SIGHUP", "SIGHUP");
      await done;
    } finally {
      process.off("SIGHUP", piListener);
    }
    assert.equal(ui.record().how, "signal:SIGHUP");
    assert.equal(process.listeners("SIGHUP").length, 0, "our listener is removed at shutdown");
  });
}

test("print mode, --no-session and subagent children never write a record", async () => {
  newProcess();
  const print = await mount({ mode: "print" });
  await print.shutdown();
  assert.equal(existsSync(lifecyclePath(print.sessionId)), false, "print");

  newProcess();
  const noSession = await mount({ withFile: false });
  await noSession.shutdown();
  assert.equal(existsSync(lifecyclePath(noSession.sessionId)), false, "--no-session");

  newProcess();
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const child = await mount();
    await child.shutdown();
    assert.equal(existsSync(lifecyclePath(child.sessionId)), false, "subagent child");
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
  }
});

test("PI_WAKE_ID marks the first session as woken, and is consumed: a later /new is manual", async () => {
  newProcess();
  process.env.PI_WAKE_ID = "abcdef0123456789";
  const woken = await mount();
  assert.equal(process.env.PI_WAKE_ID, undefined, "children of this pi must not inherit it");
  assert.equal(woken.record().opener, "wake");
  assert.equal(woken.record().wakeId, "abcdef0123456789");
  await woken.shutdown("new");

  const next = await mount({ reason: "new" });
  assert.equal(next.record().opener, "manual");
  assert.equal(next.record().wakeId, undefined);
  await next.shutdown();
});

test("a reload keeps the record's open time and opener", async () => {
  newProcess();
  process.env.PI_WAKE_ID = "00000000000000aa";
  const first = await mount({ sessionId: `reload-${process.pid}` });
  const before = first.record();
  await first.shutdown("reload");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = await mount({ sessionId: `reload-${process.pid}`, reason: "reload" });
  const after = again.record();
  assert.equal(after.state, "live");
  assert.equal(after.liveSince, before.liveSince);
  assert.equal(after.opener, "wake");
  assert.equal(after.wakeId, "00000000000000aa");
  await again.shutdown();
});

test("the live record is on disk as soon as session_start returns, without a pid start yet", async () => {
  newProcess();
  let atStart;
  const ui = await mount({ afterStart: (id) => { atStart = readLifecycle(id); } });
  assert.equal(atStart?.state, "live", "written synchronously");
  assert.equal(atStart.pid, process.pid);
  assert.equal(atStart.pidStart, undefined, "unknown start: the tick reads it as never wake");
  assert.equal(ui.record().pidStart, processStart(process.pid), "the timer fills it in");
  await ui.shutdown();
});

test("opening a session another live pi holds warns", async () => {
  newProcess();
  const sessionId = `rival-${process.pid}`;
  // The parent of this test process: alive, on this host, with a known start.
  const rival = process.ppid;
  writeFileSync(lifecyclePath(sessionId), JSON.stringify({
    v: 1, sessionFile: "/x.jsonl", cwd: "/", host: hostname(), pid: rival, pidStart: processStart(rival),
    liveSince: Date.now() - 1000, lastSeen: Date.now() - 1000, state: "live", opener: "manual",
  }));
  const ui = await mount({ sessionId });
  assert.ok(ui.notices.some((n) => n.level === "warning" && n.message.includes(`pid ${rival}`)), JSON.stringify(ui.notices));
  await ui.shutdown();

  newProcess();
  const quiet = await mount();
  assert.equal(quiet.notices.filter((n) => n.level === "warning").length, 0, "no rival, no warning");
  await quiet.shutdown();
});

test("a reload keeps the slot, so an exit before the next session_start is a crash, not a vanish", async () => {
  newProcess();
  const ui = await mount();
  await ui.shutdown("reload");
  const slot = globalThis[SLOT];
  assert.equal(slot.current?.sessionId, ui.sessionId, "still held across the reload");
  assert.equal(ui.record().state, "live");
  slot.current = undefined;
});

test("a crash (exit with no shutdown) is recorded from the exit listener, also after a reload that never came back", () => {
  const script = `
    const { default: sessionScheduler } = await import(${JSON.stringify(new URL("../extensions/session-scheduler.ts", import.meta.url).href)});
    const handlers = {};
    sessionScheduler({
      events: { emit() {}, on() {} }, on: (n, h) => { handlers[n] = h; },
      registerCommand() {}, registerTool() {}, getActiveTools: () => [], getAllTools: () => [],
      setActiveTools() {}, appendEntry() {}, sendUserMessage() {},
    });
    const ctx = { mode: "tui", hasUI: true, cwd: process.cwd(), isIdle: () => true,
      sessionManager: { getSessionId: () => process.env.SID, getBranch: () => [], getSessionFile: () => process.env.SFILE },
      ui: { notify() {}, confirm: async () => true, setStatus() {} } };
    await handlers.session_start({ reason: "startup" }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    if (process.env.RELOAD_FIRST) await handlers.session_shutdown({ reason: "reload" }, ctx);
    process.exit(1);
  `;
  for (const reloadFirst of ["", "1"]) {
    const sid = `crash-${process.pid}${reloadFirst ? "-reload" : ""}`;
    const sfile = join(mkdtempSync(join(tmpdir(), "lifecycle-crash-")), "s.jsonl");
    writeFileSync(sfile, "");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, SID: sid, SFILE: sfile, PI_SCHEDULER_DIR: schedulerDir, BOEHSLINE_CONFIG: configPath, RELOAD_FIRST: reloadFirst },
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeout: 20_000,
    });
    assert.equal(run.status, 1, run.stderr);
    const record = JSON.parse(readFileSync(lifecyclePath(sid), "utf8"));
    assert.equal(record.state, "closed", reloadFirst ? "after a failed reload" : "plain crash");
    assert.equal(record.how, "crash");
  }
});

test("crashRecord keeps a seen signal, and tmuxServerPid reads $TMUX", () => {
  const live = { v: 1, sessionFile: "/s", cwd: "/", host: "h", pid: 1, liveSince: 0, lastSeen: 0, state: "live", opener: "manual" };
  assert.equal(crashRecord(live, undefined, 5).how, "crash");
  assert.equal(crashRecord(live, "SIGTERM", 5).how, "signal:SIGTERM");
  assert.equal(crashRecord(live, undefined, 5).closedAt, 5);
  assert.equal(tmuxServerPid("/private/tmp/tmux-501/default,12345,0"), 12345);
  assert.equal(tmuxServerPid(undefined), undefined);
  assert.equal(tmuxServerPid("garbage"), undefined);
});

test("decideCloseVerdict: a server that outlives the wait is user; one gone or replaced is tmux-gone", () => {
  const server = { pid: 777, start: "Sat Nov 21 08:00:00 2026" };
  const run = (states, probeMs = 0) => {
    let calls = 0;
    let slept = 0;
    let clock = 42;
    const verdict = decideCloseVerdict(server, {
      probe: () => { clock += probeMs; return states[Math.min(calls++, states.length - 1)]; },
      sleep: (ms) => { slept += ms; clock += ms; },
      waitMs: 300,
      stepMs: 100,
      now: () => clock,
    });
    return { verdict, calls, slept, clock };
  };
  const alive = { state: "alive", start: server.start, args: "tmux" };
  const stillUp = run([alive]);
  assert.deepEqual(stillUp.verdict, { closeVerdict: "user", decidedAt: 342 });
  assert.equal(stillUp.slept, 300, "watched for the whole wait before calling it alive");

  const dies = run([alive, alive, { state: "dead" }]);
  assert.deepEqual(dies.verdict, { closeVerdict: "tmux-gone", decidedAt: 242 }, "the last window closing takes the server with it");
  assert.equal(dies.slept, 200, "and says so as soon as it sees it");

  assert.equal(run([{ state: "alive", start: "Sun Nov 22 11:00:00 2026", args: "tmux" }]).verdict.closeVerdict, "tmux-gone", "a reused pid");
  assert.equal(run([{ state: "unknown" }]).verdict, undefined, "ps could not tell");
  assert.equal(decideCloseVerdict(undefined), undefined, "not in tmux");
});

test("decideCloseVerdict stops at a wall-clock deadline, ps time included", () => {
  const server = { pid: 777, start: "Sat Nov 21 08:00:00 2026" };
  const watch = (state, probeMs) => {
    let clock = 0;
    let calls = 0;
    let slept = 0;
    const verdict = decideCloseVerdict(server, {
      probe: () => { calls += 1; clock += probeMs; return state; },
      sleep: (ms) => { slept += ms; clock += ms; },
      waitMs: 300,
      stepMs: 100,
      now: () => clock,
    });
    return { verdict, calls, slept, clock };
  };
  // Each ps hangs for its 1 s timeout: one call, no sleep, not four calls and 4.3 s.
  const slowUnknown = watch({ state: "unknown" }, 1000);
  assert.equal(slowUnknown.verdict, undefined);
  assert.equal(slowUnknown.calls, 1);
  assert.equal(slowUnknown.slept, 0);
  assert.equal(slowUnknown.clock, 1000);

  // 80 ms per ps: the last sleep shrinks to fit, and the watch ends by ~400 ms.
  const slowAlive = watch({ state: "alive", start: server.start, args: "tmux" }, 80);
  assert.equal(slowAlive.verdict.closeVerdict, "user");
  assert.equal(slowAlive.calls, 3);
  assert.equal(slowAlive.slept, 140, "100, then the 40 left");
  assert.equal(slowAlive.clock, 380);
});

test("a close is on disk before the probe: killed mid-probe, it reads as a user close, not a crash", () => {
  const sessionId = `midprobe-${process.pid}`;
  const live = { v: 1, sessionFile: "/s", cwd: "/", host: hostname(), pid: 1, liveSince: 0, lastSeen: 0, state: "live", opener: "manual",
    tmux: { pid: 777, start: "x" } };
  writeLifecycle(sessionId, live);
  for (const signal of ["SIGHUP", "SIGTERM"]) {
    let onDisk;
    const died = new Error("SIGKILL");
    assert.throws(() => writeClosedRecord(sessionId, crashRecord(live, signal, 1_000), {
      decide: () => {
        onDisk = readLifecycle(sessionId);
        throw died; // the process is gone from here on: nothing else gets written
      },
    }), died);
    assert.equal(onDisk.state, "closed", signal);
    assert.equal(onDisk.how, `signal:${signal}`);
    assert.equal(onDisk.closeVerdict, undefined);
    assert.deepEqual(readLifecycle(sessionId), onDisk, "what the tick finds");
    assert.deepEqual(classifyClose(onDisk, { bootTime: () => 0 }), { crash: false, why: "signal" }, "a user close, not vanished");
  }

  // Not killed: the verdict lands in a second write.
  const writes = [];
  const decided = writeClosedRecord(sessionId, crashRecord(live, "SIGHUP", 1_000), {
    write: (_id, record) => writes.push(record),
    decide: () => ({ closeVerdict: "user", decidedAt: 1_300 }),
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].closeVerdict, undefined);
  assert.equal(writes[1].closeVerdict, "user");
  assert.deepEqual(decided, writes[1]);

  // A crash or a quit has nothing to decide: one write, no probe.
  const once = [];
  writeClosedRecord(sessionId, crashRecord(live, undefined, 1_000), {
    write: (_id, record) => once.push(record),
    decide: () => assert.fail("no probe for a crash"),
  });
  assert.equal(once.length, 1);
});

test("a SIGHUP close records, once, whether the tmux server outlived it; a plain quit records nothing", async () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  for (const [serverPid, expected] of [[process.pid, "user"], [dead, "tmux-gone"]]) {
    newProcess();
    // This process stands in for a tmux server that stays; an exited child for one that went.
    process.env.TMUX = `/tmp/tmux-test/default,${process.pid},0`;
    let ui;
    try {
      ui = await mount();
      assert.equal(ui.record().tmux?.pid, process.pid);
    } finally {
      delete process.env.TMUX;
    }
    if (serverPid !== process.pid) {
      // Swap in the dead server, as if tmux exited with this window.
      const slot = globalThis[SLOT];
      slot.current.record = { ...slot.current.record, tmux: { pid: serverPid, start: "Sat Nov 21 08:00:00 2026" } };
    }
    process.emit("SIGHUP", "SIGHUP");
    await ui.shutdown("quit");
    const record = ui.record();
    assert.equal(record.how, "signal:SIGHUP");
    assert.equal(record.closeVerdict, expected);
    assert.equal(typeof record.decidedAt, "number");
  }

  newProcess();
  const quit = await mount();
  await quit.shutdown("quit");
  assert.equal(quit.record().how, "user");
  assert.equal(quit.record().closeVerdict, undefined);
});

test("the exit listener's record carries no verdict until the probe has run", () => {
  const live = { v: 1, sessionFile: "/s", cwd: "/", host: "h", pid: 1, liveSince: 0, lastSeen: 0, state: "live", opener: "manual",
    tmux: { pid: 777, start: "x" } };
  const writes = [];
  const decide = () => ({ closeVerdict: "tmux-gone", decidedAt: 5 });
  writeClosedRecord("s", crashRecord(live, "SIGHUP", 5), { write: (_id, r) => writes.push(r), decide });
  assert.deepEqual(writes.map((r) => r.closeVerdict), [undefined, "tmux-gone"]);
  assert.equal(crashRecord(live, "SIGHUP", 5).closeVerdict, undefined);
});
