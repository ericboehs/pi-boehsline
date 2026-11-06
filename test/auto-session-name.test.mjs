/**
 * Unit tests for auto-session-name helpers.
 *
 *   node --test .pi-agent/test/auto-session-name.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateModels,
  DEFAULT_NAME_MODELS,
  NAMING_PROMPT,
  NO_NAMING_MODEL,
  generateTitle,
  hasHistory,
  isUserGivenName,
  parseModelList,
  recentContext,
  sanitizeName,
  summarizeError,
  titleFromContent,
} from "../extensions/auto-session-name/index.ts";

test("empty and derived peer ids are not user-given", () => {
  assert.equal(isUserGivenName(undefined), false);
  assert.equal(isUserGivenName(""), false);
  assert.equal(isUserGivenName("   "), false);
  assert.equal(isUserGivenName("pi-dotfiles"), false);
  assert.equal(isUserGivenName("pi-dotfiles-2"), false);
  assert.equal(isUserGivenName("pi-customer-identity-card-lookup-code"), false);
});

test("real titles count as user-given", () => {
  assert.equal(isUserGivenName("daily-nvim"), true);
  assert.equal(isUserGivenName("tmux-session-statusline"), true);
  assert.equal(isUserGivenName("psst"), true);
});

test("sanitizeName makes Title Case with spaces", () => {
  assert.equal(sanitizeName('  "Fix the footer."  '), "Fix the Footer");
  assert.equal(sanitizeName("chicken door alert tamer"), "Chicken Door Alert Tamer");
  assert.equal(sanitizeName("**Canvas Leak Plumber**"), "Canvas Leak Plumber");
  assert.equal(sanitizeName("\u201cTokyo Time Teller\u201d"), "Tokyo Time Teller");
});

test("sanitizeName keeps acronyms, brand casing, and version numbers", () => {
  assert.equal(sanitizeName("Flaky CI Wrangler"), "Flaky CI Wrangler");
  assert.equal(sanitizeName("github token swapper"), "Github Token Swapper");
  assert.equal(sanitizeName("GitHub Token Swapper"), "GitHub Token Swapper");
  assert.equal(sanitizeName("rails 8 upgrade sherpa"), "Rails 8 Upgrade Sherpa");
  assert.equal(sanitizeName("deepseek v4.1 tester"), "Deepseek v4.1 Tester");
});

test("sanitizeName splits a kebab reply but keeps hyphens inside spaced words", () => {
  assert.equal(sanitizeName("fix-tmux-status"), "Fix Tmux Status");
  assert.equal(sanitizeName("agent-link mention butler"), "Agent-Link Mention Butler");
});

test("sanitizeName lowercases small words unless first, and calms shouting", () => {
  assert.equal(sanitizeName("Keeper Of The Coop"), "Keeper of the Coop");
  assert.equal(sanitizeName("the coop keeper"), "The Coop Keeper");
  assert.equal(sanitizeName("FLAKY TEST WRANGLER"), "Flaky Test Wrangler");
});

test("sanitizeName caps at 30 characters on whole words", () => {
  const name = sanitizeName("Extremely Verbose Session Naming Specialist");
  assert.ok(name.length <= 30, name);
  assert.equal(name, "Extremely Verbose Session");
  assert.equal(sanitizeName("a".repeat(40)), "A" + "a".repeat(29));
});

test("titleFromContent drops thinking and instruction echo", () => {
  assert.equal(
    titleFromContent([
      { type: "thinking", thinking: "The user wants a short title" },
      { type: "text", text: "Tmux Status Color Fixer" },
    ]),
    "Tmux Status Color Fixer",
  );
  assert.equal(
    titleFromContent([{ type: "text", text: "The user wants a short title (at most 6 words) for a coding-" }]),
    "",
  );
  assert.equal(titleFromContent([{ type: "text", text: "Title Case with spaces" }]), "");
  assert.equal(
    titleFromContent([{ type: "text", text: "one two three four five six seven eight" }]),
    "One Two Three Four Five Six",
  );
});

test("the naming prompt asks for Title Case nouns, with examples", () => {
  assert.match(NAMING_PROMPT, /Title Case with spaces/);
  assert.match(NAMING_PROMPT, /-> Flaky CI Wrangler/);
  assert.doesNotMatch(NAMING_PROMPT, /kebab/);
  for (const line of NAMING_PROMPT.split("\n").filter((l) => l.includes(" -> "))) {
    const name = line.split(" -> ")[1];
    assert.equal(sanitizeName(name), name, "examples survive sanitizing unchanged");
    assert.ok(name.length <= 30);
  }
});

test("recentContext prefers later turns", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "message", message: { role: "assistant", content: "hello" } },
    { type: "message", message: { role: "user", content: "price of glm 5.3" } },
  ];
  const ctx = recentContext(branch);
  assert.match(ctx, /price of glm 5.3/);
  assert.match(ctx, /hi/);
});

test("hasHistory only counts a real assistant reply", () => {
  assert.equal(hasHistory([]), false);
  assert.equal(
    hasHistory([{ type: "message", message: { role: "user", content: "hi" } }]),
    false,
  );
  assert.equal(
    hasHistory([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", content: "hello" } },
    ]),
    true,
  );
});

test("parseModelList splits env lists and falls back to defaults", () => {
  assert.deepEqual(parseModelList(undefined), DEFAULT_NAME_MODELS);
  assert.deepEqual(parseModelList("  "), DEFAULT_NAME_MODELS);
  assert.deepEqual(parseModelList("a/b"), ["a/b"]);
  assert.deepEqual(parseModelList("a/b, baseten/zai-org/GLM-5.3-Flash  c/d"), [
    "a/b",
    "baseten/zai-org/GLM-5.3-Flash",
    "c/d",
  ]);
  // Subscription-covered only: no Ollama (402s) or pay-per-token providers.
  assert.ok(DEFAULT_NAME_MODELS.every((m) => m.startsWith("opencode-go/")));
});

test("summarizeError pulls the message out of a provider JSON body", () => {
  assert.equal(
    summarizeError(
      '402: {"message":"this model is not included in your free usage (ref: abc-123)","type":"api_error"}',
    ),
    "402 this model is not included in your free usage",
  );
  assert.equal(summarizeError("socket hang up"), "socket hang up");
  assert.equal(summarizeError(undefined), "unknown error");
  assert.ok(summarizeError("x".repeat(200)).length <= 90);
});

function fakeRegistry(models, replies, calls = []) {
  return {
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => models.filter((m) => !m.noAuth),
    hasConfiguredAuth: (m) => !m.noAuth,
    complete: async (model, _req, _opts) => {
      calls.push(model);
      const reply = replies[`${model.provider}/${model.id}`];
      if (reply instanceof Error) throw reply;
      return reply ?? { stopReason: "stop", content: [] };
    },
  };
}

test("candidateModels skips unauthed models and puts the preferred one first", () => {
  const models = [
    { provider: "a", id: "one" },
    { provider: "b", id: "two", noAuth: true },
    { provider: "c", id: "three" },
  ];
  const ctx = { modelRegistry: fakeRegistry(models, {}) };
  assert.deepEqual(
    candidateModels(ctx, ["a/one", "b/two", "c/three"]).map((m) => `${m.provider}/${m.id}`),
    ["a/one", "c/three"],
  );
  assert.deepEqual(
    candidateModels(ctx, ["a/one", "c/three"], { preferred: "c/three" }).map((m) => `${m.provider}/${m.id}`),
    ["c/three", "a/one"],
  );
});

test("with the default list and no OpenCode Go, the session's own model names it", () => {
  const session = { provider: "anthropic", id: "claude-sonnet" };
  const ctx = { modelRegistry: fakeRegistry([session], {}), model: session };
  assert.deepEqual(
    candidateModels(ctx, DEFAULT_NAME_MODELS).map((m) => `${m.provider}/${m.id}`),
    ["anthropic/claude-sonnet"],
  );
  assert.equal(parseModelList(""), DEFAULT_NAME_MODELS, "unset env means the default list itself");
  const nothing = { modelRegistry: fakeRegistry([{ provider: "x", id: "y", noAuth: true }], {}), model: { provider: "x", id: "y", noAuth: true } };
  assert.deepEqual(candidateModels(nothing, DEFAULT_NAME_MODELS), [], "a session model without credentials isn't used");
});

test("generateTitle with no usable model throws NO_NAMING_MODEL, which the auto path keeps quiet", async () => {
  await assert.rejects(generateTitle({ modelRegistry: fakeRegistry([], {}) }, "user: hi", {}, ["a/missing"]), new RegExp(NO_NAMING_MODEL));
});

test("the session-model fallback gets more tokens, and its failure is quiet", async () => {
  const session = { provider: "anthropic", id: "adaptive-only" };
  const calls = [];
  const reg = {
    ...fakeRegistry([session], {}),
    complete: async (_model, _req, opts) => {
      calls.push(opts.maxTokens);
      return { stopReason: "length", content: [] };
    },
  };
  const error = await generateTitle({ modelRegistry: reg, model: session }, "user: hi", {}, DEFAULT_NAME_MODELS).catch((e) => e);
  assert.ok(error instanceof Error);
  assert.equal(error.quiet, true);
  assert.deepEqual(calls, [1024]);
  // A listed model's failure still counts.
  const listed = await generateTitle({ modelRegistry: reg }, "user: hi", {}, ["anthropic/adaptive-only"]).catch((e) => e);
  assert.equal(listed.quiet, false);
});

test("an explicit model list never falls back to unlisted models", () => {
  const models = [
    { provider: "inco", id: "deepseek-v4.1-flash:fast" },
    { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  ];
  const ctx = { modelRegistry: fakeRegistry(models, {}), model: models[0] };
  assert.deepEqual(
    candidateModels(ctx, ["opencode-go/deepseek-v4.1-flash"]).map((m) => `${m.provider}/${m.id}`),
    ["opencode-go/deepseek-v4.1-flash"],
  );
  assert.deepEqual(candidateModels(ctx, ["opencode-go/missing"]), []);
});

test("generateTitle falls through a 402 error to the next model", async () => {
  const models = [
    { provider: "ollama", id: "glm-5.3-flash", reasoning: true },
    { provider: "inco", id: "deepseek-v4.1-flash:fast", reasoning: true },
  ];
  const calls = [];
  const reg = fakeRegistry(
    models,
    {
      "ollama/glm-5.3-flash": { stopReason: "error", errorMessage: '402: {"message":"not included"}', content: [] },
      "inco/deepseek-v4.1-flash:fast": { stopReason: "stop", content: [{ type: "text", text: "Tmux Status Fixer" }] },
    },
    calls,
  );
  const state = {};
  const title = await generateTitle({ modelRegistry: reg }, "user: fix tmux", state, [
    "ollama/glm-5.3-flash",
    "inco/deepseek-v4.1-flash:fast",
  ]);
  assert.equal(title, "Tmux Status Fixer");
  assert.equal(state.preferred, "inco/deepseek-v4.1-flash:fast");
  // Models go out unchanged so pi can send their thinking-off value.
  assert.equal(calls[0].reasoning, true);
  assert.equal(calls.length, 2);
});

test("generateTitle reports every model's failure when none work", async () => {
  const models = [
    { provider: "a", id: "one" },
    { provider: "b", id: "two" },
  ];
  const reg = fakeRegistry(models, {
    "a/one": { stopReason: "error", errorMessage: '402: {"message":"pay up"}' },
    "b/two": new Error("socket hang up"),
  });
  await assert.rejects(
    generateTitle({ modelRegistry: reg }, "user: hi", {}, ["a/one", "b/two"]),
    /a\/one: 402 pay up; b\/two: socket hang up/,
  );
});
