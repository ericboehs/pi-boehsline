/**
 * A minimal RFC 6455 WebSocket client over an existing Unix socket, enough for
 * Chrome DevTools Protocol and nothing more: no extensions, no subprotocols, no
 * TLS.
 *
 * Client → server frames are always masked; server frames are unmasked. A
 * message may arrive in fragments (a continuation chain), and a ping is answered
 * with a pong carrying its payload. No dependencies.
 */

import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** A frame (or fragmented message) larger than this is refused rather than buffered. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export class WsError extends Error {}

export interface Frame {
	fin: boolean;
	opcode: number;
	payload: Buffer;
}

/** What the handshake must answer for this key (`Sec-WebSocket-Accept`). */
export function acceptFor(key: string): string {
	return createHash("sha1").update(key + WS_GUID).digest("base64");
}

export interface EncodeOptions {
	opcode?: number;
	fin?: boolean;
	/** Client frames must mask; tests (and a scripted server) may not. */
	mask?: boolean;
}

/** One frame. Default: a final, masked text frame — what a client sends. */
export function encodeFrame(payload: Buffer | string, options: EncodeOptions = {}): Buffer {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	const opcode = options.opcode ?? OP_TEXT;
	const fin = options.fin ?? true;
	const mask = options.mask ?? true;
	const len = data.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.alloc(2);
		header[1] = len;
	} else if (len < 65_536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
	if (!mask) return Buffer.concat([header, data]);
	header[1] = (header[1] ?? 0) | 0x80;
	const key = randomBytes(4);
	const masked = Buffer.alloc(len);
	for (let i = 0; i < len; i++) masked[i] = (data[i] ?? 0) ^ (key[i % 4] ?? 0);
	return Buffer.concat([header, key, masked]);
}

/** Incremental frame reader: push chunks, take whatever complete frames they hold. */
export class FrameDecoder {
	private buf: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): Frame[] {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		const frames: Frame[] = [];
		for (;;) {
			const frame = this.take();
			if (!frame) return frames;
			frames.push(frame);
		}
	}

	private take(): Frame | null {
		const buf = this.buf;
		if (buf.length < 2) return null;
		const b0 = buf[0] ?? 0;
		const b1 = buf[1] ?? 0;
		if (b0 & 0x70) throw new WsError("websocket: reserved bits set");
		const fin = (b0 & 0x80) !== 0;
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		const short = b1 & 0x7f;
		let offset = 2;
		let length = short;
		if (short === 126) {
			if (buf.length < 4) return null;
			length = buf.readUInt16BE(2);
			offset = 4;
		} else if (short === 127) {
			if (buf.length < 10) return null;
			const big = buf.readBigUInt64BE(2);
			if (big > BigInt(MAX_FRAME_BYTES)) throw new WsError("websocket: frame too large");
			length = Number(big);
			offset = 10;
		}
		if (length > MAX_FRAME_BYTES) throw new WsError("websocket: frame too large");
		let key: Buffer | undefined;
		if (masked) {
			if (buf.length < offset + 4) return null;
			key = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + length) return null;
		const payload = Buffer.from(buf.subarray(offset, offset + length));
		if (key) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0);
		this.buf = buf.subarray(offset + length);
		return { fin, opcode, payload };
	}
}

export interface WsHandlers {
	/** A complete text (or binary, as UTF-8) message. */
	onMessage?: (text: string) => void;
	/** The socket ended (or failed); called once. */
	onClose?: (err?: Error) => void;
}

export interface WsConnectOptions extends WsHandlers {
	socketPath: string;
	/** The request path, e.g. `/devtools/page/ABC`. */
	path: string;
	/** The handshake's Host header (Chrome does not check it). */
	host?: string;
	/** The handshake must finish in this long. Default 10 s. */
	timeoutMs?: number;
}

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_BYTES = 64 * 1024;

function requestFor(path: string, host: string, key: string): string {
	return [
		`GET ${path} HTTP/1.1`,
		`Host: ${host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Key: ${key}`,
		"Sec-WebSocket-Version: 13",
		"",
		"",
	].join("\r\n");
}

function checkHandshake(head: string, key: string): void {
	const lines = head.split("\r\n");
	const status = lines[0] ?? "";
	if (!/^HTTP\/1\.[01] 101\b/.test(status)) throw new WsError(`websocket: handshake refused (${status || "no status line"})`);
	const headers = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(":");
		if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
	}
	if (headers.get("sec-websocket-accept") !== acceptFor(key)) throw new WsError("websocket: bad Sec-WebSocket-Accept");
}

/** One connection; one message stream; close it when the tool call is done. */
export class WsClient {
	private readonly socket: Socket;
	private readonly handlers: WsHandlers;
	private readonly decoder = new FrameDecoder();
	private closed = false;
	private fragOpcode: number | undefined;
	private frag: Buffer[] = [];
	private fragBytes = 0;

	private constructor(socket: Socket, handlers: WsHandlers) {
		this.socket = socket;
		this.handlers = handlers;
		socket.on("data", (chunk: Buffer) => this.feed(chunk));
		socket.on("error", (err: Error) => this.finish(err));
		socket.on("close", () => this.finish());
	}

	static connect(options: WsConnectOptions): Promise<WsClient> {
		return new Promise((resolvePromise, reject) => {
			const socket = connect(options.socketPath);
			const key = randomBytes(16).toString("base64");
			const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
			let settled = false;
			let head = Buffer.alloc(0);
			const timer = setTimeout(() => fail(new WsError("websocket: handshake timed out")), timeoutMs);
			timer.unref?.();
			const fail = (err: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				reject(err);
			};
			const onData = (chunk: Buffer): void => {
				head = Buffer.concat([head, chunk]);
				const end = head.indexOf("\r\n\r\n");
				if (end < 0) {
					if (head.length > MAX_HANDSHAKE_BYTES) fail(new WsError("websocket: handshake too large"));
					return;
				}
				socket.off("data", onData);
				const text = head.subarray(0, end).toString("latin1");
				const rest = head.subarray(end + 4);
				try {
					checkHandshake(text, key);
				} catch (err) {
					fail(err as Error);
					return;
				}
				clearTimeout(timer);
				settled = true;
				const client = new WsClient(socket, options);
				resolvePromise(client);
				if (rest.length) client.feed(rest);
			};
			socket.on("data", onData);
			socket.once("error", fail);
			socket.once("close", () => fail(new WsError("websocket: closed before the handshake")));
			socket.once("connect", () => {
				socket.write(requestFor(options.path, options.host ?? "localhost", key));
			});
		});
	}

	get isClosed(): boolean {
		return this.closed;
	}

	send(text: string): void {
		if (this.closed) throw new WsError("websocket: already closed");
		this.socket.write(encodeFrame(text, { opcode: OP_TEXT }));
	}

	close(code = 1000): void {
		if (this.closed) return;
		const payload = Buffer.alloc(2);
		payload.writeUInt16BE(code, 0);
		this.closed = true;
		this.socket.write(encodeFrame(payload, { opcode: OP_CLOSE }));
		this.socket.end();
		this.handlers.onClose?.();
	}

	private feed(chunk: Buffer): void {
		if (this.closed) return;
		let frames: Frame[];
		try {
			frames = this.decoder.push(chunk);
		} catch (err) {
			this.finish(err as Error);
			return;
		}
		for (const frame of frames) {
			if (this.closed) return;
			this.frame(frame);
		}
	}

	private frame(frame: Frame): void {
		switch (frame.opcode) {
			case OP_CLOSE:
				if (!this.closed) {
					this.closed = true;
					this.socket.write(encodeFrame(frame.payload, { opcode: OP_CLOSE }));
					this.socket.end();
					this.handlers.onClose?.();
				}
				return;
			case OP_PING:
				this.socket.write(encodeFrame(frame.payload, { opcode: OP_PONG }));
				return;
			case OP_PONG:
				return;
			case OP_CONTINUATION: {
				if (this.fragOpcode === undefined) {
					this.finish(new WsError("websocket: continuation without a message"));
					return;
				}
				this.frag.push(frame.payload);
				this.fragBytes += frame.payload.length;
				if (this.fragBytes > MAX_FRAME_BYTES) {
					this.finish(new WsError("websocket: message too large"));
					return;
				}
				if (frame.fin) {
					const opcode = this.fragOpcode;
					const data = Buffer.concat(this.frag);
					this.fragOpcode = undefined;
					this.frag = [];
					this.fragBytes = 0;
					if (opcode === OP_TEXT || opcode === OP_BINARY) this.handlers.onMessage?.(data.toString("utf8"));
				}
				return;
			}
			case OP_TEXT:
			case OP_BINARY:
				if (this.fragOpcode !== undefined) {
					this.finish(new WsError("websocket: a new message inside a fragmented one"));
					return;
				}
				if (frame.fin) {
					this.handlers.onMessage?.(frame.payload.toString("utf8"));
				} else {
					this.fragOpcode = frame.opcode;
					this.frag = [frame.payload];
					this.fragBytes = frame.payload.length;
				}
				return;
			default:
				this.finish(new WsError(`websocket: unknown opcode ${frame.opcode}`));
		}
	}

	private finish(err?: Error): void {
		if (this.closed) return;
		this.closed = true;
		// A protocol error ends the connection too: never leave the socket open behind it.
		if (err) this.socket.destroy();
		this.handlers.onClose?.(err);
	}
}
