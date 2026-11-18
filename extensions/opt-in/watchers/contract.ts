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
/** The contract's states, compared uppercased (scripts may send `open`, `success`, `inline`, …). */
export const STATES = [
	// PRs and issues
	"OPEN", "CLOSED", "MERGED",
	// comments
	"CONVERSATION", "INLINE",
	// reviews
	"APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING",
	// CI
	"SUCCESS", "FAILURE",
] as const;
/** An actor the script couldn't resolve (say, a commit email with no account). Never wakes. */
export const UNKNOWN_ACTOR = "unknown";
export const MAX_ERRORS = 50;

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

// C0 and C1 controls (tabs and newlines too; whitespace collapses after).
const CONTROLS = /\p{Cc}/gu;
// Everything a reader can't see but a model can: format characters (bidi
// embeddings, overrides and isolates, zero-width characters, BOM, soft hyphen),
// private-use, lone surrogates and unassigned code points, Unicode tag
// characters (ASCII smuggling), variation selectors, the combining grapheme
// joiner, interlinear annotation marks and the Hangul fillers.
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cs}\p{Cn}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u034F\uFFF9-\uFFFB\u115F\u1160\u3164\uFFA0]/gu;

/** NFKC; strip control, format, invisible and unassigned characters; collapse whitespace; cut to `max` code points. */
export function normalize(text: string, max: number): string {
	const s = text.normalize("NFKC").replace(CONTROLS, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
	const chars = Array.from(s);
	return chars.length > max ? chars.slice(0, max).join("").trimEnd() : s;
}

/**
 * The URL paths a watcher may link to: a PR or issue (optionally its files,
 * checks or commits tab), a commit, or an Actions run. Only structured tokens,
 * so a URL can't carry free text past the guardian.
 */
export const URL_PATH_RE =
	/^\/[\w.-]+\/[\w.-]+\/(?:(?:pull)\/\d{1,7}(?:\/(?:files|checks|commits))?|issues\/\d{1,7}|commit\/[0-9a-f]{7,40}|actions\/runs\/\d{1,15}(?:\/job\/\d{1,15})?)$/;
/** The only fragments kept: anchors to a comment or review. Anything else is cut off. */
export const URL_HASH_RE = /^#(?:issuecomment-\d{1,15}|discussion_r\d{1,15}|pullrequestreview-\d{1,15})$/;

/** An `owner/name` repo slug, as `repos` lists them. */
export const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/**
 * https only, host on the list, a structured path, at most URL_MAX characters.
 * No query; only a comment anchor. With `repos` set (lowercased `owner/name`),
 * the URL's slug must be on it. Anything else is dropped.
 */
export function checkUrl(url: unknown, hosts: string[], repos?: string[]): string | undefined {
	if (typeof url !== "string" || url.length > URL_MAX) return undefined;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return undefined;
	}
	if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
	if (!hosts.includes(u.hostname.toLowerCase())) return undefined;
	if (!URL_PATH_RE.test(u.pathname)) return undefined;
	if (repos && !repos.includes(u.pathname.split("/").slice(1, 3).join("/").toLowerCase())) return undefined;
	return `${u.origin}${u.pathname}${URL_HASH_RE.test(u.hash) ? u.hash : ""}`;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** One stdout line to an event, or why it was dropped. */
export function parseLine(line: string, urlHosts: string[], repos?: string[]): ParseResult {
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
		const url = checkUrl(r.url, urlHosts, repos);
		if (url) ev.url = url;
		// An off-list or non-https URL is dropped, not the event.
	}
	return { ok: true, event: ev };
}

export interface OutputResult {
	events: WatchEvent[];
	/** The first MAX_ERRORS reasons; `errorCount` has the total. */
	errors: string[];
	errorCount: number;
	/** The whole run failed (oversized or not UTF-8); nothing should be committed. */
	fatal?: string;
}

/** A run's whole stdout. Rejects oversized and non-UTF-8 output outright. */
export function parseOutput(stdout: Buffer, urlHosts: string[], repos?: string[]): OutputResult {
	if (stdout.length > MAX_STDOUT_BYTES) return { events: [], errors: [], errorCount: 0, fatal: "stdout over 1 MB" };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
	} catch {
		return { events: [], errors: [], errorCount: 0, fatal: "stdout is not UTF-8" };
	}
	const events: WatchEvent[] = [];
	const errors: string[] = [];
	let errorCount = 0;
	const fail = (e: string) => {
		errorCount++;
		if (errors.length < MAX_ERRORS) errors.push(e);
	};
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (events.length >= MAX_EVENTS) {
			fail(`more than ${MAX_EVENTS} events; the rest dropped`);
			break;
		}
		const r = parseLine(line, urlHosts, repos);
		if (r.ok) events.push(r.event);
		else fail(r.error);
	}
	return { events, errors, errorCount };
}

/** The user's own activity, and an actor the script couldn't resolve, never wake the agent. */
export function forceInfo(ev: WatchEvent, me: string): WatchEvent {
	if (ev.kind === "info") return ev;
	const actor = ev.actor.toLowerCase();
	const mine = !!me && actor === me.toLowerCase();
	return mine || actor === UNKNOWN_ACTOR ? { ...ev, kind: "info" } : ev;
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
			return `COMMENT ${subj}${state} by ${ev.actor}`;
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
