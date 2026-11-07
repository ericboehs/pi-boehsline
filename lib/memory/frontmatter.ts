/**
 * The YAML front matter subset pi-memory files use, without a YAML dependency:
 * one `key: value` per line, where a value is a scalar (plain or double-quoted),
 * a flow list (`[a, "b c"]`) or one level of flow map (`{ kind: cli, cwd: "~/x" }`).
 * A ` #` comment after a plain value is dropped, so hand-edited files keep working.
 *
 * Pure node: no pi imports.
 */

export type Scalar = string | number | boolean | null;
export type Value = Scalar | Scalar[] | Record<string, Scalar>;
export type Fields = Record<string, Value>;

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
