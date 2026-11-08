/**
 * The YAML front matter subset pi-memory files use, without a YAML dependency:
 * one `key: value` per line, where a value is a scalar (plain or double-quoted),
 * a flow list (`[a, "b c"]`) or one level of flow map (`{ kind: cli, cwd: "~/x" }`).
 * A ` #` comment after a plain value is dropped, so hand-edited files keep working.
 *
 * Two of the fields a memory may carry have a shape of their own and are
 * checked here rather than left as loose text: `expires` (a YYYY-MM-DD day, the
 * fact is in force through it) and `verified` (a one-level flow map recording
 * the review that checked the fact against the sessions it came from). Both are
 * optional; a file without them parses as it always did.
 *
 * Pure node: no pi imports.
 */

export type Scalar = string | number | boolean | null;
export type Value = Scalar | Scalar[] | Record<string, Scalar>;
export type Fields = Record<string, Value>;

export const VERIFIED_STATUSES = ["confirmed", "contradicted", "unverifiable"] as const;
export type VerifiedStatus = (typeof VERIFIED_STATUSES)[number];

/** How a fact was checked: when, how it came out, by what, and the short evidence. */
export interface Verified {
	/** ISO time of the check. */
	at: string;
	status: VerifiedStatus;
	/** The model id that checked it, or `user`. */
	by: string;
	/** Session id(s) and one line of why, at most a few hundred characters. */
	evidence: string;
	/**
	 * The fact's version when it was checked (store.version: a short hash of its
	 * text and expiry), so "changed since verification" doesn't depend on the
	 * second-precision `updated`. Absent in files written before it existed.
	 */
	of?: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day written YYYY-MM-DD, or undefined. */
export function parseDay(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const m = DAY.exec(v.trim());
	if (!m) return undefined;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? v.trim() : undefined;
}

/** The `verified` map, when it holds a known status and a real time; undefined otherwise. */
export function parseVerified(v: unknown): Verified | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const m = v as Record<string, unknown>;
	const status = m.status;
	if (typeof status !== "string" || !(VERIFIED_STATUSES as readonly string[]).includes(status)) return undefined;
	if (typeof m.at !== "string" || !Number.isFinite(Date.parse(m.at))) return undefined;
	return {
		at: m.at,
		status: status as VerifiedStatus,
		by: typeof m.by === "string" ? m.by : "",
		evidence: typeof m.evidence === "string" ? m.evidence : "",
		...(typeof m.of === "string" && m.of ? { of: m.of } : {}),
	};
}

/** The flow map a `verified` field is written as. */
export function verifiedField(v: Verified): Record<string, Scalar> {
	return { at: v.at, status: v.status, by: v.by, evidence: v.evidence, ...(v.of ? { of: v.of } : {}) };
}

export interface Parsed {
	fields: Fields;
	body: string;
}

const OPEN = "---\n";

/** Plain YAML-safe in both block and flow context: no spaces, quotes, commas, brackets, "#" or ": ". */
const PLAIN = /^[A-Za-z0-9._/@~+-](?:[A-Za-z0-9._/@~+:-]*[A-Za-z0-9._/@~+-])?$/;
const KEYWORD = /^(?:null|true|false|~|-?\d+(?:\.\d+)?)$/i;

function scalarOut(v: Scalar): string {
	if (v === null) return "null";
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return PLAIN.test(v) && !KEYWORD.test(v) ? v : JSON.stringify(v);
}

export function serialize(fields: Fields, body: string): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error(`bad front matter key: ${key}`);
		let out: string;
		if (Array.isArray(value)) out = `[${value.map(scalarOut).join(", ")}]`;
		else if (value !== null && typeof value === "object") {
			const parts = Object.entries(value)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => {
					if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error(`bad front matter key: ${key}.${k}`);
					return `${k}: ${scalarOut(v)}`;
				});
			out = `{ ${parts.join(", ")} }`;
		} else out = scalarOut(value);
		lines.push(`${key}: ${out}`);
	}
	lines.push("---");
	return `${lines.join("\n")}\n${body.replace(/\s+$/, "")}\n`;
}

/** A cursor over one value's text. */
class Reader {
	i = 0;
	readonly s: string;
	constructor(s: string) {
		this.s = s;
	}
	ws() {
		while (this.i < this.s.length && (this.s[this.i] === " " || this.s[this.i] === "\t")) this.i++;
	}
	peek() {
		return this.s[this.i];
	}
	done() {
		this.ws();
		return this.i >= this.s.length || this.s[this.i] === "#";
	}
}

function quoted(r: Reader): string {
	const start = r.i;
	r.i++;
	while (r.i < r.s.length && r.s[r.i] !== '"') r.i += r.s[r.i] === "\\" ? 2 : 1;
	if (r.i >= r.s.length) throw new Error("unterminated string");
	r.i++;
	return JSON.parse(r.s.slice(start, r.i)) as string;
}

function single(r: Reader): string {
	r.i++;
	let out = "";
	while (r.i < r.s.length) {
		if (r.s[r.i] === "'") {
			if (r.s[r.i + 1] === "'") {
				out += "'";
				r.i += 2;
				continue;
			}
			r.i++;
			return out;
		}
		out += r.s[r.i++];
	}
	throw new Error("unterminated string");
}

function plain(text: string): Scalar {
	const t = text.trim();
	if (t === "null" || t === "~" || t === "") return null;
	if (t === "true") return true;
	if (t === "false") return false;
	if (/^-?\d+$/.test(t) && Number.isSafeInteger(Number(t))) return Number(t);
	return t;
}

/** A scalar, stopping at any of `stops` (flow context) or a " #" comment. */
function scalar(r: Reader, stops: string): Scalar {
	r.ws();
	if (r.peek() === '"') return quoted(r);
	if (r.peek() === "'") return single(r);
	const start = r.i;
	while (r.i < r.s.length && !stops.includes(r.s[r.i]!) && !(r.s[r.i] === "#" && /\s/.test(r.s[r.i - 1] ?? " "))) r.i++;
	return plain(r.s.slice(start, r.i));
}

function list(r: Reader): Scalar[] {
	r.i++;
	const out: Scalar[] = [];
	r.ws();
	if (r.peek() === "]") {
		r.i++;
		return out;
	}
	for (;;) {
		const v = scalar(r, ",]");
		if (v !== null) out.push(v);
		r.ws();
		const c = r.s[r.i++];
		if (c === "]") return out;
		if (c !== ",") throw new Error("bad list");
	}
}

function map(r: Reader): Record<string, Scalar> {
	r.i++;
	const out: Record<string, Scalar> = {};
	r.ws();
	if (r.peek() === "}") {
		r.i++;
		return out;
	}
	for (;;) {
		r.ws();
		const m = /^([A-Za-z_][\w-]*)\s*:/.exec(r.s.slice(r.i));
		if (!m) throw new Error("bad map key");
		r.i += m[0].length;
		out[m[1]!] = scalar(r, ",}");
		r.ws();
		const c = r.s[r.i++];
		if (c === "}") return out;
		if (c !== ",") throw new Error("bad map");
	}
}

function value(text: string): Value {
	const r = new Reader(text);
	r.ws();
	let v: Value;
	if (r.peek() === "[") v = list(r);
	else if (r.peek() === "{") v = map(r);
	else v = scalar(r, "");
	if (!r.done()) throw new Error("trailing text");
	return v;
}

/** Fields and body, or null when the text has no well-formed front matter. */
export function parse(text: string): Parsed | null {
	const src = text.replace(/\r\n/g, "\n");
	if (!src.startsWith(OPEN)) return null;
	const end = src.indexOf("\n---", OPEN.length - 1);
	if (end < 0) return null;
	const after = src.slice(end + 4);
	if (after !== "" && !after.startsWith("\n")) return null;
	const fields: Fields = {};
	for (const line of src.slice(OPEN.length, end + 1).split("\n")) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
		if (!m) return null;
		try {
			fields[m[1]!] = value(m[2] ?? "");
		} catch {
			return null;
		}
	}
	return { fields, body: after.replace(/^\n/, "").replace(/\s+$/, "") };
}
