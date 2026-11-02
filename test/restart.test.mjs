import assert from "node:assert/strict";
import { test } from "node:test";

import { guardianBypassed, liveDir, liveRecord } from "../extensions/restart/index.ts";

const env = { TMUX: "/private/tmp/tmux-501/default,123,0", TMUX_PANE: "%12" };
const base = { pid: 42, sessionFile: "/s/a.jsonl", cwd: "/w", env, bypass: false, idle: true, now: new Date(0) };

test("a pi in a tmux pane with a session file gets a record", () => {
	assert.deepEqual(liveRecord(base), {
		pid: 42, sessionFile: "/s/a.jsonl", cwd: "/w", pane: "%12", socket: "/private/tmp/tmux-501/default",
		bypass: false, idle: true, at: "1970-01-01T00:00:00.000Z",
	});
});

test("no record outside tmux, without a session file, or with a odd pane id", () => {
	assert.equal(liveRecord({ ...base, env: {} }), null);
	assert.equal(liveRecord({ ...base, sessionFile: undefined }), null);
	assert.equal(liveRecord({ ...base, env: { ...env, TMUX_PANE: "%12; rm -rf ~" } }), null);
	assert.equal(liveRecord({ ...base, env: { TMUX_PANE: "%12" } }), null);
});

test("bypass is read from the guardian's process slot, for this session file only", () => {
	const slot = Symbol.for("pi-approval-guardian.temporary-bypass");
	const g = {};
	assert.equal(guardianBypassed("/s/a.jsonl", g), false);
	g[slot] = { sessionFile: "/s/a.jsonl" };
	assert.equal(guardianBypassed("/s/a.jsonl", g), true);
	assert.equal(guardianBypassed("/s/b.jsonl", g), false, "another session's bypass");
	assert.equal(guardianBypassed(undefined, g), false);
	g[slot] = { sessionFile: undefined };
	assert.equal(guardianBypassed(undefined, g), false);
});

test("records live under XDG_STATE_HOME", () => {
	assert.equal(liveDir({ XDG_STATE_HOME: "/x" }), "/x/pi-restart/live");
});

test("SIGUSR2 between runtimes is kept for the next session_start, not lost or fatal", async () => {
	const { signalSlot, onRestartSignal } = await import("../extensions/restart/index.ts");
	const g = {};
	const slot = signalSlot(g);
	assert.equal(signalSlot(g), slot, "one slot per process");
	onRestartSignal(slot);
	assert.equal(slot.pending, true);
	let stopped = 0;
	slot.pending = false;
	slot.shutdown = () => stopped++;
	onRestartSignal(slot);
	assert.equal(stopped, 1);
	assert.equal(slot.pending, false);
});
