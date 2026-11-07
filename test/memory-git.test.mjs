import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { freshRoot, gitLog as log, stubBin, testGit, world } from "./helpers/memory-env.mjs";
import { commit, gitEnv } from "../lib/memory/git.ts";
import * as ops from "../lib/memory/ops.ts";
import { normalize } from "../lib/memory/settings.ts";
import * as store from "../lib/memory/store.ts";

const gitRoot = () => {
	const root = freshRoot();
	store.init(root, { git: true });
	return root;
};

test("a write is committed, with the kind and id and never the text", async () => {
	const root = gitRoot();
	const m = store.write(root, { scope: "global", text: "A private-ish fact about deploys", source: { kind: "cli" } });
	assert.deepEqual(await commit(root, `cli ${m.id}`), { ok: true });
	assert.deepEqual(log(root), [`cli ${m.id}`]);
	assert.deepEqual(await commit(root, "again"), { ok: true, unchanged: true });
	assert.equal(log(root).length, 1);
	assert.ok(existsSync(join(root, ".gitignore")));
});

test("init copies no hooks, and hooks in the repo or its config never run", async () => {
	const root = gitRoot();
	assert.ok(!existsSync(join(root, ".git", "hooks", "pre-commit.sample")));
	const marker = join(world, `hook-ran-${Date.now()}`);
	const hook = `#!/bin/sh\ntouch ${marker}\n`;
	const elsewhere = join(world, `hooks-${Date.now()}`);
	for (const dir of [join(root, ".git", "hooks"), elsewhere]) {
		mkdirSync(dir, { recursive: true });
		for (const name of ["pre-commit", "commit-msg", "post-commit", "prepare-commit-msg", "reference-transaction", "post-index-change"]) {
			writeFileSync(join(dir, name), hook);
			chmodSync(join(dir, name), 0o755);
		}
	}
	testGit(root, "config", "core.hooksPath", elsewhere);
	store.write(root, { scope: "global", text: "hooked fact", source: { kind: "cli" } });
	assert.equal((await commit(root, "cli x")).ok, true);
	assert.ok(!existsSync(marker), "a hook ran");
});

test("a .gitattributes in the root can't make git add run a filter driver", async () => {
	const root = gitRoot();
	const marker = join(world, `filter-ran-${Date.now()}`);
	testGit(root, "config", "--local", "filter.evil.clean", `touch ${marker}; cat`);
	testGit(root, "config", "--local", "diff.evil.textconv", `touch ${marker}; cat`);
	writeFileSync(join(root, ".gitattributes"), "* filter=evil diff=evil\n");
	store.write(root, { scope: "global", text: "filtered fact", source: { kind: "cli" } });
	assert.equal((await commit(root, "cli f")).ok, true);
	assert.ok(!existsSync(marker), "a filter driver ran");
	assert.deepEqual(log(root), ["cli f"]);
});

test("init writes hooks off and an identity into the repo's own config, and puts them back", () => {
	const root = gitRoot();
	const local = (key) => testGit(root, "config", "--local", "--get", key).trim();
	assert.equal(local("core.hooksPath"), "/dev/null");
	assert.equal(local("core.fsmonitor"), "false");
	assert.equal(local("commit.gpgsign"), "false");
	assert.equal(local("user.name"), "pi-memory");
	assert.equal(local("user.email"), "pi-memory@localhost");
	testGit(root, "config", "--local", "core.hooksPath", join(world, "elsewhere"));
	store.init(root, { git: true });
	assert.equal(local("core.hooksPath"), "/dev/null");
});

test("refuses to commit when the repo has a remote", async () => {
	const root = gitRoot();
	store.write(root, { scope: "global", text: "first", source: { kind: "cli" } });
	await commit(root, "first");
	testGit(root, "remote", "add", "origin", "https://example.com/mem.git");
	store.write(root, { scope: "global", text: "second", source: { kind: "cli" } });
	const logged = [];
	const r = await commit(root, "second", (m) => logged.push(m));
	assert.equal(r.ok, false);
	assert.match(r.error, /remote \(origin\)/);
	assert.equal(logged.length, 1);
	assert.deepEqual(log(root), ["first"]);
});

test("GIT_DIR and friends in the environment can't redirect the commit", async () => {
	const root = gitRoot();
	const other = freshRoot("other");
	store.init(other, { git: true });
	store.write(root, { scope: "global", text: "mine", source: { kind: "cli" } });
	const saved = { ...process.env };
	Object.assign(process.env, { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/tmp" });
	try {
		assert.equal((await commit(root, "env")).ok, true);
	} finally {
		for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete process.env[k];
		Object.assign(process.env, saved);
	}
	assert.deepEqual(log(root), ["env"]);
	assert.deepEqual(log(other), []);
	assert.deepEqual(Object.keys(gitEnv({ GIT_DIR: "x", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/h" })).sort(), ["GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT", "HOME"]);
});

test("a root that isn't a repo: no commit, and no enclosing repo is touched", async () => {
	const parent = gitRoot();
	const inner = join(parent, "global", "not-a-repo");
	mkdirSync(inner);
	const r = await commit(inner, "x");
	assert.equal(r.ok, false);
	assert.match(r.error, /not a git repo/);
	assert.deepEqual(log(parent), []);
});

test("concurrent commits are serialized by the lock", async () => {
	const root = gitRoot();
	const ids = Array.from({ length: 5 }, (_, i) => store.write(root, { scope: "global", text: `fact number ${i}`, source: { kind: "cli" } }).id);
	const results = await Promise.all(ids.map((id) => commit(root, `cli ${id}`)));
	assert.ok(results.every((r) => r.ok), JSON.stringify(results));
	assert.ok(!existsSync(join(root, ".git", "pi-memory.lock")));
});

test("a failing git doesn't fail the write", async () => {
	const root = gitRoot();
	const settings = normalize({ root, git: true, qmd: "off" }, {});
	const mem = ops.open(settings);
	const bin = stubBin("git", "#!/bin/sh\necho broken >&2\nexit 1\n");
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	let w;
	try {
		w = ops.remember(mem, { text: "Written even though git is broken", scope: "global", source: { kind: "cli" } });
		const r = await w.committed;
		assert.equal(r.ok, false);
	} finally {
		process.env.PATH = path;
	}
	assert.ok(existsSync(w.memory.path));
	assert.equal(store.find(root, w.memory.id).text, "Written even though git is broken");
});
