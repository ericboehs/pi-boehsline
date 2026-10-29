/**
 * Canvas: the live meeting feed (meeting-feed.mjs), read from meeting-capture's
 * state folder for the Meeting card and /meeting.
 *
 *   node --test test/canvas-meeting.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { CARD_AFTER_END_MS, JsonlTail, MeetingFeed, normalizeLive, normalizeNotes, normalizeRecord, normalizeSlide, notesFilePath, parseState } from "../extensions/canvas/meeting-feed.mjs";

const line = (o) => `${JSON.stringify(o)}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "canvas-meeting-"));
  const state = join(root, "state");
  const data = join(root, "data");
  const slides = join(data, "m.slides");
  mkdirSync(state);
  mkdirSync(slides, { recursive: true });
  const jsonl = join(data, "m.jsonl");
  const st = { v: 1, pid: 4242, app: "Microsoft Teams", app_id: "teams", meeting: "Weekly Sync", started_at: "2026-10-28T14:00:00Z", jsonl, txt: join(data, "m.txt"), slides_dir: slides, live: join(state, "live.json"), ended: false };
  const writeState = (o) => writeFileSync(join(state, "state.json"), JSON.stringify({ ...st, ...o }));
  return { root, state, jsonl, slides, writeState, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("parseState: recording, ended, and a dead pid reads as crashed", () => {
  const raw = { v: 1, pid: 1, meeting: "Sync", started_at: "2026-10-28T14:00:00Z", jsonl: "/x/m.jsonl", ended: false };
  assert.equal(parseState(raw, { alive: () => true }).recording, true);
  const crashed = parseState(raw, { alive: () => false, mtimeMs: Date.parse("2026-10-28T15:00:00Z") });
  assert.deepEqual([crashed.recording, crashed.ended, crashed.crashed, crashed.endedAt], [false, true, true, "2026-10-28T15:00:00.000Z"]);
  const ended = parseState({ ...raw, ended: true, ended_at: "2026-10-28T15:02:03Z", duration: "1:02:03" }, { alive: () => false });
  assert.deepEqual([ended.crashed, ended.duration], [false, "1:02:03"]);
  assert.equal(parseState({ ...raw, v: 2 }), null);
  assert.equal(parseState({ ...raw, jsonl: "relative.jsonl" }, { alive: () => true }).jsonl, null);
});

test("normalizeRecord: no absolute paths reach the page", () => {
  const s = normalizeRecord({ type: "slide", speaker: "", text: "▣ slide 7  /abs/0007.jpg", slide: 7, file: "/abs/0007-144210.jpg", reason: "change", ts: "t" });
  assert.deepEqual(s, { type: "slide", n: 7, reason: "change", ts: "t" });
  assert.equal(normalizeRecord({ type: "caption", speaker: "Ada", text: "  " }), null);
  assert.deepEqual(normalizeRecord({ type: "people", people: ["Ada", 3, "Bo"], text: "2 in", ts: "t" }), { type: "people", count: 2, people: ["Ada", "Bo"], text: "2 in", ts: "t" });
  assert.deepEqual(normalizeRecord({ type: "metadata", event: "stopped", duration: "0:10:00" }), { type: "stopped", duration: "0:10:00", ts: "" });
  assert.equal(normalizeRecord({ type: "metadata", app: "Teams" }), null);
});

test("normalizeRecord: a revisit keeps its own type and points at the original frame", () => {
  assert.deepEqual(normalizeRecord({ type: "revisit", slide: 2, file: "/abs/0002-141030.jpg", reason: "revisit", text: "▣ back to slide 2", ts: "t" }), { type: "revisit", n: 2, reason: "revisit", ts: "t" });
  assert.equal(normalizeRecord({ type: "revisit", slide: "2" }), null);
});

test("MeetingFeed: a revisit makes an earlier slide current without adding one", () => {
  const f = fixture();
  try {
    const feed = new MeetingFeed(f.state, { alive: () => true });
    f.writeState({});
    for (const n of [1, 2]) {
      writeFileSync(join(f.slides, `000${n}-14010${n}.jpg`), "jpg");
      appendFileSync(join(f.slides, "index.jsonl"), line({ n, file: `000${n}-14010${n}.jpg` }));
    }
    writeFileSync(f.jsonl, line({ type: "slide", slide: 1, ts: "t1" }) + line({ type: "slide", slide: 2, ts: "t2" }) + line({ type: "revisit", slide: 1, ts: "t3" }));
    feed.poll();
    const s = feed.summary();
    assert.deepEqual([s.slides, s.slide.n], [2, 1]);
    assert.deepEqual(feed.snapshot().entries.map((e) => `${e.type}${e.n}`), ["slide1", "slide2", "revisit1"]);
    appendFileSync(f.jsonl, line({ type: "slide", slide: 2, ts: "t4" }));
    feed.poll();
    assert.equal(feed.summary().slide.n, 2);
  } finally {
    f.done();
  }
});

test("normalizeSlide and normalizeLive: names only, bounded", () => {
  assert.equal(normalizeSlide({ n: 1, file: "../../etc/passwd" }), null);
  assert.equal(normalizeSlide({ n: 1, file: "/abs/0001-144210.jpg" }).file, "0001-144210.jpg");
  assert.equal(normalizeSlide({ n: 1, file: "0001-144210.jpg", thumb: "../x.jpg" }).thumb, null);
  const live = normalizeLive({ lines: Array.from({ length: 9 }, (_, i) => ({ speaker: "A", text: `l${i}`, ts: "t" })) });
  assert.deepEqual(live.map((l) => l.text), ["l3", "l4", "l5", "l6", "l7", "l8"]);
  assert.deepEqual(normalizeLive(null), []);
});

test("JsonlTail: whole lines only, a split line waits, a replaced file starts over", () => {
  const f = fixture();
  try {
    writeFileSync(f.jsonl, line({ a: 1 }) + '{"a":');
    const t = new JsonlTail(f.jsonl);
    assert.deepEqual(t.read().records, [{ a: 1 }]);
    appendFileSync(f.jsonl, '2}\n{"a":"é');
    assert.deepEqual(t.read().records, [{ a: 2 }]);
    appendFileSync(f.jsonl, '"}\n');
    assert.deepEqual(t.read().records, [{ a: "é" }]);
    writeFileSync(f.jsonl, line({ b: 1 }));
    const r = t.read();
    assert.equal(r.reset, true);
    assert.deepEqual(r.records, [{ b: 1 }]);
  } finally {
    f.done();
  }
});

test("MeetingFeed: tails the transcript, slides and live lines; snapshot since a cursor", () => {
  const f = fixture();
  try {
    let now = Date.parse("2026-10-28T14:05:00Z");
    const feed = new MeetingFeed(f.state, { now: () => now, alive: () => true });
    assert.deepEqual(feed.poll(), { final: false, live: false });
    assert.equal(feed.snapshot().state, null);
    assert.equal(feed.summary(), null);

    // Detected, nothing written yet: jsonl null.
    f.writeState({ jsonl: null });
    assert.equal(feed.poll().final, true);
    assert.equal(feed.summary().recording, true);
    assert.equal(feed.snapshot().state.hasTranscript, false);
    const id = feed.id;

    f.writeState({});
    writeFileSync(f.jsonl, line({ type: "metadata", app: "Microsoft Teams" }) + line({ type: "caption", speaker: "Ada", text: "Hi", ts: "t1" }) + line({ type: "people", people: ["Ada", "Bo"], ts: "t2" }));
    writeFileSync(join(f.state, "live.json"), JSON.stringify({ lines: [{ speaker: "Bo", text: "So the", ts: "t3" }] }));
    assert.deepEqual(feed.poll(), { final: true, live: true });
    assert.equal(feed.id, id, "the id holds when jsonl fills in");
    let snap = feed.snapshot(0, id);
    assert.equal(snap.total, 2);
    assert.deepEqual(snap.people, { count: 2, people: ["Ada", "Bo"] });
    assert.deepEqual(snap.live.map((l) => l.text), ["So the"]);
    assert.equal(JSON.stringify(snap).includes(f.root), false, "no paths in the page's view");

    writeFileSync(join(f.slides, "0001-140100.jpg"), "jpg");
    writeFileSync(join(f.slides, "0001-140100.thumb.jpg"), "thumb");
    appendFileSync(join(f.slides, "index.jsonl"), line({ n: 1, at: "t4", file: "0001-140100.jpg", thumb: "0001-140100.thumb.jpg", reason: "first frame", width: 2880, height: 2560 }));
    appendFileSync(f.jsonl, line({ type: "slide", slide: 1, file: join(f.slides, "0001-140100.jpg"), ts: "t4" }));
    assert.deepEqual(feed.poll(), { final: true, live: false });
    snap = feed.snapshot(2, id);
    assert.deepEqual([snap.from, snap.entries.map((e) => e.type)], [2, ["slide"]]);
    assert.deepEqual(snap.slides, [{ n: 1, at: "t4", reason: "first frame", width: 2880, height: 2560, thumb: true }]);
    assert.equal(feed.snapshot(2, "other").from, 0, "another meeting's cursor gets everything");
    assert.equal(feed.snapshot(99, id).from, 0, "a cursor past the end starts over");
    assert.deepEqual(feed.poll(), { final: false, live: false });

    const s = feed.summary();
    assert.deepEqual([s.people, s.captions, s.slides, s.slide], [2, 1, 1, { n: 1, thumb: true }]);
    assert.deepEqual(s.recent.map((e) => e.text), ["Hi"]);

    // Ended: kept for the card a while, then only on /meeting.
    f.writeState({ ended: true, ended_at: "2026-10-28T14:06:00Z", duration: "0:06:00" });
    const ch = feed.poll();
    assert.equal(ch.final, true);
    assert.equal(ch.live, true, "live lines clear when it ends");
    assert.equal(feed.summary().ended, true);
    now = Date.parse("2026-10-28T14:06:00Z") + CARD_AFTER_END_MS - 1;
    assert.notEqual(feed.summary(), null);
    now = Date.parse("2026-10-28T14:06:00Z") + CARD_AFTER_END_MS + 1;
    assert.equal(feed.summary(), null);
    assert.equal(feed.snapshot().state.ended, true);

    // The next meeting: a new id, everything starts over.
    f.writeState({ started_at: "2026-10-28T16:00:00Z", jsonl: null });
    feed.poll();
    assert.notEqual(feed.id, id);
    assert.equal(feed.snapshot().total, 0);
  } finally {
    f.done();
  }
});

test("MeetingFeed: a recording whose daemon dies reads as crashed without the file changing", () => {
  const f = fixture();
  try {
    let up = true;
    const feed = new MeetingFeed(f.state, { alive: () => up });
    f.writeState({});
    feed.poll();
    assert.equal(feed.state.recording, true);
    up = false;
    assert.equal(feed.poll().final, true);
    assert.equal(feed.state.crashed, true);
  } finally {
    f.done();
  }
});

test("MeetingFeed.slideFile: only listed names, inside slides_dir, for the current meeting", () => {
  const f = fixture();
  try {
    const feed = new MeetingFeed(f.state, { alive: () => true });
    f.writeState({});
    writeFileSync(join(f.slides, "0001-140100.jpg"), "jpg");
    writeFileSync(join(f.root, "secret.jpg"), "no");
    symlinkSync(join(f.root, "secret.jpg"), join(f.slides, "0002-140200.jpg"));
    appendFileSync(join(f.slides, "index.jsonl"), line({ n: 1, file: "0001-140100.jpg" }) + line({ n: 2, file: "0002-140200.jpg" }));
    feed.poll();
    assert.equal(feed.slideFile(feed.id, 1, false)?.endsWith("0001-140100.jpg"), true);
    assert.equal(feed.slideFile(feed.id, 1, true)?.endsWith("0001-140100.jpg"), true, "no thumb: the full image");
    assert.equal(feed.slideFile(feed.id, 2, false), null, "a symlink out of slides_dir");
    assert.equal(feed.slideFile(feed.id, 3, false), null, "not listed");
    assert.equal(feed.slideFile("someone-else", 1, false), null, "another meeting's id");
  } finally {
    f.done();
  }
});

// ── the copilot's notes file ──

const STARTED = "2026-10-28T14:00:00Z";
const rawNotes = (over = {}) => ({
  v: 1,
  pid: 4242,
  session: { id: "s-secret-id", name: "earl" },
  meeting: { started_at: STARTED, app_id: "teams", title: "Weekly Sync" },
  at: "2026-10-28T14:13:00.000Z",
  ended: false,
  me: ["eric", "boehs"],
  topics: [{ title: "Cert rotation", summary: "Thursday." }],
  decisions: [{ text: "Rotate Thursday", at: "2026-10-28T14:12:00.000Z" }],
  actions: [
    { who: "Eric Boehs", what: "own the canary move", mine: true, at: "2026-10-28T14:12:00.000Z" },
    { who: "Amy", what: "rotate the cert", mine: false, at: "2026-10-28T14:12:00.000Z" },
  ],
  questions: [{ q: "Who signs off?", why: "no approver" }],
  reply: { to: "Katherine", text: "Friday.", at: "2026-10-28T14:12:30.000Z" },
  alerts: [
    { id: "a1", kind: "action", who: "Ada", text: "own the canary move", at: "2026-10-28T14:12:00.000Z" },
    { id: "a2", kind: "name", who: "Alan", text: "Eric, are you there?", at: "2026-10-28T14:13:00.000Z" },
  ],
  ...over,
});

test("normalizeNotes: version 1 with a pid, bounded, no pid or session id for the page", () => {
  assert.equal(normalizeNotes(null), null);
  assert.equal(normalizeNotes({ ...rawNotes(), v: 2 }), null);
  assert.equal(normalizeNotes({ ...rawNotes(), pid: "4242" }), null);
  const n = normalizeNotes(rawNotes());
  assert.deepEqual([n.pid, n.startedAt, n.notes.session, n.notes.ended, n.notes.me], [4242, STARTED, "earl", false, ["eric", "boehs"]]);
  assert.equal(JSON.stringify(n.notes).includes("s-secret-id"), false);
  assert.equal("pid" in n.notes, false);
  assert.deepEqual(n.notes.actions.map((a) => [a.what, a.mine]), [["own the canary move", true], ["rotate the cert", false]]);

  const big = normalizeNotes(
    rawNotes({
      topics: Array.from({ length: 30 }, (_, i) => ({ title: "t".repeat(500), summary: `s${i}`.padEnd(900, "x") })),
      decisions: Array.from({ length: 50 }, (_, i) => ({ text: `d${i}`, at: "x".repeat(100) })),
      actions: Array.from({ length: 50 }, (_, i) => ({ who: "w".repeat(300), what: `a${i}`, mine: i === 0 })),
      questions: [{ q: "a?" }, { q: "b?" }, { q: "c?" }],
      alerts: [...Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, kind: "name", who: "A", text: "x".repeat(900), at: "t" })), { id: "bad", kind: "other", text: "no" }, "junk", null],
      reply: { to: "x".repeat(300), text: "y".repeat(2000) },
      me: ["eric", 3, "z".repeat(100), ...Array.from({ length: 20 }, () => "tok")],
    }),
  ).notes;
  assert.equal(big.topics.length, 8);
  assert.deepEqual([big.topics[0].title.length, big.topics[0].summary.length], [120, 400]);
  assert.equal(big.decisions.length, 20);
  assert.equal(big.decisions[0].at.length, 40);
  assert.equal(big.actions.length, 20);
  assert.equal(big.actions[0].who.length, 100);
  assert.equal(big.questions.length, 2);
  assert.equal(big.alerts.length, 20, "the newest 20, junk and unknown kinds dropped");
  assert.equal(big.alerts[0].text.length, 400);
  assert.deepEqual([big.reply.to.length, big.reply.text.length], [100, 500]);
  assert.equal(big.me.length, 8);
  assert.ok(big.me.every((t) => typeof t === "string" && t.length <= 40));
  assert.equal(normalizeNotes(rawNotes({ reply: { to: "A", text: "  " } })).notes.reply, null);
  assert.deepEqual(normalizeNotes({ v: 1, pid: 1 }).notes.topics, []);
});

test("notesFilePath: PI_MEETING_NOTES_FILE, else the canvas root", () => {
  const saved = process.env.PI_MEETING_NOTES_FILE;
  try {
    delete process.env.PI_MEETING_NOTES_FILE;
    assert.equal(notesFilePath("/x/canvas"), "/x/canvas/.meeting-notes.json");
    process.env.PI_MEETING_NOTES_FILE = "/y/notes.json";
    assert.equal(notesFilePath("/x/canvas"), "/y/notes.json");
  } finally {
    saved === undefined ? delete process.env.PI_MEETING_NOTES_FILE : (process.env.PI_MEETING_NOTES_FILE = saved);
  }
});

test("MeetingFeed notes: used only for this meeting while its session lives, or once it ended", () => {
  const f = fixture();
  try {
    const notesFile = join(f.root, "canvas", ".meeting-notes.json");
    mkdirSync(join(f.root, "canvas"));
    // Only the notes' session (pid 4242) can die here; the recorder (the state's pid) stays up.
    let alive = true;
    const feed = new MeetingFeed(f.state, { alive: (pid) => pid !== 4242 || alive, notesFile });
    const put = (o) => writeFileSync(notesFile, JSON.stringify(rawNotes(o)));

    // No state yet: nothing counts, whatever the file says.
    put();
    assert.equal(feed.poll().final, false);
    assert.equal(feed.snapshot().notes, null);

    f.writeState({ pid: 4243 });
    assert.equal(feed.poll().final, true);
    let snap = feed.snapshot();
    assert.equal(snap.notes.topics[0].title, "Cert rotation");
    assert.equal(JSON.stringify(snap).includes(f.root), false, "no paths in the page's view");
    assert.deepEqual(feed.poll(), { final: false, live: false }, "unchanged: quiet");

    // The summary: alert count, the newest three, Eric's open actions, questions, the reply.
    put({ alerts: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, kind: "name", who: "A", text: `t${i}`, at: "t" })) });
    assert.equal(feed.poll().final, true, "a notes change counts as a final change");
    const sum = feed.summary().notes;
    assert.deepEqual([sum.alertCount, sum.lastAlertId, sum.alerts.map((a) => a.id), sum.ended], [5, "a4", ["a2", "a3", "a4"], false]);
    assert.deepEqual(sum.actions.map((a) => a.what), ["own the canary move"], "only Eric's");
    assert.deepEqual([sum.questions.length, sum.reply.to], [1, "Katherine"]);

    // Another meeting's notes: ignored.
    put({ meeting: { started_at: "2026-10-28T09:00:00Z", app_id: "teams", title: "Old" } });
    assert.equal(feed.poll().final, true);
    assert.equal(feed.snapshot().notes, null);
    assert.equal(feed.summary().notes, null);

    // Back to this one; then its session dies: stale, ignored.
    put();
    feed.poll();
    assert.notEqual(feed.snapshot().notes, null);
    alive = false;
    assert.equal(feed.poll().final, true);
    assert.equal(feed.snapshot().notes, null, "a stale notes pid isn't trusted");
    assert.equal(feed.snapshot().state.recording, true, "while the recorder is still up");

    // Ended notes are kept for the canvas even with the session gone.
    put({ ended: true });
    feed.poll();
    assert.equal(feed.snapshot().notes.ended, true);
    assert.equal(feed.summary().notes.ended, true);

    // The file going away (the session shut down) takes the notes with it.
    rmSync(notesFile);
    assert.equal(feed.poll().final, true);
    assert.equal(feed.snapshot().notes, null);

    // Garbage in the file is just no notes.
    writeFileSync(notesFile, "{ not json");
    feed.poll();
    assert.equal(feed.snapshot().notes, null);
  } finally {
    f.done();
  }
});

test("MeetingFeed notes: a new meeting drops the old one's notes at once", () => {
  const f = fixture();
  try {
    const notesFile = join(f.root, ".meeting-notes.json");
    const feed = new MeetingFeed(f.state, { alive: () => true, notesFile });
    f.writeState({});
    writeFileSync(notesFile, JSON.stringify(rawNotes()));
    feed.poll();
    assert.equal(feed.snapshot().notes.topics.length, 1);
    f.writeState({ started_at: "2026-10-28T16:00:00Z", jsonl: null });
    assert.equal(feed.poll().final, true);
    assert.equal(feed.snapshot().notes, null);
    assert.equal(feed.summary().notes, null);
    // Without a notes file configured nothing breaks.
    const bare = new MeetingFeed(f.state, { alive: () => true });
    bare.poll();
    assert.equal(bare.snapshot().notes, null);
  } finally {
    f.done();
  }
});

test("daemon: /api/meeting and a session's card carry the notes from PI_MEETING_NOTES_FILE", async () => {
  const f = fixture();
  const port = 22790 + Math.floor(Math.random() * 1000);
  const daemon = fileURLToPath(new URL("../extensions/canvas/daemon.mjs", import.meta.url));
  const notesFile = join(f.root, "notes.json");
  const child = spawn(process.execPath, [daemon, "--port", String(port), "--root", join(f.root, "canvas"), "--omarchy", join(f.root, "none"), "--meeting", f.state], {
    stdio: "ignore",
    env: { ...process.env, PI_MEETING_NOTES_FILE: notesFile },
  });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
  try {
    f.writeState({ pid: child.pid });
    writeFileSync(notesFile, JSON.stringify(rawNotes({ pid: child.pid })));
    let d;
    for (let i = 0; i < 60; i++) {
      d = await get("/api/meeting").then((r) => r.json(), () => null);
      if (d?.notes) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(d.notes.topics[0].title, "Cert rotation");
    assert.equal(d.notes.alerts.length, 2);
    const card = await get("/api/s/nobody").then((r) => r.json());
    assert.deepEqual([card.meeting.notes.alertCount, card.meeting.notes.actions.length], [2, 1]);
  } finally {
    child.kill();
    f.done();
  }
});

test("daemon: /api/meeting, /meeting and slide routes, served from the state folder", async () => {
  const f = fixture();
  const port = 21790 + Math.floor(Math.random() * 1000);
  const daemon = fileURLToPath(new URL("../extensions/canvas/daemon.mjs", import.meta.url));
  const child = spawn(process.execPath, [daemon, "--port", String(port), "--root", join(f.root, "canvas"), "--omarchy", join(f.root, "none"), "--meeting", f.state], { stdio: "ignore" });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
  try {
    f.writeState({ pid: child.pid });
    writeFileSync(f.jsonl, line({ type: "caption", speaker: "Ada", text: "Hi", ts: "t1" }));
    writeFileSync(join(f.slides, "0001-140100.jpg"), "jpg-bytes");
    appendFileSync(join(f.slides, "index.jsonl"), line({ n: 1, file: "0001-140100.jpg" }));
    let d;
    for (let i = 0; i < 60; i++) {
      d = await get("/api/meeting").then((r) => r.json(), () => null);
      if (d?.total) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual([d.state.title, d.total, d.slides.length], ["Weekly Sync", 1, 1]);
    const img = await get(`/meeting/${d.id}/slide/1.jpg`);
    assert.deepEqual([img.status, img.headers.get("content-type"), await img.text()], [200, "image/jpeg", "jpg-bytes"]);
    assert.equal((await get(`/meeting/${d.id}/slide/2.jpg`)).status, 404);
    assert.equal((await get(`/meeting/wrong/slide/1.jpg`)).status, 404);
    assert.equal((await get(`/meeting/${d.id}/slide/..%2F..%2Fsecret.jpg`)).status, 404);
    const page = await get("/meeting");
    assert.match(await page.text(), /meeting-page\.mjs/);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'(;|$)/);
    const sessionMeeting = await get("/api/s/nobody").then((r) => r.json());
    assert.equal(sessionMeeting.meeting.title, "Weekly Sync");
  } finally {
    child.kill();
    f.done();
  }
});


// ── the card (page.mjs renderMeeting), pulled out of the module and run in jsdom ──

import { JSDOM } from "jsdom";

test("meeting card: alerts and your action items on top, one link to /meeting", async () => {
  const { h } = await import("../extensions/canvas/render.mjs");
  const dom = new JSDOM("<!doctype html><body></body>");
  after(() => dom.window.close());
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  const src = readFileSync(fileURLToPath(new URL("../extensions/canvas/page.mjs", import.meta.url)), "utf8");
  const code = src.slice(src.indexOf("const meetPad"), src.indexOf("// The card's elapsed time ticks"));
  const { renderMeeting, meetingLastAlert } = new Function("h", "plural", `${code}; return { renderMeeting, meetingLastAlert };`)(h, (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`);
  const notes = { lastAlertId: "a2", alerts: [{ id: "a1", kind: "name", who: "Ada", text: "Eric?", at: "2026-10-28T14:00:00Z" }, { id: "a2", kind: "action", who: "Ada", text: "own it", at: "2026-10-28T14:05:00Z" }], actions: [{ what: "own it", mine: true }, { what: "not mine", mine: false }] };
  const base = { id: "a00000000000", title: "Weekly Sync", app: "Teams", startedAt: new Date().toISOString(), recording: true, ended: false, people: 3, slides: 1, slide: { n: 1, thumb: true }, recent: [{ type: "caption", speaker: "Ada", text: "Hi" }], notes };

  const live = renderMeeting(base);
  assert.deepEqual([...live.querySelectorAll(".m-open")].map((a) => [a.textContent, a.getAttribute("href")]), [["Open the live view ↗", "/meeting"]]);
  assert.deepEqual([...live.querySelectorAll(".m-alert")].map((a) => a.textContent.includes("own it")), [true, false], "newest first");
  assert.deepEqual([...live.querySelectorAll(".m-todo li")].map((li) => li.textContent), ["own it"], "only your actions");
  assert.equal(live.querySelector(".m-alerts"), live.children[2], "the alerts box sits right under the title");
  assert.match(live.textContent, /Live/);

  const ended = renderMeeting({ ...base, recording: false, ended: true, endedAt: new Date().toISOString(), duration: "0:10:00" });
  assert.match(ended.querySelector(".m-status").textContent, /Ended/);
  assert.equal(ended.querySelector(".m-open").textContent, "Open the transcript ↗");
  assert.equal(renderMeeting({ ...base, notes: null }).querySelector(".m-alerts"), null);
  assert.equal(meetingLastAlert({ data: { notes } }), "a2");
  assert.equal(meetingLastAlert({ data: {} }), "");
});
