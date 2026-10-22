/**
 * Minimal footer/statusline for pi — a lean replacement for the pi-footer package.
 *
 * Renders a main line:
 *   dir [⎇ repo] branch* ⇣⇡ provider model thinking [bypass] ctx/window $cost [inline statuses] ⚡boot tk/s ◷timers   session-name
 * plus an optional dim row of other extension statuses (from ctx.ui.setStatus).
 * The tk/s chip is the output rate: dim and live while a reply streams, then
 * the exact figure for the last reply (usage.output over first token → end;
 * over the whole request when the deltas arrived as one burst).
 * It shows a bare "99"; clicking it toggles "3.1s 99tk/s", which leads with
 * the time to first token (turn start → first streamed delta). While waiting
 * for that first token the chip counts the TTFT up, dim. Color rewards
 * speed only, in Catppuccin accents (Mocha or Latte, following pi's theme
 * appearance): overlay gray under 50 tk/s, then green, teal, yellow, peach,
 * pink and mauve at 1000+ (RATE_BANDS); live and stale figures render faint.
 * When the terminal is too narrow for the chips, they wrap whole onto another
 * row instead of being cut. The session/peer name keeps its place right-
 * aligned on the first row: the chips there fill only the space left of it.
 * A pending-update notice is a separate right-aligned widget above the prompt.
 * The boot timer shows until the first message; while Approval Guardian is
 * bypassed, a bright-red "bypass" chip renders inline right after the
 * thinking chip, wrapping onto a later row by the same width rules as the
 * other chips.
 *
 * Clicking the provider or model chip cycles to the next scoped model — the
 * same switch as Ctrl+P. Clicking the thinking chip cycles the thinking level
 * forward, the boot timer shows /boot stats, and the bypass marker turns
 * bypass off. The dir chip toggles basename/full path, the context chip toggles
 * tokens/percent, the provider-usage chip toggles long/short window forms, and
 * the budget-usage cost chip (ollama/baseten/openrouter) toggles the dollar
 * total against its percent-only compact form; the whole chip colors by
 * budget pace (used% vs elapsed billing month) off the meter's reset timestamp.
 * Clicking the right-aligned session/peer name prefills /auto-name when the
 * editor is empty. The git chip's segments prefill shell commands (⇧-click picks the
 * harder variant): branch → `! git status -s`, ⇣ → `! git pull --ff-only`
 * (⇧: `! git pull --rebase --autostash`), ⇡ → `! git push` (⇧:
 * `! git push --force-with-lease`); the session-cost chip stays glance-only.
 * Fullscreen only: that is where the terminal reports mouse clicks to pi at all.
 *
 * Design notes:
 * - The layout is this file. FOOTER_CHIPS names each chip, and /footer hides
 *   or shows them, saved in footer.json in the agent directory.
 * - Git state comes from a single `git status --porcelain=v1` per refresh, cached
 *   with a 5s TTL and refreshed asynchronously (stale-while-revalidate), so a slow
 *   repo never blocks a render.
 * - Colors are ANSI SGR codes (mostly ANSI-16; xterm-256 supplies orange);
 *   the theme supplies only the dim foreground, shared by the boot timer, the
 *   peer session name, and the extension-status row.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, readFile, readlink, realpath, writeFile, access, stat, lstat, constants } from "node:fs/promises";
import { homedir, loadavg } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  CustomEditor,
  VERSION as RUNNING_PI_VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SettingsList,
  truncateToWidth,
  visibleWidth,
  type SettingItem,
  type SettingsListTheme,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

const GIT_TTL_MS = 5_000;
/**
 * After a `!` command (which may run git), re-check this often for this long.
 * pi has no event for when a user command ends, and taking over its execution
 * (user_bash `operations`) would stop other extensions' user_bash handlers, so
 * the footer polls briefly instead.
 */
export const GIT_EXPEDITE_TTL_MS = 500;
export const GIT_EXPEDITE_WINDOW_MS = 10_000;
// A busy machine can take seconds; a timeout keeps the last state rather than
// blanking it, so this only bounds how stale the chip can get.
const GIT_TIMEOUT_MS = 3_000;

/**
 * pi-claude-link registers this process in Claude Code's peer registry and
 * derives a name ("pi-dotfiles") when the session has none. That name is what
 * other agents address, so it is worth showing — dimmed, to distinguish it
 * from a session name the user actually chose.
 */
const PEER_TTL_MS = 5_000;
// pi-claude-link registers after session_start and may rename itself moments
// later to dodge a collision, so poke the cache instead of waiting for a render.
const PEER_SETTLE_DELAYS_MS = [300, 1_000, 3_000, 8_000];

/** How often to re-read pi's on-disk version looking for an upgrade while running. */
const UPDATE_TTL_MS = 30_000;

/** Where the background bundle rebuild appends its output. */
const AUTO_BUNDLE_LOG = "auto-bundle.log";
/** Concurrent detections across pi instances serialize on this lock directory. */
const AUTO_BUNDLE_LOCK = "pi-bundle.lock";
/** A lock older than this is stale (a crashed run never cleaned up) and gets stolen. */
const AUTO_BUNDLE_LOCK_STALE_MIN = 10;

/** Statuses rendered inline in the main line (in this order) instead of the status row. */
const INLINE_STATUS_KEYS = ["codex-window", "copilot-window", "grok-window", "cerebras-window", "claude-window", "opencode-go-window"] as const;

/** The scheduler's status key; the timers chip renders it instead of the status row. */
const TIMERS_STATUS_KEY = "session-scheduler";

/**
 * The scheduler's status ("2 timers", "2 timers · 1 paused", "1 paused") as
 * counts, or undefined for anything else, which then stays on the status row
 * as is rather than being lost.
 */
export function parseTimerStatus(value: string | undefined): { active: number; paused: number } | undefined {
  const match = /^(?:(\d+) timers?(?: · (\d+) paused)?|(\d+) paused)$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  if (match[3] !== undefined) return { active: 0, paused: Number(match[3]) };
  return { active: Number(match[1]), paused: Number(match[2] ?? 0) };
}

/** The timers chip: count "◷ 2", detailed "◷ 2 timers · 1 paused"; only paused shows "◷ 1 paused" either way. */
export function formatTimersChip(counts: { active: number; paused: number } | undefined, mode: string | undefined): string {
  if (!counts || (counts.active === 0 && counts.paused === 0)) return "";
  if (counts.active === 0) return `◷ ${counts.paused} paused`;
  if (mode !== "detailed") return `◷ ${counts.active}`;
  const armed = `${counts.active} timer${counts.active === 1 ? "" : "s"}`;
  return `◷ ${counts.paused > 0 ? `${armed} · ${counts.paused} paused` : armed}`;
}

/** provider-usage listens: { days, setAt } from the /footer OOO row (same string there). */
const FOOTER_COPILOT_OOO_EVENT = "footer:copilot-ooo";

/**
 * Every footer chip, in painted order. The id keys footer.json and the click
 * zones; the description is what /footer shows for the selected row, and the
 * example stands in for the chip in /footer's preview when it has nothing to
 * show right now.
 */
export const FOOTER_CHIPS = [
  { id: "dir", label: "Directory", example: "project", description: "Working directory: its name, or the full path. Click: flip for this session." },
  { id: "worktree", label: "Worktree", example: "⎇ repo", description: "In a linked git worktree, ⎇ and the main repository's name; hidden in a main checkout." },
  { id: "git", label: "Git", example: "main* ⇡", description: "Branch; full mode adds * when dirty and ⇡/⇣ ahead/behind. Click: branch prefills git status; arrows prefill push/pull (⇧ for force/rebase)." },
  { id: "provider", label: "Provider", example: "gh", description: "Provider, short (gh = GitHub Copilot, o = OpenAI Codex). Click: next model." },
  { id: "model", label: "Model", example: "opus", description: "Model, short (opus, sonn). Click: next model." },
  { id: "thinking", label: "Thinking", example: "med", description: "Thinking level (med, hi, xhi). Click: next level." },
  { id: "bypass", label: "Bypass", example: "bypass", description: "While Approval Guardian is bypassed: the session name turns red with ⚠ (name), a red bypass chip (chip, or when no name shows), or both. Click either: turn the guardian back on." },
  { id: "context", label: "Context", example: "42k/1m", description: "Context tokens / window, or a percent, coloured as it fills. Click: flip for this session." },
  { id: "cost", label: "Cost", example: "$0.42", description: "Session cost, or a provider budget (ollama, baseten, openrouter) as a percent (compact) or total (detailed). Click: flip for this session." },
  { id: "usage", label: "Rate limits", example: "57%", description: "Provider usage windows: Copilot premium-request share over workdays (W) with the %/d left per workday, Codex/Grok/Claude windows, compact, detailed, or mini (just ↑ speed up / ↓ slow down, hidden on pace; multi-window chips name the window: ↓6w). Click: cycle for this session." },
  { id: "boot", label: "Boot time", example: "⚡775ms", description: "⚡ startup time, until the first message. Click: recent boot stats." },
  { id: "rate", label: "Token rate", example: "99", description: "Tokens per second of the last reply (live while streaming), alone or with the time to first token. Click: flip for this session." },
  { id: "timers", label: "Timers", example: "◷ 2", description: "◷ and the number of /once and /loop timers armed in this session; detailed adds \"timers\" and how many are paused." },
  { id: "name", label: "Session name", example: "session-name", description: "Session name, or the dim peer name other agents use: in the editor's top border, or at the right end of the footer. Click: prefill /auto-name, or while it shows bypass (red ⚠), turn the guardian back on." },
  { id: "statuses", label: "Extension statuses", example: "extension status", description: "Other extensions' statuses, on a dim line of their own." },
] as const;

export type FooterChipId = (typeof FOOTER_CHIPS)[number]["id"];

/** Chips in the main row, which /footer can reorder; the name and statuses stay put. */
export type FooterLineChipId = Exclude<FooterChipId, "name" | "statuses">;

const CHIP_IDS: ReadonlySet<string> = new Set(FOOTER_CHIPS.map((chip) => chip.id));

const isLineChip = (id: FooterChipId): id is FooterLineChipId => id !== "name" && id !== "statuses";

/** The main row's chips in their built-in order. */
export const DEFAULT_CHIP_ORDER: readonly FooterLineChipId[] = FOOTER_CHIPS.map((chip) => chip.id).filter(isLineChip);

/**
 * Display modes a chip can start in, the first being the default. A click on
 * the chip still flips the mode, for that session only.
 */
export const CHIP_MODES: Partial<Record<FooterChipId, readonly string[]>> = {
  dir: ["name", "full path"],
  git: ["full", "branch"],
  context: ["tokens", "percent"],
  cost: ["compact", "detailed"],
  // compact stays first (the default); a click cycles compact → detailed → mini.
  usage: ["compact", "detailed", "mini"],
  rate: ["number", "with TTFT"],
  timers: ["count", "detailed"],
  name: ["border", "footer"],
  bypass: ["name", "chip", "both"],
};

/** What footer.json holds, normalized: every chip has a mode if it has modes, every line chip a place. */
export interface FooterConfig {
  hidden: Set<FooterChipId>;
  modes: Partial<Record<FooterChipId, string>>;
  order: FooterLineChipId[];
  /** The context chip shows only above this (CONTEXT_THRESHOLDS); absent means always. */
  contextMin?: string;
  /** "unless clean default" hides the git chip on a clean default branch; absent means always. */
  gitWhen?: string;
  /** "unless default" hides the chip while it matches settings.json's default; absent means always. */
  providerWhen?: string;
  modelWhen?: string;
  thinkingWhen?: string;
  /** When the usage chip shows, by pace: "unless on pace", "when > 10 ahead", "when > 20 ahead"; absent means always. */
  usageWhen?: string;
  /** "on" adds each window's pace (↓8 ahead / ↑12 behind) to compact and detailed, and points to mini. */
  usagePace?: string;
  /** "after Ns": the token-rate chip shows only for turns that ran at least N seconds; absent means always. */
  rateWhen?: string;
  /** Copilot workdays off still ahead this cycle ("0"–"15"); provider-usage reads it for the ↓%/d allowance. */
  copilotOoo?: string;
  /** When copilotOoo was set; provider-usage ignores it once a new Copilot cycle starts. */
  copilotOooSetAt?: string;
  /**
   * Names for the dir chip by exact directory, as written in footer.json
   * ("~/x" allowed): `{ "~/Code/dotfiles": ".", "~/Notes": "" }`. An empty
   * name hides the chip there. Not editable in /footer; kept when it saves.
   */
  dirNames?: Record<string, string>;
  /**
   * Each provider's everyday model, so the Model condition counts it as a
   * default too: `{ "opencode-go": "deepseek-v4.1-flash" }`. Hand-edited like
   * dirNames; kept when /footer saves. Not editable in /footer.
   */
  defaultModels?: Record<string, string>;
  /** "top border left"/"right" puts the chips in the editor's top border, after the name or at the end; "bottom border left"/"right" in its bottom one; absent means below. */
  placement?: string;
}

/** Context threshold choices for /footer, "always" first (the default). */
export const CONTEXT_THRESHOLDS = ["always", ">50k", ">100k", ">200k", ">25%", ">50%", ">75%"] as const;

/**
 * Rows in /footer that set when a chip shows, each listed under its chip and
 * saved under its own key in footer.json; the first value is the default.
 */
export const CONDITION_ROWS = [
  {
    key: "gitWhen",
    chip: "git",
    label: "Git condition",
    description: "Hide the git chip on the default branch when it is clean, with nothing to push or pull.",
    values: ["always", "unless clean default"],
  },
  {
    key: "providerWhen",
    chip: "provider",
    label: "Provider condition",
    description: "Hide the provider chip while it is the default provider in settings.json.",
    values: ["always", "unless default"],
  },
  {
    key: "modelWhen",
    chip: "model",
    label: "Model condition",
    description: "Hide the model chip while it is the default model in settings.json, or the provider's defaultModels model in footer.json.",
    values: ["always", "unless default"],
  },
  {
    key: "thinkingWhen",
    chip: "thinking",
    label: "Thinking condition",
    description: "Hide the thinking chip while it is the level this model starts on: its modelThinkingLevels entry, else defaultThinkingLevel, else pi's medium.",
    values: ["always", "unless default"],
  },
  {
    key: "contextMin",
    chip: "context",
    label: "Context threshold",
    description: "Show the context chip only above this many tokens, or this share of the window.",
    values: [...CONTEXT_THRESHOLDS],
  },
  {
    key: "usageWhen",
    chip: "usage",
    label: "Usage condition",
    description: "Hide the rate-limits chip by pace: on pace means no window is more than 5 points ahead or behind. A limit (↻) or an unreadable format always shows.",
    values: ["always", "unless on pace", "when > 10 ahead", "when > 20 ahead"],
  },
  {
    key: "usagePace",
    chip: "usage",
    label: "Usage pace",
    description: "Add each window's pace after its %: ↓8 is 8 points ahead (slow down), ↑12 is 12 behind (speed up); nothing within ±5. Chips with several windows name the span: ↓8w is the weekly one, ↓8h the 5h. Mini shows ↓8w instead of ↓w.",
    values: ["off", "on"],
  },
  {
    key: "rateWhen",
    chip: "rate",
    label: "Rate condition",
    description: "Show the token-rate chip only for slow turns: once a request has run this long (counter, live rate, then its final rate). A faster turn hides it.",
    values: ["always", "after 2s", "after 5s", "after 10s", "after 30s"],
  },
  {
    key: "copilotOoo",
    chip: "usage",
    label: "Copilot OOO days",
    description: "Workdays off still ahead this Copilot cycle: the ↓%/d allowance spreads what is left over the other workdays. Lower it as you take them; it resets with the cycle.",
    values: Array.from({ length: 16 }, (_, days) => String(days)),
  },
] as const satisfies readonly { key: keyof FooterConfig; chip: FooterChipId; label: string; description: string; values: readonly string[] }[];

type ConditionKey = (typeof CONDITION_ROWS)[number]["key"];

const conditionRow = (key: string) => CONDITION_ROWS.find((row) => row.key === key);

/** Settings of the whole footer rather than one chip: /footer lists them first. */
export const LAYOUT_ROWS = [
  {
    key: "placement",
    label: "Placement",
    description: "Below the editor, in the editor's top border (just after the session name, or at the right end), or in its bottom border (at the left or the right): chips that don't fit stay below, whole, in order.",
    values: ["below", "top border left", "top border right", "bottom border left", "bottom border right"],
  },
] as const satisfies readonly { key: keyof FooterConfig; label: string; description: string; values: readonly string[] }[];

type SettingKey = ConditionKey | (typeof LAYOUT_ROWS)[number]["key"];

/** Every saved string setting: the per-chip rows and the layout rows. */
const SETTING_ROWS: readonly { key: SettingKey; values: readonly string[] }[] = [...CONDITION_ROWS, ...LAYOUT_ROWS];

const layoutRow = (key: string) => LAYOUT_ROWS.find((row) => row.key === key);

/**
 * Whether the context chip clears its threshold: ">100k" compares tokens,
 * ">50%" the share of the window. An unknown count (right after compaction)
 * counts as below.
 */
export function contextAboveThreshold(threshold: string | undefined, tokens: number | null | undefined, window: number | undefined): boolean {
  const match = /^>(\d+)(k|%)$/.exec(threshold ?? "");
  if (!match) return true;
  if (tokens == null) return false;
  const n = Number(match[1]);
  return match[2] === "k" ? tokens > n * 1000 : !!window && tokens > (window * n) / 100;
}

/**
 * The editor's top border with the session name in it, the way Claude Code
 * frames the prompt: `── name ──────── ↑ 3 more ──`. pi's own scroll
 * indicator moves to the right end. undefined when the line is too narrow,
 * so the caller keeps pi's border.
 */
export function nameTopBorder(
  name: string,
  hiddenLineCount: number,
  width: number,
  border: (text: string) => string,
): string | undefined {
  const right = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : "";
  const rightWidth = right ? visibleWidth(right) + 2 : 0;
  // "──" + " " + name + " " + at least one "─", then the indicator.
  const maxName = width - 5 - rightWidth;
  if (!name || maxName < 3) return undefined;
  const shown = truncateToWidth(name, maxName, "…");
  const fill = width - 4 - visibleWidth(shown) - rightWidth;
  return `${border("──")} ${shown} ${border("─".repeat(fill) + (right ? `${right}──` : ""))}`;
}

/**
 * The editor's top border carrying the footer's chips (top-border
 * placement): `── name ───── dir main* opus hi ── ↑ 3 more ──`. The name
 * keeps its place; chips go right-aligned after it, a prefix in footer order
 * that fits whole, and the caller leaves the rest below. undefined when no
 * chip fits, so the caller draws the name alone (nameTopBorder).
 * `starts` are the chips' first columns, for click zones. The bottom border
 * uses it too, with no name and pi's ↓ arrow. Left-aligned, the chips
 * follow the name (`── name ─ dir main* opus ────── ↑ 3 more ──`) or start
 * the line when there is none.
 */
export function topBorderLayout(
  name: string,
  chips: readonly { text: string; width: number }[],
  hiddenLineCount: number,
  width: number,
  border: (text: string) => string,
  arrow: "↑" | "↓" = "↑",
  align: "left" | "right" = "right",
): { line: string; taken: number; starts: number[] } | undefined {
  const tail = hiddenLineCount > 0 ? `─ ${arrow} ${hiddenLineCount} more ──` : "──";
  if (align === "left") {
    // "── " (+ name + " ─ ") + chips + " " + at least one ─ + the tail.
    const prefix = name ? `${border("──")} ${name} ${border("─")} ` : `${border("──")} `;
    const prefixWidth = name ? 6 + visibleWidth(name) : 3;
    const room = width - prefixWidth - 1 - 1 - visibleWidth(tail);
    let count = 0;
    let span = 0;
    for (const chip of chips) {
      const next = span + (count > 0 ? 1 : 0) + chip.width;
      if (next > room) break;
      span = next;
      count += 1;
    }
    if (count === 0) return undefined;
    const starts: number[] = [];
    let at = prefixWidth;
    for (const chip of chips.slice(0, count)) {
      starts.push(at);
      at += chip.width + 1;
    }
    const text = chips.slice(0, count).map((chip) => chip.text).join(" ");
    const rest = width - prefixWidth - span - 1 - visibleWidth(tail);
    return { line: `${prefix}${text} ${border("─".repeat(rest) + tail)}`, taken: count, starts };
  }
  const leftWidth = name ? 4 + visibleWidth(name) : 0;
  // At least one ─ (two without a name, so the line still starts as a border),
  // a space either side of the chips, then the tail.
  const budget = width - leftWidth - (name ? 1 : 2) - 2 - visibleWidth(tail);
  let taken = 0;
  let used = 0;
  for (const chip of chips) {
    const next = used + (taken > 0 ? 1 : 0) + chip.width;
    if (next > budget) break;
    used = next;
    taken += 1;
  }
  if (taken === 0) return undefined;
  const fill = width - leftWidth - used - 2 - visibleWidth(tail);
  const starts: number[] = [];
  let col = leftWidth + fill + 1;
  for (const chip of chips.slice(0, taken)) {
    starts.push(col);
    col += chip.width + 1;
  }
  const left = name ? `${border("──")} ${name} ` : "";
  const text = chips.slice(0, taken).map((chip) => chip.text).join(" ");
  return { line: `${left}${border("─".repeat(fill))} ${text} ${border(tail)}`, taken, starts };
}

/** Tags the footer's editor factory, so a reload or /new unwraps it instead of stacking. */
const NAME_BORDER_BASE = "__footerNameBorderBase";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type TaggedEditorFactory = EditorFactory & { [NAME_BORDER_BASE]?: EditorFactory | null };

/** A chip's saved mode, or its default. */
export function chipMode(config: FooterConfig, id: FooterChipId): string | undefined {
  return config.modes[id] ?? CHIP_MODES[id]?.[0];
}

/** SGR codes out, for the gray chips in /footer's preview. */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;:]*m/g, "");
}

/** Blink, re-applied after any full reset inside the text. */
function blink(text: string): string {
  return `\x1b[5m${text.replace(/\x1B\[0?m/g, "$&\x1b[5m")}\x1b[25m`;
}

/** Struck through: a hidden chip, shown only in /footer's preview. */
function strike(text: string): string {
  return `\x1b[9m${text}\x1b[29m`;
}

/** Underlined: the selected chip in /footer's preview, legible even when the chip itself is dim. */
function underline(text: string): string {
  return `\x1b[4m${text}\x1b[24m`;
}

/**
 * footer.json: `{ "hidden": ["boot"], "modes": { "context": "percent" },
 * "order": ["git", "dir", ...] }`, every key optional. New chips start shown,
 * in their default mode, right after the chip they follow by default (or at
 * the end when that one is missing too).
 */
export function footerConfigPath(): string {
  return join(agentDir(), "footer.json");
}

/** The saved config; unknown ids, unknown modes and a missing or broken file fall back to defaults. */
export function readFooterConfig(): FooterConfig {
  let parsed: { hidden?: unknown; modes?: unknown; order?: unknown; dirNames?: unknown; defaultModels?: unknown } & Partial<Record<SettingKey, unknown>> = {};
  try {
    parsed = JSON.parse(readFileSync(footerConfigPath(), "utf8")) ?? {};
  } catch {
    // Missing or broken: defaults.
  }
  const known = (id: unknown): id is FooterChipId => typeof id === "string" && CHIP_IDS.has(id);
  const hidden = new Set(Array.isArray(parsed.hidden) ? parsed.hidden.filter(known) : []);
  const modes: Partial<Record<FooterChipId, string>> = {};
  if (parsed.modes && typeof parsed.modes === "object") {
    for (const [id, mode] of Object.entries(parsed.modes)) {
      if (known(id) && typeof mode === "string" && CHIP_MODES[id]?.includes(mode)) modes[id] = mode;
    }
  }
  const saved = Array.isArray(parsed.order) ? parsed.order.filter(known).filter(isLineChip) : [];
  const order = [...new Set(saved)];
  // A chip the file doesn't know (added since it was saved) goes after its
  // default predecessor, so a new chip sits where it belongs rather than last.
  DEFAULT_CHIP_ORDER.forEach((id, i) => {
    if (order.includes(id)) return;
    const after = i > 0 ? order.indexOf(DEFAULT_CHIP_ORDER[i - 1]!) : -1;
    if (i === 0) order.unshift(id);
    else if (after === -1) order.push(id);
    else order.splice(after + 1, 0, id);
  });
  const config: FooterConfig = { hidden, modes, order };
  // Unknown values fall back to the default, which is left out.
  // Saved before Placement split each border in two: they meant the right.
  if (parsed.placement === "top border" || parsed.placement === "bottom border") parsed.placement += " right";
  for (const row of SETTING_ROWS) {
    const value = parsed[row.key];
    if (typeof value === "string" && value !== row.values[0] && (row.values as readonly string[]).includes(value)) {
      config[row.key] = value;
    }
  }
  if (parsed.dirNames && typeof parsed.dirNames === "object" && !Array.isArray(parsed.dirNames)) {
    const names = Object.entries(parsed.dirNames as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    if (names.length > 0) config.dirNames = Object.fromEntries(names);
  }
  if (parsed.defaultModels && typeof parsed.defaultModels === "object" && !Array.isArray(parsed.defaultModels)) {
    const models = Object.entries(parsed.defaultModels as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    if (models.length > 0) config.defaultModels = Object.fromEntries(models);
  }
  if (config.copilotOoo) {
    const setAt = (parsed as { copilotOooSetAt?: unknown }).copilotOooSetAt;
    if (typeof setAt === "string") config.copilotOooSetAt = setAt;
    // Copilot cycles start on the 1st (UTC): days set in an earlier month have expired.
    const now = new Date();
    if (typeof setAt === "string" && Date.parse(setAt) < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) {
      delete config.copilotOoo;
      delete config.copilotOooSetAt;
    }
  }
  return config;
}

/** Save the config, leaving out defaults so the file stays short. */
export function writeFooterConfig(config: FooterConfig): void {
  const out: {
    hidden: FooterChipId[];
    modes?: Partial<Record<FooterChipId, string>>;
    order?: FooterLineChipId[];
    copilotOooSetAt?: string;
    dirNames?: Record<string, string>;
    defaultModels?: Record<string, string>;
  } & Partial<Record<SettingKey, string>> = {
    hidden: FOOTER_CHIPS.map((chip) => chip.id).filter((id) => config.hidden.has(id)),
  };
  const modes = Object.fromEntries(
    Object.entries(config.modes).filter(([id, mode]) => mode !== CHIP_MODES[id as FooterChipId]?.[0]),
  );
  if (Object.keys(modes).length > 0) out.modes = modes;
  if (config.order.join() !== DEFAULT_CHIP_ORDER.join()) out.order = config.order;
  for (const row of SETTING_ROWS) {
    const value = config[row.key];
    if (value && value !== row.values[0]) out[row.key] = value;
  }
  if (out.copilotOoo && config.copilotOooSetAt) out.copilotOooSetAt = config.copilotOooSetAt;
  if (config.dirNames && Object.keys(config.dirNames).length > 0) out.dirNames = config.dirNames;
  if (config.defaultModels && Object.keys(config.defaultModels).length > 0) out.defaultModels = config.defaultModels;
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(footerConfigPath(), `${JSON.stringify(out, null, 2)}\n`);
}

/** Whether two configs would save the same file (defaults left out, hidden ids in any order). */
export function sameFooterConfig(a: FooterConfig, b: FooterConfig): boolean {
  const key = (config: FooterConfig) =>
    JSON.stringify({
      hidden: FOOTER_CHIPS.map((chip) => chip.id).filter((id) => config.hidden.has(id)),
      modes: FOOTER_CHIPS.map((chip) => chipMode(config, chip.id) ?? ""),
      order: config.order,
      conditions: SETTING_ROWS.map((row) => config[row.key] ?? row.values[0]),
      dirNames: config.dirNames ?? {},
    });
  return key(a) === key(b);
}

/** What a new session starts on: settings.json's defaults, a project's .pi/settings.json first. */
export interface ChipDefaults {
  provider?: string;
  model?: string;
  thinking: string;
  /** settings.json's modelThinkingLevels ("provider/id" → level), which beat `thinking` for that model. */
  modelThinking?: Record<string, string>;
  /** footer.json's defaultModels ("provider" → model id): the model that provider runs by default. */
  defaultModels?: Record<string, string>;
}

/** pi's thinking level when settings.json names none (DEFAULT_THINKING_LEVEL). */
const PI_DEFAULT_THINKING = "medium";

/**
 * The defaults the provider/model/thinking conditions compare against. Read
 * from the files rather than pi's SettingsManager, which may migrate and
 * write; a missing or broken file just contributes nothing.
 */
export function readChipDefaults(cwd: string): ChipDefaults {
  const read = (file: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const global = read(join(agentDir(), "settings.json"));
  const project = read(join(cwd, ".pi", "settings.json"));
  const merged = { ...global, ...project };
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const levels = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  const modelThinking = { ...levels(global.modelThinkingLevels), ...levels(project.modelThinkingLevels) };
  return {
    provider: text(merged.defaultProvider),
    model: text(merged.defaultModel),
    thinking: text(merged.defaultThinkingLevel) ?? PI_DEFAULT_THINKING,
    ...(Object.keys(modelThinking).length > 0 ? { modelThinking } : {}),
  };
}

/** Each provider's current flagship: the provider letter alone stands for it,
 *  so the model chip is left out. Exact releases, like shortModel's aliases. */
const FLAGSHIP_MODELS: Record<string, RegExp> = {
  anthropic: /^claude-opus-5-5$/i,
  "github-copilot": /^claude-opus-5\.5$/i,
  xai: /^grok-4\.7$/i,
};

export function flagshipModel(provider: string | undefined, model: string | undefined): boolean {
  const pattern = provider ? FLAGSHIP_MODELS[provider] : undefined;
  return !!pattern && !!model && pattern.test(model);
}

/**
 * Session-only views over the saved layout (footer.json is never touched):
 * minimal keeps the essentials, full shows everything in detail. "saved" is
 * the layout itself.
 */
export const FOOTER_VIEWS = ["saved", "minimal", "full"] as const;
export type FooterView = (typeof FOOTER_VIEWS)[number];

export function isFooterView(value: string): value is FooterView {
  return (FOOTER_VIEWS as readonly string[]).includes(value);
}

/** What minimal keeps (when the saved layout shows it): where you are, what's answering, and how full. */
const MINIMAL_CHIPS: ReadonlySet<FooterChipId> = new Set<FooterChipId>([
  "dir", "git", "provider", "model", "thinking", "bypass", "context", "usage", "name",
]);

/** The config a view renders with. Minimal narrows the saved layout; full drops
 *  every hidden chip and condition and picks each chip's most detailed mode. */
export function viewConfig(config: FooterConfig, view: FooterView): FooterConfig {
  if (view === "saved") return config;
  if (view === "minimal") {
    return {
      ...config,
      hidden: new Set(FOOTER_CHIPS.map((chip) => chip.id).filter((id) => config.hidden.has(id) || !MINIMAL_CHIPS.has(id))),
      modes: { ...config.modes, git: "branch", usage: "mini" },
    };
  }
  const { gitWhen: _g, providerWhen: _p, modelWhen: _m, thinkingWhen: _t, contextMin: _c, usageWhen: _u, rateWhen: _r, ...rest } = config;
  return {
    ...rest,
    hidden: new Set(),
    modes: { ...config.modes, git: "full", cost: "detailed", usage: "detailed", rate: "with TTFT", timers: "detailed" },
    usagePace: "on",
  };
}

/** Statuses that show even where the statuses row is hidden: red "\u26a0" alarms
 *  (Claude extra-usage billing and the like) must never be filtered away. */
export function alarmStatuses(values: readonly string[]): string[] {
  return values.filter((value) => value.includes("\u26a0"));
}

/** Whether a provider/model/thinking chip is hidden by its "unless default" condition. */
export function defaultChipHidden(
  chip: "provider" | "model" | "thinking",
  when: string | undefined,
  current: { provider?: string; model?: string; thinking?: string },
  defaults: ChipDefaults,
): boolean {
  if (when !== "unless default") return false;
  if (chip === "provider") return !!defaults.provider && current.provider === defaults.provider;
  if (chip === "model") {
    // footer.json's defaultModels names the model a provider runs by default.
    if (current.model && defaults.defaultModels?.[current.provider ?? ""] === current.model) return true;
    // A model is the default only on the default provider: the same id elsewhere is a different route.
    return !!defaults.model && current.model === defaults.model && (!defaults.provider || current.provider === defaults.provider);
  }
  // pi starts a model on its own modelThinkingLevels entry before the global default.
  const start = defaults.modelThinking?.[`${current.provider}/${current.model}`] ?? defaults.thinking;
  return current.thinking === start;
}

/**
 * Whether the Rate condition lets the token-rate chip show. During a turn
 * (waiting or streaming) it shows once the turn has run N seconds; between
 * turns it shows only if the last turn took at least N.
 */
export function rateChipShown(
  when: string | undefined,
  turn: { active: boolean; elapsedMs?: number; lastTurnMs?: number },
): boolean {
  const match = /^after (\d+)s$/.exec(when ?? "");
  if (!match) return true;
  const thresholdMs = Number(match[1]) * 1_000;
  const ms = turn.active ? turn.elapsedMs : turn.lastTurnMs;
  return ms !== undefined && ms >= thresholdMs;
}

/**
 * The boot timer sits in the footer until the first message goes out, and every
 * cold start is appended to `boot-times.jsonl` so `/boot stats` can show whether
 * a change actually moved the needle or just felt like it did.
 *
 * Measured at the footer's first render, which is the last thing to happen in
 * `interactiveMode.init()` — so `process.uptime()` there is genuinely
 * exec-to-first-paint, node bootstrap and extension loading included. Run
 * `PI_TIMING=1 PI_STARTUP_BENCHMARK=1 pi` for the phase-by-phase breakdown.
 *
 * Each record also carries `since` (seconds since the previous cold start) and
 * `load` (1-minute load average at first paint). Without them the log is not
 * interpretable: relaunching pi a few times in a row runs ~300ms faster than a
 * one-off launch, purely from a warm page cache and an idle machine, so a
 * benchmark burst and a real launch look like a regression sitting next to a
 * fix. `/boot stats` splits the two cohorts on BOOT_BURST_WINDOW_S.
 */
const BOOT_LOG_FILE = "boot-times.jsonl";
const BOOT_STATS_DEFAULT = 50;
/** Launches this close to the previous one are "burst": warm cache, same sitting. */
const BOOT_BURST_WINDOW_S = 70;
/** Trim to this many records once the log crosses the size check below. */
const BOOT_LOG_KEEP = 1_000;
const BOOT_LOG_MAX_BYTES = 200_000;

/** Providers whose cost is meaningless (subscription-billed or local). */
const HIDE_COST_PROVIDERS = new Set(["openai-codex", "github-copilot", "omlx", "ollama", "cerebras", "opencode-go"]);

/** Free-tier model ids on otherwise paid providers (exact ctx.model.id match). */
const HIDE_COST_MODELS = new Set([
  "muse-spark-1.3-contributor-free",
  "space-bunny-free",
  "cat-jam-free",
]);

/**
 * Usage chips written by baseten-usage.ts / openrouter-usage.ts via globalThis
 * stashes (color.ts's contract pattern — an import would be a hard dependency
 * and a missing extension aborts pi's launch). Replaces the session-cost slot:
 * session cost is meaningless against providers that bill monthly in aggregate.
 */
function usageChip(provider: string | undefined): string | undefined {
  const stashKey =
    provider === "baseten" ? "__piBasetenUsage"
    : provider === "openrouter" ? "__piOpenRouterUsage"
    : provider === "ollama" ? "__piOllamaUsage"
    : undefined;
  if (!stashKey) return undefined;
  const stash = (globalThis as Record<string, unknown>)[stashKey] as
    | { value?: unknown }
    | undefined;
  const value = stash?.value;
  return typeof value === "string" && value ? value : undefined;
}

/** Trailing "(11%)" of a budget-metered usage chip → "11%", else undefined. */
function costPercentTail(value: string): string | undefined {
  return /\((\d+(?:\.\d+)?%)\)$/.exec(value)?.[1];
}

/** Stash reader for the budget-usage cost slot: value plus, when the provider
 *  exposes it (ollama), the meter's reset timestamp for pace coloring. */
function budgetStash(provider: string | undefined):
  | { value?: unknown; resetMs?: unknown }
  | undefined {
  const stashKey =
    provider === "baseten" ? "__piBasetenUsage"
    : provider === "openrouter" ? "__piOpenRouterUsage"
    : provider === "ollama" ? "__piOllamaUsage"
    : undefined;
  if (!stashKey) return undefined;
  return (globalThis as Record<string, unknown>)[stashKey] as
    | { value?: unknown; resetMs?: unknown }
    | undefined;
}

/** The ollama meter carries its reset time; the others don't. */
function budgetResetMs(provider: string | undefined): number | undefined {
  const resetMs = budgetStash(provider)?.resetMs;
  return typeof resetMs === "number" && Number.isFinite(resetMs) ? resetMs : undefined;
}

/** Cycle start of a budget whose meter resets at `resetMs`: one calendar month
 *  back, day capped to the target month's length. Correct for both
 *  calendar-aligned (1st) and anniversary (subscription-day) cycles. */
function cycleStartBefore(resetMs: number): number {
  const reset = new Date(resetMs);
  const start = new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, 1));
  const monthDays = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(reset.getUTCDate(), monthDays));
  return start.getTime();
}

/** Fraction of the billing month already elapsed: from the meter's reset when
 *  known (ollama), else the calendar month (baseten/openrouter). */
function budgetElapsedFraction(resetMs: number | undefined, nowMs: number): number {
  if (resetMs !== undefined && resetMs > nowMs) {
    const start = cycleStartBefore(resetMs);
    return Math.min(1, Math.max(0, (nowMs - start) / (resetMs - start)));
  }
  const now = new Date(nowMs);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
}

/** Budget cost chip: the whole chip — dollars and "(11%)" — colors by budget
 *  pace, used% minus the elapsed share of the billing month, on the same
 *  ladder as the window chips. A chip without a percent tail (no budget
 *  configured) keeps the flat green look. */
function renderBudgetUsage(
  value: string,
  resetMs: number | undefined,
  compact: boolean,
): string {
  const tail = costPercentTail(value);
  if (tail === undefined) return color(GREEN, value);
  const percent = Number.parseFloat(tail);
  const pace = Number.isFinite(percent)
    ? percent - budgetElapsedFraction(resetMs, Date.now()) * 100
    : undefined;
  const code = pace === undefined ? GREEN : paceColor(pace);
  return color(code, compact ? tail : value);
}

/**
 * Short names for the upstream providers OpenRouter routes to, written by
 * openrouter-route.ts. Anything unmapped is squashed to lowercase alphanumerics
 * ("Parasail" → "parasail"), so a new provider still reads sensibly.
 */
const ROUTE_NAMES: Record<string, string> = {
  "z.ai": "z",
  baseten: "b10",
  cloudflare: "cf",
  deepinfra: "di",
  digitalocean: "do",
  gmicloud: "gmi",
  "io net": "ionet",
};

/**
 * Strip an OpenRouter preset suffix: `z-ai/glm-5.3-flash@preset/ox-alpha` is
 * the same model as `z-ai/glm-5.3-flash`, routed by a saved config. Also drops
 * a `:nitro`/`:floor` variant so aliases and route matching survive both.
 */
function baseModelId(model: string | undefined): string | undefined {
  return model?.replace(/@preset\/[^:]*/i, "").replace(/:[^/]+$/, "");
}

/** `novita/` for the model chip, or "" when the route is unknown or stale. */
function routePrefix(provider: string | undefined, modelId: string | undefined): string {
  if (provider !== "openrouter") return "";
  const route = (globalThis as Record<string, unknown>)["__piOpenRouterRoute"] as
    | { provider?: unknown; model?: unknown }
    | undefined;
  const name = route?.provider;
  if (typeof name !== "string" || !name) return "";
  // A route recorded for another model (picker switch mid-session) is not ours.
  // A preset resolves server-side, so compare the models it resolves between.
  const routed = route?.model;
  const current = baseModelId(modelId);
  if (typeof routed === "string" && current && baseModelId(routed) !== current) return "";
  const key = name.toLowerCase();
  const slug = ROUTE_NAMES[key] ?? key.replace(/[^a-z0-9]+/g, "");
  return slug ? `${slug}/` : "";
}

/** Subscription OAuth (SuperGrok, Claude Pro/Max) is plan-billed; an xAI or Anthropic API key still has a real dollar cost. */
function hideSessionCost(provider: string | undefined, ctx: ExtensionContext): boolean {
  if (!provider) return false;
  if (HIDE_COST_PROVIDERS.has(provider)) return true;
  if (ctx.model && HIDE_COST_MODELS.has(ctx.model.id)) return true;
  return (provider === "xai" || provider === "anthropic") && ctx.model != null && ctx.modelRegistry.isUsingOAuth(ctx.model);
}

const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_DANGER_PERCENT = 90;

/** pi-approval-guardian's persistent below-editor warning, replaced by our marker. */
const GUARDIAN_COMMAND = "approval-guardian";
const GUARDIAN_WIDGET_KEY = "approval-guardian-bypass";
const GUARDIAN_BYPASS_CONTROL_EVENT = "approval-guardian:set-temporary-bypass";
const GUARDIAN_BYPASS_STATE_EVENT = "approval-guardian:temporary-bypass-state";

const BLUE = 34;
const MAGENTA = 35;
const CYAN = 36;
const GREEN = 32;
const YELLOW = 33;
const RED = 31;
/** xterm-256 orange; ANSI-16 has no orange distinct from yellow. */
const ORANGE = "38;5;208";
const BRIGHT_BLACK = 90;
const BRIGHT_YELLOW = 93;
const BRIGHT_RED = 91;

/** Short names for verbose provider ids. */
const PROVIDER_NAMES: Record<string, string> = {
  openrouter: "or",
  "github-copilot": "gh",
  "openai-codex": "o",
  openai: "o",
  opencode: "oc",
  "opencode-go": "oc",
  xai: "x",
  baseten: "b10",
  cerebras: "cb",
  anthropic: "a",
};

/** Short names for thinking levels (pi: off|minimal|low|medium|high|xhigh|max). */
const THINKING_NAMES: Record<string, string> = {
  minimal: "min",
  low: "lo",
  medium: "med",
  high: "hi",
  // xhigh keeps its own label so the chip visibly changes on high → xhigh
  // (aa-info and turn-timer already use "xhi" for it).
  xhigh: "xhi",
};

/** Forward-cycle order for the thinking chip (matches pi's ladder). */
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Ordered rewrite rules for verbose model ids; first match wins. Results are lowercased. */
const MODEL_RULES: Array<[RegExp, string]> = [
  // Keep release aliases exact: an older Sol must say gpt-5.6-sol rather than
  // inheriting the current release's deceptively versionless label.
  [/^gpt-6\.1-sol$/i, "sol"],
  [/^gpt-6-sol$/i, "sol"],
  [/^gpt-6-astra$/i, "astra"],
  [/^gpt-[\d.]+-luna$/i, "luna"],
  [/^gpt-[\d.]+-terra$/i, "terra"],
  [/^claude-(.+)$/i, "$1"],
  [/^muse-spark(?:-[\d.]+)?(?:-contributor)?(?:-free)?$/i, "muse"],
  [/^moonshotai\/Kimi-(.+)$/i, "$1"],
  [/^deepseek-ai\/DeepSeek-(V\d+)-([A-Za-z]+)(?:-\d+)?$/i, "DS $1-$2"],
  // V4.1's dotted minor version misses the rule above, so match it across the
  // provider spellings (org id, OpenRouter route, bare id — Ollama Cloud's
  // ":cloud" suffix is stripped by baseModelId first).
  [/^deepseek-ai\/DeepSeek-V(\d+\.\d+)-Flash$/i, "ds$1f"],
  [/^deepseek\/deepseek-v(\d+\.\d+)-flash$/i, "ds$1f"],
  [/^deepseek-v(\d+\.\d+)-flash$/i, "ds$1f"],
  [/^z-ai\/GLM-5\.3-Flash$/i, "glm-5.3f"],
  [/^zai-org\/GLM-5\.3-Flash$/i, "glm-5.3f"],
  // Ollama Cloud ships the same model under a bare, org-less id.
  [/^GLM-5\.3-Flash$/i, "glm-5.3f"],
  // Version stays: footer keeps it for Qwen too, and this string is also the
  // stats key in turn-timer, where dropping it would conflate a future Ornith 2.x.
  [/^Ornith-1\.5-35B-A3B-MLX-4bit$/i, "orn-1.5"],
  [/^Qwen([\d.]+-\d+B(?:-A\d+B)?)\b.*$/i, "$1"],
];

interface GitState {
  isRepo: boolean;
  dirty: boolean;
  ahead: boolean;
  behind: boolean;
  /** origin/HEAD's branch, when the remote recorded one. */
  defaultBranch?: string;
}

const EMPTY_GIT: GitState = { isRepo: false, dirty: false, ahead: false, behind: false };

/** Stale-while-revalidate git status: renders never await, they just trigger a repaint. */
class GitStatusCache {
  private state: GitState = EMPTY_GIT;
  private key = "";
  private fetchedAt = 0;
  private inFlight = false;
  /** Until this time, refresh every GIT_EXPEDITE_TTL_MS (a `!` command just ran). */
  private expeditedUntil = 0;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  read(cwd: string, requestRender: () => void): GitState {
    if (cwd !== this.key) {
      this.key = cwd;
      this.state = EMPTY_GIT;
      this.fetchedAt = 0;
    }
    const ttl = Date.now() < this.expeditedUntil ? GIT_EXPEDITE_TTL_MS : GIT_TTL_MS;
    if (!this.inFlight && Date.now() - this.fetchedAt >= ttl) {
      void this.refresh(cwd, requestRender);
    }
    return this.state;
  }

  /** Re-check git often for a while: a `!` command may have changed it. */
  expedite(windowMs = GIT_EXPEDITE_WINDOW_MS): void {
    this.expeditedUntil = Date.now() + windowMs;
  }

  private async refresh(cwd: string, requestRender: () => void): Promise<void> {
    this.inFlight = true;
    // A timeout or a failed spawn says nothing about the repo: keep what we had.
    let next = this.state;
    try {
      // Both run concurrently: rev-list is wasted work outside a repo or
      // without an upstream, but it costs nothing next to a serial round trip.
      const [status, revList, originHead] = await Promise.all([
        // Submodules' own uncommitted edits are skipped (a moved submodule
        // still shows): checking inside each one cost ~1.1s of dotfiles' 1.6s.
        this.pi.exec("git", ["status", "--porcelain=v1", "--ignore-submodules=dirty"], { cwd, timeout: GIT_TIMEOUT_MS }),
        this.pi.exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], {
          cwd,
          timeout: GIT_TIMEOUT_MS,
        }),
        this.pi.exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
          cwd,
          timeout: GIT_TIMEOUT_MS,
        }),
      ]);
      if (status.code === 0 && !status.killed) {
        next = {
          isRepo: true,
          // Any staged, unstaged or untracked path counts as dirty, matching
          // p10k's vcs-detect-changes + git-untracked hooks.
          dirty: status.stdout.trim().length > 0,
          // Detached HEAD or no upstream configured: rev-list exits non-zero.
          ...parseAheadBehind(revList.code === 0 && !revList.killed ? revList.stdout : ""),
          // "origin/master" → "master"; absent when origin/HEAD was never set.
          ...(originHead.code === 0 && !originHead.killed && originHead.stdout.trim()
            ? { defaultBranch: originHead.stdout.trim().replace(/^origin\//, "") }
            : {}),
        };
      } else if (!status.killed) {
        // git answered: not a repository (or not one we can read).
        next = EMPTY_GIT;
      }
    } catch {
      // exec itself failed: keep the last state.
    } finally {
      this.inFlight = false;
    }
    // A cwd change mid-flight invalidates this result.
    if (cwd !== this.key) return;
    const changed = !sameGit(this.state, next);
    this.state = next;
    this.fetchedAt = Date.now();
    if (changed) requestRender();
  }
}

function sameGit(a: GitState, b: GitState): boolean {
  return (
    a.isRepo === b.isRepo &&
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.defaultBranch === b.defaultBranch
  );
}

/** `rev-list --left-right --count @{upstream}...HEAD` prints "<behind>\t<ahead>". */
function parseAheadBehind(output: string): Pick<GitState, "ahead" | "behind"> {
  const [behind = 0, ahead = 0] = output.trim().split(/\s+/).map(Number);
  return { ahead: ahead > 0, behind: behind > 0 };
}

/** Same stale-while-revalidate shape as the git cache, over one small JSON read. */
class PeerNameCache {
  private name = "";
  private fetchedAt = 0;
  private inFlight = false;

  read(requestRender: () => void): string {
    if (!this.inFlight && Date.now() - this.fetchedAt >= PEER_TTL_MS) {
      void this.refresh(requestRender);
    }
    return this.name;
  }

  /** Re-read now, ignoring the TTL. */
  reload(requestRender: () => void): void {
    if (!this.inFlight) void this.refresh(requestRender);
  }

  private async refresh(requestRender: () => void): Promise<void> {
    this.inFlight = true;
    let next = "";
    try {
      // Resolved per read, not at module load, so a HOME change is picked up.
      const file = join(homedir(), ".claude", "sessions", `${process.pid}.json`);
      const parsed = JSON.parse(await readFile(file, "utf8")) as { name?: unknown; startedAt?: unknown } | null;
      // A file from before this process started was left by a dead process
      // with the same pid (a hard exit skips its cleanup): not our name.
      const stale = typeof parsed?.startedAt === "number" && parsed.startedAt < PROCESS_STARTED_AT - 1_000;
      if (!stale && typeof parsed?.name === "string") next = parsed.name;
    } catch {
      // No pi-claude-link, no registry, or a half-written file: show nothing.
      next = "";
    } finally {
      this.inFlight = false;
    }
    const changed = this.name !== next;
    this.name = next;
    this.fetchedAt = Date.now();
    if (changed) requestRender();
  }
}

/**
 * Claude-style update notice: remember the version this process booted with,
 * then watch the on-disk version; a mismatch means an install landed while we
 * run old code and only a restart picks it up.
 *
 * RUNNING_PI_VERSION comes from pi's already-loaded module, so /reload keeps
 * reporting the version this process is actually running even after the files
 * on disk have been replaced by an update.
 */
interface InstalledUpdate {
  from: string;
  to: string;
}

class UpdateCheckCache {
  private readonly bootVersion = RUNNING_PI_VERSION;
  private current = "";
  private fetchedAt = 0;
  private inFlight = false;

  async init(): Promise<void> {
    // On a fresh launch the version on disk is the one we just started, so
    // skip the `mise which pi` spawns that would confirm it (three per launch
    // counting read() and bundleIsStale(), ~10ms of main-thread spawn cost
    // each). The first disk check then runs one TTL later. After a /reload
    // (the extension loads again in the same process) an update may have
    // landed in the meantime, so check right away.
    const stash = globalThis as { __piFooterLoaded?: boolean };
    const reloaded = stash.__piFooterLoaded === true;
    stash.__piFooterLoaded = true;
    if (!reloaded && this.bootVersion) {
      this.current = this.bootVersion;
      this.fetchedAt = Date.now();
      return;
    }
    this.current = (await piVersion()) || this.bootVersion;
  }

  read(requestRender: () => void): InstalledUpdate | undefined {
    if (!this.bootVersion) return undefined;
    if (!this.inFlight && Date.now() - this.fetchedAt >= UPDATE_TTL_MS) {
      void this.refresh(requestRender);
    }
    return this.current && this.current !== this.bootVersion
      ? { from: this.bootVersion, to: this.current }
      : undefined;
  }

  /** Re-read now, ignoring the TTL (used by the idle-session poll timer). */
  reload(requestRender: () => void): void {
    if (this.bootVersion && !this.inFlight) void this.refresh(requestRender);
  }

  private async refresh(requestRender: () => void): Promise<void> {
    this.inFlight = true;
    let next = this.current;
    try {
      next = (await piVersion()) || this.current;
    } finally {
      this.inFlight = false;
    }
    const changed = this.current !== next;
    this.current = next;
    this.fetchedAt = Date.now();
    if (changed && next !== this.bootVersion) {
      void rebuildBundle(next).catch(() => {});
    } else if (!changed && next && (await bundleIsStale())) {
      // Version-change detection alone misses the states that leave every
      // launch on dist/cli.js: the rebuild that fired mid-npm-install stamped
      // a bundle older than the finished package.json, and a pi launched after
      // its own upgrade seeded `current` with the new version so `changed` is
      // never true. One refresh TTL later this branch re-bundles anyway.
      void rebuildBundle(next).catch(() => {});
    }
    if (changed) requestRender();
  }
}

/**
 * p10k-lean git summary: "master", "master*", "master ⇣⇡", "master* ⇡".
 *
 * Mirrors ~/.p10k.zsh — DIRTY_ICON='*' glued to the branch, blank
 * staged/unstaged/untracked icons, and unnumbered ⇣/⇡ arrows.
 *
 * The chip paints as one piece (branch and arrows wrap together), but its
 * segments get separate click zones: the branch prefills `git status`, each
 * arrow prefills a pull/push. Offsets are visible-column positions within the
 * chip, shifted by the chip's start column when the render walk zones it.
 */
interface GitChip {
  text: string;
  /** Visible width of the `branch*` segment. */
  branchWidth: number;
  /** Visible offset of ⇣ / ⇡ within the chip, when that arrow renders. */
  behindOffset?: number;
  aheadOffset?: number;
}

const EMPTY_GIT_CHIP: GitChip = { text: "", branchWidth: 0 };

/**
 * Whether the "unless clean default" Git condition hides the chip: on the
 * default branch (origin/HEAD's, else main or master) with no changes and
 * nothing to push or pull.
 */
export function gitChipHidden(
  when: string | undefined,
  branch: string | null,
  state: { isRepo: boolean; dirty: boolean; ahead: boolean; behind: boolean; defaultBranch?: string },
): boolean {
  if (when !== "unless clean default" || !branch || !state.isRepo) return false;
  const onDefault = state.defaultBranch ? branch === state.defaultBranch : branch === "main" || branch === "master";
  return onDefault && !state.dirty && !state.ahead && !state.behind;
}

function formatGit(branch: string | null, state: GitState): GitChip {
  if (!branch) return EMPTY_GIT_CHIP;
  const branchText = `${branch}${state.dirty ? "*" : ""}`;
  const arrows = `${state.behind ? "⇣" : ""}${state.ahead ? "⇡" : ""}`;
  const text = `${color(MAGENTA, branchText)}${arrows ? ` ${color(CYAN, arrows)}` : ""}`;
  // Branch names are effectively ASCII; visibleWidth keeps the arithmetic honest anyway.
  const branchWidth = visibleWidth(branchText);
  return {
    text,
    branchWidth,
    behindOffset: state.behind ? branchWidth + 1 : undefined,
    aheadOffset: state.ahead ? branchWidth + 1 + (state.behind ? 1 : 0) : undefined,
  };
}

function color(code: number | string, text: string): string {
  return text ? `\x1b[${code}m${text}\x1b[39m` : "";
}

function versionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * The SGR foreground /color painted the editor border with, or undefined when
 * no session color is set.
 *
 * Read out of color.ts's globalThis stash rather than imported from it. An
 * import is the same value but a hard dependency: pi aborts the whole launch
 * when an extension's import cannot resolve, so a host that has footer.ts but
 * not color.ts — which is exactly what a partially-applied extensions
 * directory looks like — gets no pi at all rather than an uncolored name.
 * The key is part of color.ts's contract; see its STASH_KEY.
 */
function sessionColorAnsi(): string | undefined {
  const stash = (globalThis as { __piSessionColor?: { ansi?: string } }).__piSessionColor;
  return stash?.ansi;
}

/** Wrap text in a ready-made SGR foreground sequence (from /color). */
function paint(ansi: string, text: string): string {
  return text ? `${ansi}${text}\x1b[39m` : "";
}

/** Widget key, so the footer toggle and shutdown can clear the addition. */
const UPDATE_WIDGET_KEY = "footer-update";

/** [start, end) visible-column range of a chip painted on the footer line. */
type ClickZone = [number, number];

/** Whether a click column falls inside a chip's painted range. */
function zoneHit(zone: ClickZone | undefined, col: number): boolean {
  return zone !== undefined && col >= zone[0] && col < zone[1];
}

/** Drop a chip zone that truncation pushed off the painted line; clip partial ones. */
function clipZone(zone: ClickZone | undefined, width: number): ClickZone | undefined {
  if (!zone || zone[0] >= width) return undefined;
  return [zone[0], Math.min(zone[1], width)];
}

function shortProvider(provider: string | undefined): string {
  if (!provider) return "";
  return PROVIDER_NAMES[provider] ?? provider;
}

function shortModel(model: string | undefined, provider?: string): string {
  const base = baseModelId(model);
  if (!base) return "no-model";
  // Release-specific aliases deliberately do not match siblings: the provider
  // chip already supplies the family context, while the model chip identifies
  // the exact current release. Older/newer releases keep their versioned name.
  if (provider === "xai" && /^grok-4\.7$/i.test(base)) return "grok";
  // Stealth previews are announced by a name, not an id. Two emoji fit the
  // chip; the -free ids would eat the rest of the footer.
  if (/^space-bunny(-free)?$/i.test(base)) return "🪐🐰";
  if (/^cat-jam(-free)?$/i.test(base)) return "🐱🎵";
  if (provider === "github-copilot" && /^claude-opus-5\.5$/i.test(base)) return "opus";
  if (provider === "anthropic" && /^claude-opus-5-5$/i.test(base)) return "opus";
  if (provider === "github-copilot" && /^claude-sonnet-5\.5$/i.test(base)) return "sonn";
  for (const [pattern, replacement] of MODEL_RULES) {
    // Aliased ids render lowercase; unknown ids pass through with their original casing.
    if (pattern.test(base)) return base.replace(pattern, replacement).toLowerCase();
  }
  return base;
}

function shortThinking(level: string): string {
  return THINKING_NAMES[level] ?? level;
}

/**
 * 0 → "0", 12_300 → "12k", 123_400 → "123k", 1_000_000 → "1m".
 *
 * Whole thousands only: tenths of a k are jittery noise for a context gauge.
 */
function formatCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 999_500) return `${Math.round(value / 1_000)}k`;
  return `${trimFixed(value / 1_000_000, 1)}m`;
}

/** Used tokens in bare thousands (57_300 → "57"); the window carries the unit. */
function formatThousands(value: number): string {
  return `${Math.round(value / 1_000)}`;
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

/** 4.1 → "4%": the context chip has no room for decimals. */
function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** 77.1 → "77": whole tokens are precise enough to glance at. */
function formatRateValue(tokensPerSecond: number): string {
  return `${Math.round(tokensPerSecond)}`;
}

/** "#a6e3a1" → "38;2;166;227;161", a truecolor SGR foreground for color(). */
function truecolor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

interface RateBand {
  floor: number;
  dark: string;
  light: string;
}

/**
 * Speed bands for the tk/s chip: quiet gray for ordinary speeds, then a heat
 * ladder that only rewards fast output. The top bands are for Cerebras-class
 * hardware (1000+ tk/s); frontier models over an API land in green/teal.
 *
 * Catppuccin accents in truecolor rather than ANSI-16: Mocha's ANSI red and
 * magenta are both rose and read as one color, and the 256-color cube's
 * pink/purple clash with the pastels. Peach stands in for red for the same
 * reason. Truecolor can't follow the terminal palette, so the pair is picked
 * by pi's theme appearance (dark → Mocha, light → Latte).
 */
const RATE_BANDS: readonly RateBand[] = [
  { floor: 1_000, dark: "#cba6f7", light: "#8839ef" }, // mauve
  { floor: 700, dark: "#f5c2e7", light: "#ea76cb" }, // pink
  { floor: 400, dark: "#fab387", light: "#fe640b" }, // peach
  { floor: 200, dark: "#f9e2af", light: "#df8e1d" }, // yellow
  { floor: 100, dark: "#94e2d5", light: "#179299" }, // teal
  { floor: 50, dark: "#a6e3a1", light: "#40a02b" }, // green
  { floor: 0, dark: "#6c7086", light: "#9ca0b0" }, // overlay0
];

function rateColor(tokensPerSecond: number, light: boolean): string {
  const band = RATE_BANDS.find(({ floor }) => tokensPerSecond >= floor) ?? RATE_BANDS[RATE_BANDS.length - 1]!;
  return truecolor(light ? band.light : band.dark);
}

/** Faint (SGR 2) over the band color: live and stale figures keep their hue but recede. */
function faint(text: string): string {
  return text ? `\x1b[2m${text}\x1b[22m` : "";
}

/** Compact "99", or detailed "3.1s 99tk/s" led by the time to first token. */
function formatRateChip(tokensPerSecond: number, ttftMs: number | undefined, detailed: boolean): string {
  const value = formatRateValue(tokensPerSecond);
  if (!detailed) return value;
  return ttftMs === undefined ? `${value}tk/s` : `${(ttftMs / 1_000).toFixed(1)}s ${value}tk/s`;
}

/** Shortest stream worth a rate: a tiny reply over a few ms reads as thousands of tk/s. */
const MIN_RATE_WINDOW_MS = 250;
/**
 * Below this, the deltas arrived as one burst rather than a stream (a proxy that
 * buffers the SSE response). The delta window then measures the burst, not the
 * generation, so the rate falls back to the whole request (turn start → end).
 */
const RATE_BURST_WINDOW_MS = 100;
/** Live-rate repaint throttle; deltas arrive far faster than anyone can read. */
const RATE_REPAINT_MS = 250;
/** Repaint cadence for the TTFT counter while waiting for the first token. */
const WAIT_TICK_MS = 100;
/** Starting tokens-per-char for the live estimate, until a finished reply calibrates it. */
const DEFAULT_TOKENS_PER_CHAR = 1 / 4;
/** Weight of the newest reply in the calibrated tokens-per-char average. */
const CALIBRATION_WEIGHT = 0.5;

/** text/thinking/toolcall deltas carry generated output; *_start/*_end do not. */
function isStreamDelta(event: unknown): boolean {
  const type = (event as { type?: unknown } | undefined)?.type;
  return typeof type === "string" && type.endsWith("_delta");
}

/** Streamed text in one assistant-message event, for the live token estimate. */
function streamedChars(event: unknown): number {
  const delta = (event as { delta?: unknown } | undefined)?.delta;
  return typeof delta === "string" ? delta.length : 0;
}

/** Output tokens on an assistant message's usage, or 0 when not reported yet. */
function outputTokens(message: unknown): number {
  const output = (message as { usage?: { output?: unknown } } | undefined)?.usage?.output;
  return typeof output === "number" && Number.isFinite(output) ? output : 0;
}

function isAssistant(message: unknown): boolean {
  return (message as { role?: unknown } | undefined)?.role === "assistant";
}

/** 903 → "903ms", 1240 → "1.24s". */
function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(2)}s`;
}

/** The active profile's agent directory (`pia` runs a second one). */
function agentDir(): string {
  // Resolved per call, not at module load, so a HOME change is picked up.
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * The dir chip's text. Full path: `~/x`. Otherwise a name from footer.json's
 * dirNames for this exact directory ("" hides the chip), "~" at home, and the
 * basename anywhere else.
 */
export function dirLabel(cwd: string, fullPath: boolean, dirNames: Record<string, string> = {}): string {
  if (fullPath) return tildePath(cwd);
  const home = homedir();
  const expand = (path: string) => (path === "~" || path.startsWith("~/") ? home + path.slice(1) : path);
  const strip = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  for (const [path, name] of Object.entries(dirNames)) {
    if (strip(expand(path)) === strip(cwd)) return name;
  }
  if (strip(cwd) === home) return "~";
  return basename(cwd);
}

const worktreeRepoCache = new Map<string, string | undefined>();

/**
 * The main repository's name when `cwd` is inside a linked git worktree, else
 * undefined. File reads only, no git process: a worktree's `.git` is a file
 * pointing at `<common>/worktrees/<name>`, whose `commondir` leads back to the
 * shared git directory (`repo/.git`, or a bare `repo.git`). Submodules have a
 * `.git` file too but no `commondir`, so they don't count. Cached per cwd.
 */
export function worktreeRepo(cwd: string): string | undefined {
  if (worktreeRepoCache.has(cwd)) return worktreeRepoCache.get(cwd);
  let repo: string | undefined;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    let text: string | undefined;
    try {
      text = readFileSync(dotGit, "utf8");
    } catch (error) {
      // EISDIR: a main checkout. ENOENT: keep walking up.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
    }
    if (text !== undefined) {
      const gitDir = text.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (!gitDir) break;
      const absGitDir = resolve(dir, gitDir);
      try {
        const common = resolve(absGitDir, readFileSync(join(absGitDir, "commondir"), "utf8").trim());
        repo = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
      } catch {
        // No commondir: a submodule, not a worktree.
      }
      break;
    }
    if (dirname(dir) === dir) break;
  }
  worktreeRepoCache.set(cwd, repo);
  return repo;
}

/** When this process started, for telling its registry file from a dead predecessor's. */
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

/** `$HOME/x` → `~/x`, so a notification names a path the way settings do. */
function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Which pi-approval-guardian the active profile pinned, e.g.
 * "npm:pi-approval-guardian@0.8.0".
 *
 * Read from settings rather than from the loaded extension: /bypass fails when
 * the guardian is a build without the control event, and the only actionable
 * thing to say is which pin produced it and which file to change. Both profiles
 * here share one packages tree, so the installed files cannot tell them apart —
 * the settings file is what actually differs.
 */
async function guardianPin(): Promise<{ pin: string; settings: string }> {
  const settings = join(agentDir(), "settings.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(settings, "utf8"));
    const packages = (parsed as { packages?: unknown } | null)?.packages;
    if (Array.isArray(packages)) {
      const pin = packages.find(
        (entry): entry is string =>
          typeof entry === "string" && entry.includes("pi-approval-guardian"),
      );
      if (pin) return { pin, settings };
    }
  } catch {
    // No settings file, or a half-written one: fall back to the generic wording.
  }
  return { pin: "", settings };
}

function bootLogPath(): string {
  return join(agentDir(), BOOT_LOG_FILE);
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MISE_WHICH_TIMEOUT_MS = 3_000;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every executable `name` on PATH, in PATH order. */
async function whichAll(name: string): Promise<string[]> {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const hits: string[] = [];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) hits.push(candidate);
  }
  return hits;
}

/**
 * The mise binary, if any: a `mise` on PATH, else the target of a mise shim
 * (shims are symlinks to the mise binary itself).
 */
async function miseBinary(piBins: string[]): Promise<string | null> {
  const [onPath] = await whichAll("mise");
  if (onPath) return onPath;
  for (const bin of piBins) {
    try {
      if (!(await lstat(bin)).isSymbolicLink()) continue;
      if (basename(await readlink(bin)) === "mise") return await realpath(bin);
    } catch {
      // Dangling or unreadable link: try the next one.
    }
  }
  return null;
}

function miseWhichPi(mise: string): Promise<string> {
  return new Promise((resolve) => {
    // Own process group. `execFile`'s timeout only SIGTERMs the direct child,
    // and a mise that ignores that (or whose grandchildren hold the pipes)
    // never emits close, so the test process stays up until the job timeout.
    const child = spawn(mise, ["which", "pi"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const killTree = () => {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }
      child.stdout?.destroy();
      child.unref();
    };
    const timer = setTimeout(() => {
      killTree();
      finish("");
    }, MISE_WHICH_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => finish(""));
    child.on("close", () => finish(stdout.trim()));
  });
}

/**
 * The `pi` a fresh launch from this cwd would run — not the one this process
 * is running. Asking mise comes first: mise installs each version in its own
 * directory and `mise activate` bakes that versioned bin dir into PATH, so a
 * long-running process's own PATH still points at its old install. Without
 * mise, the first `pi` on PATH is the answer.
 */
async function activePiBin(): Promise<string | null> {
  const piBins = await whichAll("pi");
  const mise = await miseBinary(piBins);
  if (mise) {
    const resolved = await miseWhichPi(mise);
    if (resolved) return resolved;
  }
  for (const bin of piBins) {
    try {
      // Skip mise shims; asking mise already failed, and running one is not an option.
      if ((await lstat(bin)).isSymbolicLink() && basename(await readlink(bin)) === "mise") continue;
    } catch {
      continue;
    }
    return bin;
  }
  return null;
}

async function isPiPackageJson(file: string): Promise<boolean> {
  try {
    const pkg: unknown = JSON.parse(await readFile(file, "utf8"));
    return (pkg as { name?: unknown } | null)?.name === PI_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Walk up from a file inside pi's package to its package.json. */
async function packageJsonAbove(file: string): Promise<string | null> {
  let dir = dirname(file);
  for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (await isPiPackageJson(candidate)) return candidate;
  }
  return null;
}

/**
 * pi's package.json for a bin path. Handles the npm-global layout (bin is a
 * symlink into the package), mise's aube layout (bin is a generated shim script
 * in node_modules/.bin beside a node_modules/@earendil-works/pi-coding-agent
 * link), and a bin repointed at bin/pi-launch.
 */
async function packageJsonForBin(bin: string): Promise<string | null> {
  const binDir = dirname(bin);
  const candidates = [
    join(binDir, "..", "@earendil-works", "pi-coding-agent", "package.json"),
    join(binDir, "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  ];
  for (const candidate of candidates) {
    if (await isPiPackageJson(candidate)) return await realpath(candidate);
  }
  try {
    return await packageJsonAbove(await realpath(bin));
  } catch {
    return null;
  }
}

/**
 * The active install's package.json, resolved fresh on every call through the
 * `pi` a new launch would run (see activePiBin). Falls back to the running
 * entrypoint (argv[1]), then an npm-global install beside node, when no pi bin
 * resolves (e.g. a pi started by path).
 *
 * argv[1] is dist/bundle/cli.js since pi ships its own bundle, so walk up to
 * the package rather than assuming a fixed depth.
 */
async function piPackageJsonPath(): Promise<string | null> {
  const bin = await activePiBin();
  if (bin) {
    const found = await packageJsonForBin(bin);
    if (found) return found;
  }
  try {
    const entry = process.argv[1];
    if (entry) {
      const found = await packageJsonAbove(await realpath(entry));
      if (found) return found;
    }
  } catch {
    // The update may have removed the running process's old entrypoint.
  }
  // Last resort: an npm-global install beside node itself, with no pi on PATH.
  const global = join(dirname(dirname(process.execPath)), "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  return (await isPiPackageJson(global)) ? global : null;
}

/** pi's own version, for correlating a regression with an upgrade. */
async function piVersion(): Promise<string> {
  try {
    const file = await piPackageJsonPath();
    if (!file) return "";
    const pkg: unknown = JSON.parse(await readFile(file, "utf8"));
    const version = (pkg as { version?: unknown } | null)?.version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

/** ~/bin/pi-bundle (bin/ is symlinked there), or null when it's not installed. */
async function piBundleScript(): Promise<string | null> {
  const candidate = join(homedir(), "bin", "pi-bundle");
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * True when dist/bundle.mjs is older than package.json — the state pi-launch
 * reads as "fall back to dist/cli.js", ~115ms slower on every launch. Beyond a
 * simply forgotten re-bundle this catches the npm-upgrade race: an old running
 * pi fires the auto-rebuild while npm is mid-install, the bundle gets stamped
 * before package.json's final mtime, and no later launch can ever see a
 * version transition to retrigger the rebuild (the Aug 31 regression sat like
 * that for days).
 */
async function bundleIsStale(): Promise<boolean> {
  try {
    const pkgJson = await piPackageJsonPath();
    if (!pkgJson) return false;
    // Since pi 0.85 upstream ships dist/bundle/cli.js and pi-bundle builds
    // nothing when it exists, so a missing dist/bundle.mjs is expected, not stale.
    if (await stat(join(dirname(pkgJson), "dist", "bundle", "cli.js")).then(() => true, () => false)) return false;
    const bundle = join(dirname(pkgJson), "dist", "bundle.mjs");
    const [pkgStat, bundleStat] = await Promise.all([
      stat(pkgJson),
      stat(bundle).catch(() => null),
    ]);
    return bundleStat === null || pkgStat.mtimeMs > bundleStat.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * A pi update leaves dist/bundle.mjs stale and the bin at stock cli.js, so
 * every launch runs ~115ms slower until someone re-runs pi-bundle. This footer
 * is already the first to know about an update — so let it kick off the
 * rebuild in a detached background process.
 *
 * Runs once per detected version (globalThis guard survives /reload), honors
 * PI_NO_AUTO_BUNDLE=1, serializes concurrent detections from other pi
 * instances on a lock directory, and appends everything to auto-bundle.log.
 * The staleness check in UpdateCheckCache.refresh() reuses this for the case
 * where the version never transitioned but the bundle is already outdated.
 */
async function rebuildBundle(version: string): Promise<void> {
  const stash = globalThis as { __piFooterAutoBundleFor?: string };
  if (stash.__piFooterAutoBundleFor === version) return;
  stash.__piFooterAutoBundleFor = version;
  if (process.env.PI_NO_AUTO_BUNDLE) return;

  const script = await piBundleScript();
  if (!script) return;

  const dir = agentDir();
  // Redirect by path, not by inherited fd: Node opens files with O_CLOEXEC,
  // so fd numbers from this process don't exist in the detached child.
  const logPath = join(dir, AUTO_BUNDLE_LOG);
  const lockPath = join(dir, AUTO_BUNDLE_LOCK);
  const sh = [
    `lock=${JSON.stringify(lockPath)}`,
    `log=${JSON.stringify(logPath)}`,
    `if ! mkdir "$lock" 2>/dev/null; then`,
    `  if [ -z "$(find "$lock" -maxdepth 0 -mmin -${AUTO_BUNDLE_LOCK_STALE_MIN} 2>/dev/null)" ]; then`,
    `    rm -rf "$lock" && mkdir "$lock" || exit 0`,
    `  else`,
    `    exit 0`,
    `  fi`,
    `fi`,
    `trap 'rm -rf "$lock"' EXIT`,
    `echo "=== auto-rebuild for ${version} at $(date) (pid $$)" >> "$log"`,
    `${JSON.stringify(script)} >> "$log" 2>&1`,
  ].join("\n");
  const child = spawn("/bin/sh", ["-c", sh], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
}

/**
 * Append one cold start. Never awaited by a render — blocking first paint to
 * record how slow first paint was would be its own punchline.
 */
async function recordBoot(ms: number, cwd: string): Promise<void> {
  const file = bootLogPath();
  // Read before appending: `since` needs the previous record's timestamp, and
  // the trim below can reuse the same read instead of a second stat + read.
  const existing = await readFile(file, "utf8").catch(() => "");
  const lines = existing.split("\n").filter(Boolean);
  const now = Date.now();
  const previous = lastBootTime(lines);
  const line = `${JSON.stringify({
    t: new Date(now).toISOString(),
    ms,
    // The version this process booted, not whatever is installed by now.
    v: RUNNING_PI_VERSION || (await piVersion()),
    cwd,
    // Both are for reading the log later, not for anything at runtime: they are
    // what separates "this build got slower" from "this launch was unlucky".
    since: previous === undefined ? undefined : Math.round((now - previous) / 1_000),
    load: Math.round((loadavg()[0] ?? 0) * 100) / 100,
  })}\n`;
  await appendFile(file, line);
  // Concurrent pi processes can race this and drop a line or two. Fine: it is a
  // trend log, not an audit log.
  if (existing.length + line.length <= BOOT_LOG_MAX_BYTES) return;
  const kept = [...lines, line.trimEnd()].slice(-BOOT_LOG_KEEP);
  await writeFile(file, `${kept.join("\n")}\n`);
}

/** Epoch ms of the newest parseable record, or undefined for an empty log. */
function lastBootTime(lines: readonly string[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const t = (JSON.parse(lines[index] as string) as { t?: unknown }).t;
      if (typeof t !== "string") continue;
      const parsed = Date.parse(t);
      if (Number.isFinite(parsed)) return parsed;
    } catch {
      // Half-written line from a racing process; keep walking back.
    }
  }
  return undefined;
}

interface BootRecord {
  ms: number;
  /** Seconds since the previous cold start; absent on records written before this was logged. */
  since?: number;
  /** 1-minute load average at first paint; absent on older records. */
  load?: number;
}

async function readBoots(limit: number): Promise<BootRecord[]> {
  const out: BootRecord[] = [];
  for (const line of (await readFile(bootLogPath(), "utf8")).split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { ms?: unknown; since?: unknown; load?: unknown };
      if (typeof entry.ms !== "number" || !Number.isFinite(entry.ms)) continue;
      out.push({
        ms: entry.ms,
        since: typeof entry.since === "number" && Number.isFinite(entry.since) ? entry.since : undefined,
        load: typeof entry.load === "number" && Number.isFinite(entry.load) ? entry.load : undefined,
      });
    } catch {
      // Half-written line from a racing process.
    }
  }
  return out.slice(-limit);
}

/** "p50 743ms · min 488ms · max 2.08s" over one cohort, or "" when it is empty. */
function cohortSummary(values: readonly number[]): string {
  if (values.length === 0) return "";
  const sorted = [...values].sort((a, b) => a - b);
  return (
    `p50 ${formatMs(percentile(sorted, 50))}` +
    ` · min ${formatMs(sorted[0] as number)}` +
    ` · max ${formatMs(sorted[sorted.length - 1] as number)}`
  );
}

/** Nearest-rank percentile over an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}


interface UsageLike {
  cost?: { total?: unknown };
}

/** Sum assistant-message cost across the active branch. */
function sessionCost(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries) {
    const message = (entry as { message?: { role?: unknown; usage?: unknown } })?.message;
    if (!message || message.role !== "assistant") continue;
    const value = (message.usage as UsageLike | undefined)?.cost?.total;
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

function contextColorCode(tokens: number | null | undefined, window: number | undefined): number {
  if (tokens == null || !window) return CYAN;
  const percent = Math.min(100, Math.max(0, (tokens / window) * 100));
  if (percent >= CONTEXT_DANGER_PERCENT) return RED;
  if (percent >= CONTEXT_WARNING_PERCENT) return YELLOW;
  return CYAN;
}

/** Pace ladder from burn rate: quiet gray, yellow, orange, red; ↻ is at-limit. */
function paceColor(pace: number): number | string {
  if (pace > 20) return RED;
  if (pace > 10) return ORANGE;
  if (pace > 5) return YELLOW;
  return BRIGHT_BLACK;
}

function paceWarningColorCode(value: string): number | string {
  if (value.includes("\u21bb")) return RED;
  const pace = parseWindowPace(value);
  if (pace !== undefined) return paceColor(pace);
  // Legacy fallback: stale cache entries still carry trailing !s.
  const bangs = /!+$/.exec(value)?.[0].length ?? 0;
  if (bangs >= 3) return RED;
  if (bangs === 2) return ORANGE;
  if (bangs === 1) return YELLOW;
  return BRIGHT_BLACK;
}

/** Points ahead of pace for "elapsed/total[H|D|W]: percent%" (W = workdays), or undefined when unparseable. */
function parseWindowPace(value: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)[HDW]:\s+(\d+(?:\.\d+)?)%/.exec(value);
  if (!match) return undefined;
  const elapsed = Number.parseFloat(match[1] as string);
  const total = Number.parseFloat(match[2] as string);
  const percent = Number.parseFloat(match[3] as string);
  if (!(total > 0)) return undefined;
  return percent - (elapsed / total) * 100;
}

/** A window group's span as the letter its pace mark names it by: h under a
 *  day, d under a week, w under a month, m beyond — so the mark says which
 *  window is off pace (↓6w is the weekly one). W counts the workdays of a
 *  monthly cycle (Copilot), so it maps past w. */
function windowSpanLetter(group: string): string | undefined {
  const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)([HDW]):/.exec(group);
  if (!match) return undefined;
  const total = Number.parseFloat(match[2] as string);
  const unit = match[3] as string;
  if (!(total > 0)) return undefined;
  const spanDays = unit === "H" ? (total * 3_600) / 86_400 : unit === "D" ? total : (total * 7) / 5;
  if (spanDays < 1) return "h";
  if (spanDays < 7) return "d";
  if (spanDays < 28) return "w";
  return "m";
}

/** How a usage chip stands: at a limit, unreadable, or the most-ahead window's
 *  pace (negative = behind), with that window's span letter (h/d/w/m) when the
 *  chip has more than one window to tell apart. */
export type UsagePace = { limit: true } | { unknown: true } | { worst: number; letter?: string };

/** The worst window of a usage chip: one at its limit wins, then the most
 *  ahead, named by its span when there are several windows. */
export function usagePace(value: string): UsagePace {
  const groups = windowGroups(value);
  if (groups.some((group) => group.includes("\u21bb"))) return { limit: true };
  const paces = groups.map(parseWindowPace);
  if (paces.length === 0 || paces.some((pace) => pace === undefined)) return { unknown: true };
  let worst = -Infinity;
  let letter: string | undefined;
  for (let index = 0; index < groups.length; index++) {
    const pace = paces[index];
    if (pace === undefined || pace <= worst) continue;
    worst = pace;
    // Single-window chips (Copilot, Grok, Cerebras) have nothing to tell apart.
    letter = groups.length > 1 ? windowSpanLetter(groups[index] as string) : undefined;
  }
  return letter === undefined ? { worst } : { worst, letter };
}

/** Points either side of pace that still count as on pace (the gray band). */
const ON_PACE_BAND = 5;

/** Whether the Usage condition hides the chip. A limit or an unreadable chip always shows. */
export function usageChipHidden(when: string | undefined, pace: UsagePace): boolean {
  if (!when || when === "always" || !("worst" in pace)) return false;
  if (when === "unless on pace") return Math.abs(pace.worst) <= ON_PACE_BAND;
  const ahead = /^when > (\d+) ahead$/.exec(when);
  return ahead ? pace.worst <= Number(ahead[1]) : false;
}

/**
 * Mini mode: ↓ slow down when any window is more than 5 ahead (today's
 * yellow/orange/red ladder; red at a limit), ↑ speed up when every window is
 * more than 5 behind (green, bright green, bold green), nothing on pace. An
 * unreadable chip returns undefined so the caller can fall back to compact.
 * The mark carries the worst window's span letter (↓6w) whenever the chip has
 * more than one window: with no window labels around, it's the only name.
 */
export function renderMiniUsage(value: string, withPoints = false): string | undefined {
  const pace = usagePace(value);
  if ("limit" in pace) return color(RED, "↓");
  if ("unknown" in pace) return undefined;
  return paceMark(pace.worst, withPoints, pace.letter ?? "");
}

/**
 * A window's pace as a mark: ↓ ahead (yellow, orange >10, red >20), ↑ behind
 * (green, bright green >10, bold green >20), "" within ±5. With points, the
 * rounded distance follows the arrow: ↓8, ↑12. With a letter (only when the
 * chip has several windows to tell apart) it names the span: ↓8w is the
 * weekly window, ↓8h the 5h one — bare when there's only one window.
 */
export function paceMark(pace: number, withPoints = true, letter = ""): string {
  if (Math.abs(pace) <= ON_PACE_BAND) return "";
  const suffix = `${withPoints ? String(Math.round(Math.abs(pace))) : ""}${letter}`;
  if (pace > 0) return color(paceColor(pace), `↓${suffix}`);
  if (-pace > 20) return `\x1b[1;92m↑${suffix}\x1b[22;39m`;
  return color(-pace > 10 ? 92 : GREEN, `↑${suffix}`);
}

/** Older provider-usage wrote the Copilot allowance as "↓3.9%/d"; it reads "3.9%/d" now. */
function stripAllowanceArrow(value: string): string {
  return value.replace(/↓(?=\d+(?:\.\d+)?%\/d)/g, "");
}

/** Color `text` with `code`, gluing the pace mark (its own colors) after the first %. */
function withPaceMark(code: number | string, text: string, mark: string): string {
  const at = mark ? /\d+(?:\.\d+)?%/.exec(text) : null;
  if (!at) return color(code, text);
  const end = at.index + at[0].length;
  return `${color(code, text.slice(0, end))}${mark}${color(code, text.slice(end))}`;
}

/** Strip legacy trailing !s (stale cache) so they never paint. */
function stripBangs(value: string): string {
  return value.replace(/!+(?=\s|$)/g, "");
}

/** A window label like "1.2/5H:" — each such token starts a fresh window group. */
const WINDOW_LABEL_RE = /^\d+(\.\d+)?\/\d+(\.\d+)?[HDW]:$/;

/** Split a multi-window chip so each window colors independently:
 *  "1.2/5H: 43% 3.4/7D: 80%" → ["1.2/5H: 43%", "3.4/7D: 80%"].
 *  Single-window chips (copilot, grok) come back as one untouched group. */
function windowGroups(value: string): string[] {
  const groups: string[] = [];
  for (const token of value.split(" ")) {
    if (groups.length === 0 || WINDOW_LABEL_RE.test(token)) {
      groups.push(token);
    } else {
      groups[groups.length - 1] += ` ${token}`;
    }
  }
  return groups;
}

/** Parsed long-form window: "3.5/5H: 4%" → "4%". */
function parseWindowValue(group: string): string | undefined {
  const raw = /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?[HDW]:\s+(.+)$/.exec(group)?.[1];
  return raw === undefined ? undefined : stripBangs(raw);
}

/** Render provider windows long, or percentages-only compact "4%/33%" form. */
function renderWindowUsage(value: string, compact: boolean, showPace = false): string {
  const groups = windowGroups(value);
  // Only multi-window chips name their windows: one window needs no name.
  const multi = groups.length > 1;
  const mark = (group: string) => {
    const pace = showPace ? parseWindowPace(group) : undefined;
    return pace === undefined ? "" : paceMark(pace, true, multi ? windowSpanLetter(group) ?? "" : "");
  };
  if (!compact) {
    return groups
      .map((group) => withPaceMark(paceWarningColorCode(group), stripBangs(group), mark(group)))
      .join(" ");
  }
  const values = groups.map(parseWindowValue);
  if (values.some((window) => window === undefined)) {
    // Unknown producer format: preserve it rather than guessing destructively.
    return groups
      .map((group) => color(paceWarningColorCode(group), stripBangs(group)))
      .join(" ");
  }
  return (values as string[])
    .map((window, index) => {
      const group = groups[index] as string;
      return withPaceMark(paceWarningColorCode(group), window, mark(group));
    })
    .join(color(BRIGHT_BLACK, "/"));
}

export default function footerExtension(pi: ExtensionAPI): void {
  const git = new GitStatusCache(pi);
  const peer = new PeerNameCache();
  const update = new UpdateCheckCache();
  const updateReady = update.init().catch(() => {});
  let enabled = true;
  let bypassed = false;
  let runtimeContext: ExtensionContext | undefined;
  let repaint: (() => void) | undefined;
  // Only a cold start has a boot time worth showing; after /reload or a session
  // switch, uptime is however long the process has been sitting there.
  let coldStart = false;
  let bootMs: number | undefined;
  let bootCleared = false;
  let updateTimerStarted = false;
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  /** Dir chip shows the full ~/path instead of the basename when true. */
  let showFullPath = false;
  // settings.json's defaults for the "unless default" conditions; reread on session start and model switch.
  let chipDefaults: ChipDefaults = { thinking: PI_DEFAULT_THINKING };
  /** Context chip shows percent-used instead of tokens/window when true. */
  let contextPercent = false;
  /** Provider usage hides elapsed-window ages in a compact combined form by default. */
  let usageMode = "compact";
  /** The budget-usage cost chip shows its percent-only tail by default ("11%"). */
  let compactCostUsage = true;
  /**
   * Output-rate chip. TTFT runs from turn_start (request about to go out) to
   * the first streamed delta; the rate runs from that first delta to
   * message_end, so TTFT never dilutes it.
   *
   * The live figure is an estimate: providers report usage.output only at the
   * end, and Claude's summarized thinking (like OpenAI's hidden reasoning)
   * bills far more tokens than it streams. A flat chars/4 guess therefore read
   * ~half the real rate and the chip jumped at message_end. Each finished
   * reply now calibrates tokens-per-streamed-char for the next live estimate.
   */
  let turnStartMs: number | undefined;
  /** Set from turn_start until the first token: the chip ticks the TTFT up, dim. */
  let waitingForToken = false;
  let waitTimer: ReturnType<typeof setInterval> | undefined;
  let streaming = false;
  let firstTokenMs: number | undefined;
  let streamChars = 0;
  let lastRateRepaintMs = 0;
  let tokensPerChar = DEFAULT_TOKENS_PER_CHAR;
  let liveRate: number | undefined;
  let liveTtftMs: number | undefined;
  let lastRate: number | undefined;
  // How long the last turn took, turn_start to message_end, for the Rate condition.
  let lastTurnMs: number | undefined;
  let lastTtftMs: number | undefined;
  /** The rate chip shows "3.1s 99tk/s" instead of the bare "99" when true. */
  let detailedRate = false;
  /** Clickable chip actions. The session-cost chip stays glance-only. */
  type FooterClickAction =
    | "model"
    | "thinking"
    | "boot"
    | "bypass"
    | "dir"
    | "context"
    | "providerUsage"
    | "cost"
    | "rate"
    | "name"
    | "gitStatus"
    | "gitPush"
    | "gitPull";
  /** Clickable zones: chip ids, plus the git chip's three segments. */
  type FooterZoneKey =
    | Exclude<FooterChipId, "git" | "worktree" | "timers" | "statuses">
    | "gitBranch"
    | "gitBehind"
    | "gitAhead";
  /** One entry per painted footer line, holding the chip zones on that line. */
  type FooterClickRow = Partial<Record<FooterZoneKey, ClickZone>>;
  /** Which action each zone runs, checked in this order. */
  const ZONE_ACTIONS: ReadonlyArray<readonly [FooterZoneKey, FooterClickAction]> = [
    ["provider", "model"],
    ["model", "model"],
    ["thinking", "thinking"],
    ["boot", "boot"],
    ["bypass", "bypass"],
    ["dir", "dir"],
    ["gitBranch", "gitStatus"],
    ["gitAhead", "gitPush"],
    ["gitBehind", "gitPull"],
    ["context", "context"],
    ["cost", "cost"],
    ["usage", "providerUsage"],
    ["rate", "rate"],
    ["name", "name"],
  ];
  /** /footer's saved choices (hidden chips, start modes, order), from footer.json. */
  let footerConfig = readFooterConfig();
  /** /footer minimal|full|saved: this session's view over footerConfig, never saved. */
  let view: FooterView = "saved";
  /** What the footer renders: the saved layout through the session's view. */
  const shown = (): FooterConfig => viewConfig(footerConfig, view);
  /** Switch the view; click toggles restart in its modes, like a fresh session. */
  const setView = (next: FooterView): void => {
    view = next;
    applySavedModes();
    repaint?.();
  };
  /** /footer changed footerConfig in this session and Alt+S has not saved it. */
  let sessionEdited = false;
  /**
   * Start the session-only click toggles in the modes /footer saved. A click
   * still flips them, for this session only.
   */
  function applySavedModes(): void {
    showFullPath = chipMode(shown(), "dir") === "full path";
    contextPercent = chipMode(shown(), "context") === "percent";
    compactCostUsage = chipMode(shown(), "cost") !== "detailed";
    usageMode = chipMode(shown(), "usage") ?? "compact";
    detailedRate = chipMode(shown(), "rate") === "with TTFT";
  }
  /** Each chip's text at the last render, hidden ones too, for /footer's samples. */
  let chipSamples = new Map<FooterChipId, string>();
  /**
   * The chip selected in an open /footer checklist. While set, the footer is
   * the preview: that chip blinks, the rest go gray, hidden ones show struck
   * through.
   */
  let previewChip: FooterChipId | undefined;
  /**
   * Hit-testing state for clickable chips, refreshed on every footer render:
   * one entry per painted footer line, top to bottom, holding the
   * visible-column ranges of its clickable chips. Local coordinates
   * from Component.handleMouse index straight into it. Cleared on dispose so
   * a stale line can never be hit-tested after the footer is gone.
   */
  let footerClickRows: FooterClickRow[] = [];
  /** One chip as painted (preview styling included), its zones relative to its first column. */
  type FooterPart = { id: FooterChipId; text: string; width: number; zones: FooterClickRow };
  /** The footer's chips for the editor's top border; set while a footer is mounted. */
  let borderParts: (() => FooterPart[]) | undefined;
  /**
   * The chips an editor border drew in this render pass, by id and text.
   * The editor renders before the footer, which skips them; a microtask
   * clears it after the pass, so a pass without the editor (a selector or
   * /footer in its place) shows every chip below. Matched by content, not
   * position: the two chip lists can differ (the bypass chip shows below
   * when the border couldn't draw the name).
   */
  let borderTaken: string[] | undefined;
  /**
   * The editor's top border drew the session name in this render pass;
   * cleared after it like borderTaken. Without it the footer shows the
   * name itself (a narrow pane, an editor that isn't pi-tui's, another
   * extension replacing the wrapper), so a bypass marker is never lost.
   */
  let borderNamePainted = false;
  /** collect() threw inside an editor border once already: warned, don't repeat. */
  let borderChipsFailed = false;
  const partKey = (part: { id: string; text: string }) => `${part.id}\u0000${part.text}`;
  /** Click zones on the editor's top and bottom borders, from their last render. */
  let topClickRow: FooterClickRow = {};
  let bottomClickRow: FooterClickRow = {};
  // Clicks queue behind an in-flight switch, so a rapid double-click advances
  // twice instead of racing two reads of the same current model.
  let cycleQueue: Promise<void> = Promise.resolve();

  /**
   * Native click-to-act hit test over the footer's own painted rows.
   *
   * pi-tui dispatches mouse events to layout components via
   * Component.handleMouse, so the footer gets local 0-based coordinates
   * directly — no stdin sniffing, no previousScreen matching. footerClickRows
   * mirrors the rendered lines, so the local y indexes straight into it.
   */
  function footerChipAction(x: number, y: number): FooterClickAction | undefined {
    const row = footerClickRows[y];
    if (!row) return undefined;
    return ZONE_ACTIONS.find(([key]) => zoneHit(row[key], x))?.[1];
  }

  /** Run a chip's click action, from the footer or the editor's top border. */
  function runChipAction(action: FooterClickAction, shift: boolean): void {
    if (action === "model") queueModelCycle();
    else if (action === "thinking") cycleThinkingForward();
    else if (action === "boot") void showBootStats(BOOT_STATS_DEFAULT);
    else if (action === "bypass") void setBypassActive(false);
    // Toggles repaint the footer itself, which is the feedback — no notice.
    else if (action === "dir") {
      showFullPath = !showFullPath;
      repaint?.();
    } else if (action === "context") {
      contextPercent = !contextPercent;
      repaint?.();
    } else if (action === "providerUsage") {
      const modes = CHIP_MODES.usage ?? ["compact"];
      usageMode = modes[(modes.indexOf(usageMode) + 1) % modes.length] ?? "compact";
      repaint?.();
    } else if (action === "rate") {
      detailedRate = !detailedRate;
      repaint?.();
    } else if (action === "cost") {
      compactCostUsage = !compactCostUsage;
      repaint?.();
    } else if (action === "name") {
      // The red ⚠ name stands in for the bypass chip, so it acts like it.
      if (bypassMarks("name")) void setBypassActive(false);
      else prefillAutoNameCommand();
    } else if (action === "gitStatus") {
      prefillBashCommand("git status -s");
    } else if (action === "gitPush") {
      prefillBashCommand(shift ? "git push --force-with-lease" : "git push");
    } else if (action === "gitPull") {
      prefillBashCommand(shift ? "git pull --rebase --autostash" : "git pull --ff-only");
    }
  }

  /** Fill the auto-name command without destroying a prompt already in progress. */
  function prefillAutoNameCommand(): void {
    const ctx = runtimeContext;
    if (!ctx?.hasUI) return;
    if (ctx.ui.getEditorText().length > 0) {
      ctx.ui.notify("Editor is not empty; /auto-name was not inserted", "info");
      return;
    }
    ctx.ui.setEditorText("/auto-name");
  }

  /** Fill a `!`-prefixed shell command without destroying a prompt already in progress. */
  function prefillBashCommand(command: string): void {
    const ctx = runtimeContext;
    if (!ctx?.hasUI) return;
    if (ctx.ui.getEditorText().length > 0) {
      ctx.ui.notify(`Editor is not empty; ${command} was not inserted`, "info");
      return;
    }
    ctx.ui.setEditorText(`! ${command}`);
  }

  /**
   * The session name, or the dim name other agents use to reach this session.
   * A /color'd session names itself in that color, matching the editor
   * border. Only a name you chose: a peer name pi-claude-link derived stays
   * dim, because it says "nobody named this" and a bright color would claim
   * otherwise. Untinted, a chosen name is cyan, or `untinted` (the editor
   * border passes its own color).
   */
  function sessionNameText(
    theme: { fg(color: "dim", text: string): string },
    requestRender: () => void,
    untinted: (text: string) => string = (text) => color(CYAN, text),
  ): string {
    const sessionName = pi.getSessionName();
    const peerName = sessionName ? "" : peer.read(requestRender);
    // Bypassed: red with ⚠, whatever the tint, so it can't be missed.
    if (bypassMarks("name") && (sessionName || peerName)) return color(BRIGHT_RED, `⚠ ${sessionName || peerName}`);
    const tint = sessionColorAnsi();
    return sessionName ? (tint ? paint(tint, sessionName) : untinted(sessionName))
      : peerName ? theme.fg("dim", peerName)
      : "";
  }

  /** Whether bypass marks the name or the chip, by the Bypass row's mode (hidden: neither). */
  const bypassMarks = (where: "name" | "chip"): boolean => {
    if (!bypassed || shown().hidden.has("bypass")) return false;
    const mode = chipMode(shown(), "bypass");
    return mode === "both" || mode === where;
  };
  /**
   * The bypass chip shows in chip and both modes, and in name mode when no
   * name is on screen to mark: the footer took over the guardian's warning,
   * so bypass must stay visible unless the row is hidden.
   */
  const bypassChipShown = (requestRender: () => void): boolean => {
    if (bypassMarks("chip")) return true;
    if (!bypassMarks("name")) return false;
    const nameOnScreen =
      enabled &&
      !shown().hidden.has("name") &&
      !!(pi.getSessionName() || peer.read(requestRender)) &&
      (nameInFooter() || borderNamePainted);
    return !nameOnScreen;
  };

  const nameShownAs = (mode: string): boolean =>
    enabled && !shown().hidden.has("name") && chipMode(shown(), "name") === mode;
  // Border mode falls back to the footer whenever the border didn't draw it.
  const nameInFooter = () => nameShownAs("footer") || (nameShownAs("border") && !borderNamePainted);

  /**
   * Put the session name in the editor's top border (the name chip's border
   * mode). Wraps whatever editor is installed, like cursor-focus and
   * prompt-history, and only replaces pi's renderTopBorder, so their changes
   * and the `!` border color stay.
   */
  function installNameBorder(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    let previous = ctx.ui.getEditorComponent();
    while (previous && NAME_BORDER_BASE in previous) {
      previous = (previous as TaggedEditorFactory)[NAME_BORDER_BASE] ?? undefined;
    }
    const factory: EditorFactory = (tui, theme, keybindings) => {
      const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      // protected in pi-tui's Editor: the hook its subclasses override. An
      // editor that isn't pi-tui's (no such hook, no borderColor) is left as is.
      const target = editor as unknown as { renderTopBorder?(width: number, hidden: number): string };
      const borderColor = editor.borderColor;
      if (typeof target.renderTopBorder !== "function" || !borderColor) return editor;
      const piBorder = target.renderTopBorder.bind(editor);
      // Read borderColor per render: pi swaps it for `!` bash mode and thinking levels.
      const borderPaint = (text: string) => (editor.borderColor ?? borderColor)(text);
      /**
       * The chips for one border, when Placement puts them there. collect()
       * reads git, peer and usage state; a throw here would break the prompt
       * editor's render, so it falls back to no chips and warns once.
       */
      const chipsFor = (where: "top border" | "bottom border"): FooterPart[] => {
        if (!shown().placement?.startsWith(where)) return [];
        try {
          return borderParts?.() ?? [];
        } catch (error) {
          if (!borderChipsFailed) {
            borderChipsFailed = true;
            ctx.ui.notify(`footer: chips left out of the editor border: ${(error as Error).message}`, "warning");
          }
          return [];
        }
      };
      /** Mark the name drawn for this render pass, cleared after it. */
      const markNamePainted = (painted: boolean) => {
        borderNamePainted = painted;
        if (painted) {
          queueMicrotask(() => {
            borderNamePainted = false;
          });
        }
      };
      /** Note the chips a border drew, for the footer's skip and the click zones. */
      const placeChips = (layout: { taken: number; starts: number[] }, parts: FooterPart[], row: FooterClickRow) => {
        borderTaken = parts.slice(0, layout.taken).map(partKey);
        queueMicrotask(() => {
          borderTaken = undefined;
        });
        layout.starts.forEach((start, i) => {
          for (const [key, zone] of Object.entries(parts[i]!.zones) as Array<[FooterZoneKey, ClickZone]>) {
            const placed: ClickZone = [zone[0] + start, zone[1] + start];
            row[key] = key === "usage" && row.usage ? [row.usage[0], placed[1]] : placed;
          }
        });
      };
      // pi's CustomEditor can embed the working status (spinner) in this
      // border; while it shows, pi's border wins and the name and chips go below.
      const working = editor as unknown as {
        embedWorkingStatus?: boolean;
        workingStatusIndicator?: { renderInBorder?(width: number): string };
      };
      const workingShown = (width: number) =>
        !!working.embedWorkingStatus &&
        typeof working.workingStatusIndicator?.renderInBorder === "function" &&
        visibleWidth(working.workingStatusIndicator.renderInBorder(Math.max(1, width - 5))) > 0;
      target.renderTopBorder = (width, hidden) => {
        if (workingShown(width)) {
          topClickRow = {};
          markNamePainted(false);
          return piBorder(width, hidden);
        }
        const name = nameShownAs("border") ? sessionNameText(ctx.ui.theme, () => tui.requestRender(), borderPaint) : "";
        // Provisional while the chips are collected (the bypass chip asks
        // whether the name is on screen); settled below once it's drawn. It
        // queues its own clearing, so a throw before then can't leave it set.
        markNamePainted(!!name);
        const parts = chipsFor("top border");
        const align = shown().placement === "top border left" ? "left" : "right";
        const layout = parts.length ? topBorderLayout(name, parts, hidden, width, borderPaint, "↑", align) : undefined;
        topClickRow = {};
        if (layout) {
          placeChips(layout, parts, topClickRow);
          // The name starts after "── " and isn't cut when chips fit beside it.
          if (name) topClickRow.name = [3, 3 + visibleWidth(name)];
          markNamePainted(!!name);
          return layout.line;
        }
        const named = name ? nameTopBorder(name, hidden, width, borderPaint) : undefined;
        markNamePainted(!!named);
        if (!named) return piBorder(width, hidden);
        // As nameTopBorder fits it: the room left by "── ", " ─" and the indicator.
        const indicator = hidden > 0 ? visibleWidth(` ↑ ${hidden} more `) + 2 : 0;
        topClickRow.name = [3, 3 + Math.min(visibleWidth(name), width - 5 - indicator)];
        return named;
      };
      // Bottom-border placement: the chips right-aligned before pi's "↓ N more".
      // The autocomplete list renders below that border, so render() finds
      // which line it landed on for the clicks.
      const bottomTarget = editor as unknown as {
        renderBottomBorder?(width: number, hidden: number): string;
        render(width: number): string[];
      };
      let bottomRow = -1;
      let bottomLine: string | undefined;
      if (typeof bottomTarget.renderBottomBorder === "function" && typeof bottomTarget.render === "function") {
        const piBottom = bottomTarget.renderBottomBorder.bind(editor);
        bottomTarget.renderBottomBorder = (width, hidden) => {
          const parts = chipsFor("bottom border");
          const align = shown().placement === "bottom border left" ? "left" : "right";
          const layout = parts.length ? topBorderLayout("", parts, hidden, width, borderPaint, "↓", align) : undefined;
          bottomClickRow = {};
          bottomLine = undefined;
          if (!layout) return piBottom(width, hidden);
          placeChips(layout, parts, bottomClickRow);
          bottomLine = layout.line;
          return layout.line;
        };
        const editorRender = bottomTarget.render.bind(editor);
        bottomTarget.render = (width: number) => {
          bottomLine = undefined;
          const lines = editorRender(width);
          bottomRow = bottomLine === undefined ? -1 : lines.lastIndexOf(bottomLine);
          return lines;
        };
      }
      // Clicks on the borders' name and chips, fullscreen only like the
      // footer's; everything else is the editor's.
      const mouseTarget = editor as unknown as { handleMouse?(event: TuiMouseEvent): unknown };
      const editorMouse = mouseTarget.handleMouse?.bind(editor);
      mouseTarget.handleMouse = (event: TuiMouseEvent) => {
        const row = event.y === 0 ? topClickRow : event.y === bottomRow ? bottomClickRow : undefined;
        if (
          row &&
          tui.mode === "fullscreen" &&
          event.button === "left" &&
          (event.type === "press" || event.type === "click")
        ) {
          const action = ZONE_ACTIONS.find(([key]) => zoneHit(row[key], event.x))?.[1];
          if (action) {
            if (event.type === "click") runChipAction(action, event.shift === true);
            return { handled: true };
          }
        }
        return editorMouse?.(event);
      };
      return editor;
    };
    (factory as TaggedEditorFactory)[NAME_BORDER_BASE] = previous ?? null;
    ctx.ui.setEditorComponent(factory);
  }

  function apply(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    if (!enabled) {
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget(UPDATE_WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(UPDATE_WIDGET_KEY, (tui) => ({
      invalidate(): void {},
      render(width: number): string[] {
        if (width <= 0) return [];
        const installed = update.read(() => tui.requestRender());
        if (!installed) return [];
        const message =
          `Update installed ${versionLabel(installed.from)} → ${versionLabel(installed.to)}` +
          " · Restart to update";
        return [alignRight(color(GREEN, message), width)];
      },
    }));

    ctx.ui.setFooter((tui, theme, footerData) => {
      const requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      repaint = requestRender;

      /** The chips as painted, in /footer order, with what render needs around them. */
      const collect = () => {
        const provider = ctx.model?.provider;
        const usage = ctx.getContextUsage();
        const gitState = git.read(ctx.cwd, requestRender);
        const branch = footerData.getGitBranch();
        // Git "branch" mode drops the dirty marker and the arrows (and their clicks);
        // the Git condition can hide the chip on a clean default branch.
        const gitChip = gitChipHidden(shown().gitWhen, branch, gitState)
          ? EMPTY_GIT_CHIP
          : formatGit(
              branch,
              chipMode(shown(), "git") === "branch" ? { ...gitState, dirty: false, ahead: false, behind: false } : gitState,
            );
        const statuses = footerData.getExtensionStatuses();
        const usageValue = usageChip(provider);
        // theme is pi's live proxy, so a light/dark switch repaints with the right pair.
        const lightTheme = theme.appearance === "light";

        if (coldStart && bootMs === undefined) {
          bootMs = Math.round(process.uptime() * 1_000);
          void recordBoot(bootMs, ctx.cwd).catch(() => {});
        }
        const showBoot = bootMs !== undefined && !bootCleared;

        // A worktree is usually named for its branch: "wt-invoice ⎇ acme-api wt-invoice"
        // says it twice. Drop the directory then; ⎇ still marks the worktree and
        // the git chip (with its dirty and ahead marks) names it once.
        const repoOfWorktree = worktreeRepo(ctx.cwd);
        const dirChipShown = !(
          repoOfWorktree &&
          !showFullPath &&
          gitChip.text &&
          branch &&
          dirLabel(ctx.cwd, false, shown().dirNames) === branch
        );
        // footer.json's defaultModels names each provider's everyday model; the
        // Model condition treats those pairs as defaults too.
        const defaultModels = shown().defaultModels;
        const defaults: ChipDefaults = defaultModels ? { ...chipDefaults, defaultModels } : chipDefaults;
        const hideAsDefault = (chip: "provider" | "model" | "thinking") =>
          defaultChipHidden(
            chip,
            shown()[`${chip}When`],
            { provider: ctx.model?.provider, model: ctx.model?.id, thinking: pi.getThinkingLevel() },
            defaults,
          );
        const timersText = formatTimersChip(parseTimerStatus(statuses.get(TIMERS_STATUS_KEY)), chipMode(shown(), "timers"));
        const chips: Array<readonly [Exclude<FooterChipId, "name" | "statuses">, string]> = [
          ["dir", dirChipShown ? color(BLUE, dirLabel(ctx.cwd, showFullPath, shown().dirNames)) : ""],
          ["worktree", repoOfWorktree ? color(BLUE, `⎇ ${repoOfWorktree}`) : ""],
          ["git", gitChip.text],
          [
            "provider",
            hideAsDefault("provider") ? "" : color(BRIGHT_YELLOW, shortProvider(provider)),
          ],
          [
            "model",
            hideAsDefault("model") || (view !== "full" && flagshipModel(provider, ctx.model?.id))
              ? ""
              : color(BRIGHT_YELLOW, `${routePrefix(provider, ctx.model?.id)}${shortModel(ctx.model?.id, provider)}`),
          ],
          [
            "thinking",
            ctx.model?.reasoning && !hideAsDefault("thinking")
              ? color(BRIGHT_YELLOW, shortThinking(pi.getThinkingLevel()))
              : "",
          ],
          ["bypass", bypassChipShown(requestRender) ? color(BRIGHT_RED, "bypass") : ""],
          // context-length / context-window share one segment (no spaces around "/"),
          // or a single percent when the chip is toggled; hidden below the
          // /footer threshold.
          [
            "context",
            !contextAboveThreshold(shown().contextMin, usage?.tokens, usage?.contextWindow)
              ? ""
              : contextPercent
              ? color(
                  contextColorCode(usage?.tokens, usage?.contextWindow),
                  usage?.percent == null ? "?" : formatPercent(usage.percent),
                )
              : `${color(
                  contextColorCode(usage?.tokens, usage?.contextWindow),
                  usage?.tokens == null ? "?" : formatThousands(usage.tokens),
                )}/${color(CYAN, usage?.contextWindow ? formatCount(usage.contextWindow) : "?")}`,
          ],
          [
            "cost",
            usageValue
              ? renderBudgetUsage(usageValue, budgetResetMs(provider), compactCostUsage)
              : view !== "full" && hideSessionCost(provider, ctx)
                ? ""
                : color(GREEN, formatCost(sessionCost(ctx.sessionManager.getBranch()))),
          ],
          ...INLINE_STATUS_KEYS.map((key) => {
            const raw = statuses.get(key);
            const value = raw ? stripAllowanceArrow(raw) : raw;
            // Per-window coloring: a red 5h shouldn't paint the week red too.
            if (!value || usageChipHidden(shown().usageWhen, usagePace(value))) return ["usage", ""] as const;
            const showPace = shown().usagePace === "on";
            const mini = usageMode === "mini" ? renderMiniUsage(value, showPace) : undefined;
            return ["usage", mini ?? renderWindowUsage(value, usageMode !== "detailed", showPace)] as const;
          }),
          ["boot", showBoot ? theme.fg("dim", `⚡${formatMs(bootMs as number)}`) : ""],
          // Waiting for the first token: the TTFT counts up, dim (detailed
          // mode keeps the previous rate beside it, faint). Then live
          // (faint) while streaming, and the exact figure once it ends.
          [
            "rate",
            !rateChipShown(shown().rateWhen, {
              active: waitingForToken || streaming,
              elapsedMs: turnStartMs === undefined ? undefined : Date.now() - turnStartMs,
              lastTurnMs,
            })
              ? ""
              : waitingForToken && turnStartMs !== undefined
              ? `${theme.fg("dim", `${((Date.now() - turnStartMs) / 1_000).toFixed(1)}s`)}${
                  detailedRate && lastRate !== undefined
                    ? ` ${faint(color(rateColor(lastRate, lightTheme), `${formatRateValue(lastRate)}tk/s`))}`
                    : ""
                }`
              : liveRate !== undefined
                ? faint(color(rateColor(liveRate, lightTheme), formatRateChip(liveRate, liveTtftMs, detailedRate)))
                : lastRate !== undefined
                  ? streaming
                    ? faint(color(rateColor(lastRate, lightTheme), formatRateChip(lastRate, lastTtftMs, detailedRate)))
                    : color(rateColor(lastRate, lightTheme), formatRateChip(lastRate, lastTtftMs, detailedRate))
                  : "",
          ],
          ["timers", timersText ? theme.fg("dim", timersText) : ""],
        ];
        // /footer's order: a stable sort, so the rate-limit slots stay together.
        const rank = (id: FooterLineChipId) => shown().order.indexOf(id);
        chips.sort(([a], [b]) => rank(a) - rank(b));
        // /footer samples every chip, hidden ones included; the walk below
        // then skips the hidden ones.
        const samples = new Map<FooterChipId, string>();
        for (const [id, text] of chips) {
          if (text) samples.set(id, samples.has(id) ? `${samples.get(id)} ${text}` : text);
        }
        // /footer's preview: the selected chip blinks underlined, the rest go
        // faint gray (faint too, so a chip that is already dim, like boot or
        // idle, still stands out when selected), and hidden chips show struck
        // through so you can see where they'd go.
        const previewStyle = (id: FooterChipId, text: string): string => {
          if (!previewChip || !text) return text;
          const styled = id === previewChip ? blink(underline(text)) : faint(theme.fg("dim", stripAnsi(text)));
          return footerConfig.hidden.has(id) ? strike(styled) : styled;
        };
        // The selected chip, when it has nothing to show right now, stands in
        // with its example, styled the way the real chip is, so you see what
        // it would look like and where it would sit.
        const placeholder = (id: FooterChipId): string => {
          const text = FOOTER_CHIPS.find((chip) => chip.id === id)?.example ?? "";
          switch (id) {
            case "dir":
            case "worktree":
              return color(BLUE, text);
            case "git":
              return `${color(MAGENTA, "main*")} ${color(CYAN, "⇡")}`;
            case "provider":
            case "model":
            case "thinking":
              return color(BRIGHT_YELLOW, text);
            case "bypass":
              return color(BRIGHT_RED, text);
            case "context":
              return `${color(contextColorCode(42_000, 1_000_000), "42k")}/${color(CYAN, "1m")}`;
            case "cost":
              return color(GREEN, text);
            case "usage":
              return color(YELLOW, text);
            case "rate":
              return color(rateColor(99, lightTheme), text);
            case "name":
              return color(CYAN, text);
            default:
              // boot and the status row are dim in the real footer.
              return theme.fg("dim", text);
          }
        };
        const previewEmpty = previewChip !== undefined && !chips.some(([id, text]) => id === previewChip && text);
        // Hidden chips (outside the preview) and empties drop out; zones are
        // relative to each chip, placed by whoever lays the chips out.
        const parts: FooterPart[] = [];
        let examplePlaced = false;
        for (const [id, raw] of chips) {
          // Rate limits fill several slots; the example takes only the first.
          const isExample = !raw && previewEmpty && id === previewChip && !examplePlaced;
          if (isExample) examplePlaced = true;
          const text = isExample ? placeholder(id) : raw;
          if (!text || (shown().hidden.has(id) && !previewChip)) continue;
          const part = previewStyle(id, text);
          const partWidth = visibleWidth(part);
          const span: ClickZone = [0, partWidth];
          const zones: FooterClickRow = {};
          if (isExample) {
            // A stand-in has nothing to act on, so no click zone.
          } else if (id === "git") {
            zones.gitBranch = [0, gitChip.branchWidth];
            if (gitChip.behindOffset !== undefined) zones.gitBehind = [gitChip.behindOffset, gitChip.behindOffset + 1];
            if (gitChip.aheadOffset !== undefined) zones.gitAhead = [gitChip.aheadOffset, gitChip.aheadOffset + 1];
          } else if (id === "cost") {
            // A budget chip (ollama/baseten/openrouter) toggles percent/total;
            // the plain session-cost fallback stays glance-only.
            if (usageValue) zones.cost = span;
          } else if (id === "usage") {
            zones.usage = span;
          } else if (id !== "worktree" && id !== "timers") {
            // The worktree and timers chips are glance-only; every other chip is its own zone.
            zones[id] = span;
          }
          parts.push({ id, text: part, width: partWidth, zones });
        }
        return { parts, samples, statuses, previewStyle, placeholder };
      };
      borderParts = () => (enabled && shown().placement?.includes(" border") ? collect().parts : []);

      return {
        dispose: () => {
          unsubscribe();
          footerClickRows = [];
          borderParts = undefined;
          topClickRow = {};
          bottomClickRow = {};
          repaint = undefined;
        },
        invalidate(): void {},
        handleMouse(event: TuiMouseEvent) {
          // Fullscreen only: in regular mode the terminal owns the scrollback
          // buffer and mouse stays with terminal selection.
          if (tui.mode !== "fullscreen") return undefined;
          if (event.button !== "left") return undefined;
          // Capture the gesture on press (suppresses transcript selection and
          // routes the synthesized click back here), act on click so a drag
          // starting on a chip doesn't fire.
          if (event.type !== "press" && event.type !== "click") return undefined;
          const action = footerChipAction(event.x, event.y);
          if (!action) return undefined;
          if (event.type === "click") runChipAction(action, event.shift === true);
          return { handled: true };
        },
        render(width: number): string[] {
          if (width <= 0) return [];
          const { parts, samples, statuses, previewStyle, placeholder } = collect();
          // Border placement: leave out the chips the editor drew this pass.
          const taken = previewChip ? [] : [...(borderTaken ?? [])];
          const below = parts.filter((part) => {
            const i = taken.indexOf(partKey(part));
            if (i === -1) return true;
            taken.splice(i, 1);
            return false;
          });

          const nameText = sessionNameText(theme, requestRender);
          if (nameText) samples.set("name", nameText);
          const nameShown = nameText || (previewChip === "name" ? placeholder("name") : "");
          // In border mode the editor's top border carries the name instead.
          const right = previewChip ? previewStyle("name", nameShown) : nameInFooter() ? nameText : "";

          // Wrap, don't truncate: chips fill a row and whole chips move down
          // to the next row when the terminal is too narrow, so nothing is
          // ever cut mid-chip. The session/peer name owns the right end of the
          // first row, so the first row's chips fill only the space left of
          // it; later rows get the full width. The same walk records the
          // clickable chip columns per row; skipped empties contribute no
          // separator, non-empty parts join with one space.
          const chipRows: Array<{ line: string; zones: FooterClickRow }> = [];
          const nameWidth = visibleWidth(right);
          const firstLimit = nameWidth > 0 ? Math.max(0, width - nameWidth - 1) : width;
          let rowLimit = firstLimit;
          let current = "";
          let cursor = 0;
          let zones: FooterClickRow = {};
          const flushChipRow = () => {
            const line = truncateToWidth(current, rowLimit, "…");
            const paintedWidth = visibleWidth(line);
            const clipped: FooterClickRow = {};
            for (const [key, zone] of Object.entries(zones) as Array<[FooterZoneKey, ClickZone]>) {
              const fitted = clipZone(zone, paintedWidth);
              if (fitted) clipped[key] = fitted;
            }
            chipRows.push({ line, zones: clipped });
            current = "";
            cursor = 0;
            zones = {};
            rowLimit = width;
          };
          for (const part of below) {
            // A chip moves down whole when it cannot fit its row's budget —
            // except a chip wider than the terminal itself, which can never
            // fit and is placed anyway (the flush truncates it). A lone chip
            // wider than the first row's name-budget also moves down, leaving
            // that row to the name.
            const fitsHere =
              cursor === 0 ? part.width <= rowLimit || rowLimit >= width : cursor + 1 + part.width <= rowLimit;
            if (!fitsHere) flushChipRow();
            if (cursor > 0) {
              current += " ";
              cursor += 1;
            }
            for (const [key, zone] of Object.entries(part.zones) as Array<[FooterZoneKey, ClickZone]>) {
              const placed: ClickZone = [zone[0] + cursor, zone[1] + cursor];
              // Several provider statuses on a row share one toggle target.
              zones[key] = key === "usage" && zones.usage ? [zones.usage[0], placed[1]] : placed;
            }
            current += part.text;
            cursor += part.width;
          }
          if (cursor > 0) flushChipRow();

          // The session/peer name stays right-aligned on the first row. The
          // chip budget above reserved its space, so the pad never truncates;
          // only a name at least as wide as the terminal (firstLimit 0) can
          // miss the fit, and then it replaces the (necessarily empty) first
          // chip row rather than painting over the chips.
          if (nameWidth > 0) {
            const fittedNameWidth = visibleWidth(truncateToWidth(right, width, "…"));
            const nameZone: ClickZone = [width - fittedNameWidth, width];
            const first = chipRows[0];
            if (!first) {
              chipRows.push({ line: alignRight(right, width), zones: { name: nameZone } });
            } else if (visibleWidth(first.line) + 1 + nameWidth <= width) {
              chipRows[0] = {
                line: padBetween(first.line, right, width),
                zones: { ...first.zones, name: nameZone },
              };
            } else {
              // The name replaced the whole row, so don't retain invisible
              // chip zones from the row that was displaced.
              chipRows[0] = { line: alignRight(right, width), zones: { name: nameZone } };
            }
          }

          const lines = chipRows.map((row) => row.line);
          const extra: string[] = [];
          for (const [key, value] of statuses) {
            if (!value || (INLINE_STATUS_KEYS as readonly string[]).includes(key)) continue;
            // The timers chip owns the scheduler's status when it can read it.
            if (key === TIMERS_STATUS_KEY && parseTimerStatus(value)) continue;
            extra.push(value);
          }
          if (extra.length > 0) {
            samples.set("statuses", extra.join(" "));
            const statusLine = theme.fg("dim", extra.join(" "));
            if (previewChip) lines.push(truncateToWidth(previewStyle("statuses", statusLine), width, "…"));
            else if (!shown().hidden.has("statuses")) lines.push(truncateToWidth(statusLine, width, "…"));
            else {
              // Hidden (saved, or by the minimal view): ⚠ alarms still show, undimmed.
              const alarms = alarmStatuses(extra);
              if (alarms.length > 0) lines.push(truncateToWidth(alarms.join(" "), width, "…"));
            }
          } else if (previewChip === "statuses") {
            lines.push(truncateToWidth(previewStyle("statuses", placeholder("statuses")), width, "…"));
          }
          chipSamples = samples;
          // Publish the chip zones per painted line for the click hit test.
          // Aligned with `lines` so handleMouse's local event.y indexes
          // straight into it. Extra status rows carry no zones and never hit.
          footerClickRows = lines.map((_, index) => chipRows[index]?.zones ?? {});
          return lines;
        },
      };
    });
  }

  function padBetween(left: string, right: string, width: number): string {
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "…");
  }

  function alignRight(text: string, width: number): string {
    const fitted = truncateToWidth(text, width, "…");
    return `${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`;
  }

  /**
   * Take over the guardian's persistent below-editor warning.
   *
   * The guardian refuses to bypass outside the TUI so its warning stays
   * visible; the footer marker is just as persistent, so the property holds —
   * but only while the footer is on, hence the `enabled` guard.
   */
  function suppressGuardianWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!enabled || !ctx.hasUI || !bypassed) return;
    ctx.ui.setWidget(GUARDIAN_WIDGET_KEY, undefined);
  }

  /**
   * Cycle forward through the scoped models — the extension-side equivalent of
   * Ctrl+P (session.cycleModel("forward") with a non-empty scope). pi.setModel
   * reaches session.setModel, which applies the per-model thinking override,
   * logs the change and fires model_select; an explicit thinking level on the
   * scope entry ("provider/model:high") is applied on top, matching the
   * built-in cycle.
   */
  async function cycleScopedModelForward(): Promise<void> {
    const ctx = runtimeContext;
    if (!ctx?.hasUI) return;
    const scoped = ctx.scopedModels;
    if (scoped.length === 0) {
      // Scopeless Ctrl+P cycles every available model, but the extension API
      // exposes no catalogue snapshot to walk — say so instead.
      ctx.ui.notify("No scoped models — add some with /scoped-models", "info");
      return;
    }
    if (scoped.length === 1) {
      ctx.ui.notify("Only one model in scope", "info");
      return;
    }
    const current = ctx.model;
    let index = scoped.findIndex(
      (scopedModel) =>
        scopedModel.model.provider === current?.provider &&
        scopedModel.model.id === current?.id,
    );
    if (index === -1) index = 0;
    // pi.setModel refuses models whose provider has no configured auth
    // (Ctrl+P pre-filters those out of the cycle), so walk forward until one
    // takes.
    for (let step = 0; step < scoped.length; step += 1) {
      const next = scoped[(index + 1 + step) % scoped.length]!;
      let switched: boolean;
      try {
        switched = await pi.setModel(next.model);
      } catch {
        switched = false;
      }
      if (!switched) continue;
      if (next.thinkingLevel) pi.setThinkingLevel(next.thinkingLevel);
      const thinking =
        next.model.reasoning && pi.getThinkingLevel() !== "off"
          ? ` (thinking: ${pi.getThinkingLevel()})`
          : "";
      ctx.ui.notify(`Switched to ${next.model.name || next.model.id}${thinking}`, "info");
      return;
    }
    ctx.ui.notify("No scoped model has auth configured", "warning");
  }

  function queueModelCycle(): void {
    cycleQueue = cycleQueue.then(cycleScopedModelForward).catch(() => {});
  }

  /**
   * Click the thinking chip: step forward through pi's ladder, wrapping past
   * max to the lowest on-level (never "off" — a click shouldn't silently
   * disable reasoning).
   *
   * pi.setThinkingLevel clamps to what the model supports, so each step is
   * verified: when the effective level didn't move (e.g. xhigh on a model
   * without an xhigh mapping clamps back to high) the walk continues past the
   * unsupported level instead of getting stuck requesting it forever.
   */
  function cycleThinkingForward(): void {
    const ctx = runtimeContext;
    if (!ctx?.hasUI) return;
    if (!ctx.model?.reasoning) {
      ctx.ui.notify("Current model does not use thinking levels", "info");
      return;
    }
    const current = pi.getThinkingLevel();
    const at = (THINKING_ORDER as readonly string[]).indexOf(current);
    for (let step = 1; step <= THINKING_ORDER.length; step += 1) {
      const candidate =
        THINKING_ORDER[(at + step + THINKING_ORDER.length) % THINKING_ORDER.length]!;
      if (candidate === "off") continue;
      pi.setThinkingLevel(candidate);
      const effective = pi.getThinkingLevel();
      if (effective !== current) {
        ctx.ui.notify(`Thinking: ${current} → ${effective}`, "info");
        return;
      }
      // No movement: the model has no such level (clamped back). Keep walking.
    }
    ctx.ui.notify(`Thinking stays ${current} (no other level supported)`, "info");
  }

  /**
   * Shared by /bypass and a click on the bypass marker. The marker only
   * renders while bypassed, so a click always means "turn it off".
   */
  async function setBypassActive(
    next: boolean,
    ctx: ExtensionContext | ExtensionCommandContext | undefined = runtimeContext,
  ): Promise<void> {
    if (!ctx?.hasUI) return;
    if (next === bypassed) {
      ctx.ui.notify(`Approval Guardian is already ${next ? "bypassed" : "enabled"}`, "info");
      return;
    }
    if (!pi.getCommands().some((command) => command.name === GUARDIAN_COMMAND)) {
      // Without the guardian loaded this would go to the LLM as a plain message.
      ctx.ui.notify(`/${GUARDIAN_COMMAND} is not available`, "error");
      return;
    }
    const request = { active: next, quiet: true, handled: false };
    pi.events.emit(GUARDIAN_BYPASS_CONTROL_EVENT, request);
    if (!request.handled) {
      const { pin, settings } = await guardianPin();
      // Boehsline bundles a guardian that answers the control event
      // (packages/approval-guardian); upstream builds don't. Not handled means
      // another guardian package is loaded instead of, or ahead of, that one.
      ctx.ui.notify(
        `${pin || "The loaded Approval Guardian"} does not support immediate bypass control.` +
          ` Boehsline's bundled guardian does: remove ${pin ? `"${pin}"` : "the other approval-guardian package"}` +
          ` from ${tildePath(settings)} and /reload, or use /approval-guardian bypass.`,
        "error",
      );
      return;
    }
    if (next) suppressGuardianWidget(ctx);
  }

  /** Shared by /boot stats and a click on the boot timer chip. */
  async function showBootStats(
    limit: number,
    ctx: ExtensionContext | ExtensionCommandContext | undefined = runtimeContext,
  ): Promise<void> {
    if (!ctx?.hasUI) return;
    let boots: BootRecord[] = [];
    try {
      boots = await readBoots(limit);
    } catch {
      // No log yet.
    }
    if (boots.length === 0) {
      ctx.ui.notify("No boot times recorded yet", "warning");
      return;
    }
    const sorted = boots.map((boot) => boot.ms).sort((a, b) => a - b);
    // Compare like with like: a burst of relaunches and a one-off launch
    // differ by more than most changes worth measuring, so an undivided p50
    // mostly reports how you happened to be using pi that day.
    const burst = boots.filter((boot) => boot.since !== undefined && boot.since < BOOT_BURST_WINDOW_S);
    const isolated = boots.filter((boot) => boot.since !== undefined && boot.since >= BOOT_BURST_WINDOW_S);
    const loads = boots.map((boot) => boot.load).filter((load): load is number => load !== undefined);
    const cohorts = [
      burst.length > 0 ? `burst <${BOOT_BURST_WINDOW_S}s (n=${burst.length}) ${cohortSummary(burst.map((b) => b.ms))}` : "",
      isolated.length > 0 ? `isolated (n=${isolated.length}) ${cohortSummary(isolated.map((b) => b.ms))}` : "",
      loads.length > 0 ? `load p50 ${percentile([...loads].sort((a, b) => a - b), 50).toFixed(2)}` : "",
    ].filter(Boolean);
    ctx.ui.notify(
      `${boots.length} launches · p50 ${formatMs(percentile(sorted, 50))}` +
        ` · p95 ${formatMs(percentile(sorted, 95))}` +
        ` · min ${formatMs(sorted[0] ?? 0)} · max ${formatMs(sorted[sorted.length - 1] ?? 0)}` +
        (bootMs === undefined ? "" : ` · this one ${formatMs(bootMs)}`) +
        (cohorts.length > 0 ? `\n${cohorts.join(" · ")}` : ""),
      "info",
    );
  }

  // provider-usage.ts pings these after writing fresh MTD values to their
  // globalThis stashes; without it the chip waits for the next render event.
  pi.events.on("baseten-usage:updated", () => {
    repaint?.();
  });
  pi.events.on("openrouter-usage:updated", () => {
    repaint?.();
  });
  pi.events.on("ollama-usage:updated", () => {
    repaint?.();
  });

  // openrouter-route.ts sniffs the served provider out of the response stream.
  pi.events.on("openrouter-route:updated", () => {
    repaint?.();
  });

  pi.events.on(GUARDIAN_BYPASS_STATE_EVENT, (state: unknown) => {
    if (
      !state ||
      typeof state !== "object" ||
      typeof (state as { active?: unknown }).active !== "boolean"
    ) return;
    bypassed = (state as { active: boolean }).active;
    if (bypassed && runtimeContext) suppressGuardianWidget(runtimeContext);
    repaint?.();
  });

  pi.registerCommand("bypass", {
    description: "Toggle Approval Guardian bypass, shown in the footer",
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      const next =
        argument === "on" ? true
        : argument === "off" ? false
        : argument === "" ? !bypassed
        : undefined;
      if (next === undefined) {
        ctx.ui.notify("Usage: /bypass [on|off]", "warning");
        return;
      }
      await setBypassActive(next, ctx);
    },
  });

  pi.registerCommand("boot", {
    description: "Show this launch's boot time, or /boot stats [n] for recent launches",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (/^stats\b/.test(argument)) {
        const requested = Number.parseInt(argument.slice("stats".length).trim(), 10);
        const limit = Number.isFinite(requested) && requested > 0 ? requested : BOOT_STATS_DEFAULT;
        await showBootStats(limit, ctx);
        return;
      }

      const uptime = formatMs(Math.round(process.uptime() * 1_000));
      ctx.ui.notify(
        bootMs === undefined ?
          `Up ${uptime} (boot not measured — footer was off at launch)`
        : `Booted in ${formatMs(bootMs)}, up ${uptime}. Trend: /boot stats · Breakdown: PI_TIMING=1 PI_STARTUP_BENCHMARK=1 pi`,
        "info",
      );
    },
  });

  pi.registerCommand("footer", {
    description: "Choose which footer chips show; /footer minimal|full|saved switches this session's view, /footer on|off toggles it",
    getArgumentCompletions: (prefix: string) => {
      const items = [...FOOTER_VIEWS, "on", "off"].map((value) => ({ value, label: value }));
      const typed = prefix.trim().toLowerCase();
      // An exact match gets no menu: with one open, Enter only accepts the
      // completion, so `/footer minimal` + Enter would need a second Enter.
      if (items.some((item) => item.value === typed)) return null;
      const filtered = items.filter((item) => item.value.startsWith(typed));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (argument === "on" || argument === "off" || argument === "toggle") {
        enabled = argument === "toggle" ? !enabled : argument === "on";
        apply(ctx);
        ctx.ui.notify(enabled ? "footer enabled" : "footer disabled", "info");
        return;
      }
      if (isFooterView(argument)) {
        setView(argument);
        ctx.ui.notify(
          argument === "saved" ? "Footer: saved layout" : `Footer: ${argument} view for this session \u00b7 /footer saved to return`,
          "info",
        );
        return;
      }
      if (argument) {
        ctx.ui.notify("Usage: /footer (choose chips), /footer minimal|full|saved, /footer on|off", "warning");
        return;
      }
      if (!ctx.hasUI) return;
      // Another session may have changed footer.json since this one read it;
      // pick that up unless this session has changes of its own to keep.
      if (!sessionEdited) footerConfig = readFooterConfig();
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        // Wide enough for every row's name, indented setting rows included
        // ("  Thinking condition"), so the selected row's highlight covers it.
        const labelWidth = Math.max(
          ...FOOTER_CHIPS.map((chip) => chip.label.length),
          ...CONDITION_ROWS.map((row) => `  ${row.label}`.length),
          ...LAYOUT_ROWS.map((row) => row.label.length),
        );
        // SettingsList aligns values after at most 36 label columns; a longer
        // label would push its value out of line, so samples fit in the rest.
        const sampleWidth = Math.max(8, 36 - labelWidth - 2);
        const chipById = new Map<FooterChipId, (typeof FOOTER_CHIPS)[number]>(FOOTER_CHIPS.map((chip) => [chip.id, chip]));
        // Rows follow the footer: the saved order, then the name and statuses, which stay put.
        const layoutItems = (): SettingItem[] =>
          LAYOUT_ROWS.map((row) => ({
            id: row.key,
            label: row.label.padEnd(labelWidth),
            description: row.description,
            currentValue: footerConfig[row.key] ?? row.values[0],
            values: [...row.values],
          }));
        const viewItem = (): SettingItem => ({
          id: "view",
          label: "View".padEnd(labelWidth),
          description: "This session only, never saved: minimal keeps dir, branch, model, context and usage; full shows every chip in detail. Chip edits below change the saved layout.",
          currentValue: view,
          values: [...FOOTER_VIEWS],
        });
        const buildItems = (): SettingItem[] => [
          viewItem(),
          ...layoutItems(),
          ...[...footerConfig.order, "name" as const, "statuses" as const].flatMap((id) => {
            const chip = chipById.get(id)!;
            const sample = chipSamples.get(id);
            const item: SettingItem = {
              id,
              // The live value in the footer's own colours.
              label: `${chip.label.padEnd(labelWidth)}  ${sample ? truncateToWidth(sample, sampleWidth, "…") : "—"}`,
              description: chip.description,
              // A chip with modes cycles through them, then hidden.
              currentValue: footerConfig.hidden.has(id) ? "hidden" : (chipMode(footerConfig, id) ?? "shown"),
              values: [...(CHIP_MODES[id] ?? ["shown"]), "hidden"],
            };
            // Each setting gets its own row under the chip, following it when the chip moves.
            const rows = CONDITION_ROWS.filter((condition) => condition.chip === id).map((row) => ({
              id: row.key,
              // Indented: a setting of the chip above, not a chip of its own.
              label: `  ${row.label}`.padEnd(labelWidth),
              description: row.description,
              currentValue: footerConfig[row.key] ?? row.values[0],
              values: [...row.values],
            }));
            return [item, ...rows];
          }),
        ];
        const listTheme: SettingsListTheme = {
          // Accent only the chip name: the sample after it keeps its colours.
          label: (text, selected) =>
            selected ? `${theme.fg("accent", text.slice(0, labelWidth))}${text.slice(labelWidth)}` : text,
          value: (text, selected) =>
            selected ? theme.fg("accent", text) : theme.fg(text === "hidden" ? "dim" : "muted", text),
          description: (text) => theme.fg("dim", text),
          cursor: theme.fg("accent", "→ "),
          hint: (text) => theme.fg("dim", text),
        };
        // Changes apply to this session only; Alt+S writes them to footer.json.
        let unsaved = !sameFooterConfig(footerConfig, readFooterConfig());
        let justSaved = false;
        const changed = () => {
          sessionEdited = true;
          unsaved = !sameFooterConfig(footerConfig, readFooterConfig());
          justSaved = false;
          repaint?.();
        };
        const persist = () => {
          try {
            writeFooterConfig(footerConfig);
            sessionEdited = false;
            unsaved = false;
            justSaved = true;
          } catch (error) {
            ctx.ui.notify(`Could not save ${footerConfigPath()}: ${(error as Error).message}`, "warning");
          }
        };
        const onChange = (id: string, value: string) => {
          if (id === "view") {
            if (isFooterView(value)) setView(value);
            return;
          }
          const layout = layoutRow(id);
          if (layout) {
            footerConfig[layout.key] = value;
            changed();
            return;
          }
          const row = conditionRow(id);
          if (row) {
            footerConfig[row.key] = value;
            if (row.key === "copilotOoo") {
              footerConfig.copilotOooSetAt = new Date().toISOString();
              // provider-usage recomputes the Copilot allowance with it, saved or not.
              pi.events.emit(FOOTER_COPILOT_OOO_EVENT, { days: Number(value), setAt: footerConfig.copilotOooSetAt });
            }
            changed();
            return;
          }
          const chip = id as FooterChipId;
          if (value === "hidden") {
            footerConfig.hidden.add(chip);
          } else {
            footerConfig.hidden.delete(chip);
            if (CHIP_MODES[chip]) footerConfig.modes[chip] = value;
          }
          // The new mode shows at once; clicks flip it from there.
          applySavedModes();
          changed();
        };
        const close = () => {
          previewChip = undefined;
          repaint?.();
          done(undefined);
        };
        let items = buildItems();
        const makeList = (select?: string) => {
          const created = new SettingsList(items, Math.min(items.length, 22), listTheme, onChange, close);
          if (select) created.selectItem(select);
          return created;
        };
        let list = makeList();
        // SettingsList keeps its cursor private; read it to follow the
        // selection in the footer preview (search is off, so its index is ours).
        const selectedId = (): string | undefined => {
          const index = (list as unknown as { selectedIndex?: number }).selectedIndex;
          return typeof index === "number" ? items[index]?.id : undefined;
        };
        const syncPreview = () => {
          const id = selectedId();
          // A condition row previews the chip it applies to.
          // A layout row previews the whole row, from its first chip.
          previewChip =
            (id && (id === "view" || layoutRow(id)) && footerConfig.order[0]) ||
            (id && conditionRow(id)?.chip) ||
            ((id as FooterChipId | undefined) ?? FOOTER_CHIPS[0].id);
          repaint?.();
        };
        // J/K or Shift+↑/↓: move the selected chip; the list is rebuilt in the
        // new order with the chip still selected.
        const move = (delta: 1 | -1) => {
          const id = selectedId() as FooterChipId | undefined;
          if (!id || !isLineChip(id)) return;
          const order = footerConfig.order;
          const from = order.indexOf(id);
          const to = from + delta;
          if (from < 0 || to < 0 || to >= order.length) return;
          order.splice(from, 1);
          order.splice(to, 0, id);
          changed();
          items = buildItems();
          list = makeList(id);
        };
        syncPreview();
        const header = () => [
          theme.fg("accent", "Footer chips"),
          theme.fg("dim", "j/k select · J/K or ⇧↑/⇧↓ move · click a chip to flip its mode for this session"),
          ...(view === "saved"
            ? []
            : [theme.fg("warning", `Showing the ${view} view: chip edits change the saved layout · View → saved to see it`)]),
          "",
        ];
        // The save state, under the list.
        const status = (): string[] =>
          unsaved
            ? ["", theme.fg("warning", "● Unsaved: these changes last this session only · Alt+S to save for every session")]
            : justSaved
              ? ["", theme.fg("success", `✓ Saved to ${footerConfigPath().replace(homedir(), "~")}`)]
              : [];
        return {
          render: (width: number) =>
            [...header(), ...list.render(width), ...status()].map((line) => truncateToWidth(line, width, "…")),
          invalidate: () => list.invalidate(),
          handleInput: (data: string) => {
            // Alt+Shift+S too (Caps Lock, or tools that can only send ESC S).
            if (matchesKey(data, Key.alt("s")) || data === "\x1bS") persist();
            else if (data === "J" || matchesKey(data, Key.shift("down"))) move(1);
            else if (data === "K" || matchesKey(data, Key.shift("up"))) move(-1);
            else if (data === "j") list.handleInput("\x1b[B");
            else if (data === "k") list.handleInput("\x1b[A");
            else list.handleInput(data);
            if (previewChip) syncPreview();
            tui.requestRender();
          },
          // The list's rows start below the header.
          handleMouse: (event: TuiMouseEvent) => {
            const result = list.handleMouse({ ...event, y: event.y - header().length });
            if (previewChip) syncPreview();
            return result;
          },
          dispose: () => {
            previewChip = undefined;
            repaint?.();
          },
        };
      });
    },
  });

  pi.on("session_start", async (event, ctx) => {
    await updateReady;
    runtimeContext = ctx;
    chipDefaults = readChipDefaults(ctx.cwd);
    // Session-local toggles reset instead of leaking into the next conversation.
    bypassed = false;
    turnStartMs = undefined;
    stopWaiting();
    streaming = false;
    firstTokenMs = undefined;
    tokensPerChar = DEFAULT_TOKENS_PER_CHAR;
    liveRate = undefined;
    liveTtftMs = undefined;
    lastRate = undefined;
    lastTtftMs = undefined;
    lastTurnMs = undefined;
    coldStart = event.reason === "startup";
    // The click toggles start each session in the modes /footer saved, and
    // unsaved /footer changes stay with the session they were made in.
    footerConfig = readFooterConfig();
    sessionEdited = false;
    view = "saved";
    applySavedModes();
    apply(ctx);
    installNameBorder(ctx);
    // Renders are event-driven, so an idle footer would otherwise miss a peer
    // name that lands after the last startup paint — until the next keystroke.
    for (const delay of PEER_SETTLE_DELAYS_MS) {
      setTimeout(() => peer.reload(() => repaint?.()), delay).unref?.();
    }
    // Renders are event-driven, so an idle session would never re-read the
    // version; poll so a pi upgrade surfaces like Claude's update notice.
    // session_start also fires on session switches — only start one timer.
    if (!updateTimerStarted) {
      updateTimerStarted = true;
      updateTimer = setInterval(() => {
        update.reload(() => repaint?.());
      }, UPDATE_TTL_MS);
      updateTimer.unref?.();
    }
  });
  // Retire the boot timer the moment a message is sent. Extension commands are
  // matched before this event, so /boot and /footer leave it alone; messages
  // this extension sends itself arrive as source "extension" and do too.
  pi.on("input", async (event) => {
    if (bootCleared || event.source !== "interactive") return undefined;
    bootCleared = true;
    repaint?.();
    return undefined;
  });

  /** Renders are event-driven; a 10Hz tick keeps the waiting TTFT counting. */
  function startWaiting(): void {
    waitingForToken = true;
    if (waitTimer === undefined) {
      waitTimer = setInterval(() => repaint?.(), WAIT_TICK_MS);
      waitTimer.unref?.();
    }
    repaint?.();
  }
  function stopWaiting(): void {
    waitingForToken = false;
    if (waitTimer !== undefined) clearInterval(waitTimer);
    waitTimer = undefined;
  }

  // One turn is one LLM request: turn_start fires just before it goes out.
  pi.on("turn_start", async () => {
    turnStartMs = Date.now();
    startWaiting();
  });
  pi.on("message_start", async (event) => {
    if (!isAssistant(event.message)) return;
    streaming = true;
    firstTokenMs = undefined;
    streamChars = 0;
    lastRateRepaintMs = 0;
    liveRate = undefined;
    liveTtftMs = undefined;
    repaint?.();
  });
  pi.on("message_update", async (event) => {
    if (!streaming || !isAssistant(event.message)) return;
    const update = event.assistantMessageEvent;
    if (!isStreamDelta(update)) return;
    const now = Date.now();
    if (firstTokenMs === undefined) {
      firstTokenMs = now;
      if (turnStartMs !== undefined) liveTtftMs = now - turnStartMs;
      stopWaiting();
      repaint?.();
    }
    streamChars += streamedChars(update);
    const elapsed = now - firstTokenMs;
    if (elapsed < MIN_RATE_WINDOW_MS || now - lastRateRepaintMs < RATE_REPAINT_MS) return;
    const tokens = Math.max(outputTokens(event.message), streamChars * tokensPerChar);
    if (tokens <= 0) return;
    liveRate = tokens / (elapsed / 1_000);
    lastRateRepaintMs = now;
    repaint?.();
  });
  pi.on("message_end", async (event) => {
    if (!streaming || !isAssistant(event.message)) return undefined;
    const now = Date.now();
    if (turnStartMs !== undefined) lastTurnMs = now - turnStartMs;
    const tokens = outputTokens(event.message);
    if (firstTokenMs !== undefined && tokens > 0) {
      const deltaWindow = now - firstTokenMs;
      // A buffered stream dumps every delta in a few ms, so the delta window
      // measures the burst, not the generation. Fall back to the whole request
      // (turn start → end), which is honest though it folds TTFT into the rate.
      const burst = deltaWindow < RATE_BURST_WINDOW_MS && turnStartMs !== undefined;
      const elapsed = burst ? now - turnStartMs! : deltaWindow;
      // Aborted/errored replies and tiny blips keep the previous figure.
      if (elapsed >= MIN_RATE_WINDOW_MS) {
        lastRate = tokens / (elapsed / 1_000);
        lastTtftMs = liveTtftMs;
      }
      if (streamChars > 0) {
        const observed = tokens / streamChars;
        tokensPerChar = tokensPerChar * (1 - CALIBRATION_WEIGHT) + observed * CALIBRATION_WEIGHT;
      }
    }
    streaming = false;
    stopWaiting();
    firstTokenMs = undefined;
    liveRate = undefined;
    repaint?.();
    return undefined;
  });
  // message_end should always arrive, but never leave the chip stuck dim.
  pi.on("agent_end", async () => {
    if (!streaming && !waitingForToken) return;
    streaming = false;
    stopWaiting();
    liveRate = undefined;
    repaint?.();
  });

  pi.on("model_select", async (_event, ctx) => {
    // A rate and its calibration belong to the model that produced them.
    lastRate = undefined;
    lastTtftMs = undefined;
    lastTurnMs = undefined;
    tokensPerChar = DEFAULT_TOKENS_PER_CHAR;
    // Choosing a provider after /login saves it as the default.
    chipDefaults = readChipDefaults(ctx.cwd);
    apply(ctx);
  });
  // `!git switch`, `!git commit`, `!echo >> file`: show the result as soon as
  // the command finishes, not up to 5s later. Polls for a few seconds (renders
  // drive the git cache) and never handles the command itself.
  let gitTicker: ReturnType<typeof setInterval> | undefined;
  const stopGitTicker = () => {
    if (gitTicker !== undefined) clearInterval(gitTicker);
    gitTicker = undefined;
  };
  pi.on("user_bash", async () => {
    git.expedite();
    stopGitTicker();
    const until = Date.now() + GIT_EXPEDITE_WINDOW_MS;
    gitTicker = setInterval(() => {
      if (Date.now() >= until) stopGitTicker();
      else repaint?.();
    }, GIT_EXPEDITE_TTL_MS);
    gitTicker.unref?.();
    return undefined;
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stopWaiting();
    stopGitTicker();
    if (updateTimer !== undefined) clearInterval(updateTimer);
    updateTimer = undefined;
    if (ctx.hasUI) {
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget(UPDATE_WIDGET_KEY, undefined);
    }
  });
}
