// Delivery receipts: "delivered" means in the receiver's conversation.
//
// Three layers: the receipt bookkeeping (delivery.ts) on its own, then the
// real extension (index.ts) against a stub pi as a sender, talking to fake
// receivers that answer each way a receiver can, then as a receiver, against a
// fake sender. Throwaway HOME, real sockets, so nothing reaches a live session.
//   node --experimental-strip-types --test test/delivery.mjs
// index.ts imports typebox, so run `scripts/typecheck.sh --link-only` first.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "al-delivery-"));
process.env.HOME = home;
process.env.XDG_CACHE_HOME = path.join(home, ".cache");
// The "received, not yet read" case waits this long instead of 5s.
process.env.PI_AGENT_LINK_ACK_WAIT_MS = "400";
delete process.env.PI_SUBAGENT_CHILD;
const REG = path.join(home, ".claude", "sessions");
mkdirSync(REG, { recursive: true });

// CLAUDE_REGISTRY is fixed from HOME at import, so HOME comes first.
const P = await import("../claude-protocol.ts");
const D = await import("../delivery.ts");
const M = await import("../mentions.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(10); }
  return false;
}

// ---------------------------------------------------------------- bookkeeping

test("a two-stage receipt settles on the second, in either order", async () => {
  const box = new D.Outbox();
  box.track("m1");
  const waiting = box.wait("m1", 1000);
  box.onReceipt({ orig_msg_id: "m1", status: "delivered", ack: "conversation" });
  box.onReceipt({ orig_msg_id: "m1", status: "in_conversation" });
  assert.deepEqual(await waiting, { state: "conversation" });

  box.track("m2");
  box.onReceipt({ orig_msg_id: "m2", status: "in_conversation" });
  box.onReceipt({ orig_msg_id: "m2", status: "delivered", ack: "conversation" }); // late first stage
  assert.deepEqual(await box.wait("m2", 1000), { state: "conversation" }, "a receipt that beat the wait still counts");
  box.forget("m1");
  box.forget("m2");
  assert.equal(box.size, 0);
});

test("a first receipt alone is 'received' after the wait, and the second comes as a late notice", async () => {
  const box = new D.Outbox();
  box.track("m");
  box.onReceipt({ orig_msg_id: "m", status: "delivered", ack: "conversation" });
  assert.deepEqual(await box.wait("m", 50), { state: "received" });
  const late = [];
  box.onLate("m", (o) => late.push(o));
  box.onReceipt({ orig_msg_id: "m", status: "dropped", reason: "its run ended" });
  assert.deepEqual(late, [{ state: "dropped", reason: "its run ended" }]);
});

test("a receipt without the ack flag (an older agent-link) ends the wait at once", async () => {
  const box = new D.Outbox();
  box.track("m");
  const t0 = Date.now();
  const waiting = box.wait("m", 5000);
  box.onReceipt({ orig_msg_id: "m", status: "delivered" });
  assert.deepEqual(await waiting, { state: "receipt" });
  assert.ok(Date.now() - t0 < 1000);
});

test("refused and dropped end the wait, with their reason", async () => {
  const box = new D.Outbox();
  box.track("r");
  box.onReceipt({ orig_msg_id: "r", status: "refused", reason: "no" });
  assert.deepEqual(await box.wait("r", 1000), { state: "refused", reason: "no" });
  assert.equal(box.onReceipt({ orig_msg_id: "unknown", status: "delivered" }), false, "untracked receipts are ignored");
});

test("the inbox matches a nonce in the injected text, once", () => {
  const inbox = new D.Inbox();
  const a = inbox.expect({ fromAddr: "uds:/a", msgId: "ma", steered: true });
  const b = inbox.expect({ fromAddr: "uds:/b", msgId: "mb", steered: false });
  assert.match(a, /^[0-9a-f]{8}$/);
  const text = P.frameInbound({ who: "x", body: "hi", ref: D.refMarker(a) });
  assert.match(text, new RegExp(`\\(ref ${a}\\)`));
  assert.deepEqual(inbox.seen(text).map((e) => e.msgId), ["ma"]);
  assert.deepEqual(inbox.seen(text), [], "only once");
  assert.deepEqual(inbox.take((e) => e.steered), [], "b was not a steer");
  assert.deepEqual(inbox.take().map((e) => e.msgId), ["mb"]);
  assert.match(D.messageText({ content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }] }), /^one\n+two$/);
  assert.equal(D.messageText({ content: "plain" }), "plain");
});

test("send says exactly how far the message got", () => {
  assert.match(D.describeSend("w", { state: "conversation" }).text, /^Delivered into "w"'s conversation\./);
  const queued = D.describeSend("w", { state: "received" }, { waitedMs: 5000 });
  assert.match(queued.text, /^Received by "w" but not yet in its conversation after 5s \(it may be finishing; the message is queued\)/);
  assert.equal(queued.isError, false);
  const refused = D.describeSend("w", { state: "refused", reason: "\"w\" is a print-mode subagent and can't take messages: its run has ended. Start a new task instead." });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /print-mode subagent and can't take messages/);
  const dropped = D.describeSend("w", { state: "dropped", reason: "its run ended" });
  assert.equal(dropped.isError, true);
  assert.match(dropped.text, /dropped: the peer's own words \(not your user's\): "its run ended"/);
  assert.match(D.describeLate("w", { state: "dropped", reason: "its run ended" }), /was not delivered: dropped: the peer's own words \(not your user's\): "its run ended"/);
  assert.match(D.describeSend("w", { state: "refused" }).text, /not delivered: "w" refused the message/);
});

test("a peer's reason is capped, one line, quoted and labelled as theirs", () => {
  const long = `line one\nline two\u001b[31m ${"x".repeat(500)}`;
  const words = D.peerWords(long);
  assert.match(words, /^the peer's own words \(not your user's\): ".*"$/);
  assert.doesNotMatch(words, /[\n\u001b]/, "one line, no escape sequence");
  const quoted = words.slice(words.indexOf('"') + 1, -1);
  assert.ok(quoted.length <= D.REASON_MAX, `at most ${D.REASON_MAX} characters, got ${quoted.length}`);
  assert.ok(quoted.startsWith("line one line two"), "the start of what it said");
  assert.match(words, /\u2026"$/, "cut with an ellipsis, inside the quotes");
  assert.equal(D.peerWords('say "hi"'), `the peer's own words (not your user's): "say 'hi'"`, "no quote of its own to break out of");
  assert.equal(D.peerWords("a\u202Eb\u200Bc\u2066d"), `the peer's own words (not your user's): "a b c d"`, "bidi overrides and zero-width characters go too");
  // Capped by code point: a cut between the halves of an emoji's surrogate pair leaves a lone half,
  // which Swift's and Ruby's JSON can reject.
  const emoji = D.peerWords("😀".repeat(D.REASON_MAX + 10));
  const quote = emoji.slice(emoji.indexOf('"') + 1, -1);
  assert.ok(Array.from(quote).length <= D.REASON_MAX, `at most ${D.REASON_MAX} code points, got ${Array.from(quote).length}`);
  assert.doesNotMatch(quote, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "never half a surrogate pair");
  assert.match(quote, /\u2026$/, "cut with an ellipsis");
  assert.equal(D.peerWords("  \n\t "), "", "nothing to show: the caller's own words");
  assert.equal(D.peerWords(undefined), "");
});

test("a print-mode session takes messages only while its run lasts", () => {
  const base = { name: "Pill face + Esc", subagent: true };
  assert.equal(D.printModeRefusal({ ...base, mode: "tui", running: false, everRan: true }), undefined, "interactive always takes them");
  assert.equal(D.printModeRefusal({ ...base, mode: "json", running: true, everRan: true }), undefined);
  assert.equal(
    D.printModeRefusal({ ...base, mode: "json", running: false, everRan: true }),
    "\"Pill face + Esc\" is a print-mode subagent and can't take messages: its run has ended. Start a new task instead.",
  );
  assert.match(D.printModeRefusal({ ...base, mode: "print", running: false, everRan: false }), /until its run starts/);
  assert.match(D.printModeRefusal({ ...base, subagent: false, mode: "print", running: false, everRan: true }), /a print-mode session/);
});

test("a subagent's title is reachable as an @mention handle", () => {
  const peers = [
    { name: "Pill face + Esc", pid: 1, cwd: "/w", status: "thinking", subagent: true, parent: "boss" },
    { name: "pi-work", pid: 2, cwd: "/w", status: "idle" },
  ];
  assert.equal(M.nameHandle("Pill face + Esc"), "pill-face-esc");
  assert.equal(M.findAgentMentions("ask @pill-face-esc about it", peers)[0]?.peer.pid, 1);
  assert.equal(M.findAgentMentions("ask @pill-face too", peers)[0]?.peer.pid, 1);
  assert.equal(M.matchPeer("+", peers), undefined, "punctuation alone is no handle");
  assert.match(M.formatAgentItem(peers[0]).description, /^subagent of boss · thinking/);
});

// ---------------------------------------------------------------- the extension

const servers = [];
/** A fake peer on a real socket; `answer(frame, reply)` decides its receipts. */
async function peer({ pid, name, entrypoint = "pi", answer, extra = {} }) {
  const sock = path.join(home, `${pid}.sock`);
  const frames = [];
  const reply = (frame, receipt, delay = 0) => setTimeout(() =>
    P.sendFrame(frame.from.slice(4), P.receiptFrame({ ...receipt, origMsgId: frame.msg_id, from: `uds:${sock}` })).catch(() => {}), delay);
  servers.push(await P.bindSocket(sock, (frame) => { frames.push(frame); if (frame.type === "user") answer?.(frame, (r, d) => reply(frame, r, d)); }));
  writeFileSync(path.join(REG, `${pid}.json`), JSON.stringify({
    pid, name, cwd: "/tmp/work", startedAt: pid, status: "thinking", entrypoint, sessionId: `s-${pid}`, messagingSocketPath: sock, ...extra,
  }));
  return { sock, frames, from: `uds:${sock}` };
}

function stubPi() {
  const handlers = new Map();
  const tools = [];
  const sent = [];
  const messages = [];
  const listeners = new Map();
  const pi = {
    on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
    registerCommand: () => {},
    registerTool: (tool) => tools.push(tool),
    sendUserMessage: (content, options) => { sent.push({ content, options }); },
    sendMessage: (message, options) => { messages.push({ message, options }); },
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    getSessionName: () => "sender",
    events: { on: (ch, fn) => listeners.set(ch, fn), emit: (ch, data) => listeners.get(ch)?.(data) },
  };
  const fire = async (event, payload, ctx) => Promise.all((handlers.get(event) ?? []).map((fn) => fn(payload, ctx)));
  return { pi, tools, sent, messages, fire, tool: () => tools.find((t) => t.name === "agent-link") };
}

const state = { idle: true, pending: false };
const notes = [];
const ctx = {
  cwd: "/tmp/sender",
  mode: "tui",
  hasUI: true,
  isIdle: () => state.idle,
  hasPendingMessages: () => state.pending,
  sessionManager: { getSessionId: () => "s-sender", getSessionFile: () => undefined },
  ui: { notify: (m, level) => notes.push([level, m]), getEditorText: () => "", addAutocompleteProvider: () => {} },
};

let stub, ownSock, fake;
let setupOnce;
const setup = () => (setupOnce ??= (async () => {
  // Registered before the extension starts, so ccSocksDir() puts its socket in this HOME too.
  fake = {
    // Reads it at once: both receipts.
    reader: await peer({ pid: 920001, name: "reader", answer: (f, r) => { r({ status: "delivered", ack: "conversation" }); r({ status: "in_conversation" }, 50); } }),
    // Queues it and never gets to it, then gives up.
    busy: await peer({ pid: 920002, name: "busy", answer: (f, r) => { r({ status: "delivered", ack: "conversation" }); r({ status: "dropped", reason: "its run ended before the message reached its conversation" }, 700); } }),
    // A print-mode child whose run is over.
    done: await peer({ pid: 920003, name: "Pill face + Esc", extra: { subagent: true, parent: "boss", printMode: true },
      answer: (f, r) => r({ status: "refused", reason: "\"Pill face + Esc\" is a print-mode subagent and can't take messages: its run has ended. Start a new task instead." }) }),
    // An agent-link from before two-stage receipts.
    old: await peer({ pid: 920004, name: "old", answer: (f, r) => r({ status: "delivered" }) }),
    // Claude Code: never waited on.
    claude: await peer({ pid: 920005, name: "claude", entrypoint: "cli" }),
    // A name that ends like a copied list label: reaching it by that exact name must work.
    labelled: await peer({ pid: 920006, name: "Notes (subagent of boss)", answer: (f, r) => { r({ status: "delivered", ack: "conversation" }); r({ status: "in_conversation" }, 20); } }),
  };
  const { default: extension } = await import("../index.ts");
  stub = stubPi();
  extension(stub.pi);
  await stub.fire("session_start", { reason: "startup" }, ctx);
  const ownJson = path.join(REG, `${process.pid}.json`);
  assert.ok(await until(() => existsSync(ownJson)), "the extension registered");
  ownSock = JSON.parse(readFileSync(ownJson, "utf8")).messagingSocketPath;
})());
const extTest = (name, fn) => test(name, async (t) => { await setup(); return fn(t); });
const run = (params) => stub.tool().execute("call", params);
const textOf = (r) => r.content.map((c) => c.text).join("\n");

extTest("list marks a subagent and says whose it is, in text and in details", async () => {
  const r = await run({ action: "list" });
  assert.match(textOf(r), /- Pill face \+ Esc \(subagent of boss\)  ·  \/tmp\/work/);
  assert.match(textOf(r), /- reader  ·/);
  const row = r.details.sessions.find((s) => s.name === "Pill face + Esc");
  assert.deepEqual([row.subagent, row.parent, row.printMode], [true, "boss", true]);
  assert.equal(r.details.sessions.find((s) => s.name === "reader").subagent, undefined);
});

extTest("send asks a pi target for both receipts and reports 'in its conversation'", async () => {
  const r = await run({ action: "send", to: "reader", message: "hello" });
  assert.match(textOf(r), /^Delivered into "reader"'s conversation\./);
  assert.equal(fake.reader.frames.at(-1).ack, "conversation");
});

extTest("a message still queued when the wait ends is reported as received, and its drop arrives later", async () => {
  const t0 = Date.now();
  const r = await run({ action: "send", to: "busy", message: "hello" });
  assert.ok(Date.now() - t0 >= 350, "it waited for the second receipt");
  assert.match(textOf(r), /^Received by "busy" but not yet in its conversation after 0s \(it may be finishing; the message is queued\)/);
  assert.equal(r.isError, undefined);
  assert.ok(await until(() => stub.messages.length > 0), "a late notice went into the conversation");
  assert.match(stub.messages[0].message.content, /your earlier message to "busy" was not delivered: dropped: the peer's own words \(not your user's\): "its run ended before the message reached its conversation"/);
  assert.equal(stub.messages[0].options.deliverAs, "nextTurn", "idle: for the next turn, without starting one");
  assert.ok(notes.some(([level, m]) => level === "warning" && /not delivered/.test(m)));
});

extTest("a refusal is an error with the receiver's reason, and a list label resolves", async () => {
  const r = await run({ action: "send", to: "Pill face + Esc (subagent of boss)", message: "hello" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /peer's own words \(not your user's\): "'Pill face \+ Esc' is a print-mode subagent and can't take messages: its run has ended\. Start a new task instead\."/);
});

extTest("an exact name that ends like a subagent label is reached as written", async () => {
  const r = await run({ action: "send", to: "Notes (subagent of boss)", message: "hello" });
  assert.match(textOf(r), /^Delivered into "Notes \(subagent of boss\)"'s conversation\./);
});

extTest("a refused ask fails at once instead of waiting for an answer", async () => {
  const t0 = Date.now();
  const r = await run({ action: "ask", to: "pill-face-esc", message: "status?" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /can't take messages/);
  assert.ok(Date.now() - t0 < 2000);
});

extTest("an older agent-link's single receipt is reported for what it is", async () => {
  const r = await run({ action: "send", to: "old", message: "hello" });
  assert.match(textOf(r), /^Delivered to "old" \(its agent-link can't confirm when it's read\)/);
});

extTest("a Claude Code target is not asked for, or waited on for, a second receipt", async () => {
  const t0 = Date.now();
  const r = await run({ action: "send", to: "claude", message: "hello" });
  assert.match(textOf(r), /^Delivered to "claude"\./);
  assert.ok(Date.now() - t0 < 350);
  assert.ok(await until(() => fake.claude.frames.length > 0));
  assert.equal(fake.claude.frames.at(-1).ack, undefined);
});

/** A fake sender's message to the extension, asking for both receipts. */
async function inbound(body, sender = fake.reader) {
  const frame = P.buildUserFrame({ content: P.buildEnvelope({ from: sender.from, fromName: "reader", body }), from: sender.from, ack: "conversation" });
  await P.sendFrame(ownSock, frame);
  return frame.msg_id;
}
const receiptsFor = (sender, id) => sender.frames.filter((f) => f.action === "peer_message_status" && f.orig_msg_id === id);

extTest("as a receiver: 'in_conversation' once message_start shows the message", async () => {
  state.idle = true;
  stub.sent.length = 0;
  const id = await inbound("please look");
  assert.ok(await until(() => stub.sent.length === 1));
  const { content, options } = stub.sent[0];
  assert.equal(options, undefined, "idle: it starts a turn");
  assert.match(content, /\(ref [0-9a-f]{8}\)/);
  assert.ok(await until(() => receiptsFor(fake.reader, id).length === 1));
  assert.deepEqual(receiptsFor(fake.reader, id).map((f) => [f.status, f.ack]), [["delivered", "conversation"]]);
  await stub.fire("message_start", { message: { role: "user", content: [{ type: "text", text: content }] } }, ctx);
  assert.ok(await until(() => receiptsFor(fake.reader, id).length === 2));
  assert.equal(receiptsFor(fake.reader, id)[1].status, "in_conversation");
});

extTest("as a receiver: a steer still unread when the run settles is reported dropped", async () => {
  state.idle = false;
  stub.sent.length = 0;
  const id = await inbound("mid-run note");
  assert.ok(await until(() => stub.sent.length === 1));
  assert.deepEqual(stub.sent[0].options, { deliverAs: "steer" });
  state.idle = true;
  await stub.fire("agent_settled", { aborted: true }, ctx);
  assert.ok(await until(() => receiptsFor(fake.reader, id).some((f) => f.status === "dropped")));
  assert.match(receiptsFor(fake.reader, id).find((f) => f.status === "dropped").reason, /run ended/);
});

extTest("as a receiver: a message queued before a run that the run never saw is dropped when it settles", async () => {
  state.idle = true;
  stub.sent.length = 0;
  const id = await inbound("rewritten away");
  assert.ok(await until(() => stub.sent.length === 1));
  // An input handler rewrote it, so its ref never came back: message_start finds nothing.
  await stub.fire("message_start", { message: { role: "user", content: [{ type: "text", text: "something else" }] } }, ctx);
  assert.equal(receiptsFor(fake.reader, id).length, 1, "still only the first receipt");
  await stub.fire("agent_start", {}, ctx);
  await stub.fire("agent_settled", { aborted: true }, ctx);
  assert.ok(await until(() => receiptsFor(fake.reader, id).some((f) => f.status === "dropped")));
  assert.match(receiptsFor(fake.reader, id).find((f) => f.status === "dropped").reason, /run ended/);
});

extTest("as a receiver: a sender that didn't ask gets the old single receipt and no ref", async () => {
  state.idle = true;
  stub.sent.length = 0;
  const frame = P.buildUserFrame({ content: P.buildEnvelope({ from: fake.old.from, fromName: "old", body: "hi" }), from: fake.old.from });
  await P.sendFrame(ownSock, frame);
  assert.ok(await until(() => stub.sent.length === 1));
  assert.doesNotMatch(stub.sent[0].content, /\(ref /);
  assert.ok(await until(() => receiptsFor(fake.old, frame.msg_id).length === 1));
  await sleep(50);
  assert.deepEqual(receiptsFor(fake.old, frame.msg_id).map((f) => [f.status, f.ack]), [["delivered", undefined]]);
});

test.after(async () => {
  await stub?.fire("session_shutdown", { reason: "quit" }, ctx);
  for (const s of servers) s.close();
});
