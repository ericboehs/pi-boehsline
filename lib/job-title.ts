/**
 * A short title for a delegated run (a subagent task, a Cursor run): what Botsun's info sheet
 * and the canvas jobs feed show in a running row instead of the raw prompt.
 *
 * The caller's own `title` wins. Without one, deriveTitle guesses from the prompt:
 *   1. a worktree named in it: a `~/tmp/wt-X` path (`cd ~/tmp/wt-X`), a `worktree <path>`, or a
 *      `branch <name>` with a separator in it, humanized ("wt-jobs-title-scope" → "Jobs title scope");
 *   2. else its first sentence, paths and backticks stripped, cut to TITLE_MAX at a word.
 *
 * Pure: no masking here (lib/children.ts and bg mask what they keep).
 */

/** A derived title's length at most, in characters ("…" included). */
export const TITLE_MAX = 40;
/** A caller's title's length at most. */
export const GIVEN_TITLE_MAX = 60;

const oneLine = (s: string) => s.replace(/[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu, " ").replace(/\s+/g, " ").trim();

function cut(s: string, n: number): string {
	if (s.length <= n) return s;
	const head = s.slice(0, n - 1);
	const space = head.lastIndexOf(" ");
	// At a word when one ends in the back half; else mid-word.
	return `${(space >= n / 2 ? head.slice(0, space) : head).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** A worktree or branch name as words: "wt-" and a branch's "feat/" go, separators become spaces, the first letter is capitalized. */
export function humanize(name: string): string {
	const last = name.replace(/\/+$/, "").split("/").pop() ?? "";
	const words = last.replace(/^wt-/, "").replace(/\.git$/, "").replace(/[-_.]+/g, " ").trim();
	return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

const TRIM_NAME = /[.,;:)\]}'"`]+$/;

/** The worktree or branch a prompt names, or "" (see the header). */
function worktreeName(prompt: string): string {
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

/** The first sentence of the prompt, paths and backticks out, at most TITLE_MAX. */
function firstSentence(prompt: string): string {
	const text = oneLine(prompt.replace(PATH, " ").replace(/`/g, ""))
		.replace(/\(\s*[,;:]?\s*\)/g, " ") // a "(...)" the paths left empty
		.replace(/\s+([,;:.!?])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
	return cut(sentence.replace(/[.!?:;,\s]+$/, "").trim(), TITLE_MAX);
}

/** A title guessed from a prompt (see the header); "" when the prompt has no words. */
export function deriveTitle(prompt: unknown): string {
	const raw = typeof prompt === "string" ? prompt : "";
	const name = worktreeName(raw);
	const human = name ? humanize(name) : "";
	if (human) return cut(human, TITLE_MAX);
	return firstSentence(raw) || cut(oneLine(raw.replace(/`/g, "")), TITLE_MAX);
}

/** A caller's title, one line and capped; undefined when it has none. */
export function cleanTitle(title: unknown): string | undefined {
	if (typeof title !== "string") return undefined;
	const t = oneLine(title);
	return t ? cut(t, GIVEN_TITLE_MAX) : undefined;
}

/** The title a run shows: the caller's, else one derived from its prompt. */
export function jobTitle(title: unknown, prompt: unknown): string {
	return cleanTitle(title) ?? deriveTitle(prompt);
}
