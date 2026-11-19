/**
 * Watcher state on disk and the script runner.
 *
 * Per watcher, in `<stateRoot>/<id>/` (0700); with `scope = "repo"`, per
 * (watcher, repo) in `<stateRoot>/<id>/<slug>-<sha256(toplevel)[0:8]>/`:
 *   seen.jsonl     delivered event ids, one {"id","at"} per line; 14-day TTL
 *   wakes.json     wake timestamps (cross-session cap)
 *   host.json      {lastPollAt}: drives the backlog summary
 *   holder.lock    {pid, startedAt, instance}: only the holder polls
 *   run.lock       {pid, startedAt, instance}: held for one script run, so two
 *                  runs never share the folder (even across a takeover)
 *   state.json     the script's own state; it writes state.json.next only.
 *                  After exit 0 (outside a dry run) the host takes that file
 *                  and writes it over state.json once the run's events are
 *                  delivered. No other *.next is ever touched.
 *
 * Pure node, no pi imports.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_PASS_RE, type WatcherConfig } from "./config.ts";
import { normalize } from "./contract.ts";

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
export function writeAtomic(file: string, data: string | Buffer): void {
	const tmp = `${file}.${process.pid}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
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

/** A pid a lock may name: 0, -1 and 1 would make `kill(pid, 0)` signal a group or init, which always "lives". */
export const validPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) > 1;

export const isAlive = (pid: number): boolean => {
	if (!validPid(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** `ps -o etime=` ([[dd-]hh:]mm:ss) in seconds; undefined if it doesn't parse. */
export function parseEtime(s: string): number | undefined {
	const m = /^(?:(?:(\d+)-)?(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(s.trim());
	if (!m) return undefined;
	const [, d = "0", h = "0", mi = "0", se = "0"] = m;
	return ((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(se);
}

/**
 * When a pid's process started (ms), from its elapsed time (`ps -o etime=`),
 * so the answer doesn't depend on any time zone; undefined if unknown.
 */
export function pidStartedAt(pid: number, now = Date.now()): number | undefined {
	if (!validPid(pid)) return undefined;
	try {
		const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { PATH: "/bin:/usr/bin", LC_ALL: "C", TZ: "UTC" } });
		const secs = parseEtime(r.stdout ?? "");
		return secs === undefined ? undefined : now - secs * 1000;
	} catch {
		return undefined;
	}
}

/**
 * The lock's owner still runs: its pid is alive and that process started
 * before the lock was written (else the pid was reused). `ps` has 1 s
 * resolution, so allow 2 s.
 */
export function lockOwnerAlive(l: LockInfo): boolean {
	if (!validPid(l.pid) || !isAlive(l.pid)) return false;
	if (l.pid === process.pid) return true;
	const started = pidStartedAt(l.pid);
	return started === undefined || started <= l.startedAt + 2000;
}

function readLockFile(file: string): LockInfo | undefined {
	const l = readJson<LockInfo>(file);
	return l && Number.isInteger(l.pid) && typeof l.instance === "string" && typeof l.startedAt === "number" ? l : undefined;
}

export function readLock(dir: string): LockInfo | undefined {
	return readLockFile(join(dir, "holder.lock"));
}

/**
 * Create the lock with its content in one step: write a temp file, then
 * link it into place (link fails if the lock exists). A reader never sees
 * an empty or half-written lock.
 */
function createExclusive(file: string, me: LockInfo): boolean {
	const tmp = `${file}.new-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeSync(fd, JSON.stringify(me));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		linkSync(tmp, file);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		return false;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** An unreadable lock this young counts as live (it may be mid-replace); older, it's stale. */
export const UNREADABLE_LIVE_MS = 2000;

function unreadableAndYoung(file: string): boolean {
	try {
		return Date.now() - statSync(file).mtimeMs < UNREADABLE_LIVE_MS;
	} catch {
		return false; // gone
	}
}

/**
 * Remove the lock at `file` only if it's still the one judged stale. It's
 * renamed aside first (atomic), then checked; a lock someone else created in
 * between is put back (link fails if yet another one appeared, and then that
 * one stands).
 */
function removeIfSame(file: string, judged: LockInfo | undefined): void {
	const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(file, aside);
	} catch {
		return; // already gone
	}
	const got = readLockFile(aside);
	const same = judged ? got?.instance === judged.instance && got?.startedAt === judged.startedAt : got === undefined;
	if (!same) {
		try {
			linkSync(aside, file);
		} catch {
			// a newer lock exists; it wins
		}
	}
	rmSync(aside, { force: true });
}

function takeLock(
	file: string,
	me: LockInfo,
	stale: (l: LockInfo) => boolean,
	force: boolean,
): { ok: true } | { ok: false; holder?: LockInfo } {
	for (let attempt = 0; attempt < 3; attempt++) {
		if (createExclusive(file, me)) return { ok: true };
		const cur = readLockFile(file);
		if (cur?.instance === me.instance) return { ok: true };
		if (cur && !force && !stale(cur)) return { ok: false, holder: cur };
		if (!cur && !force && unreadableAndYoung(file)) return { ok: false };
		removeIfSame(file, cur);
	}
	const cur = readLockFile(file);
	if (cur?.instance === me.instance) return { ok: true };
	if (cur) return { ok: false, holder: cur };
	return createExclusive(file, me) ? { ok: true } : { ok: false, holder: readLockFile(file) };
}

/**
 * Take the holder lock, created atomically (temp file, then link). A lock
 * whose owner is gone (dead pid, a reused pid, a pid of 1 or less, or
 * unreadable for over 2 s) is stale and replaced, race-free. `force`
 * replaces a live holder (takeover). Returns the live holder when the lock is
 * someone else's.
 */
export function acquireLock(
	dir: string,
	me: LockInfo,
	opts: { force?: boolean; alive?: (l: LockInfo) => boolean } = {},
): { ok: true } | { ok: false; holder?: LockInfo } {
	const alive = opts.alive ?? lockOwnerAlive;
	return takeLock(join(dir, "holder.lock"), me, (l) => !alive(l), !!opts.force);
}

export function holdsLock(dir: string, instance: string): boolean {
	return readLock(dir)?.instance === instance;
}

export function releaseLock(dir: string, instance: string): void {
	if (holdsLock(dir, instance)) removeIfSame(join(dir, "holder.lock"), readLock(dir));
}

/** How long a run lock may be held before it's stale whoever holds it: the run timeout plus slack. */
export const RUN_LOCK_MAX_MS = 60_000;

/**
 * The per-run lock (`run.lock`, O_EXCL): at most one script run in the folder
 * at a time, even when a takeover overlaps a run still in flight. Stale when
 * its owner is gone or it's older than RUN_LOCK_MAX_MS.
 */
export function acquireRunLock(dir: string, me: LockInfo, opts: { now?: number; alive?: (l: LockInfo) => boolean } = {}): boolean {
	const alive = opts.alive ?? lockOwnerAlive;
	const now = opts.now ?? Date.now();
	return takeLock(join(dir, "run.lock"), me, (l) => !alive(l) || now - l.startedAt > RUN_LOCK_MAX_MS, false).ok;
}

export function releaseRunLock(dir: string, instance: string): void {
	const file = join(dir, "run.lock");
	const cur = readLockFile(file);
	if (cur?.instance === instance) removeIfSame(file, cur);
}

// ── script state files ──

export const STATE_FILE = "state.json";
export const NEXT_FILE = "state.json.next";

/** Delete a leftover state.json.next from a run that didn't commit. Nothing else. */
export function clearNext(dir: string): string[] {
	if (!existsSync(join(dir, NEXT_FILE))) return [];
	rmSync(join(dir, NEXT_FILE), { force: true });
	return [NEXT_FILE];
}

/** Take the run's state.json.next (read and remove it), to commit once its events are delivered. */
export function takeNext(dir: string): Buffer | undefined {
	const file = join(dir, NEXT_FILE);
	let data: Buffer;
	try {
		data = readFileSync(file);
	} catch {
		return undefined;
	}
	rmSync(file, { force: true });
	return data;
}

/** Write a taken state over state.json (temp, fsync, rename). */
export function commitState(dir: string, data: Buffer): void {
	writeAtomic(join(dir, STATE_FILE), data);
}

/** Commit state.json.next now, if there is one. Only state.json; never any other file. */
export function commitNext(dir: string): string[] {
	const data = takeNext(dir);
	if (!data) return [];
	commitState(dir, data);
	return [NEXT_FILE];
}

/** A throwaway copy of the state dir for a dry run: the script reads its state but nothing it writes survives. */
export function dryRunDir(dir: string): string {
	const tmp = mkdtempSync(join(tmpdir(), "pi-watchers-dry-"));
	if (existsSync(join(dir, STATE_FILE))) copyFileSync(join(dir, STATE_FILE), join(tmp, STATE_FILE));
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

/** The fixed names that reach the script, besides GH_* and GITHUB_*. */
export const ENV_BASE = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME"];

/** Per-session WATCHER_* values: the realpath'd session cwd, and the remote's owner/name and host when they resolve. */
export interface SessionEnv {
	cwd?: string;
	repo?: string;
	host?: string;
}

/** Only these variables reach the script: ENV_BASE, every GH_* and GITHUB_*, and the WATCHER_* ones. */
export function scriptEnv(
	cfg: WatcherConfig,
	stateDir: string,
	dryRun: boolean,
	env: NodeJS.ProcessEnv = process.env,
	session: SessionEnv = {},
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of ENV_BASE) if (env[k]) out[k] = env[k] as string;
	for (const [k, v] of Object.entries(env)) if (v && ENV_PASS_RE.test(k)) out[k] = v;
	out.WATCHER_ID = cfg.id;
	out.WATCHER_STATE_DIR = stateDir;
	out.WATCHER_ME = cfg.me;
	if (session.cwd) out.WATCHER_CWD = session.cwd;
	if (session.repo) out.WATCHER_REPO = session.repo;
	if (session.host) out.WATCHER_HOST = session.host;
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
	/** WATCHER_CWD, WATCHER_REPO and WATCHER_HOST. */
	session?: SessionEnv;
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
				env: scriptEnv(cfg, opts.stateDir, !!opts.dryRun, opts.env, opts.session),
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
			const tail = stderrTail(stderr);
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[@-_]/g;

/** stderr's last non-empty line, escape sequences and invisible characters gone, at most 200 characters. */
export function stderrTail(stderr: string): string {
	const last = stderr.replace(ANSI, "").trim().split("\n").at(-1) ?? "";
	return normalize(last, 200);
}

export function killAll(children: Set<ChildProcess>): void {
	for (const c of children) killGroup(c);
	children.clear();
}
