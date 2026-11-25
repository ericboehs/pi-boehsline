// Brighten the tmux window index when pi needs attention in a background
// window: a settled turn, or a blocking prompt (ask tool, confirm, input)
// waiting on an answer. Focusing any pane in that window clears the attention
// state via the pane-focus-in hook in ~/.tmux.conf.
//
// With the opt-in `programStatus` setting it also forwards pi's program status
// (OSC 7501) through tmux's DCS passthrough, so the outer terminal shows pi's
// state while pi sits in a pane. One ActivityTracker drives both, so the window
// flag and the terminal's status agree.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { optIn } from "../../../lib/opt-in.ts";
import { ActivityTracker, formatProgramStatus, passthroughAllowed, tmuxPassthrough, writeTerminal } from "../../../lib/program-status.ts";
import { attentionSettings } from "./settings.ts";

const TMUX_PANE = process.env.TMUX_PANE;
/** The name pi's own reporter puts on its OSC 7501 reports. */
const STATUS_APP = "pi";
const BG_REQUEST = "pi-background-tasks:request:v1";
const BG_RESPONSE = "pi-background-tasks:response:v1";
const BG_TERMINAL = "pi-background-tasks:terminal:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";
const BG_RESPONSE_TIMEOUT_MS = 250;
/**
 * How long to trust "nobody is listening" before probing again.
 *
 * The probe below is a broadcast on the shared event bus, and the bus offers no
 * way to ask whether a channel has subscribers. So when pi-background-tasks is
 * not installed — the normal case — every single turn used to wait out the full
 * BG_RESPONSE_TIMEOUT_MS for a reply that could never come, which is a quarter
 * of a second of dead air between the agent settling and the tmux indicator.
 *
 * Latch the silence instead and skip the wait, but stay ready to be proven
 * wrong: any well-formed response seen on the bus lifts the latch immediately
 * (see watchForResponder), and this timer is the backstop for the case where
 * nothing is ever emitted to notice.
 */
const BG_PROBE_RETRY_MS = 5 * 60_000;

let requestSequence = 0;
/** Set once any well-formed response is seen; the probe is only skipped while false. */
let responderSeen = false;
/** Epoch ms of the last probe that timed out with no responder. */
let lastSilentProbeAt = 0;

interface BackgroundTask {
  status?: unknown;
  notifyOnCompletion?: unknown;
  triggerOnCompletion?: unknown;
}

/** The quiet extension's shared state (no import between extensions). */
const QUIET_STATE = Symbol.for("pi-boehsline.quiet");

/** False when the quiet extension is not loaded: every run is Eric's. */
function runIsQuiet(): boolean {
  const state = (globalThis as Record<symbol, unknown>)[QUIET_STATE] as { quiet?: unknown } | undefined;
  return state?.quiet === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Watch the response channel for the lifetime of the extension.
 *
 * Without this the silence latch could only be undone by BG_PROBE_RETRY_MS,
 * and a responder that arrives mid-session (or simply answered one probe a
 * few milliseconds late, after its per-request listener was already torn down)
 * would go unnoticed for minutes. Any traffic at all is proof enough.
 */
function watchForResponder(pi: ExtensionAPI): void {
  pi.events.on(BG_RESPONSE, (value: unknown) => {
    if (isRecord(value) && value.schema_version === BG_RESPONSE_SCHEMA) responderSeen = true;
  });
}

async function hasRunningBackgroundTasks(pi: ExtensionAPI): Promise<boolean> {
  if (!responderSeen && Date.now() - lastSilentProbeAt < BG_PROBE_RETRY_MS) return false;
  const requestId = `tmux-attention-${process.pid}-${Date.now()}-${++requestSequence}`;

  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (running: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      off();
      resolve(running);
    };

    const off = pi.events.on(BG_RESPONSE, (value: unknown) => {
      if (!isRecord(value) || value.schema_version !== BG_RESPONSE_SCHEMA) return;
      if (value.request_id !== requestId || value.ok !== true) return;
      if (!isRecord(value.result) || !Array.isArray(value.result.tasks)) return;

      // A reply of any shape proves somebody is on the channel, so stop
      // short-circuiting future probes even if this one reports nothing running.
      responderSeen = true;
      finish(
        value.result.tasks.some(
          (task: BackgroundTask) => isRecord(task) && task.status === "running",
        ),
      );
    });

    timer = setTimeout(() => {
      if (!responderSeen) lastSilentProbeAt = Date.now();
      finish(false);
    }, BG_RESPONSE_TIMEOUT_MS);
    try {
      pi.events.emit(BG_REQUEST, {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: requestId,
        operation: "status",
        payload: {},
      });
    } catch {
      finish(false);
    }
  });
}

function main(pi: ExtensionAPI): void {
  if (!TMUX_PANE) return;

  watchForResponder(pi);

  // Stamp this pane with a sticky marker carrying our PID. The sweeper uses
  // it to (a) exclude idle agents from the non-interactive-job heuristic —
  // we report "node" as our foreground command even when sitting still — and
  // (b) detect a harsh kill via kill -0 without ever spawning ps.
  // A second after boot: spawning tmux is ~5ms of main-thread work, and
  // nothing reads the marker that early.
  setTimeout(() => {
    void pi
      .exec(
        "tmux",
        ["set-option", "-p", "-t", TMUX_PANE, "@agent_pane", String(process.pid)],
        { timeout: 1000 },
      )
      .catch(() => {
        // Cosmetic only; status-daemon's tty check covers unmarked sessions.
      });
  }, 1_000).unref();

  const setAttention = async (on: boolean): Promise<void> => {
    try {
      await pi.exec(
        "tmux",
        on
          ? ["set-window-option", "-t", TMUX_PANE, "@special_activity", "on"]
          : ["set-window-option", "-u", "-t", TMUX_PANE, "@special_activity"],
        { timeout: 1000 },
      );
    } catch {
      // tmux may have exited or the pane may have moved between checks. This is
      // a best-effort status hint, so never surface failures inside pi.
    }
  };

  const markWindow = async () => {
    try {
      // A settled turn only needs announcing when its window is not the active
      // window. Split panes in the active window remain visible. Blocking
      // prompts skip this check: the question may appear while focused, and the
      // flag must already be set so switching away still shows attention.
      const visible = await pi.exec(
        "tmux",
        ["display-message", "-p", "-t", TMUX_PANE, "#{window_active}"],
        { timeout: 1000 },
      );
      if (visible.code !== 0 || visible.stdout.trim() === "1") return;
      await setAttention(true);
    } catch {
      // Same best-effort contract as setAttention above.
    }
  };

  /**
   * Maintain this pane's @agent_running flag and roll it up into the window's
   * @agent_count. The status bar dims #I on background windows while
   * @agent_count is set; Claude's hooks (claude-agent-state.sh) keep the same
   * convention, and ~/.tmux/status-daemon.sh clears flags orphaned by a dead
   * agent. Dimming is decided at render time from window_active, so the flag
   * is maintained even when this window is currently focused — switching away
   * mid-turn dims it without any extra bookkeeping.
   *
   * Returns the window's remaining running-pane count. A window with any pane
   * still working shows dim, so resuming work also drops the stale bright
   * indicators (@special_activity from a settled turn, @job_done from a shell
   * job): the new turn supersedes the previous settlement, and bright must
   * never outrank the busy signal. Prompt attention shares @special_activity,
   * so in a same-window multi-agent overlap this can also drop a sibling's
   * prompt flag — accepted, matching the existing single-flag imprecision
   * (answering one prompt already clears another's via ui_prompt_end).
   */
  const setRunning = async (on: boolean): Promise<number> => {
    try {
      await pi.exec(
        "tmux",
        on
          ? ["set-option", "-p", "-t", TMUX_PANE, "@agent_running", "on"]
          : ["set-option", "-p", "-u", "-t", TMUX_PANE, "@agent_running"],
        { timeout: 1000 },
      );

      // Recount every pane in this window: with several agents split across
      // panes, the dim must hold until the last one settles, not the first.
      const win = await pi.exec(
        "tmux",
        ["display-message", "-p", "-t", TMUX_PANE, "#{window_id}"],
        { timeout: 1000 },
      );
      if (win.code !== 0) return 0;
      const target = win.stdout.trim();
      const listing = await pi.exec(
        "tmux",
        ["list-panes", "-t", target, "-F", "#{@agent_running}"],
        { timeout: 1000 },
      );
      let count = 0;
      if (listing.code === 0) {
        for (const line of listing.stdout.split("\n")) {
          if (line.trim()) count++;
        }
      }
      if (count > 0) {
        await pi.exec(
          "tmux",
          ["set-window-option", "-t", target, "@agent_count", String(count)],
          { timeout: 1000 },
        );
      } else {
        await pi.exec(
          "tmux",
          ["set-window-option", "-u", "-t", target, "@agent_count"],
          { timeout: 1000 },
        );
      }
      // A start always means this window is working again, and a settle that
      // leaves siblings running does too. Only a settle to fully idle keeps
      // whatever attention was already there (markWindow then sets its own).
      // Unsetting a missing option is a tmux no-op, so no read-before-write.
      if (on || count > 0) {
        await pi.exec(
          "tmux",
          ["set-window-option", "-u", "-t", target, "@special_activity"],
          { timeout: 1000 },
        );
        await pi.exec(
          "tmux",
          ["set-window-option", "-u", "-t", target, "@job_done"],
          { timeout: 1000 },
        );
      }
      return count;
    } catch {
      // Same best-effort contract as markWindow above.
      return 0;
    }
  };

  // ── program status: OSC 7501, forwarded through tmux ───────────────────────
  //
  // tmux answers no 7501 query and drops an OSC it does not know, so pi's own
  // reporter never sends one here: pi reports only to a terminal that answered
  // its query. With `programStatus` on (off by default) these states go out
  // wrapped in tmux's DCS passthrough instead, which tmux unwraps and the outer
  // terminal draws. Skipped when PI_PROGRAM_STATUS is set, since that means pi
  // was told to report for itself and every state would then go out twice.
  const status = new ActivityTracker();
  const reporting = !("PI_PROGRAM_STATUS" in process.env) && attentionSettings().programStatus;
  /** tmux's allow-passthrough, until the session_start probe says otherwise. */
  let passthrough = false;
  /** Only the TUI owns its terminal: a print, json or rpc child (a subagent) writes to a pipe. */
  let interactive = false;
  let reported = "";

  const writeStatus = (force = false) => {
    if (!reporting || !interactive || !passthrough) return;
    const current = status.current();
    const key = JSON.stringify(current);
    if (!force && key === reported) return;
    reported = key;
    writeTerminal(tmuxPassthrough(formatProgramStatus({ ...current, app: STATUS_APP })));
  };

  const writeClear = () => {
    if (!reporting || !interactive || !passthrough) return;
    writeTerminal(tmuxPassthrough(formatProgramStatus({ state: "clear" })));
  };

  // allow-passthrough reads `on` (the active pane only) or `all`; anything else
  // would have tmux drop the report, so nothing is written.
  const probePassthrough = async () => {
    if (!reporting || !interactive) return;
    try {
      const r = await pi.exec("tmux", ["show-options", "-gv", "allow-passthrough"], { timeout: 1000 });
      passthrough = r.code === 0 && passthroughAllowed(r.stdout);
    } catch {
      passthrough = false;
    }
    writeStatus(true);
  };

  /**
   * Feed pi's events to the one tracker both consumers read: a dialog opening
   * raises this pane's window flag, a dialog closing (or the run moving on)
   * lowers it, and every state change is one report. Deriving the flag from the
   * tracker rather than from the raw events keeps the window and the terminal
   * from ever disagreeing.
   */
  const track = (event: { type: string }) => {
    const before = status.current().state;
    status.handle(event);
    const now = status.current().state;
    if (now !== before && (now === "blocked" || before === "blocked")) void setAttention(now === "blocked");
    writeStatus();
  };

  if (reporting) {
    pi.on("message_end", track);
    pi.on("session_before_compact", track);
    pi.on("session_compact", track);
    pi.on("session_compact_failed", track);
  }

  // A quiet run's settle must not brighten the window. It has no attention of
  // its own; notify_user and the classifier arrive through quiet:attention.
  pi.events.on("quiet:attention", (attention: unknown) => {
    void setAttention(attention != null);
  });

  // A working agent dims its background window's index until it settles.
  pi.on("agent_start", (event) => {
    track({ ...event, type: "agent_start" });
    // A run starting clears the window's attention; one the quiet extension still holds
    // (notify_user, the classifier) is put back, since nothing he did cleared it.
    void setRunning(true).then(() => {
      const state = (globalThis as Record<symbol, unknown>)[QUIET_STATE] as { attention?: unknown } | undefined;
      if (state?.attention) void setAttention(true);
    });
  });

  pi.on("agent_settled", async (event) => {
    track({ ...event, type: "agent_settled" });
    // Clear this pane's running flag first: a turn that launched background
    // work still counts as settled for dimming purposes — the tasks below get
    // their own announcement path when they finish.
    const remaining = await setRunning(false);

    // A sibling pane is still working: the window stays dim until the last
    // one settles rather than flashing bright while work continues.
    if (remaining > 0) return;

    // Background work stays quiet: its settle raises no window attention. A
    // notify_user or classifier result already set it through quiet:attention.
    if (runIsQuiet()) return;

    // A turn that launched background work does not need attention yet. Its
    // completion notification will either wake another turn or be handled by
    // the terminal-event listener below.
    if (await hasRunningBackgroundTasks(pi)) return;
    await markWindow();
  });

  // A blocking prompt (ask tool, confirm, input, custom dialog) means the user
  // is needed, even if this window is currently focused — the status format
  // keeps the active window blue, and switching away then shows attention. The
  // dialog's close clears it, so answering while focused leaves no stale flag.
  // Notification-only; pi does not await these.
  pi.on("ui_prompt_start", (event) => track({ ...event, type: "ui_prompt_start" }));
  pi.on("ui_prompt_end", (event) => track({ ...event, type: "ui_prompt_end" }));

  let removeTerminalListener: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    // Spend the one unavoidable probe here, while the session is idle at
    // startup, so the first turn's agent_settled already knows the answer
    // instead of paying the timeout at the worst possible moment.
    void hasRunningBackgroundTasks(pi);
    // Same idea for the terminal: ask tmux once, at startup, whether it forwards
    // what pi would write, then report the state it is already in.
    interactive = (ctx as { mode?: string }).mode === "tui";
    void probePassthrough();

    removeTerminalListener?.();
    removeTerminalListener = pi.events.on(BG_TERMINAL, (value: unknown) => {
      if (!isRecord(value) || value.schema_version !== BG_TERMINAL_SCHEMA) return;
      if (!isRecord(value.task)) return;
      const task = value.task as BackgroundTask;

      // A triggering completion starts another agent turn; wait for that turn's
      // agent_settled event. Notification-only completions need announcing here,
      // unless an unrelated foreground turn is still working.
      if (
        task.notifyOnCompletion !== true ||
        task.triggerOnCompletion === true ||
        !ctx.isIdle()
      ) {
        return;
      }
      void hasRunningBackgroundTasks(pi).then((running) => {
        if (!running) void markWindow();
      });
    });
  });

  pi.on("session_shutdown", () => {
    removeTerminalListener?.();
    removeTerminalListener = undefined;
    // A departing pi leaves no state behind in the outer terminal, as pi's own
    // reporter does when it stops.
    writeClear();
    // Best effort: a clean exit should leave no dim or stale marker behind.
    // Anything harsher is status-daemon's job (it drops dead markers itself).
    void setRunning(false);
    void pi
      .exec("tmux", ["set-option", "-p", "-u", "-t", TMUX_PANE, "@agent_pane"], {
        timeout: 1000,
      })
      .catch(() => {});
  });
}

export default optIn("tmux-attention", "Highlight the tmux window when pi needs you", main);
