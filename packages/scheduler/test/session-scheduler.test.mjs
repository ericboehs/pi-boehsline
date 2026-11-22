import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The schedule tool is a Boehsline opt-in. Point the config at a scratch file
// so the developer's own boehsline.json cannot turn it on under the tests.
const configDir = mkdtempSync(join(tmpdir(), "session-scheduler-"));
const configPath = join(configDir, "boehsline.json");
process.env.BOEHSLINE_CONFIG = configPath;
delete process.env.BOEHSLINE_ENABLE;

// Every scheduler file a test produces — the timer index, lock directories —
// goes here. Without this the tests read and write ~/.pi/agent/scheduler, which
// is the developer's real one.
const schedulerDir = mkdtempSync(join(tmpdir(), "session-scheduler-state-"));
process.env.PI_SCHEDULER_DIR = schedulerDir;
delete process.env.PI_SCHEDULER_SESSION_MISFIRE;
process.env.PI_AGENT_DIR = schedulerDir;

import sessionScheduler, {
  MAX_CATCHUPS,
  TOOL_OPT_IN,
  advanceRecurringTask,
  deliveryText,
  latestMissedSlot,
  normalizeTasksForResume,
  parseTimerFlags,
  planRestore,
  sessionMisfireMs,
  timerStatusText,
} from "../extensions/session-scheduler.ts";
import {
  indexPath,
  planIndexEntry,
  readSessionIndex,
  sessionHeldElsewhere,
  updateSessionIndex,
} from "../extensions/lib/session-index.ts";
import { processStart } from "../extensions/lib/process-identity.ts";

/** The index file for this run. */
const indexFile = () => indexPath();

function readIndex() {
  return JSON.parse(readFileSync(indexFile(), "utf8"));
}

/** A fresh, real session file: the index refuses to record one that is not on disk. */
function makeSessionFile(name = "session") {
  const dir = mkdtempSync(join(tmpdir(), `session-scheduler-${name}-`));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, "");
  return file;
}

function snapshot(sessionId, tasks) {
  return {
    type: "custom",
    customType: "session-scheduler:snapshot",
    data: { version: 1, sessionId, tasks },
  };
}

async function mount({
  branch = [],
  idle = true,
  sessionId = "session-a",
  persisted = true,
  hasUI = true,
  config = {},
  reason = "startup",
  sessionFile = makeSessionFile(),
} = {}) {
  writeFileSync(configPath, JSON.stringify(config));
  const tools = [];
  const handlers = {};
  const commands = {};
  const entries = persisted
    ? [{ type: "message", message: { role: "assistant", content: [] } }, ...branch]
    : [...branch];
  const sent = [];
  /** Each send, with how many tasks the snapshot held at that instant. */
  const sentOrder = [];
  const lastSnapshotTasks = () => {
    const latest = entries.filter((entry) => entry.type === "custom").at(-1);
    return latest?.data?.tasks?.length;
  };
  const notices = [];
  const statuses = [];
  let isIdle = idle;
  let idleChecks = 0;
  let registeredTools = 0;

  const ctx = {
    hasUI,
    cwd: tmpdir(),
    isIdle: () => (idleChecks++, isIdle),
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
      ...(sessionFile === null ? {} : { getSessionFile: () => sessionFile }),
    },
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      confirm: async () => true,
      setStatus: (key, value) => statuses.push({ key, value }),
    },
  };

  const emitted = [];
  const listeners = {};
  const pi = {
    events: {
      emit: (name, data) => { emitted.push({ name, data }); for (const fn of listeners[name] ?? []) fn(data); },
      on: (name, fn) => { (listeners[name] ??= []).push(fn); },
    },
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: (name, options) => { commands[name] = options; },
    registerTool: (tool) => { registeredTools += 1; tools.push(tool); },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    appendEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (prompt) => {
      sentOrder.push({ prompt, snapshotTasks: lastSnapshotTasks() });
      sent.push(prompt);
      isIdle = false;
    },
  };

  sessionScheduler(pi);
  await handlers.session_start({ reason }, ctx);
  // Catch-ups are delivered on the tick after session_start, deliberately:
  // pi is still wiring the session up while the event runs.
  await new Promise((resolve) => setTimeout(resolve, 20));

  return {
    commands,
    ctx,
    emitted,
    pi,
    entries,
    handlers,
    notices,
    sent,
    sentOrder,
    statuses,
    registeredTools,
    tools,
    sessionFile,
    tool: (params) => tools[0].execute("call-1", params, undefined, undefined, ctx),
    setIdle: (value) => { isIdle = value; },
    /** How often the scheduler asked whether the session is idle: once per delivery attempt. */
    idleChecks: () => idleChecks,
    run: (name, args = "") => commands[name].handler(args, ctx),
    start: (startReason = "resume") => handlers.session_start({ reason: startReason }, ctx),
    shutdown: (shutdownReason = "quit") => handlers.session_shutdown({ reason: shutdownReason }, ctx),
    settle: () => handlers.agent_settled({}, ctx),
  };
}

function latestTasks(ui) {
  return ui.entries.at(-1)?.data?.tasks ?? [];
}

test("registers only the session-scoped commands, and no LLM tools", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);
  assert.deepEqual(Object.keys(ui.commands).sort(), ["loop", "once"]);
  assert.equal(ui.registeredTools, 0, "scheduling must not enter model context");
});

test("resume skips missed recurring slots and drops expired one-shots", () => {
  const now = 10_000;
  const tasks = [
    { id: "interval", kind: "interval", prompt: "tick", createdAt: 0, nextRunAt: 1_000, intervalMs: 3_000 },
    { id: "old-once", kind: "once", prompt: "old", createdAt: 0, nextRunAt: 9_000 },
    { id: "future-once", kind: "once", prompt: "future", createdAt: 0, nextRunAt: 11_000 },
  ];
  const result = normalizeTasksForResume(tasks, now);
  assert.equal(result.changed, true);
  assert.deepEqual(result.tasks.map((task) => task.id), ["interval", "future-once"]);
  assert.equal(result.tasks[0].nextRunAt, 13_000, "keeps the original interval phase without catch-up");
});

test("advances a recurring interval to the first future slot", () => {
  const task = { id: "x", kind: "interval", prompt: "tick", createdAt: 0, nextRunAt: 1_000, intervalMs: 1_000 };
  assert.equal(advanceRecurringTask(task, 1_000).nextRunAt, 2_000);
  assert.equal(advanceRecurringTask(task, 3_500).nextRunAt, 4_000);
});

test("a cron task whose expression went bad is dropped, not respun", () => {
  const result = normalizeTasksForResume(
    [{ id: "bad", kind: "cron", prompt: "x", createdAt: 0, nextRunAt: 1_000, cronExpr: "0 0 30 2 *" }],
    10_000,
  );
  assert.deepEqual(result.tasks, [], "cannot advance, so it is discarded");
  assert.equal(result.changed, true);
});

test("/loop creates a session snapshot and supports trailing every syntax", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "15m check CI");
  assert.equal(latestTasks(ui).length, 1);
  assert.equal(latestTasks(ui)[0].intervalMs, 900_000);
  assert.equal(latestTasks(ui)[0].prompt, "check CI");

  await ui.run("loop", "review deploy every 1h");
  assert.equal(latestTasks(ui).length, 2);
  assert.equal(latestTasks(ui)[1].intervalMs, 3_600_000);
  assert.equal(latestTasks(ui)[1].prompt, "review deploy");
});

test("/loop rejects an interval below the one-minute floor", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "10s hammer the API");
  assert.equal(ui.notices.at(-1).level, "error");
  assert.match(ui.notices.at(-1).message, /at least 1m/);
  assert.equal(latestTasks(ui).length, 0);
});

test("/once creates a one-shot task and warns that the session must stay open", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "15m check whether the deploy finished");
  const [task] = latestTasks(ui);
  assert.equal(task.kind, "once");
  assert.equal(task.prompt, "check whether the deploy finished");
  assert.ok(task.nextRunAt > Date.now());
  assert.match(ui.notices.at(-1).message, /fires while this session is open/);
  assert.match(ui.notices.at(-1).message, /next resume if not more than 1d late/);
  assert.deepEqual(ui.sent, [], "scheduling must not wake the model");
});

test("/once and /loop share one help that draws the line at /schedule", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  for (const command of ["once", "loop"]) {
    await ui.run(command, "help");
    const help = ui.notices.at(-1).message;
    assert.equal(ui.notices.at(-1).level, "info", `${command} help is not an error`);
    assert.match(help, /need pi open/, "the session-scoped caveat is the whole point");
    assert.match(help, /delivered once when you next resume/, "catch-up, not replay-of-everything");
    assert.match(help, /24h late/, "the staleness window is stated");
    assert.match(help, /use \/schedule/, "help names the durable alternative");
    assert.match(help, /may lead or trail/, "the one genuinely surprising parse rule");
    assert.match(help, /1m minimum/);
    assert.match(help, /--wake=always/);
    assert.match(help, /--misfire/, "the new flags are documented where they are used");
  }

  assert.equal(latestTasks(ui).length, 0, "asking for help does not schedule anything");
});

test("/once points at /schedule rather than silently doing nothing on junk", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "check the build");
  assert.match(ui.notices.at(-1).message, /Use \/schedule for tasks that must run/);
  assert.equal(latestTasks(ui).length, 0);
});

test("/once list shows only one-shots, and /once cancel removes them", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "5m check CI");
  await ui.run("once", "at 8p check in on this");
  const oneShot = latestTasks(ui).find((task) => task.kind === "once");

  await ui.run("once", "list");
  const listed = ui.notices.at(-1).message;
  assert.match(listed, new RegExp(oneShot.id));
  assert.doesNotMatch(listed, /check CI/, "the interval task belongs to /loop");

  await ui.run("once", `cancel ${oneShot.id.slice(0, 4)}`);
  assert.deepEqual(latestTasks(ui).map((task) => task.kind), ["interval"]);
});

test("/once list is empty when only recurring tasks exist", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "5m check CI");
  await ui.run("once", "list");
  assert.match(ui.notices.at(-1).message, /No one-shot tasks/);
});

test("/loop list shows every session timer, whatever created it", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "5m check CI");
  await ui.run("once", "8p check in");
  await ui.run("loop", "list");
  const listed = ui.notices.at(-1).message;
  assert.match(listed, /every 5m/);
  assert.match(listed, /once/);
});

test("list and cancel are handled without waking the model", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "every 5m check CI");
  const id = latestTasks(ui)[0].id;
  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, new RegExp(id));
  assert.deepEqual(ui.sent, []);

  await ui.run("loop", `cancel ${id.slice(0, 4)}`);
  assert.equal(latestTasks(ui).length, 0);
  assert.match(ui.notices.at(-1).message, /Cancelled/);
});

test("/loop edit keeps the id and paused state, and takes a new interval and prompt", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "15m check CI");
  await ui.run("loop", "1h other");
  const [first] = latestTasks(ui);
  await ui.run("loop", `edit ${first.id} 30m :: check CI :: and the deploy\nthen say so`);
  assert.match(ui.notices.at(-1).message, new RegExp(`^Edited ${first.id}; every 30m`));
  const [edited, other] = latestTasks(ui);
  assert.equal(edited.id, first.id, "same id, same place in the list");
  assert.equal(edited.intervalMs, 1_800_000);
  assert.equal(edited.prompt, "check CI :: and the deploy\nthen say so", "only the leading :: is the delimiter");
  assert.ok(edited.nextRunAt > Date.now() + 1_700_000, "restarts from now");
  assert.equal(other.prompt, "other");

  await ui.run("loop", `pause ${first.id}`);
  await ui.run("loop", `edit ${first.id} 2h paused still`);
  assert.equal(latestTasks(ui)[0].paused, true);
  assert.match(ui.notices.at(-1).message, /still paused/);
  assert.deepEqual(ui.sent, [], "editing never wakes the model");
});

test("/once edit moves a one-shot, and each edit refuses the other kind", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "15m ping");
  await ui.run("loop", "15m tick");
  const [once, loop] = latestTasks(ui);
  const at = new Date(Date.now() + 7_200_000).toISOString();
  await ui.run("once", `edit ${once.id} ${at} :: ping later`);
  assert.deepEqual([latestTasks(ui)[0].nextRunAt, latestTasks(ui)[0].prompt], [Date.parse(at), "ping later"]);

  const before = JSON.stringify(latestTasks(ui));
  await ui.run("loop", `edit ${once.id} 30m x`);
  assert.match(ui.notices.at(-1).message, /is a one-shot; change it with \/once edit/);
  await ui.run("once", `edit ${loop.id} 30m x`);
  assert.match(ui.notices.at(-1).message, /repeats; change it with \/loop edit/);
  await ui.run("loop", `edit ${loop.id} 10s x`);
  assert.match(ui.notices.at(-1).message, /at least 1m/);
  await ui.run("loop", "edit nope 30m x");
  assert.match(ui.notices.at(-1).message, /No session task matches nope/);
  assert.equal(JSON.stringify(latestTasks(ui)), before, "a refused edit changes nothing");
});

test("an edited agent timer fires as the user's prompt, not the agent's reminder", async (t) => {
  const task = { id: "a9e47000", kind: "interval", prompt: "agent's", createdAt: Date.now(), nextRunAt: Date.now() + 60_000, intervalMs: 60_000, source: "agent" };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  await ui.run("loop", "edit a9e47000 5m mine now");
  assert.equal(latestTasks(ui)[0].source, undefined);
  assert.equal(ui.emitted.at(-1).data[0].source, "session");
});

test("a /loop whose prompt opens with edit is still a new timer", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "edit the docs every 1h");
  assert.deepEqual(latestTasks(ui).map((task) => [task.prompt, task.intervalMs]), [["edit the docs", 3_600_000]]);
});

test("snapshots are bound to the session id, so forks do not inherit jobs", async (t) => {
  const task = { id: "deadbeef", kind: "interval", prompt: "tick", createdAt: Date.now(), nextRunAt: Date.now() + 60_000, intervalMs: 60_000 };
  const ui = await mount({ branch: [snapshot("parent-session", [task])], sessionId: "fork-session" });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /No timers in this session/);
});

test("resume restores matching future tasks", async (t) => {
  const task = { id: "deadbeef", kind: "interval", prompt: "tick", createdAt: Date.now(), nextRunAt: Date.now() + 60_000, intervalMs: 60_000 };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /deadbeef/);
});

test("a cron task is restored from a snapshot rather than filtered out", async (t) => {
  // Regression: the snapshot validator's kind allowlist omitted "cron", so
  // every cron task was silently dropped on resume before its own branch of
  // the validator could run.
  const task = {
    id: "cr0nb00b",
    kind: "cron",
    prompt: "weekday standup",
    createdAt: Date.now(),
    nextRunAt: Date.now() + 3_600_000,
    cronExpr: "0 9 * * 1-5",
  };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /cr0nb00b · cron 0 9 \* \* 1-5/);
});

test("a snapshot with an unparseable cron expression is still rejected", async (t) => {
  const task = {
    id: "badc0de5",
    kind: "cron",
    prompt: "junk",
    createdAt: Date.now(),
    nextRunAt: Date.now() + 3_600_000,
    cronExpr: "99 * * * *",
  };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /No timers in this session/);
});

test("a due task waits for agent_settled when the session is busy", async (t) => {
  // Due in the future, so the mount's own catch-up pass has nothing to do: the
  // timer fires live, finds the session busy, and waits to be settled.
  const task = { id: "deadbeef", kind: "once", prompt: "wake up", createdAt: Date.now(), nextRunAt: Date.now() + 250 };
  const ui = await mount({ branch: [snapshot("session-a", [task])], idle: false });
  t.after(ui.shutdown);

  // Wait for the scheduler to try delivering and find the session busy (it asks
  // ctx.isIdle()), not a fixed sleep: under a loaded test run the timer can fire
  // late, and agent_settled would then find nothing queued yet.
  const deadline = Date.now() + 5_000;
  while (ui.idleChecks() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ui.idleChecks() > 0, "the scheduler tried to deliver");
  assert.deepEqual(ui.sent, []);

  ui.setIdle(true);
  await ui.handlers.agent_settled({}, ui.ctx);
  assert.deepEqual(ui.sent, ["wake up"]);
});

test("an overdue one-shot is delivered once on resume, with a late prefix", async (t) => {
  const dueAt = Date.now() - 2 * 3_600_000;
  const task = { id: "deadbeef", kind: "once", prompt: "check the backup", createdAt: dueAt - 1_000, nextRunAt: dueAt };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  assert.equal(ui.sent.length, 1, "the missed one-shot is delivered");
  assert.match(ui.sent[0], /^\[Scheduled task deadbeef was due at .+, 2h late \(1 missed run\) because this session was not open\]\ncheck the backup$/);
  assert.deepEqual(latestTasks(ui), [], "and retired from the snapshot as usual");
});

test("the snapshot records the removal before the catch-up is sent", async (t) => {
  const dueAt = Date.now() - 60_000;
  const task = { id: "0rder1ng", kind: "once", prompt: "persist first", createdAt: dueAt - 1_000, nextRunAt: dueAt };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  assert.equal(ui.sent.length, 1);
  // The appended snapshot that emptied the list came before the message went
  // out: at-most-once means a crash between the two loses the prompt, never
  // delivers it twice.
  const appended = ui.entries.filter((entry) => entry.type === "custom");
  assert.deepEqual(appended.at(-1).data.tasks, []);
  assert.equal(ui.sentOrder[0].snapshotTasks, 0, "snapshot was already empty when the send happened");
});

test("a missed fire past its cap is dropped with a notice, not delivered", async (t) => {
  const dueAt = Date.now() - 30 * 3_600_000;
  const task = { id: "t00late", kind: "once", prompt: "month-old reminder", createdAt: dueAt - 1_000, nextRunAt: dueAt };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  assert.deepEqual(ui.sent, [], "24h is the default staleness window");
  assert.deepEqual(latestTasks(ui), []);
  assert.match(ui.notices.at(-1).message, /Skipped t00late: its .+ fire was 1d6h late, past its catch-up limit/);
  assert.equal(ui.notices.at(-1).level, "warning", "a lost reminder is never silent");
});

test("a per-task misfire window overrides the default cap", async (t) => {
  const dueAt = Date.now() - 30 * 3_600_000;
  const task = { id: "always", kind: "once", prompt: "fires however late", createdAt: dueAt - 1_000, nextRunAt: dueAt, misfire: "always" };
  const kept = { id: "skip", kind: "once", prompt: "never late", createdAt: dueAt - 1_000, nextRunAt: dueAt - 1, misfire: "skip" };
  const ui = await mount({ branch: [snapshot("session-a", [task, kept])] });
  t.after(ui.shutdown);

  assert.equal(ui.sent.length, 1, "misfire=always still delivers a month-old fire");
  assert.match(ui.sent[0], /^\[Scheduled task always was due at/);
  assert.match(ui.notices.find((n) => /Skipped skip/.test(n.message)).message, /past its catch-up limit/);
});

test("PI_SCHEDULER_SESSION_MISFIRE sets the default window", () => {
  const previous = process.env.PI_SCHEDULER_SESSION_MISFIRE;
  try {
    delete process.env.PI_SCHEDULER_SESSION_MISFIRE;
    assert.equal(sessionMisfireMs(), 24 * 3_600_000);
    process.env.PI_SCHEDULER_SESSION_MISFIRE = "90m";
    assert.equal(sessionMisfireMs(), 5_400_000);
    process.env.PI_SCHEDULER_SESSION_MISFIRE = "skip";
    assert.equal(sessionMisfireMs(), 0);
    process.env.PI_SCHEDULER_SESSION_MISFIRE = "always";
    assert.equal(sessionMisfireMs(), Number.POSITIVE_INFINITY);
    process.env.PI_SCHEDULER_SESSION_MISFIRE = "nonsense";
    assert.equal(sessionMisfireMs(), 24 * 3_600_000, "an unreadable value falls back, never to zero");
  } finally {
    if (previous === undefined) delete process.env.PI_SCHEDULER_SESSION_MISFIRE;
    else process.env.PI_SCHEDULER_SESSION_MISFIRE = previous;
  }
});

test("a recurring task with missed slots fires once and re-arms", async (t) => {
  const now = Date.now();
  const task = { id: "l00p1111", kind: "interval", prompt: "check CI", createdAt: now - 600_000, nextRunAt: now - 250_000, intervalMs: 60_000 };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  assert.equal(ui.sent.length, 1, "one fire, not five");
  // The slots at -250s, -190s, -130s, -70s and -10s all came due; lateness is
  // measured from the latest of them, not the earliest.
  assert.match(ui.sent[0], /^\[Scheduled task l00p1111 was due at .+, \d+s late \(5 missed runs\) because this session was not open\]\ncheck CI$/);
  const [restored] = latestTasks(ui);
  assert.equal(restored.id, "l00p1111");
  assert.ok(restored.nextRunAt > Date.now(), "re-armed into the future");
  assert.equal(restored.nextRunAt % 60_000, task.nextRunAt % 60_000, "and still on its original phase");
});

test("recurring lateness is measured from the latest missed slot", () => {
  const now = 1_000_000_000;
  // Due 25.5h ago every hour: the earliest slot is old, the latest is minutes old.
  const task = { id: "hourly", kind: "interval", prompt: "x", createdAt: now - 100_000_000, intervalMs: 3_600_000, nextRunAt: now - 25.5 * 3_600_000 };
  assert.equal(now - latestMissedSlot(task, now), 1_800_000, "30m late, not 25h");
  const plan = planRestore([task], now, { catchUp: true });
  assert.equal(plan.catchUps.length, 1, "so a 24h cap still delivers it");
  assert.equal(plan.catchUps[0].late.missed, 26);
});

test("only MAX_CATCHUPS missed timers are delivered, oldest first", async (t) => {
  const now = Date.now();
  const tasks = Array.from({ length: MAX_CATCHUPS + 2 }, (_, index) => ({
    id: `catch${index}`,
    kind: "once",
    prompt: `reminder ${index}`,
    createdAt: now - 600_000,
    nextRunAt: now - 300_000 + index * 1_000,
  }));
  const ui = await mount({ branch: [snapshot("session-a", tasks)] });
  t.after(ui.shutdown);
  // Deliver them one at a time, as a real session would.
  for (let index = 0; index < MAX_CATCHUPS + 2; index += 1) {
    ui.setIdle(true);
    await ui.settle();
  }

  assert.equal(ui.sent.length, MAX_CATCHUPS);
  assert.match(ui.sent[0], /reminder 0/, "oldest first");
  const overflow = ui.notices.filter((n) => /only 5 missed timers are caught up at a time/.test(n.message));
  assert.equal(overflow.length, 2, "the rest are named, not silently binned");
  assert.match(overflow[0].message, /Skipped catch5/);
});

test("paused tasks are untouched by a catch-up", async (t) => {
  const now = Date.now();
  const paused = { id: "pau5ed00", kind: "once", prompt: "held", createdAt: now - 600_000, nextRunAt: now - 300_000, paused: true };
  const ui = await mount({ branch: [snapshot("session-a", [paused])] });
  t.after(ui.shutdown);

  assert.deepEqual(ui.sent, [], "a paused task does not fire");
  assert.deepEqual(latestTasks(ui).map((task) => task.id), ["pau5ed00"], "and is not dropped");
});

test("reload delivers a never-delivered one-shot exactly once", async (t) => {
  const now = Date.now();
  const task = { id: "re10ad00", kind: "once", prompt: "check the deploy", createdAt: now - 600_000, nextRunAt: now - 300_000 };
  const ui = await mount({ branch: [snapshot("session-a", [task])], reason: "reload" });
  t.after(ui.shutdown);

  assert.equal(ui.sent.length, 1);
  assert.deepEqual(latestTasks(ui), [], "the snapshot now says it is gone");

  // /reload again: the runtime is rebuilt from that snapshot, so there is
  // nothing left to fire.
  ui.setIdle(true);
  await ui.start("reload");
  ui.setIdle(true);
  await ui.settle();
  assert.equal(ui.sent.length, 1, "a second reload does not re-fire");
});

test("a crash after delivery does not re-fire the catch-up", async (t) => {
  const now = Date.now();
  const task = { id: "cra5h000", kind: "once", prompt: "only once", createdAt: now - 600_000, nextRunAt: now - 300_000 };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);
  assert.equal(ui.sent.length, 1);

  // Kill the process without a shutdown: the appended snapshot is the only
  // thing that survives, which is why it is written before the send.
  const entries = ui.entries.map((entry) => ({ ...entry }));
  const restarted = await mount({ branch: entries, reason: "resume" });
  t.after(restarted.shutdown);
  assert.equal(restarted.sent.length, 0, "at most once, even across a crash");
});

test("tree navigation never catches up", async (t) => {
  const now = Date.now();
  const future = { id: "future00", kind: "interval", prompt: "future", createdAt: now, nextRunAt: now + 3_600_000, intervalMs: 3_600_000 };
  const ui = await mount({ branch: [snapshot("session-a", [future])] });
  t.after(ui.shutdown);
  // Moving to a branch whose snapshot holds a slot that already fired.
  ui.entries.push(snapshot("session-a", [
    future,
    { id: "tree0000", kind: "once", prompt: "older branch", createdAt: now - 600_000, nextRunAt: now - 300_000 },
  ]));

  await ui.handlers.session_tree({}, ui.ctx);
  ui.setIdle(true);
  await ui.settle();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(ui.sent.filter((text) => text.includes("older branch")).length, 0, "session_tree must not replay");
  assert.deepEqual(latestTasks(ui).map((task) => task.id), ["future00"], "the missed one-shot is dropped, as before");
});

test("print mode leaves the snapshot alone and still writes the index", async (t) => {
  const now = Date.now();
  const task = { id: "pr1nt000", kind: "once", prompt: "never into a print run", createdAt: now - 600_000, nextRunAt: now - 300_000 };
  const sessionFile = makeSessionFile("print");
  const ui = await mount({ branch: [snapshot("session-a", [task])], hasUI: false, sessionFile });
  t.after(ui.shutdown);
  const customs = () => ui.entries.filter((entry) => entry.type === "custom");

  assert.deepEqual(ui.sent, [], "no catch-up is injected into an unattended answer");
  assert.equal(customs().length, 1, "and nothing is persisted: only the snapshot it found");
  assert.deepEqual(customs()[0].data.tasks.map((entry) => entry.id), ["pr1nt000"], "not even a drop");
  assert.equal(ui.notices.length, 0, "nor is a missing watch reported as a drop");
  const entry = readIndex().sessions["session-a"];
  assert.equal(entry.sessionFile, sessionFile, "the index still says the session has timers");
  assert.ok(entry.nextDueAt <= Date.now());
});

test("/loop pause stops a task firing but keeps it listed", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "30s ping");
  const id = latestTasks(ui)[0].id;

  await ui.run("loop", `pause ${id}`);
  assert.equal(latestTasks(ui)[0].paused, true);
  assert.match(ui.notices.at(-1).message, /Paused 1 task/);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /paused/);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(ui.sent, [], "a paused task must not fire");
});

test("/loop resume re-arms and recomputes the next run", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h morning report");
  const id = latestTasks(ui)[0].id;

  await ui.run("loop", `pause ${id}`);
  await ui.run("loop", `resume ${id}`);

  const task = latestTasks(ui)[0];
  assert.equal(task.paused, false);
  assert.ok(task.nextRunAt > Date.now(), "next run is back in the future");
  assert.match(ui.notices.at(-1).message, /Resumed/);
});

test("pause and resume accept 'all'", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h a");
  await ui.run("loop", "2h b");
  await ui.run("loop", "pause all");
  assert.deepEqual(latestTasks(ui).map((task) => task.paused), [true, true]);

  await ui.run("loop", "resume all");
  assert.deepEqual(latestTasks(ui).map((task) => task.paused), [false, false]);
});

test("pausing is idempotent and reports when there is nothing to do", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h a");
  await ui.run("loop", "pause all");
  await ui.run("loop", "pause all");
  assert.match(ui.notices.at(-1).message, /Nothing to pause/);
});

test("/loop clear drops every session timer", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h a");
  await ui.run("once", "30m b");
  await ui.run("loop", "clear yes");
  assert.deepEqual(latestTasks(ui), []);
  assert.match(ui.notices.at(-1).message, /Cleared all session timers/);
});

test("a paused task survives resume without being advanced or dropped", async (t) => {
  const stale = {
    id: "deadbeef",
    kind: "once",
    prompt: "held",
    createdAt: Date.now() - 10_000,
    nextRunAt: Date.now() - 5_000,
    paused: true,
  };
  const ui = await mount({ branch: [snapshot("session-a", [stale])] });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /deadbeef/, "kept despite being overdue");
  assert.deepEqual(ui.sent, [], "and it did not fire on restore");
});

test("resuming an overdue one-shot drops it instead of firing late", async (t) => {
  const stale = {
    id: "deadbeef",
    kind: "once",
    prompt: "held",
    createdAt: Date.now() - 10_000,
    nextRunAt: Date.now() - 5_000,
    paused: true,
  };
  const ui = await mount({ branch: [snapshot("session-a", [stale])] });
  t.after(ui.shutdown);

  await ui.run("loop", "resume deadbeef");
  assert.deepEqual(latestTasks(ui), []);
  assert.match(ui.notices.at(-1).message, /passed while paused/);
  assert.deepEqual(ui.sent, []);
});

test("resuming an overdue recurring task advances it rather than dropping it", async (t) => {
  const stale = {
    id: "cafe1234",
    kind: "interval",
    prompt: "tick",
    createdAt: Date.now() - 600_000,
    nextRunAt: Date.now() - 300_000,
    intervalMs: 60_000,
    paused: true,
  };
  const ui = await mount({ branch: [snapshot("session-a", [stale])] });
  t.after(ui.shutdown);

  await ui.run("loop", "resume cafe1234");
  const task = latestTasks(ui)[0];
  assert.equal(task.id, "cafe1234");
  assert.ok(task.nextRunAt > Date.now());
  assert.deepEqual(ui.sent, [], "no catch-up burst");
});

test("warns when the session has not been written to disk yet", async (t) => {
  const ui = await mount({ persisted: false });
  t.after(ui.shutdown);

  await ui.run("loop", "1h morning report");
  const warning = ui.notices.find((n) => /no model reply yet/.test(n.message));
  assert.ok(warning, "expected an unsaved-session warning");
  assert.equal(warning.level, "warning");
  assert.match(ui.notices.at(-1).message, /^Looping /, "the confirmation still comes last");
  assert.equal(latestTasks(ui).length, 1, "the task is still created");
});

test("stays quiet once the session has an assistant message", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("loop", "1h morning report");
  assert.equal(ui.notices.filter((n) => /no model reply yet/.test(n.message)).length, 0);
});

test("switching sessions disarms the old timers, so a prompt cannot land in the wrong chat", async (t) => {
  const handlers = {};
  const sentTo = { a: [], b: [] };

  const makeCtx = (sessionId, entries) => ({
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
    ui: { notify: () => {}, confirm: async () => true, setStatus: () => {} },
  });

  const entriesA = [{ type: "message", message: { role: "assistant", content: [] } }];
  const entriesB = [{ type: "message", message: { role: "assistant", content: [] } }];
  let current = "a";

  sessionScheduler({
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: (customType, data) => {
      (current === "a" ? entriesA : entriesB).push({ type: "custom", customType, data });
    },
    sendUserMessage: (prompt) => { sentTo[current].push(prompt); },
  });

  const ctxA = makeCtx("session-a", entriesA);
  const ctxB = makeCtx("session-b", entriesB);

  await handlers.session_start({ reason: "startup" }, ctxA);
  // Armed in A, and deliberately not yet due.
  entriesA.push(snapshot("session-a", [{
    id: "aaaaaaaa",
    kind: "once",
    prompt: "a secret from session A",
    createdAt: Date.now(),
    nextRunAt: Date.now() + 30,
  }]));
  await handlers.session_start({ reason: "resume" }, ctxA);

  // Now the user switches. A's timer is still counting down at this point.
  current = "b";
  await handlers.session_start({ reason: "switch" }, ctxB);

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.deepEqual(sentTo.b, [], "A's prompt must never be delivered into B");
  assert.deepEqual(sentTo.a, [], "and A is no longer the active session either");

  await handlers.session_shutdown({ reason: "quit" }, ctxB);
});

test("an unreadable latest snapshot does not resurrect timers from an older one", async (t) => {
  const cancelled = {
    id: "deadbeef",
    kind: "interval",
    intervalMs: 60_000,
    prompt: "the one you cancelled",
    createdAt: Date.now(),
    nextRunAt: Date.now() + 60_000,
  };
  const ui = await mount({
    branch: [
      snapshot("session-a", [cancelled]),
      // A later snapshot that cannot be trusted. Falling back to the one above
      // would re-arm a timer the user has since cancelled.
      { type: "custom", customType: "session-scheduler:snapshot", data: { version: 99, sessionId: "session-a", tasks: [] } },
    ],
  });
  t.after(ui.shutdown);

  await ui.run("loop", "list");
  assert.match(ui.notices.at(-1).message, /No timers in this session/);
});

test("a one-shot that fails to deliver is kept, not silently dropped", async (t) => {
  const handlers = {};
  const entries = [{ type: "message", message: { role: "assistant", content: [] } }];
  const notices = [];
  let failNext = true;

  sessionScheduler({
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: () => {
      if (failNext) throw new Error("the agent is wedged");
    },
  });

  const ctx = {
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session-a", getBranch: () => entries },
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      confirm: async () => true,
      setStatus: () => {},
    },
  };

  entries.push(snapshot("session-a", [{
    id: "deadbeef",
    kind: "once",
    prompt: "the reminder that matters",
    createdAt: Date.now(),
    nextRunAt: Date.now() + 250, // past due at resume would count as missed and be dropped
  }]));
  await handlers.session_start({ reason: "resume" }, ctx);
  // Poll for the failed delivery, not one fixed sleep: a loaded run fires timers late.
  const deadline = Date.now() + 5_000;
  while (!/Could not deliver/.test(notices.at(-1)?.message ?? "") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.match(notices.at(-1).message, /Could not deliver/);

  // Removing it before the send succeeded would leave the reminder in neither
  // the queue nor the snapshot, and it would simply never arrive.
  const stillQueued = entries.filter((entry) => entry.type === "custom").at(-1)?.data.tasks ?? [];
  assert.deepEqual(
    stillQueued.map((task) => task.id),
    ["deadbeef"],
    "the undelivered one-shot is still in the snapshot",
  );

  failNext = false;
  await handlers.agent_settled({}, ctx);
  const afterDelivery = entries.filter((entry) => entry.type === "custom").at(-1)?.data.tasks ?? [];
  assert.deepEqual(afterDelivery, [], "and it retires only once it has actually landed");

  await handlers.session_shutdown({ reason: "quit" }, ctx);
});

// ── schedule tool (opt-in) ──

const withTool = { config: { enable: [TOOL_OPT_IN] } };
const textOf = (result) => result.content.map((part) => part.text).join("");

test("the schedule tool stays off unless scheduler-tool is enabled", async (t) => {
  const ui = await mount({ config: { enable: ["something-else"] } });
  t.after(ui.shutdown);
  assert.equal(ui.registeredTools, 0);
});

test("enabled, it registers one deferred, sequential schedule tool", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);
  assert.equal(ui.tools.length, 1);
  assert.equal(ui.tools[0].name, "schedule");
  assert.equal(ui.tools[0].exposure, "deferred", "costs no context until tool_search loads it");
  assert.equal(ui.tools[0].executionMode, "sequential", "it mutates the shared timer list");
  assert.deepEqual(Object.keys(ui.commands).sort(), ["loop", "once"], "the commands are unchanged");
});

test("settings can expose the tool directly", async (t) => {
  const ui = await mount({ config: { enable: [TOOL_OPT_IN], [TOOL_OPT_IN]: { exposure: "direct" } } });
  t.after(ui.shutdown);
  assert.equal(ui.tools[0].exposure, "direct");
});

test("the tool sets a one-shot the user can see and /once list shows", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);

  const result = await ui.tool({ action: "once", when: "15m", prompt: "check the deploy" });
  assert.match(textOf(result), /next in 15m/);
  const [task] = latestTasks(ui);
  assert.equal(task.kind, "once");
  assert.equal(task.prompt, "check the deploy");
  assert.equal(task.source, "agent");
  assert.ok(Math.abs(task.nextRunAt - (Date.now() + 900_000)) < 5_000);
  assert.match(ui.notices.at(-1).message, /Scheduled .* once at/, "the user is told");

  await ui.run("once", "list");
  assert.match(ui.notices.at(-1).message, /check the deploy/);
});

test("the tool sets loops and lists every timer, the user's included", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);

  await ui.run("loop", "1h user loop");
  await ui.tool({ action: "loop", every: "5m", prompt: "poll CI" });
  const listed = textOf(await ui.tool({ action: "list" }));
  assert.match(listed, /every 1h .* set by user · "user loop"/);
  assert.match(listed, /every 5m .* set by agent · "poll CI"/);
});

test("the tool cancels, pauses and resumes by id prefix or all", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);

  await ui.tool({ action: "loop", every: "5m", prompt: "a" });
  await ui.tool({ action: "loop", every: "10m", prompt: "b" });
  const [a, b] = latestTasks(ui);

  assert.match(textOf(await ui.tool({ action: "pause", id: "all" })), /Paused .*\n.*Paused/);
  assert.ok(latestTasks(ui).every((task) => task.paused));

  assert.match(textOf(await ui.tool({ action: "resume", id: a.id.slice(0, 6) })), new RegExp(`Resumed ${a.id}`));
  assert.equal(latestTasks(ui).find((task) => task.id === a.id).paused, false);

  assert.equal(textOf(await ui.tool({ action: "cancel", id: b.id })), `Cancelled ${b.id}`);
  assert.deepEqual(latestTasks(ui).map((task) => task.id), [a.id]);
});

test("bad tool input fails the call instead of scheduling anything", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);

  await assert.rejects(ui.tool({ action: "once", prompt: "x" }), /once needs `when`/);
  await assert.rejects(ui.tool({ action: "once", when: "someday", prompt: "x" }), /Could not read "someday"/);
  await assert.rejects(ui.tool({ action: "loop", every: "10s", prompt: "x" }), /at least 1m/);
  await assert.rejects(ui.tool({ action: "loop", every: "5m" }), /loop needs a `prompt`/);
  await assert.rejects(ui.tool({ action: "cancel", id: "nope" }), /No session task matches nope/);
  assert.deepEqual(latestTasks(ui), []);
});

test("without an interactive session the tool refuses to set timers that could never fire", async (t) => {
  const ui = await mount({ ...withTool, hasUI: false });
  t.after(ui.shutdown);
  await assert.rejects(ui.tool({ action: "once", when: "5m", prompt: "x" }), /interactive session/);
  assert.match(textOf(await ui.tool({ action: "list" })), /No timers/);
});

test("an agent's timer fires labelled as its own; a user's fires verbatim", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);

  await ui.tool({ action: "once", when: new Date(Date.now() + 30).toISOString(), prompt: "look at CI" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ui.sent.length, 1);
  assert.match(ui.sent[0], /^\[Scheduled task [0-9a-f]{8} \(one-shot\) that you set with the schedule tool fired\]\nlook at CI$/);

  const user = { id: "u", kind: "once", prompt: "verbatim", createdAt: 0, nextRunAt: 0 };
  assert.equal(deliveryText(user), "verbatim");
});

test("the tool quotes prompts, so trailing punctuation never doubles up", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);
  const text = textOf(await ui.tool({ action: "once", when: "5m", prompt: 'Say "done".' }));
  assert.ok(text.includes('· "Say \\"done\\".". It fires'), text);
  assert.doesNotMatch(text, /\.\. /);
});

test("the footer status is plain text: no emoji", async (t) => {
  assert.equal(timerStatusText(0, 0), undefined);
  assert.equal(timerStatusText(1, 0), "1 timer");
  assert.equal(timerStatusText(2, 1), "2 timers · 1 paused");
  assert.equal(timerStatusText(0, 3), "3 paused");

  const ui = await mount();
  t.after(ui.shutdown);
  await ui.run("loop", "5m a");
  await ui.run("loop", "5m b");
  await ui.run("loop", `pause ${latestTasks(ui)[0].id}`);
  assert.deepEqual(ui.statuses.at(-1), { key: "session-scheduler", value: "1 timer · 1 paused" });
});

test("emits scheduler:tasks with a display-safe view on start, every change and shutdown", async () => {
  const restored = { id: "r1", kind: "interval", prompt: "restored task", createdAt: 0, nextRunAt: Date.now() + 600_000, intervalMs: 600_000 };
  const ui = await mount({ branch: [snapshot("session-a", [restored])] });
  const events = () => ui.emitted.filter((e) => e.name === "scheduler:tasks").map((e) => e.data);
  assert.deepEqual(events().at(-1).map((v) => v.id), ["r1"], "session_start sends the restored timers");

  const long = "check the deploy and the long tail of things that follow it\nPRIVATE second line with a token";
  await ui.run("loop", `5m ${long}`);
  const [, view] = events().at(-1);
  assert.deepEqual(Object.keys(view).sort(), ["every", "id", "kind", "last", "name", "next", "source", "status"]);
  assert.equal(view.name, "check the deploy and the long tail of t\u2026");
  assert.equal(view.name.length, 40);
  assert.deepEqual([view.kind, view.every, view.status, view.source, view.last], ["interval", "every 5m", "armed", "session", null]);
  assert.ok(Date.parse(view.next) > Date.now());
  assert.equal(JSON.stringify(events()).includes("PRIVATE"), false, "never the full prompt");

  const count = events().length;
  ui.handlers.agent_settled?.({}, ui.ctx);
  assert.equal(events().length, count, "nothing changed: not re-sent");

  await ui.run("loop", `pause ${view.id}`);
  const paused = events().at(-1).find((v) => v.id === view.id);
  assert.deepEqual([paused.status, paused.next], ["paused", null]);

  let replied;
  ui.pi.events.emit("scheduler:list", { reply: (list) => (replied = list) });
  assert.deepEqual(replied.map((v) => v.id), ["r1", view.id], "answers scheduler:list");

  await ui.shutdown();
  assert.deepEqual(events().at(-1), [], "shutdown clears them");
});

// ── wake flag and misfire flags ──

test("flags are parsed as whole tokens and the rest of the line is untouched", () => {
  const parsed = parseTimerFlags("--wake=always 15m :: check CI\nand the deploy");
  assert.equal(parsed.wake, "always");
  assert.equal(parsed.rest, "15m :: check CI\nand the deploy", "the prompt keeps its newline");

  assert.equal(parseTimerFlags("--wake 15m x").wake, "crash");
  assert.equal(parseTimerFlags("15m x --no-wake").clearWake, true);
  assert.equal(parseTimerFlags("--misfire=6h 15m x").misfire, 21_600_000);
  assert.equal(parseTimerFlags("--misfire=skip 15m x").misfire, "skip");
  assert.equal(parseTimerFlags("--misfire=always 15m x").misfire, "always");
  assert.equal(parseTimerFlags("15m explain --frobnicate").rest, "15m explain --frobnicate", "unknown flags stay in the prompt");
  assert.throws(() => parseTimerFlags("--wake=sometimes 15m x"), /--wake wants/);
  assert.throws(() => parseTimerFlags("--misfire=soon 15m x"), /--misfire wants/);
});

test("/once --wake sets crash, --wake=always sets always, and /loop takes both", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "--wake 15m ping");
  await ui.run("loop", "--wake=always 5m tick");
  await ui.run("once", "30m plain");
  assert.deepEqual(latestTasks(ui).map((task) => [task.wake, task.prompt]), [
    ["crash", "ping"],
    ["always", "tick"],
    [undefined, "plain"],
  ]);
  assert.match(ui.notices.find((entry) => /Looping .* wake always/.test(entry.message)).message, /wake always/);

  await ui.run("loop", "list");
  const listed = ui.notices.at(-1).message;
  assert.match(listed, /· wake ·/, "wake crash reads as 'wake'");
  assert.match(listed, /· wake always ·/);
});

test("edit keeps the wake level, and --no-wake clears it", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);

  await ui.run("once", "--wake=always 15m ping");
  const id = latestTasks(ui)[0].id;

  await ui.run("once", `edit ${id} 30m ping again`);
  assert.equal(latestTasks(ui)[0].wake, "always", "an edit that says nothing keeps the level");
  assert.equal(latestTasks(ui)[0].misfire, undefined);

  await ui.run("once", `edit ${id} --no-wake 45m ping once more`);
  assert.equal(latestTasks(ui)[0].wake, undefined);
  assert.equal(latestTasks(ui)[0].prompt, "ping once more");
});

test("--misfire per task is stored and overrides the env window", async (t) => {
  const ui = await mount();
  t.after(ui.shutdown);
  await ui.run("once", "--misfire=6h 15m ping");
  assert.equal(latestTasks(ui)[0].misfire, 21_600_000);
});

test("a snapshot with an invalid wake level or misfire is rejected", async (t) => {
  const now = Date.now();
  const ui = await mount({
    branch: [snapshot("session-a", [
      { id: "badwake0", kind: "once", prompt: "x", createdAt: now, nextRunAt: now + 60_000, wake: "sometimes" },
      { id: "badmisf1", kind: "once", prompt: "y", createdAt: now, nextRunAt: now + 60_000, misfire: -5 },
      { id: "good0001", kind: "once", prompt: "z", createdAt: now, nextRunAt: now + 60_000, wake: "always", misfire: "skip" },
    ])],
  });
  t.after(ui.shutdown);

  await ui.run("once", "list");
  const listed = ui.notices.at(-1).message;
  assert.match(listed, /good0001/);
  assert.doesNotMatch(listed, /badwake0|badmisf1/);
});

// ── the due index ──

test("the index follows create, edit, pause, resume and cancel", async (t) => {
  const sessionId = "index-life";
  const sessionFile = makeSessionFile("index-life");
  const ui = await mount({ sessionId, sessionFile });
  t.after(ui.shutdown);
  const entry = () => readSessionIndex().index.sessions[sessionId];

  assert.equal(entry(), undefined, "no timers, no entry");

  await ui.run("loop", "1h check CI");
  const first = latestTasks(ui)[0];
  const created = entry();
  assert.equal(created.count, 1);
  assert.equal(created.sessionFile, sessionFile);
  assert.equal(created.pid, process.pid);
  assert.equal(created.host, hostname());
  assert.ok(created.pidStart, "pid identity carries the start stamp");
  assert.equal(created.wake, undefined);
  assert.equal(created.nextWakeDueAt, undefined);
  assert.ok(created.liveSince <= created.updatedAt);
  assert.equal(created.nextDueAt, first.nextRunAt);
  assert.equal(statSync(indexFile()).mode & 0o777, 0o600, "private: mode 0600");
  assert.equal(statSync(schedulerDir).mode & 0o777, 0o700, "and its directory 0700");

  const before = entry().nextDueAt;
  await ui.run("loop", `edit ${first.id} 2h check CI again`);
  assert.ok(entry().nextDueAt > before, "an edit moves nextDueAt");

  await ui.run("once", "--wake=always 3h wake me");
  assert.equal(entry().count, 2);
  assert.equal(entry().wake, "always", "the strongest level wins");
  const wakeTask = latestTasks(ui).find((task) => task.wake === "always");
  assert.equal(entry().nextWakeDueAt, wakeTask.nextRunAt, "the earliest wake timer, not the earliest timer");

  await ui.run("loop", "pause all");
  assert.equal(entry(), undefined, "no unpaused timers: the entry is removed");

  await ui.run("loop", "resume all");
  assert.equal(entry().count, 2, "and comes back when they are resumed");

  await ui.run("loop", "clear yes");
  assert.equal(entry(), undefined, "cleared timers leave no entry");
});

test("the index never contains a prompt", async (t) => {
  const sessionId = "index-secret";
  const ui = await mount({ sessionId, sessionFile: makeSessionFile("index-secret") });
  t.after(ui.shutdown);
  const secret = "rotate the PRIVATE token";
  await ui.run("loop", `5m ${secret}`);
  await ui.run("once", `2h ${secret} again`);

  const raw = readFileSync(indexFile(), "utf8");
  assert.match(raw, new RegExp(sessionId));
  assert.equal(raw.includes("PRIVATE"), false, "the index is metadata only");
});

test("an ephemeral session is not indexed", async (t) => {
  const sessionId = "index-ephemeral";
  const ui = await mount({ sessionId, sessionFile: null });
  t.after(ui.shutdown);

  await ui.run("loop", "1h check CI");
  assert.equal(readSessionIndex().index.sessions[sessionId], undefined);
});

test("a session is indexed once its file exists, retried on the first reply", async (t) => {
  const sessionId = "index-unflushed";
  const dir = mkdtempSync(join(tmpdir(), "session-scheduler-unflushed-"));
  const notYet = join(dir, "session.jsonl");
  const ui = await mount({ sessionId, sessionFile: notYet });
  t.after(ui.shutdown);

  await ui.run("loop", "1h check CI");
  assert.equal(readSessionIndex().index.sessions[sessionId], undefined, "pi has not written the file yet");

  writeFileSync(notYet, "");
  await ui.settle();
  assert.equal(readSessionIndex().index.sessions[sessionId]?.sessionFile, notYet, "the first reply flushes it, and then it is indexed");
});

test("shutdown for any reason clears the pid and records when", async () => {
  for (const reason of ["quit", "resume", "fork", "new", "reload"]) {
    const sessionId = `index-shutdown-${reason}`;
    const ui = await mount({ sessionId, sessionFile: makeSessionFile(reason) });
    await ui.run("loop", "1h check CI");
    assert.ok(readSessionIndex().index.sessions[sessionId].pid, `${reason}: live before shutdown`);
    await ui.shutdown(reason);
    const entry = readSessionIndex().index.sessions[sessionId];
    assert.equal(entry.pid, undefined, `${reason} must not keep claiming the session`);
    assert.equal(entry.pidStart, undefined);
    assert.ok(entry.closedAt > 0, `${reason} records closedAt`);
  }
});

test("an entry is pruned only when its file is gone and its pi is dead", () => {
  const alive = makeSessionFile("prune-alive");
  const gone = join(mkdtempSync(join(tmpdir(), "session-scheduler-gone-")), "missing.jsonl");
  const base = { cwd: "/tmp", host: hostname(), liveSince: 1, count: 1, updatedAt: 1, nextDueAt: 1 };

  updateSessionIndex("prune-alive", { ...base, sessionFile: alive, pid: process.pid, pidStart: processStart(process.pid) });
  updateSessionIndex("prune-gone", { ...base, sessionFile: gone, pid: 999_999, pidStart: "Thu Jan  1 00:00:00 1970" });
  // Something else writes: the dead entry goes, the live one stays.
  updateSessionIndex("prune-writer", { ...base, sessionFile: makeSessionFile("prune-writer"), pid: process.pid });

  const sessions = readSessionIndex().index.sessions;
  assert.ok(sessions["prune-alive"], "a live session is never pruned");
  assert.equal(sessions["prune-gone"], undefined, "a missing file plus a dead pid is pruned");
  assert.ok(sessions["prune-writer"]);
});

test("a session held by another live pi is not caught up here", async (t) => {
  // A real live process on this host, but not us.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => other.kill());
  await new Promise((resolve) => setTimeout(resolve, 50));
  const otherStart = processStart(other.pid);
  assert.ok(otherStart, "ps found the other process");

  const sessionId = "index-held-elsewhere";
  const sessionFile = makeSessionFile("held");
  const now = Date.now();
  updateSessionIndex(sessionId, {
    sessionFile, cwd: "/tmp", host: hostname(), liveSince: now, count: 1, updatedAt: now,
    pid: other.pid, pidStart: otherStart, nextDueAt: now - 300_000,
  });
  assert.equal(sessionHeldElsewhere(sessionId), true);

  const ui = await mount({
    sessionId,
    sessionFile,
    branch: [snapshot(sessionId, [{ id: "held0000", kind: "once", prompt: "the other pi's business", createdAt: now - 600_000, nextRunAt: now - 300_000 }])],
  });
  t.after(ui.shutdown);
  assert.deepEqual(ui.sent, [], "two live pis must not both deliver it");

  other.kill();
  assert.equal(sessionHeldElsewhere(sessionId), false, "a dead holder does not count");
});

test("a corrupt index is moved aside and rebuilt", () => {
  mkdirSync(schedulerDir, { recursive: true });
  writeFileSync(indexFile(), "{ this is not json");
  const result = updateSessionIndex("corrupt-1", {
    sessionFile: makeSessionFile("corrupt"), cwd: "/tmp", host: hostname(), liveSince: 1, count: 1, updatedAt: 1, nextDueAt: 1,
  });

  assert.equal(result.error, undefined);
  assert.ok(readSessionIndex().index.sessions["corrupt-1"], "starts empty and writes this entry");
  const quarantined = readdirSync(schedulerDir).filter((name) => name.startsWith("session-timers.json.corrupt-"));
  assert.equal(quarantined.length, 1, "the unreadable file is kept, not deleted");
});

test("concurrent writers lose no entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-scheduler-race-"));
  const script = join(dir, "writer.mjs");
  writeFileSync(script, [
    "import { updateSessionIndex } from " + JSON.stringify(new URL("../extensions/lib/session-index.ts", import.meta.url).href) + ";",
    "const [id, file] = process.argv.slice(2);",
    "const now = Date.now();",
    "updateSessionIndex(id, { sessionFile: file, cwd: '/tmp', host: 'concurrency-test', liveSince: now, count: 1, updatedAt: now, nextDueAt: now });",
  ].join("\n"));

  const writers = Array.from({ length: 8 }, (_, index) => index);
  await Promise.all(writers.map((index) => {
    const file = makeSessionFile(`race-${index}`);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, `race-${index}`, file], {
        stdio: "inherit",
        env: { ...process.env, PI_SCHEDULER_DIR: schedulerDir },
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${index} exited ${code}`))));
    });
  }));

  const sessions = readSessionIndex().index.sessions;
  for (const index of writers) {
    assert.ok(sessions[`race-${index}`], `writer ${index} kept its entry`);
  }
});

test("the index builder refuses an empty entry", () => {
  assert.equal(
    planIndexEntry({ sessionFile: "/tmp/x", cwd: "/tmp", liveSince: 1, count: 0 }, 1_000),
    undefined,
    "no unpaused tasks, no entry",
  );
  assert.equal(
    planIndexEntry({ sessionFile: "", cwd: "/tmp", liveSince: 1, count: 1 }, 1_000),
    undefined,
    "no session file, no entry",
  );
  const entry = planIndexEntry({ sessionFile: "/tmp/x", cwd: "/tmp", liveSince: 1, count: 1, wake: "crash", nextDueAt: 7, nextWakeDueAt: 7 }, 1_000);
  assert.deepEqual(
    { count: entry.count, wake: entry.wake, nextDueAt: entry.nextDueAt, updatedAt: entry.updatedAt, pid: entry.pid },
    { count: 1, wake: "crash", nextDueAt: 7, updatedAt: 1_000, pid: undefined },
  );
});

// ── live timers across a sleep ──

/** Swap in a setTimeout that records instead of arming; returns the undo. */
function captureTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;
  const scheduled = [];
  globalThis.setTimeout = (fn, delay) => {
    // Anything short is the scheduler's own plumbing (the deferred first drain,
    // the test's own sleeps): run it for real so mounting still works.
    if (delay <= 100) return realSetTimeout(fn, delay);
    const handle = { fn, delay, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  globalThis.clearTimeout = () => {};
  return {
    scheduled,
    jump(ms) { Date.now = () => realNow() + ms; },
    undo() {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

test("a live timer waits in 60s chunks and re-checks the clock", async (t) => {
  const task = { id: "chunk000", kind: "interval", prompt: "tick", createdAt: Date.now(), nextRunAt: Date.now() + 3_600_000, intervalMs: 3_600_000 };
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  const fake = captureTimers();
  t.after(fake.undo);
  await ui.run("loop", "1h other");
  assert.equal(fake.scheduled.at(-1).delay, 60_000, "an hour is armed in one-minute chunks");

  fake.scheduled.at(-1).fn();
  assert.equal(fake.scheduled.at(-1).delay, 60_000, "an early chunk re-arms instead of firing");
  assert.deepEqual(ui.sent, []);
});

test("a live fire after a long sleep carries the late prefix", async (t) => {
  const now = Date.now();
  const task = { id: "sl33p000", kind: "once", prompt: "wake up", createdAt: now, nextRunAt: now + 600_000 };
  const fake = captureTimers();
  t.after(fake.undo);
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  fake.jump(2 * 3_600_000);
  fake.scheduled.filter((handle) => handle.fn).at(-1).fn();

  assert.equal(ui.sent.length, 1);
  assert.match(ui.sent[0], /^\[Scheduled task sl33p000 was due at .+, 1h\d+m late \(1 missed run\) because this session was not open\]\nwake up$/);
});

test("a live fire past the cap is skipped with a notice", async (t) => {
  const now = Date.now();
  const task = { id: "s10ppped", kind: "once", prompt: "too old", createdAt: now, nextRunAt: now + 600_000 };
  const fake = captureTimers();
  t.after(fake.undo);
  const ui = await mount({ branch: [snapshot("session-a", [task])] });
  t.after(ui.shutdown);

  fake.jump(30 * 3_600_000);
  fake.scheduled.filter((handle) => handle.fn).at(-1).fn();

  assert.deepEqual(ui.sent, [], "a 30h-late fire is past the 24h cap");
  assert.match(ui.notices.at(-1).message, /Skipped s10ppped/);
  assert.deepEqual(latestTasks(ui), [], "and the one-shot is gone rather than left overdue");
});

// ── the tool's wake parameter ──

test("the tool refuses wake unless the opt-in allows it", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);
  assert.equal("wake" in ui.tools[0].parameters.properties, false, "the parameter is not even declared");

  await assert.rejects(
    ui.tool({ action: "once", when: "15m", prompt: "x", wake: "always" }),
    /not allowed to set wake/,
  );
  assert.deepEqual(latestTasks(ui), []);
});

test("allowWake exposes the parameter, and true means crash", async (t) => {
  const ui = await mount({ config: { enable: [TOOL_OPT_IN], [TOOL_OPT_IN]: { allowWake: true } } });
  t.after(ui.shutdown);
  assert.ok("wake" in ui.tools[0].parameters.properties, "declared when the user allowed it");

  await ui.tool({ action: "once", when: "15m", prompt: "remind me", wake: true });
  await ui.tool({ action: "loop", every: "5m", prompt: "poll", wake: "always" });
  assert.deepEqual(latestTasks(ui).map((task) => task.wake), ["crash", "always"]);

  await assert.rejects(ui.tool({ action: "once", when: "15m", prompt: "x", wake: "sometimes" }), /wake wants/);
});

test("the tool's misfire parameter accepts skip, always or a duration", async (t) => {
  const ui = await mount(withTool);
  t.after(ui.shutdown);

  await ui.tool({ action: "once", when: "15m", prompt: "a", misfire: "6h" });
  await ui.tool({ action: "once", when: "15m", prompt: "b", misfire: "skip" });
  assert.deepEqual(latestTasks(ui).map((task) => task.misfire), [21_600_000, "skip"]);
  await assert.rejects(ui.tool({ action: "once", when: "15m", prompt: "c", misfire: "soon" }), /Could not read misfire/);
});
