// Remote reload: one session asks another to run pi's /reload.
//
// Sending "/reload" as a chat message does nothing useful: the receiving model
// sees text and can't run slash commands. Instead the sender writes a control
// frame ({type:"control", action:"reload"}) that the target's agent-link
// handles itself, so the target's model never sees it. The target reloads by
// dispatching its own command (RELOAD_COMMAND), whose handler calls
// ctx.reload(): pi only reloads from a command context, and never mid-run, so
// a busy target waits for agent_settled.
//
// This module is the decision logic, kept free of pi and sockets so it can be
// tested directly; index.ts wires it to the transport and pi's events.

/** The command a reload is dispatched through. */
export const RELOAD_COMMAND = "agent-link-reload";
/** At most one accepted reload request per target in this window. */
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
  if (o.status === "queued") return "queued (busy, reloads when the turn ends)";
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

export interface ReloadHost {
  /** True when pi is not running an agent turn (ctx.isIdle()). */
  isIdle(): boolean;
  /** What the user has typed but not sent; "" when unknown (RPC, no UI). */
  editorText(): string;
  /** Run RELOAD_COMMAND as a command (sendUserMessage with expandPromptTemplates). */
  dispatch(): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  now?(): number;
}

/** State that has to outlive a reload: the extension instance itself is replaced. */
export interface ReloadShared { lastAcceptedAt: number; }

/** Per-process state on globalThis, so the rate limit holds across the reload it caused. */
export function sharedReloadState(): ReloadShared {
  const g = globalThis as { __piAgentLinkReload?: ReloadShared };
  g.__piAgentLinkReload ??= { lastAcceptedAt: 0 };
  return g.__piAgentLinkReload;
}

type Reply = (outcome: ReloadOutcome) => unknown;

export class ReloadController {
  private host: ReloadHost;
  private shared: ReloadShared;
  private rateMs: number;
  /** A reload waiting for agent_settled (a busy target, or a self-reload). */
  private pending: { force: boolean; who: string } | undefined;
  /** "reloaded" answers owed to senders, sent just before ctx.reload() tears us down. */
  private owed: Array<() => unknown> = [];

  constructor(host: ReloadHost, opts: { shared?: ReloadShared; rateMs?: number } = {}) {
    this.host = host;
    this.shared = opts.shared ?? sharedReloadState();
    this.rateMs = opts.rateMs ?? RELOAD_RATE_MS;
  }

  private now(): number { return this.host.now?.() ?? Date.now(); }

  private hasDraft(): boolean {
    try { return this.host.editorText().trim().length > 0; } catch { return false; }
  }

  get isPending(): boolean { return this.pending !== undefined; }

  /**
   * A reload request from a peer. `reply` gets the outcome: at once for queued
   * and refused, and for "reloaded" from the reload command itself, before
   * ctx.reload() runs (after it, this instance is gone).
   */
  request(o: { who: string; force?: boolean; reply: Reply }): void {
    const now = this.now();
    const since = now - this.shared.lastAcceptedAt;
    if (this.shared.lastAcceptedAt && since < this.rateMs) {
      const wait = Math.ceil((this.rateMs - since) / 1000);
      o.reply({ status: "refused", reason: `rate-limited (at most one reload request per ${Math.round(this.rateMs / 1000)}s; try again in ${wait}s)` });
      return;
    }
    if (!o.force && this.hasDraft()) {
      o.reply({ status: "refused", reason: EDITOR_REFUSAL });
      return;
    }
    this.shared.lastAcceptedAt = now;
    if (this.host.isIdle()) {
      this.owed.push(() => o.reply({ status: "reloaded" }));
      this.host.notify(`agent-link: reloading (requested by ${o.who})`);
      this.host.dispatch();
      return;
    }
    this.pending = { force: Boolean(o.force) || Boolean(this.pending?.force), who: o.who };
    this.host.notify(`agent-link: ${o.who} asked for a reload; it runs when this turn ends`);
    o.reply({ status: "queued" });
  }

  /** The calling session reloads itself once the current response settles. */
  requestSelf(force = false): void {
    this.pending = { force: force || Boolean(this.pending?.force), who: "this session" };
  }

  /** agent_settled: run a reload that was waiting on the turn. */
  settled(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    // The draft check ran when the request arrived, but the user may have
    // started typing during the turn.
    if (!p.force && this.hasDraft()) {
      this.host.notify(`agent-link: skipped the reload ${p.who} asked for: there is unsent text in the editor`, "warning");
      return;
    }
    this.host.dispatch();
  }

  /** Called by the reload command right before ctx.reload(): pay the answers owed. */
  async beforeReload(): Promise<void> {
    const owed = this.owed;
    this.owed = [];
    await Promise.allSettled(owed.map(async (send) => send()));
  }
}
