// Remote reload: a control frame asks a session to run pi's /reload.
//
// Two layers: the decision logic (reload.ts) against a fake host, then the
// real extension (index.ts) against a stub pi, with throwaway peers on real
// sockets in a throwaway HOME, so nothing here reaches a live session.
//   node --experimental-strip-types --test test/reload.mjs
// index.ts imports typebox, so run `scripts/typecheck.sh --link-only` first.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, statSync, symlinkSync } from "node:fs";
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
    idle: true, running: false, ui: false, draft: "", clock: 1_000_000, dispatched: 0, notes: [],
    isIdle: () => host.idle,
    isRunning: () => host.running,
    uiBusy: () => host.ui,
    editorText: () => host.draft,
    dispatch: () => { host.dispatched++; },
    notify: (m) => host.notes.push(m),
    now: () => host.clock,
    ...over,
  };
  return host;
}
// pollMs is huge so only explicit poll() calls re-check: the tests drive the clock.
const controller = (host, opts = {}) => new R.ReloadController(host, { shared: { lastAcceptedAt: 0, lastBulkAt: 0 }, pollMs: 1e9, ...opts });

test("idle: dispatches now and answers 'reloaded' only from the reload command", async () => {
  const host = fakeHost();
  const c = controller(host);
  const replies = [];
  c.request({ who: "peer", reply: (o) => replies.push(o) });
  assert.equal(host.dispatched, 1);
  assert.deepEqual(replies, [], "nothing until the command runs");
  assert.equal(await c.beginReload(true), true);
  assert.deepEqual(replies, [{ status: "reloaded" }]);
  await c.beginReload(true);
  assert.equal(replies.length, 1, "each answer is paid once");
});

test("streaming: answers 'queued', then reloads at agent_settled", () => {
  const host = fakeHost({ idle: false, running: true });
  const c = controller(host);
  const replies = [];
  c.request({ who: "peer", reply: (o) => replies.push(o) });
  assert.deepEqual(replies, [{ status: "queued" }]);
  assert.equal(R.describeOutcome(replies[0]), "queued (busy, reloads when it is free)");
  assert.equal(host.dispatched, 0, "never mid-run");
  host.clock += 10 * 60_000;
  c.poll();
  assert.equal(c.isPending, true, "a wait on an agent run never expires");
  host.idle = true; host.running = false;
  c.settled();
  assert.equal(host.dispatched, 1);
  c.settled();
  assert.equal(host.dispatched, 1, "once");
});

test("busy outside a run (manual /compact): re-checks without agent_settled", () => {
  const host = fakeHost({ idle: false, running: false });
  const c = controller(host);
  const replies = [];
  c.request({ who: "peer", reply: (o) => replies.push(o) });
  assert.equal(replies[0].status, "queued");
  c.poll();
  assert.equal(host.dispatched, 0, "still compacting");
  host.idle = true; // session_compact
  c.poll();
  assert.equal(host.dispatched, 1, "runs as soon as the compaction ends");
});

test("a wait outside a run expires after 2 minutes with a notice", () => {
  const host = fakeHost({ idle: false, running: false });
  const c = controller(host);
  c.request({ who: "peer", reply: () => {} });
  c.poll();
  host.clock += R.RELOAD_WAIT_MS - 1;
  c.poll();
  assert.equal(c.isPending, true);
  host.clock += 1;
  c.poll();
  assert.equal(c.isPending, false);
  assert.match(host.notes.at(-1), /dropped the reload peer asked for: this session stayed busy for 120s/);
  host.idle = true;
  c.poll(); c.settled();
  assert.equal(host.dispatched, 0, "an expired reload never runs");
});

test("the reload command finds the session busy: re-queues, answers 'queued', charges no rate limit", async () => {
  const shared = { lastAcceptedAt: 0, lastBulkAt: 0 };
  const host = fakeHost();
  const c = controller(host, { shared });
  const replies = [];
  c.request({ who: "peer", reply: (o) => replies.push(o) });
  assert.equal(host.dispatched, 1);
  host.idle = false; // the user started a /compact before the command ran
  assert.equal(await c.beginReload(false), false, "don't call ctx.reload()");
  assert.deepEqual(replies, [{ status: "queued" }]);
  assert.equal(shared.lastAcceptedAt, 0, "the window starts only on an actual reload");
  assert.equal(c.isPending, true);
  host.idle = true;
  c.poll();
  assert.equal(host.dispatched, 2, "dispatched again once free");
  assert.equal(await c.beginReload(true), true);
  assert.equal(shared.lastAcceptedAt, host.clock);
});

test("an open dialog or agent-link command holds the reload until it closes", () => {
  const host = fakeHost({ ui: true });
  const c = controller(host);
  const replies = [];
  c.request({ who: "peer", reply: (o) => replies.push(o) });
  assert.equal(replies[0].status, "queued");
  assert.equal(host.dispatched, 0, "not under an open dialog");
  host.ui = false; // ui_prompt_end
  c.poll();
  assert.equal(host.dispatched, 1);
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
  const host = fakeHost({ idle: false, running: true });
  const c = controller(host);
  c.request({ who: "peer", reply: () => {} });
  host.idle = true; host.running = false;
  host.draft = "typed while busy";
  c.settled();
  assert.equal(host.dispatched, 0);
  assert.match(host.notes.at(-1), /skipped the reload peer asked for/);
});

test("an aborted run skips the queued reload with a notice, unless forced", () => {
  const host = fakeHost({ idle: false, running: true });
  const c = controller(host);
  c.request({ who: "peer", reply: () => {} });
  host.idle = true; host.running = false;
  c.settled(true);
  assert.equal(host.dispatched, 0);
  assert.equal(c.isPending, false);
  assert.match(host.notes.at(-1), /skipped the reload peer asked for: the run was aborted/);
  host.idle = false; host.running = true;
  c.request({ who: "peer", force: true, reply: () => {} });
  host.idle = true; host.running = false;
  c.settled(true);
  assert.equal(host.dispatched, 1, "force reloads anyway");
});

test("rate limit: one actual reload per window", async () => {
  const host = fakeHost();
  const c = controller(host, { rateMs: 30_000 });
  const replies = [];
  c.request({ who: "a", reply: (o) => replies.push(o) });
  await c.beginReload(true);
  host.clock += 10_000;
  c.request({ who: "b", reply: (o) => replies.push(o) });
  assert.equal(replies.at(-1).status, "refused");
  assert.match(replies.at(-1).reason, /rate-limited .* try again in 20s/);
  host.clock += 20_001;
  c.request({ who: "b", reply: (o) => replies.push(o) });
  assert.equal(host.dispatched, 2);
});

test("beginReload waits for the answers to be sent", async () => {
  const host = fakeHost();
  const c = controller(host);
  let sent = false;
  c.request({ who: "a", reply: () => sleep(30).then(() => { sent = true; }) });
  await c.beginReload(true);
  assert.equal(sent, true, "not fire-and-forget");
});

test("a dispatch the command never ran stops blocking after 10s", () => {
  const host = fakeHost();
  const c = controller(host);
  c.request({ who: "a", reply: () => {} });
  host.clock += 10_001;
  c.request({ who: "b", reply: () => {} });
  assert.equal(host.dispatched, 2, "dispatched afresh");
});

test("a request while a reload is already dispatched shares its answer", async () => {
  const host = fakeHost();
  const c = controller(host);
  const replies = [];
  c.request({ who: "a", reply: (o) => replies.push(["a", o.status]) });
  c.request({ who: "b", reply: (o) => replies.push(["b", o.status]) });
  assert.equal(host.dispatched, 1, "dispatched once");
  await c.beginReload(true);
  assert.deepEqual(replies, [["a", "reloaded"], ["b", "reloaded"]]);
});

test("the rate limit outlives the extension instance a reload replaces", async () => {
  const shared = R.sharedReloadState();
  shared.lastAcceptedAt = 0;
  const host = fakeHost({ now: () => Date.now() });
  const first = new R.ReloadController(host);
  first.request({ who: "a", reply: () => {} });
  await first.beginReload(true);
  const replies = [];
  new R.ReloadController(host).request({ who: "a", reply: (o) => replies.push(o) });
  assert.equal(replies[0]?.status, "refused", "a fresh instance shares the window");
  assert.equal(R.sharedReloadState(), shared);
  shared.lastAcceptedAt = 0;
});

test("self-reload waits for the response to settle", () => {
  const host = fakeHost({ idle: false, running: true });
  const c = controller(host);
  c.requestSelf();
  assert.equal(host.dispatched, 0);
  host.idle = true; host.running = false;
  c.settled();
  assert.equal(host.dispatched, 1);
});

test("junk answers become refusals", () => {
  assert.deepEqual(R.outcomeFromFrame({ status: "reloaded" }), { status: "reloaded" });
  assert.deepEqual(R.outcomeFromFrame({ status: "refused", reason: "x" }), { status: "refused", reason: "x" });
  assert.equal(R.outcomeFromFrame({ status: "boom" }).status, "refused");
});

test("sender cooldown: one *idle reload per 60s per process", () => {
  const shared = { lastAcceptedAt: 0, lastBulkAt: 0 };
  assert.equal(R.claimBulkReload(shared, 1_000_000), 0);
  assert.equal(R.claimBulkReload(shared, 1_015_000), 45);
  assert.equal(R.claimBulkReload(shared, 1_060_000), 0);
});

test("/agent-link reload argument parsing", () => {
  assert.deepEqual(R.parseReloadArgs("reload pi-foo"), { isReload: true, to: "pi-foo", force: false });
  assert.deepEqual(R.parseReloadArgs("  reload  --force  *idle "), { isReload: true, to: "*idle", force: true });
  assert.deepEqual(R.parseReloadArgs("reload pi-foo --force"), { isReload: true, to: "pi-foo", force: true });
  assert.deepEqual(R.parseReloadArgs("reload"), { isReload: true, to: "", force: false });
  assert.deepEqual(R.parseReloadArgs("reload --force"), { isReload: true, to: "", force: true });
  assert.equal(R.parseReloadArgs("dedupe").isReload, false);
  assert.equal(R.parseReloadArgs("").isReload, false);
});

test("socket dir: binds only in a private dir of ours", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "al-sockdir-"));
  const fresh = path.join(base, "fresh");
  await P.ensurePrivateDir(fresh);
  assert.equal(statSync(fresh).mode & 0o777, 0o700, "created 0700");
  await P.ensurePrivateDir(fresh); // an existing, correct dir keeps working

  const loose = path.join(base, "loose");
  mkdirSync(loose); chmodSync(loose, 0o755);
  await P.ensurePrivateDir(loose);
  assert.equal(statSync(loose).mode & 0o777, 0o700, "ours with read bits: tightened");

  const shared = path.join(base, "shared");
  mkdirSync(shared); chmodSync(shared, 0o777);
  await assert.rejects(P.ensurePrivateDir(shared), /writable by others/);

  const link = path.join(base, "link");
  symlinkSync(fresh, link);
  await assert.rejects(P.ensurePrivateDir(link), /is a symlink/);
  const server = P.bindSocket(path.join(link, "x.sock"), () => {});
  await assert.rejects(server, /is a symlink/, "bindSocket refuses too");
});

// ------------------------------------------------------------- real extension

const servers = [];
/**
 * A throwaway peer: registered, listening, and recording frames. `answer`
 * makes it behave like a pi that handles reload requests.
 */
async function peer({ pid, name, status = "idle", entrypoint = "pi", answer, delay = 0 }) {
  const sock = path.join(home, `${pid}.sock`);
  const frames = [];
  const server = await P.bindSocket(sock, (frame) => {
    frames.push(frame);
    if (answer && frame.type === "control" && frame.action === "reload" && frame.from?.startsWith("uds:")) {
      setTimeout(() => P.sendFrame(frame.from.slice(4), { type: "control", action: "reload_result", req_id: frame.req_id, ...answer }).catch(() => {}), delay);
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
    // Recorded first thing: the answer must already be written to the socket,
    // not merely started (the receiver reads it on a later tick).
    reload: async () => { state.framesAtReload = answersWritten; await sleep(50); state.reloads++; },
    isIdle: () => state.idle,
  });
}

function reset() {
  R.sharedReloadState().lastAcceptedAt = 0;
  R.sharedReloadState().lastBulkAt = 0;
  notes.length = 0;
  state.idle = true; state.draft = ""; state.reloads = 0; state.framesAtReload = -1;
  answersWritten = 0;
  stub.sent.length = 0;
  sender.frames.length = 0;
}

// Count reload_result frames whose write has completed (sendFrame's end
// callback), so the test can tell "sent before ctx.reload()" from "started".
let answersWritten = 0;
const realEnd = net.Socket.prototype.end;
net.Socket.prototype.end = function (data, ...rest) {
  const cb = typeof rest.at(-1) === "function" ? rest.pop() : undefined;
  const isAnswer = typeof data === "string" && data.includes('"reload_result"');
  return realEnd.call(this, data, ...rest, (...a) => { if (isAnswer) answersWritten++; cb?.(...a); });
};

const ask = (extra = {}) => P.sendFrame(target, { type: "control", action: "reload", req_id: `r-${Math.random()}`, from: sender.from, ...extra });
const answers = () => sender.frames.filter((f) => f.action === "reload_result");

test("extension: a reload frame reaches no chat and answers before reloading", async () => {
  reset();
  await ask({ req_id: "one" });
  assert.ok(await until(() => stub.sent.length === 1));
  assert.equal(stub.sent.filter((s) => s.content !== `/${R.RELOAD_COMMAND}`).length, 0, "no chat message for the model");
  await runDispatched();
  assert.equal(state.reloads, 1);
  assert.equal(state.framesAtReload, 1, "the answer was written before ctx.reload() started");
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "reloaded");
  assert.equal(answers()[0].req_id, "one");
});

test("extension: busy answers queued and reloads at agent_settled", async () => {
  reset();
  state.idle = false;
  await stub.fire("agent_start", {}, ctx);
  await ask();
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "queued");
  assert.equal(stub.sent.length, 0, "not while busy");
  state.idle = true;
  await stub.fire("agent_settled", { aborted: false }, ctx);
  await runDispatched();
  assert.equal(state.reloads, 1);
});

test("extension: an aborted run drops the queued reload with a notice", async () => {
  reset();
  state.idle = false;
  await stub.fire("agent_start", {}, ctx);
  await ask();
  assert.ok(await until(() => answers().length === 1));
  state.idle = true;
  await stub.fire("agent_settled", { aborted: true }, ctx);
  assert.equal(stub.sent.length, 0);
  assert.ok(notes.some(([, m]) => /the run was aborted/.test(m)));
});

test("extension: a manual /compact holds the reload until session_compact, not the next turn", async () => {
  reset();
  state.idle = false; // compacting: busy, but no agent run
  await ask();
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "queued");
  state.idle = true;
  await stub.fire("session_compact", { reason: "manual" }, ctx);
  assert.equal(stub.sent.length, 1, "dispatched when the compaction ends");
  await runDispatched();
  assert.equal(state.reloads, 1);
});

test("extension: busy again when the reload command runs: answers queued, no reload, no rate limit", async () => {
  reset();
  await ask({ req_id: "late" });
  assert.ok(await until(() => stub.sent.length === 1));
  state.idle = false; // e.g. the user hit /compact in between
  await runDispatched();
  assert.equal(state.reloads, 0, "ctx.reload() never called while busy");
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "queued");
  assert.equal(answers()[0].req_id, "late");
  assert.equal(R.sharedReloadState().lastAcceptedAt, 0);
  state.idle = true;
  stub.sent.length = 0;
  await stub.fire("session_compact", { reason: "manual" }, ctx);
  await runDispatched();
  assert.equal(state.reloads, 1);
});

test("extension: an open dialog (any extension's) holds the reload", async () => {
  reset();
  await stub.fire("ui_prompt_start", { kind: "select" }, ctx);
  await ask();
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "queued");
  assert.equal(stub.sent.length, 0);
  await stub.fire("ui_prompt_end", { kind: "select" }, ctx);
  assert.equal(stub.sent.length, 1);
  await runDispatched();
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
  await runDispatched();
});

test("extension: a request inside 30s of a reload is rate-limited", async () => {
  reset();
  await ask();
  assert.ok(await until(() => stub.sent.length === 1));
  await runDispatched();
  await ask();
  assert.ok(await until(() => answers().length === 2));
  assert.equal(answers()[1].status, "refused");
  assert.match(answers()[1].reason, /rate-limited/);
  assert.equal(stub.sent.length, 1, "only the first dispatched");
});

test("extension: a spoofed registered 'from' can only send the answer to that peer", async () => {
  reset();
  // Same-user processes can already reach the socket; one naming another
  // peer's socket as 'from' gets no answer itself (accepted, see SECURITY.md).
  const rogue = path.join(home, "rogue2.sock");
  const frames = [];
  servers.push(await P.bindSocket(rogue, (f) => frames.push(f)));
  await P.sendFrame(target, { type: "control", action: "reload", req_id: "spoof", from: sender.from });
  assert.ok(await until(() => stub.sent.length === 1));
  await runDispatched();
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].req_id, "spoof", "the answer went to the registered peer");
  assert.equal(frames.length, 0);
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
let replaced;

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
  assert.equal(res.content[0].text, '"solo-busy": queued (busy, reloads when it is free)');
});

test("extension: a single non-pi target is refused at once, without a frame", async () => {
  reset();
  const claude = await peer({ pid: 910011, name: "claude-solo", entrypoint: "cli", answer: { status: "reloaded" } });
  const res = await tool().execute("id", { action: "reload", to: "claude-solo" });
  assert.match(res.content[0].text, /refused: not a pi session/);
  assert.equal(res.isError, true);
  assert.equal(claude.frames.length, 0);
});

test("extension: /agent-link reload parses --force and needs a target", async () => {
  reset();
  const cmd = stub.commands.get("agent-link");
  const forced = await peer({ pid: 910012, name: "solo-force", answer: { status: "reloaded" } });
  await cmd.handler("reload solo-force --force", ctx);
  assert.equal(forced.frames[0]?.force, true);
  assert.match(notes.at(-1)[1], /"solo-force": reloaded/);
  await cmd.handler("reload --force", ctx);
  assert.match(notes.at(-1)[1], /^Usage: \/agent-link reload/);
  await cmd.handler("reload", ctx);
  assert.match(notes.at(-1)[1], /^Usage: \/agent-link reload/);
});

test("extension: a reload waits for agent-link's own command to finish", async () => {
  reset();
  // A peer that answers slowly keeps /agent-link reload in flight.
  const slow = await peer({ pid: 910013, name: "solo-slow", answer: { status: "reloaded" }, delay: 300 });
  const running = stub.commands.get("agent-link").handler("reload solo-slow", ctx);
  assert.ok(await until(() => slow.frames.length === 1));
  await ask();
  assert.ok(await until(() => answers().length === 1));
  assert.equal(answers()[0].status, "queued", "held while our command is open");
  assert.equal(stub.sent.length, 0);
  await running;
  assert.equal(stub.sent.length, 1, "dispatched once it finished");
  await runDispatched();
});

test("extension: completions offer reload, *idle, pi peers and --force", async () => {
  const complete = stub.commands.get("agent-link").getArgumentCompletions;
  assert.deepEqual((await complete("re")).map((i) => i.label), ["reload"]);
  const after = await complete("reload ");
  const labels = after.map((i) => i.label);
  assert.ok(labels.includes(R.IDLE_TARGETS) && labels.includes("--force") && labels.includes("solo-busy"));
  assert.ok(!labels.includes("claude-solo"), "only pi sessions");
  assert.equal(after.find((i) => i.label === R.IDLE_TARGETS).value, `reload ${R.IDLE_TARGETS}`);
  assert.match(stub.commands.get(R.RELOAD_COMMAND).description, /^\(internal\)/);
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
  const again = await tool().execute("id", { action: "reload", to: R.IDLE_TARGETS });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /at most once per 60s/);
  assert.equal(a.frames.length, 1, "the cooldown sends nothing");
});

test("extension: a reload keeps the name a rename frame set", async () => {
  reset();
  await P.sendFrame(target, { type: "control", action: "rename", name: "renamed-by-dedupe" });
  assert.ok(await until(() => JSON.parse(readFileSync(ownJson, "utf8")).name === "renamed-by-dedupe"));
  // What ctx.reload() does: shut this instance down, start a fresh one.
  await stub.fire("session_shutdown", { reason: "reload" }, ctx);
  const next = stubPi();
  next.pi.getSessionName = () => undefined;
  extension(next.pi);
  await next.fire("session_start", { reason: "reload" }, ctx);
  assert.ok(await until(() => existsSync(ownJson)));
  assert.ok(await until(() => JSON.parse(readFileSync(ownJson, "utf8")).name === "renamed-by-dedupe"), "the name survived");
  await sleep(400); // past a name-race settle
  assert.equal(JSON.parse(readFileSync(ownJson, "utf8")).name, "renamed-by-dedupe");
  replaced = next;
});

test.after(async () => {
  net.Socket.prototype.end = realEnd;
  await (replaced ?? stub).fire("session_shutdown", { reason: "quit" }, ctx);
  for (const s of servers) s.close();
});
