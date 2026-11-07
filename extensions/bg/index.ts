/**
 * bg.ts — background task runner for pi
 *
 * Design goals: minimal permanent context cost, minimal boot cost.
 *
 *   Context: +~55 tokens total. Adds one optional `background` boolean to the
 *            existing built-in `bash` tool instead of registering bg_start /
 *            bg_status / bg_logs / bg_wait / bg_kill. Status and logs need no
 *            tools — the log is a plain file the model reads with `read`.
 *            One description sentence documents the foreground budget.
 *   Boot:    ~20ms. Single file, no npm dependencies. Nothing is started at
 *            factory time; all resources come up in session_start.
 *
 * Foreground auto-background:
 *   Without `background` or an explicit `timeout`, commands run in the
 *   foreground for up to PI_BG_FG_TIMEOUT seconds (default 120), then are
 *   adopted as bg jobs. The tool result returns "moved to background" + log
 *   path immediately, and the normal completion wake delivers exit code +
 *   tail later — no polling tokens. On a foreground command, an explicit
 *   `timeout` keeps pi's built-in hard-deadline semantics and kills the command
 *   if it expires. PI_BG_MAX_TIMEOUT caps that deadline (default 600 seconds).
 *   Completion within the foreground budget is silent (quiet): the result already
 *   carries the outcome. PI_BG_FG_TIMEOUT=0 disables
 *   auto-backgrounding.
 *
 * UI:
 *   above prompt    "● 2 background jobs · rspec 1m12s · vite 12s · /bg"
 *                   Live elapsed times, hidden when idle; zero model tokens.
 *   /bg             job list; ↑/↓ select, enter opens a full-screen live log,
 *                   x stops the selected job, esc closes
 *   ctrl+shift+b    same panel
 *
 *   ctrl+shift+b only reaches pi where the terminal disambiguates it via the
 *   Kitty/CSI-u protocol (tmux: `extended-keys on` + `extended-keys-format
 *   csi-u`). Without that it collapses to 0x02, i.e. plain ctrl+b — swallowed
 *   as the tmux prefix, or read as tui.editor.cursorLeft outside tmux. The
 *   failure mode is a dead shortcut, never a false trigger, so /bg is the
 *   portable path and the one to reach for on an unfamiliar host.
 *
 * Wake:
 *   When a job exits, injects exit code + tail into the conversation and
 *   triggers a turn. User-initiated kills never wake the model.
 *
 * Event bus (for other extensions, e.g. subagent.ts):
 *   pi.events.emit("bg:start", req) starts `req.command` as a regular bg job
 *   (same widget, /bg panel, kill, and wake). bg.ts sets `req.accepted = true`
 *   synchronously, so the sender can detect that bg.ts is not loaded, then calls
 *   `req.reply({ id, logPath } | { error })`. Optional per-job overrides: `name`
 *   (widget label), `summary` (wake header instead of the command), and
 *   `tailLines`/`tailMaxChars` (how much of the log the wake carries), and
 *   `details` is ignored unless this process's cursor runner marked the request
 *   (an unexported WeakSet in runner.ts; a forged stack cannot). Even then,
 *   PI_BG_LOG is set only when the command's argv[1] realpaths to runner.ts.
 *   That flag is not saved. At completion the sidecar is read only when the
 *   job command still realpaths there. The diff in `<log>.details.json` joins
 *   the completion message's details.
 *   bg.ts emits "bg:jobs" with a snapshot of its jobs (id, name, command, cwd,
 *   logPath, startedAt, endedAt, exitCode, signal, killedByUser; foreground
 *   jobs still racing their budget left out) on every start, adoption and
 *   exit, and answers pi.events.emit("bg:list", { reply }) with the same.
 *   pi.events.emit("bg:kill", { id, wake?, reply }) stops a running job as
 *   x in /bg does (sets `accepted`, replies `{ killed }`). `wake: true` still
 *   wakes the model with "killed", for a stop the model didn't ask for (a
 *   subagent stopped from Eric's phone), so it doesn't wait on that result.
 *
 * Surviving /reload and restarts:
 *   Every job runs under a tiny /bin/sh wrapper that writes its exit status to
 *   `<log>.exit` (temp file + mv) when it ends, so a job that is no longer our
 *   child still reports its exit code.
 *   /reload: session_shutdown leaves a hand-off in a globalThis slot; the next
 *   instance takes the whole job table if it opens the same session id. The
 *   old instance keeps the ChildProcess handles and forwards their exits.
 *   Restart / resume: each persisted session's jobs (metadata, never output)
 *   are kept in STATE_DIR/<session id>.json. session_start for that session
 *   re-adopts jobs whose leader is provably still the job (pid + start time +
 *   the wrapper's args), polls them, and reports once the ones that ended
 *   while the session was closed. /new and /fork open a new session id, so
 *   they start empty.
 *
 * Env knobs:
 *   PI_BG_DIR         log/spool directory (default /tmp/pi-bg-<uid>, mode
 *                     0700; not $TMPDIR — macOS makes that per-user and
 *                     unguessable, and purges it out from under running jobs)
 *   PI_BG_STATE_DIR   job registry directory (default
 *                     $XDG_STATE_HOME/pi-bg or ~/.local/state/pi-bg, 0700)
 *   PI_BG_TAIL_LINES  lines injected on completion (default 15, 0 disables)
 *   PI_BG_WAKE        followUp | nextTurn | off  (default followUp)
 *   PI_BG_FG_TIMEOUT  foreground seconds before auto-background (default
 *                     120; 0 disables auto-background)
 *   PI_BG_MAX_TIMEOUT maximum explicit foreground timeout in seconds (default
 *                     600); larger values are clamped, except values that read
 *                     as milliseconds (e.g. 60000 for a minute) are converted
 *                     to seconds first — models confuse the units constantly
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getShellConfig,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { commandRunsCursorRunner, maskDiffSecrets, readJobDetails, trustJobDetails } from "../../lib/cursor-diff.ts";
import { cursorDetailsRequested } from "../opt-in/cursor-agent/runner.ts";
import { registerBgCodemode } from "./codemode.ts";

// Deliberately NOT os.tmpdir(): on macOS that is /var/folders/<hash>/T, which is
// unguessable for a path we hand to the model, and macOS purges it periodically —
// which would delete the logs of exactly the long-running jobs this exists for.
// Suffixed with the uid so two users on one box cannot collide on ownership of
// a shared /tmp/pi-bg directory.
function defaultBgDir(): string {
	if (process.platform === "win32") return path.join(os.tmpdir(), "pi-bg");
	let uid = "";
	try {
		uid = `-${os.userInfo().uid}`;
	} catch {
		// uid unavailable; fall back to the bare path
	}
	return `/tmp/pi-bg${uid}`;
}

const BG_DIR = process.env.PI_BG_DIR ?? defaultBgDir();
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Only ever delete files this extension created: <6 hex>.log and its wrapper's exit file. */
const LOG_NAME_RE = /^[0-9a-f]{6}\.log(\.exit(\.tmp)?)?$/;
const JOB_ID_RE = /^[0-9a-f]{6}$/;

/**
 * The registry outlives /tmp cleaners and reboots-in-between; it only holds
 * metadata (commands, paths, pids), never output.
 */
const STATE_DIR =
	process.env.PI_BG_STATE_DIR ??
	path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-bg");
/** Not-running entries older than this are dropped unreported. */
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
/** Session ids name registry files: no separators, no leading dot. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Exit polling for jobs that aren't a child of this process. */
const ADOPTED_POLL_MS = 2000;
/** Re-check an adopted job's identity every this many polls, in case its pid was reused between two. */
const VERIFY_EVERY_POLLS = 15;
/** The wrapper, the registry and adoption need /bin/sh and ps. */
const DURABLE = process.platform !== "win32";

/**
 * Runs the job's shell ("$@") and records its exit status in $0 (`<log>.exit`)
 * through a temp file + mv, so a reader never sees a partial file. The no-op
 * trap keeps the wrapper alive through a stop's group-wide SIGTERM until the job
 * is gone; trapped (unlike ignored) signals reset on exec, so the job itself
 * keeps default dispositions. A killed job reads as 128+N, like any shell.
 * set -C after the rm: the write never follows a link planted at the temp name.
 */
const EXIT_WRAPPER =
	'trap : TERM INT HUP; "$@"; s=$?; (umask 077; rm -f "$0.tmp"; set -C; printf \'%s\\n\' "$s" > "$0.tmp") && mv -f "$0.tmp" "$0"; exit "$s"';
const exitPathOf = (logPath: string) => `${logPath}.exit`;

/**
 * BG_DIR is a directory of ours that no one else can write to. Otherwise
 * another user could swap a log for a symlink to a secret, which a wake would
 * read into the conversation, or plant files the wrapper writes through.
 */
function bgDirReady(): boolean {
	try {
		fs.mkdirSync(BG_DIR, { recursive: true, mode: 0o700 });
		if (process.platform === "win32") return true;
		const st = fs.lstatSync(BG_DIR);
		const uid = process.getuid?.();
		return st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o022) === 0;
	} catch {
		return false;
	}
}

/** Spawned bare, a missing shell fails the start (ENOENT) instead of exiting 127 inside the wrapper later. */
function shellRunnable(shell: string): boolean {
	if (!path.isAbsolute(shell)) return true;
	try {
		fs.accessSync(shell, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Owned by us and not writable by anyone else: safe to trust what it says. */
function ownedPrivately(st: fs.Stats): boolean {
	const uid = process.getuid?.();
	return (uid === undefined || st.uid === uid) && (st.mode & 0o022) === 0;
}

/** Read a small private regular file without following a symlink. */
function readPrivateFile(file: string, maxBytes: number): { text: string; mtimeMs: number } | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const st = fs.fstatSync(fd);
		if (!st.isFile() || !ownedPrivately(st) || st.size > maxBytes) return undefined;
		return { text: fs.readFileSync(fd, "utf8"), mtimeMs: st.mtimeMs };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** The status the wrapper recorded, or undefined while the job runs (or if it was SIGKILLed). */
function readExitFile(logPath: string): { code: number; at: number } | undefined {
	const file = readPrivateFile(exitPathOf(logPath), 16);
	const match = file && /^(\d{1,3})\n?$/.exec(file.text);
	const code = match ? Number(match[1]) : Number.NaN;
	return file && code <= 255 ? { code, at: file.mtimeMs } : undefined;
}

function removeExitFile(logPath: string): void {
	try {
		fs.rmSync(exitPathOf(logPath), { force: true });
	} catch {
		// best-effort; pruned with the logs
	}
}

function signalName(number: number): NodeJS.Signals | undefined {
	for (const [name, value] of Object.entries(os.constants.signals)) {
		if (value === number) return name as NodeJS.Signals;
	}
	return undefined;
}

interface ProcessIdentity {
	/** ps lstart, pinned to C locale and UTC: the same process always reads the same. */
	start: string;
	args: string;
}
const psArgs = (pid: number) => ["-ww", "-o", "lstart=", "-o", "args=", "-p", String(pid)];
const PS_OPTIONS = { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 3000, encoding: "utf8" as const };
/** The synchronous lookup (before a stop) blocks the UI: give up sooner. */
const PS_SYNC_TIMEOUT_MS = 1000;
const LSTART_RE = /^\s*([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

function parsePs(out: string): ProcessIdentity | undefined {
	const match = LSTART_RE.exec(out.split("\n")[0] ?? "");
	return match?.[1] && match[2] !== undefined ? { start: match[1], args: match[2] } : undefined;
}

function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
	return new Promise((resolve) => {
		try {
			execFile("ps", psArgs(pid), PS_OPTIONS, (error, stdout) =>
				resolve(error ? undefined : parsePs(String(stdout))),
			);
		} catch {
			resolve(undefined);
		}
	});
}

function processIdentitySync(pid: number): ProcessIdentity | undefined {
	try {
		return parsePs(
			String(
				execFileSync("ps", psArgs(pid), {
					...PS_OPTIONS,
					timeout: PS_SYNC_TIMEOUT_MS,
					stdio: ["ignore", "pipe", "ignore"],
				}),
			),
		);
	} catch {
		return undefined;
	}
}

/**
 * The pid is still the job's wrapper: started when the job was, and running
 * with this job's exit file in its argv. A process that merely inherited the
 * pid fails both.
 */
function isJobProcess(job: { logPath: string; pidStart?: string }, identity: ProcessIdentity | undefined): boolean {
	return (
		identity !== undefined &&
		job.pidStart !== undefined &&
		identity.start === job.pidStart &&
		identity.args.includes(` ${exitPathOf(job.logPath)} `)
	);
}

/** kill(pid, 0): ours and alive. EPERM means another user's process now holds the pid. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
const TAIL_LINES = Number.parseInt(process.env.PI_BG_TAIL_LINES ?? "15", 10);
const TAIL_MAX_CHARS = 2000;
const VIEWER_WINDOW_BYTES = 1024 * 1024;
const WAKE = (process.env.PI_BG_WAKE ?? "followUp") as "followUp" | "nextTurn" | "off";
const WIDGET_KEY = "bg";
const MAX_WIDGET_JOBS = 3;

/**
 * Foreground wait budget before a command with no explicit timeout is adopted
 * as a bg job instead of blocking the turn indefinitely. 0 disables the
 * feature entirely.
 */
const FG_TIMEOUT_SECS = (() => {
	const parsed = Number.parseInt(process.env.PI_BG_FG_TIMEOUT ?? "120", 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 120;
})();
/** Hard ceiling for model-supplied foreground timeouts, matching Claude's default. */
const MAX_TIMEOUT_SECS = (() => {
	const parsed = Number(process.env.PI_BG_MAX_TIMEOUT ?? "600");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
})();
/**
 * Interpret a model-supplied timeout in seconds. Values above the cap that
 * become a sane number of seconds once divided by 1000 are assumed to be
 * milliseconds (the recurring 60000-for-a-minute mistake) and converted;
 * anything else is returned as-is for clamping. The >= 1000 floor keeps
 * small second-scale values (and fractional test caps) out of the heuristic.
 */
function timeoutToSeconds(timeout: number): number {
	if (timeout >= 1000 && timeout > MAX_TIMEOUT_SECS && timeout / 1000 <= MAX_TIMEOUT_SECS) {
		return timeout / 1000;
	}
	return timeout;
}
/** Cap for partial output streamed to the TUI while a foreground job runs. */
const PARTIAL_CAP_BYTES = 64 * 1024;
/** setTimeout() clamps delays above 2^31-1 ms down to 1ms — keep under it. */
const MAX_TIMER_MS = 2_147_483_647;
/** Short output peek included in the "moved to background" tool result. */
const ADOPT_TAIL_LINES = 5;
const ADOPT_TAIL_CHARS = 400;
/** Limit of `structuredContent.output` for scripts, same as built-in bash. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * A job as plain data: what the registry stores, the /reload hand-off passes
 * and BgLive.deliver forwards. Never output.
 */
interface JobRecord {
	id: string;
	name: string;
	command: string;
	cwd: string;
	logPath: string;
	pid: number | undefined;
	/** ps lstart of the wrapper, recorded at spawn: adoption requires the same. */
	pidStart?: string;
	/** The persisted session the job was started in (its registry file). */
	sessionId?: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	/** Ended without a recorded status (not our child, and no exit file). */
	exitUnknown?: boolean;
	killedByUser: boolean;
	/** Killed through bg:kill with wake: the completion wake still applies. */
	wakeOnKill?: boolean;
	/** Foreground-race job: its tool result carries the outcome; suppress the wake. */
	quiet?: boolean;
	/** Wake header text instead of the command (event-bus jobs). */
	summary?: string;
	/** Per-job overrides of TAIL_LINES / TAIL_MAX_CHARS for the wake. */
	tailLines?: number;
	tailMaxChars?: number;
	/** Its completion reached a session (or the UI). */
	reported?: boolean;
	/** Not a child of this process: poll it, and verify it before any signal. */
	adopted?: boolean;
	/** Last time a pi saw it in the registry; ages out not-running entries. */
	seenAt?: number;
}

interface Job extends JobRecord {
	quiet: boolean;
	/** This instance holds the ChildProcess, whose exit event reports the job. */
	own: boolean;
	/** Ended while no pi had it; said in the wake. */
	whileDown?: boolean;
	/** The last signal a stop sent, for a stopped job whose status went unrecorded. */
	lastSignal?: NodeJS.Signals;
	polls?: number;
	/** Drop the child's event-loop ref so an adopted job outlives the turn. */
	unrefChild?: () => void;
}

function toRecord(job: Job): JobRecord {
	const { id, name, command, cwd, logPath, pid, pidStart, sessionId, startedAt, endedAt, exitCode, signal } = job;
	const { exitUnknown, killedByUser, wakeOnKill, quiet, summary, tailLines, tailMaxChars, reported, adopted } = job;
	return {
		id, name, command, cwd, logPath, pid, pidStart, sessionId, startedAt, endedAt, exitCode, signal,
		exitUnknown, killedByUser, wakeOnKill, quiet, summary, tailLines, tailMaxChars, reported, adopted,
		seenAt: Date.now(),
	};
}

/**
 * Validate a record from the registry or another bg instance. Its log must be
 * BG_DIR/<id>.log, so a record can't point a wake's tail at any other file, and
 * its pid is only ever signalled after isJobProcess() (adopted) or while it is
 * an unreaped child of this process (handed over).
 */
function parseRecord(raw: unknown): JobRecord | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
	const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
	const optional = <T>(value: unknown, ok: (v: unknown) => v is T): T | undefined => (ok(value) ? value : undefined);
	const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
	if (typeof r.id !== "string" || !JOB_ID_RE.test(r.id)) return undefined;
	if (r.logPath !== path.join(BG_DIR, `${r.id}.log`)) return undefined;
	if (!text(r.name, 100) || !text(r.command, 2 * 1024 * 1024) || !text(r.cwd, 4096) || !time(r.startedAt)) return undefined;
	if (r.pid !== undefined && !(typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 1)) return undefined;
	if (r.endedAt !== undefined && !time(r.endedAt)) return undefined;
	if (r.exitCode !== undefined && r.exitCode !== null && !count(r.exitCode)) return undefined;
	if (r.signal !== undefined && r.signal !== null && !(typeof r.signal === "string" && /^SIG[A-Z0-9]+$/.test(r.signal))) {
		return undefined;
	}
	return {
		id: r.id,
		name: r.name,
		command: r.command,
		cwd: r.cwd,
		logPath: r.logPath,
		pid: r.pid as number | undefined,
		pidStart: optional(r.pidStart, (v): v is string => text(v, 64)),
		sessionId: optional(r.sessionId, (v): v is string => typeof v === "string" && SESSION_ID_RE.test(v)),
		startedAt: r.startedAt,
		endedAt: r.endedAt as number | undefined,
		exitCode: r.exitCode as number | null | undefined,
		signal: r.signal as NodeJS.Signals | null | undefined,
		exitUnknown: r.exitUnknown === true,
		killedByUser: r.killedByUser === true,
		wakeOnKill: r.wakeOnKill === true,
		quiet: r.quiet === true,
		summary: optional(r.summary, (v): v is string => text(v, 10_000)),
		tailLines: optional(r.tailLines, count),
		tailMaxChars: optional(r.tailMaxChars, count),
		reported: r.reported === true,
		adopted: r.adopted === true,
		seenAt: optional(r.seenAt, time),
	};
}

const registryFile = (sessionId: string) => path.join(STATE_DIR, `${sessionId}.json`);

/**
 * STATE_DIR is a 0700 directory of ours (created when `create`). Anything else
 * (another user's, a symlink) and the registry is neither read nor written.
 */
function stateDirReady(create: boolean): boolean {
	try {
		if (create) fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
		const st = fs.lstatSync(STATE_DIR);
		const uid = process.getuid?.();
		if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return false;
		if ((st.mode & 0o077) !== 0) fs.chmodSync(STATE_DIR, 0o700);
		return true;
	} catch {
		return false;
	}
}

/** The session's registered jobs; [] for a missing, foreign, loose-permission or malformed file. */
function readRegistry(sessionId: string): JobRecord[] {
	if (!DURABLE || !SESSION_ID_RE.test(sessionId) || !stateDirReady(false)) return [];
	const file = readPrivateFile(registryFile(sessionId), REGISTRY_MAX_BYTES);
	if (!file) return [];
	try {
		const data = JSON.parse(file.text) as { v?: unknown; sessionId?: unknown; jobs?: unknown };
		if (data?.v !== 1 || data.sessionId !== sessionId || !Array.isArray(data.jobs)) return [];
		const byId = new Map<string, JobRecord>();
		for (const raw of data.jobs) {
			const record = parseRecord(raw);
			if (record) byId.set(record.id, { ...record, sessionId });
		}
		return [...byId.values()];
	} catch {
		return [];
	}
}

/** Replace the session's registry atomically (0600 temp file + rename); none left removes it. */
function writeRegistry(sessionId: string, records: JobRecord[]): void {
	if (!DURABLE || !SESSION_ID_RE.test(sessionId)) return;
	const file = registryFile(sessionId);
	if (records.length === 0) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// best-effort
		}
		return;
	}
	if (!stateDirReady(true)) return;
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	try {
		const jobs = records.map((record) => ({ ...record, quiet: undefined, adopted: undefined }));
		fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, sessionId, savedAt: Date.now(), jobs })}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		fs.renameSync(tmp, file);
	} catch {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best-effort
		}
	}
}

/**
 * Record jobs' current state in their sessions' registries, merged by id with
 * what is there (another instance may hold other jobs of the same session).
 * Reported endings drop out. Never throws.
 */
function persist(...list: Job[]): void {
	const bySession = new Map<string, Job[]>();
	for (const job of list) {
		if (!job.sessionId || job.quiet) continue;
		bySession.set(job.sessionId, [...(bySession.get(job.sessionId) ?? []), job]);
	}
	for (const [sessionId, jobs] of bySession) {
		try {
			const ids = new Set(jobs.map((job) => job.id));
			const existing = readRegistry(sessionId);
			const records = existing.filter((record) => !ids.has(record.id));
			for (const job of jobs) {
				if (job.endedAt !== undefined && job.reported) continue;
				// A copy handed over before ps answered lacks what the spawning instance wrote since.
				job.pidStart ??= existing.find((record) => record.id === job.id)?.pidStart;
				records.push(toRecord(job));
			}
			writeRegistry(sessionId, records);
		} catch {
			// the registry is best-effort
		}
	}
}

/**
 * The bg instance bound to the live session, shared across /reload. A reload
 * re-runs this factory with a fresh pi and invalidates the old one, but the
 * old instance's detached children keep running and their exit listeners
 * still fire into it. Those completions are forwarded here instead of
 * throwing "ctx is stale" out of a ChildProcess listener (which kills pi).
 * globalThis + Symbol.for: survives the module being re-imported on reload.
 */
interface BgLive {
	/** A finished job (a JobRecord, or an older version's Job). Throws if it can't be taken. */
	deliver(job: unknown): void;
}
/**
 * Left by session_shutdown for the next instance in this process. take()
 * returns the job table as records, current at the moment it is called (so it
 * includes jobs that ended in between), and only once.
 */
interface BgHandoff {
	sessionId: string | undefined;
	take(): JobRecord[];
}
const LIVE_KEY = Symbol.for("pi-boehsline.bg.live");
const HANDOFF_KEY = Symbol.for("pi-boehsline.bg.handoff");
const CHILDREN_KEY = Symbol.for("pi-boehsline.bg.children");
const liveSlot = globalThis as unknown as {
	[LIVE_KEY]?: BgLive;
	[HANDOFF_KEY]?: BgHandoff;
	[CHILDREN_KEY]?: Map<number, string>;
};

/**
 * pid -> job id of this process's unreaped bg children, kept by whichever
 * instance spawned them and shared by all. While a pid maps to a job's id it
 * can't belong to anything else, so that job's group may be signalled without
 * ps; a stale instance's copy of a job learns nothing else once it is gone.
 */
function childPids(): Map<number, string> {
	liveSlot[CHILDREN_KEY] ??= new Map();
	return liveSlot[CHILDREN_KEY];
}

type Verdict = "job" | "other" | "unknown";

/** Is the pid still the job? "unknown" when ps can't tell: then neither adopt, report, nor signal. */
function verdictOf(job: JobRecord, identity: ProcessIdentity | undefined, pid: number): Verdict {
	if (identity) {
		if (isJobProcess(job, identity)) return "job";
		// Without a recorded start time, only another program at the pid is proof.
		if (job.pidStart === undefined && identity.args.includes(` ${exitPathOf(job.logPath)} `)) return "unknown";
		return "other";
	}
	return pidAlive(pid) ? "unknown" : "other";
}

/** The session's id, persisted or not (the hand-off matches on it). */
function sessionIdOf(ctx: unknown): string | undefined {
	try {
		const id = (ctx as { sessionManager?: { getSessionId?(): string } } | undefined)?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

/** The id jobs are registered under: only a session with a file can be resumed. */
function registryIdOf(ctx: unknown): string | undefined {
	if (!DURABLE) return undefined;
	try {
		const manager = (ctx as { sessionManager?: { getSessionFile?(): string | undefined } } | undefined)?.sessionManager;
		const id = sessionIdOf(ctx);
		return manager?.getSessionFile?.() && id && SESSION_ID_RE.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * "bundle exec rspec spec/foo" -> "rspec". Best-effort label for the widget.
 * Skips shell keywords, wrappers, env assignments, and loop variables so that
 * e.g. `for i in $(seq 1 400); do echo ...` labels as "echo", not "for".
 */
const LABEL_SKIP = new Set([
	// shell control keywords
	"for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "in", "case", "esac",
	// wrappers and runners that say nothing about the job
	"sudo", "env", "time", "nohup", "exec", "command", "bundle", "npm", "npx", "pnpm", "yarn",
	"run", "bin/rails", "rails", "mise", "asdf", "uv", "poetry", "bunx", "deno", "task", "just",
]);

function labelFor(command: string): string {
	const words = command.trim().split(/\s+/);
	for (const word of words) {
		if (word.length < 2) continue; // loop vars like `i`
		if (word.includes("=")) continue; // FOO=bar prefixes
		if (!/^[A-Za-z0-9_.:/-]+$/.test(word)) continue; // $(seq, quotes, redirects
		if (/^\d+$/.test(word)) continue; // bare numbers
		if (LABEL_SKIP.has(word)) continue;
		return path.basename(word).slice(0, 14);
	}
	// Nothing looked like a program name; fall back to the first token that is
	// at least not an environment assignment.
	return words.find((word) => !word.includes("="))?.slice(0, 14) ?? "job";
}

function humanDuration(ms: number): string {
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

/**
 * pi's agent dir (mirrors pi's getAgentDir(); not part of the public API).
 * Used to replicate the built-in bash tool's PATH tweak and settings lookup.
 */
function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? path.join(os.homedir(), envDir.slice(1)) : envDir;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

/**
 * The env the built-in bash tool spawns with: process.env plus pi's bin dir
 * prepended to PATH (mirrors getShellEnv(), which is not public).
 */
function shellEnv(): NodeJS.ProcessEnv {
	const binDir = path.join(agentDir(), "bin");
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const entries = currentPath.split(path.delimiter).filter(Boolean);
	const updatedPath = entries.includes(binDir)
		? currentPath
		: [binDir, ...entries].join(path.delimiter);
	return { ...process.env, [pathKey]: updatedPath };
}

/**
 * Session env injected into built-in bash commands (PI_SESSION_ID etc.).
 * Mirrors bash.js resolveSpawnContext; process.env may hold stale values on
 * resume, so prefer the live session when ctx provides one. Best-effort.
 */
function sessionEnv(ctx: unknown): Record<string, string> {
	const env: Record<string, string> = {};
	try {
		const c = ctx as
			| {
					sessionManager?: { getSessionId(): string; getSessionFile?(): string | undefined };
					model?: { provider: string; id: string } | null;
					thinkingLevel?: string;
			  }
			| undefined;
		if (c?.sessionManager) {
			env.PI_SESSION_ID = c.sessionManager.getSessionId();
			const file = c.sessionManager.getSessionFile?.();
			if (file) env.PI_SESSION_FILE = file;
		}
		if (c?.model) {
			env.PI_PROVIDER = c.model.provider;
			env.PI_MODEL = c.model.id;
		}
		if (c?.thinkingLevel) env.PI_REASONING_LEVEL = c.thinkingLevel;
	} catch {
		// session env is best-effort
	}
	return env;
}

/**
 * The built-in bash tool prefixes every command with the `shellCommandPrefix`
 * setting. Extensions get no settings API, so read it straight from the
 * settings files (project overrides global) to keep parity.
 */
function shellCommandPrefix(cwd: string): string | undefined {
	let prefix: string | undefined;
	for (const settingsPath of [
		path.join(agentDir(), "settings.json"),
		path.join(cwd, ".pi", "settings.json"),
	]) {
		try {
			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
				shellCommandPrefix?: string;
			};
			if (parsed.shellCommandPrefix) prefix = parsed.shellCommandPrefix;
		} catch {
			// missing or invalid settings file
		}
	}
	return prefix;
}

/** Read the last `count` lines without slurping a huge log into memory. */
/** Request shape for the `bg:start` event-bus channel (see header). */
interface BgStartRequest {
	command: string;
	cwd?: string;
	ctx?: unknown;
	name?: string;
	summary?: string;
	tailLines?: number;
	tailMaxChars?: number;
	/** Ignored unless the cursor runner authorized this request. Not settable by other callers. */
	details?: boolean;
	accepted?: boolean;
	reply?: (result: { id: string; logPath: string } | { error: string }) => void;
}

function tailFile(
	logPath: string,
	count: number,
	windowBytes = 256 * 1024,
	maxChars = TAIL_MAX_CHARS,
): { text: string; lines: number; shown: number } {
	const all = tailLines(logPath, windowBytes);
	let selected = count > 0 ? all.slice(-count) : [];
	// Drop whole lines from the front until it fits, so the tail never begins
	// mid-line; only fall back to a hard character cut for a single huge line.
	while (selected.length > 1 && selected.join("\n").length > maxChars) {
		selected = selected.slice(1);
	}
	let text = maskDiffSecrets(selected.join("\n"));
	if (text.length > maxChars) text = `…${maskDiffSecrets(text.slice(-maxChars))}`;
	return { text, lines: all.length, shown: selected.length };
}

/** Read the tail of a file as lines, bounded by a byte window. */
function tailLines(logPath: string, windowBytes: number): string[] {
	let raw: string;
	try {
		const size = fs.statSync(logPath).size;
		const window = Math.min(size, windowBytes);
		const buffer = Buffer.alloc(window);
		const fd = fs.openSync(logPath, "r");
		try {
			fs.readSync(fd, buffer, 0, window, size - window);
		} finally {
			fs.closeSync(fd);
		}
		raw = buffer.toString("utf8");
	} catch {
		return [];
	}
	const all = raw.split("\n");
	if (all.at(-1) === "") all.pop();
	return all;
}

/**
 * Built-in bash's `structuredContent`, which codemode scripts receive instead of
 * text. `...base` keeps the built-in outputSchema, so results must match it.
 * Over the limit, keep the head and tail around a marker, like the built-in.
 */
function structuredResult(job: Job): {
	output: string;
	truncated: boolean;
	full_output_path?: string;
	exit_code: number;
	wall_time_seconds: number;
} {
	let output = "";
	let truncated = false;
	try {
		const size = fs.statSync(job.logPath).size;
		if (size <= STRUCTURED_OUTPUT_MAX_BYTES) {
			output = fs.readFileSync(job.logPath, "utf8");
		} else {
			const headBytes = Math.floor(STRUCTURED_OUTPUT_MAX_BYTES / 2);
			const tailBytes = STRUCTURED_OUTPUT_MAX_BYTES - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			const fd = fs.openSync(job.logPath, "r");
			try {
				fs.readSync(fd, head, 0, headBytes, 0);
				fs.readSync(fd, tail, 0, tailBytes, size - tailBytes);
			} finally {
				fs.closeSync(fd);
			}
			// Cut at character boundaries: drop a partial trailing sequence from the
			// head and leading continuation bytes from the tail.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && ((tail[tailStart] ?? 0) & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			output = `${headText}\n\n[... ${size - headBytes - tailBytes} bytes omitted ...]\n\n${tailText}`;
			truncated = true;
		}
	} catch {
		// log not readable: report empty output with the exit code
	}
	return {
		output,
		truncated,
		...(truncated ? { full_output_path: job.logPath } : {}),
		exit_code: job.exitCode ?? 0,
		wall_time_seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10,
	};
}

interface PanelDeps {
	tui: { requestRender(): void; terminal?: { rows: number } };
	theme: { fg(color: string, text: string): string };
	getJobs: () => Job[];
	kill: (job: Job) => boolean;
	done: () => void;
}

/** Short status suffix shown in the job list, e.g. "running 1m02s". */
function statusOf(job: Job): string {
	const elapsed = humanDuration((job.endedAt ?? Date.now()) - job.startedAt);
	if (job.endedAt === undefined) return `running ${elapsed}`;
	if (job.signal) return `stopped ${elapsed}`;
	if (job.exitUnknown) return "ended (exit unknown)";
	if (job.exitCode === 0) return `done ${elapsed}`;
	return `exit ${job.exitCode} · ${elapsed}`;
}

/**
 * Background job panel: a list view and a full-screen detail view.
 *
 * Deliberately not ctx.ui.select()/ctx.ui.editor(): select() would force a
 * submenu just to stop a job, and editor() is an editable prompt advertising
 * "enter submit", which is wrong for a log. Renders in the TUI only, so
 * viewing a 10k-line log costs zero tokens.
 */
class BgPanel {
	private mode: "list" | "detail" = "list";
	/**
	 * Selection is tracked by job id, never by list index: jobList() re-sorts
	 * running-first, so stopping a job reorders the list and an index would
	 * silently slide onto a different job — and then `x` would kill the wrong one.
	 */
	private selectedId: string | undefined;
	private lines: string[] = [];
	private scroll = 0;
	private follow = true;
	private timer: NodeJS.Timeout | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];
	/** Extra rows consumed by a wrapped Command: line, fed back into sizing. */
	private commandExtraRows = 0;
	// Declared field rather than a constructor parameter property: the shared
	// tsconfig sets erasableSyntaxOnly, so everything under extensions/ stays
	// importable by plain Node in strip-only mode (bin/pi-scheduler does this).
	private readonly deps: PanelDeps;

	constructor(deps: PanelDeps) {
		this.deps = deps;
		// Runtime counters tick and logs grow while the panel is open.
		this.timer = setInterval(() => {
			if (this.mode === "detail") this.load();
			this.invalidate();
			this.deps.tui.requestRender();
		}, 1000);
		this.timer.unref?.();
	}

	private jobList(): Job[] {
		// Running first, then most recently started.
		return this.deps.getJobs().sort((a, b) => {
			const aDone = a.endedAt === undefined ? 0 : 1;
			const bDone = b.endedAt === undefined ? 0 : 1;
			return aDone - bDone || b.startedAt - a.startedAt;
		});
	}

	private current(): Job | undefined {
		const jobs = this.jobList();
		return jobs.find((job) => job.id === this.selectedId) ?? jobs[0];
	}

	/** Move the selection by `delta` rows, resolving through ids. */
	private move(delta: number): void {
		const jobs = this.jobList();
		if (jobs.length === 0) return;
		const index = Math.max(
			0,
			jobs.findIndex((job) => job.id === this.selectedId),
		);
		const next = Math.max(0, Math.min(jobs.length - 1, index + delta));
		this.selectedId = jobs[next]?.id;
		this.invalidate();
	}

	private load(): void {
		const job = this.current();
		if (!job) return;
		this.lines = tailLines(job.logPath, VIEWER_WINDOW_BYTES);
		if (this.follow) this.scroll = this.maxScroll();
	}

	private terminalRows(): number {
		return this.deps.tui.terminal?.rows ?? process.stdout.rows ?? 24;
	}

	/**
	 * Output box height. Budget: 14 rows of panel chrome (title, status block,
	 * borders, hint) plus ~7 rows of pi's own editor/footer/status chrome that
	 * sit outside this component. Undercounting clips the hint line off-screen.
	 */
	private viewportHeight(): number {
		return Math.max(5, this.terminalRows() - 21 - this.commandExtraRows);
	}

	private maxScroll(): number {
		return Math.max(0, this.lines.length - this.viewportHeight());
	}

	private scrollBy(delta: number): void {
		const next = Math.max(0, Math.min(this.maxScroll(), this.scroll + delta));
		if (next === this.scroll) return;
		this.scroll = next;
		this.follow = this.scroll >= this.maxScroll();
		this.invalidate();
	}

	private stopSelected(): void {
		const job = this.current();
		if (job && job.endedAt === undefined) this.deps.kill(job);
		this.invalidate();
	}

	private close(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.deps.done();
	}

	handleInput(data: string): void {
		if (this.selectedId === undefined) this.selectedId = this.jobList()[0]?.id;

		if (this.mode === "list") {
			if (matchesKey(data, Key.up)) {
				this.move(-1);
			} else if (matchesKey(data, Key.down)) {
				this.move(1);
			} else if (matchesKey(data, Key.enter)) {
				this.mode = "detail";
				this.follow = true;
				this.scroll = 0;
				this.load();
				this.invalidate();
			} else if (data === "x") {
				this.stopSelected();
			} else if (matchesKey(data, Key.escape) || data === "q") {
				this.close();
			}
			return;
		}

		const page = this.viewportHeight() - 1;
		if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-page);
		else if (matchesKey(data, "pageDown")) this.scrollBy(page);
		else if (matchesKey(data, Key.home) || data === "g") this.scrollBy(-this.lines.length);
		else if (matchesKey(data, Key.end) || data === "G") this.scrollBy(this.lines.length);
		else if (data === "x") this.stopSelected();
		else if (matchesKey(data, Key.escape)) {
			this.mode = "list";
			this.invalidate();
		} else if (data === "q") this.close();
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	/** One row inside the output box, padded so the right border lines up. */
	private boxed(content: string, width: number): string {
		const inner = Math.max(1, width - 4);
		const text = truncateToWidth(content, inner);
		return `│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const out = this.mode === "list" ? this.renderList(width) : this.renderDetail(width);
		this.cachedLines = out;
		this.cachedWidth = width;
		return out;
	}

	private renderList(width: number): string[] {
		const { theme } = this.deps;
		const jobs = this.jobList();
		if (this.selectedId === undefined) this.selectedId = jobs[0]?.id;
		const active = jobs.filter((job) => job.endedAt === undefined).length;
		const finished = jobs.length - active;
		const out = [
			truncateToWidth(theme.fg("accent", "Background"), width),
			truncateToWidth(
				`${active} active job${active === 1 ? "" : "s"}${finished > 0 ? ` · ${finished} finished` : ""}`,
				width,
			),
			"",
		];

		jobs.forEach((job) => {
			const status = ` (${statusOf(job)})`;
			const room = Math.max(10, width - visibleWidth(status) - 3);
			const truncated = visibleWidth(job.command) > room;
			const command = truncateToWidth(job.command, truncated ? room - 1 : room);
			const row = `${command}${truncated ? "…" : ""}${status}`;
			out.push(
				job.id === this.selectedId
					? truncateToWidth(theme.fg("accent", `❯ ${row}`), width)
					: truncateToWidth(`  ${row}`, width),
			);
		});

		out.push("");
		out.push(
			truncateToWidth(
				theme.fg("dim", "↑/↓ to select · Enter to view · x to stop · Esc to close"),
				width,
			),
		);
		return out;
	}

	private renderDetail(width: number): string[] {
		const { theme } = this.deps;
		const job = this.current();
		if (!job) {
			this.mode = "list";
			return this.renderList(width);
		}

		const label = 10;
		const wrap = Math.max(20, width - label);
		const commandLines: string[] = [];
		for (let i = 0; i < job.command.length; i += wrap) {
			commandLines.push(job.command.slice(i, i + wrap));
		}
		this.commandExtraRows = commandLines.length - 1;

		const out = [
			truncateToWidth(theme.fg("accent", "Shell details"), width),
			"",
			truncateToWidth(`${"Status:".padEnd(label)}${statusOf(job)}`, width),
			truncateToWidth(`${"Cwd:".padEnd(label)}${job.cwd}`, width),
			truncateToWidth(`${"Log:".padEnd(label)}${job.logPath}`, width),
			truncateToWidth(`${"Command:".padEnd(label)}${commandLines[0] ?? ""}`, width),
			...commandLines.slice(1).map((l) => truncateToWidth(`${" ".repeat(label)}${l}`, width)),
			"",
			truncateToWidth("Output:", width),
		];

		const height = this.viewportHeight();
		const window = this.lines.slice(this.scroll, this.scroll + height);
		const inner = Math.max(1, width - 4);
		out.push(`╭${"─".repeat(inner + 2)}╮`);
		if (this.lines.length === 0) {
			out.push(this.boxed(theme.fg("dim", "(no output yet)"), width));
			for (let i = 1; i < height; i++) out.push(this.boxed("", width));
		} else {
			for (const line of window) out.push(this.boxed(line, width));
			for (let i = window.length; i < height; i++) out.push(this.boxed("", width));
		}
		out.push(`╰${"─".repeat(inner + 2)}╯`);

		const position = this.follow
			? "following"
			: `${this.scroll + 1}-${this.scroll + window.length}`;
		out.push(
			truncateToWidth(theme.fg("dim", `Showing ${this.lines.length} lines · ${position}`), width),
		);
		out.push("");
		out.push(
			truncateToWidth(
				theme.fg("dim", "↑/↓ scroll · pgup/pgdn page · g/G top/bottom · x to stop · Esc to go back"),
				width,
			),
		);
		return out;
	}
}

export default function (pi: ExtensionAPI) {
	registerBgCodemode(pi);
	const jobs = new Map<string, Job>();
	let ctxRef: ExtensionContext | undefined;
	let ticker: NodeJS.Timeout | undefined;
	/** Set once this instance's pi is shut down or found stale; completions then go to the live instance. */
	let disposed = false;
	/** The live session's id, and the id its jobs are registered under (persisted sessions only). */
	let sessionId: string | undefined;
	let registryId: string | undefined;
	let poller: NodeJS.Timeout | undefined;
	/** What this instance left for the next one at shutdown, until it is taken or discarded. */
	let handoff: BgHandoff | undefined;
	/** Inside session_start: wakes wait until it returns. */
	let starting = false;
	const report = (job: Job) => {
		if (starting) setTimeout(() => deliver(job), 0);
		else deliver(job);
	};
	const self: BgLive = {
		deliver(raw) {
			// The exit of a job another (stale) instance holds the child of.
			const record = parseRecord(raw);
			if (!record) throw new Error("not a bg job");
			const existing = jobs.get(record.id);
			if (existing) {
				// Handed over or adopted here: this copy may know more (a stop sent from here).
				if (existing.endedAt !== undefined) return;
				existing.killedByUser ||= record.killedByUser;
				existing.wakeOnKill ||= record.wakeOnKill;
				existing.exitUnknown = record.exitUnknown;
				applyEnd(existing, record.exitCode ?? null, record.signal ?? null, record.endedAt);
				report(existing);
				return;
			}
			// Unknown here (it belongs to the session before /new, /resume or /fork): list it and wake this session.
			const job = jobFrom(record);
			jobs.set(job.id, job);
			report(job);
		},
	};

	function jobFrom(record: JobRecord): Job {
		return { ...record, quiet: record.quiet === true, own: false };
	}

	const running = () => [...jobs.values()].filter((job) => job.endedAt === undefined);
	/** Jobs the widget surfaces (quiet foreground-race jobs are invisible until adopted). */
	const visible = () => running().filter((job) => !job.quiet);
	/** What other extensions see (`bg:jobs`, `bg:list`): every job past the foreground race, running or finished. */
	const snapshot = () =>
		[...jobs.values()]
			.filter((job) => !job.quiet)
			.map(({ id, name, command, cwd, logPath, startedAt, endedAt, exitCode, signal, killedByUser }) => ({ id, name, command, cwd, logPath, startedAt, endedAt, exitCode, signal, killedByUser }));

	function renderWidget(): void {
		const ctx = ctxRef;
		if (ctx?.mode !== "tui") return;
		const active = visible();
		if (active.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const now = Date.now();
		// Shell loops often collapse to the same label (three `echo` jobs are
		// indistinguishable), so fall back to the id whenever a name repeats.
		const nameCounts = new Map<string, number>();
		for (const job of active) nameCounts.set(job.name, (nameCounts.get(job.name) ?? 0) + 1);
		const shown = active
			.slice(0, MAX_WIDGET_JOBS)
			.map(
				(job) =>
					`${(nameCounts.get(job.name) ?? 0) > 1 ? job.id : job.name} ${humanDuration(now - job.startedAt)}`,
			);
		if (active.length > MAX_WIDGET_JOBS) shown.push(`+${active.length - MAX_WIDGET_JOBS}`);
		const label = `${active.length} background job${active.length === 1 ? "" : "s"}`;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render: (width) => [
					truncateToWidth(
						`${theme.fg("accent", "●")} ${theme.fg("dim", `${label} · ${shown.join(" · ")} · /bg`)}`,
						width,
					),
				],
				invalidate() {}, // No cached colors; use the live theme on every render.
			}),
			{ placement: "aboveEditor" },
		);
	}

	function syncTicker(): void {
		// This timer only refreshes the TUI, never wakes the model.
		const active = ctxRef?.mode === "tui" && visible().length > 0;
		if (active && !ticker) {
			ticker = setInterval(() => {
				try {
					renderWidget();
				} catch {
					// stale ctx after a reload: stop refreshing a UI we no longer own
					clearInterval(ticker);
					ticker = undefined;
				}
			}, 1000);
			ticker.unref?.();
		} else if (!active && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
		renderWidget();
		// Every start, adoption and exit passes through here: tell listeners (canvas.ts).
		pi.events.emit("bg:jobs", snapshot());
	}

	async function start(
		command: string,
		cwd: string,
		opts: {
			quiet?: boolean;
			ctx?: unknown;
			name?: string;
			summary?: string;
			tailLines?: number;
			tailMaxChars?: number;
			details?: boolean;
		} = {},
	): Promise<{ job: Job; exited: Promise<void> }> {
		if (!bgDirReady()) throw new Error(`${BG_DIR} is not a directory only you can write to; not running jobs in it`);
		const id = crypto.randomBytes(3).toString("hex");
		const logPath = path.join(BG_DIR, `${id}.log`);
		const fd = fs.openSync(logPath, "a");
		// A reused id must not inherit an earlier job's status.
		removeExitFile(logPath);

		// Same shell the built-in bash tool uses (bash -c), not /bin/sh.
		const shellConfig = getShellConfig();
		const stdinTransport = shellConfig.commandTransport === "stdin";
		const shellArgs = stdinTransport ? shellConfig.args : [...shellConfig.args, command];
		// /bin/sh only wraps it: the job runs in shellConfig.shell as before.
		const wrap = DURABLE && shellRunnable(shellConfig.shell);
		const child = spawn(
			wrap ? "/bin/sh" : shellConfig.shell,
			wrap ? ["-c", EXIT_WRAPPER, exitPathOf(logPath), shellConfig.shell, ...shellArgs] : shellArgs,
			{
				cwd,
				detached: true, // own process group, so we can kill the whole tree
				stdio: [stdinTransport ? "pipe" : "ignore", fd, fd],
				env: { ...shellEnv(), ...sessionEnv(opts.ctx), PI_BG_JOB_ID: id, ...(opts.details && commandRunsCursorRunner(command) ? { PI_BG_LOG: logPath } : {}) },
				windowsHide: true,
			},
		);
		const job: Job = {
			id,
			name: opts.name?.slice(0, 20) || labelFor(command),
			command,
			cwd,
			logPath,
			pid: child.pid,
			sessionId: registryId,
			startedAt: Date.now(),
			killedByUser: false,
			quiet: opts.quiet === true,
			own: true,
			summary: opts.summary,
			tailLines: opts.tailLines,
			tailMaxChars: opts.tailMaxChars,
		};
		jobs.set(id, job);
		const pid = child.pid;
		if (pid !== undefined) childPids().set(pid, id);

		let resolveExited!: () => void;
		const exited = new Promise<void>((resolve) => {
			resolveExited = resolve;
		});
		// Listeners must be attached before unref/await so a fast-exiting job
		// cannot slip through the gap (e.g. `exit 3`).
		const ready = new Promise<void>((resolve) => {
			child.once("spawn", () => resolve());
			// Never let a throw escape a ChildProcess listener: it becomes an
			// uncaughtException and takes pi down with it.
			child.once("exit", (code, signal) => {
				// Reaped: from here on the pid may be anyone's.
				if (pid !== undefined && childPids().get(pid) === id) childPids().delete(pid);
				safeFinish(job, code, signal);
				resolveExited();
				resolve();
			});
			child.once("error", (error) => {
				appendLog(job, `pi-bg: failed to start: ${error.message}`);
				safeFinish(job, 127, null);
				resolveExited();
				resolve();
			});
		});

		if (stdinTransport) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		fs.closeSync(fd);
		// Explicit bg jobs outlive the turn immediately. Foreground-race jobs
		// stay referenced until they finish or are adopted, so their exit (and
		// the budget timer) keep the event loop alive even without a TUI.
		if (!job.quiet) {
			child.unref();
		} else {
			job.unrefChild = () => {
				child.unref();
				job.unrefChild = undefined;
			};
		}

		syncTicker();
		// Confirm the fork actually happened before telling the model "started",
		// so spawn failures surface in the tool result instead of arriving later.
		await ready;
		register(job);
		return { job, exited };
	}

	/**
	 * Put a job past the foreground race in its session's registry, then record
	 * its wrapper's start time (what re-adoption checks) once ps answers. Not if
	 * the job ended meanwhile: once reaped, its pid may belong to something else.
	 */
	function register(job: Job): void {
		if (!job.sessionId || job.quiet || job.endedAt !== undefined || job.pid === undefined) return;
		persist(job);
		const pid = job.pid;
		void processIdentity(pid).then((identity) => {
			if (!identity || job.endedAt !== undefined || job.pidStart !== undefined) return;
			job.pidStart = identity.start;
			persist(job);
		});
	}

	/**
	 * Drop logs from long-dead jobs. Best-effort, once per session.
	 * Strictly scoped: only files matching LOG_NAME_RE, only regular files, never
	 * directories or symlinks, so a shared or user-populated BG_DIR is safe.
	 */
	// Async and after boot: the log dir holds thousands of files, and an lstat
	// for each on the session_start path cost ~12ms of every launch.
	async function pruneLogs(): Promise<void> {
		try {
			const cutoff = Date.now() - LOG_TTL_MS;
			for (const entry of await fs.promises.readdir(BG_DIR, { withFileTypes: true })) {
				if (!entry.isFile() || !LOG_NAME_RE.test(entry.name)) continue;
				const file = path.join(BG_DIR, entry.name);
				if ((await fs.promises.lstat(file)).mtimeMs < cutoff) await fs.promises.rm(file, { force: true });
			}
		} catch {
			// directory may not exist yet
		}
	}

	function appendLog(job: Job, line: string): void {
		try {
			fs.appendFileSync(job.logPath, `${line}\n`);
		} catch {
			// log is best-effort
		}
	}

	/**
	 * Record how a job ended. The wrapper exits 128+N when the job died of
	 * signal N; for a stop we sent, report it as that signal.
	 */
	function applyEnd(job: Job, code: number | null, signal: NodeJS.Signals | null, endedAt = Date.now()): void {
		if (signal === null && code !== null && code > 128 && job.killedByUser) {
			const name = signalName(code - 128);
			if (name) {
				signal = name;
				code = null;
			}
		}
		if (signal === null && code === null && job.exitUnknown && job.killedByUser && job.lastSignal) {
			signal = job.lastSignal;
			job.exitUnknown = false;
		}
		job.endedAt = endedAt;
		job.exitCode = code;
		job.signal = signal;
	}

	function finish(job: Job, code: number | null, signal: NodeJS.Signals | null, endedAt?: number): void {
		if (job.endedAt !== undefined) return;
		applyEnd(job, code, signal, endedAt);
		removeExitFile(job.logPath);
		deliver(job);
	}

	/** A job that isn't our child has ended: its wrapper's exit file says how, if it got to write one. */
	function endForeign(job: Job): void {
		if (job.endedAt !== undefined) return;
		const exit = readExitFile(job.logPath);
		job.exitUnknown = !exit;
		finish(job, exit?.code ?? null, null, exit?.at);
	}

	function stopTimers(): void {
		if (ticker) clearInterval(ticker);
		if (poller) clearInterval(poller);
		ticker = undefined;
		poller = undefined;
	}

	/** Adopted jobs aren't our children, so no exit event: poll for their exit file or a gone pid. */
	function syncPoller(): void {
		const needed = !disposed && running().some((job) => job.adopted);
		if (needed && !poller) {
			poller = setInterval(() => {
				try {
					pollAdopted();
				} catch {
					// never throw out of a timer
				}
			}, ADOPTED_POLL_MS);
			poller.unref?.();
		} else if (!needed && poller) {
			clearInterval(poller);
			poller = undefined;
		}
	}

	function pollAdopted(): void {
		for (const job of running()) {
			if (!job.adopted || job.pid === undefined) continue;
			if (readExitFile(job.logPath) || !pidAlive(job.pid)) {
				endForeign(job);
				continue;
			}
			job.polls = (job.polls ?? 0) + 1;
			if (job.polls % VERIFY_EVERY_POLLS === 0) {
				const pid = job.pid;
				void processIdentity(pid)
					.then((identity) => {
						// ps failing says nothing; a different process at the pid ends ours.
						if (job.endedAt === undefined && verdictOf(job, identity, pid) === "other") endForeign(job);
					})
					.catch(() => {});
			}
		}
		syncPoller();
	}

	/**
	 * Pick up this session's registered jobs after a restart or resume: running
	 * ones whose leader is provably still the job are adopted; ones that ended
	 * in between come back finished, to be reported once. Returns those.
	 */
	async function readopt(id: string): Promise<Job[]> {
		const records = readRegistry(id).filter((record) => !jobs.has(record.id));
		if (records.length === 0) return [];
		const checked = await Promise.all(
			records.map(async (record): Promise<{ record: JobRecord; state: Verdict }> => {
				const pid = record.pid;
				if (record.endedAt !== undefined || pid === undefined || readExitFile(record.logPath)) {
					return { record, state: "other" };
				}
				return { record, state: verdictOf(record, await processIdentity(pid), pid) };
			}),
		);
		const now = Date.now();
		const report: Job[] = [];
		const undecided: JobRecord[] = [];
		for (const { record, state } of checked) {
			// Handed over, or its completion was forwarded here while ps ran.
			if (jobs.has(record.id)) continue;
			if (record.endedAt !== undefined && record.reported) continue;
			// ps couldn't tell (failed, or no start time was recorded): neither adopt nor report it.
			if (state === "unknown") {
				if (now - (record.seenAt ?? record.startedAt) <= REGISTRY_TTL_MS) undecided.push(record);
				continue;
			}
			const job: Job = { ...jobFrom(record), sessionId: id, quiet: false, adopted: true };
			if (state === "other") {
				if (job.endedAt === undefined) {
					const exit = readExitFile(job.logPath);
					if (now - (exit?.at ?? job.seenAt ?? job.startedAt) > REGISTRY_TTL_MS) continue;
					job.exitUnknown = !exit;
					applyEnd(job, exit?.code ?? null, null, exit?.at ?? now);
					removeExitFile(job.logPath);
				} else if (now - job.endedAt > REGISTRY_TTL_MS) {
					continue;
				}
				job.whileDown = true;
				report.push(job);
			}
			jobs.set(job.id, job);
		}
		// What this instance tracks for the session, plus what a later resume should try again.
		writeRegistry(id, [
			...[...jobs.values()]
				.filter((job) => job.sessionId === id && !job.quiet && !(job.endedAt !== undefined && job.reported))
				.map(toRecord),
			...undecided,
		]);
		return report;
	}

	/**
	 * Other sessions' registries untouched for REGISTRY_TTL_MS keep only jobs
	 * still provably running; the rest (and the file, once empty) go. Stray temp
	 * files from an interrupted write go too.
	 */
	async function pruneRegistry(): Promise<void> {
		try {
			if (!stateDirReady(false)) return;
			const cutoff = Date.now() - REGISTRY_TTL_MS;
			for (const entry of await fs.promises.readdir(STATE_DIR, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const file = path.join(STATE_DIR, entry.name);
				const stale = (await fs.promises.lstat(file)).mtimeMs < cutoff;
				if (/\.json\.\d+\.[0-9a-f]{8}\.tmp$/.test(entry.name)) {
					if (stale) await fs.promises.rm(file, { force: true });
					continue;
				}
				const id = /^(.+)\.json$/.exec(entry.name)?.[1];
				if (!stale || !id || id === registryId || !SESSION_ID_RE.test(id)) continue;
				const alive: JobRecord[] = [];
				for (const record of readRegistry(id)) {
					if (record.endedAt !== undefined || record.pid === undefined || readExitFile(record.logPath)) continue;
					if (isJobProcess(record, await processIdentity(record.pid))) alive.push(record);
				}
				writeRegistry(id, alive);
			}
		} catch {
			// directory may not exist yet
		}
	}

	function safeFinish(job: Job, code: number | null, signal: NodeJS.Signals | null): void {
		try {
			finish(job, code, signal);
		} catch (error) {
			appendLog(job, `pi-bg: completion handling failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Report a finished job to this session, or, when this instance's pi is
	 * stale (reloaded, replaced), to whichever instance owns the live session.
	 * Never throws.
	 */
	function deliver(job: Job): void {
		if (!disposed) {
			try {
				deliverHere(job);
				job.reported = true;
				persist(job);
				return;
			} catch {
				// "ctx is stale after session replacement or reload": hand off below
				disposed = true;
				stopTimers();
			}
		}
		const live = liveSlot[LIVE_KEY];
		if (live && live !== self) {
			try {
				live.deliver(toRecord(job));
				job.reported = true;
			} catch (error) {
				appendLog(job, `pi-bg: completion not delivered: ${error instanceof Error ? error.message : String(error)}`);
			}
			persist(job);
			return;
		}
		// Mid-/reload: the next instance takes this job, ended and unreported, with the table.
		if (!handoff || liveSlot[HANDOFF_KEY] !== handoff) {
			appendLog(job, "pi-bg: completion not delivered: no live pi session");
		}
		// Unreported, it is reported when this session is resumed.
		persist(job);
	}

	/** A cursor run's diff sidecar, merged into the completion message. Other jobs stay `{ id }`. Re-derived from the command, never a persisted flag. */
	function completionDetails(job: Job): Record<string, unknown> {
		const details: Record<string, unknown> = { id: job.id };
		const extra = commandRunsCursorRunner(job.command) ? readJobDetails(job.logPath) : undefined;
		if (!extra) return details;
		// Read again through the trust helper: sensitive bodies reduced, secrets masked, diffPath checked.
		const trusted = trustJobDetails(extra);
		details.diff = trusted.diff;
		details.diffStats = trusted.diffStats;
		if (trusted.diffPath) details.diffPath = trusted.diffPath;
		return details;
	}

	function deliverHere(job: Job): void {
		const code = job.exitCode ?? null;
		const signal = job.signal ?? null;
		const endedAt = job.endedAt ?? Date.now();
		syncTicker();

		// Foreground-race jobs report through their tool result; only adopted
		// (timed-out) jobs get the completion wake.
		if (job.quiet) return;

		const outcome =
			signal !== null
				? `killed (${signal})`
				: job.exitUnknown
					? "ended (exit unknown)"
					: code === 0
						? "succeeded"
						: `exited ${code}`;
		// An unknown end was only noticed, so its time is not the job's runtime.
		const when =
			`${job.exitUnknown && signal === null ? "" : ` after ${humanDuration(endedAt - job.startedAt)}`}` +
			`${job.whileDown ? " while the session was closed" : ""}`;

		if ((job.killedByUser && !job.wakeOnKill) || WAKE === "off") {
			ctxRef?.ui?.notify(`bg ${job.id} ${outcome}${when}`, "info");
			return;
		}

		const { text, lines, shown } = tailFile(
			job.logPath,
			job.tailLines ?? TAIL_LINES,
			undefined,
			job.tailMaxChars,
		);
		const omitted = lines - shown;
		// The model saw the command when it launched the job, so replaying it in
		// full on every completion is pure token cost. Collapse whitespace too:
		// a multi-line command would otherwise mangle the header.
		const oneLine = maskDiffSecrets((job.summary ?? job.command).replace(/\s+/g, " ").trim());
		const command = oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
		const header =
			`[bg ${job.id}] \`${command}\` ${outcome}${when}\n` +
			`log: ${job.logPath} (${lines} line${lines === 1 ? "" : "s"})`;
		// Report what was actually included, not the configured cap: a capped tail
		// otherwise reads as if the job started partway through.
		const body = text
			? `\nlast ${shown} line${shown === 1 ? "" : "s"}${omitted > 0 ? ` (${omitted} earlier omitted)` : ""}:\n${text}`
			: "\n(no output)";

		pi.sendMessage(
			{ customType: "bg", content: header + body, display: true, details: completionDetails(job) },
			// followUp waits for any in-flight turn to finish its tool calls;
			// triggerTurn wakes the model when idle. nextTurn parks it silently.
			WAKE === "nextTurn"
				? { deliverAs: "nextTurn" }
				: { deliverAs: "followUp", triggerTurn: true },
		);
	}

	/**
	 * Whether the job's pid is still the job, right now. A child of this process
	 * (own, or handed over by a reloaded instance that still holds it) is, while
	 * the shared child map says so; this also holds for a stale instance's copy,
	 * which hears nothing once the job is reaped. Anything else needs ps.
	 */
	function pidState(job: Job, pid: number): Verdict {
		if (childPids().get(pid) === job.id) return "job";
		// Not in the map: reaped, unless handed over by an instance from before the map.
		if (!job.adopted && job.pidStart === undefined) return job.own ? "other" : "unknown";
		return verdictOf(job, processIdentitySync(pid), pid);
	}

	/** Stop a job's whole process group, only ever while its pid is provably still the job. */
	function kill(job: Job): boolean {
		if (job.endedAt !== undefined || job.pid === undefined) return false;
		const pid = job.pid;
		const state = pidState(job, pid);
		if (state !== "job") {
			// Gone, or someone else's now: never signal it. Unknown (ps failed): leave it running.
			if (state === "other") endForeign(job);
			return false;
		}
		job.killedByUser = true;
		persist(job);
		try {
			process.kill(-pid, "SIGTERM"); // negative pid = whole process group
			job.lastSignal = "SIGTERM";
			setTimeout(() => {
				if (job.endedAt !== undefined || pidState(job, pid) !== "job") return;
				try {
					process.kill(-pid, "SIGKILL");
					job.lastSignal = "SIGKILL";
				} catch {
					// already gone
				}
			}, 5000).unref?.();
			return true;
		} catch {
			if (job.own) safeFinish(job, null, "SIGTERM");
			else endForeign(job);
			return false;
		}
	}

	const autoBackgroundNote =
		FG_TIMEOUT_SECS > 0
			? ` Foreground commands without a timeout auto-background after ${FG_TIMEOUT_SECS}s and report on completion. A foreground command with an explicit timeout is killed if it expires (maximum ${MAX_TIMEOUT_SECS}s).`
			: ` Explicit foreground timeouts are capped at ${MAX_TIMEOUT_SECS}s.`;

	// ---- bash override: +~55 tokens, the entire discovery surface -------------

	/**
	 * The base bash definition is bound to a cwd at construction, but pi's
	 * session cwd is not process.cwd(): resume and new-session rebuild the
	 * runtime with sessionManager.getCwd(), and SessionManager.open() accepts a
	 * cwd override. Binding once at load would run every bash call through this
	 * override -- including background:false ones -- in whatever directory pi
	 * happened to be launched from, silently and with plausible output.
	 *
	 * Schema, description and prompt metadata are cwd-independent (verified), so
	 * one instance is fine for registration; execution resolves per ctx.cwd and
	 * memoizes so we are not rebuilding a definition per invocation.
	 */
	const baseByCwd = new Map<string, ReturnType<typeof createBashToolDefinition>>();
	function baseFor(cwd: string): ReturnType<typeof createBashToolDefinition> {
		let definition = baseByCwd.get(cwd);
		if (definition === undefined) {
			definition = createBashToolDefinition(cwd, {
				commandPrefix: shellCommandPrefix(cwd),
			});
			baseByCwd.set(cwd, definition);
		}
		return definition;
	}
	const base = baseFor(process.cwd());
	const baseProperties = (base.parameters as unknown as { properties: Record<string, unknown> })
		.properties;

	pi.registerTool({
		...base,
		description: `${base.description}${autoBackgroundNote}`,
		parameters: Type.Object({
			...baseProperties,
			timeout: Type.Optional(
				Type.Number({
					description: `Hard deadline in seconds (optional, maximum ${MAX_TIMEOUT_SECS})`,
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run detached; returns a job id immediately and notifies on completion",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const input = params as { command: string; timeout?: number; background?: boolean };
			// Follow the session, not the launch directory.
			const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();

			if (input.background) {
				const { job } = await start(input.command, cwd, { ctx });
				if (job.endedAt !== undefined && job.exitCode === 127) {
					return {
						content: [{ type: "text", text: `bg job failed to start; see ${job.logPath}` }],
						details: undefined,
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `bg job ${job.id} started · log: ${job.logPath}`,
						},
					],
					details: undefined,
				};
			}

			// Auto-backgrounding is only the fallback for commands with no deadline.
			// An explicit timeout keeps pi's built-in hard-deadline semantics and
			// kills the process tree if it expires. Passing only built-in fields also
			// keeps the override's `background` option out of the base implementation.
			// Also when the log dir isn't private: then no log is written at all.
			if (FG_TIMEOUT_SECS === 0 || input.timeout !== undefined || !bgDirReady()) {
				const timeout =
					input.timeout === undefined
						? undefined
						: Math.min(timeoutToSeconds(input.timeout), MAX_TIMEOUT_SECS);
				return baseFor(cwd).execute(
					toolCallId,
					{
						command: input.command,
						...(timeout !== undefined ? { timeout } : {}),
					},
					signal,
					onUpdate,
					ctx,
				);
			}

			// Foreground race: run as a quiet bg job so the process can be adopted
			// instead of killed if it outlives the budget (non-idempotent commands
			// keep running rather than being re-run).
			const budgetSecs = FG_TIMEOUT_SECS;
			const prefix = shellCommandPrefix(cwd);
			const command = prefix ? `${prefix}\n${input.command}` : input.command;
			const { job, exited } = await start(command, cwd, { quiet: true, ctx });

			// Stream the job log into partial tool updates so live output in the
			// TUI matches the built-in tool.
			onUpdate?.({ content: [], details: undefined });
			let offset = 0;
			let partial = "";
			const tail = onUpdate
				? setInterval(() => {
						try {
							const size = fs.statSync(job.logPath).size;
							if (size <= offset) return;
							const buffer = Buffer.alloc(size - offset);
							const fd = fs.openSync(job.logPath, "r");
							try {
								fs.readSync(fd, buffer, 0, buffer.length, offset);
							} finally {
								fs.closeSync(fd);
							}
							offset = size;
							partial = (partial + buffer.toString("utf8")).slice(-PARTIAL_CAP_BYTES);
							onUpdate({ content: [{ type: "text", text: partial }], details: undefined });
						} catch {
							// log file not readable (yet)
						}
				  }, 100)
				: undefined;

			const onAbort = () => kill(job);
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			let timerHandle: NodeJS.Timeout | undefined;
			try {
				timedOut = await Promise.race([
					exited.then(() => false),
					new Promise<boolean>((resolve) => {
						timerHandle = setTimeout(
							() => resolve(true),
							Math.min(budgetSecs * 1000, MAX_TIMER_MS),
						);
					}),
				]);
			} finally {
				if (timerHandle) clearTimeout(timerHandle);
				if (tail) clearInterval(tail);
				signal?.removeEventListener("abort", onAbort);
			}

			// The budget timer and the exit event can interleave; a recorded
			// outcome always wins over the timer.
			if (timedOut && job.endedAt !== undefined) timedOut = false;

			if (timedOut) {
				job.quiet = false; // adopt: the completion wake now applies
				job.unrefChild?.(); // outlive the turn, like an explicit bg job
				syncTicker(); // widget ignored it while quiet; start the UI ticker now
				register(job);
				let peek = "";
				try {
					const all = tailLines(job.logPath, 8 * 1024);
					let lines = all.slice(-ADOPT_TAIL_LINES);
					while (lines.length > 1 && lines.join("\n").length > ADOPT_TAIL_CHARS) {
						lines = lines.slice(1);
					}
					peek = lines.join("\n").slice(-ADOPT_TAIL_CHARS);
				} catch {
					// no output yet
				}
				const outputSoFar = peek ? `\nOutput so far:\n${peek}` : "";
				return {
					content: [
						{
							type: "text",
							text:
								`Still running after ${budgetSecs}s — moved to background as job ${job.id}.\n` +
								`log: ${job.logPath} — you'll be notified on completion; tail the log for progress.` +
								outputSoFar,
						},
					],
					details: undefined,
				};
			}

			if (signal?.aborted) throw new Error("Command aborted");

			// Completed within the budget: report straight from the log (the log
			// is the full-output file, so truncation needs no temp copy).
			let text: string;
			let details: unknown = undefined;
			try {
				const result = truncateTail(fs.readFileSync(job.logPath, "utf8"));
				text = result.content || "(no output)";
				if (result.truncated) {
					text += `\n\n[Truncated: showing ${result.outputLines} of ${result.totalLines} lines. Full output: ${job.logPath}]`;
					details = { truncation: result, fullOutputPath: job.logPath };
				}
			} catch {
				text = "(no output)";
			}
			if (job.signal) {
				return {
					content: [{ type: "text", text: `${text}\n\nCommand killed (${job.signal})` }],
					details,
					isError: true,
				};
			}
			if (job.exitCode !== 0) {
				return {
					content: [
						{ type: "text", text: `${text}\n\nCommand exited with code ${job.exitCode}` },
					],
					details,
					structuredContent: structuredResult(job),
					isError: true,
				};
			}
			return { content: [{ type: "text", text }], details, structuredContent: structuredResult(job) };
		},
	} as Parameters<ExtensionAPI["registerTool"]>[0]);

	// ---- UI -----------------------------------------------------------------

	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (jobs.size === 0) {
			ctx.ui.notify("No background jobs", "info");
			return;
		}
		// TUI-only: never enters the conversation, so log size costs no tokens.
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new BgPanel({
					tui: tui as unknown as PanelDeps["tui"],
					theme,
					getJobs: () => [...jobs.values()],
					kill,
					done: () => done(undefined),
				}) as never,
		);
	}

	pi.registerCommand("bg", {
		description: "List, view, or stop background jobs",
		handler: async (_args, ctx) => {
			await openPanel(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+b", {
		// Requires CSI-u disambiguation; /bg is the portable fallback.
		description: "Background jobs (also /bg)",
		handler: async (ctx) => {
			await openPanel(ctx);
		},
	});

	// ---- event bus: other extensions start jobs through bg.ts ---------------
	pi.events.on("bg:list", (data) => (data as { reply?: (jobs: unknown) => void } | undefined)?.reply?.(snapshot()));
	pi.events.on("bg:kill", (data) => {
		const req = data as { id?: unknown; wake?: unknown; accepted?: boolean; reply?: (r: { killed: boolean }) => void } | undefined;
		if (!req || typeof req.id !== "string" || req.accepted) return;
		const job = jobs.get(req.id);
		if (!job) return; // another instance (an adopted job's) may hold it
		req.accepted = true;
		if (req.wake === true && job.endedAt === undefined) job.wakeOnKill = true;
		req.reply?.({ killed: kill(job) });
	});
	// Subscribing is not a resource (pi tracks and drops it on reload); the job
	// itself only starts when a request arrives, after session_start.
	pi.events.on("bg:start", async (data) => {
		const req = data as BgStartRequest | undefined;
		if (!req || typeof req.command !== "string" || req.accepted) return;
		req.accepted = true; // synchronous: the sender checks this right after emit()
		try {
			const ctx = req.ctx ?? ctxRef;
			const cwd = req.cwd ?? (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			const { job } = await start(req.command, cwd, {
				ctx,
				name: req.name,
				summary: req.summary,
				tailLines: req.tailLines,
				tailMaxChars: req.tailMaxChars,
				details: cursorDetailsRequested(req),
			});
			if (job.endedAt !== undefined && job.exitCode === 127) {
				req.reply?.({ error: `failed to start; see ${job.logPath}` });
			} else {
				req.reply?.({ id: job.id, logPath: job.logPath });
			}
		} catch (error) {
			req.reply?.({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	// ---- lifecycle ----------------------------------------------------------
	// Nothing above this point starts a resource; per the docs, background
	// resources must not be created in the factory.

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		disposed = false;
		handoff = undefined;
		starting = true;
		sessionId = sessionIdOf(ctx);
		registryId = registryIdOf(ctx);
		// Taken or not, a hand-off is only ever for the instance right after it.
		const pending = liveSlot[HANDOFF_KEY];
		delete liveSlot[HANDOFF_KEY];
		liveSlot[LIVE_KEY] = self;

		const toReport: Job[] = [];
		// /reload: continue the previous instance's table, if it had this session.
		if (pending && sessionId !== undefined && pending.sessionId === sessionId) {
			let records: JobRecord[] = [];
			try {
				records = pending.take();
			} catch {
				// an older or broken instance: start empty, as before hand-offs
			}
			for (const raw of records) {
				const record = parseRecord(raw);
				if (!record || jobs.has(record.id)) continue;
				const job = jobFrom(record);
				jobs.set(job.id, job);
				if (job.endedAt !== undefined && !job.reported) toReport.push(job);
			}
		}
		// Restart or resume: what is still registered under this session.
		try {
			if (registryId) toReport.push(...(await readopt(registryId)));
		} finally {
			starting = false;
		}
		syncPoller();
		syncTicker();
		// After session_start returns: a wake that starts a turn mid-startup would race pi's own setup.
		if (toReport.length > 0) {
			setTimeout(() => {
				for (const job of toReport) if (!job.reported) deliver(job);
			}, 0);
		}
		setTimeout(() => void pruneLogs(), 5_000).unref();
		if (DURABLE) setTimeout(() => void pruneRegistry(), 5_000).unref();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		stopTimers();
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
		const orphans = running();
		const reloading = (event as { reason?: string } | undefined)?.reason === "reload";
		if (orphans.length > 0 && ctx.hasUI && !reloading) {
			// Detached jobs outlive pi on purpose; surface where to find them.
			ctx.ui.notify(
				`${orphans.length} bg job(s) still running: ${orphans.map((j) => j.id).join(", ")} in ${BG_DIR}` +
					(registryId ? "; resuming this session picks them up again" : ""),
				"warning",
			);
		}
		// Seen running just now: their registry entries age from here.
		persist(...orphans);
		ctxRef = undefined;
		// Jobs still running report to whichever instance takes the next session.
		disposed = true;
		if (liveSlot[LIVE_KEY] === self) delete liveSlot[LIVE_KEY];
		let taken = false;
		const mine: BgHandoff = {
			sessionId,
			take: () => {
				if (taken) return [];
				taken = true;
				return [...jobs.values()].filter((job) => !job.quiet).map(toRecord);
			},
		};
		handoff = mine;
		liveSlot[HANDOFF_KEY] = mine;
	});
}
