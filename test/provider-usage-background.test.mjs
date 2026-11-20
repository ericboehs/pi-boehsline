/**
 * Background polls (backgroundPollMinutes): a provider no session is using
 * still refreshes its shared-cache entry, once per interval machine-wide, and
 * only through pi's OAuth sign-in. fetch is stubbed; nothing leaves the box.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import providerUsage, {
  PROVIDER_USAGE_DEFAULTS,
  backgroundPollOnce,
  backgroundPollPlan,
  resolveUsageDriver,
} from "../extensions/provider-usage/index.ts";

const MINUTE = 60_000;
const INTERVAL = 30 * MINUTE;
const grok = resolveUsageDriver("xai");

/** A SuperGrok weekly-credits body: 47% of a week that started two days ago. */
function creditsBody() {
  const start = Date.now() - 2 * 86_400_000;
  return {
    config: {
      currentPeriod: { type: "WEEKLY", start: new Date(start).toISOString(), end: new Date(start + 7 * 86_400_000).toISOString() },
      creditUsagePercent: 47,
    },
  };
}

/** A fresh agent dir and a counting fetch stub, restored after the test. */
function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-bg-"));
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, config: process.env.BOEHSLINE_CONFIG, fetch: globalThis.fetch };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.BOEHSLINE_CONFIG = path.join(dir, "boehsline.json");
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    // A beat of latency so concurrent pollers overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify(creditsBody()), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = saved.fetch;
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agentDir], ["BOEHSLINE_CONFIG", saved.config]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const cacheFile = path.join(dir, "usage-cache.json");
  return {
    dir,
    calls,
    writeCache: (fetchedAt) => writeFileSync(cacheFile, JSON.stringify({ "grok-window": { value: "1.0/7D: 10%", fetchedAt } })),
    readCache: () => JSON.parse(readFileSync(cacheFile, "utf8")),
  };
}

/** ctx with an xAI credential: "oauth" (a SuperGrok sign-in), "key" (an xai- API key), or none. */
function ctxWith(auth, extra = {}) {
  const authCalls = [];
  return {
    authCalls,
    mode: "tui",
    hasUI: true,
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    modelRegistry: {
      isUsingOAuth: (model) => auth === "oauth" && model.provider === "xai",
      getProviderAuth: async (provider) => {
        authCalls.push(provider);
        if (auth === "oauth") return { auth: { apiKey: "oauth-access-token" } };
        if (auth === "key") return { auth: { apiKey: "xai-paid-api-key" } };
        return undefined;
      },
    },
    ui: { setStatus() {}, notify() {} },
    ...extra,
  };
}

test("backgroundPollPlan: xai every 30 minutes by default; others only when asked, never faster than 5", () => {
  const plan = backgroundPollPlan(PROVIDER_USAGE_DEFAULTS);
  assert.deepEqual(plan.map((p) => [p.driver.id, p.intervalMs]), [["grok-window", INTERVAL]]);
  assert.deepEqual(backgroundPollPlan({ backgroundPollMinutes: { xai: 0 } }), [], "0 turns it off");
  assert.deepEqual(backgroundPollPlan({}), []);
  const custom = backgroundPollPlan({ backgroundPollMinutes: { grok: 60, codex: 1, anthropic: 30, cerebras: 10, openrouter: 10 } });
  assert.deepEqual(
    custom.map((p) => [p.driver.id, p.intervalMs]),
    [["grok-window", 60 * MINUTE], ["codex-window", 5 * MINUTE]],
    "aliases resolve, the floor holds, and key/cookie providers and Claude never poll in the background",
  );
});

test("no sign-in: no auth lookup and no fetch", async (t) => {
  const env = setup(t);
  const ctx = ctxWith(undefined);
  assert.equal(await backgroundPollOnce(ctx, grok, INTERVAL), "signed-out");
  assert.deepEqual(ctx.authCalls, []);
  assert.equal(env.calls.length, 0);
});

test("an xai- API key: no fetch, whether or not pi reports it as OAuth", async (t) => {
  const env = setup(t);
  assert.equal(await backgroundPollOnce(ctxWith("key"), grok, INTERVAL), "signed-out");
  // Belt and braces: even if the sign-in check let a key through, fetchGrok refuses it.
  const leaky = ctxWith("key");
  leaky.modelRegistry.isUsingOAuth = () => true;
  assert.equal(await backgroundPollOnce(leaky, grok, INTERVAL), "failed");
  assert.equal(env.calls.length, 0);
  const log = readFileSync(path.join(env.dir, "provider-usage.log"), "utf8");
  assert.match(log, /background poll failed: xAI API keys are not SuperGrok/);
});

test("a fresh cache entry: no fetch", async (t) => {
  const env = setup(t);
  env.writeCache(Date.now() - 10 * MINUTE);
  const ctx = ctxWith("oauth");
  assert.equal(await backgroundPollOnce(ctx, grok, INTERVAL), "fresh");
  assert.equal(env.calls.length, 0);
  assert.deepEqual(ctx.authCalls, [], "no token refresh either");
});

test("a stale cache entry: one fetch through pi's auth, then quiet for the interval", async (t) => {
  const env = setup(t);
  const old = Date.now() - 12 * 86_400_000;
  env.writeCache(old);
  const ctx = ctxWith("oauth");
  assert.equal(await backgroundPollOnce(ctx, grok, INTERVAL), "fetched");
  assert.equal(env.calls.length, 1);
  assert.deepEqual(ctx.authCalls, ["xai"], "getProviderAuth: pi refreshes the token itself");
  const entry = env.readCache()["grok-window"];
  assert.ok(entry.fetchedAt > old);
  assert.match(entry.value, /D: 47%$/);
  assert.equal(await backgroundPollOnce(ctx, grok, INTERVAL), "fresh");
  assert.equal(env.calls.length, 1);
});

test("a failed poll keeps the last value and is not retried within the interval", async (t) => {
  const env = setup(t);
  const old = Date.now() - 12 * 86_400_000;
  env.writeCache(old);
  const ctx = ctxWith("oauth");
  ctx.modelRegistry.getProviderAuth = async (provider) => {
    ctx.authCalls.push(provider);
    throw new Error("token refresh failed");
  };
  assert.equal(await backgroundPollOnce(ctx, grok, INTERVAL), "failed");
  assert.equal(await backgroundPollOnce(ctxWith("oauth"), grok, INTERVAL), "fresh", "another pi waits out the interval too");
  assert.deepEqual(ctx.authCalls, ["xai"]);
  assert.equal(env.calls.length, 0);
  assert.equal(env.readCache()["grok-window"].fetchedAt, old, "the last value and its age stay");
});

test("two pi instances polling at once: one fetch", async (t) => {
  const env = setup(t);
  env.writeCache(Date.now() - 2 * INTERVAL);
  const results = await Promise.all([
    backgroundPollOnce(ctxWith("oauth"), grok, INTERVAL),
    backgroundPollOnce(ctxWith("oauth"), grok, INTERVAL),
  ]);
  assert.equal(env.calls.length, 1);
  assert.deepEqual(results.toSorted(), ["fetched", "locked"]);
  // The loser's next tick sees the winner's fresh entry.
  assert.equal(await backgroundPollOnce(ctxWith("oauth"), grok, INTERVAL), "fresh");
  assert.equal(env.calls.length, 1);
});

/** Run session_start under fake timers, jump past the first background tick, and count fetches. */
async function fetchesAfterStart(t, ctx) {
  const env = setup(t);
  env.writeCache(Date.now() - 2 * INTERVAL);
  const handlers = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    events: { on() {}, emit() {} },
    registerCommand() {},
    registerTool() {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
  };
  const fire = async (name) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  providerUsage(pi);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    await fire("session_start");
    mock.timers.tick(20_000);
  } finally {
    mock.timers.reset();
  }
  const deadline = Date.now() + 2_000;
  while (env.calls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await fire("session_shutdown");
  return env.calls.length;
}

test("the extension polls xai in the background shortly after session start", async (t) => {
  assert.equal(await fetchesAfterStart(t, ctxWith("oauth")), 1);
});

test("print mode never starts the background poll", async (t) => {
  assert.equal(await fetchesAfterStart(t, ctxWith("oauth", { mode: "print", hasUI: false })), 0);
});
