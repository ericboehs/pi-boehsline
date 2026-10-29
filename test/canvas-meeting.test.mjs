/**
 * Canvas: the live meeting feed (meeting-feed.mjs), read from meeting-capture's
 * state folder for the Meeting card and /meeting.
 *
 *   node --test test/canvas-meeting.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { CARD_AFTER_END_MS, JsonlTail, MeetingFeed, meetingDataDir, meetingId, normalizeLive, normalizeNotes, normalizeRecord, normalizeSlide, notesDirPath, notesFilePath, parseState } from "../extensions/canvas/meeting-feed.mjs";

// No test reads the real meeting-capture folder: this one is empty (a feed or daemon asked for a dir overrides it).
process.env.MEETING_CAPTURE_DATA_DIR = mkdtempSync(join(tmpdir(), "canvas-meeting-empty-"));
delete process.env.PI_MEETING_NOTES_DIR;

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
    assert.deepEqual(s.lines.map((e) => e.text), ["Hi"]);

    // Ended: kept for the card a while, then only on /meeting.
    f.writeState({ ended: true, ended_at: "2026-10-28T14:06:00Z", duration: "0:06:00" });
    const ch = feed.poll();
    assert.equal(ch.final, true);
    assert.equal(ch.live, true, "live lines clear when it ends");
    assert.equal(feed.summary().ended, true);
    now = Date.parse("2026-10-28T14:06:00Z") + CARD_AFTER_END_MS - 1;
    const expanded = feed.summary();
    assert.equal(expanded.kind, "ended");
    assert.deepEqual(feed.poll(), { final: false, live: false }, "the feed itself does not change when the 15 minutes run out");
    now = Date.parse("2026-10-28T14:06:00Z") + CARD_AFTER_END_MS + 1;
    assert.equal(feed.summary().kind, "list", "no expanded card any more: just the recent meetings");
    assert.notEqual(feed.summary().at, expanded.at, "ended → list changes `at`, so the page swaps the card");
    assert.equal(feed.summary().recent[0].id, id);
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

// ── history: /meetings, the card's recent list, past meetings, search ──

const DAY = "2026-10-28";
const at = (hms, day = DAY) => `${day}T${hms}Z`;

/**
 * One meeting in a data folder, as meeting-capture writes it. base: the file name without .jsonl.
 * Without stopped it reads as ended-by-crash; slides: how many frames (1..n) with thumbnails.
 */
function writeMeeting(dir, base, { title = "Weekly Sync", app = "Microsoft Teams", appId, start = at("14:00:00"), lines = [], people = null, stopped = null, slides = 0, noMeta = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const recs = [];
  if (!noMeta) recs.push({ type: "metadata", app, meeting: title, recorded_at: start, ...(appId ? { app_id: appId } : {}) });
  if (people) recs.push({ type: "people", people, count: people.length, ts: at("14:00:30") });
  lines.forEach(([speaker, text, ts], i) => recs.push({ type: i % 5 === 4 ? "chat" : "caption", speaker, text, ts: ts || at(`14:${String(i + 1).padStart(2, "0")}:00`) }));
  const sdir = join(dir, `${base}.slides`);
  for (let n = 1; n <= slides; n++) {
    mkdirSync(sdir, { recursive: true });
    const f = `000${n}-14${String(n).padStart(2, "0")}00`;
    writeFileSync(join(sdir, `${f}.jpg`), `jpg${n}`);
    writeFileSync(join(sdir, `${f}.thumb.jpg`), `thumb${n}`);
    appendFileSync(join(sdir, "index.jsonl"), line({ n, at: at("14:05:00"), file: `${f}.jpg`, thumb: `${f}.thumb.jpg`, reason: "change", width: 100, height: 50 }));
    recs.push({ type: "slide", slide: n, file: join(sdir, `${f}.jpg`), ts: at("14:05:00") });
  }
  if (stopped) recs.push({ type: "metadata", event: "stopped", stopped_at: stopped.at, duration: stopped.duration });
  writeFileSync(join(dir, `${base}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** A meeting file over 20 MB: header, ~21 MB of captions saying "pipeline", then people and stopped (so the head and the tail say what the list needs). */
function writeBigMeeting(dir, base, { title = "Big", start = at("13:00:00") } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${base}.jsonl`);
  writeFileSync(path, line({ type: "metadata", app: "Zoom", app_id: "zoom", meeting: title, recorded_at: start }));
  const chunk = Buffer.from(Array.from({ length: 1000 }, (_, i) => line({ type: "caption", speaker: "Ada", text: `pipeline filler ${i} ${"x".repeat(900)}`, ts: at("13:01:00") })).join(""));
  for (let i = 0; i < 22; i++) appendFileSync(path, chunk);
  appendFileSync(path, line({ type: "people", people: ["Ada", "Bo"], ts: at("13:29:00") }) + line({ type: "caption", speaker: "Bo", text: "last words", ts: at("13:29:30") }) + line({ type: "metadata", event: "stopped", stopped_at: at("13:30:00"), duration: "0:30:00" }));
  return path;
}

/** A data folder with four meetings: ended (with slides), a crashed one, one named only by its file, and an old one. */
function history() {
  const f = fixture();
  const dir = join(f.root, "hist");
  writeMeeting(dir, "20261028_140000-teams-weekly-sync", {
    appId: "teams",
    people: ["Ada Lovelace", "Alan Turing", "Amy Smith", "Bo", "Cy", "Di", "Ed", "Fay", "Gus", "Hal"],
    stopped: { at: at("14:32:10"), duration: "0:32:10" },
    slides: 2,
    lines: [
      ["Ada Lovelace", "Morning everyone, the Budget review starts now"],
      ["Alan Turing", "The cert expires Friday so we rotate it Thursday"],
      ["Ada Lovelace", "Rotate Thursday, agreed"],
    ],
  });
  writeMeeting(dir, "20261028_100000-zoom-standup", { app: "Zoom", appId: "zoom", title: "Standup", start: at("10:00:00"), lines: [["Bo", "Nothing blocked", at("10:01:00")], ["Cy", "Cert is done", at("10:02:00")]] });
  writeMeeting(dir, "20261027_090000-slack-design-review", { noMeta: true, lines: [["Di", "Looks good"]] });
  writeMeeting(dir, "20261020_090000-meet-retro", { app: "Google Meet", title: "Retro", start: at("09:00:00", "2026-10-20"), stopped: { at: at("09:45:00", "2026-10-20"), duration: "0:45:00" }, lines: [["Ed", "What went well"]] });
  writeFileSync(join(dir, "notes.txt"), "not a meeting");
  writeFileSync(join(dir, "20261028_140000-teams-weekly-sync.txt"), "transcript text");
  const feed = new MeetingFeed(f.state, { alive: () => true, dataDir: dir, now: () => Date.parse(at("15:00:00")) });
  return { ...f, dir, feed };
}

test("meetingDataDir: explicit, env, the state's folder, the last one seen, XDG, then ~/.local/share", () => {
  const env = {};
  assert.equal(meetingDataDir({ env }), join(homedir(), ".local", "share", "meeting-capture"));
  assert.equal(meetingDataDir({ env: { XDG_DATA_HOME: "/x/data" } }), "/x/data/meeting-capture");
  assert.equal(meetingDataDir({ env: { XDG_DATA_HOME: "/x/data" }, last: "/y/last" }), "/y/last");
  assert.equal(meetingDataDir({ env: { XDG_DATA_HOME: "/x/data" }, last: "/y/last", jsonl: "/z/live/m.jsonl" }), "/z/live");
  assert.equal(meetingDataDir({ env: { MEETING_CAPTURE_DATA_DIR: "/e/dir" }, jsonl: "/z/live/m.jsonl" }), "/e/dir");
  assert.equal(meetingDataDir({ explicit: "/a/arg", env: { MEETING_CAPTURE_DATA_DIR: "/e/dir" }, jsonl: "/z/live/m.jsonl" }), "/a/arg");
});

test("MeetingFeed: the data folder comes from the state's jsonl and is remembered after state.json goes away", () => {
  const f = fixture();
  const saved = process.env.MEETING_CAPTURE_DATA_DIR;
  delete process.env.MEETING_CAPTURE_DATA_DIR;
  try {
    const feed = new MeetingFeed(f.state, { alive: () => true });
    f.writeState({});
    feed.poll();
    assert.equal(feed.dataDir(), join(f.root, "data"));
    rmSync(join(f.state, "state.json"));
    feed.poll();
    assert.equal(feed.state, null);
    assert.equal(feed.dataDir(), join(f.root, "data"), "still the folder it saw");
    process.env.MEETING_CAPTURE_DATA_DIR = join(f.root, "elsewhere");
    assert.equal(feed.dataDir(), join(f.root, "elsewhere"), "the env var wins");
    assert.equal(new MeetingFeed(f.state, { dataDir: "/arg/dir" }).dataDir(), "/arg/dir");
  } finally {
    process.env.MEETING_CAPTURE_DATA_DIR = saved;
    f.done();
  }
});

test("history: newest first, ended / crashed / filename-only, app_id from the metadata or the file name", () => {
  const h = history();
  try {
    const list = h.feed.history();
    assert.deepEqual(list.map((m) => m.title), ["Weekly Sync", "Standup", "design review", "Retro"], "only <date>_<time>-… .jsonl files, newest first");
    const [sync, standup, design, retro] = list;
    assert.deepEqual([sync.app, sync.started_at, sync.ended_at, sync.duration, sync.live], ["Microsoft Teams", at("14:00:00"), at("14:32:10"), "0:32:10", false]);
    assert.deepEqual([sync.people, sync.names.length, sync.slides, sync.captions, sync.thumb, sync.notes], [10, 8, 2, 3, true, null], "three captions; names capped at 8");
    assert.equal(sync.id, meetingId({ appId: "teams", startedAt: at("14:00:00") }), "app_id from the metadata");
    // Crashed: no stopped line, so it ends at its last line and the duration runs to it.
    assert.deepEqual([standup.ended_at, standup.duration, standup.thumb, standup.slides], [at("10:02:00"), "0:02:00", false, 0]);
    // No metadata at all: the file name gives app id, slug and a local start time.
    assert.equal(design.app, "");
    assert.equal(design.id, meetingId({ appId: "slack", startedAt: design.started_at }));
    assert.equal(new Date(design.started_at).getHours(), 9);
    assert.equal(retro.duration, "0:45:00");
    assert.equal(JSON.stringify(list).includes(h.root), false, "no paths");
    // Paging.
    assert.deepEqual(h.feed.history({ limit: 2, offset: 1 }).map((m) => m.title), ["Standup", "design review"]);
    assert.equal(h.feed.total(), 4);
    // Metadata app_id wins over the file name.
    writeMeeting(h.dir, "20261029_090000-teams-odd", { appId: "webex", title: "Odd", start: at("09:00:00", "2026-10-29") });
    h.feed.rescan();
    const odd = h.feed.history()[0];
    assert.equal(odd.id, meetingId({ appId: "webex", startedAt: at("09:00:00", "2026-10-29") }));
  } finally {
    h.done();
  }
});

test("history: the scan is cached for 10 s and a file is parsed again only when its size or mtime changes", () => {
  const h = history();
  try {
    let now = Date.parse(at("15:00:00"));
    h.feed.now = () => now;
    assert.equal(h.feed.history().length, 4);
    writeMeeting(h.dir, "20261028_150000-zoom-new", { appId: "zoom", title: "New", start: at("15:00:00") });
    assert.equal(h.feed.history().length, 4, "cached");
    now += 11_000;
    assert.equal(h.feed.history().length, 5, "listed again after 10 s");
    const info = [...h.feed.infos.values()].find((c) => c.info?.title === "Retro");
    now += 11_000;
    h.feed.history();
    assert.equal([...h.feed.infos.values()].find((c) => c.info?.title === "Retro"), info, "an unchanged file keeps its parse");
    appendFileSync(join(h.dir, "20261020_090000-meet-retro.jsonl"), line({ type: "caption", speaker: "Ed", text: "More", ts: at("09:46:00", "2026-10-20") }));
    now += 11_000;
    assert.equal(h.feed.history().at(-1).captions, 2);
  } finally {
    h.done();
  }
});

test("history: the live meeting and its history entry share one id, and it appears once, as Live", () => {
  const h = history();
  try {
    const base = join(h.dir, "20261028_140000-teams-weekly-sync");
    const past = h.feed.history().find((m) => m.title === "Weekly Sync");
    // The live state names the very meeting the file's metadata describes.
    h.writeState({ app_id: "teams", started_at: at("14:00:00"), meeting: "Weekly Sync", jsonl: `${base}.jsonl`, slides_dir: `${base}.slides` });
    h.feed.poll();
    assert.equal(h.feed.id, past.id, "same sha1(app_id|started_at)");
    h.feed.rescan();
    const list = h.feed.history();
    assert.equal(list.filter((m) => m.id === past.id).length, 1);
    const live = list.find((m) => m.id === past.id);
    assert.deepEqual([live.live, "ended_at" in live], [true, false]);
    assert.equal(h.feed.snapshot(0, past.id).state.recording, true, "its id asks for the live view");
    assert.equal(h.feed.snapshot(0, past.id).total, 7);
    assert.equal(h.feed.slideFile(past.id, 1, true)?.endsWith("0001-140100.thumb.jpg"), true, "slides by the live state");
    assert.equal(new MeetingFeed(h.state, { dataDir: h.dir }).history().find((m) => m.id === past.id).live, false, "without the state, a finished meeting");
  } finally {
    h.done();
  }
});

test("past meetings: whole transcript by id, ended, with no client paths; unknown ids are notFound", () => {
  const h = history();
  try {
    const id = h.feed.history().find((m) => m.title === "Weekly Sync").id;
    const snap = h.feed.snapshot(0, id);
    assert.deepEqual([snap.id, snap.state.title, snap.state.recording, snap.state.ended, snap.state.crashed, snap.state.duration, snap.state.hasSlides], [id, "Weekly Sync", false, true, false, "0:32:10", true]);
    assert.deepEqual(snap.entries.map((e) => e.type), ["people", "caption", "caption", "caption", "slide", "slide", "stopped"]);
    assert.equal(snap.total, snap.entries.length);
    assert.equal(snap.people.count, 10);
    assert.equal(snap.slides.length, 2);
    assert.equal(snap.slides[0].thumb, true);
    assert.equal(JSON.stringify(snap).includes(h.root), false, "no paths in a past meeting's view");
    // A cursor: only what's after it, when it belongs to this meeting.
    assert.equal(h.feed.snapshot(3, id).entries.length, snap.total - 3);
    assert.equal(h.feed.snapshot(3, id, "").from, 0, "another meeting's cursor starts over");
    // A crashed one reads as such.
    const st = h.feed.history().find((m) => m.title === "Standup");
    assert.equal(h.feed.snapshot(0, st.id).state.crashed, true);
    // Unknown, malformed and traversal ids.
    for (const bad of ["0123456789ab", "../../etc", "x", "%2e%2e"]) {
      const s = h.feed.snapshot(0, bad);
      assert.deepEqual([s.notFound, s.state, s.id], [true, null, ""]);
    }
    // Following the live meeting is unaffected: no id, no state, nothing.
    assert.equal(h.feed.snapshot(0, "").state, null);
    assert.equal(h.feed.snapshot(0, "").notFound, undefined);
  } finally {
    h.done();
  }
});

test("past meetings: three kept in memory, revalidated by size and mtime", () => {
  const h = history();
  try {
    const ids = h.feed.history().map((m) => m.id);
    for (const id of ids) h.feed.snapshot(0, id);
    assert.equal(h.feed.loaded.size, 3);
    assert.equal(h.feed.loaded.has(ids[0]), false, "the oldest-used one went");
    const id = ids[3];
    const first = h.feed.loadPast(id);
    assert.equal(h.feed.loadPast(id), first, "unchanged: the same load");
    appendFileSync(join(h.dir, "20261020_090000-meet-retro.jsonl"), line({ type: "caption", speaker: "Ed", text: "One more", ts: at("09:46:00", "2026-10-20") }));
    h.feed.rescan();
    assert.equal(h.feed.snapshot(0, id).entries.some((e) => e.text === "One more"), true, "a changed file is read again");
  } finally {
    h.done();
  }
});

test("past meetings: slides resolve by id and index only, inside the slides folder", () => {
  const h = history();
  try {
    const id = h.feed.history().find((m) => m.title === "Weekly Sync").id;
    assert.equal(h.feed.slideFile(id, 1, false)?.endsWith("0001-140100.jpg"), true);
    assert.equal(h.feed.slideFile(id, 2, true)?.endsWith("0002-140200.thumb.jpg"), true);
    assert.equal(h.feed.slideFile(id, 3, false), null, "not in index.jsonl");
    for (const bad of ["../hist", "0123456789ab", "", "20261028_140000-teams-weekly-sync"]) assert.equal(h.feed.slideFile(bad, 1, false), null, `id ${bad}`);
    // A symlink out of the folder is not served, even though it is listed.
    writeFileSync(join(h.root, "secret.jpg"), "no");
    symlinkSync(join(h.root, "secret.jpg"), join(h.dir, "20261028_140000-teams-weekly-sync.slides", "0009-140900.jpg"));
    appendFileSync(join(h.dir, "20261028_140000-teams-weekly-sync.slides", "index.jsonl"), line({ n: 9, file: "0009-140900.jpg" }));
    utimesSync(join(h.dir, "20261028_140000-teams-weekly-sync.jsonl"), new Date(), new Date(Date.now() + 5000));
    h.feed.rescan();
    assert.equal(h.feed.slideFile(id, 9, false), null);
  } finally {
    h.done();
  }
});

test("search: every term must match (one line, or the title, people and notes), case-insensitively", () => {
  const h = history();
  try {
    const titles = (q) => h.feed.search(q).map((r) => r.title);
    assert.deepEqual(titles("cert"), ["Weekly Sync", "Standup"]);
    assert.deepEqual(titles("CERT thursday"), ["Weekly Sync"], "both terms in one line");
    assert.deepEqual(titles("cert budget"), [], "terms in different lines of one meeting don't count");
    const r = h.feed.search("rotate")[0];
    assert.deepEqual([r.title, r.hits, r.lines.map((l) => [l.speaker, l.i])], ["Weekly Sync", 2, [["Alan Turing", 2], ["Ada Lovelace", 3]]]);
    assert.deepEqual(r.fields, ["transcript"]);
    assert.equal(r.id, h.feed.history()[0].id, "the same entry the list shows");
    // i is the entry's index, so the page can jump to it.
    const snap = h.feed.snapshot(0, r.id);
    assert.equal(snap.entries[r.lines[0].i].text, r.lines[0].text);
    // Title and people (no line says them).
    assert.deepEqual(titles("retro"), ["Retro"]);
    assert.deepEqual(h.feed.search("retro")[0].fields, ["title"]);
    assert.deepEqual(h.feed.search("lovelace weekly")[0].fields, ["title", "people"], "terms split across title and people still match");
    // Short and blank queries.
    assert.deepEqual(h.feed.search("a"), []);
    assert.deepEqual(h.feed.search("  "), []);
    assert.deepEqual(h.feed.search(""), []);
    // The limit counts meetings, newest first.
    assert.deepEqual(h.feed.search("re", { limit: 1 }).length, 1);
    assert.equal(h.feed.search("re", { limit: 2 })[0].title, "Weekly Sync");
  } finally {
    h.done();
  }
});

test("search: three lines per meeting at most, hits counts them all; long lines are cut around the match; big files are skipped", () => {
  const f = fixture();
  try {
    const dir = join(f.root, "hist");
    writeMeeting(dir, "20261028_140000-teams-many", {
      appId: "teams",
      lines: [...Array.from({ length: 7 }, (_, i) => ["Ada", `Pipeline ${i} is green`, at(`14:0${i}:00`)]), ["Bo", `${"x ".repeat(400)}pipeline in the middle${" y".repeat(400)}`]],
    });
    writeMeeting(dir, "20261028_130000-teams-big", { appId: "teams", title: "Big", start: at("13:00:00"), lines: [["Ada", "pipeline in a big file"]] });
    const feed = new MeetingFeed(f.state, { dataDir: dir });
    feed.poll();
    const r = feed.search("pipeline");
    assert.equal(r.length, 2);
    assert.deepEqual([r[0].title, r[0].lines.length, r[0].hits], ["Weekly Sync", 3, 8]);
    assert.ok(r[0].lines.every((l) => l.text.length <= 402));
    // Files over 20 MB are not read for lines (their title still searches). Made big for real, so the stat path is the one tested.
    writeBigMeeting(dir, "20261028_130000-teams-big", { title: "Big", start: at("13:00:00") });
    feed.rescan();
    assert.equal(feed.scan().list.find((m) => m.title === "Big").size > 20 * 1024 * 1024, true);
    const again = feed.search("pipeline");
    assert.deepEqual(again.map((m) => m.title), ["Weekly Sync"]);
    assert.deepEqual(feed.search("big").map((m) => [m.title, m.hits]), [["Big", 0]], "its title still searches");
    // Cached lines are kept (and counted) per file.
    assert.ok(feed.linesBytes > 0);
    const hit = feed.linesCache.get(join(dir, "20261028_140000-teams-many.jsonl"));
    assert.equal(feed.linesOf(feed.scan().list.find((m) => m.title === "Weekly Sync")), hit.lines);
    feed.linesBytes = 60 * 1024 * 1024;
    writeFileSync(join(dir, "20261028_120000-teams-other.jsonl"), line({ type: "metadata", meeting: "Other", recorded_at: at("12:00:00") }) + line({ type: "caption", speaker: "A", text: "pipeline too", ts: at("12:01:00") }));
    feed.rescan();
    feed.search("pipeline");
    assert.ok(feed.linesCache.size <= 2, "over the byte cap the oldest lines go");
  } finally {
    f.done();
  }
});

test("search: a long line that matches only the speaker still gets a snippet", () => {
  const f = fixture();
  try {
    const dir = join(f.root, "hist");
    const text = "words ".repeat(120);
    writeMeeting(dir, "20261028_140000-teams-long", { appId: "teams", lines: [["Zed Zebra", text]] });
    const feed = new MeetingFeed(f.state, { dataDir: dir });
    const r = feed.search("zebra");
    assert.equal(r.length, 1);
    assert.equal(r[0].lines[0].text.startsWith("words words"), true, "cut from the start, not \"……\"");
    assert.equal(r[0].lines[0].text.includes("words"), true);
    assert.equal(r[0].lines[0].speaker, "Zed Zebra");
  } finally {
    f.done();
  }
});

test("a transcript over 20 MB: listed from its head and tail, searched by title only, and a past view loads only its end", () => {
  const f = fixture();
  try {
    const dir = join(f.root, "hist");
    const path = writeBigMeeting(dir, "20261028_130000-zoom-big");
    assert.equal(statSync(path).size > 20 * 1024 * 1024, true);
    const feed = new MeetingFeed(f.state, { dataDir: dir });
    const t0 = Date.now();
    const [m] = feed.history();
    assert.deepEqual([m.title, m.app, m.duration, m.people, m.names, m.ended_at], ["Big", "Zoom", "0:30:00", 2, ["Ada", "Bo"], at("13:30:00")], "header, people and stopped come from the head and tail");
    assert.equal(m.captions < 2000, true, `only the tail is counted (${m.captions})`);
    assert.equal(Date.now() - t0 < 2000, true);
    assert.deepEqual(feed.search("pipeline"), [], "transcript lines are not searched");
    assert.equal(feed.search("big").length, 1);
    // The past view: the last 8 MB, flagged partial; the cursor still works (total is stable).
    const snap = feed.snapshot(0, m.id);
    assert.equal(snap.partial, true);
    assert.equal(snap.entries.length > 0 && snap.entries.length < 22_000, true);
    assert.equal(snap.entries.at(-1).type, "stopped");
    assert.equal(snap.state.ended, true);
    assert.equal(feed.snapshot(snap.total, m.id).entries.length, 0);
    assert.equal(feed.loaded.size, 1);
  } finally {
    f.done();
  }
});

test("the first scan is spread over calls: newest first, partial until done, and an id lookup parses only its own file", () => {
  const h = history();
  try {
    const feed = new MeetingFeed(h.state, { alive: () => true, dataDir: h.dir, now: () => Date.parse(at("15:00:00")), scanBudgetMs: 0 });
    // A zero budget parses one file per call: the newest.
    let l = feed.listing();
    assert.deepEqual([l.meetings.map((m) => m.title), l.total, l.partial], [["Weekly Sync"], 1, true]);
    l = feed.listing();
    assert.deepEqual([l.meetings.map((m) => m.title), l.partial], [["Weekly Sync", "Standup"], true]);
    l = feed.listing();
    l = feed.listing();
    assert.deepEqual([l.meetings.length, l.total, l.partial], [4, 4, false]);
    assert.equal(feed.listing().partial, false, "done: cached again");
    assert.equal(feed.scanned.partial, false);

    // A lookup by id that the half-done scan has not reached works out each unparsed file's id from its
    // header and parses only the matching file: no synchronous full scan, and a made-up id parses nothing.
    const full = h.feed.history();
    const old = full.find((m) => m.title === "Retro");
    const cold = new MeetingFeed(h.state, { alive: () => true, dataDir: h.dir, now: () => Date.parse(at("15:00:00")), scanBudgetMs: 0 });
    cold.listing();
    assert.equal(cold.scanned.partial, true);
    assert.equal(cold.infos.size, 1);
    assert.equal(cold.snapshot(0, old.id).notFound, undefined);
    assert.equal(cold.scanned.partial, true, "the scan was not finished for it");
    const parsed = () => [...cold.infos.values()].filter((c) => c.info).map((c) => c.info.title);
    assert.equal(parsed().includes("Retro"), true);
    assert.equal(parsed().length < 4, true, "the other files were not parsed for it");
    const before = parsed().length;
    assert.equal(cold.find("0123456789ab"), undefined);
    assert.equal(parsed().length <= before + 1, true, "an unknown id parses nothing itself (the scan's own one-file step aside)");
    // The file named by the filename stamp alone (no metadata) is found by the same derived id.
    const noMeta = full.find((m) => m.title === "design review");
    const cold2 = new MeetingFeed(h.state, { alive: () => true, dataDir: h.dir, now: () => Date.parse(at("15:00:00")), scanBudgetMs: 0 });
    cold2.listing();
    assert.equal(cold2.find(noMeta.id)?.title, "design review");

    // A file that changed keeps its old row while the scan catches up.
    const warm = new MeetingFeed(h.state, { alive: () => true, dataDir: h.dir, now: () => Date.parse(at("15:00:00")), scanBudgetMs: 1e9 });
    assert.equal(warm.listing().total, 4);
    appendFileSync(join(h.dir, "20261028_100000-zoom-standup.jsonl"), line({ type: "caption", speaker: "Bo", text: "more", ts: at("10:03:00") }));
    warm.rescan();
    warm.scanBudgetMs = 0;
    appendFileSync(join(h.dir, "20261028_140000-teams-weekly-sync.jsonl"), line({ type: "caption", speaker: "Bo", text: "more", ts: at("14:03:00") }));
    warm.rescan();
    l = warm.listing();
    assert.deepEqual([l.total, l.partial], [4, true], "the stale standup row is still listed");
  } finally {
    h.done();
  }
});

test("search: reads at most a byte budget per search (cache hits are free), then says partial", () => {
  const h = history();
  try {
    const size = (b) => statSync(join(h.dir, `${b}.jsonl`)).size;
    const weekly = size("20261028_140000-teams-weekly-sync");
    const standup = size("20261028_100000-zoom-standup");
    const opts = { alive: () => true, dataDir: h.dir, now: () => Date.parse(at("15:00:00")) };
    const feed = new MeetingFeed(h.state, { ...opts, searchBytes: weekly + standup });
    let r = feed.searchResult("cert");
    assert.deepEqual([r.results.map((m) => m.title), r.partial, r.searched], [["Weekly Sync", "Standup"], true, 2], "the third meeting would go over the budget");
    // What is cached is free the next time, so the search reaches further.
    r = feed.searchResult("cert");
    assert.deepEqual([r.results.map((m) => m.title), r.partial, r.searched], [["Weekly Sync", "Standup"], false, 4]);
    const tiny = new MeetingFeed(h.state, { ...opts, searchBytes: weekly - 1 });
    r = tiny.searchResult("cert");
    assert.deepEqual([r.results, r.partial, r.searched], [[], true, 0]);
    assert.deepEqual(new MeetingFeed(h.state, opts).searchResult("cert").partial, false);
    assert.deepEqual(new MeetingFeed(h.state, opts).searchResult("c"), { results: [], partial: false, searched: 0 });
    // The page's search keeps working through search().
    assert.deepEqual(new MeetingFeed(h.state, opts).search("cert").length, 2);
  } finally {
    h.done();
  }
});

test("search: the lines cache keeps what the running search used, and is trimmed back to its cap afterwards", () => {
  const h = history();
  try {
    const feed = new MeetingFeed(h.state, { alive: () => true, dataDir: h.dir, now: () => Date.parse(at("15:00:00")), linesCacheBytes: 1 });
    const r0 = feed.searchResult("cert");
    assert.deepEqual([r0.results.length, r0.partial, r0.searched], [2, false, 4], "a cache smaller than the corpus still lets the search use every entry");
    assert.equal(feed.linesCache.size, 1, "then it is trimmed back (oldest out)");
    assert.equal(feed.linesBytes, [...feed.linesCache.values()][0].bytes);
    // A newer meeting arrives; a search that stops after it evicts the older entries (they are not this search's).
    writeMeeting(h.dir, "20261028_150000-teams-newest", { appId: "teams", title: "Newest", start: at("15:00:00"), lines: [["Ada", "cert again"]] });
    feed.rescan();
    const r = feed.search("cert", { limit: 1 });
    assert.deepEqual(r.map((m) => m.title), ["Newest"]);
    assert.deepEqual([...feed.linesCache.keys()], [join(h.dir, "20261028_150000-teams-newest.jsonl")]);
    assert.equal(feed.linesBytes, [...feed.linesCache.values()][0].bytes);
  } finally {
    h.done();
  }
});

test("search: repeated rare-term searches never grow the lines cache past linesCacheBytes + searchBytes", () => {
  const f = fixture();
  const dir = join(f.root, "many");
  try {
    // 12 meetings of ~30 KB of transcript each; a term that matches none walks them all.
    const bases = [];
    for (let k = 0; k < 12; k++) {
      const base = `202610${String(10 + k)}_090000-zoom-m${k}`;
      bases.push(base);
      writeMeeting(dir, base, { app: "Zoom", appId: "zoom", title: `M${k}`, start: at("09:00:00", `2026-10-${10 + k}`), lines: Array.from({ length: 60 }, (_, i) => ["Ada", `filler ${k} ${i} ${"y".repeat(300)}`]) });
    }
    const size = statSync(join(dir, `${bases[0]}.jsonl`)).size;
    const probe = new MeetingFeed(f.state, { alive: () => true, dataDir: dir, now: () => Date.parse(at("15:00:00")) });
    probe.searchResult("zzqrare");
    const entry = Math.max(...[...probe.linesCache.values()].map((v) => v.bytes)); // what one meeting costs in the cache
    const searchBytes = size * 3;
    const linesCacheBytes = Math.floor(entry * 2.5);
    const feed = new MeetingFeed(f.state, { alive: () => true, dataDir: dir, now: () => Date.parse(at("15:00:00")), searchBytes, linesCacheBytes });
    let max = 0;
    let partials = 0;
    for (let i = 0; i < 8; i++) {
      const orig = feed.linesOf.bind(feed);
      feed.linesOf = (info) => {
        const r = orig(info);
        max = Math.max(max, feed.linesBytes);
        return r;
      };
      const r = feed.searchResult("zzqrare");
      feed.linesOf = orig;
      if (r.partial) partials++;
      assert.deepEqual(r.results, []);
      assert.equal(feed.linesBytes <= linesCacheBytes, true, "trimmed back after each search");
    }
    const one = [...feed.linesCache.values()][0].bytes;
    assert.equal(max <= linesCacheBytes + searchBytes + one, true, `hard cap held (peak ${max})`);
    assert.equal(partials, 8, "every search stops as partial: the archive is bigger than one search may hold");
    assert.equal(feed.linesBytes, [...feed.linesCache.values()].reduce((n, v) => n + v.bytes, 0));
  } finally {
    f.done();
  }
});

test("search: stops as partial when its time budget runs out", () => {
  const h = history();
  try {
    const feed = new MeetingFeed(h.state, { alive: () => true, dataDir: h.dir, now: () => Date.parse(at("15:00:00")), searchBudgetMs: 0 });
    const r = feed.searchResult("cert");
    assert.deepEqual([r.partial, r.searched], [true, 1], "at least one meeting is searched, then the clock stops it");
    assert.equal(new MeetingFeed(h.state, { alive: () => true, dataDir: h.dir, now: () => Date.parse(at("15:00:00")) }).searchResult("cert").partial, false);
  } finally {
    h.done();
  }
});

test("search: the live meeting is searched from memory", () => {
  const f = fixture();
  try {
    const feed = new MeetingFeed(f.state, { alive: () => true, dataDir: join(f.root, "nothing-here") });
    f.writeState({});
    writeFileSync(f.jsonl, line({ type: "caption", speaker: "Ada", text: "the Canary is live", ts: "t1" }));
    feed.poll();
    const r = feed.search("canary");
    assert.deepEqual([r.length, r[0].live, r[0].lines[0].i, r[0].id], [1, true, 0, feed.id]);
  } finally {
    f.done();
  }
});

test("archived notes: <id>.json in the notes folder, validated and bounded, for the history list and a past meeting", () => {
  const h = history();
  try {
    const notesDir = join(h.root, "archive");
    mkdirSync(notesDir);
    h.feed.notesDir = notesDir;
    const id = h.feed.history().find((m) => m.title === "Weekly Sync").id;
    assert.equal(h.feed.history()[0].notes, null, "none yet");
    writeFileSync(
      join(notesDir, `${id}.json`),
      JSON.stringify(
        rawNotes({
          pid: 1,
          ended: true,
          topics: Array.from({ length: 30 }, (_, i) => ({ title: `Topic ${i}`, summary: "s" })),
          actions: Array.from({ length: 50 }, (_, i) => ({ who: "w", what: `a${i}`, mine: i < 2 })),
        }),
      ),
    );
    const entry = h.feed.history()[0];
    assert.deepEqual(entry.notes, { actions: 20, mine: 2, topics: ["Topic 0", "Topic 1", "Topic 2", "Topic 3"] }, "bounded like the live notes, at most 4 topics");
    const snap = h.feed.snapshot(0, id);
    assert.equal(snap.notes.topics.length, 8);
    assert.equal(snap.notes.actions.length, 20);
    assert.equal(JSON.stringify(snap.notes).includes("s-secret-id"), false);
    assert.equal(h.feed.search("topic 3")[0].fields.includes("notes"), true, "notes are searched");
    // Invalid shape, garbage and unsafe ids are no notes.
    writeFileSync(join(notesDir, `${id}.json`), JSON.stringify({ ...rawNotes(), v: 2 }));
    assert.equal(h.feed.history()[0].notes, null);
    writeFileSync(join(notesDir, `${id}.json`), "{ nope");
    assert.equal(h.feed.history()[0].notes, null);
    assert.equal(h.feed.archived("../x"), null);
    // The folder comes from PI_MEETING_NOTES_DIR, else <root>/meetings.
    const saved = process.env.PI_MEETING_NOTES_DIR;
    process.env.PI_MEETING_NOTES_DIR = "/n/dir";
    assert.equal(notesDirPath("/x/canvas"), "/n/dir");
    delete process.env.PI_MEETING_NOTES_DIR;
    assert.equal(notesDirPath("/x/canvas"), "/x/canvas/meetings");
    if (saved !== undefined) process.env.PI_MEETING_NOTES_DIR = saved;
  } finally {
    h.done();
  }
});

test("archived notes: the live meeting keeps the live-file logic, and falls back to the archive", () => {
  const h = history();
  try {
    const notesDir = join(h.root, "archive");
    mkdirSync(notesDir);
    const notesFile = join(h.root, ".meeting-notes.json");
    const base = join(h.dir, "20261028_140000-teams-weekly-sync");
    const feed = new MeetingFeed(h.state, { alive: () => true, dataDir: h.dir, notesFile, notesDir });
    h.writeState({ app_id: "teams", started_at: at("14:00:00"), jsonl: `${base}.jsonl`, slides_dir: `${base}.slides` });
    writeFileSync(notesFile, JSON.stringify(rawNotes({ topics: [{ title: "Live topic", summary: "" }] })));
    feed.poll();
    const id = feed.id;
    assert.deepEqual(feed.history().find((m) => m.id === id).notes.topics, ["Live topic"]);
    writeFileSync(join(notesDir, `${id}.json`), JSON.stringify(rawNotes({ topics: [{ title: "Archived topic", summary: "" }] })));
    assert.deepEqual(feed.history().find((m) => m.id === id).notes.topics, ["Live topic"], "live logic wins while it applies");
    rmSync(notesFile);
    feed.poll();
    assert.deepEqual(feed.history().find((m) => m.id === id).notes.topics, ["Archived topic"]);
  } finally {
    h.done();
  }
});

test("card summary: recent is the newest four; live, just ended, or just the list", () => {
  const h = history();
  try {
    for (let i = 0; i < 3; i++) writeMeeting(h.dir, `2026102${i + 1}_120000-zoom-x${i}`, { appId: "zoom", title: `Old ${i}`, start: at("12:00:00", `2026-10-2${i + 1}`) });
    h.feed.rescan();
    // Nothing live: the list alone.
    assert.equal(h.feed.state, null);
    let s = h.feed.summary();
    assert.deepEqual([s.kind, s.recording, s.id, s.recent.length], ["list", false, "", 4]);
    assert.deepEqual(s.recent.map((m) => m.title), ["Weekly Sync", "Standup", "design review", "Old 2"]);
    assert.equal(JSON.stringify(s).includes(h.root), false);
    // Live: today's card plus the list.
    h.writeState({ app_id: "teams", started_at: at("15:00:00"), meeting: "Now", jsonl: join(h.dir, "20261028_150000-teams-now.jsonl") });
    writeFileSync(join(h.dir, "20261028_150000-teams-now.jsonl"), line({ type: "caption", speaker: "Ada", text: "Hi", ts: at("15:00:05") }));
    h.feed.poll();
    s = h.feed.summary();
    assert.deepEqual([s.kind, s.recording, s.title, s.lines.map((e) => e.text)], ["live", true, "Now", ["Hi"]]);
    assert.deepEqual(s.recent, [], "the live card never shows the list, so it is not built");
    assert.equal(h.feed.history()[0].live, true, "(the list itself has the live meeting on top)");
    // Just ended: expanded, with the rest below; later, only the list.
    h.writeState({ app_id: "teams", started_at: at("15:00:00"), meeting: "Now", jsonl: join(h.dir, "20261028_150000-teams-now.jsonl"), ended: true, ended_at: at("15:10:00"), duration: "0:10:00" });
    h.feed.poll();
    h.feed.now = () => Date.parse(at("15:12:00"));
    s = h.feed.summary();
    assert.deepEqual([s.kind, s.ended, s.recent[0].title, s.recent[0].live, s.recent[0].duration], ["ended", true, "Now", false, "0:10:00"]);
    h.feed.now = () => Date.parse(at("15:10:00")) + CARD_AFTER_END_MS + 1;
    assert.equal(h.feed.summary().kind, "list");
    // No meetings at all: no card.
    assert.equal(new MeetingFeed(h.state, { dataDir: join(h.root, "empty") }).summary(), null);
  } finally {
    h.done();
  }
});

test("a new meeting appearing or ending is a final change, and the card's `at` moves with it", () => {
  const h = history();
  try {
    h.feed.poll();
    const quiet = h.feed.poll();
    assert.deepEqual(quiet, { final: false, live: false });
    h.writeState({ app_id: "teams", started_at: at("15:00:00"), meeting: "Now", jsonl: null });
    assert.equal(h.feed.poll().final, true);
    const a = h.feed.summary().at;
    h.writeState({ app_id: "teams", started_at: at("15:00:00"), meeting: "Now", jsonl: null, ended: true, ended_at: at("15:01:00"), duration: "0:01:00" });
    h.feed.now = () => Date.parse(at("15:01:30"));
    assert.equal(h.feed.poll().final, true);
    assert.notEqual(h.feed.summary().at, a);
  } finally {
    h.done();
  }
});

test("daemon: /meetings, /api/meetings, /api/meetings/search, past /api/meeting?id= and slides, from --meeting-data", async () => {
  const h = history();
  const port = 23790 + Math.floor(Math.random() * 1000);
  const daemon = fileURLToPath(new URL("../extensions/canvas/daemon.mjs", import.meta.url));
  const notesDir = join(h.root, "archive");
  mkdirSync(notesDir);
  const child = spawn(process.execPath, [daemon, "--port", String(port), "--root", join(h.root, "canvas"), "--omarchy", join(h.root, "none"), "--meeting", h.state, "--meeting-data", h.dir], {
    stdio: "ignore",
    env: { ...process.env, PI_MEETING_NOTES_DIR: notesDir },
  });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
  try {
    let d;
    for (let i = 0; i < 60; i++) {
      d = await get("/api/meetings").then((r) => r.json(), () => null);
      if (d?.meetings) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual([d.meetings.length, d.live, d.more], [4, null, false]);
    const sync = d.meetings[0];
    writeFileSync(join(notesDir, `${sync.id}.json`), JSON.stringify(rawNotes({ pid: 1, ended: true })));
    const paged = await get("/api/meetings?limit=2&offset=1").then((r) => r.json());
    assert.deepEqual([paged.meetings.map((m) => m.title), paged.more], [["Standup", "design review"], true]);
    assert.equal((await get("/api/meetings?limit=1000").then((r) => r.json())).meetings.length, 4, "limit is capped, not an error");
    assert.equal((await get("/api/meetings?limit=-5&offset=abc").then((r) => r.json())).meetings.length, 4);

    const found = await get("/api/meetings/search?q=rotate").then((r) => r.json());
    assert.deepEqual([found.q, found.results.length, found.results[0].lines.length], ["rotate", 1, 2]);
    assert.deepEqual((await get("/api/meetings/search?q=a").then((r) => r.json())).results, []);

    const past = await get(`/api/meeting?id=${sync.id}`).then((r) => r.json());
    assert.deepEqual([past.state.title, past.state.ended, past.total > 3], ["Weekly Sync", true, true]);
    assert.equal(JSON.stringify(past).includes(h.root), false);
    assert.equal(past.notes.topics[0].title, "Cert rotation", "archived notes");
    const miss = await get("/api/meeting?id=0123456789ab").then((r) => r.json());
    assert.equal(miss.notFound, true);

    const img = await get(`/meeting/${sync.id}/slide/1.thumb.jpg`);
    assert.deepEqual([img.status, img.headers.get("content-type"), await img.text()], [200, "image/jpeg", "thumb1"]);
    assert.equal((await get(`/meeting/${sync.id}/slide/7.jpg`)).status, 404);
    assert.equal((await get(`/meeting/${encodeURIComponent("../hist")}/slide/1.jpg`)).status, 404);

    const page = await get("/meetings");
    assert.match(await page.text(), /meetings-page\.mjs/);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'(;|$)/);
    const js = await get("/assets/meetings-page.mjs");
    assert.equal(js.status, 200);
    const card = await get("/api/s/nobody").then((r) => r.json());
    assert.deepEqual([card.meeting.kind, card.meeting.recent.length, card.meeting.recent[0].notes.mine], ["list", 4, 1]);
  } finally {
    child.kill();
    h.done();
  }
});

// ── the pages' scripts, in jsdom (no browser, no network) ──

import { JSDOM } from "jsdom";

const pageSource = (name) => readFileSync(fileURLToPath(new URL(`../extensions/canvas/${name}`, import.meta.url)), "utf8");
const windows = [];
after(() => windows.forEach((w) => w.close())); // the pages' timers would hold the process open
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Run one of the page modules (plain scripts apart from comments) in a fresh jsdom with canned API answers. */
async function runPage(name, { url, api }) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  const calls = [];
  w.fetch = async (u) => {
    calls.push(String(u));
    const body = await api(String(u));
    return { ok: true, json: async () => body };
  };
  w.EventSource = class {
    addEventListener() {}
  };
  w.Element.prototype.scrollIntoView = function () {
    this.dataset.scrolled = "1";
  };
  w.eval(pageSource(name));
  await tick();
  return { w, doc: w.document, calls };
}

const entry = (over = {}) => ({ id: "aaaaaaaaaaaa", title: "Weekly Sync", app: "Microsoft Teams", started_at: new Date().toISOString(), ended_at: new Date().toISOString(), duration: "0:32:10", live: false, people: 3, names: [], slides: 2, captions: 5, thumb: true, notes: { actions: 3, mine: 2, topics: ["Cert rotation", "Canary", "A", "B"] }, ...over });

test("meetings page: live pinned on top, days grouped, rows link to /meeting?id=, load more, search with marks", async () => {
  const day = (n) => new Date(Date.now() - n * 86_400_000 - 3_600_000).toISOString();
  const list = [entry({ id: "live00000000", title: "Live <b>one</b>", live: true, ended_at: undefined, duration: "", thumb: false }), entry({ id: "a00000000000", started_at: new Date().toISOString() }), entry({ id: "b00000000000", title: "Yesterday's", started_at: day(1), thumb: false, notes: null }), entry({ id: "c00000000000", title: "Old", started_at: "2026-10-20T09:00:00-05:00" })];
  const { doc, calls } = await runPage("meetings-page.mjs", {
    url: "http://127.0.0.1:8790/meetings",
    api: (u) => {
      if (u.startsWith("/api/meetings/search")) return { q: "cert", results: [{ ...list[1], hits: 5, fields: ["transcript"], lines: [{ ts: "2026-10-28T14:12:05Z", speaker: "Ada", text: "The Cert expires <i>Friday</i>", i: 7 }] }] };
      return { meetings: list, live: "live00000000", more: true };
    },
  });
  assert.equal(doc.querySelector("h1").textContent, "Meetings");
  assert.equal(doc.querySelector("header a.back").getAttribute("href"), "/");
  const live = doc.querySelector(".item.live");
  assert.match(live.textContent, /Live <b>one<\/b>/, "title is text, not markup");
  assert.equal(live.querySelector("a").getAttribute("href"), "/meeting");
  assert.equal(doc.querySelector("b i, .t b"), null, "no element built from the data");
  const rows = [...doc.querySelectorAll(".item:not(.live) a.mrow")];
  assert.deepEqual(rows.map((a) => a.getAttribute("href")), ["/meeting?id=a00000000000", "/meeting?id=b00000000000", "/meeting?id=c00000000000"]);
  assert.deepEqual([...doc.querySelectorAll(".day")].map((d) => d.textContent).slice(0, 2), ["Today", "Yesterday"]);
  assert.match(doc.querySelectorAll(".day")[2].textContent, /^[A-Z][a-z]{2} Oct 20$/);
  assert.match(rows[0].textContent, /Microsoft Teams· \d\d:\d\d· 32m· 3 people· 2 slides★ 2/);
  assert.deepEqual([...rows[0].querySelectorAll(".tags span")].map((s) => s.textContent), ["Cert rotation", "Canary", "A", "B"]);
  assert.equal(rows[0].querySelector("img.thumb").getAttribute("src"), "/meeting/a00000000000/slide/1.thumb.jpg");
  assert.equal(rows[0].querySelector("img.thumb").getAttribute("loading"), "lazy");
  assert.equal(rows[1].querySelector("img.thumb"), null);
  assert.ok(doc.querySelector("button.more-btn"), "load more");
  assert.equal(JSON.stringify([doc.body.innerHTML]).includes("recording"), false, "never the word recording");

  // Search: debounced, replaces the list, highlights terms with <mark> and links to the line.
  const input = doc.querySelector("header input");
  input.value = "cert";
  input.dispatchEvent(new doc.defaultView.Event("input"));
  await tick(300);
  assert.ok(calls.some((c) => c === "/api/meetings/search?q=cert"));
  assert.equal(doc.querySelector(".day"), null);
  const hit = doc.querySelector("a.hit");
  assert.equal(hit.getAttribute("href"), "/meeting?id=a00000000000#e7");
  assert.deepEqual([...hit.querySelectorAll("mark")].map((m) => m.textContent), ["Cert"]);
  assert.match(hit.textContent, /The Cert expires <i>Friday<\/i>/);
  assert.match(doc.querySelector(".more").textContent, /\+4 more/);
  // Esc clears the box and brings the list back.
  input.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  assert.equal(input.value, "");
  assert.ok(doc.querySelector(".day"));
});

test("meetings page: no matches, and an empty history, say so", async () => {
  const { doc } = await runPage("meetings-page.mjs", { url: "http://127.0.0.1:8790/meetings", api: (u) => (u.startsWith("/api/meetings/search") ? { q: "zzz", results: [] } : { meetings: [], live: null, more: false }) });
  assert.match(doc.querySelector(".msg").textContent, /No meetings yet/);
  const input = doc.querySelector("header input");
  input.value = "zzz";
  input.dispatchEvent(new doc.defaultView.Event("input"));
  await tick(300);
  assert.match(doc.querySelector(".msg").textContent, /No meetings match/);
});

test("meeting page: ?id= asks for that meeting, #e<i> scrolls to the entry and flashes it, 'All meetings' links back", async () => {
  const snap = {
    id: "aaaaaaaaaaaa",
    state: { title: "Weekly Sync", app: "Teams", startedAt: "2026-10-28T14:00:00Z", recording: false, ended: true, crashed: false, endedAt: "2026-10-28T14:32:10Z", duration: "0:32:10", hasTranscript: true, hasSlides: false },
    entries: [0, 1, 2, 3].map((i) => ({ type: "caption", speaker: "Ada", text: `line ${i}`, ts: `2026-10-28T14:0${i}:00Z` })),
    total: 4,
    from: 0,
    slides: [],
    live: [],
    people: null,
    notes: null,
  };
  const { doc, calls } = await runPage("meeting-page.mjs", { url: "http://127.0.0.1:8790/meeting?id=aaaaaaaaaaaa#e2", api: () => snap });
  assert.match(calls[0], /^\/api\/meeting\?since=0&id=aaaaaaaaaaaa&cur=$/);
  assert.deepEqual([...doc.querySelectorAll("header a.back")].map((a) => [a.textContent, a.getAttribute("href")]), [["All meetings", "/meetings"], ["Canvas", "/"]]);
  assert.match(doc.querySelector(".meta .state").textContent, /^Ended · \w{3} \w{3} \d+$/);
  const row = doc.querySelector('.row[data-i="2"]');
  assert.match(row.textContent, /line 2/);
  assert.equal(row.dataset.scrolled, "1");
  assert.ok(row.classList.contains("flash"));
  assert.equal(doc.querySelector('.row[data-i="1"]').dataset.scrolled, undefined);
  assert.equal(doc.body.innerHTML.includes("recording"), false);
});

test("meeting page: an unknown id says Meeting not found, with a way back", async () => {
  const { doc } = await runPage("meeting-page.mjs", { url: "http://127.0.0.1:8790/meeting?id=0123456789ab", api: () => ({ id: "", state: null, entries: [], total: 0, from: 0, slides: [], live: [], people: null, notes: null, notFound: true }) });
  const empty = doc.querySelector(".empty");
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /Meeting not found/);
  assert.equal(empty.querySelector("a").getAttribute("href"), "/meetings");
});

// ── the card (page.mjs renderMeeting), pulled out of the module and run in jsdom ──

test("meeting card: live links, just-ended expanded plus list, plain recent list", async () => {
  const { h } = await import("../extensions/canvas/render.mjs");
  const dom = new JSDOM("<!doctype html><body></body>");
  windows.push(dom.window);
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  const src = pageSource("page.mjs");
  const code = src.slice(src.indexOf("const meetPad"), src.indexOf("// The card's elapsed time ticks"));
  const { renderMeeting } = new Function("h", "plural", `${code}; return { renderMeeting };`)(h, (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`);
  const recent = [entry({ id: "a00000000000", title: "Weekly Sync" }), entry({ id: "b00000000000", title: "Standup", notes: null, duration: "0:00:20", started_at: "2026-10-27T09:30:00-05:00" })];
  const base = { id: "a00000000000", title: "Weekly Sync", app: "Teams", startedAt: new Date().toISOString(), recording: true, ended: false, people: 3, slides: 1, slide: { n: 1, thumb: true }, lines: [{ type: "caption", speaker: "Ada", text: "Hi" }], recent, notes: { alerts: [{ kind: "name", who: "Ada", text: "Eric?", at: "2026-10-28T14:00:00Z" }], actions: [{ what: "own it", mine: true }] } };

  const live = renderMeeting({ ...base, kind: "live" });
  assert.deepEqual([...live.querySelectorAll(".m-open")].map((a) => [a.textContent, a.getAttribute("href")]), [["Open the live view ↗", "/meeting"], ["Previous meetings ↗", "/meetings"]]);
  assert.equal(live.querySelector(".m-list"), null);
  assert.match(live.textContent, /Live/);
  assert.equal(live.textContent.includes("Open the transcript"), false);

  const ended = renderMeeting({ ...base, kind: "ended", recording: false, ended: true, endedAt: new Date().toISOString(), duration: "0:10:00" });
  assert.match(ended.querySelector(".m-status").textContent, /Ended/);
  assert.ok(ended.querySelector(".m-alerts"), "the alerts box stays");
  assert.match(ended.querySelector(".m-todo").textContent, /own it/);
  assert.deepEqual([...ended.querySelectorAll(".m-item")].map((a) => a.getAttribute("href")), ["/meeting?id=b00000000000"], "the rest of the list, not the expanded one again");
  assert.equal(ended.querySelector(".m-open").getAttribute("href"), "/meetings");
  assert.equal(ended.querySelector(".m-open").textContent, "View all ↗");

  const list = renderMeeting({ kind: "list", id: "", recent, recording: false, ended: false });
  const items = [...list.querySelectorAll(".m-item")];
  assert.deepEqual(items.map((a) => [a.getAttribute("href"), a.getAttribute("target")]), [["/meeting?id=a00000000000", "_blank"], ["/meeting?id=b00000000000", "_blank"]]);
  assert.match(items[0].textContent, /^Weekly Sync(Today|Yesterday|\w{3} \w{3} \d+) \d\d:\d\d · 32m★ 2$/);
  assert.match(items[1].textContent, /^Standup.* · <1m$/);
  assert.equal(list.querySelector(".m-open").textContent, "View all ↗");
});

test("meeting card: short names, one block per speaker run, the in-progress line in italics", async () => {
  const { h } = await import("../extensions/canvas/render.mjs");
  const dom = new JSDOM("<!doctype html><body></body>");
  windows.push(dom.window);
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  const src = pageSource("page.mjs");
  const code = src.slice(src.indexOf("const meetPad"), src.indexOf("// The card's elapsed time ticks"));
  const { renderMeeting, meetName } = new Function("h", "plural", `${code}; return { renderMeeting, meetName };`)(h, (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`);
  assert.equal(meetName("Compton, Tori K. (governmentcio Llc)"), "Tori Compton");
  assert.equal(meetName("Alex Teal"), "Alex Teal");
  assert.equal(meetName("Ada B. Lovelace (ORG)"), "Ada Lovelace");
  assert.equal(meetName("Grace"), "Grace");
  const tori = "Compton, Tori K. (governmentcio Llc)";
  const lines = [
    { type: "caption", speaker: "Alex Teal", text: "One." },
    { type: "caption", speaker: "Alex Teal", text: "Two." },
    { type: "caption", speaker: tori, text: "Yeah." },
    { type: "caption", speaker: tori, text: "At 1:35." },
    { type: "chat", speaker: tori, text: "link?" },
  ];
  const card = renderMeeting({ kind: "live", id: "b1b1b1b1b1b1", title: "T", recording: true, startedAt: new Date().toISOString(), lines, live: [{ speaker: tori, text: "and then" }], total: 5, recent: [] });
  const rows = [...card.querySelectorAll(".m-line")];
  assert.deepEqual(rows.map((r) => [r.querySelector("b")?.textContent ?? "", r.className]), [["Alex Teal", "m-line"], ["Tori Compton", "m-line"], ["(chat) Tori Compton", "m-line chat"], ["Tori Compton", "m-line live"]]);
  assert.equal(rows[0].textContent, "Alex TealOne. Two.");
  assert.equal(rows[1].textContent, "Tori ComptonYeah. At 1:35.");
  assert.equal(rows[1].getAttribute("title"), tori, "the full name on hover");
  const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
  const lc = renderMeeting({ kind: "live", id: "c1c1c1c1c1c1", title: "T", recording: true, startedAt: new Date().toISOString(), lines: [{ type: "caption", speaker: "Ada", text: long }], live: [], total: 1, recent: [] });
  const txt = lc.querySelector(".m-line").textContent;
  assert.match(txt, /^Ada…w\d+ .* w199$/, "a long turn keeps its end, not its start");
});

test("feed.tailSnapshot() and /api/meeting?tail=1: only id, from, total, entries and live", async () => {
  const f = fixture();
  const port = 23790 + Math.floor(Math.random() * 1000);
  const daemon = fileURLToPath(new URL("../extensions/canvas/daemon.mjs", import.meta.url));
  const child = spawn(process.execPath, [daemon, "--port", String(port), "--root", join(f.root, "canvas"), "--omarchy", join(f.root, "none"), "--meeting", f.state], { stdio: "ignore" });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.json());
  try {
    f.writeState({ pid: child.pid });
    writeFileSync(f.jsonl, line({ type: "caption", speaker: "Ada", text: "One", ts: "t1" }) + line({ type: "caption", speaker: "Ada", text: "Two", ts: "t2" }));
    writeFileSync(join(f.slides, "0001-140100.jpg"), "jpg");
    appendFileSync(join(f.slides, "index.jsonl"), line({ n: 1, file: "0001-140100.jpg" }));
    let full;
    for (let i = 0; i < 60; i++) {
      full = await get("/api/meeting").then((d) => d, () => null);
      if (full?.total === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(full.slides.length && full.state, "the full snapshot is as before");
    const tail = await get(`/api/meeting?tail=1&since=1&id=${full.id}`);
    assert.deepEqual(Object.keys(tail).sort(), ["entries", "from", "id", "live", "total"]);
    assert.deepEqual([tail.id, tail.from, tail.total, tail.entries.map((e) => e.text)], [full.id, 1, 2, ["Two"]]);
    assert.ok(JSON.stringify(tail).length < JSON.stringify(full).length);
    // A cursor from another meeting starts over; a bad id is notFound-shaped but light too.
    const other = await get("/api/meeting?tail=1&since=1&id=0123456789ab");
    assert.deepEqual(Object.keys(other).sort(), ["entries", "from", "id", "live", "total"]);
    assert.equal(other.id, "");
    // The feed itself.
    const feed = new MeetingFeed(f.state, { alive: () => true });
    feed.poll();
    assert.deepEqual(Object.keys(feed.tailSnapshot(0)).sort(), ["entries", "from", "id", "live", "total"]);
  } finally {
    child.kill();
    f.done();
  }
});

/** The card's code out of page.mjs, run against a jsdom document with a fake fetch. */
async function cardPump() {
  const { h } = await import("../extensions/canvas/render.mjs");
  const dom = new JSDOM("<!doctype html><body></body>");
  windows.push(dom.window);
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  const src = pageSource("page.mjs");
  const code = src.slice(src.indexOf("const meetPad"), src.indexOf("// The card's elapsed time ticks"));
  const asked = [];
  const fetchFake = (url) =>
    new Promise((resolve) => {
      asked.push({ url: String(url), answer: (body) => resolve({ ok: true, json: async () => body }) });
    });
  const api = new Function("h", "plural", "fetch", `${code}; return { renderMeeting, pumpMeetTail, meetBlocks, meetName, getTail: () => meetTail };`)(h, (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`, fetchFake);
  const mount = (m) => {
    const card = api.renderMeeting({ kind: "live", id: "d1d1d1d1d1d1", title: "T", recording: true, startedAt: new Date().toISOString(), live: [], recent: [], ...m });
    dom.window.document.body.replaceChildren(card);
  };
  const text = () => [...dom.window.document.querySelectorAll(".m-line")].map((e) => e.textContent).join(" | ");
  return { ...api, asked, mount, text };
}
const capLine = (text, speaker = "Ada") => ({ type: "caption", speaker, text });

test("card pump: an answer for an older cursor (a render re-seeded the tail meanwhile) is dropped, then the poll runs again from the new cursor", async () => {
  const p = await cardPump();
  p.mount({ total: 5, lines: [capLine("five")] });
  const first = p.pumpMeetTail();
  await tick(5);
  assert.equal(p.asked.length, 1);
  assert.match(p.asked[0].url, /^\/api\/meeting\?tail=1&since=5&id=d1d1d1d1d1d1$/);
  // A refresh re-renders the card with a newer total while that poll is in flight.
  p.mount({ total: 9, lines: [capLine("five"), capLine("nine", "Bo")] });
  p.asked[0].answer({ id: "d1d1d1d1d1d1", from: 5, total: 7, entries: [capLine("seven")], live: [] });
  await first;
  await tick(5);
  assert.equal(p.getTail().total, 9, "the total never moves backwards");
  assert.equal(p.text().includes("seven"), false, "the stale lines are not shown");
  assert.match(p.text(), /five/);
  assert.match(p.text(), /nine/, "and the re-seeded lines were not cut down to the answer's");
  // The poll came back by itself, from the new cursor.
  assert.equal(p.asked.length, 2);
  assert.match(p.asked[1].url, /since=9&/);
  p.asked[1].answer({ id: "d1d1d1d1d1d1", from: 9, total: 10, entries: [capLine("ten", "Bo")], live: [] });
  await tick(5);
  assert.equal(p.getTail().total, 10);
  assert.match(p.text(), /five.*nine.*ten|Ada.*five.*Bo.*nine ten/s);
  assert.equal(p.getTail().lines.length, 3);
});

test("card pump: a poll asked for while one is in flight runs once more when it ends (no lost update), and a cursor mismatch resets the lines", async () => {
  const p = await cardPump();
  p.mount({ total: 2, lines: [capLine("one"), capLine("two")] });
  const first = p.pumpMeetTail();
  await tick(5);
  await p.pumpMeetTail(); // busy: remembered, not dropped
  await p.pumpMeetTail();
  assert.equal(p.asked.length, 1, "one at a time");
  p.asked[0].answer({ id: "d1d1d1d1d1d1", from: 2, total: 3, entries: [capLine("three")], live: [] });
  await first;
  await tick(5);
  assert.equal(p.asked.length, 2, "the update that came in meanwhile gets its poll");
  assert.match(p.asked[1].url, /since=3&/);
  p.asked[1].answer({ id: "d1d1d1d1d1d1", from: 3, total: 4, entries: [capLine("four")], live: [{ speaker: "Ada", text: "and five" }] });
  await tick(5);
  assert.equal(p.asked.length, 2, "and only once");
  assert.match(p.text(), /four/);
  assert.match(p.text(), /and five/, "the in-progress line");
  // The server started over (from 0, not the cursor): the old lines go, the answer's entries stay.
  const again = p.pumpMeetTail();
  await tick(5);
  p.asked[2].answer({ id: "d1d1d1d1d1d1", from: 0, total: 2, entries: [capLine("alpha"), capLine("beta")], live: [] });
  await again;
  assert.deepEqual(p.getTail().lines.map((l) => l.text), ["alpha", "beta"]);
  assert.equal(p.getTail().total, 2);
});

test("card: a cut that starts on the continuation of a live turn still names its speaker", async () => {
  const p = await cardPump();
  const blocks = p.meetBlocks([capLine("said so far"), { ...capLine("and going on"), live: true }], 1);
  assert.deepEqual(blocks.map((b) => [b.speaker, b.live, b.cont]), [["Ada", true, false]]);
  p.mount({ total: 2, lines: [capLine("said so far")], live: [{ speaker: "Ada", text: "and going on" }] });
  assert.equal(p.text(), "Adasaid so far | and going on", "uncut, the continuation has no second name");
});

test("meetName: suffixes and titles are dropped before 'Last, First' is read; one word, emails and initials are kept", async () => {
  const { meetName } = await cardPump();
  assert.equal(meetName("Smith, John, Jr."), "John Smith");
  assert.equal(meetName("Doe, Jane, III"), "Jane Doe");
  assert.equal(meetName("Smith, John Jr."), "John Smith");
  assert.equal(meetName("John Smith II"), "John Smith");
  assert.equal(meetName("Dr. Jane Doe"), "Jane Doe");
  assert.equal(meetName("Compton, Tori K. (governmentcio Llc)"), "Tori Compton");
  assert.equal(meetName("Ada B. Lovelace (ORG)"), "Ada Lovelace");
  assert.equal(meetName("Grace"), "Grace");
  assert.equal(meetName("ada@example.com"), "ada@example.com");
  assert.equal(meetName("Dr."), "Dr.");
  assert.equal(meetName("Jr."), "Jr.", "only a suffix: nothing else to show");
  assert.equal(meetName("Dr. Smith, John"), "John Smith");
  assert.equal(meetName("Smith, Dr. John"), "John Smith");
  assert.equal(meetName("Jane Q. Doe Jr."), "Jane Doe");
  assert.equal(meetName("Dr. Jane Doe, Jr."), "Jane Doe");
  assert.equal(meetName("Smith Jr., John"), "John Smith");
  assert.equal(meetName("Sr. Jr. Dr. Who"), "Who");
});

test("card css: .m-line has one rule (the old line-clamp rule was dead)", () => {
  const css = pageSource("page.mjs");
  assert.equal(css.match(/^\.m-line \{/gm).length, 1);
  assert.doesNotMatch(css, /\.m-line \{[^}]*line-clamp/);
});

test("feed.summary(): the newest 12 lines, the in-progress ones and the total; `at` stays put while nothing changes", () => {
  const f = fixture();
  try {
    f.writeState({ pid: process.pid });
    writeFileSync(f.jsonl, Array.from({ length: 15 }, (_, i) => line({ type: "caption", speaker: "Ada", text: `c${i}`, ts: `t${i}` })).join(""));
    const feed = new MeetingFeed(f.state, { alive: () => true });
    feed.poll();
    const s = feed.summary();
    assert.deepEqual(s.lines.map((e) => e.text), Array.from({ length: 12 }, (_, i) => `c${i + 3}`));
    assert.deepEqual([s.total, s.live], [15, []]);
    assert.equal(feed.summary().at, s.at, "asking again does not move `at`");
    feed.poll();
    assert.equal(feed.summary().at, s.at, "a quiet poll does not either");
  } finally {
    f.done();
  }
});
