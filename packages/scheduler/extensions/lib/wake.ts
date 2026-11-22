/**
 * Session wake: the pi-scheduler tick reopens a closed session in tmux when
 * one of its `wake` timers comes due, or when a background job it started has
 * finished since it closed. The tick only spawns; pi's own restore does the
 * rest (the timer catch-up fires, bg re-adopts and reports the job). No model
 * runs in the tick.
 *
 * Inputs, all read-only here:
 *   - session-timers.json (lib/session-index.ts): which sessions have wake
 *     timers, and when the earliest `crash`/`always` ones are due;
 *   - sessions/<id>.json (lib/lifecycle.ts): how each session last closed;
 *   - the bg registry (~/.local/state/pi-bg/<id>.json) and its `<log>.exit`
 *     files.
 *
 * Its own files, under the scheduler dir (0700/0600):
 *   - wake.json        config: { enabled, bg, tmuxTarget, perSessionHourly,
 *                      globalHourly, perTick, tmux?, pi? }
 *   - wake-state.json  in-flight wakes, consecutive failures and backoffs, the
 *                      hourly ledger, and when each skip was last logged
 *   - wake.log         one line per wake, skip and failure; rotated at 1 MB
 *
 * Privacy: ids, paths, reasons and times only. Nothing here ever copies a bg
 * job's command, name, summary or meta, or a timer's prompt.
 *
 * Everything that touches the machine (the clock, hostname, boot time, ps,
 * tmux) comes in through `WakeDeps`, so the tests never start a tmux window
 * or a pi.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { withLockedFile } from "./locked-file.ts";
import {
  type LifecycleRecord,
  SESSION_ID_RE,
  lifecyclePath,
  pruneLifecycle,
  readLifecycle,
} from "./lifecycle.ts";
import { type ProcessProbe, probeProcess } from "./process-identity.ts";
import { type SessionIndexEntry, readSessionIndex } from "./session-index.ts";
import { schedulerDir } from "./task-registry.ts";

// ── constants ──

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A spawned wake must show a matching live lifecycle record (or a live pane) by then. */
export const GRACE_MS = 3 * MINUTE;
/** A pane alive this long without its session going live is stuck: a failure, never killed. */
export const STUCK_MS = 10 * MINUTE;
/** A woken session that crashes or vanishes within this of going live is a failed wake. */
export const SETTLE_MS = 10 * MINUTE;
/** Consecutive failures before a session is backed off until a manual open. */
export const BACKOFF_AFTER = 2;
/** Due times (and bg exits) older than this are past the catch-up window: waking does nothing. */
export const STALE_MS = 24 * HOUR;
/** Each skip is logged at most this often per session and reason. */
const SKIP_LOG_EVERY_MS = HOUR;
/** A gap between ticks longer than this is a sleep: in-flight deadlines move by it. */
const SLEEP_GAP_MS = 3 * MINUTE;
const LOG_MAX_BYTES = 1024 * 1024;
const LIFECYCLE_PRUNE_EVERY_MS = 6 * HOUR;
const LIFECYCLE_MAX_AGE_MS = 7 * 24 * HOUR;
const BG_REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
const MIN_TMUX: [number, number] = [3, 0];
const STATE_VERSION = 1;

// ── config ──

export interface WakeConfig {
  enabled: boolean;
  /** Wake for finished bg jobs (crash-class closes only). */
  bg: boolean;
  /** "pi-wake" (default, created if missing), "attached", or a session name. */
  tmuxTarget: string;
  perSessionHourly: number;
  globalHourly: number;
  perTick: number;
  /** Absolute tmux path, when PATH under the service does not find the right one. */
  tmux?: string;
  /** Absolute pi path; default ~/.pi/agent/bin/pi, then pi on PATH. */
  pi?: string;
}

/**
 * Off until turned on with `pi-scheduler wake on`: a wake runs the model with
 * nobody watching, so no session reopens on its own until the device test has
 * passed on that machine.
 */
export const DEFAULT_WAKE_CONFIG: WakeConfig = {
  enabled: false,
  bg: true,
  tmuxTarget: "pi-wake",
  perSessionHourly: 3,
  globalHourly: 10,
  perTick: 1,
};

export function wakeConfigPath(): string {
  return join(schedulerDir(), "wake.json");
}
export function wakeStatePath(): string {
  return join(schedulerDir(), "wake-state.json");
}
export function wakeLogPath(): string {
  return join(schedulerDir(), "wake.log");
}

const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
const absolute = (value: unknown) => (typeof value === "string" && isAbsolute(value) ? value : undefined);
const TARGET_RE = /^[A-Za-z0-9_.@-]{1,64}$/;

/**
 * wake.json, filled in from the defaults. A file that will not parse reads as
 * the defaults plus an error. `enabledSet` says whether `enabled` came from the
 * file rather than the default.
 */
export function readWakeConfig(): { config: WakeConfig; error?: string; enabledSet?: boolean } {
  let raw: string;
  try {
    raw = readFileSync(wakeConfigPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { ...DEFAULT_WAKE_CONFIG } };
    return { config: { ...DEFAULT_WAKE_CONFIG }, error: String(error) };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
  } catch (error) {
    return { config: { ...DEFAULT_WAKE_CONFIG }, error: `wake.json: ${error instanceof Error ? error.message : String(error)}` };
  }
  const config: WakeConfig = {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_WAKE_CONFIG.enabled,
    bg: typeof parsed.bg === "boolean" ? parsed.bg : DEFAULT_WAKE_CONFIG.bg,
    tmuxTarget: typeof parsed.tmuxTarget === "string" && TARGET_RE.test(parsed.tmuxTarget)
      ? parsed.tmuxTarget
      : DEFAULT_WAKE_CONFIG.tmuxTarget,
    perSessionHourly: positive(parsed.perSessionHourly, DEFAULT_WAKE_CONFIG.perSessionHourly),
    globalHourly: positive(parsed.globalHourly, DEFAULT_WAKE_CONFIG.globalHourly),
    perTick: positive(parsed.perTick, DEFAULT_WAKE_CONFIG.perTick),
  };
  const tmux = absolute(parsed.tmux);
  const pi = absolute(parsed.pi);
  if (tmux) config.tmux = tmux;
  if (pi) config.pi = pi;
  return { config, enabledSet: typeof parsed.enabled === "boolean" };
}

/** Merge `patch` into wake.json, keeping whatever else is in it. */
export function updateWakeConfig(patch: Partial<WakeConfig>): WakeConfig {
  return withLockedFile(wakeConfigPath(), () => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(wakeConfigPath(), "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }, (current) => {
    const next = { ...current, ...patch };
    writePrivateJson(wakeConfigPath(), next);
    return readWakeConfig().config;
  });
}

// ── state ──

export type WakeReason = "timer" | "always" | "bg";

export interface InFlightWake {
  wakeId: string;
  sessionId: string;
  host: string;
  sessionFile: string;
  cwd: string;
  reason: WakeReason;
  dueAt: number;
  /** When the window was spawned. */
  at: number;
  /** tmux window id (`@12`). */
  window?: string;
  /** When wake-exec started pi. */
  execAt?: number;
  /** When its lifecycle record first showed it live. */
  liveAt?: number;
  /** Time spent asleep since the spawn; grace and stuck are measured without it. */
  sleptMs?: number;
}

export interface FailureRecord {
  count: number;
  lastAt: number;
  lastReason: string;
  /** Set once `count` reaches BACKOFF_AFTER: no wakes until a manual open after this. */
  backoffSince?: number;
}

export interface WakeState {
  v: number;
  wakes: Record<string, InFlightWake>;
  /** Keyed `host:sessionId`. */
  failures: Record<string, FailureRecord>;
  /** One entry per spawn in the last hour, keyed by host and session for the caps. */
  ledger: Array<{ host: string; sessionId: string; at: number }>;
  /** `host:sessionId:reason` → when that skip was last logged. */
  logged: Record<string, number>;
  lastTickAt?: number;
  lastPruneAt?: number;
}

export function emptyWakeState(): WakeState {
  return { v: STATE_VERSION, wakes: {}, failures: {}, ledger: [], logged: {} };
}

/** Read wake-state.json. Missing reads as empty; unreadable reads as empty with `corrupt`. */
export function readWakeState(): { state: WakeState; corrupt?: string } {
  let raw: string;
  try {
    raw = readFileSync(wakeStatePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: emptyWakeState() };
    return { state: emptyWakeState(), corrupt: String(error) };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WakeState> | null;
    if (!parsed || typeof parsed !== "object" || parsed.v !== STATE_VERSION) throw new Error("unexpected shape");
    const state = emptyWakeState();
    for (const [id, wake] of Object.entries(parsed.wakes ?? {})) {
      if (wake && typeof wake.sessionId === "string" && typeof wake.at === "number") state.wakes[id] = wake;
    }
    for (const [key, failure] of Object.entries(parsed.failures ?? {})) {
      if (failure && typeof failure.count === "number") state.failures[key] = failure;
    }
    if (Array.isArray(parsed.ledger)) {
      state.ledger = parsed.ledger.filter((entry) => entry && typeof entry.at === "number");
    }
    if (parsed.logged && typeof parsed.logged === "object") state.logged = { ...parsed.logged };
    if (typeof parsed.lastTickAt === "number") state.lastTickAt = parsed.lastTickAt;
    if (typeof parsed.lastPruneAt === "number") state.lastPruneAt = parsed.lastPruneAt;
    return { state };
  } catch (error) {
    return { state: emptyWakeState(), corrupt: error instanceof Error ? error.message : String(error) };
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function writeWakeState(state: WakeState): void {
  writePrivateJson(wakeStatePath(), state);
}

/** Read-modify-write wake-state.json under its lock. */
export function withWakeState<R>(mutate: (state: WakeState) => R, attempts?: number): R {
  return withLockedFile(wakeStatePath(), readWakeState, ({ state, corrupt }) => {
    if (corrupt !== undefined) {
      try {
        renameSync(wakeStatePath(), `${wakeStatePath()}.corrupt-${Date.now()}`);
      } catch {
        // the next write replaces it anyway
      }
      appendWakeLog("state-reset", undefined, { why: "corrupt" });
    }
    return mutate(state);
  }, attempts === undefined ? {} : { attempts });
}

export const failureKey = (host: string, sessionId: string) => `${host}:${sessionId}`;

// ── the log ──

/** A log value: bare when it is one safe token, JSON-quoted otherwise. */
function logValue(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9_.:@\/+-]+$/.test(text) ? text : JSON.stringify(text);
}

/**
 * Append one line to wake.log: `<iso> <event> <sessionId|-> key=value…`.
 *
 * Callers pass ids, paths, reasons and times only. Rotates to wake.log.1 at
 * 1 MB, keeping one. Never throws: a log that cannot be written must not stop
 * a wake or the durable tasks after it.
 */
export function appendWakeLog(
  event: string,
  sessionId: string | undefined,
  fields: Record<string, string | number | undefined> = {},
  now = Date.now(),
): void {
  const path = wakeLogPath();
  const parts = [new Date(now).toISOString(), event, sessionId ?? "-"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${logValue(value)}`);
  }
  try {
    try {
      if (statSync(path).size >= LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // no log yet
    }
    appendFileSync(path, `${parts.join(" ")}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

export function wakeLogTail(lines = 20): string[] {
  try {
    const all = readFileSync(wakeLogPath(), "utf8").split("\n").filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

// ── the machine, injected ──

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface WakeDeps {
  now(): number;
  hostname(): string;
  /** Boot time in ms, or undefined when it cannot be read. */
  bootTime(): number | undefined;
  probe(pid: number): ProcessProbe;
  /** Run a program synchronously, argv form (never a shell). */
  run(file: string, args: string[]): RunResult;
  platform: NodeJS.Platform;
  uid: number | undefined;
  env: Record<string, string | undefined>;
  /** Absolute node and pi-scheduler, for the window's argv. */
  node: string;
  self: string;
}

function runSync(file: string, args: string[]): RunResult {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
}

/** kern.boottime on macOS, btime in /proc/stat on Linux. */
export function readBootTime(platform: NodeJS.Platform = process.platform): number | undefined {
  try {
    if (platform === "darwin") {
      const out = runSync("/usr/sbin/sysctl", ["-n", "kern.boottime"]).stdout;
      const sec = /sec\s*=\s*(\d+)/.exec(out)?.[1];
      return sec ? Number(sec) * 1000 : undefined;
    }
    if (platform === "linux") {
      const btime = /^btime\s+(\d+)/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
      return btime ? Number(btime) * 1000 : undefined;
    }
  } catch {
    // unknown
  }
  return undefined;
}

export function defaultWakeDeps(self: string): WakeDeps {
  return {
    now: () => Date.now(),
    hostname: () => osHostname(),
    bootTime: () => readBootTime(),
    probe: probeProcess,
    run: runSync,
    platform: process.platform,
    uid: process.getuid?.(),
    env: process.env,
    node: process.execPath,
    self,
  };
}

// ── resolution ──

function executable(path: string | undefined): path is string {
  if (!path || !isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function which(name: string, pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

const homeOf = (deps: WakeDeps) => deps.env.HOME || homedir();

export function resolveTmux(config: WakeConfig, deps: WakeDeps): string | undefined {
  if (config.tmux) return executable(config.tmux) ? config.tmux : undefined;
  return which("tmux", deps.env.PATH)
    ?? ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((path) => executable(path));
}

export function resolvePi(config: WakeConfig, deps: WakeDeps): string | undefined {
  if (config.pi) return executable(config.pi) ? config.pi : undefined;
  const wrapper = join(homeOf(deps), ".pi", "agent", "bin", "pi");
  return executable(wrapper) ? wrapper : which("pi", deps.env.PATH);
}

/** PATH for a woken window: the service's, with this node's directory first so the pi wrapper's `exec node` resolves. */
export function windowPath(deps: WakeDeps): string {
  const nodeDir = dirname(deps.node);
  const parts = (deps.env.PATH ?? "/usr/bin:/bin").split(delimiter).filter(Boolean);
  return [nodeDir, ...parts.filter((part) => part !== nodeDir)].join(delimiter);
}

/** `tmux -V` as [major, minor], or undefined when missing or unreadable. */
export function tmuxVersion(tmux: string | undefined, deps: WakeDeps): [number, number] | undefined {
  if (!tmux) return undefined;
  const result = deps.run(tmux, ["-V"]);
  if (result.error || result.status !== 0) return undefined;
  const match = /(\d+)\.(\d+)/.exec(result.stdout);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function versionOk(version: [number, number] | undefined): boolean {
  if (!version) return false;
  return version[0] > MIN_TMUX[0] || (version[0] === MIN_TMUX[0] && version[1] >= MIN_TMUX[1]);
}

/** Where the bg extension keeps its registry; the same lookup as extensions/bg. */
export function bgStateDir(deps: WakeDeps): string {
  return deps.env.PI_BG_STATE_DIR
    ?? join(deps.env.XDG_STATE_HOME || join(homeOf(deps), ".local", "state"), "pi-bg");
}

/** Why bg wakes are off, or undefined when they are on. */
export function bgWakeOff(config: WakeConfig, deps: WakeDeps): string | undefined {
  if (!config.bg) return "wake.json bg:false";
  if (deps.env.PI_SCHEDULER_WAKE_BG === "0") return "PI_SCHEDULER_WAKE_BG=0";
  // A reopened session would re-adopt the job but report it without a turn
  // (nextTurn) or not at all (off): nothing would happen, so do not wake.
  const bgWake = deps.env.PI_BG_WAKE;
  if (bgWake === "off" || bgWake === "nextTurn") return `PI_BG_WAKE=${bgWake}`;
  return undefined;
}

// ── tmux ──

export interface TmuxWindow {
  id: string;
  piSession: string;
  paneDead: boolean;
}

export function listWindows(tmux: string, deps: WakeDeps): TmuxWindow[] | undefined {
  const result = deps.run(tmux, ["list-windows", "-a", "-F", "#{window_id}\t#{@pi-session}\t#{pane_dead}"]);
  if (result.error) return undefined;
  // No server running: there are no windows, which is an answer, not an error.
  if (result.status !== 0) return /no server running|error connecting|No such file/i.test(result.stderr) ? [] : undefined;
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [id = "", piSession = "", dead = "0"] = line.split("\t");
    return { id, piSession, paneDead: dead === "1" };
  });
}

function serverRunning(tmux: string, deps: WakeDeps): boolean {
  return deps.run(tmux, ["list-sessions", "-F", "#{session_name}"]).status === 0;
}

/**
 * Start a detached tmux session, starting the server too if none runs.
 *
 * A server the tick starts must outlive the tick, and must not inherit its
 * service's scheduling class:
 *  - Linux: a `Type=oneshot` unit's default KillMode kills the whole control
 *    group when `check` exits, tmux server included, so the server is started
 *    in its own transient scope with `systemd-run --user --scope`.
 *  - macOS: the launchd job is `ProcessType Background` + `LowPriorityIO`, and
 *    everything it forks inherits that throttling, including every pi the
 *    server later runs. The server is started through `launchctl asuser` with
 *    the I/O policy reset (`taskpolicy -d default -g default`), then moved out
 *    of the darwin background band with `taskpolicy -B -p <server pid>`.
 * When the server already runs, a plain `new-session` asks it to create the
 * session, and the server (not the tick) forks the shell, so none of this is
 * needed.
 *
 * On Linux there is no plain fallback: a server started inside the oneshot
 * unit's control group dies when `check` exits, taking the woken pi with it.
 * On macOS the plain fallback (asuser failed) still gets `taskpolicy -B`.
 */
export function createSession(name: string, tmux: string, deps: WakeDeps): { ok: boolean; how: string; error?: string } {
  const home = homeOf(deps);
  const newSession = [tmux, "new-session", "-d", "-s", name, "-c", home];
  if (serverRunning(tmux, deps)) {
    const result = deps.run(newSession[0] as string, newSession.slice(1));
    return result.status === 0 ? { ok: true, how: "server" } : { ok: false, how: "server", error: result.stderr.trim() || result.error };
  }

  if (deps.platform === "linux") {
    const systemdRun = which("systemd-run", deps.env.PATH) ?? ["/usr/bin/systemd-run", "/bin/systemd-run"].find((p) => executable(p));
    if (systemdRun) {
      const result = deps.run(systemdRun, ["--user", "--scope", "--quiet", "--collect", "--", ...newSession]);
      if (result.status === 0) return { ok: true, how: "systemd-scope" };
      appendWakeLog("tmux-scope-failed", undefined, { status: result.status ?? -1 }, deps.now());
      return { ok: false, how: "systemd-scope", error: `systemd-run exited ${result.status ?? -1}` };
    }
    // Under a systemd unit (INVOCATION_ID) with no way out of its cgroup: refuse.
    if (deps.env.INVOCATION_ID) return { ok: false, how: "systemd-scope", error: "systemd-run not found" };
  }

  let how = "plain";
  let created = false;
  if (deps.platform === "darwin" && deps.uid !== undefined) {
    const result = deps.run("/bin/launchctl", [
      "asuser", String(deps.uid), "/usr/sbin/taskpolicy", "-d", "default", "-g", "default", ...newSession,
    ]);
    if (result.status === 0) {
      how = "launchctl-asuser";
      created = true;
    } else {
      appendWakeLog("tmux-asuser-failed", undefined, { status: result.status ?? -1 }, deps.now());
    }
  }
  if (!created) {
    const result = deps.run(newSession[0] as string, newSession.slice(1));
    if (result.status !== 0) return { ok: false, how: "plain", error: result.stderr.trim() || result.error };
  }
  if (deps.platform === "darwin") {
    // Whichever way it was created, move the server out of the background band.
    const pid = deps.run(tmux, ["display-message", "-p", "-t", `${name}:`, "#{pid}"]).stdout.trim();
    const unthrottled = /^\d+$/.test(pid) && deps.run("/usr/sbin/taskpolicy", ["-B", "-p", pid]).status === 0;
    if (!unthrottled) {
      appendWakeLog("tmux-throttled", undefined, { pid: pid || "?" }, deps.now());
      how += "-throttled";
    }
  }
  return { ok: true, how };
}

/** The running tmux server's pid and scheduling (`ps -o pri,nice`), for `wake status`. */
export function tmuxServerInfo(tmux: string | undefined, deps: WakeDeps): { pid?: number; pri?: string; nice?: string } | undefined {
  if (!tmux) return undefined;
  const result = deps.run(tmux, ["display-message", "-p", "#{pid}"]);
  const pid = result.status === 0 ? result.stdout.trim() : "";
  if (!/^\d+$/.test(pid)) return undefined;
  const ps = deps.run(which("ps", deps.env.PATH) ?? "/bin/ps", ["-o", "pri=", "-o", "nice=", "-p", pid]);
  const [pri, nice] = ps.status === 0 ? ps.stdout.trim().split(/\s+/) : [];
  return { pid: Number(pid), ...(pri ? { pri } : {}), ...(nice ? { nice } : {}) };
}

/** The session to open the window in, created when it does not exist. */
export function ensureTarget(config: WakeConfig, tmux: string, deps: WakeDeps): { target?: string; error?: string } {
  let name = config.tmuxTarget;
  if (name === "attached") {
    const listed = deps.run(tmux, ["list-sessions", "-F", "#{session_attached}\t#{session_name}"]);
    const attached = listed.status === 0
      ? listed.stdout.split("\n").map((line) => line.split("\t")).find(([count]) => Number(count) > 0)?.[1]
      : undefined;
    if (attached) return { target: attached };
    name = DEFAULT_WAKE_CONFIG.tmuxTarget;
  }
  if (deps.run(tmux, ["has-session", "-t", `=${name}`]).status === 0) return { target: name };
  const created = createSession(name, tmux, deps);
  if (!created.ok) return { error: `could not create tmux session ${name}: ${created.error ?? "unknown"}` };
  appendWakeLog("tmux-session", undefined, { name, how: created.how }, deps.now());
  return { target: name };
}

/**
 * The argv that opens a woken window. Argv form only — never a shell string,
 * which a path with a quote in it could escape — with absolute node and
 * pi-scheduler, and the service's PATH passed explicitly: a window inherits
 * the tmux server's environment, not the tick's.
 */
export function newWindowArgs(
  target: string,
  wake: { wakeId: string; sessionId: string; cwd: string },
  deps: WakeDeps,
): string[] {
  const env = [`PATH=${windowPath(deps)}`, `PI_WAKE_ID=${wake.wakeId}`];
  // wake-exec has to read the same state as the tick that spawned it.
  for (const key of ["PI_SCHEDULER_DIR", "PI_AGENT_DIR", "PI_BG_STATE_DIR", "PI_BG_DIR", "TMUX_TMPDIR"]) {
    const value = deps.env[key];
    if (value) env.push(`${key}=${value}`);
  }
  return [
    "new-window", "-d", "-P", "-F", "#{window_id}",
    "-t", `${target}:`,
    "-n", `wake:${wake.sessionId.slice(0, 8)}`,
    "-c", wake.cwd,
    ...env.flatMap((assignment) => ["-e", assignment]),
    "--", deps.node, deps.self, "wake-exec", wake.wakeId,
  ];
}

// ── reading a session file's header ──

export interface SessionHeader {
  id: string;
  cwd: string;
}

/** The first line of a session JSONL, bounded. */
export function readSessionHeader(file: string): SessionHeader | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
    const header = JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown };
    if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
    return { id: header.id, cwd: header.cwd };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The checks both the tick and wake-exec make right before opening a session:
 * the file is there, it is the session we mean, and its cwd still exists.
 * `pi --session <missing path>` would silently start a brand-new empty session
 * at that path, and a missing header cwd stops pi at an interactive prompt.
 */
export function sessionFileProblem(sessionId: string, sessionFile: string): { problem?: string; header?: SessionHeader } {
  if (!isAbsolute(sessionFile) || !isFile(sessionFile)) return { problem: "file-missing" };
  const header = readSessionHeader(sessionFile);
  if (!header || header.id !== sessionId) return { problem: "header-mismatch" };
  if (!isAbsolute(header.cwd) || !isDirectory(header.cwd)) return { problem: "cwd-missing" };
  return { header };
}

// ── classification ──

export interface CloseClass {
  /** The close was not on purpose: eligible for `crash` timers and bg wakes. */
  crash: boolean;
  /** Why, in a word: crash | vanished | reboot | tmux-gone | user | switched | signal. */
  why: string;
}

/**
 * Whether a closed (or vanished) session's close counts as a crash.
 *
 * `vanished` is the caller's: the record still says live but its pid is dead.
 * A SIGHUP or SIGTERM counts only when the machine has booted since the close,
 * or when the tmux server the session ran under is gone — otherwise it is
 * someone closing the window (Ghostty, `tmux kill-window`, Botsun), which is a
 * user close.
 */
export function classifyClose(
  record: LifecycleRecord,
  deps: Pick<WakeDeps, "bootTime" | "probe">,
  vanished = false,
): CloseClass {
  if (vanished) return { crash: true, why: "vanished" };
  if (record.how === "crash") return { crash: true, why: "crash" };
  if (record.how === "signal:SIGHUP" || record.how === "signal:SIGTERM") {
    const closedAt = record.closedAt ?? record.lastSeen;
    const boot = deps.bootTime();
    if (boot !== undefined && boot > closedAt) return { crash: true, why: "reboot" };
    if (record.tmux) {
      const server = deps.probe(record.tmux.pid);
      if (server.state === "dead" || (server.state === "alive" && server.start !== record.tmux.start)) {
        return { crash: true, why: "tmux-gone" };
      }
    }
    return { crash: false, why: "signal" };
  }
  return { crash: false, why: record.how === "switched" ? "switched" : "user" };
}

/** Is the record's pid still that pi? `unknown` when ps cannot tell. */
function recordLiveness(record: LifecycleRecord, deps: WakeDeps): "live" | "dead" | "unknown" {
  const probe = deps.probe(record.pid);
  if (probe.state === "unknown") return "unknown";
  if (probe.state === "dead") return "dead";
  // A matching start is that process. No recorded start cannot be proven
  // either way: unknown, so never woken over a pi that may be running.
  if (record.pidStart === undefined) return "unknown";
  return probe.start === record.pidStart ? "live" : "dead";
}

function indexHolderLive(entry: SessionIndexEntry | undefined, host: string, deps: WakeDeps): "live" | "dead" | "unknown" {
  if (!entry || entry.pid === undefined) return "dead";
  if (entry.host !== host) return "unknown";
  const probe = deps.probe(entry.pid);
  if (probe.state === "unknown") return "unknown";
  if (probe.state === "dead" || entry.pidStart === undefined) return probe.state === "dead" ? "dead" : "unknown";
  return probe.start === entry.pidStart ? "live" : "dead";
}

// ── candidates ──

/** Finished, unreported bg jobs of one session that may wake it: their exit-file mtimes. */
export function bgExitsBySession(deps: WakeDeps): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const dir = bgStateDir(deps);
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || (deps.uid !== undefined && st.uid !== deps.uid)) return out;
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return out;
  }
  const now = deps.now();
  for (const name of names) {
    const sessionId = name.slice(0, -".json".length);
    if (!SESSION_ID_RE.test(sessionId)) continue;
    const file = join(dir, name);
    let data: { v?: unknown; sessionId?: unknown; jobs?: unknown };
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > BG_REGISTRY_MAX_BYTES || (deps.uid !== undefined && st.uid !== deps.uid)) continue;
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (data?.v !== 1 || data.sessionId !== sessionId || !Array.isArray(data.jobs)) continue;
    // Only these fields are read: never command, name, summary or meta.
    for (const raw of data.jobs as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.endedAt !== undefined || raw.reported === true || raw.wake === false) continue;
      if (typeof raw.logPath !== "string" || !isAbsolute(raw.logPath)) continue;
      try {
        const exit = lstatSync(`${raw.logPath}.exit`);
        if (!exit.isFile() || (deps.uid !== undefined && exit.uid !== deps.uid)) continue;
        if (now - exit.mtimeMs > STALE_MS) continue;
        out.set(sessionId, [...(out.get(sessionId) ?? []), exit.mtimeMs]);
      } catch {
        // still running, or its exit file is gone (a reboot wiped /tmp)
      }
    }
  }
  return out;
}

export interface WakeDecision {
  sessionId: string;
  action: "wake" | "skip";
  /** Skip reason, or the wake's reason. */
  reason: string;
  dueAt?: number;
  /** For a wake: what it opens. */
  sessionFile?: string;
  cwd?: string;
  wakeReason?: WakeReason;
  /** The close, for the log: crash | vanished | reboot | tmux-gone | user | switched | signal. */
  close?: string;
  /** Not worth a log line (in flight, or deferred by the per-tick cap). */
  quiet?: boolean;
}

interface EvaluateContext {
  config: WakeConfig;
  deps: WakeDeps;
  state: WakeState;
  host: string;
  now: number;
  index: Record<string, SessionIndexEntry>;
  bgExits: Map<string, number[]>;
  bgOff?: string;
  /** Mutated: backoffs cleared by a manual open. */
  onDirty(): void;
}

/** Evaluate one session: wake (with what) or skip (with why). Pre-spawn tmux checks come later. */
function evaluateSession(sessionId: string, ctx: EvaluateContext): WakeDecision {
  const { deps, state, host, now } = ctx;
  const skip = (reason: string, extra: Partial<WakeDecision> = {}): WakeDecision =>
    ({ sessionId, action: "skip", reason, ...extra });

  if (Object.values(state.wakes).some((wake) => wake.sessionId === sessionId && wake.host === host)) {
    return skip("in-flight", { quiet: true });
  }
  const record = readLifecycle(sessionId);
  // No record is unknown: an old pi, print mode, a subagent. Never woken, and
  // not logged: a print-mode bg exit would say so every hour for a day.
  if (!record) return skip("no-record", { quiet: true });
  if (record.host !== host) return skip("host-mismatch");

  const entry = ctx.index[sessionId];
  let vanished = false;
  if (record.state === "live") {
    const liveness = recordLiveness(record, deps);
    if (liveness === "live") return skip("live");
    if (liveness === "unknown") return skip("ps-unknown");
    vanished = true;
  }
  const holder = indexHolderLive(entry, host, deps);
  if (holder === "live") return skip("live");
  if (holder === "unknown" && entry?.pid !== undefined) return skip("ps-unknown");

  const key = failureKey(host, sessionId);
  const failure = state.failures[key];
  if (failure?.backoffSince !== undefined) {
    // Opened by hand since the backoff: the user has seen it, start over.
    if (record.opener === "manual" && record.liveSince > failure.backoffSince) {
      delete state.failures[key];
      ctx.onDirty();
    } else {
      return skip("backoff");
    }
  } else if (failure && record.opener === "manual" && record.liveSince > failure.lastAt) {
    // A failure short of a backoff, then opened by hand: the streak is broken.
    delete state.failures[key];
    ctx.onDirty();
  }

  const close = classifyClose(record, deps, vanished);
  // Each due time on its own: one past the 24 h catch-up window (a crash timer
  // that went due while backed off, say) must not block a fresher reason.
  const options: Array<{ reason: WakeReason; dueAt: number }> = [];
  const blocked: number[] = [];
  let staleDue: number | undefined;
  const consider = (reason: WakeReason, dueAt: number, eligible: boolean) => {
    if (now - dueAt > STALE_MS) {
      staleDue = Math.min(staleDue ?? dueAt, dueAt);
      return;
    }
    if (eligible) options.push({ reason, dueAt });
    else blocked.push(dueAt);
  };
  if (entry && entry.host === host) {
    if (entry.nextWakeDueAt !== undefined && entry.nextWakeDueAt <= now) {
      consider("timer", entry.nextWakeDueAt, close.crash);
    }
    // `always` reopens even a deliberate quit; it still obeys everything else.
    if (entry.nextAlwaysDueAt !== undefined && entry.nextAlwaysDueAt <= now) {
      consider("always", entry.nextAlwaysDueAt, true);
    }
  }
  const exits = ctx.bgExits.get(sessionId);
  if (exits && ctx.bgOff === undefined) {
    // Only exits after the session's last live moment: earlier ones it saw itself.
    const since = record.state === "closed" ? (record.closedAt ?? record.lastSeen) : record.lastSeen;
    const fresh = exits.filter((at) => at > since && now - at <= STALE_MS);
    if (fresh.length > 0) consider("bg", Math.min(...fresh), close.crash);
  }
  if (options.length === 0) {
    if (blocked.length > 0) return skip("user-closed", { close: close.why, dueAt: Math.min(...blocked) });
    if (staleDue !== undefined) return skip("stale", { dueAt: staleDue, close: close.why });
    return skip("nothing-due", { close: close.why, quiet: true });
  }
  options.sort((left, right) => left.dueAt - right.dueAt);
  const chosen = options[0] as { reason: WakeReason; dueAt: number };

  const checked = sessionFileProblem(sessionId, record.sessionFile);
  if (checked.problem) return skip(checked.problem, { dueAt: chosen.dueAt });
  return {
    sessionId,
    action: "wake",
    reason: chosen.reason,
    wakeReason: chosen.reason,
    dueAt: chosen.dueAt,
    sessionFile: record.sessionFile,
    cwd: (checked.header as SessionHeader).cwd,
    close: close.why,
  };
}

// ── settling in-flight wakes ──

function recordFailure(state: WakeState, wake: InFlightWake, reason: string, now: number): void {
  const key = failureKey(wake.host, wake.sessionId);
  const previous = state.failures[key];
  const count = (previous?.count ?? 0) + 1;
  const failure: FailureRecord = { count, lastAt: now, lastReason: reason };
  if (previous?.backoffSince !== undefined) failure.backoffSince = previous.backoffSince;
  else if (count >= BACKOFF_AFTER) failure.backoffSince = now;
  state.failures[key] = failure;
  appendWakeLog("fail", wake.sessionId, { reason, wakeId: wake.wakeId, failures: count }, now);
  if (failure.backoffSince === now) appendWakeLog("backoff", wake.sessionId, { failures: count }, now);
}

function windowAlive(wake: InFlightWake, windows: TmuxWindow[] | undefined): boolean | undefined {
  if (!windows) return undefined;
  return windows.some((window) =>
    !window.paneDead && (window.id === wake.window || window.piSession === wake.sessionId));
}

/**
 * Settle what earlier ticks started: success once the woken session has been
 * live for SETTLE_MS, failure if it never went live (no record, no pane after
 * GRACE_MS), got stuck (pane alive, never live, STUCK_MS) or crashed or
 * vanished within SETTLE_MS of going live.
 */
export function settleWakes(state: WakeState, deps: WakeDeps, tmux: string | undefined): boolean {
  const now = deps.now();
  const host = deps.hostname();
  let dirty = false;
  const mine = Object.values(state.wakes).filter((wake) => wake.host === host);
  if (mine.length === 0) return false;

  // A long gap since the last tick is a sleep: the machine could not have
  // booted anything meanwhile, so the wait does not count against grace.
  if (state.lastTickAt !== undefined && now - state.lastTickAt > SLEEP_GAP_MS) {
    const slept = now - state.lastTickAt - MINUTE;
    for (const wake of mine) wake.sleptMs = (wake.sleptMs ?? 0) + slept;
    dirty = true;
  }

  const windows = tmux ? listWindows(tmux, deps) : undefined;
  const done = (wake: InFlightWake) => {
    delete state.wakes[wake.wakeId];
    dirty = true;
  };

  for (const wake of mine) {
    const elapsed = now - wake.at - (wake.sleptMs ?? 0);
    const record = readLifecycle(wake.sessionId);
    if (record && record.wakeId === wake.wakeId) {
      if (wake.liveAt === undefined) {
        wake.liveAt = record.liveSince;
        dirty = true;
      }
      const liveFor = (until: number) => until - (wake.liveAt ?? record.liveSince);
      if (record.state === "live") {
        const liveness = recordLiveness(record, deps);
        if (liveness === "unknown") continue;
        if (liveness === "live") {
          if (liveFor(now) >= SETTLE_MS) {
            delete state.failures[failureKey(wake.host, wake.sessionId)];
            appendWakeLog("ok", wake.sessionId, { wakeId: wake.wakeId }, now);
            done(wake);
          }
          continue;
        }
        // Vanished: the record says live, the pid is gone.
        if (liveFor(record.lastSeen) < SETTLE_MS) recordFailure(state, wake, "vanished", now);
        else appendWakeLog("ok", wake.sessionId, { wakeId: wake.wakeId }, now);
        done(wake);
        continue;
      }
      const close = classifyClose(record, deps);
      const closedAt = record.closedAt ?? record.lastSeen;
      if (close.crash && liveFor(closedAt) < SETTLE_MS) recordFailure(state, wake, close.why, now);
      else appendWakeLog("ok", wake.sessionId, { wakeId: wake.wakeId, closed: close.why }, now);
      done(wake);
      continue;
    }

    const alive = windowAlive(wake, windows);
    if (alive === true) {
      if (elapsed >= STUCK_MS) {
        // Probably a prompt nobody is there to answer (trust, approval,
        // biometrics). Never killed: whoever finds it may want to answer it.
        recordFailure(state, wake, "stuck", now);
        done(wake);
      }
      continue;
    }
    if (alive === undefined && elapsed < STUCK_MS) continue;
    if (elapsed >= GRACE_MS) {
      recordFailure(state, wake, "no-start", now);
      done(wake);
    }
  }
  return dirty;
}

// ── the phase ──

export interface WakePhaseResult {
  decisions: WakeDecision[];
  spawned: WakeDecision[];
  /** Set when the phase did not run at all. */
  idle?: string;
}

/** Whether there is anything at all to look at, without taking the lock: idle ticks touch nothing. */
function anyCandidates(config: WakeConfig, deps: WakeDeps, index: Record<string, SessionIndexEntry>, bgExits: Map<string, number[]>): boolean {
  const now = deps.now();
  const host = deps.hostname();
  for (const entry of Object.values(index)) {
    if (entry.host !== host) continue;
    if ((entry.nextWakeDueAt ?? Number.POSITIVE_INFINITY) <= now) return true;
    if ((entry.nextAlwaysDueAt ?? Number.POSITIVE_INFINITY) <= now) return true;
  }
  if (bgExits.size > 0 && bgWakeOff(config, deps) === undefined) return true;
  return isFile(wakeStatePath());
}

function evaluateAll(
  state: WakeState,
  config: WakeConfig,
  deps: WakeDeps,
  index: Record<string, SessionIndexEntry>,
  bgExits: Map<string, number[]>,
  onDirty: () => void,
): WakeDecision[] {
  const now = deps.now();
  const host = deps.hostname();
  const bgOff = bgWakeOff(config, deps);
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(index)) {
    if (entry.host !== host) continue;
    const due = Math.min(entry.nextWakeDueAt ?? Number.POSITIVE_INFINITY, entry.nextAlwaysDueAt ?? Number.POSITIVE_INFINITY);
    if (due <= now) ids.add(id);
  }
  if (bgOff === undefined) for (const id of bgExits.keys()) ids.add(id);
  const ctx: EvaluateContext = { config, deps, state, host, now, index, bgExits, ...(bgOff ? { bgOff } : {}), onDirty };
  return [...ids].filter((id) => SESSION_ID_RE.test(id)).map((id) => evaluateSession(id, ctx));
}

/** Skips that will not change until their due time does: logged once per due time. */
const ONCE_PER_DUE = new Set(["stale", "user-closed"]);
/** How long a once-per-due-time key is remembered. */
const DUE_LOG_KEEP_MS = 7 * 24 * HOUR;

/**
 * Log a skip: `stale` and `user-closed` once per due time, the rest at most
 * once an hour per session and reason. Returns whether the state changed.
 */
function logSkip(state: WakeState, decision: WakeDecision, host: string, now: number): boolean {
  if (decision.quiet) return false;
  const perDue = ONCE_PER_DUE.has(decision.reason) && decision.dueAt !== undefined;
  const key = `${host}:${decision.sessionId}:${decision.reason}${perDue ? `@${decision.dueAt}` : ""}`;
  const last = state.logged[key];
  if (last !== undefined && (perDue || now - last < SKIP_LOG_EVERY_MS)) return false;
  state.logged[key] = now;
  appendWakeLog("skip", decision.sessionId, {
    reason: decision.reason,
    close: decision.close,
    due: decision.dueAt === undefined ? undefined : new Date(decision.dueAt).toISOString(),
  }, now);
  return true;
}

function pruneState(state: WakeState, now: number, host: string): boolean {
  let dirty = false;
  const ledger = state.ledger.filter((entry) => now - entry.at < HOUR);
  if (ledger.length !== state.ledger.length) {
    state.ledger = ledger;
    dirty = true;
  }
  for (const [key, at] of Object.entries(state.logged)) {
    if (now - at >= (key.includes("@") ? DUE_LOG_KEEP_MS : SKIP_LOG_EVERY_MS)) {
      delete state.logged[key];
      dirty = true;
    }
  }
  // Another host's in-flight wakes are its own to settle; one a day old is
  // never coming back (that host is gone, or its state was copied here).
  for (const [id, wake] of Object.entries(state.wakes)) {
    if (wake.host !== host && now - wake.at > STALE_MS) {
      delete state.wakes[id];
      dirty = true;
    }
  }
  return dirty;
}

/**
 * The wake phase of `pi-scheduler check`.
 *
 * Runs before the durable tasks (which are sequential agent runs and can take
 * many minutes), under the wake-state lock, and spawns at most `perTick`
 * windows, oldest due first. With `dryRun` it decides the same way and
 * changes nothing: no lock, no state, no log, no tmux session or window.
 */
export function runWakePhase(deps: WakeDeps, { dryRun = false }: { dryRun?: boolean } = {}): WakePhaseResult {
  const { config, error } = readWakeConfig();
  if (error && !dryRun) appendWakeLog("config-error", undefined, { path: wakeConfigPath() }, deps.now());
  if (!config.enabled) return { decisions: [], spawned: [], idle: "off" };

  const { index } = readSessionIndex();
  const bgExits = bgWakeOff(config, deps) === undefined ? bgExitsBySession(deps) : new Map<string, number[]>();

  if (dryRun) {
    const { state } = readWakeState();
    const decisions = evaluateAll(state, config, deps, index.sessions, bgExits, () => {});
    applyPreSpawn(decisions, state, config, deps, { dryRun: true });
    return { decisions, spawned: decisions.filter((decision) => decision.action === "wake") };
  }

  if (!anyCandidates(config, deps, index.sessions, bgExits)) return { decisions: [], spawned: [], idle: "nothing" };

  return withWakeState((state) => {
    const now = deps.now();
    const host = deps.hostname();
    let dirty = pruneState(state, now, host);
    const tmux = resolveTmux(config, deps);
    if (settleWakes(state, deps, tmux)) dirty = true;
    if (state.lastPruneAt === undefined || now - state.lastPruneAt > LIFECYCLE_PRUNE_EVERY_MS) {
      // Never a record a pending wake or always timer still needs (a 30-day
      // `--wake=always` timer after a /quit), and drop live records whose pi
      // is long dead (no shutdown, no exit listener: a SIGKILL, a power loss).
      const keep = new Set(Object.entries(index.sessions)
        .filter(([, entry]) => entry.nextWakeDueAt !== undefined || entry.nextAlwaysDueAt !== undefined)
        .map(([id]) => id));
      pruneLifecycle(now, LIFECYCLE_MAX_AGE_MS, {
        keep,
        isDead: (record) => record.host === host && recordLiveness(record, deps) === "dead",
      });
      state.lastPruneAt = now;
      dirty = true;
    }

    const decisions = evaluateAll(state, config, deps, index.sessions, bgExits, () => { dirty = true; });
    const spawned = applyPreSpawn(decisions, state, config, deps, { dryRun: false, tmux });
    for (const decision of decisions) {
      if (decision.action === "skip" && logSkip(state, decision, host, now)) dirty = true;
    }
    if (spawned.length > 0) dirty = true;
    // Only while something is in flight: it is what tells the next tick how
    // long it slept, and an idle tick must not rewrite the file every minute.
    if (Object.values(state.wakes).some((wake) => wake.host === host)) {
      state.lastTickAt = now;
      dirty = true;
    } else if (state.lastTickAt !== undefined) {
      delete state.lastTickAt;
      dirty = true;
    }
    if (dirty) writeWakeState(state);
    return { decisions, spawned };
  });
}

/**
 * The tmux pre-checks, the caps and the spawn, oldest due first. Turns
 * would-be wakes into skips where a check fails; spawns the rest (unless
 * `dryRun`).
 */
function applyPreSpawn(
  decisions: WakeDecision[],
  state: WakeState,
  config: WakeConfig,
  deps: WakeDeps,
  { dryRun, tmux: resolved }: { dryRun: boolean; tmux?: string | undefined },
): WakeDecision[] {
  const now = deps.now();
  const host = deps.hostname();
  const wakes = decisions.filter((decision) => decision.action === "wake")
    .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0));
  if (wakes.length === 0) return [];

  const toSkip = (decision: WakeDecision, reason: string, quiet = false) => {
    decision.action = "skip";
    decision.reason = reason;
    if (quiet) decision.quiet = true;
  };

  const tmux = resolved ?? resolveTmux(config, deps);
  const version = tmuxVersion(tmux, deps);
  const pi = resolvePi(config, deps);
  const problem = !tmux ? "tmux-missing" : !versionOk(version) ? "tmux-old" : !pi ? "pi-missing" : undefined;
  if (problem) {
    for (const decision of wakes) toSkip(decision, problem);
    return [];
  }
  const windows = listWindows(tmux as string, deps);
  if (windows === undefined) {
    for (const decision of wakes) toSkip(decision, "tmux-unknown");
    return [];
  }

  const recent = state.ledger.filter((entry) => entry.host === host && now - entry.at < HOUR);
  let globalUsed = recent.length;
  const spawned: WakeDecision[] = [];
  for (const decision of wakes) {
    if (windows.some((window) => window.piSession === decision.sessionId)) {
      toSkip(decision, "window-exists");
      continue;
    }
    if (recent.filter((entry) => entry.sessionId === decision.sessionId).length >= config.perSessionHourly) {
      toSkip(decision, "cap-session");
      continue;
    }
    if (globalUsed >= config.globalHourly) {
      toSkip(decision, "cap-global");
      continue;
    }
    if (spawned.length >= config.perTick) {
      // Deferred, not refused: the next tick takes it.
      toSkip(decision, "per-tick", true);
      continue;
    }
    if (dryRun) {
      spawned.push(decision);
      globalUsed += 1;
      continue;
    }
    if (spawnWake(decision, state, config, tmux as string, deps)) {
      spawned.push(decision);
      globalUsed += 1;
    } else {
      toSkip(decision, "spawn-failed");
    }
  }
  return spawned;
}

function spawnWake(decision: WakeDecision, state: WakeState, config: WakeConfig, tmux: string, deps: WakeDeps): boolean {
  const now = deps.now();
  const host = deps.hostname();
  const target = ensureTarget(config, tmux, deps);
  if (!target.target) {
    appendWakeLog("spawn-failed", decision.sessionId, { why: "tmux-target" }, now);
    return false;
  }
  const wake: InFlightWake = {
    wakeId: randomBytes(8).toString("hex"),
    sessionId: decision.sessionId,
    host,
    sessionFile: decision.sessionFile as string,
    cwd: decision.cwd as string,
    reason: decision.wakeReason as WakeReason,
    dueAt: decision.dueAt as number,
    at: now,
  };
  // On disk before the window exists: wake-exec looks itself up here, and the
  // next tick must see it in flight rather than spawn a second one.
  state.wakes[wake.wakeId] = wake;
  state.ledger.push({ host, sessionId: wake.sessionId, at: now });
  writeWakeState(state);

  const result = deps.run(tmux, newWindowArgs(target.target, wake, deps));
  if (result.status !== 0 || result.error) {
    delete state.wakes[wake.wakeId];
    state.ledger.pop();
    appendWakeLog("spawn-failed", wake.sessionId, { why: "new-window", status: result.status ?? -1 }, now);
    return false;
  }
  const windowId = result.stdout.trim().split("\n")[0] ?? "";
  if (/^@\d+$/.test(windowId)) {
    wake.window = windowId;
    deps.run(tmux, ["set-option", "-w", "-t", windowId, "@pi-session", wake.sessionId]);
    deps.run(tmux, ["set-option", "-w", "-t", windowId, "remain-on-exit", "off"]);
  }
  appendWakeLog("wake", wake.sessionId, {
    reason: wake.reason,
    close: decision.close,
    due: new Date(wake.dueAt).toISOString(),
    wakeId: wake.wakeId,
    target: target.target,
    window: wake.window,
  }, now);
  return true;
}

// ── wake-exec ──

export interface WakeExecDeps extends WakeDeps {
  /** Start pi and resolve with its exit code. Injected so tests never start one. */
  spawnPi(pi: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): Promise<{ code: number; stderrTail: string[] }>;
  /** Lock attempts (about 20 ms each); tests shorten it. Default 500, about 10 s. */
  lockAttempts?: number;
}

/**
 * What runs inside the woken window: re-check everything under the
 * per-session lock, immediately before starting pi, then start it.
 *
 * The tick decided a minute ago at most; Eric or Botsun may have opened the
 * session since, and two pi processes appending to one JSONL corrupt it. The
 * session file is passed as an absolute path, never an id: `--session <id>`
 * can stop at a "found in a different project" prompt nobody will answer.
 */
export async function wakeExec(wakeId: string, deps: WakeExecDeps): Promise<number> {
  const lockAttempts = deps.lockAttempts ?? 500;
  const host = deps.hostname();
  const safeId = /^[0-9a-f]{1,32}$/.test(wakeId) ? wakeId : "?";
  let wake: InFlightWake | undefined;
  try {
    wake = withWakeState((state) => state.wakes[wakeId], lockAttempts);
  } catch {
    // The tick held the lock too long (slow tmux or ps). Its next pass settles
    // this wake as no-start; say why here, since nothing else will.
    appendWakeLog("refuse", undefined, { reason: "lock-timeout", wakeId: safeId }, deps.now());
    return 4;
  }
  if (!wake) {
    appendWakeLog("refuse", undefined, { reason: "unknown-wake", wakeId: safeId }, deps.now());
    return 2;
  }
  const found = wake;
  /**
   * A refusal is the safety check working (live, file or cwd gone), not a
   * failed wake, and the hourly ledger already bounds repeats. The one
   * exception is a missing pi: that will fail the same way every time.
   */
  const refuse = (reason: string) => {
    appendWakeLog("refuse", found.sessionId, { reason, wakeId }, deps.now());
    try {
      withWakeState((state) => {
        delete state.wakes[wakeId];
        if (reason === "pi-missing") recordFailure(state, found, reason, deps.now());
        writeWakeState(state);
      }, lockAttempts);
    } catch {
      appendWakeLog("refuse", found.sessionId, { reason: "lock-timeout", wakeId }, deps.now());
    }
    return 3;
  };
  if (found.host !== host) return refuse("host-mismatch");

  const { config } = readWakeConfig();
  const pi = resolvePi(config, deps);
  if (!pi) return refuse("pi-missing");

  type Verdict = { problem?: string; cwd?: string };
  let verdict: Verdict;
  try {
    verdict = withLockedFile(lifecyclePath(found.sessionId), () => readLifecycle(found.sessionId), (record): Verdict => {
      if (record && record.host !== host) return { problem: "host-mismatch" };
      if (record?.state === "live") {
        const liveness = recordLiveness(record, deps);
        if (liveness === "live") return { problem: "live" };
        if (liveness === "unknown") return { problem: "ps-unknown" };
      }
      const { index } = readSessionIndex();
      const holder = indexHolderLive(index.sessions[found.sessionId], host, deps);
      if (holder === "live") return { problem: "live" };
      const checked = sessionFileProblem(found.sessionId, found.sessionFile);
      if (checked.problem) return { problem: checked.problem };
      return { cwd: (checked.header as SessionHeader).cwd };
    }, { attempts: lockAttempts });
  } catch {
    return refuse("lock-timeout");
  }
  if (verdict.problem) return refuse(verdict.problem);

  try {
    withWakeState((state) => {
      const current = state.wakes[wakeId];
      if (current) {
        current.execAt = deps.now();
        writeWakeState(state);
      }
    }, lockAttempts);
  } catch {
    // Only a marker for status; the lifecycle record is what settles the wake.
  }
  appendWakeLog("exec", found.sessionId, { wakeId }, deps.now());

  const { code, stderrTail } = await deps.spawnPi(pi, ["--session", found.sessionFile], {
    cwd: verdict.cwd as string,
    env: { ...deps.env, PI_WAKE_ID: wakeId },
  });
  if (code !== 0) {
    appendWakeLog("exit", found.sessionId, { code, wakeId }, deps.now());
    for (const line of stderrTail) appendWakeLog("stderr", found.sessionId, { wakeId, line: line.slice(0, 500) }, deps.now());
  }
  return code;
}

/**
 * Start pi in this terminal and wait for it.
 *
 * Not an exec: the nonzero exit and the last 20 lines of stderr go to
 * wake.log, and an exec'd pi would leave nobody to write them. stdin and
 * stdout stay the pane's tty; stderr is piped through to it. Ctrl+C reaches
 * pi through the tty's process group, so this process ignores SIGINT, and
 * passes SIGHUP and SIGTERM on in case they were sent to it alone.
 */
export function spawnPiInTerminal(
  pi: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): Promise<{ code: number; stderrTail: string[] }> {
  return new Promise((resolve) => {
    const tail: string[] = [];
    let partial = "";
    const child = spawn(pi, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["inherit", "inherit", "pipe"] });
    const forward = (signal: NodeJS.Signals) => () => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };
    const onInt = () => {};
    const onHup = forward("SIGHUP");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGHUP", onHup);
    process.on("SIGTERM", onTerm);
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      const lines = (partial + chunk.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      tail.push(...lines);
      if (tail.length > 20) tail.splice(0, tail.length - 20);
    });
    const finish = (code: number) => {
      process.off("SIGINT", onInt);
      process.off("SIGHUP", onHup);
      process.off("SIGTERM", onTerm);
      if (partial) tail.push(partial);
      resolve({ code, stderrTail: tail.slice(-20) });
    };
    child.on("error", (error) => {
      tail.push(`spawn failed: ${error.message}`);
      finish(127);
    });
    child.on("exit", (code, signal) => finish(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1)));
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal];
}

// ── status and reset ──

/** Clear a session's failures and backoff. Accepts an id or a unique prefix. Returns the ids cleared. */
export function resetWake(selector: string, host: string): string[] {
  return withWakeState((state) => {
    const keys = Object.keys(state.failures).filter((key) => {
      const [keyHost, ...rest] = key.split(":");
      return keyHost === host && rest.join(":").startsWith(selector);
    });
    const ids = keys.map((key) => key.slice(host.length + 1));
    if (new Set(ids).size > 1 && !ids.includes(selector)) {
      throw new Error(`${selector} matches ${ids.length} sessions; give more of the id`);
    }
    const chosen = ids.includes(selector) ? [failureKey(host, selector)] : keys;
    for (const key of chosen) delete state.failures[key];
    for (const [key] of Object.entries(state.logged)) {
      if (chosen.some((chosenKey) => key.startsWith(`${chosenKey}:`))) delete state.logged[key];
    }
    if (chosen.length > 0) {
      writeWakeState(state);
      for (const key of chosen) appendWakeLog("reset", key.slice(host.length + 1));
    }
    return chosen.map((key) => key.slice(host.length + 1));
  });
}

