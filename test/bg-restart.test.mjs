import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

// Real processes end to end: an "old pi" (its own node process) starts a job
// under the exit-status wrapper and quits; this process is the pi that resumes
// the session, re-adopting the job through real ps, kill and the exit file.
const dir = mkdtempSync(path.join(tmpdir(), "pi-bg-restart-"));
process.env.PI_BG_DIR = path.join(dir, "logs");
process.env.PI_BG_STATE_DIR = path.join(dir, "state");
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_BG_WAKE = "followUp";
process.env.PI_BG_TAIL_LINES = "15";
const STATE = process.env.PI_BG_STATE_DIR;
const EXTENSION = new URL("../extensions/bg/index.ts", import.meta.url).href;
after(() => rmSync(dir, { recursive: true, force: true }));

const { default: backgroundTasks } = await import(EXTENSION);

let sessions = 0;
const sid = (label) => `${label}-${process.pid}-${++sessions}`;
const registry = (session) => path.join(STATE, `${session}.json`);

const OLD_PI = `
import { readFileSync } from "node:fs";
const { default: bg } = await import(process.argv[1]);
const handlers = new Map();
const tools = new Map();
bg({
  registerTool: (d) => tools.set(d.name, d),
  registerCommand() {},
  registerShortcut() {},
  on: (name, handler) => handlers.set(name, handler),
  sendMessage() {},
  events: { on: () => () => {}, emit() {} },
});
const session = process.env.TEST_SESSION;
const ctx = {
  cwd: process.cwd(), mode: "print", hasUI: false, ui: { notify() {}, setWidget() {} },
  sessionManager: { getSessionId: () => session, getSessionFile: () => "/nonexistent/" + session + ".jsonl" },
};
await handlers.get("session_start")({ reason: "startup" }, ctx);
const result = await tools.get("bash").execute("t", { command: process.env.TEST_COMMAND, background: true }, undefined, undefined, ctx);
const id = /bg job ([0-9a-f]{6})/.exec(result.content[0].text)[1];
// Quit only once the registry holds the wrapper's start time.
const file = process.env.PI_BG_STATE_DIR + "/" + session + ".json";
for (let i = 0; i < 250; i++) {
  try {
    const job = JSON.parse(readFileSync(file, "utf8")).jobs.find((j) => j.id === id);
    if (job?.pidStart) {
      await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      process.stdout.write(JSON.stringify(job));
      process.exit(0);
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 20));
}
process.exit(1);
`;

/** Run a pi that starts `command` as a bg job of `session` and quits; returns the job's registry entry. */
function oldPi(session, command) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", OLD_PI, EXTENSION], {
    env: { ...process.env, TEST_SESSION: session, TEST_COMMAND: command },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

/** The resuming pi: one bg instance on a fake pi with the same session. */
async function resume(t, session) {
  delete globalThis[Symbol.for("pi-boehsline.bg.handoff")];
  delete globalThis[Symbol.for("pi-boehsline.bg.live")];
  delete globalThis[Symbol.for("pi-boehsline.bg.children")];
  const handlers = new Map();
  const bus = new Map();
  const sent = [];
  const notices = [];
  backgroundTasks({
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    on: (name, handler) => handlers.set(name, handler),
    sendMessage: (message) => sent.push(message.content),
    events: { on: (channel, handler) => (bus.set(channel, handler), () => {}), emit() {} },
  });
  const ctx = {
    cwd: dir, mode: "print", hasUI: true, ui: { notify: (message) => notices.push(message), setWidget() {} },
    sessionManager: { getSessionId: () => session, getSessionFile: () => path.join(dir, `${session}.jsonl`) },
  };
  t.after(() => handlers.get("session_shutdown")({ reason: "quit" }, ctx));
  await handlers.get("session_start")({ reason: "resume" }, ctx);
  return {
    sent,
    notices,
    list: () => {
      let jobs;
      bus.get("bg:list")({ reply: (value) => (jobs = value) });
      return jobs;
    },
    kill: (id) => {
      const req = { id, reply: (r) => (req.got = r) };
      bus.get("bg:kill")(req);
      return req.got;
    },
  };
}

async function waitFor(what, done, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A job command that runs until `trigger` exists, then prints `say` and exits `code`. */
const waitsFor = (trigger, say, code) => `while [ ! -e ${trigger} ]; do sleep 0.05; done; echo ${say}; exit ${code}`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a job outlives its pi; the resumed session re-adopts it and gets its exit code from the wrapper", async (t) => {
  const session = sid("outlives");
  const go = path.join(dir, `${session}.go`);
  const job = oldPi(session, waitsFor(go, "finished", 7));
  assert.ok(alive(job.pid), "still running after its pi quit");

  const pi = await resume(t, session);
  assert.deepEqual(pi.list().map((j) => [j.id, j.endedAt]), [[job.id, undefined]], "adopted as running");
  writeFileSync(go, "");
  await waitFor("the completion wake", () => pi.sent.length > 0);
  assert.equal(pi.sent.length, 1);
  assert.match(pi.sent[0], new RegExp(`^\\[bg ${job.id}\\] \`while .*\` exited 7 after \\d+s\\n`));
  assert.match(pi.sent[0], /finished/);
  assert.equal(existsSync(`${job.logPath}.exit`), false, "consumed");
  assert.equal(existsSync(registry(session)), false, "reported, so pruned");
});

test("a job that ended while pi was down is reported once, from the status the wrapper wrote", async (t) => {
  const session = sid("ended-down");
  const go = path.join(dir, `${session}.go`);
  const job = oldPi(session, waitsFor(go, "bye", 5));
  writeFileSync(go, "");
  await waitFor("the wrapper's exit file", () => existsSync(`${job.logPath}.exit`));
  assert.equal(readFileSync(`${job.logPath}.exit`, "utf8"), "5\n");

  const pi = await resume(t, session);
  await waitFor("the report", () => pi.sent.length > 0, 2000);
  assert.match(pi.sent[0], new RegExp(`^\\[bg ${job.id}\\] .* exited 5 after \\d+s while the session was closed\\n`));
  assert.match(pi.sent[0], /bye/);
  await sleep(100);
  assert.equal(pi.sent.length, 1);
  assert.equal(existsSync(registry(session)), false);
});

test("stopping an adopted job kills its whole process group, and reports the stop", async (t) => {
  const session = sid("stop");
  const pidFile = path.join(dir, `${session}.pid`);
  const job = oldPi(session, `echo $$ > ${pidFile}; sleep 30`);
  await waitFor("the job's shell pid", () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const shell = Number(readFileSync(pidFile, "utf8"));

  const pi = await resume(t, session);
  assert.deepEqual(pi.kill(job.id), { killed: true });
  await waitFor("the stop", () => pi.notices.some((n) => n.includes(job.id)));
  assert.match(pi.notices.find((n) => n.includes(job.id)), /killed \(SIGTERM\)/);
  assert.deepEqual(pi.sent, [], "a user stop wakes no one");
  await waitFor("the group to be gone", () => !alive(job.pid) && !alive(shell), 3000);
});

test("a live pid that is not the job's wrapper (same start time, other argv) is never adopted or signalled", async (t) => {
  const session = sid("impostor");
  const impostor = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  impostor.unref();
  t.after(() => impostor.kill("SIGKILL"));
  await waitFor("the impostor", () => alive(impostor.pid));
  const start = execFileSync("ps", ["-o", "lstart=", "-p", String(impostor.pid)], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
  }).trim();
  const id = "abc123";
  const logPath = path.join(process.env.PI_BG_DIR, `${id}.log`);
  writeFileSync(logPath, "");
  const entry = { id, name: "sleep", command: "sleep 30", cwd: dir, logPath, pid: impostor.pid, pidStart: start, startedAt: Date.now(), killedByUser: false, seenAt: Date.now() };
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  writeFileSync(registry(session), JSON.stringify({ v: 1, sessionId: session, jobs: [entry] }), { mode: 0o600 });

  const pi = await resume(t, session);
  assert.equal(typeof pi.list()[0].endedAt, "number", "not adopted");
  assert.deepEqual(pi.kill(id), { killed: false });
  await sleep(2500);
  assert.ok(alive(impostor.pid), "never signalled");
  assert.match(pi.sent[0], /ended \(exit unknown\) while the session was closed/);
});

test("the wrapper never writes its status through a planted temp-file symlink", async (t) => {
  const session = sid("planted");
  const go = path.join(dir, `${session}.go`);
  const job = oldPi(session, waitsFor(go, "done", 4));
  const victim = path.join(dir, `${session}.victim`);
  writeFileSync(victim, "keep\n");
  symlinkSync(victim, `${job.logPath}.exit.tmp`);
  writeFileSync(go, "");
  await waitFor("the wrapper to end", () => !alive(job.pid));
  assert.equal(readFileSync(victim, "utf8"), "keep\n");
  assert.equal(readFileSync(`${job.logPath}.exit`, "utf8"), "4\n");

  const pi = await resume(t, session);
  await waitFor("the report", () => pi.sent.length > 0, 2000);
  assert.match(pi.sent[0], / exited 4 after \d+s while the session was closed\n/);
});
