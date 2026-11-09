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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { stubPi } from "./helpers/stub-pi.mjs";

const { acceptFor, encodeFrame, FrameDecoder, OP_CONTINUATION, OP_PING, OP_PONG, OP_TEXT, WsClient } = await import(
	"../extensions/computer/ws.ts"
);
const { KeepAlive, expandHome, openDesk, parseDeskOutput, putFile, releaseDesk, validCdpSocket } = await import("../extensions/computer/desk.ts");
const {
	capBytes,
	click,
	drag,
	evaluate,
	fileInputNode,
	hover,
	keySpec,
	openCdp,
	parseKey,
	pressKey,
	screenshot,
	scroll,
	scrollOffsetsExpression,
	setFileInput,
	waitFor,
	EVAL_BYTES,
} = await import("../extensions/computer/cdp.ts");
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
 * WebSocket. Every CDP call is recorded in `calls`. `script` is read when each
 * answer is built, so a test can change what the page finds or what a node is.
 *
 * Each WebSocket connection mints its own DOM node ids, as Chrome does: a
 * `nodeId` from one connection is refused on another ("No node with given id
 * found"), while a `backendNodeId` works anywhere.
 */
function fakeCdp(sock, options = {}) {
	const calls = [];
	const script = { queryNodeId: 7, inputNodeName: "INPUT", inputAttributes: ["type", "file"], selectorMatched: true, backendNodeId: 42, ...options };
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
				// This connection's node ids; Chrome mints them per CDP session.
				const nodes = new Set();
				let minted = 0;
				const mint = () => {
					const id = ++minted;
					nodes.add(id);
					return id;
				};
				const frames = (data) => {
					for (const frame of decoder.push(data)) {
						if (frame.opcode !== OP_TEXT) continue;
						const msg = JSON.parse(frame.payload.toString("utf8"));
						calls.push(msg);
						const answer = (result) => conn.write(encodeFrame(JSON.stringify({ id: msg.id, result }), { mask: false }));
						const fail = (message) => conn.write(encodeFrame(JSON.stringify({ id: msg.id, error: { code: -32000, message } }), { mask: false }));
						if (msg.method === "Page.captureScreenshot") answer({ data: PNG });
						else if (msg.method === "Runtime.evaluate") {
							const expression = String(msg.params.expression);
							let value;
							if (expression.includes("document.querySelector")) value = script.selectorMatched;
							else if (expression.includes("requestAnimationFrame")) value = script.scroll ?? { of: "page", x: 0, y: 600 };
							else if (expression.includes("innerWidth")) value = [400, 300];
							else value = `echo:${expression}`;
							answer({ result: { type: "object", value } });
						} else if (msg.method === "DOM.getDocument") answer({ root: { nodeId: mint(), nodeName: "#document" } });
						else if (msg.method === "DOM.querySelector") {
							if (!nodes.has(msg.params.nodeId)) fail("No node with given id found");
							else if (script.queryNodeId === 0) answer({ nodeId: 0 });
							else answer({ nodeId: mint() });
						} else if (msg.method === "DOM.describeNode") {
							if (!nodes.has(msg.params.nodeId)) fail("No node with given id found");
							else answer({ node: { nodeName: script.inputNodeName, attributes: script.inputAttributes, backendNodeId: script.backendNodeId } });
						} else if (msg.method === "DOM.setFileInputFiles") {
							if (msg.params.nodeId !== undefined && !nodes.has(msg.params.nodeId)) fail("No node with given id found");
							else if (msg.params.backendNodeId !== undefined && msg.params.backendNodeId !== script.backendNodeId)
								fail("No node with given backend id found");
							else answer({});
						} else answer({});
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
	return new Promise((resolve) =>
		server.listen(sock, () => resolve({ server, calls, script, close: () => new Promise((done) => server.close(done)) })),
	);
}

const page = (id, url) => ({ id, type: "page", title: `title ${id}`, url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` });

/** The next message on a WsClient, or a timeout failure. */
const bodyOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

/**
 * A CdpClient stand-in that records every message and answers from `answers`
 * (a value, a function of the params, or an Error to throw).
 */
function recorder(answers = {}) {
	const calls = [];
	const client = {
		async send(method, params = {}) {
			calls.push({ method, params });
			const answer = answers[method];
			const value = typeof answer === "function" ? answer(params, calls.length) : answer;
			if (value instanceof Error) throw value;
			return value;
		},
	};
	return { client, calls };
}

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
	assert.equal(keySpec("F13"), null);
	assert.equal(keySpec("F5").vk, 116);
	assert.equal(keySpec("PageDown").vk, 34);
	assert.equal(keySpec("Space").text, " ");
	assert.equal(keySpec("a").code, "KeyA");

	assert.equal(parseKey("Enter").label, "Enter");
	assert.deepEqual(parseKey("Control+Shift+t").modifiers, ["Control", "Shift"]);
	assert.equal(parseKey("ctrl+shift+t").label, "Control+Shift+t", "aliases and order");
	assert.equal(parseKey("Shift+Control+t").label, "Control+Shift+t", "canonical order");
	assert.equal(parseKey("Meta+l").label, "Meta+l");
	assert.equal(parseKey("Alt+ArrowLeft").label, "Alt+ArrowLeft");
	assert.equal(parseKey("Shift+Tab").label, "Shift+Tab");
	assert.equal(parseKey("nope"), null);
	assert.equal(parseKey("Hyper+a"), null, "an unknown modifier");
	assert.equal(parseKey("Control+Control+a").modifiers.length, 1, "a repeated modifier is held once");
	assert.equal(parseKey(""), null);
	assert.equal(parseKey(undefined), null);
});

test("hover is one mouseMoved with no button held", async () => {
	const { client, calls } = recorder();
	await hover(client, 5, 6);
	assert.deepEqual(calls, [{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 5, y: 6, buttons: 0 } }]);
});

test("a click takes a button (right holds buttons 2) and a clickCount (a double-click counts up 1, 2)", async () => {
	const left = recorder();
	await click(left.client, 1, 2);
	assert.deepEqual(
		left.calls.map((c) => c.params),
		[
			{ type: "mousePressed", x: 1, y: 2, button: "left", buttons: 1, clickCount: 1 },
			{ type: "mouseReleased", x: 1, y: 2, button: "left", buttons: 0, clickCount: 1 },
		],
	);

	const right = recorder();
	await click(right.client, 1, 2, { button: "right" });
	assert.deepEqual(
		right.calls.map((c) => [c.params.type, c.params.button, c.params.buttons]),
		[
			["mousePressed", "right", 2],
			["mouseReleased", "right", 0],
		],
	);

	const middle = recorder();
	await click(middle.client, 1, 2, { button: "middle" });
	assert.deepEqual(middle.calls.map((c) => c.params.buttons), [4, 0]);

	const double = recorder();
	await click(double.client, 3, 4, { clickCount: 2 });
	assert.deepEqual(
		double.calls.map((c) => [c.params.type, c.params.clickCount, c.params.buttons]),
		[
			["mousePressed", 1, 1],
			["mouseReleased", 1, 0],
			["mousePressed", 2, 1],
			["mouseReleased", 2, 0],
		],
	);

	await assert.rejects(click(recorder().client, Number.NaN, 2), /numeric x and y/);
	await assert.rejects(click(recorder().client, 1, 2, { button: "fourth" }), /left, right or middle/);
});

test("scroll: a wheel event where asked, then one awaitPromise evaluate that reads the new offsets", async () => {
	const settle = (offsets) => (params) =>
		String(params.expression).includes("innerWidth") ? { result: { value: [400, 300] } } : { result: { value: offsets } };
	const centre = recorder({ "Input.dispatchMouseEvent": {}, "Runtime.evaluate": settle({ of: "page", x: 0, y: 600 }) });
	assert.equal(await scroll(centre.client), "page at scrollX 0, scrollY 600");
	assert.deepEqual(centre.calls.map((c) => c.method), ["Runtime.evaluate", "Input.dispatchMouseEvent", "Runtime.evaluate"]);
	assert.deepEqual(centre.calls[1].params, { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 600 });
	assert.deepEqual(centre.calls[2].params, {
		expression: scrollOffsetsExpression(400, 300),
		awaitPromise: true,
		returnByValue: true,
	});
	assert.match(centre.calls[2].params.expression, /requestAnimationFrame\(\(\) => requestAnimationFrame/, "two frames settle first");
	assert.match(centre.calls[2].params.expression, /elementFromPoint\(400, 300\)/, "the point it read the wheel at");

	const placed = recorder({ "Input.dispatchMouseEvent": {}, "Runtime.evaluate": settle({ of: "element", x: 0, y: 1200 }) });
	assert.equal(await scroll(placed.client, { x: 10, y: 20, deltaY: -300, deltaX: 5 }), "scroller at scrollX 0, scrollY 1200");
	assert.deepEqual(
		placed.calls.map((c) => c.method),
		["Input.dispatchMouseEvent", "Runtime.evaluate"],
		"a given position skips the viewport lookup",
	);
	assert.deepEqual(placed.calls[0].params, { type: "mouseWheel", x: 10, y: 20, deltaX: 5, deltaY: -300 });
	assert.match(placed.calls[1].params.expression, /elementFromPoint\(10, 20\)/);

	const broken = recorder({ "Input.dispatchMouseEvent": {}, "Runtime.evaluate": { result: { value: null } } });
	await assert.rejects(scroll(broken.client, { x: 1, y: 2 }), /did not get the page's new scroll position/);
});

test("drag: interpolated moves between the press and the release", async () => {
	const { client, calls } = recorder();
	await drag(client, 10, 10, { toX: 30, toY: 20, steps: 2 });
	assert.deepEqual(calls.map((c) => c.params), [
		{ type: "mouseMoved", x: 10, y: 10, buttons: 0 },
		{ type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1, clickCount: 1 },
		{ type: "mouseMoved", x: 20, y: 15, button: "left", buttons: 1 },
		{ type: "mouseMoved", x: 30, y: 20, button: "left", buttons: 1 },
		{ type: "mouseReleased", x: 30, y: 20, button: "left", buttons: 0, clickCount: 1 },
	]);
});

test("drag releases the button when an event midway throws", async () => {
	const broken = recorder({ "Input.dispatchMouseEvent": (params, n) => (n === 3 ? new Error("CDP timed out") : {}) });
	await assert.rejects(drag(broken.client, 10, 10, { toX: 30, toY: 30, steps: 2 }), /timed out/);
	const last = broken.calls.at(-1);
	assert.deepEqual(last.params, { type: "mouseReleased", x: 30, y: 30, button: "left", buttons: 0, clickCount: 1 });
	assert.equal(broken.calls.filter((c) => c.params.type === "mouseReleased").length, 1, "one release");
});

test("Control+Shift+t sends modifier key downs, a raw key down, then modifier key ups in reverse", async () => {
	const { client, calls } = recorder();
	assert.equal(await pressKey(client, "Control+Shift+t"), "Control+Shift+t");
	assert.deepEqual(calls.map((c) => c.params), [
		{ type: "rawKeyDown", modifiers: 2, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 },
		{ type: "rawKeyDown", modifiers: 10, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 },
		{ type: "rawKeyDown", modifiers: 10, key: "T", code: "KeyT", windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84 },
		{ type: "keyUp", modifiers: 10, key: "T", code: "KeyT", windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84 },
		{ type: "keyUp", modifiers: 2, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 },
		{ type: "keyUp", modifiers: 0, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 },
	]);
});

test("Enter is a keyDown carrying its text, then a keyUp; Shift+a types A", async () => {
	const { client, calls } = recorder();
	assert.equal(await pressKey(client, "Enter"), "Enter");
	assert.deepEqual(calls.map((c) => c.params), [
		{
			type: "keyDown",
			modifiers: 0,
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13,
			text: "\r",
			unmodifiedText: "\r",
		},
		{ type: "keyUp", modifiers: 0, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
	]);

	const shifted = recorder();
	await pressKey(shifted.client, "Shift+a");
	assert.equal(shifted.calls[1].params.type, "keyDown");
	assert.equal(shifted.calls[1].params.key, "A");
	assert.equal(shifted.calls[1].params.text, "A");
	assert.equal(shifted.calls[1].params.unmodifiedText, "a");

	const meta = recorder();
	await pressKey(meta.client, "Meta+l");
	assert.equal(meta.calls[1].params.type, "rawKeyDown", "a shortcut carries no text");
	assert.equal(meta.calls[1].params.modifiers, 4);

	const unknown = recorder();
	await assert.rejects(pressKey(unknown.client, "F13"), /computer: key needs a key or a \+ combo: .*Control\+Shift\+t .*"F13"/);
	assert.deepEqual(unknown.calls, [], "nothing is sent for a key it doesn't know");
});

test("Shift+Tab, PageDown, Alt+ArrowLeft and punctuation send no text they don't have", async () => {
	const shiftedTab = recorder();
	assert.equal(await pressKey(shiftedTab.client, "Shift+Tab"), "Shift+Tab");
	assert.deepEqual(shiftedTab.calls.map((c) => c.params), [
		{ type: "rawKeyDown", modifiers: 8, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 },
		{ type: "rawKeyDown", modifiers: 8, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
		{ type: "keyUp", modifiers: 8, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
		{ type: "keyUp", modifiers: 0, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 },
	], "Tab types nothing (Chrome's own Tab keydown has no text): no char event, no literal tab");
	assert.equal(shiftedTab.calls.some((c) => "text" in c.params), false);

	const pageDown = recorder();
	assert.equal(await pressKey(pageDown.client, "PageDown"), "PageDown");
	assert.deepEqual(pageDown.calls[0].params, { type: "rawKeyDown", modifiers: 0, key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 });

	const back = recorder();
	assert.equal(await pressKey(back.client, "Alt+ArrowLeft"), "Alt+ArrowLeft");
	assert.deepEqual(
		back.calls.map((c) => [c.params.type, c.params.modifiers, c.params.key]),
		[
			["rawKeyDown", 1, "Alt"],
			["rawKeyDown", 1, "ArrowLeft"],
			["keyUp", 1, "ArrowLeft"],
			["keyUp", 0, "Alt"],
		],
	);
	assert.equal(back.calls[1].params.windowsVirtualKeyCode, 37);

	const slash = recorder();
	assert.equal(await pressKey(slash.client, "/"), "/");
	assert.deepEqual(slash.calls.map((c) => c.params), [
		{ type: "keyDown", modifiers: 0, key: "/", code: "Slash", windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191, text: "/", unmodifiedText: "/" },
		{ type: "keyUp", modifiers: 0, key: "/", code: "Slash", windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191 },
	]);

	const question = recorder();
	await pressKey(question.client, "Shift+/");
	assert.equal(question.calls[1].params.text, "?", "Shift turns / into ?");
	assert.equal(question.calls[1].params.unmodifiedText, "/");

	const space = recorder();
	await pressKey(space.client, "Space");
	assert.equal(space.calls[0].params.text, " ", "Space keeps its text: a space must be typed into inputs");
	assert.equal(space.calls[0].params.type, "keyDown");
});

test("upload: the file input is looked up and checked, then given the guest path", async () => {
	const found = recorder({
		"DOM.getDocument": { root: { nodeId: 1 } },
		"DOM.querySelector": { nodeId: 7 },
		"DOM.describeNode": { node: { nodeName: "INPUT", attributes: ["type", "file", "id", "f"], backendNodeId: 42 } },
	});
	assert.equal(await fileInputNode(found.client, "#f"), 42, "the backend node id, which survives the second connection");
	assert.deepEqual(
		found.calls.map((c) => [c.method, c.params]),
		[
			["DOM.getDocument", {}],
			["DOM.querySelector", { nodeId: 1, selector: "#f" }],
			["DOM.describeNode", { nodeId: 7 }],
		],
	);
	await setFileInput(found.client, 42, "/home/agent/upload.txt");
	assert.deepEqual(found.calls.at(-1), {
		method: "DOM.setFileInputFiles",
		params: { files: ["/home/agent/upload.txt"], backendNodeId: 42 },
	});

	const noBackend = recorder({
		"DOM.getDocument": { root: { nodeId: 1 } },
		"DOM.querySelector": { nodeId: 7 },
		"DOM.describeNode": { node: { nodeName: "INPUT", attributes: ["type", "file"] } },
	});
	await assert.rejects(fileInputNode(noBackend.client, "#f"), /could not read the backend node id/);

	const noMatch = recorder({ "DOM.getDocument": { root: { nodeId: 1 } }, "DOM.querySelector": { nodeId: 0 } });
	await assert.rejects(fileInputNode(noMatch.client, "#nope"), /nothing in the page matches "#nope"/);
	assert.equal(noMatch.calls.some((c) => c.method === "DOM.describeNode"), false, "no describe when nothing matched");

	const textInput = recorder({
		"DOM.getDocument": { root: { nodeId: 1 } },
		"DOM.querySelector": { nodeId: 7 },
		"DOM.describeNode": { node: { nodeName: "INPUT", attributes: ["type", "text"] } },
	});
	await assert.rejects(fileInputNode(textInput.client, "#q"), /not an <input type=file>/);

	const div = recorder({
		"DOM.getDocument": { root: { nodeId: 1 } },
		"DOM.querySelector": { nodeId: 7 },
		"DOM.describeNode": { node: { nodeName: "DIV", attributes: [] } },
	});
	await assert.rejects(fileInputNode(div.client, "div.drop"), /not an <input type=file>/);

	const empty = recorder();
	await assert.rejects(fileInputNode(empty.client, "  "), /needs a CSS selector/);
	assert.deepEqual(empty.calls, [], "nothing is sent without a selector");
});

test("upload: `desk put` copies the file, and a missing file or a directory never reaches the CLI", async () => {
	const dir = path.join(root, "put");
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "note.txt");
	writeFileSync(file, "hi");
	const calls = [];
	const run = async (cmd, args) => {
		calls.push([cmd, ...args]);
		return `noise\n{"path":"/home/agent/note.txt","bytes":2}`;
	};
	assert.deepEqual(await putFile("sess-put", file, { bin: "/fake/botsun", run }), { path: "/home/agent/note.txt", bytes: 2 });
	assert.deepEqual(calls[0], ["/fake/botsun", "desk", "put", "--session", "sess-put", file]);

	const noBytes = await putFile("s", file, { bin: "/fake/botsun", run: async () => JSON.stringify({ path: "/home/agent/x" }) });
	assert.deepEqual(noBytes, { path: "/home/agent/x", bytes: 2 }, "the size falls back to the file's");

	// `~/` expands (against the injected home), and every path reaches the CLI absolute, so a
	// name can never be read as a flag: botsun's `parse` has no `--` terminator.
	const tilde = path.join(root, "tilde");
	mkdirSync(tilde, { recursive: true });
	writeFileSync(path.join(tilde, "note.txt"), "hi");
	calls.length = 0;
	assert.deepEqual(await putFile("s", "~/note.txt", { bin: "/fake/botsun", run, home: tilde }), { path: "/home/agent/note.txt", bytes: 2 });
	assert.deepEqual(calls[0], ["/fake/botsun", "desk", "put", "--session", "s", path.join(tilde, "note.txt")]);
	assert.equal(calls[0].some((arg) => arg === "--"), false, "no `--` separator: botsun's parser would take it for a flag");

	calls.length = 0;
	const relative = path.relative(process.cwd(), file);
	assert.deepEqual(await putFile("s", relative, { bin: "/fake/botsun", run }), { path: "/home/agent/note.txt", bytes: 2 });
	assert.deepEqual(calls[0], ["/fake/botsun", "desk", "put", "--session", "s", file], "a relative path is made absolute");

	assert.equal(expandHome("~/x", "/home/me"), "/home/me/x");
	assert.equal(expandHome("~", "/home/me"), "/home/me");
	assert.equal(expandHome("/abs/x", "/home/me"), "/abs/x");
	assert.equal(expandHome("~user/x", "/home/me"), "~user/x", "only a bare `~/` is ours to expand");

	let reached = 0;
	const spy = async () => {
		reached++;
		return "{}";
	};
	const bin = { bin: "/fake/botsun", run: spy };
	assert.match((await putFile("s", dir, bin)).error, /takes a file, not a directory/);
	assert.match((await putFile("s", "/dev/null", bin)).error, /takes a regular file/, "/dev/null is a character device");
	assert.match((await putFile("s", path.join(dir, "nope"), bin)).error, /no such file on this Mac/);
	assert.match((await putFile("s", "", bin)).error, /needs a path/);
	assert.equal(reached, 0, "a refused path never calls the CLI");

	assert.match((await putFile("s", file, { bin: "/fake/botsun", run: async () => "noise" })).error, /no guest path/);
	assert.match(
		(
			await putFile("s", file, {
				bin: "/fake/botsun",
				run: async () => {
					throw new Error("desk put failed");
				},
			})
		).error,
		/could not put the file on the desk: desk put failed/,
	);
});

test("wait polls for a selector and gives up with a line", async () => {
	const found = recorder({ "Runtime.evaluate": { result: { value: true } } });
	await waitFor(found.client, "#app", 5000);
	assert.deepEqual(found.calls[0].params, { expression: '!!document.querySelector("#app")', returnByValue: true });
	assert.equal(found.calls.length, 1);

	let polls = 0;
	const late = recorder({ "Runtime.evaluate": () => ({ result: { value: ++polls >= 3 } }) });
	await waitFor(late.client, "#later", 5000, 5);
	assert.equal(late.calls.length, 3, "it polls until the element appears");

	const missing = recorder({ "Runtime.evaluate": { result: { value: false } } });
	await assert.rejects(waitFor(missing.client, "#later", 0), /no element matches "#later" after 0 ms/);
	assert.equal(missing.calls.length, 1, "timeoutMs 0 checks once");
});

test("fake CDP: a nodeId is per connection, a backendNodeId is not", async () => {
	const sock = sockPath("identity");
	const fake = await fakeCdp(sock);
	const first = await openCdp(sock);
	let second;
	try {
		const doc = await first.send("DOM.getDocument");
		const found = await first.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input" });
		const described = await first.send("DOM.describeNode", { nodeId: found.nodeId });
		assert.equal(typeof found.nodeId, "number");
		assert.equal(described.node.backendNodeId, 42);
		first.close();

		second = await openCdp(sock);
		await assert.rejects(
			second.send("DOM.setFileInputFiles", { files: ["/tmp/x"], nodeId: found.nodeId }),
			/No node with given id found/,
			"the first connection's nodeId does not exist on the second (what real Chrome answers)",
		);
		assert.deepEqual(await second.send("DOM.setFileInputFiles", { files: ["/tmp/x"], backendNodeId: described.node.backendNodeId }), {});
	} finally {
		first.close();
		second?.close();
		await fake.close();
	}
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
		assert.match(body(await call({ action: "key", key: "F13" })), /key needs a key or a \+ combo/);

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

test("the tool: hover, drag, scroll, right/double click, key combos, wait, upload", async () => {
	const home = path.join(root, "actions-home");
	mkdirSync(home, { recursive: true });
	const sock = path.join(home, "desk.cdp.sock");
	const fake = await fakeCdp(sock);
	const uploaded = path.join(home, "upload.txt");
	writeFileSync(uploaded, "hello");
	const cli = [];
	const run = async (_cmd, args) => {
		cli.push(args.join(" "));
		if (args[1] === "put") return JSON.stringify({ path: "/home/agent/upload.txt", bytes: 5 });
		return JSON.stringify({ desk_id: "d-a", display: 2, vnc_socket: path.join(home, "vnc.sock"), cdp_socket: sock });
	};
	const h = stubPi();
	computerExtension({ bin: () => "/fake/botsun", run, home, timers: { set: () => ({ unref() {} }), clear: () => {} } })(h.pi);
	const tool = h.tools.find((t) => t.name === "computer");
	const ctx = { sessionManager: { getSessionId: () => "sess-actions" } };
	const call = (params) => tool.execute("call", params, undefined, undefined, ctx);
	const body = (result) => result.content.map((part) => part.text ?? "").join("\n");
	const mouse = () => fake.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
	const clear = () => {
		fake.calls.length = 0;
	};
	try {
		assert.equal(body(await call({ action: "hover", x: 5, y: 6 })), "hovered 5,6");
		assert.deepEqual(mouse(), [{ type: "mouseMoved", x: 5, y: 6, buttons: 0 }]);

		clear();
		assert.equal(body(await call({ action: "drag", x: 0, y: 0, toX: 10, toY: 0, steps: 1 })), "dragged 0,0 → 10,0");
		assert.deepEqual(
			mouse().map((p) => p.type),
			["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased"],
		);
		assert.deepEqual(mouse().at(-1), { type: "mouseReleased", x: 10, y: 0, button: "left", buttons: 0, clickCount: 1 });

		clear();
		assert.equal(body(await call({ action: "scroll" })), "page at scrollX 0, scrollY 600");
		assert.deepEqual(mouse(), [{ type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 600 }]);
		assert.equal(fake.calls.filter((c) => c.method === "Runtime.evaluate").length, 2, "the centre, then the offsets");

		clear();
		assert.equal(body(await call({ action: "click", x: 3, y: 4, button: "right" })), "clicked 3,4 (right)");
		assert.deepEqual(
			mouse().map((p) => [p.button, p.buttons]),
			[
				["right", 2],
				["right", 0],
			],
		);

		clear();
		assert.equal(body(await call({ action: "click", x: 3, y: 4, button: "middle" })), "clicked 3,4 (middle)");
		assert.deepEqual(
			mouse().map((p) => [p.button, p.buttons]),
			[
				["middle", 4],
				["middle", 0],
			],
		);

		clear();
		assert.equal(body(await call({ action: "click", x: 3, y: 4, clickCount: 2 })), "double-clicked 3,4");
		assert.deepEqual(mouse().map((p) => p.clickCount), [1, 1, 2, 2]);

		clear();
		assert.equal(body(await call({ action: "key", key: "Control+Shift+t" })), "pressed Control+Shift+t");
		assert.deepEqual(
			fake.calls.map((c) => c.params.modifiers),
			[2, 10, 10, 10, 2, 0],
		);
		assert.equal(body(await call({ action: "key", key: "Meta+l" })), "pressed Meta+l");
		assert.match(body(await call({ action: "key", key: "F13" })), /key needs a key or a \+ combo/);

		clear();
		assert.equal(body(await call({ action: "wait", selector: "#app", timeoutMs: 1000 })), "#app is in the page");
		assert.deepEqual(fake.calls[0].params, { expression: '!!document.querySelector("#app")', returnByValue: true });
		fake.script.selectorMatched = false;
		assert.match(body(await call({ action: "wait", selector: "#never", timeoutMs: 0 })), /no element matches "#never" after 0 ms/);
		fake.script.selectorMatched = true;

		clear();
		assert.equal(
			body(await call({ action: "upload", selector: "input[type=file]", path: uploaded })),
			`uploaded ${uploaded} → /home/agent/upload.txt (5 bytes) into input[type=file]`,
		);
		assert.deepEqual(cli.at(-1), `desk put --session sess-actions ${uploaded}`);
		assert.deepEqual(
			fake.calls.map((c) => c.method),
			["DOM.getDocument", "DOM.querySelector", "DOM.describeNode", "DOM.setFileInputFiles"],
		);
		assert.deepEqual(fake.calls.at(-1).params, { files: ["/home/agent/upload.txt"], backendNodeId: 42 }, "not the first connection's nodeId");

		// The refusals never copy the file: no selector, nothing matched, a non-file input, a directory, a missing file.
		const puts = () => cli.filter((line) => line.startsWith("desk put")).length;
		assert.match(body(await call({ action: "upload", selector: "", path: uploaded })), /needs a selector/);
		assert.match(body(await call({ action: "upload", selector: "input", path: "" })), /needs a path/);
		fake.script.queryNodeId = 0;
		assert.match(body(await call({ action: "upload", selector: "#nope", path: uploaded })), /nothing in the page matches/);
		fake.script.queryNodeId = 7;
		fake.script.inputAttributes = ["type", "text"];
		assert.match(body(await call({ action: "upload", selector: "#text", path: uploaded })), /not an <input type=file>/);
		fake.script.inputAttributes = ["type", "file"];
		assert.match(body(await call({ action: "upload", selector: "input", path: home })), /takes a file, not a directory/);
		assert.match(
			body(await call({ action: "upload", selector: "input", path: path.join(home, "nope.txt") })),
			/no such file on this Mac/,
		);
		assert.equal(puts(), 1, "one copy, for the call that succeeded");
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
