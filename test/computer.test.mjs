/**
 * extensions/computer: the `computer` tool, its CDP-over-a-Unix-socket client,
 * the minimal WebSocket in ws.ts, and the desk CLI parsing/keep-alive in desk.ts.
 *
 * Nothing here calls Botsun or a VM: a scripted `net.createServer` on a temp
 * Unix socket stands in for Botsun's CDP tunnel (HTTP `/json/list` plus a fake
 * CDP WebSocket), and the CLI runner is injected.
 *
 *   node scripts/test.mjs -- test/computer.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { stubPi } from "./helpers/stub-pi.mjs";

const { acceptFor, encodeFrame, FrameDecoder, OP_CONTINUATION, OP_PING, OP_PONG, OP_TEXT, WsClient } = await import(
	"../extensions/computer/ws.ts"
);
const { KeepAlive, openDesk, parseDeskOutput, releaseDesk, validCdpSocket } = await import("../extensions/computer/desk.ts");
const { capBytes, evaluate, keySpec, openCdp, screenshot, EVAL_BYTES } = await import("../extensions/computer/cdp.ts");
const { computerExtension } = await import("../extensions/computer/index.ts");

const root = mkdtempSync("/tmp/pi-computer-");
after(() => rmSync(root, { recursive: true, force: true }));

/** A 1×1 PNG, base64: the fake CDP's Page.captureScreenshot answer. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let n = 0;
const sockPath = (name = `s${++n}`) => path.join(root, `${name}.cdp.sock`);

/** Split a frame's bytes into two writes, so a decoder must hold a partial frame. */
function splitFrame(frame) {
	const mid = Math.max(1, Math.floor(frame.length / 2));
	return [frame.subarray(0, mid), frame.subarray(mid)];
}

/**
 * A scripted WebSocket server on a Unix socket: answers the handshake, decodes
 * client (masked) frames into `received`, and lets `script` send unmasked frames.
 */
function wsServer(sock, script = {}) {
	const received = [];
	const server = createServer((conn) => {
		let buf = Buffer.alloc(0);
		let handshook = false;
		const decoder = new FrameDecoder();
		const handle = (frame) => {
			received.push(frame);
			script.onFrame?.(frame, send(conn));
		};
		conn.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (!handshook) {
				const end = buf.indexOf("\r\n\r\n");
				if (end < 0) return;
				const head = buf.subarray(0, end).toString("latin1");
				const rest = buf.subarray(end + 4);
				buf = Buffer.alloc(0);
				handshook = true;
				const key = /sec-websocket-key:\s*(.*)/i.exec(head)?.[1]?.trim() ?? "";
				conn.write(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`,
				);
				script.onOpen?.(send(conn));
				if (rest.length) for (const frame of decoder.push(rest)) handle(frame);
				return;
			}
			for (const frame of decoder.push(buf)) handle(frame);
			buf = Buffer.alloc(0);
		});
	});
	return new Promise((resolve) => server.listen(sock, () => resolve({ server, received, close: () => new Promise((done) => server.close(done)) })));
}

/** `send` for a scripted server: unmasked, any opcode. */
const send = (conn) => (payload, options = {}) => conn.write(encodeFrame(payload, { mask: false, ...options }));

/**
 * A fake CDP tunnel: HTTP `/json/list` and `/json/new?` plus the page
 * WebSocket. Every CDP call is recorded in `calls`.
 */
function fakeCdp(sock) {
	const calls = [];
	const server = createServer((conn) => {
		let buf = Buffer.alloc(0);
		conn.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			const end = buf.indexOf("\r\n\r\n");
			if (end < 0) return;
			const head = buf.subarray(0, end).toString("latin1");
			const rest = buf.subarray(end + 4);
			conn.removeAllListeners("data");
			const [line] = head.split("\r\n");
			const [method, target] = line.split(" ");
			const headers = new Map(
				head
					.split("\r\n")
					.slice(1)
					.map((row) => {
						const colon = row.indexOf(":");
						return [row.slice(0, colon).trim().toLowerCase(), row.slice(colon + 1).trim()];
					}),
			);
			if (String(headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
				conn.write(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(headers.get("sec-websocket-key") ?? "")}\r\n\r\n`,
				);
				const decoder = new FrameDecoder();
				const frames = (data) => {
					for (const frame of decoder.push(data)) {
						if (frame.opcode !== OP_TEXT) continue;
						const msg = JSON.parse(frame.payload.toString("utf8"));
						calls.push(msg);
						const answer = (result) => conn.write(encodeFrame(JSON.stringify({ id: msg.id, result }), { mask: false }));
						if (msg.method === "Page.captureScreenshot") answer({ data: PNG });
						else if (msg.method === "Runtime.evaluate") answer({ result: { type: "string", value: `echo:${msg.params.expression}` } });
						else answer({});
					}
				};
				if (rest.length) frames(rest);
				conn.on("data", frames);
				return;
			}
			const target_ = target ?? "";
			const body =
				method === "PUT" && target_.startsWith("/json/new")
					? JSON.stringify(page("NEW1", "about:blank"))
					: JSON.stringify([page("PAGE1", "https://example.com"), { id: "OTHER", type: "service_worker", title: "", url: "" }]);
			conn.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
		});
	});
	return new Promise((resolve) => server.listen(sock, () => resolve({ server, calls, close: () => new Promise((done) => server.close(done)) })));
}

const page = (id, url) => ({ id, type: "page", title: `title ${id}`, url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` });

/** The next message on a WsClient, or a timeout failure. */
const bodyOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("a client text frame is masked, and unmasking it gives the text back", () => {
	const frame = encodeFrame("hi");
	assert.equal(frame[0], 0x81, "FIN + text opcode");
	assert.equal(frame[1], 0x80 | 2, "mask bit + length");
	const key = frame.subarray(2, 6);
	const masked = frame.subarray(6);
	const plain = Buffer.from([...masked].map((b, i) => b ^ key[i % 4]));
	assert.equal(plain.toString("utf8"), "hi");
});

test("the decoder reads 7-, 16- and 64-bit lengths, and holds a frame split across chunks", () => {
	const decoder = new FrameDecoder();
	for (const size of [5, 200, 70_000]) {
		const payload = Buffer.alloc(size, 0x61);
		const frame = encodeFrame(payload, { mask: false });
		const [first, second] = splitFrame(frame);
		assert.deepEqual(decoder.push(first), [], "a partial frame waits");
		const frames = decoder.push(second);
		assert.equal(frames.length, 1);
		assert.equal(frames[0].opcode, OP_TEXT);
		assert.ok(frames[0].payload.equals(payload), `${size} bytes round-trip`);
	}
});

test("a fragmented text message arrives whole, and a ping is answered with its payload", async () => {
	const sock = sockPath("frag");
	let pongSeen;
	const pong = new Promise((resolve) => (pongSeen = resolve));
	const srv = await wsServer(sock, {
		onOpen(emit) {
			emit("hel", { opcode: OP_TEXT, fin: false });
			emit("lo", { opcode: OP_CONTINUATION, fin: true });
			emit("pi", { opcode: OP_PING });
		},
		onFrame(frame, emit) {
			if (frame.opcode === OP_PONG) pongSeen(frame.payload.toString("utf8"));
			void emit;
		},
	});
	try {
		const messages = [];
		const ws = await WsClient.connect({ socketPath: sock, path: "/devtools/page/PAGE1", onMessage: (m) => messages.push(m) });
		assert.equal(await pong, "pi");
		for (let i = 0; i < 50 && messages.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(messages, ["hello"]);
		assert.ok(srv.received.some((f) => f.opcode === OP_PONG), "the pong went back over the socket");
		ws.close();
	} finally {
		await srv.close();
	}
});

test("a new message inside a fragmented one closes the connection with an error", async () => {
	const sock = sockPath("interleave");
	const srv = await wsServer(sock, {
		onOpen(emit) {
			emit("hel", { opcode: OP_TEXT, fin: false });
			emit("oops", { opcode: OP_TEXT, fin: true });
		},
		onFrame() {},
	});
	try {
		const messages = [];
		let closed;
		const done = new Promise((resolve) => (closed = resolve));
		await WsClient.connect({ socketPath: sock, path: "/devtools/page/PAGE1", onMessage: (m) => messages.push(m), onClose: (err) => closed(err) });
		const err = await done;
		assert.match(String(err?.message), /inside a fragmented/);
		assert.deepEqual(messages, [], "neither half is delivered");
	} finally {
		await srv.close();
	}
});

test("CDP over the socket: /json/list pages only, navigate, screenshot, eval", async () => {
	const sock = sockPath("cdp");
	const fake = await fakeCdp(sock);
	try {
		const client = await openCdp(sock);
		try {
			assert.equal(await screenshot(client), PNG);
			assert.equal(await evaluate(client, "1+1"), '"echo:1+1"');
			await client.send("Page.navigate", { url: "https://example.com/" });
		} finally {
			client.close();
		}
		assert.deepEqual(
			fake.calls.map((c) => c.method),
			["Page.captureScreenshot", "Runtime.evaluate", "Page.navigate"],
		);
		assert.equal(fake.calls[2].params.url, "https://example.com/");
	} finally {
		await fake.close();
	}
});

test("eval results are capped at 8 KB, and key names are checked", () => {
	const big = "x".repeat(EVAL_BYTES * 2);
	const capped = capBytes(big);
	assert.ok(Buffer.byteLength(capped) <= EVAL_BYTES + 40, "under the cap plus its note");
	assert.match(capped, /bytes more/);
	assert.equal(keySpec("Enter").key, "Enter");
	assert.equal(keySpec("arrowleft").key, "ArrowLeft");
	assert.equal(keySpec("nope"), null);
});

test("desk JSON parsing and cdp_socket validation", () => {
	const line = parseDeskOutput(`some noise\n{"desk_id":"d-1","display":3,"vnc_socket":"/tmp/v","cdp_socket":"/tmp/c.cdp.sock"}`);
	assert.equal(line.desk_id, "d-1");
	assert.equal(line.display, 3);
	assert.equal(parseDeskOutput("not json"), null);
	assert.equal(parseDeskOutput(""), null);

	const home = path.join(root, "home");
	mkdirSync(home, { recursive: true });
	assert.equal(validCdpSocket(path.join(home, "desk-botsun-workers-3.cdp.sock"), home), path.join(home, "desk-botsun-workers-3.cdp.sock"));
	assert.equal(validCdpSocket("/tmp/desk.cdp.sock", home), null, "outside home");
	assert.equal(validCdpSocket("desk.cdp.sock", home), null, "not absolute");
	assert.equal(validCdpSocket(path.join(home, "desk.sock"), home), null, "wrong suffix");
	assert.equal(validCdpSocket(`${home}/../escape.cdp.sock`, home), null, "escaping home");
	assert.equal(validCdpSocket(undefined, home), null);
});

test("the desk CLI's one JSON line is read, and a bad socket is refused", async () => {
	const home = path.join(root, "home2");
	mkdirSync(home, { recursive: true });
	const good = { desk_id: "d-2", display: 4, vnc_socket: path.join(home, "vnc.sock"), cdp_socket: path.join(home, "desk.cdp.sock") };
	const calls = [];
	const run = async (cmd, args) => {
		calls.push([cmd, ...args]);
		return args.includes("--release") ? JSON.stringify({ desk_id: "d-2", display: 4, released: true }) : `noise\n${JSON.stringify(good)}`;
	};
	const opened = await openDesk("sess-1", { bin: "/fake/botsun", run, home });
	assert.equal(opened.desk.display, "4");
	assert.equal(opened.desk.cdpSocket, good.cdp_socket);
	assert.deepEqual(calls[0], ["/fake/botsun", "desk", "session", "--session", "sess-1"]);

	const bad = await openDesk("sess-1", { bin: "/fake/botsun", home, run: async () => JSON.stringify({ display: 4, cdp_socket: "/tmp/x.cdp.sock" }) });
	assert.match(bad.error, /no usable cdp_socket/);
	const released = await releaseDesk("sess-1", { bin: "/fake/botsun", run, home });
	assert.deepEqual(released, { ok: true });
	assert.deepEqual(calls.at(-1), ["/fake/botsun", "desk", "session", "--session", "sess-1", "--release"]);
});

test("the keep-alive starts once, ticks at 90 s, and stops", () => {
	const timers = [];
	const clock = {
		set(fn, ms) {
			const handle = { fn, ms, cleared: false };
			timers.push(handle);
			return handle;
		},
		clear(handle) {
			handle.cleared = true;
		},
	};
	const keep = new KeepAlive(() => {}, { intervalMs: 90_000, timers: clock });
	keep.start();
	keep.start();
	assert.equal(timers.length, 1, "one timer");
	assert.equal(timers[0].ms, 90_000);
	assert.equal(keep.running, true);
	keep.stop();
	assert.equal(timers[0].cleared, true);
	assert.equal(keep.running, false);
});

test("the tool: open, tabs, navigate, screenshot, eval, click/type/key, release; file: is refused", async () => {
	const home = path.join(root, "tool-home");
	mkdirSync(home, { recursive: true });
	const sock = path.join(home, "state", "desk-botsun-workers-2.cdp.sock");
	mkdirSync(path.dirname(sock), { recursive: true });
	const fake = await fakeCdp(sock);
	const calls = [];
	const timers = [];
	const clock = {
		set(fn, ms) {
			const handle = { fn, ms, cleared: false };
			timers.push(handle);
			return handle;
		},
		clear(handle) {
			handle.cleared = true;
		},
	};
	const run = async (_cmd, args) => {
		calls.push(args.join(" "));
		if (args.includes("--release")) return JSON.stringify({ desk_id: "d-tool", display: 2, released: true });
		return JSON.stringify({ desk_id: "d-tool", display: 2, vnc_socket: path.join(home, "vnc.sock"), cdp_socket: sock });
	};
	const h = stubPi();
	computerExtension({ bin: () => "/fake/botsun", run, home, intervalMs: 90_000, timers: clock })(h.pi);
	const tool = h.tools.find((t) => t.name === "computer");
	assert.ok(tool, "the tool is registered");
	const ctx = { sessionManager: { getSessionId: () => "sess-tool" } };
	const call = (params) => tool.execute("call", params, undefined, undefined, ctx);
	const body = (result) => result.content.map((part) => part.text ?? "").join("\n");

	try {
		assert.equal(body(await call({ action: "open" })), "display 2 · ready");
		assert.equal(timers.length, 1, "the keep-alive started");

		assert.match(body(await call({ action: "navigate", url: "file:///etc/passwd" })), /http\(s\) url/);
		assert.equal(fake.calls.length, 0, "no CDP call for a refused scheme");

		const tabs = JSON.parse(body(await call({ action: "tabs" })));
		assert.deepEqual(tabs, [{ id: "PAGE1", title: "title PAGE1", url: "https://example.com" }]);

		assert.equal(body(await call({ action: "navigate", url: "https://example.com/app" })), "navigated to https://example.com/app");

		const shot = await call({ action: "screenshot" });
		assert.equal(shot.content[0].type, "image");
		assert.equal(shot.content[0].mimeType, "image/png");
		assert.equal(shot.content[0].data, PNG);

		assert.equal(body(await call({ action: "eval", expression: "1+1" })), '"echo:1+1"');
		assert.equal(body(await call({ action: "click", x: 10, y: 20 })), "clicked 10,20");
		const mouse = fake.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => [c.params.type, c.params.buttons]);
		assert.deepEqual(mouse, [["mousePressed", 1], ["mouseReleased", 0]], "the release holds no button");
		assert.equal(body(await call({ action: "type", text: "hello" })), "typed 5 characters");
		assert.equal(body(await call({ action: "key", key: "Enter" })), "pressed Enter");
		assert.match(body(await call({ action: "key", key: "F13" })), /key needs Enter/);

		const methods = fake.calls.map((c) => c.method);
		assert.ok(methods.includes("Page.navigate"));
		assert.equal(methods.filter((m) => m === "Input.dispatchMouseEvent").length, 2, "pressed and released");
		assert.equal(fake.calls.filter((c) => c.method === "Input.dispatchMouseEvent").every((c) => c.params.button === "left"), true);
		assert.equal(fake.calls.some((c) => c.method === "Input.insertText"), true);

		assert.match(body(await call({ action: "release" })), /desk released/);
		assert.equal(timers[0].cleared, true, "the keep-alive stopped");
	} finally {
		await h.fire("session_shutdown", {}, ctx);
		await fake.close();
	}
});

test("the tool leases once, and another session's call re-leases; no session id is one line", async () => {
	const home = path.join(root, "lease-home");
	mkdirSync(home, { recursive: true });
	const sock = path.join(home, "desk.cdp.sock");
	const fake = await fakeCdp(sock);
	const sessions = [];
	const run = async (_cmd, args) => {
		sessions.push(args.at(-1));
		return JSON.stringify({ desk_id: "d", display: 1, cdp_socket: sock });
	};
	const h = stubPi();
	computerExtension({ bin: () => "/fake/botsun", run, home, timers: { set: () => ({ unref() {} }), clear: () => {} } })(h.pi);
	const tool = h.tools.find((t) => t.name === "computer");
	const at = (id) => ({ sessionManager: { getSessionId: () => id } });
	try {
		await tool.execute("c", { action: "open" }, undefined, undefined, at("s1"));
		await tool.execute("c", { action: "tabs" }, undefined, undefined, at("s1"));
		assert.deepEqual(sessions, ["s1"], "one lease for one desk");
		await tool.execute("c", { action: "open" }, undefined, undefined, at("s2"));
		assert.deepEqual(sessions, ["s1", "s2"], "a new session leases its own desk");
		const none = await tool.execute("c", { action: "open" }, undefined, undefined, {});
		assert.match(bodyOf(none), /no pi session id/);
	} finally {
		await h.fire("session_shutdown", {}, at("s2"));
		await fake.close();
	}
});
