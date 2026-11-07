/**
 * pi-memory settings: the `memory` block of boehsline.json over these defaults.
 *
 * Pure node: no pi imports, so the CLI and `node --test` use it directly.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type ConfigObject, settingsFor } from "../config.ts";

export interface ExtraPattern {
	category: string;
	pattern: string;
	flags?: string;
}

export interface MemorySettings {
	root: string;
	git: boolean;
	inject: { startChars: number; startMax: number; turnChars: number; turnHits: number };
	qmd: "auto" | "off";
	search: { collections: string[] };
	/** Read but unused until P2. */
	candidates: "off" | "compaction";
	/** Read but unused until P2. */
	reviewModel: string | null;
	scanner: { extraPatterns: ExtraPattern[] };
}

export const DEFAULT_ROOT = "~/.local/share/pi-memory";

const DEFAULTS = {
	root: DEFAULT_ROOT,
	git: true,
	inject: { startChars: 2500, startMax: 25, turnChars: 1200, turnHits: 5 },
	qmd: "auto",
	search: { collections: [] },
	candidates: "off",
	reviewModel: null,
	scanner: { extraPatterns: [] },
} satisfies ConfigObject;

/** qmd collection names that are safe to pass as one argv value: no leading "-", no spaces or slashes. */
export const COLLECTION = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function expandHome(p: string, home = homedir()): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return p;
}

/** `p` with the home folder shown as `~`. */
export function tildePath(p: string, home = homedir()): string {
	return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

const int = (v: unknown, fallback: number, min: number, max: number): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Settings from a raw block (already merged over the defaults), every field checked. */
export function normalize(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): MemorySettings {
	const rootRaw = env.PI_MEMORY_ROOT || (typeof raw.root === "string" && raw.root.trim() ? raw.root.trim() : DEFAULT_ROOT);
	const expanded = expandHome(rootRaw);
	const inject = rec(raw.inject);
	const search = rec(raw.search);
	const scanner = rec(raw.scanner);
	const extra = Array.isArray(scanner.extraPatterns) ? scanner.extraPatterns : [];
	return {
		root: isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded),
		git: raw.git !== false,
		inject: {
			startChars: int(inject.startChars, 2500, 0, 50_000),
			startMax: int(inject.startMax, 25, 0, 500),
			turnChars: int(inject.turnChars, 1200, 0, 50_000),
			turnHits: int(inject.turnHits, 5, 0, 100),
		},
		qmd: raw.qmd === "off" ? "off" : "auto",
		search: {
			collections: (Array.isArray(search.collections) ? search.collections : [])
				.filter((c): c is string => typeof c === "string" && COLLECTION.test(c) && c !== "memory"),
		},
		candidates: raw.candidates === "compaction" ? "compaction" : "off",
		reviewModel: typeof raw.reviewModel === "string" && raw.reviewModel ? raw.reviewModel : null,
		scanner: {
			extraPatterns: extra
				.map((p) => rec(p))
				.filter((p) => typeof p.category === "string" && typeof p.pattern === "string" && p.pattern)
				.map((p) => ({ category: p.category as string, pattern: p.pattern as string, ...(typeof p.flags === "string" ? { flags: p.flags } : {}) })),
		},
	};
}

/** The merged `memory` settings; PI_MEMORY_ROOT overrides the root (tests, one-off runs). */
export function memorySettings(env: NodeJS.ProcessEnv = process.env): MemorySettings {
	return normalize(settingsFor("memory", DEFAULTS as ConfigObject), env);
}
