/**
 * Auto-name a session after the first turn if the user did not already.
 *
 * `--name` / `/name foo` win, and a resumed session is never re-titled
 * automatically — only a fresh session with no history gets an auto title.
 * `/auto-name` regenerates on demand.
 * Names that look like pi-agent-link's derived peer
 * ids (`pi-dotfiles`, `pi-dotfiles-2`) are treated as unnamed so they still
 * get a real title. One cheap flash-model call, trying DEFAULT_NAME_MODELS in
 * order until one answers (a 402/quota error just falls through to the next);
 * override with PI_AUTO_NAME_MODEL=provider/id[,provider/id...], disable with
 * PI_AUTO_NAME=0. When none of the defaults has credentials (no OpenCode Go,
 * say), the session's own model names it, so the text only goes where the
 * session already sends it. An explicit PI_AUTO_NAME_MODEL list never falls
 * back, so it can pin naming to free models. With no usable model at all it
 * stays quiet.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Opencode Go models only: they're covered by the flat subscription, unlike
 * the pay-per-token providers (inco, baseten). deepseek-v4.1-flash is verified;
 * the rest are fallbacks. Ollama Cloud's glm-5.3-flash used to lead this list
 * but now 402s on the free tier.
 */
export const DEFAULT_NAME_MODELS = [
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/glm-5.3-flash",
  "opencode-go/qwen3.8-flash",
];
/** Give up auto-naming a session after this many failed attempts. */
const MAX_AUTO_FAILURES = 3;

/** `provider/id` specs from a comma/space separated env value. */
export function parseModelList(raw?: string | null): string[] {
  const specs = (raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.indexOf("/") > 0);
  return specs.length ? specs : DEFAULT_NAME_MODELS;
}

/** One short line from a provider error like `402: {"message":"..."}`. */
export function summarizeError(raw?: string | null): string {
  const text = String(raw || "unknown error").trim();
  const m = text.match(/^(\d{3}):\s*(\{.*\})\s*$/s);
  let out = text;
  if (m) {
    try {
      const body = JSON.parse(m[2]!) as { message?: string; error?: { message?: string } };
      const msg = body?.message || body?.error?.message;
      if (msg) out = `${m[1]} ${msg}`;
    } catch {
      // keep the raw text
    }
  }
  out = out.replace(/\s*\(ref: [^)]*\)/, "").replace(/\s+/g, " ");
  return out.length > 90 ? `${out.slice(0, 89)}…` : out;
}
/** Session titles stay this short so they fit tabs, footers, and pickers. */
const MAX_NAME_CHARS = 30;
const MAX_NAME_WORDS = 6;
/** Lowercase inside a title ("Keeper of the Coop"), capitalized when first. */
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);

/** True when the name is one the user (or a previous auto-name) chose. */
export function isUserGivenName(name?: string | null): boolean {
  const n = (name || "").trim();
  if (!n) return false;
  if (/^pi-[A-Za-z0-9._-]+(-\d+)?$/.test(n)) return false;
  return true;
}

/**
 * Title-case one word. Words the model already cased (CI, GitHub, iOS, v4.1)
 * and words with digits stay as given; plain lowercase words get a capital, each part of a
 * hyphenated word too (Agent-Link).
 */
function titleWord(word: string, first: boolean): string {
  if (/[A-Z]/.test(word.slice(1)) || /\d/.test(word)) return word;
  if (!first && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
  return word
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join("-");
}

/**
 * A Title Case name with spaces: "Chicken Door Alert Tamer". A kebab-case
 * reply (an older habit) is split on its hyphens; otherwise hyphens inside a
 * word stay. Whole words only up to MAX_NAME_CHARS.
 */
export function sanitizeName(raw: string): string {
  let text = raw
    .trim()
    .replace(/^[#>*_\s]+|[*_\s]+$/g, "")
    .replace(/^["'`\u201c\u2018]+|["'`\u201d\u2019.!?:;,]+$/g, "")
    .trim();
  if (!/\s/.test(text) && /-/.test(text)) text = text.replace(/-+/g, " ");
  // Shouted all-caps names are lowercased first, so only real acronyms keep caps.
  if (/[A-Z]{4,}/.test(text) && !/[a-z]/.test(text) && text.split(/\s+/).length > 1) text = text.toLowerCase();
  const words = text
    .replace(/[^A-Za-z0-9.+#&'\-\s]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-.']+|[-.']+$/g, ""))
    .filter(Boolean)
    .slice(0, MAX_NAME_WORDS)
    .map((w, i) => titleWord(w, i === 0));
  // Whole words only: stop before the word that would exceed the cap, so a
  // tab never shows a clipped fragment. A single over-long first word still
  // hard-truncates rather than leaving the session unnamed.
  let name = "";
  for (const word of words) {
    const next = name ? `${name} ${word}` : word;
    if (next.length > MAX_NAME_CHARS) break;
    name = next;
  }
  if (!name && words.length > 0) name = words[0]!.slice(0, MAX_NAME_CHARS);
  return name;
}

/** Checked against the name lowercased with spaces turned to hyphens. */
const INSTRUCTION_ECHO =
  /at-?most-?\d+-?(short-?)?(words|characters)|session-?picker|short-?title|coding-?agent-?sessions?|the-?user-?wants|plain-?text-?only|role-?noun|title-?case/i;

/** Keep final answer text only — drop thinking blocks and instruction echo. */
export function titleFromContent(
  content: { type?: string; text?: string; thinking?: string }[] | undefined,
): string {
  const raw = (content || [])
    .filter((c) => c?.type === "text" && c.text)
    .map((c) => c.text as string)
    .join(" ");
  const line = raw.split(/\n/)[0] || "";
  if (INSTRUCTION_ECHO.test(line.toLowerCase().replace(/[\s-]+/g, "-"))) return "";
  return sanitizeName(line);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: { type?: string; text?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text)
    .join(" ")
    .trim();
}

/** Newest user + assistant turns, capped, for a rename from recent context. */
export function recentContext(branch: unknown[], maxChars = 2000): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = branch.length - 1; i >= 0 && used < maxChars; i--) {
    const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const t = messageText(entry.message?.content);
    if (!t) continue;
    if (t.startsWith("[cross-agent") || t.startsWith("[reply from")) continue;
    const chunk = `${role}: ${t.slice(0, 400)}`;
    parts.unshift(chunk);
    used += chunk.length;
  }
  return parts.join("\n\n").slice(-maxChars);
}

/** True once the transcript holds a real exchange (i.e. this is a resume). */
export function hasHistory(branch: unknown[]): boolean {
  return (branch || []).some((e) => {
    const entry = e as { type?: string; message?: { role?: string } };
    return entry?.type === "message" && entry.message?.role === "assistant";
  });
}

type NameModel = { provider?: string; id?: string; reasoning?: boolean };
type CompleteResult = {
  stopReason?: string;
  errorMessage?: string;
  content?: { type?: string; text?: string; thinking?: string }[];
};
type NamingRegistry = {
  find?: (provider: string, id: string) => NameModel | undefined;
  hasConfiguredAuth?: (model: NameModel) => boolean;
  complete?: (
    model: NameModel,
    req: { systemPrompt?: string; messages: { role: string; content: string }[] },
    opts: Record<string, unknown>,
  ) => Promise<CompleteResult>;
};
/** Remembers which model last produced a title so later calls start there. */
export type NamerState = { preferred?: string };

const modelKey = (m: NameModel) => `${m.provider}/${m.id}`;

/**
 * Configured naming models with credentials, preferred first. No generic
 * fallback (any "flash" model, the session model): that could silently land
 * on a pay-per-token provider.
 */
export function candidateModels(
  ctx: Pick<ExtensionContext, "modelRegistry"> & { model?: unknown },
  specs: string[],
  state: NamerState = {},
  // parseModelList hands back DEFAULT_NAME_MODELS itself when nothing is set.
  fallback = specs === DEFAULT_NAME_MODELS,
): NameModel[] {
  const reg = ctx.modelRegistry as unknown as NamingRegistry;
  const hasAuth = (m: NameModel) =>
    typeof reg?.hasConfiguredAuth === "function" ? reg.hasConfiguredAuth(m) : true;
  const out: NameModel[] = [];
  const add = (m?: NameModel) => {
    if (!m || !hasAuth(m) || out.some((o) => modelKey(o) === modelKey(m))) return;
    out.push(m);
  };
  for (const spec of specs) {
    const slash = spec.indexOf("/");
    if (slash > 0 && typeof reg?.find === "function") {
      add(reg.find(spec.slice(0, slash), spec.slice(slash + 1)));
    }
  }
  // None of the default naming models is set up: the session's own model.
  if (!out.length && fallback) add(ctx.model as NameModel | undefined);
  const i = state.preferred ? out.findIndex((m) => modelKey(m) === state.preferred) : -1;
  if (i > 0) out.unshift(...out.splice(i, 1));
  return out;
}

/**
 * Names read like a character on the job: the specific thing being worked on,
 * then one role noun. Examples steer a small flash model better than rules.
 */
export const NAMING_PROMPT = [
  "Name this conversation like a character on the job: the specific thing being worked on (2-3 words), then one role noun for what is being done to it. Playful but clear; the subject must say what it is about.",
  "Title Case with spaces. Keep acronyms and brand casing (CI, GitHub, NAS). At most 30 characters.",
  "Reply with only the name: no quotes, no period, no markdown. Name the conversation as it is now, not the first message alone.",
  "Examples:",
  "chicken coop door notifications firing every morning -> Chicken Door Alert Tamer",
  "a CI test that fails one run in five -> Flaky CI Wrangler",
  "memory leak in the canvas server -> Canvas Leak Plumber",
  "upgrading Rails 7.1 to 8 -> Rails 8 Upgrade Sherpa",
  "rotating an expired GitHub token -> GitHub Token Swapper",
  "what time is it in Tokyo -> Tokyo Time Teller",
].join("\n");

/** The session model may spend tokens reasoning even with thinking off; titles stay short anyway. */
const FALLBACK_MAX_TOKENS = 1024;

/** generateTitle's error when there is no model it could ask at all. */
export const NO_NAMING_MODEL = "no naming model with credentials";

/**
 * Ask each candidate in turn for a title. Provider errors (stopReason "error",
 * e.g. Ollama's 402 free-tier refusal) come back as results, not throws, so
 * they are checked explicitly. Throws with every model's reason if none work.
 */
export async function generateTitle(
  ctx: Pick<ExtensionContext, "modelRegistry"> & { model?: unknown },
  source: string,
  state: NamerState = {},
  specs: string[] = parseModelList(process.env.PI_AUTO_NAME_MODEL),
): Promise<string> {
  if (!source.trim()) return "";
  const reg = ctx.modelRegistry as unknown as NamingRegistry;
  if (typeof reg?.complete !== "function") throw new Error("modelRegistry.complete unavailable");
  const listed = candidateModels(ctx, specs, state, false);
  // Only the session's own model: it may not turn thinking off, so give it
  // room, and a failure there is quiet (there was nothing better to try).
  const usingFallback = listed.length === 0;
  const candidates = usingFallback ? candidateModels(ctx, specs, state) : listed;
  if (!candidates.length) throw new Error(NO_NAMING_MODEL);
  const errors: string[] = [];
  for (const model of candidates) {
    try {
      // Pass the model unchanged: for reasoning models pi sends the model's
      // thinking-off value (e.g. reasoning_effort "none"); forcing
      // reasoning:false suppressed that and let thinking eat the budget.
      const res = await reg.complete(
        model,
        {
          systemPrompt:
            NAMING_PROMPT,
          messages: [{ role: "user", content: source.slice(0, 2000) }],
        },
        {
          maxTokens: usingFallback ? FALLBACK_MAX_TOKENS : 64,
          cacheRetention: "none",
          signal: AbortSignal.timeout(15_000),
          sessionId: randomUUID(),
          samplingParams: { enable_thinking: false, thinking: { type: "disabled" } },
        },
      );
      if (res?.stopReason === "error" || res?.stopReason === "aborted") {
        errors.push(`${modelKey(model)}: ${summarizeError(res.errorMessage || res.stopReason)}`);
        continue;
      }
      const title = titleFromContent(res?.content);
      if (title) {
        state.preferred = modelKey(model);
        return title;
      }
      errors.push(`${modelKey(model)}: no usable title (${res?.stopReason || "empty"})`);
    } catch (e) {
      errors.push(`${modelKey(model)}: ${summarizeError((e as Error)?.message)}`);
    }
  }
  throw Object.assign(new Error(errors.join("; ")), { quiet: usingFallback });
}

export default function (pi: ExtensionAPI) {
  let attempted = false;
  let failures = 0;
  const namer: NamerState = {};

  async function applyGeneratedName(ctx: ExtensionContext, opts: { force: boolean }): Promise<string> {
    const source = recentContext(ctx.sessionManager.getBranch() || []);
    if (!source) return "";
    const title = await generateTitle(ctx, source, namer);
    if (!title) return "";
    if (!opts.force && isUserGivenName(pi.getSessionName())) return "";
    pi.setSessionName(title);
    return title;
  }

  pi.on("session_start", (_event, ctx) => {
    // A resumed session keeps whatever title it already had; only /auto-name
    // re-titles it. Fresh sessions (new, /new) still get one automatically.
    failures = 0;
    attempted =
      isUserGivenName(pi.getSessionName()) ||
      hasHistory(ctx.sessionManager.getBranch() || []);
  });

  pi.on("session_info_changed", (event) => {
    const name = (event as { name?: string })?.name ?? pi.getSessionName();
    if (isUserGivenName(name)) attempted = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (process.env.PI_AUTO_NAME === "0") return;
    if (attempted || isUserGivenName(pi.getSessionName())) {
      attempted = true;
      return;
    }
    attempted = true;
    try {
      const title = await applyGeneratedName(ctx, { force: false });
      if (title) failures = 0;
      else attempted = false;
    } catch (e) {
      // Nothing to ask (no naming model, no session model with credentials),
      // or only the session's own model and it couldn't: not worth a
      // warning, and retrying won't change it. /auto-name still reports it.
      if ((e as Error).message === NO_NAMING_MODEL || (e as { quiet?: boolean }).quiet) return;
      // Retry on later turns, but stop hammering providers that keep refusing.
      failures += 1;
      attempted = failures >= MAX_AUTO_FAILURES;
      if (attempted && ctx.hasUI) {
        ctx.ui.notify(`auto-name gave up: ${(e as Error).message}`, "warning");
      }
    }
  });

  pi.registerCommand("auto-name", {
    description: "Generate a Title Case session name from recent context",
    handler: async (_args, ctx) => {
      ctx.ui.notify("naming…", "info");
      try {
        const title = await applyGeneratedName(ctx, { force: true });
        ctx.ui.notify(title ? `named ${title}` : "could not generate a name", title ? "info" : "warning");
      } catch (e) {
        ctx.ui.notify(`naming failed: ${(e as Error).message}`, "error");
      }
    },
  });
}
