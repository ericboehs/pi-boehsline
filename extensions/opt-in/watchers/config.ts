/**
 * watchers.toml: a small TOML subset parser and the config it describes.
 *
 * Supported TOML: `# comments`, `[table]`, `[[array-of-tables]]`, and
 * `key = value` where value is a basic or literal string, an integer, a
 * boolean, an array of those, or an inline table of those. That covers the
 * config shape; anything else is a parse error with a line number.
 *
 * Pure node, no pi imports, so tests run under plain `node --test`.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

export const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
/** Passed to every script: gh and GitHub tooling read these. */
export const ENV_PASS_RE = /^(GH|GITHUB)_[A-Za-z0-9_]{1,60}$/;
export const INTERVAL_FLOOR_MS = 30_000;

class Cursor {
	i = 0;
	readonly s: string;
	readonly line: number;
	constructor(s: string, line: number) {
		this.s = s;
		this.line = line;
	}
	ws() {
		while (this.i < this.s.length && (this.s[this.i] === " " || this.s[this.i] === "\t")) this.i++;
	}
	peek() {
		return this.s[this.i];
	}
	fail(msg: string): never {
		throw new Error(`watchers.toml line ${this.line}: ${msg}`);
	}
	rest() {
		this.ws();
		if (this.i < this.s.length && this.s[this.i] !== "#") this.fail(`unexpected "${this.s.slice(this.i, this.i + 10)}"`);
	}
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;

function parseKey(c: Cursor): string[] {
	const parts: string[] = [];
	for (;;) {
		c.ws();
		const ch = c.peek();
		if (ch === '"' || ch === "'") parts.push(parseString(c));
		else {
			const m = BARE_KEY.exec(c.s.slice(c.i));
			if (!m) c.fail("expected a key");
			parts.push(m[0]);
			c.i += m[0].length;
		}
		c.ws();
		if (c.peek() !== ".") return parts;
		c.i++;
	}
}

function parseString(c: Cursor): string {
	const q = c.peek();
	c.i++;
	let out = "";
	while (c.i < c.s.length) {
		const ch = c.s[c.i++] as string;
		if (ch === q) return out;
		if (q === '"' && ch === "\\") {
			const e = c.s[c.i++];
			const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
			if (e && e in map) out += map[e];
			else if (e === "u" || e === "U") {
				const len = e === "u" ? 4 : 8;
				const hex = c.s.slice(c.i, c.i + len);
				if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) c.fail("bad unicode escape");
				out += String.fromCodePoint(Number.parseInt(hex, 16));
				c.i += len;
			} else c.fail("bad escape");
		} else out += ch;
	}
	return c.fail("unterminated string");
}

function parseValue(c: Cursor): TomlValue {
	c.ws();
	const ch = c.peek();
	if (ch === '"' || ch === "'") return parseString(c);
	if (ch === "[") {
		c.i++;
		const arr: TomlValue[] = [];
		for (;;) {
			c.ws();
			if (c.peek() === "]") {
				c.i++;
				return arr;
			}
			arr.push(parseValue(c));
			c.ws();
			if (c.peek() === ",") c.i++;
			else if (c.peek() !== "]") c.fail("expected , or ] in array");
		}
	}
	if (ch === "{") {
		c.i++;
		const t: TomlTable = {};
		c.ws();
		if (c.peek() === "}") {
			c.i++;
			return t;
		}
		for (;;) {
			const key = parseKey(c);
			if (c.peek() !== "=") c.fail("expected =");
			c.i++;
			setPath(t, key, parseValue(c), c);
			c.ws();
			if (c.peek() === ",") c.i++;
			else if (c.peek() === "}") {
				c.i++;
				return t;
			} else c.fail("expected , or } in inline table");
		}
	}
	const m = /^(true|false|[+-]?\d[\d_]*)(?=[\s,\]}#]|$)/.exec(c.s.slice(c.i));
	if (!m) c.fail("unsupported value");
	c.i += m[0].length;
	if (m[0] === "true") return true;
	if (m[0] === "false") return false;
	return Number(m[0].replace(/_/g, ""));
}

function isTable(v: unknown): v is TomlTable {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function setPath(t: TomlTable, key: string[], value: TomlValue, c: Cursor) {
	let cur = t;
	for (const part of key.slice(0, -1)) {
		const next = cur[part] ?? (cur[part] = {});
		if (!isTable(next)) c.fail(`${part} is not a table`);
		cur = next;
	}
	const last = key.at(-1) as string;
	if (last in cur) c.fail(`duplicate key ${key.join(".")}`);
	cur[last] = value;
}

/** Parse the supported TOML subset. Throws with a line number on anything else. */
export function parseToml(text: string): TomlTable {
	const root: TomlTable = {};
	let cur = root;
	const lines = text.split(/\r?\n/);
	for (let n = 0; n < lines.length; n++) {
		const c: Cursor = new Cursor(lines[n] as string, n + 1);
		c.ws();
		if (c.i >= c.s.length || c.peek() === "#") continue;
		if (c.s.startsWith("[[", c.i)) {
			c.i += 2;
			const key = parseKey(c);
			if (!c.s.startsWith("]]", c.i)) c.fail("expected ]]");
			c.i += 2;
			c.rest();
			let parent = root;
			for (const part of key.slice(0, -1)) {
				const next = parent[part] ?? (parent[part] = {});
				if (!isTable(next)) c.fail(`${part} is not a table`);
				parent = next;
			}
			const last = key.at(-1) as string;
			const arr = parent[last] ?? (parent[last] = []);
			if (!Array.isArray(arr)) c.fail(`${last} is not an array of tables`);
			const t: TomlTable = {};
			arr.push(t);
			cur = t;
			continue;
		}
		if (c.peek() === "[") {
			c.i++;
			const key = parseKey(c);
			if (c.peek() !== "]") c.fail("expected ]");
			c.i++;
			c.rest();
			let t = root;
			for (const part of key) {
				const next = t[part] ?? (t[part] = {});
				if (!isTable(next)) c.fail(`${part} is not a table`);
				t = next;
			}
			cur = t;
			continue;
		}
		const key = parseKey(c);
		if (c.peek() !== "=") c.fail("expected =");
		c.i++;
		setPath(cur, key, parseValue(c), c);
		c.rest();
	}
	return root;
}

// ── the config ──

export interface GuardianConfig {
	/**
	 * Session provider -> judge "provider/id". The judge follows the session's
	 * current model provider, re-resolved at each batch. No default ships.
	 */
	byProvider: Record<string, string>;
	/** Used when the session provider isn't mapped or its judge can't run. Must be approved. */
	fallback?: string;
	approved: string[];
	fail: "closed";
	/** Guardian calls allowed per watcher per hour. */
	callsPerHour: number;
}

export interface WatcherConfig {
	id: string;
	command: string[];
	matchCwd: string;
	intervalMs: number;
	me: string;
	wake: "actionable" | "never";
	urlHosts: string[];
	/** Local quiet hours, [startHour, endHour): wakes become silent lines. */
	quiet: [number, number];
	/** The table as written, passed to the script on stdin. */
	raw: TomlTable;
}

export interface WatchersConfig {
	guardian: GuardianConfig;
	watchers: WatcherConfig[];
	/** Problems that dropped a watcher or a setting; shown in /watchers. */
	warnings: string[];
}

export function expandHome(p: string, home = homedir()): string {
	return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

export function parseInterval(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v * 1000;
	if (typeof v !== "string") return undefined;
	const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(v.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[(m[2] ?? "s") as "ms" | "s" | "m" | "h"];
}

function parseQuiet(v: unknown): [number, number] | undefined {
	if (v === undefined) return [22, 7];
	if (v === false || v === "off") return [0, 0];
	const m = typeof v === "string" ? /^(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?$/.exec(v.trim()) : null;
	if (!m) return undefined;
	const a = Number(m[1]);
	const b = Number(m[2]);
	return a < 24 && b < 24 ? [a, b] : undefined;
}

const strings = (v: unknown): string[] | undefined =>
	Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

export function buildConfig(t: TomlTable, home = homedir()): WatchersConfig {
	const warnings: string[] = [];
	const g = isTable(t.guardian) ? t.guardian : {};
	if (g.fail !== undefined && g.fail !== "closed") warnings.push(`guardian.fail = "${String(g.fail)}" is not supported; failing closed`);
	const approved = strings(g.approved) ?? [];
	const isRef = (v: unknown): v is string => typeof v === "string" && /^[^/\s]+\/[^\s]+$/.test(v);
	const byProvider: Record<string, string> = {};
	if (g.by_provider !== undefined && !isTable(g.by_provider)) warnings.push("guardian.by_provider must be an inline table of provider = \"provider/id\"; ignored");
	for (const [provider, ref] of Object.entries(isTable(g.by_provider) ? g.by_provider : {})) {
		if (!isRef(ref)) warnings.push(`guardian.by_provider.${provider} must be "provider/id"; ignored`);
		else if (!approved.includes(ref)) warnings.push(`guardian.by_provider.${provider} = "${ref}" is not on guardian.approved; ignored`);
		else byProvider[provider] = ref;
	}
	let fallback: string | undefined;
	const fb = g.fallback ?? g.model;
	if (g.model !== undefined) warnings.push("guardian.model is deprecated; use guardian.fallback (and guardian.by_provider)");
	if (g.fallback !== undefined && g.model !== undefined) warnings.push("guardian.model ignored: guardian.fallback is set");
	if (fb !== undefined) {
		if (!isRef(fb)) warnings.push(`guardian.fallback must be "provider/id"; ignored`);
		else if (!approved.includes(fb)) warnings.push(`guardian.fallback = "${fb}" is not on guardian.approved; ignored`);
		else fallback = fb;
	}
	const guardian: GuardianConfig = {
		byProvider,
		fallback,
		approved,
		fail: "closed",
		callsPerHour: typeof g.calls_per_hour === "number" && g.calls_per_hour > 0 ? Math.min(g.calls_per_hour, 200) : 200,
	};
	const list = Array.isArray(t.watcher) ? t.watcher : [];
	const watchers: WatcherConfig[] = [];
	const ids = new Set<string>();
	for (const [n, w] of list.entries()) {
		if (!isTable(w)) continue;
		const where = `watcher ${typeof w.id === "string" ? w.id : `#${n + 1}`}`;
		const id = typeof w.id === "string" && ID_RE.test(w.id) ? w.id : undefined;
		if (!id) {
			warnings.push(`${where}: id must match ${ID_RE.source}; skipped`);
			continue;
		}
		if (ids.has(id)) {
			warnings.push(`${where}: duplicate id; skipped`);
			continue;
		}
		const command = strings(w.command);
		if (!command?.length) {
			warnings.push(`${where}: command must be a non-empty array of strings; skipped`);
			continue;
		}
		const match = isTable(w.match) ? w.match : {};
		if (typeof match.cwd !== "string" || !match.cwd) {
			warnings.push(`${where}: match.cwd is required; skipped`);
			continue;
		}
		let intervalMs = parseInterval(w.interval ?? "60s");
		if (intervalMs === undefined) {
			warnings.push(`${where}: bad interval; using 60s`);
			intervalMs = 60_000;
		}
		const wake = w.wake === "never" ? "never" : "actionable";
		if (w.wake !== undefined && w.wake !== "never" && w.wake !== "actionable") warnings.push(`${where}: wake must be actionable or never; using actionable`);
		if (w.pass_env !== undefined) warnings.push(`${where}: pass_env is no longer needed (GH_* and GITHUB_* always pass); ignored`);
		const me = typeof w.me === "string" ? w.me : "";
		if (!me) warnings.push(`${where}: me is empty, so the actor check is off and your own activity can wake the agent`);
		let quiet = parseQuiet(w.quiet_hours);
		if (!quiet) {
			warnings.push(`${where}: quiet_hours must look like "22-07"; using 22-07`);
			quiet = [22, 7];
		}
		ids.add(id);
		watchers.push({
			id,
			command: [expandHome(command[0] as string, home), ...command.slice(1)],
			matchCwd: expandHome(match.cwd, home),
			intervalMs: Math.max(INTERVAL_FLOOR_MS, intervalMs),
			me,
			wake,
			urlHosts: (strings(w.url_hosts) ?? ["github.com"]).map((h) => h.toLowerCase()),
			quiet,
			raw: w,
		});
	}
	return { guardian, watchers, warnings };
}

export interface LoadResult extends WatchersConfig {
	path: string;
	missing?: boolean;
	error?: string;
}

const EMPTY_GUARDIAN: GuardianConfig = { byProvider: {}, approved: [], fail: "closed", callsPerHour: 200 };

/** Read and parse the config file. Never throws; problems land in `error` or `warnings`. */
export function loadConfig(path: string, home = homedir()): LoadResult {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { path, missing: true, guardian: { ...EMPTY_GUARDIAN, byProvider: {} }, watchers: [], warnings: [] };
	}
	// The mode warning comes first, and even when the file doesn't parse.
	const modeWarnings: string[] = [];
	try {
		if ((statSync(path).mode & 0o077) !== 0) modeWarnings.push(`${path} is readable by others; chmod 600 it`);
	} catch {
		// raced away; the text is already read
	}
	try {
		const cfg = buildConfig(parseToml(text), home);
		return { path, ...cfg, warnings: [...modeWarnings, ...cfg.warnings] };
	} catch (e) {
		return { path, error: (e as Error).message, guardian: { ...EMPTY_GUARDIAN, byProvider: {} }, watchers: [], warnings: modeWarnings };
	}
}

/** realpath that falls back to path.resolve for paths that don't exist. */
export function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/** The session cwd is the match path or inside it (after realpath on both). */
export function matchesCwd(matchCwd: string, cwd: string): boolean {
	const base = real(matchCwd);
	const here = real(cwd);
	return here === base || here.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * command[0] must be an absolute path to a file the user owns that nobody
 * else can write, in folders only the user or root can change (a sticky,
 * world-writable folder like /tmp is fine: others can't replace your
 * entries there). Returns why not, or undefined when it's fine. Checked at
 * start and again before every run.
 */
export function commandProblem(cmd0: string, uid = process.getuid?.() ?? -1): string | undefined {
	if (!isAbsolute(cmd0)) return `command[0] must be an absolute path (got ${cmd0})`;
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(cmd0);
	} catch {
		return `command[0] not found: ${cmd0}`;
	}
	if (!st.isFile()) return `command[0] is not a file: ${cmd0}`;
	if (uid >= 0 && st.uid !== uid) return `command[0] is not owned by you: ${cmd0}`;
	if (st.mode & 0o022) return `command[0] is group- or world-writable: ${cmd0}`;
	// Both the folders as written and the real ones (after symlinks).
	for (const start of new Set([dirname(cmd0), dirname(real(cmd0))])) {
		for (let dir = start; ; dir = dirname(dir)) {
			let d: ReturnType<typeof statSync>;
			try {
				d = statSync(dir);
			} catch {
				return `command[0]'s folder can't be checked: ${dir}`;
			}
			if (uid >= 0 && d.uid !== uid && d.uid !== 0) return `command[0]'s folder ${dir} is not owned by you or root`;
			if (d.mode & 0o022 && !(d.mode & 0o1000)) return `command[0]'s folder ${dir} is group- or world-writable`;
			if (dirname(dir) === dir) break;
		}
	}
	return undefined;
}

/** Pick the guardian's judge for the session's current provider. */
export interface JudgeChoice {
	/** "provider/id" to call, or undefined when the guardian is unavailable. */
	model?: string;
	/** Why this judge (or why none), for /watchers. */
	reason: string;
}

/**
 * `problem(ref)` says why an approved model can't run right now (not found,
 * no credentials), or undefined when it can. An unmapped provider or a
 * mapped judge that can't run goes to `fallback` if set; never to another
 * provider's mapping.
 */
export function pickJudge(g: GuardianConfig, provider: string | undefined, problem: (ref: string) => string | undefined): JudgeChoice {
	const ok = (ref: string) => g.approved.includes(ref) && !problem(ref);
	const why = (ref: string) => (g.approved.includes(ref) ? problem(ref) : "not on guardian.approved");
	const mapped = provider ? g.byProvider[provider] : undefined;
	const session = `session provider ${provider ?? "unknown"}`;
	if (mapped && ok(mapped)) return { model: mapped, reason: session };
	const miss = mapped ? `${mapped}: ${why(mapped)}` : `${session} is not in guardian.by_provider`;
	if (g.fallback && ok(g.fallback)) return { model: g.fallback, reason: `fallback; ${miss}` };
	return { reason: g.fallback ? `${miss}; fallback ${g.fallback}: ${why(g.fallback)}` : `${miss}; no guardian.fallback` };
}
