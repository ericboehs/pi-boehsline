/**
 * pi-agent-link — mesh a pi coding-agent session with Claude Code.
 *
 * On session start this extension registers the pi session as a peer in Claude's
 * cross-session registry (so it appears in Claude's /list-agents) and binds a
 * socket that speaks Claude's wire protocol. Inbound messages from Claude are
 * injected into the live pi session in real time; the pi model can list and
 * message agent sessions via the `agent-link` tool.
 *
 * Runs in-process; no daemon, no external transport — Claude's registry is the hub.
 */

import type { AgentEndEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ccSocksDir, bindSocketOrPrivate, registerPeer, updatePeer, deregisterPeer, deregisterPeerSync,
  firstFreeName, losesNameRace,
  listClaudeSessions, resolveTarget, sendToClaude, stripEnvelope, receiptFrame, sendFrame,
  peerLabel, listLabel, planDedupe, renamePeer,
  shouldArmReply, frameInbound, REPLY_MODE, ASK_MODE,
  slugFromCwd, peerNameBySock, HOME,
} from "./claude-protocol.ts";
import {
  extractAtQuery, isPathishQuery, filterPeers, findAgentMentions,
  mentionHint, formatAgentItem, isInboundPeerPrompt,
} from "./mentions.ts";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { activateToolSearch } from "../../lib/tool-search.ts";
import {
  ReloadController, RELOAD_COMMAND, RELOAD_REPLY_TIMEOUT_MS, IDLE_TARGETS, BULK_COOLDOWN_MS,
  claimBulkReload, describeOutcome, outcomeFromFrame, parseReloadArgs, sharedReloadState, type ReloadOutcome,
} from "./reload.ts";
import { randomUUID } from "node:crypto";
import {
  ACK_CONVERSATION, ACK_FIELD, CONVERSATION_WAIT_MS, Inbox, Outbox, describeLate, describeSend,
  messageText, printModeRefusal, refMarker, type Outcome,
} from "./delivery.ts";

// Debug logging: enabled by env PI_AGENT_LINK_DEBUG or the sentinel /tmp/pi-agent-link-debug.on
// (pi may not propagate env to extensions in all modes, so the sentinel is handy).
const dbg = (...a: unknown[]) => {
  if (!(process.env.PI_AGENT_LINK_DEBUG || existsSync("/tmp/pi-agent-link-debug.on"))) return;
  try { appendFileSync("/tmp/pi-agent-link-debug.log", `[pi-agent-link ${new Date().toISOString()}] ${a.join(" ")}\n`); } catch { /* */ }
};

interface AskWaiter { resolve: (body: string | { dropped: string }) => void; timer: NodeJS.Timeout; }
interface PendingReply { hops: number; who: string; receivedAt: number; preview: string; }
/** The peer identity a reload carries over: the new instance would otherwise re-derive it. */
interface StashedIdentity { selfName: string; nameSource: "user" | "derived"; startedAt: number; }
const identityStash = (): Map<number, StashedIdentity> => {
  const g = globalThis as { __piAgentLinkIdentity?: Map<number, StashedIdentity> };
  return (g.__piAgentLinkIdentity ??= new Map());
};

export default function piMeshExtension(pi: ExtensionAPI) {
  let started = false;
  // start() runs off the boot path: session_start kicks it off without
  // awaiting (it binds a socket and probes every live peer for a free name,
  // ~60ms with a dozen sessions open). Anything that touches the peer record
  // awaits this first.
  let starting: Promise<void> | undefined;
  const ensureStarted = (ctx: ExtensionContext, reason?: string): Promise<void> => {
    if (!started) starting = start(ctx, reason);
    return starting ?? Promise.resolve();
  };
  let server: Server | undefined;
  let sockPath = "";
  let ownFrom = "";
  let selfName = "";
  let sessionCwd = "";
  const pid = process.pid;
  let lastCtx: ExtensionContext | undefined;

  const fallbackName = () => `pi-${slugFromCwd(sessionCwd || process.cwd())}`;

  // A subagent's child (extensions/subagent sets these): it registers under its
  // task title, marked as whose it is, and keeps that name for its whole run.
  const subagentTitle = process.env.PI_SUBAGENT_CHILD ? (process.env.PI_SUBAGENT_TITLE || "").trim() : "";
  const subagentParent = subagentTitle ? (process.env.PI_SUBAGENT_PARENT || "").trim() : "";
  const isPrintMode = (ctx?: ExtensionContext) => ctx?.mode === "print" || ctx?.mode === "json";

  // Derived names come from the directory, so every pi in one checkout wants
  // the same one. Claim the first free slot instead of shipping a duplicate.
  let startedAt = Date.now();
  let nameSource: "user" | "derived" = "derived";
  const liveNames = async (): Promise<string[]> =>
    (await listClaudeSessions({ excludeSock: sockPath })).map((r) => r.name);

  /**
   * Two pis starting in the same instant can claim the same slot, so re-check
   * after registering: the oldest keeps the name (pid breaks ties) and the
   * others move on. Both sides read the same registry values, so exactly one
   * winner emerges per round and the loop converges.
   */
  async function settleNameRace(): Promise<void> {
    for (let attempt = 0; attempt < 5 && nameSource === "derived"; attempt++) {
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
      const rows = await listClaudeSessions({ excludeSock: sockPath });
      const rivals = rows.filter((r) => r.name === selfName);
      if (!rivals.some((rival) => losesNameRace({ startedAt, pid }, rival))) return;
      selfName = firstFreeName(fallbackName(), rows.map((r) => r.name));
      await updatePeer(pid, { name: selfName, nameSource: "derived" }).catch(() => {});
      syncSummaryFile();
      dbg(`yielded a contested name, now ${selfName}`);
    }
  }

  // Apply a (possibly cleared) pi session name to our peer identity. Once we've
  // registered, push it to Claude's registry so /list-agents updates live.
  async function applyName(name?: string): Promise<void> {
    if (subagentTitle) return; // a subagent child's name is its task title
    const trimmed = (name || "").trim();
    // A name the user chose is theirs verbatim; only derived names get suffixed.
    const next = trimmed || firstFreeName(fallbackName(), started ? await liveNames() : []);
    if (next === selfName) return;
    selfName = next;
    nameSource = trimmed ? "user" : "derived";
    if (started) {
      await updatePeer(pid, { name: selfName, nameSource }).catch(() => {});
      syncSummaryFile();
      dbg(`renamed peer to ${selfName}`);
      if (nameSource === "derived") await settleNameRace();
    }
  }

  // Senders blocked in `ask`, with enough metadata for `pending` and `reply`.
  const pendingReplies = new Map<string, PendingReply>();
  // Blocking `ask` waiters, keyed by the target's socket path.
  const askWaiters = new Map<string, AskWaiter[]>();
  let peerStatus = "idle";
  const activeTools = new Map<string, string>();

  async function setPeerStatus(status: string): Promise<void> {
    await starting;
    if (!started || status === peerStatus) return;
    peerStatus = status;
    syncSummaryFile();
    await updatePeer(pid, { status }).catch(() => {});
  }

  // ---- shared-cache mirror (for psst; ~/.claude stays Claude's) -------------
  // psst must not read ~/.claude (guarded on this machine), so we mirror the
  // name/status into a neutral cache file that psst can read.
  // Same layout root both sides: $XDG_CACHE_HOME/agent-link/summaries | ~/.cache/…
  function summaryCacheDir(): string {
    const base = process.env.XDG_CACHE_HOME || path.join(HOME, ".cache");
    return path.join(base, "agent-link", "summaries");
  }
  const summaryFile = () => path.join(summaryCacheDir(), `${pid}.json`);

  function syncSummaryFile(): void {
    if (!started) return;
    try {
      mkdirSync(summaryCacheDir(), { recursive: true });
      // sessionFile lets psst pair this pid with its transcript exactly;
      // several pi processes in one cwd are otherwise ambiguous.
      let sessionFile: string | undefined;
      try { sessionFile = lastCtx?.sessionManager.getSessionFile() || undefined; } catch { /* stale ctx */ }
      const body = JSON.stringify({
        pid, name: selfName, cwd: sessionCwd, status: peerStatus, sessionFile,
        updatedAt: Date.now(),
      });
      // Atomic write (tmp + rename) so readers never see a torn file.
      const tmp = `${summaryFile()}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, summaryFile());
    } catch { /* best effort */ }
  }

  function clearSummaryFile(): void {
    try { unlinkSync(summaryFile()); } catch { /* */ }
  }

  const notify = (m: string, level: "info" | "warning" | "error" = "info") => {
    try { lastCtx?.ui.notify(m, level); } catch { /* no UI */ }
  };

  // Live peers for @ autocomplete and @mention hints. Socket probes are not
  // free, so keep a short TTL rather than hitting the registry on every key.
  const PEER_CACHE_MS = 2000;
  let peerCache: { at: number; rows: Awaited<ReturnType<typeof listClaudeSessions>> } | undefined;
  async function cachedPeers() {
    if (peerCache && Date.now() - peerCache.at < PEER_CACHE_MS) return peerCache.rows;
    const rows = await listClaudeSessions({ excludeSock: sockPath });
    peerCache = { at: Date.now(), rows };
    return rows;
  }

  function installAutocomplete(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["@"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const currentLine = lines[cursorLine] ?? "";
        const textBeforeCursor = currentLine.slice(0, cursorCol);
        const at = extractAtQuery(textBeforeCursor);
        if (!at || isPathishQuery(at.query)) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const [files, peers] = await Promise.all([
          current.getSuggestions(lines, cursorLine, cursorCol, options),
          cachedPeers().catch(() => []),
        ]);
        if (options.signal.aborted) return files;

        const agents = filterPeers(peers, at.query).slice(0, 8).map((p) => formatAgentItem(p, HOME));
        if (!agents.length) return files;
        return {
          prefix: files?.prefix ?? at.prefix,
          items: [...agents, ...(files?.items ?? [])],
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  }

  // ---- inbound: a peer frame arrived on our socket -------------------------
  // The agent-link tool is deferred (no context cost in sessions that never
  // talk to a peer). It's activated, and stays active, the moment it's needed:
  // an @mention in the prompt or a message from a peer. tool_search can also
  // find it, so it's turned on below for prompts that ask without an @name.
  function activateTool(): void {
    const active = pi.getActiveTools();
    if (!active.includes("agent-link")) pi.setActiveTools([...active, "agent-link"]);
  }

  // ---- remote reload (see reload.ts) ----------------------------------------
  // Between agent_start and agent_settled. A busy session outside a run (a
  // manual /compact) has no agent_settled to wait for.
  let runActive = false;
  // A blocking extension dialog (any extension's ctx.ui.select/confirm/input/
  // editor/custom, via ui_prompt_start/end) or one of our own commands is open.
  // Reloading then would tear the dialog down under its handler. Other
  // extensions' commands that are busy without a dialog can't be seen.
  let uiPromptOpen = false;
  let ownCommands = 0;
  const reloads = new ReloadController({
    isIdle: () => lastCtx?.isIdle?.() ?? true,
    isRunning: () => runActive,
    uiBusy: () => uiPromptOpen || ownCommands > 0,
    editorText: () => (lastCtx?.hasUI ? lastCtx.ui.getEditorText?.() ?? "" : ""),
    // A command, not a chat message: expandPromptTemplates makes pi run the
    // extension command, so nothing reaches the transcript or the model.
    dispatch: () => pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true }),
    notify: (m, level) => notify(m, level),
  });
  // Senders waiting on a reload_result, keyed by request id.
  const reloadWaiters = new Map<string, (outcome: ReloadOutcome) => void>();

  /**
   * A peer asks us to reload. Only registered, live peers are answered: the
   * socket is 0600 in a directory bindSocket has checked is ours and 0700, so
   * the sender already runs as this user, and the reply address must belong to
   * a session in the registry, so a frame can't make us write to an arbitrary
   * socket. A same-user process can still name another peer's socket as
   * `from`; that only sends the answer to that peer (accepted: see SECURITY.md).
   */
  function onReloadRequest(frame: any): void {
    const fromAddr = typeof frame.from === "string" ? frame.from : "";
    const sock = fromAddr.startsWith("uds:") ? fromAddr.slice(4) : "";
    const who = sock && sock !== sockPath ? peerNameBySock(sock) : undefined;
    if (!who) { dbg(`reload request dropped: sender ${fromAddr || "(none)"} is not a registered peer`); return; }
    const reqId = typeof frame.req_id === "string" ? frame.req_id : undefined;
    dbg(`reload requested by ${who} force=${frame.force === true}`);
    reloads.request({
      who,
      force: frame.force === true,
      reply: (outcome) => sendFrame(sock, {
        type: "control", action: "reload_result", req_id: reqId, from: ownFrom, name: selfName, ...outcome,
      }).catch((e) => dbg(`reload reply to ${who} failed: ${(e as Error).message}`)),
    });
  }

  /** Ask one peer to reload and wait for its answer. */
  async function reloadPeer(target: { sock: string; name: string; entrypoint?: string }, force: boolean): Promise<ReloadOutcome> {
    if (target.entrypoint && target.entrypoint !== "pi") {
      return { status: "refused", reason: "not a pi session (only pi sessions running agent-link can be reloaded)" };
    }
    const reqId = randomUUID();
    const answer = new Promise<ReloadOutcome>((resolve) => {
      const timer = setTimeout(() => {
        reloadWaiters.delete(reqId);
        resolve({ status: "refused", reason: `no answer within ${RELOAD_REPLY_TIMEOUT_MS / 1000}s (its agent-link may predate reload)` });
      }, RELOAD_REPLY_TIMEOUT_MS);
      reloadWaiters.set(reqId, (o) => { clearTimeout(timer); reloadWaiters.delete(reqId); resolve(o); });
    });
    try {
      await sendFrame(target.sock, { type: "control", action: "reload", req_id: reqId, from: ownFrom, fromName: selfName, force });
    } catch (e) {
      reloadWaiters.get(reqId)?.({ status: "refused", reason: `could not reach it: ${(e as Error).message}` });
    }
    return answer;
  }

  /** The tool's and /agent-link's reload: one target, or every idle pi session. */
  async function reloadTargets(to: string, force: boolean): Promise<{ text: string; isError: boolean }> {
    await starting;
    if (!started) return { text: "Error: agent-link is not running in this session.", isError: true };
    if (to === IDLE_TARGETS) {
      const rows = await listClaudeSessions({ excludeSock: sockPath });
      const idle = rows.filter((r) => r.entrypoint === "pi" && r.status === "idle");
      if (!idle.length) return { text: "No other idle pi sessions to reload.", isError: false };
      // A looping or prompt-injected model could otherwise keep every idle
      // session reloading: the targets' limits are per target, not per sender.
      const wait = claimBulkReload(sharedReloadState(), Date.now());
      if (wait) return { text: `Error: ${IDLE_TARGETS} reloads at most once per ${BULK_COOLDOWN_MS / 1000}s from one session; try again in ${wait}s.`, isError: true };
      const outcomes = await Promise.all(idle.map((r) => reloadPeer(r, force)));
      const lines = idle.map((r, i) => `- ${peerLabel(r, rows)}: ${describeOutcome(outcomes[i]!)}`);
      return { text: `Reload of ${idle.length} idle session(s):\n${lines.join("\n")}`, isError: false };
    }
    const res = await resolveTarget(to, { excludeSock: sockPath });
    if (res.error) {
      const hint = res.candidates?.length ? ` Available: ${res.candidates.join(", ")}.` : "";
      return { text: `Error: ${res.error}.${hint}`, isError: true };
    }
    const outcome = await reloadPeer(res.target!, force);
    return { text: `"${res.target!.name}": ${describeOutcome(outcome)}`, isError: outcome.status === "refused" };
  }

  function onFrame(frame: any): void {
    if (frame?.type === "control" && frame.action === "reload") { onReloadRequest(frame); return; }
    if (frame?.type === "control" && frame.action === "reload_result") {
      const waiter = typeof frame.req_id === "string" ? reloadWaiters.get(frame.req_id) : undefined;
      waiter?.(outcomeFromFrame(frame));
      return;
    }
    if (frame?.type === "control" && frame.action === "peer_message_status") {
      outbox.onReceipt(frame);
      return;
    }
    if (frame?.type === "control" && frame.action === "rename" && typeof frame.name === "string") {
      if (subagentTitle) return; // keeps its task title
      selfName = frame.name;
      updatePeer(pid, { name: frame.name }).catch(() => {});
      syncSummaryFile();
      return;
    }
    if (frame?.type !== "user") return;
    const raw = frame.message?.content;
    if (typeof raw !== "string" || !raw) return;

    const env = stripEnvelope(raw);
    const fromAddr: string = frame.from || env.from || "";
    const targetSock = fromAddr.startsWith("uds:") ? fromAddr.slice(4) : "";
    // Prefer the registry name (matches Claude's /list-agents) over the envelope
    // from-name, which can be a stale/verbose session title.
    const who = peerNameBySock(targetSock) || env.fromName || targetSock || fromAddr || "another agent";

    // If this is the reply to a blocking `ask`, resolve the waiter instead of injecting.
    const waiters = targetSock ? askWaiters.get(targetSock) : undefined;
    if (waiters && waiters.length) {
      const w = waiters.shift()!;
      clearTimeout(w.timer);
      if (!waiters.length) askWaiters.delete(targetSock);
      w.resolve(env.body);
      ackDelivered(fromAddr, frame.msg_id);
      return;
    }

    const idle = lastCtx?.isIdle?.() ?? true;
    // A print-mode session (a subagent's child, say) reads a steer at its next
    // turn boundary while its run lasts. Outside the run there is no turn to
    // read it: a message sent before the run would collide with its prompt, and
    // one after it would start a run that the exiting process cuts off.
    const refusal = printModeRefusal({ mode: lastCtx?.mode, running: !idle, everRan: runEverStarted, name: selfName, subagent: !!subagentTitle });
    if (refusal) {
      dbg(`refused inbound from ${who}: ${refusal}`);
      receipt(fromAddr, { status: "refused", origMsgId: frame.msg_id, reason: refusal });
      return;
    }

    // Normal inbound: inject into the live pi session (real-time).
    activateTool();
    // A sender that asked gets a second receipt once this is in our conversation (delivery.ts).
    const wantsAck = frame[ACK_FIELD] === ACK_CONVERSATION;
    const nonce = wantsAck ? inbox.expect({ fromAddr, msgId: frame.msg_id, steered: !idle }) : undefined;
    const framed = frameInbound({ who, body: env.body, fromMode: env.fromMode, ref: nonce && refMarker(nonce) });

    dbg(`inbound from ${who} (${fromAddr}) idle=${idle}: ${env.body.slice(0, 60)}`);
    try {
      // sendUserMessage always triggers a turn; when busy, steer into the current one.
      pi.sendUserMessage(framed, idle ? undefined : { deliverAs: "steer" });
      // Only a blocked `ask` earns an automatic answer. A plain send is
      // fire-and-forget: without this, our report to our own user gets
      // scraped and delivered to the peer as though it were a message.
      if (shouldArmReply(fromAddr, env.fromMode, env.hops)) {
        pendingReplies.set(fromAddr, {
          hops: (env.hops ?? 0) + 1,
          who,
          receivedAt: Date.now(),
          preview: env.body.replace(/\s+/g, " ").trim().slice(0, 80),
        });
      }
      ackDelivered(fromAddr, frame.msg_id, wantsAck);
      notify(`agent-link: message from ${who}`, "info");
    } catch (e) { dbg(`inject failed: ${(e as Error).message}`); }
  }

  function receipt(fromAddr: string, o: { status: string; origMsgId?: string; reason?: string; ack?: string }): Promise<unknown> {
    if (typeof fromAddr !== "string" || !fromAddr.startsWith("uds:")) return Promise.resolve();
    return sendFrame(fromAddr.slice(4), receiptFrame({ ...o, from: ownFrom })).catch(() => {});
  }

  /** The first receipt: it reached us and is queued. `ack` promises the second (delivery.ts). */
  function ackDelivered(fromAddr: string, origMsgId?: string, twoStage = false) {
    void receipt(fromAddr, {
      status: "delivered", origMsgId,
      reason: "Delivered to the pi session.",
      ...(twoStage && { ack: ACK_CONVERSATION }),
    });
  }

  // ---- delivery receipts (delivery.ts) --------------------------------------
  // Ours, sent: receipts by msg_id. Theirs, received: messages queued for our
  // conversation, matched by their ref when message_start fires for them.
  const outbox = new Outbox();
  const inbox = new Inbox();
  let runEverStarted = false;
  /** When the last run began (ms): a message queued before it that was never seen is stale. */
  let runStartedAt = 0;
  const DROPPED_RUN = "its run ended before the message reached its conversation";

  function dropExpected(reason: string, filter?: Parameters<Inbox["take"]>[0]): Promise<unknown> {
    return Promise.all(inbox.take(filter).map((e) => receipt(e.fromAddr, { status: "dropped", origMsgId: e.msgId, reason })));
  }

  /** A message `send` reported as queued has now been read, or dropped. */
  function lateNotice(name: string, o: Outcome): void {
    const msg = describeLate(name, o);
    notify(msg, o.state === "conversation" ? "info" : "warning");
    if (o.state === "conversation") return;
    // The model was told it's queued: tell it, too, that it wasn't read.
    try {
      const idle = lastCtx?.isIdle?.() ?? true;
      pi.sendMessage({ customType: "agent-link-delivery", content: msg, display: true }, { deliverAs: idle ? "nextTurn" : "steer" });
    } catch (e) { dbg(`late notice failed: ${(e as Error).message}`); }
  }

  const ackWaitMs = () => Number(process.env.PI_AGENT_LINK_ACK_WAIT_MS) || CONVERSATION_WAIT_MS;

  /** Send one message; pi targets are asked for the two-stage receipt. */
  async function deliver(target: { sock: string; entrypoint?: string }, message: string, fromMode?: string): Promise<{ msgId: string; staged: boolean }> {
    const msgId = randomUUID();
    const staged = target.entrypoint === "pi";
    if (staged) outbox.track(msgId);
    try {
      await sendToClaude({ sock: target.sock, body: message, from: ownFrom, fromName: selfName, fromMode, msgId, ...(staged && { ack: ACK_CONVERSATION }) });
    } catch (e) {
      outbox.forget(msgId);
      throw e;
    }
    return { msgId, staged };
  }

  // ---- reply relay: after the pi turn answers, send its text back ----------
  function lastAssistantText(messages: AgentEndEvent["messages"]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i];
      if (!m || m.role !== "assistant") continue;
      const c = m.content;
      if (typeof c === "string") return c.trim() || undefined;
      if (Array.isArray(c)) {
        const t = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
        if (t) return t;
      }
    }
    return undefined;
  }

  function relayReply(event: AgentEndEvent) {
    if (!pendingReplies.size) return;
    const answer = lastAssistantText(event.messages || []);
    if (!answer) return;
    const targets = [...pendingReplies];
    pendingReplies.clear();
    dbg(`relaying reply to ${targets.length} sender(s): ${answer.slice(0, 60)}`);
    for (const [from, pending] of targets) {
      if (!from.startsWith("uds:")) continue;
      sendToClaude({
        sock: from.slice(4), body: answer, from: ownFrom, fromName: selfName,
        fromMode: REPLY_MODE, hops: pending.hops,
      }).catch(() => {});
    }
  }

  // ---- lifecycle -----------------------------------------------------------
  async function start(ctx: ExtensionContext, reason?: string) {
    lastCtx = ctx;
    if (started) return;
    started = true;
    sessionCwd = ctx.cwd || process.cwd();
    const cwd = sessionCwd;
    const sessionId = ctx.sessionManager.getSessionId() || undefined;
    sockPath = path.join(ccSocksDir(), `${pid}.sock`);
    ownFrom = `uds:${sockPath}`;
    const chosen = (pi.getSessionName() || "").trim();
    // A reload keeps the name it had (one set by dedupe or a rename frame
    // included) and its age, so a peer that grabbed the name in the gap yields.
    const stashed = identityStash().get(pid);
    identityStash().delete(pid);
    if (reason === "reload" && stashed && (!chosen || chosen === stashed.selfName)) {
      ({ selfName, nameSource, startedAt } = stashed);
    } else if (subagentTitle) {
      // Its title, as the parent's subagents list shows it; suffixed if a sibling has it.
      nameSource = "user";
      selfName = firstFreeName(subagentTitle, await liveNames());
    } else {
      nameSource = chosen ? "user" : "derived";
      selfName = chosen || firstFreeName(fallbackName(), await liveNames());
    }
    try {
      // Claude's socket dir, unless it's unsafe to bind in (shared with other users, say): then a
      // private one of ours, so agent-link still starts (without Claude's receipts).
      const bound = await bindSocketOrPrivate(sockPath, (frame) => onFrame(frame));
      server = bound.server;
      if (bound.refused) {
        sockPath = bound.sockPath;
        ownFrom = `uds:${sockPath}`;
        notify(`pi-agent-link: ${bound.refused}; using ${path.dirname(sockPath)} instead (Claude Code won't send delivery receipts there)`, "warning");
      }
      peerStatus = "idle";
      await registerPeer({
        pid, sessionId, name: selfName, cwd, sockPath, status: peerStatus, startedAt, nameSource,
        subagent: !!subagentTitle, parent: subagentParent || undefined, printMode: isPrintMode(ctx),
      });
      // session_shutdown cleans up a normal exit; this catches a hard one.
      // Once per process: a reload builds a new instance, and the path is the same.
      const g = globalThis as { __piAgentLinkExitHooked?: boolean };
      if (!g.__piAgentLinkExitHooked) {
        g.__piAgentLinkExitHooked = true;
        const exitSock = sockPath;
        process.once("exit", () => deregisterPeerSync(pid, exitSock));
      }
      syncSummaryFile();
      dbg(`started name=${selfName} pid=${pid} sock=${sockPath} session=${sessionId}`);
      if (nameSource === "derived") void settleNameRace();
      // Startup banner is off by default; opt in via env PI_AGENT_LINK_BANNER
      // or the sentinel /tmp/pi-agent-link-banner.on.
      if (process.env.PI_AGENT_LINK_BANNER || existsSync("/tmp/pi-agent-link-banner.on"))
        notify(`pi-agent-link active as "${selfName}" — reachable from Claude Code /list-agents`, "info");
    } catch (e) {
      started = false;
      notify(`pi-agent-link failed to start: ${(e as Error).message}`, "error");
    }
  }

  async function stop() {
    reloads.dispose();
    await dropExpected("the session shut down before the message reached its conversation");
    if (started) identityStash().set(pid, { selfName, nameSource, startedAt });
    try { server?.close(); } catch { /* */ }
    clearSummaryFile();
    await deregisterPeer(pid, sockPath).catch(() => {});
  }

  pi.on("session_start", async (event, ctx) => {
    lastCtx = ctx;
    // Already running (/new, /resume, /fork in the same process): refresh the
    // mirrored sessionFile so psst follows the switch.
    if (started) syncSummaryFile();
    void ensureStarted(ctx, (event as { reason?: string })?.reason);
    installAutocomplete(ctx);
  });
  // The tool is deferred, so tool_search must be active to find it.
  activateToolSearch(pi);
  // The subagent extension asks for our name (synchronously, like bg:start) to
  // tell its children whose subagents they are: PI_SUBAGENT_PARENT.
  pi.events?.on?.("agent-link:whoami", (req: unknown) => {
    if (req && typeof req === "object" && selfName) (req as { name?: string }).name = selfName;
  });
  pi.on("before_agent_start", async (event) => {
    const prompt = event.prompt || "";
    if (!prompt || isInboundPeerPrompt(prompt)) return;
    const peers = await cachedPeers().catch(() => []);
    if (!peers.length) return;
    const mentions = findAgentMentions(prompt, peers);
    if (!mentions.length) return;
    activateTool();
    // A hidden message for this run, not a replaced system prompt: a
    // replacement re-renders the prompt from base options, which differs from
    // the transcript's sections and busts the prompt cache on this turn and
    // the next. The message lands after the prompt, so the prefix stays cached.
    return { message: { customType: "agent-link-mentions", content: mentionHint(mentions), display: false } };
  });
  pi.on("turn_start", async (_e, ctx) => {
    lastCtx = ctx;
    const fresh = !started;
    await ensureStarted(ctx);
    // Catch a name that landed after session_start (e.g. --name applied late).
    if (!fresh) await applyName(pi.getSessionName() ?? undefined);
    await setPeerStatus("thinking");
  });
  pi.on("session_info_changed", async (event, ctx) => {
    lastCtx = ctx;
    await ensureStarted(ctx);
    await applyName((event as { name?: string })?.name);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    lastCtx = ctx;
    activeTools.set(event.toolCallId, event.toolName);
    await setPeerStatus(`tool:${event.toolName}`);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    lastCtx = ctx;
    activeTools.delete(event.toolCallId);
    const remaining = [...activeTools.values()].at(-1);
    await setPeerStatus(remaining ? `tool:${remaining}` : "thinking");
  });
  pi.on("agent_end", async (event, ctx) => {
    lastCtx = ctx;
    relayReply(event);
  });
  pi.on("agent_start", async () => { runActive = true; runEverStarted = true; runStartedAt = Date.now(); });
  // A queued message enters the conversation: tell its sender (delivery.ts).
  pi.on("message_start", async (event) => {
    const m = (event as { message?: { role?: string } }).message;
    if (m?.role !== "user" || !inbox.size) return;
    for (const e of inbox.seen(messageText(m))) {
      void receipt(e.fromAddr, { status: "in_conversation", origMsgId: e.msgId, reason: "In the pi session's conversation." });
    }
  });
  pi.on("agent_settled", async (event, ctx) => {
    lastCtx = ctx;
    runActive = false;
    // pi drains queued steers before a run settles, so one still waiting was
    // lost (an interrupted run puts it back in the editor). A print-mode run
    // is over for good: nothing it was sent will be read now.
    if (inbox.size) {
      if (isPrintMode(ctx)) void dropExpected(DROPPED_RUN);
      else if (!(ctx.hasPendingMessages?.() ?? false)) {
        // Also one queued before this run began and never shown (an extension
        // rewrote the message and its ref went with it): it is not coming.
        const startedAt = runStartedAt;
        void dropExpected(DROPPED_RUN, (e) => e.steered || e.at < startedAt);
      }
    }
    activeTools.clear();
    await setPeerStatus("idle");
    reloads.settled((event as { aborted?: boolean })?.aborted === true);
  });
  // A queued reload waiting on a compaction or a dialog re-checks when it ends.
  pi.on("session_compact", async () => { reloads.poll(); });
  pi.on("session_compact_failed", async () => { reloads.poll(); });
  pi.on("ui_prompt_start", async () => { uiPromptOpen = true; });
  pi.on("ui_prompt_end", async () => { uiPromptOpen = false; reloads.poll(); });
  pi.on("session_shutdown", async () => { await starting; await stop(); });

  // ---- outbound: the model-facing tool ------------------------------------
  const PARAMS = Type.Object({
    action: Type.Union([
      Type.Literal("list"), Type.Literal("send"), Type.Literal("ask"),
      Type.Literal("reply"), Type.Literal("pending"), Type.Literal("reload"),
    ], { description: "list sessions; send fire-and-forget; ask and wait; reply to a pending ask; list pending asks; reload a session (pi's /reload)" }),
    to: Type.Optional(Type.String({ description: `Target name or id; optional to disambiguate reply. For reload: omit to reload this session after the response, or "${IDLE_TARGETS}" for every idle session` })),
    message: Type.Optional(Type.String({ description: "Message text for send, ask, or reply" })),
    force: Type.Optional(Type.Boolean({ description: "reload only: reload even if the target has unsent text in its editor" })),
  });

  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: {}, ...(isError && { isError: true }) });

  pi.registerTool({
    name: "agent-link",
    label: "Agent Link",
    exposure: "deferred",
    description:
      "Talk to agent sessions running on this machine: list, send, ask and wait, " +
      "reply to a pending ask, list pending asks, or reload a session. When the user writes @name " +
      "(for example @foo), that addresses a live session — use this tool, not read. " +
      "To reload a session (pi's /reload, e.g. after extension changes) use action \"reload\": " +
      "sending the text \"/reload\" does nothing, the receiving model can't run slash commands.",
    promptSnippet: "Message other agent sessions on this machine. @name in the user prompt addresses a live session (use this tool, not read).",
    parameters: PARAMS,
    async execute(_id, params) {
      const excludeSock = sockPath;
      if (params.action === "list") {
        const rows = await listClaudeSessions({ excludeSock });
        if (!rows.length) return text("No live agent sessions found.");
        const lines = rows.map((r) => `- ${listLabel(r, rows)}  ·  ${r.cwd}  ·  ${r.status}`);
        const sessions = rows.map((r) => ({
          name: r.name, pid: r.pid, cwd: r.cwd, status: r.status, entrypoint: r.entrypoint,
          ...(r.subagent && { subagent: true, parent: r.parent }),
          ...(r.printMode && { printMode: true }),
        }));
        return { ...text(`Live sessions (${rows.length}):\n${lines.join("\n")}`), details: { sessions } };
      }
      if (params.action === "pending") {
        if (!pendingReplies.size) return text("No pending inbound asks.");
        const now = Date.now();
        const lines = [...pendingReplies.values()].map((p) => {
          const seconds = Math.max(0, Math.floor((now - p.receivedAt) / 1000));
          return `- ${p.who}  ·  ${seconds}s  ·  ${p.preview}`;
        });
        return text(`Pending asks (${lines.length}):\n${lines.join("\n")}`);
      }
      const to = String(params.to || "").trim();
      if (params.action === "reload") {
        const force = params.force === true;
        if (!to) {
          reloads.requestSelf(force);
          // terminate ends the run here, so the reload follows this response.
          return { ...text("Reload requested: this session reloads once this response ends."), terminate: true };
        }
        const result = await reloadTargets(to, force);
        return text(result.text, result.isError);
      }
      const message = String(params.message ?? "");
      if (!message) return text("Error: 'message' is required.", true);

      if (params.action === "reply") {
        let targetEntry: [string, PendingReply] | undefined;
        if (to) {
          const res = await resolveTarget(to, { excludeSock });
          if (res.error) {
            const hint = res.candidates?.length ? ` Available: ${res.candidates.join(", ")}.` : "";
            return text(`Error: ${res.error}.${hint}`, true);
          }
          const from = `uds:${res.target!.sock}`;
          const pending = pendingReplies.get(from);
          if (!pending) return text(`Error: no pending ask from "${res.target!.name}".`, true);
          targetEntry = [from, pending];
        } else if (pendingReplies.size === 1) {
          targetEntry = pendingReplies.entries().next().value;
        } else if (!pendingReplies.size) {
          return text("Error: no pending inbound asks.", true);
        } else {
          return text(`Error: multiple pending asks; specify 'to'. Pending: ${[...pendingReplies.values()].map((p) => p.who).join(", ")}.`, true);
        }
        const [from, pending] = targetEntry!;
        try {
          await sendToClaude({
            sock: from.slice(4), body: message, from: ownFrom, fromName: selfName,
            fromMode: REPLY_MODE, hops: pending.hops,
          });
          pendingReplies.delete(from);
          return text(`Replied to "${pending.who}".`);
        } catch (e) {
          return text(`Error replying to "${pending.who}": ${(e as Error).message}`, true);
        }
      }

      if (!to) return text("Error: 'to' is required.", true);
      const res = await resolveTarget(to, { excludeSock });
      if (res.error) {
        const hint = res.candidates?.length ? ` Available: ${res.candidates.join(", ")}.` : "";
        return text(`Error: ${res.error}.${hint}`, true);
      }
      const target = res.target!;
      if (params.action === "send") {
        let sent: { msgId: string; staged: boolean };
        try {
          sent = await deliver(target, message);
        } catch (e) {
          return text(`Error delivering to "${target.name}": ${(e as Error).message}`, true);
        }
        // Claude Code sessions only confirm the socket: say what we know, as before.
        if (!sent.staged) return text(`Delivered to "${target.name}". Nothing comes back automatically — use action:"ask" if you need an answer.`);
        // Delivered means in its conversation: wait briefly for that receipt.
        const waitMs = ackWaitMs();
        const outcome = await outbox.wait(sent.msgId, waitMs);
        if (outcome.state === "received") outbox.onLate(sent.msgId, (late) => lateNotice(target.name, late));
        else outbox.forget(sent.msgId);
        const d = describeSend(target.name, outcome, { waitedMs: waitMs });
        return text(d.text, d.isError);
      }
      // action === "ask": send, then block for the reply. ASK_MODE is what tells
      // the receiver somebody is waiting, and is the only thing that earns an
      // automatic relay of their next turn. The waiter goes in first: a reply
      // must never beat it and be injected as a fresh message instead.
      let waiter!: AskWaiter;
      const reply = new Promise<string | { dropped: string } | null>((resolve) => {
        const timer = setTimeout(() => { unwait(); resolve(null); }, 120000);
        waiter = { resolve: (b) => { clearTimeout(timer); resolve(b); }, timer };
        const list = askWaiters.get(target.sock) || [];
        list.push(waiter);
        askWaiters.set(target.sock, list);
      });
      const unwait = () => {
        const list = askWaiters.get(target.sock) || [];
        const idx = list.indexOf(waiter);
        if (idx >= 0) list.splice(idx, 1);
        if (!list.length) askWaiters.delete(target.sock);
      };
      let sent: { msgId: string; staged: boolean };
      try {
        sent = await deliver(target, message, ASK_MODE);
      } catch (e) {
        unwait(); clearTimeout(waiter.timer);
        return text(`Error delivering to "${target.name}": ${(e as Error).message}`, true);
      }
      if (sent.staged) {
        // A refusal comes back at once; a drop (its run ended first) can come any time before the answer.
        const first = await outbox.wait(sent.msgId, ackWaitMs(), "received");
        if (first.state === "refused" || first.state === "dropped") {
          unwait(); clearTimeout(waiter.timer); outbox.forget(sent.msgId);
          return text(describeSend(target.name, first).text, true);
        }
        if (first.state === "conversation") outbox.forget(sent.msgId);
        else outbox.onLate(sent.msgId, (late) => {
          if (late.state !== "conversation") { unwait(); waiter.resolve({ dropped: late.reason || "it never reached its conversation" }); }
        });
      }
      const answer = await reply;
      outbox.forget(sent.msgId);
      if (answer !== null && typeof answer === "object") return text(`Error: not delivered to "${target.name}": dropped: ${answer.dropped}`, true);
      return answer === null
        ? text(`Sent to "${target.name}", but no reply within 120s.`)
        : text(`Reply from "${target.name}":\n${answer}`);
    },
  });

  // ---- reload command ------------------------------------------------------
  // Remote and self reloads dispatch this (sendUserMessage with
  // expandPromptTemplates), since only a command context can call ctx.reload().
  // pi has no hidden commands, so the description says it's internal.
  pi.registerCommand(RELOAD_COMMAND, {
    description: "(internal) agent-link runs this for reload requests; use /reload yourself",
    handler: async (_args, ctx) => {
      // pi refuses to reload mid-run or mid-compaction. The user may have
      // started either since the dispatch: queue again and answer "queued".
      // Otherwise answer waiting senders first: ctx.reload() shuts this
      // instance down.
      if (!(await reloads.beginReload(ctx.isIdle()))) return;
      try {
        await ctx.reload();
      } catch (e) {
        notify(`agent-link: reload failed: ${(e as Error).message}`, "error");
      }
    },
  });

  // ---- convenience command -------------------------------------------------
  pi.registerCommand("agent-link", {
    description: `List sessions you can message; 'dedupe' un-collides their names; 'reload <name|${IDLE_TARGETS}> [--force]' reloads other sessions`,
    getArgumentCompletions: async (prefix) => {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) {
        const subs = [
          { value: "dedupe", label: "dedupe", description: "un-collide duplicate session names" },
          { value: "reload ", label: "reload", description: `reload another pi session, or ${IDLE_TARGETS}` },
        ];
        const hits = subs.filter((s) => s.label.startsWith(parts[0] ?? ""));
        return hits.length ? hits : null;
      }
      if (parts[0] !== "reload") return null;
      const word = parts.at(-1) ?? "";
      const head = `${parts.slice(0, -1).join(" ")} `;
      const peers = (await cachedPeers().catch(() => [])).filter((p) => p.entrypoint === "pi");
      const options = [
        { name: IDLE_TARGETS, description: "every idle pi session" },
        ...peers.map((p) => ({ name: p.name, description: p.status })),
        { name: "--force", description: "even with unsent text in the editor" },
      ];
      const hits = options.filter((o) => o.name.startsWith(word) && !parts.slice(1, -1).includes(o.name));
      return hits.length ? hits.map((o) => ({ value: `${head}${o.name}`, label: o.name, description: o.description })) : null;
    },
    handler: async (args, ctx) => {
      // Ours is in flight (it may open a dialog): a reload waits for it.
      ownCommands++;
      try { await agentLinkCommand(args, ctx); } finally { ownCommands--; reloads.poll(); }
    },
  });

  async function agentLinkCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const { force, to, isReload } = parseReloadArgs(args);
    if (isReload) {
      if (!to) { ctx.ui.notify(`Usage: /agent-link reload <name|${IDLE_TARGETS}> [--force]. Use /reload for this session.`, "info"); return; }
      const result = await reloadTargets(to, force);
      ctx.ui.notify(result.text, result.isError ? "warning" : "info");
      return;
    }
    const rows = await listClaudeSessions({ excludeSock: sockPath });
    if (args.trim() === "dedupe") {
      // Include ourselves: our name is one of the ones that can collide.
      const all = [...rows, { pid, name: selfName, cwd: sessionCwd, status: peerStatus, sock: sockPath, startedAt, entrypoint: "pi", nameSource }];
      const plans = planDedupe(all);
      if (!plans.length) { ctx.ui.notify("No duplicate names among live sessions.", "info"); return; }
      const done: string[] = [];
      const failed: string[] = [];
      for (const plan of plans) {
        if (plan.peer.pid === pid) { selfName = plan.to; await updatePeer(pid, { name: selfName, nameSource: "derived" }).catch(() => {}); syncSummaryFile(); done.push(`${plan.from} → ${plan.to} (us)`); continue; }
        try {
          await renamePeer(plan.peer.sock, plan.to);
          done.push(`${plan.from} → ${plan.to} (pid ${plan.peer.pid})`);
        } catch (e) {
          failed.push(`${plan.from} (pid ${plan.peer.pid}): ${(e as Error).message}`);
        }
      }
      ctx.ui.notify(
        [done.length ? `Renamed:\n${done.map((d) => `  ${d}`).join("\n")}` : "", failed.length ? `Failed:\n${failed.map((f) => `  ${f}`).join("\n")}` : ""]
          .filter(Boolean).join("\n"),
        failed.length ? "warning" : "info",
      );
      return;
    }
    if (!rows.length) { ctx.ui.notify("No live Claude sessions found.", "info"); return; }
    ctx.ui.notify(`Reachable: ${rows.map((r) => `${listLabel(r, rows)} [${r.status}]`).join(", ")}`, "info");
  }
}
