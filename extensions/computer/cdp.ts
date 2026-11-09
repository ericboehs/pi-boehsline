/**
 * Chrome DevTools Protocol over Botsun's Unix socket: plain HTTP for `/json/*`
 * and one WebSocket (ws.ts) for the page commands the `computer` tool uses.
 *
 * No dependencies. Every CDP call has its own timeout, so a wedged Chromium
 * ends the tool call with a line rather than hanging the turn.
 */

import { request } from "node:http";
import { WsClient } from "./ws.ts";

export const CDP_TIMEOUT_MS = 30_000;
export const EVAL_BYTES = 8 * 1024;
const HTTP_MAX_BODY = 4 * 1024 * 1024;

export interface HttpResponse {
	status: number;
	body: string;
}

/** One HTTP request down the Unix socket; the socket is closed with the response. */
export function httpOverSocket(socketPath: string, path: string, method = "GET", timeoutMs = CDP_TIMEOUT_MS): Promise<HttpResponse> {
	return new Promise((ok, fail) => {
		const req = request(
			{ socketPath, path, method, headers: { Host: "localhost", Connection: "close" }, timeout: timeoutMs },
			(res) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				res.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > HTTP_MAX_BODY) {
						req.destroy(new Error("CDP answer too large"));
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
				res.on("error", fail);
			},
		);
		req.on("timeout", () => req.destroy(new Error("CDP timed out")));
		req.on("error", fail);
		req.end();
	});
}

export interface Target {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

/** `/json/list`, validated down to the fields this tool reads. */
export async function listTargets(socketPath: string): Promise<Target[]> {
	const res = await httpOverSocket(socketPath, "/json/list");
	if (res.status !== 200) throw new Error(`CDP /json/list answered ${res.status}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(res.body);
	} catch {
		throw new Error("CDP /json/list did not answer JSON");
	}
	if (!Array.isArray(parsed)) throw new Error("CDP /json/list did not answer a list");
	return parsed.filter((t): t is Target => typeof t === "object" && t !== null && (t as Target).type === "page");
}

/** The first page target; a fresh about:blank one when Chromium has none. */
export async function ensureTarget(socketPath: string): Promise<Target> {
	const pages = await listTargets(socketPath);
	const first = pages[0];
	if (first) return first;
	const created = await httpOverSocket(socketPath, `/json/new?${encodeURIComponent("about:blank")}`, "PUT");
	if (created.status >= 200 && created.status < 300) {
		try {
			const target = JSON.parse(created.body) as Target;
			if (target && target.type === "page") return target;
		} catch {
			// Older Chromium answers an empty body: ask the list again below.
		}
	}
	const after = await listTargets(socketPath);
	const page = after[0];
	if (!page) throw new Error("Chromium has no page to drive");
	return page;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** One page's WebSocket, with id-matched requests. One per tool call is fine. */
export class CdpClient {
	private readonly ws: WsClient;
	private readonly pending = new Map<number, Pending>();
	private nextId = 0;
	private closed: Error | undefined;

	constructor(ws: WsClient) {
		this.ws = ws;
	}

	send(method: string, params: Record<string, unknown> = {}, timeoutMs = CDP_TIMEOUT_MS): Promise<unknown> {
		if (this.closed) return Promise.reject(this.closed);
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.ws.send(JSON.stringify({ id, method, params }));
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err as Error);
			}
		});
	}

	/** Feed a server message in (tested directly, and the one WsClient handler). */
	onMessage(text: string): void {
		let msg: { id?: number; result?: unknown; error?: { message?: string } };
		try {
			msg = JSON.parse(text) as typeof msg;
		} catch {
			return;
		}
		if (typeof msg.id !== "number") return; // an event: not ours
		const pending = this.pending.get(msg.id);
		if (!pending) return;
		this.pending.delete(msg.id);
		clearTimeout(pending.timer);
		if (msg.error) pending.reject(new Error(msg.error.message || "CDP error"));
		else pending.resolve(msg.result);
	}

	/** The socket ended: fail whatever is waiting, once. */
	onClose(err?: Error): void {
		if (this.closed) return;
		this.closed = err ?? new Error("CDP socket closed");
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(this.closed);
			this.pending.delete(id);
		}
	}

	close(): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("CDP closed"));
			this.pending.delete(id);
		}
		this.closed ??= new Error("CDP closed");
		this.ws.close();
	}
}

/**
 * The page's WebSocket, close handler wired: connect to the first page (making
 * one when Chromium has none).
 */
export async function openCdp(socketPath: string, timeoutMs = CDP_TIMEOUT_MS): Promise<CdpClient> {
	const target = await ensureTarget(socketPath);
	const raw = target.webSocketDebuggerUrl;
	if (!raw) throw new Error("CDP's page target has no webSocketDebuggerUrl");
	const url = new URL(raw);
	let client: CdpClient | undefined;
	const ws = await WsClient.connect({
		socketPath,
		path: `${url.pathname}${url.search}`,
		host: url.host || "localhost",
		timeoutMs,
		onMessage: (text) => client?.onMessage(text),
		onClose: (err) => client?.onClose(err),
	});
	client = new CdpClient(ws);
	return client;
}

/** An http(s) URL, or null for anything else (file:, javascript:, data:, a typo). */
export function httpUrl(raw: string | undefined): string | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
}

/** A screenshot as PNG base64 (`Page.captureScreenshot`). */
export async function screenshot(client: CdpClient): Promise<string> {
	const result = (await client.send("Page.captureScreenshot", { format: "png" })) as { data?: unknown } | undefined;
	if (typeof result?.data !== "string" || !result.data) throw new Error("CDP returned no screenshot");
	return result.data;
}

/** `Runtime.evaluate` with returnByValue; the value as JSON, capped at 8 KB. */
export async function evaluate(client: CdpClient, expression: string): Promise<string> {
	if (!expression.trim()) throw new Error("computer: eval needs an expression.");
	const result = (await client.send("Runtime.evaluate", { expression, returnByValue: true })) as
		| { result?: { value?: unknown; description?: string; type?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
		| undefined;
	const thrown = result?.exceptionDetails;
	if (thrown) return capBytes(`Error: ${thrown.exception?.description || thrown.text || "the expression threw"}`);
	const value = result?.result;
	const text = value?.value === undefined ? (value?.description ?? "undefined") : JSON.stringify(value.value);
	return capBytes(text);
}

/** Text cut at `max` UTF-8 bytes, with a line saying how much was left. */
export function capBytes(text: string, max = EVAL_BYTES): string {
	const bytes = Buffer.byteLength(text);
	if (bytes <= max) return text;
	let cut = text.slice(0, max);
	while (Buffer.byteLength(cut) > max) cut = cut.slice(0, -1);
	return `${cut}\n… ${bytes - Buffer.byteLength(cut)} bytes more`;
}

export interface KeySpec {
	key: string;
	code: string;
	vk: number;
	text?: string;
}

const KEY_SPECS: Record<string, KeySpec> = {
	enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", vk: 9, text: "\t" },
	escape: { key: "Escape", code: "Escape", vk: 27 },
	esc: { key: "Escape", code: "Escape", vk: 27 },
	backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};

/** Enter/Tab/Escape/Backspace/arrows, case-insensitive; null for anything else. */
export function keySpec(name: string | undefined): KeySpec | null {
	if (typeof name !== "string") return null;
	const key = name.trim().toLowerCase();
	return KEY_SPECS[key] ?? null;
}

/** A left-button click at the page's CSS pixels: pressed, then released. */
export async function click(client: CdpClient, x: number, y: number): Promise<void> {
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("computer: click needs numeric x and y.");
	// `buttons` is the mask held after the event: 1 while pressed, 0 once released.
	await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

/** Text into the focused element (`Input.insertText`). */
export async function typeText(client: CdpClient, text: string): Promise<void> {
	if (typeof text !== "string" || !text) throw new Error("computer: type needs text.");
	await client.send("Input.insertText", { text });
}

/** One key press and release via Input.dispatchKeyEvent. */
export async function pressKey(client: CdpClient, name: string | undefined): Promise<string> {
	const spec = keySpec(name);
	if (!spec) throw new Error(`computer: key needs Enter, Tab, Escape, Backspace or an arrow (got ${JSON.stringify(name ?? "")}).`);
	const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
	await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}) });
	await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
	return spec.key;
}
