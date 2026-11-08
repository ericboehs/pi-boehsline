import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { configPath, fake, freshRoot, gitLog, stateHome, world } from "./helpers/memory-env.mjs";
import { due, expiringSoon, line, neverVerified, reasons } from "../lib/memory/review.ts";
import { normalize } from "../lib/memory/settings.ts";
import * as ops from "../lib/memory/ops.ts";
import * as store from "../lib/memory/store.ts";

const BIN = new URL("../bin/pi-memory", import.meta.url).pathname;
const cwd = join(world, "review-cwd");
mkdirSync(cwd, { recursive: true });
const NOW = new Date("2026-11-07T12:00:00-06:00");

let n = 0;
const mem = (over = {}) => ({
	id: `m-20261107-${String(++n).padStart(4, "0")}`,
	scope: "global",
	created: "2026-11-01T00:00:00-06:00",
	updated: "2026-11-01T00:00:00-06:00",
	source: { kind: "cli" },
	confidence: "stated",
	tags: [],
	text: "A fact.",
	state: "active",
	path: "",
	...over,
});
const confirmed = { at: "2026-11-05T00:00:00-06:00", status: "confirmed", by: "test/model", evidence: "s1: he said so" };

test("due rules: never verified, contradicted, changed since, verified long ago", () => {
	const checked = mem({ verified: confirmed });
	assert.deepEqual(reasons(checked, { now: NOW }), []);
	assert.deepEqual(reasons(mem(), { now: NOW }), ["never verified"]);
	assert.deepEqual(reasons(mem({ verified: { ...confirmed, status: "contradicted" } }), { now: NOW }), ["contradicted"]);
	assert.deepEqual(reasons(mem({ updated: "2026-11-06T00:00:00-06:00", verified: confirmed }), { now: NOW }), ["changed since verification"]);
	assert.deepEqual(reasons(checked, { now: new Date("2026-11-20T00:00:00-06:00") }), ["verified long ago"]);
	assert.deepEqual(reasons(checked, { now: new Date("2026-11-20T00:00:00-06:00"), days: 30 }), [], "the window is --days");
	assert.deepEqual(reasons(mem({ state: "archived" }), { now: NOW }), [], "archived facts are never due");
	const all = due([mem({ id: "m-20261107-zzzz", verified: { ...confirmed, status: "contradicted" } }), mem({ id: "m-20261107-aaaa" })], { now: NOW });
	assert.deepEqual(all.map((d) => d.memory.id), ["m-20261107-aaaa", "m-20261107-zzzz"], "id order, so two runs read the same");
});

test("a review line says id, scope, updated, expires, verification and text", () => {
	const m = mem({ id: "m-20261107-k3f9", expires: "2026-11-09", verified: confirmed, text: "Deploys need\ntwo approvals" });
	assert.equal(
		line({ memory: m, reasons: ["never verified"] }),
		"m-20261107-k3f9  global  updated 2026-11-01  expires 2026-11-09  verified confirmed 2026-11-05  Deploys need two approvals  (due: never verified)",
	);
	assert.equal(line({ memory: mem({ id: "m-20261107-a1b2" }), reasons: ["never verified"] }), "m-20261107-a1b2  global  updated 2026-11-01  expires none  verified never  A fact.  (due: never verified)");
});

test("counts: expiring within 7 days, and never verified", () => {
	const items = [
		mem({ expires: "2026-11-07" }),
		mem({ expires: "2026-11-14" }),
		mem({ expires: "2026-11-15" }),
		mem({ expires: "2026-11-01" }),
		mem({ expires: "2026-11-20", verified: confirmed }),
		mem({ verified: confirmed }),
	];
	assert.deepEqual(expiringSoon(items, { now: NOW }).map((m) => m.expires), ["2026-11-07", "2026-11-14"], "today is still in force; day 8 is not soon");
	assert.equal(neverVerified(items).length, 4, "two of the six were verified");
	assert.equal(neverVerified([mem({ state: "proposed" }), mem({ state: "archived" })]).length, 0);
});

/** pi-memory in a temp world: its own config, root, state and no git config. */
function cli(root, args, { env = {}, git = false } = {}) {
	writeFileSync(configPath, JSON.stringify({ memory: { git, qmd: "off" } }));
	const r = spawnSync(process.execPath, [BIN, ...args], {
		cwd,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: world, BOEHSLINE_CONFIG: configPath, XDG_STATE_HOME: stateHome, PI_MEMORY_ROOT: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
	});
	return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), json: () => JSON.parse(r.stdout) };
}
const pad = (k) => String(k).padStart(2, "0");
const day = (offset = 0) => {
	const d = new Date();
	d.setDate(d.getDate() + offset);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

test("review-check exits 0 when something is due, 3 when nothing is, 1 on an error", async () => {
	const root = freshRoot();
	const id = cli(root, ["add", "--json", "Deploys need two approvals"]).json().memory.id;

	const first = cli(root, ["review-check"]);
	assert.equal(first.code, 0);
	assert.match(first.out, new RegExp(`^${id}  global  updated \\d{4}-\\d{2}-\\d{2}  expires none  verified never  Deploys need two approvals  \\(due: never verified\\)$`));

	assert.equal(cli(root, ["verify", id, "--status", "confirmed", "--evidence", "s0b1c: he said it twice"]).code, 0);
	const nothing = cli(root, ["review-check"]);
	assert.equal(nothing.code, 3, "3 is nothing due, not an error");
	assert.equal(nothing.out, "Nothing due.");
	assert.equal(cli(root, ["review-check", "--json"]).code, 3, "--json keeps the code");

	// Changed after the check: due again. No sleep: the edit lands in the same
	// second as the verification, which is exactly the case `verified.of` guards.
	assert.equal(cli(root, ["edit", id, "--text", "Deploys need three approvals"]).code, 0);
	const changed = cli(root, ["review-check", "--json"]).json();
	assert.equal(changed.ok, true);
	assert.deepEqual(changed.due.map((d) => d.id), [id]);
	assert.deepEqual(changed.due[0].reasons, ["changed since verification"]);

	// Contradicted: due until something fixes it.
	assert.equal(cli(root, ["verify", id, "--status", "contradicted", "--evidence", "s0b1c: the policy changed"]).code, 0);
	assert.deepEqual(cli(root, ["review-check", "--json"]).json().due[0].reasons, ["contradicted"]);
	assert.match(cli(root, ["review-check"]).out, /verified contradicted \d{4}-\d{2}-\d{2}  Deploys need three approvals  \(due: contradicted\)/);

	// An error is 1, so it never reads as "nothing due".
	const foreign = join(world, "not-a-memory-root");
	mkdirSync(foreign, { recursive: true });
	writeFileSync(join(foreign, "someone-elses.txt"), "hello\n");
	const broken = cli(root, ["review-check", "--root", foreign]);
	assert.equal(broken.code, 1);
	assert.match(broken.err, /not a pi-memory root/);
});

test("a verify and an edit in the same second are still a change", () => {
	const root = freshRoot();
	store.init(root, { git: false });
	const mem = ops.open(normalize({ root, git: false, qmd: "off" }, {}));
	const now = new Date("2026-11-07T12:00:00-06:00");
	const src = { kind: "cli" };
	const at = store.isoLocal(now);

	const m = store.write(root, { scope: "global", text: "Deploys need two approvals", source: src, now });
	const v = ops.verify(mem, m.id, { status: "confirmed", evidence: "s1: he said so", by: "test/model", now }).memory;
	assert.equal(v.updated, m.updated, "a verification leaves updated alone");
	assert.equal(v.verified.of, store.version(m), "it records the version it checked");
	assert.deepEqual(reasons(store.find(root, m.id), { now }), [], "unchanged since the check");

	const edited = store.update(root, m.id, { text: "Deploys need three approvals", now });
	assert.equal(edited.updated, v.updated, "the same second, so `updated` alone cannot tell");
	assert.deepEqual(reasons(store.find(root, m.id), { now }), ["changed since verification"]);

	// An expiry added after the check changes the fact too.
	ops.verify(mem, m.id, { status: "confirmed", evidence: "s1: still so", by: "test/model", now });
	store.update(root, m.id, { expires: "2026-11-09", now });
	assert.deepEqual(reasons(store.find(root, m.id), { now }), ["changed since verification"]);

	// A file verified before `of` existed falls back to the timestamp.
	const old = store.find(root, m.id);
	const { of: _gone, ...legacy } = old.verified;
	assert.deepEqual(reasons({ ...old, updated: old.verified.at, verified: legacy }, { now }), [], "same second, no of: as before");
});

test("expiring soon is a calendar week, not 7 × 24 hours (DST)", () => {
	// 2026-11-01 02:00 America/Chicago falls back; 00:30 CDT + 7 × 24 h lands on
	// the 7th at 23:30 CST, a day short of the 8th.
	const script = `
		import { pathToFileURL } from "node:url";
		const m = await import(pathToFileURL(${JSON.stringify(new URL("../lib/memory/review.ts", import.meta.url).pathname)}).href);
		const now = new Date("2026-11-01T00:30:00-05:00");
		const fact = (expires) => ({ id: "m-20261101-aaaa", scope: "global", created: "", updated: "", source: { kind: "cli" }, confidence: "stated", tags: [], text: "x", expires, state: "active", path: "" });
		console.log(JSON.stringify(m.expiringSoon([fact("2026-11-07"), fact("2026-11-08")], { now }).map((x) => x.expires)));
	`;
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ: "America/Chicago" } });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout.trim()), ["2026-11-07", "2026-11-08"], "day 7 of a fall-back week is the 8th");
});

test("review-check archives expired facts and reports; --days and usage", () => {
	const root = freshRoot();
	const id = cli(root, ["add", "--json", "--expires", day(0), "The widget freeze runs today"], { git: true }).json().memory.id;
	assert.ok(gitLog(root).some((subject) => subject.endsWith(id)), "the add is committed");
	const days = cli(root, ["review-check", "--days", "0"]);
	assert.equal(days.code, 0, days.err);
	assert.match(days.out, /verified never/);

	const j = cli(root, ["review-check", "--json", "--days", "0"]).json();
	assert.deepEqual(j.due.map((d) => d.id), [id]);
	assert.deepEqual(j.expired, []);

	assert.equal(cli(root, ["review-check", "--days", "abc"]).code, 2);
	assert.equal(cli(root, ["review-check", "--days", "-1"]).code, 2);
});

test("review-check archives an expired fact and says so", () => {
	const root = freshRoot();
	cli(root, ["add", "A fact that holds forever"]);
	const id = "m-20261107-old1";
	writeFileSync(join(root, "global", `${id}.md`), `---\nid: ${id}\nscope: global\ncreated: 2001-01-01T00:00:00-06:00\nupdated: 2001-01-01T00:00:00-06:00\nexpires: 2001-01-02\nconfidence: stated\ntags: []\n---\nAn old time-bound fact\n`);
	const r = cli(root, ["review-check"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, new RegExp(`^expired 1: ${id}\\n`));
	assert.equal(cli(root, ["list", "--state", "archived", "--json"]).json().memories[0].id, id);
	const live = cli(root, ["review-check", "--json"]).json();
	assert.deepEqual(live.expired, [], "only once");
});

test("verify: both flags are required, status, evidence and by", () => {
	const root = freshRoot();
	// Every call in this test keeps git on, so each verification is committed.
	const git = (args) => cli(root, args, { git: true });
	const id = git(["add", "--json", "Sam owns the billing service"]).json().memory.id;

	// No invented confirmations: both flags, and evidence that says something.
	const missing = [
		["verify", id, "--evidence", "s1: he said so"],
		["verify", id, "--status", "confirmed"],
		["verify", id],
		["verify", id, "--status", "confirmed", "--evidence", "   "],
	];
	for (const args of missing) {
		const r = git(args);
		assert.equal(r.code, 2, `${args.join(" ")} is a usage error`);
		assert.match(r.err, /needs --status/);
	}
	assert.equal(cli(root, ["list", "--json"]).json().memories[0].verified, undefined, "a usage error records nothing");

	assert.equal(cli(root, ["verify", id, "--status", "sideways", "--evidence", "x"]).code, 2);

	// Scanned whole, then cut: a secret straddling the cut is refused, not halved.
	// The token starts at 290, so truncation would keep `ghp_` plus six characters —
	// too short for the scanner to see, which is how it used to reach the file.
	const filler = "he said the policy changed on Tuesday. ".repeat(11).slice(0, 286).replace(/\S+$/, "").padEnd(286, " ");
	const straddle = `s1: ${filler}${fake.github()}`;
	assert.equal(straddle.indexOf(fake.github()), 290);
	assert.ok(straddle.length > 300, "the token straddles the 300-char cut");
	const refused = git(["verify", id, "--status", "confirmed", "--evidence", straddle]);
	assert.equal(refused.code, 1);
	assert.match(refused.err, /secret/);
	assert.ok(!refused.err.includes(fake.github().slice(0, 12)));
	assert.equal(cli(root, ["list", "--json"]).json().memories[0].verified, undefined, "nothing was written");

	const secret = fake.jwt();
	const refusedJwt = cli(root, ["verify", id, "--status", "confirmed", "--evidence", `s1: token ${secret}`]);
	assert.equal(refusedJwt.code, 1);
	assert.match(refusedJwt.err, /secret/);
	assert.ok(!refusedJwt.err.includes(secret.slice(0, 20)));

	const long = `s1: ${"he said the policy changed on Tuesday. ".repeat(10)}`;
	assert.ok(long.length > 300);
	assert.equal(git(["verify", id, "--status", "confirmed", "--evidence", long]).code, 0);
	const m = cli(root, ["list", "--json"]).json().memories[0];
	assert.equal(m.verified.status, "confirmed");
	assert.equal(m.verified.by, "user");
	assert.equal(m.verified.evidence.length, 300);
	assert.equal(m.verified.of, store.version(m), "the version checked is recorded");
	assert.match(m.verified.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

	assert.equal(git(["verify", id, "--status", "unverifiable", "--evidence", "no session matches", "--by", "opencode-go/deepseek-v4.1-flash"]).code, 0);
	assert.equal(cli(root, ["list", "--json"]).json().memories[0].verified.by, "opencode-go/deepseek-v4.1-flash");
	assert.deepEqual(
		gitLog(root).filter((s) => s.startsWith("verify ")),
		[`verify ${id} unverifiable`, `verify ${id} confirmed`],
		"newest first, one commit per verification",
	);
	assert.equal(cli(root, ["verify", "m-20261107-none", "--status", "confirmed", "--evidence", "x"]).code, 1);
});

test("add and edit take --expires, and status counts the two review numbers", () => {
	const root = freshRoot();
	const id = cli(root, ["add", "--json", "--expires", day(3), "The widget freeze runs this week"]).json().memory.id;
	assert.equal(cli(root, ["list", "--json"]).json().memories[0].expires, day(3));
	assert.equal(cli(root, ["add", "--expires", day(-1), "Another fact about widgets today"]).code, 1);
	assert.match(cli(root, ["add", "--expires", "2026-02-30", "Another fact about widgets today"]).err, /YYYY-MM-DD/);

	// --expires alone leaves the text as it is.
	assert.equal(cli(root, ["edit", id, "--expires", day(5)]).out, `Updated ${id}.`);
	assert.deepEqual([cli(root, ["list", "--json"]).json().memories[0].text, cli(root, ["list", "--json"]).json().memories[0].expires], ["The widget freeze runs this week", day(5)]);
	assert.match(cli(root, ["edit", id, "--expires", day(5)]).out, /Unchanged/);

	const st = cli(root, ["status", "--json"]).json();
	assert.equal(st.expiringSoon, 1);
	assert.equal(st.neverVerified, 1);
	assert.match(cli(root, ["status"]).out, /expiring within 7 days: 1\nnever verified: 1/);
});
