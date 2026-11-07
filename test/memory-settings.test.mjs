import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath } from "./helpers/memory-env.mjs";
import { expandHome, memorySettings, normalize, tildePath } from "../lib/memory/settings.ts";

test("defaults: the root under ~/.local/share, git on, qmd auto, no extra collections", () => {
	writeFileSync(configPath, "{}");
	const s = memorySettings({});
	assert.equal(s.root, join(homedir(), ".local/share/pi-memory"));
	assert.equal(s.git, true);
	assert.deepEqual(s.inject, { startChars: 2500, startMax: 25, turnChars: 1200, turnHits: 5 });
	assert.equal(s.qmd, "auto");
	assert.deepEqual(s.search.collections, []);
	assert.equal(s.candidates, "off");
	assert.equal(s.reviewModel, null);
	assert.deepEqual(s.scanner.extraPatterns, []);
});

test("boehsline.json overrides, ~ expands, PI_MEMORY_ROOT wins", () => {
	writeFileSync(configPath, JSON.stringify({ memory: { root: "~/notes/mem", git: false, qmd: "off", inject: { startMax: 5 } } }));
	const s = memorySettings({});
	assert.equal(s.root, join(homedir(), "notes/mem"));
	assert.equal(s.git, false);
	assert.equal(s.qmd, "off");
	assert.equal(s.inject.startMax, 5);
	assert.equal(s.inject.startChars, 2500);
	assert.equal(memorySettings({ PI_MEMORY_ROOT: "/tmp/elsewhere" }).root, "/tmp/elsewhere");
	writeFileSync(configPath, "{}");
});

test("bad values fall back or are dropped", () => {
	const s = normalize({
		root: 42,
		inject: { startChars: -5, startMax: "many", turnChars: 1e9 },
		qmd: "yes",
		search: { collections: ["notes", "-c", "a b", "memory", 7, "work.notes"] },
		candidates: "always",
		scanner: { extraPatterns: [{ category: "x", pattern: "y" }, { pattern: "no category" }, "str", { category: "z", pattern: "q", flags: "m" }] },
	}, {});
	assert.equal(s.root, join(homedir(), ".local/share/pi-memory"));
	assert.equal(s.inject.startChars, 0);
	assert.equal(s.inject.startMax, 25);
	assert.equal(s.inject.turnChars, 50_000);
	assert.equal(s.qmd, "auto");
	assert.deepEqual(s.search.collections, ["notes", "work.notes"]);
	assert.equal(s.candidates, "off");
	assert.deepEqual(s.scanner.extraPatterns, [{ category: "x", pattern: "y" }, { category: "z", pattern: "q", flags: "m" }]);
});

test("expandHome and tildePath", () => {
	assert.equal(expandHome("~/x", "/h"), "/h/x");
	assert.equal(expandHome("~", "/h"), "/h");
	assert.equal(expandHome("/abs", "/h"), "/abs");
	assert.equal(tildePath("/h/a/b", "/h"), "~/a/b");
	assert.equal(tildePath("/hx/a", "/h"), "/hx/a");
});
