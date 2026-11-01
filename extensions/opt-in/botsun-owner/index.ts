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
// Signing v1 ("botsun-decide-v1") and v2 ("botsun-sign-v2", sig_v: 2;
// lib/signing-v2.ts) are both taken, and each device's key is pinned on first
// use (pins.ts): a changed key, or a new device once one is pinned, needs a
// yes at the keyboard. A device's first verified v2 request ratchets it: v1
// from it is refused after that (recorded in sign-versions.json, next to pins.json). A sensitive
// prompt takes only a v2 answer.
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
import { canonicalAnswer, canonicalAnswerV2, invalidAnswer, onPromptsChange, openPrompts, type RemotePrompt } from "../../../lib/remote-prompts.ts";
import { messageV2, validScope } from "../../../lib/signing-v2.ts";
import { checkPin, isPinsError, pin, ratchet, shortFingerprint, signVersionOf, type KeyKind } from "./pins.ts";
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
/** Streaming text to Botsun: at most this often, and at most this much (the end is kept). */
const STREAM_EVERY_MS = 250;
const STREAM_MAX = 20_000;
/** DER prefix that turns a 65-byte uncompressed P-256 point into an SPKI key. */
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
	/** Delivers released call words: queued after the turn, steered in, or stopping the run first. */
	deliver?: (text: string, mode: "queue" | "steer" | "stop") => string;
	/** Stops the running turn as Esc does: "stopped", or "idle" when nothing is running. */
	stop?: () => string;
	/** The phone's Close: aborts a running turn ("stopped" / "idle"); the shutdown it returns runs once the reply is sent. */
	close?: () => { stopped: boolean; shutdown: () => void };
	/** A call's verified words, held until the voice helper releases them (session-voice plan). */
	held?: Map<string, { text: string; at: number; proposal?: string; sigV?: 1 | 2; deviceId?: string }>;
	/** The keyboard's yes/no (ctx.ui.confirm), for pinning a device whose key changed or that's new. */
	confirm?: (title: string, message: string) => Promise<boolean>;
	/** Pin confirms open now (kind:device; at most one), so retries and minted keys don't stack dialogs. */
	pinPrompts?: Set<string>;
	/** kind:device → until (ms): refused without a dialog after a no at the keyboard. */
	pinCooldown?: Map<string, number>;
	/** Until (ms): no pin dialog at all, for any device, after any no at the keyboard. */
	pinQuietUntil?: number;
	/** When each recent pin dialog opened (ms), for the cap of PIN_DIALOG_MAX per PIN_DIALOG_WINDOW_MS. */
	pinDialogs?: number[];
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
	const { decision, digest } = sayDigest(text, images, files);
	return Buffer.from(["botsun-decide-v1", deviceId, nonce, "session", sessionId, decision, digest].join("\n"), "utf8");
}

/**
 * v1: decision and digest. v2: the same decision, over a payload: text only is
 * "botsun-propose-text-v1\n<text>" (as Botsun's vectors); with photos or files, the lines v1
 * hashes (sha256(text), then one per photo / file).
 */
function sayDigest(text: string, images: Image[], files: File[]): { decision: string; digest: string; payload: string } {
	const textHash = sha256hex(Buffer.from(text, "utf8"));
	let decision = "say";
	let digest = textHash;
	let payload = `botsun-propose-text-v1\n${text}`;
	if (files.length) {
		// "say_attach": sha256(text), then "image <sha256>" per photo, "file <sha256(name)> <sha256(data)>" per file.
		decision = "say_attach";
		payload = [textHash, ...images.map((i) => `image ${sha256hex(Buffer.from(i.data, "base64"))}`),
			...files.map((f) => `file ${sha256hex(Buffer.from(f.name, "utf8"))} ${sha256hex(Buffer.from(f.data, "base64"))}`)].join("\n");
		digest = sha256hex(payload);
	} else if (images.length) {
		decision = "say_images";
		payload = [textHash, ...images.map((i) => sha256hex(Buffer.from(i.data, "base64")))].join("\n");
		digest = sha256hex(payload);
	}
	return { decision, digest, payload };
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

/**
 * Unsigned, and the oldest is evicted past NONCES_MAX: any local process running as Eric can
 * flood this to spend Botsun's nonce before it's used. Accepted: that's a same-user local DoS
 * (it could kill pi as easily); the signed request just fails with "nonce is expired or used",
 * and nothing can be forged with a nonce.
 */
function newNonce(c: Conn): string {
	const nonce = randomBytes(24).toString("base64url");
	c.nonces.set(nonce, Date.now() + NONCE_TTL_MS);
	while (c.nonces.size > NONCES_MAX) c.nonces.delete(c.nonces.keys().next().value as string);
	return nonce;
}

const deviceIdOf = (r: Record<string, unknown>): string =>
	typeof r.device_id === "number" || typeof r.device_id === "string" ? String(r.device_id) : "";

/** The signing version a request says it was signed with: absent or 1 = v1, 2 = v2, else null. */
export function sigVersion(r: Record<string, unknown>): 1 | 2 | null {
	if (r.sig_v === undefined || r.sig_v === 1) return 1;
	return r.sig_v === 2 ? 2 : null;
}

/**
 * What a request is signed over. v1: "botsun-decide-v1" … "session", session id, decision,
 * digest(). v2 (sig_v: 2): "botsun-sign-v2" … kind, scope = the session id, decision,
 * sha256(payload()).
 */
interface SignSpec {
	decision: string;
	digest: () => string;
	v2: { kind: string; decision: string; payload: () => string | Buffer };
}

/**
 * Checks a phone-signed request: its nonce (spent whatever happens next: one try per nonce), the
 * paired device's key, its signature (v1 or v2, per sig_v), and the device's key pin (pins.ts).
 * Returns the error, or null when it verifies. keyKind "call": the phone's call key (T5).
 */
function verifyDevice(c: Conn, r: Record<string, unknown>, spec: SignSpec, keyKind: KeyKind = "decide"): string | null {
	const { nonce, signature } = r;
	const deviceId = deviceIdOf(r);
	const v = sigVersion(r);
	if (typeof nonce !== "string" || typeof signature !== "string" || !/^\d{1,12}$/.test(deviceId) || !v) return "bad request";
	if (!c.sessionId) return "this session has no id yet";
	if (!takeNonce(c, nonce)) return "nonce is expired or used";
	let key: Buffer | null;
	try {
		key = deviceKey(deviceId, keyKind);
	} catch (e) {
		return (e as Error).message.startsWith("owner-keys") ? (e as Error).message : "no device keys";
	}
	if (!key) return "unknown device";
	if (v === 2 && !validScope(c.sessionId)) return "this session's id can't be signed (v2)";
	let verified = false;
	try {
		const text = v === 2
			? messageV2({ deviceId, nonce, kind: spec.v2.kind, scope: c.sessionId, decision: spec.v2.decision, payload: spec.v2.payload() })
			: ["botsun-decide-v1", deviceId, nonce, "session", c.sessionId, spec.decision, spec.digest()].join("\n");
		const pub = createPublicKey({ key: Buffer.concat([P256_SPKI, key]), format: "der", type: "spki" });
		verified = verifySignature("sha256", Buffer.from(text, "utf8"), { key: pub, dsaEncoding: "der" }, Buffer.from(signature, "base64"));
	} catch {}
	if (!verified) return "signature does not verify";
	if (v === 1) {
		// The ratchet (pins.ts): a device that has signed v2 isn't taken at v1 again (a downgrade).
		try {
			if (signVersionOf(deviceId) === 2) return V1_REFUSED;
		} catch (e) {
			return isPinsError(e) ? (e as Error).message : "couldn't read the device's signing version";
		}
	}
	const pinCheck = checkPin(keyKind, deviceId, key);
	if (!pinCheck.ok) {
		if (pinCheck.ask) askPin(c, keyKind, deviceId, pinCheck.ask);
		return pinCheck.error;
	}
	if (v === 2) {
		try {
			ratchet(deviceId);
		} catch (e) {
			return isPinsError(e) ? (e as Error).message : "couldn't record the device's signing version";
		}
	}
	return null;
}

/** A v1 request from a device that has signed v2 (the ratchet). */
export const V1_REFUSED = "this phone signs v2: v1 is refused (update Botsun and the app)";
/** A v1-signed close: close takes v2 only. */
export const CLOSE_V1_REFUSED = "close needs a v2 signature: v1 is refused (update Botsun and the app)";
/** A v1 answer to a sensitive prompt: v1 doesn't bind the card's text. */
export const SENSITIVE_V1_REFUSED = "this one needs a v2-signed answer (update Botsun and the app), or answer it at the keyboard";

/** After a no at the keyboard, that device's key kind is refused without asking for this long. */
export const PIN_COOLDOWN_MS = 10 * 60_000;
/** After any no at the keyboard, no pin dialog opens at all (any device) for this long. */
export const PIN_QUIET_MS = 2 * 60_000;
/** At most this many pin dialogs open per PIN_DIALOG_WINDOW_MS, across devices; more are refused without one. */
export const PIN_DIALOG_MAX = 3;
export const PIN_DIALOG_WINDOW_MS = 10 * 60_000;

/**
 * A verified request came with a key this session hasn't pinned for its device (a changed key, or
 * a new device once others are pinned): ask at the keyboard (never the phone) whether to trust it.
 * Only that yes pins, and only from the pin shown (or none) to the key shown; the request itself
 * stays refused either way. One dialog at a time across devices, keyed by kind:device (not the
 * key, so minting keys can't stack dialogs); after a no, that kind:device is refused without a
 * dialog for PIN_COOLDOWN_MS, and every other one for PIN_QUIET_MS; and at most PIN_DIALOG_MAX
 * dialogs open per PIN_DIALOG_WINDOW_MS, so one after another can't wear Eric down into a yes.
 */
function askPin(c: Conn, kind: KeyKind, deviceId: string, ask: { pinned: string | null; offered: string }): void {
	const open = (c.pinPrompts ??= new Set());
	const cooldown = (c.pinCooldown ??= new Map());
	const id = `${kind}:${deviceId}`;
	const now = Date.now();
	for (const [k, until] of cooldown) if (until <= now) cooldown.delete(k);
	const shown = (c.pinDialogs = (c.pinDialogs ?? []).filter((t) => now - t < PIN_DIALOG_WINDOW_MS));
	if (!c.confirm || open.size > 0 || cooldown.has(id) || now < (c.pinQuietUntil ?? 0) || shown.length >= PIN_DIALOG_MAX) return;
	open.add(id);
	shown.push(now);
	const which = kind === "call" ? "call key" : "key";
	const title = ask.pinned
		? `Botsun: phone device ${deviceId}'s ${which} changed`
		: `Botsun: new phone device ${deviceId} (${which})`;
	const message = (ask.pinned
		? [
			`A request was signed by a different ${which} for paired device ${deviceId} than the one this session pinned.`,
			`Pinned: ${shortFingerprint(ask.pinned)}`,
			`New:    ${shortFingerprint(ask.offered)}`,
			"Trust the new key? Say yes only if you just re-paired this phone.",
		]
		: [
			`A request was signed by device ${deviceId}, which this session hasn't pinned a ${which} for (other devices are pinned).`,
			`Device: ${deviceId}`,
			`Kind:   ${kind === "call" ? "call" : "decision"} key`,
			`Key:    ${shortFingerprint(ask.offered)}`,
			"Trust this device? Say yes only if you just paired this phone.",
		]).join("\n");
	const confirm = c.confirm;
	Promise.resolve()
		.then(() => confirm(title, message))
		.then((yes) => {
			if (yes) pin(kind, deviceId, ask.offered, ask.pinned);
			else {
				cooldown.set(id, Date.now() + PIN_COOLDOWN_MS);
				c.pinQuietUntil = Date.now() + PIN_QUIET_MS;
			}
			debug(`owner device ${deviceId} ${which} ${ask.pinned ? "re-pin" : "new pin"} ${yes ? "accepted" : "refused"} at the keyboard`);
		})
		.catch(() => {})
		.finally(() => open.delete(id));
}

/** One request line → one reply object. Exported for tests. */
export function handleOwnerRequest(c: Conn, req: unknown): Record<string, unknown> | Promise<Record<string, unknown>> {
	if (!req || typeof req !== "object") return { error: "bad request" };
	const r = req as Record<string, unknown>;
	if (r.type === "nonce") {
		if (!c.sessionId) return { error: "this session has no id yet" };
		// What this version takes, so Botsun can say "reload it" instead of a failed signature.
		return { nonce: newNonce(c), session_id: c.sessionId, features: featureList(c) };
	}
	if (r.type === "say_audio") return sayAudio(c, r);
	if (r.type === "release") return releaseHeld(c, r);
	if (r.type === "drop") return dropHeld(c, r);
	if (r.type === "call_end") return dropHeld(c, {});
	if (r.type === "confirm") return confirmHeld(c, r);
	if (r.type === "answer") return answerAsk(c, r);
	if (r.type === "stash") return stashRequest(c, r);
	if (r.type === "stop") return stopRequest(c, r);
	if (r.type === "close") return closeRequest(c, r);
	// Display only (a chip's mode, as a click on the footer flips it): not signed, nothing acts.
	if (r.type === "footer_tap") return footerTap(String(r.chip ?? ""));
	if (r.type !== "say") return { error: "unknown request" };
	const { text } = r;
	const images = imagesOf(r.images);
	if (typeof images === "string") return { error: images };
	const files = filesOf(r.files);
	if (typeof files === "string") return { error: files };
	if (images.length + files.length > ATTACH_MAX) return { error: `at most ${ATTACH_MAX} attachments` };
	if (typeof text !== "string" || text.length > TEXT_MAX || (!text.trim() && !images.length && !files.length)) {
		return { error: "text must be 1 to 20000 characters (or attach something)" };
	}
	const say = sayDigest(text, images, files);
	const denied = verifyDevice(c, r, { decision: say.decision, digest: () => say.digest,
		v2: { kind: "session", decision: say.decision, payload: () => say.payload } });
	if (denied) return { error: denied };
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
	const { text, wav_sha256: wav } = r;
	// A reply to a proposal on the call (an `ask` answer read back to him): its hash is signed too.
	const proposal = typeof r.proposal_sha256 === "string" && /^[0-9a-f]{64}$/.test(r.proposal_sha256) ? r.proposal_sha256 : undefined;
	if (r.proposal_sha256 !== undefined && !proposal) return { error: "bad request" };
	if (typeof text !== "string" || !text.trim() || text.length > TEXT_MAX) return { error: "nothing was said" };
	if (typeof wav !== "string" || !/^[0-9a-f]{64}$/.test(wav)) return { error: "bad request" };
	// v1's digest line is the audio hash (and the proposal's, a line more) as is; v2 hashes them.
	const lines = () => [wav, ...(proposal ? [proposal] : [])].join("\n");
	const denied = verifyDevice(c, r, { decision: "say_audio", digest: lines, v2: { kind: "session", decision: "say_audio", payload: lines } }, "call");
	if (denied) return { error: denied };
	if (r.hold === true) {
		// Verified now, while the nonce is fresh; delivered only when the voice helper releases it.
		const held = (c.held ??= new Map());
		pruneHeld(c);
		if (held.size >= HELD_MAX) return { error: "too many words are waiting; release or drop some" };
		const id = randomBytes(6).toString("hex");
		// A v2-signed utterance carries a v2 proposal hash (canonicalAnswerV2 for an ask).
		// The device too: a v1 reply held before the device ratcheted isn't confirmed after (confirmHeld).
		held.set(id, { text, at: Date.now(), ...(proposal ? { proposal, sigV: sigVersion(r) ?? 1, deviceId: deviceIdOf(r) } : {}) });
		writeHeld(c);
		debug(`owner say_audio held (${text.length} chars)`);
		return { ok: true, held: id };
	}
	c.inject(text, c.busy);
	debug(`owner say_audio accepted (${text.length} chars)`);
	return { ok: true, delivered: c.busy ? "steer" : "prompt" };
}

const HELD_MAX = 20;
const HELD_TTL_MS = 15 * 60_000;

/**
 * One utterance of Eric's asking to stop what's running: a short one that leads with the word
 * ("stop", "ok stop the build", "wait, cancel that"), not one that mentions it ("add a cancel
 * button", "don't stop", "can't stop thinking about it"). Only this lets a release abort: the
 * helper's judgment alone never does.
 */
export function saysStop(text: string): boolean {
	const t = text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' ]+/g, " ").trim();
	const words = t.split(/\s+/).filter(Boolean);
	if (!words.length || words.length > 8) return false;
	if (/^(?:(?:ok|okay|hey|wait|no|please|hold on|actually|pi)\s+)*(?:stop|cancel|abort|halt)\b/.test(t)) return true;
	// "make it stop", "tell it to stop": only that short, so "make it stop retrying the spec" isn't one.
	return words.length <= 4 && /^(?:please\s+)?(?:make it|tell it to)\s+(?:stop|cancel|abort|halt)\b/.test(t);
}

/**
 * His reply to a proposal says no ("no", "wait", "not that", "cancel"): the session refuses the
 * confirm whatever the voice helper made of it. Leans to no ("no problem" is refused too).
 */
export function saysNo(text: string): boolean {
	const t = text.toLowerCase().replace(/[’']/g, "'");
	return /\b(no|nope|nah|uh-uh|don't|dont|do not|not|cancel|wait|stop|hold on|never ?mind|wrong|scratch|actually|instead)\b/.test(t);
}

/**
 * His reply to a read-back says yes in so many words ("yeah", "sure, send it", "go ahead") and
 * is short: a question back, "hmm" or "read it again" carries the card's hash too, and must not
 * count whatever the voice helper made of it.
 */
export function saysYes(text: string): boolean {
	const t = text.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' -]+/g, " ").trim();
	if (!t || t.split(/\s+/).length > 12 || saysNo(t) || /\?/.test(text)) return false;
	return /\b(yes|yeah|yep|yup|ya|sure|ok|okay|correct|right|confirm|confirmed|affirmative|absolutely|definitely|perfect|fine|sounds good|go ahead|go for it|do it|do that|send|send it|send that|that's it|that one|uh huh|uh-huh|mm-hmm|mhm|please do|you got it|ship it)\b/.test(t);
}

/** A reworded message is read back in full on the call: Botsun caps it at this too. */
const PROPOSED_TEXT_MAX = 600;

/** What a reworded message's read-back is signed over: its own namespace, never an ask answer's. */
export function proposalTextHash(text: string): string {
	return sha256hex(Buffer.from(`botsun-propose-text-v1\n${text}`, "utf8"));
}

/**
 * The voice helper says his held reply means yes to the proposal it read back: answer the open
 * `ask` with it. The session checks on its own that his signed words carry this exact answer's
 * hash (canonicalAnswer) and don't say no; the helper can't write the yes, only point at it.
 *
 * Two kinds of proposal: an `ask` answer ({ask_id, answers}), or a message the helper reworded
 * from his words ({text, mode}: queue after the turn, or steer in as typed). Either way the
 * hash is recomputed here from what's about to go in. Never a sensitive prompt.
 */
function confirmHeld(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const { id, ask_id: askId, answers, text, mode } = r;
	const isText = typeof text === "string";
	if (typeof id !== "string") return { error: "bad request" };
	if (isText ? !text.trim() || [...text].length > PROPOSED_TEXT_MAX || (mode !== "queue" && mode !== "steer")
		: typeof askId !== "string" || !Array.isArray(answers)) return { error: "bad request" };
	if (isText && !c.deliver) return { error: "this session can't take released words yet; run /reload" };
	pruneHeld(c);
	const h = c.held?.get(id);
	if (!h) return { error: `not waiting: ${id}` };
	if (!h.proposal) return { error: "his words weren't a reply to a proposal" };
	// v2: the answer's hash covers the prompt's own questions, so find the prompt first.
	const prompt = isText ? undefined : openPrompts().find((p) => p.id === askId);
	const v2 = !isText && h.sigV === 2;
	let digest: string | null = null;
	try {
		if (isText) digest = proposalTextHash(text);
		else if (!v2) digest = sha256hex(Buffer.from(canonicalAnswer(askId as string, answers as never), "utf8"));
		else if (prompt) digest = sha256hex(Buffer.from(canonicalAnswerV2(prompt.id, prompt.questions, answers as never), "utf8"));
	} catch {
		return { error: "bad request" };
	}
	// Whatever happens next, these words are spent: a failed confirm never leaves them to retry.
	c.held?.delete(id);
	writeHeld(c);
	// The ratchet, again: v1 words held from before the device's first v2 don't count after it.
	if (h.sigV !== 2) {
		try {
			if (!h.deviceId || signVersionOf(h.deviceId) === 2) return { error: V1_REFUSED };
		} catch (e) {
			return { error: isPinsError(e) ? (e as Error).message : "couldn't read the device's signing version" };
		}
	}
	if (v2 && !prompt) return { error: "that question was already answered" };
	if (digest !== h.proposal) return { error: `his yes was for a different ${isText ? "message" : "answer"}` };
	// A secret's approval (op-broker) takes a device-signed tap or the keyboard, never a spoken yes.
	if (prompt?.sensitive) return { error: "answer this one on the phone screen or the keyboard" };
	if (saysNo(h.text)) return { error: "his words say no" };
	if (!saysYes(h.text)) return { error: "his words don't say yes" };
	if (isText) {
		let delivered: string;
		try {
			delivered = c.deliver!(text, mode as "queue" | "steer");
		} catch {
			return { error: "couldn't put it in" };
		}
		debug(`owner confirm sent a reworded message (${text.length} chars, ${delivered})`);
		return { ok: true, delivered };
	}
	if (!prompt) return { error: "that question was already answered" };
	const error = prompt.answer(answers as never);
	if (error) return { error };
	debug("owner confirm answered an ask");
	return { ok: true };
}

function pruneHeld(c: Conn): void {
	const now = Date.now();
	for (const [id, h] of c.held ?? []) if (now - h.at > HELD_TTL_MS) c.held?.delete(id);
}

function writeHeld(c: Conn): void {
	// Ids, sizes and times only: Botsun has the words already, from its own transcription.
	const held = [...(c.held ?? new Map()).entries()].map(([id, h]) => ({ id, chars: h.text.length, at: new Date(h.at).toISOString() }));
	try { write(c, "held", { held }); } catch {}
}

/**
 * The voice helper says when and how held words go in. It can't add any: the ids name words
 * this session verified itself. queue: after the turn. steer: into it. interrupt: steer, or
 * stop the run first when the released words themselves say stop.
 */
function releaseHeld(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const { ids, mode } = r;
	if (!Array.isArray(ids) || !ids.length || ids.length > HELD_MAX || !ids.every((i) => typeof i === "string")) return { error: "bad request" };
	if (mode !== "queue" && mode !== "steer" && mode !== "interrupt") return { error: "mode must be queue, steer or interrupt" };
	pruneHeld(c);
	const missing = (ids as string[]).filter((i) => !c.held?.has(i));
	if (missing.length) return { error: `not waiting: ${missing.join(", ")}` };
	if (!c.deliver) return { error: "this session can't take released words yet; run /reload" };
	const texts = (ids as string[]).map((i) => c.held?.get(i)?.text ?? "");
	const text = texts.join("\n\n");
	// Stop only when one of his utterances, on its own, says stop.
	const how = mode === "queue" ? "queue" : mode === "interrupt" && texts.some(saysStop) ? "stop" : "steer";
	let delivered: string;
	try {
		delivered = c.deliver(text, how);
	} catch {
		return { error: "couldn't put them in; they're still waiting" };
	}
	for (const i of ids as string[]) c.held?.delete(i); // gone only once they went in
	writeHeld(c);
	debug(`owner release ${ids.length} held (${how})`);
	return { ok: true, delivered };
}

/** Forgets held words: the ids given, or all of them (a call ending). */
function dropHeld(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const ids = Array.isArray(r.ids) ? r.ids.filter((i): i is string => typeof i === "string") : null;
	if (ids) for (const i of ids) c.held?.delete(i);
	else c.held?.clear();
	writeHeld(c);
	return { ok: true };
}

/**
 * T3: Eric answers an `ask` question from the phone. Signed with the decision key over the
 * prompt id and his picks (v1: canonicalAnswer; v2: canonicalAnswerV2 over the prompt's own
 * questions too), checked here, then handed to the waiting tool.
 */
function answerAsk(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const { ask_id: id, answers } = r;
	if (typeof id !== "string" || !Array.isArray(answers)) return { error: "bad request" };
	// v2 signs the questions as asked, so the prompt is looked up before the digest is built.
	const prompt = openPrompts().find((p) => p.id === id);
	// Refused before verifyDevice: spend the nonce anyway (one try per nonce, as there).
	const spend = (error: string) => {
		if (typeof r.nonce === "string") takeNonce(c, r.nonce);
		return { error };
	};
	// A secret's approval (op-broker) binds its card text only in v2: a v1 answer is refused,
	// ratchet or not.
	if (prompt?.sensitive && sigVersion(r) !== 2) return spend(SENSITIVE_V1_REFUSED);
	if (sigVersion(r) === 2) {
		if (!prompt) return spend("that question was already answered");
		const bad = invalidAnswer(prompt.questions, answers);
		if (bad) return spend(bad);
	}
	const denied = verifyDevice(c, r, {
		decision: "answer",
		digest: () => sha256hex(Buffer.from(canonicalAnswer(id, answers as never), "utf8")),
		v2: { kind: "answer", decision: "answer", payload: () => canonicalAnswerV2(prompt!.id, prompt!.questions, answers as never) },
	});
	if (denied) return { error: denied };
	// A sensitive prompt too: a screen tap is signed by the device, unlike a spoken yes.
	if (!prompt) return { error: "that question was already answered" };
	const error = prompt.answer(answers as never);
	return error ? { error } : { ok: true };
}

/**
 * The phone works with this session's message stash (the stash extension's stack): push a draft,
 * take one back into its message box, or drop one. Signed with the decision key over
 * "push\n<sha256(text)>", "take\n<id>" or "drop\n<id>".
 */
function stashRequest(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const { op } = r;
	const text = typeof r.text === "string" ? r.text : "";
	const id = typeof r.id === "string" ? r.id : "";
	if (op !== "push" && op !== "take" && op !== "drop") return { error: "bad request" };
	if (op === "push" && (!text.trim() || text.length > TEXT_MAX)) return { error: "nothing to stash" };
	if (op !== "push" && !/^[\w-]{1,40}$/.test(id)) return { error: "bad request" };
	const payload = op === "push" ? `push\n${sha256hex(Buffer.from(text, "utf8"))}` : `${op}\n${id}`;
	const denied = verifyDevice(c, r, { decision: "stash", digest: () => sha256hex(Buffer.from(payload, "utf8")),
		v2: { kind: "session", decision: "stash", payload: () => payload } });
	if (denied) return { error: denied };
	const sessionId = c.sessionId!; // verifyDevice refuses a session without one
	if (op === "push") return { ok: true, id: pushStash(sessionId, text).id };
	const entry = takeStash(sessionId, id);
	if (!entry) return { error: "that stash is gone" };
	return op === "take" ? { ok: true, text: entry.text } : { ok: true };
}

/**
 * The phone's Stop button: ends the running turn as Esc does. Signed with the decision key over
 * "stop" (this session's nonce makes each one single-use).
 */
function stopRequest(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const denied = verifyDevice(c, r, { decision: "stop", digest: () => sha256hex(Buffer.from("stop", "utf8")),
		v2: { kind: "session", decision: "stop", payload: () => "stop" } });
	if (denied) return { error: denied };
	if (!c.stop) return { error: "this session can't stop from the phone yet; run /reload" };
	return { ok: true, stopped: c.stop() === "stopped" };
}

/** Runs once the reply carrying it has been written to the owner socket (a symbol, so never sent). */
export const AFTER_REPLY = Symbol("afterReply");

/**
 * The phone's Close: aborts a running turn, replies at once, then shuts pi down gracefully
 * (ctx.shutdown) so the process exits. Signed exactly like stop, over "close" (single-use nonce).
 */
function closeRequest(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const denied = verifyDevice(c, r, { decision: "close", digest: () => sha256hex(Buffer.from("close", "utf8")),
		v2: { kind: "session", decision: "close", payload: () => "close" } });
	if (denied) return { error: denied };
	// v2 only (scoped to this session), ratchet or not: even a v1 signature that verifies is
	// refused (checked after verifyDevice, so its nonce is spent and its errors stay alike).
	if (sigVersion(r) !== 2) return { error: CLOSE_V1_REFUSED };
	if (!c.close) return { error: "this session can't close from the phone yet; run /reload" };
	const { shutdown } = c.close();
	return { ok: true, [AFTER_REPLY]: shutdown };
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
				.then((r) => {
					const after = (r as Record<symbol, unknown>)[AFTER_REPLY];
					if (typeof after !== "function") { sock.end(`${JSON.stringify(r)}\n`); return; }
					let ran = false;
					const once = () => {
						if (ran) return;
						ran = true;
						try { (after as () => void)(); } catch (e) { debug(`after reply: ${(e as Error).message}`); }
					};
					sock.once("close", once); // even if the phone hung up before the reply went out
					sock.end(`${JSON.stringify(r)}\n`, once);
				});
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

/**
 * The newest question a tool (ask) has open, as Botsun shows it; null when none. sensitive: a
 * secret's approval, which the call can't confirm (Botsun drops keys it doesn't know).
 */
function askLine(): { id: string; questions: RemotePrompt["questions"]; sensitive?: true } | null {
	const open = openPrompts();
	const p = open[open.length - 1];
	return p ? { id: p.id, questions: p.questions, ...(p.sensitive ? { sensitive: true as const } : {}) } : null;
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

// What this version takes: the nonce reply's list, also in hello (and after a reload) so the
// phone's Sessions list knows which sessions can close without asking each one for a nonce.
function featureList(c: Conn): string[] {
	const hasStash = (() => {
		try { return c.commands?.().some((x) => x.name === "stash") ?? false; } catch { return false; }
	})();
	return ["say", "images", "files", "say_audio", "hold", "stop", "confirm", "confirm_text", "stream", "ask", "sign_v2", "ask_v2", "close",
		...(hasStash ? ["stash"] : [])];
}

function sendHello(c: Conn): void {
	write(c, "hello", {
		features: featureList(c),
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
	// Words a stop released: sent once the aborted run has settled, as if typed after Esc.
	let afterStop: string[] = [];

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
		// Released call words. queue: a follow-up once the turn ends (a prompt when idle). steer: as a
		// typed message would. stop: abort the run, like Esc, then send them once pi settles.
		const deliver = (text: string, mode: "queue" | "steer" | "stop"): string => {
			const idle = ctx.isIdle();
			if (mode === "steer" || compacting) {
				inject(text, !idle);
				return compacting ? "held" : idle ? "prompt" : "steer";
			}
			if (idle) {
				pi.sendUserMessage(text);
				return "prompt";
			}
			if (mode === "queue") {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
				return "queue";
			}
			afterStop.push(text);
			ctx.abort();
			return "stopped";
		};
		// The phone's Stop: Esc. A compaction counts as running (Esc stops that too).
		const stop = (): string => {
			if (ctx.isIdle() && !compacting) return "idle";
			ctx.abort();
			return "stopped";
		};
		// The phone's Close: stop what's running, then (after the reply) a graceful exit.
		const close = () => ({ stopped: stop() === "stopped", shutdown: () => ctx.shutdown() });
		const command = (text: string, busy: boolean) =>
			compacting && /^\//.test(text.trim()) && !/^\/(model|thinking|name|bypass)\b/.test(text.trim()) ? "wait for the compaction to finish" : runCommand(pi, ctx, text, busy);
		const commands = () => phoneCommands(pi);
		const models = () => phoneModels(ctx);
		const context = () => phoneContext(ctx);
		// The keyboard's yes/no, for pinning a changed key or a new device (never answerable remotely).
		const confirm = typeof ctx.ui?.confirm === "function" ? (title: string, message: string) => ctx.ui.confirm(title, message) : undefined;
		const prev = store[STORE];
		if (prev && !prev.closed) {
			// Same pid, new extension instance: reuse the connection.
			clearTimeout(prev.handoffTimer);
			prev.handoffTimer = undefined;
			conn = prev;
			conn.sessionName = sessionName;
			conn.inject = inject;
			conn.deliver = deliver;
			conn.stop = stop;
			conn.close = close;
			conn.command = command;
			conn.commands = commands;
			conn.models = models;
			conn.context = context;
			conn.confirm = confirm;
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
			try { write(conn, "features", { features: featureList(conn) }); } catch {}
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
			nonces: new Map(), inject, deliver, stop, close, command, commands, models, context, confirm, model: modelOf(ctx),
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
		if (afterStop.length) {
			// As if typed after Esc; through inject, so a compaction starting now still holds them.
			const text = afterStop.join("\n\n");
			afterStop = [];
			try {
				if (conn && !conn.closed) conn.inject(text, false);
				else pi.sendUserMessage(text);
			} catch {}
		}
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
