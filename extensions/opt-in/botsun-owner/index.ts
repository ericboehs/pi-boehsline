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

import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { accessSync, appendFileSync, closeSync, existsSync, chmodSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
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
/** A long video Botsun put on this Mac in chunks (its uploads dir) and a say names: the host's
 * path, and what the phone signed about it. */
export interface Upload { path: string; name: string; mime: string; bytes: number; sha256: string }

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
/** Where Botsun keeps long videos while they upload (its Paths.state("uploads")): the only place an
 * upload's path may point. */
export const uploadsDir = (): string => process.env.BOTSUN_UPLOADS_DIR || join(homedir(), ".local", "state", "botsun", "uploads");
/** A long video: at most this many bytes (Botsun's Uploads::MAX_SIZE), MP4 or QuickTime. */
const UPLOAD_MAX = 512 * 1024 * 1024;
const UPLOAD_TYPES = new Set(["video/mp4", "video/quicktime"]);
const UPLOAD_FILE = /^[0-9a-f]{32}\.part$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Video frames shown to the agent: at most this many per video and per message (on top of the photos). */
const FRAMES_PER_VIDEO = 8;
const FRAMES_MAX = 16;
/** All of a message's ffprobe/ffmpeg runs together. */
const FRAMES_TIMEOUT_MS = 20_000;
const VIDEO_NAME = /\.(mp4|mov|m4v)$/i;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/heic", "image/webp", "image/gif"]);
const TEXT_MAX = 20_000;
/** A message's id as the phone makes it (sent as client_id, signed in the payload): a lowercase UUID.
 * Botsun refuses anything else (OwnerSessions / WebDevice CLIENT_ID). */
export const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The v2 magics a message's own id rides after: Botsun's OwnerSessions::PROPOSE_TEXT_ID and
 * SAY_ATTACH_ID (signed_payload). Without an id the payloads are the old bytes exactly. */
const PROPOSE_TEXT_ID = "botsun-propose-text-v2";
const PROPOSE_TEXT = "botsun-propose-text-v1";
const SAY_ATTACH_ID = "botsun-say-attach-v2";
/** How many delivered message ids this process remembers (the phone's recent sends, not history). */
const SAID_MAX = 64;
/** Streaming text to Botsun: at most this often, and at most this much (the end is kept). */
const STREAM_EVERY_MS = 250;
const STREAM_MAX = 20_000;
/**
 * A busy steer from the phone waits here (Conn.steers) for the turn's end instead of going to pi at
 * once, so the phone's first Stop can take it back (unsteer): pi's extension API can't read or clear
 * its own steering queue. Only words alone can come back, up to this many bytes of JSON: one must
 * fit, whole, in the unsteer reply and in a `returned` line under Botsun's 64 KB MAX_LINE. Photos,
 * files and bigger words wait too when earlier steers do (to keep his order), but never come back
 * from an unsteer.
 */
export const STEER_BYTES_MAX = 16 * 1024;
/** The unsteer reply's withdrawn steers: at most this many bytes of JSON (Botsun cuts a reply at 64 KB). */
export const UNSTEER_REPLY_MAX = 48 * 1024;
/** A v1-signed unsteer: it takes v2 or newer only (a new request, like stop_child). */
export const UNSTEER_V1_REFUSED = "unsteer needs a v2 signature: v1 is refused (update Botsun and the app)";
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
	/** Sends a user message through the current extension instance's pi. A busy steer may wait for the
	 * turn's end (Conn.steers, holdsSteer): `steer.id` is the phone's client_id for it (a say's, which
	 * its steer mark carries), `steer.text` his words as typed (what a Stop gives back), and
	 * `steer.withdrawable` false for one the phone can't take back (photos, files, frames).
	 * "held" when a compaction (announced or not, see pendingCompact) made them wait instead. */
	inject: (content: string | UserContent[], busy: boolean, steer?: SteerMeta) => "held" | undefined;
	/** Whether words sent now would wait for a compaction pi hasn't finished: deliverSay says "held". */
	pendingCompact?: () => boolean;
	/** Runs a slash command from the phone: undefined = not one (send as text), null = ran, string = why not. */
	command?: (text: string, busy: boolean) => PhoneCommandRun;
	/** Stop one of this session's bg jobs (stopBgJob over this pi's events); the phone's Stop on a job row. */
	stopJob?: (id: string) => StopJobResult;
	/** The commands the phone can run here, for its "/" list; read lazily. */
	commands?: () => PhoneCommand[];
	/** Delivers released call words: queued after the turn, steered in, or stopping the run first. */
	deliver?: (text: string, mode: "queue" | "steer" | "stop") => string;
	/** Stops the running turn as Esc does: "stopped", or "idle" when nothing is running. */
	stop?: () => string;
	/** The phone's Stop: as `stop`, with the phone's own steers the abort took out of pi's queue
	 * (`dropped`, oldest first; taken back out of the TUI editor too), so the phone gets them back. */
	stopReturning?: () => { stopped: boolean; dropped: string[] };
	/** The phone's messages on their way into pi (`deliverSay`), each with its client_id when it sent
	 * one, until pi's input event for it: its steer mark carries the id. Process only. */
	phoneSays?: PhoneSay[];
	/** The phone's Close: aborts a running turn ("stopped" / "idle"); the shutdown it returns runs once the reply is sent.
	 * idleOnly (a locked phone's close_call): null while a turn, Botsun's busy, a compaction or a video reply's
	 * framing runs, a sent prompt hasn't started yet or pi has queued messages, and nothing is aborted; its
	 * shutdown is skipped if one has started since. */
	close?: (opts?: { idleOnly?: boolean }) => { stopped: boolean; dropped?: string[]; shutdown: () => void } | null;
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
	/** The message ids (session, device and id) this process delivered, oldest first: a say carrying
	 * one already delivered here is answered "duplicate" and not delivered again (Botsun's own table
	 * is the first guard; this one holds even if Botsun loses it). In memory only, never a file. */
	said?: Map<string, string>;
	/** The message ids in `said` whose delivery is still on its way (a video hashing or its frames
	 * being pulled), each with the promise that settles when it is done: never evicted (or the
	 * phone's retry would be delivered a second time), and a retry of the same message waits for it
	 * rather than hearing "duplicate" for a message that may still fail. */
	saidPending?: Map<string, Promise<void>>;
	/** What the host says it takes (its features line: model_pages for a paged catalogue), and so what
	 * this session may send it. Undefined until that line arrives: until then, only what an older host takes. */
	hostFeatures?: Set<string>;
	/** Eric's steers from the phone, waiting for a turn's end (holdsSteer), oldest first: the phone can
	 * take the withdrawable ones back (unsteer). On the connection, so a handoff never drops one. */
	steers?: HeldSteer[];
	/** Steers taken back (unsteer) or handed back by a stopped run, kept until Botsun says the phone has
	 * them (a returned_ack line): they never go to pi again, and never vanish. Sent again after every hello. */
	returned?: ReturnedSteer[];
	/** Between pi's turn_start and turn_end: a steer then is held for that turn's end. */
	inTurn?: boolean;
	/** The steers line last sent (JSON): one goes only when it changed. */
	steersSent?: string;
	/** Shows the waiting steers in pi's footer (ctx.ui.setStatus), so the keyboard sees what the phone queued. */
	steerStatus?: (text: string | undefined) => void;
}

/** What inject is told about a message: see Conn.inject. */
export interface SteerMeta { id?: string; text?: string; withdrawable?: boolean; attachments?: number }
/**
 * A steer waiting for the turn's end: its id (the phone's client_id, or one made here), his words as
 * typed (`text`, what goes back), what pi gets (`content`), whether an unsteer may take it, and
 * whether its phone say is noted already (it came through a compaction's hold).
 */
export interface HeldSteer {
	id: string;
	clientId?: string;
	text: string;
	content: string | UserContent[];
	withdrawable: boolean;
	attachments: number;
	noted?: boolean;
	at: number;
}
/** A steer on its way back to the phone, and the conversation it was said in. */
export interface ReturnedSteer { id: string; text: string; at: number; sessionId: string | null; why: "withdrawn" | "stopped" }
/** Steers kept for Botsun at most (the oldest go first): its own escrow takes as many per session. */
export const RETURNED_MAX = 50;

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
 *
 * A message's own id (the phone's client_id) is signed too, on a line of its own after a v2 magic
 * (Botsun's OwnerSessions.signed_payload): "botsun-propose-text-v2\n<id>\n<text>", or
 * "botsun-say-attach-v2\n<id>\n<lines>" with photos or files. With no id the bytes are exactly
 * the old form, so the id can't be swapped, dropped or added under the same signature.
 */
export function sayDigest(text: string, images: Image[], files: File[], clientId?: string,
	uploads: Pick<Upload, "name" | "sha256" | "bytes">[] = []):
	{ decision: string; digest: string; payload: string } {
	const textHash = sha256hex(Buffer.from(text, "utf8"));
	let decision = "say";
	let digest = textHash;
	// Text's v2 payload replaces the magic's line; an attachment's is the v1 lines with a new magic.
	let payload = clientId ? `${PROPOSE_TEXT_ID}\n${clientId}\n${text}` : `${PROPOSE_TEXT}\n${text}`;
	if (files.length || uploads.length) {
		// "say_attach": sha256(text), then "image <sha256>" per photo, "file <sha256(name)> <sha256(data)>" per file,
		// and "upload <sha256(name)> <sha256> <bytes>" per long video (Botsun's record of it, which this
		// session hashes again before it takes the file).
		decision = "say_attach";
		const lines = [textHash, ...images.map((i) => `image ${sha256hex(Buffer.from(i.data, "base64"))}`),
			...files.map((f) => `file ${sha256hex(Buffer.from(f.name, "utf8"))} ${sha256hex(Buffer.from(f.data, "base64"))}`),
			...uploads.map((u) => `upload ${sha256hex(Buffer.from(u.name, "utf8"))} ${u.sha256} ${u.bytes}`)].join("\n");
		digest = sha256hex(lines);
		payload = clientId ? `${SAY_ATTACH_ID}\n${clientId}\n${lines}` : lines;
	} else if (images.length) {
		decision = "say_images";
		const lines = [textHash, ...images.map((i) => sha256hex(Buffer.from(i.data, "base64")))].join("\n");
		digest = sha256hex(lines);
		payload = clientId ? `${SAY_ATTACH_ID}\n${clientId}\n${lines}` : lines;
	}
	return { decision, digest, payload };
}

function filesOf(raw: unknown): File[] | string {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw) || raw.length > ATTACH_MAX) return `at most ${ATTACH_MAX} attachments`;
	for (const f of raw) {
		if (!f || typeof f.name !== "string" || typeof f.data !== "string") return "bad file";
		if (badName(f.name)) return "bad file name";
		if (f.data.length > FILE_B64_MAX || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return "a file is too big (25 MB) or not base64";
	}
	return raw as File[];
}

/** A file name the phone may give (a file's or an upload's): one line, no path, no leading dot,
 * and at most NAME_MAX bytes (a name's 200 characters can be 600 bytes of UTF-8, and the inbox's
 * name adds a stamp to it). */
const badName = (name: string): boolean =>
	!name.trim() || Buffer.byteLength(name, "utf8") > NAME_MAX || /[\/\0\n\r]/.test(name) || name.startsWith(".");

/**
 * The long videos a say names (Botsun resolved each upload id to its own file): what the phone
 * signed about each, checked without touching the disk, so an unsigned caller learns nothing about
 * which files are there (checkUploads does that part, once the signature holds). The session hashes
 * the file again before taking it (takeUploads).
 */
export function uploadsOf(raw: unknown): Upload[] | string {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw) || raw.length > ATTACH_MAX) return `at most ${ATTACH_MAX} attachments`;
	for (const u of raw) {
		if (!u || typeof u.path !== "string" || typeof u.name !== "string" || typeof u.mime !== "string" || typeof u.sha256 !== "string") return "bad upload";
		if (badName(u.name)) return "bad file name";
		if (!UPLOAD_TYPES.has(u.mime)) return "a long video is MP4 or QuickTime";
		if (!Number.isSafeInteger(u.bytes) || u.bytes < 1 || u.bytes > UPLOAD_MAX) return "a long video is at most 512 MB";
		if (!SHA256_HEX.test(u.sha256)) return "bad upload";
		if (!u.path.startsWith("/") || !UPLOAD_FILE.test(basename(u.path))) return "an upload must be in Botsun's uploads dir";
	}
	return raw as Upload[];
}

/**
 * Each upload's path must be a plain file named by its uid right inside the uploads dir (realpath,
 * never a link), of exactly the size signed. It reads the disk, so it runs after the signature:
 * before one, its answers would tell a caller which files exist and how big they are. takeUploads
 * checks the same again on the opened file, before it copies.
 *
 * Hands back the real directory it checked (`dir`), or undefined when there is nothing to check: the
 * open then names the file by its basename in that directory, so no path part can be swapped after
 * the check. (O_NOFOLLOW in that open guards the file itself; the directory is one this check
 * realpath'd, and a swap of it would need write access this user's own state dir doesn't give
 * another account.) A string is the sentence saying why not.
 */
export function checkUploads(uploads: Upload[]): { dir: string } | string | undefined {
	if (!uploads.length) return undefined;
	let dir: string;
	try { dir = realpathSync(uploadsDir()); } catch { return "no uploads dir on this Mac"; }
	for (const u of uploads) {
		try {
			if (realpathSync(dirname(u.path)) !== dir) return "an upload must be in Botsun's uploads dir";
			const st = lstatSync(join(dir, basename(u.path)));
			if (st.isSymbolicLink() || !st.isFile()) return "an upload must be a plain file";
			if (st.size !== u.bytes) return "an upload isn't the size that was signed";
		} catch {
			return "an upload must be in Botsun's uploads dir";
		}
	}
	return { dir };
}

interface Saved { path: string; note: string; video: boolean; upload?: boolean }

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

const sizeText = (n: number): string =>
	n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Whether a file starts like an MP4 / QuickTime ("ftyp" at 4), so a renamed file isn't fed to ffmpeg. */
function startsLikeMovie(path: string): boolean {
	const fd = openSync(path, "r");
	try {
		const head = Buffer.alloc(12);
		return readSync(fd, head, 0, 12, 0) === 12 && head.subarray(4, 8).toString("latin1") === "ftyp";
	} finally {
		closeSync(fd);
	}
}

/**
 * Long videos into the inbox, as saveFiles names a file (inbox/<pid>/<time>-v<n>-<rand>-<name>): a
 * copy of Botsun's file (never a link to it: whatever can still write to Botsun's copy could change
 * a video after the check), hashed as it is copied, and the hash must be the one the phone signed
 * before the copy's mode is set. Anything wrong removes what it copied and says why; Botsun keeps
 * its own file until the say's ok.
 */
export async function takeUploads(uploads: Upload[], checkedDir?: string): Promise<Saved[] | string> {
	if (!uploads.length) return [];
	const dir = join(inboxDir(), String(process.pid));
	const saved: Saved[] = [];
	const drop = () => dropTaken(saved);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		for (const [i, u] of uploads.entries()) {
			const path = join(dir, `${stamp}-v${i}-${randomBytes(3).toString("hex")}-${u.name}`);
			const got = await copyUpload(u, path, checkedDir);
			// A digest is hex; anything else is the sentence saying why it wasn't copied (nothing made).
			if (!SHA256_HEX.test(got)) { drop(); return got; }
			const taken: Saved = { path, note: `📎 Attached: ${path} (${sizeText(u.bytes)})`, video: false, upload: true };
			saved.push(taken);
			if (got !== u.sha256) { drop(); return "an upload's sha256 doesn't match what was signed"; }
			// copyUpload made it 0600 and nothing has touched it since; the mode is never loosened.
			taken.video = startsLikeMovie(path);
		}
		return saved;
	} catch (e) {
		drop();
		return `couldn't take the video: ${(e as NodeJS.ErrnoException).code ?? "error"}`;
	}
}

/** Removes inbox copies a failed say took: a retry mustn't leave another copy (up to 512 MB each) behind. */
export function dropTaken(saved: Saved[]): void {
	for (const s of saved) { try { unlinkSync(s.path); } catch {} }
}

/** A copy's sha256, or why it won't copy. The source is opened without following a link and must
 * be, on that open file, a plain file that is nobody else's (one link) and the size signed: a swap
 * between the checks and the copy, or a hard link to a file of this Mac's user, gets nothing.
 * `dir` is the uploads directory checkUploads checked, so only the basename is opened there (a
 * directory swapped after the check can't steer it elsewhere), and O_NONBLOCK keeps a FIFO from
 * holding a worker thread. The copy stops at the signed size (a `.part` that keeps growing can't
 * fill the inbox), and only a file this call made is ever unlinked.
 * Returns the digest (a hex string), or a sentence saying why not. */
async function copyUpload(u: Upload, path: string, dir?: string): Promise<string> {
	const src = await open(dir ? join(dir, basename(u.path)) : u.path,
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	try {
		const st = await src.stat();
		if (!st.isFile()) return "an upload must be a plain file";
		if (st.nlink !== 1) return "an upload is a link to another file";
		if (st.size !== u.bytes) return "an upload isn't the size that was signed";
		let dst: FileHandle | undefined;
		try {
			dst = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
			const hash = createHash("sha256");
			const buf = Buffer.alloc(1 << 20);
			let left = u.bytes;
			while (left > 0) {
				const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, left), null);
				if (bytesRead === 0) break;
				hash.update(buf.subarray(0, bytesRead));
				// write may take less than the whole chunk (a signal, a full pipe): keep going until it
				// is all there, or the copy would differ from the bytes hashed.
				let off = 0;
				while (off < bytesRead) {
					const { bytesWritten } = await dst.write(buf, off, bytesRead - off);
					if (bytesWritten <= 0) throw new Error("the copy couldn't be written");
					off += bytesWritten;
				}
				left -= bytesRead;
			}
			return hash.digest("hex");
		} catch (e) {
			// Only what this call made: if the open failed (EEXIST), the file there is somebody else's.
			if (dst) {
				try { await dst.close(); } catch {}
				dst = undefined;
				try { unlinkSync(path); } catch {}
			}
			throw e;
		} finally {
			if (dst) await dst.close().catch(() => {});
		}
	} finally {
		await src.close().catch(() => {});
	}
}

/** 192.4 → "3m12s", 42 → "42s", 3725 → "1h02m05s": a long video's length in its note. */
export function span(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
	if (h) return `${h}h${String(m).padStart(2, "0")}m${String(r).padStart(2, "0")}s`;
	return m ? `${m}m${String(r).padStart(2, "0")}s` : `${r}s`;
}

/** A path as one shell word: as it is when it is plain, else in single quotes. */
const shellWord = (path: string): string => /^[A-Za-z0-9_\/.@%+=:,-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;

/**
 * A long video's note for the agent: where it is, how long and how big, and how to look at all of
 * it (the frames that come with the message are a handful; a debugging session wants more).
 */
export function videoNote(path: string, info: { duration?: number; width?: number; height?: number; bytes: number }): string {
	const parts = [info.duration !== undefined ? span(info.duration) : sizeText(info.bytes),
		...(info.width && info.height ? [`${info.width}x${info.height}`] : [])];
	return `Video: ${path} (${parts.join(", ")}). To view it, extract frames, e.g. ffmpeg -i ${shellWord(path)} -vf fps=1 /tmp/frames/%04d.png, then read the PNGs.`;
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
	Promise<{ images: UserContent[]; note: string; duration: number } | { why: string; duration?: number }> {
	const ffmpeg = findTool("ffmpeg");
	const ffprobe = findTool("ffprobe");
	if (!ffmpeg || !ffprobe) return { why: "ffmpeg unavailable" };
	const left = () => deadline - Date.now();
	let dir: string | undefined;
	let got: number | undefined;
	try {
		if (left() <= 0) return { why: "ffmpeg timed out" };
		const out = await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], left());
		const duration = Number.parseFloat(out.trim());
		if (!Number.isFinite(duration) || duration < 0) return { why: "ffmpeg failed" };
		dir = mkdtempSync(join(tmpdir(), "botsun-frames-"));
		chmodSync(dir, 0o700);
		const images: UserContent[] = [];
		const at: number[] = [];
		got = duration;
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
		if (!images.length) return { why: left() <= 0 ? "ffmpeg timed out" : "ffmpeg failed", duration };
		const noun = images.length === 1 ? "frame" : "frames";
		return { images, duration, note: `🎞️ Video ${path} (${clock(duration)}): ${images.length} ${noun} at ${at.map(clock).join(", ")}` };
	} catch {
		return { why: left() <= 0 ? "ffmpeg timed out" : "ffmpeg failed", duration: got };
	} finally {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

/** A video's picture size (ffprobe's first video stream), or nothing when it can't say in time. */
async function videoSize(path: string, deadline: number, run: VideoRunner): Promise<{ width?: number; height?: number }> {
	const ffprobe = findTool("ffprobe");
	const left = deadline - Date.now();
	if (!ffprobe || left <= 0) return {};
	try {
		const out = await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path], left);
		const m = out.trim().match(/^(\d{1,5})x(\d{1,5})$/);
		return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
	} catch {
		return {};
	}
}

/** Every saved file's note, each video's with its frames (or why none); frames after the photos. A
 * long video (an upload) gets videoNote's line in place of its 📎 one, frames or not. */
async function withFrames(saved: Saved[], run: VideoRunner): Promise<{ notes: string[]; frames: UserContent[] }> {
	const videos = saved.filter((s) => s.video).length;
	const per = videos ? Math.max(1, Math.min(FRAMES_PER_VIDEO, Math.floor(FRAMES_MAX / videos))) : 0;
	const deadline = Date.now() + FRAMES_TIMEOUT_MS;
	const notes: string[] = [];
	const frames: UserContent[] = [];
	for (const s of saved) {
		if (!s.video) { notes.push(s.note); continue; }
		const got = await videoFrames(s.path, per, deadline, run);
		const note = s.upload
			? videoNote(s.path, { duration: got.duration, bytes: statSync(s.path).size, ...(await videoSize(s.path, deadline, run)) })
			: s.note;
		if ("why" in got) { notes.push(`${note} (no frames: ${got.why})`); continue; }
		notes.push(note, got.note);
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

/** One request line → one reply object. Exported for tests. `opts.longerTimeout` is called once a
 * say's signature holds: only then may the owner socket wait longer for it (a long video hashed
 * here, a retry waiting for frames still coming), so an unsigned caller can't hold one open. */
export function handleOwnerRequest(c: Conn, req: unknown, opts: { longerTimeout?: () => void } = {}): Record<string, unknown> | Promise<Record<string, unknown>> {
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
	if (r.type === "cancel_ask") return cancelAsk(c, r);
	if (r.type === "stash") return stashRequest(c, r);
	if (r.type === "stop") return stopRequest(c, r);
	if (r.type === "unsteer") return unsteerRequest(c, r);
	if (r.type === "stop_child") return stopChildRequest(c, r);
	if (r.type === "stop_job") return stopJobRequest(c, r);
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
	const uploads = uploadsOf(r.uploads);
	if (typeof uploads === "string") return { error: uploads };
	if (images.length + files.length + uploads.length > ATTACH_MAX) return { error: `at most ${ATTACH_MAX} attachments` };
	if ([...images, ...files].reduce((n, a) => n + a.data.length, 0) > ATTACH_B64_TOTAL_MAX) {
		return { error: "attachments are over 40 MB together" };
	}
	// A long video is named in v2 or newer only: a v1 signature never covered one.
	if (uploads.length && !atLeastV2(r)) return { error: "a long video is signed with v2 or newer" };
	if (typeof text !== "string" || text.length > TEXT_MAX || (!text.trim() && !images.length && !files.length && !uploads.length)) {
		return { error: "text must be 1 to 20000 characters (or attach something)" };
	}
	// The phone's own id for this message, if it sent one: a lowercase UUID, and signed with v2 or
	// newer (which is what carries it in the payload), so it can't be swapped, dropped or added.
	if (r.client_id !== undefined && (typeof r.client_id !== "string" || !CLIENT_ID.test(r.client_id))) {
		return { error: "client_id must be a lowercase UUID" };
	}
	const clientId = r.client_id as string | undefined;
	if (clientId && !atLeastV2(r)) return { error: "a message id is signed with v2 or newer" };
	const say = sayDigest(text, images, files, clientId, uploads);
	const denied = verifyDevice(c, r, { decision: say.decision, digest: () => say.digest,
		v2: { kind: "session", decision: say.decision, payload: () => say.payload } });
	if (denied) return { error: denied };
	// The signature holds (and its nonce is spent): this say may hash a long video for a second or
	// two, and a retry of one may wait for frames still coming. Botsun waits up to 30 s for one, so
	// the socket's 5 s idle timeout gets longer from here.
	opts.longerTimeout?.();
	// The same message again (its first answer was lost on the way to the phone): it went in once.
	// Only the same id with the same message is a repeat: an id reused for other words (an app bug)
	// is delivered, never dropped. This goes before the uploads' disk checks: a retry of a message
	// already delivered is a duplicate even when Botsun has removed its `.part`.
	const said = clientId ? saidKey(c, r, clientId) : undefined;
	const digest = said ? say.digest : "";
	// The uploads' disk checks come after the signature (their answers would tell an unsigned caller
	// whether a file is there and how big it is; checkUploads).
	const deliver = (): Record<string, unknown> | Promise<Record<string, unknown>> => {
		if (said) {
			if (saidBefore(c, said, digest)) return { ok: true, delivered: "duplicate" };
		}
		const checked = checkUploads(uploads);
		if (typeof checked === "string") return { error: checked };
		// In progress from here, not from the reply: a long video hashes for a second or two, and a
		// retry with a fresh nonce mustn't be delivered a second time while it does.
		if (said) saidNow(c, said, digest);
		// Long videos: copied into the inbox and hashed again here before anything goes in (a second or
		// two for 500 MB; Botsun waits up to 30 s), so the reply says whether this session has them.
		if (uploads.length) {
			const uploadsSay = deliverUploads(c, text, images, files, uploads, checked?.dir, clientId, said, digest);
			// On its way from now, not only once the take is done: a retry that arrives while a long
			// video is copied and hashed must wait for that delivery, not be answered "duplicate" for
			// a message that may still fail. deliverUploads hands the wait over to its frames below
			// (saidOnItsWay replaces this mark, and the older mark leaves the newer one alone).
			if (said) saidOnItsWay(c, said, digest, uploadsSay);
			return uploadsSay;
		}
		let outcome: Record<string, unknown> | Promise<Record<string, unknown>>;
		const before = c.framing;
		try {
			// A queued say's frames are injected from a promise of their own: a throw there never reaches
			// this reply, so it forgets the id through onFail.
			outcome = deliverSay(c, text, images, files, { clientId, onFail: () => saidForget(c, said, digest) });
		} catch (e) {
			// A delivery that threw didn't go in: forget the id, so the phone's next try is delivered.
			saidForget(c, said, digest);
			throw e;
		}
		// Frames still coming (a small video, or words queued behind one): the id stays on its way until
		// they are in, so a retry waits for them instead of hearing "duplicate" for a message that may
		// still fail.
		if (said && c.framing && c.framing !== before) saidOnItsWay(c, said, digest, c.framing);
		if (!(outcome instanceof Promise)) return saidDone(c, said, digest, outcome);
		return outcome.then((reply) => saidDone(c, said, digest, reply), (e) => {
			saidForget(c, said, digest);
			throw e;
		});
	};
	// The same message is on its way right now (a big video hashing, its frames being pulled): wait
	// for that delivery rather than answering "duplicate" now. If it fails, its id is forgotten by
	// then and this try goes in; answering "duplicate" would lose the phone's only copy. A take
	// hands the wait over to its frames when it replies, so keep waiting while the id is still on
	// its way rather than going in as soon as the reply is out.
	const onItsWay = async (): Promise<Record<string, unknown>> => {
		for (;;) {
			const job = said && c.said?.get(said) === digest ? c.saidPending?.get(said) : undefined;
			if (!job) return deliver();
			await job;
		}
	};
	return said && c.said?.get(said) === digest && c.saidPending?.get(said) ? onItsWay() : deliver();
}

/** A verified say with long videos: the take starts at once (hashing Botsun's own file needs nothing
 * from the queue), and the reply goes once the take is done. Only the inject waits for the framing
 * queue, so an earlier video's ffmpeg (up to FRAMES_TIMEOUT_MS) can't hold this reply past the owner
 * socket's idle timeout. The queue is held from the moment the take starts, so a text say sent while
 * the video is hashed can't overtake it, and the id stays on its way until the frames are in. */
async function deliverUploads(c: Conn, text: string, images: Image[], files: File[], uploads: Upload[], dir: string | undefined,
	clientId: string | undefined, said: string | undefined, digest: string): Promise<Record<string, unknown>> {
	const prev = c.framing ?? Promise.resolve();
	// The queue from now on: a say sent during the take chains behind this, which opens once the
	// video's frames are in.
	let open!: () => void;
	const held = new Promise<void>((r) => { open = r; });
	const queue: Promise<void> = prev.catch(() => {}).then(() => held);
	c.framing = queue;
	const letGo = () => { open(); if (c.framing === queue) c.framing = undefined; };
	let taken: Saved[] | string;
	try {
		taken = await takeUploads(uploads, dir);
	} catch (e) {
		letGo();
		saidForget(c, said, digest);
		throw e;
	}
	if (typeof taken === "string") {
		// Nothing went in: the id is forgotten before the reply, so a retry isn't answered "duplicate".
		letGo();
		return saidDone(c, said, digest, { error: taken });
	}
	// inOrder: this reply's frames are chained here (behind the earlier ones, not behind the take),
	// and handed back on the reply rather than on c.framing (below the phone never sees them).
	let reply: Record<string, unknown>;
	try {
		reply = deliverSay(c, text, images, files, { clientId, uploads: taken, inOrder: true, after: prev }) as Record<string, unknown>;
	} catch (e) {
		// pi refused the message as it went in (a video's frames are the only other way to throw, and
		// that is below): nothing went in, so the copies go, the id is forgotten, and the queue this
		// take holds opens rather than leaving every later say waiting behind it.
		letGo();
		dropTaken(taken);
		saidForget(c, said, digest);
		throw e;
	}
	const frames = (reply as Record<symbol, unknown>)[FRAMES] as Promise<void> | undefined;
	let wentIn = !("error" in reply);
	const mark: Promise<void> = (frames ?? Promise.resolve()).catch((e) => {
		wentIn = false;
		debug(`owner say with a video: ${(e as Error).message}`);
	}).then(() => {
		if (wentIn) return;
		// Nothing went in: the id is forgotten (so the phone's next try is delivered) and the copies
		// taken are removed (a retry mustn't leave another 512 MB behind).
		saidForget(c, said, digest);
		dropTaken(taken);
	}).finally(letGo);
	if (c.framing === queue) c.framing = mark;
	if (said) saidOnItsWay(c, said, digest, mark);
	return "error" in reply ? saidDone(c, said, digest, reply) : reply;
}

/** The key a delivered message id is remembered under: this conversation, the device that signed it
 * and the id (Botsun's table is per device and session too). */
const saidKey = (c: Conn, r: Record<string, unknown>, clientId: string): string =>
	`${c.sessionId}:${deviceIdOf(r)}:${clientId}`;

/** Whether this process already delivered this conversation's message id from this device, with
 * these same words (its payload digest). */
const saidBefore = (c: Conn, key: string, digest: string): boolean => c.said?.get(key) === digest;

/** Remembers a delivered message id, oldest forgotten first. Process only: never a file or a log. */
function saidNow(c: Conn, key: string, digest: string): void {
	const said = (c.said ??= new Map());
	said.delete(key); // the newest use is the last one out
	said.set(key, digest);
	const pending = (c.saidPending ??= new Map());
	// Evict the oldest that has settled. An id still on its way (a big video hashing) keeps its
	// place: evicting it would let the phone's retry be delivered a second time.
	for (const old of said.keys()) {
		if (said.size <= SAID_MAX) break;
		if (old === key || pending.has(old)) continue;
		said.delete(old);
	}
}

/** Holds a message id on its way until `job` settles (a video hashing, its frames being pulled, a
 * say queued behind one): a retry of the same message waits for it instead of hearing "duplicate"
 * for a delivery that may still fail and forget the id. The entry goes when the job does, and only
 * if it is still this job's (a newer use of the id has its own). */
export function saidOnItsWay(c: Pick<Conn, "said" | "saidPending">, key: string, digest: string, job: Promise<unknown>): void {
	const pending = (c.saidPending ??= new Map());
	const settled = job.then(() => {}, () => {});
	pending.set(key, settled);
	void settled.then(() => {
		if (pending.get(key) !== settled) return;
		if (c.said?.get(key) === digest) pending.delete(key);
	});
}

/** Forgets a message id whose delivery failed, so the phone's next try of the same message is
 * delivered (it is remembered from before the take: see handleOwnerRequest). */
function saidForget(c: Conn, key: string | undefined, digest: string): void {
	if (!key) return;
	if (c.said?.has(key) && c.said.get(key) !== digest) return; // a newer message with this id is the one on its way
	c.said?.delete(key);
	c.saidPending?.delete(key);
}

/** Keeps the in-progress id once the reply says it went in; a refused or failed delivery forgets
 * it, so the phone's next try of the same message is delivered. */
function saidDone(c: Conn, key: string | undefined, digest: string, reply: Record<string, unknown>): Record<string, unknown> {
	if ("error" in reply) saidForget(c, key, digest);
	return reply;
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
	if (v === 1 && type === "returned_ack") return applyReturnedAck(c, msg as Record<string, unknown>);
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

/** A reply whose video frames are still coming: deliverSay hands them back on the reply (a symbol,
 * so the phone never sees it), and deliverUploads holds the framing queue until they are in. */
const FRAMES = Symbol("frames");

function deliverSay(c: Conn, text: string, images: Image[], files: File[], opts: { noCommands?: boolean; clientId?: string; uploads?: Saved[]; inOrder?: boolean; after?: Promise<void>; onFail?: () => void } = {}): Record<string, unknown> | Promise<Record<string, unknown>> {
	// The copies this call made itself (opts.uploads are its caller's: deliverUploads drops those).
	let mine: Saved[] = [];
	let saved: Saved[];
	try {
		mine = saveFiles(files);
		saved = [...mine, ...(opts.uploads ?? [])];
	} catch (e) {
		dropTaken(mine);
		return { error: `couldn't save the file: ${(e as NodeJS.ErrnoException).code ?? "error"}` };
	}
	// A delivery that didn't go in leaves its copies behind for nothing: they go with it.
	const dropMine = () => dropTaken(mine);
	const attached = images.length + files.length + (opts.uploads?.length ?? 0);
	const compose = (notes: string[], frames: UserContent[]): string | UserContent[] => {
		const said = [text, ...notes].filter((t) => t.trim()).join("\n\n");
		const pics: UserContent[] = [...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mime_type })), ...frames];
		return pics.length ? [...(said.trim() ? [{ type: "text" as const, text: said }] : []), ...pics] : said;
	};
	const notes = saved.map((s) => s.note);
	if (!opts.noCommands && !images.length && !notes.length && c.command) {
		const outcome = c.command(text, c.busy);
		if (typeof outcome === "string") { dropMine(); return { error: outcome }; }
		if (outcome === null) {
			debug("owner say ran a slash command");
			return { ok: true, delivered: "command" };
		}
		if (outcome !== undefined) {
			// Busy: pi took it as typed mid-turn (a steer), or it waits here for the settle (/compact).
			debug(`owner say had a slash command ${outcome.delivered}`);
			return { ok: true, delivered: outcome.delivered };
		}
	}
	// Words a compaction holds are "held": pi would refuse them as a prompt (2026-11-10).
	const delivered = c.pendingCompact?.() ? "held" : c.busy ? "steer" : "prompt";
	// A reply chained behind an earlier one (`after`) goes in from a promise of its own, even when none
	// of its files is a video: injecting it now would overtake the video ahead of it.
	if (saved.some((s) => s.video) || (opts.inOrder ? opts.after !== undefined : c.framing !== undefined)) {
		// Frames take ffmpeg a few seconds: reply now (the socket and Botsun don't wait), deliver when
		// they're ready, and queue later replies behind it so they keep their order. `after` is the
		// queue an inOrder reply's frames wait for (its caller owns c.framing).
		const queue = opts.after ?? (opts.inOrder ? Promise.resolve() : (c.framing ?? Promise.resolve()));
		const frames: Promise<void> = queue
			.then(() => withFrames(saved, runFile))
			.then(({ notes, frames }) => {
				c.inject(compose(notes, frames), c.busy, { id: opts.clientId, text, withdrawable: false, attachments: attached });
			});
		if (opts.inOrder) {
			// This job is the framing queue (deliverUploads' take), so nothing is chained here: hand the
			// frames' promise back on the reply. The reply itself goes now (Botsun doesn't wait for
			// ffmpeg); the take holds its queue until the frames are in, so nothing overtakes them.
			// The caller drops the uploads it took; the files saved here are this call's own.
			void frames.catch(() => dropMine());
			const awaiting: Record<string, unknown> = { ok: true, delivered };
			(awaiting as Record<symbol, unknown>)[FRAMES] = frames;
			return awaiting;
		}
		const job: Promise<void> = frames
			.catch((e) => {
				debug(`owner say with a video: ${(e as Error).message}`);
				// A throw in the frames (ffmpeg, or pi refusing the message) means nothing went in: the
				// copies go, and the caller forgets the message id, so the phone's next try is delivered,
				// not "duplicate".
				dropMine();
				opts.onFail?.();
			})
			.finally(() => { if (c.framing === job) c.framing = undefined; });
		c.framing = job;
		debug(`owner say accepted (${text.length} chars, ${images.length} photos, ${files.length} files, frames pending)`);
		return { ok: true, delivered };
	}
	// Words alone can be taken back from the phone while they wait for the turn's end; a message with
	// photos or files can't (yet): the reply that brings a steer back has no room for them.
	let kept: ReturnType<Conn["inject"]>;
	try {
		kept = c.inject(compose(notes, []), c.busy, { id: opts.clientId, text, withdrawable: !attached, attachments: attached });
	} catch (e) {
		// pi refused it: nothing went in, so the copies this reply made go with it.
		dropMine();
		throw e;
	}
	debug(`owner say accepted (${text.length} chars, ${images.length} photos, ${files.length} files)`); // never the text
	// The inject knows what happened just now (`delivered` was guessed before it): a compaction it
	// held them for, or a send pi refused, and the phone hears "held" rather than a prompt it lost.
	return { ok: true, delivered: kept === "held" ? "held" : delivered };
}

/** A phone message on its way into pi: the text pi's input event will carry, and its client_id. */
export interface PhoneSay { text: string; id?: string; at: number }
const PHONE_SAYS_MAX = 20;
const PHONE_SAY_MS = 10 * 60_000;

/** The text pi queues and its input event carries for a user message (text blocks, joined as pi's contentText does). */
export function contentTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => String((b as { text?: unknown }).text ?? "")).join("");
}

/** Remembers a phone message until pi's input event for it (takePhoneSay). Newest last, capped. */
export function notePhoneSay(c: Pick<Conn, "phoneSays">, content: string | UserContent[], id?: string, now = Date.now()): void {
	const says = (c.phoneSays ??= []);
	says.push({ text: contentTextOf(content), ...(id ? { id } : {}), at: now });
	while (says.length > PHONE_SAYS_MAX) says.shift();
}

/** The phone message pi's input event is for (the oldest with that text, not stale), taken; else undefined. */
export function takePhoneSay(c: Pick<Conn, "phoneSays"> | undefined, text: string, now = Date.now()): PhoneSay | undefined {
	const says = c?.phoneSays;
	if (!says) return undefined;
	while (says.length && now - says[0]!.at > PHONE_SAY_MS) says.shift();
	const i = says.findIndex((s) => s.text === text);
	return i < 0 ? undefined : says.splice(i, 1)[0];
}

/**
 * The phone's steers taken back out of the TUI editor after an abort: pi's TUI puts every queued
 * message there (the queue's texts joined by blank lines, then what was typed), and these are the
 * phone's, so they go back to the phone instead of waiting for Enter on the Mac. Only whole blocks
 * (between blank lines, or the editor's ends) equal to a phone text are taken, never part of one: a
 * phone text that's only a word in what Eric typed stays. They're looked for in queue order from the
 * front (pi puts the queue's texts first, in order), each after the one before it, each once, with
 * the blank line pi joined it by; one not found (delivered already) is skipped. What the TUI queued
 * or typed itself stays. `taken` is the ones found, oldest first.
 */
export function takeQueued(editor: string, texts: string[]): { editor: string; taken: string[] } {
	let rest = editor;
	const taken: string[] = [];
	let at = 0;
	for (const t of texts) {
		if (!t.trim()) continue;
		const i = wholeBlock(rest, t, at);
		if (i < 0) continue;
		let from = i;
		let to = i + t.length;
		if (rest.startsWith("\n\n", to)) to += 2;
		else if (from >= 2) from -= 2;
		rest = rest.slice(0, from) + rest.slice(to);
		at = from;
		taken.push(t);
	}
	return { editor: rest, taken };
}

/** Where `t` is a whole block of `s` (a blank line or an end on each side), at or after `from`; else -1. */
function wholeBlock(s: string, t: string, from: number): number {
	for (let i = s.indexOf(t, from); i >= 0; i = s.indexOf(t, i + 1)) {
		const end = i + t.length;
		const starts = i === 0 || s.slice(i - 2, i) === "\n\n";
		const ends = end === s.length || s.startsWith("\n\n", end);
		if (starts && ends) return i;
	}
	return -1;
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
	// A compaction (announced or not) holds these too: the phone hears "held", not a steer it lost.
	const kept = c.inject(text, c.busy);
	debug(`owner say_audio accepted (${text.length} chars)`);
	return { ok: true, delivered: kept === "held" ? "held" : c.busy ? "steer" : "prompt" };
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

/** A v1-signed cancel_ask: it takes v2 or newer only. */
export const CANCEL_ASK_V1_REFUSED = "cancelling a question needs a v2 signature: update Botsun and the app";
/** A prompt offered without `cancellable` (op-broker's secret approval): only answered. */
export const CANCEL_ASK_REFUSED = "this question can't be cancelled from the phone; answer it, or press Esc in the session";

/**
 * Eric's Cancel on the phone's ask card: the tool returns what Esc at the keyboard returns ("User
 * cancelled") and closes its dialog. Signed with the decision key, v2 or newer, over
 * "cancel_ask\n<ask id>" (kind session, scope the session id; this session's nonce: single use),
 * so the signature cancels that question and no other. Only a prompt offered cancellable (the ask
 * tool's) is taken. Refusals before verifyDevice spend the nonce anyway (one try per nonce).
 */
function cancelAsk(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const spend = (error: string) => {
		if (typeof r.nonce === "string") takeNonce(c, r.nonce);
		return { error };
	};
	if (r.key !== undefined) return spend("bad request");
	const id = r.ask_id;
	if (typeof id !== "string" || !validScope(id)) return spend("bad request");
	if (!atLeastV2(r)) return spend(CANCEL_ASK_V1_REFUSED);
	const prompt = openPrompts().find((p) => p.id === id);
	if (!prompt) return spend("that question was already answered");
	if (!prompt.cancel) return spend(CANCEL_ASK_REFUSED);
	const payload = `cancel_ask\n${id}`;
	const denied = verifyDevice(c, r, {
		decision: "cancel_ask",
		digest: () => sha256hex(Buffer.from(payload, "utf8")),
		v2: { kind: "session", decision: "cancel_ask", payload: () => payload },
	});
	if (denied) return { error: denied };
	const error = prompt.cancel();
	if (error) return { error };
	debug("owner cancel_ask cancelled an ask");
	return { ok: true };
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
	if (c.stopReturning) {
		// The steers still waiting for the turn's end go back to the phone first, never to pi (returnSteers):
		// by id in the reply (what fits it), and through the escrow either way.
		const returned = replyList(returnSteers(c, "stopped"));
		const { stopped, dropped } = c.stopReturning();
		return { ok: true, stopped, ...(dropped.length ? { dropped } : {}), ...(returned.length ? { returned } : {}) };
	}
	if (!c.stop) return { error: "this session can't stop from the phone yet; run /reload" };
	return { ok: true, stopped: c.stop() === "stopped" };
}

/**
 * Whether a busy steer waits for the turn's end (Conn.steers) instead of going to pi now: between
 * pi's turn_start and turn_end (one said after the last turn_end has no turn_end left to go in at,
 * and goes straight to pi as before), or whenever earlier ones wait (so it never jumps ahead of
 * them). Only one the phone can take back starts the wait (words alone, STEER_BYTES_MAX); one it
 * can't (photos, files, bigger words) waits only behind others.
 */
export function holdsSteer(c: Pick<Conn, "inTurn" | "steers" | "hostFeatures">, withdrawable: boolean): boolean {
	if (c.steers?.length) return true;
	// Only for a Botsun that takes them back (its features line lists `unsteer`): an older one drops the
	// `returned` lines and a stop's `returned` field, so a steer held for it could never come back.
	return withdrawable && c.inTurn === true && c.hostFeatures?.has("unsteer") === true;
}

/** Whether these words, alone, can come back from an unsteer: some words, small enough for one reply. */
export function withdrawableText(content: string | UserContent[], meta?: SteerMeta): boolean {
	if (meta?.withdrawable === false || typeof content !== "string" || !content.trim()) return false;
	return Buffer.byteLength(JSON.stringify(content), "utf8") <= STEER_BYTES_MAX;
}

/** A steer id: the phone's client_id (a lowercase UUID), as Botsun checks it. */
const STEER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A busy steer, into the wait (holdsSteer said so). Its phone say is noted when it goes to pi. */
export function holdSteer(c: Conn, content: string | UserContent[], meta: SteerMeta | undefined, opts: { noted?: boolean; now?: number } = {}): HeldSteer {
	const withdrawable = withdrawableText(content, meta);
	const clientId = meta?.id && STEER_ID.test(meta.id) ? meta.id : undefined;
	const steer: HeldSteer = {
		id: clientId ?? randomUUID(),
		...(clientId ? { clientId } : {}),
		text: meta?.text ?? contentTextOf(content),
		content,
		withdrawable,
		attachments: meta?.attachments ?? 0,
		...(opts.noted ? { noted: true } : {}),
		at: opts.now ?? Date.now(),
	};
	(c.steers ??= []).push(steer);
	reportSteers(c);
	return steer;
}

/**
 * The waiting steers as Botsun keeps them (its `steers` line): what the phone's next Stop takes
 * back, by id, size and time, never the words. One it can't take back isn't listed.
 */
export function steersLine(c: Pick<Conn, "steers">): Array<{ id: string; chars: number; photos: number; at: string }> {
	return (c.steers ?? []).filter((s) => s.withdrawable)
		.map((s) => ({ id: s.id, chars: s.text.length, photos: 0, at: new Date(s.at).toISOString() }));
}

/** The footer's status for the waiting steers (every one, photos too), or undefined for none. */
export function steerStatusText(n: number): string | undefined {
	return n > 0 ? `📱 ${n} phone steer${n === 1 ? "" : "s"} waiting for the turn's end` : undefined;
}

/** A steers line, when the list changed since Botsun was last told (or forced after a hello); and pi's footer status. */
export function reportSteers(c: Conn, force = false): void {
	try { c.steerStatus?.(steerStatusText(c.steers?.length ?? 0)); } catch {}
	const steers = steersLine(c);
	const key = JSON.stringify(steers);
	if (!force && key === c.steersSent) return;
	c.steersSent = key;
	try { write(c, "steers", { steers }); } catch {}
}

/** Each steer on its way back to the phone, one `returned` line each (a line stays under MAX_LINE). */
function sendReturned(c: Conn, items: ReturnedSteer[]): void {
	for (const s of items) {
		try {
			write(c, "returned", { session_id: s.sessionId, steers: [{ id: s.id, text: s.text, at: new Date(s.at).toISOString(), why: s.why }] });
		} catch {}
	}
}

/** Into the escrow (Conn.returned, at most RETURNED_MAX) and down to Botsun. */
function escrow(c: Conn, out: ReturnedSteer[]): void {
	if (!out.length) return;
	const all = (c.returned ??= []);
	all.push(...out);
	if (all.length > RETURNED_MAX) all.splice(0, all.length - RETURNED_MAX);
	reportSteers(c);
	sendReturned(c, out);
}

/** The words a steer goes back with: his own, or what it carried when he typed none. */
function returnedText(s: HeldSteer): string {
	if (s.text.trim()) return s.text;
	const n = Math.max(1, s.attachments);
	return `[${n} attachment${n === 1 ? "" : "s"}]`;
}

/**
 * Every waiting steer goes back to the phone (a run stopped, or this session is ending): into the
 * escrow and down to Botsun, which puts them back in the phone's message box. Never to pi: a
 * stopped run's steers would start the agent again, or be lost in the reset that follows an abort
 * on /new, /resume, /fork and quit. One with photos goes back as its words (the phone still has
 * its photos while its bubble is there, and finds them by id).
 */
export function returnSteers(c: Conn, why: ReturnedSteer["why"]): ReturnedSteer[] {
	const out = (c.steers ?? []).map((s): ReturnedSteer => ({ id: s.id, text: returnedText(s), at: s.at, sessionId: c.sessionId, why }));
	c.steers = [];
	escrow(c, out);
	return out;
}

/** The returned steers that fit one reply under Botsun's 64 KB line ({id, text}); the rest reach the phone by the thread read. */
export function replyList(items: ReturnedSteer[], max = UNSTEER_REPLY_MAX): Array<{ id: string; text: string }> {
	const out: Array<{ id: string; text: string }> = [];
	let bytes = 64;
	for (const s of items) {
		const size = Buffer.byteLength(JSON.stringify({ id: s.id, text: s.text }), "utf8") + 1;
		if (bytes + size > max) break;
		out.push({ id: s.id, text: s.text });
		bytes += size;
	}
	return out;
}

/** Botsun has the phone's word that these came back (its returned_ack line): the escrow lets them go. */
function applyReturnedAck(c: Conn, msg: Record<string, unknown>): boolean {
	if (!Array.isArray(msg.ids)) return false;
	const ids = new Set(msg.ids.filter((id): id is string => typeof id === "string"));
	if (!c.returned?.length) return true;
	c.returned = c.returned.filter((s) => !ids.has(s.id));
	return true;
}

/**
 * The phone's first Stop (or Esc) while steers wait: takes back the ones it can, as pi's own Alt+Up
 * does for typed ones, and never stops the run. Signed with the decision key, v2 or newer, over
 * "unsteer". Atomic with the turn's end, which hands pi the next one: both run on this one thread,
 * so a steer pi took is never in the reply, and one in the reply never reaches pi. The reply names
 * exactly what came back (`withdrawn`, oldest first) and how many it could have taken are still
 * waiting (`kept`: the rest of a reply over UNSTEER_REPLY_MAX, for the next press); photos, files
 * and bigger words stay where they are, in order. Nothing to take back is an empty `withdrawn`,
 * never a stop (the phone stops with its own request). What came back is in the escrow too, so a
 * reply lost on the way still reaches the phone.
 */
function unsteerRequest(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const denied = verifyDevice(c, r, { decision: "unsteer", digest: () => sha256hex(Buffer.from("unsteer", "utf8")),
		v2: { kind: "session", decision: "unsteer", payload: () => "unsteer" } });
	if (denied) return { error: denied };
	if (!atLeastV2(r)) return { error: UNSTEER_V1_REFUSED };
	const { withdrawn, kept } = takeWithdrawable(c);
	const back = withdrawn.map((s): ReturnedSteer => ({ id: s.id, text: s.text, at: s.at, sessionId: c.sessionId, why: "withdrawn" }));
	escrow(c, back);
	debug(`owner unsteer took back ${withdrawn.length} (${kept} kept)`);
	return { ok: true, withdrawn: back.map((s) => ({ id: s.id, text: s.text })), kept };
}

/** The withdrawable waiting steers, oldest first, as many as fit one reply; the rest stay in order. */
export function takeWithdrawable(c: Pick<Conn, "steers">, max = UNSTEER_REPLY_MAX): { withdrawn: HeldSteer[]; kept: number } {
	const withdrawn: HeldSteer[] = [];
	const left: HeldSteer[] = [];
	let bytes = 64;
	let full = false;
	for (const s of c.steers ?? []) {
		if (!s.withdrawable) {
			left.push(s);
			continue;
		}
		const size = Buffer.byteLength(JSON.stringify({ id: s.id, text: s.text }), "utf8") + 1;
		if (full || bytes + size > max) {
			full = true;
			left.push(s);
			continue;
		}
		withdrawn.push(s);
		bytes += size;
	}
	c.steers = left;
	return { withdrawn, kept: left.filter((s) => s.withdrawable).length };
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

/** A v1-signed stop_job: it takes v2 or newer only. */
export const STOP_JOB_V1_REFUSED = "stop_job needs a v2 signature: v1 is refused (update Botsun and the app)";
/** A bg job id (bg.ts makes 6 hex digits): never "." or "..", since the phone puts it in a route's path. */
const JOB_ID = /^[A-Za-z0-9][\w-]{0,39}$/;

export type StopJobResult = "stopped" | "ended" | "not_found" | "unstoppable";

/**
 * Stop a bg job of this session: only one on bg.ts's own list (bg:list, this pi's jobs), through
 * bg:kill with wake, so the model hears "killed" rather than waiting on a result (a stop it didn't
 * ask for). A job that already ended is "ended", not an error: the phone's list can be a few
 * seconds stale.
 */
export function stopBgJob(events: { emit(channel: string, data: unknown): void } | undefined, id: string): StopJobResult {
	if (!events) return "unstoppable";
	let jobs: unknown = null;
	try {
		events.emit("bg:list", { reply: (list: unknown) => { jobs = list; } });
	} catch {
		return "unstoppable";
	}
	if (!Array.isArray(jobs)) return "unstoppable";
	const job = (jobs as Array<Record<string, unknown> | null>).find((j) => j?.id === id);
	if (!job) return "not_found";
	if (typeof job.endedAt === "number") return "ended";
	let killed = false;
	const req = { id, wake: true, accepted: false, reply: (r: { killed: boolean }) => { killed = r.killed; } };
	try {
		events.emit("bg:kill", req);
	} catch {
		return "unstoppable";
	}
	if (!req.accepted) return "unstoppable";
	return killed ? "stopped" : "ended";
}

/**
 * The phone's Stop on a shell job's row (its info sheet). Signed with the decision key, v2 or
 * newer, over "stop_job\n<id>" (this session's nonce: single use). Only a job on this session's
 * own bg list is stopped.
 */
function stopJobRequest(c: Conn, r: Record<string, unknown>): Record<string, unknown> {
	const id = typeof r.job_id === "string" && JOB_ID.test(r.job_id) ? r.job_id : null;
	if (!id) return { error: "bad request" };
	const payload = `stop_job\n${id}`;
	const denied = verifyDevice(c, r, { decision: "stop_job", digest: () => sha256hex(Buffer.from(payload, "utf8")),
		v2: { kind: "session", decision: "stop_job", payload: () => payload } });
	if (denied) return { error: denied };
	if (!atLeastV2(r)) return { error: STOP_JOB_V1_REFUSED };
	const result = c.stopJob?.(id) ?? "unstoppable";
	if (result === "not_found") return { error: "no such job in this session" };
	if (result === "unstoppable") return { error: "this job can't be stopped from the phone" };
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
 * doesn't know), so an older phone reads the line as before. `title` is the row's short name
 * (lib/job-title.ts: the caller's, else derived from the task); `task` stays the prompt. */
function childWire(k: ChildInfo, tail: number, text: number): Record<string, unknown> {
	return {
		id: k.id,
		kind: k.kind,
		agent: k.agent,
		task: k.task,
		...(k.title ? { title: k.title } : {}),
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
	const { shutdown, dropped } = c.close()!;
	return { ok: true, ...(dropped?.length ? { dropped } : {}), [AFTER_REPLY]: shutdown };
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

/** How long the owner socket waits for a reply (a say with files takes a moment to save). */
const OWNER_IDLE_MS = 5_000;
/** A say carrying a long video hashes (and copies) it before the reply, and a retry of one may wait
 * for a delivery whose frames are still being pulled: Botsun waits up to 30 s for such a say, so the
 * socket's idle timeout is longer for one, once its signature holds (handleOwnerRequest). */
const SAY_UPLOADS_TIMEOUT_MS = 35_000;

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
		// One idle timeout for every request; a say that may take a while (a long video hashed here, a
		// retry waiting for frames still coming) sets a longer one once its signature holds, from
		// handleOwnerRequest (opts.longerTimeout), so no second handler is ever registered for it.
		sock.setTimeout(OWNER_IDLE_MS);
		sock.on("timeout", () => sock.destroy());
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
			let req: unknown;
			try {
				req = JSON.parse(line);
			} catch {
				req = undefined;
			}
			// A say with a long video is hashed here before its reply (and a retry of it may wait for that
			// delivery), and Botsun waits up to 30 s for one: handleOwnerRequest lengthens this socket's
			// idle timeout, but only once the request's signature holds (and its nonce is spent).
			try {
				reply = handleOwnerRequest(c, req, { longerTimeout: () => sock.setTimeout(SAY_UPLOADS_TIMEOUT_MS) });
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
 * cancellable: the phone may cancel it (cancel_ask); an older Botsun drops the key.
 */
function askLine(): { id: string; questions: RemotePrompt["questions"]; sensitive?: true; cancellable?: true } | null {
	const open = openPrompts();
	const p = open[open.length - 1];
	return p
		? {
				id: p.id,
				questions: p.questions,
				...(p.sensitive ? { sensitive: true as const } : {}),
				...(p.cancel ? { cancellable: true as const } : {}),
			}
		: null;
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

/** When this process started (ms): an agent-link registry file from before it was left by a dead
 * process whose pid this one reused (as extensions/footer reads the same file). */
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

/** agent-link's registry entry (~/.claude/sessions, shared with Claude Code) for this process: the
 * name it gave, whether that name is derived from the folder, and when it wrote the file. A file
 * from another pid (a crashed process's, with its pid reused), from before this process started
 * (the same, since a hard exit skips the cleanup and the registry is keyed by pid), or another
 * tool's is not this session's, so it is ignored. */
function linkEntry(): { name?: string; derived: boolean; at: number } | undefined {
	try {
		const file = join(homedir(), ".claude", "sessions", `${process.pid}.json`);
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (raw?.pid !== process.pid || raw?.entrypoint !== "pi") return undefined;
		// A dead pi's file whose pid this process now has still says pid === process.pid: its start
		// time is what tells it apart (a second's slack for a clock that moved under it).
		if (typeof raw.startedAt === "number" && raw.startedAt < PROCESS_STARTED_AT - 1_000) return undefined;
		const name = typeof raw.name === "string" ? raw.name.trim() || undefined : undefined;
		return { name, derived: raw.nameSource === "derived", at: statSync(file).mtimeMs };
	} catch {
		return undefined;
	}
}

/** The session's two names: agent-link's (unless a rename through pi from here came after agent-link
 * last wrote its file), and pi's. */
function sessionNames(c: Pick<Conn, "sessionName" | "namedAt">): { link?: string; linkDerived: boolean; pi?: string } {
	let pi: string | undefined;
	try { pi = c.sessionName()?.trim() || undefined; } catch {}
	const entry = linkEntry();
	const renamed = !!entry?.name && !!pi && !!c.namedAt && c.namedAt > entry.at;
	return { link: renamed ? undefined : entry?.name, linkDerived: !!entry?.derived, pi };
}

/** The name this session is called by, as the phone shows it: agent-link's name for this pid, else
 * the pi session name. A name set through pi from here (Botsun's rename, the phone's /name) after
 * agent-link last wrote its file wins. A name agent-link derived from the folder is not the
 * session's own (agent-link re-picks it as sibling sessions come and go), so it names no prompt
 * section; the phone still shows it. No folder fallback: an unnamed session has no name. */
export function identityName(c: Pick<Conn, "sessionName" | "namedAt">): string | undefined {
	const { link, linkDerived, pi } = sessionNames(c);
	return (link && !linkDerived ? link : pi)?.slice(0, NAME_MAX);
}

/** What every line to the phone says this session is called: agent-link's name (derived or not),
 * else the pi session name, else its folder. */
export function currentName(c: Conn): string {
	const { link, pi } = sessionNames(c);
	return (link || pi || basename(c.cwd) || c.cwd).slice(0, NAME_MAX);
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
// How long a compaction may hold the phone's words before they go back to it, unsent (dropHeld):
// a compaction that never ends mustn't swallow them.
const HELD_MAX_MS = 10 * 60_000;
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
	return ["say", "say_id", "say_call", "answer_call", "close_call", "images", "files", "say_audio", "hold", "stop", "confirm", "confirm_text", "stream", "ask", "sign_v2", "sign_v3", "ask_v2", "close", "name",
		// This pi picks a look with a session's name (#21) and wants what each draws with it: the host
		// answers with its looks pages (OwnerSessions' LOOK_NOTES).
		"look_notes",
		// This pi sends a catalogue in pages (sendModels) when the host says it appends them: the host
		// answers this with its own features line (OwnerSessions' HOST_FEATURES).
		"model_pages",
		"subagents", "subagent_chats",
		// Long videos Botsun put on this Mac first: a say names them by path (uploadsOf, takeUploads).
		"uploads",
		// The phone's Stop on a shell job row (stopJobRequest).
		"jobs",
		// Phone steers wait here for the turn's end, and the phone can take them back (unsteerRequest).
		"unsteer",
		...(hasStash ? ["stash"] : []), ...(c.reload ? ["reload"] : []),
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
		// The steers held for the turn's end (ids and sizes): the phone's first Stop takes them back.
		steers: steersLine(c),
		...colorFields(c),
		context: (() => {
			try { return c.context?.() ?? null; } catch { return null; }
		})(),
	});
	// A line of its own, not a hello field: hello must stay under the host's line limit. A hello
	// clears the host's list, so an empty one needs no line.
	c.subagentsSent = "[]";
	reportSubagents(c);
	c.steersSent = JSON.stringify(steersLine(c));
	// The escrow again: a line written while Botsun was away (or before a restart of its own) never
	// reached it, and one it had is answered with another returned_ack.
	resendReturned(c);
}

/**
 * Every steer still in the escrow, down to Botsun again, named for the conversation pi is in now:
 * Botsun takes a `returned` line only for that one, and the phone reads the thread by its id. One
 * handed back by a /new, /resume or /fork was said in the conversation pi just left, so it moves with
 * pi (Botsun moves its own copies on the `session` line too); one Botsun has is acked again.
 */
export function resendReturned(c: Conn): void {
	const all = c.returned ?? [];
	for (const s of all) s.sessionId = c.sessionId;
	sendReturned(c, all);
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
/**
 * Other commands kept off the phone's "/" list: internal ones another extension dispatches itself
 * (agent-link's reload command), and the icon picker, which needs the keyboard.
 */
export const PHONE_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([RELOAD_COMMAND, "agent-link-reload", "icon"]);

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
 * Slash commands from the phone. Extension commands, prompt templates and skills run as typed (and
 * mid-turn too: pi runs a command's handler at once, queues a template or skill as a steer);
 * of pi's built-ins, /compact, /model, /thinking and /name are rebuilt on the extension API, and
 * the rest (pickers, /reload, /new…) need the keyboard. A /compact mid-turn waits for the settle.
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
		.filter((c) => !seen.has(c.name) && !BUILTINS.has(c.name) && !PHONE_HIDDEN_COMMANDS.has(c.name) && /^[A-Za-z][\w:.-]*$/.test(c.name))
		.map((c) => ({ name: c.name.slice(0, 64), ...(c.description ? { description: c.description.slice(0, 160) } : {}) }));
	return [...PHONE_BUILTINS, ...rest].slice(0, 300);
}

/**
 * What a phone slash command did: `null` ran it now, a string is why it didn't, `undefined` isn't a
 * command (it goes in as text), and `{delivered}` says how it went in when the turn was busy: as a
 * steer, exactly as typing it mid-turn does, or held for the settle (a /compact).
 */
export type PhoneCommandRun = string | null | undefined | { delivered: "steer" | "held" };

/**
 * A /compact the phone sent while pi was busy: it waits for the run's end (agent_settled), where it
 * runs as typed after the turn would have. One at a time: a later one replaces it. It remembers the
 * conversation it was sent in, so a /new or /resume in between drops it rather than compacting the
 * session that took its place.
 */
let queuedCompact: { customInstructions?: string; sessionId: string | null } | null = null;

/** Whether pi is idle now; a stale ctx (a session that has since switched) counts as busy. */
function idleNow(ctx: ExtensionContext): boolean {
	try { return ctx.isIdle(); } catch { return false; }
}

function runCommand(pi: ExtensionAPI, ctx: ExtensionContext, text: string, busy: boolean): PhoneCommandRun {
	const cmd = slashCommand(text);
	if (!cmd) return undefined;
	const { name, args } = cmd;
	if (name === "compact") {
		if (busy && !idleNow(ctx)) {
			// pi refuses a prompt (and so a compaction) mid-turn, as it refuses the keyboard's Enter:
			// the words wait for the settle, where the run's own end is. A stale busy flag (pi is
			// already idle) would leave it waiting for a settle that never comes, so run it now then.
			queuedCompact = { ...(args ? { customInstructions: args } : {}), sessionId: sessionInfo(ctx).sessionId };
			return { delivered: "held" }; // not "ran": nothing has run yet
		}
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
	const known = pi.getCommands().find((c) => c.name === name);
	if (known) {
		// As typed: pi runs an extension command's handler at once, even mid-turn (no message in the
		// thread, so the phone shows its "ran" note), and queues a skill or template as a steer (the
		// turn's next boundary reads it, and it lands in the thread). Idle, it is a plain prompt.
		sendUser(pi, text.trim(), { expandPromptTemplates: true, ...(busy ? { deliverAs: "steer" as const } : {}) });
		return busy && known.source !== "extension" ? { delivered: "steer" } : null;
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

// Who this session is: the name the phone shows (identityName), so it answers to it ("Victor,
// what's left?") and never takes another session's name, or the phone app's, as its own. A named
// section, so the prompt only changes when the name does (pi patches just that section).
const IDENTITY_SECTION = "session-identity";
export function identityText(name: string | undefined): string | undefined {
	// Angle brackets out, so a name can't close the section and add text after it.
	const clean = (name ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
	if (!clean) return undefined;
	return (
		`This session is named ${clean}. The user may call you ${clean} in chat, from the phone or on a ` +
		`voice call; answer to it and use it when you refer to yourself. Other sessions have names of their own, and ` +
		`the phone app that relays to you is not you.`
	);
}
export function applyIdentity(sections: Record<string, string> | undefined, name: string | undefined): void {
	if (!sections) return;
	const text = identityText(name);
	if (text) sections[IDENTITY_SECTION] = text;
	else delete sections[IDENTITY_SECTION];
}

function main(pi: ExtensionAPI): void {
	iconBus = pi.events;
	// Subagent children are not Eric's sessions.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let conn: Conn | undefined;
	// When pi's agent_end last ran (0: none since the last idle): the phone's idle says how long the
	// run took to settle after it ended (settle_ms).
	let agentEndAt = 0;
	// Every idle this extension writes, stamped the same way: at (ms) is when it was written, settle_ms
	// how long after agent_end that was. Botsun logs both against its own clock (lag_ms), so at must
	// be epoch ms here even though write() defaults it to ISO. Clears the gap, so it is reported once.
	const writeIdle = (c: Conn, extra: Record<string, unknown> = {}): void => {
		const now = Date.now();
		write(c, "idle", { ...extra, at: now, settle_ms: agentEndAt ? now - agentEndAt : null });
		agentEndAt = 0;
	};
	let held: Array<{ content: string | UserContent[]; steer?: SteerMeta }> = [];
	// The waiting steers' turn_end and agent_settled steps (set in session_start, where pi and ctx are).
	let turnEndSteers: (aborted: boolean, pending: boolean) => void = () => {};
	let settleSteers: (aborted: boolean) => void = () => {};
	// Words a stop released: sent once the aborted run has settled, as if typed after Esc.
	let afterStop: string[] = [];
	let steerHook = false;
	// The phone's steers in pi's queue now (not delivered yet), oldest first: what an abort drops.
	let queuedSteers: string[] = [];

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
	pi.on("agent_end", (_event, ctx) => {
		// The run's own end, before the settle chain: idle carries the gap, so a slow agent_settled
		// (pi awaits each handler in turn, canvas's can take seconds) shows up as settle_ms.
		agentEndAt = Date.now();
		void flushPendingIcon(ctx);
	});

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
		try { write(conn, "busy", { quiet, at: Date.now() }); } catch {}
	});
	// A background message joined his run after its final reply (the quiet extension's split):
	// his part ends here, so Botsun settles it (its finished push brings his answer), and a quiet
	// run starts. split: true tells Botsun this busy isn't him moving on (it keeps the held push).
	pi.events?.on?.(QUIET_SPLIT_EVENT, () => {
		if (!conn || conn.closed || !conn.busy || conn.quietSent === true) return;
		try {
			writeIdle(conn);
			conn.quietSent = true;
			write(conn, "busy", { quiet: true, split: true, at: Date.now() });
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
	const stopJob = (id: string): StopJobResult => stopBgJob(pi.events, id);

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
					const text = typeof event?.text === "string" ? event.text : "";
					// The phone's message this is (if it is one): its client_id goes on the steer mark,
					// so Botsun's thread row for it carries the id the phone matches its bubble by. Only an
					// extension's input (sendUserMessage) can be one: the same words typed at the keyboard
					// stay Eric's own, never the phone's to take back.
					const said = event?.source === "extension" ? takePhoneSay(conn, text) : undefined;
					if (event?.streamingBehavior !== "steer") return;
					if (said) {
						queuedSteers.push(text);
						if (queuedSteers.length > PHONE_SAYS_MAX) queuedSteers.shift();
					}
					pi.appendEntry("botsun-steer", { text: [...text].slice(0, 200).join(""), at: Date.now(), ...(said?.id ? { client_id: said.id } : {}) });
				} catch {}
			});
			// A steer delivered (pi takes it out of its queue as its message starts): no longer the
			// phone's to get back from a Stop.
			pi.on("message_start", (event) => {
				const m = (event as { message?: { role?: unknown; content?: unknown } } | undefined)?.message;
				if (m?.role !== "user" || !queuedSteers.length) return;
				const i = queuedSteers.indexOf(contentTextOf(m.content));
				if (i >= 0) queuedSteers.splice(i, 1);
			});
		}
		const info = sessionInfo(ctx);
		const g = globalThis as { [LAUNCH]?: Conn["launch"] };
		if (!(LAUNCH in g)) g[LAUNCH] = (_event as { reason?: string } | undefined)?.reason === "startup" ? launchOf(info) : null;
		const sessionName = () => pi.getSessionName();
		const setSessionName = (name: string) => pi.setSessionName(name);
		// Eric's own words, as if typed: steer into a running turn, else start one. A busy steer waits for
		// the turn's end (holdsSteer), where turn_end hands it to pi at the point pi would have read it:
		// until then the phone's first Stop can take it back (unsteer).
		const inject = (content: string | UserContent[], busy: boolean, steer?: SteerMeta): "held" | undefined => {
			const c = conn;
			// Words still waiting (a compaction just ended, see releaseHeld) or a compaction pi hasn't
			// announced yet (pendingCompact): stay behind them, in order.
			if (pendingCompact(ctx) || held.length > 0) {
				// Remembered until pi's input event for it: its steer mark takes the id, and a Stop gives it back.
				if (c) notePhoneSay(c, content, steer?.id);
				holdWords(ctx, content, steer);
				return "held";
			}
			if (busy && c && !c.closed && holdsSteer(c, withdrawableText(content, steer))) {
				holdSteer(c, content, steer);
				return undefined;
			}
			if (c) notePhoneSay(c, content, steer?.id);
			return sendOrHold(ctx, content, busy ? { deliverAs: "steer" } : promptOptions(ctx), steer) ? undefined : "held";
		};
		// The oldest waiting steer, to pi now as a steer (turn_end), its phone say noted for its mark.
		const flushSteer = (c: Conn): void => {
			const next = c.steers?.shift();
			if (!next) return;
			reportSteers(c);
			if (!next.noted) notePhoneSay(c, next.content, next.clientId);
			sendUser(pi, next.content, { deliverAs: "steer" });
		};
		// A settled run's steers it never read (no turn_end was left, or one skipped its handlers): his
		// next prompt and follow-ups, as if typed once it settled; held while a compaction runs (or one
		// pi hasn't announced yet), behind the words already waiting.
		const sendLeftSteers = (c: Conn): void => {
			const left = c.steers ?? [];
			if (!left.length) return;
			c.steers = [];
			reportSteers(c);
			left.forEach((s, i) => {
				if (!s.noted) notePhoneSay(c, s.content, s.clientId);
				// Its own id and words, so one held and dropped comes back as the phone's bubble, not a new one.
				sendOrHold(ctx, s.content, i > 0 ? { deliverAs: "followUp" } : promptOptions(ctx), {
					...(s.clientId ? { id: s.clientId } : {}), text: s.text, withdrawable: s.withdrawable, attachments: s.attachments,
				});
			});
		};
		settleSteers = (aborted: boolean): void => {
			const c = conn;
			if (!c || c.closed) return;
			c.inTurn = false;
			if (!c.steers?.length) return;
			if (aborted) returnSteers(c, "stopped");
			else sendLeftSteers(c);
		};
		turnEndSteers = (aborted: boolean, pending: boolean): void => {
			const c = conn;
			if (!c || c.closed) return;
			c.inTurn = false;
			if (!c.steers?.length) return;
			if (aborted) returnSteers(c, "stopped");
			else if (!pending) flushSteer(c);
		};
		// Released call words. queue: a follow-up once the turn ends (a prompt when idle). steer: as a
		// typed message would. stop: abort the run, like Esc, then send them once pi settles.
		const deliver = (text: string, mode: "queue" | "steer" | "stop"): string => {
			const idle = ctx.isIdle();
			// A compaction, announced or not, holds these (pendingCompact): the phone hears "held".
			if (mode === "steer" || pendingCompact(ctx)) return inject(text, !idle) ?? (idle ? "prompt" : "steer");
			if (idle) return sendOrHold(ctx, text, promptOptions(ctx)) ? "prompt" : "held";
			if (mode === "queue") return sendOrHold(ctx, text, { deliverAs: "followUp" }) ? "queue" : "held";
			// The phone's steers the abort drops go again first (they were sent first), then these words:
			// the waiting ones in words alone too; one with photos goes back to the phone (turn_end).
			const waiting = conn?.steers ?? [];
			const words = waiting.filter((s) => typeof s.content === "string");
			if (conn && words.length) {
				conn.steers = waiting.filter((s) => typeof s.content !== "string");
				reportSteers(conn);
			}
			afterStop.push(...words.map((s) => s.content as string), ...abortTaking(), text);
			return "stopped";
		};
		// ctx.abort(), taking back the phone's steers it drops: pi's TUI puts every queued message
		// into its editor on an abort, and the phone's would wait there for Enter at the Mac. They
		// come back out of the editor (the TUI's own queued and typed text stays) and are returned.
		const abortTaking = (): string[] => {
			const phone = ctx.hasPendingMessages?.() === true ? queuedSteers : [];
			queuedSteers = [];
			ctx.abort();
			if (!phone.length || typeof ctx.ui?.getEditorText !== "function" || typeof ctx.ui?.setEditorText !== "function") return [];
			try {
				const before = ctx.ui.getEditorText();
				const { editor, taken } = takeQueued(before, phone);
				if (taken.length) ctx.ui.setEditorText(editor);
				return taken;
			} catch {
				return [];
			}
		};
		// The phone's Stop: Esc, with the phone's steers it dropped. A compaction counts as running
		// (Esc stops that too).
		const stopReturning = (): { stopped: boolean; dropped: string[] } => {
			if (ctx.isIdle() && !compacting) return { stopped: false, dropped: [] };
			return { stopped: true, dropped: abortTaking() };
		};
		const stop = (): string => (stopReturning().stopped ? "stopped" : "idle");
		// The phone's Close: stop what's running, then (after the reply) a graceful exit. idleOnly
		// (close_call): nothing while a turn or compaction runs, a prompt is on its way in (sent,
		// not started yet) or messages wait in pi's queue, and the same again at shutdown (a typed
		// prompt, a follow-up or a trigger may have started one since the reply).
		const running = () =>
			!ctx.isIdle() || compacting !== null || conn?.busy === true || conn?.framing !== undefined || (conn?.steers?.length ?? 0) > 0 ||
			held.length > 0 || promptStarting() || ctx.hasPendingMessages?.() === true;
		const close = (opts?: { idleOnly?: boolean }) => {
			if (opts?.idleOnly && running()) return null;
			const shutdown = () => {
				if (opts?.idleOnly && running()) {
					debug("close_call: a turn started before the shutdown; not closing");
					return;
				}
				ctx.shutdown();
			};
			// The phone's steers the abort takes out of the editor go back in the reply (pi exits next).
			const { stopped, dropped } = stopReturning();
			return { stopped, dropped, shutdown };
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
		// The waiting steers in pi's footer: the keyboard sees what the phone queued (reportSteers).
		const steerStatus = (text: string | undefined) => {
			try { ctx.ui?.setStatus?.("botsun-steers", text); } catch {}
		};
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
			conn.pendingCompact = () => pendingCompact(ctx);
			conn.steerStatus = steerStatus;
			conn.deliver = deliver;
			conn.stop = stop;
			conn.stopReturning = stopReturning;
			conn.close = close;
			conn.reload = reload;
			conn.restart = restart;
			conn.command = command;
			conn.commands = commands;
			conn.models = models;
			conn.context = context;
			conn.confirm = confirm;
			conn.color = color;
			conn.stopJob = stopJob;
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
				// Steers a /new, /resume or /fork handed back (session_shutdown) reach the box of the
				// conversation the phone follows now, not the one pi left.
				resendReturned(conn);
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
			if (conn.busy) { conn.busy = false; writeIdle(conn); }
			if (conn.prompt) { conn.prompt = null; conn.promptDepth = 0; write(conn, "prompt_end"); }
			return;
		}
		conn = {
			connected: false, closed: false, delay: retryBase(),
			busy: false, prompt: null, promptDepth: 0, sessionName, setSessionName, ...info, launch: g[LAUNCH],
			nonces: new Map(), inject, pendingCompact: () => pendingCompact(ctx), steerStatus, deliver, stop, stopReturning, close, reload, restart, command, commands, models, context, confirm, color, stopJob,
			model: modelOf(ctx),
		};
		store[STORE] = conn;
		connect(conn);
		listenOwner(conn);
	});
	// The restart extension writes its record in its own session_start, before or after this one:
	// once every handler ran, say whether restart is possible now, if that changed.
	pi.on("session_start", () => {
		// A /compact queued for the run that ended here isn't this conversation's to run.
		queuedCompact = null;
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
		write(conn, "stream_end", { at: Date.now() });
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
	pi.on("before_agent_start", (event) => {
		inputAt = Date.now();
		// The name the phone shows, not just pi's: agent-link's name is the one a call says.
		applyIdentity(event.systemPromptOptions?.sections, conn ? identityName(conn) : pi.getSessionName());
		return undefined;
	});
	pi.on("agent_start", () => {
		inputAt = 0; // pi's turn counts as running from here
		// Before the early return too: a run that ends without an agent_end (or one whose idle never
		// went out) must not hand a stale gap to the next idle's settle_ms.
		agentEndAt = 0;
		if (!conn || conn.closed || conn.busy) return;
		conn.busy = true;
		conn.quietSent = runIsQuiet();
		write(conn, "busy", { quiet: conn.quietSent, at: Date.now() });
	});

	// A turn: a busy steer said now waits for its end (holdsSteer), where pi reads its queue.
	pi.on("turn_start", () => {
		if (conn && !conn.closed) conn.inTurn = true;
	});
	// pi runs this inside finishTurn, before the agent loop reads its steering queue: a waiting steer
	// handed over here lands at the same read it would have. One per turn, and only while pi holds
	// none of its own, so the rest stay withdrawable (in pi's default one-at-a-time mode the loop
	// reads one per turn anyway). hasPendingMessages counts pi's follow-ups too, and the API can't
	// tell them apart: with a follow-up queued, a waiting steer waits for the run to settle and goes in
	// as a prompt then, after that follow-up (accepted: rare, and nothing is lost; it is still
	// withdrawable until then). Never on an aborted turn: the run is stopping (an Esc, the phone's
	// Stop, or a /new, /resume, /fork or quit, which reset pi's queue right after), so they go back to
	// the phone instead (returnSteers).
	pi.on("turn_end", (event, ctx) => {
		let pending = false;
		try { pending = ctx?.hasPendingMessages?.() === true; } catch {}
		turnEndSteers((event as { outcome?: string } | undefined)?.outcome === "aborted", pending);
	});

	pi.on("agent_settled", (event, ctx) => {
		inputAt = 0;
		// A settled run has delivered its steers, or an Esc at the keyboard put them in the editor
		// for Eric there: none is the phone's to take back now.
		queuedSteers = [];
		settleSteers((event as { aborted?: boolean } | undefined)?.aborted === true);
		const released = afterStop.length > 0;
		if (released) {
			// As if typed after Esc; through the hold guard, so a compaction starting now waits with them.
			const text = afterStop.join("\n\n");
			afterStop = [];
			try {
				if (conn && !conn.closed) conn.inject(text, false);
				else sendOrHold(ctx, text);
			} catch {}
		}
		if (conn && !conn.closed && conn.busy) {
			conn.busy = false;
			conn.quietSent = undefined;
			// The run's done signal, with settle_ms: how long the settle handlers ahead of this one held it.
			writeIdle(conn);
			reportContext();
		}
		// A /compact the phone sent during the run waited for this end, as typed after the turn would be.
		runQueuedCompact(ctx, released);
	});

	/**
	 * The phone's /compact while pi was busy, run once the run settled. Left waiting when a stop just
	 * released words into a run of their own (it would abort that): it runs at that run's settle. One
	 * sent in another conversation (a /new or /resume since) is dropped, not run against this one.
	 */
	const runQueuedCompact = (ctx: ExtensionContext, released: boolean): void => {
		if (!queuedCompact || released) return;
		const waiting = queuedCompact;
		queuedCompact = null;
		if (!conn || conn.closed) return;
		if (waiting.sessionId !== null && waiting.sessionId !== sessionInfo(ctx).sessionId) return;
		ctx.compact({
			...(waiting.customInstructions ? { customInstructions: waiting.customInstructions } : {}),
			onError: (e) => ctx.ui.notify(`Compaction from the phone failed: ${e.message}`, "error"),
		});
	};

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
		startRelease(ctx);
	};
	/** A prompt sent, not started yet: pi's input and before_agent_start handlers are still running. */
	const promptStarting = (): boolean => inputAt > 0 && Date.now() - inputAt < PROMPT_STARTING_MS;
	/**
	 * A compaction pi hasn't announced yet. pi refuses a prompt from the moment it starts one, but its
	 * `session_before_compact` handlers run in load order and another extension's can run for a minute
	 * first (extensions/compaction writes the whole summary inside its own), so `compacting` is still
	 * null when the phone's words arrive (2026-11-10). A session that isn't idle with no turn running
	 * and no prompt on its way in is one of those: the API has neither `compaction_start` nor
	 * `isCompacting`, and that is the only other thing that leaves pi neither idle nor running.
	 */
	const pendingCompact = (ctx: ExtensionContext): boolean =>
		compacting !== null || (!ctx.isIdle() && conn?.busy !== true && !promptStarting());
	/**
	 * A prompt's options where pi may already be busy with one: none when it is idle and takes a plain
	 * prompt (pi ignores deliverAs then), a follow-up while it isn't (a turn's start, a prompt in its
	 * input handler, a compaction's own check): a second bare prompt then throws "Agent is already
	 * processing" asynchronously, past any try/catch, and the words would be lost.
	 */
	const promptOptions = (ctx: ExtensionContext): Parameters<ExtensionAPI["sendUserMessage"]>[1] =>
		!ctx.isIdle() || promptStarting() ? { deliverAs: "followUp" } : undefined;
	// The phone's words a compaction holds: they wait in `held`, in order, until pi takes a prompt
	// again (releaseHeld). Never sent blind, and never dropped without going back to the phone.
	const holdWords = (ctx: ExtensionContext, content: string | UserContent[], steer?: SteerMeta): void => {
		if (!held.length) heldAt = Date.now(); // the wait's clock starts with the first word
		held.push({ content, ...(steer ? { steer } : {}) });
		startRelease(ctx);
	};
	/**
	 * pi's words now, or held when it can't take them: false when they were held. pi's own refusal ("Cannot
	 * submit a prompt while compaction is in progress") goes to the runner's error listeners
	 * (`send_user_message`), which no extension can hear, so the check before the send is the guard; a
	 * send that throws anyway (an older pi that refuses first) re-holds them rather than losing them.
	 */
	const sendOrHold = (ctx: ExtensionContext, content: string | UserContent[], options?: Parameters<ExtensionAPI["sendUserMessage"]>[1], steer?: SteerMeta): boolean => {
		// Words still waiting go first, in order: one sent now would jump ahead of them (and a bare
		// prompt racing a released one loses one of them).
		if (pendingCompact(ctx) || held.length > 0) {
			holdWords(ctx, content, steer);
			return false;
		}
		try {
			sendUser(pi, content, options);
			return true;
		} catch {
			holdWords(ctx, content, steer);
			return false;
		}
	};
	// One release poll at a time: a hold while one waits joins it, and a compaction's end starts one.
	let releasing = false;
	// The poll's pending tick, so a shutdown can stop it: it captures ctx, which goes stale under it.
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	// When the waiting words' clock started (Date.now: wall time, so a test can move it).
	let heldAt = 0;
	const startRelease = (ctx: ExtensionContext): void => {
		if (releasing) return;
		releasing = true;
		releaseHeld(ctx);
	};
	/** The poll stops and its words stay where they are, for the next hold or compaction's end. */
	const stopRelease = (): void => {
		clearTimeout(releaseTimer);
		releaseTimer = undefined;
		releasing = false;
	};
	/**
	 * pi emits session_compact while the compaction still counts as running, and a prompt sent then is
	 * refused asynchronously, past any try/catch: the phone's words were lost (2026-11-10). Release them
	 * only once pi takes them: idle (a prompt) or in a running turn (a steer). A compaction pi never
	 * announced reads the same way (pendingCompact) and is waited out; after HELD_MAX_MS the words go
	 * back to the phone (dropHeld) instead, so nothing waits forever and nothing vanishes.
	 */
	const releaseHeld = (ctx: ExtensionContext): void => {
		// A stale ctx (a /new, /resume, /fork or /reload under the poll) throws in here, and a throw
		// inside a timer is uncaught, which takes pi down: the poll just stops.
		try {
			releaseWords(ctx);
		} catch (e) {
			stopRelease();
			debug(`release poll stopped: ${(e as Error).message}`);
		}
	};
	const releaseWords = (ctx: ExtensionContext): void => {
		// An announced compaction ends with session_compact, which starts this again (endCompaction).
		if (compacting || held.length === 0) {
			releasing = false;
			if (!held.length) heldAt = 0;
			return;
		}
		if (pendingCompact(ctx)) {
			if (Date.now() - heldAt >= HELD_MAX_MS) {
				releasing = false;
				dropHeld();
				return;
			}
			releaseTimer = setTimeout(() => {
				releaseTimer = undefined;
				releaseHeld(ctx);
			}, 250);
			releaseTimer.unref();
			return; // still releasing: one poll at a time
		}
		releasing = false;
		const idle = ctx.isIdle();
		const out = held;
		held = [];
		const c = conn;
		out.forEach(({ content, steer }, i) => {
			// A running turn's steer waits for its end like any other (holdsSteer), behind those waiting.
			if (!idle && c && !c.closed && holdsSteer(c, withdrawableText(content, steer))) {
				holdSteer(c, content, steer, { noted: true });
				return;
			}
			// A prompt still on its way in (a keyboard one reads as idle): a follow-up, never a second bare one.
			const options = i > 0 || promptStarting() ? { deliverAs: "followUp" as const } : idle ? undefined : { deliverAs: "steer" as const };
			// One pi still won't take stays held, for the next hold or compaction's end.
			try { sendUser(pi, content, options); } catch { held.push({ content, ...(steer ? { steer } : {}) }); }
		});
		// Nothing left: the next hold starts the wait's clock again.
		if (!held.length) heldAt = 0;
	};
	/**
	 * Words held past HELD_MAX_MS (or a session ending), back to the phone's message box: the channel a
	 * returned steer uses (Botsun's `returned` line, which puts it in the phone's box), so the phone
	 * hears they weren't delivered. Never silently dropped; `why` says which: "withdrawn" for the wait's
	 * cap, "stopped" for a session ending on them.
	 */
	const dropHeld = (why: ReturnedSteer["why"] = "withdrawn"): void => {
		const c = conn;
		if (!held.length) return;
		// No connection to hand them back through: they stay held (a reconnect's hello asks again).
		if (!c) return;
		const out = held;
		held = [];
		heldAt = 0;
		debug(`held words dropped (${why})`); // never the text
		escrow(c, out.map(({ content, steer }) => {
			const text = (steer?.text ?? contentTextOf(content)).trim();
			const n = Math.max(1, steer?.attachments ?? 0);
			return {
				id: steer?.id && STEER_ID.test(steer.id) ? steer.id : randomUUID(),
				text: text || `[${n} attachment${n === 1 ? "" : "s"}]`,
				at: Date.now(),
				sessionId: c.sessionId,
				why,
			};
		}));
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
		// The release poll holds ctx: /new, /resume, /fork and /reload abort a compaction under it, and
		// the next tick's ctx.isIdle() throws ("ctx is stale") inside a timer, which takes pi down.
		// Stop it, and the words it waited for go back to the phone rather than dying here.
		stopRelease();
		dropHeld("stopped");
		queuedCompact = null; // the phone's /compact waited for a run that won't settle here
		const c = conn;
		conn = undefined;
		if (!c || c.closed) return;
		// Never handed to pi at teardown (it aborts and resets its queue): back to the phone, before a bye.
		c.inTurn = false;
		returnSteers(c, "stopped");
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
