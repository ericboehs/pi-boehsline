/**
 * The v2 signed-message format the phone's Secure Enclave key signs, the same as Botsun's
 * (botsun lib/botsun/signing.rb; pinned to it by test/fixtures/signing-v2.json):
 *
 *   botsun-sign-v2
 *   <device_id>
 *   <nonce>
 *   <kind>        what is acted on ("session", "answer", …)
 *   <scope>       the real target id (here: the session id)
 *   <decision>    the verb ("say", "answer", "stop", …)
 *   <sha256hex(payload)>
 *
 * v3 ("botsun-sign-v3", botsun docs/plans/host-signing.md; pinned by test/fixtures/signing-v3.json)
 * is the same with the host's authority ("fqdn:port", lowercase, port always written) on the line
 * after the magic, so a signature made for one host never verifies on another.
 *
 * Every hash is SHA-256, lowercase hex, over the exact UTF-8 bytes (no Unicode normalization).
 * Pure functions only; botsun-owner decides what kind/scope/decision/payload a request means.
 */
import { createHash } from "node:crypto";

export const SIGN_MAGIC = "botsun-sign-v2";
export const VALID_SCOPE = /^[A-Za-z0-9._:-]{1,120}$/;
/** kind, decision, device id and nonce: no newline can let one field pose as two. */
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A field name in a fields payload: no spaces, no newlines. */
const FIELD = /^[A-Za-z0-9_.-]{1,64}$/;

/** SHA-256 hex of a string's UTF-8 bytes, or of a buffer's bytes. */
export const digestHex = (payload: string | Buffer): string =>
	createHash("sha256").update(typeof payload === "string" ? Buffer.from(payload, "utf8") : payload).digest("hex");

export const validScope = (scope: unknown): scope is string => typeof scope === "string" && VALID_SCOPE.test(scope);

export interface MessageV2 {
	deviceId: string;
	nonce: string;
	kind: string;
	scope: string;
	decision: string;
	payload: string | Buffer;
}

/** The exact text the phone signs. Throws on a field that could smuggle a line. */
export function messageV2(m: MessageV2): string {
	for (const [name, value] of [["device_id", m.deviceId], ["nonce", m.nonce], ["kind", m.kind], ["decision", m.decision]] as const) {
		if (typeof value !== "string" || !TOKEN.test(value)) throw new Error(`bad ${name}: ${JSON.stringify(value)}`);
	}
	if (!validScope(m.scope)) throw new Error(`bad scope: ${JSON.stringify(m.scope)}`);
	return [SIGN_MAGIC, m.deviceId, m.nonce, m.kind, m.scope, m.decision, digestHex(m.payload)].join("\n");
}

export const SIGN_MAGIC_V3 = "botsun-sign-v3";
/** A host's authority as v3 signs it: lowercase "fqdn:port", the port always written. */
export const VALID_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?:[0-9]{1,5}$/;

export const validHost = (host: unknown): host is string => typeof host === "string" && VALID_HOST.test(host);

export interface MessageV3 extends MessageV2 { host: string }

/** v3: v2's message with "<host>" (VALID_HOST) on the line after the magic. Throws like messageV2, and on a bad host. */
export function messageV3(m: MessageV3): string {
	if (!validHost(m.host)) throw new Error(`bad host: ${JSON.stringify(m.host)}`);
	const v2 = messageV2(m);
	return [SIGN_MAGIC_V3, m.host, v2.slice(SIGN_MAGIC.length + 1)].join("\n");
}

/**
 * F(k1=v1, …): one line "<k> <sha256hex(v)>" per pair, in order. null/undefined means "leave
 * unchanged" and is "<k> -", which differs from "" (the hash of the empty string).
 */
export function fieldsPayload(pairs: Array<[string, string | null | undefined]>): string {
	return pairs.map(([key, value]) => {
		if (!FIELD.test(key)) throw new Error(`bad field name: ${JSON.stringify(key)}`);
		return `${key} ${value == null ? "-" : digestHex(String(value))}`;
	}).join("\n");
}
