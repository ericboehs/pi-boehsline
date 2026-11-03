/**
 * The current provider's usage windows as data, for other extensions (botsun-owner sends them
 * to Eric's phone). provider-usage publishes whenever it paints or clears a window chip, so the
 * numbers are there whether or not the footer's usage chip is shown. One snapshot per process:
 * a pi session runs one model, so one provider at a time.
 */

export interface UsageWindowSnapshot {
	/** Short name: "5h", "week", "opus week", "premium". */
	label: string;
	/** 0-100, rounded to a whole number. */
	percent: number;
	/** ISO time (or YYYY-MM-DD date) the window resets; absent when unknown. */
	resets_at?: string;
}

export interface ProviderUsageSnapshot {
	/** Display name: "Claude", "Copilot", "Codex", "Grok". */
	provider: string;
	windows: UsageWindowSnapshot[];
	/** Requests are being billed to extra usage (Claude's overage alarm). */
	extra_usage?: boolean;
	/** The numbers are old: the last fetch failed, or nothing refreshed for a while. */
	stale?: boolean;
}

const KEY = "__boehslineUsageSnapshot";

interface Store {
	usage: ProviderUsageSnapshot | null;
	signature: string;
	listeners: Set<() => void>;
}

function store(): Store {
	const g = globalThis as unknown as { [KEY]?: Store };
	g[KEY] ??= { usage: null, signature: "null", listeners: new Set() };
	return g[KEY];
}

/** Publish (or clear, with null). Listeners run only when the data changed. */
export function publishUsage(usage: ProviderUsageSnapshot | null): void {
	const s = store();
	const signature = JSON.stringify(usage);
	if (signature === s.signature) return;
	s.signature = signature;
	s.usage = usage;
	for (const fn of s.listeners) {
		try {
			fn();
		} catch {}
	}
}

export function latestUsage(): ProviderUsageSnapshot | null {
	return store().usage;
}

/** Called after every change. Returns the unsubscribe. */
export function onUsageChange(fn: () => void): () => void {
	store().listeners.add(fn);
	return () => store().listeners.delete(fn);
}
