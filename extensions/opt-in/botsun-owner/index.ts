// Report this interactive session's state to Botsun over a local Unix socket
// (protocol: botsun-owner v1, client side). Botsun's web process listens; we
// only ever write newline-delimited JSON to it: hello on every (re)connect with
// the full current state, then busy/idle/prompt/prompt_end/session/bye.
//
// T2, reply as Eric: each session also listens on its own owner socket
// (~/.local/state/botsun/owner/<pid>.sock, 0600). Botsun asks it for a nonce,
// the phone signs the reply with its Secure Enclave key, and this session
// checks the signature itself against the paired devices' public keys
// (owner-keys.json, written by Botsun) before the text goes in as Eric's own
// message. A stolen Botsun token or a peer agent can't speak as Eric here.
//
// Best effort throughout: a missing socket or a refused connection is normal
// (Botsun not running), so it retries quietly with backoff and never logs
// unless BOTSUN_OWNER_DEBUG is set. Every timer and the socket are unref'd,
// so nothing here keeps pi alive.

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { optIn } from "../../../lib/opt-in.ts";
import { canonicalAnswer, onPromptsChange, openPrompts, type RemotePrompt } from "../../../lib/remote-prompts.ts";
import { onStashChange, pushStash, stashStack, takeStash } from "../../../lib/stash-store.ts";
import { latestFooter, onFooterChange, tapFooter, type FooterChip } from "../../../lib/footer-snapshot.ts";

type PromptKind = "select" | "confirm" | "input" | "editor" | "custom";
interface Prompt { kind: PromptKind; title: string }
type UserContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface Image { data: string; mime_type: string }
interface File { name: string; data: string }

const TITLE_MAX = 500;
const NAME_MAX = 200;
const RETRY_MAX_MS = 60_000;
/** How long a connection handed over by session_shutdown (new/resume/fork/reload) waits for the next session_start. */
const HANDOFF_MS = 10_000;
const STORE = Symbol.for("botsun-owner.v1");
const NONCE_TTL_MS = 120_000;
const NONCES_MAX = 16;
const REQUEST_MAX = 24 * 1024 * 1024; // a reply with up to IMAGES_MAX photos, base64
const IMAGES_MAX = 4;
const IMAGE_B64_MAX = 5 * 1024 * 1024;
const FILE_B64_MAX = 14 * 1024 * 1024; // ~10 MB a file
const ATTACH_MAX = 4;
export const inboxDir = (): string => process.env.BOTSUN_OWNER_INBOX || join(homedir(), ".local", "state", "botsun", "inbox");
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/heic", "image/webp", "image/gif"]);
const TEXT_MAX = 20_000;
/** DER prefix that turns a 65-byte uncompressed P-256 point into an SPKI key. */
/** Streaming text to Botsun: at most this often, and at most this much (the end is kept). */
const STREAM_EVERY_MS = 250;
const STREAM_MAX = 20_000;
const P256_SPKI = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

/**
 * One connection per process, kept on globalThis: /new, /resume, /fork and
 * /reload tear this extension instance down and load a fresh one, but it's the
 * same pid, so the connection carries over and the server gets a `session`
 * line instead of a bye + hello.
 */
interface Conn {
	sock?: Socket;
	connected: boolean;
	closed: boolean;
	retryTimer?: ReturnType<typeof setTimeout>;
	handoffTimer?: ReturnType<typeof setTimeout>;
	delay: number;
	busy: boolean;
	prompt: Prompt | null;
	promptDepth: number;
	cwd: string;
	sessionFile: string | null;
	sessionId: string | null;
	/** Fallback name source: the pi session name, read lazily. */
	sessionName: () => string | undefined;
	/** The model on screen ("Claude Opus 5.5") and its thinking level, for the phone's header. */
	model: { name: string; provider: string; id?: string; thinking?: string } | null;
	/** The models the phone's picker offers; read lazily. */
	models?: () => PhoneModel[];
	/** Context use now ({tokens, window, percent}); read lazily. */
	context?: () => PhoneContext | null;
	/** The owner socket (T2) and its outstanding nonces (value: expiry ms). */
	server?: Server;
	nonces: Map<string, number>;
	/** Sends a user message through the current extension instance's pi. */
	inject: (content: string | UserContent[], busy: boolean) => void;
	/** Runs a slash command from the phone: undefined = not one (send as text), null = ran, string = why not. */
	command?: (text: string, busy: boolean) => string | null | undefined;
	/** The commands the phone can run here, for its "/" list; read lazily. */
	commands?: () => PhoneCommand[];
}

const store = globalThis as unknown as { [STORE]?: Conn };

export const sockPath = (): string =>
	process.env.BOTSUN_OWNER_SOCK || join(homedir(), ".local", "state", "botsun", "owner.sock");

export const ownerDir = (): string => process.env.BOTSUN_OWNER_DIR || join(homedir(), ".local", "state", "botsun", "owner");
export const keysPath = (): string =>
	process.env.BOTSUN_OWNER_KEYS || join(homedir(), ".local", "state", "botsun", "owner-keys.json");
const ownerSock = (): string => join(ownerDir(), `${process.pid}.sock`);

const sha256hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/**
 * The message the phone signs: the same shape as Botsun's signed decisions. Text only: decision
 * "say" over sha256(text). With photos: "say_images" over sha256(text) and each photo's sha256,
 * one per line, so neither can be swapped or dropped under the same signature.
 */
export function ownerMessage(deviceId: string, nonce: string, sessionId: string, text: string, images: Image[] = [],
	files: File[] = []): Buffer {
	const textHash = sha256hex(Buffer.from(text, "utf8"));
	let decision = "say";
	let digest = textHash;
	if (files.length) {
		// "say_attach": sha256(text), then "image <sha256>" per photo, "file <sha256(name)> <sha256(data)>" per file.
		decision = "say_attach";
		digest = sha256hex([textHash, ...images.map((i) => `image ${sha256hex(Buffer.from(i.data, "base64"))}`),
			...files.map((f) => `file ${sha256hex(Buffer.from(f.name, "utf8"))} ${sha256hex(Buffer.from(f.data, "base64"))}`)].join("\n"));
	} else if (images.length) {
		decision = "say_images";
		digest = sha256hex([textHash, ...images.map((i) => sha256hex(Buffer.from(i.data, "base64")))].join("\n"));
	}
	return Buffer.from(["botsun-decide-v1", deviceId, nonce, "session", sessionId, decision, digest].join("\n"), "utf8");
}

function filesOf(raw: unknown): File[] | string {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw) || raw.length > ATTACH_MAX) return `at most ${ATTACH_MAX} attachments`;
	for (const f of raw) {
		if (!f || typeof f.name !== "string" || typeof f.data !== "string") return "bad file";
		if (!f.name.trim() || f.name.length > 200 || /[\/\0]/.test(f.name) || f.name.startsWith(".")) return "bad file name";
		if (f.data.length > FILE_B64_MAX || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return "a file is too big (10 MB) or not base64";
	}
	return raw as File[];
}

/** Saves attached files where the agent can read them: inbox/<pid>/<time>-<name>, 0600. */
function saveFiles(files: File[]): string[] {
	if (!files.length) return [];
	const dir = join(inboxDir(), String(process.pid));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return files.map((f, i) => {
		const path = join(dir, `${stamp}-${i}-${f.name}`);
		const data = Buffer.from(f.data, "base64");
		writeFileSync(path, data, { mode: 0o600, flag: "wx" });
		const kb = data.length < 1024 ? `${data.length} B` : data.length < 1048576 ? `${Math.round(data.length / 1024)} KB` : `${(data.length / 1048576).toFixed(1)} MB`;
		return `📎 Attached: ${path} (${kb})`;
	});
}

function imagesOf(raw: unknown): Image[] | string {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw) || raw.length > IMAGES_MAX) return `at most ${IMAGES_MAX} photos`;
	for (const i of raw) {
		if (!i || typeof i.data !== "string" || typeof i.mime_type !== "string") return "bad photo";
		if (!IMAGE_TYPES.has(i.mime_type)) return "photos must be JPEG, PNG, HEIC, WebP or GIF";
		if (!i.data || i.data.length > IMAGE_B64_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) return "a photo is too big or not base64";
	}
	return raw as Image[];
}

/**
 * Paired devices' raw public keys from Botsun's file; refuses a file others could have written.
 * kind "call": the phone's call key, which signs a call's audio (T5).
 */
function deviceKey(deviceId: string, kind: "decide" | "call" = "decide"): Buffer | null {
	const path = keysPath();
	const st = lstatSync(path);
	if (!st.isFile() || (st.mode & 0o022) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
		throw new Error("owner-keys.json must be a regular file only Eric can write");
	}
	const file = JSON.parse(readFileSync(path, "utf8"));
	const raw = (kind === "call" ? file?.call_devices : file?.devices)?.[deviceId];
	if (typeof raw !== "string") return null;
	const key = Buffer.from(raw, "base64");
	return key.length === 65 && key[0] === 4 ? key : null;
}

function takeNonce(c: Conn, nonce: string): boolean {
	const now = Date.now();
	for (const [n, exp] of c.nonces) if (exp <= now) c.nonces.delete(n);
	const exp = c.nonces.get(nonce);
	c.nonces.delete(nonce);
	return exp !== undefined && exp > now;
}

function newNonce(c: Conn): string {
	const nonce = randomBytes(24).toString("base64url");
	c.nonces.set(nonce, Date.now() + NONCE_TTL_MS);
	while (c.nonces.size > NONCES_MAX) c.nonces.delete(c.nonces.keys().next().value as string);
	return nonce;
}

/** One request line → one reply object. Exported for tests. */
export function handleOwnerRequest(c: Conn, req: unknown): Record<string, unknown> | Promise<Record<string, unknown>> {
	if (!req || typeof req !== "object") return { error: "bad request" };
	const r = req as Record<string, unknown>;
	if (r.type === "nonce") {
		if (!c.sessionId) return { error: "this session has no id yet" };
		// What this version takes, so Botsun can say "reload it" instead of a failed signature.
		const hasStash = (() => {
			try { return c.commands?.().some((x) => x.name === "stash") ?? false; } catch { return false; }
		})();
		return { nonce: newNonce(c), session_id: c.sessionId,
			features: ["say", "images", "files", "say_audio", "stream", "ask", ...(hasStash ? ["stash"] : [])] };
	}
	if (r.type === "say_audio") return sayAudio(c, r);
	if (r.type === "answer") return answerAsk(c, r);
	if (r.type === "stash") return stashRequest(c, r);
	// Display only (a chip's mode, as a click on the footer flips it): not signed, nothing acts.
	if (r.type === "footer_tap") return footerTap(String(r.chip ?? ""));
	if (r.type !== "say") return { error: "unknown request" };
	const { text, nonce, signature } = r;
	const deviceId = typeof r.device_id === "number" || typeof r.device_id === "string" ? String(r.device_id) : "";
	const images = imagesOf(r.images);
	if (typeof images === "string") return { error: images };
	const files = filesOf(r.files);
	if (typeof files === "string") return { error: files };
	if (images.length + files.length > ATTACH_MAX) return { error: `at most ${ATTACH_MAX} attachments` };
	if (typeof text !== "string" || text.length > TEXT_MAX || (!text.trim() && !images.length && !files.length)) {
		return { error: "text must be 1 to 20000 characters (or attach something)" };
	}
	if (typeof nonce !== "string" || typeof signature !== "string" || !/^\d{1,12}$/.test(deviceId)) return { error: "bad request" };
	if (!c.sessionId) return { error: "this session has no id yet" };
	// The nonce is spent whatever happens next: one try per nonce.
	if (!takeNonce(c, nonce)) return { error: "nonce is expired or used" };
	let key: Buffer | null;
	try {
		key = deviceKey(deviceId);
	} catch (e) {
		return { error: (e as Error).message.startsWith("owner-keys") ? (e as Error).message : "no device keys" };
	}
	if (!key) return { error: "unknown device" };
	let ok = false;
	try {
		const pub = createPublicKey({ key: Buffer.concat([P256_SPKI, key]), format: "der", type: "spki" });
		ok = verifySignature("sha256", ownerMessage(deviceId, nonce, c.sessionId, text, images, files), { key: pub, dsaEncoding: "der" },
			Buffer.from(signature, "base64"));
	} catch {}
	if (!ok) return { error: "signature does not verify" };
	let notes: string[];
	try {
		notes = saveFiles(files);
	} catch (e) {
		return { error: `couldn't save the file: ${(e as NodeJS.ErrnoException).code ?? "error"}` };
	}
	if (!images.length && !notes.length && c.command) {
		const outcome = c.command(text, c.busy);
		if (typeof outcome === "string") return { error: outcome };
		if (outcome === null) {
			debug("owner say ran a slash command");
			return { ok: true, delivered: "command" };
		}
	}
	const said = [text, ...notes].filter((t) => t.trim()).join("\n\n");
	const content: string | UserContent[] = images.length
		? [...(said.trim() ? [{ type: "text" as const, text: said }] : []), ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mime_type }))]
		: said;
	c.inject(content, c.busy);
	debug(`owner say accepted (${text.length} chars, ${images.length} photos, ${files.length} files)`); // never the text
	return { ok: true, delivered: c.busy ? "steer" : "prompt" };
}

/**
 * T5, a call into this session: Eric's utterance, transcribed by Botsun. The phone signed the
 * audio (its sha256) and this session's nonce with its call key; the words go in as his.
 */
function sayAudio(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const { text, nonce, signature, wav_sha256: wav } = r;
	const deviceId = typeof r.device_id === "number" || typeof r.device_id === "string" ? String(r.device_id) : "";
	if (typeof text !== "string" || !text.trim() || text.length > TEXT_MAX) return { error: "nothing was said" };
	if (typeof nonce !== "string" || typeof signature !== "string" || typeof wav !== "string" || !/^[0-9a-f]{64}$/.test(wav) ||
		!/^\d{1,12}$/.test(deviceId)) return { error: "bad request" };
	if (!c.sessionId) return { error: "this session has no id yet" };
	if (!takeNonce(c, nonce)) return { error: "nonce is expired or used" };
	let key: Buffer | null;
	try {
		key = deviceKey(deviceId, "call");
	} catch (e) {
		return { error: (e as Error).message.startsWith("owner-keys") ? (e as Error).message : "no device keys" };
	}
	if (!key) return { error: "unknown device" };
	let ok = false;
	try {
		const pub = createPublicKey({ key: Buffer.concat([P256_SPKI, key]), format: "der", type: "spki" });
		const msg = Buffer.from(["botsun-decide-v1", deviceId, nonce, "session", c.sessionId, "say_audio", wav].join("\n"), "utf8");
		ok = verifySignature("sha256", msg, { key: pub, dsaEncoding: "der" }, Buffer.from(signature, "base64"));
	} catch {}
	if (!ok) return { error: "signature does not verify" };
	c.inject(text, c.busy);
	debug(`owner say_audio accepted (${text.length} chars)`);
	return { ok: true, delivered: c.busy ? "steer" : "prompt" };
}

/**
 * T3: Eric answers an `ask` question from the phone. Signed with the decision key over the
 * prompt id and his picks (canonicalAnswer), checked here, then handed to the waiting tool.
 */
function answerAsk(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const { nonce, signature, ask_id: id, answers } = r;
	const deviceId = typeof r.device_id === "number" || typeof r.device_id === "string" ? String(r.device_id) : "";
	if (typeof nonce !== "string" || typeof signature !== "string" || typeof id !== "string" || !Array.isArray(answers) ||
		!/^\d{1,12}$/.test(deviceId)) return { error: "bad request" };
	if (!c.sessionId) return { error: "this session has no id yet" };
	if (!takeNonce(c, nonce)) return { error: "nonce is expired or used" };
	const prompt = openPrompts().find((p) => p.id === id);
	if (!prompt) return { error: "that question was already answered" };
	let key: Buffer | null;
	try {
		key = deviceKey(deviceId);
	} catch (e) {
		return { error: (e as Error).message.startsWith("owner-keys") ? (e as Error).message : "no device keys" };
	}
	if (!key) return { error: "unknown device" };
	let ok = false;
	try {
		const digest = sha256hex(Buffer.from(canonicalAnswer(id, answers as never), "utf8"));
		const msg = Buffer.from(["botsun-decide-v1", deviceId, nonce, "session", c.sessionId, "answer", digest].join("\n"), "utf8");
		const pub = createPublicKey({ key: Buffer.concat([P256_SPKI, key]), format: "der", type: "spki" });
		ok = verifySignature("sha256", msg, { key: pub, dsaEncoding: "der" }, Buffer.from(signature, "base64"));
	} catch {}
	if (!ok) return { error: "signature does not verify" };
	const error = prompt.answer(answers as never);
	return error ? { error } : { ok: true };
}

/**
 * The phone works with this session's message stash (the stash extension's stack): push a draft,
 * take one back into its message box, or drop one. Signed with the decision key over
 * "push\n<sha256(text)>", "take\n<id>" or "drop\n<id>".
 */
function stashRequest(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const { op, nonce, signature } = r;
	const deviceId = typeof r.device_id === "number" || typeof r.device_id === "string" ? String(r.device_id) : "";
	const text = typeof r.text === "string" ? r.text : "";
	const id = typeof r.id === "string" ? r.id : "";
	if (op !== "push" && op !== "take" && op !== "drop") return { error: "bad request" };
	if (op === "push" && (!text.trim() || text.length > TEXT_MAX)) return { error: "nothing to stash" };
	if (op !== "push" && !/^[\w-]{1,40}$/.test(id)) return { error: "bad request" };
	if (typeof nonce !== "string" || typeof signature !== "string" || !/^\d{1,12}$/.test(deviceId)) return { error: "bad request" };
	if (!c.sessionId) return { error: "this session has no id yet" };
	if (!takeNonce(c, nonce)) return { error: "nonce is expired or used" };
	let key: Buffer | null;
	try {
		key = deviceKey(deviceId);
	} catch (e) {
		return { error: (e as Error).message.startsWith("owner-keys") ? (e as Error).message : "no device keys" };
	}
	if (!key) return { error: "unknown device" };
	const payload = op === "push" ? `push\n${sha256hex(Buffer.from(text, "utf8"))}` : `${op}\n${id}`;
	let ok = false;
	try {
		const msg = Buffer.from(["botsun-decide-v1", deviceId, nonce, "session", c.sessionId, "stash",
			sha256hex(Buffer.from(payload, "utf8"))].join("\n"), "utf8");
		const pub = createPublicKey({ key: Buffer.concat([P256_SPKI, key]), format: "der", type: "spki" });
		ok = verifySignature("sha256", msg, { key: pub, dsaEncoding: "der" }, Buffer.from(signature, "base64"));
	} catch {}
	if (!ok) return { error: "signature does not verify" };
	if (op === "push") return { ok: true, id: pushStash(c.sessionId, text).id };
	const entry = takeStash(c.sessionId, id);
	if (!entry) return { error: "that stash is gone" };
	return op === "take" ? { ok: true, text: entry.text } : { ok: true };
}

function listenOwner(c: Conn): void {
	if (c.server || c.closed) return;
	const path = ownerSock();
	try {
		mkdirSync(ownerDir(), { recursive: true, mode: 0o700 });
		chmodSync(ownerDir(), 0o700);
		try { unlinkSync(path); } catch {}
	} catch (e) {
		debug(`owner socket dir: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
		return;
	}
	const server = createServer((sock) => {
		sock.setTimeout(5_000, () => sock.destroy());
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		sock.on("data", (chunk: Buffer) => {
			if (done) return;
			size += chunk.length;
			if (size > REQUEST_MAX) { done = true; sock.destroy(); return; }
			chunks.push(chunk);
			if (!chunk.includes(10)) return; // only the new chunk is searched for the newline
			done = true;
			const all = Buffer.concat(chunks);
			const line = all.subarray(0, all.indexOf(10)).toString("utf8");
			let reply: Record<string, unknown> | Promise<Record<string, unknown>>;
			try {
				reply = handleOwnerRequest(c, JSON.parse(line));
			} catch {
				reply = { error: "bad request" };
			}
			Promise.resolve(reply)
				.catch(() => ({ error: "bad request" }))
				.then((r) => sock.end(`${JSON.stringify(r)}\n`));
		});
		sock.on("error", () => {});
	});
	server.on("error", (e) => debug(`owner socket: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
	server.listen(path, () => {
		try { chmodSync(path, 0o600); } catch {}
	});
	server.unref();
	c.server = server;
}

function closeOwner(c: Conn): void {
	const server = c.server;
	c.server = undefined;
	c.nonces?.clear();
	if (!server) return;
	try { server.close(); } catch {}
	try { unlinkSync(ownerSock()); } catch {}
}

/** The footer chips the phone shows (Eric's pick): no model, provider or name, which it has. */
const PHONE_FOOTER = new Set(["dir", "worktree", "git", "context", "cost", "usage", "rate", "timers"]);

/** The footer's chips as painted (footer.json order and modes), for the phone's chip row. */
export function footerLine(): FooterChip[] {
	return latestFooter()
		.filter((c) => PHONE_FOOTER.has(c.id))
		.slice(0, 16)
		.map((c) => ({ id: c.id, segments: c.segments.slice(0, 12).map((s) => ({ ...s, text: s.text.slice(0, 80) })) }));
}

/**
 * A chip tap: the footer flips it and repaints; the reply waits for that repaint (briefly) and
 * carries the new row, so the phone shows it at once instead of on the next throttled send.
 */
function footerTap(chip: string): Record<string, unknown> | Promise<Record<string, unknown>> {
	if (!tapFooter(chip)) return { error: "that chip doesn't flip" };
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			stop();
			resolve({ ok: true, footer: footerLine() });
		};
		const stop = onFooterChange(done);
		const timer = setTimeout(done, 400);
	});
}

const STASH_TEXT_MAX = 4000;

/** The session's message stash as the phone shows it (oldest first, the top last). */
export function stashLine(c: Pick<Conn, "sessionId">): { id: string; text: string; ts: number }[] {
	if (!c.sessionId) return [];
	return stashStack(c.sessionId).slice(-50).map((e) => ({ id: e.id, text: e.text.slice(0, STASH_TEXT_MAX), ts: e.ts }));
}

/** The newest question a tool (ask) has open, as Botsun shows it; null when none. */
function askLine(): { id: string; questions: RemotePrompt["questions"] } | null {
	const open = openPrompts();
	const p = open[open.length - 1];
	return p ? { id: p.id, questions: p.questions } : null;
}

const retryBase = (): number => {
	const n = Number(process.env.BOTSUN_OWNER_RETRY_MS); // test knob
	return Number.isFinite(n) && n > 0 ? n : 5_000;
};

function debug(msg: string): void {
	if (!process.env.BOTSUN_OWNER_DEBUG) return;
	try {
		appendFileSync(join(homedir(), ".local", "state", "botsun", "owner-client.log"), `${new Date().toISOString()} ${process.pid} ${msg}\n`);
	} catch {}
}

/** agent-link's name for this pid, else the pi session name, else the folder. */
function currentName(c: Conn): string {
	let name: string | undefined;
	try {
		const raw = JSON.parse(readFileSync(join(homedir(), ".claude", "sessions", `${process.pid}.json`), "utf8"));
		if (typeof raw?.name === "string" && raw.name.trim()) name = raw.name.trim();
	} catch {}
	if (!name) {
		try { name = c.sessionName()?.trim() || undefined; } catch {}
	}
	return (name || basename(c.cwd) || c.cwd).slice(0, NAME_MAX);
}

function write(c: Conn, type: string, extra: Record<string, unknown> = {}): void {
	if (!c.connected || !c.sock) return;
	const line = JSON.stringify({ v: 1, type, pid: process.pid, at: new Date().toISOString(), name: currentName(c), ...extra });
	try { c.sock.write(`${line}\n`); } catch {}
}

// A compaction under way (its reason): pi refuses a prompt mid-compaction, so the phone's words
// wait for it to end (held in main), and the phone shows it.
let compacting: string | null = null;
// Whether the approval guardian is bypassed (its state event), for the phone's red title.
let bypassed = false;
const GUARDIAN_BYPASS_STATE_EVENT = "approval-guardian:temporary-bypass-state";
const GUARDIAN_BYPASS_CONTROL_EVENT = "approval-guardian:set-temporary-bypass";

function sendHello(c: Conn): void {
	write(c, "hello", {
		cwd: c.cwd,
		session_file: c.sessionFile,
		session_id: c.sessionId,
		busy: c.busy,
		prompt: c.prompt,
		model: c.model,
		ask: askLine(),
		commands: (() => {
			try { return c.commands?.() ?? []; } catch { return []; }
		})(),
		models: (() => {
			try { return c.models?.() ?? []; } catch { return []; }
		})(),
		stash: stashLine(c),
		footer: footerLine(),
		compacting,
		bypass: bypassed,
		context: (() => {
			try { return c.context?.() ?? null; } catch { return null; }
		})(),
	});
}

function scheduleRetry(c: Conn): void {
	if (c.closed || c.retryTimer) return;
	const wait = c.delay;
	c.delay = Math.min(c.delay * 2, RETRY_MAX_MS);
	debug(`retry in ${wait}ms`);
	c.retryTimer = setTimeout(() => {
		c.retryTimer = undefined;
		connect(c);
	}, wait);
	c.retryTimer.unref();
}

function connect(c: Conn): void {
	if (c.closed || c.sock) return;
	let sock: Socket;
	try {
		sock = createConnection(sockPath());
	} catch {
		scheduleRetry(c);
		return;
	}
	c.sock = sock;
	sock.unref();
	sock.on("connect", () => {
		if (c.sock !== sock) return;
		c.connected = true;
		c.delay = retryBase();
		debug("connected");
		sendHello(c);
	});
	// The server never writes in v1; drain anything so the socket can't stall.
	sock.on("data", () => {});
	sock.on("error", (err) => debug(`socket error: ${(err as NodeJS.ErrnoException).code ?? err.message}`));
	sock.on("close", () => {
		if (c.sock !== sock) return;
		c.sock = undefined;
		c.connected = false;
		scheduleRetry(c);
	});
}

/** Stop for good: bye if connected, end the socket, clear timers. */
function close(c: Conn): void {
	if (c.closed) return;
	write(c, "bye");
	c.closed = true;
	clearTimeout(c.retryTimer);
	clearTimeout(c.handoffTimer);
	c.retryTimer = c.handoffTimer = undefined;
	const sock = c.sock;
	c.sock = undefined;
	c.connected = false;
	if (sock) {
		try { sock.end(); } catch {}
		// end() waits on the peer; don't let a stuck server hold the fd.
		setTimeout(() => sock.destroy(), 1_000).unref();
	}
	closeOwner(c);
	if (store[STORE] === c) delete store[STORE];
}

/** pi's built-ins: the TUI handles them, so an extension can't run them as typed. */
const BUILTINS = new Set(["settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
	"name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "cd", "compact", "resume",
	"reload", "quit"]);
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** "/name args" as a command; a path like /Users/x is not one. Pure for tests. */
export function slashCommand(text: string): { name: string; args: string } | null {
	const m = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return m ? { name: m[1]!, args: (m[2] ?? "").trim() } : null;
}

type ModelLike = { provider: string; id: string; name?: string };

/** The one model "/model <query>" means: provider/id, then id, then a unique partial match. Pure for tests. */
export function findModel<M extends ModelLike>(models: M[], query: string): M | string {
	const q = query.toLowerCase();
	const exact = models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === q) ?? models.find((m) => m.id.toLowerCase() === q);
	if (exact) return exact;
	const hits = models.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q));
	if (hits.length === 1) return hits[0]!;
	if (hits.length === 0) return `no model matches "${query}"`;
	return `"${query}" matches ${hits.length} models: ${hits.slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ")}${hits.length > 5 ? ", …" : ""}`;
}

/**
 * Slash commands from the phone. Extension commands, prompt templates and skills run as typed;
 * of pi's built-ins, /compact, /model, /thinking and /name are rebuilt on the extension API, and
 * the rest (pickers, /reload, /new…) need the keyboard.
 */
export interface PhoneCommand {
	name: string;
	description?: string;
	hint?: string;
}

/** The built-ins runCommand rebuilds, as the phone lists them. */
const PHONE_BUILTINS: PhoneCommand[] = [
	{ name: "compact", description: "Compact the session context", hint: "[notes]" },
	{ name: "model", description: "Switch model", hint: "<name>" },
	{ name: "thinking", description: "Set the thinking level", hint: THINKING.join("|") },
	{ name: "name", description: "Rename the session", hint: "<name>" },
];

/** What the phone's "/" list shows: those built-ins, then extension commands, templates, skills. */
export function phoneCommands(pi: Pick<ExtensionAPI, "getCommands">): PhoneCommand[] {
	const seen = new Set(PHONE_BUILTINS.map((c) => c.name));
	const rest = pi.getCommands()
		.filter((c) => !seen.has(c.name) && !BUILTINS.has(c.name) && /^[A-Za-z][\w:.-]*$/.test(c.name))
		.map((c) => ({ name: c.name.slice(0, 64), ...(c.description ? { description: c.description.slice(0, 160) } : {}) }));
	return [...PHONE_BUILTINS, ...rest].slice(0, 300);
}

function runCommand(pi: ExtensionAPI, ctx: ExtensionContext, text: string, busy: boolean): string | null | undefined {
	const cmd = slashCommand(text);
	if (!cmd) return undefined;
	const { name, args } = cmd;
	const wait = `wait for the turn to finish before /${name}`;
	if (name === "compact") {
		if (busy) return wait;
		ctx.compact({
			...(args ? { customInstructions: args } : {}),
			onError: (e) => ctx.ui.notify(`Compaction from the phone failed: ${e.message}`, "error"),
		});
		return null;
	}
	if (name === "model") {
		if (!args) return "say which model, e.g. /model opus (the picker needs the keyboard)";
		const found = findModel(ctx.modelRegistry.getAvailable() as ModelLike[], args);
		if (typeof found === "string") return found;
		pi.setModel(found as never).then(
			(ok) => { if (!ok) ctx.ui.notify(`No API key for ${found.provider}/${found.id}`, "error"); },
			() => {},
		);
		return null;
	}
	if (name === "thinking") {
		if (!THINKING.includes(args)) return `say a level: /thinking ${THINKING.join("|")}`;
		pi.setThinkingLevel(args as never);
		return null;
	}
	if (name === "name") {
		if (!args) return "say the name: /name <name>";
		pi.setSessionName(args.slice(0, 200));
		return null;
	}
	if (name === "bypass") {
		// Signed like every phone command (the say path checks it first); the guardian's own
		// control event, not quiet, so the terminal shows its warning. Mid-turn is fine.
		if (args !== "on" && args !== "off") return "say /bypass on or /bypass off";
		const request = { active: args === "on", quiet: false, handled: false };
		pi.events?.emit(GUARDIAN_BYPASS_CONTROL_EVENT, request);
		return request.handled ? null : "no approval guardian here to bypass";
	}
	if (BUILTINS.has(name)) return `/${name} only works at the keyboard`;
	if (pi.getCommands().some((c) => c.name === name)) {
		if (busy) return wait;
		pi.sendUserMessage(text.trim(), { expandPromptTemplates: true });
		return null;
	}
	return undefined; // not a command pi knows: plain text, as typing it would send
}

export interface PhoneContext {
	tokens: number | null;
	window: number;
	percent: number | null;
}

/** pi's context use, for the phone's info sheet; null when pi has no model yet. */
export function phoneContext(ctx: Pick<ExtensionContext, "getContextUsage">): PhoneContext | null {
	const u = ctx.getContextUsage();
	if (!u || !Number.isFinite(u.contextWindow) || u.contextWindow <= 0) return null;
	return { tokens: u.tokens ?? null, window: u.contextWindow, percent: u.percent == null ? null : Math.round(u.percent) };
}

export interface PhoneModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
}

/** The models pi can use here (auth configured), for the phone's picker. */
export function phoneModels(ctx: Pick<ExtensionContext, "modelRegistry">): PhoneModel[] {
	return (ctx.modelRegistry.getAvailable() as Array<{ provider: string; id: string; name?: string; reasoning?: boolean }>)
		.slice(0, 120)
		.map((m) => ({ provider: String(m.provider).slice(0, 80), id: String(m.id).slice(0, 120), name: String(m.name || m.id).slice(0, 80), reasoning: m.reasoning === true }));
}

function modelOf(ctx: ExtensionContext, model?: unknown, thinking?: string): Conn["model"] {
	const m = (model ?? (ctx as { model?: unknown }).model) as { name?: string; id?: string; provider?: string } | undefined;
	if (!m || (!m.name && !m.id)) return null;
	const level = thinking ?? ((ctx as { thinkingLevel?: string }).thinkingLevel || undefined);
	return {
		name: String(m.name || m.id).slice(0, 80),
		provider: String(m.provider ?? "").slice(0, 80),
		...(m.id ? { id: String(m.id).slice(0, 120) } : {}),
		...(level ? { thinking: level } : {}),
	};
}

function sessionInfo(ctx: ExtensionContext): { cwd: string; sessionFile: string | null; sessionId: string | null } {
	const sm = ctx.sessionManager;
	let sessionFile: string | null = null;
	let sessionId: string | null = null;
	try { sessionFile = sm.getSessionFile() ?? null; } catch {}
	try { sessionId = sm.getSessionId() ?? null; } catch {}
	return { cwd: ctx.cwd, sessionFile, sessionId };
}

function main(pi: ExtensionAPI): void {
	// Subagent children are not Eric's sessions.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let conn: Conn | undefined;
	let held: Array<string | UserContent[]> = [];

	// The guardian's bypass, as it announces it (on start and on each change): the phone shows it.
	pi.events?.on(GUARDIAN_BYPASS_STATE_EVENT, (state: unknown) => {
		bypassed = (state as { active?: unknown } | undefined)?.active === true;
		if (conn && !conn.closed) try { write(conn, "bypass", { active: bypassed }); } catch {}
	});

	pi.on("session_start", (_event, ctx) => {
		// Interactive TUI only: print/json have no UI, and Botsun drives its own
		// pi over RPC (hasUI is true there), which must not report itself.
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const info = sessionInfo(ctx);
		const sessionName = () => pi.getSessionName();
		// Eric's own words, as if typed: steer into a running turn, else start one.
		const inject = (content: string | UserContent[], busy: boolean) => {
			if (compacting) held.push(content);
			else pi.sendUserMessage(content, busy ? { deliverAs: "steer" } : undefined);
		};
		const command = (text: string, busy: boolean) =>
			compacting && /^\//.test(text.trim()) && !/^\/(model|thinking|name|bypass)\b/.test(text.trim()) ? "wait for the compaction to finish" : runCommand(pi, ctx, text, busy);
		const commands = () => phoneCommands(pi);
		const models = () => phoneModels(ctx);
		const context = () => phoneContext(ctx);
		const prev = store[STORE];
		if (prev && !prev.closed) {
			// Same pid, new extension instance: reuse the connection.
			clearTimeout(prev.handoffTimer);
			prev.handoffTimer = undefined;
			conn = prev;
			conn.sessionName = sessionName;
			conn.inject = inject;
			conn.command = command;
			conn.commands = commands;
			conn.models = models;
			conn.context = context;
			// A connection made by an older version of this extension (T1, before /reload) has
			// no nonce map or owner socket yet: upgrade it in place.
			conn.nonces ??= new Map();
			conn.nonces.clear(); // a nonce was for the session it was issued in
			listenOwner(conn);
			const changed = info.sessionFile !== conn.sessionFile || info.sessionId !== conn.sessionId || info.cwd !== conn.cwd;
			Object.assign(conn, info);
			const model = modelOf(ctx);
			if (JSON.stringify(model) !== JSON.stringify(conn.model)) {
				conn.model = model;
				write(conn, "model", { model });
			}
			if (changed) write(conn, "session", { session_file: conn.sessionFile, session_id: conn.sessionId, cwd: conn.cwd });
			// A reload may have added or dropped commands: the phone's "/" list follows.
			try { write(conn, "commands", { commands: commands() }); } catch {}
			try { write(conn, "models", { models: models() }); } catch {}
			// And what the phone shows from hello: context use and the stash, fresh, not after the next run.
			write(conn, "context", { context: (() => { try { return context(); } catch { return null; } })() });
			write(conn, "stash", { stash: stashLine(conn) });
			// A replaced session isn't running or waiting on anything.
			if (conn.busy) { conn.busy = false; write(conn, "idle"); }
			if (conn.prompt) { conn.prompt = null; conn.promptDepth = 0; write(conn, "prompt_end"); }
			return;
		}
		conn = {
			connected: false, closed: false, delay: retryBase(),
			busy: false, prompt: null, promptDepth: 0, sessionName, ...info,
			nonces: new Map(), inject, command, commands, models, context, model: modelOf(ctx),
		};
		store[STORE] = conn;
		connect(conn);
		listenOwner(conn);
	});

	// Streaming (so the phone shows the reply as it's written): the assistant message's text so
	// far, throttled; stream_end once it's final (it's in the session file from then on).
	let streamTimer: ReturnType<typeof setTimeout> | undefined;
	let streamLast = 0;
	let streamText = "";
	const textOf = (content: unknown): string =>
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n")
				: "";
	const flushStream = () => {
		streamTimer = undefined;
		if (!conn || conn.closed) return;
		streamLast = Date.now();
		write(conn, "stream", { text: streamText.slice(-STREAM_MAX) });
	};
	pi.on("message_update", (event) => {
		const m = (event as { message?: { role?: string; content?: unknown } }).message;
		if (!conn || conn.closed || m?.role !== "assistant") return;
		streamText = textOf(m.content);
		if (!streamText.trim() || streamTimer) return;
		const wait = Math.max(0, STREAM_EVERY_MS - (Date.now() - streamLast));
		streamTimer = setTimeout(flushStream, wait);
		streamTimer.unref();
	});
	pi.on("message_end", (event) => {
		const m = (event as { message?: { role?: string } }).message;
		if (!conn || conn.closed || m?.role !== "assistant") return;
		clearTimeout(streamTimer);
		streamTimer = undefined;
		streamText = "";
		write(conn, "stream_end");
	});

	// The model (and thinking level) on the phone's header follow /model, Ctrl+P and settings.
	pi.on("model_select", (event, ctx) => {
		if (!conn || conn.closed) return;
		conn.model = modelOf(ctx, (event as { model?: unknown }).model);
		write(conn, "model", { model: conn.model });
	});
	pi.on("thinking_level_select", (event, ctx) => {
		if (!conn || conn.closed) return;
		conn.model = modelOf(ctx, undefined, (event as { level?: string }).level);
		write(conn, "model", { model: conn.model });
	});

	// Questions a tool has open (ask) go to Botsun, so the phone can answer them.
	let lastAsk = "";
	const reportAsk = () => {
		if (!conn || conn.closed) return;
		const ask = askLine();
		const key = ask?.id ?? "";
		if (key === lastAsk) return;
		lastAsk = key;
		write(conn, ask ? "ask" : "ask_end", ask ? { ask } : {});
	};
	const stopAsk = onPromptsChange(reportAsk);
	// The message stash follows Ctrl+S and /stash here, and the phone's own pushes and takes.
	const stopStash = onStashChange((sessionId) => {
		if (conn && !conn.closed && sessionId === conn.sessionId) write(conn, "stash", { stash: stashLine(conn) });
	});
	// The footer's chips, at most once a second (it repaints while a reply streams).
	let footerTimer: ReturnType<typeof setTimeout> | undefined;
	let lastFooter = "";
	const stopFooter = onFooterChange(() => {
		if (footerTimer) return;
		footerTimer = setTimeout(() => {
			footerTimer = undefined;
			if (!conn || conn.closed) return;
			const footer = footerLine();
			const key = JSON.stringify(footer);
			if (key === lastFooter) return;
			lastFooter = key;
			write(conn, "footer", { footer });
		}, 1_000);
		footerTimer.unref?.();
	});
	pi.on("session_shutdown", () => {
		stopAsk();
		stopStash();
		stopFooter();
		clearTimeout(footerTimer);
	});

	pi.on("agent_start", () => {
		if (!conn || conn.closed || conn.busy) return;
		conn.busy = true;
		write(conn, "busy");
	});

	pi.on("agent_settled", () => {
		if (!conn || conn.closed || !conn.busy) return;
		conn.busy = false;
		write(conn, "idle");
		reportContext();
	});

	// Context use for the phone's info sheet: after each run, and after a compaction.
	const reportContext = () => {
		if (!conn || conn.closed) return;
		try { write(conn, "context", { context: conn.context?.() ?? null }); } catch {}
	};
	// Compaction, /compact's or pi's own: the phone shows it, and holds what Eric sends meanwhile.
	pi.on("session_before_compact", (event) => {
		compacting = String((event as { reason?: string }).reason ?? "manual");
		if (conn && !conn.closed) try { write(conn, "compacting", { reason: compacting }); } catch {}
		return undefined; // never cancels or changes it
	});
	const endCompaction = (ctx: ExtensionContext) => {
		if (!compacting) return;
		compacting = null;
		if (conn && !conn.closed) try { write(conn, "compacting", { reason: null }); } catch {}
		const out = held;
		held = [];
		out.forEach((content, i) => {
			const options = i > 0 ? { deliverAs: "followUp" as const } : ctx.isIdle() ? undefined : { deliverAs: "steer" as const };
			try { pi.sendUserMessage(content, options); } catch {}
		});
	};
	pi.on("session_compact", (_event, ctx) => {
		endCompaction(ctx);
		reportContext();
	});
	pi.on("session_compact_failed", (_event, ctx) => endCompaction(ctx));

	pi.on("ui_prompt_start", (event) => {
		if (!conn || conn.closed) return;
		// pi already coalesces nested prompts; count anyway so a stray pair
		// can't end the outer span early.
		if (conn.promptDepth++ > 0) return;
		const title = typeof event.title === "string" ? event.title.slice(0, TITLE_MAX) : "";
		conn.prompt = { kind: event.kind, title };
		write(conn, "prompt", { kind: conn.prompt.kind, title });
	});

	pi.on("ui_prompt_end", () => {
		if (!conn || conn.closed || conn.promptDepth === 0) return;
		if (--conn.promptDepth > 0) return;
		conn.prompt = null;
		write(conn, "prompt_end");
	});

	pi.on("session_shutdown", (event) => {
		const c = conn;
		conn = undefined;
		if (!c || c.closed) return;
		const reason = (event as { reason?: string }).reason;
		if (reason === "new" || reason === "resume" || reason === "fork" || reason === "reload") {
			// The next instance picks this up in session_start; if none does
			// (e.g. the opt-in was turned off), say bye after a grace period.
			clearTimeout(c.handoffTimer);
			c.handoffTimer = setTimeout(() => close(c), HANDOFF_MS);
			c.handoffTimer.unref();
			return;
		}
		close(c);
	});
}

export default optIn("botsun-owner", "Report this session's state to Botsun (phone Sessions list)", main);
