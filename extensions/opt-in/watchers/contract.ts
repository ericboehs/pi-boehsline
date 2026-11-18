/**
 * The script contract: parse and validate JSON Lines from a watcher script,
 * normalize the free text in them, and build each event's line from its
 * structured fields only.
 *
 * Pure node, no pi imports.
 */

export const MAX_LINE_BYTES = 2048;
export const MAX_STDOUT_BYTES = 1024 * 1024;
export const MAX_EVENTS = 200;
export const TITLE_MAX = 80;
export const UNTRUSTED_MAX = 300;
export const URL_MAX = 300;

export const ID_RE = /^[A-Za-z0-9:._-]{1,120}$/;
export const ACTOR_RE = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
export const SUBJECT_RE = /^(pr|issue):\d{1,7}$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/;
export const VERBS = ["PUSH", "CI", "COMMENT", "REVIEW", "MERGED", "CLOSED", "OPENED"] as const;
export const STATES = [
	// CI
	"SUCCESS", "FAILURE", "PENDING", "ERROR", "CANCELLED", "TIMED_OUT", "SKIPPED", "NEUTRAL", "ACTION_REQUIRED", "IN_PROGRESS", "QUEUED", "STALE",
	// reviews
	"APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED",
	// PRs and issues
	"OPEN", "CLOSED", "MERGED", "DRAFT",
] as const;

export type Verb = (typeof VERBS)[number];
export type Kind = "act" | "info";

export interface WatchEvent {
	id: string;
	kind: Kind;
	actor: string;
	subject: string;
	verb: Verb;
	number?: number;
	state?: string;
	sha?: string;
	/** Normalized, at most TITLE_MAX characters. Untrusted. */
	title?: string;
	/** Normalized, at most UNTRUSTED_MAX characters. Untrusted. */
	untrusted?: string;
	url?: string;
}

export type ParseResult = { ok: true; event: WatchEvent } | { ok: false; error: string };

// Bidi embeddings, overrides and isolates; marks; zero-width characters; BOM.
const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060-\u2064\u061C\uFEFF\u180E\u00AD]/g;
// C0 and C1 controls (tabs and newlines too; whitespace collapses after).
// biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/** NFKC; strip bidi, zero-width and control characters; collapse whitespace; cut to `max` code points. */
export function normalize(text: string, max: number): string {
	const s = text.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
	const chars = Array.from(s);
	return chars.length > max ? chars.slice(0, max).join("").trimEnd() : s;
}

/** https only, host on the list, at most URL_MAX characters. Anything else is dropped. */
export function checkUrl(url: unknown, hosts: string[]): string | undefined {
	if (typeof url !== "string" || url.length > URL_MAX) return undefined;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return undefined;
	}
	if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
	if (!hosts.includes(u.hostname.toLowerCase())) return undefined;
	return u.href;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** One stdout line to an event, or why it was dropped. */
export function parseLine(line: string, urlHosts: string[]): ParseResult {
	if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return { ok: false, error: "line over 2 KB" };
	let o: unknown;
	try {
		o = JSON.parse(line);
	} catch {
		return { ok: false, error: "not JSON" };
	}
	if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, error: "not an object" };
	const r = o as Record<string, unknown>;
	if (!isStr(r.id) || !ID_RE.test(r.id)) return { ok: false, error: "bad id" };
	if (r.kind !== "act" && r.kind !== "info") return { ok: false, error: "unknown kind" };
	if (!isStr(r.actor) || !ACTOR_RE.test(r.actor)) return { ok: false, error: "bad actor" };
	if (!isStr(r.subject) || !SUBJECT_RE.test(r.subject)) return { ok: false, error: "bad subject" };
	const verb = isStr(r.verb) ? r.verb.toUpperCase() : "";
	if (!(VERBS as readonly string[]).includes(verb)) return { ok: false, error: "unknown verb" };
	const ev: WatchEvent = { id: r.id, kind: r.kind, actor: r.actor, subject: r.subject, verb: verb as Verb };
	if (r.number !== undefined) {
		if (!Number.isInteger(r.number) || (r.number as number) < 0 || (r.number as number) > 9_999_999) return { ok: false, error: "bad number" };
		ev.number = r.number as number;
	}
	if (r.state !== undefined) {
		const state = isStr(r.state) ? r.state.toUpperCase() : "";
		if (!(STATES as readonly string[]).includes(state)) return { ok: false, error: "unknown state" };
		ev.state = state;
	}
	if (r.sha !== undefined) {
		if (!isStr(r.sha) || !SHA_RE.test(r.sha)) return { ok: false, error: "bad sha" };
		ev.sha = r.sha;
	}
	if (r.title !== undefined) {
		if (!isStr(r.title)) return { ok: false, error: "bad title" };
		const t = normalize(r.title, TITLE_MAX);
		if (t) ev.title = t;
	}
	if (r.untrusted !== undefined) {
		if (!isStr(r.untrusted)) return { ok: false, error: "bad untrusted" };
		const u = normalize(r.untrusted, UNTRUSTED_MAX);
		if (u) ev.untrusted = u;
	}
	if (r.url !== undefined) {
		const url = checkUrl(r.url, urlHosts);
		if (url) ev.url = url;
		// An off-list or non-https URL is dropped, not the event.
	}
	return { ok: true, event: ev };
}

export interface OutputResult {
	events: WatchEvent[];
	errors: string[];
	/** The whole run failed (oversized or not UTF-8); nothing should be committed. */
	fatal?: string;
}

/** A run's whole stdout. Rejects oversized and non-UTF-8 output outright. */
export function parseOutput(stdout: Buffer, urlHosts: string[]): OutputResult {
	if (stdout.length > MAX_STDOUT_BYTES) return { events: [], errors: [], fatal: "stdout over 1 MB" };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
	} catch {
		return { events: [], errors: [], fatal: "stdout is not UTF-8" };
	}
	const events: WatchEvent[] = [];
	const errors: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (events.length >= MAX_EVENTS) {
			errors.push(`more than ${MAX_EVENTS} events; the rest dropped`);
			break;
		}
		const r = parseLine(line, urlHosts);
		if (r.ok) events.push(r.event);
		else errors.push(r.error);
	}
	return { events, errors };
}

/** The user's own activity never wakes the agent. */
export function forceInfo(ev: WatchEvent, me: string): WatchEvent {
	return me && ev.actor.toLowerCase() === me.toLowerCase() && ev.kind !== "info" ? { ...ev, kind: "info" } : ev;
}

function subjectLabel(subject: string): string {
	const [type, n] = subject.split(":");
	return type === "pr" ? `PR #${n}` : `issue #${n}`;
}

/** The event's line from structured fields only. No title, no excerpt. */
export function textFor(ev: WatchEvent): string {
	const subj = subjectLabel(ev.subject);
	const sha = ev.sha ? ` (${ev.sha.slice(0, 7)})` : "";
	const state = ev.state ? ` ${ev.state}` : "";
	switch (ev.verb) {
		case "PUSH":
			return `PUSH ${subj} by ${ev.actor}${sha}`;
		case "CI":
			return `CI ${subj}${state || " UNKNOWN"}${sha}`;
		case "COMMENT":
			return `COMMENT ${subj} by ${ev.actor}`;
		case "REVIEW":
			return `REVIEW ${subj}${state} by ${ev.actor}`;
		case "MERGED":
			return `MERGED ${subj} by ${ev.actor}`;
		case "CLOSED":
			return `CLOSED ${subj} by ${ev.actor}`;
		case "OPENED":
			return `OPENED ${subj} by ${ev.actor}`;
	}
}
