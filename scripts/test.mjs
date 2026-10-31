#!/usr/bin/env node
// npm test: run node --test and keep a copy of the whole run.
//
// Every run's output goes to the terminal and to a log in /tmp/test-runs/
// (TEST_RUNS_DIR overrides), headed with the commit, the dirty files and the
// load average, so an intermittent failure can be read afterwards instead of
// lost with the scrollback. The newest 50 logs are kept.
//
//   npm test                          the whole suite
//   npm test -- test/footer.test.mjs  just these files (any node --test args)

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { testEnv } from "./test-env.mjs";

// Globs, not shell-expanded paths: node --test expands them itself (>= 21).
const SUITE = [
  "test/*.test.mjs",
  "packages/goal/test/*.test.mjs",
  "packages/scheduler/test/*.test.mjs",
  // The security gate: its own tests, not just the opt-in wrapper's.
  "packages/approval-guardian/tests/*.test.ts",
  // agent-link's tests that need no pi (reg-test and roundtrip launch one).
  "packages/agent-link/test/mentions.mjs",
  "packages/agent-link/test/naming.mjs",
  "packages/agent-link/test/relay.mjs",
  "packages/agent-link/test/send-close.mjs",
];
const KEEP = 50;


const args = process.argv.slice(2);
const dir = process.env.TEST_RUNS_DIR || "/tmp/test-runs";
mkdirSync(dir, { recursive: true });
// Local time, so the name matches the clock you noticed the failure by.
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const logPath = join(dir, `${stamp}-${process.pid}.log`);
const log = createWriteStream(logPath);

// trimEnd: status lines start with a meaningful space (" M" is unstaged).
const git = (...gitArgs) => spawnSync("git", gitArgs, { encoding: "utf8" }).stdout?.trimEnd() ?? "";
const dirty = git("status", "--short");
log.write(
  [
    `# ${new Date().toISOString()}  node ${process.version}  load ${loadavg().map((n) => n.toFixed(2)).join(" ")}`,
    `# commit ${git("rev-parse", "--short", "HEAD") || "?"}${dirty ? `, ${dirty.split("\n").length} dirty:` : ", clean"}`,
    ...(dirty ? dirty.split("\n").map((line) => `#   ${line}`) : []),
    `# node --test ${(args.length ? args : SUITE).join(" ")}`,
    "",
    "",
  ].join("\n"),
);

// Without pi's PI_* variables, and with a canvas root and port of the run's own.
const { env, madeRoot } = await testEnv(process.env);
const child = spawn(process.execPath, ["--test", ...(args.length ? args : SUITE)], {
  stdio: ["inherit", "pipe", "pipe"],
  env,
});
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

child.on("close", (code, signal) => {
  const status = signal ? `killed by ${signal}` : `exit ${code}`;
  log.end(`\n# ${status}\n`, () => {
    // Oldest first by name (the stamp sorts); keep the newest KEEP.
    const logs = readdirSync(dir).filter((name) => name.endsWith(".log")).sort();
    for (const name of logs.slice(0, Math.max(0, logs.length - KEEP))) rmSync(join(dir, name), { force: true });
    if (madeRoot) rmSync(madeRoot, { recursive: true, force: true });
    process.stderr.write(`\ntest log (${status}): ${logPath}\n`);
    process.exit(code ?? 1);
  });
});
