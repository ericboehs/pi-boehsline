import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { freshRoot, gitLog } from "./helpers/memory-env.mjs";
import * as ops from "../lib/memory/ops.ts";
import { render } from "../lib/memory/render.ts";
import { normalize } from "../lib/memory/settings.ts";
import * as store from "../lib/memory/store.ts";

const src = { kind: "cli" };
const open = (extra = {}) => ops.open(normalize({ root: freshRoot(), git: false, qmd: "off", ...extra }, {}));
const pad = (n) => String(n).padStart(2, "0");
/** A local YYYY-MM-DD, `offset` days from today. */
const day = (offset = 0) => {
	const d = new Date();
	d.setDate(d.getDate() + offset);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

test("expires is written, read back and checked on the way in", () => {
	const root = freshRoot();
	store.init(root, { git: false });
	const m = store.write(root, { scope: "global", text: "The widget freeze runs through Sunday", source: src, expires: day(2) });
	assert.equal(m.expires, day(2));
	assert.match(readFileSync(m.path, "utf8"), new RegExp(`^expires: ${day(2)}$`, "m"));
	assert.equal(store.find(root, m.id).expires, day(2));
	assert.equal(store.find(root, m.id).text, "The widget freeze runs through Sunday");

	const plain = store.write(root, { scope: "global", text: "A fact with no end", source: src });
	assert.equal(plain.expires, undefined);
	assert.ok(!readFileSync(plain.path, "utf8").includes("expires:"));

	assert.throws(() => store.write(root, { scope: "global", text: "Another fact here today", source: src, expires: day(-1) }), /already past/);
	assert.throws(() => store.write(root, { scope: "global", text: "Another fact here today", source: src, expires: "soon" }), /YYYY-MM-DD/);
	assert.throws(() => store.write(root, { scope: "global", text: "Another fact here today", source: src, expires: "2026-02-30" }), /YYYY-MM-DD/);
	assert.equal(store.load(root).memories.length, 2, "a refused expiry writes nothing");
});

test("in force through its day: shown today, gone tomorrow", () => {
	const root = freshRoot();
	store.init(root, { git: false });
	const today = new Date();
	const tomorrow = new Date(today.getTime() + 86_400_000);
	const m = store.write(root, { scope: "global", text: "The widget freeze runs today", source: src, expires: store.dayOf(today) });
	assert.deepEqual(render(store.load(root).memories, { slug: null, startChars: 2500, startMax: 25, now: today }).ids, [m.id]);
	assert.deepEqual(render(store.load(root).memories, { slug: null, startChars: 2500, startMax: 25, now: tomorrow }).ids, [], "the day after, it is not injected");
	assert.equal(store.expired(m, today), false);
	assert.equal(store.expired(m, tomorrow), true);
});

test("an expired fact is never injected or searchable", async () => {
	const mem = open();
	const live = ops.remember(mem, { text: "Deploys need two approvals", scope: "global", source: src }).memory;
	const id = "m-20261107-old1";
	writeFileSync(
		join(mem.root, "global", `${id}.md`),
		`---\nid: ${id}\nscope: global\ncreated: 2001-01-01T00:00:00-06:00\nupdated: 2001-01-01T00:00:00-06:00\nexpires: 2001-01-02\nconfidence: stated\ntags: []\n---\nDeploys used to need one approval\n`,
	);
	const found = await ops.search(mem, "deploys", { slug: null });
	assert.deepEqual(found.memories.map((m) => m.id), [live.id]);
	const block = ops.context(mem, null, {});
	assert.deepEqual(block.ids, [live.id]);
	assert.ok(!block.text.includes(id));
});

test("remember and update take expires; a stale fact doesn't block saving it again", async () => {
	const mem = open();
	const a = ops.remember(mem, { text: "The widget freeze runs this weekend", scope: "global", source: src, expires: day(2) }).memory;
	assert.equal(a.expires, day(2));
	assert.throws(() => ops.remember(mem, { text: "Another fact about widgets", scope: "global", source: src, expires: day(-1) }), /already past/);

	// expires alone: the text is left as it is.
	const moved = ops.update(mem, a.id, undefined, undefined, { expires: day(3) }).memory;
	assert.equal(moved.expires, day(3));
	assert.equal(moved.text, "The widget freeze runs this weekend");
	assert.equal(ops.update(mem, a.id, undefined, undefined, { expires: null }).memory.expires, undefined);
	assert.throws(() => ops.update(mem, a.id, undefined), /nothing to change/);

	// A fact that expired yesterday is not a duplicate of the same fact today.
	const id = "m-20261107-old2";
	writeFileSync(
		join(mem.root, "global", `${id}.md`),
		`---\nid: ${id}\nscope: global\ncreated: 2001-01-01T00:00:00-06:00\nupdated: 2001-01-01T00:00:00-06:00\nexpires: 2001-01-02\nconfidence: stated\ntags: []\n---\nThe release train leaves on Thursday morning\n`,
	);
	const again = ops.remember(mem, { text: "The release train leaves on Thursday morning", scope: "global", source: src });
	assert.notEqual(again.memory.id, id);
});

test("update ignores an expired fact in the duplicate pool too", () => {
	const mem = open();
	const live = ops.remember(mem, { text: "The release train leaves on Monday morning", scope: "global", source: src }).memory;
	const stale = "m-20261107-old3";
	writeFileSync(
		join(mem.root, "global", `${stale}.md`),
		`---\nid: ${stale}\nscope: global\ncreated: 2001-01-01T00:00:00-06:00\nupdated: 2001-01-01T00:00:00-06:00\nexpires: 2001-01-02\nconfidence: stated\ntags: []\n---\nThe release train leaves on Thursday morning\n`,
	);
	// The expired fact says the same thing; it must not block the edit.
	const moved = ops.update(mem, live.id, "The release train leaves on Thursday morning").memory;
	assert.equal(moved.text, "The release train leaves on Thursday morning");
	// An active fact still does.
	const other = ops.remember(mem, { text: "Deploys need two approvals", scope: "global", source: src }).memory;
	assert.throws(() => ops.update(mem, other.id, "The release train leaves on Thursday morning"), /would duplicate/);
});

test("verify writes the review to the file and leaves updated alone", () => {
	const root = freshRoot();
	store.init(root, { git: false });
	const m = store.write(root, { scope: "global", text: "Deploys need two approvals", source: src });
	const verified = { at: "2026-11-08T03:30:12-06:00", status: "confirmed", by: "opencode-go/deepseek-v4.1-flash", evidence: "2026-11-07T14-02-11-abc: said it twice" };
	const after = store.verify(root, m.id, verified);
	// The store records the version it checked, not one the caller hands it.
	assert.deepEqual(after.verified, { ...verified, of: store.version(m) });
	assert.equal(after.updated, m.updated, "a review is not an edit");
	assert.equal(after.text, m.text);
	assert.deepEqual(store.find(root, m.id).verified, after.verified, "it survives a reload");
	assert.match(
		readFileSync(m.path, "utf8"),
		new RegExp(`^verified: \\{ at: 2026-11-08T03:30:12-06:00, status: confirmed, by: opencode-go/deepseek-v4.1-flash, evidence: "2026-11-07T14-02-11-abc: said it twice", of: ${store.version(m)} \\}$`, "m"),
	);
	assert.throws(() => store.verify(root, "m-20261107-none", verified), /no memory/);
});

test("expire archives through the normal path, one commit per fact", async () => {
	const root = freshRoot();
	store.init(root, { git: true });
	const mem = ops.open(normalize({ root, git: true, qmd: "off" }, {}));
	const a = store.write(root, { scope: "global", text: "The widget freeze ends Sunday", source: src, expires: day(0) });
	const b = store.write(root, { scope: "global", text: "A fact with no end at all", source: src });
	assert.deepEqual(await ops.expire(mem), [], "nothing has passed yet");
	const archived = await ops.expire(mem, new Date(Date.now() + 2 * 86_400_000));
	assert.deepEqual(archived.map((m) => m.id), [a.id]);
	assert.equal(store.find(root, a.id).state, "archived");
	assert.equal(store.find(root, b.id).state, "active");
	assert.deepEqual(gitLog(root), [`expire ${a.id}`]);
	ops.restore(mem, a.id);
	assert.equal(store.find(root, a.id).state, "active", "an expired fact stays restorable");
});

test("restore clears expires, so the fact isn't active-but-expired", async () => {
	const root = freshRoot();
	store.init(root, { git: false });
	const mem = ops.open(normalize({ root, git: false, qmd: "off" }, {}));
	const m = store.write(root, { scope: "global", text: "The widget freeze ends Sunday", source: src, expires: day(0) });
	await ops.expire(mem, new Date(Date.now() + 2 * 86_400_000));
	assert.equal(store.find(root, m.id).expires, day(0), "the file keeps its expiry while archived");
	const back = ops.restore(mem, m.id).memory;
	assert.equal(back.state, "active");
	assert.equal(back.expires, undefined, "no end until one is set again");
	assert.equal(store.find(root, m.id).expires, undefined);
	assert.ok(!readFileSync(back.path, "utf8").includes("expires:"));
	// It is injected again, and the next expire leaves it alone.
	assert.deepEqual(render(store.load(root).memories, { slug: null, startChars: 2500, startMax: 25 }).ids, [m.id]);
	assert.deepEqual(await ops.expire(mem, new Date(Date.now() + 2 * 86_400_000)), []);
});
