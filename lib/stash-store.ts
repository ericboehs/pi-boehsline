/**
 * The message stash's stacks, per session id, shared by the stash extension (Ctrl+S, /stash)
 * and botsun-owner (the phone's stash). In memory on globalThis, so /reload keeps them; never on
 * disk, never in model context. Listeners hear every change, so the TUI's stashed bar follows
 * edits made from the phone and the phone follows Ctrl+S.
 */

export interface StashEntry {
	id: string;
	text: string;
	ts: number;
}

type StashStore = Map<string, StashEntry[]>;

/** The same key the stash extension always used: stacks from before this module survive. */
const STORE_KEY = "__piMessageStash";
const LISTENERS_KEY = "__piMessageStashListeners";

type Root = typeof globalThis & { [STORE_KEY]?: StashStore; [LISTENERS_KEY]?: Set<(sessionId: string) => void> };

function store(): StashStore {
	const root = globalThis as Root;
	root[STORE_KEY] ??= new Map();
	return root[STORE_KEY];
}

function listeners(): Set<(sessionId: string) => void> {
	const root = globalThis as Root;
	root[LISTENERS_KEY] ??= new Set();
	return root[LISTENERS_KEY];
}

/** The live stack for a session (oldest first; the top is the last). Mutate, then call stashChanged. */
export function stashStack(sessionId: string): StashEntry[] {
	const stacks = store();
	let stack = stacks.get(sessionId);
	if (!stack) {
		stack = [];
		stacks.set(sessionId, stack);
	}
	return stack;
}

export function newStashId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Tells every listener this session's stack changed. */
export function stashChanged(sessionId: string): void {
	for (const fn of listeners()) {
		try {
			fn(sessionId);
		} catch {}
	}
}

/** Called with the session id whenever a stack changes. Returns the unsubscribe. */
export function onStashChange(fn: (sessionId: string) => void): () => void {
	listeners().add(fn);
	return () => listeners().delete(fn);
}

/** Pushes a draft on top. */
export function pushStash(sessionId: string, text: string): StashEntry {
	const entry = { id: newStashId(), text, ts: Date.now() };
	stashStack(sessionId).push(entry);
	stashChanged(sessionId);
	return entry;
}

/** Removes an entry by id and returns it (null when gone). */
export function takeStash(sessionId: string, id: string): StashEntry | null {
	const stack = stashStack(sessionId);
	const i = stack.findIndex((e) => e.id === id);
	if (i < 0) return null;
	const [entry] = stack.splice(i, 1);
	stashChanged(sessionId);
	return entry ?? null;
}
