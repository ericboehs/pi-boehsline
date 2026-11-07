import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";

const m = await import("../extensions/providers/index.ts");

function recorder(statuses = [200]) {
	const calls = [];
	const fetch = async (input, init) => {
		calls.push({ input, init });
		const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
		return new Response(status === 200 ? "ok" : "no", { status });
	};
	return { fetch, calls };
}

test("a string body goes zstd-compressed with Content-Encoding: zstd", async () => {
	const { fetch, calls } = recorder();
	const body = JSON.stringify({ messages: ["x".repeat(5000)] });
	const res = await m.zstdFetch(fetch, "https://a.example")("https://a.example/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
	assert.equal(res.status, 200);
	assert.equal(calls.length, 1);
	const sent = calls[0].init;
	assert.equal(new Headers(sent.headers).get("content-encoding"), "zstd");
	assert.equal(new Headers(sent.headers).get("content-type"), "application/json");
	assert.ok(sent.body instanceof Uint8Array);
	assert.ok(sent.body.length < body.length / 10);
	assert.equal(zstdDecompressSync(sent.body).toString(), body);
});

test("a 415 to the compressed body is retried plain once, and the base URL stays plain", async () => {
	m.refused.clear();
	const { fetch, calls } = recorder([415, 200]);
	const send = m.zstdFetch(fetch, "https://b.example");
	assert.equal((await send("https://b.example/v1", { body: "{}" })).status, 200);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].init.body, "{}");
	assert.equal(new Headers(calls[1].init.headers).get("content-encoding"), null);
	assert.ok(m.refused.has("https://b.example"));
	await send("https://b.example/v1", { body: "{}" });
	assert.equal(calls[2].init.body, "{}", "no second try at compression");
});

test("a 400 that the plain retry also gets is not blamed on compression", async () => {
	m.refused.clear();
	const { fetch, calls } = recorder([400, 400]);
	assert.equal((await m.zstdFetch(fetch, "https://c.example")("u", { body: "{}" })).status, 400);
	assert.equal(calls.length, 2);
	assert.equal(m.refused.has("https://c.example"), false);
});

test("non-string bodies, and a runtime without zstd, go as they are", async () => {
	const { fetch, calls } = recorder();
	const bytes = new Uint8Array([1, 2, 3]);
	await m.zstdFetch(fetch, "https://d.example")("u", { body: bytes });
	assert.equal(calls[0].init.body, bytes, "already compressed (or a stream): untouched");
	await m.zstdFetch(fetch, "https://d.example", () => null)("u", { body: "{}" });
	assert.equal(calls[1].init.body, "{}");
	assert.equal(m.zstd("{}", null), null);
});

function fakeProvider(id = "github-copilot") {
	const seen = [];
	return {
		seen,
		provider: {
			id,
			name: id,
			filterModels: (models) => models,
			stream: (model, context, options) => seen.push(["stream", model.api, options]),
			streamSimple: (model, context, options) => seen.push(["streamSimple", model.api, options]),
			classify: () => "kept",
		},
	};
}

test("withZstd gives Anthropic Messages calls a zstd fetch, and leaves other APIs and members alone", async () => {
	const { provider, seen } = fakeProvider();
	const wrapped = m.withZstd(provider);
	const inner = recorder();
	wrapped.streamSimple({ api: "anthropic-messages", baseUrl: "https://e.example" }, {}, { fetch: inner.fetch, maxTokens: 9 });
	wrapped.stream({ api: "openai-responses", baseUrl: "https://e.example" }, {}, { maxTokens: 1 });
	assert.equal(seen[0][0], "streamSimple");
	assert.equal(seen[0][2].maxTokens, 9, "the other options pass through");
	assert.notEqual(seen[0][2].fetch, inner.fetch);
	await seen[0][2].fetch("u", { body: "{}" });
	assert.equal(new Headers(inner.calls[0].init.headers).get("content-encoding"), "zstd", "and it reaches the caller's fetch");
	assert.deepEqual(seen[1], ["stream", "openai-responses", { maxTokens: 1 }]);
	assert.equal(wrapped.classify(), "kept");
});

test("disabled drops every model from availability, keeping the rest of the provider", () => {
	const { provider } = fakeProvider("amazon-bedrock");
	const off = m.disabled(provider);
	assert.deepEqual(off.filterModels([{ id: "a" }], undefined), []);
	assert.deepEqual(off.filterAllModels([{ id: "a" }], undefined), []);
	assert.equal(off.id, "amazon-bedrock");
	assert.equal(off.stream, provider.stream, "an explicit model still streams");
});

test("disabledProviders reads the settings file's list, ignoring junk", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "prov-"));
	try {
		const file = path.join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ disabledProviders: ["amazon-bedrock", 7, "../x", "baseten"] }));
		assert.deepEqual(m.disabledProviders(file), ["amazon-bedrock", "baseten"]);
		writeFileSync(file, "{nope");
		assert.deepEqual(m.disabledProviders(file), []);
		assert.deepEqual(m.disabledProviders(path.join(dir, "missing.json")), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the extension registers each disabled provider emptied, and Copilot with zstd", async () => {
	const registered = [];
	const pi = { registerProvider: (p) => registered.push(p) };
	const load = async (id) => (id === "missing" ? undefined : fakeProvider(id).provider);
	await m.default(pi, { load, disabled: ["amazon-bedrock", "missing"] });
	assert.deepEqual(registered.map((p) => p.id), ["amazon-bedrock", "github-copilot"]);
	assert.deepEqual(registered[0].filterModels([{ id: "a" }]), []);
	registered.length = 0;
	await m.default(pi, { load, disabled: ["github-copilot"] });
	assert.deepEqual(registered.map((p) => p.id), ["github-copilot"], "disabled wins: no zstd wrapper on top");
	assert.deepEqual(registered[0].filterModels([{ id: "a" }]), []);
});

test("builtin loads pi-ai's own provider by id", async () => {
	const copilot = await m.builtin("github-copilot");
	assert.equal(copilot?.id, "github-copilot");
	assert.equal(typeof copilot.streamSimple, "function");
	assert.equal(await m.builtin("no-such-provider"), undefined);
});
