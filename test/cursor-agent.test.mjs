/**
 * Tests for cursor-agent's pure parts: settings (config, then PI_CURSOR_*
 * env vars) and the stream-json reducer. The tool itself shells out to
 * cursor-agent and calls Cursor's API, so it is exercised by hand, not here.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { registerSource, sources } from "../lib/config.ts";
import { describeTool, RunReducer } from "../extensions/opt-in/cursor-agent/events.ts";
import { applyEnv, blockedBy, DEFAULTS, loadSettings, normalize } from "../extensions/opt-in/cursor-agent/settings.ts";

const emptyUserConfig = () => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-agent-"));
	const path = join(dir, "boehsline.json");
	writeFileSync(path, "{}");
	return path;
};

beforeEach(() => {
	sources().clear();
	process.env.BOEHSLINE_CONFIG = emptyUserConfig();
});

test("settings: neutral defaults with no config and no env", () => {
	assert.deepEqual(loadSettings({}), DEFAULTS);
	assert.equal(DEFAULTS.defaultModel, "auto");
	assert.deepEqual(DEFAULTS.blockedModels, []);
});

test("settings: a config source (a work package) supplies org rules", () => {
	registerSource("work", {
		"cursor-agent": { defaultModel: "composer-2.5", blockedModels: ["fable"], note: "Work seat.", rules: ["R1"] },
	});
	const s = loadSettings({});
	assert.equal(s.defaultModel, "composer-2.5");
	assert.deepEqual(s.blockedModels, ["fable"]);
	assert.equal(s.note, "Work seat.");
	assert.deepEqual(s.rules, ["R1"]);
	assert.equal(s.blockedReason, DEFAULTS.blockedReason);
});

test("settings: env vars replace config; empty vars count as unset", () => {
	registerSource("work", { "cursor-agent": { defaultModel: "composer-2.5", blockedModels: ["fable"], rules: ["R1"] } });
	const s = loadSettings({
		PI_CURSOR_MODEL: "claude-opus-5-5-high",
		PI_CURSOR_BLOCKED_MODELS: "fable, grok ,",
		PI_CURSOR_BLOCKED_REASON: "policy",
		PI_CURSOR_NOTE: "  ",
		PI_CURSOR_RULES: "Rule A || Rule B\nRule C",
	});
	assert.equal(s.defaultModel, "claude-opus-5-5-high");
	assert.deepEqual(s.blockedModels, ["fable", "grok"]);
	assert.equal(s.blockedReason, "policy");
	assert.equal(s.note, "", "a blank PI_CURSOR_NOTE leaves the setting alone");
	assert.deepEqual(s.rules, ["Rule A", "Rule B", "Rule C"]);
});

test("settings: junk in config falls back to defaults", () => {
	const s = normalize({ defaultModel: 7, blockedModels: "fable", rules: ["ok", 3, " "], note: null });
	assert.equal(s.defaultModel, "auto");
	assert.deepEqual(s.blockedModels, []);
	assert.deepEqual(s.rules, ["ok"]);
	assert.equal(s.note, "");
	assert.deepEqual(applyEnv(s, {}), s);
});

test("blockedBy: case-insensitive substring match", () => {
	const s = { ...DEFAULTS, blockedModels: ["Fable"] };
	assert.equal(blockedBy("claude-fable-5-thinking-high", s), "Fable");
	assert.equal(blockedBy("composer-2.5", s), undefined);
});

test("describeTool: paths relative to the workspace, through /private realpaths", () => {
	const cwd = "/tmp/ws";
	assert.deepEqual(describeTool({ readToolCall: { args: { path: "/private/tmp/ws/fizz.rb" } } }, cwd), {
		kind: "read",
		summary: "read fizz.rb",
		ok: undefined,
	});
	const shell = describeTool(
		{
			shellToolCall: {
				args: { command: "ruby /private/tmp/ws/fizz_test.rb" },
				result: { success: { exitCode: 1 } },
			},
		},
		cwd,
	);
	assert.equal(shell.summary, "shell ruby fizz_test.rb");
	assert.equal(shell.ok, false);
	assert.equal(describeTool({ globToolCall: { args: { globPattern: "**/*.rb" } } }, cwd).summary, "glob **/*.rb");
});

// Trimmed from a real `cursor-agent -p --output-format stream-json --stream-partial-output` run.
const RUN = [
	{ type: "system", subtype: "init", session_id: "s1", model: "Composer 2.5", cwd: "/private/tmp/ws" },
	{ type: "user", message: { role: "user", content: [{ type: "text", text: "fix it" }] }, session_id: "s1" },
	{ type: "thinking", subtype: "delta", text: "I", session_id: "s1", timestamp_ms: 1 },
	{ type: "thinking", subtype: "completed", session_id: "s1", timestamp_ms: 2 },
	{ type: "assistant", message: { content: [{ type: "text", text: "Inspect" }] }, session_id: "s1", timestamp_ms: 3 },
	{ type: "assistant", message: { content: [{ type: "text", text: "ing" }] }, session_id: "s1", timestamp_ms: 3 },
	{
		type: "assistant",
		message: { content: [{ type: "text", text: "Inspecting fizz.rb." }] },
		session_id: "s1",
		timestamp_ms: 4,
		model_call_id: "m1",
	},
	{ type: "tool_call", subtype: "started", call_id: "t1", tool_call: { readToolCall: { args: { path: "/private/tmp/ws/fizz.rb" } } } },
	{
		type: "tool_call",
		subtype: "completed",
		call_id: "t1",
		tool_call: { readToolCall: { args: { path: "/private/tmp/ws/fizz.rb" }, result: { success: { content: "…" } } } },
	},
	{ type: "assistant", message: { content: [{ type: "text", text: "Fixed: 15 is checked first." }] }, session_id: "s1" },
	{
		type: "result",
		subtype: "success",
		duration_ms: 9683,
		is_error: false,
		result: "Inspecting fizz.rb.\n\nFixed: 15 is checked first.",
		session_id: "s1",
		usage: { inputTokens: 10401, outputTokens: 887, cacheReadTokens: 44768, cacheWriteTokens: 0 },
	},
];

test("RunReducer: folds a real event stream; the final answer is the last full message, not .result", () => {
	const r = new RunReducer("/tmp/ws");
	// Feed in awkward chunks, splitting lines mid-JSON, with a stray non-JSON line.
	const raw = `${RUN.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`;
	let toolChanges = 0;
	for (let i = 0; i < raw.length; i += 37) if (r.feed(raw.slice(i, i + 37))) toolChanges++;
	const s = r.state;
	assert.equal(s.sessionId, "s1");
	assert.equal(s.modelName, "Composer 2.5");
	assert.equal(s.answer, "Fixed: 15 is checked first.");
	assert.deepEqual(s.tools, [{ kind: "read", summary: "read fizz.rb", ok: true }]);
	assert.equal(s.durationMs, 9683);
	assert.equal(s.cliUsage?.inputTokens, 10401);
	assert.ok(toolChanges >= 1);
});

test("RunReducer: live text tracks deltas, then the flushed segment", () => {
	const r = new RunReducer("/tmp/ws");
	r.apply(RUN[4]);
	r.apply(RUN[5]);
	assert.equal(r.state.live, "Inspecting");
	r.apply(RUN[6]);
	assert.equal(r.state.live, "Inspecting fizz.rb.");
});

test("RunReducer: falls back to .result when no final message arrives", () => {
	const r = new RunReducer("/tmp/ws");
	r.apply(RUN[0]);
	r.apply(RUN[10]);
	assert.equal(r.state.answer, RUN[10].result);
});
