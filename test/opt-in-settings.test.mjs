import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

process.env.BOEHSLINE_CONFIG = join(mkdtempSync(join(tmpdir(), "boehsline-")), "none.json");
process.env.BOEHSLINE_ENABLE = "wiki-session-log";
const { registerSource, sources } = await import("../lib/config.ts");
const wiki = await import("../extensions/opt-in/wiki-session-log/index.ts");

beforeEach(() => sources().clear());

test("wiki-session-log: no command configured, nothing runs", () => {
	assert.deepEqual(wiki.syncCommand(), []);
});

test("wiki-session-log: command from settings, ~ expands, string form splits", () => {
	registerSource("me", { "wiki-session-log": { command: ["~/bin/pi-session-sync", "--quiet"] } });
	assert.deepEqual(wiki.syncCommand(), [join(homedir(), "bin/pi-session-sync"), "--quiet"]);
	registerSource("me", { "wiki-session-log": { command: "sync-notes  --fast" } });
	assert.deepEqual(wiki.syncCommand(), ["sync-notes", "--fast"]);
});

test("wiki-session-log: runs the command with the session file after a settled turn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wsl-"));
	const out = join(dir, "args.txt");
	const bin = join(dir, "sync");
	writeFileSync(bin, `#!/bin/sh\necho "$@" > ${out}\n`);
	chmodSync(bin, 0o755);
	registerSource("me", { "wiki-session-log": { command: [bin, "--flag"] } });

	const handlers = new Map();
	const pi = { on: (n, h) => handlers.set(n, h) };
	await wiki.default(pi);
	const ctx = { sessionManager: { getSessionFile: () => "/tmp/session.jsonl" } };
	handlers.get("session_start")({}, ctx);
	handlers.get("agent_settled")({}, ctx);
	// The shell's `>` creates the file before echo writes it, so wait for the line, not the file;
	// and give a loaded machine up to 10 s to spawn the command at all.
	const line = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
	for (let i = 0; i < 500 && !line().endsWith("\n"); i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(line().trim(), "--flag /tmp/session.jsonl");
});
