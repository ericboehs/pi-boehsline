import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { optIns } from "../lib/config.ts";

// Point the user file somewhere empty so Eric's real config can't leak in.
process.env.BOEHSLINE_CONFIG = join(mkdtempSync(join(tmpdir(), "boehsline-")), "none.json");

const OPT_INS = ["approval-guardian", "image-prune", "meeting", "omlx", "sc", "tmux-attention", "botsun-owner", "update", "watch", "wiki-session-log"];

/** A pi stub that records every registration. */
function recorder() {
	const calls = [];
	const rec = (kind) => (...args) => { calls.push([kind, args[0]]); return () => {}; };
	const pi = {
		on: rec("on"), registerCommand: rec("command"), registerTool: rec("tool"),
		registerProvider: rec("provider"), registerShortcut: rec("shortcut"),
		registerMessageRenderer: rec("renderer"), registerFlag: rec("flag"),
		exec: async () => ({ stdout: "", stderr: "", code: 1 }),
		events: { on: rec("events.on"), emit: () => {} },
	};
	return { pi, calls };
}

for (const name of OPT_INS) {
	test(`${name}: off by default, registers nothing`, async () => {
		delete process.env.BOEHSLINE_ENABLE;
		const mod = await import(`../extensions/opt-in/${name}/index.ts?off=${Math.random()}`);
		const { pi, calls } = recorder();
		await mod.default(pi);
		assert.deepEqual(calls, []);
		assert.equal(optIns().get(name)?.on, false);
		assert.ok(optIns().get(name)?.description);
	});
}

test("tmux-attention: enabled via BOEHSLINE_ENABLE, it registers handlers", async () => {
	process.env.BOEHSLINE_ENABLE = "tmux-attention";
	process.env.TMUX_PANE = "%9";
	try {
		const mod = await import(`../extensions/opt-in/tmux-attention/index.ts?on=${Math.random()}`);
		const { pi, calls } = recorder();
		await mod.default(pi);
		assert.ok(calls.length > 0);
		assert.equal(optIns().get("tmux-attention")?.on, true);
	} finally {
		delete process.env.BOEHSLINE_ENABLE;
	}
});
