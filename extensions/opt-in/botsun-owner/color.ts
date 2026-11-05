// The session's color, kept the same in pi's /color and on Botsun's phone (Botsun's
// docs/session-icons.md). Pure: what index.ts sends and takes, no sockets.
//
// Botsun names colors from its own palette; /color takes its own names, a hex or an
// xterm index. A Botsun name /color also has goes to pi as that name, the others as
// the hex the phone draws them in. Whatever pi has comes back as the nearest Botsun name.

/** Botsun's palette (Bots::COLORS), each as the phone fills it in dark mode. Botsun's
 * test/fixtures/session-colors.json; test/fixtures/session-colors.json here is a copy. */
export const BOTSUN_COLORS: Readonly<Record<string, string>> = {
	blue: "#3b82ff",
	indigo: "#6366ff",
	purple: "#a35bff",
	pink: "#ff5cad",
	red: "#ff4d4f",
	orange: "#ff8c1a",
	yellow: "#ffd400",
	green: "#34d058",
	mint: "#3de8b5",
	teal: "#12b5b0",
	cyan: "#2ec5ff",
	brown: "#b5794a",
	gray: "#8e8e9a",
};

/** /color's own palette names (extensions/color's PALETTE). */
export const PI_NAMES: ReadonlySet<string> = new Set(["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"]);

type Rgb = { r: number; g: number; b: number };

function hexRgb(hex: string): Rgb {
	const body = hex.replace(/^#/, "");
	const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
	return { r: Number.parseInt(full.slice(0, 2), 16), g: Number.parseInt(full.slice(2, 4), 16), b: Number.parseInt(full.slice(4, 6), 16) };
}

/** xterm's 16 system colors (its defaults), then the 6x6x6 cube and the gray ramp. */
const XTERM_16 = ["000000", "cd0000", "00cd00", "cdcd00", "0000ee", "cd00cd", "00cdcd", "e5e5e5", "7f7f7f", "ff0000", "00ff00", "ffff00",
	"5c5cff", "ff00ff", "00ffff", "ffffff"];
const CUBE = [0, 95, 135, 175, 215, 255];

/** index: 0 to 255 (fromPi checks). */
export function xtermRgb(index: number): Rgb {
	if (index < 16) return hexRgb(XTERM_16[index]!);
	if (index < 232) {
		const i = index - 16;
		return { r: CUBE[Math.floor(i / 36)]!, g: CUBE[Math.floor(i / 6) % 6]!, b: CUBE[i % 6]! };
	}
	const v = 8 + 10 * (index - 232);
	return { r: v, g: v, b: v };
}

/** The Botsun name nearest rgb, by the "redmean" distance (weights that follow the eye better than plain RGB). */
export function nearest(rgb: Rgb): string {
	let best = "";
	let bestD = Infinity;
	for (const [name, hex] of Object.entries(BOTSUN_COLORS)) {
		const c = hexRgb(hex);
		const mean = (rgb.r + c.r) / 2;
		const dr = rgb.r - c.r;
		const dg = rgb.g - c.g;
		const db = rgb.b - c.b;
		const d = (2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db;
		if (d < bestD) {
			bestD = d;
			best = name;
		}
	}
	return best;
}

/** What /color gets for a Botsun name; null for one that isn't Botsun's. */
export function toPi(name: string): string | null {
	if (!Object.hasOwn(BOTSUN_COLORS, name)) return null;
	return PI_NAMES.has(name) ? name : BOTSUN_COLORS[name]!;
}

/** The Botsun name for what /color has (a palette name, "#hex", an xterm index); null for none or one it can't read. */
export function fromPi(spec: string | null | undefined): string | null {
	if (spec == null) return null;
	const token = spec.trim().toLowerCase();
	if (Object.hasOwn(BOTSUN_COLORS, token)) return token;
	if (/^\d{1,3}$/.test(token)) {
		const index = Number.parseInt(token, 10);
		return index <= 255 ? nearest(xtermRgb(index)) : null;
	}
	if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/.test(token)) return nearest(hexRgb(token));
	return null;
}

/** What Botsun is told about pi's color: a Botsun name or null, and when it was set (ms), null if never. */
export interface ColorClaim {
	color: string | null;
	color_at: number | null;
}

/** The claim for the color extension's state ({spec, at}); null when there is none to make (no color extension). */
export function claimOf(state: { spec?: unknown; at?: unknown } | null | undefined): ColorClaim | null {
	if (!state || typeof state !== "object") return null;
	const spec = typeof state.spec === "string" ? state.spec : null;
	const at = typeof state.at === "number" && Number.isSafeInteger(state.at) && state.at >= 0 ? state.at : null;
	return { color: fromPi(spec), color_at: at };
}

/** A color Botsun sent down this session's connection ({v: 1, type: "color", session_id, color, at}),
 * as a "color:set" for /color ({spec, at}), or null: for another session (pi moved on since), not a
 * Botsun name, or a bad time. */
export function colorPush(sessionId: string | null, msg: Record<string, unknown>): { spec: string; at: number; color: string } | null {
	const { session_id: sid, color, at } = msg;
	if (!sessionId || sid !== sessionId) return null;
	if (typeof color !== "string") return null;
	const spec = toPi(color);
	if (!spec || typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return null;
	return { spec, at, color };
}
