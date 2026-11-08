/**
 * Quiet mode: background work stays quiet.
 *
 * A run Eric started is his: it notifies exactly as it did before. Every other
 * run is quiet — a bg job finishing, a subagent result, an agent-link message,
 * a codemode_bg result, a scheduler or Botsun trigger. A quiet run raises no
 * attention unless the agent calls notify_user or the classifier safety net
 * decides Eric is needed.
 *
 * Where a run came from:
 *   - pi's input event says "interactive", "rpc" or "extension".
 *   - interactive and rpc are Eric's.
 *   - an extension input is his only when that extension emitted "quiet:mine"
 *     just before pi.sendUserMessage (botsun-owner relays his phone that way).
 *   - pi.sendMessage(..., { triggerTurn: true }) fires no input at all, so its
 *     run (before_agent_start messageType "custom") is quiet.
 *
 * Stock pi order is input -> before_agent_start -> agent_start (docs/extensions.md
 * "Lifecycle Overview"). before_agent_start therefore sees the origin, which is
 * where the hint is added; agent_start is where the run is published, and it
 * still recomputes so a steer arriving in between flips the run.
 *
 * The state is shared with other extensions through pi.events and through
 * globalThis[Symbol.for("pi-boehsline.quiet")], so tmux-attention and
 * botsun-owner need no import:
 *   - "quiet:run"      { quiet: boolean }                       on agent_start, and on a flip
 *   - "quiet:attention" { kind, text, at, source? } | null     set, and null when cleared
 *   - "quiet:mine"     {}                                       another extension marks Eric's next input
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const RUN_EVENT = "quiet:run";
export const ATTENTION_EVENT = "quiet:attention";
export const MINE_EVENT = "quiet:mine";
export const STATE_KEY = Symbol.for("pi-boehsline.quiet");

export const KINDS = ["ready", "decision", "blocked", "failed", "deadline", "asked"] as const;
export type Kind = (typeof KINDS)[number];

export interface Attention {
  kind: Kind;
  text: string;
  at: number;
  source?: "tool" | "classifier";
}

export interface QuietSnapshot {
  quiet: boolean;
  attention: Attention | null;
}

export const DEFAULT_CLASSIFIER_MODEL = "opencode-go/deepseek-v4.1-flash";
/** An extension's "quiet:mine" mark is good for this long. */
export const MARK_TTL_MS = 2_000;
/** The classifier never holds a settle longer than this. */
export const CLASSIFIER_TIMEOUT_MS = 10_000;
/** Appended to a background run's system prompt for that run only. */
export const QUIET_HINT =
  "This turn was started by a background event, not by Eric. Act on it; don't report or summarise. End with at most one line. If Eric is needed, call notify_user.";

export const CLASSIFIER_PROMPT = `You decide whether a background pi run needs Eric's attention.
Default to not notifying. Notify only when Eric is genuinely needed: a decision only he can make, a deadline, a failure, something ready for him to test, or something he explicitly asked to hear about. Never notify for progress, a summary, or work you finished silently.
Reply with JSON only, no code fence:
{"notify": true or false, "kind": "ready" | "decision" | "blocked" | "failed" | "deadline" | "asked", "one_line": "at most 140 characters, one line"}
When notify is false, kind and one_line may be omitted.`;

interface Settings {
  mode: "background" | "off";
  classifier: boolean;
  classifierModel: string;
}

type CompleteResult = {
  stopReason?: string;
  errorMessage?: string;
  content?: { type?: string; text?: string }[];
};

type Registry = {
  find?: (provider: string, id: string) => unknown;
  hasConfiguredAuth?: (model: unknown) => boolean;
  complete?: (
    model: unknown,
    request: { systemPrompt?: string; messages: { role: string; content: string }[] },
    options: Record<string, unknown>,
  ) => Promise<CompleteResult>;
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readSettings(): Settings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // No settings file, or one that is not JSON: defaults are the quiet ones.
  }
  const spec = typeof raw.quietClassifierModel === "string" && raw.quietClassifierModel.includes("/")
    ? raw.quietClassifierModel
    : DEFAULT_CLASSIFIER_MODEL;
  return {
    mode: raw.quietMode === "off" ? "off" : "background",
    classifier: raw.quietClassifier !== false,
    classifierModel: spec,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: { type?: string; text?: string }) => part?.type === "text" && typeof part.text === "string")
    .map((part: { text?: string }) => part.text)
    .join("")
    .trim();
}

/** The newest assistant text on the branch, at most the last 4,000 characters. */
export function lastAssistantText(branch: unknown[]): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = textOf(entry.message.content);
    if (text) return text.slice(-4_000);
  }
  return "";
}

/** One line, whitespace collapsed, at most `max` characters (an ellipsis counts). */
export function oneLine(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** The first `max` characters of a single line, with no ellipsis. */
export function firstLine(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function localStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${localDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function sessionShort(ctx: ExtensionContext): string {
  try {
    const id = String(ctx.sessionManager.getSessionId() ?? "");
    return id.slice(0, 8) || "unknown";
  } catch {
    return "unknown";
  }
}

/** Best effort: one line per quiet run, whether or not it raised attention. */
function appendDigest(ctx: ExtensionContext, outcome: string): void {
  try {
    const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    const dir = join(base, "pi-quiet");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Existing directory owned elsewhere: appending is still best effort.
    }
    const now = new Date();
    const cwd = basename(ctx.cwd || process.cwd()) || "unknown";
    const line = `${localStamp(now)}\t${sessionShort(ctx)}\t${cwd}\t${oneLine(outcome, 500)}\n`;
    const file = join(dir, `${localDate(now)}.log`);
    appendFileSync(file, line, { mode: 0o600 });
    chmodSync(file, 0o600); // a file made before (or by hand) is tightened too
  } catch {
    // The digest must never disturb a settle.
  }
}

interface ClassifierReply {
  kind: Kind;
  text: string;
}

/** Parse the model's JSON, tolerating a fenced or chatty reply around it. */
export function parseClassifierReply(raw: string): ClassifierReply | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as { notify?: unknown; kind?: unknown; one_line?: unknown };
  if (obj.notify !== true) return null;
  if (typeof obj.kind !== "string" || !KINDS.includes(obj.kind as Kind)) return null;
  const text = oneLine(obj.one_line, 140);
  if (!text) return null;
  return { kind: obj.kind as Kind, text };
}

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && KINDS.includes(value as Kind);
}

export default function quiet(pi: ExtensionAPI): void {
  const snapshot = ((globalThis as Record<symbol, unknown>)[STATE_KEY] as QuietSnapshot | undefined) ?? {
    quiet: false,
    attention: null,
  };
  snapshot.quiet = false;
  snapshot.attention = null;
  (globalThis as Record<symbol, unknown>)[STATE_KEY] = snapshot;

  let settings = readSettings();
  /** An Eric input arrived since the last settle. */
  let mineSinceSettle = false;
  // When his last input came: a classifier answer that lands after it is stale.
  let lastMineAt = 0;
  /** When another extension said its next input is Eric's (epoch ms; 0 when unset). */
  let mineMarkAt = 0;
  /** The low-level run in progress, or null between runs. */
  let active: { quiet: boolean } | null = null;
  /** notify_user ran during this run. */
  let notifiedThisRun = false;
  let notifiedLine: { kind: Kind; text: string } | null = null;

  const emit = (channel: string, data: unknown) => {
    try {
      pi.events.emit(channel, data);
    } catch {
      // A broken subscriber must not break the run.
    }
  };

  const publishRun = (quietRun: boolean) => {
    snapshot.quiet = quietRun;
    emit(RUN_EVENT, { quiet: quietRun });
  };

  const publishAttention = (attention: Attention | null) => {
    snapshot.attention = attention;
    emit(ATTENTION_EVENT, attention ? { ...attention } : null);
  };

  const setAttention = (kind: Kind, text: string, source: Attention["source"]) => {
    const attention: Attention = { kind, text, at: Date.now(), ...(source ? { source } : {}) };
    publishAttention(attention);
    return attention;
  };

  const clearAttention = () => {
    if (!snapshot.attention) return;
    publishAttention(null);
  };

  const classifier = async (ctx: ExtensionContext, text: string): Promise<ClassifierReply | null> => {
    if (!text.trim()) return null;
    const reg = ctx.modelRegistry as unknown as Registry;
    if (!reg || typeof reg.find !== "function" || typeof reg.complete !== "function") return null;
    const slash = settings.classifierModel.indexOf("/");
    if (slash <= 0) return null;
    const model = reg.find(settings.classifierModel.slice(0, slash), settings.classifierModel.slice(slash + 1));
    if (!model) return null;
    if (typeof reg.hasConfiguredAuth === "function" && !reg.hasConfiguredAuth(model)) return null;

    const controller = new AbortController();
    // PI_QUIET_CLASSIFIER_TIMEOUT_MS is a test knob; production is the 10 s above.
    const configured = Number(process.env.PI_QUIET_CLASSIFIER_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : CLASSIFIER_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await reg.complete(
        model,
        {
          systemPrompt: CLASSIFIER_PROMPT,
          messages: [{ role: "user", content: text }],
        },
        {
          maxTokens: 200,
          cacheRetention: "none",
          signal: controller.signal,
          sessionId: randomUUID(),
          samplingParams: { enable_thinking: false, thinking: { type: "disabled" } },
        },
      );
      if (controller.signal.aborted) return null;
      if (result?.stopReason === "error" || result?.stopReason === "aborted") return null;
      return parseClassifierReply(textOf(result?.content));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // Another extension's "this next input is Eric's"; the next extension input
  // within MARK_TTL_MS consumes it.
  pi.events.on(MINE_EVENT, () => {
    mineMarkAt = Date.now();
  });

  pi.on("input", (event) => {
    let mine = event.source === "interactive" || event.source === "rpc";
    if (event.source === "extension" && mineMarkAt && Date.now() - mineMarkAt <= MARK_TTL_MS) {
      mineMarkAt = 0;
      mine = true;
    }
    if (!mine) {
      // A background input while idle starts a background run: a latch left by a prompt of his
      // that never started a run (no model, no auth) must not make this one his.
      if (!active) mineSinceSettle = false;
      return;
    }
    lastMineAt = Date.now();
    clearAttention();
    mineSinceSettle = true;
    if (active && active.quiet) {
      active.quiet = false;
      publishRun(false);
    }
  });

  pi.on("before_agent_start", (event) => {
    // A run a custom message started (sendMessage triggerTurn) is background whatever came
    // before: only a steer of his mid-run makes it his.
    if ((event as { messageType?: string }).messageType === "custom") mineSinceSettle = false;
    if (settings.mode === "off") {
      snapshot.quiet = false;
      return;
    }
    const quietRun = !mineSinceSettle;
    // Publish early enough that extensions loaded after this one (botsun-owner)
    // can read the origin from the global even when agent_start handler order
    // is not ours first.
    snapshot.quiet = quietRun;
    if (!quietRun) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${QUIET_HINT}`,
    };
  });

  pi.on("agent_start", () => {
    const continuing = active !== null;
    const quietRun = settings.mode !== "off" && !mineSinceSettle;
    if (!continuing) {
      notifiedThisRun = false;
      notifiedLine = null;
    }
    active = { quiet: quietRun };
    publishRun(quietRun);
  });

  pi.on("session_start", () => {
    settings = readSettings();
    active = null;
    mineSinceSettle = false;
    mineMarkAt = 0;
    notifiedThisRun = false;
    notifiedLine = null;
    snapshot.quiet = false;
    snapshot.attention = null;
  });

  pi.on("agent_settled", (_event, ctx) => {
    const run = active;
    active = null;
    const wasQuiet = run?.quiet === true && settings.mode !== "off";
    const notified = notifiedThisRun;
    const line = notifiedLine;
    const last = wasQuiet ? lastAssistantText(ctx.sessionManager.getBranch() || []) : "";
    mineSinceSettle = false;
    notifiedThisRun = false;
    notifiedLine = null;

    if (!wasQuiet) return;
    if (notified && line) {
      appendDigest(ctx, `notified ${line.kind}: ${line.text}`);
      return;
    }
    if (!settings.classifier) {
      appendDigest(ctx, `quiet: ${firstLine(last, 100) || "(no reply)"}`);
      return;
    }

    // Never make the settle wait on the model. The digest is written when the
    // side call answers, or immediately when there is nothing to ask about.
    const settledAt = Date.now();
    void (async () => {
      const answer = await classifier(ctx, last);
      // He typed since, or another run started: the answer is about a moment that has passed.
      const stale = active !== null || lastMineAt >= settledAt;
      if (answer && !stale) {
        setAttention(answer.kind, answer.text, "classifier");
        appendDigest(ctx, `classifier ${answer.kind}: ${answer.text}`);
      } else {
        appendDigest(ctx, `quiet: ${firstLine(last, 100) || "(no reply)"}`);
      }
    })();
  });

  pi.registerTool({
    name: "notify_user",
    label: "Notify user",
    description:
      "Ask for Eric's attention only when he is needed: something ready to test, a decision, a blocker, a failure, a deadline, or something he asked to hear about. Never use it for progress or a summary. In a run Eric started, the reply itself reaches him, so it is rarely needed there.",
    promptSnippet: "notify_user: quietly ask for Eric when a background run needs him",
    parameters: Type.Object({
      kind: StringEnum(KINDS, { description: "Why Eric is needed" }),
      text: Type.String({
        minLength: 1,
        maxLength: 140,
        description: "One line, 1-140 characters, saying what he needs to know",
      }),
    }),
    async execute(_toolCallId, params, _signal, _update, ctx) {
      if (!isKind(params.kind)) {
        return { content: [{ type: "text" as const, text: `notify_user: kind must be one of ${KINDS.join(", ")}` }], details: undefined };
      }
      if (typeof params.text !== "string" || /[\r\n]/.test(params.text)) {
        return { content: [{ type: "text" as const, text: "notify_user: text must be one line" }], details: undefined };
      }
      const text = params.text.trim();
      if (!text || text.length > 140) {
        return { content: [{ type: "text" as const, text: "notify_user: text must be 1-140 characters" }], details: undefined };
      }
      setAttention(params.kind, text, undefined);
      notifiedThisRun = true;
      notifiedLine = { kind: params.kind, text };
      try {
        ctx?.ui?.notify(`Needs you (${params.kind}): ${text}`, "warning");
      } catch {
        // The attention event still carries it.
      }
      return {
        content: [{ type: "text" as const, text: `Notified Eric (${params.kind}): ${text}` }],
        details: { kind: params.kind, text },
      };
    },
  });
}
