/**
 * The canvas extension's settle path. pi awaits every agent_settled handler in
 * load order, so the canvas one must return at once and leave reply/info reads
 * and the widget diffs to a macrotask (botsun-owner's idle comes after it). And
 * a settle must not spawn a git diff for, or rewrite the patch of, a tracked
 * file nothing touched.
 *
 *   node --test test/canvas-settle.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

// index.ts reads PI_CANVAS_PORT once, at import: a port and a root of this
// file's own, so a fire-and-forget ensureDaemon can never reach the live daemon
// or ~/.pi/canvas.
const PORT = await freePort();
process.env.PI_CANVAS_PORT = String(PORT);
const ROOT = mkdtempSync(join(tmpdir(), "canvas-settle-root-"));
process.env.PI_CANVAS_ROOT = ROOT;
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_CANVAS;
const canvas = await import("../extensions/canvas/index.ts");

after(() => {
  // A daemon a stray ensureDaemon started there: stop exactly that pid.
  try {
    const { pid, port } = JSON.parse(readFileSync(join(ROOT, ".daemon.json"), "utf8"));
    if (port === PORT && Number.isInteger(pid)) process.kill(pid, "SIGTERM");
  } catch {}
  rmSync(ROOT, { recursive: true, force: true });
});

/** A `git` first on PATH that appends its arguments to log, then runs the real one. */
function countingGit(log) {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "canvas-settle-bin-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  return bin;
}

const calls = (log) => {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
/** The git diff --no-index spawns: one per tracked file updateWidgets re-diffs. */
const diffs = (log) => calls(log).filter((l) => l.includes("--no-index"));

async function until(ok, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await sleep(20);
  }
  throw new Error("timed out");
}

const msg = (role, content, extra = {}) => ({ type: "message", message: { role, content, ...extra } });
/** A turn that edited each path, the way the transcript reads after one. */
const editTurn = (paths) => [
  msg("user", "edit them"),
  msg("assistant", [{ type: "text", text: "done" }, ...paths.map((p, i) => ({ type: "toolCall", id: `c${i}`, name: "edit", arguments: { path: p } }))]),
];
const idleTurn = (text) => [msg("user", text), msg("assistant", [{ type: "text", text: "ok" }])];

/** A pi that keeps every handler for an event, in registration (load) order. */
function stubPi() {
  const handlers = new Map();
  const noop = () => {};
  const pi = new Proxy(
    {
      on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
      events: { on: () => () => {}, emit: () => {} },
      getSessionName: () => "",
      getThinkingLevel: () => "off",
      registerTool: noop,
      registerCommand: noop,
      registerShortcut: noop,
      registerFlag: noop,
    },
    { get: (t, k) => (k in t ? t[k] : noop) },
  );
  // Like pi's runner: each handler for an event, awaited in order.
  const fire = async (name, event, ctx) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };
  return { pi, handlers, fire };
}

const ctxFor = (cwd, sid, getBranch) => ({
  cwd,
  hasUI: true,
  sessionManager: { getSessionId: () => sid, getBranch: () => getBranch() },
  modelRegistry: {},
  ui: { notify() {}, setStatus() {}, setWidget() {} },
  getContextUsage: () => undefined,
});

/** A work folder of n tracked (edited) files, a git-call log, and the ctx around them. */
function workspace(sid, n) {
  const cwd = mkdtempSync(join(tmpdir(), "canvas-settle-work-"));
  const log = join(cwd, ".git-calls");
  writeFileSync(log, "");
  const paths = Array.from({ length: n }, (_, i) => {
    const p = join(cwd, `f${i}.txt`);
    writeFileSync(p, `one\n${i}\n`);
    return p;
  });
  const state = { branch: editTurn(paths) };
  const ctx = ctxFor(cwd, sid, () => state.branch);
  const dir = join(ROOT, sid);
  const idx = () => JSON.parse(readFileSync(join(dir, "auto-diffs.json"), "utf8"));
  return { cwd, log, paths, state, ctx, dir, idx };
}

test("a settle re-diffs nothing and rewrites no patch when no tracked file changed", async () => {
  const N = 12;
  const w = workspace("settle-a", N);
  const bin = countingGit(w.log);
  const wasPath = process.env.PATH;
  process.env.PATH = `${bin}:${wasPath}`;
  try {
    const { pi, fire } = stubPi();
    await canvas.default(pi);
    await fire("session_start", { reason: "new" }, w.ctx);
    // The tool_call snapshots the base, then the edit lands, as pi does it.
    for (const [i, p] of w.paths.entries()) {
      await fire("tool_call", { toolName: "edit", input: { path: p } }, w.ctx);
      writeFileSync(p, `one\n${i}\nedited\n`);
    }

    // First settle: every tracked file has no stamp yet, so each gets one diff and a patch.
    await fire("agent_settled", { aborted: false }, w.ctx);
    await until(() => diffs(w.log).length >= N);
    await until(() => Object.values(w.idx()).every((e) => e.mtimeMs !== undefined));
    await sleep(100);
    assert.equal(diffs(w.log).length, N, "one diff per tracked file, the first time");
    const patches = Object.values(w.idx()).map((e) => join(w.dir, e.patch));
    assert.equal(patches.length, N);
    const stamp = () => patches.map((p) => `${statSync(p).mtimeMs}:${statSync(p).size}`);
    const before = stamp();
    assert.ok(readFileSync(patches[0], "utf8").includes("--- a/f0.txt"), "the patch is the page's diff");

    // Second settle: a new turn with no edits, and nothing on disk moved.
    w.state.branch = [...w.state.branch, ...idleTurn("thanks")];
    await fire("agent_settled", { aborted: false }, w.ctx);
    // Its macrotask has run and the serial chain drained by now.
    await sleep(100);
    assert.equal(diffs(w.log).length, N, "unchanged files spawn no git diff at all");
    assert.deepEqual(stamp(), before, "and no patch file was rewritten");

    // Third settle: one file changed and is in this turn's ops, so it alone is re-diffed.
    writeFileSync(w.paths[0], "one\n0\nnew line\n");
    w.state.branch = [...w.state.branch, msg("user", "again"), msg("assistant", [{ type: "text", text: "ok" }, { type: "toolCall", id: "c9", name: "edit", arguments: { path: w.paths[0] } }])];
    await fire("agent_settled", { aborted: false }, w.ctx);
    await until(() => diffs(w.log).length >= N + 1);
    await sleep(100);
    assert.equal(diffs(w.log).length, N + 1, "only the file that changed is re-diffed");
    assert.match(readFileSync(patches[0], "utf8"), /\n\+new line/, "its patch is the new diff");
    assert.ok(statSync(patches[0]).mtimeMs > Number(before[0].split(":")[0]), "and it was rewritten");
    assert.deepEqual(stamp().slice(1), before.slice(1), "the other patches were left alone");
  } finally {
    process.env.PATH = wasPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(w.cwd, { recursive: true, force: true });
  }
});

test("agent_settled returns before the deferred widget work starts", async () => {
  const w = workspace("settle-b", 3);
  const bin = countingGit(w.log);
  const wasPath = process.env.PATH;
  process.env.PATH = `${bin}:${wasPath}`;
  try {
    const { pi, fire } = stubPi();
    await canvas.default(pi);
    await fire("session_start", { reason: "new" }, w.ctx);
    for (const p of w.paths) await fire("tool_call", { toolName: "edit", input: { path: p } }, w.ctx);

    // A handler registered after canvas's, the way botsun-owner's is after it.
    const seen = {};
    pi.on("agent_settled", () => {
      seen.diffs = diffs(w.log).length;
      seen.reply = existsSync(join(w.dir, "reply.json"));
    });
    const t0 = performance.now();
    await fire("agent_settled", { aborted: false }, w.ctx);
    const took = performance.now() - t0;
    assert.ok(took < 50, `the handler returned in ${took.toFixed(1)} ms`);
    assert.equal(seen.diffs, 0, "no git diff had started when the later handler ran");
    assert.equal(seen.reply, false, "and neither had the branch read behind reply.json");

    // Deferred, not dropped: the work lands a tick later.
    await until(() => diffs(w.log).length >= 3);
    await until(() => existsSync(join(w.dir, "reply.json")));
    assert.match(readFileSync(join(w.dir, "reply.json"), "utf8"), /done/);
  } finally {
    process.env.PATH = wasPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(w.cwd, { recursive: true, force: true });
  }
});

/** A `git` first on PATH that logs, and on its first call copies `from` over `to` (then never
 * again): a way to change a tracking JSON at exactly the moment the diffs are in flight. */
function mutatingGit(log, from, to) {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "canvas-settle-bin-"));
  const once = join(bin, "done");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n` +
      `if [ ! -f ${JSON.stringify(once)} ]; then : > ${JSON.stringify(once)}; cp ${JSON.stringify(from)} ${JSON.stringify(to)}; fi\n` +
      `exec ${JSON.stringify(real)} "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

test("a run that starts before the deferred settle can't take the settled turn's ops", async () => {
  const w = workspace("settle-c", 2);
  try {
    const { pi, fire } = stubPi();
    await canvas.default(pi);
    await fire("session_start", { reason: "new" }, w.ctx);
    for (const [i, p] of w.paths.entries()) {
      await fire("tool_call", { toolName: "edit", input: { path: p } }, w.ctx);
      writeFileSync(p, `one\n${i}\nedited\n`);
    }

    const settled = fire("agent_settled", { aborted: false }, w.ctx);
    // Before the timer runs: the next run starts (botsun-owner's afterStop, the scheduler,
    // goal, agent-link) and its user entry is on the branch.
    w.state.branch = [...w.state.branch, msg("user", "next run, no edits yet"), msg("assistant", [{ type: "text", text: "on it" }])];
    await settled;

    // The settled turn's ops still reach Files changed: they were read in the handler, not in the
    // timer, where lastTurn would have handed back the new, empty turn.
    await until(() => existsSync(join(w.dir, "auto-files.json")));
    const files = JSON.parse(readFileSync(join(w.dir, "auto-files.json"), "utf8"));
    assert.deepEqual(Object.keys(files).sort(), [...w.paths].sort(), "both edited files are tracked");
    await until(() => Object.values(w.idx()).every((e) => e.adds !== undefined));
    assert.ok(Object.values(w.idx()).every((e) => e.adds >= 1), "and each got its diff");
    const card = JSON.parse(readFileSync(join(w.dir, "sections.json"), "utf8")).find((s) => s.id === "auto-files");
    assert.match(readFileSync(join(w.dir, card.file), "utf8"), /f0\.txt/, "the card lists them too");
  } finally {
    rmSync(w.cwd, { recursive: true, force: true });
  }
});

test("the diff merge keeps a fresher entry and never resurrects a deleted one", async () => {
  const w = workspace("settle-d", 2);
  const [f0, f1] = w.paths;
  try {
    const { pi, fire } = stubPi();
    await canvas.default(pi);
    await fire("session_start", { reason: "new" }, w.ctx);
    for (const [i, p] of w.paths.entries()) {
      await fire("tool_call", { toolName: "edit", input: { path: p } }, w.ctx);
      writeFileSync(p, `one\n${i}\nedited\n`);
    }
    // What the prune does mid-diff: one entry gone, and another rewritten by a fresher read
    // (snapshotBase only writes when absent, so a base it recorded during the diffs must stand).
    const fresh = { ...w.idx() };
    assert.ok(fresh[f0] && fresh[f1], "snapshotBase tracked both before the settle");
    delete fresh[f1];
    fresh[f0] = { ...fresh[f0], base: "base-fresh", patch: "diff-fresh.patch" };
    const freshPath = join(w.cwd, "fresh.json");
    writeFileSync(freshPath, JSON.stringify(fresh, null, 2));
    const bin = mutatingGit(w.log, freshPath, join(w.dir, "auto-diffs.json"));
    const wasPath = process.env.PATH;
    process.env.PATH = `${bin}:${wasPath}`;
    try {
      await fire("agent_settled", { aborted: false }, w.ctx);
      await until(() => diffs(w.log).length >= 2);
      await sleep(150); // the merge, the copies and the card are behind the diffs

      const idx = w.idx();
      assert.equal(idx[f0].base, "base-fresh", "the fresher base was not overwritten by the stale one");
      assert.equal(idx[f0].patch, "diff-fresh.patch");
      assert.equal(typeof idx[f0].adds, "number", "but the measured fields did land");
      assert.equal(typeof idx[f0].mtimeMs, "number");
      assert.equal(idx[f1], undefined, "an entry deleted during the diffs is not resurrected");
    } finally {
      process.env.PATH = wasPath;
      rmSync(bin, { recursive: true, force: true });
    }
  } finally {
    rmSync(w.cwd, { recursive: true, force: true });
  }
});
