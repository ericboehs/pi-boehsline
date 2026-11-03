import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

// No mise config under this HOME, and the agent dir (update-check.json) is a temp one too.
const home = mkdtempSync(join(tmpdir(), "update-home-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = home;
const config = join(home, "boehsline.json");
process.env.BOEHSLINE_CONFIG = config;
process.env.BOEHSLINE_ENABLE = "update";
delete process.env.PI_SKIP_VERSION_CHECK;
delete process.env.PI_OFFLINE;

const { default: update, projectRoot, isNewer } = await import("../extensions/opt-in/update/index.ts");

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

test("/update without a mise project says how to set update.dir; with one, projectRoot finds it", async () => {
	const s = stubPi();
	update(s.pi);
	const { ctx, notes } = stubCtx();
	await s.commands.get("update").handler("check", ctx);
	assert.equal(notes.at(-1)[0], "error");
	assert.match(notes.at(-1)[1], /"update": \{ "dir"/);
	writeFileSync(config, JSON.stringify({ update: { dir: home } }));
	assert.equal(await projectRoot(), home, "not a git checkout, so the dir itself");
});

test("no UI: the startup check does nothing", async () => {
	const s = stubPi();
	update(s.pi);
	await s.fire("session_start", {}, stubCtx({ hasUI: false }).ctx);
	assert.equal(s.sent.length, 0);
});
