// /icon's picker, drawn: each look's idle frame beside its name, in the color it would get, and
// then the chosen look in every color. The frames are Botsun's exported strips
// (~/.local/share/botsun/icons/<look>/<color>.png, `bin/botsun icons export`), shown with Kitty
// graphics through Unicode placeholders (U=1), wrapped for tmux passthrough, so a picture sits in
// text cells pi-tui lays out like any other. A terminal that can't draw them (or no strips) gets
// pi's plain select, as before.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflate, inflate } from "node:zlib";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

export const iconsDir = (): string => process.env.BOTSUN_ICONS_DIR || join(homedir(), ".local/share/botsun/icons");

interface Manifest {
	revision?: string;
	frame?: { width?: number; height?: number };
	idle_index?: number;
}

function manifest(dir: string): Manifest | null {
	try {
		return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
	} catch {
		return null;
	}
}

// ── PNG: one frame out of a strip ─────────────────────────────────────────────

/**
 * One frame of a horizontal strip as RGBA, without decoding the rest of each row: a filter reads
 * only bytes left of and above the one it restores, so the frame's columns unfilter on their own.
 * 8-bit RGBA, non-interlaced only (what Botsun exports); anything else is null.
 */
export async function stripFrame(png: Buffer, frame: number, size: number): Promise<{ w: number; h: number; rgba: Buffer } | null> {
	if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return null;
	let off = 8;
	let width = 0;
	let height = 0;
	const idat: Buffer[] = [];
	while (off + 8 <= png.length) {
		const len = png.readUInt32BE(off);
		const type = png.toString("latin1", off + 4, off + 8);
		const data = png.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) return null; // 8-bit, RGBA, no interlace
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		off += 12 + len;
	}
	if (!width || !height || !idat.length) return null;
	const raw = await inflateAsync(Buffer.concat(idat));
	const stride = width * 4;
	const x0 = frame * size;
	if (x0 + size > width || size > height) return null;
	const need = (x0 + size) * 4; // bytes of each row to restore: up to the frame's right edge
	const prev = Buffer.alloc(need);
	const cur = Buffer.alloc(need);
	const out = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		const base = y * (stride + 1);
		if (base + 1 + need > raw.length) return null;
		const filter = raw[base]!;
		for (let i = 0; i < need; i++) {
			const x = raw[base + 1 + i]!;
			const a = i >= 4 ? cur[i - 4]! : 0;
			const b = prev[i]!;
			const c = i >= 4 ? prev[i - 4]! : 0;
			let v: number;
			switch (filter) {
				case 0: v = x; break;
				case 1: v = x + a; break;
				case 2: v = x + b; break;
				case 3: v = x + ((a + b) >> 1); break;
				case 4: {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
					break;
				}
				default: return null;
			}
			cur[i] = v & 255;
		}
		cur.copy(out, y * size * 4, x0 * 4, need);
		cur.copy(prev);
	}
	return { w: size, h: size, rgba: out };
}

/** Halve an RGBA square until it is at most max px: a box average, alpha-weighted. */
export function shrink(img: { w: number; h: number; rgba: Buffer }, max: number): { w: number; h: number; rgba: Buffer } {
	let { w, h, rgba } = img;
	while (w > max && w % 2 === 0 && h % 2 === 0) {
		const nw = w / 2;
		const nh = h / 2;
		const next = Buffer.alloc(nw * nh * 4);
		for (let y = 0; y < nh; y++) {
			for (let x = 0; x < nw; x++) {
				let r = 0, g = 0, b = 0, a = 0;
				for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
					const i = ((y * 2 + dy) * w + (x * 2 + dx)) * 4;
					const al = rgba[i + 3]!;
					r += rgba[i]! * al; g += rgba[i + 1]! * al; b += rgba[i + 2]! * al; a += al;
				}
				const o = (y * nw + x) * 4;
				if (a) { next[o] = Math.round(r / a); next[o + 1] = Math.round(g / a); next[o + 2] = Math.round(b / a); }
				next[o + 3] = Math.round(a / 4);
			}
		}
		w = nw; h = nh; rgba = next;
	}
	return { w, h, rgba };
}

// ── Kitty graphics ────────────────────────────────────────────────────────────

const wrap = (seq: string) => (process.env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : seq);
const apc = (keys: string, payload = "") => wrap(`\x1b_G${keys}${payload ? `;${payload}` : ""}\x1b\\`);

/** Transmit raw RGBA (zlib, o=z) in <=4096-byte base64 chunks, then a virtual placement of cols x rows cells. */
export function kittyTransmit(id: number, w: number, h: number, zrgba: Buffer, cols: number, rows: number): string {
	const b64 = zrgba.toString("base64");
	let seq = "";
	for (let i = 0; i < b64.length; i += 4096) {
		const more = i + 4096 < b64.length ? 1 : 0;
		seq += apc(i === 0 ? `a=t,f=32,o=z,s=${w},v=${h},i=${id},q=2,m=${more}` : `m=${more}`, b64.slice(i, i + 4096));
	}
	return seq + apc(`a=p,U=1,i=${id},c=${cols},r=${rows},q=2`);
}

export const kittyDelete = (id: number): string => apc(`a=d,d=I,i=${id},q=2`);

// Kitty's row/column diacritics, in order (the first few of rowcolumn-diacritics.txt).
const DIACRITICS = ["\u0305", "\u030D", "\u030E", "\u0310", "\u0312", "\u033D", "\u033E", "\u033F"];

/** One row of an image's placeholder cells: the id rides in the 24-bit foreground. */
export function placeholderRow(id: number, row: number, cols: number): string {
	let cells = "";
	for (let col = 0; col < cols; col++) cells += `\u{10EEEE}${DIACRITICS[row]}${DIACRITICS[col]}`;
	return `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m${cells}\x1b[39m`;
}

/** Whether this terminal draws Kitty images through placeholders: Ghostty, Kitty or WezTerm, in tmux or not. */
export function canDrawIcons(): boolean {
	if (process.env.BOTSUN_ICON_IMAGES === "0") return false;
	if (!existsSync(join(iconsDir(), "manifest.json"))) return false;
	const kittyish = (s: string | undefined) => /ghostty|kitty|wezterm/i.test(s ?? "");
	if (process.env.TMUX) {
		try {
			const r = spawnSync("tmux", ["display-message", "-p", "#{client_termname} #{client_termtype}"], { encoding: "utf8", timeout: 1000 });
			if (kittyish(r.stdout)) return true;
		} catch {}
		return false;
	}
	return kittyish(process.env.TERM_PROGRAM) || kittyish(process.env.TERM) || !!process.env.KITTY_WINDOW_ID;
}

// ── The picker ────────────────────────────────────────────────────────────────

export interface PickItem {
	value: string;
	label: string;
	/** The strip to draw, or none (automatic, keep color). */
	look?: string;
	color?: string;
}

const ICON_COLS = 4;
const ICON_ROWS = 2;
const ICON_PX = 64;
const LABEL_MAX = 22;

// Frames already cut, by path and revision: the next /icon draws at once.
const frameCache = new Map<string, Promise<{ w: number; h: number; z: Buffer } | null>>();

function frameFor(dir: string, look: string, color: string): Promise<{ w: number; h: number; z: Buffer } | null> {
	const m = manifest(dir);
	const key = `${look}/${color}@${m?.revision ?? ""}`;
	let p = frameCache.get(key);
	if (!p) {
		p = (async () => {
			if (!/^[a-z0-9.]{1,40}$/.test(look) || !/^[a-z]{1,20}$/.test(color)) return null;
			const png = await readFile(join(dir, look, `${color}.png`));
			const img = await stripFrame(png, m?.idle_index ?? 0, m?.frame?.width ?? 128);
			if (!img) return null;
			const small = shrink(img, ICON_PX);
			return { w: small.w, h: small.h, z: await deflateAsync(small.rgba) };
		})().catch(() => null);
		frameCache.set(key, p);
	}
	return p;
}

/**
 * A grid of items, each its picture (ICON_COLS x ICON_ROWS cells) and name. Type to filter, arrows
 * to move, Enter to pick, Esc to cancel. Resolves to the picked value, or undefined.
 */
export async function pickDrawn(ctx: ExtensionContext, title: string, items: PickItem[], initial?: string): Promise<string | undefined> {
	const dir = iconsDir();
	const write = (s: string) => {
		try { process.stdout.write(s); } catch {}
	};
	const ids = new Map<string, number>(); // "look/color" -> image id, sent this picker
	const sent = new Set<number>();
	let closed = false;
	const newId = () => 0x100000 + Math.floor(Math.random() * 0xeffff);
	const idFor = (look: string, color: string) => {
		const k = `${look}/${color}`;
		let id = ids.get(k);
		if (!id) {
			id = newId();
			ids.set(k, id);
		}
		return id;
	};

	try {
		return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
			let query = "";
			let selected = Math.max(0, items.findIndex((i) => i.value === initial));
			let top = 0; // first grid row shown
			const shown = () => (query ? items.filter((i) => i.value.includes(query) || i.label.includes(query)) : items);
			const send = (look: string, color: string, id: number) => {
				if (sent.has(id)) return;
				sent.add(id);
				void frameFor(dir, look, color).then((f) => {
					if (!f || closed) return;
					write(kittyTransmit(id, f.w, f.h, f.z, ICON_COLS, ICON_ROWS));
					tui.requestRender();
				});
			};
			const layout = (width: number) => {
				const label = Math.min(LABEL_MAX, Math.max(4, ...items.map((i) => i.label.length)));
				const cols = Math.max(1, Math.floor(width / (ICON_COLS + 1 + label + 2)));
				const termRows = (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 30;
				const gridRows = Math.max(2, Math.min(12, Math.floor((termRows - 8) / ICON_ROWS)));
				return { label, cols, gridRows };
			};
			let lastCols = 1;
			let lastRows = 6;
			const move = (d: number) => {
				const n = shown().length;
				if (!n) return;
				selected = Math.max(0, Math.min(n - 1, selected + d));
				tui.requestRender();
			};
			return {
				render(width: number): string[] {
					const list = shown();
					if (selected >= list.length) selected = Math.max(0, list.length - 1);
					const { label, cols, gridRows } = layout(width);
					lastCols = cols;
					lastRows = gridRows;
					const row = Math.floor(selected / cols);
					if (row < top) top = row;
					if (row >= top + gridRows) top = row - gridRows + 1;
					const total = Math.ceil(list.length / cols);
					if (top > Math.max(0, total - gridRows)) top = Math.max(0, total - gridRows);
					const lines: string[] = [];
					lines.push(truncateToWidth(theme.fg("accent", theme.bold(title)) + theme.fg("dim", query ? `  filter: ${query}` : "  type to filter"), width));
					for (let r = top; r < Math.min(total, top + gridRows); r++) {
						const parts: string[][] = Array.from({ length: ICON_ROWS }, () => []);
						for (let c = 0; c < cols; c++) {
							const idx = r * cols + c;
							const item = list[idx];
							if (!item) break;
							const sel = idx === selected;
							let pic: string[] | null = null;
							if (item.look && item.color) {
								const id = idFor(item.look, item.color);
								send(item.look, item.color, id);
								pic = Array.from({ length: ICON_ROWS }, (_, k) => placeholderRow(id, k, ICON_COLS));
							}
							const name = item.label.length > label ? `${item.label.slice(0, label - 1)}…` : item.label;
							const text = sel ? theme.fg("accent", theme.bold(name)) : name;
							const pad = " ".repeat(Math.max(0, label - visibleWidth(name)));
							for (let k = 0; k < ICON_ROWS; k++) {
								const icon = pic ? pic[k]! : " ".repeat(ICON_COLS);
								const mark = k === 0 ? (sel ? theme.fg("accent", "›") : " ") : " ";
								const words = k === 0 ? text + pad : " ".repeat(label);
								parts[k]!.push(`${icon}${mark}${words}  `);
							}
						}
						for (const p of parts) lines.push(truncateToWidth(p.join(""), width));
					}
					if (!list.length) lines.push(theme.fg("dim", "  no match"));
					const more = total > gridRows ? `  ${top + 1}-${Math.min(total, top + gridRows)} of ${total} rows` : "";
					lines.push(truncateToWidth(theme.fg("dim", `↑↓←→ move · enter pick · esc cancel${more}`), width));
					return lines;
				},
				handleInput(data: string): void {
					if (keybindings.matches(data, "tui.select.cancel")) {
						if (query) {
							query = "";
							selected = 0;
							tui.requestRender();
							return;
						}
						done(undefined);
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						done(shown()[selected]?.value);
						return;
					}
					if (keybindings.matches(data, "tui.select.up")) return move(-lastCols);
					if (keybindings.matches(data, "tui.select.down")) return move(lastCols);
					if (keybindings.matches(data, "tui.select.pageUp")) return move(-lastCols * lastRows);
					if (keybindings.matches(data, "tui.select.pageDown")) return move(lastCols * lastRows);
					if (matchesKey(data, Key.left)) return move(-1);
					if (matchesKey(data, Key.right)) return move(1);
					if (matchesKey(data, Key.backspace)) {
						query = query.slice(0, -1);
						selected = 0;
						tui.requestRender();
						return;
					}
					if (/^[a-z0-9.]$/i.test(data)) {
						query += data.toLowerCase();
						selected = 0;
						tui.requestRender();
					}
				},
				invalidate() {},
			};
		});
	} finally {
		closed = true;
		for (const id of sent) write(kittyDelete(id));
	}
}
