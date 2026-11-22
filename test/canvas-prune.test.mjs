/**
 * The nightly canvas cleanup (canvas/prune.mjs): old sections, stale Files
 * changed tracking, orphans, and folders nobody will open again.
 *
 * A temp canvas root stands in for ~/.pi/canvas, with times set rather than
 * waited for. The last tests drive the CLI the daemon runs, --dry-run included.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BOOKKEEPING, isArtifactName, LOG_NAME, nextRunDelay, pruneCanvas, pruneSession, schedulePrune, sessionFileTimes, summaryLine } from "../extensions/canvas/prune.mjs";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const DAY = 86_400_000;
/** Every test prunes as of now, and stamps fixture times against it. */
const NOW = Date.now();
const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "canvas-prune-"));
}

function write(dir, name, body) {
  writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

/** Backdate a path (a file's mtime, or a folder's when the folder is passed). */
function age(path, days) {
  const t = new Date(NOW - days * DAY);
  utimesSync(path, t, t);
}

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const deadMeta = (id) => ({ id, pid: 0, ended: daysAgo(1) });

/**
 * A session folder: meta.json, the files given as [name, body, ageDays], and
 * optionally the whole folder (meta.json included) aged.
 */
function session(root, id, files = [], { meta = deadMeta(id), age: dirAge = 0 } = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  write(dir, "meta.json", meta);
  if (dirAge) age(join(dir, "meta.json"), dirAge);
  for (const [name, body, days] of files) {
    write(dir, name, body);
    if (days) age(join(dir, name), days);
  }
  if (dirAge) age(dir, dirAge);
  return dir;
}

test("old sections go; new, auto and tracker sections stay", () => {
  const root = makeRoot();
  const dir = session(root, "s1", [["old.md", "old body", 20], ["fresh.md", "fresh body", 1], ["auto-files.md", "files", 40], ["auto-tasks.kanban", "{}", 40], ["ship.tracker", "{}", 40]]);
  write(dir, "sections.json", [
    { id: "old", title: "Old", kind: "markdown", file: "old.md", at: daysAgo(20) },
    { id: "fresh", title: "Fresh", kind: "markdown", file: "fresh.md", at: daysAgo(1) },
    { id: "auto-files", title: "Files changed", kind: "markdown", file: "auto-files.md", at: daysAgo(40), by: "auto" },
    { id: "auto-tasks", title: "Tasks", kind: "kanban", file: "auto-tasks.kanban", at: daysAgo(40), by: "auto" },
    { id: "ship", title: "Ship", kind: "tracker", file: "ship.tracker", at: daysAgo(40) },
  ]);

  const summary = pruneSession(root, "s1", { now: NOW });

  assert.deepEqual(summary.sections, ["old"]);
  assert.equal(existsSync(join(dir, "old.md")), false);
  assert.equal(existsSync(join(dir, "fresh.md")), true);
  assert.equal(existsSync(join(dir, "auto-files.md")), true);
  assert.equal(existsSync(join(dir, "auto-tasks.kanban")), true);
  assert.equal(existsSync(join(dir, "ship.tracker")), true);
  assert.deepEqual(json(join(dir, "sections.json")).map((s) => s.id).sort(), ["auto-files", "auto-tasks", "fresh", "ship"]);
  assert.equal(summary.removedDir, false);
});

test("a section with no file falls back to its `at`", () => {
  const root = makeRoot();
  const dir = session(root, "s1b");
  write(dir, "sections.json", [
    { id: "gone", title: "Gone", kind: "markdown", file: "gone.md", at: daysAgo(30) },
    { id: "there", title: "There", kind: "markdown", file: "there.md", at: daysAgo(2) },
  ]);
  write(dir, "there.md", "hi", 2);

  const summary = pruneSession(root, "s1b", { now: NOW });
  assert.deepEqual(summary.sections, ["gone"]);
  assert.deepEqual(json(join(dir, "sections.json")).map((s) => s.id), ["there"]);
});

test("referenced media stays, orphans go, unknown files stay", () => {
  const root = makeRoot();
  const dir = session(root, "s2", [
    ["shot.png", "png", 1],
    ["cmp.compare", JSON.stringify({ before: "cmp-before.png", after: "cmp-after.png" }), 1],
    ["cmp-before.png", "png", 1],
    ["cmp-after.png", "png", 1],
    ["notes.md", "![diagram](inline.png)", 1],
    ["inline.png", "png", 1],
    ["orphan.png", "png", 1],
    ["shot-0123456789ab.png", "png", 1],
    ["notes.txt", "mine", 1],
    ["keep.bin", "?", 1],
    ["stale.png.4242.tmp", "half written", 1],
  ]);
  write(dir, "sections.json", [
    { id: "shot", title: "Shot", kind: "image", file: "shot.png", at: daysAgo(1) },
    { id: "cmp", title: "Compare", kind: "compare", file: "cmp.compare", at: daysAgo(1), extra: ["cmp-before.png", "cmp-after.png"] },
    { id: "notes", title: "Notes", kind: "markdown", file: "notes.md", at: daysAgo(1) },
  ]);
  age(join(dir, "stale.png.4242.tmp"), 2 / 24); // two hours: a half-written file nobody finished

  const summary = pruneSession(root, "s2", { now: NOW });

  assert.deepEqual(summary.orphans.sort(), ["orphan.png", "shot-0123456789ab.png", "stale.png.4242.tmp"]);
  for (const kept of ["shot.png", "cmp.compare", "cmp-before.png", "cmp-after.png", "notes.md", "inline.png", "notes.txt", "keep.bin"]) {
    assert.equal(existsSync(join(dir, kept)), true, `${kept} should stay`);
  }
  for (const gone of ["orphan.png", "shot-0123456789ab.png", "stale.png.4242.tmp"]) {
    assert.equal(existsSync(join(dir, gone)), false, `${gone} should go`);
  }
});

test("a fresh .tmp is left alone (a write may be in flight)", () => {
  const root = makeRoot();
  const dir = session(root, "s2b", [["part.png.99.tmp", "writing", 0]]);
  const summary = pruneSession(root, "s2b", { now: NOW });
  assert.deepEqual(summary.orphans, []);
  assert.equal(existsSync(join(dir, "part.png.99.tmp")), true);
});

test("stale Files changed entries go with their base, cur and diff files", () => {
  const root = makeRoot();
  const dir = session(root, "s3", [
    ["auto-files.md", "| File |", 1],
    ["base-0123456789ab", "old base", 8],
    ["diff-0123456789ab.patch", "old patch", 8],
    ["cur-0123456789ab.txt", "old copy", 8],
    ["diff-ba9876543210.patch", "fresh patch", 1],
    ["cur-ba9876543210.txt", "fresh copy", 1],
    ["diff-cccccccccccc.patch", "no time anywhere", 10],
  ]);
  write(dir, "sections.json", [{ id: "auto-files", title: "Files changed", kind: "markdown", file: "auto-files.md", at: daysAgo(1), by: "auto" }]);
  write(dir, "auto-files.json", {
    "/repo/a.rb": { edits: 2, writes: 0, at: daysAgo(8) },
    "/repo/b.rb": { edits: 1, writes: 0, at: daysAgo(1) },
  });
  write(dir, "auto-diffs.json", {
    "/repo/a.rb": { base: "base-0123456789ab", patch: "diff-0123456789ab.patch", adds: 3, dels: 1 },
    "/repo/b.rb": { base: null, patch: "diff-ba9876543210.patch", adds: 1, dels: 0 },
    "/repo/c.rb": { base: null, patch: "diff-cccccccccccc.patch" },
  });
  write(dir, "auto-copies.json", {
    "/repo/a.rb": { file: "cur-0123456789ab.txt", mtimeMs: NOW - 8 * DAY, size: 7 },
    "/repo/b.rb": { file: "cur-ba9876543210.txt", mtimeMs: NOW - 1 * DAY, size: 7 },
  });

  const summary = pruneSession(root, "s3", { now: NOW });

  assert.deepEqual(summary.tracked, ["/repo/a.rb", "/repo/c.rb"]);
  assert.deepEqual(Object.keys(json(join(dir, "auto-files.json"))), ["/repo/b.rb"]);
  assert.deepEqual(Object.keys(json(join(dir, "auto-diffs.json"))), ["/repo/b.rb"]);
  assert.deepEqual(Object.keys(json(join(dir, "auto-copies.json"))), ["/repo/b.rb"]);
  for (const gone of ["base-0123456789ab", "diff-0123456789ab.patch", "cur-0123456789ab.txt", "diff-cccccccccccc.patch"]) {
    assert.equal(existsSync(join(dir, gone)), false, `${gone} should go`);
  }
  for (const kept of ["diff-ba9876543210.patch", "cur-ba9876543210.txt"]) {
    assert.equal(existsSync(join(dir, kept)), true, `${kept} should stay`);
  }
});

test("an emptied Files changed list takes its tracking files and its card", () => {
  const root = makeRoot();
  const dir = session(root, "s4", [
    ["auto-files.md", "| File |", 1],
    ["base-0123456789ab", "base", 9],
    ["diff-0123456789ab.patch", "patch", 9],
    ["cur-0123456789ab.txt", "copy", 9],
  ]);
  write(dir, "sections.json", [{ id: "auto-files", title: "Files changed", kind: "markdown", file: "auto-files.md", at: daysAgo(1), by: "auto" }]);
  write(dir, "auto-files.json", { "/repo/a.rb": { edits: 1, writes: 0, at: daysAgo(9) } });
  write(dir, "auto-diffs.json", { "/repo/a.rb": { base: "base-0123456789ab", patch: "diff-0123456789ab.patch" } });
  write(dir, "auto-copies.json", { "/repo/a.rb": { file: "cur-0123456789ab.txt", mtimeMs: NOW - 9 * DAY, size: 4 } });

  const summary = pruneSession(root, "s4", { now: NOW });

  assert.deepEqual(summary.sections, ["auto-files"]);
  assert.deepEqual(json(join(dir, "sections.json")), []);
  for (const gone of ["auto-files.json", "auto-diffs.json", "auto-copies.json", "auto-files.md", "base-0123456789ab", "diff-0123456789ab.patch", "cur-0123456789ab.txt"]) {
    assert.equal(existsSync(join(dir, gone)), false, `${gone} should go`);
  }
});

test("a dead 31-day folder goes; a live one and one with a fresh transcript stay", () => {
  const root = makeRoot();
  const dead = session(root, "dead", [["old.md", "old", 31], ["status.json", "{}", 31]], { age: 31 });
  const live = session(root, "live", [["status.json", "{}", 40]], { meta: { id: "live", pid: process.pid }, age: 40 });
  const talked = session(root, "talked", [["old.md", "old", 31], ["status.json", "{}", 31]], { age: 31 });

  const sessionFiles = new Map([
    ["dead", NOW - 31 * DAY],
    ["talked", NOW - 2 * DAY],
  ]);
  const summary = pruneSession(root, "dead", { now: NOW, sessionFiles });
  assert.equal(summary.removedDir, true);
  assert.equal(existsSync(join(root, "dead")), false);

  const keptLive = pruneSession(root, "live", { now: NOW, sessionFiles });
  assert.equal(keptLive.removedDir, false);
  assert.equal(existsSync(join(root, "live")), true);

  const keptTalked = pruneSession(root, "talked", { now: NOW, sessionFiles });
  assert.equal(keptTalked.removedDir, false);
  assert.match(keptTalked.kept, /transcript/);
  assert.equal(existsSync(join(root, "talked")), true);
});

test("--days moves the folder cutoff", () => {
  const files = [["status.json", "{}", 5], ["x.md", "x", 5]];
  const kept = makeRoot();
  session(kept, "young", files, { age: 5 });
  assert.equal(pruneSession(kept, "young", { now: NOW, dirDays: 30, sessionFiles: new Map() }).removedDir, false);

  const pruned = makeRoot();
  const dir = session(pruned, "young", files, { age: 5 });
  assert.equal(pruneSession(pruned, "young", { now: NOW, dirDays: 2, sessionFiles: new Map() }).removedDir, true);
  assert.equal(existsSync(dir), false);
});

test("an active turn only gets its sections pruned", () => {
  const root = makeRoot();
  const dir = session(
    root,
    "turn",
    [
      ["old.md", "old", 20],
      ["auto-files.md", "| File |", 1],
      ["base-0123456789ab", "base", 9],
      ["diff-0123456789ab.patch", "patch", 9],
      ["orphan.png", "png", 2],
      ["turn.json", JSON.stringify({ started: daysAgo(0) }), 0],
    ],
    { meta: { id: "turn", pid: process.pid } },
  );
  write(dir, "sections.json", [
    { id: "old", title: "Old", kind: "markdown", file: "old.md", at: daysAgo(20) },
    { id: "auto-files", title: "Files changed", kind: "markdown", file: "auto-files.md", at: daysAgo(1), by: "auto" },
  ]);
  write(dir, "auto-files.json", { "/repo/a.rb": { edits: 1, writes: 0, at: daysAgo(9) } });
  write(dir, "auto-diffs.json", { "/repo/a.rb": { base: "base-0123456789ab", patch: "diff-0123456789ab.patch" } });

  const summary = pruneSession(root, "turn", { now: NOW });

  assert.equal(summary.activeTurn, true);
  assert.deepEqual(summary.sections, ["old"]);
  assert.equal(existsSync(join(dir, "old.md")), false);
  // The tracking and the orphan wait for the turn to end.
  assert.deepEqual(summary.tracked, []);
  assert.deepEqual(summary.orphans, []);
  assert.equal(existsSync(join(dir, "diff-0123456789ab.patch")), true);
  assert.equal(existsSync(join(dir, "orphan.png")), true);
});

test("an unreadable sections.json or tracking file leaves the folder alone", () => {
  const root = makeRoot();
  const dir = session(root, "broken", [
    ["old.md", "old", 20],
    ["orphan.png", "png", 2],
    ["diff-0123456789ab.patch", "patch", 9],
  ]);
  write(dir, "sections.json", "{ not json");
  write(dir, "auto-diffs.json", "[\"nope\"]");

  const summary = pruneSession(root, "broken", { now: NOW });

  assert.deepEqual(summary.sections, []);
  assert.deepEqual(summary.orphans, []);
  assert.match(summary.kept, /sections\.json unreadable/);
  for (const kept of ["old.md", "orphan.png", "diff-0123456789ab.patch"]) {
    assert.equal(existsSync(join(dir, kept)), true, `${kept} should stay`);
  }
});

test("sessions are told apart from the root's other folders", () => {
  const root = makeRoot();
  session(root, "one", [["status.json", "{}", 1]]);
  mkdirSync(join(root, "meetings"));
  writeFileSync(join(root, ".watch.json"), "{}");
  mkdirSync(join(root, ".vendor"));

  const { sessions } = pruneCanvas({ root, now: NOW });
  assert.deepEqual(sessions.map((s) => s.id), ["one"]);
  assert.equal(existsSync(join(root, "meetings")), true);
});

test("sessionFileTimes finds <stamp>_<id>.jsonl in every project folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-sessions-"));
  mkdirSync(join(dir, "--Users-eric-Code--"), { recursive: true });
  writeFileSync(join(dir, "--Users-eric-Code--", "2026-03-09T10-00-00-000Z_abc-123.jsonl"), "{}");
  writeFileSync(join(dir, "--Users-eric-Code--", "2026-03-01T10-00-00-000Z_abc-123.jsonl"), "{}");
  age(join(dir, "--Users-eric-Code--", "2026-03-09T10-00-00-000Z_abc-123.jsonl"), 1);
  age(join(dir, "--Users-eric-Code--", "2026-03-01T10-00-00-000Z_abc-123.jsonl"), 9);

  const times = sessionFileTimes(dir);
  assert.equal(times.get("abc-123"), NOW - 1 * DAY);
});

test("daily at 04:00 local, and a name is only an artifact when the canvas writes it", () => {
  const at = (h, m = 0, day = 10) => new Date(2026, 2, day, h, m, 0, 0);
  assert.equal(nextRunDelay(4, at(3)), at(4).getTime() - at(3).getTime());
  assert.equal(nextRunDelay(4, at(5)), at(4, 0, 11).getTime() - at(5).getTime());
  assert.equal(nextRunDelay(4, at(4)), at(4, 0, 11).getTime() - at(4).getTime()); // exactly 04:00 is tomorrow

  for (const name of ["plan.md", "old.png", "x.compare", "base-0123456789ab", "cur-0123456789ab.txt", "diff-0123456789ab.patch", "shot-0123456789ab.png", "plan.md.4242.tmp"]) {
    assert.equal(isArtifactName(name), true, name);
  }
  for (const name of ["sections.json", "meta.json", "notes.txt", "keep.bin", "README", ".hidden.md"]) {
    assert.equal(isArtifactName(name), false, name);
  }
  // The bookkeeping names prune.mjs keeps, as index.ts and daemon.mjs write them.
  for (const name of ["meta.json", "sections.json", "status.json", "reply.json", "info.json", "activity.json", "turn.json", "inbox-ack.json", "auto-files.json", "auto-diffs.json", "auto-copies.json", "auto-shots.json"]) {
    assert.equal(BOOKKEEPING.has(name), true, name);
  }
});

test("the daemon's schedule runs once after startup, then daily, on unref'd timers", async () => {
  const root = makeRoot();
  session(root, "one", [["status.json", "{}", 1]]);
  const ran = [];
  const schedule = schedulePrune({ root, firstDelayMs: 5, log: (line) => ran.push(line) });
  await new Promise((resolve) => setTimeout(resolve, 60));
  schedule.stop();

  assert.equal(ran.length, 1, ran.join("\\n"));
  assert.match(ran[0], /prune \(startup\) 1 session/);
  assert.equal(schedule.timers.every((t) => t.hasRef() === false), true, "timers must be unref'd");
  assert.match(readFileSync(join(root, LOG_NAME), "utf8"), /canvas prune: one: nothing to remove/);
});

test("the CLI prunes, logs one line per session, does nothing twice, and --dry-run changes nothing", () => {
  const canvas = makeRoot();
  const agent = mkdtempSync(join(tmpdir(), "canvas-agent-"));
  mkdirSync(join(agent, "sessions", "--Users-eric-Code--"), { recursive: true });
  writeFileSync(join(agent, "sessions", "--Users-eric-Code--", "2026-03-09T10-00-00-000Z_keepme.jsonl"), "{}");
  age(join(agent, "sessions", "--Users-eric-Code--", "2026-03-09T10-00-00-000Z_keepme.jsonl"), 1);

  const dir = session(canvas, "old", [
    ["old.md", "old", 20],
    ["fresh.md", "fresh", 1],
    ["orphan.png", "png", 2],
    ["auto-files.md", "| File |", 1],
    ["diff-0123456789ab.patch", "patch", 9],
  ]);
  write(dir, "sections.json", [
    { id: "old", title: "Old", kind: "markdown", file: "old.md", at: daysAgo(20) },
    { id: "fresh", title: "Fresh", kind: "markdown", file: "fresh.md", at: daysAgo(1) },
    { id: "auto-files", title: "Files changed", kind: "markdown", file: "auto-files.md", at: daysAgo(1), by: "auto" },
  ]);
  write(dir, "auto-files.json", { "/repo/a.rb": { edits: 1, writes: 0, at: daysAgo(9) } });
  write(dir, "auto-diffs.json", { "/repo/a.rb": { base: null, patch: "diff-0123456789ab.patch" } });
  // A dead folder well past 30 days, whose transcript is gone too.
  session(canvas, "gone", [["status.json", "{}", 40]], { age: 40 });

  const env = { ...process.env, PI_CANVAS_ROOT: canvas, PI_CODING_AGENT_DIR: agent };
  delete env.PI_CANVAS;
  const cli = (...args) => spawnSync(process.execPath, [join(HERE, "extensions/canvas/prune.mjs"), ...args], { encoding: "utf8", env });

  const snapshot = () => {
    const out = [];
    const walk = (d, prefix) => {
      for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(d, entry.name);
        if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
        else out.push(`${prefix}${entry.name} ${statSync(path).mtimeMs} ${statSync(path).size}`);
      }
    };
    walk(canvas, "");
    return out;
  };

  const before = snapshot();
  const dry = cli("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/);
  assert.match(dry.stdout, /old: 2 section\(s\) \(old, auto-files\)/);
  assert.deepEqual(snapshot(), before, "--dry-run touched the canvas");
  assert.equal(existsSync(join(canvas, LOG_NAME)), false, "--dry-run wrote the log");

  const first = cli();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /2 session\(s\)/);
  assert.equal(existsSync(join(dir, "old.md")), false);
  assert.equal(existsSync(join(dir, "orphan.png")), false);
  assert.equal(existsSync(join(dir, "fresh.md")), true);
  assert.equal(existsSync(join(dir, "diff-0123456789ab.patch")), false);
  assert.equal(existsSync(join(canvas, "gone")), false);
  const log = readFileSync(join(canvas, LOG_NAME), "utf8");
  assert.match(log, /canvas prune: gone: removed the folder/);
  assert.match(log, /canvas prune: old: 2 section\(s\) \(old, auto-files\)/);

  const second = cli();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /old: nothing to remove/);
  // Two lines on the first run (both sessions), one on the second ("gone" is gone).
  assert.equal(readFileSync(join(canvas, LOG_NAME), "utf8").trim().split("\n").length, 3);

  assert.match(summaryLine({ id: "x", removedDir: true, bytes: 2048, sections: [], tracked: [], trackedFiles: 0, orphans: [], live: false, activeTurn: false, kept: "" }), /removed the folder \(2\.0 KB\)/);
});
