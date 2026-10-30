/**
 * slides.ts — slide summaries, the pure parts: what the vision model is asked,
 * how its JSON is read, the OCR wait, and the queue that decides which slide is
 * summarized next.
 *
 * Not an extension: pi loads only top-level files and folders with an index.ts.
 * Everything here is re-exported by notes.ts (and so by index.ts), so tests
 * import it from there. This file imports nothing from the rest of the meeting
 * extension, so notes.ts can use it without a cycle.
 *
 * Each new slide meeting-capture saves is read by the notes model (meeting.model,
 * default github-copilot/claude-haiku-5.5) when it can see images: the image, the
 * OCR text beside it, who you are, what you are working on, and the talk around
 * the moment it came up. It answers with a title, what the slide shows, why it
 * matters to you (usually "": nothing is invented), key points and numbers.
 * Code decides when it runs (SlideWork): newest slide first, one call at a time,
 * at most one per 10 s, 80 slides a meeting, three tries per slide.
 */

// ── the summary ──────────────────────────────────────────────────────────────

export type SlideSummary = { n: number; title: string; what: string; why: string; points: string[]; numbers: string[]; at: string };

/** What the model says about one slide (no number or time: the caller knows those). */
export type SlideReply = Pick<SlideSummary, "title" | "what" | "why" | "points" | "numbers">;

export const MAX_SLIDE_SUMMARIES = 120; // kept in the notes file and the archive
export const SLIDE_CAP = 80; // slides summarized per meeting
export const SLIDE_POINTS = 4;
export const SLIDE_NUMBERS = 4;
export const SLIDE_OCR_MAX = 3000;
export const SLIDE_NEARBY_MS = 90_000;
export const SLIDE_TRIES = 3;
export const SLIDE_GAP_MS = 10_000;
export const OCR_WAIT_MS = 90_000;

/** Collapse whitespace and cap at n chars; a cut lands on a word boundary and ends in "…", never mid-word. */
export const clip = (v: unknown, n: number): string => {
	if (typeof v !== "string") return "";
	const s = v.replace(/\s+/g, " ").trim();
	if (s.length <= n) return s;
	const cut = s.slice(0, n - 1);
	const sp = cut.lastIndexOf(" ");
	return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
};
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const strings = (v: unknown, max: number, n: number): string[] => {
	const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
	return list
		.map((x) => clip(typeof x === "number" ? String(x) : x, n))
		.filter(Boolean)
		.slice(0, max);
};

/** The model's JSON, tolerant of fences, prose and loose types; null when there is no title or description at all. */
export function parseSlideReply(text: string): SlideReply | null {
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
	const what = clip(obj.what ?? obj.summary ?? obj.description, 500);
	const title = clip(obj.title, 80) || what.slice(0, 60);
	if (!title && !what) return null;
	return {
		title,
		what,
		why: clip(obj.why, 300),
		points: strings(obj.points, SLIDE_POINTS, 200),
		numbers: strings(obj.numbers, SLIDE_NUMBERS, 100),
	};
}

/**
 * Summaries read back from a notes file (or archive): bounded, one per slide
 * number (the last wins), sorted by n, at most MAX_SLIDE_SUMMARIES (the newest).
 * `n` must be an integer of 1 or more.
 */
export function normSlides(raw: unknown): SlideSummary[] {
	if (!Array.isArray(raw)) return [];
	const byN = new Map<number, SlideSummary>();
	for (const s of raw) {
		const r = rec(s);
		if (typeof r.n !== "number" || !Number.isInteger(r.n) || r.n < 1) continue;
		const title = clip(r.title, 80);
		const what = clip(r.what, 500);
		if (!title && !what) continue;
		byN.set(r.n, { n: r.n, title, what, why: clip(r.why, 300), points: strings(r.points, SLIDE_POINTS, 200), numbers: strings(r.numbers, SLIDE_NUMBERS, 100), at: clip(r.at, 40) });
	}
	return [...byN.values()].sort((a, b) => a.n - b.n).slice(-MAX_SLIDE_SUMMARIES);
}

/** A summary added (or replaced) in an n-sorted list, newest MAX_SLIDE_SUMMARIES kept. */
export function withSummary(list: readonly SlideSummary[], s: SlideSummary): SlideSummary[] {
	return [...list.filter((x) => x.n !== s.n), s].sort((a, b) => a.n - b.n).slice(-MAX_SLIDE_SUMMARIES);
}

/** The summary's lines for the meeting tool: title, what, why (when there is one), points, numbers. */
export function formatSlideSummary(s: SlideSummary): string[] {
	return [
		`Summary: ${s.title || "(no title)"}`,
		...(s.what ? [`What it shows: ${s.what}`] : []),
		...(s.why ? [`Why it matters to you: ${s.why}`] : []),
		...(s.points.length ? ["Key points:", ...s.points.map((p) => `- ${p}`)] : []),
		...(s.numbers.length ? ["Numbers:", ...s.numbers.map((p) => `- ${p}`)] : []),
	];
}

/** Whether every word of `query` is somewhere in the summary (title, what, why, points, numbers), case-insensitive. */
export function summaryMatches(s: SlideSummary, query: string): boolean {
	const need = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hay = [s.title, s.what, s.why, ...s.points, ...s.numbers].join("\n").toLowerCase();
	return need.every((w) => hay.includes(w));
}

// ── OCR ──────────────────────────────────────────────────────────────────────

/**
 * The OCR text as the model sees it: a leading "Shared content | …" line (the
 * Teams window title) dropped, trimmed, at most `max` characters.
 */
export function cleanOcr(text: string, max = SLIDE_OCR_MAX): string {
	const lines = text.replace(/\r/g, "").split("\n");
	const first = lines.findIndex((l) => l.trim());
	if (first >= 0 && /^\s*Shared content\s*\|/i.test(lines[first] as string)) lines.splice(first, 1);
	const t = lines.join("\n").trim();
	return t.length > max ? `${t.slice(0, max)}\n[… cut]` : t;
}

export type OcrWait = { text: string; state: "ready" | "empty" | "timeout" | "aborted" };

/**
 * Wait for meeting-capture's OCR file. `read` gives null while the file is
 * missing ("not yet"), "" for a 0 byte file ("no text on the slide"), else the
 * text. Polls every `pollMs` up to `timeoutMs`, then goes on without it.
 * A file holding only the window title counts as empty.
 */
export async function waitForOcr(
	read: () => Promise<string | null>,
	o: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number; noWait?: boolean | (() => boolean) } = {},
): Promise<OcrWait> {
	const timeoutMs = o.timeoutMs ?? OCR_WAIT_MS;
	const pollMs = Math.max(1, o.pollMs ?? 1000);
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = o.now ?? Date.now;
	const t0 = now();
	for (;;) {
		if (o.signal?.aborted) return { text: "", state: "aborted" };
		const raw = await read();
		if (raw !== null) {
			const text = cleanOcr(raw);
			return text ? { text, state: "ready" } : { text: "", state: "empty" };
		}
		if ((typeof o.noWait === "function" ? o.noWait() : o.noWait) || now() - t0 >= timeoutMs) return { text: "", state: "timeout" };
		await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (now() - t0))));
	}
}

// ── the talk around a slide ──────────────────────────────────────────────────

export const NEARBY_LINES = 30;
export const NEARBY_CHARS = 3500;

/**
 * Transcript lines within `windowMs` before and after `shownMs`, from a parallel
 * list of line times (0: unknown, skipped). Before keeps the last lines, after
 * the first, each under a line and character cap.
 */
export function nearbyLines(lines: readonly string[], times: readonly number[], shownMs: number, windowMs = SLIDE_NEARBY_MS): { before: string[]; after: string[] } {
	const before: string[] = [];
	const after: string[] = [];
	if (!shownMs) return { before, after };
	lines.forEach((l, i) => {
		const t = times[i] ?? 0;
		if (!t) return;
		if (t <= shownMs && shownMs - t <= windowMs) before.push(l);
		else if (t > shownMs && t - shownMs <= windowMs) after.push(l);
	});
	const cap = (list: string[], tail: boolean) => {
		let out = tail ? list.slice(-NEARBY_LINES) : list.slice(0, NEARBY_LINES);
		let size = out.reduce((n, l) => n + l.length + 1, 0);
		while (out.length > 1 && size > NEARBY_CHARS) {
			size -= (tail ? (out[0] as string) : (out.at(-1) as string)).length + 1;
			out = tail ? out.slice(1) : out.slice(0, -1);
		}
		return out;
	};
	return { before: cap(before, true), after: cap(after, false) };
}

// ── what the model is asked ──────────────────────────────────────────────────

export function buildSlideSystem(me: string, meTokens: string[], about: string): string {
	const who = me || "the user";
	return [
		`You describe one slide from a meeting ${who} is sitting in, so ${who} can follow along and look it up later. You get the slide's image, the text read from it (OCR, which can be partial or garbled), a little about ${who} and what ${who} is working on, and what was being said around the time it came up.`,
		meTokens.length ? `\n${who} may be called ${meTokens.join(" or ")}.` : "",
		"",
		"Reply with JSON only, no prose and no code fence:",
		'{"title": "...", "what": "...", "why": "...", "points": ["..."], "numbers": ["..."]}',
		'- "title": a short title for the slide, at most 80 characters.',
		'- "what": one or two plain sentences on what the slide shows.',
		`- "why": ONE sentence on why this matters to ${who}, given ${who}'s context. "" (empty) is the normal answer: most slides have no particular bearing on ${who}. Do not invent relevance; only say it when the slide clearly touches what ${who} works on or was assigned.`,
		`- "points": at most ${SLIDE_POINTS} key takeaways, short.`,
		`- "numbers": at most ${SLIDE_NUMBERS} figures, dates or versions on the slide worth remembering, each with what it measures.`,
		"Say nothing beyond what the image, the OCR text and the transcript support: no speculation. If the image is mostly unreadable, say so in \"what\" and leave the rest empty. Never quote a garble as exact.",
		about ? `\n<about>\n${about.trim()}\n</about>` : "",
	]
		.filter((l, i, a) => !(l === "" && a[i - 1] === ""))
		.join("\n");
}

export type SlidePromptInput = {
	title: string;
	app: string;
	focus: string;
	me: string;
	digest: string; // formatDigest(...), already masked; "" for none
	n: number;
	shownAt: string; // HH:MM:SS the slide came up
	ocr: OcrWait;
	before: string[];
	after: string[];
	previous: { n: number; title: string }[]; // earlier summarized slides, oldest first
};

export function buildSlidePrompt(p: SlidePromptInput): string {
	const who = p.me || "the user";
	const ocr =
		p.ocr.state === "ready"
			? ["<ocr>", p.ocr.text, "</ocr>"]
			: p.ocr.state === "empty"
				? ["<ocr>", "(the OCR found no text on this slide)", "</ocr>"]
				: ["<ocr>", "(the OCR text was not ready: go by the image)", "</ocr>"];
	return [
		`Meeting: ${p.title || "untitled"}${p.app ? ` (${p.app})` : ""}`,
		p.focus ? `${who}'s goals for this meeting: ${p.focus}` : "",
		"",
		p.digest,
		p.previous.length ? ["<previous_slides>", "Titles of the slides before this one, for continuity:", ...p.previous.map((s) => `${s.n}. ${s.title}`), "</previous_slides>"].join("\n") : "",
		`This is slide ${p.n}${p.shownAt ? `, which came up at ${p.shownAt}` : ""}. Its image is attached.`,
		...ocr,
		p.before.length ? ["<said_before>", ...p.before, "</said_before>"].join("\n") : "",
		p.after.length ? ["<said_after>", ...p.after, "</said_after>"].join("\n") : "",
		"",
		"Describe the slide.",
	]
		.filter((l, i, a) => !(l === "" && (a[i - 1] === "" || i === 0)))
		.join("\n");
}

// ── the queue ────────────────────────────────────────────────────────────────

export type SlideJob = { n: number; at: string; ms: number; fails: number; retryAt: number };

/**
 * Which slide is summarized next. `pending` waits its turn; a slide is `done`
 * (summarized or restored), `failed` (gave up) or `active` (a call in flight).
 * `seen` counts the distinct slides ever taken in, against SLIDE_CAP.
 */
export type SlideWork = {
	pending: SlideJob[];
	done: Set<number>;
	failed: Set<number>;
	active: number | null;
	lastCallAt: number; // start of the last model call (ms)
	holdUntil: number; // after a failure: nothing starts before this (ms)
	streak: number; // failures in a row
	seen: number;
};

export const newSlideWork = (): SlideWork => ({ pending: [], done: new Set(), failed: new Set(), active: null, lastCallAt: 0, holdUntil: 0, streak: 0, seen: 0 });

const known = (w: SlideWork, n: number) => w.done.has(n) || w.failed.has(n) || w.active === n || w.pending.some((j) => j.n === n);

/** A new slide (never a revisit). False when it is known already or the meeting is at the cap. */
export function queueSlide(w: SlideWork, n: number, at: string, ms: number): boolean {
	if (!Number.isInteger(n) || n < 1 || known(w, n)) return false;
	if (w.seen >= SLIDE_CAP) {
		w.failed.add(n); // over the cap: it will never be summarized, and the canvas should not say "Summarizing…"
		return false;
	}
	w.pending.push({ n, at, ms, fails: 0, retryAt: 0 });
	w.seen++;
	return true;
}

/** A summary that already exists (restored from the notes file): no call for it. */
export function markSlideDone(w: SlideWork, n: number): void {
	if (!w.done.has(n) && !known(w, n)) w.seen++;
	w.done.add(n);
	w.pending = w.pending.filter((j) => j.n !== n);
}

/**
 * The next slide to work on, or undefined: nothing while a call is in flight,
 * within `gapMs` of the last call, or on hold after a failure. The newest slide
 * (highest number) that is due goes first, so a burst is summarized newest
 * first, then backwards.
 */
export function takeSlide(w: SlideWork, now: number, gapMs = SLIDE_GAP_MS): SlideJob | undefined {
	if (w.active !== null || now < w.holdUntil || (w.lastCallAt && now - w.lastCallAt < gapMs)) return undefined;
	let best: SlideJob | undefined;
	for (const j of w.pending) if (j.retryAt <= now && (!best || j.n > best.n)) best = j;
	if (!best) return undefined;
	w.pending = w.pending.filter((j) => j !== best);
	w.active = best.n;
	return best;
}

/** The model call for the active slide is starting now (the OCR wait is over). */
export const noteSlideCall = (w: SlideWork, now: number): void => void (w.lastCallAt = now);

export function slideDone(w: SlideWork, job: SlideJob): void {
	if (w.active === job.n) w.active = null;
	w.done.add(job.n);
	w.streak = 0;
	w.holdUntil = 0;
}

/**
 * A call failed: the slide goes back to the queue after `backoffMs`, nothing
 * else starts before then either, and after SLIDE_TRIES failures it is given up
 * ("gave-up", marked failed, never retried).
 */
export function slideFailed(w: SlideWork, job: SlideJob, now: number, backoffMs: number): "retry" | "gave-up" {
	if (w.active === job.n) w.active = null;
	w.streak++;
	w.holdUntil = now + backoffMs;
	job.fails++;
	if (job.fails >= SLIDE_TRIES) {
		w.failed.add(job.n);
		return "gave-up";
	}
	job.retryAt = now + backoffMs;
	w.pending.push(job);
	return "retry";
}

/** The slide numbers to tell the canvas about (given up on, or past the cap): integers of 1 or more, at most MAX_SLIDE_SUMMARIES, the highest kept, ascending. */
export function normFailed(raw: unknown): number[] {
	const list = Array.isArray(raw) ? raw : raw instanceof Set ? [...raw] : [];
	const ns = [...new Set(list.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
	return ns.slice(-MAX_SLIDE_SUMMARIES);
}

/**
 * How long to wait for a slide's OCR, counted from when the slide appeared
 * (`shownMs`), not from when the worker picked it up: after a reload or with a
 * capture that has no OCR, the one worker must not sit 90 s on every slide. A
 * replay (`speed` above 1, shown times are the recording's own) counts from the pickup, scaled.
 */
export function ocrTimeout(shownMs: number, nowMs: number, speed = 1, replay = false): number {
	if (replay || speed > 1) return speed > 1 ? Math.max(500, OCR_WAIT_MS / speed) : OCR_WAIT_MS;
	if (!shownMs) return OCR_WAIT_MS;
	return Math.min(OCR_WAIT_MS, Math.max(0, shownMs + OCR_WAIT_MS - nowMs));
}

/** The call gap, shrunk for a replay playing at `speed`×. */
export const slideGap = (speed = 1): number => (speed > 1 ? Math.max(20, SLIDE_GAP_MS / speed) : SLIDE_GAP_MS);
