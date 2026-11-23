/**
 * Headless execution of one durable task.
 *
 * A scheduled run is a fresh, isolated `pi -p` process, never a message into an
 * existing session: pi appends to session JSONL without locking, so writing
 * into a session that might be open in a terminal risks interleaved entries.
 * Isolation also means the run cannot inherit whatever model or context a
 * human happened to leave in a session three days ago.
 *
 * Discovery is on by default — the same extensions, skills, prompt templates
 * and AGENTS.md an interactive pi would load — because a scheduled prompt
 * should behave like the pi you would have typed it into. That is also what
 * makes `/checkin` work as a scheduled prompt. `without` strips pieces back
 * out. Themes are always off: there is no TUI to theme.
 */

import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, fchmodSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import {
  DEFAULT_TIMEOUT_MS,
  type DurableTask,
  enabledFeatures,
  type RunStatus,
  truncate,
} from "./task-registry.ts";

export interface RunOutcome {
  status: RunStatus;
  exitCode?: number;
  output: string;
  error?: string;
}

const MAX_CAPTURED_OUTPUT = 200_000;
/**
 * Cap for the copy of the output passed in the environment.
 *
 * Linux caps a single argument or environment string at MAX_ARG_STRLEN, 32
 * pages — 128KiB — and `execve` fails the whole spawn with E2BIG if any one
 * exceeds it. A task that produced more than that got "deliver failed to
 * start: spawn E2BIG" and no delivery at all, on Linux only, at whatever size
 * its output happened to cross the line. macOS has no equivalent per-string
 * limit, so this never showed up there.
 *
 * stdin carries the whole output and has no such limit, so the variable is a
 * convenience for one-liners and is the copy that gets shortened.
 */
const MAX_ENV_OUTPUT = 100_000;
const DELIVERY_TIMEOUT_MS = 120_000;
/** Cap on the error text inside a failure notice, to keep the page readable. */
const MAX_ALERT_ERROR = 1_500;

export function piArgsFor(task: DurableTask): string[] {
  const enabled = enabledFeatures(task);
  // Always off: a headless run has no TUI, and saving a session for something
  // that runs unattended every day would grow a session file forever.
  const args = ["-p", "--no-session", "--no-themes"];
  if (!enabled.has("extensions")) args.push("--no-extensions");
  if (!enabled.has("skills")) args.push("--no-skills");
  if (!enabled.has("templates")) args.push("--no-prompt-templates");
  if (!enabled.has("context")) args.push("--no-context-files");
  if (!enabled.has("tools")) args.push("--no-tools");
  if (task.model) args.push("--model", task.model);
  return args;
}

interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** A write to the child's stdin failed, so `input` may be only partly there. */
  stdinError?: Error;
}

function capture(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs: number;
    /** Append stdout and stderr here as they arrive (mode 0600), for a live tail. */
    logPath?: string;
    /** The child's pid (its process group) once spawned, then undefined once it has exited. */
    onChild?: (pid: number | undefined) => void;
  },
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const log = openRunLog(options.logPath);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a timeout can kill the whole tree. A prompt
      // that shells out, or a `deliver` one-liner with a pipeline in it, leaves
      // grandchildren holding the stdio pipes: signalling only the direct child
      // leaves 'close' waiting on them long past the deadline.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let settled = false;
    let stdinError: Error | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Cancel the timeout and the kill escalation.
     *
     * Not housekeeping: a child that dies promptly on SIGTERM would otherwise
     * be followed five seconds later by `kill(-pid, SIGKILL)` against a pid the
     * OS may have handed to something else. `unref` hides this in the CLI, but
     * an in-process `/schedule run` keeps the loop alive long enough to fire.
     */
    const stopTimers = () => {
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      timer = undefined;
      hardTimer = undefined;
      giveUpTimer = undefined;
    };

    let childReported = false;
    const childGone = () => {
      if (!childReported) return;
      childReported = false;
      try {
        options.onChild?.(undefined);
      } catch {
        // Bookkeeping for `stop`; never fail a run over it.
      }
    };
    if (child.pid !== undefined && options.onChild) {
      try {
        options.onChild(child.pid);
        childReported = true;
      } catch {
        // As above.
      }
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      stopTimers();
      childGone();
      log.close();
      resolve({ code, signal, stdout, stderr, timedOut, truncated, stdinError });
    };

    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is already gone, or this platform refused it.
        child.kill(signal);
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      // A wedged model call ignores SIGTERM; do not let a stuck run hold its
      // claim until CLAIM_STALE_MS expires. If even SIGKILL leaves something
      // holding the pipes, give up waiting and report what we have.
      hardTimer = setTimeout(() => {
        signalTree("SIGKILL");
        giveUpTimer = setTimeout(() => finish(null, "SIGKILL"), 1_000);
        giveUpTimer.unref?.();
      }, 5_000);
      hardTimer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      log.write(chunk);
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk.toString();
      else truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk);
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stopTimers();
      childGone();
      log.close();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });

    // A child that exits, or never reads stdin, makes this write fail with
    // EPIPE. An unhandled 'error' on the stream would take down the whole
    // process — for the tick, that means one misbehaving task killing the run
    // of every other due task. So it is recorded rather than thrown, and the
    // caller decides: a `deliver` one-liner that ignores stdin is fine, a pi
    // run that never received its prompt is not.
    child.stdin.on("error", (error: Error) => {
      stdinError ??= error;
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Past this a run's output log stops growing (the in-memory capture is capped too). */
export const MAX_RUN_LOG_FILE = 5_000_000;

/** Written once when the log reaches its cap, so a live tail shows why it stopped moving. */
export const RUN_LOG_CAPPED_MARKER = "\n[log capped: the run is still going, but its output is no longer written here]\n";

/**
 * A run's output log: private (0600, in a 0700 directory), appended as chunks
 * arrive, capped. Best-effort: a log that can't be opened or written never
 * fails the run, it just isn't there to tail.
 *
 * Opened with O_NOFOLLOW and chmodded through the fd: a symlink planted at the
 * path is refused rather than followed, so neither the output nor the mode
 * change lands on its target. At the cap the log gets one marker line.
 */
export function openRunLog(
  path: string | undefined,
  maxBytes = MAX_RUN_LOG_FILE,
): { write: (chunk: Buffer) => void; close: () => void } {
  let fd: number | undefined;
  let written = 0;
  let capped = false;
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      fd = openSync(
        path,
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(fd, 0o600);
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort.
        }
      }
      fd = undefined;
    }
  }
  return {
    write(chunk) {
      if (fd === undefined || capped) return;
      try {
        const room = maxBytes - written;
        if (chunk.length <= room) {
          written += writeSync(fd, chunk);
          return;
        }
        if (room > 0) written += writeSync(fd, chunk.subarray(0, room));
        capped = true;
        writeSync(fd, RUN_LOG_CAPPED_MARKER);
      } catch {
        // Best-effort.
      }
    },
    close() {
      if (fd === undefined) return;
      try {
        closeSync(fd);
      } catch {
        // Best-effort.
      }
      fd = undefined;
    },
  };
}

/** The output as the environment can carry it, marked if it had to be cut. */
function envOutput(output: string): string {
  if (output.length <= MAX_ENV_OUTPUT) return output;
  return `${output.slice(0, MAX_ENV_OUTPUT)}\n\n… truncated at ${MAX_ENV_OUTPUT} characters;`
    + ` the full output is on stdin`;
}

/**
 * The directory the run should happen in.
 *
 * A task records the directory it was created in, so project extensions and
 * AGENTS.md resolve the way they did when the prompt was written. A directory
 * that has since been deleted falls back to $HOME; one that exists but cannot
 * be used is an error, because running a tool-enabled prompt against the wrong
 * project and reporting success is worse than not running it.
 */
function resolveCwd(task: DurableTask): { cwd: string } | { error: string } {
  if (!task.cwd) return { cwd: homedir() };
  try {
    if (!statSync(task.cwd).isDirectory()) return { error: `cwd ${task.cwd} is not a directory` };
    return { cwd: task.cwd };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { cwd: homedir() };
    return { error: `cannot use cwd ${task.cwd}: ${code ?? String(error)}` };
  }
}

export interface RunOptions {
  piBin?: string;
  env?: NodeJS.ProcessEnv;
  deliveryTimeoutMs?: number;
  /**
   * Page the task's delivery channel when the run fails. The tick sets this:
   * it runs unattended, and without it a failed run is a silent registry
   * entry — the 15:30 grade check that never arrives being the case that
   * motivated it. Manual runs leave it off; whoever asked is already watching.
   */
  alertOnFailure?: boolean;
  /** Write the run's output here as it arrives (task-registry's runLogPath), for a live tail. */
  runLogPath?: string;
  /** Told each child's pid once spawned and undefined once it exits (the claim's runChildPid). */
  onChild?: (pid: number | undefined) => void;
  /** Whether `pi-scheduler stop` ended this run: it is then "stopped", not an error, and pages nobody. */
  wasStopped?: () => boolean;
}

/**
 * Run the task's prompt and, if it has one, its delivery command.
 *
 * The prompt goes in on stdin rather than argv so it never appears in `ps`
 * output, and the same is true of the result handed to `deliver`.
 *
 * With `alertOnFailure` a failed run also pages the task's own delivery
 * channel, so an unattended tick cannot fail quietly.
 */
export async function runTask(task: DurableTask, options: RunOptions = {}): Promise<RunOutcome> {
  let outcome = await executeTask(task, options);
  if (outcome.status !== "ok" && options.wasStopped?.()) {
    outcome = { ...outcome, status: "stopped", error: "stopped by pi-scheduler stop" };
  }
  if (options.alertOnFailure && task.deliver && outcome.status !== "ok" && outcome.status !== "stopped") {
    await alertFailure(task, task.deliver, outcome, options);
  }
  return outcome;
}

/**
 * A failure notice through the task's own delivery channel.
 *
 * The record of a failed run sits in `runs` where nobody looks until something
 * is already wrong, so the tick sends the failure to the one place built for
 * "this task wants attention": its `deliver` command. The notice is the whole
 * message on stdin — a `slack-noti` one-liner needs nothing more — with the
 * error also in `$PI_SCHEDULER_ERROR` for anything structured.
 *
 * Best-effort on purpose. A broken channel must not crash the tick or rewrite
 * the run's story: the outcome is returned to the caller untouched, and a
 * notice that could not be delivered is said so on stderr, which is where the
 * tick's log already lives. The cwd falls back to $HOME for the same reason —
 * a vanished project directory must not cost the page as well as the run.
 */
async function alertFailure(
  task: DurableTask,
  deliver: string,
  outcome: RunOutcome,
  options: { env?: NodeJS.ProcessEnv; deliveryTimeoutMs?: number },
): Promise<void> {
  const env = options.env ?? process.env;
  const error = truncate(outcome.error ?? `status ${outcome.status}`, MAX_ALERT_ERROR);
  const what = outcome.status === "timeout" ? "timed out" : "failed";
  const notice = `:rotating_light: pi-scheduler *${task.name ?? task.id}* ${what}: ${error}`;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
  const resolved = resolveCwd(task);
  const name = task.name ?? task.id;
  const notDelivered = (reason: string) =>
    process.stderr.write(`${new Date().toISOString()} ${name} failure notice not delivered: ${reason}\n`);

  let delivery: CaptureResult;
  try {
    delivery = await capture("/bin/sh", ["-c", deliver], {
      cwd: "error" in resolved ? homedir() : resolved.cwd,
      env: { ...env, PI_SCHEDULER_TASK: name, PI_SCHEDULER_ERROR: error },
      input: notice,
      timeoutMs: deliveryTimeoutMs,
    });
  } catch (spawnError) {
    notDelivered(spawnError instanceof Error ? spawnError.message : String(spawnError));
    return;
  }
  if (delivery.timedOut) {
    notDelivered(`did not finish within ${deliveryTimeoutMs}ms and was killed`);
  } else if (delivery.code !== 0) {
    notDelivered(
      truncate(delivery.stderr.trim() || `exited ${delivery.code ?? delivery.signal}`, 500),
    );
  }
}

async function executeTask(
  task: DurableTask,
  options: RunOptions,
): Promise<RunOutcome> {
  const piBin = options.piBin ?? process.env.PI_SCHEDULER_PI_BIN ?? "pi";
  const env = options.env ?? process.env;
  const resolved = resolveCwd(task);
  if ("error" in resolved) return { status: "error", output: "", error: resolved.error };
  const cwd = resolved.cwd;
  const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result: CaptureResult;
  try {
    result = await capture(piBin, piArgsFor(task), {
      cwd,
      env,
      input: task.prompt,
      timeoutMs,
      logPath: options.runLogPath,
      onChild: options.onChild,
    });
  } catch (error) {
    return {
      status: "error",
      output: "",
      error: `could not start ${piBin}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const output = result.truncated
    ? `${result.stdout.trim()}\n\n… output truncated at ${MAX_CAPTURED_OUTPUT} characters`
    : result.stdout.trim();
  if (result.timedOut) {
    return { status: "timeout", output, error: `no result within ${timeoutMs}ms` };
  }
  // A pi that failed is reported by its own error first. A pi that dies before
  // reading stdin also breaks the prompt's pipe, and whether that EPIPE lands
  // before the exit is a race; letting it win hid the real cause ("the model is
  // down") behind "could not send the prompt", and made two tests flaky in CI.
  if (result.code !== 0) {
    return {
      status: "error",
      exitCode: result.code ?? undefined,
      output,
      error: truncate(result.stderr.trim() || `pi exited ${result.code ?? result.signal}`, 2_000),
    };
  }
  // The prompt goes in on stdin, so a broken pipe from a pi that then exits 0
  // means it may have run on a partial prompt — or none at all. Reporting that
  // as success would hand back an answer to a question never fully asked.
  if (result.stdinError) {
    return {
      status: "error",
      exitCode: result.code ?? undefined,
      output,
      error: `could not send the prompt to ${piBin}: ${result.stdinError.message}`,
    };
  }

  if (!task.deliver) return { status: "ok", exitCode: 0, output };

  // Empty output is a successful no-op, not something to page about.
  if (!output) return { status: "ok", exitCode: 0, output };

  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
  let delivery: CaptureResult;
  try {
    delivery = await capture("/bin/sh", ["-c", task.deliver], {
      cwd,
      env: { ...env, PI_SCHEDULER_OUTPUT: envOutput(output), PI_SCHEDULER_TASK: task.name ?? task.id },
      input: output,
      timeoutMs: deliveryTimeoutMs,
      onChild: options.onChild,
    });
  } catch (error) {
    return {
      status: "error",
      output,
      error: `deliver failed to start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (delivery.timedOut) {
    return {
      status: "error",
      output,
      error: `deliver did not finish within ${deliveryTimeoutMs}ms and was killed`,
    };
  }
  if (delivery.code !== 0) {
    return {
      status: "error",
      exitCode: delivery.code ?? undefined,
      output,
      error: truncate(
        delivery.stderr.trim() || `deliver exited ${delivery.code ?? delivery.signal}`,
        2_000,
      ),
    };
  }

  return { status: "ok", exitCode: 0, output };
}
