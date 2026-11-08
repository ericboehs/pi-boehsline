/**
 * The memory operations the extension and the CLI share, so every write goes
 * through the same scanner, dedupe, git commit and qmd update.
 *
 * Writes return as soon as the file is in place; `committed` settles when the
 * commit does (the extension doesn't wait, the CLI does).
 *
 * Pure node: no pi imports.
 */

import { commit, type GitResult } from "./git.ts";
import { duplicate } from "./dedupe.ts";
import { VERIFIED_STATUSES, type Verified, type VerifiedStatus } from "./frontmatter.ts";
import { type Qmd, qmdClient } from "./qmd.ts";
import { type Block, oneLine, render } from "./render.ts";
import { refusal, type Scanner, scanner } from "./scan.ts";
import { search as builtinSearch } from "./search.ts";
import type { MemorySettings } from "./settings.ts";
import * as store from "./store.ts";
import { type Memory, MemoryError, type Source } from "./store.ts";

export interface Memories {
	settings: MemorySettings;
	root: string;
	scanner: Scanner;
	qmd: Qmd;
	log: (msg: string) => void;
}

export function open(settings: MemorySettings, log: (msg: string) => void = () => {}, qmd?: Qmd): Memories {
	store.init(settings.root, { git: settings.git });
	return {
		settings,
		root: settings.root,
		scanner: scanner(settings.scanner.extraPatterns),
		qmd: qmd ?? qmdClient({ root: settings.root, mode: settings.qmd, log }),
		log,
	};
}

export interface Written {
	memory: Memory;
	committed: Promise<GitResult>;
}

/** Refuse text the scanner flags, naming only the category. */
export function check(mem: Memories, ...texts: string[]): void {
	for (const t of texts) {
		const r = mem.scanner.scan(t);
		if (!r.ok) throw new MemoryError(refusal(r.category));
	}
}

function after(mem: Memories, message: string): Promise<GitResult> {
	mem.qmd.scheduleUpdate();
	return mem.settings.git ? commit(mem.root, message, mem.log) : Promise.resolve({ ok: true, unchanged: true });
}

/** Scope from `global` / `project`, given the cwd's slug. */
export function scopeFor(kind: string | undefined, slug: string | null): string {
	if (!kind || kind === "global") return "global";
	if (kind === "project") {
		if (!slug) throw new MemoryError("no project scope here: this folder has no git origin remote; save it as global instead");
		return store.projectScope(slug);
	}
	throw new MemoryError(`unknown scope ${kind}: use global or project`);
}

export function remember(mem: Memories, input: { text: string; tags?: readonly string[]; scope: string; source: Source; confidence?: store.Confidence; expires?: string }): Written {
	const text = store.cleanText(input.text);
	const tags = store.normalizeTags(input.tags ?? []);
	const expires = input.expires === undefined ? undefined : store.cleanExpires(input.expires);
	check(mem, text, tags.join(" "));
	const existing = store.load(mem.root).memories.filter((m) => m.state !== "archived" && !store.expired(m));
	const same = duplicate(text, input.scope, existing);
	if (same) throw new MemoryError(`already saved as ${same.id} (use memory_update to change it, or forget it first)`);
	const memory = store.write(mem.root, { scope: input.scope, text, tags, source: input.source, confidence: input.confidence, ...(expires ? { expires } : {}) });
	return { memory, committed: after(mem, `${input.source.kind} ${memory.id}`) };
}

/**
 * Replace a fact's text and/or tags and/or expiry. `text === undefined` leaves
 * the text as it is (so a review can add an expiry to a time-bound fact without
 * retyping it); `expires: null` clears it.
 */
export function update(mem: Memories, id: string, text: string | undefined, tags?: readonly string[], change: { expires?: string | null } = {}): Written {
	if (text === undefined && tags === undefined && change.expires === undefined) throw new MemoryError("nothing to change");
	const clean = text === undefined ? undefined : store.cleanText(text);
	const normTags = tags === undefined ? undefined : store.normalizeTags(tags);
	check(mem, ...(clean !== undefined ? [clean] : []), ...(normTags !== undefined ? [normTags.join(" ")] : []));
	const current = store.find(mem.root, id);
	if (!current || current.state === "archived") throw new MemoryError(`no memory ${id}${current ? " (it is archived; restore it first)" : ""}`);
	if (clean !== undefined) {
		const others = store.load(mem.root).memories.filter((m) => m.state !== "archived" && m.id !== id && !store.expired(m));
		const same = duplicate(clean, current.scope, others);
		if (same) throw new MemoryError(`that would duplicate ${same.id}; forget one of them instead`);
	}
	const memory = store.update(mem.root, id, {
		...(clean !== undefined ? { text: clean } : {}),
		...(normTags !== undefined ? { tags: normTags } : {}),
		...(change.expires !== undefined ? { expires: change.expires === null ? null : store.cleanExpires(change.expires) } : {}),
	});
	return { memory, committed: after(mem, `update ${id}`) };
}

/**
 * Record how a fact was checked against the sessions it came from: when, what
 * came of it, by what (a model id or "user"), and the evidence. The evidence is
 * scanned like any other write and only then cut at MAX_EVIDENCE, so a secret
 * straddling the cut is still refused (and never written in part).
 */
export function verify(mem: Memories, id: string, input: { status: string; evidence: string; by: string; now?: Date }): Written {
	if (!(VERIFIED_STATUSES as readonly string[]).includes(input.status)) throw new MemoryError(`status is one of ${VERIFIED_STATUSES.join(", ")}`);
	const raw = (typeof input.evidence === "string" ? input.evidence : "").trim();
	check(mem, raw);
	const evidence = raw.slice(0, store.MAX_EVIDENCE);
	const verified: Verified = { at: store.isoLocal(input.now), status: input.status as VerifiedStatus, by: input.by, evidence };
	const memory = store.verify(mem.root, id, verified);
	return { memory, committed: after(mem, `verify ${id} ${verified.status}`) };
}

/** Archive every active fact whose `expires` day has passed, one commit each ("expire <id>"). */
export async function expire(mem: Memories, now = new Date()): Promise<Memory[]> {
	const stale = store.load(mem.root).memories.filter((m) => m.state === "active" && store.expired(m, now));
	const out: Memory[] = [];
	for (const m of stale) {
		out.push(store.archive(mem.root, m.id, now));
		await after(mem, `expire ${m.id}`);
	}
	return out;
}

export function forget(mem: Memories, id: string): Written {
	const memory = store.archive(mem.root, id);
	return { memory, committed: after(mem, `forget ${id}`) };
}

export function restore(mem: Memories, id: string): Written {
	const archived = store.find(mem.root, id);
	if (archived) check(mem, archived.text);
	const memory = store.restore(mem.root, id);
	return { memory, committed: after(mem, `restore ${id}`) };
}

export function pin(mem: Memories, text: string): { pins: string[]; committed: Promise<GitResult> } {
	check(mem, store.cleanText(text));
	const pins = store.addPin(mem.root, text);
	return { pins, committed: after(mem, "pin add") };
}

export function unpin(mem: Memories, n: number): { pins: string[]; committed: Promise<GitResult> } {
	const pins = store.removePin(mem.root, n);
	return { pins, committed: after(mem, `pin rm ${n}`) };
}

export const SEARCH_SCOPES = ["visible", "global", "project", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export interface SearchResult {
	memories: Memory[];
	outside: { collection: string; file: string; snippet: string }[];
	/** "qmd" when qmd answered, else "built-in". */
	via: "qmd" | "built-in";
}

function inScope(m: Memory, scope: SearchScope, slug: string | null): boolean {
	const project = slug ? store.projectScope(slug) : null;
	if (scope === "all") return true;
	if (scope === "global") return m.scope === "global";
	if (scope === "project") return m.scope === project;
	return m.scope === "global" || m.scope === project;
}

/**
 * Built-in search, merged with qmd's hits when qmd answers (qmd's order first).
 * Active memories only, and none the scanner refuses (a hand-edited file).
 */
export async function search(mem: Memories, query: string, opts: { scope?: SearchScope; limit?: number; slug: string | null }): Promise<SearchResult> {
	const scope = opts.scope ?? "visible";
	if (!SEARCH_SCOPES.includes(scope)) throw new MemoryError(`unknown scope ${scope}: use ${SEARCH_SCOPES.join(", ")}`);
	if (opts.limit !== undefined && !Number.isFinite(opts.limit)) throw new MemoryError("limit must be a number");
	const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit ?? 10)));
	if (scope === "project" && !opts.slug) throw new MemoryError("no project scope here: this folder has no git origin remote");
	const pool = store.load(mem.root).memories.filter((m) => m.state === "active" && !store.expired(m) && inScope(m, scope, opts.slug) && mem.scanner.scan(m.text).ok);
	const byId = new Map(pool.map((m) => [m.id, m]));
	const builtin = builtinSearch(query, pool, limit).map((h) => h.memory);
	const q = await mem.qmd.query(query, limit * 2, mem.settings.search.collections);
	if (!q) return { memories: builtin, outside: [], via: "built-in" };
	const merged: Memory[] = [];
	for (const id of q.ids) {
		const m = byId.get(id);
		if (m && !merged.includes(m)) merged.push(m);
	}
	for (const m of builtin) if (!merged.includes(m)) merged.push(m);
	return {
		memories: merged.slice(0, limit),
		outside: q.outside.slice(0, limit).map(({ collection, file, snippet }) => ({ collection, file, snippet })),
		via: "qmd",
	};
}

/** The static block a session in `slug` starts with; memories and pins the scanner refuses are left out. */
export function context(mem: Memories, slug: string | null, used: Readonly<Record<string, number>>): Block {
	return render(store.load(mem.root).memories, {
		slug,
		startChars: mem.settings.inject.startChars,
		startMax: mem.settings.inject.startMax,
		pinned: store.readPins(mem.root),
		used,
		allow: (text) => mem.scanner.scan(text).ok,
	});
}

/** One line per memory for tool results and the TUI. */
export function line(m: Memory): string {
	return `[${m.id}] (${m.scope}, ${m.updated.slice(0, 10)}) ${oneLine(m.text)}`;
}
