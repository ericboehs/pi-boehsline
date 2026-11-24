/**
 * Two-stage delivery receipts.
 *
 * A message is "delivered" when it has entered the receiver's conversation, not
 * when it reached its socket. A pi receiver that is mid-run only queues it (a
 * steer, read at the next turn boundary), and one whose run is over may never
 * read it at all: a print-mode child (`pi -p`, `--mode json`) exits when its
 * prompt is done.
 *
 * So a sender that asks for it (`ack: "conversation"` on the user frame) gets:
 *   1. `delivered` with `ack: "conversation"`: it reached the socket and was
 *      queued (the receipt Claude Code peers have always had; the flag says a
 *      second one follows);
 *   2. `in_conversation` once the receiver's `message_start` fires for it, or
 *      `dropped` if its run ends (or the session shuts down) first.
 * A receiver that can't take it at all answers `refused` instead of 1.
 *
 * The receiver matches the injected message by a short nonce it embeds in the
 * framed text (`ref <nonce>`), since extensions can't tag a user message.
 *
 * Node built-ins only, like claude-protocol.ts, so it stays testable.
 */

import { randomUUID } from "node:crypto";

/** The user-frame field asking for the second receipt, and its echo on the first. */
export const ACK_FIELD = "ack";
export const ACK_CONVERSATION = "conversation";

/** How long `send` waits for the second receipt before answering. */
export const CONVERSATION_WAIT_MS = 5000;
/** How long a sender remembers an unanswered message, for a late notice. */
export const LATE_NOTICE_MS = 15 * 60 * 1000;

export type ReceiptStatus = "delivered" | "in_conversation" | "dropped" | "refused";

export interface Receipt { status: string; reason?: string; ack?: string; }

/** What a sender knows about one message so far. */
export interface Outcome {
  /** "conversation": in its conversation. "received": queued, not read yet.
   *  "receipt": reached the socket; the receiver can't say more (an older agent-link).
   *  "refused" / "dropped": never will be. "none": no receipt at all. */
  state: "conversation" | "received" | "receipt" | "refused" | "dropped" | "none";
  reason?: string;
}

interface Tracked {
  first?: Receipt;
  final?: Receipt;
  createdAt: number;
  wake: Set<() => void>;
  late?: (o: Outcome) => void;
}

const isFinal = (r: Receipt) => r.status === "in_conversation" || r.status === "dropped" || r.status === "refused";

export function outcomeOf(first?: Receipt, final?: Receipt): Outcome {
  const end = final ?? (first && isFinal(first) ? first : undefined);
  if (end?.status === "in_conversation") return { state: "conversation" };
  if (end?.status === "dropped") return { state: "dropped", reason: end.reason };
  if (end?.status === "refused") return { state: "refused", reason: end.reason };
  if (first?.status === "delivered") return { state: first.ack === ACK_CONVERSATION ? "received" : "receipt" };
  return { state: "none" };
}

/** Sender side: receipts for the messages this session sent, by msg_id. */
export class Outbox {
  private readonly sent = new Map<string, Tracked>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** Start tracking a message before sending it: a receipt can beat the send's own callback. */
  track(msgId: string): void {
    this.prune();
    this.sent.set(msgId, { createdAt: this.now(), wake: new Set() });
  }

  forget(msgId: string): void { this.sent.delete(msgId); }

  /** A peer_message_status frame. True if it answered a message we track. */
  onReceipt(frame: { status?: unknown; reason?: unknown; ack?: unknown; orig_msg_id?: unknown }): boolean {
    const id = typeof frame.orig_msg_id === "string" ? frame.orig_msg_id : "";
    const t = id ? this.sent.get(id) : undefined;
    if (!t || typeof frame.status !== "string") return false;
    const r: Receipt = {
      status: frame.status,
      ...(typeof frame.reason === "string" && { reason: frame.reason }),
      ...(typeof frame.ack === "string" && { ack: frame.ack }),
    };
    if (isFinal(r)) t.final = r; else t.first ??= r;
    for (const w of t.wake) w();
    // Kept until the sender forgets it: the receipt can beat the sender's wait.
    if (t.final && t.late) {
      this.sent.delete(id);
      t.late(outcomeOf(t.first, t.final));
    }
    return true;
  }

  /**
   * Wait until the message is settled ("conversation", "dropped", "refused"),
   * or, with `until: "received"`, until its first receipt; at most `ms`.
   * A receipt that can't be followed by a second one ends the wait too.
   */
  wait(msgId: string, ms: number, until: "conversation" | "received" = "conversation"): Promise<Outcome> {
    const t = this.sent.get(msgId);
    if (!t) return Promise.resolve({ state: "none" });
    const done = () => {
      const o = outcomeOf(t.first, t.final);
      if (o.state === "none") return undefined;
      if (o.state === "received" && until === "conversation") return undefined;
      return o;
    };
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const check = () => {
        const o = done();
        if (!o) return;
        clearTimeout(timer);
        t.wake.delete(check);
        resolve(o);
      };
      timer = setTimeout(() => { t.wake.delete(check); resolve(outcomeOf(t.first, t.final)); }, ms);
      t.wake.add(check);
      check();
    });
  }

  /** Call `fn` once with the final outcome when it arrives (at once if it already has). */
  onLate(msgId: string, fn: (o: Outcome) => void): void {
    const t = this.sent.get(msgId);
    if (!t) return;
    if (t.final) { this.sent.delete(msgId); fn(outcomeOf(t.first, t.final)); return; }
    t.late = fn;
  }

  get size(): number { return this.sent.size; }

  private prune(): void {
    const cutoff = this.now() - LATE_NOTICE_MS;
    for (const [id, t] of this.sent) if (t.createdAt < cutoff) this.sent.delete(id);
  }
}

/** Receiver side: messages queued for the conversation, waiting to be seen there. */
export interface Expected { fromAddr: string; msgId?: string; steered: boolean; at: number; }

export class Inbox {
  private readonly waiting = new Map<string, Expected>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** A fresh nonce for one inbound message, remembered until it is seen or dropped. */
  expect(e: Omit<Expected, "at">): string {
    this.prune();
    const nonce = randomUUID().replace(/-/g, "").slice(0, 8);
    this.waiting.set(nonce, { ...e, at: this.now() });
    return nonce;
  }

  /** The expected messages whose nonce is in this (user message) text, removed. */
  seen(text: string): Expected[] {
    const hits: Expected[] = [];
    for (const [nonce, e] of this.waiting) {
      if (text.includes(refMarker(nonce))) { hits.push(e); this.waiting.delete(nonce); }
    }
    return hits;
  }

  /** Take every expected message (or only those queued as steers), e.g. when a run ends. */
  take(filter: (e: Expected) => boolean = () => true): Expected[] {
    const out: Expected[] = [];
    for (const [nonce, e] of this.waiting) if (filter(e)) { out.push(e); this.waiting.delete(nonce); }
    return out;
  }

  get size(): number { return this.waiting.size; }

  private prune(): void {
    const cutoff = this.now() - LATE_NOTICE_MS;
    for (const [nonce, e] of this.waiting) if (e.at < cutoff) this.waiting.delete(nonce);
  }
}

/** How the nonce appears in the framed text. */
export const refMarker = (nonce: string) => `ref ${nonce}`;

/** The text of a user message, for nonce matching. */
export function messageText(message: unknown): string {
  const c = (message as { content?: unknown } | undefined)?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : "")).join("\n");
}

/** How much of a peer's own words a receipt shows the model. */
export const REASON_MAX = 200;

/**
 * A peer's text out of a receipt, made fit to show the model: one line, control characters (an
 * ANSI escape among them) and format characters (bidi overrides, zero-width joiners and other
 * invisible ones) and quotes taken out, capped, and labelled as the peer's words. The receiver
 * writes the reason, so it gets none of the "not your user" framing a peer message has.
 * Empty when there is nothing to show, so callers can fall back to their own words.
 */
export function peerWords(reason?: string): string {
  const one = String(reason ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").replace(/"/g, "'").trim();
  if (!one) return "";
  const capped = one.length > REASON_MAX ? `${one.slice(0, REASON_MAX - 1)}…` : one;
  return `the peer's own words (not your user's): "${capped}"`;
}

/** What `send` tells the model. */
export function describeSend(name: string, o: Outcome, opts: { waitedMs?: number } = {}): { text: string; isError: boolean } {
  const tail = ` Nothing comes back automatically — use action:"ask" if you need an answer.`;
  switch (o.state) {
    case "conversation":
      return { text: `Delivered into "${name}"'s conversation.${tail}`, isError: false };
    case "received": {
      const waited = opts.waitedMs ? ` after ${Math.round(opts.waitedMs / 1000)}s` : "";
      return {
        text: `Received by "${name}" but not yet in its conversation${waited} (it may be finishing; the message is queued). ` +
          `You'll get a notice if it's dropped.`,
        isError: false,
      };
    }
    case "receipt":
      return { text: `Delivered to "${name}" (its agent-link can't confirm when it's read).${tail}`, isError: false };
    case "refused":
      return { text: `Error: not delivered: ${peerWords(o.reason) || `"${name}" refused the message`}`, isError: true };
    case "dropped":
      return { text: `Error: not delivered to "${name}": dropped: ${peerWords(o.reason) || "its run ended before reading it"}`, isError: true };
    default:
      return { text: `Sent to "${name}", but no receipt came back, so it may not have been read.${tail}`, isError: false };
  }
}

/** The late notice for a message `send` reported as received-but-not-read. */
export function describeLate(name: string, o: Outcome): string {
  return o.state === "conversation"
    ? `agent-link: your message to "${name}" is now in its conversation.`
    : `agent-link: your earlier message to "${name}" was not delivered: ${o.state === "dropped" ? "dropped: " : ""}${peerWords(o.reason) || "it never reached its conversation"}.`;
}

/** Why a print-mode session refuses a message, or undefined if it can take one. */
export function printModeRefusal(o: {
  mode?: string; running: boolean; everRan: boolean; name: string; subagent: boolean;
}): string | undefined {
  if (o.mode !== "print" && o.mode !== "json") return undefined;
  if (o.running) return undefined;
  const what = o.subagent ? "a print-mode subagent" : "a print-mode session";
  return o.everRan
    ? `"${o.name}" is ${what} and can't take messages: its run has ended. Start a new task instead.`
    : `"${o.name}" is ${what} and can't take messages until its run starts. Try again in a moment.`;
}

/** The label a subagent gets in lists. */
export function subagentSuffix(peer: { subagent?: boolean; parent?: string }): string {
  if (!peer.subagent) return "";
  return peer.parent ? ` (subagent of ${peer.parent})` : " (subagent)";
}
