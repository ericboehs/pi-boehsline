// Remote reload: one session asks another to run pi's /reload.
//
// Sending "/reload" as a chat message does nothing useful: the receiving model
// sees text and can't run slash commands. Instead the sender writes a control
// frame ({type:"control", action:"reload"}) that the target's agent-link
// handles itself, so the target's model never sees it. The target reloads by
// dispatching its own command (RELOAD_COMMAND), whose handler calls
// ctx.reload(): pi only reloads from a command context, and never mid-run, so
// a target in an agent run waits for agent_settled, and one that is busy
// otherwise (a manual /compact, an open dialog) re-checks until it is free.
//
// This module is the decision logic, kept free of pi and sockets so it can be
// tested directly; index.ts wires it to the transport and pi's events.

/** The command a reload is dispatched through. */
export const RELOAD_COMMAND = "agent-link-reload";
/** A target reloads for a request at most once in this window. */
export const RELOAD_RATE_MS = 30_000;
/** How long a sender waits for the target's answer. */
export const RELOAD_REPLY_TIMEOUT_MS = 5_000;
/** Bulk target: every live, idle pi session except the caller. */
export const IDLE_TARGETS = "*idle";

export type ReloadStatus = "reloaded" | "queued" | "refused";
export interface ReloadOutcome { status: ReloadStatus; reason?: string; }

export const EDITOR_REFUSAL = "has unsent text in its editor (force: true overrides)";

/** The one-line form the tool reports per target. */
export function describeOutcome(o: ReloadOutcome): string {
  if (o.status === "reloaded") return "reloaded";
  if (o.status === "queued") return "queued (busy, reloads when it is free)";
  return `refused: ${o.reason || "no reason given"}`;
}

/** Parse a reload_result frame's fields into an outcome, rejecting junk. */
export function outcomeFromFrame(frame: { status?: unknown; reason?: unknown }): ReloadOutcome {
  const status = frame.status;
  if (status === "reloaded" || status === "queued" || status === "refused") {
    return { status, ...(typeof frame.reason === "string" && frame.reason && { reason: frame.reason }) };
  }
  return { status: "refused", reason: "the target sent an unrecognised answer" };
}

/** `/agent-link reload <name|*idle> [--force]`: the target ("" when missing) and the flag. */
export function parseReloadArgs(args: string): { isReload: boolean; to: string; force: boolean } {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (sub !== "reload") return { isReload: false, to: "", force: false };
  return { isReload: true, force: rest.includes("--force"), to: rest.filter((a) => a && a !== "--force").join(" ") };
}

export interface ReloadHost {
  /** True when pi has no agent run, compaction or retry going (ctx.isIdle()). */
  isIdle(): boolean;
  /** True between agent_start and agent_settled: an agent run that ends in agent_settled. */
  isRunning(): boolean;
  /**
   * True while a blocking extension dialog (ui_prompt_start..ui_prompt_end, from
   * any extension) or one of agent-link's own commands is in flight. A reload
   * then would tear the dialog down under its handler.
   */
  uiBusy?(): boolean;
  /** What the user has typed but not sent; "" when unknown (RPC, no UI). */
  editorText(): string;
  /** Run RELOAD_COMMAND as a command (sendUserMessage with expandPromptTemplates). */
  dispatch(): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  now?(): number;
}

/** State that has to outlive a reload: the extension instance itself is replaced. */
export interface ReloadShared {
  /** When this process last actually reloaded for a request (the rate limit). */
  lastAcceptedAt: number;
  /** When this process last sent a bulk (*idle) reload (the sender cooldown). */
  lastBulkAt: number;
}

/** Per-process state on globalThis, so the limits hold across the reload they caused. */
export function sharedReloadState(): ReloadShared {
  const g = globalThis as { __piAgentLinkReload?: Partial<ReloadShared> };
  g.__piAgentLinkReload ??= {};
  g.__piAgentLinkReload.lastAcceptedAt ??= 0;
  g.__piAgentLinkReload.lastBulkAt ??= 0;
  return g.__piAgentLinkReload as ReloadShared;
}

/** A sender sends at most one *idle reload per this window. */
export const BULK_COOLDOWN_MS = 60_000;

/**
 * Claim the sender-side *idle cooldown: 0 when the bulk reload may go ahead
 * (and the window starts now), else the seconds left.
 */
export function claimBulkReload(shared: ReloadShared, now = Date.now(), ms = BULK_COOLDOWN_MS): number {
  const since = now - shared.lastBulkAt;
  if (shared.lastBulkAt && since < ms) return Math.ceil((ms - since) / 1000);
  shared.lastBulkAt = now;
  return 0;
}

/** How long a queued reload waits on something other than an agent run (a manual /compact, a dialog). */
export const RELOAD_WAIT_MS = 120_000;
/** A dispatched reload whose command hasn't run after this long is given up on. */
const INFLIGHT_MS = 10_000;
/** How often a waiting reload re-checks between events. */
export const RELOAD_POLL_MS = 1_000;

type Reply = (outcome: ReloadOutcome) => unknown;
interface Pending { force: boolean; who: string; waitingSince?: number; }

export class ReloadController {
  private host: ReloadHost;
  private shared: ReloadShared;
  private rateMs: number;
  private waitMs: number;
  private pollMs: number;
  /** A reload waiting for the session to be free (a busy target, or a self-reload). */
  private pending: Pending | undefined;
  /** The reload dispatched and not yet run by the reload command. */
  private inflight: { force: boolean; who: string; at: number } | undefined;
  /** "reloaded" answers owed to senders, paid just before ctx.reload() tears us down. */
  private owed: Reply[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(host: ReloadHost, opts: { shared?: ReloadShared; rateMs?: number; waitMs?: number; pollMs?: number } = {}) {
    this.host = host;
    this.shared = opts.shared ?? sharedReloadState();
    this.rateMs = opts.rateMs ?? RELOAD_RATE_MS;
    this.waitMs = opts.waitMs ?? RELOAD_WAIT_MS;
    this.pollMs = opts.pollMs ?? RELOAD_POLL_MS;
  }

  private now(): number { return this.host.now?.() ?? Date.now(); }

  private hasDraft(): boolean {
    try { return this.host.editorText().trim().length > 0; } catch { return false; }
  }

  /** Free to reload now: idle, and no dialog or agent-link command open. */
  private ready(): boolean {
    try { return this.host.isIdle() && !this.host.uiBusy?.(); } catch { return false; }
  }

  get isPending(): boolean { return this.pending !== undefined; }

  /**
   * A reload request from a peer. `reply` gets the outcome: at once for queued
   * and refused, and for "reloaded" from the reload command itself, right
   * before ctx.reload() runs (after it, this instance is gone).
   */
  request(o: { who: string; force?: boolean; reply: Reply }): void {
    const now = this.now();
    const since = now - this.shared.lastAcceptedAt;
    if (this.shared.lastAcceptedAt && since < this.rateMs) {
      const wait = Math.ceil((this.rateMs - since) / 1000);
      o.reply({ status: "refused", reason: `rate-limited (reloads at most once per ${Math.round(this.rateMs / 1000)}s; try again in ${wait}s)` });
      return;
    }
    if (!o.force && this.hasDraft()) {
      o.reply({ status: "refused", reason: EDITOR_REFUSAL });
      return;
    }
    // A dispatch the command never picked up (pi dropped it) mustn't swallow
    // every later request; its senders have long since timed out.
    if (this.inflight && now - this.inflight.at > INFLIGHT_MS) { this.inflight = undefined; this.owed = []; }
    // A reload is already on its way: this sender gets the same answer.
    if (this.inflight) { this.owed.push(o.reply); return; }
    if (this.ready()) {
      const waiting = this.clearPending();
      this.owed.push(o.reply);
      this.host.notify(`agent-link: reloading (requested by ${o.who})`);
      this.fire({ force: Boolean(o.force) || Boolean(waiting?.force), who: o.who });
      return;
    }
    this.queue(o.who, Boolean(o.force));
    this.host.notify(`agent-link: ${o.who} asked for a reload; it runs when this session is free`);
    o.reply({ status: "queued" });
  }

  /** The calling session reloads itself once the current response settles. */
  requestSelf(force = false): void {
    this.queue("this session", force);
  }

  private queue(who: string, force: boolean): void {
    this.pending = { force: force || Boolean(this.pending?.force), who: this.pending?.who ?? who };
    // An agent run ends in agent_settled. Anything else (a manual /compact, a
    // dialog) has no such event, so re-check on a timer until it clears.
    this.timer ??= setInterval(() => this.poll(), this.pollMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private clearPending(): Pending | undefined {
    const p = this.pending;
    this.pending = undefined;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    return p;
  }

  /**
   * Re-check a waiting reload: on the timer, and on events that may have freed
   * the session (session_compact, ui_prompt_end, a command finishing). A wait
   * not on an agent run expires after waitMs.
   */
  poll(): void {
    const p = this.pending;
    if (!p) return;
    if (this.inflight) {
      if (this.now() - this.inflight.at <= INFLIGHT_MS) return;
      this.inflight = undefined; this.owed = [];
    }
    if (this.host.isRunning()) { p.waitingSince = undefined; return; }
    if (this.ready()) { this.run(); return; }
    const now = this.now();
    p.waitingSince ??= now;
    if (now - p.waitingSince >= this.waitMs) {
      this.clearPending();
      this.host.notify(`agent-link: dropped the reload ${p.who} asked for: this session stayed busy for ${Math.round(this.waitMs / 1000)}s`, "warning");
    }
  }

  /** agent_settled: run a reload that was waiting on the turn, unless the user aborted it. */
  settled(aborted = false): void {
    const p = this.pending;
    if (!p) return;
    if (aborted && !p.force) {
      this.clearPending();
      this.host.notify(`agent-link: skipped the reload ${p.who} asked for: the run was aborted (force: true overrides)`, "warning");
      return;
    }
    this.poll();
  }

  private run(): void {
    const p = this.clearPending();
    if (!p) return;
    // The draft check ran when the request arrived, but the user may have
    // started typing since.
    if (!p.force && this.hasDraft()) {
      this.host.notify(`agent-link: skipped the reload ${p.who} asked for: there is unsent text in the editor`, "warning");
      return;
    }
    this.fire(p);
  }

  private fire(p: { force: boolean; who: string }): void {
    this.inflight = { force: p.force, who: p.who, at: this.now() };
    this.host.dispatch();
  }

  /**
   * Called by the reload command with ctx.isIdle(). Idle: start the rate-limit
   * window, pay the "reloaded" answers owed, and return true (go ahead with
   * ctx.reload()). Busy (the user started a turn or a compaction after the
   * dispatch): queue again, tell the waiting senders "queued", and return false.
   * With no reload dispatched (the command run by hand), it goes ahead only when
   * idle, with no dialog open and no unsent text, else refuses (nothing queued).
   */
  async beginReload(idle: boolean): Promise<boolean> {
    const inflight = this.inflight;
    this.inflight = undefined;
    const owed = this.owed;
    this.owed = [];
    if (!inflight) {
      // Nothing dispatched it: typed by hand, or sent by another extension (a phone's "/" list).
      // The same checks a dispatched reload passed first: idle, no dialog open, nothing typed.
      const refusal = this.byHandRefusal(idle);
      if (refusal) {
        await Promise.allSettled(owed.map(async (send) => send({ status: "refused", reason: refusal })));
        this.host.notify(`agent-link: not reloading: ${refusal}; use /reload yourself`, "warning");
        return false;
      }
    } else if (!idle) {
      this.queue(inflight.who, inflight.force);
      await Promise.allSettled(owed.map(async (send) => send({ status: "queued" })));
      return false;
    }
    this.shared.lastAcceptedAt = this.now();
    await Promise.allSettled(owed.map(async (send) => send({ status: "reloaded" })));
    return true;
  }

  /** Why a reload no request dispatched can't run now, or undefined when it can. */
  private byHandRefusal(idle: boolean): string | undefined {
    if (!idle) return "this session is busy";
    let dialog = false;
    try { dialog = this.host.uiBusy?.() === true; } catch { dialog = true; }
    if (dialog) return "a dialog is open";
    if (this.hasDraft()) return "there is unsent text in the editor";
    return undefined;
  }

  /** Stop the re-check timer (session_shutdown). */
  dispose(): void { this.clearPending(); }
}
