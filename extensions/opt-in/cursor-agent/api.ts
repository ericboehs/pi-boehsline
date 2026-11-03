/**
 * Cursor's dashboard API, as the Cursor CLI's own login sees it.
 *
 * Undocumented: the service and method names come from the cursor-agent
 * bundle (aiserver.v1.DashboardService) and may change with any release.
 * Calls use the Connect protocol's JSON form: POST a JSON body, get JSON back.
 *
 * The bearer token is the one `cursor-agent login` stores in the macOS
 * Keychain (service "cursor-access-token", account "cursor-user"). It is read
 * for each call and kept only in memory, never logged, returned or written.
 */

import { execFile } from "node:child_process";

const API = "https://api2.cursor.sh/aiserver.v1.DashboardService";

export interface UsageEvent {
	timestamp: string;
	model: string;
	conversationId?: string;
	chargedCents?: number;
	cursorTokenFee?: number;
	tokenUsage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheWriteTokens?: number;
		cacheReadTokens?: number;
		totalCents?: number;
	};
}

export interface Aggregate {
	totalCostCents?: number;
	totalInputTokens?: string;
	totalOutputTokens?: string;
	totalCacheWriteTokens?: string;
	totalCacheReadTokens?: string;
	aggregations?: { modelIntent: string; totalCents: number }[];
}

export interface Identity {
	teamId: number;
	userId: number;
	email?: string;
	teamName?: string;
}

function readToken(): Promise<string> {
	if (process.platform !== "darwin") {
		return Promise.reject(new Error("Cursor usage lookup needs the macOS Keychain"));
	}
	return new Promise((resolve, reject) => {
		execFile(
			"security",
			["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
			{ timeout: 10_000 },
			(err, stdout) => {
				const token = String(stdout ?? "").trim();
				if (err || !token) reject(new Error("No Cursor login in the Keychain; run `cursor-agent login`"));
				else resolve(token);
			},
		);
	});
}

export async function call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const token = await readToken();
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"Connect-Protocol-Version": "1",
			"x-ghost-mode": "true",
		},
		body: JSON.stringify(body ?? {}),
		signal,
	});
	if (!res.ok) {
		const hint = res.status === 401 ? " (login expired? run `cursor-agent login`)" : "";
		throw new Error(`Cursor ${method} returned HTTP ${res.status}${hint}`);
	}
	return (await res.json()) as T;
}

let identity: Promise<Identity> | undefined;

/** teamId and userId don't change within a session, so look them up once. */
export function me(signal?: AbortSignal): Promise<Identity> {
	identity ??= call<Identity>("GetMe", {}, signal).catch((err) => {
		identity = undefined;
		throw err;
	});
	return identity;
}

/**
 * The usage event for one cursor-agent run. Its conversationId is the
 * session_id from the run's stream-json events. Events can land a few seconds
 * after the run ends, so this polls before giving up.
 */
export async function findUsageEvent(
	sessionId: string,
	sinceMs: number,
	signal?: AbortSignal,
	attempts = 6,
	delayMs = 2_000,
): Promise<UsageEvent | undefined> {
	const { teamId, userId } = await me(signal);
	for (let i = 0; i < attempts; i++) {
		if (signal?.aborted) return undefined;
		const res = await call<{ usageEventsDisplay?: UsageEvent[] }>(
			"GetFilteredUsageEvents",
			{ teamId, userId, startDate: String(sinceMs - 60_000), page: 1, pageSize: 25 },
			signal,
		);
		const hit = res.usageEventsDisplay?.find((e) => e.conversationId === sessionId);
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, delayMs));
	}
	return undefined;
}

export interface CycleUsage {
	start: number;
	end: number;
	spentCents: number;
	limitDollars?: number;
	aggregate: Aggregate;
}

/** This billing cycle's spend and the per-user limit (assumed to be dollars). */
export async function cycleUsage(signal?: AbortSignal): Promise<CycleUsage> {
	const { teamId, userId } = await me(signal);
	const cycle = await call<{ startDateEpochMillis: string; endDateEpochMillis: string }>(
		"GetCurrentBillingCycle",
		{},
		signal,
	);
	const [aggregate, limit] = await Promise.all([
		call<Aggregate>(
			"GetAggregatedUsageEvents",
			{ teamId, userId, startDate: cycle.startDateEpochMillis, endDate: cycle.endDateEpochMillis },
			signal,
		),
		call<{ hardLimitPerUser?: number }>("GetHardLimit", { teamId }, signal),
	]);
	return {
		start: Number(cycle.startDateEpochMillis),
		end: Number(cycle.endDateEpochMillis),
		spentCents: aggregate.totalCostCents ?? 0,
		limitDollars: limit.hardLimitPerUser,
		aggregate,
	};
}

export function eventTokens(e: UsageEvent): number {
	const t = e.tokenUsage ?? {};
	return (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheWriteTokens ?? 0) + (t.cacheReadTokens ?? 0);
}

export function dollars(cents: number): string {
	const d = cents / 100;
	return d < 1 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
}

export function kfmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return String(n);
}
