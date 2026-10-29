/**
 * notes.ts — the notes scout's pure parts: what it is asked, how its JSON is
 * read, when code lets it run, what becomes an alert, the notes file the canvas
 * reads, the status line and the recap.
 *
 * Not an extension: pi loads only top-level files and folders with an index.ts.
 * Everything here is re-exported by index.ts, so tests import it from there.
 *
 * The scout (one small model, github-copilot/claude-haiku-5.5 unless
 * meeting.model says otherwise) keeps rolling notes of the meeting: topics,
 * decisions, action items (Eric's marked), at most two questions worth asking
 * out loud, and a reply when someone is waiting on him. Code decides when it
 * runs (shouldCall) and what becomes an alert (a name said, a new action on
 * Eric); the model never decides to interrupt.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { estTokens, PROMPT_MAX_TOKENS } from "../watch/models.ts";
import { meetingId, writeAtomic } from "./capture.ts";
import { normFailed, normSlides, type SlideSummary } from "./slides.ts";

// ── the notes ────────────────────────────────────────────────────────────────

export type Topic = { title: string; summary: string };
export type Decision = { text: string; at: string };
export type Action = { who: string; what: string; mine: boolean; at: string; by?: string };
export type Ask = { q: string; why: string };
export type Reply = { to: string; text: string };
export type Notes = { topics: Topic[]; decisions: Decision[]; actions: Action[]; questions: Ask[] };

export const emptyNotes = (): Notes => ({ topics: [], decisions: [], actions: [], questions: [] });
export const hasNotes = (n: Notes) => n.topics.length + n.decisions.length + n.actions.length + n.questions.length > 0;

export const MAX_TOPICS = 8;
export const MAX_ITEMS = 20;
export const MAX_QUESTIONS = 2;

/** What one scout call says. A field the model left out is undefined: that part of the notes stays as it was. */
export type ScoutUpdate = {
	topics?: Topic[];
	decisions?: string[];
	actions?: { who: string; what: string; mine: boolean; by: string }[];
	questions?: Ask[];
	reply: Reply | null;
};

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const truthy = (v: unknown) => v === true || /^(true|yes|y|1)$/i.test(String(v ?? ""));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Lowercase letters and digits only: two phrasings of the same text compare equal. */
export const normText = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();

const ACTION_STOP = new Set("a an the to of on onto into in at for by with and or then also will would can could should please just up out from this that is be are".split(" "));

/** Crude stem: "services"/"service" -> "servic", "moving"/"move" -> "mov", "verify"/"verified" -> "verifi". */
const stemWord = (w: string) => {
	if (w.length <= 3) return w;
	let r = w;
	if (/(ing|ed)$/.test(r)) r = r.replace(/(ing|ed)$/, "");
	else if (/s$/.test(r) && !/ss$/.test(r)) r = r.slice(0, -1);
	return r.replace(/e$/, "").replace(/y$/, "i");
};

/** Verbs the scout swaps for one another between calls; each group counts as one word. */
const VERB_GROUPS = ["move migrate shift", "own take handle", "send share", "check verify confirm", "write draft", "fix resolve"].map((g) => g.split(" ").map(stemWord));
const canonical = (w: string) => {
	const i = VERB_GROUPS.findIndex((g) => g.includes(w));
	return i < 0 ? w : `~${i}`;
};

/** Content words of an action, stemmed, with verb synonyms folded together. */
const actionWords = (s: string) =>
	new Set(
		normText(s)
			.split(" ")
			.filter((w) => w && !ACTION_STOP.has(w))
			.map((w) => canonical(stemWord(w))),
	);

const numbersOf = (s: string) => new Set(normText(s).split(" ").filter((w) => /\d/.test(w)));

/**
 * Whether two action texts are the same task in different words. Conservative:
 * a duplicate alert is better than a dropped one. Identical after normText, or
 * content-word overlap (Dice) of 0.6 or more, unless the texts differ in a number
 * or identifier, or each side has a word the other lacks (outside the verb
 * synonyms: "update the staging config" is not "update the production config"),
 * or one side adds more than two words.
 */
export function sameAction(a: string, b: string): boolean {
	const x = normText(a);
	const y = normText(b);
	if (!x || !y) return false;
	if (x === y) return true;
	const na = numbersOf(a);
	const nb = numbersOf(b);
	if (na.size !== nb.size || [...na].some((n) => !nb.has(n))) return false;
	const wa = actionWords(a);
	const wb = actionWords(b);
	if (wa.size < 2 || wb.size < 2) return false;
	let both = 0;
	for (const w of wa) if (wb.has(w)) both++;
	const onlyA = wa.size - both;
	const onlyB = wb.size - both;
	if (onlyA > 0 && onlyB > 0) return false;
	if (onlyA > 2 || onlyB > 2) return false;
	return (2 * both) / (wa.size + wb.size) >= 0.6;
}

/** The scout's JSON, tolerant of code fences, prose around it and loose types; null when it isn't the notes at all. */
export function parseScoutReply(text: string): ScoutUpdate | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	if (!["topics", "decisions", "actions", "questions", "reply"].some((k) => k in obj)) return null;
	const list = (v: unknown) => (Array.isArray(v) ? v : undefined);
	const out: ScoutUpdate = { reply: null };

	const topics = list(obj.topics);
	if (topics) {
		out.topics = topics
			.map((t): Topic => {
				if (typeof t === "string") return { title: clip(t, 80), summary: "" };
				const r = rec(t);
				return { title: clip(r.title ?? r.topic, 80), summary: clip(r.summary ?? r.text, 300) };
			})
			.filter((t) => t.title || t.summary)
			.map((t) => (t.title ? t : { title: t.summary.slice(0, 60), summary: t.summary }))
			.slice(-MAX_TOPICS);
	}
	const decisions = list(obj.decisions);
	if (decisions) {
		out.decisions = decisions
			.map((d) => (typeof d === "string" ? clip(d, 300) : clip(rec(d).text ?? rec(d).decision, 300)))
			.filter(Boolean)
			.slice(-MAX_ITEMS);
	}
	const actions = list(obj.actions);
	if (actions) {
		out.actions = actions
			.map((a) => {
				if (typeof a === "string") return { who: "", what: clip(a, 300), mine: false, by: "" };
				const r = rec(a);
				return { who: clip(r.who ?? r.owner, 80), what: clip(r.what ?? r.text ?? r.task, 300), mine: truthy(r.mine), by: clip(r.by ?? r.from, 80) };
			})
			.filter((a) => a.what)
			.slice(-MAX_ITEMS);
	}
	const questions = list(obj.questions);
	if (questions) {
		out.questions = questions
			.map((q): Ask => (typeof q === "string" ? { q: clip(q, 300), why: "" } : { q: clip(rec(q).q ?? rec(q).question, 300), why: clip(rec(q).why, 200) }))
			.filter((q) => q.q)
			.slice(0, MAX_QUESTIONS);
	}
	const reply = obj.reply;
	if (typeof reply === "string") out.reply = clip(reply, 500) ? { to: "", text: clip(reply, 500) } : null;
	else if (reply && typeof reply === "object") {
		const r = rec(reply);
		const t = clip(r.text ?? r.reply, 500);
		out.reply = t ? { to: clip(r.to, 80), text: t } : null;
	}
	return out;
}

/**
 * Fold a scout update into the notes. Items the scout repeats keep the time
 * they were first noted; `newMine` is the actions on Eric that weren't on him in the
 * previous notes (same text or, by sameAction, the same task reworded).
 */
export function mergeNotes(prev: Notes, u: ScoutUpdate, at: string): { notes: Notes; newMine: Action[] } {
	const decisions = u.decisions
		? [...new Map(u.decisions.map((text) => [normText(text), text])).entries()]
				.filter(([k]) => k)
				.map(([k, text]): Decision => ({ text, at: prev.decisions.find((d) => normText(d.text) === k)?.at ?? at }))
		: prev.decisions;
	// Only actions already on Eric count as known: a task that moves to him from someone else is new to him.
	const known = prev.actions.filter((a) => a.mine);
	const seen = new Set<string>();
	const newMine: Action[] = [];
	const actions = u.actions
		? u.actions.flatMap((a): Action[] => {
				const k = normText(a.what);
				if (!k || seen.has(k)) return [];
				seen.add(k);
				const old = prev.actions.find((x) => normText(x.what) === k) ?? prev.actions.find((x) => sameAction(x.what, a.what));
				const next: Action = { who: a.who, what: a.what, mine: a.mine, at: old?.at ?? at, ...(a.by ? { by: a.by } : {}) };
				if (next.mine && !known.some((x) => sameAction(x.what, a.what))) newMine.push(next);
				return [next];
			})
		: prev.actions;
	return { notes: { topics: u.topics ?? prev.topics, decisions, actions, questions: u.questions ?? prev.questions }, newMine };
}

// ── what the scout is asked ──────────────────────────────────────────────────

export function buildSystemPrompt(me: string, meTokens: string[], about: string, background: string): string {
	const who = me || "the user";
	return [
		`You are a live meeting copilot for ${who}. You read the running caption transcript of a meeting ${who} is in and keep rolling notes for ${who}: what has been discussed, what was decided, who took which action, and, only when it is really worth it, a question or a reply. ${who} glances at the notes mid-call and reads them after, so every line must be accurate and short.`,
		meTokens.length ? `\n${who} may be called ${meTokens.join(" or ")}. Speech recognition often garbles names; read through it.` : "",
		"",
		"The notes:",
		`- "topics": what has been discussed, newest last, at most ${MAX_TOPICS}. Each is a short title and one sentence. Keep the earlier titles; fold new talk into the topic it belongs to.`,
		'- "decisions": things the group agreed, one line each.',
		`- "actions": tasks someone took or was given: "who" does "what". "mine" is true only when the task is assigned to or taken by ${who}. "by" is who asked, when somebody other than the owner did; else "".`,
		`- "questions": AT MOST ${MAX_QUESTIONS}, and usually none. Empty is the normal answer. Add one only when it is worth interrupting the meeting for: it pins down something left vague that matters (an owner, a date, a dependency, a risk, a decision nobody made) AND it is grounded in what ${who} is working on (the session digest, the about text, the slides). Never generic ("any blockers?", "what are the next steps?"), never something already asked or answered, never small talk. Short (under 25 words), plain, in ${who}'s voice. "why" is a fragment of at most 10 words.`,
		`- "reply": only when someone is waiting on ${who} right now: they asked ${who} directly (by name, or in a way only ${who} can answer) and ${who} has not answered. Then {"to": who is waiting, "text": what ${who} could say}: one or two plain sentences in ${who}'s voice, grounded in the transcript and background; if the facts aren't there, a short honest "I'll check and get back to you". Otherwise null.`,
		"",
		"You get the previous notes. Update them instead of rewriting: keep what still stands, correct what changed, drop nothing that is still true. Return the full updated notes every time.",
		'The transcript is automatic speech recognition: names and terms are often misheard, and "Unknown user" is an unidentified speaker. Never quote a garble.',
		"",
		'Reply with JSON only, no prose and no code fence: {"topics": [{"title": "...", "summary": "..."}], "decisions": ["..."], "actions": [{"who": "...", "what": "...", "mine": false, "by": ""}], "questions": [{"q": "...", "why": "..."}], "reply": null}',
		about ? `\n<about>\n${about.trim()}\n</about>` : "",
		background ? `\n<background>\n${background.trim()}\n</background>` : "",
	]
		.filter((l, i, a) => !(l === "" && a[i - 1] === ""))
		.join("\n");
}

const TOKEN_PREFIX = new RegExp(
	[
		String.raw`(?:sk|pk|rk)[-_][A-Za-z0-9_-]{10,}`,
		String.raw`gh[pousr]_[A-Za-z0-9]{10,}`,
		String.raw`github_pat_[A-Za-z0-9_]{10,}`,
		String.raw`glpat-[A-Za-z0-9_-]{10,}`,
		String.raw`xox[abeprs]-[A-Za-z0-9-]{10,}`,
		String.raw`npm_[A-Za-z0-9]{10,}`,
		String.raw`hf_[A-Za-z0-9]{10,}`,
		String.raw`ya29\.[A-Za-z0-9._-]{10,}`,
		String.raw`AIza[A-Za-z0-9_-]{30,}`,
		String.raw`(?:AKIA|ASIA)[A-Z0-9]{16}`,
	]
		.map((p) => `\\b${p}`)
		.join("|"),
	"g",
);
const LONG_TOKEN = /[A-Za-z0-9_+=-]{24,}/g;

/** A 24+ character run that looks random: letters and digits, mixed-case. Words, paths, kebab-case names and hex commit SHAs (40 chars) pass; longer hex runs are masked. */
const looksRandom = (t: string) => /\d/.test(t) && /[A-Za-z]/.test(t) && !/^[0-9a-f]{40}$/i.test(t) && ((/[A-Z]/.test(t) && /[a-z]/.test(t)) || /^[0-9a-f]{32,}$/i.test(t));

/** A Bearer/Basic value that is token-shaped: has a digit or base64 punctuation, so "Basic authentication" survives. */
const tokenShaped = (v: string) => /\d|[=+/]/.test(v);

/**
 * Credentials that must not leave in a prompt, whatever the model: well-known
 * token prefixes, "Bearer …" values, credentials inside URLs, private key blocks
 * and long random-looking strings.
 */
export function maskSecrets(s: string): string {
	return s
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[key]")
		.replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi, (m, k: string, sp: string, v: string) => (tokenShaped(v) ? `${k}${sp}[token]` : m))
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(TOKEN_PREFIX, "[token]")
		.replace(LONG_TOKEN, (t) => (looksRandom(t) ? "[token]" : t));
}

export type SessionDigest = { name: string; user: string[]; assistant: string };

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (rec(c).type === "text" && typeof rec(c).text === "string" ? (rec(c).text as string) : "")).join("\n");
};
const trimTo = (s: string, n: number) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const DIGEST_USER = 5;
export const DIGEST_USER_CHARS = 300;
export const DIGEST_ASSISTANT_CHARS = 600;

/**
 * What this pi session is about right now: the last few user messages and the last
 * assistant message on its branch. This goes to whatever model is configured, so
 * it is masked first (maskSecrets, then `redact`: the work.redact rules), before
 * it is clipped, so a cut can't leave half a token.
 */
export function sessionDigest(entries: readonly unknown[], name: string, redact: (s: string) => string = (t) => t): SessionDigest {
	const user: string[] = [];
	let assistant = "";
	for (const e of entries) {
		const m = rec(rec(e).message);
		if (rec(e).type !== "message") continue;
		const text = trimTo(redact(maskSecrets(textOf(m.content))), m.role === "user" ? DIGEST_USER_CHARS : DIGEST_ASSISTANT_CHARS);
		if (!text) continue;
		if (m.role === "user") user.push(text);
		else if (m.role === "assistant") assistant = text;
	}
	return { name: trimTo(redact(maskSecrets(name)), 120), user: user.slice(-DIGEST_USER), assistant };
}

export function formatDigest(d: SessionDigest | undefined): string {
	if (!d || (!d.name && !d.user.length && !d.assistant)) return "";
	return [
		"<session>",
		`What the user is working on right now, from their pi session${d.name ? ` "${d.name}"` : ""}:`,
		...(d.user.length ? ["Their last messages:", ...d.user.map((u) => `- ${u}`)] : []),
		...(d.assistant ? ["The assistant's last message:", d.assistant] : []),
		"</session>",
	].join("\n");
}

export type SlideText = { n: number; at: string; text: string; onScreen: boolean; summary?: { title: string; what: string; why: string } };
export const SLIDE_OCR_CHARS = 4000;

/** A slide's summary as the scout reads it: title, what it shows, and why it matters to you when there is a reason. */
const summaryText = (s: { title: string; what: string; why: string }) => [s.title, s.what].filter(Boolean).join(": ") + (s.why ? ` Why it matters: ${s.why}` : "");

/**
 * The slides shown so far, newest first, under `cap` characters in all: a
 * slide's summary (title, what, why) where it has one, else its raw OCR text.
 */
export function formatSlides(slides: readonly SlideText[], cap = SLIDE_OCR_CHARS): string {
	const out: string[] = [];
	let left = cap;
	for (const s of [...slides].reverse()) {
		const text = (s.summary ? summaryText(s.summary) : s.text).trim();
		if (!text || left <= 0) continue;
		const head = `Slide ${s.n}${s.at ? ` (${s.at})` : ""}${s.onScreen ? ", on screen now" : ""}${s.summary ? " (summary)" : ""}:`;
		const body = text.length > left ? `${text.slice(0, left)}\n[… cut]` : text;
		out.push(`${head}\n${body}`);
		left -= text.length;
	}
	return out.length ? ["<slides>", "What the slides shown so far say:", ...out, "</slides>"].join("\n") : "";
}

export type NotesInput = {
	title: string;
	app: string;
	people: string[];
	lines: string[];
	newFrom: number; // index of the first line the scout hasn't seen
	focus: string;
	me: string;
	now: Date;
	digest?: SessionDigest;
	slides?: SlideText[];
	prev: Notes;
	maxChars?: number; // transcript budget; MAX_TRANSCRIPT_CHARS when unset
};

export const MAX_TRANSCRIPT_CHARS = 100_000;
export const NEW_MARK = "── new since your last update ──";

/** The previous notes as the scout sees them (compact JSON). */
export function prevNotesJson(n: Notes): string {
	return JSON.stringify({
		topics: n.topics,
		decisions: n.decisions.map((d) => d.text),
		actions: n.actions.map(({ who, what, mine, by }) => ({ who, what, mine, by: by ?? "" })),
		questions: n.questions,
	});
}

export function buildNotesPrompt(p: NotesInput): string {
	const lines = p.lines.slice();
	if (p.newFrom > 0 && p.newFrom < lines.length) lines.splice(p.newFrom, 0, NEW_MARK);
	let body = lines.join("\n");
	const max = Math.max(0, p.maxChars ?? MAX_TRANSCRIPT_CHARS);
	// The oldest lines go first: the new ones are what the scout is for.
	if (body.length > max) {
		const cut = body.indexOf("\n", body.length - max);
		body = `[… earlier lines omitted …]${cut < 0 ? "" : `\n${body.slice(cut + 1)}`}`;
	}
	const who = p.me || "the user";
	return [
		`Meeting: ${p.title}${p.app ? ` (${p.app})` : ""}`,
		p.people.length ? `People: ${p.people.join("; ")}` : "",
		p.focus ? `${who}'s goals for this meeting: ${p.focus}` : "",
		`Now: ${p.now.toTimeString().slice(0, 8)}`,
		"",
		formatDigest(p.digest),
		formatSlides(p.slides ?? []),
		"<previous_notes>",
		hasNotes(p.prev) ? prevNotesJson(p.prev) : "(none yet: this is your first look)",
		"</previous_notes>",
		"",
		"<transcript>",
		body || "(nothing yet)",
		"</transcript>",
		"",
		p.newFrom > 0 ? `The lines after "${NEW_MARK}" are new since your last update. Update the notes.` : hasNotes(p.prev) ? "Update the notes with anything in the transcript they don't have yet." : "Write the first notes.",
	]
		.filter((l, i, a) => !(l === "" && (a[i - 1] === "" || i === 0)))
		.join("\n");
}

/** The user prompt, keeping less of the transcript's start until system + user fit under the cap. */
export function fitNotesPrompt(system: string, p: NotesInput, cap = PROMPT_MAX_TOKENS): string {
	let maxChars = Math.min(p.maxChars ?? MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_CHARS);
	let user = buildNotesPrompt({ ...p, maxChars });
	for (let i = 0; i < 8 && maxChars > 0; i++) {
		const over = estTokens(system) + estTokens(user) - cap;
		if (over <= 0) break;
		maxChars = Math.max(0, maxChars - over * 3 - 500);
		user = buildNotesPrompt({ ...p, maxChars });
	}
	return user;
}

// ── when code lets the scout run ─────────────────────────────────────────────

export const CADENCE = { talkMs: 3 * 60_000, minGapMs: 60_000, quietMs: 2500, earlyMaxWaitMs: 15_000 };
export type CadenceCfg = typeof CADENCE;
export const RETRY_MAX_MS = 5 * 60_000;

/** The wait after `streak` failed calls in a row: the 60 s floor doubled each time, up to five minutes (both shrink with a replay's speed). */
export const retryWait = (streak: number, cfg: CadenceCfg = CADENCE, speed = 1): number =>
	Math.min(cfg.minGapMs * 2 ** Math.max(0, streak - 1), speed > 1 ? Math.max(20, RETRY_MAX_MS / speed) : RETRY_MAX_MS);

export type Cadence = {
	unsent: number; // lines since the last call
	firstUnsentAt: number; // arrival of the oldest line not yet sent (ms; 0 for history)
	lastLineAt: number; // arrival of the newest line (ms)
	lastCallAt: number; // start of the last call (ms)
	early: boolean; // a new slide or a name alert wants a call sooner
	earlyAt: number; // when it asked
	retryMs: number; // the last call failed: wait at least this long (grows with each failure)
};

export const freshCadence = (): Cadence => ({ unsent: 0, firstUnsentAt: 0, lastLineAt: 0, lastCallAt: 0, early: false, earlyAt: 0, retryMs: 0 });

/** The cadence in a replay playing at `speed`×: every wait shrinks with it. */
export const scaleCadence = (speed: number, cfg = CADENCE): CadenceCfg =>
	speed <= 1 ? cfg : (Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, Math.max(20, v / speed)])) as CadenceCfg);

/**
 * Whether to spend a model call now. Pure, so the cadence is testable. Never
 * while one is in flight. `final` (the meeting is over): one look at whatever is
 * left, no waiting. Otherwise: about three minutes of new talk, or sooner after
 * a new slide or a name alert once the sentence has landed, and never twice
 * within a minute.
 */
export function shouldCall(t: Cadence, now: number, o: { final?: boolean; busy?: boolean } = {}, cfg: CadenceCfg = CADENCE): "final" | "early" | "talk" | null {
	if (o.busy || t.unsent === 0) return null;
	if (o.final) return "final";
	if (now - t.lastCallAt < Math.max(cfg.minGapMs, t.retryMs)) return null;
	if (t.early && (now - t.lastLineAt >= cfg.quietMs || now - t.earlyAt >= cfg.earlyMaxWaitMs)) return "early";
	if (now - t.firstUnsentAt >= cfg.talkMs) return "talk";
	return null;
}

// ── alerts ───────────────────────────────────────────────────────────────────

export type Alert = { id: string; kind: "name" | "action"; who: string; text: string; at: string };
export const ALERTS_KEPT = 20;
export const NAME_ALERT_GAP_MS = 2 * 60_000;

export const pushAlert = (alerts: readonly Alert[], a: Alert): Alert[] => [...alerts, a].slice(-ALERTS_KEPT);

/**
 * One name alert per speaker per two minutes: true (and noted) when this one is
 * due, false for a repeat. `at` is the line's own time, so a replay keeps the rule.
 */
export function takeNameAlert(last: Map<string, number>, speaker: string, at: number, gap = NAME_ALERT_GAP_MS): boolean {
	const key = normText(speaker) || "unknown";
	const prev = last.get(key);
	if (prev !== undefined && Math.abs(at - prev) < gap) return false;
	last.set(key, at);
	return true;
}

const quote = (s: string, n: number) => {
	const t = s.replace(/\s+/g, " ").trim();
	return `"${t.length > n ? `${t.slice(0, n - 1)}…` : t}"`;
};
const hhmm = (c: string) => c.slice(0, 5);

const saying = (r: Reply) => `↳ You could say: ${quote(r.text, 300)}`;

/** `🔔 Ada said your name (14:12): "Eric, can you own…"`, and the reply when the scout already has one. */
export function nameAlertText(speaker: string, clockStr: string, text: string, reply?: Reply | null): string {
	const head = `🔔 ${speaker || "Someone"} said your name${clockStr ? ` (${hhmm(clockStr)})` : ""}: ${quote(text, 140)}`;
	return reply ? `${head}\n${saying(reply)}` : head;
}

/** `✅ Action on you: own moving the services (Ada, 14:12)`. */
export function actionAlertText(what: string, by: string, clockStr: string, reply?: Reply | null): string {
	const tail = [by, clockStr ? hhmm(clockStr) : ""].filter(Boolean).join(", ");
	const head = `✅ Action on you: ${what.replace(/\s+/g, " ").trim()}${tail ? ` (${tail})` : ""}`;
	return reply ? `${head}\n${saying(reply)}` : head;
}

/** A reply that arrives on its own: `↳ Katherine is waiting on you. You could say: "…"`. */
export const replyText = (r: Reply): string => `↳ ${r.to || "Someone"} is waiting on you. You could say: ${quote(r.text, 300)}`;

export type SentReply = { key: string; to: string; at: number };
export const REPLY_GAP_MS = 2 * 60_000;

/** Once per reply: not the same words again, and not another from the same person within two minutes. */
export function replyDue(sent: readonly SentReply[], r: Reply, now: number): boolean {
	const key = normText(r.text);
	if (!key) return false;
	const to = normText(r.to);
	return !sent.some((s) => s.key === key || (!!to && s.to === to && now - s.at < REPLY_GAP_MS));
}

// ── the notes file the canvas reads ──────────────────────────────────────────

export const notesPath = () =>
	process.env.PI_MEETING_NOTES_FILE || path.join(process.env.PI_CANVAS_ROOT || path.join(os.homedir(), ".pi", "canvas"), ".meeting-notes.json");

export type NotesFile = {
	v: 1;
	pid: number;
	session: { id: string; name: string };
	meeting: { started_at: string; app_id: string; title: string };
	at: string;
	ended: boolean;
	me: string[];
	topics: Topic[];
	decisions: Decision[];
	actions: { who: string; what: string; mine: boolean; at: string }[];
	questions: Ask[];
	reply: { to: string; text: string; at: string } | null;
	alerts: Alert[];
	alertSeq: number; // the last alert id's number: ids keep counting after a reload
	slides: SlideSummary[]; // slide summaries, sorted by n (see slides.ts)
	slidesOn: boolean; // slide summaries are running for this meeting (setting on, a model that reads images)
	slidesFailed: number[]; // slides that will not get one: given up on, or past the cap
};

export function buildNotesFile(i: {
	pid: number;
	sessionId: string;
	sessionName: string;
	startedAt: string;
	appId: string;
	title: string;
	at: string;
	ended: boolean;
	me: string[];
	notes: Notes;
	reply: { to: string; text: string; at: string } | null;
	alerts: readonly Alert[];
	alertSeq: number;
	slides?: readonly SlideSummary[];
	slidesOn?: boolean;
	slidesFailed?: Iterable<number>;
}): NotesFile {
	return {
		v: 1,
		pid: i.pid,
		session: { id: i.sessionId, name: i.sessionName },
		meeting: { started_at: i.startedAt, app_id: i.appId, title: i.title },
		at: i.at,
		ended: i.ended,
		me: i.me,
		topics: i.notes.topics,
		decisions: i.notes.decisions,
		actions: i.notes.actions.map(({ who, what, mine, at }) => ({ who, what, mine, at })),
		questions: i.notes.questions,
		reply: i.reply,
		alerts: i.alerts.slice(-ALERTS_KEPT),
		alertSeq: i.alertSeq,
		slides: normSlides(i.slides ?? []),
		slidesOn: i.slidesOn === true,
		slidesFailed: normFailed(i.slidesFailed ? [...i.slidesFailed] : []),
	};
}

/** Atomic, mode 600. */
export function writeNotesFile(f: NotesFile): void {
	writeAtomic(notesPath(), `${JSON.stringify(f)}\n`);
}

/**
 * Where finished meetings' notes are kept, one <meeting id>.json each:
 * PI_MEETING_NOTES_DIR, else meetings/ in the canvas root. Never removed.
 */
export const archiveDir = () => process.env.PI_MEETING_NOTES_DIR || path.join(process.env.PI_CANVAS_ROOT || path.join(os.homedir(), ".pi", "canvas"), "meetings");

/**
 * The same notes as writeNotesFile, kept for good as <archive>/<id>.json (id = meetingId of app_id and
 * started_at): atomic, file mode 600, folder mode 700. The canvas's /meetings history reads these;
 * the live .meeting-notes.json can be dropped when pi quits, this never is. Skipped without a start time.
 */
export function writeNotesArchive(f: NotesFile): void {
	if (!f.meeting.started_at) return;
	const dir = archiveDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		fs.mkdirSync(dir, { mode: 0o700 });
	} else {
		try {
			fs.chmodSync(dir, 0o700); // a folder made earlier (or by hand) is tightened too
		} catch {}
	}
	writeAtomic(path.join(dir, `${meetingId(f.meeting.app_id, f.meeting.started_at)}.json`), `${JSON.stringify(f)}\n`);
}

/** What a new instance takes back from the notes file of the meeting it is joining. */
export type Restored = { notes: Notes; reply: { to: string; text: string; at: string } | null; alerts: Alert[]; alertSeq: number; alerted: Set<string>; slides: SlideSummary[]; failed: number[] };

const isoAt = (v: unknown) => clip(v, 40);

/**
 * The notes a previous instance wrote for this same meeting (started_at matches),
 * or null (then the archived notes for this meeting, when appId is given). After a /reload, /resume or /fork the scout would otherwise start from
 * nothing and alert again for every action already on you. The file is ours to
 * trust only as far as its shape: every field is clipped and bounded.
 */
export function restoreNotes(startedAt: string, file = notesPath(), appId?: string): Restored | null {
	const live = restoreFrom(startedAt, file);
	if (live || appId === undefined || !startedAt) return live;
	// The live file is gone (`/meeting watch off`, a restart): the archive still has this meeting's notes, so the next archive write doesn't replace them with empty ones.
	return restoreFrom(startedAt, path.join(archiveDir(), `${meetingId(appId, startedAt)}.json`));
}

function restoreFrom(startedAt: string, file: string): Restored | null {
	let raw: Record<string, unknown>;
	try {
		raw = rec(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return null;
	}
	if (raw.v !== 1 || !startedAt || rec(raw.meeting).started_at !== startedAt) return null;
	const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
	const notes: Notes = {
		topics: arr(raw.topics)
			.map((t): Topic => ({ title: clip(rec(t).title, 80), summary: clip(rec(t).summary, 300) }))
			.filter((t) => t.title || t.summary)
			.slice(-MAX_TOPICS),
		decisions: arr(raw.decisions)
			.map((d): Decision => ({ text: clip(rec(d).text, 300), at: isoAt(rec(d).at) }))
			.filter((d) => d.text)
			.slice(-MAX_ITEMS),
		actions: arr(raw.actions)
			.map((a): Action => ({ who: clip(rec(a).who, 80), what: clip(rec(a).what, 300), mine: rec(a).mine === true, at: isoAt(rec(a).at) }))
			.filter((a) => a.what)
			.slice(-MAX_ITEMS),
		questions: arr(raw.questions)
			.map((q): Ask => ({ q: clip(rec(q).q, 300), why: clip(rec(q).why, 200) }))
			.filter((q) => q.q)
			.slice(0, MAX_QUESTIONS),
	};
	const alerts = arr(raw.alerts)
		.map((a): Alert => ({ id: clip(rec(a).id, 20), kind: rec(a).kind === "name" ? "name" : "action", who: clip(rec(a).who, 80), text: clip(rec(a).text, 300), at: isoAt(rec(a).at) }))
		.filter((a) => a.id && a.text)
		.slice(-ALERTS_KEPT);
	const r = rec(raw.reply);
	const reply = clip(r.text, 500) ? { to: clip(r.to, 80), text: clip(r.text, 500), at: isoAt(r.at) } : null;
	const seqOf = (id: string) => Number(/^a(\d+)$/.exec(id)?.[1] ?? 0);
	const alertSeq = Math.max(Number.isInteger(raw.alertSeq) ? (raw.alertSeq as number) : 0, ...alerts.map((a) => seqOf(a.id)));
	// Already told about: every action on you in the notes, and every action alert still in the file.
	const alerted = new Set([...notes.actions.filter((a) => a.mine).map((a) => normText(a.what)), ...alerts.filter((a) => a.kind === "action").map((a) => normText(a.text))]);
	return { notes, reply, alerts, alertSeq, alerted, slides: normSlides(raw.slides), failed: normFailed(raw.slidesFailed) };
}

/** The slide summaries archived for a meeting (<archive>/<id>.json); [] when there is no archive or it can't be read. */
export function readArchivedSlides(appId: string, startedAt: string): SlideSummary[] {
	if (!startedAt) return [];
	try {
		return normSlides(rec(JSON.parse(fs.readFileSync(path.join(archiveDir(), `${meetingId(appId, startedAt)}.json`), "utf8"))).slides);
	} catch {
		return [];
	}
}

/** Delete the file if this session wrote it (another session's notes stay). */
export function removeNotesFile(me: { pid: number; sessionId: string }): void {
	try {
		const cur = JSON.parse(fs.readFileSync(notesPath(), "utf8")) as Partial<NotesFile>;
		if (cur.pid !== me.pid || cur.session?.id !== me.sessionId) return;
		fs.rmSync(notesPath(), { force: true });
	} catch {
		// no file, or not ours to read
	}
}

// ── the status line ──────────────────────────────────────────────────────────

export type WidgetView = {
	phase: "waiting" | "live" | "ended";
	title: string;
	startedMs: number;
	slide?: number; // the slide on screen
	alerts: number;
	questions: number;
	hasLines: boolean;
	busy: boolean;
	error: string;
	replay: boolean;
	rulesOnly?: boolean; // no notes model: name alerts only
};

export function humanElapsed(ms: number): string {
	const m = Math.max(0, Math.floor(ms / 60_000));
	return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line above the prompt: `● Weekly Sync · 16m · slide 4 · 2 alerts · 1 question`. Zero parts are left out. */
export function widgetLines(v: WidgetView, theme: Pick<Theme, "fg">, width: number, now = Date.now()): string[] {
	const fg = theme.fg.bind(theme) as (c: string, s: string) => string;
	const dim = (s: string) => fg("dim", s);
	const title = `${v.title || "meeting"}${v.replay ? " (replay)" : ""}`;
	if (v.phase === "waiting") return [truncateToWidth(`${dim("◌")} ${dim([title, "waiting for captions"].join(" · "))}`, width)];
	const icon = v.error ? fg("warning", "✕") : v.busy ? fg("accent", "◐") : fg("accent", "●");
	const counts = [
		v.slide !== undefined ? `slide ${v.slide}` : "",
		v.alerts ? plural(v.alerts, "alert") : "",
		v.questions ? plural(v.questions, "question") : "",
	].filter(Boolean);
	const bits = [
		title,
		v.startedMs ? humanElapsed(now - v.startedMs) : "",
		v.phase === "ended" ? (v.replay ? "replay done" : "call ended") : "",
		...(v.hasLines || v.phase === "ended" ? counts : ["waiting for captions"]),
		v.rulesOnly ? "name alerts only" : "",
		v.busy ? "updating notes…" : "",
		v.error ? `error: ${v.error}` : "",
	].filter(Boolean);
	return [truncateToWidth(`${icon} ${dim(bits.join(" · "))}`, width)];
}

// ── the recap ────────────────────────────────────────────────────────────────

export const RECAP_SLIDES = 8; // slides listed in the recap: only those with a reason they matter

const paren = (bits: (string | undefined)[]) => {
	const s = bits.filter(Boolean).join("; ");
	return s ? ` (${s})` : "";
};

/** The notes as plain markdown that reads the same in a terminal and in Obsidian: Topics, Decisions, Action items (yours first, starred), Open questions. */
export function recapBody(n: Notes, reply?: Reply | null, slides: readonly SlideSummary[] = []): string[] {
	const slideLines = slides.filter((s) => s.why).slice(0, RECAP_SLIDES).map((s) => `${s.n}. ${s.title || s.what} — ${s.why}`);
	if (!hasNotes(n) && !reply && !slideLines.length) return ["No notes were taken."];
	const section = (label: string, items: string[]) => (items.length ? [label, ...items, ""] : []);
	const who = (a: Action) => `${a.who ? `${a.who}: ` : ""}${a.what}${a.by ? ` (from ${a.by})` : ""}`;
	const out = [
		...section("Topics:", n.topics.map((t) => `- ${t.title}${t.summary ? `: ${t.summary}` : ""}`)),
		...section("Decisions:", n.decisions.map((d) => `- ${d.text}`)),
		...section("Action items:", [...n.actions.filter((a) => a.mine), ...n.actions.filter((a) => !a.mine)].map((a) => `- ${a.mine ? "★ " : ""}${who(a)}`)),
		...section("Open questions:", n.questions.map((q) => `- ${q.q}${paren([q.why])}`)),
		...section("Slides:", slideLines),
		...(reply ? [`Suggested reply${reply.to ? ` to ${reply.to}` : ""}: ${reply.text}`, ""] : []),
	];
	while (out.at(-1) === "") out.pop();
	return out;
}

/** Hidden marker that ties a daily-note block to its capture, so a rewrite replaces it. */
export const recapMarker = (file: string) => `<!-- meeting-copilot:${path.basename(file).replace(/\.(jsonl|txt)$/, "")} -->`;

export type RecapInput = { title: string; file: string; from: string; to: string; updates: number; notes: Notes; slides?: readonly SlideSummary[] };

export function recapBlock(r: RecapInput): string {
	const span = [r.from, r.to].filter(Boolean).join("–");
	return [
		`### ${span ? `${span} ` : ""}${r.title} · copilot notes`,
		recapMarker(r.file),
		`Transcript: \`${r.file.replace(/\.jsonl$/, ".txt").replace(os.homedir(), "~")}\` · ${plural(r.updates, "notes update")}`,
		"",
		...recapBody(r.notes, null, r.slides),
	].join("\n");
}
