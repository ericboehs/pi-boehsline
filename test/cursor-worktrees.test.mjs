// Tests for the cursor-agent opt-in's worktree helpers (behind /cursor-worktrees),
// against real git repos in a temp dir.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyToRepo, describe, listWorktrees, removeWorktree } from "../extensions/opt-in/cursor-agent/worktrees.ts";

const sh = (cwd, ...args) =>
	// gpgsign=false: a global commit.gpgsign must not require the user's signing key.
	execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "cursor-wt-"));
	const repo = join(dir, "app");
	const root = join(dir, "worktrees");
	mkdirSync(repo);
	sh(repo, "init", "-q");
	writeFileSync(join(repo, "fizz.rb"), "a\nb\nc\n");
	sh(repo, "add", ".");
	sh(repo, "commit", "-qm", "init");
	mkdirSync(join(root, "app"), { recursive: true });
	const add = (name) => {
		const path = join(root, "app", name);
		sh(repo, "worktree", "add", "-q", "-b", name, path);
		return path;
	};
	return { repo, root, add };
}

test("listWorktrees: finds pi-* worktrees with their changes and commits", async () => {
	const { repo, root, add } = setup();
	const a = add("pi-a");
	writeFileSync(join(a, "fizz.rb"), "a\nB\nc\n");
	writeFileSync(join(a, "new.rb"), "x\n");
	const b = add("pi-b");
	writeFileSync(join(b, "more.rb"), "y\n");
	sh(b, "add", ".");
	sh(b, "commit", "-qm", "more");
	add("other"); // not ours

	const list = await listWorktrees(root);
	assert.deepEqual(list.map((w) => w.name), ["pi-a", "pi-b"]);
	const [wa, wb] = list;
	assert.equal(wa.repo, execFileSync("realpath", [repo], { encoding: "utf8" }).trim());
	assert.equal(wa.branch, "pi-a");
	assert.deepEqual(wa.changed.sort(), [" M fizz.rb", "?? new.rb"]);
	assert.equal(wa.ahead, 0);
	assert.equal(wb.ahead, 1);
	assert.match(describe(wb), /^app\/pi-b · 0 changed, 1 commit$/);
	assert.deepEqual(await listWorktrees(join(root, "missing")), []);
});

test("applyToRepo: applies uncommitted, untracked and committed work to the repo, uncommitted", async () => {
	const { repo, root, add } = setup();
	const a = add("pi-a");
	writeFileSync(join(a, "fizz.rb"), "a\nB\nc\n");
	writeFileSync(join(a, "new.rb"), "x\n");
	sh(a, "commit", "-qam", "edit"); // committed part (new.rb stays untracked)
	writeFileSync(join(a, "fizz.rb"), "a\nB\nC\n"); // plus an uncommitted change on top
	const [wt] = await listWorktrees(root);

	assert.deepEqual(await applyToRepo(wt), { files: 2 });
	assert.equal(readFileSync(join(repo, "fizz.rb"), "utf8"), "a\nB\nC\n");
	assert.equal(readFileSync(join(repo, "new.rb"), "utf8"), "x\n");
	assert.equal(sh(repo, "log", "--oneline").trim().split("\n").length, 1, "nothing committed in the repo");
	assert.deepEqual(sh(a, "status", "--short").trimEnd().split("\n"), [" M fizz.rb", "?? new.rb"], "worktree's own index untouched");
});

test("applyToRepo: applies nothing when the patch conflicts", async () => {
	const { repo, root, add } = setup();
	const a = add("pi-a");
	writeFileSync(join(a, "fizz.rb"), "a\nB\nc\n");
	writeFileSync(join(a, "new.rb"), "x\n");
	writeFileSync(join(repo, "fizz.rb"), "a\nZ\nc\n"); // the repo changed the same line
	const [wt] = await listWorktrees(root);

	await assert.rejects(applyToRepo(wt), /doesn't apply cleanly/);
	assert.equal(readFileSync(join(repo, "fizz.rb"), "utf8"), "a\nZ\nc\n");
	assert.equal(existsSync(join(repo, "new.rb")), false);
});

test("removeWorktree: deletes the worktree, its branch and the empty repo folder", async () => {
	const { repo, root, add } = setup();
	const a = add("pi-a");
	writeFileSync(join(a, "new.rb"), "x\n");
	const [wt] = await listWorktrees(root);

	await removeWorktree(wt);
	assert.equal(existsSync(a), false);
	assert.equal(existsSync(join(root, "app")), false);
	assert.doesNotMatch(sh(repo, "branch"), /pi-a/);
	assert.deepEqual(await listWorktrees(root), []);
	await assert.rejects(removeWorktree({ ...wt, name: "main" }), /not a pi-\* worktree/);
});
