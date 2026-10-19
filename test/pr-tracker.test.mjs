import assert from "node:assert/strict";
import test from "node:test";

import prTracker, { checksText, trackerFor } from "../extensions/pr-tracker/index.ts";

const pr = (o = {}) => ({ number: 4, title: "A card", url: "https://github.com/o/r/pull/4", state: "OPEN", isDraft: false, reviewDecision: null, mergeStateStatus: "CLEAN", statusCheckRollup: [], ...o });
const run = (conclusion, status = "COMPLETED") => ({ status, conclusion });

test("checksText counts check runs and status contexts, skipping neutral ones", () => {
  assert.deepEqual(checksText([]), { text: "", failed: false });
  assert.deepEqual(checksText([run("SUCCESS"), run("SUCCESS"), run("SKIPPED")]), { text: "2/2 checks passed", failed: false });
  assert.deepEqual(checksText([run("SUCCESS"), run("", "IN_PROGRESS")]), { text: "1 of 2 checks running", failed: false });
  assert.deepEqual(checksText([run("SUCCESS"), run("FAILURE"), run("", "QUEUED")]), { text: "1 of 3 checks failed", failed: true });
  assert.deepEqual(checksText([{ state: "SUCCESS" }, { state: "PENDING" }]), { text: "1 of 2 checks running", failed: false });
});

test("trackerFor picks a state canvas colors and a note that says why", () => {
  assert.deepEqual(trackerFor(pr({ statusCheckRollup: [run("SUCCESS")], reviewDecision: "APPROVED" })), {
    title: "A card", id: "4", state: "open", note: "1/1 checks passed · approved · ready to merge", href: "https://github.com/o/r/pull/4",
  });
  assert.equal(trackerFor(pr({ statusCheckRollup: [run("FAILURE")] })).state, "failed");
  assert.equal(trackerFor(pr({ reviewDecision: "REVIEW_REQUIRED" })).state, "review");
  assert.equal(trackerFor(pr({ isDraft: true, statusCheckRollup: [run("FAILURE")] })).state, "draft");
  const merged = trackerFor(pr({ state: "MERGED", statusCheckRollup: [run("SUCCESS")], reviewDecision: "APPROVED" }));
  assert.equal(merged.state, "merged");
  assert.equal(merged.note, undefined);
  assert.equal(trackerFor(pr({ state: "CLOSED" })).state, "closed");
  assert.equal(trackerFor(pr({ mergeStateStatus: "DIRTY" })).note, "merge conflicts");
});

/** A fake pi: records handlers and canvas:put emits; exec answers from `world`. */
function fakePi(world) {
  const on = {};
  const puts = [];
  const pi = {
    on: (name, fn) => (on[name] = fn),
    registerCommand: () => {},
    events: { emit: (name, p) => name === "canvas:put" && (puts.push(p.params), p.reply?.(null, {})) },
    exec: async (cmd) => {
      if (cmd === "git") return world.branch ? { code: 0, stdout: `${world.branch}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      if (cmd === "gh") return world.pr ? { code: 0, stdout: JSON.stringify(world.pr), stderr: "" } : { code: 1, stdout: "", stderr: "no pull requests found" };
      throw new Error(cmd);
    },
  };
  prTracker(pi);
  return { on, puts };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("posts the card, skips unchanged ones, replaces on change and removes when the PR goes away", async () => {
  const world = { branch: "feat/x", pr: pr() };
  const { on, puts } = fakePi(world);
  const ctx = { cwd: "/tmp" };
  on.session_start({}, ctx);
  await settle();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].id, "github-pr");
  assert.equal(puts[0].kind, "tracker");
  assert.equal(puts[0].title, "GitHub");
  assert.equal(JSON.parse(puts[0].body).state, "open");

  on.agent_settled({}, ctx);
  await settle();
  assert.equal(puts.length, 1, "unchanged card not reposted");

  world.pr = pr({ state: "MERGED" });
  on.agent_settled({}, ctx);
  await settle();
  assert.equal(JSON.parse(puts[1].body).state, "merged");

  world.branch = "main";
  world.pr = undefined;
  on.agent_settled({}, ctx);
  await settle();
  assert.deepEqual(puts[2], { kind: "tracker", id: "github-pr", remove: true });

  on.agent_settled({}, ctx);
  await settle();
  assert.equal(puts.length, 3, "nothing to remove twice");
  on.session_shutdown({}, ctx);
});
