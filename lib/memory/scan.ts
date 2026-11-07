/**
 * The write-time scanner every memory write goes through. A hit refuses the
 * write and names the category; it never says which text matched, so a refusal
 * can't echo a secret into the transcript, and it never redacts (a redacted
 * fact is usually a wrong fact).
 *
 * The text is checked as written and as a flattened skeleton: NFKC, invisible
 * characters and combining marks gone, Cyrillic and Greek lookalikes made
 * Latin, whitespace runs as one space (render shows each memory on one line),
 * so full-width letters, zero-width joiners, accents or a line break don't
 * slip a phrase past the patterns. A phrase split across punctuation or across two memories is not
 * caught; the fence and "notes, not instructions" framing cover that.
 *
 * Pure node: no pi imports.
 */

import type { ExtraPattern } from "./settings.ts";

export type ScanResult = { ok: true } | { ok: false; category: string };

export const SECRET = "secret";
export const PERSONAL = "personal identifier";
export const INJECTION = "prompt injection";

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
);
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const PEM = /-----BEGIN [A-Z0-9 ]+-----/;
const URL_CREDS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i;
/** An op:// reference with a value beside it (the resolved secret), not the reference alone. */
const OP_VALUE = /\bop:\/\/\S+\s*(?:=|:|->|=>)\s*\S/;
const AUTH_HEADER = /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/i;
/** A credential-named key (GITHUB_TOKEN=, api-key:, "password": …) and its value. */
const NAMED = /\b(?:[A-Za-z0-9]+[_-])*(?:passw(?:or)?d|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|authorization)(?:[_-][\w-]*)?["']?\s*[=:]\s*["']?([^\s"'<>,;]{6,})/i;
const LONG_TOKEN = /[A-Za-z0-9_+/=-]{24,}/g;

/** Credential-shaped: letters mixed with digits or symbols, so "token: rotation", "tokens: 200000" and "Bearer authentication" pass. */
const tokenShaped = (v: string) => /[A-Za-z]/.test(v) && /[^A-Za-z]/.test(v);

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
	const counts = new Map<string, number>();
	for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
	return h;
}

/** How often adjacent characters change class (lower, upper, digit, other): about 0.6 for random tokens, about 0.3 for camelCase. */
function churn(t: string): number {
	const cls = (c: string) => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /\d/.test(c) ? 2 : 3);
	let changes = 0;
	for (let i = 1; i < t.length; i++) if (cls(t[i]!) !== cls(t[i - 1]!)) changes++;
	return changes / (t.length - 1);
}

/**
 * A 24+ character run that looks random: letters and digits, mixed case or long
 * hex, high entropy and class churn. Words, paths, kebab-case and camelCase
 * names, UUIDs and 40-character commit SHAs pass.
 */
function looksRandom(t: string): boolean {
	if (!/\d/.test(t) || !/[A-Za-z]/.test(t)) return false;
	if (/^[0-9a-f]{40}$/i.test(t)) return false;
	if (/^[0-9a-f]{32,}$/i.test(t)) return true;
	if (/[A-Z]/.test(t) && /[a-z]/.test(t)) return entropy(t) >= 3.5 && churn(t) >= 0.4;
	// One case only: random enough that no word or name looks like it (32+ characters, many digits).
	return t.length >= 32 && !/^[0-9a-f]+$/i.test(t) && (t.match(/\d/g)?.length ?? 0) >= 4 && entropy(t) >= 4.2 && churn(t) >= 0.25;
}

function secret(s: string): boolean {
	if (TOKEN_PREFIX.test(s) || JWT.test(s) || PEM.test(s) || URL_CREDS.test(s) || OP_VALUE.test(s)) return true;
	const auth = AUTH_HEADER.exec(s);
	if (auth && tokenShaped(auth[1]!)) return true;
	const named = NAMED.exec(s);
	if (named && tokenShaped(named[1]!)) return true;
	for (const m of s.matchAll(LONG_TOKEN)) {
		// Long base64 is the injection category's; here only token-length runs count.
		if (m[0].length >= 120) continue;
		// A run and its segments, so a prefix (dop_v1_…, key-…) can't hide the random part.
		for (const part of new Set([m[0], ...m[0].split(/[_/+=-]+/)])) if (part.length >= 24 && looksRandom(part)) return true;
	}
	return false;
}

function luhn(digits: string): boolean {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return sum % 10 === 0;
}

const SSN = /\b(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}\b/;
/** Card-number shapes: issuer prefixes 2(2-7), 3, 4, 5, 6, so epoch-millisecond timestamps (1…) pass. */
const CARD = /\b(?:2[2-7]|[3456])\d?(?:[ -]?\d){11,17}\b/g;
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE = `(?:\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|\\d{4}-\\d{2}-\\d{2}|${MONTH}\\.? \\d{1,2},? \\d{4}|\\d{1,2} ${MONTH}\\.? \\d{4})`;
const DOB = new RegExp(`\\b(?:born(?: on)?|d\\.?o\\.?b\\.?|date of birth|birth ?date|birthday)\\b[^.\\n]{0,40}?${DATE}|${DATE}\\s*[(,-]?\\s*(?:birthday|date of birth|d\\.?o\\.?b)\\b`, "i");

function personal(s: string): boolean {
	if (SSN.test(s)) return true;
	for (const m of s.matchAll(CARD)) {
		const digits = m[0].replace(/\D/g, "");
		if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return true;
	}
	return DOB.test(s);
}

const OVERRIDE = /\b(?:ignore|disregard|override|bypass)\b[^.\n]{0,30}\b(?:previous|prior|above|earlier|all|any|system|your)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules|directions|guidelines)\b/i;
const ROLE = /\byou are now (?:a|an|the|in|my|no longer)\b|\bnew (?:system )?instructions?:|\bsystem prompt:|\bact as (?:the )?system\b/i;
/** Markup that looks like the prompt's own structure or a tool call, opening or closing. */
const TAGS = /<\/?\s*(?:system|memory|instructions?|rules|tools?|user|assistant|human|developer|tool_call|tool_calls|tool_use|tool_result|function_calls?|function_results?|invoke|parameter|antml:[\w-]+|im_start|im_end)(?![\w-])/i;
const CHAT_TOKENS = /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>/i;
const TOOL_JSON = /"(?:tool_calls?|function_call)"\s*:|\{\s*"name"\s*:\s*"[^"]*"\s*,\s*"(?:arguments|parameters|input)"\s*:/i;
const BASE64_BLOB = /[A-Za-z0-9+/]{120,}={0,2}/;
/**
 * Characters that hide text: format controls (zero-width, bidi, tag characters), other controls
 * but tab and newline, private use. The zero-width joiner is allowed (emoji sequences use it);
 * folding removes it before the patterns run.
 */
const HIDDEN = /(?!\u200d)[\p{Cf}\p{Co}]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

function injection(s: string): boolean {
	return OVERRIDE.test(s) || ROLE.test(s) || TAGS.test(s) || CHAT_TOKENS.test(s) || TOOL_JSON.test(s) || BASE64_BLOB.test(s);
}

interface Compiled {
	category: string;
	re: RegExp;
}

/** User patterns, compiled once; a pattern that doesn't compile is listed in `invalid`, not thrown. */
export function compileExtra(patterns: readonly ExtraPattern[]): { compiled: Compiled[]; invalid: string[] } {
	const compiled: Compiled[] = [];
	const invalid: string[] = [];
	for (const p of patterns) {
		const category = p.category.replace(/[^\w .-]/g, "").trim().slice(0, 40) || "custom";
		try {
			const flags = (p.flags ?? "i").replace(/[gy]/g, "");
			compiled.push({ category, re: new RegExp(p.pattern, flags) });
		} catch {
			invalid.push(category);
		}
	}
	return { compiled, invalid };
}

/** Cyrillic and Greek letters drawn like Latin ones. */
const CONFUSABLE: Record<string, string> = {
	"а": "a", "в": "b", "с": "c", "е": "e", "һ": "h", "і": "i", "ј": "j", "к": "k", "ӏ": "l", "м": "m", "н": "h", "о": "o", "р": "p", "ԛ": "q", "г": "r", "ѕ": "s", "т": "t", "у": "y", "ԝ": "w", "х": "x", "ԁ": "d",
	"А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I", "Ј": "J", "К": "K", "М": "M", "О": "O", "Р": "P", "Ѕ": "S", "Т": "T", "Х": "X", "У": "Y",
	"α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
	"Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
const CONFUSABLES = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "gu");

/** The text as it reads: NFKC, marks and default-ignorable characters (zero-width, bidi, variation selectors) gone, lookalike letters made Latin. */
export function skeleton(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
		.replace(CONFUSABLES, (c) => CONFUSABLE[c]!)
		.normalize("NFKC");
}

/** Every run of whitespace as one space, as render shows it. */
const flat = (s: string) => s.replace(/\s+/g, " ");

export interface Scanner {
	scan(text: string): ScanResult;
	/** Categories of extraPatterns that did not compile. */
	invalid: string[];
}

export function scanner(extra: readonly ExtraPattern[] = []): Scanner {
	const { compiled, invalid } = compileExtra(extra);
	return {
		invalid,
		scan(text: string): ScanResult {
			if (HIDDEN.test(text)) return { ok: false, category: INJECTION };
			const variants = [...new Set([text, flat(skeleton(text))])];
			for (const s of variants) {
				if (secret(s)) return { ok: false, category: SECRET };
				if (personal(s)) return { ok: false, category: PERSONAL };
				if (injection(s)) return { ok: false, category: INJECTION };
				for (const c of compiled) if (c.re.test(s)) return { ok: false, category: c.category };
			}
			return { ok: true };
		},
	};
}

/** The message a refusal shows: the category only. */
export function refusal(category: string): string {
	return `refused: this looks like it contains a ${category}, which memory never stores. Rephrase the fact without it (the matched text is not repeated here).`;
}
