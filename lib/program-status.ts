/**
 * The Program Status Protocol (OSC 7501), pi-boehsline's side of it.
 *
 * https://mitchellh.com/writing/program-status-osc7501 — a program tells the
 * terminal whether it is idle, working, blocked on the user, done or failed:
 *
 *   ESC ] 7501 ; state=idle|working|done|blocked|error|clear[:kind=…][:app=…][:msg=<base64>] ESC \
 *
 * pi reports for itself (tui/src/program-status.ts, ProgramStatusReporter), but
 * only to a terminal that answered its 7501 query, and tmux answers none. Two
 * opt-ins need the same states anyway:
 *
 *   - canvas writes them to the session folder for its page (activity.json);
 *   - tmux-attention can forward them through tmux's DCS passthrough, so the
 *     outer terminal shows pi's state while pi sits inside a pane.
 *
 * ActivityTracker follows pi's ProgramStatusReporter event for event and rule
 * for rule, so every consumer agrees with the terminal: `working` during a run
 * or a compaction, `blocked` while a dialog waits, then `done`, `error` or
 * `idle` once the run settles. Messages are dialog titles and first error lines
 * only, never prompts or model output.
 *
 * Pure node: no pi imports, so tests run under plain `node --test`, and
 * formatProgramStatus is tested against pi-tui's own encoder.
 */

export type ActivityState = "working" | "blocked" | "done" | "error" | "idle";
export type Activity = { state: ActivityState; message?: string };

const firstLine = (text: unknown) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) || "";

/** pi's states, from pi's events: the same rules as its ProgramStatusReporter. */
export class ActivityTracker {
  private runActive = false;
  private compacting = false;
  private runResult: Activity = { state: "done" };
  private resting: Activity = { state: "idle" };
  private readonly dialogs: { kind: string; title: string }[] = [];

  handle(event: { type: string; [k: string]: any }): void {
    switch (event.type) {
      case "agent_start":
        this.runActive = true;
        this.compacting = false;
        this.runResult = { state: "done" };
        break;
      case "message_end": {
        // The latest response decides, so a retried error gives way to its retry.
        const m = event.message;
        if (m?.role !== "assistant") return;
        this.runResult = m.stopReason === "error" ? { state: "error", message: firstLine(m.errorMessage) } : { state: "done" };
        break;
      }
      case "session_before_compact":
        this.compacting = true;
        break;
      case "session_compact":
        this.compacting = false;
        if (!this.runActive && event.reason === "manual") this.resting = { state: "done" };
        break;
      case "session_compact_failed":
        this.compacting = false;
        if (this.runActive) {
          if (event.aborted) this.runResult = { state: "idle" };
          else if (event.errorMessage) this.runResult = { state: "error", message: firstLine(event.errorMessage) };
        } else if (event.aborted) this.resting = { state: "idle" };
        else if (event.reason === "manual") this.resting = { state: "error", message: firstLine(event.errorMessage) };
        break;
      case "agent_settled":
        this.runActive = false;
        this.compacting = false;
        this.resting = event.aborted ? { state: "idle" } : this.runResult;
        break;
      case "ui_prompt_start":
        this.dialogs.push({ kind: String(event.kind || ""), title: firstLine(event.title) });
        break;
      case "ui_prompt_end": {
        const title = firstLine(event.title);
        let i = this.dialogs.findLastIndex((d) => d.kind === String(event.kind || "") && d.title === title);
        if (i < 0) i = this.dialogs.length - 1;
        if (i >= 0) this.dialogs.splice(i, 1);
        break;
      }
    }
  }

  current(): Activity {
    const dialog = this.dialogs.at(-1);
    if (dialog) return { state: "blocked", ...(dialog.title ? { message: dialog.title } : {}) };
    if (this.compacting) return { state: "working", message: "Compacting context" };
    if (this.runActive) return { state: "working" };
    return this.resting;
  }
}

/** What a blocked program waits for, as the spec names it. */
export type BlockedKind = "permission" | "question" | "auth";

export interface ProgramStatusReport {
  state: ActivityState | "clear";
  /** A stable program name: letters, digits and `_ . + -`, 1-32 of them. */
  app?: string;
  /** Only reported for `blocked`, as the spec allows. */
  kind?: BlockedKind;
  /** One human-readable line; control characters become spaces, long text is cut. */
  message?: string;
}

const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
/** pi's own limit, so a report here can never be longer than pi's. */
const MAX_MESSAGE_BYTES = 2048;
/** C0, DEL and C1: a raw ESC or BEL would end the OSC early and the rest would reach the terminal as sequences. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Encode one report. Same output as pi-tui's formatProgramStatus (a test pins that). */
export function formatProgramStatus(status: ProgramStatusReport): string {
  const pairs = [`state=${status.state}`];
  if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
  if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
  const message = truncateUtf8(String(status.message ?? "").replace(CONTROL_CHARACTERS, " ").trim(), MAX_MESSAGE_BYTES);
  if (message) pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/**
 * Wrap a sequence for tmux's DCS passthrough, which hands the outer terminal
 * what tmux itself would drop (an OSC it does not know). tmux unwraps
 * `ESC P tmux; … ESC \` and writes the payload out; every ESC in the payload is
 * doubled so the wrapper's terminator stays the only ESC\. Needs
 * `set -g allow-passthrough on|all` in tmux.
 */
export function tmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * Where a report goes: stdout, as pi's own terminal writes it.
 *
 * A seam because a test shares stdout with the test runner (`node --test` reads
 * the file's results from it), so a test that wants to read a report swaps this
 * for an array instead of patching the stream.
 */
let terminalSink = (sequence: string): void => void process.stdout.write(sequence);

/** Write one control sequence to the terminal. */
export function writeTerminal(sequence: string): void {
  try {
    terminalSink(sequence);
  } catch {
    // A closed stdout costs the report, nothing else.
  }
}

/** Swap the sink (tests). No argument restores stdout. */
export function setTerminalSink(next?: (sequence: string) => void): void {
  terminalSink = next ?? ((sequence: string) => void process.stdout.write(sequence));
}

/** Whether `tmux show -gv allow-passthrough` printed a value that forwards sequences. */
export function passthroughAllowed(setting: string | undefined): boolean {
  return /^\s*(?:on|all)\s*$/i.test(setting ?? "");
}
