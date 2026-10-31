/**
 * Device key pinning for botsun-owner (trust on first use). Botsun writes owner-keys.json, so a
 * compromised Botsun (or anything that can write that file) could swap in its own key for a paired
 * device id, or add a device id of its own. This session keeps its own record, in its own state
 * dir: device id → sha256 of the public key it first verified a signature with. A later, different
 * key for the same id is refused until Eric confirms the change at the keyboard; so is a device id
 * not pinned yet. Only two cases pin silently: nothing pinned at all (the first pairing, or the move
 * to pinning: trusted blindly), or a device already pinned for the other key kind getting its first
 * key of this kind (the same phone's call key, the first time Eric calls).
 *
 * File: $BOTSUN_OWNER_PIN_DIR/pins.json (default ~/.local/state/pi-botsun-owner), 0600 in a
 * 0700 dir of Eric's, written atomically (temp file + rename) under an O_EXCL lock file so two
 * pi processes don't lose each other's pins. Decision and call keys are pinned apart.
 *
 * Signing ratchet: the same file records, per device id, that the device has signed v2
 * ("botsun-sign-v2"): the first v2 request that verifies (and passes the pin) records
 * sign_version 2 under sign_versions, shared by the device's decision and call keys. From then on
 * a v1 request from that device is refused, so a compromised Botsun can't downgrade it to v1
 * (whose ask answers don't cover the question text). Deleting pins.json resets pins and ratchets.
 *
 * What this can't do: anything running as Eric's user can rewrite pins.json (or this file).
 */
import {
	chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
	renameSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export type KeyKind = "decide" | "call";

export const pinDir = (): string => process.env.BOTSUN_OWNER_PIN_DIR || join(homedir(), ".local", "state", "pi-botsun-owner");
export const pinPath = (): string => join(pinDir(), "pins.json");
const lockPath = (): string => join(pinDir(), "pins.lock");

/** A lock file older than this is a crashed writer's: it's broken. */
export const LOCK_STALE_MS = 10_000;
/** How long pin() waits for the lock before giving up (the caller refuses the request). */
const LOCK_WAIT_MS = 2_000;

/** sha256 hex of the raw 65-byte public key. */
export const keyFingerprint = (raw: Buffer): string => createHash("sha256").update(raw).digest("hex");

/** A fingerprint as a person compares it: the first 16 hex digits in fours. */
export const shortFingerprint = (fp: string): string => fp.slice(0, 16).match(/.{4}/g)!.join(" ");

interface PinEntry { sha256: string; at: string }
interface RatchetEntry { sign_version: 2; at: string }
interface PinFile {
	version: 1;
	devices: Record<string, PinEntry>;
	call_devices: Record<string, PinEntry>;
	/** device id → the signing version it has moved to (only 2 so far): v1 from it is refused. */
	sign_versions: Record<string, RatchetEntry>;
}

const section = (kind: KeyKind): "devices" | "call_devices" => (kind === "call" ? "call_devices" : "devices");
const otherSection = (kind: KeyKind): "devices" | "call_devices" => (kind === "call" ? "devices" : "call_devices");
const empty = (): PinFile => ({ version: 1, devices: {}, call_devices: {}, sign_versions: {} });
const myUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/**
 * The pin dir, checked: a real directory (not a symlink) of Eric's, mode 0700. Created 0700 when
 * missing and create is set; false when missing and not. Throws on anything else.
 */
function checkDir(create: boolean): boolean {
	const dir = pinDir();
	let st;
	try {
		st = lstatSync(dir);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		if (!create) return false;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700); // the umask may have taken bits off
		st = lstatSync(dir);
	}
	const uid = myUid();
	if (!st.isDirectory() || (st.mode & 0o777) !== 0o700 || (uid !== null && st.uid !== uid)) {
		throw new Error("device pins dir must be a real 0700 directory of Eric's");
	}
	return true;
}

const malformed = (): Error => new Error("device pins file is malformed");

/** One section of the file: every entry must be a pin, or the whole file is refused (never "not pinned"). */
function pick(o: unknown): Record<string, PinEntry> {
	const out: Record<string, PinEntry> = {};
	if (o === undefined) return out;
	if (!o || typeof o !== "object" || Array.isArray(o)) throw malformed();
	for (const [id, e] of Object.entries(o as Record<string, unknown>)) {
		const sha = (e as PinEntry | null)?.sha256;
		if (!e || typeof e !== "object" || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw malformed();
		out[id] = { sha256: sha, at: String((e as PinEntry).at ?? "") };
	}
	return out;
}

/** The ratchet section: every entry must be {sign_version: 2}, or the whole file is refused. */
function pickRatchets(o: unknown): Record<string, RatchetEntry> {
	const out: Record<string, RatchetEntry> = {};
	if (o === undefined) return out;
	if (!o || typeof o !== "object" || Array.isArray(o)) throw malformed();
	for (const [id, e] of Object.entries(o as Record<string, unknown>)) {
		if (!e || typeof e !== "object" || (e as RatchetEntry).sign_version !== 2) throw malformed();
		out[id] = { sign_version: 2, at: String((e as RatchetEntry).at ?? "") };
	}
	return out;
}

/** The pin file, or an empty one when there is none. Throws on a file others could have written, or a malformed one. */
export function readPins(): PinFile {
	if (!checkDir(false)) return empty();
	let fd: number;
	try {
		fd = openSync(pinPath(), constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return empty();
		if (code === "ELOOP") throw new Error("device pins file must be a regular 0600 file of Eric's");
		throw e;
	}
	let text: string;
	try {
		const st = fstatSync(fd);
		const uid = myUid();
		if (!st.isFile() || (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) {
			throw new Error("device pins file must be a regular 0600 file of Eric's");
		}
		text = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw malformed();
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw malformed();
	const r = raw as Record<string, unknown>;
	return { version: 1, devices: pick(r.devices), call_devices: pick(r.call_devices), sign_versions: pickRatchets(r.sign_versions) };
}

function writePins(file: PinFile): void {
	const dir = pinDir();
	const tmp = join(dir, `.pins.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, pinPath());
	} catch (e) {
		try { unlinkSync(tmp); } catch {}
		throw e;
	}
}

/**
 * Breaks a lock file judged stale, whose contents were seen. Moved aside first, so only one waiter
 * breaks it; then the moved file is checked: if it's a different (or fresh) lock, another waiter
 * broke the stale one first and someone took the lock since, so it's put back (a hard link, which
 * never clobbers a newer lock) and this waiter backs off. Returns whether the stale lock was broken.
 */
export function breakStaleLock(path: string, seen: string): boolean {
	const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
	try {
		renameSync(path, aside);
	} catch {
		return false;
	}
	let stale = false;
	try {
		stale = readFileSync(aside, "utf8") === seen && Date.now() - lstatSync(aside).mtimeMs > LOCK_STALE_MS;
	} catch {}
	if (!stale) {
		try { linkSync(aside, path); } catch {}
	}
	try { unlinkSync(aside); } catch {}
	return stale;
}

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Runs fn holding the pin lock (an O_EXCL lock file; one older than LOCK_STALE_MS is broken). */
function withLock<T>(fn: () => T): T {
	checkDir(true);
	const path = lockPath();
	const token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try { writeSync(fd, token); } finally { closeSync(fd); }
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		try {
			if (Date.now() - lstatSync(path).mtimeMs > LOCK_STALE_MS && breakStaleLock(path, readFileSync(path, "utf8"))) continue;
		} catch {}
		if (Date.now() > deadline) throw new Error("device pins are locked");
		pause(5);
	}
	try {
		return fn();
	} finally {
		try { if (readFileSync(path, "utf8") === token) unlinkSync(path); } catch {}
	}
}

/** The pinned fingerprint for a device's key, or null when it has none yet. */
export function pinned(kind: KeyKind, deviceId: string): string | null {
	return readPins()[section(kind)][deviceId]?.sha256 ?? null;
}

/**
 * Records a device's pin, re-reading the file under the lock. With expect, only when the device's
 * pin is still that (null: still unpinned), so a keyboard yes changes only what it showed.
 * Returns whether it pinned.
 */
export function pin(kind: KeyKind, deviceId: string, fingerprint: string, expect?: string | null): boolean {
	return withLock(() => {
		const file = readPins();
		const s = file[section(kind)];
		if (expect !== undefined && (s[deviceId]?.sha256 ?? null) !== expect) return false;
		s[deviceId] = { sha256: fingerprint, at: new Date().toISOString() };
		writePins(file);
		return true;
	});
}

/** What needs Eric's yes at the keyboard: a changed key (pinned set) or a device not pinned yet (pinned null). */
export interface PinAsk { pinned: string | null; offered: string }
export type PinCheck = { ok: true } | { ok: false; error: string; ask?: PinAsk };

/**
 * Whether a device's first key of this kind pins silently: nothing is pinned at all (the first
 * pairing), or this kind has nothing pinned and the device is pinned for the other kind (the same
 * phone's first call key). A new device id while anything is pinned needs the keyboard.
 */
const bootstrap = (file: PinFile, kind: KeyKind, deviceId: string): boolean => {
	const mine = file[section(kind)];
	const other = file[otherSection(kind)];
	if (Object.keys(mine).length > 0) return false;
	return Object.keys(other).length === 0 || Object.hasOwn(other, deviceId);
};

const decide = (file: PinFile, kind: KeyKind, deviceId: string, offered: string): PinCheck | null => {
	const have = Object.hasOwn(file[section(kind)], deviceId) ? file[section(kind)][deviceId]!.sha256 : null;
	if (have === offered) return { ok: true };
	if (have) return { ok: false, error: "this device's key changed: confirm at the keyboard", ask: { pinned: have, offered } };
	if (!bootstrap(file, kind, deviceId)) return { ok: false, error: "new device: confirm at the keyboard", ask: { pinned: null, offered } };
	return null; // pin it silently (see bootstrap)
};

/**
 * Checks a key that just verified a signature against the device's pin: passes a match, pins it
 * silently only on bootstrap (above), and otherwise refuses (ask: what to put to Eric at the
 * keyboard).
 */
export function checkPin(kind: KeyKind, deviceId: string, raw: Buffer): PinCheck {
	const offered = keyFingerprint(raw);
	const readError = (e: unknown): PinCheck =>
		({ ok: false, error: (e as Error).message.startsWith("device pins") ? (e as Error).message : "couldn't read the device pins" });
	let first: PinCheck | null;
	try {
		first = decide(readPins(), kind, deviceId, offered);
	} catch (e) {
		return readError(e);
	}
	if (first) return first;
	try {
		// Decided again under the lock: another process may have pinned something meanwhile.
		return withLock(() => {
			const file = readPins();
			const again = decide(file, kind, deviceId, offered);
			if (again) return again;
			file[section(kind)][deviceId] = { sha256: offered, at: new Date().toISOString() };
			writePins(file);
			return { ok: true } as PinCheck;
		});
	} catch (e) {
		return (e as Error).message.startsWith("device pins file") || (e as Error).message.startsWith("device pins dir")
			? readError(e)
			: { ok: false, error: "couldn't record the device's key pin" };
	}
}

/** The signing version a device has ratcheted to (2), or 1 when none. Throws on an unreadable pin file. */
export function signVersionOf(deviceId: string): 1 | 2 {
	const file = readPins();
	return Object.hasOwn(file.sign_versions, deviceId) ? 2 : 1;
}

/**
 * Records that a device signs v2 (re-read under the lock; written only when it isn't recorded
 * yet). Throws when the file can't be read or written.
 */
export function ratchet(deviceId: string): void {
	if (signVersionOf(deviceId) === 2) return;
	withLock(() => {
		const file = readPins();
		if (Object.hasOwn(file.sign_versions, deviceId)) return;
		file.sign_versions[deviceId] = { sign_version: 2, at: new Date().toISOString() };
		writePins(file);
	});
}
