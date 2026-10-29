import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

// No user file, no env: what a stranger gets.
process.env.BOEHSLINE_CONFIG = join(mkdtempSync(join(tmpdir(), "boehsline-")), "none.json");
for (const k of Object.keys(process.env)) if (/^PI_(WATCH|MEETING)_/.test(k)) delete process.env[k];

const { registerSource, sources } = await import("../lib/config.ts");
const { compileRedactions, watchSettings, workSettings, meetingSettings, expandHome } = await import("../extensions/opt-in/watch/settings.ts");
const watch = await import("../extensions/opt-in/watch/index.ts");
const models = await import("../extensions/opt-in/watch/models.ts");

beforeEach(() => sources().clear());

test("neutral defaults: no workspaces, no feed, no work route, no notes, nothing redacted", () => {
	watch.applySettings();
	assert.deepEqual(watch.WORKSPACES, []);
	assert.deepEqual(watch.WORK_WORKSPACES, []);
	assert.equal(watch.FEED_CLI, "");
	assert.equal(watch.FEED_CHANNEL, "");
	assert.deepEqual(models.WORK_PROVIDERS, []);
	assert.equal(models.isWorkModel("github-copilot/anything"), false, "no provider may read work text until configured");
	assert.equal(watch.redact("EMP123456 and 555-12-3456"), "EMP123456 and 555-12-3456");
	assert.equal(watchSettings().dailyDir, "");
	assert.deepEqual(meetingSettings().qmdCollections, []);
	assert.equal(meetingSettings().owner, "", "no owner session until named");
});

test("a package's settings apply at applySettings (session_start), not at import", () => {
	registerSource("acme", {
		work: { label: "Acme Copilot", providers: ["GitHub-Copilot"], redact: [{ pattern: "\\bEMP\\d{6}\\b", flags: "", replace: "[EMP]" }] },
		watch: { workspaces: ["acme"], workWorkspaces: ["acme"], feed: { cli: "feed", workspace: "acme", channel: "C1", label: "#f" } },
	});
	assert.deepEqual(watch.WORKSPACES, [], "unchanged until applied");
	watch.applySettings();
	assert.deepEqual(watch.WORKSPACES, ["acme"]);
	assert.equal(watch.FEED_LABEL, "#f");
	assert.equal(models.WORK_LABEL, "Acme Copilot");
	assert.equal(models.isWorkModel("github-copilot/x"), true, "providers compare case-blind");
	assert.equal(watch.redact("id EMP123456 and EMP654321"), "id [EMP] and [EMP]", "g is always added");
	assert.equal(watch.routeOf("acme"), "work");
});

test("env still wins over settings", () => {
	registerSource("acme", { watch: { workspaces: ["acme"], vips: ["Sam"] }, meeting: { qmdCollections: ["a"] } });
	const env = { PI_WATCH_WORKSPACES: "x, y", PI_WATCH_VIP: "", PI_MEETING_QMD_COLLECTIONS: "", PI_WATCH_WORK_MODEL: "p/m, nope" };
	assert.deepEqual(watchSettings(env).workspaces, ["x", "y"]);
	assert.deepEqual(watchSettings(env).vips, [], "an empty env var clears the list");
	assert.deepEqual(meetingSettings(env).qmdCollections, []);
	assert.deepEqual(workSettings(env).models, ["p/m"], "specs need a provider");
});

test("meeting.owner: from settings, PI_MEETING_OWNER wins, trimmed", () => {
	registerSource("me", { meeting: { owner: "earl" } });
	assert.equal(meetingSettings({}).owner, "earl");
	assert.equal(meetingSettings({ PI_MEETING_OWNER: " bob " }).owner, "bob");
	assert.equal(meetingSettings({ PI_MEETING_OWNER: "" }).owner, "", "an empty env var clears it");
});

test("dailyDir: watch falls back to meeting's; ~ expands", () => {
	registerSource("me", { meeting: { dailyDir: "~/Notes/daily" } });
	assert.equal(watchSettings({}).dailyDir, expandHome("~/Notes/daily"));
	assert.ok(!watchSettings({}).dailyDir.startsWith("~"));
});

test("a bad redaction pattern is skipped, not fatal", () => {
	assert.equal(compileRedactions([{ pattern: "(", flags: "", replace: "x" }, { pattern: "a", flags: "i", replace: "b" }]).length, 1);
});

test("notif-watch: work.redact becomes --mask rules; a replacement with = is skipped", () => {
	assert.deepEqual(
		watch.notifMasks([
			{ pattern: "\\bEMP\\d{6}\\b", flags: "g", replace: "[EMP]" },
			{ pattern: "acct-\\d+", flags: "gi", replace: "[ACCT]" },
			{ pattern: "x", flags: "", replace: "a=b" },
		]),
		["[EMP]=\\bEMP\\d{6}\\b", "[ACCT]=(?i)acct-\\d+"],
	);
});

test("notif-watch binary: env, then watch.notifBin, then Boehsline's build, then PATH", () => {
	assert.equal(watch.notifBin({ PI_WATCH_NOTIF_BIN: "/x/nw" }), "/x/nw");
	registerSource("me", { watch: { notifBin: "~/bin/nw" } });
	watch.applySettings();
	assert.match(watch.notifBin({}), /\/bin\/nw$/);
	assert.ok(!watch.notifBin({}).startsWith("~"));
	sources().clear();
	watch.applySettings();
	assert.match(watch.notifBin({}), /(\/bin\/notif-watch|^notif-watch)$/);
});
