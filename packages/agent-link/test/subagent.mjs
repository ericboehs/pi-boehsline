// A subagent's child: the subagent extension runs it as
// `PI_SUBAGENT_CHILD=1 PI_SUBAGENT_TITLE=… PI_SUBAGENT_PARENT=… pi --mode json -p`.
//
// It registers under its task title, marked as whose subagent it is, and, in
// print mode, takes messages only while its run lasts: a steer is read at the
// next turn boundary, and nothing is read once the run is over. The real
// extension against a stub pi in json mode, a fake sender on a real socket, a
// throwaway HOME.
//   node --experimental-strip-types --test test/subagent.mjs
// index.ts imports typebox, so run `scripts/typecheck.sh --link-only` first.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "al-subagent-"));
process.env.HOME = home;
process.env.XDG_CACHE_HOME = path.join(home, ".cache");
process.env.PI_SUBAGENT_CHILD = "1";
process.env.PI_SUBAGENT_TITLE = "Pill face + Esc";
process.env.PI_SUBAGENT_PARENT = "Boss Session";
const REG = path.join(home, ".claude", "sessions");
mkdirSync(REG, { recursive: true });

const P = await import("../claude-protocol.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(10); }
  return false;
}

const handlers = new Map();
const sent = [];
const listeners = new Map();
const pi = {
  on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
  registerCommand: () => {},
  registerTool: () => {},
  sendUserMessage: (content, options) => { sent.push({ content, options }); },
  sendMessage: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
  getAllTools: () => [],
  // auto-session-name leaves a titled subagent unnamed.
  getSessionName: () => undefined,
  events: { on: (ch, fn) => listeners.set(ch, fn), emit: (ch, data) => listeners.get(ch)?.(data) },
};
const fire = (event, payload) => Promise.all((handlers.get(event) ?? []).map((fn) => fn(payload, ctx)));
const state = { idle: true };
const ctx = {
  cwd: "/tmp/child",
  mode: "json",
  hasUI: false,
  isIdle: () => state.idle,
  hasPendingMessages: () => false,
  sessionManager: { getSessionId: () => "s-child", getSessionFile: () => undefined },
  ui: { notify: () => {}, addAutocompleteProvider: () => {} },
};

let sender, ownJson, ownSock, server;
let setupOnce;
const setup = () => (setupOnce ??= (async () => {
  // A parent-side sender, registered first so ccSocksDir() is in this HOME.
  const sock = path.join(home, "sender.sock");
  const frames = [];
  server = await P.bindSocket(sock, (f) => frames.push(f));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(REG, "930001.json"), JSON.stringify({
    pid: 930001, name: "Boss Session", cwd: "/tmp/work", startedAt: 1, status: "thinking", entrypoint: "pi", messagingSocketPath: sock,
  }));
  sender = { sock, frames, from: `uds:${sock}` };
  const { default: extension } = await import("../index.ts");
  extension(pi);
  await fire("session_start", { reason: "startup" });
  ownJson = path.join(REG, `${process.pid}.json`);
  assert.ok(await until(() => existsSync(ownJson)), "registered");
  ownSock = JSON.parse(readFileSync(ownJson, "utf8")).messagingSocketPath;
})());
const extTest = (name, fn) => test(name, async (t) => { await setup(); return fn(t); });

async function inbound(body) {
  const frame = P.buildUserFrame({ content: P.buildEnvelope({ from: sender.from, fromName: "Boss Session", body }), from: sender.from, ack: "conversation" });
  await P.sendFrame(ownSock, frame);
  return frame.msg_id;
}
const receipts = (id) => sender.frames.filter((f) => f.action === "peer_message_status" && f.orig_msg_id === id);

extTest("it registers under its task title, marked as a print-mode subagent of its parent", async () => {
  const entry = JSON.parse(readFileSync(ownJson, "utf8"));
  assert.equal(entry.name, "Pill face + Esc");
  assert.equal(entry.nameSource, "user", "never renamed by dedupe");
  assert.deepEqual([entry.subagent, entry.parent, entry.printMode], [true, "Boss Session", true]);
  const row = (await P.listClaudeSessions({})).find((r) => r.pid === process.pid);
  assert.equal(P.listLabel(row, [row]), "Pill face + Esc (subagent of Boss Session)");
  const whoami = {};
  pi.events.emit("agent-link:whoami", whoami);
  assert.equal(whoami.name, "Pill face + Esc");
});

extTest("a turn doesn't rename it to a derived name", async () => {
  await fire("turn_start", {});
  await sleep(50);
  assert.equal(JSON.parse(readFileSync(ownJson, "utf8")).name, "Pill face + Esc");
});

extTest("it's reachable by its title, its handle, and the label the list shows", async () => {
  for (const to of ["Pill face + Esc", "pill-face-esc", "Pill face + Esc (subagent of Boss Session)"]) {
    const res = await P.resolveTarget(to, { excludeSock: sender.sock });
    assert.equal(res.target?.pid, process.pid, to);
  }
});

extTest("before its run starts it refuses, instead of colliding with its prompt", async () => {
  state.idle = true;
  const id = await inbound("too early");
  assert.ok(await until(() => receipts(id).length === 1));
  assert.equal(receipts(id)[0].status, "refused");
  assert.match(receipts(id)[0].reason, /print-mode subagent and can't take messages until its run starts/);
  assert.equal(sent.length, 0, "nothing injected");
});

extTest("mid-run, a message is steered in and confirmed once it enters the conversation", async () => {
  await fire("agent_start", {});
  state.idle = false;
  const id = await inbound("Also check the README.");
  assert.ok(await until(() => sent.length === 1));
  assert.deepEqual(sent[0].options, { deliverAs: "steer" });
  assert.ok(await until(() => receipts(id).length === 1));
  assert.deepEqual([receipts(id)[0].status, receipts(id)[0].ack], ["delivered", "conversation"]);
  // pi reads the steer at the next turn boundary: message_start for the user message.
  await fire("message_start", { message: { role: "user", content: [{ type: "text", text: sent[0].content }] } });
  assert.ok(await until(() => receipts(id).length === 2));
  assert.equal(receipts(id)[1].status, "in_conversation");
});

extTest("a steer still queued when the run settles is reported dropped", async () => {
  sent.length = 0;
  const id = await inbound("Too late, as it turns out.");
  assert.ok(await until(() => sent.length === 1));
  state.idle = true;
  await fire("agent_settled", { aborted: false });
  assert.ok(await until(() => receipts(id).some((f) => f.status === "dropped")));
  assert.match(receipts(id).find((f) => f.status === "dropped").reason, /run ended before the message reached its conversation/);
});

extTest("after its run it refuses with a clear reason, never claiming delivery", async () => {
  sent.length = 0;
  const id = await inbound("one more thing");
  assert.ok(await until(() => receipts(id).length === 1));
  await sleep(50);
  assert.deepEqual(receipts(id).map((f) => f.status), ["refused"]);
  assert.equal(receipts(id)[0].reason, "\"Pill face + Esc\" is a print-mode subagent and can't take messages: its run has ended. Start a new task instead.");
  assert.equal(sent.length, 0);
});

test.after(async () => {
  await fire("session_shutdown", { reason: "quit" });
  server?.close();
});
