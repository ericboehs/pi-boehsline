import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, parseDay, parseVerified, serialize, VERIFIED_STATUSES, verifiedField } from "../lib/memory/frontmatter.ts";

test("front matter round-trips scalars, flow lists and one flow map", () => {
	const fields = {
		id: "m-20261107-k3f9",
		scope: "projects/github.com/acme/widgets",
		created: "2026-11-07T14:02:11-06:00",
		source: { kind: "remember", session: "0b1c-22", cwd: "~/Code/a b/c", model: "openai/gpt-x: fast, {big}" },
		confidence: "stated",
		tags: ["deploy", "a, b", "x]y", "null", "42"],
		botsun_id: 412,
		note: 'quote " and # hash and : colon',
		empty: null,
		flag: true,
	};
	const body = "One fact.\n\n---\nwith a rule line inside";
	const text = serialize(fields, body);
	const back = parse(text);
	assert.deepEqual(back?.fields, fields);
	assert.equal(back?.body, body);
});

test("strings that look like YAML keywords or numbers stay strings", () => {
	const back = parse(serialize({ a: "true", b: "123", c: "~", d: "null" }, "x"));
	assert.deepEqual(back?.fields, { a: "true", b: "123", c: "~", d: "null" });
});

test("hand-edited files: comments, single quotes, CRLF and spacing", () => {
	const text = [
		"---",
		"# a comment line",
		"id: m-20261107-k3f9   # trailing comment",
		"scope: global",
		"tags: [ deploy ,  'it''s' ]",
		"source: {kind: cli,cwd: ~/x}",
		"---",
		"The fact.",
		"",
	].join("\r\n");
	const back = parse(text);
	assert.deepEqual(back?.fields, { id: "m-20261107-k3f9", scope: "global", tags: ["deploy", "it's"], source: { kind: "cli", cwd: "~/x" } });
	assert.equal(back?.body, "The fact.");
});

test("not front matter: no opening, no closing, bad lines, bad values", () => {
	assert.equal(parse("id: x\n---\nbody"), null);
	assert.equal(parse("---\nid: x\nbody without a close"), null);
	assert.equal(parse("---\nnot a key line\n---\nbody"), null);
	assert.equal(parse('---\nid: "unterminated\n---\nbody'), null);
	assert.equal(parse("---\ntags: [a, b\n---\nbody"), null);
	assert.equal(parse("---\nid: x\n----\nbody"), null);
});

test("serialize refuses keys that would break the format", () => {
	assert.throws(() => serialize({ "bad key": "x" }, "b"));
	assert.throws(() => serialize({ source: { "a:b": "x" } }, "b"));
});

test("expires and verified round-trip, and a file without them parses unchanged", () => {
	const verified = { at: "2026-11-08T03:30:12-06:00", status: "confirmed", by: "opencode-go/deepseek-v4.1-flash", evidence: 'session 0b1c: said "twice", with a comma, a: colon and {braces}' };
	const fields = {
		id: "m-20261107-k3f9",
		scope: "global",
		expires: "2026-11-09",
		verified: verifiedField(verified),
		confidence: "stated",
		tags: [],
	};
	const text = serialize(fields, "The widget freeze runs through Sunday.");
	const back = parse(text);
	assert.deepEqual(back?.fields, fields);
	assert.deepEqual(parseVerified(back?.fields.verified), verified);
	assert.equal(parseDay(back?.fields.expires), "2026-11-09");
	assert.equal(text.split("\n").find((l) => l.startsWith("verified:")), `verified: { at: ${verified.at}, status: confirmed, by: opencode-go/deepseek-v4.1-flash, evidence: ${JSON.stringify(verified.evidence)} }`);

	// An old file, written before either field existed.
	const old = parse("---\nid: m-20261107-old1\nscope: global\nconfidence: stated\n---\nAn older fact.\n");
	assert.deepEqual(old?.fields, { id: "m-20261107-old1", scope: "global", confidence: "stated" });
	assert.equal(parseDay(old?.fields.expires), undefined);
	assert.equal(parseVerified(old?.fields.verified), undefined);
});

test("days are real calendar days; a verified map needs a known status and a real time", () => {
	assert.equal(parseDay("2026-11-09"), "2026-11-09");
	assert.equal(parseDay(" 2026-11-09 "), "2026-11-09");
	for (const bad of ["2026-02-30", "2026-13-01", "2026-1-9", "9 Nov 2026", "20261109", "", null, 20261109]) assert.equal(parseDay(bad), undefined, JSON.stringify(bad));
	const at = "2026-11-08T03:30:12-06:00";
	for (const status of VERIFIED_STATUSES) assert.equal(parseVerified({ at, status })?.status, status);
	assert.equal(parseVerified({ at, status: "maybe" }), undefined);
	assert.equal(parseVerified({ at: "yesterday", status: "confirmed" }), undefined);
	assert.equal(parseVerified({ status: "confirmed" }), undefined);
	assert.equal(parseVerified("confirmed"), undefined);
	assert.deepEqual(parseVerified({ at, status: "confirmed" }), { at, status: "confirmed", by: "", evidence: "" });
});
