import assert from "node:assert/strict";
import { test } from "node:test";
import { queryWords, search } from "../lib/memory/search.ts";

const m = (id, text, tags = [], updated = "2026-11-01T00:00:00-06:00") => ({ id, text, tags, updated });

test("more matched words rank higher; no match is left out", () => {
	const items = [
		m("m-20261101-aaaa", "Deploys need two approvals in the release channel"),
		m("m-20261101-bbbb", "Approvals for expense reports go to Sam"),
		m("m-20261101-cccc", "The cat is named Miso"),
	];
	assert.deepEqual(search("deploy approvals release", items).map((h) => h.memory.id), ["m-20261101-aaaa", "m-20261101-bbbb"]);
});

test("stems count less than exact words, tags add a bonus", () => {
	const items = [
		m("m-20261101-stem", "Deploying happens on Fridays"),
		m("m-20261101-exac", "Deploy happens on Fridays"),
		m("m-20261101-tagd", "Happens on Fridays", ["deploy"]),
	];
	const hits = search("deploy", items);
	assert.deepEqual(hits.map((h) => [h.memory.id, h.score]), [["m-20261101-exac", 1], ["m-20261101-stem", 0.75], ["m-20261101-tagd", 0.5]]);
});

test("ties go to the newest, and limit applies", () => {
	const items = [
		m("m-20261101-oldr", "Billing runs nightly", [], "2026-10-01T00:00:00-06:00"),
		m("m-20261101-newr", "Billing runs hourly", [], "2026-11-05T00:00:00-06:00"),
	];
	assert.deepEqual(search("billing", items).map((h) => h.memory.id), ["m-20261101-newr", "m-20261101-oldr"]);
	assert.equal(search("billing", items, 1).length, 1);
});

test("short or empty queries find nothing; at most 40 query words", () => {
	assert.deepEqual(search("a an to", [m("m-20261101-aaaa", "a an to")]), []);
	assert.equal(queryWords(Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")).length, 40);
});
