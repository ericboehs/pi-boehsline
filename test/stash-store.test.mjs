import assert from "node:assert/strict";
import { test } from "node:test";

import { markRemoteSubmit, pushStash, stashChanged, stashStack, takeRemoteSubmit, takeStash } from "../lib/stash-store.ts";

const stacks = () => globalThis.__piMessageStash;

test("an emptied stack's session entry is deleted, not kept forever", () => {
	const a = pushStash("store-a", "one");
	assert.ok(stacks().has("store-a"));
	assert.equal(takeStash("store-a", a.id)?.text, "one");
	assert.equal(stacks().has("store-a"), false, "take of the last entry drops the session");

	// The stash extension mutates the live stack, then calls stashChanged.
	stashStack("store-b").push({ id: "x", text: "draft", ts: 0 });
	stashChanged("store-b");
	assert.ok(stacks().has("store-b"));
	stashStack("store-b").length = 0;
	stashChanged("store-b");
	assert.equal(stacks().has("store-b"), false);
});

test("taking from an unknown session creates nothing", () => {
	assert.equal(takeStash("store-never", "nope"), null);
	assert.equal(stacks().has("store-never"), false);
});

test("read-only lookups across many sessions don't pile up empty entries", () => {
	for (let i = 0; i < 50; i++) stashStack(`store-read-${i}`);
	const empty = [...stacks()].filter(([id, s]) => id.startsWith("store-read-") && s.length === 0);
	assert.equal(empty.length, 1, "only the session looked up last");
	// A session with drafts is never swept.
	pushStash("store-keep", "keep me");
	stashStack("store-other");
	assert.deepEqual(stacks().get("store-keep").map((e) => e.text), ["keep me"]);
});

test("a phone submit is taken once, and only within its window", () => {
	assert.equal(takeRemoteSubmit(1000), false, "nothing marked");
	markRemoteSubmit(1000);
	assert.equal(takeRemoteSubmit(3000), true, "marked 2 s ago");
	assert.equal(takeRemoteSubmit(3000), false, "taken once");
	markRemoteSubmit(1000);
	assert.equal(takeRemoteSubmit(7000), false, "a stale mark (a steer that started no run) is dropped");
	assert.equal(takeRemoteSubmit(7001), false);
});
