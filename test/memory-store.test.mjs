import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { freshRoot, world } from "./helpers/memory-env.mjs";
import * as store from "../lib/memory/store.ts";

const src = { kind: "cli" };
const open = () => {
	const root = freshRoot();
	store.init(root, { git: false });
	return root;
};

test("init makes the layout, owner-only", () => {
	const root = open();
	for (const d of ["global", "projects", "proposed", "archive"]) assert.ok(statSync(join(root, d)).isDirectory(), d);
	assert.equal(statSync(root).mode & 0o777, 0o700);
	assert.equal(statSync(join(root, "global")).mode & 0o777, 0o700);
});

test("init refuses a folder that isn't a pi-memory root, and takes a new or empty one", () => {
	const foreign = join(world, `foreign-${Date.now()}`);
	mkdirSync(join(foreign, "src"), { recursive: true });
	writeFileSync(join(foreign, "wip.txt"), "someone's work\n");
	chmodSync(foreign, 0o755);
	assert.throws(() => store.init(foreign, { git: false }), /not a pi-memory root \(it holds .*wip\.txt/);
	assert.equal(statSync(foreign).mode & 0o777, 0o755, "not chmodded");
	assert.ok(!existsSync(join(foreign, "global")) && !existsSync(join(foreign, store.MARKER)));

	const empty = join(world, `empty-${Date.now()}`);
	mkdirSync(empty);
	store.init(empty, { git: false });
	assert.ok(existsSync(join(empty, store.MARKER)));
	writeFileSync(join(empty, "global", "notes.txt"), "inside the layout is fine\n");
	writeFileSync(join(empty, "later.txt"), "added after init\n");
	assert.doesNotThrow(() => store.init(empty, { git: false }), "the marker makes it ours");
});

test("ids: date plus random, and the regex refuses anything else", () => {
	const id = store.newId(new Date(2026, 10, 7));
	assert.match(id, /^m-20261107-[a-z0-9]{6}$/);
	assert.ok(store.validId(id));
	for (const bad of ["m-2026110-abcd", "m-20261107-ab", "m-20261107-ABCD", "../m-20261107-abcd", "/etc/passwd", "m-20261107-abcd/../x", "m-20261107-abcd\n", 42, undefined]) {
		assert.equal(store.validId(bad), false, String(bad));
	}
});

test("write, load, update, archive, restore", () => {
	const root = open();
	const m = store.write(root, { scope: "global", text: "  Eric prefers tabs.  ", tags: ["Style", "style", "a b!", ""], source: { kind: "remember", session: "s1", cwd: "~/x" } });
	assert.equal(m.text, "Eric prefers tabs.");
	assert.deepEqual(m.tags, ["style", "ab"]);
	assert.equal(m.path, join(root, "global", `${m.id}.md`));
	const [loaded] = store.load(root).memories;
	assert.equal(loaded.id, m.id);
	assert.equal(loaded.state, "active");
	assert.deepEqual(loaded.source, { kind: "remember", session: "s1", cwd: "~/x", model: undefined });

	const u = store.update(root, m.id, { text: "Eric prefers tabs, width 4." });
	assert.equal(store.find(root, m.id).text, "Eric prefers tabs, width 4.");
	assert.equal(u.created, m.created);

	const a = store.archive(root, m.id);
	assert.equal(a.state, "archived");
	assert.ok(existsSync(join(root, "archive", `${m.id}.md`)));
	assert.ok(!existsSync(m.path));
	assert.ok(a.archived);
	assert.throws(() => store.update(root, m.id, { text: "x" }), /archived/);

	const r = store.restore(root, m.id);
	assert.equal(r.state, "active");
	assert.ok(existsSync(m.path));
	assert.ok(!existsSync(join(root, "archive", `${m.id}.md`)));
	assert.equal(store.find(root, m.id).archived, undefined);
});

test("project scope goes under projects/<slug>; inferred goes to proposed/", () => {
	const root = open();
	const p = store.write(root, { scope: "projects/github.com/acme/widgets", text: "Uses pnpm.", source: src });
	assert.equal(p.path, join(root, "projects/github.com/acme/widgets", `${p.id}.md`));
	const c = store.write(root, { scope: "global", text: "Maybe likes dark mode.", source: { kind: "candidate" }, confidence: "inferred" });
	assert.equal(c.state, "proposed");
	assert.ok(c.path.startsWith(join(root, "proposed")));
	const states = Object.fromEntries(store.load(root).memories.map((m) => [m.id, m.state]));
	assert.deepEqual(states, { [p.id]: "active", [c.id]: "proposed" });
});

test("text limits", () => {
	const root = open();
	assert.throws(() => store.write(root, { scope: "global", text: "   ", source: src }), /nothing to remember/);
	assert.throws(() => store.write(root, { scope: "global", text: "x".repeat(1001), source: src }), /at most 1000/);
	assert.doesNotThrow(() => store.write(root, { scope: "global", text: "x".repeat(1000), source: src }));
});

test("atomic write leaves no .tmp- file", () => {
	const root = open();
	const m = store.write(root, { scope: "global", text: "A fact.", source: src });
	store.update(root, m.id, { text: "A changed fact." });
	assert.deepEqual(readdirSync(join(root, "global")), [`${m.id}.md`]);
});

test("containment: bad scopes and ids are refused", () => {
	const root = open();
	for (const scope of ["projects/../../etc", "projects/github.com/..", "projects/a", "/etc", "global/../x", "projects/GitHub.com/a/b", "projects/a/b/c/../d"]) {
		assert.throws(() => store.write(root, { scope, text: "x y z", source: src }), /bad scope/, scope);
	}
	assert.throws(() => store.find(root, "../../etc/passwd"), /not a memory id/);
	assert.throws(() => store.find(root, "/etc/passwd"), /not a memory id/);
	assert.throws(() => store.archive(root, "m-20261107-abcd/../../x"), /not a memory id/);
});

test("containment: a symlinked folder can't take a write or a read out of the root", () => {
	const root = open();
	const outside = join(world, `outside-${Date.now()}`);
	mkdirSync(join(outside, "acme", "widgets"), { recursive: true });
	symlinkSync(outside, join(root, "projects", "github.com"));
	assert.throws(() => store.write(root, { scope: "projects/github.com/acme/widgets", text: "x y z", source: src }), /symlink/);
	assert.deepEqual(readdirSync(join(outside, "acme", "widgets")), []);

	// A memory file planted behind the symlink is not loaded.
	const id = "m-20261107-plnt";
	writeFileSync(join(outside, "acme", "widgets", `${id}.md`), `---\nid: ${id}\nscope: projects/github.com/acme/widgets\n---\nplanted\n`);
	assert.equal(store.load(root).memories.length, 0);
});

test("containment: a symlinked memory file or folder is skipped", () => {
	const root = open();
	const outside = join(world, `outside-file-${Date.now()}.md`);
	const id = "m-20261107-link";
	writeFileSync(outside, `---\nid: ${id}\nscope: global\n---\nplanted\n`);
	symlinkSync(outside, join(root, "global", `${id}.md`));
	assert.equal(store.load(root).memories.length, 0);
	assert.throws(() => store.update(root, id, { text: "x" }), /no memory/);
	assert.equal(readFileSync(outside, "utf8").includes("planted"), true);
});

test("load skips invalid files and active files in the wrong folder", () => {
	const root = open();
	writeFileSync(join(root, "global", "notes.md"), "hello");
	writeFileSync(join(root, "global", "m-20261107-bad1.md"), "---\nid: m-20261107-zzzz\nscope: global\n---\nid mismatch\n");
	mkdirSync(join(root, "projects", "github.com", "a", "b"), { recursive: true });
	writeFileSync(join(root, "projects", "github.com", "a", "b", "m-20261107-wrng.md"), "---\nid: m-20261107-wrng\nscope: global\n---\nwrong folder\n");
	writeFileSync(join(root, "global", "m-20261107-empt.md"), "---\nid: m-20261107-empt\nscope: global\n---\n\n");
	const r = store.load(root);
	assert.equal(r.memories.length, 0);
	assert.equal(r.skipped, 4);
});

test("archived memories older than 30 days are pruned on load", () => {
	const root = open();
	const old = store.write(root, { scope: "global", text: "Old fact.", source: src });
	const recent = store.write(root, { scope: "global", text: "Recent fact.", source: src });
	store.archive(root, recent.id, new Date(Date.now() - 29 * 86_400_000));
	store.archive(root, old.id, new Date(Date.now() - 31 * 86_400_000));
	const r = store.load(root);
	assert.equal(r.pruned, 1);
	assert.deepEqual(r.memories.map((m) => m.id), [recent.id]);
	assert.ok(!existsSync(join(root, "archive", `${old.id}.md`)));
});

test("load orders newest first", () => {
	const root = open();
	const a = store.write(root, { scope: "global", text: "First.", source: src, now: new Date(2026, 0, 1) });
	const b = store.write(root, { scope: "global", text: "Second.", source: src, now: new Date(2026, 5, 1) });
	assert.deepEqual(store.load(root).memories.map((m) => m.id), [b.id, a.id]);
});

test("pins: add, list, remove; a symlinked pinned.md is ignored", () => {
	const root = open();
	assert.deepEqual(store.readPins(root), []);
	store.addPin(root, "Answer\nbriefly.");
	store.addPin(root, "Use metric units.");
	assert.deepEqual(store.readPins(root), ["Answer briefly.", "Use metric units."]);
	assert.match(readFileSync(join(root, "pinned.md"), "utf8"), /^# Pinned\n/);
	assert.deepEqual(store.removePin(root, 1), ["Use metric units."]);
	assert.throws(() => store.removePin(root, 5), /no pin 5/);

	const root2 = open();
	const outside = join(world, `pins-${Date.now()}.md`);
	writeFileSync(outside, "- planted\n");
	symlinkSync(outside, join(root2, "pinned.md"));
	assert.deepEqual(store.readPins(root2), []);
	assert.throws(() => store.addPin(root2, "x"), /symlink/);
	assert.equal(readFileSync(outside, "utf8"), "- planted\n");
});

test("pins: hand-written lines survive add and remove; an oversized pinned.md is refused, not replaced", () => {
	const root = open();
	const hand = "# My pins\n\nSome prose I wrote.\n\n- first\n* not a pin\n- second\n";
	writeFileSync(join(root, "pinned.md"), hand);
	assert.deepEqual(store.addPin(root, "third"), ["first", "second", "third"]);
	assert.equal(readFileSync(join(root, "pinned.md"), "utf8"), `${hand}- third\n`);
	assert.deepEqual(store.removePin(root, 2), ["first", "third"]);
	assert.equal(readFileSync(join(root, "pinned.md"), "utf8"), "# My pins\n\nSome prose I wrote.\n\n- first\n* not a pin\n- third\n");

	const big = `- keep me\n${"x".repeat(70 * 1024)}\n`;
	writeFileSync(join(root, "pinned.md"), big);
	assert.deepEqual(store.readPins(root), []);
	assert.throws(() => store.addPin(root, "after big"), /over 64 KB/);
	assert.throws(() => store.removePin(root, 1), /over 64 KB/);
	assert.equal(readFileSync(join(root, "pinned.md"), "utf8"), big);
});

test("pins: at most MAX_PINS of at most MAX_TEXT characters are read", () => {
	const root = open();
	const lines = Array.from({ length: store.MAX_PINS + 5 }, (_, i) => `- pin ${i} ${"z".repeat(i === 0 ? 2000 : 1)}`);
	writeFileSync(join(root, "pinned.md"), `${lines.join("\n")}\n`);
	const pins = store.readPins(root);
	assert.equal(pins.length, store.MAX_PINS);
	assert.equal(pins[0].length, store.MAX_TEXT);
});

test("usage stats live outside the root and count up", () => {
	const path = join(world, "stats", `s-${Date.now()}.json`);
	store.bumpUsed(["m-20261107-aaaa", "m-20261107-aaaa", "../bad"], path);
	store.bumpUsed(["m-20261107-bbbb"], path);
	assert.deepEqual(store.readStats(path), { "m-20261107-aaaa": 2, "m-20261107-bbbb": 1 });
	assert.ok(store.statsPath({ XDG_STATE_HOME: "/x" }).startsWith("/x/pi-memory/"));
});
