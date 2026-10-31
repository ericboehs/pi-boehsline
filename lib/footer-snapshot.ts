/**
 * The footer's chips as last painted, for other extensions (botsun-owner shows them on Eric's
 * phone). The footer publishes on render, in /footer order with hidden chips left out; ANSI
 * colours become plain segments ({text, fg}) a non-terminal can draw. One footer per process.
 */

export interface FooterSegment {
	text: string;
	/** "#rrggbb", or an ANSI colour name ("red", "brightCyan"); none = default. */
	fg?: string;
	dim?: boolean;
}

export interface FooterChip {
	id: string;
	segments: FooterSegment[];
}

const KEY = "__boehslineFooterSnapshot";

interface Snapshot {
	chips: FooterChip[];
	signature: string;
	listeners: Set<() => void>;
}

function snapshot(): Snapshot {
	const g = globalThis as unknown as { [KEY]?: Snapshot };
	g[KEY] ??= { chips: [], signature: "", listeners: new Set() };
	return g[KEY];
}

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** xterm 256-colour index to hex. */
function x256(n: number): string {
	if (n < 8) return NAMES[n]!;
	if (n < 16) return `bright${NAMES[n - 8]![0]!.toUpperCase()}${NAMES[n - 8]!.slice(1)}`;
	const hex = (v: number) => v.toString(16).padStart(2, "0");
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `#${hex(v)}${hex(v)}${hex(v)}`;
	}
	const i = n - 16;
	const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
	return `#${hex(level(Math.floor(i / 36)))}${hex(level(Math.floor(i / 6) % 6))}${hex(level(i % 6))}`;
}

/** Text with ANSI SGR colours (and OSC 8 links) to segments. Pure for tests. */
export function ansiSegments(text: string): FooterSegment[] {
	// OSC sequences (hyperlinks): drop the wrappers, keep the label.
	const plain = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
	const out: FooterSegment[] = [];
	let fg: string | undefined;
	let dim = false;
	const re = /\x1b\[([\d;]*)m/g;
	let last = 0;
	const push = (chunk: string) => {
		if (!chunk) return;
		const prev = out[out.length - 1];
		if (prev && prev.fg === fg && (prev.dim ?? false) === dim) prev.text += chunk;
		else out.push({ text: chunk, ...(fg ? { fg } : {}), ...(dim ? { dim } : {}) });
	};
	for (let m = re.exec(plain); m; m = re.exec(plain)) {
		push(plain.slice(last, m.index));
		last = re.lastIndex;
		const codes = (m[1] || "0").split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i]!;
			if (c === 0) {
				fg = undefined;
				dim = false;
			} else if (c === 2) dim = true;
			else if (c === 22) dim = false;
			else if (c === 39) fg = undefined;
			else if (c >= 30 && c <= 37) fg = NAMES[c - 30];
			else if (c >= 90 && c <= 97) fg = x256(c - 90 + 8);
			else if (c === 38 && codes[i + 1] === 5) {
				fg = x256(codes[i + 2] ?? 7);
				i += 2;
			} else if (c === 38 && codes[i + 1] === 2) {
				const hex = (v: number | undefined) => Math.max(0, Math.min(255, v ?? 0)).toString(16).padStart(2, "0");
				fg = `#${hex(codes[i + 2])}${hex(codes[i + 3])}${hex(codes[i + 4])}`;
				i += 4;
			} else if (c === 48) {
				i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0; // backgrounds: skipped
			}
		}
	}
	push(plain.slice(last).replace(/\x1b\[[\d;]*[A-Za-z]/g, ""));
	return out;
}

/** The footer, after painting: its chips in order (ANSI text). Cheap when nothing changed. */
export function publishFooter(parts: { id: string; text: string }[]): void {
	const s = snapshot();
	const signature = parts.map((p) => `${p.id}\u0000${p.text}`).join("\u0001");
	if (signature === s.signature) return;
	s.signature = signature;
	s.chips = parts.map((p) => ({ id: p.id, segments: ansiSegments(p.text) })).filter((c) => c.segments.some((x) => x.text.trim()));
	for (const fn of s.listeners) {
		try {
			fn();
		} catch {}
	}
}

export function latestFooter(): FooterChip[] {
	return snapshot().chips;
}

/** Called after every change. Returns the unsubscribe. */
export function onFooterChange(fn: () => void): () => void {
	snapshot().listeners.add(fn);
	return () => snapshot().listeners.delete(fn);
}

/** The chips a tap flips between their display modes, as a click on the footer does. */
export const TAPPABLE_CHIPS = ["dir", "context", "cost", "usage", "rate", "timers"] as const;

const TAP_KEY = "__boehslineFooterTap";

/** The footer's handler for a chip tap from elsewhere (the phone). Returns the unregister. */
export function onFooterTap(fn: (id: string) => boolean): () => void {
	const g = globalThis as unknown as { [TAP_KEY]?: (id: string) => boolean };
	g[TAP_KEY] = fn;
	return () => {
		if (g[TAP_KEY] === fn) delete g[TAP_KEY];
	};
}

/** Flips a chip's display mode, like clicking it in the footer: false when it can't. */
export function tapFooter(id: string): boolean {
	if (!(TAPPABLE_CHIPS as readonly string[]).includes(id)) return false;
	const fn = (globalThis as unknown as { [TAP_KEY]?: (id: string) => boolean })[TAP_KEY];
	return fn ? fn(id) : false;
}
