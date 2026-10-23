import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
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
} from "./lib/schedule-core.ts";

const SNAPSHOT_TYPE = "session-scheduler:snapshot";
const SNAPSHOT_VERSION = 1;
const MAX_TASKS = 50;

/** The opt-in name in boehsline.json's `enable` list, and its settings key. */
export const TOOL_OPT_IN = "scheduler-tool";
export const TOOL_NAME = "schedule";
const TOOL_ACTIONS = ["once", "loop", "list", "cancel", "pause", "resume"] as const;
type ToolAction = (typeof TOOL_ACTIONS)[number];

// setTimeout silently fires immediately past this, so long waits are re-armed
// in chunks instead of being trusted to a single timer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type NoticeLevel = "info" | "warning" | "error";

export interface ScheduledTask extends Schedule {
  id: string;
  prompt: string;
  createdAt: number;
  nextRunAt: number;
  paused?: boolean;
  /** "agent" when the schedule tool created it; its fire is labelled as the agent's own reminder. */
  source?: "agent";
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

interface ToolParams {
  action: string;
  prompt?: string;
  when?: string;
  every?: string;
  id?: string;
}

interface ResumeResult {
  tasks: ScheduledTask[];
  changed: boolean;
}

export function advanceRecurringTask(task: ScheduledTask, now: number): ScheduledTask {
  const next = advanceSchedule(task, task.nextRunAt, now);
  return next === undefined ? task : { ...task, nextRunAt: next };
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
  if (task.kind === "interval") {
    return typeof task.intervalMs === "number" && task.intervalMs >= MIN_INTERVAL_MS;
  }
  if (task.kind === "daily") return typeof task.dailyAt === "string" && parseClock(task.dailyAt) !== undefined;
  if (task.kind === "cron") return typeof task.cronExpr === "string" && parseCron(task.cronExpr) !== undefined;
  return true;
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
  if (task.kind === "once") {
    return `${task.id} · once ${task.paused ? `paused, was ${when}` : when} · ${task.prompt}`;
  }
  const next = task.paused ? "paused" : `next ${when}`;
  return `${task.id} · ${describeSchedule(task)} · ${next} · ${task.prompt}`;
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
  // Quoted (JSON-escaped), so the tool's own sentence after it never runs
  // into the prompt's punctuation ("…done.. It fires…").
  return `${task.id} · ${kind} · ${when} · set by ${by} · ${JSON.stringify(task.prompt)}`;
}

/**
 * The text a fire sends. A timer the agent set itself comes back as a user
 * message, so say whose it is; otherwise the model reads its own reminder as
 * a fresh request from the user.
 */
export function deliveryText(task: ScheduledTask): string {
  if (task.source !== "agent") return task.prompt;
  const kind = task.kind === "once" ? "one-shot" : `recurring, ${describeSchedule(task)}`;
  return `[Scheduled task ${task.id} (${kind}) that you set with the ${TOOL_NAME} tool fired]\n${task.prompt}`;
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
 * fire while pi is not running is lost, never replayed. Anything that must run
 * whether or not pi is open belongs to `/schedule` (durable-scheduler.ts).
 */
export default function sessionScheduler(pi: ExtensionAPI): void {
  let tasks: ScheduledTask[] = [];
  let activeCtx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let generation = 0;
  let deliveryInFlight = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, ScheduledTask>();

  const notice = (ctx: ExtensionContext, message: string, level: NoticeLevel = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else process.stderr.write(`${message}\n`);
  };

  const updateStatus = (ctx = activeCtx) => {
    if (!ctx?.hasUI) return;
    const active = new Set([
      ...tasks.filter((task) => !task.paused).map((task) => task.id),
      ...pending.keys(),
    ]).size;
    const paused = tasks.filter((task) => task.paused).length;
    ctx.ui.setStatus("session-scheduler", timerStatusText(active, paused));
  };

  const persist = () => {
    if (!sessionId) return;
    pi.appendEntry(SNAPSHOT_TYPE, {
      version: SNAPSHOT_VERSION,
      sessionId,
      tasks: tasks.map((task) => ({ ...task })),
    } satisfies SchedulerSnapshot);
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
    const next = pending.entries().next().value as [string, ScheduledTask] | undefined;
    if (!next) return;

    const [id, task] = next;
    pending.delete(id);
    deliveryInFlight = true;
    updateStatus(ctx);
    if (ctx.hasUI) ctx.ui.notify(`Scheduled task ${task.id} fired`, "info");
    try {
      pi.sendUserMessage(deliveryText(task));
    } catch (error) {
      // Put it back before persisting anything: a one-shot removed from the
      // snapshot and then failing to deliver would be gone from both the
      // session and the queue, and the user would simply never be reminded.
      deliveryInFlight = false;
      pending.set(id, task);
      notice(ctx, `Could not deliver scheduled task ${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }

    // Delivered. Only now is a one-shot really finished.
    if (task.kind === "once") {
      tasks = tasks.filter((candidate) => candidate.id !== task.id);
      try {
        persist();
      } catch (error) {
        // The snapshot is stale, not the timers. Say so rather than throwing
        // out of a timer callback, which nothing above here would catch.
        notice(ctx, `Delivered ${id}, but could not record it: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
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
        armTask(current, ctx, runtimeGeneration);
        return;
      }

      if (!pending.has(current.id)) pending.set(current.id, { ...current });
      if (current.kind !== "once") {
        const advanced = advanceRecurringTask(current, now);
        if (advanced.nextRunAt > now) {
          tasks[index] = advanced;
          armTask(advanced, ctx, runtimeGeneration);
        } else {
          tasks.splice(index, 1);
        }
      }
      persist();
      updateStatus(ctx);
      drainPending();
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    timers.set(task.id, timer);
  };

  const restoreRuntime = (ctx: ExtensionContext) => {
    clearRuntime();
    activeCtx = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    const restored = normalizeTasksForResume(readSnapshot(ctx));
    tasks = restored.tasks;
    const runtimeGeneration = generation;
    for (const task of tasks) {
      if (!task.paused) armTask(task, ctx, runtimeGeneration);
    }
    if (restored.changed) persist();
    updateStatus(ctx);
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
    });
  };

  const addOnce = (
    ctx: ExtensionContext,
    nextRunAt: number,
    prompt: string,
    source?: ScheduledTask["source"],
  ) => {
    const task = addTask(ctx, { kind: "once", prompt, nextRunAt, ...(source ? { source } : {}) });
    notice(
      ctx,
      `Scheduled ${task.id} once at ${new Date(task.nextRunAt).toLocaleString()}`
      + ` (in ${formatDuration(task.nextRunAt - Date.now())});`
      + " keep this session open or it will not fire.",
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
        "Session timers (this session only, while pi is running):",
        "  /once <duration|HH:MM|ISO> <prompt>",
        "  /once <prompt> in <duration>",
        "  /once list | cancel <id>",
        "  /loop <duration> <prompt>",
        "  /loop <prompt> every <duration>",
        "  /loop list | cancel <id> | clear",
        "  /loop pause <id|all> | resume <id|all>",
        "  (:: before the prompt is optional)",
        "/once help or /loop help explains the forms in full.",
        "Use /schedule for tasks that must run without an open session.",
      ].join("\n"),
      "warning",
    );
  };

  const showHelp = (ctx: ExtensionContext) => {
    notice(
      ctx,
      [
        "/once and /loop \u2014 timers that fire a prompt into this conversation.",
        "",
        "They live in this session: they need pi open, they stop when it exits, and",
        "anything missed while it was closed is dropped rather than replayed. For work",
        "that must happen whether or not you are here, use /schedule.",
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
        "MANAGING",
        "  /once list | cancel <id>              one-shots only",
        "  /loop list | cancel <id> | clear      every timer in this session",
        "  /loop pause <id|all> | resume <id|all>",
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
   * /loop gets all five; /once exposes only `list` and `cancel`, since the
   * others describe a timer that will fire again and a one-shot will not.
   */
  const handleManagement = async (
    input: string,
    ctx: ExtensionContext,
    { onlyOnce }: { onlyOnce: boolean },
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

  pi.registerCommand("once", {
    description: "Run a prompt once later in this session, for example /once 15m check the build",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "help") {
        showHelp(ctx);
        return;
      }
      if (await handleManagement(input, ctx, { onlyOnce: true })) return;

      const parsed = parseOnceCommand(input);
      if (!parsed) {
        showUsage(ctx);
        return;
      }
      try {
        addOnce(ctx, parsed.nextRunAt, parsed.prompt);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("loop", {
    description: "Repeat a prompt in this session, for example /loop 5m check the deploy",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "help") {
        showHelp(ctx);
        return;
      }
      if (!input) {
        showUsage(ctx);
        return;
      }
      if (await handleManagement(input, ctx, { onlyOnce: false })) return;

      const leading = input.match(/^(?:every\s+)?(\S+)\s+([\s\S]+)$/i);
      const trailing = input.match(/^([\s\S]+?)\s+every\s+(\S+)\s*$/i);
      const duration = trailing?.[2] ?? leading?.[1];
      const prompt = trailing?.[1] ?? leading?.[2];
      if (!duration || !prompt) {
        showUsage(ctx);
        return;
      }
      try {
        const task = addInterval(ctx, duration, prompt);
        notice(ctx, `Looping ${task.id} every ${formatDuration(task.intervalMs ?? 0)}; next ${new Date(task.nextRunAt).toLocaleString()}`);
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
    const { exposure } = settingsFor(TOOL_OPT_IN, { exposure: "deferred" }, config);
    const direct = exposure === "direct";
    if (!direct) activateToolSearch(pi);

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
          const nextRunAt = parseOnceTime(when);
          if (nextRunAt === undefined) throw new Error(`Could not read "${when}" as a time; use 15m, 2h, 15:30, 8p or an ISO timestamp`);
          const task = addOnce(ctx, nextRunAt, prompt, "agent");
          return { text: `Scheduled ${formatTaskForAgent(task)}. It fires into this conversation only while this session stays open.`, tasks: [task] };
        }
        case "loop": {
          const every = need(params.every, "`every` (a duration of 1m or more, like 15m)");
          const prompt = need(params.prompt, "a `prompt`");
          const task = addInterval(ctx, every, prompt, "agent");
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
        "Timers live in this session only: they fire while pi is open and are lost when it exits. " +
        "When one fires, its prompt arrives as a message labelled as your scheduled task. Cancel loops you no longer need.",
      parameters: Type.Object({
        action: Type.Union(TOOL_ACTIONS.map((name) => Type.Literal(name))),
        prompt: Type.Optional(Type.String({ description: "once/loop: what to send into the conversation when it fires; write it as an instruction to yourself" })),
        when: Type.Optional(Type.String({ description: "once: 30s, 15m, 2h, 1d; or a clock time 15:30, 9a, 8p; or an ISO timestamp" })),
        every: Type.Optional(Type.String({ description: "loop: interval such as 5m, 1h, 1h30m (at least 1m)" })),
        id: Type.Optional(Type.String({ description: "cancel/pause/resume: task id or a unique prefix; pause/resume also take \"all\"" })),
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

  pi.on("session_start", (_event, ctx) => restoreRuntime(ctx));
  pi.on("session_tree", (_event, ctx) => restoreRuntime(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    deliveryInFlight = false;
    activeCtx = ctx;
    drainPending();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearRuntime();
    if (ctx.hasUI) ctx.ui.setStatus("session-scheduler", undefined);
    activeCtx = undefined;
    sessionId = undefined;
    tasks = [];
  });
}
