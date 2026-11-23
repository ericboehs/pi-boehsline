/**
 * lib/job-title.ts: a short title for a subagent or Cursor run's row (Botsun's info sheet, the
 * canvas jobs feed). Pure functions, no I/O.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle, deriveTitle, GIVEN_TITLE_MAX, humanize, jobTitle, TITLE_MAX } from "../lib/job-title.ts";

test("a wt-* worktree path in the prompt names it, humanized", () => {
	assert.equal(deriveTitle("First `cd ~/tmp/wt-worklog-after-text` (Botsun worktree, branch worklog-after-text off origin/main). Then fix it."), "Worklog after text");
	assert.equal(deriveTitle("cd /Users/me/tmp/wt-jobs_title.scope && npm test"), "Jobs title scope");
	assert.equal(deriveTitle("Work in ~/tmp/wt-ios-push. Nothing else."), "Ios push", "a sentence's period is not the name's");
});

test("else a worktree path, else a branch with a separator in it", () => {
	assert.equal(deriveTitle("Use the worktree at ~/Code/foo/info-sheet and add a test"), "Info sheet");
	assert.equal(deriveTitle("On branch feat/info-sheet-scope, add a test."), "Info sheet scope");
	assert.equal(deriveTitle("What does the branch do here?"), "What does the branch do here", "a plain word after branch is not a name");
});

test("else the first sentence, paths and backticks out, cut at a word to TITLE_MAX", () => {
	assert.equal(deriveTitle("Review the diff in lib/foo.rb for bugs. Then report back."), "Review the diff for bugs", "a preposition into a path goes with it");
	assert.equal(deriveTitle("Find every call of `trackChild` in ~/Code/x and list them with their line numbers"), "Find every call of trackChild and list…");
	const long = deriveTitle("x".repeat(100));
	assert.equal(long.length, TITLE_MAX);
	assert.ok(long.endsWith("…"));
	assert.equal(deriveTitle("Summarize\nthe changes since Monday"), "Summarize the changes since Monday", "one line");
	assert.equal(deriveTitle("Check (~/x/y) quickly."), "Check quickly", "parentheses the paths emptied go too");
});

test("heuristic polish: URLs as hosts, no dangling preposition, e.g./i.e. don't end a sentence", () => {
	assert.equal(deriveTitle("Fix v1.2.3 parsing in lib/x.rb"), "Fix v1.2.3 parsing");
	assert.equal(deriveTitle("Review e.g. the parser and the lexer. Then stop."), "Review e.g. the parser and the lexer");
	assert.equal(deriveTitle("Check i.e. this one. Then stop."), "Check i.e. this one");
	assert.equal(deriveTitle("Look at https://github.com/foo/bar/pull/12 and summarize it"), "Look at github.com and summarize it");
	assert.equal(deriveTitle("Look at the PR https://user:pw@www.example.com/x?y=1. Then stop."), "Look at the PR example.com");
	assert.equal(deriveTitle("Read the long and winding description of the bug in the tracker"), "Read the long and winding description…", "a cut doesn't end on 'of'");
	assert.equal(deriveTitle("cd ~/tmp/wt-"), "cd ~/tmp/wt-", "nothing but a cd: the prompt itself, not a bare 'cd'");
	assert.equal(deriveTitle("cd ~/x && run the tests"), "run the tests");
});

test("secrets: the prompt is masked whole before a title comes from it", () => {
	const ghp = `ghp_${"A1b2C3d4E5".repeat(3)}O5p6Q7`;
	assert.equal(ghp.length, 40);
	assert.equal(deriveTitle(`Use ${ghp}`), "Use •••");
	assert.ok(!deriveTitle(`Use ${ghp} for the push`).includes("ghp_"));
	// A key the 40-character cut would land in the middle of.
	const sk = `sk-ant-api03-${"x9Y8z7W6v5".repeat(4)}`;
	const mid = deriveTitle(`Please call the API with key ${sk} and report`);
	assert.ok(!/sk-ant|x9Y8/.test(mid), mid);
	assert.ok(!/sk-ant|x9Y8/.test(jobTitle(`Call it with ${sk} now`, "")), "a given title is masked too");
	// AKIA in a wt- path: the name is not used, and the fallback is masked.
	const wt = deriveTitle("cd /tmp/wt-AKIAIOSFODNN7EXAMPLE");
	assert.ok(!wt.includes("AKIA") && !wt.includes("IOSFODNN"), wt);
	const br = deriveTitle(`On branch ${"ghp_" + "Z".repeat(36)}-x, add a test.`);
	assert.ok(!/ghp|ZZZZ/i.test(br), br);
});

test("cuts are by code point: an emoji is never split", () => {
	const t = deriveTitle("😀".repeat(30));
	assert.equal(Array.from(t).length, TITLE_MAX > 30 ? 30 : TITLE_MAX);
	const long = deriveTitle("😀".repeat(60));
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long), "no lone high surrogate");
	assert.ok(!JSON.stringify(long).includes("\\ud"), JSON.stringify(long));
	assert.equal(Array.from(long).length, TITLE_MAX);
	const given = cleanTitle(`Fix ${"🎉".repeat(70)}`);
	assert.ok(!JSON.stringify(given).includes("\\ud"));
});

test("nothing but a path: the path; nothing at all: empty", () => {
	assert.equal(deriveTitle("~/tmp/x"), "~/tmp/x");
	assert.equal(deriveTitle(""), "");
	assert.equal(deriveTitle(undefined), "");
	assert.equal(deriveTitle(42), "");
});

test("a given title wins, one line and capped; blank or not a string falls back to the prompt", () => {
	assert.equal(jobTitle("  Work log\n order ", "cd ~/tmp/wt-other"), "Work log order");
	assert.equal(jobTitle("", "cd ~/tmp/wt-other"), "Other");
	assert.equal(jobTitle("   ", "cd ~/tmp/wt-other"), "Other");
	assert.equal(jobTitle(7, "cd ~/tmp/wt-other"), "Other");
	assert.equal(cleanTitle("w".repeat(200)).length, GIVEN_TITLE_MAX);
	assert.equal(cleanTitle("a\u202Eb"), "a b", "no bidi overrides");
});

test("humanize: wt- and a branch prefix go, separators become spaces", () => {
	assert.equal(humanize("wt-jobs-title-scope"), "Jobs title scope");
	assert.equal(humanize("feat/foo_bar"), "Foo bar");
	assert.equal(humanize("~/Code/x/repo.git/"), "Repo");
	assert.equal(humanize("wt-"), "");
});
