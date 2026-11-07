/**
 * The memory store: one markdown file per memory under the root.
 *
 *   <root>/global/<id>.md                 facts every session on this host may see
 *   <root>/projects/<host>/<org>/<repo>/  facts for one repo
 *   <root>/proposed/                      candidates awaiting approval; never injected
 *   <root>/archive/                       forgotten; restorable, pruned after 30 days
 *   <root>/pinned.md                      standing instructions, written only by the user
 *   <root>/.pi-memory                     marks the folder as a root (init refuses any other non-empty folder)
 *
 * Writes go to a `.tmp-` file that is fsynced and renamed into place. Every
 * path is built from a checked id (ID) and scope (SCOPE), and every folder on
 * the way is checked to be a real folder (no symlink) inside the root's real
 * path, so neither a `../` nor a symlink can move a write outside the root.
 *
 * Pure node: no pi imports.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { type Fields, parse, serialize } from "./frontmatter.ts";
import { gitInit } from "./git.ts";

export const ID = /^m-\d{8}-[a-z0-9]{4,}$/;
const SLUG_SEGMENT = /^[a-z0-9_][a-z0-9._-]*$/;
export const MAX_TEXT = 1000;
export const MAX_TAGS = 8;
export const MAX_PINS = 50;
export const ARCHIVE_DAYS = 30;
const MAX_FILE_BYTES = 64 * 1024;
const LAYOUT = ["global", "projects", "proposed", "archive"];
const PINNED_FILE = "pinned.md";

export type State = "active" | "proposed" | "archived";
export type Confidence = "stated" | "inferred" | "reviewed";
export type SourceKind = "remember" | "phone" | "cli" | "candidate" | "review" | "migrated";
const CONFIDENCE: readonly Confidence[] = ["stated", "inferred", "reviewed"];
const KINDS: readonly SourceKind[] = ["remember", "phone", "cli", "candidate", "review", "migrated"];

export interface Source {
	kind: SourceKind;
	session?: string;
	cwd?: string;
	model?: string;
}

export interface Memory {
	id: string;
	/** `global` or `projects/<host>/<org>/<repo>`. */
	scope: string;
	created: string;
	updated: string;
	source: Source;
	confidence: Confidence;
	tags: string[];
	text: string;
	botsun_id?: number;
	/** When it was archived (archive/ only). */
	archived?: string;
	state: State;
	path: string;
}

export class MemoryError extends Error {}

export const validId = (id: unknown): id is string => typeof id === "string" && ID.test(id);

export function projectScope(slug: string): string {
	return `projects/${slug}`;
}

/** Whether `scope` is `global` or `projects/<host>/<path…>` with safe segments. */
export function validScope(scope: unknown): scope is string {
	if (scope === "global") return true;
	if (typeof scope !== "string" || !scope.startsWith("projects/")) return false;
	const segments = scope.slice("projects/".length).split("/");
	return segments.length >= 3 && segments.length <= 8 && segments.every((s) => SLUG_SEGMENT.test(s) && s !== "." && s !== "..");
}

/** Local time with its offset, to the second: 2026-11-07T14:02:11-06:00. */
export function isoLocal(d = new Date()): string {
	const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

export function newId(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const rand = [...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join("");
	return `m-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${rand}`;
}

export function normalizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	const out = tags.map((t) => String(t).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "")).filter(Boolean);
	return [...new Set(out)].slice(0, MAX_TAGS);
}

export function cleanText(text: unknown): string {
	const t = typeof text === "string" ? text.trim() : "";
	if (!t) throw new MemoryError("nothing to remember");
	if (t.length > MAX_TEXT) throw new MemoryError(`memories are at most ${MAX_TEXT} characters; save one fact per call`);
	return t;
}

export const MARKER = ".pi-memory";
/** What a root may already hold without the marker: a layout made before it, nothing of anyone else's. */
const OWN_ENTRIES = new Set([...LAYOUT, MARKER, PINNED_FILE, ".git", ".gitignore", ".DS_Store"]);

/**
 * Create the layout (0700) and, with `git`, the local repo. The root must be
 * new, empty, or already a pi-memory root, so a mistyped root can't chmod,
 * re-configure and commit someone's folder or repo.
 */
export function init(root: string, opts: { git?: boolean } = {}): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (!statSync(root).isDirectory()) throw new MemoryError(`${root} is not a folder`);
	const marker = join(root, MARKER);
	if (!existsFile(marker)) {
		const foreign = readdirSync(root).filter((e) => !OWN_ENTRIES.has(e));
		if (foreign.length) throw new MemoryError(`${root} is not a pi-memory root (it holds ${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""}); set memory.root to a new or empty folder`);
		writeFileSync(marker, "This folder is a pi-memory root. Never add a git remote to it.\n", { mode: 0o600, flag: "wx" });
	} else if (lstatSync(marker).isSymbolicLink()) throw new MemoryError(`${marker} is a symlink`);
	chmodSync(root, 0o700);
	for (const d of LAYOUT) ensureDir(root, d);
	if (opts.git !== false) gitInit(realpathSync(root));
}

const inside = (realRoot: string, p: string) => p === realRoot || p.startsWith(realRoot + sep);

/**
 * The real path of `rel` under the root, creating folders (0700) as needed.
 * Refuses a symlink or non-folder anywhere on the way.
 */
export function ensureDir(root: string, rel: string): string {
	const realRoot = realpathSync(root);
	const parts = rel.split("/").filter(Boolean);
	if (parts.some((p) => p === ".." || p === "." || p.includes(sep))) throw new MemoryError("bad memory path");
	let cur = realRoot;
	for (const part of parts) {
		cur = join(cur, part);
		let st;
		try {
			st = lstatSync(cur);
		} catch {
			mkdirSync(cur, { mode: 0o700 });
			continue;
		}
		if (st.isSymbolicLink() || !st.isDirectory()) throw new MemoryError(`refusing a memory path through a symlink or file: ${rel}`);
	}
	if (!inside(realRoot, realpathSync(cur))) throw new MemoryError("memory path escapes the root");
	return cur;
}

function folderFor(scope: string, state: State, confidence: Confidence): string {
	if (state === "archived") return "archive";
	if (state === "proposed" || confidence === "inferred") return "proposed";
	return scope;
}

function atomicWrite(file: string, text: string): void {
	try {
		if (lstatSync(file).isSymbolicLink()) throw new MemoryError("refusing to write through a symlink");
	} catch (err) {
		if (err instanceof MemoryError) throw err;
	}
	const tmp = join(dirname(file), `.tmp-${basename(file)}-${randomBytes(4).toString("hex")}`);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} catch (err) {
		closeSync(fd);
		try {
			unlinkSync(tmp);
		} catch {}
		throw err;
	}
	closeSync(fd);
	try {
		renameSync(tmp, file);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw err;
	}
}

function fieldsOf(m: Omit<Memory, "path" | "state" | "text">): Fields {
	const source: Record<string, string> = { kind: m.source.kind };
	for (const k of ["session", "cwd", "model"] as const) if (m.source[k]) source[k] = m.source[k];
	const fields: Fields = { id: m.id, scope: m.scope, created: m.created, updated: m.updated, source, confidence: m.confidence, tags: m.tags };
	if (m.botsun_id !== undefined) fields.botsun_id = m.botsun_id;
	if (m.archived) fields.archived = m.archived;
	return fields;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A memory from a file's text, or null when it isn't a valid one. */
export function fromText(text: string, path: string, state: State): Memory | null {
	const parsed = parse(text);
	if (!parsed) return null;
	const f = parsed.fields;
	const id = f.id;
	if (!validId(id) || basename(path) !== `${id}.md`) return null;
	if (!validScope(f.scope)) return null;
	if (!parsed.body.trim()) return null;
	const src = f.source && typeof f.source === "object" && !Array.isArray(f.source) ? f.source : {};
	const kind = KINDS.includes(src.kind as SourceKind) ? (src.kind as SourceKind) : "cli";
	const confidence = CONFIDENCE.includes(f.confidence as Confidence) ? (f.confidence as Confidence) : "stated";
	const created = str(f.created) ?? "";
	return {
		id,
		scope: f.scope,
		created,
		updated: str(f.updated) ?? created,
		source: { kind, session: str(src.session), cwd: str(src.cwd), model: str(src.model) },
		confidence,
		tags: normalizeTags(Array.isArray(f.tags) ? f.tags : []),
		text: parsed.body.trim(),
		...(typeof f.botsun_id === "number" ? { botsun_id: f.botsun_id } : {}),
		...(str(f.archived) ? { archived: str(f.archived) } : {}),
		state,
		path,
	};
}

/** `*.md` files under `dir`, real folders only, at most `depth` levels down. */
function files(dir: string, depth: number): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const p = join(dir, e.name);
		if (e.isDirectory() && depth > 0) out.push(...files(p, depth - 1));
		else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
	}
	return out;
}

const time = (iso: string | undefined) => {
	const t = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(t) ? t : 0;
};

export interface Loaded {
	memories: Memory[];
	/** Files that weren't valid memories, or sat in the wrong folder. */
	skipped: number;
	pruned: number;
}

/**
 * Every memory under the root, newest first. Archived memories older than
 * ARCHIVE_DAYS are deleted on the way (git keeps them).
 */
export function load(root: string, now = new Date()): Loaded {
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		return { memories: [], skipped: 0, pruned: 0 };
	}
	const seen = new Set<string>();
	const memories: Memory[] = [];
	let skipped = 0;
	let pruned = 0;
	const groups: [string, State, number][] = [["global", "active", 0], ["projects", "active", 8], ["proposed", "proposed", 0], ["archive", "archived", 0]];
	for (const [folder, state, depth] of groups) {
		const base = join(realRoot, folder);
		try {
			if (lstatSync(base).isSymbolicLink()) {
				skipped++;
				continue;
			}
		} catch {
			continue;
		}
		for (const path of files(base, depth)) {
			let text: string;
			try {
				if (lstatSync(path).size > MAX_FILE_BYTES) {
					skipped++;
					continue;
				}
				text = readFileSync(path, "utf8");
			} catch {
				skipped++;
				continue;
			}
			const m = fromText(text, path, state);
			if (!m || seen.has(m.id) || (state === "active" && dirname(path) !== join(realRoot, m.scope))) {
				skipped++;
				continue;
			}
			if (state === "archived") {
				const at = time(m.archived) || statSync(path).mtimeMs;
				if (now.getTime() - at > ARCHIVE_DAYS * 86_400_000) {
					try {
						unlinkSync(path);
						pruned++;
					} catch {}
					continue;
				}
			}
			seen.add(m.id);
			memories.push(m);
		}
	}
	memories.sort((a, b) => time(b.updated) - time(a.updated) || (a.id < b.id ? 1 : -1));
	return { memories, skipped, pruned };
}

export function find(root: string, id: string): Memory | undefined {
	if (!validId(id)) throw new MemoryError(`not a memory id: ids look like m-20261107-k3f9`);
	return load(root).memories.find((m) => m.id === id);
}

export interface NewMemory {
	scope: string;
	text: string;
	tags?: readonly string[];
	source: Source;
	confidence?: Confidence;
	botsun_id?: number;
	now?: Date;
}

/** Write a new memory. Text and tags are cleaned here; scanning and dedupe are the caller's (ops.ts). */
export function write(root: string, input: NewMemory): Memory {
	if (!validScope(input.scope)) throw new MemoryError("bad scope: global or projects/<host>/<org>/<repo>");
	const now = input.now ?? new Date();
	const confidence = input.confidence ?? "stated";
	const text = cleanText(input.text);
	const dir = ensureDir(root, folderFor(input.scope, "active", confidence));
	let id = newId(now);
	for (let i = 0; i < 5 && existsFile(join(dir, `${id}.md`)); i++) id = newId(now);
	const iso = isoLocal(now);
	const base = { id, scope: input.scope, created: iso, updated: iso, source: input.source, confidence, tags: normalizeTags(input.tags ?? []), ...(input.botsun_id !== undefined ? { botsun_id: input.botsun_id } : {}) };
	const path = join(dir, `${id}.md`);
	if (existsFile(path)) throw new MemoryError("id collision; try again");
	atomicWrite(path, serialize(fieldsOf(base), text));
	return { ...base, text, state: confidence === "inferred" ? "proposed" : "active", path };
}

function existsFile(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/** Write `m` to where its state says, removing the file it was in if that differs. */
function rewrite(root: string, m: Memory, from?: string): Memory {
	const dir = ensureDir(root, folderFor(m.scope, m.state, m.confidence));
	const path = join(dir, `${m.id}.md`);
	if (from && path !== from && existsFile(path)) throw new MemoryError(`${m.id} already exists in ${basename(dir)}`);
	atomicWrite(path, serialize(fieldsOf(m), m.text));
	if (from && from !== path) unlinkSync(from);
	return { ...m, path };
}

export function update(root: string, id: string, patch: { text?: string; tags?: readonly string[]; now?: Date }): Memory {
	const m = find(root, id);
	if (!m || m.state === "archived") throw new MemoryError(`no memory ${id}${m ? " (it is archived; restore it first)" : ""}`);
	const next: Memory = {
		...m,
		text: patch.text !== undefined ? cleanText(patch.text) : m.text,
		tags: patch.tags !== undefined ? normalizeTags(patch.tags) : m.tags,
		updated: isoLocal(patch.now),
	};
	return rewrite(root, next, m.path);
}

export function archive(root: string, id: string, now = new Date()): Memory {
	const m = find(root, id);
	if (!m || m.state === "archived") throw new MemoryError(m ? `${id} is already archived` : `no memory ${id}`);
	return rewrite(root, { ...m, state: "archived", archived: isoLocal(now) }, m.path);
}

export function restore(root: string, id: string): Memory {
	const m = find(root, id);
	if (!m || m.state !== "archived") throw new MemoryError(m ? `${id} is not archived` : `no archived memory ${id}`);
	const { archived: _gone, ...rest } = m;
	return rewrite(root, { ...rest, state: rest.confidence === "inferred" ? "proposed" : "active" }, m.path);
}

// ── pinned.md ──

const PINNED_HEADER = "# Pinned\n\nStanding instructions for every pi session on this host, injected before any memory. Written by the user only; one \"- \" line each.\n";

/** pinned.md's text (null when there is none); throws when it can't be edited safely. */
function pinnedFile(root: string): { path: string; text: string | null } {
	const path = join(realpathSync(root), PINNED_FILE);
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return { path, text: null };
	}
	if (st.isSymbolicLink() || !st.isFile()) throw new MemoryError(`refusing ${PINNED_FILE}: it is a symlink or not a file`);
	if (st.size > MAX_FILE_BYTES) throw new MemoryError(`${PINNED_FILE} is over ${MAX_FILE_BYTES / 1024} KB; trim it by hand`);
	return { path, text: readFileSync(path, "utf8") };
}

const pinOf = (line: string): string | null => (line.startsWith("- ") && line.slice(2).trim() ? line.slice(2).trim() : null);
const pinsIn = (text: string | null): string[] => (text ?? "").split("\n").map(pinOf).filter((p): p is string => p !== null);

/** The pins: each "- " line of pinned.md, at most MAX_PINS of at most MAX_TEXT characters; none when it can't be read. */
export function readPins(root: string): string[] {
	try {
		return pinsIn(pinnedFile(root).text).slice(0, MAX_PINS).map((p) => p.slice(0, MAX_TEXT));
	} catch {
		return [];
	}
}

/** Append a pin; the rest of pinned.md (prose, other lines) is kept as it is. */
export function addPin(root: string, text: string): string[] {
	const t = cleanText(text).replace(/\s+/g, " ");
	const { path, text: current } = pinnedFile(root);
	const pins = pinsIn(current);
	if (pins.length >= MAX_PINS) throw new MemoryError(`at most ${MAX_PINS} pins`);
	const base = (current ?? PINNED_HEADER).replace(/\s*$/, "\n");
	atomicWrite(path, `${base}${pins.length ? "" : "\n"}- ${t}\n`);
	return [...pins, t];
}

/** Remove pin `n` (1-based), leaving every other line of pinned.md alone. */
export function removePin(root: string, n: number): string[] {
	const { path, text } = pinnedFile(root);
	const pins = pinsIn(text);
	if (!Number.isInteger(n) || n < 1 || n > pins.length) throw new MemoryError(`no pin ${n} (there ${pins.length === 1 ? "is 1" : `are ${pins.length}`})`);
	const lines = (text ?? "").split("\n");
	let seen = 0;
	const at = lines.findIndex((l) => pinOf(l) !== null && ++seen === n);
	lines.splice(at, 1);
	atomicWrite(path, lines.join("\n"));
	return pinsIn(lines.join("\n"));
}

// ── usage stats (outside the repo, so git stays quiet) ──

export function statsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-memory", "stats.json");
}

export function readStats(path = statsPath()): Record<string, number> {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { used?: Record<string, unknown> };
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(raw.used ?? {})) if (validId(k) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

/** Count one use for each id. Best effort: a lost race loses a count, nothing else. */
export function bumpUsed(ids: readonly string[], path = statsPath()): void {
	if (ids.length === 0) return;
	try {
		const used = readStats(path);
		for (const id of ids) if (validId(id)) used[id] = (used[id] ?? 0) + 1;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
		const fd = openSync(tmp, "wx", 0o600);
		writeSync(fd, `${JSON.stringify({ used })}\n`);
		closeSync(fd);
		renameSync(tmp, path);
	} catch {}
}
