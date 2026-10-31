/**
 * Remote prompts: questions a tool is asking in the TUI that another extension may answer from
 * elsewhere (botsun-owner, from Eric's phone). The asking tool offers its questions and races the
 * TUI against `answered`; whichever comes first wins, and the tool closes the other.
 *
 * The registry lives on globalThis, so it survives /reload swapping in new extension instances
 * (an open question from before a reload is gone with its tool call anyway).
 */
import { createHash, randomBytes } from "node:crypto";

export interface RemoteQuestion {
	question: string;
	options: { label: string; description?: string }[];
	multiSelect?: boolean;
}

/** One answer per question: 0-based option picks and/or free text ("Type something"). */
export interface RemoteAnswer {
	picks: number[];
	text?: string;
}

export interface RemotePrompt {
	id: string;
	questions: RemoteQuestion[];
	/** Delivers an answer; returns an error, or null once taken. */
	answer(answers: RemoteAnswer[]): string | null;
}

interface Broker {
	prompts: Map<string, RemotePrompt>;
	listeners: Set<() => void>;
}

const KEY = Symbol.for("boehsline.remote-prompts.v1");
const TEXT_MAX = 2000;

function broker(): Broker {
	const g = globalThis as unknown as { [KEY]?: Broker };
	g[KEY] ??= { prompts: new Map(), listeners: new Set() };
	return g[KEY];
}

function changed(): void {
	for (const fn of broker().listeners) {
		try {
			fn();
		} catch {}
	}
}

/** The questions open right now, oldest first. */
export function openPrompts(): RemotePrompt[] {
	return [...broker().prompts.values()];
}

/** Called whenever a prompt opens or closes. Returns the unsubscribe. */
export function onPromptsChange(fn: () => void): () => void {
	broker().listeners.add(fn);
	return () => broker().listeners.delete(fn);
}

/** Why these answers don't fit these questions, or null. */
export function invalidAnswer(questions: RemoteQuestion[], answers: unknown): string | null {
	if (!Array.isArray(answers) || answers.length !== questions.length) return "one answer per question";
	for (let i = 0; i < questions.length; i++) {
		const a = answers[i] as RemoteAnswer;
		const q = questions[i]!;
		if (!a || !Array.isArray(a.picks)) return "bad answer";
		if (a.text !== undefined && (typeof a.text !== "string" || a.text.length > TEXT_MAX)) return "bad text";
		const picks = a.picks;
		if (!picks.every((p) => Number.isInteger(p) && p >= 0 && p < q.options.length)) return "a pick isn't one of the options";
		if (new Set(picks).size !== picks.length) return "a pick is repeated";
		if (!q.multiSelect && picks.length + (a.text?.trim() ? 1 : 0) > 1) return "one answer for a single-choice question";
		if (picks.length === 0 && !a.text?.trim()) return "every question needs an answer";
	}
	return null;
}

const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * What a signature covers: the prompt id, then per question "q<i> <picks,comma> <sha256(text)>".
 * Botsun and the phone build the same text.
 */
export function canonicalAnswer(id: string, answers: RemoteAnswer[]): string {
	return [id, ...answers.map((a, i) => `q${i} ${a.picks.join(",")} ${sha256hex(a.text ?? "")}`)].join("\n");
}

/** Offers questions for a remote answer. `answered` resolves once one is taken; dispose when done. */
export function offerPrompt(questions: RemoteQuestion[]): { id: string; answered: Promise<RemoteAnswer[]>; dispose(): void } {
	const id = randomBytes(9).toString("base64url");
	let resolve!: (a: RemoteAnswer[]) => void;
	const answered = new Promise<RemoteAnswer[]>((r) => {
		resolve = r;
	});
	const b = broker();
	b.prompts.set(id, {
		id,
		questions,
		answer(answers) {
			if (!b.prompts.has(id)) return "that question was already answered";
			const bad = invalidAnswer(questions, answers);
			if (bad) return bad;
			b.prompts.delete(id);
			changed();
			resolve(answers.map((a) => ({ picks: [...a.picks], ...(a.text?.trim() ? { text: a.text } : {}) })));
			return null;
		},
	});
	changed();
	return {
		id,
		answered,
		dispose() {
			if (b.prompts.delete(id)) changed();
		},
	};
}
