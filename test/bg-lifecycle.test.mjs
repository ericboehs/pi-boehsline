import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";

// Real log files, but controlled child exits and a fake clock: no sleeping,
// background processes, or model calls. bg.test.mjs covers real shell execution.
const dir = mkdtempSync(path.join(tmpdir(), "pi-bg-lifecycle-"));
process.env.PI_BG_DIR = path.join(dir, "logs");
process.env.PI_BG_STATE_DIR = path.join(dir, "state");
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_BG_FG_TIMEOUT = "1";
process.env.PI_BG_TAIL_LINES = "15";
after(() => rmSync(dir, { recursive: true, force: true }));

const STATE = process.env.PI_BG_STATE_DIR;
const HOUR = 60 * 60 * 1000;
/** ps lstart of every fake job's wrapper. */
const PS_START = "Fri Nov  6 19:00:00 2026";
/** The fake process table ps and kill(pid, 0) answer from: pid -> { start, args }. */
const procs = new Map();
let nextPid = 40_000;
let sessions = 0;
/** A session id of this test's own, so registries never cross tests. */
const sid = (label) => `${label}-${process.pid}-${++sessions}`;

/** Pids ps fails for (times out, say) while kill(pid, 0) still finds them. */
const psDown = new Set();

function psOut(args) {
  const pid = Number(args[args.indexOf("-p") + 1]);
  const found = !psDown.has(pid) && procs.get(pid);
  return found && `${found.start}     ${found.args}\n`;
}

/** process.kill: signal 0 answers from `procs`; real signals are only recorded. */
function mockKill(t) {
  const killed = [];
  t.mock.method(process, "kill", (pid, signal) => {
    if (signal === 0) {
      if (procs.has(pid)) return true;
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    killed.push([pid, signal]);
    return true;
  });
  return killed;
}

/** What the wrapper leaves when a job ends. */
function writeExit(logPath, code) {
  writeFileSync(`${logPath}.exit`, `${code}\n`, { mode: 0o600 });
}

function writeRegistry(sessionId, jobs, mode = 0o600) {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const file = path.join(STATE, `${sessionId}.json`);
  writeFileSync(file, JSON.stringify({ v: 1, sessionId, savedAt: Date.now(), jobs }), { mode });
  chmodSync(file, mode);
  return file;
}

/** A registry entry for a fake live wrapper (its pid is in `procs`). */
function liveEntry(overrides = {}) {
  const id = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  const logPath = path.join(process.env.PI_BG_DIR, `${id}.log`);
  const pid = nextPid++;
  procs.set(pid, { start: PS_START, args: `/bin/sh -c wrapper ${logPath}.exit /bin/bash -c npm test` });
  mkdirSync(process.env.PI_BG_DIR, { recursive: true });
  writeFileSync(logPath, "");
  return { id, name: "test", command: "npm test", cwd: dir, logPath, pid, pidStart: PS_START, startedAt: Date.now() - 60_000, killedByUser: false, seenAt: Date.now(), ...overrides };
}

/** A new pi process: nothing of the previous one's globalThis survives, nor are its children ours. */
function newProcess() {
  delete globalThis[Symbol.for("pi-boehsline.bg.handoff")];
  delete globalThis[Symbol.for("pi-boehsline.bg.live")];
  delete globalThis[Symbol.for("pi-boehsline.bg.children")];
}

/** Let async fs and ps callbacks (the delayed registry prune) run, until `done()` or a bound. */
async function until(done) {
  for (let i = 0; i < 200 && !done(); i++) await settle();
}

async function mount(t, { mode = "tui", wake = "followUp", session } = {}) {
  // Each wake policy is read at module load; query imports isolate the constants.
  process.env.PI_BG_WAKE = wake;
  const { default: backgroundTasks } = await import(`../extensions/bg/index.ts?wake=${wake}`);
  // A real epoch, so registry ages compare with real file mtimes.
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });

  const children = [];
  const spawn = t.mock.method(childProcess, "spawn", (_shell, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.unref = t.mock.fn();
    const id = options.env.PI_BG_JOB_ID;
    const task = {
      child,
      id,
      args,
      logPath: path.join(process.env.PI_BG_DIR, `${id}.log`),
      ended: false,
      exit(code = 0, signal = null) {
        task.ended = true;
        procs.delete(child.pid);
        child.emit("exit", code, signal);
      },
    };
    procs.set(child.pid, { start: PS_START, args: `/bin/sh ${args.join(" ")}` });
    children.push(task);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  // hold(): async ps answers wait until release(), as a slow ps would.
  const held = [];
  const ps = {
    calls: 0,
    holding: false,
    hold: () => (ps.holding = true),
    release: () => {
      ps.holding = false;
      for (const answer of held.splice(0)) answer();
    },
  };
  t.mock.method(childProcess, "execFile", (_file, args, _options, callback) => {
    ps.calls++;
    const out = psOut(args);
    const answer = () => (out ? callback(null, out, "") : callback(Object.assign(new Error("ps: exit 1"), { code: 1 }), "", ""));
    if (ps.holding) held.push(answer);
    else queueMicrotask(answer);
    return new EventEmitter();
  });
  t.mock.method(childProcess, "execFileSync", (_file, args) => {
    ps.calls++;
    const out = psOut(args);
    if (!out) throw new Error("ps: exit 1");
    return out;
  });
  // bg.ts uses the named ESM import, so update that live binding too.
  syncBuiltinESMExports();

  const h = instance(backgroundTasks, { mode, session });
  t.after(async () => {
    try {
      for (const task of children) if (!task.ended) task.exit();
      await h.shutdown();
    } finally {
      spawn.mock.restore();
      childProcess.execFile.mock.restore();
      childProcess.execFileSync.mock.restore();
      syncBuiltinESMExports();
    }
  });
  await h.start();
  return { ...h, children, ps, backgroundTasks };
}

/** One bg instance on a fake pi, as pi builds one per runtime (start, /reload, /resume, /new). */
function instance(backgroundTasks, { mode = "tui", session } = {}) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const notices = [];
  const widgets = [];
  const statuses = [];
  const jobEvents = [];
  const theme = { fg: (_color, text) => text };
  let component;
  let panel;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: dir,
    ...(session
      ? { sessionManager: { getSessionId: () => session, getSessionFile: () => path.join(dir, `${session}.jsonl`) } }
      : {}),
    ui: {
      theme,
      setWidget(key, content, options) {
        widgets.push({ key, content, options });
        component = content?.({ requestRender() {} }, theme);
      },
      setStatus: (...args) => statuses.push(args),
      notify: (message, level) => notices.push({ message, level }),
      custom: (factory) => new Promise((resolve) => {
        panel = factory({ requestRender() {} }, theme, {}, resolve);
      }),
    },
  };
  const bus = new Map();
  // After /reload pi invalidates the old instance: every pi call throws.
  let stale = false;
  const assertActive = () => {
    if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
  };
  backgroundTasks({
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: (name, definition) => commands.set(name, definition),
    registerShortcut() {},
    on: (name, handler) => handlers.set(name, handler),
    sendMessage: (message, options) => (assertActive(), sent.push({ message, options })),
    events: {
      on: (channel, handler) => (bus.set(channel, handler), () => bus.delete(channel)),
      emit: (channel, data) => {
        assertActive();
        if (channel === "bg:jobs") jobEvents.push(data);
        return bus.get(channel)?.(data);
      },
    },
  });

  let stopped = false;
  const bash = tools.get("bash");
  return {
    bash, sent, notices, widgets, statuses, theme, jobEvents, ctx,
    start: (reason) => handlers.get("session_start")(reason ? { reason } : {}, ctx),
    shutdown: async (reason) => {
      if (stopped) return;
      stopped = true;
      await handlers.get("session_shutdown")(reason ? { reason } : {}, ctx);
    },
    goStale: () => { stale = true; },
    emit: (channel, data) => bus.get(channel)?.(data),
    /** bg:list's reply, as lib/children.ts and canvas read it. */
    list: () => {
      let jobs;
      bus.get("bg:list")?.({ reply: (value) => (jobs = value) });
      return jobs;
    },
    run: (params) => bash.execute("test-job", params, undefined, undefined, ctx),
    render: (width = 160) => component?.render(width) ?? [],
    component: () => component,
    openPanel: () => commands.get("bg").handler("", ctx),
    panel: () => panel,
  };
}

/** The next instance of the same module (a /reload, /resume, /new or a restarted pi), started. */
async function boot(t, backgroundTasks, { reason, ...options } = {}) {
  const next = instance(backgroundTasks, options);
  t.after(() => next.shutdown());
  await next.start(reason);
  return next;
}

test("bash no longer advertises a tickler parameter", async (t) => {
  const h = await mount(t);
  assert.equal(Object.hasOwn(h.bash.parameters.properties, "tickler"), false);
  assert.match(h.bash.parameters.properties.background.description, /notifies on completion/);
  assert.deepEqual(h.render(), []);
});

test("above-prompt elapsed times refresh without model wakes; completion still wakes once", async (t) => {
  const h = await mount(t);
  // A legacy call's extra field must not revive periodic model notifications.
  await h.run({ command: "bundle exec rspec", background: true, tickler: 5 });
  const task = h.children[0];
  assert.equal(h.widgets.at(-1).key, "bg");
  assert.deepEqual(h.widgets.at(-1).options, { placement: "aboveEditor" });
  assert.deepEqual(h.render(), ["● 1 background job · rspec 0s · /bg"]);

  t.mock.timers.tick(60_000);
  assert.deepEqual(h.render(), ["● 1 background job · rspec 1m00s · /bg"]);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.statuses, [], "background jobs no longer occupy the footer");

  writeFileSync(task.logPath, "example passed\nall green\n");
  task.exit();
  assert.deepEqual(h.render(), []);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "bg");
  assert.equal(h.sent[0].message.display, true);
  assert.deepEqual(h.sent[0].message.details, { id: task.id });
  assert.match(h.sent[0].message.content, /succeeded after 1m00s/);
  assert.match(h.sent[0].message.content, /last 2 lines:\nexample passed\nall green/);
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });

  const updates = h.widgets.length;
  t.mock.timers.tick(60_000);
  assert.equal(h.widgets.length, updates, "the UI timer stops when no jobs remain");
  assert.equal(h.sent.length, 1);
});

test("widget bounds width and uses live theme colors", async (t) => {
  const h = await mount(t);
  await h.run({ command: "npm run build", background: true });
  const component = h.component();
  h.theme.fg = (_color, text) => `\x1b[36m${text}\x1b[0m`;
  component.invalidate();
  assert.match(component.render(120)[0], /\x1b\[36m/);
  for (const width of [1, 10, 30, 80]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width);
  }
});

test("widget distinguishes duplicate labels and summarizes overflow", async (t) => {
  const h = await mount(t);
  for (let i = 0; i < 4; i++) await h.run({ command: `node task-${i}.js`, background: true });
  const ids = h.children.map((task) => task.id);
  assert.deepEqual(h.render(), [
    `● 4 background jobs · ${ids[0]} 0s · ${ids[1]} 0s · ${ids[2]} 0s · +1 · /bg`,
  ]);
  h.children[1].exit();
  assert.deepEqual(h.render(), [
    `● 3 background jobs · ${ids[0]} 0s · ${ids[2]} 0s · ${ids[3]} 0s · /bg`,
  ]);
});

test("foreground jobs stay hidden until adopted, then notify on completion", async (t) => {
  const h = await mount(t);
  const pending = h.run({ command: "npm test" });
  await settle(); // Let start() install the foreground-budget timer.
  assert.deepEqual(h.render(), []);
  assert.deepEqual(h.sent, []);

  t.mock.timers.tick(1000);
  const result = await pending;
  assert.match(result.content[0].text, /moved to background/);
  assert.deepEqual(h.render(), ["● 1 background job · test 1s · /bg"]);
  assert.deepEqual(h.sent, []);
  h.children[0].exit();
  assert.deepEqual(h.render(), []);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("foreground completion remains quiet and never displays a running-job widget", async (t) => {
  const h = await mount(t);
  const pending = h.run({ command: "printf done" });
  await settle();
  writeFileSync(h.children[0].logPath, "done");
  h.children[0].exit();
  assert.equal((await pending).content[0].text, "done");
  assert.deepEqual(h.sent, []);
  assert.ok(h.widgets.every(({ content }) => content === undefined));
});

test("bg:start runs another extension's job with its own label, header, and tail", async (t) => {
  const h = await mount(t);
  const req = {
    command: "PI_SUBAGENT_CHILD=1 pi --mode json -p 'Task: x' | node -e 'filter'",
    name: "sa:scout",
    summary: "subagent scout: count the files",
    tailLines: 100,
    tailMaxChars: 10_000,
  };
  const reply = new Promise((resolve) => (req.reply = resolve));
  h.emit("bg:start", req);
  assert.equal(req.accepted, true, "accepted synchronously so senders can detect bg.ts");
  const { id, logPath } = await reply;
  assert.match(id, /^[0-9a-f]{6}$/);
  assert.equal(logPath, h.children[0].logPath);
  assert.match(h.render().join("\n"), /sa:scout/);

  // 40 lines: past the default 15-line tail, inside this job's 100.
  writeFileSync(logPath, `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}\n`);
  h.children[0].exit();
  assert.equal(h.sent.length, 1);
  const wake = h.sent[0].message.content;
  assert.match(wake, /`subagent scout: count the files` succeeded/);
  assert.doesNotMatch(wake, /PI_SUBAGENT_CHILD/, "summary replaces the raw command");
  assert.match(wake, /last 40 lines:\nline 0\n/);
});

test("bg:kill stops one job by id; wake: true still tells the model it was killed", async (t) => {
  const h = await mount(t);
  const killed = [];
  t.mock.method(process, "kill", (pid, signal) => (killed.push([pid, signal]), true));
  const start = async () => {
    const req = { command: "pi child | node -e filter", name: "sa:scout", summary: "subagent scout: x" };
    const reply = new Promise((resolve) => (req.reply = resolve));
    h.emit("bg:start", req);
    return { ...(await reply), task: h.children.at(-1) };
  };
  const quiet = await start();
  const req = { id: quiet.id, reply: (r) => (req.got = r) };
  h.emit("bg:kill", req);
  assert.equal(req.accepted, true);
  assert.deepEqual(req.got, { killed: true });
  assert.deepEqual(killed, [[-quiet.task.child.pid, "SIGTERM"]], "its own process group only");
  quiet.task.exit(null, "SIGTERM");
  assert.equal(h.sent.length, 0, "a kill without wake stays quiet, as /bg's x does");

  const woken = await start();
  const wake = { id: woken.id, wake: true, reply: () => {} };
  h.emit("bg:kill", wake);
  woken.task.exit(null, "SIGTERM");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /`subagent scout: x` killed \(SIGTERM\)/);

  const unknown = { id: "nope00", reply: () => assert.fail("not this instance's job") };
  h.emit("bg:kill", unknown);
  assert.equal(unknown.accepted, undefined);
  const ended = { id: woken.id, reply: (r) => (ended.got = r) };
  h.emit("bg:kill", ended);
  assert.deepEqual(ended.got, { killed: false }, "an ended job isn't killed again");
});

test("bg:start ignores requests another listener already accepted", async (t) => {
  const h = await mount(t);
  h.emit("bg:start", { command: "true", accepted: true, reply: () => assert.fail("must not start") });
  assert.equal(h.children.length, 0);
});

test("failed jobs retain exit-code and log-tail completion notifications", async (t) => {
  const h = await mount(t);
  await h.run({ command: "npm test", background: true });
  writeFileSync(h.children[0].logPath, "assertion failed\n");
  h.children[0].exit(23);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /exited 23/);
  assert.match(h.sent[0].message.content, /assertion failed/);
  assert.deepEqual(h.render(), []);
});

test("nextTurn completion delivery remains deferred", async (t) => {
  const h = await mount(t, { wake: "nextTurn" });
  await h.run({ command: "npm test", background: true });
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.sent, []);
  h.children[0].exit();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { deliverAs: "nextTurn" });
});

test("PI_BG_WAKE=off still shows the widget but only notifies the UI on completion", async (t) => {
  const h = await mount(t, { wake: "off" });
  await h.run({ command: "npm test", background: true });
  assert.equal(h.render().length, 1);
  h.children[0].exit();
  assert.deepEqual(h.sent, []);
  assert.match(h.notices[0].message, /succeeded/);
  assert.deepEqual(h.render(), []);
});

for (const mode of ["rpc", "print", "json"]) {
  test(`${mode} mode skips the TUI widget but preserves completion delivery`, async (t) => {
    const h = await mount(t, { mode });
    await h.run({ command: "npm test", background: true });
    t.mock.timers.tick(60_000);
    assert.deepEqual(h.widgets, []);
    assert.deepEqual(h.statuses, []);
    assert.deepEqual(h.sent, []);
    h.children[0].exit();
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  });
}

test("stopping a job through /bg still suppresses the model wake", async (t) => {
  const h = await mount(t);
  await h.run({ command: "npm test", background: true });
  const task = h.children[0];
  const kill = t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, -task.child.pid);
    assert.equal(signal, "SIGTERM");
    task.exit(null, signal);
    return true;
  });
  const opened = h.openPanel();
  h.panel().handleInput("x");
  h.panel().handleInput("\x1b");
  await opened;
  t.mock.timers.tick(5000);
  assert.equal(kill.mock.callCount(), 1);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.render(), []);
  assert.match(h.notices[0].message, /killed \(SIGTERM\)/);
});

test("shutdown clears the widget and stops UI updates without killing detached jobs", async (t) => {
  const h = await mount(t);
  await h.run({ command: "npm test", background: true });
  await h.shutdown();
  assert.deepEqual(h.render(), []);
  const updates = h.widgets.length;
  t.mock.timers.tick(60_000);
  assert.equal(h.widgets.length, updates);
  assert.equal(h.children[0].ended, false);
  assert.match(h.notices[0].message, /bg job\(s\) still running/);
});

/** A second bg instance on the same module, as /reload builds one: fresh pi, same process. */
async function reloaded(backgroundTasks) {
  const handlers = new Map();
  const sent = [];
  const ctx = { mode: "print", hasUI: false, cwd: dir, ui: { notify() {}, setWidget() {} } };
  backgroundTasks({
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    on: (name, handler) => handlers.set(name, handler),
    sendMessage: (message, options) => sent.push({ message, options }),
    events: { on: () => () => {}, emit() {} },
  });
  await handlers.get("session_start")({}, ctx);
  return { sent, shutdown: () => handlers.get("session_shutdown")({}, ctx) };
}

for (const shutdownFirst of [false, true]) {
  test(`a job started before /reload wakes the reloaded session instead of crashing pi (${shutdownFirst ? "after shutdown" : "no shutdown"})`, async (t) => {
    const h = await mount(t);
    await h.run({ command: "npm run build", background: true });
    const task = h.children[0];
    // Old instance goes stale; the reload builds a new one that owns the session.
    if (shutdownFirst) await h.shutdown();
    h.goStale();
    const next = await reloaded(h.backgroundTasks);
    t.after(() => next.shutdown());

    writeFileSync(task.logPath, "built\n");
    assert.doesNotThrow(() => task.exit(0), "a stale pi must not throw out of the child exit listener");
    assert.deepEqual(h.sent, []);
    assert.equal(next.sent.length, 1, "the reloaded session receives the completion wake");
    assert.match(next.sent[0].message.content, new RegExp(`\\[bg ${task.id}\\] .*succeeded`));
    assert.match(next.sent[0].message.content, /built/);
    assert.deepEqual(next.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  });
}

test("a stale instance with no live session logs the completion instead of throwing", async (t) => {
  const h = await mount(t);
  await h.run({ command: "sleep 100", background: true });
  const task = h.children[0];
  // Stale with no shutdown (so no hand-off) and no instance after it.
  h.goStale();
  assert.doesNotThrow(() => task.exit(0));
  assert.match(readFileSync(task.logPath, "utf8"), /completion not delivered: no live pi session/);
});

// ---- surviving /reload (hand-off) and restarts (registry) ---------------------

test("/reload hands the whole job table to the next instance: ids, widget, /bg, bg:list, bg:jobs and the later wake", async (t) => {
  const session = sid("reload");
  const h = await mount(t, { session });
  await h.run({ command: "npm run build", background: true });
  await h.run({ command: "node lint.js", background: true });
  const [build, lint] = h.children;
  writeFileSync(lint.logPath, "lint ok\n");
  lint.exit(0);
  assert.equal(h.sent.length, 1);
  t.mock.timers.tick(30_000);

  await h.shutdown("reload");
  h.goStale();
  const next = await boot(t, h.backgroundTasks, { session, reason: "reload" });
  assert.deepEqual(next.render(), ["● 1 background job · build 30s · /bg"]);
  const listed = next.list();
  assert.deepEqual(listed.map((job) => job.id).sort(), [build.id, lint.id].sort());
  assert.equal(listed.find((job) => job.id === lint.id).exitCode, 0);
  assert.equal(typeof listed.find((job) => job.id === lint.id).endedAt, "number");
  assert.equal(listed.find((job) => job.id === build.id).endedAt, undefined);
  assert.deepEqual(next.jobEvents.at(-1), listed, "bg:jobs carries the same table from session_start on");

  const opened = next.openPanel();
  const rows = next.panel().render(160).join("\n");
  assert.match(rows, /npm run build \(running 30s\)/);
  assert.match(rows, /node lint\.js \(done 0s\)/);
  next.panel().handleInput("\x1b");
  await opened;

  writeFileSync(build.logPath, "built\n");
  build.exit(0);
  assert.equal(h.sent.length, 1, "the old instance sends nothing more");
  assert.equal(next.sent.length, 1);
  assert.match(next.sent[0].message.content, new RegExp(`^\\[bg ${build.id}\\] \`npm run build\` succeeded after 30s\\n`));
  assert.match(next.sent[0].message.content, /built/);
  assert.deepEqual(next.render(), []);
  t.mock.timers.tick(0);
  assert.equal(next.sent.length, 1, "nothing reported twice");
});

test("a job that ends during the reload is reported by the next instance, not logged as undelivered", async (t) => {
  const session = sid("gap");
  const h = await mount(t, { session });
  await h.run({ command: "npm test", background: true });
  const task = h.children[0];
  await h.shutdown("reload");
  h.goStale();
  writeFileSync(task.logPath, "3 failures\n");
  assert.doesNotThrow(() => task.exit(3));
  assert.doesNotMatch(readFileSync(task.logPath, "utf8"), /not delivered/, "nothing pollutes the tail");

  const next = await boot(t, h.backgroundTasks, { session, reason: "reload" });
  assert.equal(next.sent.length, 0, "not while session_start runs");
  t.mock.timers.tick(0);
  assert.equal(next.sent.length, 1);
  assert.match(next.sent[0].message.content, new RegExp(`^\\[bg ${task.id}\\] \`npm test\` exited 3 after 0s\\n`));
  assert.match(next.sent[0].message.content, /3 failures/);
  assert.deepEqual(next.render(), []);
});

test("a handed-over job is stopped through its process group, no ps lookup needed; the stop stays quiet", async (t) => {
  const session = sid("kill-handed");
  const h = await mount(t, { session });
  await h.run({ command: "npm run dev", background: true });
  const task = h.children[0];
  await h.shutdown("reload");
  h.goStale();
  const next = await boot(t, h.backgroundTasks, { session, reason: "reload" });
  const killed = mockKill(t);
  const lookups = h.ps.calls;

  const req = { id: task.id, reply: (r) => (req.got = r) };
  next.emit("bg:kill", req);
  assert.equal(req.accepted, true);
  assert.deepEqual(req.got, { killed: true });
  assert.deepEqual(killed, [[-task.child.pid, "SIGTERM"]]);
  assert.equal(h.ps.calls, lookups, "an unreaped child of this process can't have a reused pid");
  task.exit(143); // the wrapper's status after SIGTERM
  assert.deepEqual(next.sent, []);
  assert.match(next.notices.at(-1).message, new RegExp(`bg ${task.id} killed \\(SIGTERM\\)`));
  t.mock.timers.tick(5000);
  assert.equal(killed.length, 1, "no SIGKILL once it is gone");
});

test("/new or /fork (another session id) starts empty; the old job's completion still reaches the live session", async (t) => {
  const h = await mount(t, { session: sid("before-new") });
  await h.run({ command: "npm run build", background: true });
  const task = h.children[0];
  await h.shutdown("new");
  h.goStale();
  const next = await boot(t, h.backgroundTasks, { session: sid("after-new"), reason: "new" });
  assert.deepEqual(next.list(), []);
  assert.deepEqual(next.render(), []);
  t.mock.timers.tick(0);
  assert.deepEqual(next.sent, []);
  task.exit(0);
  assert.equal(next.sent.length, 1, "unchanged: a late completion wakes whichever session is live");
  assert.match(next.sent[0].message.content, new RegExp(`\\[bg ${task.id}\\] .*succeeded`));
});

test("a persisted session's jobs are registered: metadata only, 0600 in a 0700 dir, gone once reported", async (t) => {
  const session = sid("persist");
  const h = await mount(t, { session });
  // Built at runtime: a credential-shaped string in the job's output.
  const secret = ["sk", "live", "Qx7".repeat(8)].join("_");
  await h.run({ command: "npm run build", background: true });
  const task = h.children[0];
  writeFileSync(task.logPath, `token ${secret}\n`);
  await settle();

  assert.equal(task.args[2], `${task.logPath}.exit`, "runs under the exit-status wrapper");
  const file = path.join(STATE, `${session}.json`);
  assert.equal(statSync(STATE).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(secret), "no output in the registry");
  const data = JSON.parse(text);
  assert.equal(data.v, 1);
  assert.equal(data.sessionId, session);
  assert.equal(data.jobs.length, 1);
  const [entry] = data.jobs;
  assert.equal(entry.id, task.id);
  assert.equal(entry.command, "npm run build");
  assert.equal(entry.cwd, dir);
  assert.equal(entry.logPath, task.logPath);
  assert.equal(entry.pid, task.child.pid);
  assert.equal(entry.pidStart, PS_START);
  assert.equal(entry.endedAt, undefined);

  task.exit(0);
  assert.equal(h.sent.length, 1);
  assert.equal(existsSync(file), false, "a reported ending leaves the registry");
});

test("restart: the resumed session re-adopts its running job, polls it, and reports the wrapper's exit code", async (t) => {
  const session = sid("restart");
  const h = await mount(t, { session });
  await h.run({ command: "npm run build", background: true });
  const task = h.children[0];
  await settle();
  await h.shutdown("quit");
  h.goStale();
  task.ended = true; // the old pi is gone, and its ChildProcess with it
  newProcess();
  const killed = mockKill(t);

  const next = await boot(t, h.backgroundTasks, { session, reason: "startup" });
  assert.deepEqual(next.render(), ["● 1 background job · build 0s · /bg"]);
  assert.deepEqual(next.list().map((job) => [job.id, job.endedAt]), [[task.id, undefined]]);
  t.mock.timers.tick(2000);
  assert.deepEqual(next.sent, [], "still running");

  writeFileSync(task.logPath, "built\n");
  writeExit(task.logPath, 7);
  utimesSync(`${task.logPath}.exit`, Date.now() / 1000, Date.now() / 1000);
  procs.delete(task.child.pid);
  t.mock.timers.tick(2000);
  assert.equal(next.sent.length, 1);
  // Its end is when the wrapper wrote the status (2s), not when the poll saw it.
  assert.match(next.sent[0].message.content, new RegExp(`^\\[bg ${task.id}\\] \`npm run build\` exited 7 after 2s\\n`));
  assert.match(next.sent[0].message.content, /built/);
  assert.deepEqual(next.render(), []);
  assert.equal(existsSync(`${task.logPath}.exit`), false);
  assert.equal(existsSync(path.join(STATE, `${session}.json`)), false);
  assert.deepEqual(killed, []);
});

test("a restart never adopts another session's jobs", async (t) => {
  const session = sid("mine");
  const h = await mount(t, { session });
  await h.run({ command: "npm run build", background: true });
  await settle();
  await h.shutdown("quit");
  h.goStale();
  h.children[0].ended = true;
  newProcess();
  mockKill(t);

  const other = await boot(t, h.backgroundTasks, { session: sid("theirs"), reason: "startup" });
  t.mock.timers.tick(2000);
  assert.deepEqual(other.list(), []);
  assert.deepEqual(other.sent, []);
  const kept = JSON.parse(readFileSync(path.join(STATE, `${session}.json`), "utf8"));
  assert.deepEqual(kept.jobs.map((job) => job.id), [h.children[0].id], "left for its own session");
});

test("pid reuse: a live pid with another start time, or another program, is never adopted or signalled", async (t) => {
  const session = sid("reuse");
  const reused = liveEntry();
  const stranger = liveEntry();
  procs.set(reused.pid, { ...procs.get(reused.pid), start: "Sat Nov  7 09:30:00 2026" });
  procs.set(stranger.pid, { start: PS_START, args: "/usr/bin/vim notes.txt" });
  const file = writeRegistry(session, [reused, stranger]);
  newProcess();
  const killed = mockKill(t);

  const h = await mount(t, { session });
  t.mock.timers.tick(0);
  assert.deepEqual(h.list().map((job) => typeof job.endedAt), ["number", "number"]);
  assert.equal(h.sent.length, 2);
  for (const { message } of h.sent) assert.match(message.content, /` ended \(exit unknown\) while the session was closed\n/);
  for (const job of [reused, stranger]) {
    const req = { id: job.id, reply: (r) => (req.got = r) };
    h.emit("bg:kill", req);
    assert.deepEqual(req.got, { killed: false });
  }
  t.mock.timers.tick(30_000);
  assert.deepEqual(killed, [], "nothing signalled");
  assert.equal(existsSync(file), false);
});

test("jobs that ended while pi was down are reported once on resume, waking the model only if the job asked to", async (t) => {
  const session = sid("down");
  const h = await mount(t, { session });
  mockKill(t);
  await h.run({ command: "npm run build", background: true });
  await h.run({ command: "npm run dev", background: true });
  await h.run({ command: "npm run lint", background: true });
  const [build, dev, lint] = h.children;
  await settle();
  h.emit("bg:kill", { id: dev.id, reply() {} }); // stopped just before pi quit
  t.mock.timers.tick(60_000);
  await h.shutdown("quit");
  h.goStale();
  newProcess();

  // While pi was down: build and dev ended through their wrapper; lint's was SIGKILLed.
  writeFileSync(build.logPath, "built\n");
  writeExit(build.logPath, 0);
  writeExit(dev.logPath, 143);
  for (const task of h.children) {
    utimesSync(task.logPath, Date.now() / 1000, Date.now() / 1000);
    if (existsSync(`${task.logPath}.exit`)) utimesSync(`${task.logPath}.exit`, Date.now() / 1000, Date.now() / 1000);
    task.ended = true;
    procs.delete(task.child.pid);
  }

  const next = await boot(t, h.backgroundTasks, { session, reason: "resume" });
  assert.deepEqual(next.sent, []);
  t.mock.timers.tick(0);
  const wakes = next.sent.map(({ message }) => message.content);
  assert.equal(wakes.length, 2);
  const built = wakes.find((wake) => wake.includes(build.id));
  assert.match(built, /`npm run build` succeeded after 1m00s while the session was closed\n/);
  assert.match(built, /built/);
  assert.match(wakes.find((wake) => wake.includes(lint.id)), /`npm run lint` ended \(exit unknown\) while the session was closed\n/);
  assert.match(
    next.notices.map(({ message }) => message).join("\n"),
    new RegExp(`bg ${dev.id} killed \\(SIGTERM\\) after 1m00s while the session was closed`),
    "a stop the user asked for only notifies",
  );
  assert.equal(next.list().length, 3, "listed as finished");
  assert.equal(existsSync(path.join(STATE, `${session}.json`)), false, "reported entries are pruned");

  await next.shutdown("quit");
  next.goStale();
  newProcess();
  const again = await boot(t, h.backgroundTasks, { session, reason: "resume" });
  t.mock.timers.tick(0);
  assert.deepEqual(again.sent, [], "reported once");
  assert.deepEqual(again.notices, []);
  assert.deepEqual(again.list(), []);
});

test("pruning: dead entries unseen for 24 h go unreported; other sessions' stale files keep only live jobs", async (t) => {
  const session = sid("aged");
  const aged = liveEntry({ startedAt: Date.now() - 50 * HOUR, seenAt: Date.now() - 25 * HOUR });
  procs.delete(aged.pid);
  writeRegistry(session, [aged]);
  const alive = liveEntry({ seenAt: Date.now() - 30 * HOUR });
  const dead = liveEntry();
  const deadToo = liveEntry();
  const deadFresh = liveEntry();
  for (const entry of [dead, deadToo, deadFresh]) procs.delete(entry.pid);
  const staleOther = writeRegistry(sid("stale-other"), [alive, dead]);
  const goneOther = writeRegistry(sid("gone-other"), [deadToo]);
  const freshOther = writeRegistry(sid("fresh-other"), [deadFresh]);
  const old = (Date.now() - 25 * HOUR) / 1000;
  for (const file of [staleOther, goneOther]) utimesSync(file, old, old);
  newProcess();
  mockKill(t);

  const h = await mount(t, { session });
  t.mock.timers.tick(0);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.list(), []);
  assert.equal(existsSync(path.join(STATE, `${session}.json`)), false);

  t.mock.timers.tick(5000); // the delayed prune
  const ids = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8")).jobs.map((job) => job.id);
    } catch {
      return undefined;
    }
  };
  await until(() => !existsSync(goneOther) && ids(staleOther)?.length === 1);
  assert.equal(existsSync(goneOther), false);
  assert.deepEqual(ids(staleOther), [alive.id]);
  assert.deepEqual(ids(freshOther), [deadFresh.id], "a recently used session's file is left to it");
});

test("stopping an adopted job checks ps first: its group is signalled only while its wrapper holds the pid", async (t) => {
  const session = sid("kill-adopted");
  const ours = liveEntry({ command: "npm run dev", name: "dev" });
  const stubborn = liveEntry({ command: "npm run serve", name: "serve" });
  const reusedLater = liveEntry({ command: "npm run watch", name: "watch" });
  writeRegistry(session, [ours, stubborn, reusedLater]);
  newProcess();
  const killed = mockKill(t);
  const h = await mount(t, { session });
  assert.equal(h.list().filter((job) => job.endedAt === undefined).length, 3);

  const req = { id: ours.id, reply: (r) => (req.got = r) };
  h.emit("bg:kill", req);
  assert.deepEqual(req.got, { killed: true });
  assert.deepEqual(killed, [[-ours.pid, "SIGTERM"]]);
  writeExit(ours.logPath, 143);
  procs.delete(ours.pid);
  t.mock.timers.tick(2000);
  assert.match(h.notices.at(-1).message, new RegExp(`bg ${ours.id} killed \\(SIGTERM\\)`));
  assert.deepEqual(h.sent, [], "a stop the user asked for wakes no one");

  // Ignores SIGTERM: still its wrapper 5 s later, so the group gets SIGKILL.
  h.emit("bg:kill", { id: stubborn.id, reply() {} });
  t.mock.timers.tick(5000);
  assert.deepEqual(killed.slice(1), [[-stubborn.pid, "SIGTERM"], [-stubborn.pid, "SIGKILL"]]);
  procs.delete(stubborn.pid); // gone without a status
  t.mock.timers.tick(2000);
  assert.match(h.notices.at(-1).message, new RegExp(`bg ${stubborn.id} killed \\(SIGKILL\\)`));

  // This one's pid now belongs to a process started later.
  procs.set(reusedLater.pid, { ...procs.get(reusedLater.pid), start: "Sat Nov  7 09:30:00 2026" });
  const late = { id: reusedLater.id, reply: (r) => (late.got = r) };
  h.emit("bg:kill", late);
  assert.deepEqual(late.got, { killed: false });
  t.mock.timers.tick(10_000);
  assert.equal(killed.length, 3, "the process at the reused pid is never signalled");
  assert.match(h.sent.at(-1).message.content, /`npm run watch` ended \(exit unknown\)\n/);
});

test("registry tampering: loose permissions, a symlink, or a log outside the bg dir are ignored", async (t) => {
  const { backgroundTasks } = await mount(t);
  const loose = sid("loose");
  writeRegistry(loose, [liveEntry()], 0o666);
  const linked = sid("linked");
  const target = path.join(dir, `${linked}-target.json`);
  writeFileSync(target, JSON.stringify({ v: 1, sessionId: linked, jobs: [liveEntry()] }), { mode: 0o600 });
  symlinkSync(target, path.join(STATE, `${linked}.json`));
  const elsewhere = sid("elsewhere");
  const entry = liveEntry();
  writeRegistry(elsewhere, [{ ...entry, logPath: path.join(dir, "outside", `${entry.id}.log`) }]);
  const killed = mockKill(t);

  for (const session of [loose, linked, elsewhere]) {
    newProcess();
    const h = await boot(t, backgroundTasks, { session, reason: "startup" });
    t.mock.timers.tick(2000);
    assert.deepEqual(h.list(), [], session);
    assert.deepEqual(h.sent, [], session);
  }
  assert.deepEqual(killed, []);
});

test("a stale instance's SIGKILL escalation never reaches the pid once its job was reaped", async (t) => {
  const session = sid("stale-escalation");
  const h = await mount(t, { session });
  await h.run({ command: "npm run dev", background: true });
  const task = h.children[0];
  await settle();
  await h.shutdown("reload");
  h.goStale();
  const next = await boot(t, h.backgroundTasks, { session, reason: "reload" });
  const killed = mockKill(t);
  next.emit("bg:kill", { id: task.id, reply() {} });
  assert.deepEqual(killed, [[-task.child.pid, "SIGTERM"]]);

  // Reloaded again inside the 5 s: `next` goes stale with its escalation pending.
  await next.shutdown("reload");
  next.goStale();
  const last = await boot(t, h.backgroundTasks, { session, reason: "reload" });
  task.exit(143);
  procs.set(task.child.pid, { start: "Sat Nov  7 09:30:00 2026", args: "/usr/bin/vim notes.txt" });
  t.mock.timers.tick(5000);
  assert.deepEqual(killed, [[-task.child.pid, "SIGTERM"]], "whatever holds the pid now is left alone");
  assert.match(last.notices.at(-1).message, new RegExp(`bg ${task.id} killed \\(SIGTERM\\)`));
  procs.delete(task.child.pid);
});

test("when ps can't tell, a registered job is neither adopted, reported, nor signalled; it stays for the next resume", async (t) => {
  const session = sid("ps-down");
  const entry = liveEntry();
  const file = writeRegistry(session, [entry]);
  psDown.add(entry.pid);
  t.after(() => psDown.delete(entry.pid));
  newProcess();
  const killed = mockKill(t);

  const h = await mount(t, { session });
  t.mock.timers.tick(0);
  assert.deepEqual(h.list(), []);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).jobs.map((job) => job.id), [entry.id]);

  // ps answers again: the next resume adopts it. Then ps fails while it runs.
  psDown.delete(entry.pid);
  await h.shutdown("quit");
  h.goStale();
  newProcess();
  const next = await boot(t, h.backgroundTasks, { session, reason: "resume" });
  assert.deepEqual(next.list().map((job) => [job.id, job.endedAt]), [[entry.id, undefined]]);
  psDown.add(entry.pid);
  const req = { id: entry.id, reply: (r) => (req.got = r) };
  next.emit("bg:kill", req);
  assert.deepEqual(req.got, { killed: false });
  t.mock.timers.tick(30_000); // past the periodic ps check
  await settle();
  assert.deepEqual(killed, []);
  assert.equal(next.list()[0].endedAt, undefined, "still running as far as bg can tell");
  assert.deepEqual(next.sent, []);
});

test("a copy handed over before ps answered keeps the start time the spawning instance records later", async (t) => {
  const session = sid("late-ps");
  const h = await mount(t, { session });
  h.ps.hold();
  await h.run({ command: "npm run dev", background: true });
  const task = h.children[0];
  await h.shutdown("reload");
  h.goStale();
  const next = await boot(t, h.backgroundTasks, { session, reason: "reload" });
  const file = path.join(STATE, `${session}.json`);
  const pidStart = () => JSON.parse(readFileSync(file, "utf8")).jobs[0].pidStart;
  assert.equal(pidStart(), undefined);
  h.ps.release();
  await settle();
  assert.equal(pidStart(), PS_START);

  mockKill(t);
  next.emit("bg:kill", { id: task.id, reply() {} }); // persists next's copy
  assert.equal(pidStart(), PS_START, "a later resume can still verify it");
  task.exit(143);
});

test("a completion forwarded while session_start still checks the registry waits until it returns", async (t) => {
  const h = await mount(t, { session: sid("before-switch") });
  await h.run({ command: "npm run build", background: true });
  const task = h.children[0];
  await settle();
  await h.shutdown("new");
  h.goStale();
  const session = sid("switched");
  writeRegistry(session, [liveEntry()]);

  h.ps.hold();
  const next = instance(h.backgroundTasks, { session });
  t.after(() => next.shutdown());
  const started = next.start("resume");
  task.exit(0);
  assert.deepEqual(next.sent, [], "no turn starts inside session_start");
  h.ps.release();
  await started;
  t.mock.timers.tick(0);
  assert.equal(next.sent.length, 1);
  assert.match(next.sent[0].message.content, new RegExp(`\\[bg ${task.id}\\] .*succeeded`));
});
