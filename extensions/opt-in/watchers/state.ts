/**
 * Watcher state on disk and the script runner.
 *
 * Per watcher, in `<stateRoot>/<id>/` (0700):
 *   seen.jsonl     delivered event ids, one {"id","at"} per line; 14-day TTL
 *   wakes.json     wake timestamps (cross-session cap)
 *   host.json      {lastPollAt}: drives the backlog summary
 *   holder.lock    {pid, startedAt, instance}: only the holder polls
 *   state.json     the script's own state; it writes state.json.next and the
 *                  host renames it over only on exit 0 outside a dry run
 *
 * Pure node, no pi imports.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { WatcherConfig } from "./config.ts";

export const SEEN_TTL_MS = 14 * 24 * 3_600_000;
export const RUN_TIMEOUT_MS = 45_000;
export const MAX_STDOUT = 1024 * 1024;

export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_WATCHERS_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-watchers");
}

export function ensureDir(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Write via a temp file, fsync, rename. */
export function writeAtomic(file: string, data: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

// ── seen ids ──

export class SeenStore {
	readonly file: string;
	private readonly ids = new Map<string, number>();

	constructor(dir: string) {
		this.file = join(dir, "seen.jsonl");
	}

	/** Load and drop entries older than the TTL, rewriting the file when any went. */
	load(now = Date.now()): this {
		this.ids.clear();
		let text = "";
		try {
			text = readFileSync(this.file, "utf8");
		} catch {
			return this;
		}
		let dropped = 0;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const { id, at } = JSON.parse(line) as { id: string; at: number };
				if (typeof id !== "string" || typeof at !== "number") throw new Error();
				if (now - at > SEEN_TTL_MS) dropped++;
				else this.ids.set(id, Math.max(at, this.ids.get(id) ?? 0));
			} catch {
				dropped++;
			}
		}
		if (dropped) writeAtomic(this.file, [...this.ids].map(([id, at]) => `${JSON.stringify({ id, at })}\n`).join(""));
		return this;
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}

	get size(): number {
		return this.ids.size;
	}

	add(ids: string[], now = Date.now()): void {
		const fresh = ids.filter((id) => !this.ids.has(id));
		if (!fresh.length) return;
		for (const id of fresh) this.ids.set(id, now);
		writeFileSync(this.file, fresh.map((id) => `${JSON.stringify({ id, at: now })}\n`).join(""), { flag: "a", mode: 0o600 });
	}
}

// ── wakes (cross-session) ──

export function readWakes(dir: string, now = Date.now()): number[] {
	const list = readJson<number[]>(join(dir, "wakes.json"));
	return Array.isArray(list) ? list.filter((t) => typeof t === "number" && now - t < 3_600_000) : [];
}

export function recordWake(dir: string, now = Date.now()): void {
	writeAtomic(join(dir, "wakes.json"), JSON.stringify([...readWakes(dir, now), now]));
}

// ── host state ──

export function readHost(dir: string): { lastPollAt?: number } {
	return readJson<{ lastPollAt?: number }>(join(dir, "host.json")) ?? {};
}

export function writeHost(dir: string, h: { lastPollAt?: number }): void {
	writeAtomic(join(dir, "host.json"), JSON.stringify(h));
}

// ── holder lock ──

export interface LockInfo {
	pid: number;
	startedAt: number;
	instance: string;
}

export const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

export function readLock(dir: string): LockInfo | undefined {
	const l = readJson<LockInfo>(join(dir, "holder.lock"));
	return l && Number.isInteger(l.pid) && typeof l.instance === "string" ? l : undefined;
}

/**
 * Take the holder lock with O_EXCL. A lock whose pid is dead (or that can't
 * be read) is stale and replaced. `force` replaces a live holder (takeover).
 * Returns the live holder when the lock is someone else's.
 */
export function acquireLock(
	dir: string,
	me: LockInfo,
	opts: { force?: boolean; alive?: (pid: number) => boolean } = {},
): { ok: true } | { ok: false; holder: LockInfo } {
	const file = join(dir, "holder.lock");
	const alive = opts.alive ?? isAlive;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = openSync(file, "wx", 0o600);
			try {
				writeSync(fd, JSON.stringify(me));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return { ok: true };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const cur = readLock(dir);
		if (cur?.instance === me.instance) return { ok: true };
		if (cur && alive(cur.pid) && !opts.force) return { ok: false, holder: cur };
		rmSync(file, { force: true });
	}
	const cur = readLock(dir);
	return cur && cur.instance !== me.instance ? { ok: false, holder: cur } : { ok: true };
}

export function holdsLock(dir: string, instance: string): boolean {
	return readLock(dir)?.instance === instance;
}

export function releaseLock(dir: string, instance: string): void {
	if (holdsLock(dir, instance)) rmSync(join(dir, "holder.lock"), { force: true });
}

// ── script state files ──

const NEXT = /\.next$/;

/** Delete leftover *.next files from a run that didn't commit. */
export function clearNext(dir: string): string[] {
	const gone: string[] = [];
	for (const name of safeList(dir)) {
		if (NEXT.test(name)) {
			rmSync(join(dir, name), { force: true });
			gone.push(name);
		}
	}
	return gone;
}

/** Rename every *.next over its live file. Only after exit 0, never in a dry run. */
export function commitNext(dir: string): string[] {
	const done: string[] = [];
	for (const name of safeList(dir)) {
		if (!NEXT.test(name)) continue;
		const from = join(dir, name);
		try {
			const fd = openSync(from, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch {
			continue;
		}
		renameSync(from, join(dir, name.replace(NEXT, "")));
		done.push(name);
	}
	return done;
}

function safeList(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** A throwaway copy of the state dir for a dry run: the script reads its state but nothing it writes survives. */
export function dryRunDir(dir: string): string {
	const tmp = mkdtempSync(join(tmpdir(), "pi-watchers-dry-"));
	if (existsSync(join(dir, "state.json"))) copyFileSync(join(dir, "state.json"), join(tmp, "state.json"));
	return tmp;
}

// ── running a script ──

export interface RunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: Buffer;
	/** Host-made reason; never script text. */
	error?: string;
	/** The last line of stderr, for /watchers only (never sent to the agent). */
	stderrTail: string;
}

/** Only these variables reach the script. */
export function scriptEnv(cfg: WatcherConfig, stateDir: string, dryRun: boolean, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of ["PATH", "HOME", "LANG"]) if (env[k]) out[k] = env[k] as string;
	for (const k of cfg.passEnv) if (env[k]) out[k] = env[k] as string;
	out.WATCHER_ID = cfg.id;
	out.WATCHER_STATE_DIR = stateDir;
	out.WATCHER_ME = cfg.me;
	if (dryRun) out.WATCHER_DRY_RUN = "1";
	return out;
}

const killGroup = (child: ChildProcess) => {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// gone
		}
	}
};

export interface RunOptions {
	cwd: string;
	stateDir: string;
	dryRun?: boolean;
	timeoutMs?: number;
	maxStdout?: number;
	env?: NodeJS.ProcessEnv;
	/** Live children, so shutdown can kill them. */
	children?: Set<ChildProcess>;
}

/**
 * Run the watcher's command with no shell, in its own process group, config
 * on stdin. On timeout or oversized stdout the whole group gets SIGKILL.
 */
export function runScript(cfg: WatcherConfig, opts: RunOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		const [cmd, ...args] = cfg.command as [string, ...string[]];
		let child: ChildProcess;
		try {
			child = spawn(cmd, args, {
				cwd: opts.cwd,
				env: scriptEnv(cfg, opts.stateDir, !!opts.dryRun, opts.env),
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});
		} catch (e) {
			resolve({ code: null, signal: null, stdout: Buffer.alloc(0), error: `spawn failed: ${(e as Error).message}`, stderrTail: "" });
			return;
		}
		opts.children?.add(child);
		const max = opts.maxStdout ?? MAX_STDOUT;
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let error: string | undefined;
		const timer = setTimeout(() => {
			error = "timed out";
			killGroup(child);
		}, opts.timeoutMs ?? RUN_TIMEOUT_MS);
		child.stdout?.on("data", (b: Buffer) => {
			size += b.length;
			if (size > max) {
				if (!error) error = "stdout over 1 MB";
				killGroup(child);
				return;
			}
			chunks.push(b);
		});
		child.stderr?.on("data", (b: Buffer) => {
			stderr = (stderr + b.toString("utf8")).slice(-4096);
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(cfg.raw));
		let done = false;
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			opts.children?.delete(child);
			// Anything the script left running in its group goes too.
			if (child.pid)
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// the group is gone
				}
			const tail = stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
			if (!error && code !== 0) error = signal ? `killed by ${signal}` : `exit ${code}`;
			resolve({ code, signal, stdout: Buffer.concat(chunks), error, stderrTail: tail });
		};
		child.on("error", (e) => {
			error = `spawn failed: ${e.message}`;
			finish(null, null);
		});
		child.on("close", finish);
	});
}

export function killAll(children: Set<ChildProcess>): void {
	for (const c of children) killGroup(c);
	children.clear();
}
