// web.json: a file that doesn't parse is never overwritten, and markSkip (fired
// unawaited from fetch tiers, awaited inside the search chain's catch) never
// rejects, even when the config can't be written.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "web-config-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const broken = '{ "search": { "order": ["exa", "brave"], }, "fetch": { "off": ["safari"] } ';
writeFileSync(join(agentDir, "web.json"), broken);

const { activeChain, configProblem, loadConfig, markSkip, mutateConfig } = await import("../extensions/web/providers/config.ts");

test("a web.json that doesn't parse stays as it is: defaults in memory, saves refused, cool-offs still held", async () => {
  const cfg = await loadConfig();
  assert.match(configProblem() ?? "", /web\.json doesn't parse/);
  assert.ok(cfg.search.order.length > 0, "defaults stand in");
  await assert.rejects(mutateConfig((c) => (c.format = "serp")), /not overwritten/);
  // markSkip doesn't reject, and the cool-off holds for this process.
  await markSkip("exa", 60_000);
  assert.equal(activeChain(["exa", "brave"], [], (await loadConfig()).skipUntil).includes("exa"), false);
  assert.equal(readFileSync(join(agentDir, "web.json"), "utf8"), broken, "the user's file is untouched");
});

test("markSkip never rejects when web.json can't be written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-config-ro-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const fresh = await import(`../extensions/web/providers/config.ts?ro=${Date.now()}`);
  await fresh.loadConfig();
  chmodSync(dir, 0o500);
  try {
    await assert.doesNotReject(fresh.markSkip("brave", 60_000));
    assert.ok((await fresh.loadConfig()).skipUntil.brave > Date.now(), "held in memory");
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("a web.json that exists but can't be read is never overwritten", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-config-eisdir-"));
	mkdirSync(join(dir, "web.json")); // EISDIR on read; EACCES takes the same path
	process.env.PI_CODING_AGENT_DIR = dir;
	const fresh = await import(`../extensions/web/providers/config.ts?eisdir=${Date.now()}`);
	await fresh.loadConfig();
	assert.match(fresh.configProblem() ?? "", /web\.json can't be read/);
	await assert.rejects(fresh.mutateConfig((c) => (c.format = "serp")), /not overwritten/);
	await assert.doesNotReject(fresh.markSkip("exa", 60_000));
});

test("a skip reason is stored with its skip, kept by a longer window, and dropped with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-config-reason-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const fresh = await import(`../extensions/web/providers/config.ts?reason=${Date.now()}`);
  await fresh.markSkip("tavily", 24 * 60 * 60 * 1000, "blocked");
  // A shorter transient skip doesn't overwrite the longer blocked one or its reason.
  await fresh.markSkip("tavily", 60_000);
  let cfg = await fresh.loadConfig();
  assert.equal(cfg.skipReason.tavily, "blocked");
  const onDisk = JSON.parse(readFileSync(join(dir, "web.json"), "utf8"));
  assert.equal(onDisk.skipReason.tavily, "blocked");

  // A reason whose skip has expired (or never existed) is dropped on read.
  writeFileSync(
    join(dir, "web.json"),
    JSON.stringify({ skipUntil: { tavily: Date.now() - 1 }, skipReason: { tavily: "blocked", exa: "blocked", brave: "bogus" } }),
  );
  const reread = await import(`../extensions/web/providers/config.ts?reread=${Date.now()}`);
  cfg = await reread.loadConfig();
  assert.deepEqual(cfg.skipReason, {});

  await reread.markSkip("exa", 60_000, "blocked");
  await reread.clearSkips();
  assert.deepEqual((await reread.loadConfig()).skipReason, {});
});
