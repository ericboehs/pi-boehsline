/**
 * Canvas: the live meeting feed (meeting-feed.mjs), read from meeting-capture's
 * state folder for the Meeting card and /meeting.
 *
 *   node --test test/canvas-meeting.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CARD_AFTER_END_MS, JsonlTail, MeetingFeed, normalizeLive, normalizeRecord, normalizeSlide, parseState } from "../extensions/canvas/meeting-feed.mjs";

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
