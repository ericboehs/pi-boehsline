/**
 * Cursor's billing-cycle spend in pi's shared usage cache
 * (~/.pi/agent/usage-cache.json, the file provider-usage writes), so tools
 * that only read the cache, like the pi-usage CLI, list Cursor with the
 * other providers.
 *
 * Written after each cursor tool run (a fire-and-forget refresh) and on
 * /cursor-usage. Never polled. The write merges only the `cursor-usage` key
 * and is atomic (temp file, then rename), as provider-usage's own is.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CycleUsage, cycleUsage, dollars } from "./api.ts";

export const CACHE_KEY = "cursor-usage";

export interface CursorCacheEntry {
	value: string;
	commandText: string;
	resetMs: number;
	fetchedAt: number;
	quota: { spentCents: number; limitDollars?: number; cycleStart: number; cycleEnd: number };
}

/** Billing-cycle figures for the footer chip (from cache quota or API). */
export interface CycleChipFigures {
	spentCents: number;
	limitDollars?: number;
}

/** Shared session state for the cursor footer chip (cursor tool session spend + last cycle read). */
export const cursorChipSession: { sessionCents: number; lastCycle?: CycleChipFigures } = { sessionCents: 0 };

/** provider-usage's path: $PI_CODING_AGENT_DIR (default ~/.pi/agent)/usage-cache.json. */
export function usageCachePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "usage-cache.json");
}

const pct = (u: CycleUsage) => ((u.spentCents / ((u.limitDollars ?? 0) * 100)) * 100).toFixed(1);
const formatLimitDollars = (d: number) => (Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`);
const chipSpent = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const chipPct = (spentCents: number, limitDollars: number) =>
	String(Math.round((spentCents / (limitDollars * 100)) * 100));

function finiteNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Footer status text: billing cycle first, optional this-session spend after. */
export function statusChipText(figures: CycleChipFigures, sessionCents = 0, withPercent = true): string {
	const spent = chipSpent(figures.spentCents);
	let text: string;
	if (figures.limitDollars) {
		const pctSuffix = withPercent ? ` (${chipPct(figures.spentCents, figures.limitDollars)}%)` : "";
		text = `cursor ${spent}/${formatLimitDollars(figures.limitDollars)}${pctSuffix}`;
	} else {
		text = `cursor ${spent}`;
	}
	if (sessionCents > 0) text += ` · +${chipSpent(sessionCents)} here`;
	return text;
}

/** Read cycle spend/limit from the shared cache file; never throws. */
export async function readCycleFromCache(file = usageCachePath()): Promise<CycleChipFigures | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const entry = (parsed as Record<string, unknown>)[CACHE_KEY];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		const quota = (entry as { quota?: unknown }).quota;
		if (!quota || typeof quota !== "object" || Array.isArray(quota)) return undefined;
		const spentCents = finiteNumber((quota as { spentCents?: unknown }).spentCents);
		if (spentCents === undefined) return undefined;
		const limitDollars = finiteNumber((quota as { limitDollars?: unknown }).limitDollars);
		return limitDollars === undefined ? { spentCents } : { spentCents, limitDollars };
	} catch {
		return undefined;
	}
}

export function applyCursorStatusChip(
	ctx: { ui: { setStatus(key: string, value?: string): void } },
	session = cursorChipSession,
): void {
	if (!session.lastCycle) {
		if (session.sessionCents <= 0) ctx.ui.setStatus("cursor", undefined);
		else ctx.ui.setStatus("cursor", `cursor +${chipSpent(session.sessionCents)} here`);
		return;
	}
	ctx.ui.setStatus("cursor", statusChipText(session.lastCycle, session.sessionCents));
}

/** Re-read the cache file and paint the chip; never throws. */
export async function syncChipFromCacheFile(
	ctx: { ui: { setStatus(key: string, value?: string): void } },
	session = cursorChipSession,
	file?: string,
): Promise<void> {
	const fig = await readCycleFromCache(file);
	if (fig) session.lastCycle = fig;
	applyCursorStatusChip(ctx, session);
}

/** Re-read the cache and paint the chip; optionally refresh from the API first. Never throws. */
export async function refreshCursorStatusChip(
	ctx: { ui: { setStatus(key: string, value?: string): void } },
	session = cursorChipSession,
	opts: { file?: string; fetch?: boolean } = {},
): Promise<void> {
	try {
		if (opts.fetch !== false) await refreshUsageCache(undefined, opts.file);
		await syncChipFromCacheFile(ctx, session, opts.file);
	} catch {
		// best-effort
	}
}

/** The /cursor-usage notification; `sessionCents` adds this session's spend. */
export function cycleText(u: CycleUsage, nowMs = Date.now(), sessionCents = 0): string {
	const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
	const left = Math.max(0, Math.ceil((u.end - nowMs) / 86_400_000));
	const limit = u.limitDollars ? ` of $${u.limitDollars} (${pct(u)}%)` : "";
	const models = [...(u.aggregate.aggregations ?? [])]
		.sort((a, b) => b.totalCents - a.totalCents)
		.map((m) => `${m.modelIntent} ${dollars(m.totalCents)}`)
		.join(", ");
	const session = sessionCents ? ` · this session ${dollars(sessionCents)}` : "";
	return `Cursor ${day(u.start)}–${day(u.end)} (${left}d left): ${dollars(u.spentCents)}${limit}${session}${models ? `\n${models}` : ""}`;
}

/** The cache entry: value like "$0.65 / $200 (0.3%)", or "$0.65" with no limit. */
export function cacheEntry(u: CycleUsage, nowMs = Date.now()): CursorCacheEntry {
	const spent = `$${(u.spentCents / 100).toFixed(2)}`;
	return {
		value: u.limitDollars ? `${spent} / ${formatLimitDollars(u.limitDollars)} (${pct(u)}%)` : spent,
		commandText: cycleText(u, nowMs),
		resetMs: u.end,
		fetchedAt: nowMs,
		quota: {
			spentCents: u.spentCents,
			...(u.limitDollars ? { limitDollars: u.limitDollars } : {}),
			cycleStart: u.start,
			cycleEnd: u.end,
		},
	};
}

/** Merge `entry` under `cursor-usage`, keeping every other key; atomic. */
export async function writeCacheEntry(entry: CursorCacheEntry, file = usageCachePath()): Promise<void> {
	let current: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
	} catch {
		// Missing or unreadable: start fresh, as provider-usage does.
	}
	current[CACHE_KEY] = entry;
	const tmp = `${file}.tmp.${process.pid}.cursor`;
	await writeFile(tmp, JSON.stringify(current));
	await rename(tmp, file);
}

/** Best-effort write of usage already fetched; never throws. */
export async function recordCycleUsage(u: CycleUsage, file?: string): Promise<void> {
	try {
		await writeCacheEntry(cacheEntry(u), file);
	} catch {
		// The cache is best-effort.
	}
}

/** Fetch this cycle's usage and write it; never throws. Call with `void`. */
export async function refreshUsageCache(load: () => Promise<CycleUsage> = cycleUsage, file?: string): Promise<void> {
	try {
		await recordCycleUsage(await load(), file);
	} catch {
		// No login, offline, API change: skip; the next run tries again.
	}
}
