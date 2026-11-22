import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { Type } from "typebox";

// Boehsline's shared config and tool_search helper. The tool is an opt-in on
// top of the commands, so it reads the same boehsline.json `enable` list (and
// shows up in /boehsline) as every other opt-in.
import { enabled, loadConfig, optIns, settingsFor } from "../../../lib/config.ts";
import { activateToolSearch } from "../../../lib/tool-search.ts";

import {
  MIN_INTERVAL_MS,
  type Schedule,
  type ScheduleKind,
  advanceSchedule,
  describeSchedule,
  formatDuration,
  parseClock,
  parseCron,
  parseDuration,
  parseOnceCommand,
  parseOnceTime,
  stripPromptDelimiter,
  taskLabel,
} from "./lib/schedule-core.ts";
import {
  type IndexOwner,
  type WakeLevel,
  planIndexEntry,
  sessionHolder,
  updateSessionIndex,
} from "./lib/session-index.ts";
import type { MisfirePolicy } from "./lib/task-registry.ts";
import { processStart } from "./lib/process-identity.ts";

const SNAPSHOT_TYPE = "session-scheduler:snapshot";
const SNAPSHOT_VERSION = 1;
const MAX_TASKS = 50;

/** Most missed timers a single restore will deliver, oldest first. */
export const MAX_CATCHUPS = 5;

/** Default staleness cap for a fire missed while pi was not running. */
export const DEFAULT_SESSION_MISFIRE_MS = 24 * 3_600_000;

/**
 * A fire more than this late is treated as a missed one (prefix + cap) even
 * though pi was open. libuv's clock does not advance while macOS sleeps, so a
 * 15m timer set before the lid closes fires at wake, however long that was,
 * and it would otherwise look perfectly on time.
 */
const LIVE_LATE_MS = 120_000;

/** The opt-in name in boehsline.json's `enable` list, and its settings key. */
export const TOOL_OPT_IN = "scheduler-tool";
export const TOOL_NAME = "schedule";
const TOOL_ACTIONS = ["once", "loop", "list", "cancel", "pause", "resume"] as const;
type ToolAction = (typeof TOOL_ACTIONS)[number];

// Long waits are re-armed in one-minute chunks (setTimeout also silently fires
// immediately past 2^31 ms, so a single timer was never safe for a long one).
// The chunk is what keeps a live timer honest across a laptop sleep: libuv's
// clock stops while the machine is asleep, so the callback re-checks
// Date.now() and notices a jump at most a minute after it happens.
const TIMER_CHUNK_MS = 60_000;

type NoticeLevel = "info" | "warning" | "error";

/** A fire waiting for the agent to be idle. */
interface QueuedFire {
  task: ScheduledTask;
  /** Set when the fire is late: it carries the "was due at" prefix. */
  late?: LateFire;
}

export interface ScheduledTask extends Schedule {
  id: string;
  prompt: string;
  createdAt: number;
  nextRunAt: number;
  paused?: boolean;
  /** "agent" when the schedule tool created it; its fire is labelled as the agent's own reminder. */
  source?: "agent";
  /**
   * Whether pi should reopen this session for this timer. Absent means never:
   * `crash` only after a session that died without being quit, `always` even
   * after a deliberate quit. Nothing reopens anything yet — this is the field
   * the index publishes so the tick can.
   */
  wake?: WakeLevel;
  /**
   * How late a missed fire may still be delivered: `skip` never, `always`
   * regardless, a number is the window in ms. Default: `PI_SCHEDULER_SESSION_MISFIRE`,
   * else 24h.
   */
  misfire?: MisfirePolicy;
}

interface SchedulerSnapshot {
  version: number;
  sessionId: string;
  tasks: ScheduledTask[];
}

/**
 * The footer status: "2 timers", "2 timers · 1 paused", or "1 paused" when
 * nothing is armed. Plain text on purpose; Boehsline's footer parses this
 * exact shape into its timers chip, so change both together.
 */
export function timerStatusText(active: number, paused: number): string | undefined {
  if (active === 0 && paused === 0) return undefined;
  if (active === 0) return `${paused} paused`;
  const armed = `${active} timer${active === 1 ? "" : "s"}`;
  return paused > 0 ? `${armed} · ${paused} paused` : armed;
}

/**
 * What other extensions see on `scheduler:tasks` (canvas's Background jobs
 * card): a display-safe view of each timer. Never the prompt beyond its first
 * line cut to a short label, so nothing private leaves this process.
 */
export interface TaskView {
  id: string;
  name: string;
  kind: ScheduleKind;
  every: string;
  next: string | null;
  last: string | null;
  status: "armed" | "paused";
  source: "session" | "agent";
}

export const TASKS_EVENT = "scheduler:tasks";

export function taskViews(tasks: ScheduledTask[]): TaskView[] {
  return tasks.map((task) => ({
    id: task.id,
    name: taskLabel(undefined, task.prompt),
    kind: task.kind,
    every: describeSchedule(task),
    next: task.paused || !Number.isFinite(task.nextRunAt) ? null : new Date(task.nextRunAt).toISOString(),
    last: null,
    status: task.paused ? "paused" : "armed",
    source: task.source === "agent" ? "agent" : "session",
  }));
}

interface ToolParams {
  action: string;
  prompt?: string;
  when?: string;
  every?: string;
  id?: string;
  /** "crash" | "always", or `true` for "crash"; only accepted with `allowWake`. */
  wake?: WakeLevel | boolean | null;
  /** skip | always | a duration such as 6h. */
  misfire?: string;
}

interface ResumeResult {
  tasks: ScheduledTask[];
  changed: boolean;
}

export function advanceRecurringTask(task: ScheduledTask, now: number): ScheduledTask {
  const next = advanceSchedule(task, task.nextRunAt, now);
  return next === undefined ? task : { ...task, nextRunAt: next };
}

/**
 * A recurring task re-armed past `now`, or nothing when its schedule cannot be
 * advanced.
 *
 * An interval slot that lands less than a quarter interval away is skipped: a
 * catch-up or a sleep-delayed fire would otherwise be followed by the next
 * slot almost immediately, which is two model turns back to back for one loop.
 * The phase is unchanged either way. Interval tasks only — a daily or cron slot
 * is the user's clock time, not ours to move.
 */
export function rearmRecurringTask(task: ScheduledTask, now: number): ScheduledTask | undefined {
  const advanced = advanceRecurringTask(task, now);
  if (!(advanced.nextRunAt > now)) return undefined;
  if (task.kind === "interval" && task.intervalMs && advanced.nextRunAt - now < task.intervalMs / 4) {
    const again = advanceRecurringTask(advanced, now);
    if (again.nextRunAt > now) return again;
  }
  return advanced;
}

export function normalizeTasksForResume(
  tasks: ScheduledTask[],
  now = Date.now(),
): ResumeResult {
  const normalized: ScheduledTask[] = [];
  let changed = false;

  for (const task of tasks) {
    if (task.paused) {
      normalized.push(task);
      continue;
    }
    if (task.kind === "once") {
      if (task.nextRunAt <= now) {
        changed = true;
        continue;
      }
      normalized.push(task);
      continue;
    }

    if (task.nextRunAt <= now) {
      const advanced = advanceRecurringTask(task, now);
      changed = true;
      if (advanced.nextRunAt > now) normalized.push(advanced);
    } else {
      normalized.push(task);
    }
  }

  return { tasks: normalized, changed };
}

/** A fire that arrived late, in the terms a prefix and a notice need. */
export interface LateFire {
  /** The slot it belongs to: the latest missed one, for a recurring task. */
  dueAt: number;
  /** Slots that came due while nothing was running. Only arithmetic schedules know. */
  missed?: number;
  lateMs: number;
  /**
   * Why it is late: pi was not running, or the computer was asleep with pi
   * open (libuv's clock stops, so the timer fires at wake, however much later
   * that is). The two read very differently in a prompt, and only one of them
   * is a catch-up.
   */
  cause: "closed" | "asleep";
}

/** A fire the restore decided not to deliver. */
export interface SkippedFire {
  id: string;
  dueAt: number;
  lateMs: number;
  reason: "late" | "overflow";
  /** Set when the task itself survives (a recurring one, re-armed past `now`). */
  nextRunAt?: number;
}

export interface RestorePlan {
  tasks: ScheduledTask[];
  /** Missed fires to deliver, oldest first. */
  catchUps: Array<{ task: ScheduledTask; late: LateFire }>;
  skipped: SkippedFire[];
  /** Whether the snapshot no longer matches the task list. */
  changed: boolean;
}
export interface RestoreOptions {
  /** Deliver missed fires instead of dropping them. `session_tree` and pause-resume never do. */
  catchUp?: boolean;
  /** Staleness window for a missed fire; defaults to the task's own `misfire`, then the env, then 24h. */
  misfireMs?: number;
}

/**
 * The staleness window for a missed fire: `skip` never delivers late, `always`
 * always does, and a number is how stale is still worth delivering. Same
 * vocabulary as the durable side, so `--misfire` means one thing.
 */
export function misfireWindowMs(policy: MisfirePolicy | undefined, fallback: number): number {
  if (policy === "skip") return 0;
  if (policy === "always") return Number.POSITIVE_INFINITY;
  if (typeof policy === "number" && Number.isFinite(policy) && policy >= 0) return policy;
  return fallback;
}

/** `PI_SCHEDULER_SESSION_MISFIRE`: skip | always | a duration, default 24h. */
export function sessionMisfireMs(value = process.env.PI_SCHEDULER_SESSION_MISFIRE): number {
  if (value === undefined || !value.trim()) return DEFAULT_SESSION_MISFIRE_MS;
  if (value.trim() === "skip") return 0;
  if (value.trim() === "always") return Number.POSITIVE_INFINITY;
  return parseDuration(value) ?? DEFAULT_SESSION_MISFIRE_MS;
}

/** This task's staleness window, in ms. */
export function taskMisfireMs(task: ScheduledTask, fallback = sessionMisfireMs()): number {
  return misfireWindowMs(task.misfire, fallback);
}

/**
 * The newest slot a task has missed, not the oldest.
 *
 * A daily task missed for a fortnight is a minute late, not two weeks late:
 * measuring from its first missed slot would make every long absence look
 * past any cap and silently lose the timer for good.
 *
 * `capMs` bounds the walk. A minute-granularity cron left for a month has
 * tens of thousands of slots, and walking them one at a time cost 1000
 * `parseCron` calls only to report a slot hours out of date. With a finite
 * cap the walk starts at the first slot inside the window; when that is
 * already past `now`, every slot is older than the cap, so the original (and
 * certainly-too-late) due time is returned.
 */
export function latestMissedSlot(task: ScheduledTask, now: number, capMs?: number): number {
  if (task.kind === "interval" && task.intervalMs) {
    const slots = Math.floor((now - task.nextRunAt) / task.intervalMs) + 1;
    return task.nextRunAt + (slots - 1) * task.intervalMs;
  }
  let slot = task.nextRunAt;
  if (capMs !== undefined && Number.isFinite(capMs)) {
    const floor = now - Math.max(0, capMs);
    const bounded = advanceSchedule(task, floor, floor);
    if (bounded === undefined) return slot;
    if (bounded > now) return slot;
    if (bounded > slot) slot = bounded;
  }
  // daily and cron: step forward. Bounded, because a task left for a year must
  // not spin here. When the walk starts at the cap floor it can always reach
  // `now` within one step per minute of the window (cron's granularity is a
  // minute), so the bound scales with the cap; uncapped, 1000 steps is still
  // days of daily slots and hours of a minute-granularity cron.
  const steps = capMs !== undefined && Number.isFinite(capMs)
    ? Math.ceil(Math.max(0, capMs) / 60_000) + 2
    : 1_000;
  for (let step = 0; step < steps; step += 1) {
    const next = advanceSchedule(task, slot, slot);
    if (next === undefined || next > now) break;
    slot = next;
  }
  return slot;
}

/** Everything a late fire needs to describe itself. */
export function lateFire(
  task: ScheduledTask,
  now: number,
  { capMs, cause = "closed" }: { capMs?: number; cause?: LateFire["cause"] } = {},
): LateFire {
  const dueAt = latestMissedSlot(task, now, capMs);
  // A one-shot has exactly one run, so its count is always arithmetic; daily
  // and cron would each need a calendar walk, and say "one or more" instead.
  const missed = task.kind === "once"
    ? 1
    : task.kind === "interval" && task.intervalMs
      ? Math.floor((now - task.nextRunAt) / task.intervalMs) + 1
      : undefined;
  return { dueAt, missed, lateMs: now - dueAt, cause };
}

/**
 * What a restore should do with the tasks it found, as data.
 *
 * Pure, so the policy is testable without a clock or a session. With
 * `catchUp` off it is exactly `normalizeTasksForResume`, which is what tree
 * navigation and `/loop resume` still want: neither may fire anything.
 *
 * With `catchUp` on, a fire missed while pi was not running is delivered once:
 * a one-shot is left for the caller to keep (unarmed) until it is delivered, and
 * a recurring task is re-armed to its next future slot so its phase survives.
 * Fires older than the window, and everything past `MAX_CATCHUPS`, are skipped
 * with a visible reason — the overflow oldest-first, because five model turns
 * is already a lot to come back to.
 */
export function planRestore(
  tasks: ScheduledTask[],
  now = Date.now(),
  { catchUp = false, misfireMs }: RestoreOptions = {},
): RestorePlan {
  if (!catchUp) {
    const normalized = normalizeTasksForResume(tasks, now);
    return { tasks: normalized.tasks, catchUps: [], skipped: [], changed: normalized.changed };
  }

  const kept: ScheduledTask[] = [];
  const skipped: SkippedFire[] = [];
  const due: Array<{ task: ScheduledTask; late: LateFire }> = [];
  let changed = false;

  for (const task of tasks) {
    if (task.paused || task.nextRunAt > now) {
      kept.push(task);
      continue;
    }

    const capMs = misfireMs ?? taskMisfireMs(task);
    const late = lateFire(task, now, { capMs, cause: "closed" });
    // A recurring task is re-armed whether or not its missed fire is delivered:
    // losing the fire is a lost reminder, losing the loop is a lost timer.
    let rearmed: ScheduledTask | undefined;
    if (task.kind !== "once") {
      rearmed = rearmRecurringTask(task, now);
      if (rearmed) kept.push(rearmed);
    }

    if (late.lateMs > capMs) {
      // Dropped: a one-shot leaves the list, a recurring task kept its re-arm.
      changed = true;
      skipped.push({
        id: task.id,
        dueAt: late.dueAt,
        lateMs: late.lateMs,
        reason: "late",
        ...(rearmed ? { nextRunAt: rearmed.nextRunAt } : {}),
      });
      continue;
    }
    // A catch-up one-shot stays in the list until drainPending persists its
    // removal before the send, so its restore alone changes nothing.
    if (task.kind !== "once") changed = true;
    due.push({ task, late });
  }

  due.sort((left, right) => left.late.dueAt - right.late.dueAt);
  const catchUps = due.slice(0, MAX_CATCHUPS);
  for (const extra of due.slice(MAX_CATCHUPS)) {
    const keptTask = kept.find((candidate) => candidate.id === extra.task.id);
    // An overflowed fire is lost either way: the one-shot leaves the list, and
    // a recurring task keeps only its re-arm.
    changed = true;
    skipped.push({
      id: extra.task.id,
      dueAt: extra.late.dueAt,
      lateMs: extra.late.lateMs,
      reason: "overflow",
      ...(keptTask ? { nextRunAt: keptTask.nextRunAt } : {}),
    });
  }

  return { tasks: kept, catchUps, skipped, changed };
}

const KINDS: ScheduleKind[] = ["interval", "daily", "once", "cron"];

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<ScheduledTask>;
  if (
    typeof task.id !== "string" ||
    !KINDS.includes(task.kind as ScheduleKind) ||
    typeof task.prompt !== "string" ||
    !task.prompt.trim() ||
    typeof task.createdAt !== "number" ||
    typeof task.nextRunAt !== "number"
  ) {
    return false;
  }
  if (task.wake !== undefined && task.wake !== "crash" && task.wake !== "always") return false;
  // Same rule as the durable registry: skip | always | a non-negative window.
  if (task.misfire !== undefined && task.misfire !== "skip" && task.misfire !== "always"
    && (typeof task.misfire !== "number" || !Number.isFinite(task.misfire) || task.misfire < 0)) {
    return false;
  }
  if (task.kind === "interval") {
    return typeof task.intervalMs === "number" && task.intervalMs >= MIN_INTERVAL_MS;
  }
  if (task.kind === "daily") return typeof task.dailyAt === "string" && parseClock(task.dailyAt) !== undefined;
  if (task.kind === "cron") return typeof task.cronExpr === "string" && parseCron(task.cronExpr) !== undefined;
  return true;
}

/**
 * The wake level as words, for `list` and the notices: absent, `wake`, or
 * `wake always`.
 */
export function wakeText(task: ScheduledTask): string | undefined {
  if (task.wake === "always") return "wake always";
  if (task.wake === "crash") return "wake";
  return undefined;
}

/** How late this task's missed fires may still be delivered, in words. */
export function misfireText(task: ScheduledTask): string {
  const ms = taskMisfireMs(task);
  if (ms === 0) return "not caught up at all";
  if (!Number.isFinite(ms)) return "caught up however late";
  return `caught up within ${formatDuration(ms)}`;
}

/**
 * The newest snapshot for this session, or nothing.
 *
 * Deliberately not "the newest *valid* snapshot": falling back to an older one
 * would resurrect timers the user has since cancelled. A snapshot that is
 * present but unusable means no timers, which is the same thing a fresh
 * session gets and is the only safe reading of it. Only a well-formed snapshot
 * that names a *different* session is skipped over — that one genuinely is not
 * ours, and a fork should keep looking past it.
 */
function readSnapshot(ctx: ExtensionContext): ScheduledTask[] {
  const sessionId = ctx.sessionManager.getSessionId();
  const branch = ctx.sessionManager.getBranch();
  // A warning nobody reads is not a warning. In a TUI the only place the user
  // will actually see "your timers did not come back" is a notice.
  const warn = (message: string) => {
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.emitWarning(message);
  };

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE) continue;

    // Note `typeof null === "object"`, which is why null is excluded by hand.
    if (entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) {
      warn(`Ignoring a corrupt scheduler snapshot; no timers were restored in ${sessionId}`);
      return [];
    }
    const snapshot = entry.data as Partial<SchedulerSnapshot>;
    if (typeof snapshot.sessionId !== "string") {
      warn(`Ignoring a scheduler snapshot with no session id; no timers were restored`);
      return [];
    }
    // A snapshot that plainly belongs to another session is not ours to
    // restore, and not evidence of corruption either; keep looking.
    if (snapshot.sessionId !== sessionId) continue;

    if (snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.tasks)) {
      warn(`Ignoring an unreadable scheduler snapshot; no timers were restored in ${sessionId}`);
      return [];
    }
    const valid = snapshot.tasks.filter(isScheduledTask);
    if (valid.length !== snapshot.tasks.length) {
      warn(`Dropped ${snapshot.tasks.length - valid.length} malformed session timer(s) while restoring`);
    }
    return valid.map((task) => ({ ...task }));
  }

  return [];
}

function sessionHasAssistantMessage(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => {
    const candidate = entry as { type?: unknown; message?: { role?: unknown } };
    return candidate.type === "message" && candidate.message?.role === "assistant";
  });
}

function formatTask(task: ScheduledTask): string {
  const when = new Date(task.nextRunAt).toLocaleString();
  const wake = wakeText(task);
  const extras = wake ? ` · ${wake}` : "";
  if (task.kind === "once") {
    return `${task.id} · once ${task.paused ? `paused, was ${when}` : when}${extras} · ${task.prompt}`;
  }
  const next = task.paused ? "paused" : `next ${when}`;
  return `${task.id} · ${describeSchedule(task)} · ${next}${extras} · ${task.prompt}`;
}

/** What the agent sees: relative times, since it may not know the clock. */
export function formatTaskForAgent(task: ScheduledTask, now = Date.now()): string {
  const at = new Date(task.nextRunAt).toLocaleString();
  const when = task.paused
    ? `paused (was due ${at})`
    // Rounded up to the second, so 15m reads as 15m and not 14m59s.
    : `next in ${formatDuration(Math.ceil((task.nextRunAt - now) / 1000) * 1000)} (${at})`;
  const kind = task.kind === "once" ? "once" : describeSchedule(task);
  const by = task.source === "agent" ? "agent" : "user";
  const wake = wakeText(task);
  // Quoted (JSON-escaped), so the tool's own sentence after it never runs
  // into the prompt's punctuation ("…done.. It fires…").
  return `${task.id} · ${kind} · ${when}${wake ? ` · ${wake}` : ""} · set by ${by} · ${JSON.stringify(task.prompt)}`;
}

/** How a late fire describes itself in words: "2h late (3 missed runs)". */
export function lateText(late: LateFire): string {
  const missed = late.missed === undefined
    ? "one or more runs missed"
    : `${late.missed} missed run${late.missed === 1 ? "" : "s"}`;
  return `${formatDuration(late.lateMs)} late (${missed})`;
}

/**
 * The text a fire sends. A timer the agent set itself comes back as a user
 * message, so say whose it is; otherwise the model reads its own reminder as
 * a fresh request from the user.
 *
 * A late fire says when it was due and how late it is, on the same line as the
 * agent label: the model's first question about a "check the backup" message
 * that arrives at noon is when it was supposed to arrive, and a second header
 * line would only make the message longer.
 */
export function deliveryText(task: ScheduledTask, late?: LateFire): string {
  const when = late ? new Date(late.dueAt).toLocaleString() : "";
  const because = late
    ? late.cause === "asleep"
      ? ` because the computer was asleep`
      : ` because this session was not open`
    : "";
  if (task.source !== "agent") {
    return late
      ? `[Scheduled task ${task.id} was due at ${when}, ${lateText(late)}${because}]\n${task.prompt}`
      : task.prompt;
  }
  const kind = task.kind === "once" ? "one-shot" : `recurring, ${describeSchedule(task)}`;
  const lateNote = late ? `; it was due at ${when} and is ${lateText(late)}${because}` : "";
  return `[Scheduled task ${task.id} (${kind}) that you set with the ${TOOL_NAME} tool fired${lateNote}]\n${task.prompt}`;
}

/**
 * The optional flags a timer can carry, and whatever text is left once they are
 * stripped out.
 *
 * They are only recognized as a whole-token *run* in one of the positions a
 * flag actually belongs in — leading, right after the time, or trailing (and,
 * for the edit form, after its id or time). Anywhere else `--wake` is part of
 * the prompt: `/once 1h explain the --no-wake flag` is a prompt about the flag,
 * not a flag on the timer. `--wake` and `--no-wake` stand alone, `--wake=` and
 * `--misfire=` take a value. The rest of the line is left byte-for-byte alone
 * (no re-joining), so a multi-line prompt survives.
 */
export interface TimerFlags {
  wake?: WakeLevel;
  /** `--no-wake`: clear the level rather than leave it as it was. */
  clearWake?: boolean;
  misfire?: MisfirePolicy;
  rest: string;
}

/** A whitespace-delimited token and where it sits in the line. */
interface TimerToken {
  text: string;
  start: number;
  end: number;
}

function timerTokens(input: string): TimerToken[] {
  return [...input.matchAll(/\S+/g)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function isFlagToken(text: string): boolean {
  return /^--[a-z][a-z-]*(?:=\S*)?$/i.test(text);
}

/** Whether this token parses as a time or a duration (so flags may follow it). */
function isTimeToken(text: string | undefined): boolean {
  if (text === undefined) return false;
  return parseOnceTime(text) !== undefined || parseDuration(text) !== undefined;
}

/** The index where a flag run may start right after the command's time argument. */
function afterTimeIndex(tokens: TimerToken[]): number | undefined {
  const first = tokens[0]?.text;
  const second = tokens[1]?.text;
  // `/once at 8p …` and `/once in 15m …` take the time as their second token.
  if (first !== undefined && /^(at|in)$/i.test(first) && isTimeToken(second)) return 2;
  if (isTimeToken(first)) return 1;
  return undefined;
}

export function parseTimerFlags(input: string): TimerFlags {
  const tokens = timerTokens(input);
  const consumed = new Set<number>();

  /** Consume the run of flags starting at `start`, walking in `step` direction. */
  const takeRun = (start: number, step: 1 | -1) => {
    for (let index = start; index >= 0 && index < tokens.length; index += step) {
      const token = tokens[index]?.text;
      if (token === undefined || !isFlagToken(token)) break;
      // An unknown flag is prompt text; stopping here keeps the flags after it
      // in the prompt too, rather than half-consuming a phrase.
      if (!/^--(wake|no-wake|misfire)(=|$)/i.test(token)) break;
      consumed.add(index);
    }
  };

  takeRun(0, 1);
  const afterTime = afterTimeIndex(tokens);
  if (afterTime !== undefined) takeRun(afterTime, 1);
  // The edit verbs put the id (and its time) before any flags.
  if (/^edit$/i.test(tokens[0]?.text ?? "")) {
    takeRun(2, 1);
    if (isTimeToken(tokens[2]?.text)) takeRun(3, 1);
  }
  takeRun(tokens.length - 1, -1);

  const flags: TimerFlags = { rest: input };
  let rest = "";
  let cursor = 0;
  for (const index of [...consumed].sort((left, right) => left - right)) {
    const token = tokens[index];
    if (!token) continue;
    // Drop the token and the whitespace that joined it to the text before it,
    // so removing a flag never leaves a double space behind.
    let start = token.start;
    while (start > cursor && /\s/.test(input[start - 1] ?? "")) start -= 1;
    let end = token.end;
    if (start === cursor) {
      // A leading flag: take the whitespace that followed it instead.
      while (end < input.length && /\s/.test(input[end] ?? "")) end += 1;
    }
    rest += input.slice(cursor, start);
    cursor = end;
    const [name, ...valueParts] = token.text.toLowerCase().split("=");
    const value = valueParts.join("=");
    switch (name) {
      case "--wake":
        if (value === "always") flags.wake = "always";
        else if (value === "crash" || value === "") flags.wake = "crash";
        else throw new Error(`--wake wants nothing (a crash counts) or =always, not "${value}"`);
        flags.clearWake = false;
        break;
      case "--no-wake":
        flags.wake = undefined;
        flags.clearWake = true;
        break;
      case "--misfire": {
        const parsed = value === "skip" || value === "always" ? value : parseDuration(value);
        if (parsed === undefined) {
          throw new Error("--misfire needs a value: use --misfire=6h, with skip, always or a duration such as 6h");
        }
        flags.misfire = parsed;
        break;
      }
      default:
        break;
    }
  }
  rest += input.slice(cursor);
  flags.rest = rest.trim();
  return flags;
}

/** The task fields a set of flags contributes (absent when the flag was not given). */
export function timerExtras(flags: TimerFlags | undefined): { wake?: WakeLevel; misfire?: MisfirePolicy } {
  if (!flags) return {};
  return {
    ...(flags.wake ? { wake: flags.wake } : {}),
    ...(flags.misfire !== undefined ? { misfire: flags.misfire } : {}),
  };
}

function makeTaskId(existing: ScheduledTask[]): string {
  const used = new Set(existing.map((task) => task.id));
  let id: string;
  do {
    id = randomBytes(4).toString("hex");
  } while (used.has(id));
  return id;
}

/**
 * Session-scoped timers: `/once` and `/loop`.
 *
 * These live and die with the pi process and the conversation that created
 * them — they fire into the current session, using its model and context. A
 * fire while the agent is busy is queued and delivered when it goes idle; a
 * fire missed while pi was not running is caught up once on the next real
 * resume (up to the misfire window), and one older than that is dropped with a
 * notice rather than replayed. Anything that must run whether or not pi is
 * open belongs to `/schedule` (durable-scheduler.ts).
 */
export default function sessionScheduler(pi: ExtensionAPI): void {
  let tasks: ScheduledTask[] = [];
  let activeCtx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let generation = 0;
  let deliveryInFlight = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Fires waiting for the agent to be idle, in the order they should be delivered. */
  const pending = new Map<string, QueuedFire>();
  /** When this process opened the current session, for the index. */
  let liveSince = Date.now();
  /** ps lstart for our own pid, looked up once; it cannot change while we run. */
  let pidStart: string | undefined;
  /** The session file this process has indexed, so a late-flushed one is retried. */
  let indexedFile: string | undefined;
  let indexWarned = false;

  const notice = (ctx: ExtensionContext, message: string, level: NoticeLevel = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else process.stderr.write(`${message}\n`);
  };

  // Every change passes through persist or updateStatus: tell listeners
  // (canvas.ts) the same way bg.ts does with `bg:jobs`. Unchanged views are
  // not re-sent.
  let lastEmitted: string | undefined;
  const emitTasks = () => {
    const views = taskViews(tasks);
    const key = JSON.stringify(views);
    if (key === lastEmitted) return;
    lastEmitted = key;
    pi.events?.emit?.(TASKS_EVENT, views);
  };

  const updateStatus = (ctx = activeCtx) => {
    emitTasks();
    if (!ctx?.hasUI) return;
    const active = new Set([
      ...tasks.filter((task) => !task.paused).map((task) => task.id),
      ...pending.keys(),
    ]).size;
    const paused = tasks.filter((task) => task.paused).length;
    ctx.ui.setStatus("session-scheduler", timerStatusText(active, paused));
  };

  const persist = () => {
    emitTasks();
    if (!sessionId) return;
    pi.appendEntry(SNAPSHOT_TYPE, {
      version: SNAPSHOT_VERSION,
      sessionId,
      tasks: tasks.map((task) => ({ ...task })),
    } satisfies SchedulerSnapshot);
    writeIndex(activeCtx);
  };

  // ── the due index ──
  //
  // Written after every persist and on shutdown, so an outside process (the
  // tick that may wake a session) can see that this session has timers and
  // when the earliest is due. Metadata only: no prompt ever goes in here.

  const sessionFilePath = (ctx: ExtensionContext | undefined): string | undefined => {
    try {
      return ctx?.sessionManager.getSessionFile();
    } catch {
      return undefined;
    }
  };

  /** The timers that still count as armed: unpaused, plus fires already queued. */
  const armedTasks = (): ScheduledTask[] => {
    const armed = tasks.filter((task) => !task.paused).map((task) => ({ ...task }));
    for (const [id, fire] of pending) {
      if (fire.task.paused) continue;
      const existing = armed.find((task) => task.id === id);
      if (existing) existing.nextRunAt = Math.min(existing.nextRunAt, fire.task.nextRunAt);
      else armed.push({ ...fire.task });
    }
    return armed;
  };

  const writeIndex = (
    ctx: ExtensionContext | undefined,
    { closed = false, owner }: { closed?: boolean; owner?: IndexOwner } = {},
  ) => {
    if (!sessionId) return;
    const target = ctx ?? activeCtx;
    const file = sessionFilePath(target);
    // pi writes a session file only once the session holds a reply, and
    // --no-session never writes one. Indexing either would point an outside
    // process at a file that is not there; the first agent_settled retries.
    if (!file || !existsSync(file)) return;

    // `count` is the unpaused tasks, as the README says: a queued fire may move
    // nextDueAt earlier (it is due now) but is never a timer of its own.
    const unpaused = tasks.filter((task) => !task.paused);
    const armed = armedTasks();
    const wakeTasks = armed.filter((task) => task.wake !== undefined);
    const wake: WakeLevel | undefined = wakeTasks.some((task) => task.wake === "always")
      ? "always"
      : wakeTasks.length > 0 ? "crash" : undefined;
    const entry = planIndexEntry({
      sessionFile: file,
      cwd: target?.cwd ?? process.cwd(),
      liveSince,
      count: unpaused.length,
      pid: process.pid,
      // ps lstart cannot change while we run, so it is looked up once per process.
      pidStart: pidStart ??= processStart(process.pid),
      ...(closed ? { closedAt: Date.now() } : {}),
      ...(armed.length > 0 ? { nextDueAt: Math.min(...armed.map((task) => task.nextRunAt)) } : {}),
      ...(wakeTasks.length > 0 ? { nextWakeDueAt: Math.min(...wakeTasks.map((task) => task.nextRunAt)) } : {}),
      ...(wake ? { wake } : {}),
    });

    const { error } = updateSessionIndex(sessionId, entry, {
      owner: owner ?? (closed ? "release" : "claim"),
    });
    if (error && !indexWarned) {
      // Once, not once per persist: a broken index is a housekeeping problem
      // and repeating it would bury every real notice. Never thrown, because
      // this runs inside persist() and inside timer callbacks.
      indexWarned = true;
      if (target) notice(target, `Could not update the session-timer index: ${error}`, "warning");
    }
    // Recorded only on success, so a failed update is retried on the next
    // agent_settled rather than considered done.
    if (!error) indexedFile = file;
  };

  const clearRuntime = () => {
    generation += 1;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
    deliveryInFlight = false;
  };

  const drainPending = () => {
    const ctx = activeCtx;
    if (!ctx || deliveryInFlight || !ctx.isIdle()) return;
    const next = pending.entries().next().value as [string, QueuedFire] | undefined;
    if (!next) return;

    const [id, fire] = next;
    const { task, late } = fire;
    pending.delete(id);
    deliveryInFlight = true;
    updateStatus(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(
        late
          ? `Scheduled task ${task.id} was due at ${new Date(late.dueAt).toLocaleString()} and is ${lateText(late)}; delivering it now`
          : `Scheduled task ${task.id} fired`,
        late ? "warning" : "info",
      );
    }

    // A one-shot is removed and persisted BEFORE the send, live or catch-up
    // alike: at-most-once means the snapshot has to say "delivered" before the
    // model can see the prompt. A failed send puts it back below.
    const oneShot = task.kind === "once";
    if (oneShot) {
      const before = tasks;
      tasks = tasks.filter((candidate) => candidate.id !== task.id);
      try {
        persist();
      } catch (error) {
        // Not delivered, so not removed: a snapshot that dropped it here would
        // lose the reminder from both the session and the queue.
        tasks = before;
        deliveryInFlight = false;
        pending.set(id, fire);
        notice(ctx, `Could not record scheduled task ${id} as delivered, so it was not sent: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return;
      }
      // No longer queued and no longer listed: the chip counts neither.
      updateStatus(ctx);
    }

    try {
      pi.sendUserMessage(deliveryText(task, late));
    } catch (error) {
      deliveryInFlight = false;
      pending.set(id, fire);
      if (oneShot) {
        // The removal was already persisted, so the snapshot has to learn about
        // the failure too or the reminder is gone from both places.
        tasks = [...tasks, task];
        try {
          persist();
        } catch {
          // Nothing more to do; the notice below still tells the user.
        }
      }
      notice(ctx, `Could not deliver scheduled task ${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
  };

  /** One line per fire the restore refused, so a lost reminder is never silent. */
  const describeSkipped = (fire: SkippedFire): string => {
    const when = new Date(fire.dueAt).toLocaleString();
    const late = formatDuration(fire.lateMs);
    const next = fire.nextRunAt !== undefined ? `; next ${new Date(fire.nextRunAt).toLocaleString()}` : "; dropped";
    return fire.reason === "overflow"
      ? `Skipped ${fire.id}: its ${when} fire was ${late} late and only ${MAX_CATCHUPS} missed timers are caught up at a time${next}`
      : `Skipped ${fire.id}: its ${when} fire was ${late} late, past its catch-up limit${next}`;
  };

  const armTask = (task: ScheduledTask, ctx: ExtensionContext, runtimeGeneration: number) => {
    const existing = timers.get(task.id);
    if (existing) clearTimeout(existing);

    const delay = Math.max(0, task.nextRunAt - Date.now());
    const timer = setTimeout(() => {
      timers.delete(task.id);
      if (runtimeGeneration !== generation) return;

      const index = tasks.findIndex((candidate) => candidate.id === task.id);
      if (index < 0) return;
      const current = tasks[index];
      if (!current) return;
      const now = Date.now();
      if (current.nextRunAt > now) {
        // A chunk expired, not the timer: re-arm, after re-reading the clock.
        armTask(current, ctx, runtimeGeneration);
        return;
      }

      // Longer than any scheduler hiccup: the machine slept, and libuv's clock
      // stopped with it. Treat it as a missed fire (prefix, and subject to the
      // same staleness cap) rather than an on-time one. The prefix says
      // "asleep", not "not open": pi was open the whole time.
      const capMs = taskMisfireMs(current);
      const late = now - current.nextRunAt > LIVE_LATE_MS ? lateFire(current, now, { capMs, cause: "asleep" }) : undefined;
      if (late && late.lateMs > capMs) {
        if (current.kind !== "once") {
          const rearmed = rearmRecurringTask(current, now);
          if (rearmed) {
            tasks[index] = rearmed;
            armTask(rearmed, ctx, runtimeGeneration);
          } else {
            tasks.splice(index, 1);
          }
        } else {
          tasks.splice(index, 1);
        }
        persist();
        updateStatus(ctx);
        notice(
          ctx,
          `Skipped ${current.id}: its ${new Date(late.dueAt).toLocaleString()} fire was ${lateText(late)}, past its catch-up limit`,
          "warning",
        );
        return;
      }

      if (!pending.has(current.id)) {
        pending.set(current.id, { task: { ...current }, ...(late ? { late } : {}) });
      }
      if (current.kind !== "once") {
        const rearmed = rearmRecurringTask(current, now);
        if (rearmed) {
          tasks[index] = rearmed;
          armTask(rearmed, ctx, runtimeGeneration);
        } else {
          tasks.splice(index, 1);
        }
      }
      persist();
      updateStatus(ctx);
      drainPending();
    }, Math.min(delay, TIMER_CHUNK_MS));
    timer.unref?.();
    timers.set(task.id, timer);
  };

  /**
   * Rebuild the runtime from the session's snapshot.
   *
   * `catchUp` is only true for a real restore — `session_start` with reason
   * startup, resume or reload. Tree navigation and pause-resume go through
   * planRestore without it, because neither may fire anything: an older branch
   * can hold a slot that already fired, and `/loop resume` promises to skip
   * what was missed. `opened` is only true for `session_start`: moving between
   * branches does not reopen the session, so it must not move `liveSince`.
   */
  const restoreRuntime = (ctx: ExtensionContext, { catchUp = false, opened = false } = {}) => {
    clearRuntime();
    activeCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    if (opened) liveSince = Date.now();
    const raw = readSnapshot(ctx);

    // Print mode (`pi -p --session`): a fire would inject a message into an
    // unattended answer, and there is nobody to see a notice. Leave the
    // snapshot exactly as it is — no catch-up, no drop, no persist — and only
    // publish the index, so the tick can still see these timers. Nothing is
    // armed: an overdue timer here would fire immediately and be a catch-up
    // by another name.
    if (!ctx.hasUI) {
      tasks = raw;
      writeIndex(ctx, { owner: "passive" });
      return;
    }

    // Two pi processes on one session (the same file resumed in a second
    // terminal) would each catch up the same missed timers. The index says
    // whether another live one holds it; if it does, leave the session to that
    // one: restore the list, but arm nothing, catch nothing up and persist
    // nothing, so this pi cannot advance or drop the holder's timers either.
    const holder = sessionId === undefined ? undefined : sessionHolder(sessionId);
    if (holder !== undefined) {
      tasks = raw;
      notice(
        ctx,
        `Timers are held by pi pid ${holder}; this session will not fire or catch them up here.`,
        "warning",
      );
      writeIndex(ctx, { owner: "passive" });
      updateStatus(ctx);
      return;
    }

    const plan = planRestore(raw, Date.now(), { catchUp });
    const runtimeGeneration = generation;
    // A catch-up one-shot stays in the list, unarmed, until drainPending has
    // persisted its removal and sent it: quitting, crashing or reloading before
    // then leaves it in the snapshot, so the next resume retries it.
    const catchUpOneShots = plan.catchUps
      .filter((fire) => fire.task.kind === "once")
      .map((fire) => fire.task);
    tasks = [...plan.tasks, ...catchUpOneShots];
    for (const { task, late } of plan.catchUps) pending.set(task.id, { task, late });
    for (const task of tasks) {
      if (!task.paused && !pending.has(task.id)) armTask(task, ctx, runtimeGeneration);
    }
    // A recurring catch-up is re-armed here, so its snapshot has to say so.
    // A one-shot's removal is persisted by drainPending, just before the send.
    if (plan.changed) persist();
    for (const fire of plan.skipped) notice(ctx, describeSkipped(fire), "warning");
    updateStatus(ctx);
    writeIndex(ctx);
    if (pending.size > 0) {
      // After session_start returns, not during it: pi is still wiring the
      // session up when this handler runs.
      const drain = setTimeout(() => {
        if (runtimeGeneration !== generation) return;
        drainPending();
      }, 0);
      drain.unref?.();
    }
  };

  const addTask = (ctx: ExtensionContext, task: Omit<ScheduledTask, "id" | "createdAt">) => {
    if (tasks.length >= MAX_TASKS) throw new Error(`This session already has ${MAX_TASKS} scheduled tasks`);
    const complete: ScheduledTask = {
      ...task,
      id: makeTaskId(tasks),
      createdAt: Date.now(),
    };
    tasks.push(complete);
    persist();
    if (!complete.paused) armTask(complete, ctx, generation);
    updateStatus(ctx);
    if (!sessionHasAssistantMessage(ctx)) {
      notice(
        ctx,
        "This session has no model reply yet, so pi has not written it to disk. The schedule is held in memory and saves with the first reply — quit before that and it is lost.",
        "warning",
      );
    }
    return complete;
  };

  const addInterval = (
    ctx: ExtensionContext,
    durationText: string,
    promptText: string,
    source?: ScheduledTask["source"],
    flags?: TimerFlags,
  ) => {
    const intervalMs = parseDuration(durationText);
    if (intervalMs === undefined || intervalMs < MIN_INTERVAL_MS) {
      throw new Error("Recurring intervals must be at least 1m (examples: 5m, 1h, 1h30m)");
    }
    const prompt = stripPromptDelimiter(promptText);
    if (!prompt) throw new Error("A prompt is required");
    return addTask(ctx, {
      kind: "interval",
      prompt,
      intervalMs,
      nextRunAt: Date.now() + intervalMs,
      ...(source ? { source } : {}),
      ...timerExtras(flags),
    });
  };

  const addOnce = (
    ctx: ExtensionContext,
    nextRunAt: number,
    prompt: string,
    source?: ScheduledTask["source"],
    flags?: TimerFlags,
  ) => {
    const task = addTask(ctx, {
      kind: "once",
      prompt,
      nextRunAt,
      ...(source ? { source } : {}),
      ...timerExtras(flags),
    });
    const wake = wakeText(task);
    notice(
      ctx,
      `Scheduled ${task.id} once at ${new Date(task.nextRunAt).toLocaleString()}`
      + ` (in ${formatDuration(task.nextRunAt - Date.now())});`
      + ` it fires while this session is open, or on the next resume if not more than ${formatDuration(taskMisfireMs(task))} late.`
      + (wake ? ` ${wake}: kept for the reopen tick.` : ""),
    );
    return task;
  };

  const findTask = (idPrefix: string) => {
    const matches = tasks.filter((task) => task.id.startsWith(idPrefix));
    if (matches.length === 0) throw new Error(`No session task matches ${idPrefix}`);
    if (matches.length > 1) throw new Error(`Task prefix ${idPrefix} is ambiguous`);
    const task = matches[0];
    if (!task) throw new Error(`No session task matches ${idPrefix}`);
    return task;
  };

  const disarm = (id: string) => {
    pending.delete(id);
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };

  const removeTask = (ctx: ExtensionContext, idPrefix: string) => {
    const task = findTask(idPrefix);
    tasks = tasks.filter((candidate) => candidate.id !== task.id);
    disarm(task.id);
    persist();
    updateStatus(ctx);
    return task;
  };

  /**
   * The same timer with a new time and prompt: its id and paused state stay, and so does its
   * place in the list. An interval restarts from now; a one-shot moves to `when`. Whoever set it,
   * the prompt is now the user's, so it no longer fires as the agent's own reminder. A fire still
   * queued behind a busy turn is dropped with the old prompt.
   */
  const editTask = (
    ctx: ExtensionContext,
    idPrefix: string,
    kind: "interval" | "once",
    when: number,
    promptText: string,
    flags?: TimerFlags,
  ) => {
    const task = findTask(idPrefix);
    if (task.kind !== kind) {
      throw new Error(
        task.kind === "once"
          ? `${task.id} is a one-shot; change it with /once edit`
          : kind === "once"
            ? `${task.id} repeats; change it with /loop edit`
            : `${task.id} runs ${describeSchedule(task)}; only an interval timer takes /loop edit`,
      );
    }
    if (kind === "interval" && when < MIN_INTERVAL_MS) {
      throw new Error("Recurring intervals must be at least 1m (examples: 5m, 1h, 1h30m)");
    }
    const prompt = stripPromptDelimiter(promptText);
    if (!prompt) throw new Error("A prompt is required");

    const { source: _source, ...kept } = task;
    const updated: ScheduledTask = kind === "interval"
      ? { ...kept, prompt, intervalMs: when, nextRunAt: Date.now() + when }
      : { ...kept, prompt, nextRunAt: when };
    // `kept` already carries wake and misfire; these only ever override them.
    if (flags?.wake) updated.wake = flags.wake;
    if (flags?.clearWake) delete updated.wake;
    if (flags?.misfire !== undefined) updated.misfire = flags.misfire;
    tasks = tasks.map((candidate) => (candidate.id === task.id ? updated : candidate));
    disarm(task.id);
    persist();
    if (!updated.paused) armTask(updated, ctx, generation);
    updateStatus(ctx);
    return updated;
  };

  const setPaused = (ctx: ExtensionContext, target: string, paused: boolean) => {
    const all = /^(all|\*)$/i.test(target);
    const selected = all ? tasks.filter((task) => Boolean(task.paused) !== paused) : [findTask(target)];
    if (selected.length === 0) {
      return { changed: [] as ScheduledTask[], expired: [] as ScheduledTask[] };
    }

    const now = Date.now();
    const changed: ScheduledTask[] = [];
    const expired: ScheduledTask[] = [];

    for (const task of selected) {
      if (paused) {
        disarm(task.id);
        const updated = { ...task, paused: true };
        tasks = tasks.map((candidate) => (candidate.id === task.id ? updated : candidate));
        changed.push(updated);
        continue;
      }

      const revived = normalizeTasksForResume([{ ...task, paused: false }], now).tasks[0];
      if (!revived) {
        tasks = tasks.filter((candidate) => candidate.id !== task.id);
        expired.push(task);
        continue;
      }
      tasks = tasks.map((candidate) => (candidate.id === task.id ? revived : candidate));
      armTask(revived, ctx, generation);
      changed.push(revived);
    }

    persist();
    updateStatus(ctx);
    return { changed, expired };
  };

  const showUsage = (ctx: ExtensionContext) => {
    notice(
      ctx,
      [
        "Session timers (this session, plus one catch-up per missed fire):",
        "  /once <duration|HH:MM|ISO> [--wake[=always]] <prompt>",
        "  /once <prompt> in <duration>",
        "  /once list | cancel <id> | edit <id> <time> <prompt>",
        "  /loop <duration> [--wake[=always]] <prompt>",
        "  /loop <prompt> every <duration>",
        "  /loop list | cancel <id> | clear",
        "  /loop pause <id|all> | resume <id|all>",
        "  /loop edit <id> <duration> <prompt>",
        "  (:: before the prompt is optional)",
        "/once help or /loop help explains the forms in full.",
        "Use /schedule for tasks that must run without an open session.",
      ].join("\n"),
      "warning",
    );
  };

  const showHelp = (ctx: ExtensionContext) => {
    const misfire = formatDuration(sessionMisfireMs());
    notice(
      ctx,
      [
        "/once and /loop \u2014 timers that fire a prompt into this conversation.",
        "",
        "They live in this session: they need pi open to fire. A fire that came due",
        "while pi was closed is delivered once when you next resume the session, up",
        `to ${misfire} late; older ones are skipped with a notice. For work that must happen`,
        "whether or not you are here, use /schedule.",
        "",
        "/once \u2014 fire one time",
        "  /once 15m check whether the deploy finished",
        "  /once at 8p check in on this",
        "  /once remind me about the PR in 2h",
        "  The time may lead or trail. A leading time wins when it parses, so",
        "  '/once 8p check in on this' keeps the prompt's own 'in'.",
        "",
        "/loop \u2014 fire repeatedly (1m minimum)",
        "  /loop 15m check CI",
        "  /loop review the deploy every 1h",
        "",
        "TIMES   /once takes 30s 15m 2h 1d, or 9a 8p 15:30, or an ISO timestamp",
        "        /loop takes a duration only, 1m or longer",
        "",
        "OPTIONS (leading, after the time, or trailing \u2014 never inside the prompt)",
        "  --wake          mark it to be woken for after a crash (kept for the tick)",
        "  --wake=always   mark it to be woken for even after a deliberate quit",
        "  --no-wake       clear that mark",
        "  --misfire=X     how late a missed fire may still be delivered:",
        "                    skip     never catch up",
        "                    always   catch up however late",
        `                    <dur>    catch up within this window (default ${misfire},`,
        "                             or PI_SCHEDULER_SESSION_MISFIRE)",
        "",
        "MANAGING",
        "  /once list | cancel <id>              one-shots only",
        "  /loop list | cancel <id> | clear      every timer in this session",
        "  /loop pause <id|all> | resume <id|all>",
        "  /loop edit <id> <duration> <prompt>   new interval and prompt, same id",
        "  /once edit <id> <time> <prompt>       new time and prompt, same id",
        "  pause keeps a task but disarms it; resume moves to the next future slot",
        "  rather than firing for everything missed while it was paused.",
        "",
        "Timers restore when you resume this session, and are not inherited by /new,",
        "/fork or /clone. (:: before the prompt is optional.)",
      ].join("\n"),
      "info",
    );
  };

  /**
   * The management verbs, shared by /once and /loop.
   *
   * /loop gets them all; /once exposes only `list`, `cancel` and `edit`, since
   * the others describe a timer that will fire again and a one-shot will not.
   * Each `edit` changes only its own kind: /loop edit an interval, /once edit a
   * one-shot.
   */
  const handleManagement = async (
    input: string,
    ctx: ExtensionContext,
    { onlyOnce }: { onlyOnce: boolean },
    flags?: TimerFlags,
  ): Promise<boolean> => {
    if (/^(list|ls)$/i.test(input)) {
      const listed = onlyOnce ? tasks.filter((task) => task.kind === "once") : tasks;
      notice(
        ctx,
        listed.length > 0
          ? listed.map(formatTask).join("\n")
          : onlyOnce
            ? "No one-shot tasks in this session"
            : "No timers in this session",
      );
      return true;
    }

    const cancel = input.match(/^(?:cancel|delete|remove|stop)\s+(\S+)$/i);
    if (cancel?.[1]) {
      try {
        const task = removeTask(ctx, cancel[1]);
        notice(ctx, `Cancelled session task ${task.id}`);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    // Only when the time reads as one: a new timer whose prompt opens "edit the docs" stays one.
    const edit = input.match(/^edit\s+(\S+)\s+(\S+)\s+([\s\S]+)$/i);
    const editWhen = edit?.[2] ? (onlyOnce ? parseOnceTime(edit[2]) : parseDuration(edit[2])) : undefined;
    if (edit?.[1] && edit[3] && editWhen !== undefined) {
      try {
        const task = editTask(ctx, edit[1], onlyOnce ? "once" : "interval", editWhen, edit[3], flags);
        const next = new Date(task.nextRunAt).toLocaleString();
        const wake = wakeText(task);
        notice(
          ctx,
          task.paused
            ? `Edited ${task.id} (still paused)`
            : onlyOnce
              ? `Edited ${task.id}; once at ${next}${wake ? ` · ${wake}` : ""}`
              : `Edited ${task.id}; every ${formatDuration(task.intervalMs ?? 0)}, next ${next}${wake ? ` · ${wake}` : ""}`,
        );
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (onlyOnce) return false;

    const toggle = input.match(/^(pause|resume|unpause)\s+(\S+)$/i);
    if (toggle?.[1] && toggle[2]) {
      const paused = toggle[1].toLowerCase() === "pause";
      try {
        const { changed, expired } = setPaused(ctx, toggle[2], paused);
        const lines: string[] = [];
        if (changed.length > 0) {
          lines.push(
            paused
              ? `Paused ${changed.length} task(s): ${changed.map((task) => task.id).join(", ")}`
              : changed.map((task) => `Resumed ${task.id}; next ${new Date(task.nextRunAt).toLocaleString()}`).join("\n"),
          );
        }
        for (const task of expired) {
          lines.push(`Dropped ${task.id}: its one-shot time passed while paused`);
        }
        if (lines.length === 0) lines.push(paused ? "Nothing to pause" : "Nothing to resume");
        notice(ctx, lines.join("\n"), expired.length > 0 ? "warning" : "info");
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    const clear = input.match(/^clear(?:\s+(yes))?$/i);
    if (clear) {
      const confirmed = clear[1] === "yes"
        || (ctx.hasUI && await ctx.ui.confirm("Clear session timers?", `Cancel all ${tasks.length} task(s) in this session?`));
      if (!confirmed) {
        notice(ctx, ctx.hasUI ? "No timers changed" : "Use /loop clear yes in non-interactive mode", "warning");
        return true;
      }
      clearRuntime();
      tasks = [];
      persist();
      updateStatus(ctx);
      notice(ctx, "Cleared all session timers");
      return true;
    }

    return false;
  };

  /** Parse `--wake` / `--misfire` flags, reporting a bad value as a notice rather than a throw. */
  const readFlags = (
    ctx: ExtensionContext,
    input: string,
  ): { input: string | undefined; flags?: TimerFlags } => {
    try {
      const flags = parseTimerFlags(input);
      return { input: flags.rest, flags };
    } catch (error) {
      notice(ctx, error instanceof Error ? error.message : String(error), "error");
      return { input: undefined };
    }
  };

  pi.registerCommand("once", {
    description: "Run a prompt once later in this session, for example /once 15m check the build",
    handler: async (args, ctx) => {
      const { input, flags } = readFlags(ctx, args.trim());
      if (input === undefined) return;
      if (input === "help") {
        showHelp(ctx);
        return;
      }
      if (await handleManagement(input, ctx, { onlyOnce: true }, flags)) return;

      const parsed = parseOnceCommand(input);
      if (!parsed) {
        showUsage(ctx);
        return;
      }
      try {
        addOnce(ctx, parsed.nextRunAt, parsed.prompt, undefined, flags);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("loop", {
    description: "Repeat a prompt in this session, for example /loop 5m check the deploy",
    handler: async (args, ctx) => {
      const { input, flags } = readFlags(ctx, args.trim());
      if (input === undefined) return;
      if (input === "help") {
        showHelp(ctx);
        return;
      }
      if (!input) {
        showUsage(ctx);
        return;
      }
      if (await handleManagement(input, ctx, { onlyOnce: false }, flags)) return;

      const leading = input.match(/^(?:every\s+)?(\S+)\s+([\s\S]+)$/i);
      const trailing = input.match(/^([\s\S]+?)\s+every\s+(\S+)\s*$/i);
      const duration = trailing?.[2] ?? leading?.[1];
      const prompt = trailing?.[1] ?? leading?.[2];
      if (!duration || !prompt) {
        showUsage(ctx);
        return;
      }
      try {
        const task = addInterval(ctx, duration, prompt, undefined, flags);
        const wake = wakeText(task);
        notice(
          ctx,
          `Looping ${task.id} every ${formatDuration(task.intervalMs ?? 0)}; next ${new Date(task.nextRunAt).toLocaleString()}`
          + (wake ? ` · ${wake}` : ""),
        );
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  // ── schedule tool (opt-in) ──
  //
  // Off by default: the commands above stay out of model context, which is
  // the package's whole stance. Turning on "scheduler-tool" in boehsline.json
  // lets the agent set and manage the same timers. It is deferred unless the
  // settings say otherwise, so it costs nothing until tool_search loads it.
  const config = loadConfig();
  const toolOn = enabled(TOOL_OPT_IN, config);
  optIns().set(TOOL_OPT_IN, {
    name: TOOL_OPT_IN,
    description: "Let the agent set /once and /loop timers with a schedule tool",
    on: toolOn,
  });
  if (toolOn) {
    // `allowWake` is off by default: a timer that reopens a session runs an
    // unattended turn with full tools, and an agent should not be able to grant
    // itself that. The user's own --wake flags are always allowed.
    const { exposure, allowWake } = settingsFor(TOOL_OPT_IN, { exposure: "deferred", allowWake: false }, config);
    const direct = exposure === "direct";
    if (!direct) activateToolSearch(pi);

    /** A tool-set wake level, refused when the opt-in does not allow it. */
    const toolWake = (params: ToolParams): WakeLevel | undefined => {
      const value = params.wake;
      if (value === undefined || value === null) return undefined;
      if (!allowWake) {
        throw new Error(
          "This session's `schedule` tool is not allowed to set wake (it would reopen the session unattended)."
          + " Ask the user to set `\"scheduler-tool\": { \"allowWake\": true }` in boehsline.json, or set it themselves with /once --wake.",
        );
      }
      if (value === true) return "crash";
      if (value === "crash" || value === "always") return value;
      throw new Error(`wake wants "crash" or "always", not ${JSON.stringify(value)}`);
    };

    const toolMisfire = (params: ToolParams): MisfirePolicy | undefined => {
      const raw = params.misfire?.trim();
      if (!raw) return undefined;
      const parsed = raw === "skip" || raw === "always" ? raw : parseDuration(raw);
      if (parsed === undefined) throw new Error(`Could not read misfire "${raw}" as a policy; use skip, always or a duration such as 6h`);
      return parsed;
    };

    /** The flags a tool call carries, validated before anything is created. */
    const toolFlags = (params: ToolParams): TimerFlags => {
      const wake = toolWake(params);
      const misfire = toolMisfire(params);
      return { ...(wake ? { wake } : {}), ...(misfire !== undefined ? { misfire } : {}), rest: "" };
    };

    const runTool = (action: ToolAction, params: ToolParams, ctx: ExtensionContext) => {
      const need = (value: string | undefined, name: string) => {
        const trimmed = value?.trim();
        if (!trimmed) throw new Error(`${action} needs ${name}`);
        return trimmed;
      };
      switch (action) {
        case "once": {
          const when = need(params.when, "`when` (a duration like 15m, a clock time like 15:30 or 8p, or an ISO timestamp)");
          const prompt = need(params.prompt, "a `prompt`");
          const flags = toolFlags(params);
          const nextRunAt = parseOnceTime(when);
          if (nextRunAt === undefined) throw new Error(`Could not read "${when}" as a time; use 15m, 2h, 15:30, 8p or an ISO timestamp`);
          const task = addOnce(ctx, nextRunAt, prompt, "agent", flags);
          return {
            text: `Scheduled ${formatTaskForAgent(task)}.`
              + ` It fires while this session is open, or once on the next resume if it is not more than ${formatDuration(taskMisfireMs(task))} late.`,
            tasks: [task],
          };
        }
        case "loop": {
          const every = need(params.every, "`every` (a duration of 1m or more, like 15m)");
          const prompt = need(params.prompt, "a `prompt`");
          const task = addInterval(ctx, every, prompt, "agent", toolFlags(params));
          notice(ctx, `Agent set loop ${task.id} every ${formatDuration(task.intervalMs ?? 0)}: ${task.prompt}`);
          return { text: `Looping ${formatTaskForAgent(task)}. Cancel it with action "cancel" once it is no longer needed.`, tasks: [task] };
        }
        case "list":
          return {
            text: tasks.length > 0 ? tasks.map((task) => formatTaskForAgent(task)).join("\n") : "No timers in this session",
            tasks: tasks.map((task) => ({ ...task })),
          };
        case "cancel": {
          const task = removeTask(ctx, need(params.id, "an `id`"));
          notice(ctx, `Agent cancelled session task ${task.id}`);
          return { text: `Cancelled ${task.id}`, tasks: [task] };
        }
        case "pause":
        case "resume": {
          const paused = action === "pause";
          const { changed, expired } = setPaused(ctx, need(params.id, "an `id` (or \"all\")"), paused);
          const lines = changed.map((task) => `${paused ? "Paused" : "Resumed"} ${formatTaskForAgent(task)}`);
          for (const task of expired) lines.push(`Dropped ${task.id}: its one-shot time passed while paused`);
          if (lines.length === 0) lines.push(paused ? "Nothing to pause" : "Nothing to resume");
          if (changed.length > 0 || expired.length > 0) notice(ctx, `Agent: ${lines.join("; ")}`);
          return { text: lines.join("\n"), tasks: [...changed, ...expired] };
        }
      }
    };

    pi.registerTool({
      name: TOOL_NAME,
      label: "Schedule",
      exposure: direct ? "direct" : "deferred",
      executionMode: "sequential",
      description:
        "Set timers that send a prompt back into this conversation later, the same timers as the user's /once and /loop. " +
        "Use it to check back on something slow (a deploy, CI, a long build) instead of polling, or when the user asks to be reminded. " +
        "Actions: once (needs when + prompt), loop (needs every + prompt, 1m minimum), list, cancel (id), pause/resume (id or \"all\"). " +
        "Timers live in this session: they fire while pi is open, and a fire that came due while it was closed is delivered once when the user next resumes it (up to " + formatDuration(sessionMisfireMs()) + " late, or the task's misfire). " +
        "Set misfire to change how late a missed fire may still be delivered." +
        (allowWake
          ? " Set wake so the session is reopened for it: \"crash\" after an unexpected exit, \"always\" even after a deliberate quit."
          : "") +
        " When one fires, its prompt arrives as a message labelled as your scheduled task. Cancel loops you no longer need.",
      parameters: Type.Object({
        action: Type.Union(TOOL_ACTIONS.map((name) => Type.Literal(name))),
        prompt: Type.Optional(Type.String({ description: "once/loop: what to send into the conversation when it fires; write it as an instruction to yourself" })),
        when: Type.Optional(Type.String({ description: "once: 30s, 15m, 2h, 1d; or a clock time 15:30, 9a, 8p; or an ISO timestamp" })),
        every: Type.Optional(Type.String({ description: "loop: interval such as 5m, 1h, 1h30m (at least 1m)" })),
        id: Type.Optional(Type.String({ description: "cancel/pause/resume: task id or a unique prefix; pause/resume also take \"all\"" })),
        misfire: Type.Optional(Type.String({ description: `once/loop: how late a missed fire may still be delivered — skip, always, or a duration such as 6h (default ${formatDuration(sessionMisfireMs())})` })),
        // Only declared when the user turned it on: a parameter the agent can
        // see is a parameter it will try, and an unattended reopened turn with
        // full tools is not something a model should be able to grant itself.
        ...(allowWake
          ? { wake: Type.Optional(Type.Union([Type.Literal("crash"), Type.Literal("always"), Type.Literal(true)], { description: "once/loop: reopen this session to fire even if it is closed — \"crash\" (unexpected exit only) or \"always\" (even after the user quit); true means \"crash\"" })) }
          : {}),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!ctx.hasUI && params.action !== "list") {
          throw new Error("Session timers need an interactive session; this one ends when the run does, so a timer would never fire.");
        }
        const action = params.action as ToolAction;
        const result = runTool(action, params, ctx);
        return { content: [{ type: "text", text: result.text }], details: { action, tasks: result.tasks } };
      },
    });
  }

  pi.events?.on?.("scheduler:list", (data) => (data as { reply?: (tasks: TaskView[]) => void } | undefined)?.reply?.(taskViews(tasks)));
  // Catch-up (delivering a fire that came due while pi was not running) only
  // on a real restore. `new`, `fork` and `clone` have nothing to catch up —
  // the snapshot names a session id that no longer exists — and `session_tree`
  // must not replay a slot another branch already fired.
  pi.on("session_start", (event, ctx) =>
    restoreRuntime(ctx, {
      catchUp: event?.reason === "startup" || event?.reason === "resume" || event?.reason === "reload",
      opened: true,
    }));
  pi.on("session_tree", (_event, ctx) => restoreRuntime(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    deliveryInFlight = false;
    activeCtx = ctx;
    // pi writes the session file with the first reply, so a session that had
    // none at restore time can be indexed now.
    if (indexedFile !== sessionFilePath(ctx)) writeIndex(ctx);
    drainPending();
  });
  pi.on("session_shutdown", (event, ctx) => {
    // Any reason: the process may outlive this session (/new, /resume, /fork),
    // and the index must not keep claiming a live pi holds it afterwards.
    writeIndex(ctx, { closed: true });
    clearRuntime();
    if (ctx.hasUI) ctx.ui.setStatus("session-scheduler", undefined);
    activeCtx = undefined;
    sessionId = undefined;
    indexedFile = undefined;
    tasks = [];
    lastEmitted = undefined;
    // A /reload brings the same timers straight back: saying [] now would drop the card (and the
    // phone's strip) for a moment, only to draw it again.
    if (event?.reason !== "reload") emitTasks();
  });
}
