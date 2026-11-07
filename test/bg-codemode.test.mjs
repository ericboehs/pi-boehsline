import assert from "node:assert/strict";
import test from "node:test";

const { registerBgCodemode, codemodeRunner, withTimeout, CUSTOM_TYPE, DEFAULT_TIMEOUT_MS, RESULT_MAX_CHARS } = await import(
	"../extensions/bg/codemode.ts"
);
const TIMEOUT_LINE = `// @options: {"timeout_ms":${DEFAULT_TIMEOUT_MS}}\n`;

/** A codemode runner whose scripts settle only when the test says so. */
function deferredRunner() {
	const calls = [];
	const runner = (code, toolCallId, signal, ctx) =>
		new Promise((resolve, reject) => {
			calls.push({ name: "codemode", args: { code }, toolCallId, signal, ctx, resolve, reject });
		});
	return { runner, calls };
}

function mount() {
	const tools = new Map();
	const handlers = new Map();
	const sent = [];
	const pi = {
		registerTool: (definition) => tools.set(definition.name, definition),
		on: (name, handler) => handlers.set(name, handler),
		sendMessage: (message, options) => sent.push({ message, options }),
	};
	let clock = 1_000_000;
	const { runner, calls } = deferredRunner();
	const api = registerBgCodemode(pi, { now: () => clock, runner });
	const ctx = { executeTool: async () => assert.fail("the runner, not executeTool, starts the script") };
	return { tool: tools.get("codemode_bg"), handlers, sent, api, calls, ctx, tick: (ms) => (clock += ms) };
}


const flush = () => new Promise((resolve) => setImmediate(resolve));

test("returns before the script ends, then delivers its result as one waking message", async () => {
	const { tool, sent, api, tick, ctx, calls } = mount();
	const callerAbort = new AbortController();
	const res = await tool.execute("call-1", { code: "return 42", name: "answer" }, callerAbort.signal, undefined, ctx);
	assert.match(res.content[0].text, /^codemode_bg [0-9a-f]{6} started/);
	assert.equal(sent.length, 0, "nothing delivered while the script runs");
	await flush();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "codemode");
	assert.deepEqual(calls[0].args, { code: `${TIMEOUT_LINE}return 42` }, "a default timeout frees the worker of a hung run");
	assert.equal(calls[0].toolCallId, "call-1");
	assert.equal(calls[0].ctx, ctx, "the script's tools.* go through this call's ctx");
	// The run has its own signal: ending or interrupting the calling turn does not cancel it.
	assert.notEqual(calls[0].signal, callerAbort.signal);
	callerAbort.abort();
	assert.equal(calls[0].signal.aborted, false);
	assert.equal(api.runs.size, 1);

	tick(125_000);
	// codemode's execute() returns a bare tool result, not executeTool's {result} wrapper.
	calls[0].resolve({ content: [{ type: "text", text: "Script completed\n42" }], details: {} });
	await flush();
	assert.equal(sent.length, 1);
	const { message, options } = sent[0];
	assert.equal(message.customType, CUSTOM_TYPE);
	assert.match(message.content, /`answer` succeeded after 2m05s\nScript completed\n42$/);
	assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(api.runs.size, 0);
});

test("a failed script and a rejected call both report failed", async () => {
	const { tool, sent, ctx, calls } = mount();
	await tool.execute("c", { code: "throw 1" }, undefined, undefined, ctx);
	await flush();
	calls[0].resolve({ content: [{ type: "text", text: "Script failed" }], isError: true });
	await flush();
	await tool.execute("c", { code: "x" }, undefined, undefined, ctx);
	await flush();
	calls[1].reject(new Error("boom"));
	await flush();
	assert.equal(sent.length, 2);
	assert.match(sent[0].message.content, /failed after .*\nScript failed/);
	assert.match(sent[1].message.content, /failed after .*\nboom/);
	assert.equal(sent[1].message.details.failed, true);
});

test("stop aborts the run's own signal and reports stopped", async () => {
	const { tool, sent, ctx, calls } = mount();
	const res = await tool.execute("c", { code: "await never()" }, undefined, undefined, ctx);
	const id = res.content[0].text.split(" ")[1];
	await flush();
	const stop = await tool.execute("c2", { stop: id }, undefined, undefined, ctx);
	assert.match(stop.content[0].text, /stopping/);
	assert.equal(calls[0].signal.aborted, true);
	calls[0].resolve({ result: { content: [{ type: "text", text: "Script failed: aborted" }] }, isError: true });
	await flush();
	assert.match(sent[0].message.content, /stopped after/);
	const again = await tool.execute("c3", { stop: id }, undefined, undefined, ctx);
	assert.equal(again.isError, true);
});

test("session shutdown aborts runs and delivers nothing afterwards", async () => {
	const { tool, sent, handlers, ctx, calls } = mount();
	await tool.execute("c", { code: "1" }, undefined, undefined, ctx);
	await flush();
	const notes = [];
	await handlers.get("session_shutdown")({}, { hasUI: true, ui: { notify: (text) => notes.push(text) } });
	assert.match(notes[0] ?? "", /stopped with the session/, "the model gets no result, so the person is told");
	assert.equal(calls[0].signal.aborted, true);
	calls[0].resolve({ result: { content: [{ type: "text", text: "late" }] } });
	await flush();
	assert.equal(sent.length, 0);
});

test("refuses without code or without executeTool", async () => {
	const { tool, ctx, calls } = mount();
	assert.equal((await tool.execute("c", { code: "  " }, undefined, undefined, ctx)).isError, true);
	assert.equal((await tool.execute("c", { code: "1" }, undefined, undefined, {})).isError, true);
	assert.equal(calls.length, 0);
});

test("the real runner is codemode's own definition, built from the exported factory", async () => {
	const { codemodeRunner } = await import("../extensions/bg/codemode.ts");
	const pi = {
		registerTool: () => assert.fail("codemode must not be registered in the session"),
		appendEntry: () => {},
		getAllTools: () => [],
		getSettings: () => ({}),
	};
	const runner = codemodeRunner(pi);
	assert.equal(typeof runner.run, "function");
	assert.deepEqual(runner.reach({ code: "await tools.mcp__docs__search({})" }).includes("mcp__docs__search"), true);
});

test("codemode_bg names the tools its script reaches, so pi waits for their MCP servers", () => {
	const tools = new Map();
	const pi = {
		registerTool: (d) => tools.set(d.name, d),
		on: () => {},
		sendMessage: () => {},
		appendEntry: () => assert.fail("no session writes from a background script"),
		getAllTools: () => [],
		getSettings: () => ({}),
	};
	registerBgCodemode(pi);
	const reach = tools.get("codemode_bg").reachesTools;
	assert.ok(reach({ code: "await tools.mcp__jira__get({})" }).includes("mcp__jira__get"));
	assert.equal(reach({ code: "await searchTools('x')" }), "all");
});

test("the captured definition's session writes (store()) are dropped", async () => {
	const writes = [];
	const pi = { appendEntry: (...args) => writes.push(args), getSettings: () => ({}) };
	// A stand-in for codemode's factory: its execute() writes a store entry, as a script's store() does.
	const factory = (api) =>
		api.registerTool({
			name: "codemode",
			execute: async () => {
				api.appendEntry("codemode-store", { k: 1 });
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
	const runner = codemodeRunner(pi, factory);
	const out = await runner.run("store('k', 1)", "id", new AbortController().signal, {});
	assert.equal(out.content[0].text, "ok");
	assert.deepEqual(writes, [], "no write lands in whatever session is current when the script ends");
	assert.equal(typeof pi.appendEntry, "function", "the real API is untouched");
});

test("one run at a time: a second start is refused while the first runs", async () => {
	const { tool, ctx, calls } = mount();
	await tool.execute("c", { code: "1" }, undefined, undefined, ctx);
	const second = await tool.execute("c", { code: "2" }, undefined, undefined, ctx);
	assert.equal(second.isError, true);
	assert.match(second.content[0].text, /still running/);
	await flush();
	assert.equal(calls.length, 1);
	calls[0].resolve({ content: [{ type: "text", text: "ok" }] });
	await flush();
	assert.equal((await tool.execute("c", { code: "3" }, undefined, undefined, ctx)).isError, undefined);
});

test("withTimeout adds timeout_ms unless the script sets one", () => {
	assert.equal(withTimeout("return 1", 5), '// @options: {"timeout_ms":5}\nreturn 1');
	assert.equal(withTimeout('// @options: {"max_output_tokens": 9}\nreturn 1', 5), '// @options: {"max_output_tokens":9,"timeout_ms":5}\nreturn 1');
	const own = '// @options: {"timeout_ms": 60000}\nreturn 1';
	assert.equal(withTimeout(own, 5), own);
	const bad = "// @options: {nope\nreturn 1";
	assert.equal(withTimeout(bad, 5), bad, "codemode reports a bad options line itself");
});

test("a long result is capped, keeping its start and end", async () => {
	const { tool, sent, ctx, calls } = mount();
	await tool.execute("c", { code: "1" }, undefined, undefined, ctx);
	await flush();
	calls[0].resolve({ result: { content: [{ type: "text", text: `HEAD${"x".repeat(RESULT_MAX_CHARS * 2)}TAIL` }] } });
	await flush();
	const text = sent[0].message.content;
	assert.ok(text.length < RESULT_MAX_CHARS + 300);
	assert.match(text, /HEAD/);
	assert.match(text, /TAIL$/);
	assert.match(text, /chars omitted/);
});
