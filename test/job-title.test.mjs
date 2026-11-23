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
	assert.equal(deriveTitle("Review the diff in lib/foo.rb for bugs. Then report back."), "Review the diff in for bugs");
	assert.equal(deriveTitle("Find every call of `trackChild` in ~/Code/x and list them with their line numbers"), "Find every call of trackChild in and…");
	const long = deriveTitle("x".repeat(100));
	assert.equal(long.length, TITLE_MAX);
	assert.ok(long.endsWith("…"));
	assert.equal(deriveTitle("Summarize\nthe changes since Monday"), "Summarize the changes since Monday", "one line");
	assert.equal(deriveTitle("Check (~/x/y) quickly."), "Check quickly", "parentheses the paths emptied go too");
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
