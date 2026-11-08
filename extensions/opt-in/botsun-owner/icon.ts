// /icon: set this session's icon on Botsun's Home. The looks and colors are whatever Botsun
// sent (the phone's shapes, character sets and palette). Nothing here hard-codes them: a
// Botsun that adds a set is the one /icon offers.

/** Said when this pi has no live connection to Botsun. Exact: the command and its test share it. */
export const ICON_DISCONNECTED = "/icon needs Botsun";

export interface IconCatalog {
	shapes: string[];
	sets: Record<string, string[]>;
	colors: string[];
}

export type IconArgs =
	| { kind: "pick" }
	| { kind: "clear" }
	| { kind: "set"; look: string; color?: string }
	| { kind: "bad"; error: string };

export interface IconReply {
	ok: boolean;
	look?: string | null;
	color?: string | null;
	error?: string;
	unset?: boolean;
	cleared?: boolean;
}

const LOOK = /^[a-z0-9]+(?:\.[a-z0-9]+)?$/;
const COLOR = /^[a-z]+$/;
/** A shape or set name as Botsun sends one. A hyphen or an underscore keeps the whole catalog. */
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** /icon's arguments. auto and off clear. A look with no color keeps the saved color. */
export function parseIconArgs(args: string): IconArgs {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { kind: "pick" };
	const look = parts[0]!.toLowerCase();
	if (look === "auto" || look === "off") {
		if (parts.length > 1) return { kind: "bad", error: "/icon auto takes no color" };
		return { kind: "clear" };
	}
	if (parts.length > 2) return { kind: "bad", error: "usage: /icon [look] [color]" };
	if (!LOOK.test(look)) return { kind: "bad", error: "unknown look" };
	const color = parts[1]?.toLowerCase();
	if (color !== undefined && !COLOR.test(color)) return { kind: "bad", error: "unknown color" };
	return color === undefined ? { kind: "set", look } : { kind: "set", look, color };
}

/** The line's fields, apart from its id. A clear sends no look. A missing color keeps it. */
export function iconLineFields(req: { kind: "clear" } | { kind: "set"; look: string; color?: string }): Record<string, unknown> {
	if (req.kind === "clear") return { clear: true };
	return req.color === undefined ? { look: req.look } : { look: req.look, color: req.color };
}

/** Shapes, then each set's "<set>.<name>", in the order Botsun sent. */
export function looksOf(catalog: IconCatalog): string[] {
	const out = [...catalog.shapes];
	for (const [set, names] of Object.entries(catalog.sets)) {
		for (const name of names) out.push(`${set}.${name}`);
	}
	return out;
}

export function iconCompletions(prefix: string, catalog: IconCatalog | null): { value: string; label: string; description?: string }[] {
	const typed = prefix.trimStart();
	const looks = catalog ? looksOf(catalog) : [];
	const shapes = new Set(catalog?.shapes ?? []);
	// Still on the first token (no space yet): looks, plus auto and off, which need no catalog.
	if (!typed.includes(" ")) {
		const token = typed.toLowerCase();
		const items = [...looks, "auto", "off"].filter((v) => v.startsWith(token));
		return items.map((value) => ({
			value,
			label: value,
			description: value === "auto" || value === "off" ? "clear the icon" : shapes.has(value) ? "shape" : "character",
		}));
	}
	const parts = typed.split(/\s+/);
	const look = (parts[0] ?? "").toLowerCase();
	if (look === "auto" || look === "off" || !catalog || !looks.includes(look)) return [];
	const colorPrefix = typed.endsWith(" ") ? "" : (parts[1] ?? "").toLowerCase();
	return catalog.colors.filter((c) => c.startsWith(colorPrefix)).map((color) => ({
		value: `${look} ${color}`,
		label: color,
		description: color,
	}));
}

function names(value: unknown, max: number): string[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !NAME.test(item) || item.length > 40) return null;
		out.push(item);
	}
	return out;
}

/** Botsun's icons line, or null when it isn't one this command can offer. */
export function takeCatalog(msg: Record<string, unknown>): IconCatalog | null {
	const shapes = names(msg.shapes, 40);
	const colors = names(msg.colors, 40);
	const raw = msg.sets;
	if (!shapes || !colors || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const sets: Record<string, string[]> = Object.create(null);
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0 || entries.length > 40) return null;
	for (const [set, list] of entries) {
		if (!NAME.test(set)) return null;
		const parsed = names(list, 80);
		if (!parsed) return null;
		sets[set] = parsed;
	}
	return { shapes, sets, colors };
}

/** A look the catalog offers, or, before Botsun has sent one, one shaped as Botsun's looks are. */
function goodLook(value: string, catalog: IconCatalog | null | undefined): string | null {
	if (catalog) return looksOf(catalog).includes(value) ? value : null;
	return LOOK.test(value) ? value : null;
}

/** A palette color the catalog offered (a Botsun name, before one arrived), or null. */
function goodColor(value: unknown, catalog: IconCatalog | null | undefined): string | null {
	if (typeof value !== "string") return null;
	if (catalog) return catalog.colors.includes(value) ? value : null;
	return COLOR.test(value) ? value : null;
}

/**
 * What an icon or icons line says the session looks like now, checked against the catalog Botsun
 * sent: a look it doesn't offer, or a color it doesn't have, is stored as null (#22 only ever
 * draws what Botsun offers). Null when the line says nothing about the look.
 */
export function lookOf(msg: Record<string, unknown>, catalog?: IconCatalog | null): { look: string | null; color: string | null } | null {
	if (!("look" in msg)) return null;
	const look = typeof msg.look === "string" ? goodLook(msg.look, catalog) : null;
	return { look, color: goodColor(msg.color, catalog) };
}

/** As many looks' words as Botsun's own pages hold together. */
const NOTES_MAX = 400;
/** One look's words, and no more: the line is a page, and a suggestion's prompt stays small. */
const ABOUT_MAX = 80;
/** What a look's words may not carry: control characters, the line and paragraph separators, and
 * the direction marks (a note is one line of a prompt, down the same socket a color comes down). */
const NOTE_BAD = /[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * A looks line's page: {look id: what it draws}, for #21's auto-name to give a small model the
 * words to pick one by. Checked whole: a page with one bad name or word is dropped, not half taken.
 */
export function takeLookNotes(msg: Record<string, unknown>): Record<string, string> | null {
	const raw = msg.looks;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0 || entries.length > NOTES_MAX) return null;
	const out: Record<string, string> = Object.create(null);
	for (const [id, about] of entries) {
		if (!LOOK.test(id)) return null;
		if (typeof about !== "string" || about.length === 0 || about.length > ABOUT_MAX) return null;
		if (NOTE_BAD.test(about)) return null;
		out[id] = about;
	}
	return out;
}
