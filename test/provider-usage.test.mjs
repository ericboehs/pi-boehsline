/**
 * Tests for the OpenCode Go usage parsers in provider-usage.ts.
 *
 * The chip prefers GET /zen/go/v1/usage (API key). The console status API
 * remains the cookie fallback. Both JSON shapes are pinned here.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  IDLE_POLL_MS,
  pollFetches,
  claudeBillingAlarm,
  claudeLimitWindows,
  claudeModelFamily,
  claudeWindowsForFamily,
  copilotUsageDisplay,
  effectiveOooDays,
  workdaysBetween,
  formatUsageCacheReport,
  grokUsageDisplay,
  opencodeGoCookieHeader,
  parseOpencodeGoStatus,
  parseOpencodeGoUsage,
  resolveUsageDriver,
  summarizeUsageCache,
} from "../extensions/provider-usage/index.ts";
import providerUsage from "../extensions/provider-usage/index.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Shape of GET /console/api/go/status: microcents are bigints, so they arrive
// as JSON strings; `month` carries no rolling window of its own.
const FIXTURE = {
  subscriberUserID: "usr_01ABC",
  access: {
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-10-01T00:00:00.000Z",
    meters: {
      fiveHour: {
        startsAt: "2026-09-19T10:00:00.000Z",
        resetsAt: "2026-09-19T15:00:00.000Z",
        limitMicroCents: "1200000000",
        usedMicroCents: "744000000",
      },
      week: {
        startsAt: "2026-09-14T00:00:00.000Z",
        resetsAt: "2026-09-21T00:00:00.000Z",
        limitMicroCents: 3000000000,
        usedMicroCents: 960000000,
      },
      month: { limitMicroCents: "6000000000", usedMicroCents: "4344000000" },
    },
  },
};

test("parseOpencodeGoStatus maps the three console meters", () => {
  const meters = parseOpencodeGoStatus(FIXTURE);
  assert.deepEqual(meters.map((m) => m.label), ["5h rolling", "Weekly", "Monthly"]);

  const [fiveHour, week, month] = meters;
  // 744000000 / 1200000000 microcents = $7.44 of $12 = 62%.
  assert.equal(fiveHour.percent, 62);
  assert.equal(fiveHour.resetMs, Date.parse("2026-09-19T15:00:00.000Z"));
  assert.equal(fiveHour.seconds, 5 * 3_600);

  // Numeric microcent encodings count too (31.999…→ 32.0, one decimal).
  assert.equal(week.percent, 32);
  assert.equal(week.resetMs, Date.parse("2026-09-21T00:00:00.000Z"));

  // The month meter has no window: the paid period end is its reset.
  assert.equal(month.percent, 72.4);
  assert.equal(month.resetMs, Date.parse("2026-10-01T00:00:00.000Z"));
});

test("parseOpencodeGoStatus leaves the monthly reset undefined without a period end", () => {
  const meters = parseOpencodeGoStatus({
    access: { meters: { month: { limitMicroCents: "6000000000", usedMicroCents: "4344000000" } } },
  });
  assert.equal(meters.length, 1);
  assert.equal(meters[0]?.resetMs, undefined);
});

test("parseOpencodeGoStatus reports nothing for payloads without meters", () => {
  assert.deepEqual(parseOpencodeGoStatus(null), []);
  assert.deepEqual(parseOpencodeGoStatus({}), []);
  assert.deepEqual(parseOpencodeGoStatus({ access: {} }), []);
  // Signed out: the console answers 401 long before this, but a payload
  // without usable money fields must not become a confident zero either.
  assert.deepEqual(
    parseOpencodeGoStatus({ access: { meters: { fiveHour: { unlimited: true } } } }),
    [],
  );
});

test("parseOpencodeGoStatus clamps a zero limit to 0%", () => {
  const meters = parseOpencodeGoStatus({
    access: { meters: { fiveHour: { limitMicroCents: "0", usedMicroCents: "500" } } },
  });
  assert.equal(meters.length, 1);
  assert.equal(meters[0]?.percent, 0);
});

test("parseOpencodeGoUsage maps the key usage API windows", () => {
  const meters = parseOpencodeGoUsage({
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-09-25T00:43:18.063Z" },
      weekly: { status: "ok", percent: 55.04, resetsAt: "2026-09-28T00:00:00.000Z" },
      monthly: { status: "ok", percent: "84", resetsAt: "2026-10-08T22:06:17.000Z" },
    },
  });
  assert.deepEqual(meters.map((m) => m.label), ["5h rolling", "Weekly", "Monthly"]);

  const [rolling, weekly, monthly] = meters;
  assert.equal(rolling.percent, 0);
  assert.equal(rolling.resetMs, Date.parse("2026-09-25T00:43:18.063Z"));
  assert.equal(rolling.seconds, 5 * 3_600);
  assert.equal(rolling.usage, undefined);

  // One decimal, matching the console meter's percent precision.
  assert.equal(weekly.percent, 55);
  assert.equal(weekly.resetMs, Date.parse("2026-09-28T00:00:00.000Z"));

  // String percents count too.
  assert.equal(monthly.percent, 84);
  assert.equal(monthly.resetMs, Date.parse("2026-10-08T22:06:17.000Z"));
  assert.equal(monthly.seconds, 30 * 86_400);
});

test("parseOpencodeGoUsage skips windows without a percent and ignores a bad reset", () => {
  const meters = parseOpencodeGoUsage({
    usage: {
      rolling: { status: "ok", resetsAt: "2026-09-25T00:43:18.063Z" },
      weekly: { status: "ok", percent: 12, resetsAt: "not-a-date" },
    },
  });
  assert.equal(meters.length, 1);
  assert.equal(meters[0]?.label, "Weekly");
  assert.equal(meters[0]?.percent, 12);
  assert.equal(meters[0]?.resetMs, undefined);
});

test("parseOpencodeGoUsage reports nothing for payloads without usage windows", () => {
  assert.deepEqual(parseOpencodeGoUsage(null), []);
  assert.deepEqual(parseOpencodeGoUsage({}), []);
  assert.deepEqual(parseOpencodeGoUsage({ usage: {} }), []);
  assert.deepEqual(parseOpencodeGoUsage({ rollingUsage: { usagePercent: 1 } }), []);
});

test("opencodeGoCookieHeader pairs known names and prefixes bare values", () => {
  const consoleName = "__Host-console_session";
  // A bare session value (the env/fnox storage format) gets the console name.
  assert.equal(opencodeGoCookieHeader("rawsessionvalue"), `${consoleName}=rawsessionvalue`);
  // Known cookie names pass through, extra pairs and all.
  assert.equal(
    opencodeGoCookieHeader("auth=abc; other=def"),
    "auth=abc; other=def",
  );
  assert.equal(
    opencodeGoCookieHeader("__Host-console_session=abc"),
    "__Host-console_session=abc",
  );
  // A bare base64 value ending in `=` is not mistaken for a name=value pair.
  assert.equal(opencodeGoCookieHeader("Zm9vYmFy="), `${consoleName}=Zm9vYmFy=`);
  // An unknown name is treated as a bare value, and trailing `;` is trimmed.
  assert.equal(opencodeGoCookieHeader(" token ; "), `${consoleName}=token`);
});

const NOW = 1_700_000_000_000;

function row(id, cache, now = NOW) {
  return summarizeUsageCache(cache, now).find((entry) => entry.id === id);
}

test("summarizeUsageCache marks fresh, stale, and missing without treating a hole as zero", () => {
  const rows = summarizeUsageCache({
    "ollama-usage": {
      value: "$1 / $60 (2%)",
      commandText: "Included (pro): $1 of $60",
      fetchedAt: NOW - 30_000,
    },
    // Window chips share the 2-minute file TTL. 130s is stale; a scrape is not.
    "codex-window": { value: "1/5H: 10%", fetchedAt: NOW - 130_000 },
    "grok-window": { value: "2/7D: 4%", fetchedAt: "nope" },
  }, NOW);

  // One row per driver; a cache hole becomes a missing row, not a zero.
  assert.equal(rows.length, 9);
  assert.equal(row("ollama-usage", {
    "ollama-usage": { value: "$1 / $60 (2%)", commandText: "Included (pro): $1 of $60", fetchedAt: NOW - 30_000 },
  }).status, "fresh");
  assert.equal(row("ollama-usage", {
    "ollama-usage": { value: "$1 / $60 (2%)", fetchedAt: NOW - 61_000 },
  }).status, "stale");
  assert.equal(row("codex-window", {
    "codex-window": { value: "1/5H: 10%", fetchedAt: NOW - 119_000 },
  }).status, "fresh");
  assert.equal(row("codex-window", {
    "codex-window": { value: "1/5H: 10%", fetchedAt: NOW - 130_000 },
  }).status, "stale");
  // pi's Anthropic login refetches on every 2-minute poll tick, latency included.
  assert.equal(row("claude-window", {
    "claude-window": { value: "1/5H: 8%", fetchedAt: NOW - 109_000 },
  }).status, "fresh");
  assert.equal(row("claude-window", {
    "claude-window": { value: "1/5H: 8%", fetchedAt: NOW - 111_000 },
  }).status, "stale");
  // Variant-keyed entries (claude's family filter): the freshest variant is the row.
  const claude = row("claude-window", {
    "claude-window": { value: "1/5H: 8%", fetchedAt: NOW - 109_000 },
    "claude-window:opus": { value: "1/5H: 8% 3.4/7D: 40%", fetchedAt: NOW - 30_000 },
  });
  assert.equal(claude.status, "fresh");
  assert.equal(claude.value, "1/5H: 8% 3.4/7D: 40%", "the freshest family wins over the older plain key");
  assert.equal(row("grok-window", { "grok-window": { value: "2/7D: 4%", fetchedAt: "nope" } }).status, "missing");
  assert.equal(row("copilot-window", {}).status, "missing");
  assert.equal(row("copilot-window", {}).value, undefined);

  const ollama = rows.find((entry) => entry.id === "ollama-usage");
  assert.equal(ollama.status, "fresh");
  assert.equal(ollama.ageMs, 30_000);
  assert.equal(ollama.commandText, "Included (pro): $1 of $60");
});

test("summarizeUsageCache treats a future fetchedAt as stale with no age", () => {
  const ollama = row("ollama-usage", {
    "ollama-usage": { value: "$1 / $60", fetchedAt: NOW + 5_000 },
  });
  assert.equal(ollama.status, "stale");
  assert.equal(ollama.ageMs, undefined);
  assert.equal(ollama.value, "$1 / $60");
});

test("Grok keeps the exact reset in cache and shows it in the tool report", () => {
  const resetMs = Date.parse("2023-11-20T08:15:30.000Z");
  const display = grokUsageDisplay({
    used_percent: 18,
    reset_at: resetMs / 1000,
    limit_window_seconds: 7 * 86_400,
  }, NOW);
  assert.equal(display.resetMs, resetMs);
  assert.match(display.value, /18%$/);
  assert.doesNotMatch(display.value, /Resets:/, "the footer chip stays compact");

  const cached = { "grok-window": { ...display, fetchedAt: NOW - 30_000 } };
  const grok = row("grok-window", cached);
  assert.equal(grok.resetMs, resetMs);
  assert.equal(
    formatUsageCacheReport([grok]),
    `xai fresh 30s\n${display.value}\nResets: 2023-11-20T08:15:30.000Z`,
  );
  assert.equal(
    formatUsageCacheReport([row("grok-window", { "grok-window": { value: "2/7D: 18%", fetchedAt: NOW - 30_000 } })]),
    "xai fresh 30s\n2/7D: 18%",
    "old cache entries cannot reconstruct the reset",
  );
});

test("Copilot caches a date-only reset without inventing a time", () => {
  const display = copilotUsageDisplay({ percent_remaining: 70, reset_date: "2023-12-01" }, undefined, NOW);
  assert.equal(display.resetDate, "2023-12-01");
  assert.equal(display.resetMs, undefined);
  assert.match(display.value, /W: 30% [\d.]+%\/d$/);
  const copilot = row("copilot-window", { "copilot-window": { ...display, fetchedAt: NOW - 30_000 } });
  assert.equal(copilot.resetDate, "2023-12-01");
  assert.equal(
    formatUsageCacheReport([copilot]),
    `github-copilot fresh 30s\n${display.value}\nResets: 2023-12-01 (date only)`,
  );
  const exhausted = copilotUsageDisplay({ percent_remaining: 0, reset_date: "2023-12-01" }, undefined, NOW);
  assert.match(exhausted.value, /↻2023-12-01$/, "the footer must not claim midnight precision");
  assert.equal(copilotUsageDisplay({ percent_remaining: 70, reset_date: "2023-02-30" }, undefined, NOW), undefined);
});

test("Copilot paces by local workdays and spreads what is left over the workdays ahead", () => {
  // Cycle Oct 1 – Nov 1 2026 (local); now Fri Oct 16 at noon.
  const reset = new Date(2026, 10, 1).toISOString();
  const now = new Date(2026, 9, 16, 12).getTime();
  // Elapsed: Oct 1–2, 5–9, 12–15 + half of the 16th = 11.5 of 22 workdays.
  // Allowance: 41% over today + 10 more workdays = 3.7%/d.
  assert.equal(copilotUsageDisplay({ percent_remaining: 41 }, reset, now).value, "11.5/22W: 59% 3.7%/d");
  // Two OOO days ahead: 20 workdays, 41% over 9 days.
  assert.equal(copilotUsageDisplay({ percent_remaining: 41 }, reset, now, 2).value, "11.5/20W: 59% 4.6%/d");
  // Saturday adds no workday time; the allowance starts Monday.
  const saturday = new Date(2026, 9, 17, 12).getTime();
  assert.equal(copilotUsageDisplay({ percent_remaining: 41 }, reset, saturday).value, "12/22W: 59% 4.1%/d");
  // More OOO than workdays left: no allowance to show.
  assert.equal(copilotUsageDisplay({ percent_remaining: 41 }, reset, now, 15).value, "11.5/11.5W: 59%");
});

test("workdaysBetween weights partial weekdays and skips weekends", () => {
  const friday = new Date(2026, 9, 16).getTime();
  const monday = new Date(2026, 9, 19).getTime();
  assert.equal(workdaysBetween(friday, monday), 1);
  assert.equal(workdaysBetween(friday + 6 * 3_600_000, monday + 12 * 3_600_000), 1.25);
  assert.equal(workdaysBetween(monday, friday), 0);
});

test("Copilot OOO days set in an earlier cycle no longer count", () => {
  const reset = new Date("2026-11-01T00:00:00Z");
  assert.equal(effectiveOooDays({ days: 2, setAt: "2026-10-05T00:00:00Z" }, reset), 2);
  assert.equal(effectiveOooDays({ days: 2, setAt: "2026-09-28T00:00:00Z" }, reset), 0);
  assert.equal(effectiveOooDays({ days: 2 }, reset), 2, "hand-edited, no stamp");
  assert.equal(effectiveOooDays(undefined, reset), 0);
});

test("Copilot caches an exact timestamp only when supplied by the API", () => {
  const timestamp = "2023-12-01T09:15:30.000Z";
  const display = copilotUsageDisplay({ percent_remaining: 70 }, timestamp, NOW);
  assert.equal(display.resetMs, Date.parse(timestamp));
  assert.equal(display.resetDate, undefined);
  const copilot = row("copilot-window", { "copilot-window": { ...display, fetchedAt: NOW - 30_000 } });
  assert.equal(
    formatUsageCacheReport([copilot]),
    `github-copilot fresh 30s\n${display.value}\nResets: ${timestamp}`,
  );
  assert.deepEqual(copilotUsageDisplay({ unlimited: true, reset_date: "2023-12-01" }), {
    value: "unlimited",
    quota: { unlimited: true, resetDate: "2023-12-01" },
  });
});

test("claudeLimitWindows: meters with a reset, is_active ignored, span from the kind or its group", () => {
  const reset = "2026-10-26T15:59:59.570269+00:00";
  const windows = claudeLimitWindows([
    // Idle window: Anthropic keeps the meter but nulls the reset.
    { kind: "session", group: "session", percent: 0, is_active: false, resets_at: null },
    // is_active: false does NOT mean unused: weekly_all arrives that way at 33%.
    { kind: "weekly_all", group: "weekly", percent: 33, is_active: false, resets_at: reset },
    { kind: "weekly_opus", group: "weekly", percent: 40, resets_at: reset },
    // A meter we have never seen: the group still gives its span.
    { kind: "weekly_cowork", group: "weekly", percent: 5, resets_at: reset },
    // Nothing to pace against, so it cannot render a chip.
    { kind: "session", group: "session", percent: 5, is_active: true, resets_at: null },
  ]);
  assert.deepEqual(
    windows.map((w) => w.label),
    ["Weekly (all models)", "Weekly Opus", "weekly cowork"],
  );
  assert.deepEqual(
    windows.map((w) => w.window.limit_window_seconds),
    [7 * 86_400, 7 * 86_400, 7 * 86_400],
  );
  assert.equal(windows[0]?.window.used_percent, 33);
  assert.equal(windows[0]?.window.reset_at, Math.floor(Date.parse(reset) / 1000));
  // An unknown group falls back to the session span; severity only rides along when abnormal.
  assert.equal(
    claudeLimitWindows([{ kind: "mystery", percent: 1, resets_at: reset }])[0]?.window.limit_window_seconds,
    5 * 3_600,
  );
  assert.deepEqual(
    claudeLimitWindows([{ kind: "weekly_all", percent: 99, severity: "critical", resets_at: reset }])[0]?.severity,
    "critical",
  );
  assert.equal(
    claudeLimitWindows([{ kind: "weekly_all", percent: 10, severity: "normal", resets_at: reset }])[0]?.severity,
    undefined,
  );
});

test("claudeWindowsForFamily: the chip shows the session plus the family's weekly; no family meter keeps them all", () => {
  const reset = "2026-10-26T15:59:59.570269+00:00";
  const windows = claudeLimitWindows([
    { kind: "session", percent: 20, resets_at: reset },
    { kind: "weekly_all", percent: 33, resets_at: reset },
    { kind: "weekly_opus", percent: 40, resets_at: reset },
    { kind: "weekly_sonnet", percent: 10, resets_at: reset },
  ]);
  // On an Opus model: the 5h session plus Opus's weekly; weekly_all and Sonnet drop.
  assert.deepEqual(
    claudeWindowsForFamily(windows, claudeModelFamily("claude-opus-5-5")).map((w) => w.label),
    ["5h session", "Weekly Opus"],
  );
  assert.deepEqual(
    claudeWindowsForFamily(windows, claudeModelFamily("claude-sonnet-4-5")).map((w) => w.label),
    ["5h session", "Weekly Sonnet"],
  );
  // No family meter in the response (Pro's single weekly_all, or the family's
  // window idle: no reset): every meter stays.
  assert.deepEqual(
    claudeWindowsForFamily(windows.filter((w) => w.label !== "Weekly Opus"), "opus").map((w) => w.label),
    ["5h session", "Weekly (all models)", "Weekly Sonnet"],
  );
  assert.deepEqual(claudeWindowsForFamily(windows, claudeModelFamily("claude-3-haiku")), windows);
  assert.deepEqual(claudeWindowsForFamily(windows, claudeModelFamily(undefined)), windows);
});

test("resolveUsageDriver accepts ids and the short names a model will pass", () => {
  assert.equal(resolveUsageDriver("openai")?.id, "codex-window");
  assert.equal(resolveUsageDriver("Codex")?.provider, "openai-codex");
  assert.equal(resolveUsageDriver("grok")?.id, "grok-window");
  assert.equal(resolveUsageDriver("xai")?.id, "grok-window");
  assert.equal(resolveUsageDriver("copilot")?.provider, "github-copilot");
  assert.equal(resolveUsageDriver("ollama-usage")?.provider, "ollama");
  assert.equal(resolveUsageDriver("claude")?.id, "claude-window");
  assert.equal(resolveUsageDriver("anthropic")?.id, "claude-window");
  // claude-bridge was retired: its chip is gone, not just unlisted.
  assert.equal(resolveUsageDriver("claude-bridge"), undefined);
  assert.equal(resolveUsageDriver(""), undefined);
  assert.equal(resolveUsageDriver("nope"), undefined);
});

test("formatUsageCacheReport is one block per driver and prefers commandText", () => {
  assert.equal(formatUsageCacheReport([
    { id: "grok-window", provider: "xai", status: "missing" },
    {
      id: "ollama-usage",
      provider: "ollama",
      status: "fresh",
      ageMs: 45_000,
      value: "$1 / $60 (2%)",
      commandText: "Included (pro): $1 of $60",
    },
  ]), "xai missing\nollama fresh 45s\nIncluded (pro): $1 of $60");
});

test("claudeBillingAlarm flags extra-usage billing and the HTTP 400 failure only", () => {
  const header = "anthropic-ratelimit-unified-overage-in-use";
  assert.equal(claudeBillingAlarm(200, { [header]: "false" }), undefined);
  assert.equal(claudeBillingAlarm(200, {}), undefined, "no header is plan billing");
  assert.equal(claudeBillingAlarm(200, { [header]: "true" }), "⚠ Claude extra usage");
  assert.equal(claudeBillingAlarm(400, {}), "⚠ Claude HTTP 400");
  assert.equal(claudeBillingAlarm(429, {}), undefined, "rate limits are not a billing failure");
});

test("pollFetches: poll ticks call provider APIs only mid-run or within 10 minutes of a turn", () => {
  assert.equal(IDLE_POLL_MS, 600_000);
  assert.equal(pollFetches(false, undefined, NOW), false, "no turn yet: cache only");
  assert.equal(pollFetches(true, undefined, NOW), true, "first run in progress");
  assert.equal(pollFetches(false, NOW - 599_000, NOW), true, "turn 9:59 ago");
  assert.equal(pollFetches(false, NOW - 600_000, NOW), false, "idle 10 minutes");
  assert.equal(pollFetches(true, NOW - 3_600_000, NOW), true, "a long run counts however old its start");
});

test("a settle adopts a newer shared-cache value even while the memory copy is fresh", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-adopt-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const write = (value, fetchedAt) =>
    writeFileSync(path.join(dir, "usage-cache.json"), JSON.stringify({ "claude-window:opus": { value, fetchedAt } }));
  const handlers = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    events: { on() {}, emit() {} },
    registerCommand() {},
    registerTool() {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
  };
  const statuses = new Map();
  const ctx = {
    hasUI: true,
    cwd: dir,
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    modelRegistry: { isUsingOAuth: () => true },
    ui: { setStatus: (key, value) => statuses.set(key, value), notify() {} },
  };
  const fire = async (name) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  try {
    const now = Date.now();
    write("2.5/5H: 50% 3.5/7D: 50%", now);
    providerUsage(pi);
    await fire("session_start");
    await settle();
    assert.equal(statuses.get("claude-window"), "2.5/5H: 50% 3.5/7D: 50%");

    // Another session fetched newer data seconds later, inside the 110s memory TTL.
    write("2.5/5H: 12% 3.5/7D: 18%", now + 5_000);
    await fire("agent_settled");
    await settle();
    assert.equal(statuses.get("claude-window"), "2.5/5H: 12% 3.5/7D: 18%", "adopted at the settle");

    write("2.5/5H: 99% 3.5/7D: 99%", now + 1_000); // older than what we have: ignored
    await fire("agent_settled");
    await settle();
    assert.equal(statuses.get("claude-window"), "2.5/5H: 12% 3.5/7D: 18%");

    // A different family's entry (another session on Sonnet) is never adopted,
    // even newer: sessions on Opus and Sonnet keep separate cache keys.
    writeFileSync(path.join(dir, "usage-cache.json"), JSON.stringify({
      "claude-window:opus": { value: "2.5/5H: 12% 3.5/7D: 18%", fetchedAt: now + 5_000 },
      "claude-window:sonnet": { value: "2.5/5H: 99% 3.5/7D: 99%", fetchedAt: now + 20_000 },
    }));
    await fire("agent_settled");
    await settle();
    assert.equal(statuses.get("claude-window"), "2.5/5H: 12% 3.5/7D: 18%", "another family's newer entry is not adopted");
  } finally {
    await fire("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
