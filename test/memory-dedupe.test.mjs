import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cleanup, duplicate, words } from "../lib/memory/dedupe.ts";

// The shared cases: Botsun's Memory.duplicate / Memory.cleanup must give the same answers.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/memory-dedupe.json", import.meta.url), "utf8"));

test("words: lowercase ASCII runs of 3+, unique, in order", () => {
	for (const c of fixture.words) assert.deepEqual(words(c.text), c.words, c.text);
});

test("duplicate: fixture parity", () => {
	for (const c of fixture.duplicate) {
		const existing = c.existing.map((m) => ({ scope: "global", ...m }));
		const hit = duplicate(c.text, c.scope ?? "global", existing);
		assert.equal(hit?.id ?? null, c.duplicate_of, c.name);
	}
});

test("cleanup: fixture parity", () => {
	for (const c of fixture.cleanup) {
		const memories = c.memories.map((m) => ({ scope: "global", ...m }));
		assert.deepEqual(cleanup(memories), c.archived, c.name);
	}
});
