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
import { closeHow, lifecyclePath, readLifecycle, tmuxServerPid } from "../extensions/lib/lifecycle.ts";
import { processStart } from "../extensions/lib/process-identity.ts";

// Run from inside pi (a subagent, a bash tool call) these are set, and each
// would change what is under test.
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_WAKE_ID;

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
