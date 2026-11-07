/**
 * Built-in keyword search over loaded memories: the query's words (three or more
 * letters or digits, at most 40, as Botsun's search_memories takes them) scored
 * against each fact's words and tags. An exact word counts 1, a shared stem
 * (one word a prefix of the other, four letters or more, differing by at most
 * three: deploy, deploys, deployed) 0.75, a tag 0.5 more. Best first, then
 * newest.
 *
 * Pure node: no pi imports.
 */

import { words } from "./dedupe.ts";

export interface SearchItem {
	id: string;
	text: string;
	tags: readonly string[];
	updated: string;
}

export interface Hit<T> {
	memory: T;
	score: number;
}

export function queryWords(query: string): string[] {
	return words(query).slice(0, 40);
}

const stem = (a: string, b: string) => {
	const [s, l] = a.length <= b.length ? [a, b] : [b, a];
	return s.length >= 4 && l.startsWith(s) && l.length - s.length <= 3;
};

export function score(q: readonly string[], item: SearchItem): number {
	const text = words(item.text);
	const textSet = new Set(text);
	const tags = new Set(item.tags.map((t) => t.toLowerCase()));
	let total = 0;
	for (const w of q) {
		if (textSet.has(w)) total += 1;
		else if (text.some((t) => stem(w, t))) total += 0.75;
		if (tags.has(w)) total += 0.5;
	}
	return total;
}

export function search<T extends SearchItem>(query: string, items: readonly T[], limit = 10): Hit<T>[] {
	const q = queryWords(query);
	if (q.length === 0) return [];
	return items
		.map((memory) => ({ memory, score: score(q, memory) }))
		.filter((h) => h.score > 0)
		.sort((a, b) => b.score - a.score || (a.memory.updated < b.memory.updated ? 1 : a.memory.updated > b.memory.updated ? -1 : 0) || (a.memory.id < b.memory.id ? 1 : -1))
		.slice(0, Math.max(0, limit));
}
