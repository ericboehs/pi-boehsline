/**
 * Near-duplicate rule, ported from Botsun's Memory.duplicate and Memory.cleanup
 * (models like to save a fact, then each half of it again): a memory whose
 * words are 80% contained in another in the same scope is a duplicate. Words
 * are lowercase ASCII runs of three or more letters or digits.
 *
 * test/fixtures/memory-dedupe.json holds the cases both ports must agree on.
 *
 * Pure node: no pi imports.
 */

export const DUPLICATE = 0.8;

export interface DedupeItem {
	id: string;
	text: string;
	scope: string;
}

export function words(text: string): string[] {
	return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
}

const overlap = (a: readonly string[], b: ReadonlySet<string>) => a.filter((w) => b.has(w)).length;

/**
 * The first memory in `existing` (newest first) in `scope` that already holds
 * most of `text`'s words, or undefined. Texts of fewer than three words are
 * never duplicates.
 */
export function duplicate<T extends DedupeItem>(text: string, scope: string, existing: readonly T[]): T | undefined {
	const mine = words(text);
	if (mine.length < 3) return undefined;
	return existing.find((m) => m.scope === scope && overlap(mine, new Set(words(m.text))) >= DUPLICATE * mine.length);
}

/**
 * Of two near-duplicates in one scope (either holding 80% of the other's words),
 * the older goes. `memories` is newest first; returns the ids to archive.
 */
export function cleanup(memories: readonly DedupeItem[]): string[] {
	const kept: { scope: string; words: Set<string> }[] = [];
	const gone: string[] = [];
	for (const m of memories) {
		const mine = words(m.text);
		const dup = kept.find((k) => {
			if (k.scope !== m.scope) return false;
			const shared = overlap(mine, k.words);
			return mine.length >= 3 && (shared >= DUPLICATE * mine.length || shared >= DUPLICATE * k.words.size);
		});
		if (dup) gone.push(m.id);
		else kept.push({ scope: m.scope, words: new Set(mine) });
	}
	return gone;
}
