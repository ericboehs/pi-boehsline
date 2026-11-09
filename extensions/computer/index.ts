/**
 * computer — drive this pi session's own Linux desktop's Chromium, the one
 * Botsun shows on Eric's phone (docs/plans/sandbox-workers.md Part 3 Phase 3.9,
 * in the Botsun repo).
 *
 * The desk is leased with `bin/botsun desk session --session <pi session id>`,
 * which prints one JSON line naming two 0600 Unix sockets on this Mac: the VNC
 * one (his phone's viewer) and the CDP one (this tool). Botsun stops a desk that
 * looks idle, so while one is open here the same ask is repeated every 90 s.
 *
 * Every action is a tool result; a failure is one line, never a thrown error.
 * No dependencies beyond node: the WebSocket client is ws.ts, the CLI and the
 * keep-alive are desk.ts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { sessionOf } from "../../lib/children.ts";
import { optIn } from "../../lib/opt-in.ts";
import { sandboxBin } from "../subagent/sandbox.ts";
import { capBytes, click, drag, evaluate, fileInputNode, hover, httpUrl, listTargets, openCdp, pressKey, screenshot, scroll, setFileInput, typeText, waitFor } from "./cdp.ts";
import type { MouseButton } from "./cdp.ts";
import { KeepAlive, openDesk, putFile, releaseDesk, type DeskRunner, type DeskSession, type TimerFns } from "./desk.ts";

const ACTIONS = [
	"open",
	"navigate",
	"screenshot",
	"click",
	"hover",
	"drag",
	"scroll",
	"type",
	"key",
	"eval",
	"tabs",
	"wait",
	"upload",
	"release",
] as const;

const BUTTONS = ["left", "right", "middle"] as const;

const Params = Type.Object({
	action: StringEnum(ACTIONS),
	url: Type.Optional(Type.String({ description: "navigate: the http(s) URL to open" })),
	x: Type.Optional(Type.Number({ description: "click, hover, scroll, drag: x in the page's CSS pixels" })),
	y: Type.Optional(Type.Number({ description: "click, hover, scroll, drag: y in the page's CSS pixels" })),
	toX: Type.Optional(Type.Number({ description: "drag: where the drag ends, x in CSS pixels" })),
	toY: Type.Optional(Type.Number({ description: "drag: where the drag ends, y in CSS pixels" })),
	steps: Type.Optional(Type.Number({ description: "drag: interpolated moves between press and release (default 12)" })),
	button: Type.Optional(StringEnum(BUTTONS, { description: "click: left (default), right (a context menu) or middle" })),
	clickCount: Type.Optional(Type.Number({ description: "click: 1 (default) or 2 for a double-click" })),
	deltaX: Type.Optional(Type.Number({ description: "scroll: horizontal CSS pixels (default 0)" })),
	deltaY: Type.Optional(Type.Number({ description: "scroll: vertical CSS pixels, positive scrolls down (default 600)" })),
	text: Type.Optional(Type.String({ description: "type: the text to insert" })),
	key: Type.Optional(
		Type.String({
			description:
				"key: a key or a + combo — Enter, Tab, Escape, Backspace, Delete, Space, Home, End, PageDown, ArrowLeft, F5, a, Control+a, Control+Shift+t, Alt+ArrowLeft, Meta+l, Shift+Tab",
		}),
	),
	expression: Type.Optional(Type.String({ description: "eval: the JavaScript expression to evaluate" })),
	selector: Type.Optional(Type.String({ description: "upload: a CSS selector of an <input type=file>; wait: a CSS selector to wait for" })),
	path: Type.Optional(Type.String({ description: "upload: a file on this Mac to put on the desk and select (a leading `~/` is expanded)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "wait: how long to wait for the selector (default 5000, max 30000)" })),
});

/** What tests inject; every field has a real default. */
export interface ComputerDeps {
	/** Where the Botsun CLI is (default: sandboxBin(), the subagent sandbox's lookup). */
	bin?: () => string;
	/** Runs the CLI (default: execFile, no shell). */
	run?: DeskRunner;
	/** The home a cdp_socket must sit under (default: os.homedir()). */
	home?: string;
	/** The keep-alive's interval and timer functions (tests). */
	intervalMs?: number;
	timers?: TimerFns;
	/** One CLI call's timeout (tests). */
	cliTimeoutMs?: number;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

/** One line: an error a model can act on without a stack trace. */
function oneLine(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const line = message.replace(/\s+/g, " ").trim() || "unknown error";
	return line.length > 500 ? `${line.slice(0, 499)}…` : line;
}

export function computerExtension(deps: ComputerDeps = {}) {
	return (pi: ExtensionAPI) => {
		const bin = () => deps.bin?.() ?? sandboxBin();
		const runOpts = () => ({ bin: bin(), run: deps.run, timeoutMs: deps.cliTimeoutMs, home: deps.home });

		interface OpenDesk extends DeskSession {
			keep: KeepAlive;
		}
		let desk: OpenDesk | undefined;

		/** Ask Botsun to touch the desk; a failure here is not worth a tool error. */
		const touch = async (sessionId: string): Promise<void> => {
			const opened = await openDesk(sessionId, runOpts());
			if ("desk" in opened && desk && desk.sessionId === sessionId) {
				desk.cdpSocket = opened.desk.cdpSocket;
				desk.display = opened.desk.display ?? desk.display;
				desk.deskId = opened.desk.deskId ?? desk.deskId;
			}
		};

		/** The session's desk: leased in this process already, or leased now. */
		// One lease in flight at a time: concurrent first calls share it, so no second KeepAlive is
		// started and orphaned.
		let opening: { sessionId: string; promise: Promise<{ desk: OpenDesk } | { error: string }> } | undefined;
		const ensureDesk = (sessionId: string): Promise<{ desk: OpenDesk } | { error: string }> => {
			if (desk && desk.sessionId === sessionId) return Promise.resolve({ desk });
			if (opening && opening.sessionId === sessionId) return opening.promise;
			const promise = (async (): Promise<{ desk: OpenDesk } | { error: string }> => {
				desk?.keep.stop();
				desk = undefined;
				const opened = await openDesk(sessionId, runOpts());
				if ("error" in opened) return opened;
				const keep = new KeepAlive(() => void touch(sessionId).catch(() => {}), { intervalMs: deps.intervalMs, timers: deps.timers });
				const next: OpenDesk = { ...opened.desk, keep };
				desk = next;
				keep.start();
				return { desk: next };
			})().finally(() => {
				if (opening?.promise === promise) opening = undefined;
			});
			opening = { sessionId, promise };
			return promise;
		};

		pi.on("session_shutdown", () => {
			desk?.keep.stop();
			desk = undefined;
		});

		pi.registerTool({
			name: "computer",
			label: "Computer",
			description:
				"Drive this pi session's own Linux desktop's Chromium, which Eric can watch and use from his phone: open (lease the desk), navigate, screenshot, click (left/right/middle, double), hover, drag, scroll, type, key (any key or Control+Shift+t combo), eval, tabs, wait for a selector, upload a file, release.",
			parameters: Params,

			renderCall(args, theme) {
				let line = theme.fg("toolTitle", theme.bold("computer ")) + theme.fg("muted", String(args.action ?? ""));
				if (args.url) line += ` ${theme.fg("accent", String(args.url))}`;
				if (args.key) line += ` ${theme.fg("accent", String(args.key))}`;
				if (args.selector) line += ` ${theme.fg("accent", capBytes(String(args.selector), 60))}`;
				if (args.path) line += ` ${theme.fg("dim", capBytes(String(args.path), 60))}`;
				if (args.x !== undefined && args.y !== undefined) {
					line += ` ${theme.fg("dim", `${args.x},${args.y}`)}`;
					if (args.toX !== undefined && args.toY !== undefined) line += ` ${theme.fg("dim", `→ ${args.toX},${args.toY}`)}`;
				}
				if (args.expression) line += ` ${theme.fg("dim", capBytes(String(args.expression), 60))}`;
				return new Text(line, 0, 0);
			},

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					const sessionId = sessionOf(ctx);
					if (!sessionId) return text("computer: this tool call has no pi session id.");

					if (params.action === "release") {
						desk?.keep.stop();
						desk = undefined;
						const released = await releaseDesk(sessionId, runOpts());
						if ("error" in released) return text(released.error);
						return text("desk released · its Chromium profile is kept");
					}

					const opened = await ensureDesk(sessionId);
					if ("error" in opened) return text(opened.error);
					const open = opened.desk;

					switch (params.action) {
						case "open":
							return text(`display ${open.display ?? "?"} · ready`);
						case "tabs": {
							const pages = await listTargets(open.cdpSocket);
							return text(JSON.stringify(pages.map(({ id, title, url }) => ({ id, title, url })), null, 2));
						}
						case "navigate": {
							const url = httpUrl(params.url);
							if (!url) return text("computer: navigate takes an http(s) url.");
							const client = await openCdp(open.cdpSocket);
							try {
								await client.send("Page.navigate", { url });
							} finally {
								client.close();
							}
							return text(`navigated to ${url}`);
						}
						case "screenshot": {
							const client = await openCdp(open.cdpSocket);
							try {
								const data = await screenshot(client);
								return { content: [{ type: "image" as const, data, mimeType: "image/png" }], details: { action: "screenshot" } };
							} finally {
								client.close();
							}
						}
						case "click": {
							if (params.x === undefined || params.y === undefined) return text("computer: click needs x and y.");
							const clickCount = params.clickCount ?? 1;
							const client = await openCdp(open.cdpSocket);
							try {
								await click(client, params.x, params.y, { button: params.button as MouseButton | undefined, clickCount });
							} finally {
								client.close();
							}
							const button = (params.button as MouseButton | undefined) ?? "left";
							const what = clickCount === 2 ? "double-clicked" : clickCount === 3 ? "triple-clicked" : "clicked";
							return text(`${what} ${params.x},${params.y}${button === "left" ? "" : ` (${button})`}`);
						}
						case "hover": {
							if (params.x === undefined || params.y === undefined) return text("computer: hover needs x and y.");
							const client = await openCdp(open.cdpSocket);
							try {
								await hover(client, params.x, params.y);
							} finally {
								client.close();
							}
							return text(`hovered ${params.x},${params.y}`);
						}
						case "drag": {
							if (params.x === undefined || params.y === undefined || params.toX === undefined || params.toY === undefined) {
								return text("computer: drag needs x, y, toX and toY.");
							}
							const client = await openCdp(open.cdpSocket);
							try {
								await drag(client, params.x, params.y, { toX: params.toX, toY: params.toY, steps: params.steps });
							} finally {
								client.close();
							}
							return text(`dragged ${params.x},${params.y} → ${params.toX},${params.toY}`);
						}
						case "scroll": {
							const client = await openCdp(open.cdpSocket);
							try {
								return text(await scroll(client, { x: params.x, y: params.y, deltaX: params.deltaX, deltaY: params.deltaY }));
							} finally {
								client.close();
							}
						}
						case "wait": {
							if (!params.selector?.trim()) return text("computer: wait needs a selector.");
							const client = await openCdp(open.cdpSocket);
							try {
								await waitFor(client, params.selector, params.timeoutMs);
							} finally {
								client.close();
							}
							return text(`${params.selector} is in the page`);
						}
						case "upload": {
							if (!params.selector?.trim()) return text("computer: upload needs a selector.");
							if (!params.path?.trim()) return text("computer: upload needs a path to a file on this Mac.");
							const client = await openCdp(open.cdpSocket);
							let backendNodeId: number;
							try {
								// The input is checked before the copy, so a wrong selector leaves no file behind.
								backendNodeId = await fileInputNode(client, params.selector);
							} finally {
								client.close();
							}
							const put = await putFile(sessionId, params.path, runOpts());
							if ("error" in put) return text(put.error);
							// A second connection (the first is closed): the backend node id survives it, a nodeId would not.
							const uploader = await openCdp(open.cdpSocket);
							try {
								await setFileInput(uploader, backendNodeId, put.path);
							} finally {
								uploader.close();
							}
							return text(`uploaded ${params.path} → ${put.path} (${put.bytes} bytes) into ${params.selector}`);
						}
						case "type": {
							if (!params.text) return text("computer: type needs text.");
							const client = await openCdp(open.cdpSocket);
							try {
								await typeText(client, params.text);
							} finally {
								client.close();
							}
							return text(`typed ${params.text.length} characters`);
						}
						case "key": {
							const client = await openCdp(open.cdpSocket);
							let pressed: string;
							try {
								pressed = await pressKey(client, params.key);
							} finally {
								client.close();
							}
							return text(`pressed ${pressed}`);
						}
						case "eval": {
							if (!params.expression?.trim()) return text("computer: eval needs an expression.");
							const client = await openCdp(open.cdpSocket);
							try {
								return text(await evaluate(client, params.expression));
							} finally {
								client.close();
							}
						}
					}
					return text(`computer: unknown action ${JSON.stringify(params.action)}.`);
				} catch (err) {
					return text(`computer: ${oneLine(err)}`);
				}
			},
		});
	};
}

export default optIn("computer", "Drive this session's Botsun Computer (Linux desktop Chromium) from the agent", computerExtension());
