/**
 * cursor-agent's usage-cache entry: the format pi-usage reads, and the merge
 * write into the shared ~/.pi/agent/usage-cache.json (a temp dir here).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	applyCursorStatusChip,
	CACHE_KEY,
	CURSOR_CHIP_STASH_KEY,
	cacheEntry,
	cycleText,
	readCycleFromCache,
	refreshUsageCache,
	statusChipText,
	usageCachePath,
	writeCacheEntry,
} from "../extensions/opt-in/cursor-agent/usage-cache.ts";

const START = Date.UTC(2026, 10, 1, 12);
const END = Date.UTC(2026, 11, 1, 12);
const NOW = Date.UTC(2026, 10, 3, 12);

const usage = (over = {}) => ({
	start: START,
	end: END,
	spentCents: 65,
	limitDollars: 200,
	aggregate: {
		totalCostCents: 65,
		aggregations: [
			{ modelIntent: "auto", totalCents: 15 },
			{ modelIntent: "gpt-5", totalCents: 50 },
		],
	},
	...over,
});

test("cacheEntry: spend against the limit, reset at cycle end, numbers in quota", () => {
	const e = cacheEntry(usage(), NOW);
	assert.equal(e.value, "$0.65 / $200 (0.3%)");
	assert.equal(e.resetMs, END);
	assert.equal(e.fetchedAt, NOW);
	assert.deepEqual(e.quota, { spentCents: 65, limitDollars: 200, cycleStart: START, cycleEnd: END });
	assert.equal(e.commandText, cycleText(usage(), NOW));
	assert.match(e.commandText, /\(28d left\): \$0\.6500 of \$200 \(0\.3%\)\ngpt-5 \$0\.5000, auto \$0\.1500$/);
});

test("cacheEntry: no limit shows the spend alone and omits limitDollars", () => {
	const e = cacheEntry(usage({ spentCents: 1319, limitDollars: undefined }), NOW);
	assert.equal(e.value, "$13.19");
	assert.equal("limitDollars" in e.quota, false);
	assert.doesNotMatch(e.commandText, / of \$/);
});

test("cycleText: adds the session's spend when there is one", () => {
	assert.match(cycleText(usage(), NOW, 25), / · this session \$0\.2500\n/);
	assert.doesNotMatch(cycleText(usage(), NOW, 0), /this session/);
});

test("statusChipText: cycle spend with limit and optional session suffix", () => {
	assert.equal(statusChipText({ spentCents: 8160, limitDollars: 200 }), "cursor $81.60/$200 (41%)");
	assert.equal(statusChipText({ spentCents: 8160, limitDollars: 200 }, 0, false), "cursor $81.60/$200");
	assert.equal(statusChipText({ spentCents: 8160, limitDollars: 200 }, 2), "cursor $81.60/$200 (41%) · +$0.02 here");
	assert.equal(statusChipText({ spentCents: 1319 }), "cursor $13.19");
});

test("applyCursorStatusChip: no data, session only, cycle + session", () => {
	const chip = {};
	const ctx = { ui: { setStatus(k, v) { chip[k] = v; } } };
	const session = { sessionCents: 0, lastCycle: undefined };
	applyCursorStatusChip(ctx, session);
	assert.equal(chip.cursor, undefined);
	session.sessionCents = 2;
	applyCursorStatusChip(ctx, session);
	assert.equal(chip.cursor, "cursor +$0.02 here");
	session.lastCycle = { spentCents: 8160, limitDollars: 200 };
	applyCursorStatusChip(ctx, session);
	assert.equal(chip.cursor, "cursor $81.60/$200 (41%) · +$0.02 here");
	assert.deepEqual(globalThis[CURSOR_CHIP_STASH_KEY], {
		spentCents: 8160,
		limitDollars: 200,
		sessionCents: 2,
	});
	delete globalThis[CURSOR_CHIP_STASH_KEY];
});

test("readCycleFromCache: quota from file, missing file, malformed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-chip-"));
	const file = join(dir, "usage-cache.json");
	assert.equal(await readCycleFromCache(file), undefined);
	writeFileSync(
		file,
		JSON.stringify({
			[CACHE_KEY]: { value: "$0.65 / $200 (0.3%)", quota: { spentCents: 65, limitDollars: 200, cycleStart: 1, cycleEnd: 2 } },
		}),
	);
	assert.deepEqual(await readCycleFromCache(file), { spentCents: 65, limitDollars: 200, cycleStart: 1, cycleEnd: 2 });
	writeFileSync(file, "{");
	assert.equal(await readCycleFromCache(file), undefined);
	writeFileSync(file, JSON.stringify({ [CACHE_KEY]: { value: "x" } }));
	assert.equal(await readCycleFromCache(file), undefined);
});

test("usageCachePath: follows PI_CODING_AGENT_DIR like provider-usage", () => {
	assert.equal(usageCachePath({ PI_CODING_AGENT_DIR: "/x/agent" }), "/x/agent/usage-cache.json");
	assert.match(usageCachePath({}), /\.pi\/agent\/usage-cache\.json$/);
});

test("writeCacheEntry: merges cursor-usage and leaves other keys intact", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-cache-"));
	const file = join(dir, "usage-cache.json");
	const others = {
		"baseten-usage": { value: "$13.19 / $60.00 (22%)", fetchedAt: 1 },
		"claude-window:opus": { value: "5H: 10%", fetchedAt: 2 },
		[CACHE_KEY]: { value: "old", fetchedAt: 0 },
	};
	writeFileSync(file, JSON.stringify(others));
	await writeCacheEntry(cacheEntry(usage(), NOW), file);
	const after = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(after["baseten-usage"], others["baseten-usage"]);
	assert.deepEqual(after["claude-window:opus"], others["claude-window:opus"]);
	assert.equal(after[CACHE_KEY].value, "$0.65 / $200 (0.3%)");
	assert.deepEqual(readdirSync(dir), ["usage-cache.json"]); // temp file renamed away
});

test("writeCacheEntry: creates the file when missing or corrupt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-cache-"));
	const file = join(dir, "usage-cache.json");
	await writeCacheEntry(cacheEntry(usage(), NOW), file);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), [CACHE_KEY]);
	writeFileSync(file, "{not json");
	await writeCacheEntry(cacheEntry(usage(), NOW), file);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), [CACHE_KEY]);
});

test("refreshUsageCache: swallows fetch and write failures", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-cache-"));
	const file = join(dir, "usage-cache.json");
	await refreshUsageCache(() => Promise.reject(new Error("no login")), file);
	assert.deepEqual(readdirSync(dir), []);
	await refreshUsageCache(async () => usage(), join(dir, "missing", "usage-cache.json"));
	await refreshUsageCache(async () => usage(), file);
	assert.equal(JSON.parse(readFileSync(file, "utf8"))[CACHE_KEY].quota.spentCents, 65);
});
