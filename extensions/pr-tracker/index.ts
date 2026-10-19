/**
 * A canvas tracker card for the GitHub PR on the current branch.
 *
 * On session start, after every run, and once a minute while the PR is open, it
 * asks `gh pr view` about the branch and posts a `tracker` section (id
 * `github-pr`, titled "GitHub") through canvas's `canvas:put` event. The card
 * shows the PR number, a state word canvas colors (draft, failed, review, open,
 * merged, closed), the PR title linked to the PR, and a note with checks,
 * review and merge status.
 *
 * It stays quiet: no `gh`, no git repo, or a branch with no PR posts nothing, and
 * removes a card it posted earlier (after you switch back to main, say). An
 * unchanged card is not posted again, so it doesn't light up as "changed in the
 * last turn" on every poll. Polling stops once the PR is merged or closed, and
 * gh is only asked again when the branch changes or a run ends.
 *
 * `/pr-tracker` refreshes it now.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SECTION_ID = "github-pr";
const SECTION_TITLE = "GitHub";
const POLL_MS = 60_000;
const GH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 3_000;
const FIELDS = "number,title,url,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup";

type Check = { status?: string; conclusion?: string; state?: string };
export type Pr = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
  statusCheckRollup?: Check[] | null;
};
export type Tracker = { title: string; id: string; state: string; note?: string; href: string };

/** One check's outcome. CheckRuns carry status+conclusion; StatusContexts carry state. */
function outcome(c: Check): "pass" | "fail" | "pending" | "skip" {
  const v = String(c.conclusion || c.state || "").toUpperCase();
  if (c.status && c.status.toUpperCase() !== "COMPLETED") return "pending";
  if (["SUCCESS"].includes(v)) return "pass";
  if (["NEUTRAL", "SKIPPED", "STALE"].includes(v)) return "skip";
  if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", ""].includes(v)) return "pending";
  return "fail"; // FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE
}

/** "8/8 checks passed", "1 of 8 checks failed", "3 of 8 checks running", or "" with no checks. */
export function checksText(checks: Check[] | null | undefined): { text: string; failed: boolean } {
  const list = (checks || []).map(outcome).filter((o) => o !== "skip");
  if (!list.length) return { text: "", failed: false };
  const n = (o: string) => list.filter((x) => x === o).length;
  if (n("fail")) return { text: `${n("fail")} of ${list.length} checks failed`, failed: true };
  if (n("pending")) return { text: `${n("pending")} of ${list.length} checks running`, failed: false };
  return { text: `${list.length}/${list.length} checks passed`, failed: false };
}

const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };
const MERGE: Record<string, string> = { CLEAN: "ready to merge", DIRTY: "merge conflicts", BEHIND: "behind base", BLOCKED: "blocked by rules", UNSTABLE: "mergeable, checks unstable" };

/** The tracker card for a PR: a state word canvas colors, and a note that says why. */
export function trackerFor(pr: Pr): Tracker {
  const checks = checksText(pr.statusCheckRollup);
  let state: string;
  if (pr.state === "MERGED") state = "merged";
  else if (pr.state === "CLOSED") state = "closed";
  else if (pr.isDraft) state = "draft";
  else if (checks.failed) state = "failed";
  else if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED") state = "review";
  else state = "open";
  const open = pr.state === "OPEN";
  const note = [
    open ? checks.text : "",
    open && pr.reviewDecision ? REVIEW[pr.reviewDecision] || "" : "",
    open && !pr.isDraft && pr.mergeStateStatus ? MERGE[pr.mergeStateStatus] || "" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { title: pr.title, id: String(pr.number), state, ...(note ? { note } : {}), href: pr.url };
}

export default function prTracker(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastBranch = "";
  let lastBody = ""; // the card as last posted; "" when none is up
  let open = false; // the branch's PR is open: worth polling
  let running: Promise<void> | undefined;
  let ctxRef: ExtensionContext | undefined;

  const put = (ctx: ExtensionContext, params: Record<string, unknown>) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5_000); // no canvas listening: don't wait forever
      pi.events?.emit?.("canvas:put", { params, ctx, reply: () => (clearTimeout(t), resolve()) });
    });

  async function branchOf(cwd: string): Promise<string> {
    const r = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }).catch(() => undefined);
    return r?.code === 0 ? r.stdout.trim() : "";
  }

  async function prOf(cwd: string): Promise<Pr | undefined> {
    const r = await pi.exec("gh", ["pr", "view", "--json", FIELDS], { cwd, timeout: GH_TIMEOUT_MS }).catch(() => undefined);
    if (r?.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout) as Pr;
    } catch {
      return undefined;
    }
  }

  /** Re-read the branch's PR and post, replace or remove the card. `force`: ask gh even when nothing hints at a change. */
  async function refresh(ctx: ExtensionContext, force: boolean): Promise<void> {
    const branch = await branchOf(ctx.cwd);
    if (!force && !open && branch === lastBranch) return; // idle poll, nothing open, same branch: skip gh
    lastBranch = branch;
    const pr = branch ? await prOf(ctx.cwd) : undefined;
    open = pr?.state === "OPEN";
    if (!pr) {
      if (lastBody) await put(ctx, { kind: "tracker", id: SECTION_ID, remove: true });
      lastBody = "";
      return;
    }
    const body = JSON.stringify(trackerFor(pr));
    if (body === lastBody) return;
    lastBody = body;
    await put(ctx, { kind: "tracker", id: SECTION_ID, title: SECTION_TITLE, body });
  }

  const kick = (ctx: ExtensionContext, force: boolean) => {
    ctxRef = ctx;
    if (running) return running;
    running = refresh(ctx, force)
      .catch(() => {})
      .finally(() => (running = undefined));
    return running;
  };

  pi.on("session_start", (_e, ctx) => {
    lastBranch = "";
    lastBody = "";
    open = false;
    void kick(ctx, true);
    if (timer) clearInterval(timer);
    timer = setInterval(() => ctxRef && void kick(ctxRef, false), POLL_MS);
    timer.unref?.();
  });

  pi.on("agent_settled", (_e, ctx) => void kick(ctx, true));

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    ctxRef = undefined;
  });

  pi.registerCommand("pr-tracker", {
    description: "Refresh the canvas card for this branch's GitHub PR",
    handler: async (_args, ctx) => {
      await kick(ctx, true);
      ctx.ui.notify(lastBody ? `PR card: ${JSON.parse(lastBody).state}` : "No PR for this branch", "info");
    },
  });
}
