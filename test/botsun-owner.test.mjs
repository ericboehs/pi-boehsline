/**
 * botsun-owner: the client side of the botsun-owner v1 socket protocol.
 *
 * A temp Unix socket server stands in for Botsun; a stub pi/ctx drives the
 * extension's handlers. HOME is a temp dir, so the default socket path and the
 * agent-link registry (~/.claude/sessions) never touch the real ones.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { stubPi } from "./helpers/stub-pi.mjs";

const home = mkdtempSync(join(tmpdir(), "botsun-owner-"));
process.env.HOME = home;
process.env.BOEHSLINE_CONFIG = join(home, "boehsline.json");
process.env.BOTSUN_OWNER_RETRY_MS = "50";
delete process.env.BOTSUN_OWNER_DEBUG;
after(() => rmSync(home, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 2000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await sleep(10);
	}
	assert.fail("timed out waiting");
}

const cleanups = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()();
});

let n = 0;
/** A server on a fresh socket path that records parsed lines. */
async function server(path = join(home, `s${++n}.sock`)) {
	const lines = [];
	const conns = new Set();
	const srv = createServer((c) => {
		conns.add(c);
		let buf = "";
		c.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				lines.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		c.on("close", () => conns.delete(c));
	});
	await new Promise((r) => srv.listen(path, r));
	const stop = () => new Promise((r) => { for (const c of conns) c.destroy(); srv.close(() => r()); });
	cleanups.push(() => srv.listening && stop());
	return { path, lines, conns, stop, types: () => lines.map((l) => l.type) };
}

async function mount({ ctx: over = {}, sessionName } = {}) {
	process.env.BOEHSLINE_ENABLE = "botsun-owner";
	const mod = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const s = stubPi();
	s.pi.getSessionName = () => sessionName;
	await mod.default(s.pi);
	const ctx = {
		cwd: "/tmp/work/proj",
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionFile: () => "/tmp/sessions/a.jsonl", getSessionId: () => "sid-a" },
		...over,
	};
	const fire = (event, payload = {}, c = ctx) => s.fire(event, payload, c);
	// A failed assertion must not leave a connection retrying past the test.
	cleanups.push(() => fire("session_shutdown", { reason: "quit" }));
	return { ...s, ctx, fire };
}

beforeEach(() => {
	delete process.env.PI_SUBAGENT_CHILD;
	rmSync(join(home, ".claude"), { recursive: true, force: true });
});

test("hello on connect, then busy/idle/prompt/prompt_end/bye", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	const hello = srv.lines[0];
	assert.equal(hello.type, "hello");
	assert.equal(hello.v, 1);
	assert.equal(hello.pid, process.pid);
	assert.match(hello.at, /^\d{4}-\d\d-\d\dT.*Z$/);
	assert.equal(hello.name, "proj", "falls back to basename(cwd)");
	assert.equal(hello.cwd, "/tmp/work/proj");
	assert.equal(hello.session_file, "/tmp/sessions/a.jsonl");
	assert.equal(hello.session_id, "sid-a");
	assert.equal(hello.busy, false);
	assert.equal(hello.prompt, null);

	await m.fire("agent_start");
	await m.fire("ui_prompt_start", { reason: "ui_prompt", kind: "select", title: "x".repeat(900) });
	await m.fire("ui_prompt_end", { reason: "ui_prompt" });
	await m.fire("agent_settled");
	await m.fire("session_shutdown", { reason: "quit" });
	await until(() => srv.lines.length >= 6);
	assert.deepEqual(srv.types(), ["hello", "busy", "prompt", "prompt_end", "idle", "bye"]);
	assert.equal(srv.lines[2].kind, "select");
	assert.equal(srv.lines[2].title.length, 500);
	await until(() => srv.conns.size === 0);
	await srv.stop();
});

test("name: agent-link registry, else pi session name; re-read per line", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ sessionName: "my-session" });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	assert.equal(srv.lines[0].name, "my-session");
	mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
	writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "vic" }));
	await m.fire("agent_start");
	writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), "{\"name\": \"par"); // partial write
	await m.fire("agent_settled");
	await until(() => srv.lines.length >= 3);
	assert.equal(srv.lines[1].name, "vic");
	assert.equal(srv.lines[2].name, "my-session", "a torn registry file falls back");
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

test("reconnect resends hello with the current state", async () => {
	let srv = await server();
	const path = srv.path;
	process.env.BOTSUN_OWNER_SOCK = path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	await srv.stop();
	// While disconnected: state changes are tracked, not sent.
	await m.fire("agent_start");
	await m.fire("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Proceed?" });
	srv = await server(path);
	await until(() => srv.lines.length >= 1);
	assert.equal(srv.lines[0].type, "hello");
	assert.equal(srv.lines[0].busy, true);
	assert.deepEqual(srv.lines[0].prompt, { kind: "confirm", title: "Proceed?" });
	await m.fire("session_shutdown", { reason: "quit" });
	await srv.stop();
});

test("session change keeps the connection and sends a session line", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const a = await mount();
	await a.fire("session_start", { reason: "startup" });
	await until(() => srv.lines.length >= 1);
	await a.fire("session_shutdown", { reason: "new" });
	const b = await mount({
		ctx: { sessionManager: { getSessionFile: () => "/tmp/sessions/b.jsonl", getSessionId: () => "sid-b" } },
	});
	await b.fire("session_start", { reason: "new" });
	await until(() => srv.lines.length >= 2);
	assert.deepEqual(srv.types(), ["hello", "session"]);
	assert.equal(srv.lines[1].session_file, "/tmp/sessions/b.jsonl");
	assert.equal(srv.lines[1].session_id, "sid-b");
	assert.equal(srv.lines[1].cwd, "/tmp/work/proj");
	assert.equal(srv.conns.size, 1, "same connection");
	await b.fire("session_shutdown", { reason: "quit" });
	await until(() => srv.types().includes("bye"));
	await srv.stop();
});

test("subagent children and sessions without a TUI send nothing", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;

	process.env.PI_SUBAGENT_CHILD = "1";
	const child = await mount();
	assert.deepEqual(child.names(), [], "a subagent child registers nothing");
	delete process.env.PI_SUBAGENT_CHILD;

	for (const over of [{ hasUI: false, mode: "print" }, { hasUI: true, mode: "rpc" }, { hasUI: false, mode: "json" }]) {
		const m = await mount({ ctx: over });
		await m.fire("session_start", { reason: "startup" });
		await m.fire("agent_start");
		await m.fire("ui_prompt_start", { reason: "ui_prompt", kind: "input", title: "" });
		await m.fire("session_shutdown", { reason: "quit" });
	}
	await sleep(150);
	assert.equal(srv.lines.length, 0);
	assert.equal(srv.conns.size, 0);
	await srv.stop();
});

test("a missing socket doesn't throw, retries quietly, and stops on shutdown", async () => {
	const path = join(home, `missing${++n}.sock`);
	process.env.BOTSUN_OWNER_SOCK = path;
	const count = () => process.getActiveResourcesInfo().filter((r) => r === "PipeWrap" || r === "Timeout").length;
	const before = count();
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await m.fire("agent_start");
	await sleep(200); // a few retries at the 50ms test backoff
	await m.fire("session_shutdown", { reason: "quit" });
	await sleep(20);
	assert.ok(count() <= before, "no sockets or ref'd timers left behind");
	// Botsun coming up after shutdown must not get a connection.
	const srv = await server(path);
	await sleep(400);
	assert.equal(srv.lines.length, 0);
	assert.equal(srv.conns.size, 0);
});

test("the default path is under HOME/.local/state/botsun", async () => {
	delete process.env.BOTSUN_OWNER_SOCK;
	process.env.BOEHSLINE_ENABLE = "botsun-owner";
	const { sockPath } = await import(`../extensions/opt-in/botsun-owner/index.ts?p=${Math.random()}`);
	assert.equal(sockPath(), join(home, ".local", "state", "botsun", "owner.sock"));
});

// ---- T2: reply as Eric over the session's own owner socket ----------------

import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createConnection } from "node:net";

const ownerDir = join(home, "owner");
const keysFile = join(home, "owner-keys.json");
process.env.BOTSUN_OWNER_DIR = ownerDir;
process.env.BOTSUN_OWNER_KEYS = keysFile;

function phoneKey() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-65); // the uncompressed point
	return { privateKey, raw };
}

function writeKeys(devices, mode = 0o600) {
	writeFileSync(keysFile, JSON.stringify({ devices }));
	chmodSync(keysFile, mode);
}

function signed(key, deviceId, nonce, sessionId, text) {
	const digest = createHash("sha256").update(text, "utf8").digest("hex");
	const msg = ["botsun-decide-v1", String(deviceId), nonce, "session", sessionId, "say", digest].join("\n");
	return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
}

function ask(req) {
	return new Promise((resolve, reject) => {
		const c = createConnection(join(ownerDir, `${process.pid}.sock`));
		let buf = "";
		c.on("data", (d) => { buf += d; });
		c.on("end", () => resolve(JSON.parse(buf)));
		c.on("error", reject);
		c.write(`${JSON.stringify(req)}\n`);
	});
}

async function owner() {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	return m;
}

test("a signed reply goes in as Eric's message; the nonce is single use", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const { nonce, session_id } = await ask({ type: "nonce" });
	assert.equal(session_id, "sid-a");
	assert.ok((await ask({ type: "nonce" })).features.includes("images"));
	const text = "Approved: run the migration";
	const signature = signed(key, 7, nonce, "sid-a", text);
	assert.deepEqual(await ask({ type: "say", text, nonce, device_id: 7, signature }), { ok: true, delivered: "prompt" });
	assert.deepEqual(m.sent.at(-1), { content: text, options: undefined });
	const again = await ask({ type: "say", text, nonce, device_id: 7, signature });
	assert.equal(again.error, "nonce is expired or used");
	assert.equal(m.sent.length, 1);
});

test("while busy the reply steers into the running turn", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	await m.fire("agent_start");
	const { nonce } = await ask({ type: "nonce" });
	const text = "stop and run the tests first";
	const res = await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	assert.equal(res.delivered, "steer");
	assert.deepEqual(m.sent.at(-1).options, { deliverAs: "steer" });
});

test("wrong key, wrong session, changed text, unknown device and a loose key file are refused", async () => {
	const key = phoneKey();
	const other = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const tries = [
		["other device's key", (n) => ({ text: "hi", device_id: 7, signature: signed(other, 7, n, "sid-a", "hi") })],
		["signed for another session", (n) => ({ text: "hi", device_id: 7, signature: signed(key, 7, n, "sid-b", "hi") })],
		["text changed after signing", (n) => ({ text: "rm -rf", device_id: 7, signature: signed(key, 7, n, "sid-a", "hi") })],
		["unknown device", (n) => ({ text: "hi", device_id: 8, signature: signed(key, 8, n, "sid-a", "hi") })],
	];
	for (const [why, build] of tries) {
		const { nonce } = await ask({ type: "nonce" });
		const res = await ask({ type: "say", nonce, ...build(nonce) });
		assert.ok(res.error, why);
	}
	writeKeys({ 7: key.raw.toString("base64") }, 0o666);
	const { nonce } = await ask({ type: "nonce" });
	const res = await ask({ type: "say", text: "hi", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "hi") });
	assert.match(res.error, /only Eric can write/);
	assert.equal(m.sent.length, 0, "nothing reached the session");
});

test("the owner socket is 0600 and goes away on quit", async () => {
	const m = await owner();
	const path = join(ownerDir, `${process.pid}.sock`);
	const { statSync } = await import("node:fs");
	await until(() => (statSync(path).mode & 0o777) === 0o600);
	await m.fire("session_shutdown", { reason: "quit" });
	await until(() => !existsSync(path));
});

test("/reload over a connection from the T1 extension upgrades it in place", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const first = await mount();
	await first.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	// What a T1-era instance left on globalThis: no nonce map, no owner socket.
	const conn = globalThis[Symbol.for("botsun-owner.v1")];
	conn.server.close();
	rmSync(join(ownerDir, `${process.pid}.sock`), { force: true });
	delete conn.server;
	delete conn.nonces;
	delete conn.inject;
	await first.fire("session_shutdown", { reason: "reload" });
	const second = await mount();
	await second.fire("session_start", { reason: "reload" }); // threw "reading 'clear'" before the fix
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	const { nonce } = await ask({ type: "nonce" });
	assert.ok(nonce, "the upgraded session takes replies");
});

test("assistant text streams (throttled) and ends with stream_end", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const msg = (text) => ({ message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text }] } });
	await m.fire("message_update", msg("Now"));
	await m.fire("message_update", msg("Now checking"));
	await m.fire("message_update", { message: { role: "user", content: "ignored" } });
	await until(() => srv.types().includes("stream"));
	await sleep(300);
	const streams = srv.lines.filter((l) => l.type === "stream");
	assert.equal(streams.at(-1).text, "Now checking", "the latest text, thinking left out");
	assert.ok(streams.length <= 2, "throttled");
	await m.fire("message_end", msg("Now checking the logs."));
	await until(() => srv.types().includes("stream_end"));
});

function signedImages(key, deviceId, nonce, sessionId, text, images) {
	const hex = (b) => createHash("sha256").update(b).digest("hex");
	const digest = hex([hex(Buffer.from(text, "utf8")), ...images.map((i) => hex(Buffer.from(i.data, "base64")))].join("\n"));
	const msg = ["botsun-decide-v1", String(deviceId), nonce, "session", sessionId, "say_images", digest].join("\n");
	return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
}

test("a reply with photos goes in as text + image blocks, bound to those exact photos", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const photo = { data: Buffer.from("fake jpeg bytes").toString("base64"), mime_type: "image/jpeg" };
	const other = { data: Buffer.from("another photo").toString("base64"), mime_type: "image/jpeg" };
	let { nonce } = await ask({ type: "nonce" });
	let res = await ask({ type: "say", text: "what's this error?", images: [photo], nonce, device_id: 7,
		signature: signedImages(key, 7, nonce, "sid-a", "what's this error?", [photo]) });
	assert.deepEqual(res, { ok: true, delivered: "prompt" });
	assert.deepEqual(m.sent.at(-1).content, [
		{ type: "text", text: "what's this error?" },
		{ type: "image", data: photo.data, mimeType: "image/jpeg" },
	]);

	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "hi", images: [other], nonce, device_id: 7, signature: signedImages(key, 7, nonce, "sid-a", "hi", [photo]) });
	assert.equal(res.error, "signature does not verify", "a swapped photo");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "hi", images: [photo], nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "hi") });
	assert.equal(res.error, "signature does not verify", "a text-only signature with a photo added");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "", images: [photo], nonce, device_id: 7, signature: signedImages(key, 7, nonce, "sid-a", "", [photo]) });
	assert.equal(res.ok, true, "a photo alone is fine");
	assert.deepEqual(m.sent.at(-1).content, [{ type: "image", data: photo.data, mimeType: "image/jpeg" }]);
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "x", images: [{ data: photo.data, mime_type: "application/pdf" }], nonce, device_id: 7, signature: "AA==" });
	assert.match(res.error, /JPEG/);
	assert.equal(m.sent.length, 2);
});

test("a call's utterance is checked against the phone's call key and its audio hash", async () => {
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	const wav = createHash("sha256").update("RIFF…audio").digest("hex");
	const sig = (key, nonce, hash = wav) => cryptoSign("sha256",
		Buffer.from(["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", hash].join("\n")), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	let { nonce } = await ask({ type: "nonce" });
	let res = await ask({ type: "say_audio", text: "what's the status", nonce, device_id: 7, wav_sha256: wav, signature: sig(call, nonce) });
	assert.deepEqual(res, { ok: true, delivered: "prompt" });
	assert.equal(m.sent.at(-1).content, "what's the status");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, wav_sha256: wav, signature: sig(decide, nonce) });
	assert.equal(res.error, "signature does not verify", "the decision key isn't the call key");
	({ nonce } = await ask({ type: "nonce" }));
	const other = createHash("sha256").update("other audio").digest("hex");
	res = await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, wav_sha256: other, signature: sig(call, nonce) });
	assert.equal(res.error, "signature does not verify", "signed for different audio");
	assert.equal(m.sent.length, 1);
});

test("attached files are saved for the agent, named in the message, and bound by the signature", async () => {
	const { readFileSync, statSync } = await import("node:fs");
	process.env.BOTSUN_OWNER_INBOX = join(home, "inbox");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const hex = (b) => createHash("sha256").update(b).digest("hex");
	const file = { name: "report.csv", data: Buffer.from("a,b\n1,2\n").toString("base64") };
	const sign = (nonce, text, files) => {
		const digest = hex([hex(Buffer.from(text, "utf8")), ...files.map((f) => `file ${hex(Buffer.from(f.name, "utf8"))} ${hex(Buffer.from(f.data, "base64"))}`)].join("\n"));
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_attach", digest].join("\n");
		return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	};
	let { nonce } = await ask({ type: "nonce" });
	const renamed = { ...file, name: "evil.sh" };
	let res = await ask({ type: "say", text: "look", files: [renamed], nonce, device_id: 7, signature: sign(nonce, "look", [file]) });
	assert.equal(res.error, "signature does not verify", "a renamed file");

	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "look", files: [file], nonce, device_id: 7, signature: sign(nonce, "look", [file]) });
	assert.equal(res.ok, true);
	const said = m.sent.at(-1).content;
	const path = said.match(/📎 Attached: (\S+) \(8 B\)/)[1];
	assert.ok(said.startsWith("look\n\n📎 Attached: "));
	assert.equal(readFileSync(path, "utf8"), "a,b\n1,2\n");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.ok(path.startsWith(join(home, "inbox", String(process.pid))));

	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "x", files: [{ name: "../up.txt", data: "" }], nonce, device_id: 7, signature: "AA==" });
	assert.equal(res.error, "bad file name");
	assert.equal(m.sent.length, 1);
});

test("the model and thinking level go in hello and follow /model", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ ctx: { model: { provider: "github-copilot", id: "claude-opus-5.5", name: "Claude Opus 5.5" }, thinkingLevel: "medium" } });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	assert.deepEqual(srv.lines[0].model, { name: "Claude Opus 5.5", provider: "github-copilot", id: "claude-opus-5.5", thinking: "medium" });
	await m.fire("model_select", { model: { provider: "anthropic", id: "claude-haiku-5.5", name: "Claude Haiku 5.5" } });
	await until(() => srv.types().includes("model"));
	assert.equal(srv.lines.find((l) => l.type === "model").model.name, "Claude Haiku 5.5");
});

test("an open ask question goes to Botsun and takes a signed answer from the phone", async () => {
	const { offerPrompt, canonicalAnswer } = await import("../lib/remote-prompts.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	const offered = offerPrompt([{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }]);
	await until(() => srv.types().includes("ask"));
	const line = srv.lines.find((l) => l.type === "ask");
	assert.equal(line.ask.id, offered.id);
	assert.equal(line.ask.questions[0].options[1].label, "Mushrooms");

	const sign = (nonce, answers, id = offered.id) => {
		const digest = createHash("sha256").update(canonicalAnswer(id, answers)).digest("hex");
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "answer", digest].join("\n");
		return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	};
	let { nonce } = await ask({ type: "nonce" });
	let res = await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [0] }], nonce, device_id: 7, signature: sign(nonce, [{ picks: [1] }]) });
	assert.equal(res.error, "signature does not verify", "a different pick than signed");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [1] }], nonce, device_id: 7, signature: sign(nonce, [{ picks: [1] }]) });
	assert.deepEqual(res, { ok: true });
	assert.deepEqual(await offered.answered, [{ picks: [1] }]);
	await until(() => srv.types().includes("ask_end"));
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [1] }], nonce, device_id: 7, signature: sign(nonce, [{ picks: [1] }]) });
	assert.equal(res.error, "that question was already answered");
	offered.dispose();
});

test("slashCommand and findModel", async () => {
	const { slashCommand, findModel } = await import("../extensions/opt-in/botsun-owner/index.ts");
	assert.deepEqual(slashCommand("/compact keep the plan"), { name: "compact", args: "keep the plan" });
	assert.deepEqual(slashCommand(" /review "), { name: "review", args: "" });
	assert.equal(slashCommand("/Users/eric/notes.md"), null, "a path is not a command");
	assert.equal(slashCommand("hello /compact"), null);
	const models = [
		{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
		{ provider: "github-copilot", id: "claude-opus-5", name: "Claude Opus 5" },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
	];
	assert.equal(findModel(models, "haiku").id, "claude-haiku-4-5");
	assert.equal(findModel(models, "github-copilot/claude-opus-5").provider, "github-copilot");
	assert.match(findModel(models, "opus"), /matches 2 models/);
	assert.match(findModel(models, "gpt"), /no model matches/);
});

test("slash commands from the phone run instead of reaching the model", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const ran = [];
	const m = await mount({ ctx: {
		compact: (o) => ran.push(["compact", o.customInstructions]),
		modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] },
		ui: { notify: () => {} },
	} });
	m.pi.setModel = async (model) => { ran.push(["model", model.id]); return true; };
	m.pi.setThinkingLevel = (level) => ran.push(["thinking", level]);
	m.pi.setSessionName = (name) => ran.push(["name", name]);
	m.pi.getCommands = () => [{ name: "review", source: "extension" }];
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)));
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	};
	assert.deepEqual(await say("/compact keep the plan"), { ok: true, delivered: "command" });
	assert.deepEqual(await say("/model haiku"), { ok: true, delivered: "command" });
	assert.deepEqual(await say("/thinking high"), { ok: true, delivered: "command" });
	assert.deepEqual(await say("/name billing fix"), { ok: true, delivered: "command" });
	await until(() => ran.length === 4);
	assert.deepEqual(ran, [["compact", "keep the plan"], ["model", "claude-haiku-4-5"], ["thinking", "high"], ["name", "billing fix"]]);
	assert.equal(m.sent.length, 0, "none of them reached the model");

	assert.equal((await say("/model")).error, "say which model, e.g. /model opus (the picker needs the keyboard)");
	assert.equal((await say("/reload")).error, "/reload only works at the keyboard");
	assert.deepEqual(await say("/review src/a.ts"), { ok: true, delivered: "command" });
	assert.deepEqual(m.sent.at(-1), { content: "/review src/a.ts", options: { expandPromptTemplates: true } });
	assert.deepEqual(await say("/Users/eric/a.md is the file"), { ok: true, delivered: "prompt" }, "a path goes in as text");
	assert.deepEqual(await say("/whatever"), { ok: true, delivered: "prompt" }, "unknown commands go in as typed");

	await m.fire("agent_start", {});
	assert.equal((await say("/compact")).error, "wait for the turn to finish before /compact");
	assert.equal((await say("/review")).error, "wait for the turn to finish before /review");
});

test("hello lists the commands the phone can run; a reload sends the list again", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	m.pi.getCommands = () => [
		{ name: "review", description: "Review a diff", source: "extension" },
		{ name: "skill:lint", source: "skill" },
		{ name: "reload", source: "extension" }, // a built-in name: never listed
	];
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const names = srv.lines.find((l) => l.type === "hello").commands.map((c) => c.name);
	assert.deepEqual(names, ["compact", "model", "thinking", "name", "review", "skill:lint"]);
	m.pi.getCommands = () => [{ name: "deploy", source: "prompt" }];
	await m.fire("session_start", { reason: "reload" });
	await until(() => srv.types().includes("commands"));
	assert.deepEqual(srv.lines.find((l) => l.type === "commands").commands.map((c) => c.name).slice(4), ["deploy"]);
});

test("hello carries the model id and the models the phone's picker offers", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ ctx: {
		model: { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
		modelRegistry: { getAvailable: () => [
			{ provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true },
			{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
		] },
	} });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	const hello = srv.lines.find((l) => l.type === "hello");
	assert.equal(hello.model.id, "claude-opus-5-5");
	assert.deepEqual(hello.models.map((x) => [x.id, x.reasoning]), [["claude-opus-5-5", true], ["claude-haiku-4-5", false]]);
});
