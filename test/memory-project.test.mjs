import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { testGit as git, world } from "./helpers/memory-env.mjs";
import { slugFor, slugFromRemote } from "../lib/memory/project.ts";

test("slug from https and ssh remotes, normalized", () => {
	const cases = {
		"https://github.com/Acme/Widgets.git": "github.com/acme/widgets",
		"https://github.com/acme/widgets": "github.com/acme/widgets",
		"https://github.com/acme/widgets/": "github.com/acme/widgets",
		"https://user:pw@github.com/acme/widgets.git": "github.com/acme/widgets",
		"git@github.com:acme/widgets.git": "github.com/acme/widgets",
		"github.com:acme/widgets": "github.com/acme/widgets",
		"ssh://git@github.com/acme/widgets.git": "github.com/acme/widgets",
		"ssh://git@GitHub.com:2222/acme/widgets.git": "github.com/acme/widgets",
		"https://gitlab.example.com/group/sub/repo.git": "gitlab.example.com/group/sub/repo",
	};
	for (const [url, slug] of Object.entries(cases)) assert.equal(slugFromRemote(url), slug, url);
});

test("no slug for local paths, odd hosts or traversal", () => {
	for (const url of ["", "/srv/git/widgets.git", "../widgets", "file:///srv/git/widgets.git", "C:\\repos\\widgets", "https://github.com/widgets", "https://github.com/acme/../etc", "git@github.com:acme/wid gets.git", "https://-evil.com/a/b", "https://github.com/acme/%2e%2e"]) {
		assert.equal(slugFromRemote(url), null, url);
	}
});

test("slugFor: a repo, its worktree and a subfolder share the slug; no origin is null", () => {
	const repo = join(world, `repo-${Date.now()}`);
	mkdirSync(join(repo, "sub"), { recursive: true });
	git(repo, "init", "-q", "--template=");
	assert.equal(slugFor(repo), null);
	git(repo, "remote", "add", "origin", "git@github.com:acme/widgets.git");
	git(repo, "commit", "-q", "--allow-empty", "-m", "init");
	const wt = join(world, `wt-${Date.now()}`);
	git(repo, "worktree", "add", "-q", wt);
	assert.equal(slugFor(repo), "github.com/acme/widgets");
	assert.equal(slugFor(join(repo, "sub")), "github.com/acme/widgets");
	assert.equal(slugFor(wt), "github.com/acme/widgets");
	assert.equal(slugFor(join(world, "no-such-dir")), null);
});
