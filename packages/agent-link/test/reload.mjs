// Remote reload: a control frame asks a session to run pi's /reload.
//
// Two layers: the decision logic (reload.ts) against a fake host, then the
// real extension (index.ts) against a stub pi, with throwaway peers on real
// sockets in a throwaway HOME, so nothing here reaches a live session.
//   node --experimental-strip-types --test test/reload.mjs
// index.ts imports typebox, so run `scripts/typecheck.sh --link-only` first.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "al-reload-"));
process.env.HOME = home;
process.env.XDG_CACHE_HOME = path.join(home, ".cache");
const REG = path.join(home, ".claude", "sessions");
mkdirSync(REG, { recursive: true });

// CLAUDE_REGISTRY is fixed from HOME at import, so HOME comes first.
const P = await import("../claude-protocol.ts");
const R = await import("../reload.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(10); }
  return false;
}

// ---------------------------------------------------------------- decision logic

function fakeHost(over = {}) {
  const host = {
    idle: true, draft: "", clock: 1_000_000, dispatched: 0, notes: [],
    isIdle: () => host.idle,
    editorText: () => host.draft,
    dispatch: () => { host.dispatched++; },
    notify: (m) => host.notes.push(m),
    now: () => host.clock,
    ...over,
  };
  return host;
}
const controller = (host, rateMs) => new R.ReloadController(host, { shared: { lastAcceptedAt: 0 }, rateMs });

test("idle: dispatches now and answers 'reloaded' only from the reload command", async () => {
  const host = fakeHost();
  const c = controller(host);
  const replies = [];
  c.request({ who: "peer", reply: (o) => replies.push(o) });
  assert.equal(host.dispatched, 1);
  assert.deepEqual(replies, [], "nothing until the command runs");
  await c.beforeReload();
  assert.deepEqual(replies, [{ status: "reloaded" }]);
  await c.beforeReload();
  assert.equal(replies.length, 1, "each answer is paid once");
});

test("busy: answers 'queued', then reloads at agent_settled", () => {
  const host = fakeHost({ idle: false });
  const c = controller(host);
  const replies = [];
  c.request({ who: "peer", reply: (o) => replies.push(o) });
  assert.deepEqual(replies, [{ status: "queued" }]);
  assert.equal(R.describeOutcome(replies[0]), "queued (busy, reloads when the turn ends)");
  assert.equal(host.dispatched, 0, "never mid-run");
  host.idle = true;
  c.settled();
  assert.equal(host.dispatched, 1);
  c.settled();
  assert.equal(host.dispatched, 1, "once");
});

test("unsent editor text refuses; force overrides", () => {
  const host = fakeHost({ draft: "half a thought" });
  const c = controller(host);
  const replies = [];
  c.request({ who: "peer", reply: (o) => replies.push(o) });
  assert.equal(replies[0].status, "refused");
  assert.match(R.describeOutcome(replies[0]), /has unsent text in its editor/);
  assert.equal(host.dispatched, 0);
  c.request({ who: "peer", force: true, reply: (o) => replies.push(o) });
  assert.equal(host.dispatched, 1, "a refusal doesn't use up the rate limit, so force works at once");
});

test("a draft typed during the turn cancels the queued reload", () => {
  const host = fakeHost({ idle: false });
  const c = controller(host);
  c.request({ who: "peer", reply: () => {} });
  host.idle = true;
  host.draft = "typed while busy";
  c.settled();
  assert.equal(host.dispatched, 0);
  assert.match(host.notes.at(-1), /skipped the reload peer asked for/);
});

test("rate limit: one accepted request per window", () => {
  const host = fakeHost();
  const c = controller(host, 30_000);
  const replies = [];
  c.request({ who: "a", reply: (o) => replies.push(o) });
  host.clock += 10_000;
  c.request({ who: "b", reply: (o) => replies.push(o) });
  assert.equal(replies.at(-1).status, "refused");
  assert.match(replies.at(-1).reason, /rate-limited .* try again in 20s/);
  host.clock += 20_001;
  c.request({ who: "b", reply: (o) => replies.push(o) });
  assert.equal(host.dispatched, 2);
});

test("the rate limit outlives the extension instance a reload replaces", () => {
  const shared = R.sharedReloadState();
  shared.lastAcceptedAt = 0;
  const host = fakeHost({ now: () => Date.now() });
  new R.ReloadController(host).request({ who: "a", reply: () => {} });
  const replies = [];
  new R.ReloadController(host).request({ who: "a", reply: (o) => replies.push(o) });
  assert.equal(replies[0]?.status, "refused", "a fresh instance shares the window");
  assert.equal(R.sharedReloadState(), shared);
  shared.lastAcceptedAt = 0;
});

test("self-reload waits for the response to settle", () => {
  const host = fakeHost({ idle: false });
  const c = controller(host);
  c.requestSelf();
  assert.equal(host.dispatched, 0);
  c.settled();
  assert.equal(host.dispatched, 1);
});

test("junk answers become refusals", () => {
  assert.deepEqual(R.outcomeFromFrame({ status: "reloaded" }), { status: "reloaded" });
  assert.deepEqual(R.outcomeFromFrame({ status: "refused", reason: "x" }), { status: "refused", reason: "x" });
  assert.equal(R.outcomeFromFrame({ status: "boom" }).status, "refused");
});

// ------------------------------------------------------------- real extension

const servers = [];
/**
 * A throwaway peer: registered, listening, and recording frames. `answer`
 * makes it behave like a pi that handles reload requests.
 */
async function peer({ pid, name, status = "idle", entrypoint = "pi", answer }) {
  const sock = path.join(home, `${pid}.sock`);
  const frames = [];
  const server = await P.bindSocket(sock, (frame) => {
    frames.push(frame);
    if (answer && frame.type === "control" && frame.action === "reload" && frame.from?.startsWith("uds:")) {
      P.sendFrame(frame.from.slice(4), { type: "control", action: "reload_result", req_id: frame.req_id, ...answer }).catch(() => {});
    }
  });
  servers.push(server);
  writeFileSync(path.join(REG, `${pid}.json`), JSON.stringify({
    pid, name, cwd: "/tmp/work", startedAt: pid, status, entrypoint, sessionId: `s-${pid}`, messagingSocketPath: sock,
  }));
  return { sock, frames, from: `uds:${sock}` };
}

// Registered before the extension starts, so ccSocksDir() puts its socket in this HOME too.
const sender = await peer({ pid: 910001, name: "sender", answer: { status: "reloaded" } });

function stubPi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = [];
  const sent = [];
  let activeTools = [];
  const pi = {
    on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    registerCommand: (name, options) => commands.set(name, options),
    registerTool: (tool) => tools.push(tool),
    sendUserMessage: (content, options) => { sent.push({ content, options }); },
    getActiveTools: () => activeTools,
    setActiveTools: (names) => { activeTools = names; },
    getAllTools: () => [],
    getSessionName: () => "receiver",
  };
  const fire = async (event, payload, ctx) => Promise.all((handlers.get(event) ?? []).map((fn) => fn(payload, ctx)));
  return { pi, commands, tools, sent, fire };
}

const state = { idle: true, draft: "", reloads: 0, framesAtReload: -1 };
const notes = [];
const ctx = {
  cwd: "/tmp/receiver",
  hasUI: true,
  isIdle: () => state.idle,
  sessionManager: { getSessionId: () => "s-receiver", getSessionFile: () => undefined },
  ui: {
    notify: (m, level) => notes.push([level, m]),
    getEditorText: () => state.draft,
    addAutocompleteProvider: () => {},
  },
};

const { default: extension } = await import("../index.ts");
const stub = stubPi();
extension(stub.pi);
await stub.fire("session_start", { reason: "startup" }, ctx);
const ownJson = path.join(REG, `${process.pid}.json`);
assert.ok(await until(() => existsSync(ownJson)), "the extension registered");
const target = JSON.parse((await import("node:fs")).readFileSync(ownJson, "utf8")).messagingSocketPath;

/** Stand in for pi running the dispatched command: commands bypass the model. */
async function runDispatched() {
  const cmd = stub.sent.findLast((s) => s.content === `/${R.RELOAD_COMMAND}`);
  assert.ok(cmd, "the reload command was dispatched");
  assert.equal(cmd.options?.expandPromptTemplates, true, "as a command, not a chat message");
  await stub.commands.get(R.RELOAD_COMMAND).handler("", {
    ...ctx,
    reload: async () => { await sleep(50); state.framesAtReload = sender.frames.length; state.reloads++; },
  });
}

function reset() {
  R.sharedReloadState().lastAcceptedAt = 0;
  state.idle = true; state.draft = ""; state.reloads = 0; state.framesAtReload = -1;
  stub.sent.length = 0;
  sender.frames.length = 0;
}

const ask = (extra = {}) => P.sendFrame(target, { type: "control", action: "reload", req_id: `r-${Math.random()}`, from: sender.from, ...extra });
const answers = () => sender.frames.filter((f) => f.action === "reload_result");

test("extension: a reload frame reaches no chat and answers before reloading", async () => {
  reset();
  await ask({ req_id: "one" });
  assert.ok(await until(() => stub.sent.length === 1));
  assert.equal(stub.sent.filter((s) => s.content !== `/${R.RELOAD_COMMAND}`).length, 0, "no chat message for the model");
  await runDispatched();
  assert.equal(state.reloads, 1);
  assert.ok(await until(() => answers().length === 1));
  assert.ok(state.framesAtReload >= 1, "the answer went out before ctx.reload()");
  assert.equal(answers()[0].status, "reloaded");
  assert.equal(answers()[0].req_id, "one");
});

test("extension: busy answers queued and reloads at agent_settled", async () => {
  reset();
  state.idle = false;
  await ask();
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "queued");
  assert.equal(stub.sent.length, 0, "not while busy");
  state.idle = true;
  await stub.fire("agent_settled", {}, ctx);
  await runDispatched();
  assert.equal(state.reloads, 1);
});

test("extension: unsent editor text refuses, force reloads anyway", async () => {
  reset();
  state.draft = "draft";
  await ask();
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "refused");
  assert.match(answers()[0].reason, /has unsent text in its editor/);
  assert.equal(stub.sent.length, 0);
  await ask({ force: true });
  assert.ok(await until(() => stub.sent.length === 1));
});

test("extension: a second request inside 30s is rate-limited", async () => {
  reset();
  await ask();
  await ask();
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "refused");
  assert.match(answers()[0].reason, /rate-limited/);
  assert.equal(stub.sent.length, 1, "only the first dispatched");
});

test("extension: frames from an unregistered socket are dropped", async () => {
  reset();
  const rogue = path.join(home, "rogue.sock");
  const frames = [];
  servers.push(await P.bindSocket(rogue, (f) => frames.push(f)));
  await P.sendFrame(target, { type: "control", action: "reload", req_id: "x", from: `uds:${rogue}` });
  await sleep(150);
  assert.equal(stub.sent.length, 0);
  assert.equal(frames.length, 0, "no answer to an address outside the registry");
});

const tool = () => stub.tools.find((t) => t.name === "agent-link");

test("extension: reload without 'to' reloads this session after the response", async () => {
  reset();
  state.idle = false;
  const res = await tool().execute("id", { action: "reload" });
  assert.equal(res.terminate, true, "ends the run so the reload follows");
  assert.match(res.content[0].text, /reloads once this response ends/);
  assert.equal(stub.sent.length, 0);
  state.idle = true;
  await stub.fire("agent_settled", {}, ctx);
  await runDispatched();
  assert.equal(state.reloads, 1);
});

test("extension: reload a named peer reports its answer", async () => {
  reset();
  await peer({ pid: 910010, name: "solo-busy", answer: { status: "queued" } });
  const res = await tool().execute("id", { action: "reload", to: "solo-busy" });
  assert.equal(res.content[0].text, '"solo-busy": queued (busy, reloads when the turn ends)');
});

test("extension: *idle reloads every idle pi session and lists each outcome", async () => {
  reset();
  const a = await peer({ pid: 910020, name: "idle-a", answer: { status: "reloaded" } });
  const b = await peer({ pid: 910021, name: "idle-b", answer: { status: "refused", reason: R.EDITOR_REFUSAL } });
  const busy = await peer({ pid: 910022, name: "busy-c", status: "thinking", answer: { status: "queued" } });
  const claude = await peer({ pid: 910023, name: "claude-d", entrypoint: "cli", answer: { status: "reloaded" } });
  const res = await tool().execute("id", { action: "reload", to: R.IDLE_TARGETS });
  const out = res.content[0].text;
  assert.match(out, /- idle-a: reloaded/);
  assert.match(out, /- idle-b: refused: has unsent text in its editor/);
  assert.doesNotMatch(out, /busy-c|claude-d/, "busy and non-pi sessions are left alone");
  assert.equal(busy.frames.length + claude.frames.length, 0);
  assert.equal(a.frames[0].force, false);
  assert.equal(b.frames.length, 1);
});

test.after(async () => {
  await stub.fire("session_shutdown", { reason: "quit" }, ctx);
  for (const s of servers) s.close();
});
