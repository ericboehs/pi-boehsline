import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, serialize } from "../lib/memory/frontmatter.ts";

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
