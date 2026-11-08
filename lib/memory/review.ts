/**
 * What the memory review looks at: a fact is due when nobody ever checked it
 * against the sessions it came from, when that check is older than `days`, when
 * the fact changed after its last check, or when the check contradicted it.
 * Expiry is a separate matter (store.expired, ops.expire): a time-bound fact is
 * in force through its `expires` day and gone after it, not reviewed forever.
 *
 * The review itself is a prompt (extensions/opt-in/memory/review-prompt.md) run
 * by pi-scheduler: this module only decides what is due and prints it, so the
 * decision is testable without a model.
 *
 * Pure node: no pi imports.
 */

import { oneLine } from "./render.ts";
import { dayOf, type Memory, version } from "./store.ts";

export const DEFAULT_REVIEW_DAYS = 14;
/** `/memory` counts facts that stop being true within this many days. */
export const SOON_DAYS = 7;

/** Why a fact is due. */
export type Reason = "never verified" | "contradicted" | "changed since verification" | "verified long ago";

export interface Due {
	memory: Memory;
	reasons: Reason[];
}

export interface ReviewOptions {
	now?: Date;
	days?: number;
}

const DAY_MS = 86_400_000;

/** The reasons `m` is due for a review; empty when it is not (or not active). */
export function reasons(m: Memory, opts: ReviewOptions = {}): Reason[] {
	if (m.state !== "active") return [];
	const days = opts.days ?? DEFAULT_REVIEW_DAYS;
	const now = (opts.now ?? new Date()).getTime();
	if (!m.verified) return ["never verified"];
	const out: Reason[] = [];
	if (m.verified.status === "contradicted") out.push("contradicted");
	// The version the review saw, not the second-precision `updated`: a verify and
	// an edit in the same second must still count as changed. Files written before
	// `verified.of` existed fall back to the timestamp.
	const changed = m.verified.of ? version(m) !== m.verified.of : Date.parse(m.updated) > Date.parse(m.verified.at);
	if (changed) out.push("changed since verification");
	if (now - Date.parse(m.verified.at) > days * DAY_MS) out.push("verified long ago");
	return out;
}

/** Every active fact due for review, in id order (so a run reads the same twice). */
export function due(memories: readonly Memory[], opts: ReviewOptions = {}): Due[] {
	return memories
		.map((memory) => ({ memory, reasons: reasons(memory, opts) }))
		.filter((d) => d.reasons.length > 0)
		.sort((a, b) => (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0));
}

/** One line: id, scope, updated, expires, last verification, text, and why it is due. */
export function line(d: Due): string {
	const m = d.memory;
	const v = m.verified ? `${m.verified.status} ${dayOf(new Date(m.verified.at))}` : "never";
	return `${m.id}  ${m.scope}  updated ${m.updated.slice(0, 10)}  expires ${m.expires ?? "none"}  verified ${v}  ${oneLine(m.text)}  (due: ${d.reasons.join(", ")})`;
}

/** Active facts that stop being true within `days` (today counts as still in force). */
export function expiringSoon(memories: readonly Memory[], opts: ReviewOptions = {}): Memory[] {
	const now = opts.now ?? new Date();
	// Calendar arithmetic, not `now + days * 86_400_000`: across a DST change a
	// day is 23 or 25 hours, and the millisecond sum lands a day short.
	const until = new Date(now);
	until.setDate(until.getDate() + (opts.days ?? SOON_DAYS));
	const last = dayOf(until);
	const today = dayOf(now);
	return memories.filter((m) => m.state === "active" && m.expires !== undefined && m.expires >= today && m.expires <= last);
}

/** Active facts no review ever checked. */
export function neverVerified(memories: readonly Memory[]): Memory[] {
	return memories.filter((m) => m.state === "active" && !m.verified);
}
