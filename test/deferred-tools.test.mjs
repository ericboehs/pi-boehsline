/**
 * Deferred tools (exposure: "deferred") are reachable only through tool_search,
 * so tool_search has to be active. subagent used to be the only extension that
 * turned it on; with subagent off, every other deferred tool went dark.
 *
 * This loads every extension in the manifest except subagent, finds the tools
 * registered as deferred, runs the session_start handlers against a stub pi,
 * and checks tool_search ends up active. New extensions are covered as they're
 * added to the manifest.
 */
import assert from "node:assert/strict";
import { globSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// agent-link registers a peer and binds a socket under HOME on session_start;
// keep that (and any config) out of the real home.
const home = mkdtempSync(join(tmpdir(), "deferred-tools-"));
process.env.HOME = home;
process.env.XDG_CACHE_HOME = join(home, ".cache");
process.env.BOEHSLINE_CONFIG = join(home, "boehsline.json");
// Opt-in deferred tools are only registered when enabled; turn them on so
// they are checked too.
process.env.BOEHSLINE_ENABLE = "scheduler-tool";
delete process.env.PI_SUBAGENT_CHILD;

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pi.extensions;
const entries = manifest.flatMap((pattern) => globSync(pattern, { cwd: root })).sort();

/** A pi stub: records tools and handlers, and keeps an active-tool list. */
function stubPi() {
	const tools = [];
	const handlers = new Map();
	let active = ["read", "bash", "edit", "write"];
	const pi = new Proxy(
		{},
		{
			get(_, key) {
				switch (key) {
					case "registerTool":
						return (tool) => tools.push(tool);
					case "on":
						return (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]);
					case "getActiveTools":
						return () => [...active];
					case "setActiveTools":
						return (names) => {
							active = [...names];
						};
					case "getAllTools":
						return () => [{ name: "tool_search" }, ...tools.map((t) => ({ name: t.name }))];
					case "getCommands":
						return () => [];
					case "getSessionName":
						return () => undefined;
					case "events":
						return { on: () => () => {}, emit: () => {} };
					case "exec":
						return async () => ({ stdout: "", stderr: "", code: 1 });
					default:
						return () => {};
				}
			},
		},
	);
	const ctx = {
		cwd: home,
		hasUI: false,
		mode: "print",
		isIdle: () => true,
		sessionManager: { getSessionId: () => "deferred-tools-test", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
		ui: new Proxy({}, { get: () => () => {} }),
		modelRegistry: { getAvailable: () => [], getProviderAuth: async () => undefined },
	};
	const fire = async (event) => {
		for (const fn of handlers.get(event) ?? []) await fn({ type: event }, ctx);
	};
	return { pi, tools, fire, active: () => active };
}

async function load(entry, s) {
	const mod = await import(`${join(root, entry)}?t=${Math.random()}`);
	await mod.default(s.pi);
}

const withoutSubagent = entries.filter((e) => !e.includes("/subagent/"));

test("the manifest still has deferred tools outside subagent (or this test is moot)", async () => {
	const s = stubPi();
	for (const entry of withoutSubagent) await load(entry, s);
	const deferred = s.tools.filter((t) => t.exposure === "deferred").map((t) => t.name);
	assert.ok(deferred.length >= 3, `deferred tools: ${deferred.join(", ")}`);
	await s.fire("session_shutdown");
});

test("with subagent off, tool_search is active, so every deferred tool is reachable", async () => {
	const s = stubPi();
	for (const entry of withoutSubagent) await load(entry, s);
	await s.fire("session_start");
	assert.ok(s.active().includes("tool_search"), `active: ${s.active().join(", ")}`);
	await s.fire("session_shutdown");
});

test("each extension with a deferred tool turns tool_search on by itself", async () => {
	for (const entry of entries) {
		const s = stubPi();
		await load(entry, s);
		const deferred = s.tools.filter((t) => t.exposure === "deferred");
		if (deferred.length === 0) continue;
		await s.fire("session_start");
		assert.ok(s.active().includes("tool_search"), `${entry} defers ${deferred.map((t) => t.name).join(", ")} but leaves tool_search off`);
		await s.fire("session_shutdown");
	}
});

test("child subagents stay lean: no tool_search", async () => {
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		const s = stubPi();
		for (const entry of entries.filter((e) => /provider-usage|goal/.test(e))) await load(entry, s);
		await s.fire("session_start");
		assert.ok(!s.active().includes("tool_search"));
	} finally {
		delete process.env.PI_SUBAGENT_CHILD;
	}
});
