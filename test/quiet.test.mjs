/**
 * quiet: run origin, notify_user, attention, the classifier safety net, the
 * digest, the prompt hint, and the quietMode setting.
 *
 * Each mount imports a fresh copy of the extension (cache-busting query) and
 * points PI_CODING_AGENT_DIR / XDG_STATE_HOME at a temp dir, so settings and
 * digest lines never touch the real ones.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

const RUN_EVENT = "quiet:run";
const ATTENTION_EVENT = "quiet:attention";
const MINE_EVENT = "quiet:mine";
const STATE_KEY = Symbol.for("pi-boehsline.quiet");
const KINDS = ["ready", "decision", "blocked", "failed", "deadline", "asked"];

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
  delete process.env.PI_QUIET_CLASSIFIER_TIMEOUT_MS;
  delete globalThis[STATE_KEY];
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 1_500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(5);
  }
  assert.fail("timed out waiting");
}

function stubPi() {
  const handlers = new Map();
  const listeners = new Map();
  const tools = new Map();
  const pi = {
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn));
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    events: {
      on(channel, fn) {
        const bucket = listeners.get(channel) ?? new Set();
        bucket.add(fn);
        listeners.set(channel, bucket);
        return () => bucket.delete(fn);
      },
      emit(channel, data) {
        for (const fn of [...(listeners.get(channel) ?? [])]) fn(data);
      },
    },
  };
  const fire = async (event, payload, ctx) => {
    const results = [];
    for (const fn of handlers.get(event) ?? []) results.push(await fn(payload, ctx));
    return results;
  };
  return { pi, handlers, tools, fire };
}

function branchWith(text) {
  return [
    { type: "message", message: { role: "user", content: "do the thing" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
}

async function mount({ settings = {}, branch = [], complete } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-quiet-"));
  roots.push(root);
  const agent = join(root, "agent");
  const state = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.XDG_STATE_HOME = state;
  writeFileSync(join(root, "placeholder"), "");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
  delete globalThis[STATE_KEY];

  const completeCalls = [];
  const model = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
  const registry = {
    find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
    hasConfiguredAuth: () => true,
    complete: async (m, request, options) => {
      completeCalls.push({ model: m, request, options });
      if (complete) return complete(m, request, options);
      return { stopReason: "stop", content: [{ type: "text", text: '{"notify": false}' }] };
    },
  };
  const notes = [];
  const ctx = {
    cwd: "/tmp/work/proj",
    hasUI: true,
    ui: { notify: (text, level) => notes.push([level, text]) },
    sessionManager: {
      getSessionId: () => "abcdef1234567890",
      getBranch: () => branch,
    },
    modelRegistry: registry,
  };

  const mod = await import(`../extensions/quiet/index.ts?t=${Math.random()}`);
  const s = stubPi();
  mod.default(s.pi);
  const runs = [];
  const attentions = [];
  s.pi.events.on(RUN_EVENT, (event) => runs.push(event));
  s.pi.events.on(ATTENTION_EVENT, (event) => attentions.push(event));
  await s.fire("session_start", { type: "session_start", reason: "startup" }, ctx);

  return {
    root,
    state,
    ctx,
    notes,
    runs,
    attentions,
    completeCalls,
    pi: s.pi,
    tools: s.tools,
    fire: s.fire,
    tool: () => s.tools.get("notify_user"),
    stateNow: () => globalThis[STATE_KEY],
    input: (source, extra = {}) => s.fire("input", { type: "input", text: "hi", source, ...extra }, ctx),
    mark: () => s.pi.events.emit(MINE_EVENT, {}),
    before: (messageType = "user") =>
      s.fire(
        "before_agent_start",
        messageType === "custom"
          ? { type: "before_agent_start", messageType: "custom", systemPrompt: "BASE", message: { customType: "x", content: "go" } }
          : { type: "before_agent_start", messageType: "user", systemPrompt: "BASE", prompt: "hi" },
        ctx,
      ),
    start: () => s.fire("agent_start", { type: "agent_start" }, ctx),
    settle: () => s.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx),
    async run(source, extra) {
      if (source) await this.input(source, extra);
      const before = await this.before(source === "custom" ? "custom" : "user");
      await this.start();
      return before[0];
    },
    digest() {
      try {
        const dir = join(state, "pi-quiet");
        const files = readdirSync(dir);
        return files.length ? readFileSync(join(dir, files[0]), "utf8") : "";
      } catch {
        return "";
      }
    },
    digestPath() {
      const dir = join(state, "pi-quiet");
      const files = readdirSync(dir);
      return join(dir, files[0]);
    },
  };
}

test("origin: interactive and rpc are Eric's; unmarked extension input is quiet", async () => {
  const h = await mount();
  assert.equal(h.stateNow().quiet, false, "the shared state starts known");

  await h.run("interactive");
  assert.equal(h.stateNow().quiet, false);
  assert.deepEqual(h.runs.at(-1), { quiet: false });
  await h.settle();

  await h.run("rpc");
  assert.equal(h.stateNow().quiet, false);
  assert.deepEqual(h.runs.at(-1), { quiet: false });
  await h.settle();

  await h.run("extension");
  assert.equal(h.stateNow().quiet, true);
  assert.deepEqual(h.runs.at(-1), { quiet: true });
});

test("origin: a quiet:mine mark makes the next extension input Eric's, once", async () => {
  const h = await mount();
  h.mark();
  await h.run("extension");
  assert.equal(h.stateNow().quiet, false, "the marked extension input is his");
  await h.settle();

  await h.run("extension");
  assert.equal(h.stateNow().quiet, true, "the mark is consumed once");
});

test("origin: a quiet:mine mark expires after 2 seconds", async () => {
  const h = await mount();
  h.mark();
  const realNow = Date.now;
  Date.now = () => realNow() + 2_001;
  try {
    await h.run("extension");
  } finally {
    Date.now = realNow;
  }
  assert.equal(h.stateNow().quiet, true);
});

test("origin: a sendMessage-triggered run (no input) is quiet", async () => {
  const h = await mount();
  const before = await h.run("custom");
  assert.equal(h.stateNow().quiet, true);
  assert.deepEqual(h.runs.at(-1), { quiet: true });
  assert.match(before?.systemPrompt ?? "", /background event/);
});

test("origin: a steer from Eric mid-run flips the run and announces it", async () => {
  const h = await mount();
  await h.run("extension");
  assert.equal(h.runs.at(-1).quiet, true);
  await h.input("interactive", { streamingBehavior: "steer" });
  assert.equal(h.stateNow().quiet, false);
  assert.deepEqual(h.runs.at(-1), { quiet: false });
  await h.settle();
  assert.equal(h.stateNow().quiet, false, "the settled state still describes the last run");
});

test("origin: his prompt that never started a run doesn't make the next background run his", async () => {
  const h = await mount();
  await h.input("interactive"); // no model: pi emitted input, then threw; no run, no settle
  await h.before("custom"); // sendMessage triggerTurn: no input event at all
  await h.start();
  assert.equal(h.stateNow().quiet, true, "a sendMessage-triggered run");
  await h.settle();

  await h.input("interactive");
  await h.run("extension");
  assert.equal(h.stateNow().quiet, true, "a background input while idle");
});

test("classifier: an answer that lands after he typed raises nothing", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = await mount({
    branch: branchWith("Ready."),
    complete: async () => {
      await gate;
      return { stopReason: "stop", content: [{ type: "text", text: '{"notify":true,"kind":"ready","one_line":"Ready"}' }] };
    },
  });
  await h.run("extension");
  await h.settle();
  await sleep(5);
  await h.input("interactive");
  release();
  await until(() => h.digest().length > 0);
  assert.equal(h.attentions.filter((a) => a?.source === "classifier").length, 0);
});

test("notify_user sets attention, shows a warning line, and validates its arguments", async () => {
  const h = await mount();
  const tool = h.tool();
  assert.ok(tool, "notify_user is registered");
  assert.deepEqual([...KINDS].sort(), [...tool.parameters.properties.kind.enum].sort());

  const bad = [
    [{ kind: "progress", text: "working" }, /kind/],
    [{ kind: "ready", text: "" }, /1-140/],
    [{ kind: "ready", text: "x".repeat(141) }, /1-140/],
    [{ kind: "ready", text: "two\nlines" }, /one line/],
  ];
  for (const [params, why] of bad) {
    const result = await tool.execute("id", params, undefined, undefined, h.ctx);
    assert.match(result.content[0].text, why, JSON.stringify(params));
    assert.equal(h.attentions.length, 0, "nothing raised");
  }

  const result = await tool.execute("id", { kind: "decision", text: "Pick the staging key" }, undefined, undefined, h.ctx);
  assert.match(result.content[0].text, /Notified Eric/);
  assert.deepEqual(h.notes.at(-1), ["warning", "Needs you (decision): Pick the staging key"]);
  const attention = h.stateNow().attention;
  assert.equal(attention.kind, "decision");
  assert.equal(attention.text, "Pick the staging key");
  assert.equal("source" in attention, false, "notify_user payload is {kind, text, at}");
  assert.equal(typeof attention.at, "number");
  assert.deepEqual(h.attentions.at(-1), attention);
});

test("attention clears on Eric's next input and emits null", async () => {
  const h = await mount();
  await h.tool().execute("id", { kind: "ready", text: "Try the new build" }, undefined, undefined, h.ctx);
  assert.ok(h.stateNow().attention);
  await h.input("interactive");
  assert.equal(h.stateNow().attention, null);
  assert.equal(h.attentions.at(-1), null);
  assert.equal(h.attentions.filter((a) => a === null).length, 1, "null once, not on every input");
});

test("classifier: one side call for a quiet settle, its JSON raises attention", async () => {
  const h = await mount({
    branch: branchWith("The migration is ready for you to try on staging."),
    complete: () => ({
      stopReason: "stop",
      content: [{ type: "text", text: '```json\n{"notify":true,"kind":"ready","one_line":"Migration is ready to test"}\n```' }],
    }),
  });
  await h.run("extension");
  await h.settle();
  await until(() => h.attentions.some((a) => a?.source === "classifier"));
  assert.equal(h.completeCalls.length, 1);
  assert.match(h.completeCalls[0].request.messages[0].content, /ready for you to try/);
  assert.equal(h.completeCalls[0].options.maxTokens, 200);
  const attention = h.attentions.at(-1);
  assert.equal(attention.kind, "ready");
  assert.equal(attention.text, "Migration is ready to test");
  assert.equal(attention.source, "classifier");
  await until(() => h.digest().includes("classifier ready: Migration is ready to test"));
});

test("classifier: not called for Eric's runs or after notify_user", async () => {
  const h = await mount({ branch: branchWith("Done.") });
  await h.run("interactive");
  await h.settle();
  assert.equal(h.completeCalls.length, 0, "Eric's run needs no safety net");

  await h.run("extension");
  await h.tool().execute("id", { kind: "failed", text: "Build failed" }, undefined, undefined, h.ctx);
  await h.settle();
  await sleep(20);
  assert.equal(h.completeCalls.length, 0, "notify_user already said it");
  await until(() => h.digest().includes("notified failed: Build failed"));
});

test("classifier: garbage, a provider error and a timeout all stay silent", async () => {
  const garbage = await mount({
    branch: branchWith("Everything passed."),
    complete: () => ({ stopReason: "stop", content: [{ type: "text", text: "no json here" }] }),
  });
  await garbage.run("extension");
  await garbage.settle();
  await until(() => garbage.digest().includes("quiet: Everything passed."));
  assert.equal(garbage.attentions.length, 0);

  const failed = await mount({
    branch: branchWith("Everything passed."),
    complete: () => {
      throw new Error("provider down");
    },
  });
  await failed.run("extension");
  await failed.settle();
  await until(() => failed.digest().includes("quiet: Everything passed."));
  assert.equal(failed.attentions.length, 0);

  process.env.PI_QUIET_CLASSIFIER_TIMEOUT_MS = "30";
  const timedOut = await mount({
    branch: branchWith("Everything passed."),
    complete: (_model, _request, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      }),
  });
  await timedOut.run("extension");
  await timedOut.settle();
  await until(() => timedOut.digest().includes("quiet: Everything passed."));
  assert.equal(timedOut.attentions.length, 0);
});

test("classifier: the setting off makes no side call", async () => {
  const h = await mount({ settings: { quietClassifier: false }, branch: branchWith("All green.") });
  await h.run("extension");
  await h.settle();
  await until(() => h.digest().includes("quiet: All green."));
  assert.equal(h.completeCalls.length, 0);
});

test("digest: local time, short session, cwd basename, and the outcome", async () => {
  const h = await mount();
  await h.run("extension");
  await h.tool().execute("id", { kind: "ready", text: "Tests are green" }, undefined, undefined, h.ctx);
  await h.settle();
  await until(() => h.digest().length > 0);
  assert.match(
    h.digest(),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\tabcdef12\tproj\tnotified ready: Tests are green\n$/,
  );
  const { statSync } = await import("node:fs");
  assert.equal(statSync(join(h.state, "pi-quiet")).mode & 0o777, 0o700);
  assert.equal(statSync(h.digestPath()).mode & 0o777, 0o600);
  const { chmodSync } = await import("node:fs");
  chmodSync(h.digestPath(), 0o644);
  await h.run("extension");
  await h.tool().execute("id", { kind: "ready", text: "Again" }, undefined, undefined, h.ctx);
  await h.settle();
  await until(() => h.digest().includes("Again"));
  assert.equal(statSync(h.digestPath()).mode & 0o777, 0o600, "a looser file is tightened");

  const quiet = await mount({ settings: { quietClassifier: false }, branch: branchWith("x".repeat(150)) });
  await quiet.run("extension");
  await quiet.settle();
  await until(() => quiet.digest().length > 0);
  assert.match(quiet.digest(), /\tquiet: x{100}\n$/, "the last text is one line, first 100 chars");
});

test("the hint is appended only for a quiet run", async () => {
  const h = await mount();
  const quiet = await h.run("extension");
  assert.match(quiet.systemPrompt, /^BASE\n\nThis turn was started by a background event/);
  assert.match(quiet.systemPrompt, /call notify_user/);
  await h.settle();

  const mine = await h.run("interactive");
  assert.equal(mine, undefined, "Eric's run gets no system prompt change");
});

test('quietMode "off": every run is Eric\'s, with no hint, classifier or digest', async () => {
  const h = await mount({ settings: { quietMode: "off" }, branch: branchWith("All green.") });
  const before = await h.run("extension");
  assert.equal(before, undefined);
  assert.equal(h.stateNow().quiet, false);
  assert.deepEqual(h.runs.at(-1), { quiet: false });
  await h.settle();
  await sleep(20);
  assert.equal(h.completeCalls.length, 0);
  assert.equal(existsSync(join(h.state, "pi-quiet")), false);

  await h.tool().execute("id", { kind: "asked", text: "You asked me to report this" }, undefined, undefined, h.ctx);
  assert.equal(h.stateNow().attention.kind, "asked", "notify_user still works");
});
