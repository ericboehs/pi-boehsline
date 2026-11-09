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
	/** The character the key produces, for the keys that produce one. */
	text?: string;
	/** How the tool spells the key back ("Space", "Enter", "PageDown"). */
	label?: string;
}

/** The modifier bits `Input.dispatchKeyEvent`'s `modifiers` takes. */
export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type ModifierName = keyof typeof MODIFIER_BITS;

/** The left-hand modifier a combo holds down; its events carry the mask itself. */
const MODIFIER_KEYS: Record<ModifierName, KeySpec> = {
	Alt: { key: "Alt", code: "AltLeft", vk: 18, label: "Alt" },
	Control: { key: "Control", code: "ControlLeft", vk: 17, label: "Control" },
	Meta: { key: "Meta", code: "MetaLeft", vk: 91, label: "Meta" },
	Shift: { key: "Shift", code: "ShiftLeft", vk: 16, label: "Shift" },
};

/** The order a combo's modifiers are pressed (and spelled) in. */
const MODIFIER_ORDER: ModifierName[] = ["Control", "Alt", "Meta", "Shift"];

const MODIFIER_ALIASES: Record<string, ModifierName> = {
	alt: "Alt",
	option: "Alt",
	opt: "Alt",
	control: "Control",
	ctrl: "Control",
	meta: "Meta",
	cmd: "Meta",
	command: "Meta",
	super: "Meta",
	shift: "Shift",
};

const NAMED_KEYS: Record<string, KeySpec> = {
	enter: { key: "Enter", code: "Enter", vk: 13, text: "\r", label: "Enter" },
	return: { key: "Enter", code: "Enter", vk: 13, text: "\r", label: "Enter" },
	// Tab types nothing (Chrome's own Tab keydown has no text: a text event would
	// insert a literal tab instead of moving focus). Space does, so it keeps its text.
	tab: { key: "Tab", code: "Tab", vk: 9, label: "Tab" },
	escape: { key: "Escape", code: "Escape", vk: 27, label: "Escape" },
	esc: { key: "Escape", code: "Escape", vk: 27, label: "Escape" },
	backspace: { key: "Backspace", code: "Backspace", vk: 8, label: "Backspace" },
	delete: { key: "Delete", code: "Delete", vk: 46, label: "Delete" },
	del: { key: "Delete", code: "Delete", vk: 46, label: "Delete" },
	space: { key: " ", code: "Space", vk: 32, text: " ", label: "Space" },
	insert: { key: "Insert", code: "Insert", vk: 45, label: "Insert" },
	home: { key: "Home", code: "Home", vk: 36, label: "Home" },
	end: { key: "End", code: "End", vk: 35, label: "End" },
	pageup: { key: "PageUp", code: "PageUp", vk: 33, label: "PageUp" },
	pagedown: { key: "PageDown", code: "PageDown", vk: 34, label: "PageDown" },
	arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38, label: "ArrowUp" },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40, label: "ArrowDown" },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37, label: "ArrowLeft" },
	arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39, label: "ArrowRight" },
	up: { key: "ArrowUp", code: "ArrowUp", vk: 38, label: "ArrowUp" },
	down: { key: "ArrowDown", code: "ArrowDown", vk: 40, label: "ArrowDown" },
	left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37, label: "ArrowLeft" },
	right: { key: "ArrowRight", code: "ArrowRight", vk: 39, label: "ArrowRight" },
	f1: { key: "F1", code: "F1", vk: 112, label: "F1" },
	f2: { key: "F2", code: "F2", vk: 113, label: "F2" },
	f3: { key: "F3", code: "F3", vk: 114, label: "F3" },
	f4: { key: "F4", code: "F4", vk: 115, label: "F4" },
	f5: { key: "F5", code: "F5", vk: 116, label: "F5" },
	f6: { key: "F6", code: "F6", vk: 117, label: "F6" },
	f7: { key: "F7", code: "F7", vk: 118, label: "F7" },
	f8: { key: "F8", code: "F8", vk: 119, label: "F8" },
	f9: { key: "F9", code: "F9", vk: 120, label: "F9" },
	f10: { key: "F10", code: "F10", vk: 121, label: "F10" },
	f11: { key: "F11", code: "F11", vk: 122, label: "F11" },
	f12: { key: "F12", code: "F12", vk: 123, label: "F12" },
};

/** Unshifted punctuation: its US-layout code and virtual key. */
const PUNCTUATION: Record<string, { code: string; vk: number }> = {
	"-": { code: "Minus", vk: 189 },
	"=": { code: "Equal", vk: 187 },
	"`": { code: "Backquote", vk: 192 },
	"[": { code: "BracketLeft", vk: 219 },
	"]": { code: "BracketRight", vk: 221 },
	"\\": { code: "Backslash", vk: 220 },
	";": { code: "Semicolon", vk: 186 },
	"'": { code: "Quote", vk: 222 },
	",": { code: "Comma", vk: 188 },
	".": { code: "Period", vk: 190 },
	"/": { code: "Slash", vk: 191 },
};

/** What Shift turns each unshifted character into (US layout). */
const SHIFTED_CHARS: Record<string, string> = {
	"`": "~",
	"1": "!",
	"2": "@",
	"3": "#",
	"4": "$",
	"5": "%",
	"6": "^",
	"7": "&",
	"8": "*",
	"9": "(",
	"0": ")",
	"-": "_",
	"=": "+",
	"[": "{",
	"]": "}",
	"\\": "|",
	";": ":",
	"'": '"',
	",": "<",
	".": ">",
	"/": "?",
};

/**
 * One key by name: a named key (`Enter`, `PageDown`, `F5`), a letter, a digit
 * or punctuation; case-insensitive; null for anything else.
 */
export function keySpec(name: string | undefined): KeySpec | null {
	if (typeof name !== "string") return null;
	const key = name.trim();
	if (!key) return null;
	const named = NAMED_KEYS[key.toLowerCase()];
	if (named) return named;
	if (/^[a-z]$/i.test(key)) return { key: key.toLowerCase(), code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key.toLowerCase() };
	if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, vk: key.charCodeAt(0), text: key };
	const punct = PUNCTUATION[key];
	if (punct) return { key, code: punct.code, vk: punct.vk, text: key };
	return null;
}

/** A parsed key or combo: what to press, and the modifiers held while pressing it. */
export interface KeyCombo {
	spec: KeySpec;
	/** In press order (Control, Alt, Meta, Shift). */
	modifiers: ModifierName[];
	/** `Control+Shift+t`: what the tool answers with. */
	label: string;
}

/**
 * `Enter`, `a`, `F5`, `PageDown` or a `+`-joined combo (`Control+a`,
 * `Control+Shift+t`, `Meta+l`, `Shift+Tab`); null for anything else.
 */
export function parseKey(name: string | undefined): KeyCombo | null {
	if (typeof name !== "string" || !name.trim()) return null;
	const parts = name.trim().split("+");
	const keyName = parts.pop()?.trim();
	const modifiers = new Set<ModifierName>();
	for (const part of parts) {
		const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
		if (!modifier) return null;
		modifiers.add(modifier);
	}
	const spec = keySpec(keyName);
	if (!spec) return null;
	const order = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
	const label = [...order, spec.label ?? spec.key].join("+");
	return { spec, modifiers: order, label };
}

/** A key with Shift held: `a` becomes `A`, `1` becomes `!`. */
function shiftSpec(spec: KeySpec): KeySpec {
	const text = spec.text;
	if (!text || text.length !== 1 || spec.key !== text) return spec;
	const shifted = SHIFTED_CHARS[text] ?? text.toUpperCase();
	return { ...spec, key: shifted, text: shifted };
}

export type MouseButton = "left" | "right" | "middle";

const BUTTON_MASKS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

export interface ClickOptions {
	button?: MouseButton;
	/** 2 is a double-click: Chrome expects the pairs' clickCount to count up 1, 2. */
	clickCount?: number;
}

/** A click at the page's CSS pixels: pressed, then released, once per clickCount. */
export async function click(client: CdpClient, x: number, y: number, options: ClickOptions = {}): Promise<void> {
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("computer: click needs numeric x and y.");
	const button = options.button ?? "left";
	const mask = BUTTON_MASKS[button];
	if (mask === undefined) throw new Error(`computer: click takes a left, right or middle button (got ${JSON.stringify(button)}).`);
	const clicks = options.clickCount ?? 1;
	if (!Number.isFinite(clicks) || clicks < 1 || clicks > 3) throw new Error("computer: clickCount is 1, 2 (a double-click) or 3.");
	// `buttons` is the mask held after the event: the button's bit while pressed, 0
	// once released.
	for (let count = 1; count <= clicks; count++) {
		await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: mask, clickCount: count });
		await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: count });
	}
}

/** The pointer moves to the page's CSS pixels with no button held. */
export async function hover(client: CdpClient, x: number, y: number): Promise<void> {
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("computer: hover needs numeric x and y.");
	await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
}

export interface ScrollOptions {
	/** Where the wheel turns; the viewport's centre when either is missing. */
	x?: number;
	y?: number;
	deltaX?: number;
	deltaY?: number;
}

/** The viewport's centre in CSS pixels, from one Runtime.evaluate. */
async function viewportCentre(client: CdpClient): Promise<{ x: number; y: number }> {
	const result = (await client.send("Runtime.evaluate", { expression: "[window.innerWidth / 2, window.innerHeight / 2]", returnByValue: true })) as
		| { result?: { value?: unknown } }
		| undefined;
	const value = result?.result?.value;
	const x = Array.isArray(value) ? Number(value[0]) : Number.NaN;
	const y = Array.isArray(value) ? Number(value[1]) : Number.NaN;
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("computer: scroll could not read the viewport size.");
	return { x, y };
}

/**
 * What the wheel moved, read after two frames' settle (smooth scrolling and
 * momentum land late): the element under the pointer's nearest scrollable
 * ancestor — an inner scroller — or else the page.
 */
export function scrollOffsetsExpression(x: number, y: number): string {
	return `new Promise((done) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const scrollable = (node) => {
      if (!node || node === document.body || node === document.documentElement) return false;
      const style = getComputedStyle(node);
      if (!/(auto|scroll|overlay)/.test(style.overflowY + " " + style.overflowX)) return false;
      return node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth;
    };
    let node = document.elementFromPoint(${x}, ${y});
    while (node && !scrollable(node)) node = node.parentElement;
    done(node ? { of: "element", x: node.scrollLeft, y: node.scrollTop } : { of: "page", x: window.scrollX, y: window.scrollY });
  }));
})`;
}

/**
 * A wheel event at (x, y), then one Runtime.evaluate that waits two frames and
 * reads the new offsets. Returns the line the tool shows.
 */
export async function scroll(client: CdpClient, options: ScrollOptions = {}): Promise<string> {
	const deltaX = Number.isFinite(options.deltaX) ? (options.deltaX as number) : 0;
	const deltaY = Number.isFinite(options.deltaY) ? (options.deltaY as number) : 600;
	let { x, y } = options;
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		const centre = await viewportCentre(client);
		if (!Number.isFinite(x)) x = centre.x;
		if (!Number.isFinite(y)) y = centre.y;
	}
	await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
	const result = (await client.send("Runtime.evaluate", { expression: scrollOffsetsExpression(x as number, y as number), awaitPromise: true, returnByValue: true })) as
		| { result?: { value?: unknown } }
		| undefined;
	const value = result?.result?.value as { of?: unknown; x?: unknown; y?: unknown } | undefined;
	const scrollX = Number(value?.x);
	const scrollY = Number(value?.y);
	if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) throw new Error("computer: scroll did not get the page's new scroll position.");
	return `${value?.of === "element" ? "scroller" : "page"} at scrollX ${scrollX}, scrollY ${scrollY}`;
}

export interface DragOptions {
	toX: number;
	toY: number;
	/** How many interpolated moves between press and release (default 12). */
	steps?: number;
}

/**
 * A left-button drag from (x, y) to (toX, toY). Whatever throws midway, a
 * mouseReleased follows, so the button is never left down.
 */
export async function drag(client: CdpClient, x: number, y: number, options: DragOptions): Promise<void> {
	const toX = options.toX;
	const toY = options.toY;
	if (![x, y, toX, toY].every((value) => Number.isFinite(value))) throw new Error("computer: drag needs numeric x, y, toX and toY.");
	const requested = options.steps ?? 12;
	const steps = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.trunc(requested))) : 12;
	let pressed = false;
	try {
		await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
		await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
		pressed = true;
		for (let step = 1; step <= steps; step++) {
			const px = x + ((toX - x) * step) / steps;
			const py = y + ((toY - y) * step) / steps;
			await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "left", buttons: 1 });
		}
	} finally {
		if (pressed) await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1 });
	}
}

/**
 * The node a selector names, refused unless it is an `<input type=file>`.
 *
 * Answers the `backendNodeId`, not the `nodeId`: node ids are minted per CDP
 * session, and the file is set on a second connection after `desk put`, so a
 * `nodeId` from this one is not valid there (Chrome: "No node with given id
 * found"). A backend node id is stable across CDP sessions (not across the page replacing the element).
 */
export async function fileInputNode(client: CdpClient, selector: string): Promise<number> {
	if (typeof selector !== "string" || !selector.trim()) throw new Error("computer: upload needs a CSS selector.");
	const doc = (await client.send("DOM.getDocument")) as { root?: { nodeId?: number } } | undefined;
	const rootId = doc?.root?.nodeId;
	if (typeof rootId !== "number") throw new Error("computer: upload could not read the page's DOM.");
	const found = (await client.send("DOM.querySelector", { nodeId: rootId, selector })) as { nodeId?: number } | undefined;
	const nodeId = found?.nodeId;
	if (typeof nodeId !== "number" || nodeId === 0) throw new Error(`computer: upload: nothing in the page matches ${JSON.stringify(selector)}.`);
	const described = (await client.send("DOM.describeNode", { nodeId })) as
		| { node?: { nodeName?: string; attributes?: string[]; backendNodeId?: number } }
		| undefined;
	const node = described?.node;
	const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
	const attribute = (name: string): string | undefined => {
		for (let i = 0; i + 1 < attributes.length; i += 2) if (String(attributes[i]).toLowerCase() === name) return attributes[i + 1];
		return undefined;
	};
	if (String(node?.nodeName ?? "").toUpperCase() !== "INPUT" || (attribute("type") ?? "").toLowerCase() !== "file") {
		throw new Error(`computer: upload: ${selector} is not an <input type=file>.`);
	}
	const backendNodeId = node?.backendNodeId;
	if (typeof backendNodeId !== "number" || !backendNodeId) throw new Error(`computer: upload could not read the backend node id of ${selector}.`);
	return backendNodeId;
}

/** Give the file input a file already on the desk (`DOM.setFileInputFiles`, by backend node id). */
export async function setFileInput(client: CdpClient, backendNodeId: number, guestPath: string): Promise<void> {
	await client.send("DOM.setFileInputFiles", { files: [guestPath], backendNodeId });
}

export const WAIT_DEFAULT_MS = 5000;
export const WAIT_MAX_MS = 30_000;
const WAIT_POLL_MS = 100;

/** Poll `document.querySelector(selector)` until it matches, for SPAs. */
export async function waitFor(client: CdpClient, selector: string, timeoutMs = WAIT_DEFAULT_MS, pollMs = WAIT_POLL_MS): Promise<void> {
	if (typeof selector !== "string" || !selector.trim()) throw new Error("computer: wait needs a CSS selector.");
	const limit = Math.min(WAIT_MAX_MS, Math.max(0, Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : WAIT_DEFAULT_MS));
	const expression = `!!document.querySelector(${JSON.stringify(selector)})`;
	const deadline = Date.now() + limit;
	for (;;) {
		const result = (await client.send("Runtime.evaluate", { expression, returnByValue: true })) as { result?: { value?: unknown } } | undefined;
		if (result?.result?.value === true) return;
		const left = deadline - Date.now();
		if (left <= 0) throw new Error(`computer: wait: no element matches ${JSON.stringify(selector)} after ${limit} ms.`);
		await new Promise((done) => setTimeout(done, Math.min(pollMs, left)));
	}
}

/** Text into the focused element (`Input.insertText`). */
export async function typeText(client: CdpClient, text: string): Promise<void> {
	if (typeof text !== "string" || !text) throw new Error("computer: type needs text.");
	await client.send("Input.insertText", { text });
}

/**
 * One key or combo: modifier keyDowns (each event's mask includes its own
 * modifier), the key's keyDown — `rawKeyDown` when it produces no text — and
 * keyUp, then the modifier keyUps in reverse, each without its own bit.
 */
export async function pressKey(client: CdpClient, name: string | undefined): Promise<string> {
	const combo = parseKey(name);
	if (!combo) {
		throw new Error(
			`computer: key needs a key or a + combo: Enter, Tab, Escape, Backspace, Delete, Space, Home, PageDown, ArrowLeft, F5, a, Control+a, Control+Shift+t (got ${JSON.stringify(name ?? "")}).`,
		);
	}
	const spec = combo.modifiers.includes("Shift") ? shiftSpec(combo.spec) : combo.spec;
	// A shortcut (Control, Meta or Alt held) produces no text: Chrome sees a raw key down.
	const plain = !combo.modifiers.some((modifier) => modifier !== "Shift");
	const text = plain ? spec.text : undefined;
	let mask = 0;
	for (const modifier of combo.modifiers) {
		mask |= MODIFIER_BITS[modifier];
		const key = MODIFIER_KEYS[modifier];
		await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: mask, key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk });
	}
	const base = { modifiers: mask, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
	await client.send("Input.dispatchKeyEvent", {
		type: text ? "keyDown" : "rawKeyDown",
		...base,
		...(text ? { text, unmodifiedText: combo.spec.text ?? text } : {}),
	});
	await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
	for (const modifier of [...combo.modifiers].reverse()) {
		mask &= ~MODIFIER_BITS[modifier];
		const key = MODIFIER_KEYS[modifier];
		await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: mask, key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk });
	}
	return combo.label;
}
