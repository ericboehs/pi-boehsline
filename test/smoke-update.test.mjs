import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

// A temp HOME and agent dir (update-check.json), so nothing real is read or written.
const home = mkdtempSync(join(tmpdir(), "update-home-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = home;
const config = join(home, "boehsline.json");
process.env.BOEHSLINE_CONFIG = config;
process.env.BOEHSLINE_ENABLE = "update";
delete process.env.PI_SKIP_VERSION_CHECK;
delete process.env.PI_OFFLINE;

const { default: update, forkRoot, findCheckout, upstreamStatus, isNewer } = await import("../extensions/opt-in/update/index.ts");

test("update registers /update, the banner renderer and a startup check; it silences pi's own check", () => {
	const s = stubPi();
	update(s.pi);
	assert.deepEqual(s.names(), [
		"command:update",
		"entry-renderer:pi-update-available",
		"on:session_start",
		"renderer:pi-update-available",
	]);
	assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1");
	const complete = s.commands.get("update").getArgumentCompletions;
	assert.deepEqual(complete("ch").map((i) => i.value), ["check"]);
	assert.deepEqual(complete("x"), []);
});

test("isNewer compares major.minor.patch", () => {
	assert.equal(isNewer("1.5.0", "1.4.0"), true);
	assert.equal(isNewer("1.5.0", "1.5.0"), false);
	assert.equal(isNewer("1.4.9", "1.5.0"), false);
	assert.equal(isNewer("1.10.0", "1.9.3"), true);
	assert.equal(isNewer("v2.0.0", "1.99.99"), true);
});

test("a banner renders only while its version is newer than the running pi", () => {
	const s = stubPi();
	update(s.pi);
	const theme = { fg: (_c, t) => t, bold: (t) => t };
	const entry = s.entryRenderers.get("pi-update-available");
	assert.equal(entry({ data: {} }, {}, theme), undefined);
	assert.equal(entry({ data: { version: "0.0.1" } }, {}, theme), undefined, "stale entry hidden");
	assert.ok(entry({ data: { version: "999.0.0" } }, {}, theme), "a component for a newer version");

	// Older sessions stored the banner as a custom message.
	const message = s.renderers.get("pi-update-available");
	assert.equal(message({ details: {} }, {}, theme), undefined);
	assert.equal(message({ details: { version: "0.0.1" } }, {}, theme).children.length, 0, "stale message hidden");
	assert.ok(message({ details: { version: "999.0.0" } }, {}, theme).children.length > 0);
});

const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** An "upstream" repo and a fork clone of it, with the sync script and coding-agent's package.json. */
function forkFixture(version = "1.5.0") {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "update-fork-")));
	const up = join(base, "upstream");
	mkdirSync(join(up, "scripts"), { recursive: true });
	mkdirSync(join(up, "packages", "coding-agent", "dist", "bundle"), { recursive: true });
	writeFileSync(join(up, "scripts", "sync-upstream.sh"), "#!/bin/sh\n");
	writeFileSync(join(up, "packages", "coding-agent", "dist", "bundle", "cli.js"), "");
	const pkg = (v) => writeFileSync(join(up, "packages", "coding-agent", "package.json"), JSON.stringify({ version: v }));
	pkg(version);
	sh(base, "init", "-q", "-b", "main", up);
	sh(up, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
	sh(up, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	const fork = join(base, "fork");
	sh(base, "clone", "-q", up, fork);
	sh(fork, "remote", "add", "upstream", up);
	const release = (v) => {
		pkg(v);
		sh(up, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", `release ${v}`);
	};
	return { fork, release };
}

test("/update without a fork checkout says how to set update.dir", async () => {
	const s = stubPi();
	update(s.pi);
	const saved = process.argv[1];
	process.argv[1] = join(home, "nowhere", "cli.js");
	try {
		const { ctx, notes } = stubCtx();
		await s.commands.get("update").handler("check", ctx);
		assert.equal(notes.at(-1)[0], "error");
		assert.match(notes.at(-1)[1], /"update": \{ "dir"/);
	} finally {
		process.argv[1] = saved;
	}
});

test("forkRoot: the checkout the running pi was started from, or update.dir", () => {
	const { fork } = forkFixture();
	const cli = join(fork, "packages", "coding-agent", "dist", "bundle", "cli.js");
	assert.equal(findCheckout(join(fork, "packages", "coding-agent")), fork);
	assert.equal(forkRoot(cli), fork, "walks up from the entry script");
	assert.equal(forkRoot(join(home, "missing.js")), null);
	writeFileSync(config, JSON.stringify({ update: { dir: fork } }));
	try {
		assert.equal(forkRoot(undefined), fork, "update.dir wins");
	} finally {
		writeFileSync(config, "{}");
	}
});

test("upstreamStatus: how far behind main is, and upstream's version", async () => {
	const { fork, release } = forkFixture("1.5.0");
	assert.deepEqual({ ...(await upstreamStatus(fork)), sha: "" }, { behind: 0, version: "1.5.0", sha: "" });
	release("1.6.0");
	const st = await upstreamStatus(fork);
	assert.equal(st.behind, 1);
	assert.equal(st.version, "1.6.0");
	assert.match(st.sha, /^[0-9a-f]{7,}$/);
	assert.equal(sh(fork, "rev-list", "--count", "HEAD"), "1", "main itself is untouched");
});

test("no UI: the startup check does nothing", async () => {
	const s = stubPi();
	update(s.pi);
	await s.fire("session_start", {}, stubCtx({ hasUI: false }).ctx);
	assert.equal(s.sent.length, 0);
});
