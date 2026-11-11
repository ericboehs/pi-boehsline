/**
 * Optional qmd (Quick Markdown Search) support. Everything works without it.
 *
 * - The `memory` collection is registered only by `setup()` (`pi-memory qmd
 *   setup`, `/memory qmd setup`), never automatically: it changes the user's
 *   qmd index.
 * - `query()` runs `qmd query -c memory --format json`, keeps hits for active
 *   memories (not proposed/ or archive/, nothing outside the collection), and
 *   returns hits from `search.collections` as a separate list. Any error or a
 *   5 s timeout returns null, and the caller falls back to built-in search.
 * - `scheduleUpdate()` runs `qmd update -c memory` in the background, debounced,
 *   after writes, when the collection exists. `updateDetached()` (the CLI) runs
 *   the same detached, and skips while its last one still runs: a nightly review
 *   verifies memories minutes apart, and a whole-index `qmd update` per verify
 *   stacked a dozen at once (2026-11-10, load 400).
 *
 * qmd runs without a shell, in the memory root (so no project-local .qmd
 * config is picked up), with the query after `--` so it can't be read as an
 * option. With `qmd: "off"` nothing here spawns anything.
 *
 * Pure node: no pi imports.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneLine } from "./render.ts";
import { COLLECTION } from "./settings.ts";
import { ID } from "./store.ts";

export const COLLECTION_NAME = "memory";
const MAX_OUT = 4 * 1024 * 1024;
const MAX_QUERY = 500;
/** Only the memory collection: the rest of the index is qmd-update-job's (every 30 min). */
const UPDATE_ARGS = ["update", "-c", COLLECTION_NAME];

/** Whether a pid is a live process (signal 0 checks without sending anything). */
function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface OutsideHit {
	collection: string;
	file: string;
	snippet: string;
	score: number;
}

export interface QueryResult {
	/** Memory ids, qmd's order. */
	ids: string[];
	outside: OutsideHit[];
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	missing?: boolean;
	timedOut?: boolean;
}

export interface QmdOptions {
	root: string;
	mode: "auto" | "off";
	bin?: string;
	timeoutMs?: number;
	debounceMs?: number;
	log?: (msg: string) => void;
	env?: NodeJS.ProcessEnv;
	/** Where updateDetached keeps its running child's pid (tests); default in the temp dir. */
	updatePidFile?: string;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function parseCollections(out: string): string[] {
	const names: string[] = [];
	for (const line of out.replace(ANSI, "").split("\n")) {
		const m = /^(\S+) \(qmd:\/\/([^/)]+)\/\)/.exec(line);
		if (m && m[1] === m[2]) names.push(m[1]!);
	}
	return names;
}

/** Hits from `qmd query --format json`, split into memory ids and other collections' hits. */
export function parseQuery(out: string, extra: readonly string[]): QueryResult {
	const rows = JSON.parse(out) as unknown;
	if (!Array.isArray(rows)) throw new Error("qmd query: not a list");
	const ids: string[] = [];
	const outside: OutsideHit[] = [];
	for (const row of rows) {
		const r = row as Record<string, unknown>;
		if (typeof r.file !== "string") continue;
		const m = /^qmd:\/\/([^/]+)\/(.+)$/.exec(r.file);
		if (!m) continue;
		const [, coll, rel] = m as unknown as [string, string, string];
		const parts = rel.split("/");
		if (parts.some((p) => p === ".." || p === "." || p === "")) continue;
		if (coll === COLLECTION_NAME) {
			if (parts[0] !== "global" && parts[0] !== "projects") continue;
			const id = parts[parts.length - 1]!.replace(/\.md$/i, "").toLowerCase();
			if (ID.test(id) && !ids.includes(id)) ids.push(id);
		} else if (extra.includes(coll)) {
			const snippet = typeof r.snippet === "string" ? oneLine(r.snippet).slice(0, 300) : "";
			outside.push({ collection: coll, file: oneLine(r.file).slice(0, 300), snippet, score: typeof r.score === "number" ? r.score : 0 });
		}
	}
	return { ids, outside };
}

export interface Qmd {
	/** Collections qmd knows, or null when qmd is off, missing or failing. Cached. */
	collections(): Promise<string[] | null>;
	hasMemory(): Promise<boolean>;
	query(text: string, n: number, extra: readonly string[]): Promise<QueryResult | null>;
	setup(): Promise<string>;
	scheduleUpdate(): void;
	/** Run `qmd update` now, detached (the CLI, which exits right after). */
	updateDetached(): Promise<void>;
	lastError(): string | undefined;
	dispose(): void;
}

export function qmdClient(opts: QmdOptions): Qmd {
	const bin = opts.bin ?? "qmd";
	const timeoutMs = opts.timeoutMs ?? 5000;
	const debounceMs = opts.debounceMs ?? 30_000;
	let cached: Promise<string[] | null> | undefined;
	let error: string | undefined;
	let warned = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const env = { ...(opts.env ?? process.env), NO_COLOR: "1" };

	const fail = (msg: string) => {
		error = msg;
		if (!warned) {
			warned = true;
			opts.log?.(`pi-memory: qmd: ${msg}; using built-in search`);
		}
	};

	function run(args: string[], ms = timeoutMs): Promise<RunResult> {
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			const done = (r: RunResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(kill);
				resolve(r);
			};
			const child = spawn(bin, args, { cwd: opts.root, env, stdio: ["ignore", "pipe", "pipe"] });
			const kill = setTimeout(() => {
				child.kill("SIGKILL");
				done({ code: 1, stdout, stderr, timedOut: true });
			}, ms);
			child.stdout.setEncoding("utf8").on("data", (d: string) => {
				if (stdout.length < MAX_OUT) stdout += d;
			});
			child.stderr.setEncoding("utf8").on("data", (d: string) => {
				if (stderr.length < 64 * 1024) stderr += d;
			});
			child.on("error", (e: NodeJS.ErrnoException) => done({ code: 1, stdout, stderr: e.message, missing: e.code === "ENOENT" }));
			child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
		});
	}

	const collections = (): Promise<string[] | null> => {
		if (opts.mode === "off") return Promise.resolve(null);
		cached ??= run(["collection", "list"]).then((r) => {
			if (r.missing) return null;
			if (r.code !== 0) {
				fail(r.timedOut ? "timed out" : `collection list exited ${r.code}`);
				return null;
			}
			return parseCollections(r.stdout);
		});
		return cached;
	};

	const hasMemory = async () => (await collections())?.includes(COLLECTION_NAME) ?? false;

	return {
		collections,
		hasMemory,

		async query(text, n, extra) {
			if (opts.mode === "off") return null;
			const q = text.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
			if (!q) return null;
			const known = await collections();
			if (!known) return null;
			const colls = [...(known.includes(COLLECTION_NAME) ? [COLLECTION_NAME] : []), ...extra.filter((c) => COLLECTION.test(c) && known.includes(c))];
			if (colls.length === 0) return null;
			const limit = Math.max(1, Math.min(100, Math.trunc(n)));
			const r = await run(["query", ...colls.flatMap((c) => ["-c", c]), "--format", "json", "-n", String(limit), "--", q]);
			if (r.code !== 0) {
				fail(r.timedOut ? `query timed out after ${timeoutMs / 1000}s` : `query exited ${r.code}`);
				return null;
			}
			try {
				return parseQuery(r.stdout, extra);
			} catch (err) {
				fail((err as Error).message);
				return null;
			}
		},

		async setup() {
			if (opts.mode === "off") return 'qmd is off (memory.qmd is "off").';
			const known = await collections();
			if (!known) return "qmd isn't available (not on PATH, or `qmd collection list` failed).";
			if (known.includes(COLLECTION_NAME)) return "The qmd collection `memory` is already set up.";
			const add = await run(["collection", "add", "--name", COLLECTION_NAME, "--mask", "**/*.md", "--", opts.root], 60_000);
			cached = undefined;
			if (add.code !== 0) return `qmd collection add failed: ${(add.stderr || add.stdout).trim().slice(0, 300)}`;
			const up = await run(["update"], 300_000);
			if (up.code !== 0) return `Added the qmd collection \`memory\`, but qmd update failed: ${(up.stderr || up.stdout).trim().slice(0, 300)}`;
			return `Added the qmd collection \`memory\` (${opts.root}) and indexed it. Embeddings follow your usual \`qmd embed\`.`;
		},

		scheduleUpdate() {
			if (opts.mode === "off" || timer) return;
			timer = setTimeout(async () => {
				timer = undefined;
				if (await hasMemory()) await run(UPDATE_ARGS, 300_000);
			}, debounceMs);
			timer.unref?.();
		},

		async updateDetached() {
			if (!(await hasMemory())) return;
			const pidFile = opts.updatePidFile ?? join(tmpdir(), `pi-memory-qmd-update-${process.getuid?.() ?? 0}.pid`);
			let last = NaN;
			try {
				last = Number(readFileSync(pidFile, "utf8").trim());
			} catch {}
			if (alive(last)) return; // the running one indexes this write too, or the next one will
			const child = spawn(bin, UPDATE_ARGS, { cwd: opts.root, env, stdio: "ignore", detached: true });
			child.on("error", () => {});
			if (child.pid) {
				try {
					writeFileSync(pidFile, `${child.pid}\n`);
				} catch {}
			}
			child.unref();
		},

		lastError: () => error,

		dispose() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}
