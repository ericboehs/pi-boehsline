/**
 * botsun-owner: the client side of the botsun-owner v1 socket protocol.
 *
 * A temp Unix socket server stands in for Botsun; a stub pi/ctx drives the
 * extension's handlers. HOME is a temp dir, so the default socket path and the
 * agent-link registry (~/.claude/sessions) never touch the real ones.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// Device key pins (pins.ts): each test pairs fresh keys, so each starts with none.
const pinDir = join(home, "pins");
process.env.BOTSUN_OWNER_PIN_DIR = pinDir;

beforeEach(() => {
	delete process.env.PI_SUBAGENT_CHILD;
	rmSync(join(home, ".claude"), { recursive: true, force: true });
	rmSync(pinDir, { recursive: true, force: true });
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
	assert.deepEqual(srv.types(), ["hello", "session", "context", "stash"]);
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
	await until(() => srv.types().includes("context") && srv.types().includes("stash"));
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

test("the phone pushes, takes and drops the session's message stash, signed", async () => {
	const { stashStack, pushStash } = await import("../lib/stash-store.ts");
	stashStack("sid-a").length = 0;
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	m.pi.getCommands = () => [{ name: "stash", source: "extension" }];
	pushStash("sid-a", "typed at the keyboard");
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	assert.deepEqual(srv.lines.find((l) => l.type === "hello").stash.map((e) => e.text), ["typed at the keyboard"]);

	const sign = (nonce, payload) => {
		const digest = createHash("sha256").update(payload).digest("hex");
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "stash", digest].join("\n");
		return cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
	};
	const hex = (t) => createHash("sha256").update(t).digest("hex");
	let { nonce, features } = await ask({ type: "nonce" });
	assert.ok(features.includes("stash"));
	let res = await ask({ type: "stash", op: "push", text: "from the phone", nonce, device_id: 7, signature: sign(nonce, `push\n${hex("other")}`) });
	assert.equal(res.error, "signature does not verify");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "stash", op: "push", text: "from the phone", nonce, device_id: 7, signature: sign(nonce, `push\n${hex("from the phone")}`) });
	assert.equal(res.ok, true);
	await until(() => srv.lines.some((l) => l.type === "stash" && l.stash.length === 2));
	const [first, second] = stashStack("sid-a");
	assert.equal(second.text, "from the phone");

	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "stash", op: "take", id: first.id, nonce, device_id: 7, signature: sign(nonce, `take\n${first.id}`) });
	assert.deepEqual(res, { ok: true, text: "typed at the keyboard" });
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "stash", op: "drop", id: second.id, nonce, device_id: 7, signature: sign(nonce, `drop\n${second.id}`) });
	assert.deepEqual(res, { ok: true });
	assert.equal(stashStack("sid-a").length, 0);
	await until(() => srv.lines.at(-1).type === "stash" && srv.lines.at(-1).stash.length === 0);
});

test("context use goes in hello and after each run", async () => {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	let tokens = 12_000;
	const m = await mount({ ctx: { getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: (tokens / 200_000) * 100 }) } });
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	assert.deepEqual(srv.lines.find((l) => l.type === "hello").context, { tokens: 12_000, window: 200_000, percent: 6 });
	tokens = 50_000;
	await m.fire("agent_start", {});
	await m.fire("agent_settled", {});
	await until(() => srv.types().includes("context"));
	assert.deepEqual(srv.lines.find((l) => l.type === "context").context, { tokens: 50_000, window: 200_000, percent: 25 });
});

test("the footer's chips go to the phone, only the ones it shows, at most once a second", async () => {
	const { publishFooter } = await import("../lib/footer-snapshot.ts");
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	publishFooter([{ id: "dir", text: "botsun" }, { id: "model", text: "opus" }, { id: "context", text: "\x1b[32m42k\x1b[0m/1m" }]);
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => srv.types().includes("hello"));
	assert.deepEqual(srv.lines.find((l) => l.type === "hello").footer.map((c) => c.id), ["dir", "context"]);
	publishFooter([{ id: "dir", text: "botsun" }, { id: "git", text: "main*" }]);
	await until(() => srv.types().includes("footer"), 3000);
	assert.deepEqual(srv.lines.find((l) => l.type === "footer").footer.map((c) => c.id), ["dir", "git"]);
});

test("a chip tap from the phone flips the footer's display, display chips only", async () => {
	const { onFooterTap, publishFooter } = await import("../lib/footer-snapshot.ts");
	const tapped = [];
	// The footer flips the chip and repaints: the reply waits for that and carries the new row.
	const stop = onFooterTap((id) => (tapped.push(id), setTimeout(() => publishFooter([{ id: "context", text: "23%" }]), 20), true));
	await owner();
	assert.deepEqual(await ask({ type: "footer_tap", chip: "context" }), { ok: true, footer: [{ id: "context", segments: [{ text: "23%" }] }] });
	assert.equal((await ask({ type: "footer_tap", chip: "git" })).error, "that chip doesn't flip");
	assert.deepEqual(tapped, ["context"]);
	stop();
});

test("compaction: the phone hears of it, and a reply meanwhile waits for it to end", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	m.ctx.isIdle = () => true;
	await m.fire("session_before_compact", { reason: "threshold" });
	const { nonce } = await ask({ type: "nonce" });
	const text = "and then the docs";
	assert.deepEqual(await ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) }), { ok: true, delivered: "prompt" });
	assert.equal(m.sent.length, 0, "pi refuses a prompt mid-compaction");
	await m.fire("session_compact", { reason: "threshold" });
	assert.deepEqual(m.sent.at(-1), { content: text, options: undefined });
});

test("bypass: the phone hears the guardian's state, and a signed /bypass flips it", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	const asked = [];
	m.pi.events.on("approval-guardian:set-temporary-bypass", (request) => {
		asked.push(request.active);
		request.handled = true;
	});
	const say = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", text) });
	};
	assert.deepEqual(await say("/bypass on"), { ok: true, delivered: "command" });
	assert.equal((await say("/bypass maybe")).error, "say /bypass on or /bypass off");
	assert.deepEqual(asked, [true]);
	assert.equal(m.sent.length, 0, "nothing went to the model");
});

// Session voice, phase 1: a call's words are verified on arrival, held, and released by the helper.
async function heldCall() {
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	let idle = true;
	let aborts = 0;
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => aborts++;
	const wav = createHash("sha256").update("RIFF…audio").digest("hex");
	// proposal: the hash of the answer read back to him, signed with his reply; signedFor: what the
	// phone actually signed (a forged request claims one hash, signed another).
	const hold = async (text, proposal, signedFor = proposal) => {
		const { nonce } = await ask({ type: "nonce" });
		const lines = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav, ...(signedFor ? [signedFor] : [])];
		const signature = cryptoSign("sha256", Buffer.from(lines.join("\n")), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
		return ask({ type: "say_audio", text, nonce, device_id: 7, wav_sha256: wav, signature, hold: true,
			...(proposal ? { proposal_sha256: proposal } : {}) });
	};
	return { m, hold, busy: (b) => (idle = !b), aborts: () => aborts };
}

test("held call words go in only when released: queued after the turn, or steered in", async () => {
	const { m, hold, busy } = await heldCall();
	assert.ok((await ask({ type: "nonce" })).features.includes("hold"));
	const a = await hold("run the tests");
	const b = await hold("and then lint");
	assert.match(a.held, /^[0-9a-f]{12}$/);
	assert.equal(m.sent.length, 0, "held, not put in");
	busy(true);
	assert.deepEqual(await ask({ type: "release", ids: [a.held, b.held], mode: "queue" }), { ok: true, delivered: "queue" });
	assert.deepEqual(m.sent.at(-1), { content: "run the tests\n\nand then lint", options: { deliverAs: "followUp" } });
	assert.equal((await ask({ type: "release", ids: [a.held], mode: "queue" })).error, `not waiting: ${a.held}`, "each goes in once");
	const c = await hold("use the staging config");
	assert.deepEqual(await ask({ type: "release", ids: [c.held], mode: "steer" }), { ok: true, delivered: "steer" });
	assert.deepEqual(m.sent.at(-1).options, { deliverAs: "steer" });
	assert.equal((await ask({ type: "release", ids: ["nope"], mode: "sideways" })).error, "mode must be queue, steer or interrupt");
});

test("interrupt stops the run only when Eric's own words say stop", async () => {
	const { m, hold, busy, aborts } = await heldCall();
	busy(true);
	const look = await hold("look at the failing spec instead");
	assert.deepEqual(await ask({ type: "release", ids: [look.held], mode: "interrupt" }), { ok: true, delivered: "steer" });
	assert.equal(aborts(), 0, "the helper's judgment alone never aborts");
	const button = await hold("add a cancel button");
	assert.deepEqual(await ask({ type: "release", ids: [button.held], mode: "interrupt" }), { ok: true, delivered: "steer" });
	assert.equal(aborts(), 0, "mentioning cancel isn't asking to stop");
	const stop = await hold("stop, that's the wrong branch");
	assert.deepEqual(await ask({ type: "release", ids: [stop.held], mode: "interrupt" }), { ok: true, delivered: "stopped" });
	assert.equal(aborts(), 1);
	const before = m.sent.length;
	busy(false);
	await m.fire("agent_settled");
	assert.equal(m.sent.length, before + 1, "sent once the aborted run settled");
	assert.deepEqual(m.sent.at(-1), { content: "stop, that's the wrong branch", options: undefined });
});

test("the phone's Stop ends the running turn as Esc does, signed", async () => {
	const decide = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	let idle = false;
	let aborts = 0;
	m.ctx.isIdle = () => idle;
	m.ctx.abort = () => aborts++;
	const stop = async (key = decide) => {
		const { nonce, features } = await ask({ type: "nonce" });
		assert.ok(features.includes("stop"));
		const digest = createHash("sha256").update("stop", "utf8").digest("hex");
		const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "stop", digest].join("\n");
		const signature = cryptoSign("sha256", Buffer.from(msg), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
		return ask({ type: "stop", nonce, device_id: 7, signature });
	};
	assert.deepEqual(await stop(), { ok: true, stopped: true });
	assert.equal(aborts, 1);
	assert.equal((await stop(phoneKey())).error, "signature does not verify");
	assert.equal(aborts, 1, "only Eric's phone");
	idle = true;
	assert.deepEqual(await stop(), { ok: true, stopped: false }, "nothing running");
	assert.equal(aborts, 1);
	assert.equal(m.sent.length, 0);
});

test("a yes on the call answers the ask only with the read-back answer's hash, and never a no", async () => {
	const { offerPrompt, canonicalAnswer } = await import("../lib/remote-prompts.ts");
	const { m, hold } = await heldCall();
	assert.ok((await ask({ type: "nonce" })).features.includes("confirm"));
	const offered = offerPrompt([{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }]);
	const mushrooms = [{ picks: [1] }];
	const sha = createHash("sha256").update(canonicalAnswer(offered.id, mushrooms)).digest("hex");
	const other = createHash("sha256").update(canonicalAnswer(offered.id, [{ picks: [0] }])).digest("hex");
	const confirm = (id, answers = mushrooms) => ask({ type: "confirm", id, ask_id: offered.id, answers });

	const plain = await hold("yeah send it");
	assert.equal((await confirm(plain.held)).error, "his words weren't a reply to a proposal");
	assert.equal((await hold("yes", sha, other)).error, "signature does not verify", "the hash is in the signature");
	const no = await hold("no, the other one", sha);
	assert.equal((await confirm(no.held)).error, "his words say no");
	assert.equal((await confirm(no.held)).error, `not waiting: ${no.held}`, "a failed confirm spends them");
	const hmm = await hold("hmm which one is safer", sha);
	assert.equal((await confirm(hmm.held)).error, "his words don't say yes", "a misled helper can't confirm on any words");
	const wrong = await hold("yes", sha);
	assert.equal((await confirm(wrong.held, [{ picks: [0] }])).error, "his yes was for a different answer");
	const yes = await hold("yeah that's fine, send it over", sha);
	assert.deepEqual(await confirm(yes.held), { ok: true });
	assert.deepEqual(await offered.answered, mushrooms);
	assert.equal((await confirm(yes.held)).error, `not waiting: ${yes.held}`, "used once");
	assert.equal(m.sent.length, 0, "an answer, not words for the model");
	offered.dispose();
});

test("a reworded message goes in only with his signed yes to that exact text", async () => {
	const { proposalTextHash } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const { m, hold, busy } = await heldCall();
	assert.ok((await ask({ type: "nonce" })).features.includes("confirm_text"));
	const text = "Run the tests, then lint the changed files.";
	const sha = proposalTextHash(text);
	const confirm = (id, t = text, mode = "steer") => ask({ type: "confirm", id, text: t, mode });

	const swapped = await hold("yeah send it", sha);
	assert.equal((await confirm(swapped.held, "Delete the branch.")).error, "his yes was for a different message");
	const hmm = await hold("hmm", sha);
	assert.equal((await confirm(hmm.held)).error, "his words don't say yes");
	assert.equal((await confirm((await hold("sure", sha)).held, text, "interrupt")).error, "bad request", "never a stop");
	const long = "x".repeat(601);
	assert.equal((await confirm((await hold("sure", proposalTextHash(long))).held, long)).error, "bad request", "no longer than Botsun reads back");
	assert.equal(m.sent.length, 0);
	busy(true);
	const yes = await hold("yeah send it", sha);
	assert.deepEqual(await confirm(yes.held), { ok: true, delivered: "steer" });
	assert.deepEqual(m.sent.at(-1), { content: text, options: { deliverAs: "steer" } });
	const later = await hold("yep", sha);
	assert.deepEqual(await confirm(later.held, text, "queue"), { ok: true, delivered: "queue" });
	assert.deepEqual(m.sent.at(-1).options, { deliverAs: "followUp" });
	assert.notEqual(proposalTextHash("x"), createHash("sha256").update("x").digest("hex"), "its own namespace");
});

test("saysNo leans to no, and saysYes takes a short yes in so many words", async () => {
	const { saysNo, saysYes } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	for (const t of ["no", "No, the other one", "nope", "wait", "don't", "dont", "not that", "I'm not sure", "cancel it", "hold on", "never mind",
		"no problem", "actually the first one", "scratch that", "yes, no wait"]) assert.equal(saysNo(t), true, t);
	for (const t of ["yes", "yeah that's fine, send it over", "sure", "go ahead", "I know, send it", "do it"]) assert.equal(saysNo(t), false, t);
	for (const t of ["yes", "Yeah.", "yeah that's fine, send it over", "sure, send it", "go ahead", "ok do it", "that's it", "sounds good", "uh huh", "mm-hmm", "please do", "send", "yes sir", "ship it"]) {
		assert.equal(saysYes(t), true, t);
	}
	for (const t of ["hmm", "which one is safer?", "read the question again", "say yes to send it?", "yes, no wait", "I'm not sure",
		"tell it to also run the linter on the whole repo before pushing anything at all please"]) assert.equal(saysYes(t), false, t);
});

test("saysStop: stop words, not their negations or lookalikes", async () => {
	const { saysStop } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	for (const t of ["stop", "Stop!", "cancel that", "abort it", "halt", "ok stop the build", "wait, cancel that", "stop, that's the wrong branch", "make it stop", "tell it to stop"]) {
		assert.equal(saysStop(t), true, t);
	}
	for (const t of ["don't stop", "do not cancel it", "never stop", "unstoppable", "the bus stops here", "keep going", "no need to stop",
		"add a cancel button", "the halt flag is wrong", "can't stop thinking about it", "make it stop retrying the spec", "please make it stop retrying the flaky spec when the network is down"]) {
		assert.equal(saysStop(t), false, t);
	}
});

test("drop forgets the ids given; call_end forgets them all", async () => {
	const { m, hold } = await heldCall();
	const a = await hold("one");
	const b = await hold("two");
	const c = await hold("three");
	assert.deepEqual(await ask({ type: "drop", ids: [a.held] }), { ok: true });
	assert.equal((await ask({ type: "release", ids: [a.held], mode: "steer" })).error, `not waiting: ${a.held}`);
	assert.deepEqual(await ask({ type: "call_end" }), { ok: true });
	assert.match((await ask({ type: "release", ids: [b.held, c.held], mode: "steer" })).error, /^not waiting/);
	assert.equal(m.sent.length, 0);
});

test("a sensitive prompt is flagged to Botsun and refuses a spoken yes and a v1 tap, not a v2-signed tap", async () => {
	const { offerPrompt, canonicalAnswer } = await import("../lib/remote-prompts.ts");
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount();
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	const askFor = (id) => srv.lines.find((l) => l.type === "ask" && l.ask.id === id)?.ask;
	const plain = offerPrompt([{ question: "Pizza?", options: [{ label: "Pepperoni" }] }]);
	await until(() => askFor(plain.id));
	assert.equal("sensitive" in askFor(plain.id), false);
	plain.dispose();
	const offered = offerPrompt([{ question: "Allow the read?", options: [{ label: "Allow" }, { label: "Deny" }] }], { sensitive: true });
	await until(() => askFor(offered.id));
	assert.equal(askFor(offered.id).sensitive, true);

	const allow = [{ picks: [0] }];
	const sha = createHash("sha256").update(canonicalAnswer(offered.id, allow)).digest("hex");
	const wav = createHash("sha256").update("RIFF…audio").digest("hex");
	let { nonce } = await ask({ type: "nonce" });
	const spoken = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav, sha].join("\n");
	const sig = cryptoSign("sha256", Buffer.from(spoken), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
	const held = await ask({ type: "say_audio", text: "yes", nonce, device_id: 7, wav_sha256: wav, signature: sig, hold: true, proposal_sha256: sha });
	assert.ok(held.held);
	const confirm = () => ask({ type: "confirm", id: held.held, ask_id: offered.id, answers: allow });
	assert.equal((await confirm()).error, "answer this one on the phone screen or the keyboard");
	assert.equal((await confirm()).error, `not waiting: ${held.held}`, "spent");

	({ nonce } = await ask({ type: "nonce" }));
	const msg = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "answer", sha].join("\n");
	const signature = cryptoSign("sha256", Buffer.from(msg), { key: decide.privateKey, dsaEncoding: "der" }).toString("base64");
	assert.match((await ask({ type: "answer", ask_id: offered.id, answers: allow, nonce, device_id: 7, signature })).error ?? "",
		/^this one needs a v2-signed answer/, "a v1 tap doesn't bind the card's text, even before the ratchet");
	assert.equal((await ask({ type: "stop", nonce, device_id: 7, signature })).error, "nonce is expired or used", "the refusal spent the nonce");
	({ nonce } = await ask({ type: "nonce" }));
	const { canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const payload = canonicalAnswerV2(offered.id, [{ question: "Allow the read?", options: [{ label: "Allow" }, { label: "Deny" }] }], allow);
	const v2msg = ["botsun-sign-v2", "7", nonce, "answer", "sid-a", "answer", createHash("sha256").update(payload).digest("hex")].join("\n");
	const v2sig = cryptoSign("sha256", Buffer.from(v2msg), { key: decide.privateKey, dsaEncoding: "der" }).toString("base64");
	assert.deepEqual(await ask({ type: "answer", ask_id: offered.id, answers: allow, nonce, device_id: 7, sig_v: 2, signature: v2sig }), { ok: true });
	assert.deepEqual(await offered.answered, allow);
	assert.equal(m.sent.length, 0);
	offered.dispose();
});

test("every signed request type refuses alike: bad request, used nonce, unknown device, loose key file, bad signature", async () => {
	const decide = phoneKey();
	const call = phoneKey();
	const keys = (mode = 0o600) => {
		writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
		chmodSync(keysFile, mode);
	};
	keys();
	await owner();
	const bodies = {
		say: { type: "say", text: "hi" },
		say_audio: { type: "say_audio", text: "hi", wav_sha256: "a".repeat(64) },
		answer: { type: "answer", ask_id: "nope", answers: [] },
		stash: { type: "stash", op: "drop", id: "x1" },
		stop: { type: "stop" },
	};
	for (const [name, body] of Object.entries(bodies)) {
		assert.equal((await ask({ ...body, nonce: "n", device_id: "x", signature: "s" })).error, "bad request", name);
		assert.equal((await ask({ ...body, nonce: "n", device_id: 7 })).error, "bad request", `${name}: no signature`);
		assert.equal((await ask({ ...body, nonce: "unissued", device_id: 7, signature: "s" })).error, "nonce is expired or used", name);
		let { nonce } = await ask({ type: "nonce" });
		assert.equal((await ask({ ...body, nonce, device_id: 8, signature: "s" })).error, "unknown device", name);
		assert.equal((await ask({ ...body, nonce, device_id: 7, signature: "s" })).error, "nonce is expired or used", `${name}: spent on a failure`);
		({ nonce } = await ask({ type: "nonce" }));
		assert.equal((await ask({ ...body, nonce, device_id: 7, signature: "AAAA" })).error, "signature does not verify", name);
		keys(0o666);
		({ nonce } = await ask({ type: "nonce" }));
		assert.match((await ask({ ...body, nonce, device_id: 7, signature: "s" })).error, /^owner-keys\.json must be/, name);
		keys();
	}
});

// ---- Signing v2 (sig_v: 2) and device key pinning --------------------------

const sha = (s) => createHash("sha256").update(s).digest("hex");
/** A v2 signature: "botsun-sign-v2" … kind, scope (the session id), decision, sha256(payload). */
function signV2(key, nonce, kind, decision, payload, { scope = "sid-a", deviceId = "7" } = {}) {
	const msg = ["botsun-sign-v2", deviceId, nonce, kind, scope, decision, sha(payload)].join("\n");
	return cryptoSign("sha256", Buffer.from(msg, "utf8"), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");
}

async function ownerWith(ctx) {
	const srv = await server();
	process.env.BOTSUN_OWNER_SOCK = srv.path;
	const m = await mount({ ctx });
	await m.fire("session_start", { reason: "startup" });
	await until(() => existsSync(join(ownerDir, `${process.pid}.sock`)) && srv.types().includes("hello"));
	return { m, srv };
}

test("v2: the nonce reply advertises sign_v2 and ask_v2; say, stash and stop verify v2, v1 still works", async () => {
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	m.ctx.isIdle = () => false;
	m.ctx.abort = () => {};
	const { features } = await ask({ type: "nonce" });
	assert.ok(features.includes("sign_v2") && features.includes("ask_v2"));

	let { nonce } = await ask({ type: "nonce" });
	const text = "ship it";
	let res = await ask({ type: "say", text: "v1", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "v1") });
	assert.equal(res.ok, true, "v1 verifies before the device has signed v2");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "say", text) });
	assert.equal(res.error, "signature does not verify", "v2 say signs botsun-propose-text-v1\\n<text>, not the bare text");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`) });
	assert.deepEqual(res, { ok: true, delivered: "prompt" });
	assert.equal(m.sent.at(-1).content, text);

	({ nonce } = await ask({ type: "nonce" }));
	const v2sig = signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`);
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, signature: v2sig })).error, "signature does not verify", "a v2 signature isn't a v1 one");
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature: signed(key, 7, nonce, "sid-a", text) })).error,
		"signature does not verify", "nor the other way round");
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, sig_v: 3, signature: v2sig })).error, "bad request");
	({ nonce } = await ask({ type: "nonce" }));
	const other = signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`, { scope: "sid-b" });
	assert.equal((await ask({ type: "say", text, nonce, device_id: 7, sig_v: 2, signature: other })).error, "signature does not verify", "scoped to this session");
	({ nonce } = await ask({ type: "nonce" }));
	res = await ask({ type: "say", text: "v1", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "v1") });
	assert.match(res.error ?? "", /^this phone signs v2/, "v1 is refused once the device signed v2");

	({ nonce } = await ask({ type: "nonce" }));
	assert.deepEqual(await ask({ type: "stop", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stop", "stop") }), { ok: true, stopped: true });
	({ nonce } = await ask({ type: "nonce" }));
	const push = `push\n${sha("draft")}`;
	res = await ask({ type: "stash", op: "push", text: "draft", nonce, device_id: 7, sig_v: 2, signature: signV2(key, nonce, "session", "stash", push) });
	assert.equal(res.ok, true);
	assert.equal(m.sent.length, 2);
});

test("v2 answer: signed over the prompt's own questions, looked up first", async () => {
	const { offerPrompt, canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	await owner();
	const questions = [{ question: "Pizza?", options: [{ label: "Pepperoni", description: "classic" }, { label: "Mushrooms" }] }];
	const offered = offerPrompt(questions);
	const answers = [{ picks: [1] }];
	const send = async (qs, a = answers, extra = {}) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(key, nonce, "answer", "answer", canonicalAnswerV2(offered.id, qs, a));
		return ask({ type: "answer", ask_id: offered.id, answers: a, nonce, device_id: 7, sig_v: 2, signature, ...extra });
	};
	const reworded = [{ ...questions[0], question: "Delete prod?" }];
	assert.equal((await send(reworded, answers, { questions: reworded })).error, "signature does not verify", "a reworded question, even if the request carries it");
	assert.equal((await send([{ ...questions[0], options: [{ label: "Pepperoni" }, { label: "rm -rf" }] }])).error, "signature does not verify", "a swapped option");
	assert.equal((await send(questions, [{ picks: [0, 1] }])).error, "one answer for a single-choice question");
	assert.deepEqual(await send(questions), { ok: true });
	assert.deepEqual(await offered.answered, answers);
	assert.equal((await send(questions)).error, "that question was already answered");
	offered.dispose();
});

test("v2 confirm: a v2-signed yes carries the answer-v2 hash; text proposals keep their own", async () => {
	const { offerPrompt, canonicalAnswer, canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	const wav = sha("RIFF…audio");
	const hold = async (text, proposal) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(call, nonce, "session", "say_audio", [wav, proposal].join("\n"));
		return ask({ type: "say_audio", text, nonce, device_id: 7, sig_v: 2, wav_sha256: wav, signature, hold: true, proposal_sha256: proposal });
	};
	const questions = [{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }];
	const offered = offerPrompt(questions);
	const answers = [{ picks: [1] }];
	const v1 = sha(canonicalAnswer(offered.id, answers));
	const v2 = sha(canonicalAnswerV2(offered.id, questions, answers));
	const confirm = (id) => ask({ type: "confirm", id, ask_id: offered.id, answers });
	assert.equal((await confirm((await hold("yes", v1)).held)).error, "his yes was for a different answer", "a v2 utterance needs the v2 hash");
	const yes = await hold("yeah send it", v2);
	assert.ok(yes.held);
	assert.deepEqual(await confirm(yes.held), { ok: true });
	assert.deepEqual(await offered.answered, answers);
	assert.equal((await confirm((await hold("yes", v2)).held)).error, "that question was already answered");

	m.ctx.isIdle = () => true;
	const { proposalTextHash } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const said = await hold("sure", proposalTextHash("Run the tests."));
	assert.deepEqual(await ask({ type: "confirm", id: said.held, text: "Run the tests.", mode: "steer" }), { ok: true, delivered: "prompt" });
});

const { PIN_COOLDOWN_MS } = await import("../extensions/opt-in/botsun-owner/index.ts");

/** Runs fn with the clock moved on by ms (Date.now only; nonces and timeouts follow it). */
async function later(ms, fn) {
	const real = Date.now;
	Date.now = () => real() + ms;
	try { return await fn(); } finally { Date.now = real; }
}

test("device keys are pinned on first use; a changed key is refused until a keyboard yes", async () => {
	const { readFileSync, statSync } = await import("node:fs");
	const { keyFingerprint, shortFingerprint } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const first = phoneKey();
	const second = phoneKey();
	const asked = [];
	let answer = false;
	let release;
	const confirm = (title, message) => {
		asked.push({ title, message });
		return new Promise((r) => { release = () => r(answer); });
	};
	writeKeys({ 7: first.raw.toString("base64") });
	const { m } = await ownerWith({ ui: { confirm } });
	const say = async (key, text, v = 2) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = v === 2 ? signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`) : signed(key, 7, nonce, "sid-a", text);
		return ask({ type: "say", text, nonce, device_id: 7, ...(v === 2 ? { sig_v: 2 } : {}), signature });
	};
	const pins = () => JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8"));

	assert.equal(existsSync(join(pinDir, "pins.json")), false);
	assert.equal((await say(first, "one")).ok, true, "first use");
	assert.equal(pins().devices["7"].sha256, keyFingerprint(first.raw), "pinned");
	assert.equal(statSync(join(pinDir, "pins.json")).mode & 0o777, 0o600);
	assert.equal(statSync(pinDir).mode & 0o777, 0o700);
	assert.equal((await say(first, "two")).ok, true, "same key passes");

	writeKeys({ 7: second.raw.toString("base64") }); // Botsun (or whatever wrote the file) swapped the key
	assert.equal((await say(second, "three")).error, "this device's key changed: confirm at the keyboard");
	await until(() => asked.length === 1);
	assert.match(asked[0].title, /device 7/);
	assert.ok(asked[0].message.includes(shortFingerprint(keyFingerprint(first.raw))), "names the pinned key");
	assert.ok(asked[0].message.includes(shortFingerprint(keyFingerprint(second.raw))), "names the new key");
	assert.equal((await say(second, "again")).error, "this device's key changed: confirm at the keyboard");
	await sleep(20);
	assert.equal(asked.length, 1, "one dialog while it's open");
	assert.equal((await say(first, "old key")).error, "signature does not verify", "the file's key is the one checked");

	release(); // no
	await sleep(20);
	assert.equal(pins().devices["7"].sha256, keyFingerprint(first.raw), "a no keeps the pin");
	assert.equal((await say(second, "four")).error, "this device's key changed: confirm at the keyboard", "still refused");
	await sleep(20);
	assert.equal(asked.length, 1, "no dialog during the cooldown after a no");
	await later(PIN_COOLDOWN_MS + 1000, async () => {
		assert.equal((await say(second, "four")).error, "this device's key changed: confirm at the keyboard", "still refused");
		await until(() => asked.length === 2);
		answer = true;
		release(); // yes
		await until(() => pins().devices["7"].sha256 === keyFingerprint(second.raw));
		assert.equal((await say(second, "five")).ok, true, "re-pinned at the keyboard");
	});
	assert.deepEqual(m.sent.map((s) => s.content), ["one", "two", "five"]);
});

test("pins: the call key is pinned apart; a loose pin file or no keyboard refuses", async () => {
	const { readFileSync } = await import("node:fs");
	const decide = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner(); // no ctx.ui: nothing can confirm a change
	const wav = sha("RIFF…audio");
	let { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say", text: "hi", nonce, device_id: 7, signature: signed(decide, 7, nonce, "sid-a", "hi") })).ok, true);
	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, sig_v: 2, wav_sha256: wav, signature: signV2(call, nonce, "session", "say_audio", wav) })).ok, true);
	const file = JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8"));
	assert.ok(file.devices["7"] && file.call_devices["7"] && file.devices["7"].sha256 !== file.call_devices["7"].sha256);

	const swapped = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: swapped.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	assert.equal((await sayAs(swapped, 7, "x")).error, "this device's key changed: confirm at the keyboard");
	chmodSync(join(pinDir, "pins.json"), 0o644);
	assert.match((await sayAs(swapped, 7, "x")).error, /^device pins file must be/);
	assert.equal(m.sent.length, 2, "the two first-use requests only");
});

/** A v2 say from device id, signed with key; refused requests come back as {error}. */
async function sayAs(key, deviceId, text) {
	const { nonce } = await ask({ type: "nonce" });
	const signature = signV2(key, nonce, "session", "say", `botsun-propose-text-v1\n${text}`, { deviceId: String(deviceId) });
	return ask({ type: "say", text, nonce, device_id: deviceId, sig_v: 2, signature });
}

test("pins: a new device id once others are pinned is refused until a keyboard yes; a no cools down for 10 minutes", async () => {
	const { readFileSync } = await import("node:fs");
	const { keyFingerprint, shortFingerprint } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const phone = phoneKey();
	const rogue = phoneKey();
	const asked = [];
	let answer = false;
	let release;
	const confirm = (title, message) => {
		asked.push({ title, message });
		return new Promise((r) => { release = () => r(answer); });
	};
	writeKeys({ 7: phone.raw.toString("base64") });
	const { m } = await ownerWith({ ui: { confirm } });
	const pins = () => JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8"));
	assert.equal((await sayAs(phone, 7, "one")).ok, true, "the first device pins silently");
	assert.equal(asked.length, 0);

	// A compromised Botsun pairs a device of its own.
	writeKeys({ 7: phone.raw.toString("base64"), 999: rogue.raw.toString("base64") });
	assert.equal((await sayAs(rogue, 999, "rm -rf")).error, "new device: confirm at the keyboard");
	assert.equal(pins().devices["999"], undefined, "not pinned silently");
	await until(() => asked.length === 1);
	assert.match(asked[0].title, /new phone device 999/);
	assert.match(asked[0].message, /Device: 999/);
	assert.match(asked[0].message, /decision key/);
	assert.ok(asked[0].message.includes(shortFingerprint(keyFingerprint(rogue.raw))), "names its key");
	assert.equal((await sayAs(phone, 7, "two")).ok, true, "the pinned device still works meanwhile");

	release(); // no
	await sleep(20);
	assert.equal(pins().devices["999"], undefined, "a no doesn't pin");
	for (const t of ["a", "b", "c"]) assert.equal((await sayAs(rogue, 999, t)).error, "new device: confirm at the keyboard");
	await sleep(20);
	assert.equal(asked.length, 1, "no dialog during the cooldown");
	await later(PIN_COOLDOWN_MS - 5000, async () => {
		assert.equal((await sayAs(rogue, 999, "d")).error, "new device: confirm at the keyboard");
		await sleep(20);
		assert.equal(asked.length, 1, "still cooling down");
	});
	await later(PIN_COOLDOWN_MS + 1000, async () => {
		assert.equal((await sayAs(rogue, 999, "e")).error, "new device: confirm at the keyboard");
		await until(() => asked.length === 2);
		answer = true;
		release(); // yes
		await until(() => pins().devices["999"]?.sha256 === keyFingerprint(rogue.raw));
		assert.equal((await sayAs(rogue, 999, "paired")).ok, true, "pinned by the keyboard yes");
	});
	assert.deepEqual(m.sent.map((s) => s.content), ["one", "two", "paired"]);
});

test("pins: a different key on each request opens one dialog; one dialog at a time across devices", async () => {
	const asked = [];
	const confirm = (title) => { asked.push(title); return new Promise(() => {}); }; // left open
	const first = phoneKey();
	const other = phoneKey();
	writeKeys({ 7: first.raw.toString("base64"), 8: other.raw.toString("base64") });
	await ownerWith({ ui: { confirm } });
	assert.equal((await sayAs(first, 7, "one")).ok, true);
	for (let i = 0; i < 5; i++) {
		const minted = phoneKey();
		writeKeys({ 7: minted.raw.toString("base64"), 8: other.raw.toString("base64") });
		assert.equal((await sayAs(minted, 7, `minted ${i}`)).error, "this device's key changed: confirm at the keyboard");
	}
	assert.equal((await sayAs(other, 8, "new")).error, "new device: confirm at the keyboard");
	await sleep(30);
	assert.deepEqual(asked, ["Botsun: phone device 7's key changed"], "exactly one dialog");
});

test("pins: a malformed entry, a symlinked pin dir or a group-writable pin file refuses", async () => {
	const { mkdirSync: mk, symlinkSync, readFileSync } = await import("node:fs");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	assert.equal((await sayAs(key, 7, "one")).ok, true);
	const file = join(pinDir, "pins.json");
	const good = readFileSync(file, "utf8");

	const bad = JSON.parse(good);
	bad.devices["8"] = { sha256: "not-a-fingerprint" };
	writeFileSync(file, JSON.stringify(bad));
	assert.equal((await sayAs(key, 7, "x")).error, "device pins file is malformed", "not just device 8 as unpinned");
	bad.devices = [];
	writeFileSync(file, JSON.stringify(bad));
	assert.equal((await sayAs(key, 7, "x")).error, "device pins file is malformed");

	writeFileSync(file, good);
	chmodSync(file, 0o620);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins file must be/, "group-writable");
	chmodSync(file, 0o600);

	const real = join(home, "real-pins");
	rmSync(real, { recursive: true, force: true });
	mk(real, { mode: 0o700 });
	writeFileSync(join(real, "pins.json"), good, { mode: 0o600 });
	rmSync(pinDir, { recursive: true, force: true });
	symlinkSync(real, pinDir);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins dir must be/, "symlinked dir");
	rmSync(pinDir, { force: true });
	rmSync(real, { recursive: true, force: true });

	mk(pinDir, { mode: 0o700 });
	writeFileSync(join(home, "elsewhere.json"), good, { mode: 0o600 });
	symlinkSync(join(home, "elsewhere.json"), file);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins file must be/, "symlinked file");
	rmSync(file, { force: true });

	chmodSync(pinDir, 0o750);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins dir must be/, "a loose dir");
	chmodSync(pinDir, 0o700);
	assert.equal(m.sent.length, 1);
});

/**
 * Runs each body (a loop over i, with pin and ratchet imported) in a process of its own, all
 * started at once: each child imports pins.ts, says "ready" on stdout and waits; once every child
 * is ready, the parent writes "go" to each one's stdin.
 */
async function race(bodies) {
	const { spawn } = await import("node:child_process");
	const pinsTs = new URL("../extensions/opt-in/botsun-owner/pins.ts", import.meta.url).href;
	const children = bodies.map((body) => {
		const code = `import { pin, ratchet } from ${JSON.stringify(pinsTs)};
			process.stdout.write("ready\\n");
			await new Promise((go) => process.stdin.once("data", go));
			for (let i = 0; i < 40; i++) ${body};
			process.exit(0);`;
		const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, BOTSUN_OWNER_PIN_DIR: pinDir }, stdio: ["pipe", "pipe", "pipe"] });
		let err = "";
		p.stderr.on("data", (d) => { err += d; });
		const ready = new Promise((resolve, reject) => {
			let out = "";
			p.stdout.on("data", (d) => { out += d; if (out.includes("ready\n")) resolve(); });
			p.on("exit", (c) => reject(new Error(`exit ${c} before ready: ${err}`)));
		});
		const done = new Promise((resolve, reject) => {
			p.on("error", reject);
			p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}: ${err}`))));
		});
		return { p, ready, done };
	});
	await Promise.all(children.map((c) => c.ready));
	for (const c of children) c.p.stdin.write("go\n");
	await Promise.all(children.map((c) => c.done));
}

test("pins: pin() from two processes at once keeps both processes' entries", async () => {
	const { readFileSync } = await import("node:fs");
	await race([`pin("decide", "1" + i, "a".repeat(64))`, `pin("decide", "2" + i, "b".repeat(64))`]);
	const devices = JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8")).devices;
	assert.equal(Object.keys(devices).length, 80, "no lost updates");
	assert.equal(existsSync(join(pinDir, "pins.lock")), false, "the lock is let go");
});

test("pins: with decision keys pinned and no call key yet, only an already-pinned device's call key pins silently", async () => {
	const { readFileSync } = await import("node:fs");
	const decide = phoneKey();
	const call = phoneKey();
	const rogue = phoneKey();
	const asked = [];
	const confirm = (title) => { asked.push(title); return new Promise(() => {}); }; // left open
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") }, call_devices: {} }));
	chmodSync(keysFile, 0o600);
	const { m } = await ownerWith({ ui: { confirm } });
	assert.equal((await sayAs(decide, 7, "one")).ok, true, "the first pairing pins silently");
	const pins = () => JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8"));
	assert.deepEqual(pins().call_devices, {}, "Eric never called");

	// A compromised Botsun adds a call key under a device id of its own.
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: decide.raw.toString("base64") },
		call_devices: { 7: call.raw.toString("base64"), 999: rogue.raw.toString("base64") } }));
	const wav = sha("RIFF…audio");
	const callAs = async (key, deviceId, text) => {
		const { nonce } = await ask({ type: "nonce" });
		const signature = signV2(key, nonce, "session", "say_audio", wav, { deviceId: String(deviceId) });
		return ask({ type: "say_audio", text, nonce, device_id: deviceId, sig_v: 2, wav_sha256: wav, signature });
	};
	assert.equal((await callAs(rogue, 999, "injected")).error, "new device: confirm at the keyboard");
	assert.equal(pins().call_devices["999"], undefined, "not pinned silently");
	await until(() => asked.length === 1);
	assert.match(asked[0], /new phone device 999 \(call key\)/);
	assert.equal((await callAs(call, 7, "hi")).ok, true, "device 7's first call key pins silently");
	assert.ok(pins().call_devices["7"], "pinned");
	assert.deepEqual(m.sent.map((s) => s.content), ["one", "hi"]);
});

test("pins: a stale lock is taken over; a held lock refuses after the wait; a fresh lock moved aside is put back", async () => {
	const { readFileSync, utimesSync, mkdirSync: mk } = await import("node:fs");
	const { breakStaleLock, LOCK_STALE_MS } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	const m = await owner();
	mk(pinDir, { mode: 0o700 });
	const lock = join(pinDir, "pins.lock");
	writeFileSync(lock, "12345 someone\n", { mode: 0o600 });
	assert.equal((await sayAs(key, 7, "held")).error, "couldn't record the device's key pin", "a held lock refuses, never opens");
	assert.equal(existsSync(join(pinDir, "pins.json")), false);
	assert.equal(readFileSync(lock, "utf8"), "12345 someone\n", "the holder's lock is left alone");

	const old = (Date.now() - LOCK_STALE_MS - 5000) / 1000;
	utimesSync(lock, old, old); // its writer crashed
	assert.equal((await sayAs(key, 7, "stale")).ok, true, "a stale lock is broken");
	assert.equal(existsSync(lock), false, "and the new one let go");
	assert.deepEqual(m.sent.map((s) => s.content), ["stale"]);

	// Two waiters judged the same stale lock; the other broke it and took a fresh one meanwhile.
	writeFileSync(lock, "222 fresh\n", { mode: 0o600 });
	assert.equal(breakStaleLock(lock, "111 stale\n"), false, "another lock than the one judged: back off");
	assert.equal(readFileSync(lock, "utf8"), "222 fresh\n", "put back");
	assert.equal(breakStaleLock(lock, "222 fresh\n"), false, "the same lock, but fresh: back off");
	assert.equal(readFileSync(lock, "utf8"), "222 fresh\n", "put back");
	utimesSync(lock, old, old);
	assert.equal(breakStaleLock(lock, "222 fresh\n"), true, "the stale lock judged");
	assert.equal(existsSync(lock), false);
	assert.deepEqual(readdirSync(pinDir).filter((f) => f.includes("stale")), [], "nothing left aside");
});

test("pins: after any no, no pin dialog for 2 minutes; at most 3 pin dialogs per 10 minutes", async () => {
	const { PIN_QUIET_MS, PIN_DIALOG_WINDOW_MS } = await import("../extensions/opt-in/botsun-owner/index.ts");
	const keys = Object.fromEntries([7, 8, 9, 10, 11].map((id) => [id, phoneKey()]));
	const asked = [];
	const answers = [];
	const confirm = (title) => { asked.push(title); return new Promise((r) => answers.push(r)); };
	writeKeys(Object.fromEntries(Object.entries(keys).map(([id, k]) => [id, k.raw.toString("base64")])));
	await ownerWith({ ui: { confirm } });
	assert.equal((await sayAs(keys[7], 7, "one")).ok, true);
	const newDevice = "new device: confirm at the keyboard";

	assert.equal((await sayAs(keys[8], 8, "x")).error, newDevice);
	await until(() => asked.length === 1);
	answers[0](false); // no
	await sleep(20);
	assert.equal((await sayAs(keys[9], 9, "x")).error, newDevice);
	await sleep(20);
	assert.equal(asked.length, 1, "another device gets no dialog right after a no");
	await later(PIN_QUIET_MS - 5000, async () => {
		assert.equal((await sayAs(keys[9], 9, "x")).error, newDevice);
		await sleep(20);
		assert.equal(asked.length, 1, "still quiet");
	});
	await later(PIN_QUIET_MS + 1000, async () => {
		assert.equal((await sayAs(keys[9], 9, "x")).error, newDevice);
		await until(() => asked.length === 2);
		answers[1](true);
		await sleep(20);
		assert.equal((await sayAs(keys[10], 10, "x")).error, newDevice);
		await until(() => asked.length === 3);
		answers[2](true);
		await sleep(20);
		assert.equal((await sayAs(keys[11], 11, "x")).error, newDevice);
		await sleep(20);
		assert.equal(asked.length, 3, "a fourth dialog in 10 minutes is refused without one");
	});
	await later(PIN_DIALOG_WINDOW_MS + 1000, async () => {
		assert.equal((await sayAs(keys[11], 11, "x")).error, newDevice);
		await until(() => asked.length === 4);
	});
	assert.deepEqual(asked.slice(1, 4), ["Botsun: new phone device 9 (key)", "Botsun: new phone device 10 (key)", "Botsun: new phone device 11 (key)"]);
});

test("v2 answer refused before the signature check still spends the nonce", async () => {
	const { offerPrompt, canonicalAnswerV2 } = await import("../lib/remote-prompts.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	await owner();
	const questions = [{ question: "Pizza?", options: [{ label: "Pepperoni" }, { label: "Mushrooms" }] }];
	const offered = offerPrompt(questions);
	const answers = [{ picks: [1] }];
	const signedAnswer = (nonce) => signV2(key, nonce, "answer", "answer", canonicalAnswerV2(offered.id, questions, answers));

	let { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "answer", ask_id: "gone", answers, nonce, device_id: 7, sig_v: 2, signature: "x" })).error,
		"that question was already answered");
	assert.equal((await ask({ type: "answer", ask_id: offered.id, answers, nonce, device_id: 7, sig_v: 2, signature: signedAnswer(nonce) })).error,
		"nonce is expired or used", "a gone prompt spends it");

	({ nonce } = await ask({ type: "nonce" }));
	assert.equal((await ask({ type: "answer", ask_id: offered.id, answers: [{ picks: [0, 1] }], nonce, device_id: 7, sig_v: 2, signature: "x" })).error,
		"one answer for a single-choice question");
	assert.equal((await ask({ type: "answer", ask_id: offered.id, answers, nonce, device_id: 7, sig_v: 2, signature: signedAnswer(nonce) })).error,
		"nonce is expired or used", "an invalid answer spends it");

	({ nonce } = await ask({ type: "nonce" }));
	assert.deepEqual(await ask({ type: "answer", ask_id: offered.id, answers, nonce, device_id: 7, sig_v: 2, signature: signedAnswer(nonce) }), { ok: true });
	offered.dispose();
});

// ---- The v2 ratchet (sign-versions.json) ------------------------------------

const signVersionsFile = () => join(pinDir, "sign-versions.json");
const readSignVersions = async () => JSON.parse((await import("node:fs")).readFileSync(signVersionsFile(), "utf8")).sign_versions;

test("ratchet: after a device's first v2, its v1 (either key) is refused; an un-ratcheted device's v1 still works", async () => {
	const { readFileSync, statSync } = await import("node:fs");
	const { keyFingerprint, pin } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const a = phoneKey();
	const b = phoneKey();
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: { 7: a.raw.toString("base64"), 8: b.raw.toString("base64") }, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	pin("decide", "7", keyFingerprint(a.raw));
	pin("decide", "8", keyFingerprint(b.raw));
	pin("call", "7", keyFingerprint(call.raw));
	const m = await owner();
	const v1 = async (key, deviceId, text) => {
		const { nonce } = await ask({ type: "nonce" });
		return ask({ type: "say", text, nonce, device_id: deviceId, signature: signed(key, deviceId, nonce, "sid-a", text) });
	};
	assert.equal((await v1(a, 7, "v1 before")).ok, true);
	assert.equal(existsSync(signVersionsFile()), false, "v1 doesn't ratchet");
	assert.equal((await sayAs(a, 7, "v2")).ok, true);
	assert.equal((await readSignVersions())["7"].sign_version, 2, "recorded in sign-versions.json");
	assert.equal(statSync(signVersionsFile()).mode & 0o777, 0o600);
	assert.equal(JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8")).sign_versions, undefined, "not in pins.json");
	assert.equal((await v1(a, 7, "downgrade")).error, "this phone signs v2: v1 is refused (update Botsun and the app)");
	assert.equal((await v1(b, 8, "other device")).ok, true, "device 8 never signed v2");
	const wav = sha("RIFF…audio");
	const { nonce } = await ask({ type: "nonce" });
	const spoken = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav].join("\n");
	const sig = cryptoSign("sha256", Buffer.from(spoken), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
	assert.match((await ask({ type: "say_audio", text: "hi", nonce, device_id: 7, wav_sha256: wav, signature: sig })).error, /^this phone signs v2/,
		"the call key shares the device's ratchet");
	assert.deepEqual(m.sent.map((s) => s.content), ["v1 before", "v2", "other device"]);
});

test("ratchet: survives a reload and an old session's pins.json rewrite; a malformed or loose file refuses", async () => {
	const { readFileSync } = await import("node:fs");
	const { pin, signVersionOf } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	await owner();
	assert.equal((await sayAs(key, 7, "v2")).ok, true);
	await cleanups.pop()(); // quit this session
	pin("decide", "9", "c".repeat(64)); // another write of pins.json
	// A session still on the pins.ts from before the ratchet rewrites pins.json with only what it knows.
	const pinsFile = join(pinDir, "pins.json");
	const { devices, call_devices } = JSON.parse(readFileSync(pinsFile, "utf8"));
	writeFileSync(pinsFile, JSON.stringify({ version: 1, devices, call_devices }));
	assert.equal(signVersionOf("7"), 2);
	await owner(); // a fresh instance (reload/restart) reads it back
	const { nonce } = await ask({ type: "nonce" });
	assert.match((await ask({ type: "say", text: "x", nonce, device_id: 7, signature: signed(key, 7, nonce, "sid-a", "x") })).error, /^this phone signs v2/);
	const file = signVersionsFile();
	const raw = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...raw, sign_versions: { 7: { sign_version: 1 } } }));
	assert.equal((await sayAs(key, 7, "x")).error, "device pins sign-versions file is malformed", "not a quiet un-ratchet");
	writeFileSync(file, "{");
	const { nonce: n2 } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say", text: "x", nonce: n2, device_id: 7, signature: signed(key, 7, n2, "sid-a", "x") })).error,
		"device pins sign-versions file is malformed", "v1 too");
	writeFileSync(file, JSON.stringify(raw));
	chmodSync(file, 0o644);
	assert.match((await sayAs(key, 7, "x")).error, /^device pins sign-versions file must be a regular 0600 file/);
});

test("ratchet: pin() and ratchet() from three processes at once keep every pin and ratchet", async () => {
	const { readFileSync } = await import("node:fs");
	await race([`pin("decide", "p" + i, "a".repeat(64))`, `ratchet("r" + i)`, `ratchet("s" + i)`]);
	assert.equal(Object.keys(JSON.parse(readFileSync(join(pinDir, "pins.json"), "utf8")).devices).length, 40, "every pin");
	assert.equal(Object.keys(await readSignVersions()).length, 80, "every ratchet");
	assert.equal(existsSync(join(pinDir, "pins.lock")), false);
});

test("ratchet: a v2 request from a new device (once one is pinned) is refused and ratchets nothing", async () => {
	const a = phoneKey();
	const rogue = phoneKey();
	const asked = [];
	const confirm = (title) => { asked.push(title); return new Promise(() => {}); }; // left open
	writeKeys({ 7: a.raw.toString("base64") });
	const { m } = await ownerWith({ ui: { confirm } });
	const { nonce } = await ask({ type: "nonce" });
	assert.equal((await ask({ type: "say", text: "v1 first", nonce, device_id: 7, signature: signed(a, 7, nonce, "sid-a", "v1 first") })).ok, true,
		"the first pairing (v1: no ratchet)");
	writeKeys({ 7: a.raw.toString("base64"), 9: rogue.raw.toString("base64") });
	assert.equal((await sayAs(rogue, 9, "injected")).error, "new device: confirm at the keyboard");
	await until(() => asked.length === 1);
	assert.equal(existsSync(signVersionsFile()), false, "no ratchet for an unpinned device");
	assert.deepEqual(m.sent.map((s) => s.content), ["v1 first"]);
});

test("ratchet: a ratchet that can't be recorded refuses the v2 request (a held lock, a failed write)", async () => {
	const fs = (await import("node:fs")).default;
	const { syncBuiltinESMExports } = await import("node:module");
	const { keyFingerprint, pin } = await import("../extensions/opt-in/botsun-owner/pins.ts");
	const key = phoneKey();
	writeKeys({ 7: key.raw.toString("base64") });
	pin("decide", "7", keyFingerprint(key.raw)); // pinned already: the pin check needs no lock
	const m = await owner();
	const lock = join(pinDir, "pins.lock");
	writeFileSync(lock, "12345 someone\n", { mode: 0o600 });
	assert.equal((await sayAs(key, 7, "locked")).error, "couldn't record the device's signing version", "past the lock wait");
	assert.equal(existsSync(signVersionsFile()), false);
	rmSync(lock);

	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (String(to).endsWith("sign-versions.json")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		return rename(from, to);
	};
	syncBuiltinESMExports();
	try {
		assert.equal((await sayAs(key, 7, "unwritable")).error, "couldn't record the device's signing version", "a write that fails");
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
	assert.equal(existsSync(signVersionsFile()), false);
	assert.deepEqual(readdirSync(pinDir).filter((f) => f.endsWith(".tmp")), [], "the temp file is cleaned up");
	assert.equal((await sayAs(key, 7, "ok")).ok, true);
	assert.deepEqual(m.sent.map((s) => s.content), ["ok"]);
});

test("ratchet: a v1 reply held before the device's first v2 can't be confirmed after it", async () => {
	const call = phoneKey();
	writeFileSync(keysFile, JSON.stringify({ devices: {}, call_devices: { 7: call.raw.toString("base64") } }));
	chmodSync(keysFile, 0o600);
	const m = await owner();
	m.ctx.isIdle = () => true;
	const { proposalTextHash } = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const wav = sha("RIFF…audio");
	const proposal = proposalTextHash("Run the tests.");
	const holdV1 = async (text) => {
		const { nonce } = await ask({ type: "nonce" });
		const lines = ["botsun-decide-v1", "7", nonce, "session", "sid-a", "say_audio", wav, proposal];
		const signature = cryptoSign("sha256", Buffer.from(lines.join("\n")), { key: call.privateKey, dsaEncoding: "der" }).toString("base64");
		return ask({ type: "say_audio", text, nonce, device_id: 7, wav_sha256: wav, signature, hold: true, proposal_sha256: proposal });
	};
	const confirm = (id) => ask({ type: "confirm", id, text: "Run the tests.", mode: "steer" });
	const before = await holdV1("yes");
	const stale = await holdV1("yeah do it");
	assert.ok(before.held && stale.held);
	assert.deepEqual(await confirm(before.held), { ok: true, delivered: "prompt" }, "before the ratchet, a v1 yes counts");

	const { nonce } = await ask({ type: "nonce" });
	const signature = signV2(call, nonce, "session", "say_audio", wav);
	assert.equal((await ask({ type: "say_audio", text: "hello", nonce, device_id: 7, sig_v: 2, wav_sha256: wav, signature })).ok, true, "device 7 signs v2");
	assert.equal((await readSignVersions())["7"].sign_version, 2);
	assert.equal((await confirm(stale.held)).error, "this phone signs v2: v1 is refused (update Botsun and the app)");
	assert.equal((await confirm(stale.held)).error, `not waiting: ${stale.held}`, "spent");
});
