/**
 * A short title for a delegated run (a subagent task, a Cursor run): what Botsun's info sheet
 * and the canvas jobs feed show in a running row instead of the raw prompt.
 *
 * The caller's own `title` wins. Without one, deriveTitle guesses from the prompt:
 *   1. a worktree named in it: a `~/tmp/wt-X` path (`cd ~/tmp/wt-X`), a `worktree <path>`, or a
 *      `branch <name>` with a separator in it, humanized ("wt-jobs-title-scope" → "Jobs title scope");
 *      (a name the secret masker would change is not used: it may be a token);
 *   2. else its first sentence (e.g./i.e. don't end it), URLs cut to their host, paths and
 *      backticks stripped with a preposition that led into a path, cut to TITLE_MAX at a word,
 *      a dangling preposition at its end dropped.
 *
 * Secrets: the prompt is masked whole (maskDiffSecrets: named values, bare ghp_/sk-/AKIA… tokens)
 * before anything is derived from it, so a cut never leaves a token half shown, and the title is
 * masked again after. Cuts are by code point, so an emoji is never split into a lone surrogate.
 */

import { maskDiffSecrets } from "./cursor-diff.ts";

/** A derived title's length at most, in characters ("…" included). */
export const TITLE_MAX = 40;
/** A caller's title's length at most. */
export const GIVEN_TITLE_MAX = 60;

const oneLine = (s: string) => s.replace(/[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu, " ").replace(/\s+/g, " ").trim();

/** Words a title shouldn't end on: what led into something the cut or a stripped path took. */
const DANGLING = /(?:\s+(?:in|of|at|to|for|from|into|on|with|by|and|or|the|a|an))+$/i;

/** s at most n code points (never half a surrogate pair), "…" included when cut. */
export function cut(s: string, n: number): string {
	const chars = Array.from(s);
	if (chars.length <= n) return s;
	const head = chars.slice(0, n - 1).join("");
	const space = head.lastIndexOf(" ");
	// At a word when one ends in the back half; else mid-word.
	const atWord = space >= 0 && Array.from(head.slice(0, space)).length >= n / 2;
	const kept = (atWord ? head.slice(0, space) : head).replace(/[\s,;:.–—-]+$/, "");
	return `${kept.replace(DANGLING, "") || kept}…`;
}

const mask = (s: string) => maskDiffSecrets(s);

/** A worktree or branch name as words: "wt-" and a branch's "feat/" go, separators become spaces, the first letter is capitalized. */
export function humanize(name: string): string {
	const last = name.replace(/\/+$/, "").split("/").pop() ?? "";
	const words = last.replace(/^wt-/, "").replace(/\.git$/, "").replace(/[-_.]+/g, " ").trim();
	return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

const TRIM_NAME = /[.,;:)\]}'"`]+$/;

/** The worktree or branch a prompt names, or "" (see the header). */
function worktreeName(prompt: string): string {
	const name = rawWorktreeName(prompt);
	// A name the masker would touch may be (or hold) a token: no title from it.
	return name && mask(name) === name ? name : "";
}

function rawWorktreeName(prompt: string): string {
	const wt = /\/wt-([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(prompt);
	if (wt?.[1]) return wt[1].replace(TRIM_NAME, "");
	const tree = /\bworktree\s+(?:at\s+|in\s+)?[`'"]?((?:~|\.{0,2})\/[^\s`'"]+)/i.exec(prompt);
	if (tree?.[1]) return tree[1].replace(TRIM_NAME, "");
	const branch = /\bbranch\s+[`'"]?([A-Za-z0-9][\w./-]*[-_/][\w./-]*[A-Za-z0-9])/i.exec(prompt);
	if (branch?.[1]) return branch[1];
	return "";
}

/** A path-like token: ~/x, /x, ./x, ../x, or a word with a slash in it (lib/foo.ts). */
const PATH = /(?:^|(?<=[\s(`'"]))(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]*)+|(?:^|(?<=[\s(`'"]))~(?=[\s)`'"]|$)/g;

/** A URL, its scheme's host kept: "https://github.com/a/b" → "github.com". */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([^\s/?#:'"`)]+)[^\s'"`)]*/gi;
/** Where a stripped path was (a private-use character; never in a prompt worth keeping). */
const HOLE = "\uE000";
/** A preposition that led into a stripped path ("the diff in lib/foo.rb for bugs"): it goes with it. */
const LEAD_IN = new RegExp(`\\b(?:in|of|at|to|from|into|inside|under|on|for)\\s+${HOLE}`, "gi");
/** Abbreviations whose period doesn't end a sentence. */
const ABBREV = /\b(?:e\.g|i\.e|vs|cf|approx)$/i;

/** The text up to its first sentence end (., ! or ? before a space or the end), e.g./i.e. not counted. */
function sentenceOf(text: string): string {
	const end = /[.!?](?=\s|$)/g;
	for (let m = end.exec(text); m; m = end.exec(text)) {
		if (m[0] === "." && ABBREV.test(text.slice(0, m.index))) continue;
		return text.slice(0, m.index + 1);
	}
	return text;
}

/** The first sentence of the prompt, URLs as hosts, paths and backticks out, at most TITLE_MAX. */
function firstSentence(prompt: string): string {
	const holed = prompt
		// The URL's trailing punctuation is the sentence's ("…?y=1. Then"): it stays.
		.replace(URL_RE, (m: string, host: string) => host.replace(/^www\./i, "").replace(/[.,;:!?]+$/, "") + (/[.,;:!?]+$/.exec(m)?.[0] ?? ""))
		.replace(/\bcd\s+(?:~|\.{0,2}\/)\S*\s*(?:&&|;)?/g, " ") // "cd ~/x &&" says nothing a title needs
		.replace(PATH, HOLE)
		.replace(/`/g, "");
	const text = oneLine(holed.replace(LEAD_IN, " ").replaceAll(HOLE, " "))
		.replace(/\(\s*[,;:]?\s*\)/g, " ") // a "(...)" the paths left empty
		.replace(/\s+([,;:.!?])/g, "$1")
		.replace(/\s+/g, " ")
		.replace(/^(?:&&|;|\|\|)\s*/, "")
		.trim();
	const sentence = sentenceOf(text).replace(/[.!?:;,\s]+$/, "").trim();
	const done = sentence.replace(DANGLING, "") || sentence;
	return cut(done, TITLE_MAX);
}

/** A title guessed from a prompt (see the header); "" when the prompt has no words. */
export function deriveTitle(prompt: unknown): string {
	const raw = typeof prompt === "string" ? prompt : "";
	const name = worktreeName(raw);
	const human = name ? humanize(name) : "";
	if (human) return mask(cut(human, TITLE_MAX));
	// Masked whole first: a token is gone before any cut can leave part of it.
	const masked = mask(raw);
	return mask(firstSentence(masked) || cut(oneLine(masked.replace(/`/g, "")), TITLE_MAX));
}

/** A caller's title, one line and capped; undefined when it has none. */
export function cleanTitle(title: unknown): string | undefined {
	if (typeof title !== "string") return undefined;
	const t = oneLine(mask(oneLine(title)));
	return t ? mask(cut(t, GIVEN_TITLE_MAX)) : undefined;
}

/** The title a run shows: the caller's, else one derived from its prompt. */
export function jobTitle(title: unknown, prompt: unknown): string {
	return cleanTitle(title) ?? deriveTitle(prompt);
}
