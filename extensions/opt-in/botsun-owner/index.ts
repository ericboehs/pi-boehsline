// Report this interactive session's state to Botsun over a local Unix socket
// (protocol: botsun-owner v1, client side). Botsun's web process listens; we
// only ever write newline-delimited JSON to it: hello on every (re)connect with
// the full current state, then busy/idle/prompt/prompt_end/session/bye (and
// footer/usage on change: the usage windows are provider-usage's numbers), and
// what /color is (color.ts) on hello, session and each change. Botsun writes
// back down it a sandbox session's token, the session's saved color, the icon
// catalog and an icon line's answer (icon.ts).
//
// T2, reply as Eric: each session also listens on its own owner socket
// (~/.local/state/botsun/owner/<pid>.sock, 0600). Botsun asks it for a nonce,
// the phone signs the reply with its Secure Enclave key, and this session
// checks the signature itself against the paired devices' public keys
// (owner-keys.json, written by Botsun) before the text goes in as Eric's own
// message. A stolen Botsun token or a peer agent can't speak as Eric here.
// Signing v1 ("botsun-decide-v1"), v2 ("botsun-sign-v2", sig_v: 2) and v3
// ("botsun-sign-v3", sig_v: 3: v2 plus this host's authority, the top-level
// "host" in owner-keys.json; lib/signing-v2.ts) are all taken, and each
// device's key is pinned on first use (pins.ts): a changed key, or a new device
// once one is pinned, needs a yes at the keyboard. A device's first verified v2
// (or v3) request ratchets it: anything older from it is refused after that
// (recorded in sign-versions.json, next to pins.json). A sensitive prompt takes
// only a v2-or-newer answer.
//
// Best effort throughout: a missing socket or a refused connection is normal
// (Botsun not running), so it retries quietly with backoff and never logs
// unless BOTSUN_OWNER_DEBUG is set. Every timer and the socket are unref'd,
// so nothing here keeps pi alive.

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { accessSync, appendFileSync, existsSync, chmodSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { optIn } from "../../../lib/opt-in.ts";
import { canonicalAnswer, canonicalAnswerV2, invalidAnswer, onPromptsChange, openPrompts, type RemotePrompt } from "../../../lib/remote-prompts.ts";
import { messageV2, messageV3, validHost, validScope } from "../../../lib/signing-v2.ts";
import { checkPin, isPinsError, pin, ratchet, shortFingerprint, signVersionOf, type KeyKind } from "./pins.ts";
import { canDrawIcons, pickDrawn, type PickItem } from "./icon-picker.ts";
import { ICON_DISCONNECTED, ICON_EVENT, iconCompletions, iconLineFields, lookOf, looksOf, parseIconArgs, takeCatalog, takeLookNotes, type IconCatalog, type IconReply } from "./icon.ts";
import { onIconSuggestion, provideIconCatalog, type IconSuggestion, type NamingCatalog } from "../../../lib/icon-suggestion.ts";
import { markRemoteSubmit, onStashChange, pushStash, stashStack, takeStash } from "../../../lib/stash-store.ts";
import { latestFooter, onFooterChange, tapFooter, type FooterChip } from "../../../lib/footer-snapshot.ts";
import { latestUsage, onUsageChange, type ProviderUsageSnapshot } from "../../../lib/usage-snapshot.ts";
import { bindChildren, type ChildInfo, childTranscript, listChildren, onChildrenChange, stopChild } from "../../../lib/children.ts";
import { claimOf, colorPush, type ColorClaim } from "./color.ts";

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
// A reply with up to ATTACH_MAX files of FILE_B64_MAX each (as Botsun's MAX_SESSION_SAY_BODY), plus slack.
const REQUEST_MAX = 60 * 1024 * 1024;
const IMAGES_MAX = 4;
const IMAGE_B64_MAX = 5 * 1024 * 1024;
const FILE_B64_MAX = Math.ceil((25 * 1024 * 1024) / 3) * 4; // 25 MB a file, base64'd
// All of a message's photos and files: 40 MB (Botsun's MAX_SESSION_SAY_BODY holds that, base64'd).
const ATTACH_B64_TOTAL_MAX = Math.ceil((40 * 1024 * 1024) / 3) * 4;
const ATTACH_MAX = 4;
export const inboxDir = (): string => process.env.BOTSUN_OWNER_INBOX || join(homedir(), ".local", "state", "botsun", "inbox");
/** Video frames shown to the agent: at most this many per video and per message (on top of the photos). */
const FRAMES_PER_VIDEO = 8;
const FRAMES_MAX = 16;
/** All of a message's ffprobe/ffmpeg runs together. */
const FRAMES_TIMEOUT_MS = 20_000;
const VIDEO_NAME = /\.(mp4|mov|m4v)$/i;
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
	/** The `quiet` value of the last busy line written this run. */
	quietSent?: boolean;
	prompt: Prompt | null;
	promptDepth: number;
	cwd: string;
	sessionFile: string | null;
	sessionId: string | null;
	/** Fallback name source: the pi session name, read lazily. */
	sessionName: () => string | undefined;
	/** Sets pi's session name (Botsun's rename line); the current instance's. */
	setSessionName?: (name: string) => void;
	/** When pi's session name was last set from here (a rename line or a phone /name), ms: newer
	 * than agent-link's pid file, it is the name every line says. */
	namedAt?: number;
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
	/** The phone's Close: aborts a running turn ("stopped" / "idle"); the shutdown it returns runs once the reply is sent.
	 * idleOnly (a locked phone's close_call): null while a turn, Botsun's busy, a compaction or a video reply's
	 * framing runs, a sent prompt hasn't started yet or pi has queued messages, and nothing is aborted; its
	 * shutdown is skipped if one has started since. */
	close?: (opts?: { idleOnly?: boolean }) => { stopped: boolean; shutdown: () => void } | null;
	/** The phone's Reload and Restart: null while anything runs (as close_call's idleOnly); `run` acts once the reply
	 * is sent, and is skipped if something has started since. */
	reload?: () => { run: () => void } | null;
	restart?: (pane: string) => { run: () => void } | null;
	/** Starts `pi-restart-all --only <pane>` (spawnRestartAll); tests put a fake here. */
	spawnRestart?: (pane: string) => void;
	/** The features Botsun was last told (JSON): a change to them is reported. */
	featuresSent?: string;
	/** A call's verified words, held until the voice helper releases them (session-voice plan). */
	held?: Map<string, { text: string; at: number; proposal?: string; sigV?: 1 | 2 | 3; deviceId?: string }>;
	/** A reply whose video frames are still being extracted: later replies wait for it, to keep their order. */
	framing?: Promise<void>;
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
	/** A sandbox session's VM-tool token from Botsun (sandboxToken), in memory only, until expiresAt (ms). */
	sandboxToken?: { token: string; expiresAt: number };
	/** A sandbox template's own conversation (`sandbox-<slug>`): pi's startup session's id and file. */
	launch?: { id: string; file: string | null } | null;
	/** The conversation the last hello named, cleared by a `session` line naming another: a token is kept only while
	 * pi is still in it (a renewal on its way during a switch is dropped). */
	boundId?: string | null;
	/** /color through the color extension's events (extensions/color): what it is now, null when that extension
	 * isn't loaded; and set it, false when it couldn't. */
	color?: { claim: () => ColorClaim | null; set: (spec: string, at: number) => boolean };
	/** The icon catalog Botsun sent, and the look it last said this session has. #22 reads icon. */
	icons?: IconCatalog;
	icon?: { look: string | null; color: string | null };
	/** What each look draws, from Botsun's looks lines (#21's auto-name picks by it), and the pages
	 * of a set still arriving: a set is published only on its last page, so it never reads half. */
	iconNotes?: Record<string, string>;
	iconNotesHeld?: Record<string, string>;
	iconWait?: { id: string; timer: ReturnType<typeof setTimeout>; resolve: (reply: IconReply) => void };
	/** A /icon pick made before pi wrote the session file (a new session, before its first
	 * message): Botsun only takes an icon from a pi whose file names the session, so it goes once
	 * the file is there. Drawn already; `before` is what a refusal puts back. */
	iconPending?: { request: { kind: "clear" } | { kind: "set"; look: string; color?: string }; before?: { look: string | null; color: string | null } };
	/** The last claim Botsun was told or sent (JSON): a change to it is reported, one Botsun sent is not. */
	colorSaid?: string;
	/** Botsun's color as /color last took it, and for which session: the same color at the same time in
	 * another session was carried there by /color (a /new or /resume), not picked. On the connection,
	 * so it outlives a /reload. */
	colorApplied?: { sessionId: string; color: string; at: number };
	/** The subagents list Botsun was last sent (JSON): a line goes only when it changed. */
	subagentsSent?: string;
	/** What the host says it takes (its features line: model_pages for a paged catalogue), and so what
	 * this session may send it. Undefined until that line arrives: until then, only what an older host takes. */
	hostFeatures?: Set<string>;
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
		if (f.data.length > FILE_B64_MAX || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return "a file is too big (25 MB) or not base64";
	}
	return raw as File[];
}

interface Saved { path: string; note: string; video: boolean }

/** Saves attached files where the agent can read them: inbox/<pid>/<time>-<name>, 0600. */
function saveFiles(files: File[]): Saved[] {
	if (!files.length) return [];
	const dir = join(inboxDir(), String(process.pid));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return files.map((f, i) => {
		// A random tag too: two replies in one millisecond with the same name mustn't collide (wx refuses).
		const path = join(dir, `${stamp}-${i}-${randomBytes(3).toString("hex")}-${f.name}`);
		const data = Buffer.from(f.data, "base64");
		writeFileSync(path, data, { mode: 0o600, flag: "wx" });
		const kb = data.length < 1024 ? `${data.length} B` : data.length < 1048576 ? `${Math.round(data.length / 1024)} KB` : `${(data.length / 1048576).toFixed(1)} MB`;
		// A video by name and by its first box (MP4 / QuickTime "ftyp"), so a renamed file isn't fed to ffmpeg.
		const video = VIDEO_NAME.test(f.name) && data.length >= 12 && data.subarray(4, 8).toString("latin1") === "ftyp";
		return { path, note: `📎 Attached: ${path} (${kb})`, video };
	});
}

/** Runs a program (argv, never a shell) with a timeout; resolves its stdout. SIGKILL at the
 * timeout (ffmpeg can sit on SIGTERM inside a decoder), and the promise settles by then plus a
 * grace even if the child never reports its exit: the reply queue waits on it. */
type VideoRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
const runFile: VideoRunner = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
	const ms = Math.max(1, timeoutMs);
	const child = execFile(cmd, args, { timeout: ms, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" },
		(err, stdout) => { clearTimeout(guard); err ? reject(err) : resolve(stdout); });
	const guard = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("timed out")); }, ms + 1000);
	guard.unref?.();
});

/** ffmpeg / ffprobe on PATH, else in BOTSUN_OWNER_FFMPEG_DIRS (default Homebrew's); null when missing. */
function findTool(name: string): string | null {
	const extra = process.env.BOTSUN_OWNER_FFMPEG_DIRS ?? "/opt/homebrew/bin:/usr/local/bin";
	for (const dir of [...(process.env.PATH ?? "").split(delimiter), ...extra.split(delimiter)]) {
		if (!dir || !dir.startsWith("/")) continue;
		const path = join(dir, name);
		try {
			accessSync(path, fsConstants.X_OK);
			if (lstatSync(path).isDirectory()) continue;
			return path;
		} catch {}
	}
	return null;
}

/** 42.4 → "0:42", 3725 → "1:02:05". */
export function clock(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const mm = String(Math.floor((s % 3600) / 60));
	const ss = String(s % 60).padStart(2, "0");
	return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** n evenly spaced times in [0, duration): 0, d/n, 2d/n, … (one at 0 for a clip under a second). */
export function frameTimes(duration: number, n: number): number[] {
	if (!(duration > 0) || n < 1) return [0];
	const count = duration < 1 ? 1 : n;
	return Array.from({ length: count }, (_, i) => Math.round((duration * i / count) * 100) / 100);
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * A saved video's frames for the agent: ffprobe for the duration, then one ffmpeg per frame into
 * a fresh 0700 temp dir (frames 0600, read back as JPEG, the dir removed). Note: the 🎞️ line, or
 * why there are none (appended to the 📎 line by the caller).
 */
async function videoFrames(path: string, max: number, deadline: number, run: VideoRunner):
	Promise<{ images: UserContent[]; note: string } | { why: string }> {
	const ffmpeg = findTool("ffmpeg");
	const ffprobe = findTool("ffprobe");
	if (!ffmpeg || !ffprobe) return { why: "ffmpeg unavailable" };
	const left = () => deadline - Date.now();
	let dir: string | undefined;
	try {
		if (left() <= 0) return { why: "ffmpeg timed out" };
		const out = await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], left());
		const duration = Number.parseFloat(out.trim());
		if (!Number.isFinite(duration) || duration < 0) return { why: "ffmpeg failed" };
		dir = mkdtempSync(join(tmpdir(), "botsun-frames-"));
		chmodSync(dir, 0o700);
		const images: UserContent[] = [];
		const at: number[] = [];
		for (const [i, t] of frameTimes(duration, max).entries()) {
			if (left() <= 0) break;
			const jpg = join(dir, `frame-${i}.jpg`);
			try {
				await run(ffmpeg, ["-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-ss", String(t), "-i", path, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "4", "-y", jpg], left());
				chmodSync(jpg, 0o600);
				const data = readFileSync(jpg);
				if (!isJpeg(data) || data.length * 4 / 3 > IMAGE_B64_MAX) continue;
				images.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
				at.push(t);
			} catch {}
		}
		if (!images.length) return { why: left() <= 0 ? "ffmpeg timed out" : "ffmpeg failed" };
		const noun = images.length === 1 ? "frame" : "frames";
		return { images, note: `🎞️ Video ${path} (${clock(duration)}): ${images.length} ${noun} at ${at.map(clock).join(", ")}` };
	} catch {
		return { why: left() <= 0 ? "ffmpeg timed out" : "ffmpeg failed" };
	} finally {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

/** Every saved file's note, each video's with its frames (or why none); frames after the photos. */
async function withFrames(saved: Saved[], run: VideoRunner): Promise<{ notes: string[]; frames: UserContent[] }> {
	const videos = saved.filter((s) => s.video).length;
	const per = videos ? Math.max(1, Math.min(FRAMES_PER_VIDEO, Math.floor(FRAMES_MAX / videos))) : 0;
	const deadline = Date.now() + FRAMES_TIMEOUT_MS;
	const notes: string[] = [];
	const frames: UserContent[] = [];
	for (const s of saved) {
		if (!s.video) { notes.push(s.note); continue; }
		const got = await videoFrames(s.path, per, deadline, run);
		if ("why" in got) { notes.push(`${s.note} (no frames: ${got.why})`); continue; }
		notes.push(s.note, got.note);
		frames.push(...got.images);
	}
	return { notes, frames };
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
 * A paired device's raw public key from Botsun's file (null: none), and the file's top-level
 * "host" (this host's authority, which v3 signs; null when missing or not a valid one). Refuses
 * a file others could have written. kind "call": the phone's call key, which signs a call's audio (T5).
 */
function deviceKey(deviceId: string, kind: "decide" | "call" = "decide"): { key: Buffer | null; host: string | null } {
	const path = keysPath();
	const st = lstatSync(path);
	if (!st.isFile() || (st.mode & 0o022) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) {
		throw new Error("owner-keys.json must be a regular file only Eric can write");
	}
	const file = JSON.parse(readFileSync(path, "utf8"));
	const host = validHost(file?.host) ? file.host : null;
	const raw = (kind === "call" ? file?.call_devices : file?.devices)?.[deviceId];
	if (typeof raw !== "string") return { key: null, host };
	const key = Buffer.from(raw, "base64");
	return { key: key.length === 65 && key[0] === 4 ? key : null, host };
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

/** The signing version a request says it was signed with: absent or 1 = v1, 2 = v2, 3 = v3, else null. */
export function sigVersion(r: Record<string, unknown>): 1 | 2 | 3 | null {
	if (r.sig_v === undefined || r.sig_v === 1) return 1;
	return r.sig_v === 2 || r.sig_v === 3 ? r.sig_v : null;
}

/** Whether a request is signed v2 or newer (what "v2 only" means: v3 is v2 plus the host). */
const atLeastV2 = (r: Record<string, unknown>): boolean => (sigVersion(r) ?? 1) >= 2;

/**
 * What a request is signed over. v1: "botsun-decide-v1" … "session", session id, decision,
 * digest(). v2 (sig_v: 2): "botsun-sign-v2" … kind, scope = the session id, decision,
 * sha256(payload()). v3 (sig_v: 3): "botsun-sign-v3", this host's authority (owner-keys.json's
 * "host"), then v2's lines.
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
	let host: string | null;
	try {
		({ key, host } = deviceKey(deviceId, keyKind));
	} catch (e) {
		return (e as Error).message.startsWith("owner-keys") ? (e as Error).message : "no device keys";
	}
	if (!key) return "unknown device";
	if (v >= 2 && !validScope(c.sessionId)) return `this session's id can't be signed (v${v})`;
	if (v === 3 && !host) return V3_NO_HOST;
	let verified = false;
	try {
		const m = { deviceId, nonce, kind: spec.v2.kind, scope: c.sessionId, decision: spec.v2.decision, payload: v >= 2 ? spec.v2.payload() : "" };
		const text = v === 3 ? messageV3({ ...m, host: host! })
			: v === 2 ? messageV2(m)
			: ["botsun-decide-v1", deviceId, nonce, "session", c.sessionId, spec.decision, spec.digest()].join("\n");
		const pub = createPublicKey({ key: Buffer.concat([P256_SPKI, key]), format: "der", type: "spki" });
		verified = verifySignature("sha256", Buffer.from(text, "utf8"), { key: pub, dsaEncoding: "der" }, Buffer.from(signature, "base64"));
	} catch {}
	if (!verified) return "signature does not verify";
	if (v < 3) {
		// The ratchet (pins.ts): a device that has signed v2 (v3) isn't taken at an older version again (a downgrade).
		try {
			const refused = downgrade(signVersionOf(deviceId), v);
			if (refused) return refused;
		} catch (e) {
			return isPinsError(e) ? (e as Error).message : "couldn't read the device's signing version";
		}
	}
	const pinCheck = checkPin(keyKind, deviceId, key);
	if (!pinCheck.ok) {
		if (pinCheck.ask) askPin(c, keyKind, deviceId, pinCheck.ask);
		return pinCheck.error;
	}
	if (v >= 2) {
		try {
			ratchet(deviceId, v as 2 | 3);
		} catch (e) {
			return isPinsError(e) ? (e as Error).message : "couldn't record the device's signing version";
		}
	}
	return null;
}

/** A v1 request from a device that has signed v2 (the ratchet). */
export const V1_REFUSED = "this phone signs v2: v1 is refused (update Botsun and the app)";
/** A v2 request from a device that has signed v3 (the ratchet). */
export const V2_REFUSED = "this phone signs v3: v2 is refused (update Botsun and the app)";
/** A v1 request from a device that has signed v3 (the ratchet). */
export const V1_REFUSED_V3 = "this phone signs v3: v1 is refused (update Botsun and the app)";
/** A v3 request when owner-keys.json names no (valid) host: there's nothing to check it against. */
export const V3_NO_HOST = "owner-keys.json has no valid host: v3 is refused (update Botsun)";

/** The ratchet's refusal for a request signed at v from a device at have, or null when it's taken. */
export function downgrade(have: number, v: number): string | null {
	if (v >= have) return null;
	if (have >= 3) return v === 2 ? V2_REFUSED : V1_REFUSED_V3;
	return V1_REFUSED;
}
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
	if (r.type === "answer") return r.key !== undefined ? answerCall(c, r) : answerAsk(c, r);
	if (r.type === "stash") return stashRequest(c, r);
	if (r.type === "stop") return stopRequest(c, r);
	if (r.type === "stop_child") return stopChildRequest(c, r);
	if (r.type === "close") return r.key !== undefined ? closeCall(c, r) : closeRequest(c, r);
	if (r.type === "reload" || r.type === "restart") return reloadOrRestart(c, r, r.type);
	// Display only (a chip's mode, as a click on the footer flips it): not signed, nothing acts.
	if (r.type === "footer_tap") return footerTap(String(r.chip ?? ""));
	// A read, as Botsun reads a session's own transcript: not signed, and only this session's child.
	if (r.type === "child_transcript") return childTranscriptRequest(c, r);
	if (r.type !== "say") return { error: "unknown request" };
	if (r.key !== undefined) return sayCall(c, r);
	const { text } = r;
	const images = imagesOf(r.images);
	if (typeof images === "string") return { error: images };
	const files = filesOf(r.files);
	if (typeof files === "string") return { error: files };
	if (images.length + files.length > ATTACH_MAX) return { error: `at most ${ATTACH_MAX} attachments` };
	if ([...images, ...files].reduce((n, a) => n + a.data.length, 0) > ATTACH_B64_TOTAL_MAX) {
		return { error: "attachments are over 40 MB together" };
	}
	if (typeof text !== "string" || text.length > TEXT_MAX || (!text.trim() && !images.length && !files.length)) {
		return { error: "text must be 1 to 20000 characters (or attach something)" };
	}
	const say = sayDigest(text, images, files);
	const denied = verifyDevice(c, r, { decision: say.decision, digest: () => say.digest,
		v2: { kind: "session", decision: say.decision, payload: () => say.payload } });
	if (denied) return { error: denied };
	return deliverSay(c, text, images, files);
}

/** A sandbox session token as Botsun mints it (lib/botsun/sandbox_tokens.rb, SandboxTokens::FORMAT). */
export const SANDBOX_TOKEN = /^sandbox\.[A-Za-z0-9_-]{43}$/;
const SANDBOX_TOKEN_MAX_S = 12 * 3600; // SandboxTokens::MAX_AGE
/** Where the VM extensions find sessionToken (their turnHeader). */
export const SESSION_TOKEN = Symbol.for("botsun.sessionToken");

/** The longest line Botsun's end of the connection writes. The icon catalog is the long one
 * (shapes, sets, palette) and stays under this; a sandbox_token line is ~120 bytes. */
const SERVER_LINE_MAX = 4096;
const ICON_WAIT_MS = 5_000;

/**
 * A line Botsun wrote down this process's own connection to it: never taken from <pid>.sock,
 * where any process of this user could connect. Anything else is ignored:
 * - "color": the session's saved color on Botsun (its phone's pick, or a reset's), for /color
 *   (applyColor). Botsun on the Mac and a sandbox VM's bridge both send it.
 * - "name": a rename from the phone's info sheet.
 * - "icons": the icon catalog and the current look, answered to hello and session.
 * - "looks": a page of what each look draws, for a pi whose hello lists "look_notes".
 * - "icon": the answer to an icon line this session sent (/icon).
 * - "sandbox_token": a sandbox session's VM-tool token, from its VM's bridge only
 *   (vm/owner-bridge.mjs, after Botsun bound this session's hello to its template and Eric started
 *   it); a newer one (a renewal) replaces it. Kept in this process only: never a file, env, the
 *   transcript or a log.
 * Returns whether it took one.
 */
export function serverLine(c: Conn, line: string): boolean {
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return false;
	}
	if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
	const { v, type, token, expires_in: ttl } = msg as Record<string, unknown>;
	if (v === 1 && type === "color") return applyColor(c, msg as Record<string, unknown>);
	if (v === 1 && type === "name") return applyName(c, msg as Record<string, unknown>);
	if (v === 1 && type === "icons") return applyIcons(c, msg as Record<string, unknown>);
	if (v === 1 && type === "looks") return applyLookNotes(c, msg as Record<string, unknown>);
	if (v === 1 && type === "icon") return applyIconReply(c, msg as Record<string, unknown>);
	if (v === 1 && type === "features") return applyHostFeatures(c, msg as Record<string, unknown>);
	if (v !== 1 || type !== "sandbox_token") return false;
	if (typeof token !== "string" || !SANDBOX_TOKEN.test(token)) return false;
	if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > SANDBOX_TOKEN_MAX_S) return false;
	if (c.boundId !== c.sessionId) return true; // for a conversation pi has left: read, not kept
	c.sandboxToken = { token, expiresAt: Date.now() + ttl * 1000 };
	return true;
}

/** As many host features as Botsun's own list keeps (OwnerSessions::MAX_FEATURES). */
export const HOST_FEATURES_MAX = 32;

/**
 * What the host takes (its features line, sent after every hello): the names it knows, capped as
 * the host caps its own list. It decides what this session may send in a shape an older host would
 * read wrong: a paged model list, or one page.
 */
function applyHostFeatures(c: Conn, msg: Record<string, unknown>): boolean {
	if (!Array.isArray(msg.features)) return false;
	const names = msg.features.filter((name): name is string => typeof name === "string" && /^[a-z0-9_]{1,40}$/.test(name));
	c.hostFeatures = new Set(names.slice(0, HOST_FEATURES_MAX));
	// The catalogue: hello carried only its first page, and this host can hold all of it.
	if (c.hostFeatures.has("model_pages")) sendModels(c);
	return true;
}

/**
 * Botsun's color for this session, into /color. Only for the session pi is in now (a line for one
 * it has left is read, not taken), only a Botsun name, and only through the color extension: without
 * it, nothing. What Botsun sent is what it is told back, so taking it says nothing new (no echo).
 */
function applyColor(c: Conn, msg: Record<string, unknown>): boolean {
	const push = colorPush(c.sessionId, msg);
	if (!push || !c.color) return false;
	const said = c.colorSaid;
	c.colorSaid = JSON.stringify({ color: push.color, color_at: push.at } satisfies ColorClaim);
	let ok = false;
	// pi's events throw once this instance is stale (a /reload or /new mid-handoff); a throw here
	// would reach the socket's data handler and end pi.
	try { ok = c.color.set(push.spec, push.at); } catch {}
	if (ok) c.colorApplied = { sessionId: c.sessionId!, color: push.color, at: push.at };
	else c.colorSaid = said;
	return ok;
}

/** Botsun's icon catalog, and the look it says this session has. A bad catalog is ignored. */
function applyIcons(c: Conn, msg: Record<string, unknown>): boolean {
	const catalog = takeCatalog(msg);
	if (!catalog) return false;
	c.icons = catalog;
	const look = lookOf(msg, catalog);
	if (look) setIcon(c, look);
	return true;
}

// pi's event bus, for ICON_EVENT: set by main, so a look change (a pick, Botsun's word) redraws a
// footer avatar at once instead of on its next poll.
let iconBus: ExtensionAPI["events"] | undefined;

/** This session's look, as Botsun said or a /icon pick expects it, announced when it changes. */
function setIcon(c: Conn, look: { look: string | null; color: string | null }): void {
	const same = c.icon?.look === look.look && c.icon?.color === look.color;
	c.icon = look;
	if (same) return;
	try { iconBus?.emit?.(ICON_EVENT, { ...look }); } catch {}
}

/**
 * A page of the looks' words: merged into the held set, published on the last page (the first
 * starts a new set, so an unfinished set is never read). A page Botsun sent for a look this
 * catalog doesn't offer stays harmless: the naming catalogue reads only the catalog's looks.
 */
function applyLookNotes(c: Conn, msg: Record<string, unknown>): boolean {
	const page = takeLookNotes(msg);
	if (!page) return false;
	const held = { ...(msg.first === true ? {} : (c.iconNotesHeld ?? {})), ...page };
	if (msg.last !== true) {
		c.iconNotesHeld = held;
		return true;
	}
	c.iconNotesHeld = undefined;
	c.iconNotes = held;
	return true;
}

/**
 * The answer to the icon line this session sent. Only the id it is waiting on is taken: another
 * connection's answer, or a replay, is not this command's. What it says the look is now is checked
 * against the catalog, and an error is stripped before it reaches the TUI.
 */
function applyIconReply(c: Conn, msg: Record<string, unknown>): boolean {
	const wait = c.iconWait;
	if (!wait || msg.id !== wait.id) return false;
	c.iconWait = undefined;
	clearTimeout(wait.timer);
	if (msg.ok === true) {
		const look = lookOf(msg, c.icons) ?? { look: null, color: null };
		setIcon(c, look);
		wait.resolve({ ok: true, ...look, unset: msg.unset === true, cleared: msg.cleared === true });
	} else {
		wait.resolve({ ok: false, error: cleanError(msg.error) });
	}
	return true;
}

function failIconWait(c: Conn, error: string): void {
	const wait = c.iconWait;
	if (!wait) return;
	c.iconWait = undefined;
	clearTimeout(wait.timer);
	wait.resolve({ ok: false, error });
}

/**
 * What Botsun offers a session's icon as, for #21's auto-name: every look, with what it draws when
 * the host sent that, and the palette. Null with no connection, or before the catalog arrives (a
 * host from before the looks lines sends ids only, and those pick a look just as well).
 */
function namingCatalogFor(c: Conn | undefined): NamingCatalog | null {
	if (!c || c.closed || !c.connected || !c.icons) return null;
	const looks = looksOf(c.icons).map((id) => {
		const about = c.iconNotes?.[id];
		return about ? { id, about } : { id };
	});
	return { looks, colors: [...c.icons.colors] };
}

/**
 * #21's suggestion, as an icon line Botsun saves only if nothing is: a look this session has saved
 * is a choice (/icon here, or the phone's sheet) and is left alone, as a pick in flight is. No
 * answer is waited on: the suggestion is not a command, and nothing on screen says it landed.
 */
function suggestIconLine(c: Conn | undefined, suggestion: IconSuggestion): void {
	if (!c || c.closed || !c.connected || !c.sock) return;
	if (!c.sessionId || c.boundId !== c.sessionId) return;
	if (!c.icons || !looksOf(c.icons).includes(suggestion.look)) return;
	if (c.icon?.look) return;
	if (c.iconWait || c.iconPending) return;
	const id = randomBytes(8).toString("hex");
	const line: Record<string, unknown> = { id, look: suggestion.look, if_unset: true };
	if (suggestion.color) line.color = suggestion.color;
	debug(`icon suggestion: ${suggestion.look}${suggestion.color ? `, ${suggestion.color}` : ""}`);
	write(c, "icon", line);
}

/** What /icon says it set. */
function iconSaid(look: string | null | undefined, color: string | null | undefined): string {
	return look ? (color ? `icon: ${look}, ${color}` : `icon: ${look}`) : "icon: automatic";
}

/** The current look, for a footer avatar (#22). Null until Botsun has said, or after a session switch. */
export function sessionIcon(): { look: string | null; color: string | null } | null {
	const c = store[STORE];
	if (!c || c.closed) return null;
	return c.icon ?? null;
}

async function pickIcon(ctx: ExtensionContext, catalog: IconCatalog | undefined, current?: { look: string | null; color: string | null }): Promise<{ kind: "clear" } | { kind: "set"; look: string; color?: string } | undefined> {
	if (!catalog) {
		ctx.ui.notify("Botsun hasn't sent its icons yet", "info");
		return;
	}
	if (typeof ctx.ui.select !== "function") {
		ctx.ui.notify("usage: /icon <look> [color]", "info");
		return;
	}
	const looks = looksOf(catalog);
	// Drawn when the terminal can: each look in the color it would keep, then the look in each color.
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function" && canDrawIcons()) {
		const sessionColor = process.env.PI_SESSION_COLOR;
		const keep = current?.color && catalog.colors.includes(current.color) ? current.color
			: sessionColor && catalog.colors.includes(sessionColor) ? sessionColor
			: catalog.colors.includes("gray") ? "gray" : catalog.colors[0];
		const lookItems: PickItem[] = [...looks.map((l) => ({ value: l, label: l, look: l, color: keep })), { value: "automatic", label: "automatic" }];
		const look = await pickDrawn(ctx, "Session icon", lookItems, current?.look ?? undefined);
		if (look === undefined) return;
		if (look === "automatic") return { kind: "clear" };
		const colorItems: PickItem[] = [...catalog.colors.map((c) => ({ value: c, label: c, look, color: c })), { value: "keep color", label: "keep color", look, color: keep }];
		const color = await pickDrawn(ctx, `Icon color: ${look}`, colorItems, keep);
		if (color === undefined) return;
		if (color === "keep color") return { kind: "set", look };
		return { kind: "set", look, color };
	}
	const look = await ctx.ui.select("Session icon", [...looks, "automatic"]);
	if (look === undefined) return;
	if (look === "automatic") return { kind: "clear" };
	const color = await ctx.ui.select("Icon color", [...catalog.colors, "keep color"]);
	if (color === undefined) return;
	if (color === "keep color") return { kind: "set", look };
	return { kind: "set", look, color };
}

function sendIcon(c: Conn, req: { kind: "clear" } | { kind: "set"; look: string; color?: string }): Promise<IconReply> {
	if (!c.connected || !c.sock) return Promise.resolve({ ok: false, error: ICON_DISCONNECTED });
	const id = randomBytes(8).toString("hex");
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (c.iconWait?.id === id) c.iconWait = undefined;
			resolve({ ok: false, error: "Botsun didn't answer" });
		}, ICON_WAIT_MS);
		timer.unref();
		c.iconWait = { id, timer, resolve };
		write(c, "icon", { id, ...iconLineFields(req) });
	});
}

// What a name never carries: control characters, the line and paragraph separators, and the
// direction marks and overrides that would make it read other than it is.
const NAME_BAD = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const ERROR_BAD = /[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const ERROR_MAX = 80;

/** An icon answer's error, as pi may show it: no control characters, line separators or direction
 * marks (Botsun's own are plain English, but the wire is any same-user process on the owner
 * socket), and short enough for one TUI line. Never empty. */
export function cleanError(raw: unknown): string {
	const plain = typeof raw === "string" ? raw.replace(ERROR_BAD, "") : "";
	const short = plain.slice(0, ERROR_MAX).trim();
	return short || "Botsun refused the icon";
}

/** A name from Botsun (or the phone's /name) as pi may take it: undefined when nothing is left. */
export function cleanName(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	if (NAME_BAD.test(raw)) return undefined; // refused whole, never quietly fixed
	const name = raw.trim().slice(0, NAME_MAX).trim();
	return name || undefined;
}

/**
 * Botsun's rename (the phone's info sheet, signed there), into pi's session name. Only for the
 * session pi is in now (a line for one it has left is read, not taken), only a clean name, and only
 * through pi's own setSessionName: never a shell, tmux or a command line. Then a features line, so
 * Botsun hears the new name now (every line carries it) rather than at the next state change.
 */
function applyName(c: Conn, msg: Record<string, unknown>): boolean {
	if (msg.session_id !== c.sessionId || !c.sessionId) return false;
	if (c.boundId !== c.sessionId) return true;
	const name = cleanName(msg.name);
	if (!name || !c.setSessionName) return false;
	// pi's calls throw once this instance is stale (a /reload or /new mid-handoff); a throw here
	// would reach the socket's data handler and end pi.
	try { c.setSessionName(name); } catch { return false; }
	c.namedAt = Date.now();
	try { reportFeatures(c); } catch {}
	return true;
}

/** The /color claim for a hello or session line ({color, color_at}), noted as said; none without the color extension. */
function colorFields(c: Conn): Partial<ColorClaim> & { color_carried?: true } {
	let claim: ColorClaim | null = null;
	try { claim = c.color?.claim() ?? null; } catch {}
	if (!claim) return {};
	c.colorSaid = JSON.stringify(claim);
	return carried(c, claim);
}

/** The claim, with color_carried when it is the color Botsun gave another session: Botsun keeps that one
 * from becoming this session's pick, even when it no longer remembers sending it (a restart between). */
function carried(c: Conn, claim: ColorClaim): ColorClaim & { color_carried?: true } {
	const a = c.colorApplied;
	return a && a.sessionId !== c.sessionId && a.color === claim.color && a.at === claim.color_at ? { ...claim, color_carried: true } : claim;
}

/** This session's sandbox token while its connection to Botsun is up and the token unexpired, else undefined. */
export function sessionToken(): string | undefined {
	const c = store[STORE];
	const t = c?.sandboxToken;
	if (!c || !t || c.closed || !c.connected) return undefined;
	if (Date.now() >= t.expiresAt) {
		c.sandboxToken = undefined;
		return undefined;
	}
	return t.token;
}
Object.defineProperty(globalThis, SESSION_TOKEN, { value: sessionToken, configurable: true, writable: true });

/**
 * A text reply signed with the phone's call key (key: "call"), so the Watch can answer while the
 * phone is locked. Text only, v2 only, its own decision "say_call" over the same payload as a
 * text say: a main-key "say" signature never verifies here, nor this one as a "say".
 */
function sayCall(c: Conn, r: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
	if (r.key !== "call") return { error: "bad request" };
	if (r.images !== undefined || r.files !== undefined || r.attachments !== undefined) return { error: "a call-key reply is text only" };
	if (!atLeastV2(r)) return { error: "a call-key reply must be signed v2" };
	const { text } = r;
	if (typeof text !== "string" || !text.trim() || text.length > TEXT_MAX) return { error: "text must be 1 to 20000 characters" };
	// Words only from a locked phone: no slash command (/bypass on, /model, a skill or a template)
	// and nothing in the shape of pi's ! bash prefix. Botsun refuses these too.
	if (LOCKED_COMMAND.test(text)) return { error: "a locked-phone reply can't run commands" };
	const payload = () => `botsun-propose-text-v1\n${text}`;
	const denied = verifyDevice(c, r, { decision: "say_call", digest: () => sha256hex(payload()),
		v2: { kind: "session", decision: "say_call", payload } }, "call");
	if (denied) return { error: denied };
	return deliverSay(c, text, [], [], { noCommands: true });
}

/** What a locked-phone reply may not start with: "/" (commands, skills, templates) or "!" (bash). */
export const LOCKED_COMMAND = /^[\s\p{Cf}]*[\/!]/u; // spaces and invisible format chars, then / or ! (as Botsun checks)

function deliverSay(c: Conn, text: string, images: Image[], files: File[], opts: { noCommands?: boolean } = {}): Record<string, unknown> | Promise<Record<string, unknown>> {
	let saved: Saved[];
	try {
		saved = saveFiles(files);
	} catch (e) {
		return { error: `couldn't save the file: ${(e as NodeJS.ErrnoException).code ?? "error"}` };
	}
	const compose = (notes: string[], frames: UserContent[]): string | UserContent[] => {
		const said = [text, ...notes].filter((t) => t.trim()).join("\n\n");
		const pics: UserContent[] = [...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mime_type })), ...frames];
		return pics.length ? [...(said.trim() ? [{ type: "text" as const, text: said }] : []), ...pics] : said;
	};
	const notes = saved.map((s) => s.note);
	if (!opts.noCommands && !images.length && !notes.length && c.command) {
		const outcome = c.command(text, c.busy);
		if (typeof outcome === "string") return { error: outcome };
		if (outcome === null) {
			debug("owner say ran a slash command");
			return { ok: true, delivered: "command" };
		}
	}
	const delivered = c.busy ? "steer" : "prompt";
	if (saved.some((s) => s.video) || c.framing) {
		// Frames take ffmpeg a few seconds: reply now (the socket and Botsun don't wait), deliver when
		// they're ready, and queue later replies behind it so they keep their order.
		const job: Promise<void> = (c.framing ?? Promise.resolve())
			.then(() => withFrames(saved, runFile))
			.then(({ notes, frames }) => c.inject(compose(notes, frames), c.busy))
			.catch((e) => debug(`owner say with a video: ${(e as Error).message}`))
			.finally(() => { if (c.framing === job) c.framing = undefined; });
		c.framing = job;
		debug(`owner say accepted (${text.length} chars, ${images.length} photos, ${files.length} files, frames pending)`);
		return { ok: true, delivered };
	}
	c.inject(compose(notes, []), c.busy);
	debug(`owner say accepted (${text.length} chars, ${images.length} photos, ${files.length} files)`); // never the text
	return { ok: true, delivered };
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
	const v2 = !isText && (h.sigV ?? 1) >= 2;
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
	// The ratchet, again: words held from before the device's first v2 (v3) don't count after it.
	if ((h.sigV ?? 1) < 3) {
		try {
			if (!h.deviceId && (h.sigV ?? 1) < 2) return { error: V1_REFUSED };
			const refused = h.deviceId ? downgrade(signVersionOf(h.deviceId), h.sigV ?? 1) : null;
			if (refused) return { error: refused };
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
	if (prompt?.sensitive && !atLeastV2(r)) return spend(SENSITIVE_V1_REFUSED);
	if (atLeastV2(r)) {
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

/** A sensitive ask (op-broker's secret approval) picked on a locked phone: refused. */
export const ANSWER_CALL_SENSITIVE = "answer this one on the unlocked phone or the keyboard";

/**
 * An ask's option picked on the Watch while the phone is locked, signed with the phone's
 * call key (key: "call"). v2 (or v3) only, its own decision "answer_call" (kind session, scope the
 * session id) over canonicalAnswerV2 of the prompt's own one question and one pick: a main-key
 * "answer" signature never verifies here, nor this one as an "answer". Taken only for the open
 * ask (askLine's, the one the phone was shown) when it isn't sensitive and has exactly one
 * single-select question, for exactly one answer of exactly one in-range pick and no text; then
 * answered exactly as a device-key answer of picks [i] would be.
 */
function answerCall(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	// Refused before verifyDevice: spend the nonce anyway (one try per nonce, as there).
	const spend = (error: string) => {
		if (typeof r.nonce === "string") takeNonce(c, r.nonce);
		return { error };
	};
	if (r.key !== "call") return spend("bad request");
	const { ask_id: id, answers } = r;
	if (typeof id !== "string") return spend("bad request");
	if (!atLeastV2(r)) return spend("a call-key answer must be signed v2");
	const a = Array.isArray(answers) && answers.length === 1 ? (answers[0] as Record<string, unknown> | null) : null;
	const picks = a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).length === 1 ? a.picks : null;
	if (!Array.isArray(picks) || picks.length !== 1 || !Number.isInteger(picks[0])) return spend("a call-key answer is exactly one pick, no text");
	const pick = picks[0] as number;
	const open = openPrompts();
	const prompt = open[open.length - 1]; // the open one: askLine's
	if (!prompt || prompt.id !== id) return spend("that question was already answered");
	if (prompt.sensitive) return spend(ANSWER_CALL_SENSITIVE);
	const q = prompt.questions.length === 1 ? prompt.questions[0] : undefined;
	if (!q || q.multiSelect) return spend("a locked phone can answer only one single-choice question");
	if (pick < 0 || pick >= q.options.length) return spend("a pick isn't one of the options");
	const picked = [{ picks: [pick] }];
	const bad = invalidAnswer(prompt.questions, picked);
	if (bad) return spend(bad);
	const denied = verifyDevice(c, r, {
		decision: "answer_call",
		digest: () => "",
		v2: { kind: "session", decision: "answer_call", payload: () => canonicalAnswerV2(prompt.id, prompt.questions, picked) },
	}, "call");
	if (denied) return { error: denied };
	const error = prompt.answer(picked);
	if (error) return { error };
	debug("owner answer_call answered an ask");
	return { ok: true };
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

/** A v1-signed stop_child: it takes v2 or newer only. */
export const STOP_CHILD_V1_REFUSED = "stop_child needs a v2 signature: v1 is refused (update Botsun and the app)";
/** A subagent id as lib/children.ts makes them, and as Botsun's list keeps them. */
/** Botsun's CHILD_ID: never "." or "..", since the phone puts the id in a route's path. */
const CHILD_ID = /^[A-Za-z0-9][\w.-]{0,39}$/;

/**
 * The phone's Stop on one subagent (its row's detail): aborts that child only, foreground or a
 * bg job. Signed with the decision key, v2 or newer, over "stop_child\n<id>" (this session's
 * nonce: single use). Only a child on this session's own list (lib/children.ts) is stopped.
 */
function stopChildRequest(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const id = typeof r.child_id === "string" && CHILD_ID.test(r.child_id) ? r.child_id : null;
	if (!id) return { error: "bad request" };
	const payload = `stop_child\n${id}`;
	const denied = verifyDevice(c, r, { decision: "stop_child", digest: () => sha256hex(Buffer.from(payload, "utf8")),
		v2: { kind: "session", decision: "stop_child", payload: () => payload } });
	if (denied) return { error: denied };
	if (!atLeastV2(r)) return { error: STOP_CHILD_V1_REFUSED };
	const result = stopChild(c.sessionId, id);
	if (result === "not_found") return { error: "no such subagent in this session" };
	if (result === "unstoppable") return { error: "this subagent can't be stopped from the phone" };
	return { ok: true, stopped: result === "stopped" };
}

/**
 * One page of a subagent's conversation for its chat on the phone (lib/children.ts's
 * childTranscript): the entries past `since`, at most PAGE_BYTES of them, so the reply stays one
 * line under OwnerSessions::MAX_LINE. Botsun asks again while `more` says so.
 */
function childTranscriptRequest(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const id = typeof r.child_id === "string" && CHILD_ID.test(r.child_id) ? r.child_id : null;
	if (!id) return { error: "bad request" };
	const since = typeof r.since === "number" && Number.isSafeInteger(r.since) && r.since >= -1 ? r.since : -1;
	const page = childTranscript(c.sessionId, id, since);
	if (!page) return { error: "no such subagent in this session" };
	return { ok: true, entries: page.entries, last: page.last, more: page.more, live: page.live, state: page.state };
}

/** Under OwnerSessions::MAX_LINE (64 KB) with the line's envelope. */
export const SUBAGENTS_BYTES = 56 * 1024;
/** Progress (a new tool, a turn) goes at most this often; a start or an end at once. */
export const SUBAGENTS_EVERY_MS = 1_000;

/** One child as Botsun takes it (snake_case). `context` and `window` are what the phone's
 * context bar needs: absent when the child hasn't said (a Cursor run, a pi child whose model pi
 * doesn't know), so an older phone reads the line as before. */
function childWire(k: ChildInfo, tail: number, text: number): Record<string, unknown> {
	return {
		id: k.id,
		kind: k.kind,
		agent: k.agent,
		task: k.task,
		...(k.model ? { model: k.model } : {}),
		state: k.state,
		started_at: k.startedAt,
		...(k.endedAt !== undefined ? { ended_at: k.endedAt } : {}),
		turns: k.turns,
		activity: k.activity,
		last_text: k.lastText.slice(0, text),
		tail: tail > 0 ? k.tail.slice(-tail) : [],
		...(k.usage
			? { usage: { input: k.usage.input, output: k.usage.output, cache_read: k.usage.cacheRead, cache_write: k.usage.cacheWrite, cost: k.usage.cost } }
			: {}),
		...(k.usage?.context !== undefined ? { context: Math.round(k.usage.context) } : {}),
		...(k.window !== undefined ? { window: Math.round(k.window) } : {}),
		...(k.worktree ? { worktree: k.worktree } : {}),
	};
}

/**
 * The session's children for Botsun, at most `max` bytes as JSON: past it the finished ones'
 * tails go first, then everyone's tail and text shrink, then the oldest finished ones drop.
 */
export function subagentsLine(children: ChildInfo[], max = SUBAGENTS_BYTES): Record<string, unknown>[] {
	const fits = (list: Record<string, unknown>[]) => Buffer.byteLength(JSON.stringify(list)) <= max;
	const steps: Array<(k: ChildInfo) => [number, number]> = [
		() => [30, 600],
		(k) => (k.state === "running" ? [30, 600] : [5, 600]),
		(k) => (k.state === "running" ? [10, 300] : [0, 300]),
		() => [0, 200],
	];
	for (const step of steps) {
		const list = children.map((k) => childWire(k, ...step(k)));
		if (fits(list)) return list;
	}
	const kept = [...children];
	while (kept.length > 0) {
		const finished = kept.findIndex((k) => k.state !== "running");
		kept.splice(finished >= 0 ? finished : 0, 1);
		const list = kept.map((k) => childWire(k, 0, 200));
		if (fits(list)) return list;
	}
	return [];
}

/** The session's subagents, when they changed since Botsun was last sent them (or `force`). */
export function reportSubagents(c: Conn, force = false): void {
	const children = subagentsLine(c.sessionId ? listChildren(c.sessionId) : []);
	const key = JSON.stringify(children);
	if (!force && key === c.subagentsSent) return;
	c.subagentsSent = key;
	write(c, "subagents", { children });
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
	if (!atLeastV2(r)) return { error: CLOSE_V1_REFUSED };
	if (!c.close) return { error: "this session can't close from the phone yet; run /reload" };
	const { shutdown } = c.close()!;
	return { ok: true, [AFTER_REPLY]: shutdown };
}

/** A locked phone's close while a turn runs (Botsun refuses it first, naming the session). */
export const CLOSE_CALL_BUSY = "this session is running a turn: close it once the turn ends, or from the app";

/**
 * A locked phone's Close session (a reply notification's, the Watch's), signed with the phone's
 * call key (key: "call"). v2 only, its own decision "close_call" over "close": a main-key "close"
 * never verifies here, nor this one as a "close". Unlike close it never ends a running turn: refused
 * while one runs (after verifyDevice, so its nonce is spent and it can't land once the turn ends).
 */
function closeCall(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	if (r.key !== "call") return { error: "bad request" };
	if (!atLeastV2(r)) return { error: "a call-key close must be signed v2" };
	const denied = verifyDevice(c, r, { decision: "close_call", digest: () => sha256hex(Buffer.from("close", "utf8")),
		v2: { kind: "session", decision: "close_call", payload: () => "close" } }, "call");
	if (denied) return { error: denied };
	if (!c.close) return { error: "this session can't close from the phone yet; run /reload" };
	// null while anything runs: pi's turn, Botsun's busy, a compaction, a reply whose video frames
	// are still being extracted, or a sent prompt not started yet or queued (a turn on its way in).
	// Its shutdown checks the same again. Botsun's busy and framing are also checked here, on this
	// connection, in case running() ever stops covering them.
	if (c.busy || c.framing) return { error: CLOSE_CALL_BUSY };
	const closing = c.close({ idleOnly: true });
	if (!closing) return { error: CLOSE_CALL_BUSY };
	debug("owner close_call closed the session");
	return { ok: true, [AFTER_REPLY]: closing.shutdown };
}

export const RELOAD_BUSY = "this session is running a turn: reload once it ends";
export const RESTART_BUSY = "this session is running a turn: restart once it ends";
export const RESTART_NO_TMUX = "this session can't restart from the phone: it isn't running in tmux";
export const dialogOpen = (what: "reload" | "restart"): string => `this session has a dialog open: ${what} once it's answered`;
export const v2OnlyRefused = (what: "reload" | "restart"): string =>
	`${what} needs a v2 signature: v1 is refused (update Botsun and the app)`;

/** The restart extension's records (extensions/restart, liveDir), by path: no import. */
const restartLiveDir = (env: NodeJS.ProcessEnv): string =>
	join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-restart", "live");
const RESTART_ALL = fileURLToPath(new URL("../../../bin/pi-restart-all", import.meta.url));

/**
 * The tmux pane pi-restart-all can restart this pi in, or null. What the script itself checks
 * before it signals (else it skips the pane quietly): pi's process title is "pi", in a tmux pane
 * whose server socket is there, and the restart extension's record for this pid names that pane
 * and server and isn't on its way out; and the script is there to run.
 */
export function restartTarget(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid, bin: string = RESTART_ALL): { pane: string } | null {
	const pane = env.TMUX_PANE ?? "";
	const socket = (env.TMUX ?? "").split(",")[0] ?? "";
	if (process.title !== "pi" || !/^%\d+$/.test(pane) || !socket) return null;
	try {
		if (!statSync(socket).isSocket()) return null;
		const path = join(restartLiveDir(env), `${pid}.json`);
		if (!lstatSync(path).isFile()) return null;
		const rec = JSON.parse(readFileSync(path, "utf8"));
		if (rec?.pid !== pid || rec.pane !== pane || rec.socket !== socket || rec.exiting === true) return null;
		accessSync(bin, fsConstants.X_OK);
	} catch {
		return null;
	}
	return { pane };
}

/** `pi-restart-all --only <pane>`: it hands itself to the tmux server (run-shell -b), so it outlives this pi. */
function spawnRestartAll(pane: string): void {
	const child = spawn(RESTART_ALL, ["--only", pane], { detached: true, stdio: "ignore" });
	child.on("error", (e) => debug(`restart: ${e.message}`));
	child.unref();
}

/**
 * The phone's Reload (/reload: extensions, prompts, skills) and Restart (pi-restart-all restarts
 * this pi in its tmux pane and resumes the session). Signed like close, v2 only, each over its own
 * decision ("reload" / "restart", payload the same word), so neither signature passes as the other
 * or as a close. Refused while anything runs or a dialog is open (a reload would dismiss it), after
 * verifyDevice so the nonce is spent; restart also when this pi can't be restarted. Else {ok} first
 * and the act after the reply.
 */
function reloadOrRestart(c: Conn, r: Record<string, unknown>, what: "reload" | "restart"): Record<string, unknown> {
	if (r.key !== undefined) return { error: "bad request" };
	const denied = verifyDevice(c, r, { decision: what, digest: () => sha256hex(Buffer.from(what, "utf8")),
		v2: { kind: "session", decision: what, payload: () => what } });
	if (denied) return { error: denied };
	if (!atLeastV2(r)) return { error: v2OnlyRefused(what) };
	if (!c.reload || !c.restart) return { error: `this session can't ${what} from the phone yet; run /reload` };
	const target = what === "restart" ? restartTarget() : null;
	if (what === "restart" && !target) return { error: RESTART_NO_TMUX };
	const busy = what === "reload" ? RELOAD_BUSY : RESTART_BUSY;
	if (c.busy || c.framing) return { error: busy };
	if (c.prompt) return { error: dialogOpen(what) };
	const acting = target ? c.restart(target.pane) : c.reload();
	if (!acting) return { error: busy };
	debug(`owner ${what} from the phone`);
	return { ok: true, [AFTER_REPLY]: acting.run };
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

/** The provider's usage windows (provider-usage's numbers, chip shown or not), or null. */
export function usageLine(): ProviderUsageSnapshot | null {
	return latestUsage();
}

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

/** agent-link's name for this pid, else the pi session name, else the folder. A name set through
 * pi from here (Botsun's rename, the phone's /name) after agent-link last wrote its file wins. */
export function currentName(c: Conn): string {
	let name: string | undefined;
	let piName: string | undefined;
	try { piName = c.sessionName()?.trim() || undefined; } catch {}
	try {
		const file = join(homedir(), ".claude", "sessions", `${process.pid}.json`);
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (typeof raw?.name === "string" && raw.name.trim()) name = raw.name.trim();
		if (name && piName && c.namedAt && c.namedAt > statSync(file).mtimeMs) name = piName;
	} catch {}
	return (name || piName || basename(c.cwd) || c.cwd).slice(0, NAME_MAX);
}

function write(c: Conn, type: string, extra: Record<string, unknown> = {}): void {
	if (!c.connected || !c.sock) return;
	const line = JSON.stringify({ v: 1, type, pid: process.pid, at: new Date().toISOString(), name: currentName(c), ...extra });
	try { c.sock.write(`${line}\n`); } catch {}
}

// A compaction under way (its reason): pi refuses a prompt mid-compaction, so the phone's words
// wait for it to end (held in main), and the phone shows it.
let compacting: string | null = null;
// When a prompt was last sent (sendUser, pi's input and before_agent_start events; 0 once a turn
// starts or settles): pi runs async input and before_agent_start handlers before the turn starts,
// so for a moment a sent prompt is neither streaming nor busy. A locked phone's close counts it as
// running for a while.
let inputAt = 0;
const PROMPT_STARTING_MS = 10_000;
// Every prompt this extension sends: marked before pi's input event fires for it.
// The quiet extension consumes this mark, so a phone message starts a run of
// Eric's, not a quiet background run.
const QUIET_MINE_EVENT = "quiet:mine";
const QUIET_RUN_EVENT = "quiet:run";
const QUIET_ATTENTION_EVENT = "quiet:attention";
const QUIET_SPLIT_EVENT = "quiet:split";
const QUIET_STATE = Symbol.for("pi-boehsline.quiet");

/** False when the quiet extension is not loaded: every run is Eric's. */
function runIsQuiet(): boolean {
	const state = (globalThis as Record<symbol, unknown>)[QUIET_STATE] as { quiet?: unknown } | undefined;
	return state?.quiet === true;
}

function sendUser(pi: ExtensionAPI, content: string | UserContent[], options?: Parameters<ExtensionAPI["sendUserMessage"]>[1]): void {
	inputAt = Date.now();
	try { pi.events?.emit?.(QUIET_MINE_EVENT, {}); } catch {}
	// The stash's auto-restore goes to the phone that sent this, not the terminal's editor.
	markRemoteSubmit();
	pi.sendUserMessage(content, options);
}
// Whether the approval guardian is bypassed (its state event), for the phone's red title.
let bypassed = false;
const GUARDIAN_BYPASS_STATE_EVENT = "approval-guardian:temporary-bypass-state";
// The color extension's (extensions/color), by name: no import either way.
const COLOR_SET_EVENT = "color:set";
const COLOR_STATE_EVENT = "color:state";
const COLOR_QUERY_EVENT = "color:query";

/** /color through the color extension's events: claim() is null when it isn't loaded, set() false when it couldn't. */
export function colorHooks(pi: Pick<ExtensionAPI, "events">): NonNullable<Conn["color"]> {
	return {
		claim: () => {
			let state: unknown = null;
			pi.events?.emit?.(COLOR_QUERY_EVENT, { reply: (s: unknown) => { state = s; } });
			return claimOf(state as { spec?: unknown; at?: unknown } | null);
		},
		set: (spec, at) => {
			const req: { spec: string; at: number; from: string; handled?: boolean; error?: string } = { spec, at, from: "Botsun" };
			pi.events?.emit?.(COLOR_SET_EVENT, req);
			return req.handled === true && !req.error;
		},
	};
}

/** A /color change, for Botsun: reported unless it is what Botsun was last told or sent. */
export function reportColor(c: Conn | undefined, state: unknown): void {
	if (!c || c.closed) return;
	const claim = claimOf(state as { spec?: unknown; at?: unknown } | null);
	if (!claim) return;
	const key = JSON.stringify(claim);
	if (key === c.colorSaid) return;
	c.colorSaid = key;
	write(c, "color", { ...carried(c, claim) });
}
const GUARDIAN_BYPASS_CONTROL_EVENT = "approval-guardian:set-temporary-bypass";

// What this version takes: the nonce reply's list, also in hello (and after a reload) so the
// phone's Sessions list knows which sessions can close without asking each one for a nonce.
function featureList(c: Conn): string[] {
	const hasStash = (() => {
		try { return c.commands?.().some((x) => x.name === "stash") ?? false; } catch { return false; }
	})();
	return ["say", "say_call", "answer_call", "close_call", "images", "files", "say_audio", "hold", "stop", "confirm", "confirm_text", "stream", "ask", "sign_v2", "sign_v3", "ask_v2", "close", "name",
		// This pi picks a look with a session's name (#21) and wants what each draws with it: the host
		// answers with its looks pages (OwnerSessions' LOOK_NOTES).
		"look_notes",
		// This pi sends a catalogue in pages (sendModels) when the host says it appends them: the host
		// answers this with its own features line (OwnerSessions' HOST_FEATURES).
		"model_pages",
		"subagents", "subagent_chats", ...(hasStash ? ["stash"] : []), ...(c.reload ? ["reload"] : []),
		...(c.restart && restartTarget() ? ["restart"] : [])];
}

/** A features line; unless forced, only when they changed since Botsun was last told (restart comes and goes). */
function reportFeatures(c: Conn, force = true): void {
	const features = featureList(c);
	const key = JSON.stringify(features);
	if (!force && key === c.featuresSent) return;
	c.featuresSent = key;
	write(c, "features", { features });
}

/** The conversation a sandbox template's pi was started in, from its first session: Botsun starts it
 * with `--session-id sandbox-<slug>`. Any other first session (a Mac pi) has none. */
export function launchOf(info: { sessionId: string | null; sessionFile: string | null }): { id: string; file: string | null } | null {
	return info.sessionId?.startsWith("sandbox-") ? { id: info.sessionId, file: info.sessionFile } : null;
}

/** A switch back to the conversation a sandbox template's pi was started in (same id and file) says
 * hello again rather than `session`: the host refuses a connection that left its own conversation,
 * and only a fresh hello from the pid it armed for that template puts it back. Any other switch keeps
 * the `session` line. (A reconnect says hello for whatever conversation is current: the host refuses
 * it while that template's own armed pi is live, and otherwise lists this pi as that template, with
 * no token and no deliveries, which go only to a template's armed pid.) */
export function helloOnSwitch(prev: { sessionId: string | null }, next: { sessionId: string | null; sessionFile: string | null },
	launch: { id: string; file: string | null } | null | undefined): boolean {
	return !!launch && next.sessionId === launch.id && next.sessionFile === launch.file && prev.sessionId !== next.sessionId;
}

/** pi's startup session, recorded once per process (it outlives a connection: a slow handoff or a
 * late opt-in makes a new one, which must not take the conversation pi is in then as its own). */
const LAUNCH = Symbol.for("botsun-owner.launch");

function sendHello(c: Conn): void {
	c.boundId = c.sessionId;
	const features = featureList(c);
	c.featuresSent = JSON.stringify(features);
	write(c, "hello", {
		features,
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
		// A first page only, and a small one: hello must stay under the host's line limit, and a
		// catalogue is bigger than that. A host that takes pages gets the whole list on models
		// lines once it says so (serverLine's features line, sendModels); for one that doesn't,
		// this page is the whole list.
		models: (() => {
			try { return modelPages(c.models?.() ?? [], HELLO_MODELS_BYTES)[0] ?? []; } catch { return []; }
		})(),
		stash: stashLine(c),
		footer: footerLine(),
		usage: usageLine(),
		compacting,
		bypass: bypassed,
		...colorFields(c),
		context: (() => {
			try { return c.context?.() ?? null; } catch { return null; }
		})(),
	});
	// A line of its own, not a hello field: hello must stay under the host's line limit. A hello
	// clears the host's list, so an empty one needs no line.
	c.subagentsSent = "[]";
	reportSubagents(c);
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
		// The rest of the catalogue follows once the host says it takes pages (its features line):
		// a host from before that replaces its list on every models line.
	});
	// Botsun writes this session's saved color, and a sandbox VM's bridge its token too
	// (serverLine). Read line by line, at most SERVER_LINE_MAX each, so the socket can't stall.
	let buf = "";
	let skipping = false; // inside a line over SERVER_LINE_MAX: dropped to its newline
	sock.setEncoding("utf8");
	sock.on("data", (chunk: string) => {
		if (c.sock !== sock) return;
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			if (!skipping && nl <= SERVER_LINE_MAX) {
				try { serverLine(c, buf.slice(0, nl)); } catch {} // an uncaught throw in a socket handler ends pi
			}
			skipping = false;
			buf = buf.slice(nl + 1);
		}
		if (buf.length > SERVER_LINE_MAX) {
			buf = "";
			skipping = true;
		}
	});
	sock.on("error", (err) => debug(`socket error: ${(err as NodeJS.ErrnoException).code ?? err.message}`));
	sock.on("close", () => {
		if (c.sock !== sock) return;
		c.sock = undefined;
		c.connected = false;
		c.sandboxToken = undefined; // Botsun revoked it with the connection: the next hello gets a new one
		failIconWait(c, ICON_DISCONNECTED);
		scheduleRetry(c);
	});
}

/** Stop for good: bye if connected, end the socket, clear timers. */
function close(c: Conn): void {
	if (c.closed) return;
	write(c, "bye");
	failIconWait(c, ICON_DISCONNECTED);
	c.closed = true;
	clearTimeout(c.retryTimer);
	clearTimeout(c.handoffTimer);
	c.retryTimer = c.handoffTimer = undefined;
	const sock = c.sock;
	c.sock = undefined;
	c.connected = false;
	c.sandboxToken = undefined;
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
/** The command the phone's reload runs through (main); not on the phone's "/" list. */
export const RELOAD_COMMAND = "botsun-reload";

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
		.filter((c) => !seen.has(c.name) && !BUILTINS.has(c.name) && c.name !== RELOAD_COMMAND && c.name !== "icon" && /^[A-Za-z][\w:.-]*$/.test(c.name))
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
		const clean = cleanName(args);
		if (!clean) return "a name can't have control characters or direction marks";
		pi.setSessionName(clean);
		const c = store[STORE];
		if (c) c.namedAt = Date.now(); // what every line says now, over agent-link's older name
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
		sendUser(pi, text.trim(), { expandPromptTemplates: true });
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
	/** One of the session's scoped models (the `enabledModels` setting or `--models`). */
	scoped: boolean;
}

/** The most models the phone is sent: its picker searches them, so it gets the catalogue. */
export const PHONE_MODELS_MAX = 1000;
/**
 * The bytes of JSON one models line carries for its list. The host drops a line over its 64 KB
 * limit (a sandbox relay refuses the whole batch), and the field caps are characters, not bytes:
 * a page is measured, not counted, so 100 models of multi-byte names can't overrun it.
 */
export const PHONE_MODELS_BYTES = 48 * 1024;
/** What hello's own models field may take: hello carries commands and the rest of the snapshot too. */
export const HELLO_MODELS_BYTES = 24 * 1024;

/**
 * The models pi can use here (auth configured), for the phone's picker: the session's scoped
 * models first (so a cut list keeps them), then the rest of the catalogue.
 */
export function phoneModels(ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">): PhoneModel[] {
	const scoped = new Set((ctx.scopedModels ?? []).map((s) => `${s?.model?.provider}/${s?.model?.id}`));
	const available = ctx.modelRegistry.getAvailable() as Array<{ provider: string; id: string; name?: string; reasoning?: boolean }>;
	const models = available.map((m): PhoneModel => ({
		provider: String(m.provider).slice(0, 80), id: String(m.id).slice(0, 120),
		name: String(m.name || m.id).slice(0, 80), reasoning: m.reasoning === true, scoped: scoped.has(`${m.provider}/${m.id}`),
	}));
	const ordered = [...models.filter((m) => m.scoped), ...models.filter((m) => !m.scoped)];
	return ordered.slice(0, PHONE_MODELS_MAX);
}

/**
 * A list split into pages of at most `max` bytes of JSON each (one model at a time, so a model
 * bigger than a page is still alone on its own). An empty list is one empty page.
 */
export function modelPages(list: PhoneModel[], max = PHONE_MODELS_BYTES): PhoneModel[][] {
	const pages: PhoneModel[][] = [];
	let page: PhoneModel[] = [];
	let bytes = 0;
	for (const model of list) {
		const size = Buffer.byteLength(JSON.stringify(model), "utf8") + 1; // and its comma
		if (page.length > 0 && bytes + size > max) {
			pages.push(page);
			page = [];
			bytes = 0;
		}
		page.push(model);
		bytes += size;
	}
	if (page.length > 0 || pages.length === 0) pages.push(page);
	return pages;
}

/**
 * The phone's model list. A host that lists `model_pages` takes it in pages, the first saying
 * `first: true` (it replaces what the host had) and the last `last: true` (the host publishes the
 * list only then, so a read never sees half of it). A host from before that replaces its list on
 * every models line, so it gets one page only, scoped models first: a second page would leave it
 * holding just the tail. Either way a page stays under PHONE_MODELS_BYTES.
 */
export function sendModels(c: Conn, models?: PhoneModel[]): void {
	let list: PhoneModel[];
	try { list = (models ?? c.models?.() ?? []).slice(0, PHONE_MODELS_MAX); } catch { return; }
	const pages = c.hostFeatures?.has("model_pages") ? modelPages(list) : [modelPages(list)[0] ?? []];
	pages.forEach((page, i) => {
		try { write(c, "models", { models: page, first: i === 0, last: i === pages.length - 1 }); } catch {}
	});
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
	iconBus = pi.events;
	// Subagent children are not Eric's sessions.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let conn: Conn | undefined;
	let held: Array<string | UserContent[]> = [];
	// Words a stop released: sent once the aborted run has settled, as if typed after Esc.
	let afterStop: string[] = [];
	let steerHook = false;

	// pi's reload is only on a command's context, and a command sent with expandPromptTemplates runs
	// with one, as typed: it reloads only with the one-time token the phone's verified reload sent it
	// with; typed by hand (or sent by anything else) it does nothing.
	let reloadToken: string | undefined;
	pi.registerCommand(RELOAD_COMMAND, {
		description: "Botsun's Reload from the phone (at the keyboard, use /reload)",
		handler: async (args, ctx) => {
			const token = reloadToken;
			reloadToken = undefined;
			if (!token || args.trim() !== token) {
				ctx.ui.notify("This is Botsun's Reload from the phone: type /reload instead", "info");
				return;
			}
			await ctx.reload();
		},
	});

	// The phone has the icon sheet. This is the keyboard's: looks and colors come from Botsun's
	// catalog, never a list kept here. Hidden from the phone's command list (phoneCommands).
	pi.registerCommand("icon", {
		description: "Set this session's icon on Botsun's Home",
		getArgumentCompletions: (prefix) => iconCompletions(prefix, conn?.icons ?? null),
		handler: async (args, ctx) => {
			if (!conn?.connected) {
				ctx.ui.notify(ICON_DISCONNECTED, "error");
				return;
			}
			if (conn.iconWait) {
				ctx.ui.notify("an icon change is already on its way", "info");
				return;
			}
			const parsed = parseIconArgs(args);
			if (parsed.kind === "bad") {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const request = parsed.kind === "pick" ? await pickIcon(ctx, conn.icons, conn.icon) : parsed;
			if (!request) return;
			if (!conn.connected) {
				ctx.ui.notify(ICON_DISCONNECTED, "error");
				return;
			}
			// Drawn now, not when Botsun answers: the footer avatar takes the pick at once, and
			// Botsun's answer (or a refusal) puts it right.
			const before = conn.iconPending ? conn.iconPending.before : conn.icon;
			const file = sessionInfo(ctx).sessionFile;
			if (file && !existsSync(file)) {
				// A new session: pi writes its file with the first message, and Botsun wants the file.
				conn.iconPending = { request, before };
				if (request.kind === "set") setIcon(conn, { look: request.look, color: request.color ?? before?.color ?? null });
				else setIcon(conn, { look: null, color: null });
				ctx.ui.notify(`${iconSaid(request.kind === "set" ? request.look : null, request.kind === "set" ? request.color : null)} (Botsun saves it after your first message)`, "info");
				return;
			}
			conn.iconPending = undefined;
			const sentAt = Date.now();
			if (request.kind === "set") setIcon(conn, { look: request.look, color: request.color ?? before?.color ?? null });
			else setIcon(conn, { look: null, color: null });
			const reply = await sendIcon(conn, request);
			debug(`icon answer in ${Date.now() - sentAt} ms`);
			if (!reply.ok) {
				setIcon(conn, before ?? { look: null, color: null });
				ctx.ui.notify(reply.error ?? "Botsun refused the icon", "error");
				return;
			}
			ctx.ui.notify(iconSaid(reply.look, reply.color), "info");
		},
	});

	// A pick held for the session file (above): sent once pi has written it, i.e. once the first
	// message is in. Only a refusal is said; the pick is on screen already.
	const flushPendingIcon = async (ctx: ExtensionContext) => {
		const c = conn;
		const pending = c?.iconPending;
		if (!c || !pending || !c.connected || c.iconWait) return;
		const file = sessionInfo(ctx).sessionFile;
		if (!file || !existsSync(file)) return;
		c.iconPending = undefined;
		const reply = await sendIcon(c, pending.request);
		if (reply.ok) return;
		setIcon(c, pending.before ?? { look: null, color: null });
		try { ctx.ui.notify(reply.error ?? "Botsun refused the icon", "error"); } catch {}
	};
	pi.on("message_end", (_event, ctx) => void flushPendingIcon(ctx));
	pi.on("agent_end", (_event, ctx) => void flushPendingIcon(ctx));

	// The guardian's bypass, as it announces it (on start and on each change): the phone shows it.
	pi.events?.on(GUARDIAN_BYPASS_STATE_EVENT, (state: unknown) => {
		bypassed = (state as { active?: unknown } | undefined)?.active === true;
		if (conn && !conn.closed) try { write(conn, "bypass", { active: bypassed }); } catch {}
	});
	// Quiet mode: read the run's origin from the shared state (the quiet extension
	// publishes it in before_agent_start, before any agent_start handler can race),
	// and follow a mid-run flip from quiet to Eric's.
	pi.events?.on?.(QUIET_RUN_EVENT, (state: unknown) => {
		if (!conn || conn.closed || !conn.busy) return;
		const quiet = (state as { quiet?: unknown } | undefined)?.quiet === true;
		if (conn.quietSent === quiet) return;
		conn.quietSent = quiet;
		try { write(conn, "busy", { quiet }); } catch {}
	});
	// A background message joined his run after its final reply (the quiet extension's split):
	// his part ends here, so Botsun settles it (its finished push brings his answer), and a quiet
	// run starts. split: true tells Botsun this busy isn't him moving on (it keeps the held push).
	pi.events?.on?.(QUIET_SPLIT_EVENT, () => {
		if (!conn || conn.closed || !conn.busy || conn.quietSent === true) return;
		try {
			write(conn, "idle");
			conn.quietSent = true;
			write(conn, "busy", { quiet: true, split: true });
		} catch {}
	});
	// A quiet run's attention (notify_user or the classifier): the phone shows it.
	pi.events?.on?.(QUIET_ATTENTION_EVENT, (attention: unknown) => {
		if (!conn || conn.closed) return;
		try { write(conn, "attention", { attention: attention ?? null }); } catch {}
	});
	// /color, as the color extension announces it: Botsun keeps the session's color the same.
	pi.events?.on?.(COLOR_STATE_EVENT, (state: unknown) => reportColor(conn, state));
	const color = colorHooks(pi);

	pi.on("session_start", (_event, ctx) => {
		// Interactive TUI only: print/json have no UI, and Botsun drives its own
		// pi over RPC (hasUI is true there), which must not report itself.
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		// pi records a steer as a plain user message: mark it in the session file so Botsun can
		// label it. Covers steers typed in the TUI and sent from here (sendUserMessage deliverAs
		// steer emits input too). Text only, best effort. Registered once per extension instance.
		// Every prompt (typed, or any extension's sendUserMessage) also marks inputAt for a locked
		// phone's close.
		if (!steerHook) {
			steerHook = true;
			pi.on("input", (event) => {
				inputAt = Date.now();
				try {
					if (event?.streamingBehavior !== "steer") return;
					const text = typeof event.text === "string" ? event.text : "";
					pi.appendEntry("botsun-steer", { text: [...text].slice(0, 200).join(""), at: Date.now() });
				} catch {}
			});
		}
		const info = sessionInfo(ctx);
		const g = globalThis as { [LAUNCH]?: Conn["launch"] };
		if (!(LAUNCH in g)) g[LAUNCH] = (_event as { reason?: string } | undefined)?.reason === "startup" ? launchOf(info) : null;
		const sessionName = () => pi.getSessionName();
		const setSessionName = (name: string) => pi.setSessionName(name);
		// Eric's own words, as if typed: steer into a running turn, else start one.
		const inject = (content: string | UserContent[], busy: boolean) => {
			if (compacting) held.push(content);
			else sendUser(pi, content, busy ? { deliverAs: "steer" } : undefined);
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
				sendUser(pi, text);
				return "prompt";
			}
			if (mode === "queue") {
				sendUser(pi, text, { deliverAs: "followUp" });
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
		// The phone's Close: stop what's running, then (after the reply) a graceful exit. idleOnly
		// (close_call): nothing while a turn or compaction runs, a prompt is on its way in (sent,
		// not started yet) or messages wait in pi's queue, and the same again at shutdown (a typed
		// prompt, a follow-up or a trigger may have started one since the reply).
		const running = () =>
			!ctx.isIdle() || compacting !== null || conn?.busy === true || conn?.framing !== undefined ||
			(inputAt > 0 && Date.now() - inputAt < PROMPT_STARTING_MS) || ctx.hasPendingMessages?.() === true;
		const close = (opts?: { idleOnly?: boolean }) => {
			if (opts?.idleOnly && running()) return null;
			const shutdown = () => {
				if (opts?.idleOnly && running()) {
					debug("close_call: a turn started before the shutdown; not closing");
					return;
				}
				ctx.shutdown();
			};
			return { stopped: stop() === "stopped", shutdown };
		};
		// The phone's Reload and Restart: never while anything runs or a dialog is open, checked again
		// once the reply is sent.
		const settled = () => !running() && !conn?.prompt;
		const whenIdle = (what: string, act: () => void) => !settled() ? null : {
			run: () => {
				if (!settled()) {
					debug(`${what}: a turn or a dialog started before it; not done`);
					return;
				}
				act();
			},
		};
		const reload = () => whenIdle("reload", () => {
			reloadToken = randomBytes(18).toString("base64url");
			pi.sendUserMessage(`/${RELOAD_COMMAND} ${reloadToken}`, { expandPromptTemplates: true });
		});
		const restart = (pane: string) => whenIdle("restart", () => (conn?.spawnRestart ?? spawnRestartAll)(pane));
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
			conn.setSessionName = setSessionName;
			conn.inject = inject;
			conn.deliver = deliver;
			conn.stop = stop;
			conn.close = close;
			conn.reload = reload;
			conn.restart = restart;
			conn.command = command;
			conn.commands = commands;
			conn.models = models;
			conn.context = context;
			conn.confirm = confirm;
			conn.color = color;
			// A connection made by an older version of this extension (T1, before /reload) has
			// no nonce map or owner socket yet: upgrade it in place.
			conn.nonces ??= new Map();
			conn.nonces.clear(); // a nonce was for the session it was issued in
			listenOwner(conn);
			const changed = info.sessionFile !== conn.sessionFile || info.sessionId !== conn.sessionId || info.cwd !== conn.cwd;
			if (info.sessionId !== conn.sessionId) {
				conn.sandboxToken = undefined; // it was for the session Botsun bound
				conn.icon = undefined; // the look was the session pi left; the next icons line says this one's
				conn.iconPending = undefined;
			}
			if (!("boundId" in conn)) conn.boundId = conn.sessionId; // a connection from before boundId: its hello's
			const rehello = helloOnSwitch(conn, info, conn.launch);
			Object.assign(conn, info);
			if (rehello) {
				// Back in its own conversation: a fresh hello, carrying everything below, and nothing of
				// the conversation it left (not running, no prompt open).
				conn.busy = false;
				conn.prompt = null;
				conn.promptDepth = 0;
				conn.model = modelOf(ctx);
				sendHello(conn);
				// The catalogue follows once, not twice: a host that takes pages answers this hello
				// with its features line (applyHostFeatures), and that send is the one.
				if (!conn.closed && !conn.hostFeatures?.has("model_pages")) sendModels(conn);
				return;
			}
			const model = modelOf(ctx);
			if (JSON.stringify(model) !== JSON.stringify(conn.model)) {
				conn.model = model;
				write(conn, "model", { model });
			}
			if (changed) {
				if (conn.boundId !== conn.sessionId) conn.boundId = null;
				write(conn, "session", { session_file: conn.sessionFile, session_id: conn.sessionId, cwd: conn.cwd, ...colorFields(conn) });
			}
			// The host clears a session's subagents when its id changes: this conversation's go again.
			if (changed) conn.subagentsSent = "[]";
			reportSubagents(conn);
			// A reload may have added or dropped commands: the phone's "/" list follows.
			try { write(conn, "commands", { commands: commands() }); } catch {}
			try { reportFeatures(conn); } catch {}
			try { sendModels(conn, models()); } catch {}
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
			busy: false, prompt: null, promptDepth: 0, sessionName, setSessionName, ...info, launch: g[LAUNCH],
			nonces: new Map(), inject, deliver, stop, close, reload, restart, command, commands, models, context, confirm, color,
			model: modelOf(ctx),
		};
		store[STORE] = conn;
		connect(conn);
		listenOwner(conn);
	});
	// The restart extension writes its record in its own session_start, before or after this one:
	// once every handler ran, say whether restart is possible now, if that changed.
	pi.on("session_start", () => {
		setTimeout(() => {
			if (conn && !conn.closed) try { reportFeatures(conn, false); } catch {}
		}, 0);
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
		// The window is the model's: the info sheet's "of 200k" follows the switch, not the next run.
		try { write(conn, "context", { context: phoneContext(ctx) }); } catch {}
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
	// The provider's usage windows, on change (the phone's usage line and its 90% push).
	let lastUsage = JSON.stringify(usageLine());
	const stopUsage = onUsageChange(() => {
		if (!conn || conn.closed) return;
		const usage = usageLine();
		const key = JSON.stringify(usage);
		if (key === lastUsage) return;
		lastUsage = key;
		write(conn, "usage", { usage });
	});
	// #21: what Botsun offers, and where a new session's look and color go. Both read the live
	// connection, so a reconnect's fresh catalog is what the next name picks from.
	provideIconCatalog(() => namingCatalogFor(conn));
	const stopSuggestions = onIconSuggestion((suggestion) => suggestIconLine(conn, suggestion));
	// The session's subagents (lib/children.ts): a start or an end at once, progress at most once a second.
	bindChildren(pi.events);
	let subagentsTimer: ReturnType<typeof setTimeout> | undefined;
	const stopSubagents = onChildrenChange((immediate) => {
		if (!conn || conn.closed) return;
		if (immediate) {
			clearTimeout(subagentsTimer);
			subagentsTimer = undefined;
			reportSubagents(conn);
			return;
		}
		if (subagentsTimer) return;
		subagentsTimer = setTimeout(() => {
			subagentsTimer = undefined;
			if (conn && !conn.closed) reportSubagents(conn);
		}, SUBAGENTS_EVERY_MS);
		subagentsTimer.unref?.();
	});
	pi.on("session_shutdown", () => {
		provideIconCatalog(null);
		stopSuggestions();
		stopAsk();
		stopStash();
		stopFooter();
		stopUsage();
		stopSubagents();
		clearTimeout(footerTimer);
		clearTimeout(subagentsTimer);
	});

	// A slow input handler can outlast PROMPT_STARTING_MS: the turn's last step before it starts.
	pi.on("before_agent_start", () => {
		inputAt = Date.now();
		return undefined;
	});
	pi.on("agent_start", () => {
		inputAt = 0; // pi's turn counts as running from here
		if (!conn || conn.closed || conn.busy) return;
		conn.busy = true;
		conn.quietSent = runIsQuiet();
		write(conn, "busy", { quiet: conn.quietSent });
	});

	pi.on("agent_settled", () => {
		inputAt = 0;
		if (afterStop.length) {
			// As if typed after Esc; through inject, so a compaction starting now still holds them.
			const text = afterStop.join("\n\n");
			afterStop = [];
			try {
				if (conn && !conn.closed) conn.inject(text, false);
				else sendUser(pi, text);
			} catch {}
		}
		if (!conn || conn.closed || !conn.busy) return;
		conn.busy = false;
		conn.quietSent = undefined;
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
			try { sendUser(pi, content, options); } catch {}
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
