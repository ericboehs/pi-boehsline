/**
 * op-broker's core: which reads need a card, the card's words, and the grants a card leaves.
 * No pi and no sockets here, so the tests drive it directly.
 *
 * A grant is per session (this process) and per item: "Allow for 1 hour" on GitHub's token
 * covers every field of that item for an hour. "Allow once" covers the one read. Cards are shown
 * one at a time; a read that arrives while a card is up waits, then rides a grant if the card
 * left one.
 */

import { REF_PARTS } from "./validate.mjs";

export type Kind = "read" | "otp" | "fields" | "whoami";
export interface OpRequest {
	kind: Kind;
	ref?: string;
	item?: string;
	vault?: string;
	fields?: string[];
	account?: string;
	command?: string; // the command line the read is for, as the shim saw it
}
export interface Reply {
	ok: boolean;
	value?: string;
	error?: string;
}
export type Decision = "once" | "1h" | "8h" | "deny";

export const CHOICES: Array<[string, Decision]> = [
	["Allow once", "once"],
	["Allow for 1 hour", "1h"],
	["Allow for 8 hours", "8h"],
	["Deny", "deny"],
];
const HOUR = 3_600_000;
const GRANT_MS: Record<string, number> = { "1h": HOUR, "8h": 8 * HOUR };
const MAX_COMMAND = 200;

/** op://Vault/Item[/section]/field → its parts, or null. */
export function parseRef(ref: string): { vault: string; item: string; field: string } | null {
	// The shim's and daemon's REF, its parts captured (validate.mjs). The one query op-broker takes
	// is ?attribute=otp|totp; anything else isn't parsed (the card shows the raw ref).
	const m = REF_PARTS.exec(ref);
	if (!m) return null;
	const [, vault = "", item = "", section, field = "", query] = m;
	return { vault, item, field: query ? "one-time code" : section ? `${section} › ${field}` : field };
}

/** What a grant covers: the account, the vault ("*" when the read didn't name one) and the item. */
export function grantKey(req: OpRequest): string | null {
	const acct = (req.account ?? "").toLowerCase();
	if (req.kind === "read") {
		const r = req.ref ? parseRef(req.ref) : null;
		return r ? JSON.stringify([acct, r.vault.toLowerCase(), r.item.toLowerCase()]) : null;
	}
	// No vault named: its own key (null), never a named vault's.
	if (req.kind === "otp" || req.kind === "fields") return req.item ? JSON.stringify([acct, req.vault?.toLowerCase() ?? null, req.item.toLowerCase()]) : null;
	return null;
}

/** The card's title: what's asked, in plain words, and what it's for. */
export function cardTitle(req: OpRequest): string {
	let what: string;
	if (req.kind === "read" && req.ref) {
		const r = parseRef(req.ref);
		what = r ? `${r.item} · ${r.field} (${r.vault})` : req.ref;
	} else if (req.kind === "otp") what = `${req.item} · one-time code${req.vault ? ` (${req.vault})` : ""}`;
	else what = `${req.item} · ${(req.fields ?? []).join(", ")}${req.vault ? ` (${req.vault})` : ""}`;
	const acct = req.account ? ` [${req.account}]` : "";
	const cmd = oneLine(req.command ?? "");
	return `🔑 1Password: ${what}${acct}${cmd ? `\nfor: ${cmd}` : ""}`;
}

function oneLine(s: string): string {
	const flat = maskSecrets(s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim());
	return flat.length > MAX_COMMAND ? `${flat.slice(0, MAX_COMMAND - 1)}…` : flat;
}

// A value: quoted, or a run up to whitespace, a quote or a shell separator.
const VALUE = `(?:"[^"]*"?|'[^']*'?|[^\\s"'&;|]+)`;
// A secret-looking name (GITHUB_TOKEN=, --api-key, password:, "token": …) and its value; an
// Authorization header's scheme goes with its value.
const NAMED = new RegExp(`((?:token|key|secret|passw(?:or)?d|pwd|auth)[\\w-]*["']?\\s*[=:]\\s*)(?:(?:Bearer|Basic|Token)\\s+)?${VALUE}`, "gi");
const BEARER = new RegExp(`\\b(Bearer|Basic)\\s+${VALUE}`, "gi");

/**
 * The command line with likely inline secrets masked (•••): the card's title goes to the phone
 * and to a push notification, and a command line can carry a token (TOKEN=… cmd, curl -H
 * "Authorization: Bearer …", --password=…). Best effort: the names op-broker can guess.
 */
export function maskSecrets(s: string): string {
	return s.replace(NAMED, "$1•••").replace(BEARER, "$1 •••");
}

export interface BrokerDeps {
	/** Show the card; undefined (dismissed, timed out, no UI) means deny. */
	ask(title: string, req: OpRequest): Promise<Decision | undefined>;
	/** Run the read through the daemon. */
	daemon(req: OpRequest): Promise<Reply>;
	now?(): number;
}

export class Broker {
	private grants = new Map<string, number>(); // key → expires at (ms)
	private generation = 0; // bumped by revoke: a card answered after it leaves no grant
	private queue: Promise<unknown> = Promise.resolve();
	private readonly now: () => number;
	private readonly deps: BrokerDeps;

	constructor(deps: BrokerDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	async handle(req: OpRequest): Promise<Reply> {
		if (req.kind === "whoami") return this.deps.daemon(req);
		const key = grantKey(req);
		if (!key) return { ok: false, error: "op-broker: not a read it takes" };
		if (this.live(key)) return this.deps.daemon(req);
		// One card at a time; a grant the card before left may cover this read. The generation is
		// the one this read arrived in: a revoke (the session ended) while it waited refuses it, so
		// its card never shows in the next session.
		const gen = this.generation;
		const turn = this.queue.then(async () => {
			if (gen !== this.generation) return false;
			if (this.live(key)) return true;
			const decision = await this.deps.ask(cardTitle(req), req).catch(() => undefined);
			if (!decision || decision === "deny" || gen !== this.generation) return false;
			if (GRANT_MS[decision]) this.grants.set(key, this.now() + GRANT_MS[decision]);
			return true;
		});
		this.queue = turn.catch(() => {});
		if (!(await turn)) return { ok: false, error: "op-broker: not approved" };
		return this.deps.daemon(req);
	}

	private live(key: string): boolean {
		const until = this.grants.get(key);
		if (until === undefined) return false;
		if (until > this.now()) return true;
		this.grants.delete(key);
		return false;
	}

	/** Live grants, soonest to end first: [key, ms left]. */
	list(): Array<[string, number]> {
		const now = this.now();
		return [...this.grants].filter(([, t]) => t > now).map(([k, t]): [string, number] => [k, t - now]).sort((a, b) => a[1] - b[1]);
	}

	revoke(): number {
		const n = this.list().length;
		this.grants.clear();
		this.generation++;
		return n;
	}
}
