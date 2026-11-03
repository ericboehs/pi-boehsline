// /update — bring the fork checkout pi runs from current with upstream.
//
// pi here runs from a fork checkout (github.com/ericboehs/pi) through
// ~/.pi/agent/bin/pi, which execs the checkout's dist/. `pi update` can't
// update that: there is no npm install to move. The fork's own
// scripts/sync-upstream.sh is the update: merge upstream/main, reinstall when
// the lockfile moved, build, test, and (with --push) push main so the other
// machines pull the same merge. This command finds the checkout and runs it.
//
// Settings (Boehsline config, ~/.pi/agent/boehsline.json):
//   "update": { "dir": "~/Code/github.com/ericboehs/pi", "args": ["--quick-tests", "--push"] }
// With no "dir", the checkout is the one the running pi was started from.
//
// /update check fetches upstream and reports how far behind main is, changing
// nothing. The startup banner says the same when upstream's version is newer
// than the running pi. pi's own banner compares against npm and only says
// `pi update`, which can't update this install, so this extension turns it off.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DynamicBorder, VERSION, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, getCapabilities, hyperlink, type AutocompleteItem } from "@earendil-works/pi-tui";
import { settingsFor } from "../../../lib/config.ts";
import { optIn } from "../../../lib/opt-in.ts";

const SYNC_SCRIPT = join("scripts", "sync-upstream.sh");
const UPDATE_DEFAULTS = { dir: "", args: ["--quick-tests", "--push"] as string[] };

function updateSettings(): { dir: string; args: string[] } {
  const s = settingsFor("update", UPDATE_DEFAULTS);
  const dir = typeof s.dir === "string" ? s.dir : "";
  const args = Array.isArray(s.args) && s.args.every((a) => typeof a === "string") ? s.args : UPDATE_DEFAULTS.args;
  return { dir: dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir, args };
}

const BANNER_TYPE = "pi-update-available";
const CHANGELOG_URL = "https://pi.dev/changelog";

// The startup check fetches upstream (a network round trip plus git). Run
// inline at session_start, it competes with pi's own first paint. So it waits
// until boot is done and runs at most once per window across every pane, with
// the result in a stamp file. A launch inside the window shows the cached
// banner without fetching.
const STARTUP_CHECK_DELAY_MS = 15_000;
const STARTUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STAMP_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "update-check.json");

interface CheckStamp {
  at: number;
  from: string;
  to?: string;
}

async function readStamp(): Promise<CheckStamp | null> {
  try {
    const stamp = JSON.parse(await readFile(STAMP_FILE, "utf8")) as CheckStamp;
    return typeof stamp.at === "number" && typeof stamp.from === "string" ? stamp : null;
  } catch {
    return null;
  }
}

async function writeStamp(stamp: CheckStamp): Promise<void> {
  try {
    await mkdir(dirname(STAMP_FILE), { recursive: true });
    await writeFile(STAMP_FILE, `${JSON.stringify(stamp)}\n`);
  } catch {
    // A missing stamp just means the next launch checks again.
  }
}

/** The nearest directory at or above `start` that holds the fork's sync script. */
export function findCheckout(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, SYNC_SCRIPT))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// The fork checkout: update.dir, else the one this pi was started from
// (process.argv[1] is the checkout's dist/bundle/cli.js, through the wrapper).
export function forkRoot(entry: string | undefined = process.argv[1]): string | null {
  const { dir } = updateSettings();
  if (dir) return findCheckout(dir);
  if (!entry) return null;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    return null;
  }
  return findCheckout(dirname(resolved));
}

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve({ code: 127, out: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.trim() }));
  });
}

export interface UpstreamStatus {
  /** Commits on upstream/main that main doesn't have. */
  behind: number;
  /** coding-agent's version on upstream/main. */
  version: string;
  sha: string;
}

/** Fetch upstream and compare. Changes no branch, only the upstream/main ref. */
export async function upstreamStatus(root: string): Promise<UpstreamStatus | null> {
  if ((await git(root, ["fetch", "--quiet", "upstream", "main"])).code !== 0) return null;
  const behind = await git(root, ["rev-list", "--count", "main..upstream/main"]);
  const pkg = await git(root, ["show", "upstream/main:packages/coding-agent/package.json"]);
  const sha = await git(root, ["rev-parse", "--short", "upstream/main"]);
  if (behind.code !== 0 || pkg.code !== 0) return null;
  let version = "";
  try {
    version = String((JSON.parse(pkg.out) as { version?: unknown }).version ?? "");
  } catch {
    return null;
  }
  return { behind: Number.parseInt(behind.out, 10) || 0, version, sha: sha.out };
}

function runSync(
  root: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [SYNC_SCRIPT, ...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let buf = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (buf.trim()) onLine(buf.trim());
      resolve({ code, output });
    };
    const take = (chunk: Buffer) => {
      // Strip the script's bold/red escapes: the status line and the record are plain text.
      const text = chunk.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
      output += text;
      buf += text;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
        nl = buf.indexOf("\n");
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) => {
      output += `sync-upstream: failed to start: ${err.message}\n`;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

function bannerLines(version: string, theme: Theme): { title: string; changelog: string } {
  const title =
    theme.bold(theme.fg("warning", "Update Available")) +
    "\n" +
    theme.fg("muted", `Upstream pi is at ${version}. Run `) +
    theme.fg("accent", "/update") +
    theme.fg("muted", " to merge it into the fork and rebuild");
  const url = getCapabilities().hyperlinks
    ? hyperlink(theme.fg("accent", CHANGELOG_URL), CHANGELOG_URL)
    : theme.fg("accent", CHANGELOG_URL);
  return { title, changelog: theme.fg("muted", "Changelog: ") + url };
}

function renderBanner(version: string, theme: Theme): Container {
  const { title, changelog } = bannerLines(version, theme);
  const border = () => new DynamicBorder((text) => theme.fg("warning", text));
  const box = new Container();
  box.addChild(border());
  box.addChild(new Text(title, 1, 0));
  box.addChild(new Text(changelog, 1, 0));
  box.addChild(border());
  return box;
}

// Banners live in the session file, so resuming an old session replays them.
// One only renders while its version is still newer than the running pi.
export function isNewer(version: string, than: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(version);
  const b = parts(than);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** The last `n` lines: a full run with tests is far longer than the record needs. */
function tail(text: string, n: number): string {
  const lines = text.trim().split("\n");
  return lines.length > n ? [`… ${lines.length - n} earlier lines`, ...lines.slice(-n)].join("\n") : lines.join("\n");
}

function main(pi: ExtensionAPI) {
  if (!process.env.PI_OFFLINE) process.env.PI_SKIP_VERSION_CHECK = "1";

  let announcedFor: string | undefined;

  // A custom entry, not a message: it shows in the chat but never reaches the model.
  const showBanner = (version: string): void => {
    pi.appendEntry(BANNER_TYPE, { version });
  };

  pi.registerEntryRenderer(BANNER_TYPE, (entry, _options, theme) => {
    const version = (entry.data as { version?: unknown } | undefined)?.version;
    if (typeof version !== "string" || !isNewer(version, VERSION)) return undefined;
    return renderBanner(version, theme);
  });

  // Sessions from before the switch hold banners as custom messages. An empty
  // component hides a stale one (undefined would fall back to the raw text).
  pi.registerMessageRenderer(BANNER_TYPE, (message, _options, theme) => {
    const version = (message.details as { version?: unknown } | undefined)?.version;
    if (typeof version !== "string" || version === "") return undefined;
    return isNewer(version, VERSION) ? renderBanner(version, theme) : new Container();
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || process.env.PI_OFFLINE || announcedFor) return;
    const announce = (to: string | undefined): void => {
      if (!to || !isNewer(to, VERSION) || announcedFor === to) return;
      announcedFor = to;
      showBanner(to);
    };
    void (async () => {
      try {
        // A stamp from this same pi version inside the window is current enough.
        const stamp = await readStamp();
        if (stamp && stamp.from === VERSION && Date.now() - stamp.at < STARTUP_CHECK_INTERVAL_MS) {
          announce(stamp.to);
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_CHECK_DELAY_MS).unref());
        // Another pane may have checked while this one waited.
        const again = await readStamp();
        if (again && again.from === VERSION && Date.now() - again.at < STARTUP_CHECK_INTERVAL_MS) {
          announce(again.to);
          return;
        }
        await writeStamp({ at: Date.now(), from: VERSION });
        const root = forkRoot();
        if (!root) return;
        const status = await upstreamStatus(root);
        if (!status) return;
        const to = isNewer(status.version, VERSION) ? status.version : undefined;
        await writeStamp({ at: Date.now(), from: VERSION, to });
        announce(to);
      } catch {
        // A failed availability check is not worth a startup error. /update still works.
      }
    })();
  });

  pi.registerCommand("update", {
    description: "Merge upstream pi into the fork, rebuild and test (scripts/sync-upstream.sh)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
      const item: AutocompleteItem = {
        value: "check",
        label: "check",
        description: "Fetch upstream and say how far behind the fork is, touch nothing",
      };
      return item.value.startsWith(prefix) ? [item] : [];
    },
    handler: async (args, ctx) => {
      const stash = globalThis as { __piUpdateRunning?: boolean };
      if (stash.__piUpdateRunning) {
        if (ctx.hasUI) ctx.ui.notify("An update is already running", "warning");
        return;
      }

      const root = forkRoot();
      if (!root) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Can't find the pi fork checkout (no ${SYNC_SCRIPT}). Set "update": { "dir": "…" } in ~/.pi/agent/boehsline.json`, "error");
        }
        return;
      }

      stash.__piUpdateRunning = true;
      try {
        if (args.trim() === "check") {
          if (ctx.hasUI) ctx.ui.setStatus("update", "pi update: fetching upstream…");
          const status = await upstreamStatus(root);
          if (!status) {
            if (ctx.hasUI) ctx.ui.notify(`Couldn't fetch upstream in ${root}`, "error");
            return;
          }
          await writeStamp({ at: Date.now(), from: VERSION, to: isNewer(status.version, VERSION) ? status.version : undefined });
          if (isNewer(status.version, VERSION)) {
            announcedFor = status.version;
            showBanner(status.version);
          }
          if (ctx.hasUI) {
            ctx.ui.notify(
              status.behind === 0
                ? `pi ${VERSION}: the fork has everything on upstream/main (${status.sha})`
                : `pi ${VERSION}: ${status.behind} upstream commit${status.behind === 1 ? "" : "s"} to merge (upstream at ${status.version}, ${status.sha})`,
              status.behind === 0 ? "info" : "warning",
            );
          }
          return;
        }

        const before = (await git(root, ["rev-parse", "HEAD"])).out;
        const { args: syncArgs } = updateSettings();
        if (ctx.hasUI) ctx.ui.setStatus("update", "pi update: running sync-upstream…");
        const { code, output } = await runSync(root, syncArgs, (line) => {
          if (ctx.hasUI) ctx.ui.setStatus("update", line);
        });
        const after = (await git(root, ["rev-parse", "HEAD"])).out;
        const moved = before !== "" && after !== "" && before !== after;
        if (code === 0) await writeStamp({ at: Date.now(), from: VERSION });

        if (ctx.hasUI) {
          if (code !== 0) ctx.ui.notify(`sync-upstream failed in ${root}; the tree is left as-is to inspect`, "error");
          else if (moved) ctx.ui.notify("Fork merged and rebuilt — restart pi to run the new build", "warning");
          else ctx.ui.notify(`pi ${VERSION}: the fork already has upstream/main`, "info");
        }

        // The script's own output is the record: what merged, the build, the
        // tests. A fence keeps leading dashes from being read as a list.
        pi.sendMessage({
          customType: "pi-update",
          content: ["```", tail(output, 60) || "(no output)", "```"].join("\n"),
          display: true,
        });
      } finally {
        stash.__piUpdateRunning = false;
        if (ctx.hasUI) ctx.ui.setStatus("update", undefined);
      }
    },
  });
}

export default optIn("update", "/update: merge upstream pi into the fork and rebuild", main);
