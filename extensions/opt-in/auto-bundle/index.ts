// auto-bundle — re-run ~/bin/pi-bundle in the background when pi updates.
//
// A pi update leaves dist/bundle.mjs stale and the bin at stock cli.js, so
// every launch runs ~115ms slower until someone re-runs pi-bundle. The footer
// already checks pi's on-disk version every 30s for its "Update installed"
// notice and announces each check on pi.events (boehsline:pi-version, with the
// resolved package.json); this extension listens and kicks off the rebuild in
// a detached process. It needs the footer on, and a ~/bin/pi-bundle script;
// without the script it does nothing.
//
// Runs once per detected version (a globalThis guard survives /reload), honors
// PI_NO_AUTO_BUNDLE=1, serializes concurrent detections from other pi
// instances on a lock directory, and appends everything to auto-bundle.log in
// the agent directory.

import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { optIn } from "../../../lib/opt-in.ts";

/** Same string as the footer's PI_VERSION_EVENT (not imported: that would load the whole footer). */
export const PI_VERSION_EVENT = "boehsline:pi-version";

/** Where the background bundle rebuild appends its output. */
const AUTO_BUNDLE_LOG = "auto-bundle.log";
/** Concurrent detections across pi instances serialize on this lock directory. */
const AUTO_BUNDLE_LOCK = "pi-bundle.lock";
/** A lock older than this is stale (a crashed run never cleaned up) and gets stolen. */
const AUTO_BUNDLE_LOCK_STALE_MIN = 10;

/**
 * The detached rebuild. Values arrive as positional parameters ($1 lock dir,
 * $2 log file, $3 pi-bundle script, $4 version), never spliced into the
 * script text, so a path or version with quotes, `$` or backticks is inert.
 */
export const REBUILD_SCRIPT = [
	`lock=$1 log=$2 script=$3 version=$4`,
	`if ! mkdir "$lock" 2>/dev/null; then`,
	`  if [ -z "$(find "$lock" -maxdepth 0 -mmin -${AUTO_BUNDLE_LOCK_STALE_MIN} 2>/dev/null)" ]; then`,
	`    rm -rf "$lock" && mkdir "$lock" || exit 0`,
	`  else`,
	`    exit 0`,
	`  fi`,
	`fi`,
	`trap 'rm -rf "$lock"' EXIT`,
	`echo "=== auto-rebuild for $version at $(date) (pid $$)" >> "$log"`,
	`"$script" >> "$log" 2>&1`,
].join("\n");

/** Matches the footer's PiVersionEvent. */
export interface PiVersionEvent {
	version: string;
	bootVersion: string;
	changed: boolean;
	pkgJson: string | null;
}

function agentDir(): string {
	// Resolved per call, not at module load, so a HOME change is picked up.
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
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
 * Since pi 0.85 upstream ships dist/bundle/cli.js, and pi-bundle builds
 * nothing when it exists. A source checkout (the pi fork) has it after
 * `npm run build` too.
 */
export async function shipsOwnBundle(pkgJson: string): Promise<boolean> {
	return stat(join(dirname(pkgJson), "dist", "bundle", "cli.js")).then(() => true, () => false);
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
export async function bundleIsStale(pkgJson: string | null): Promise<boolean> {
	try {
		if (!pkgJson) return false;
		// A missing dist/bundle.mjs is expected, not stale, when pi ships its own.
		if (await shipsOwnBundle(pkgJson)) return false;
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
 * Start pi-bundle in a detached background process, once per version.
 * Resolves with the child, or undefined when nothing was started.
 */
export async function rebuildBundle(version: string, pkgJson: string | null): Promise<ReturnType<typeof spawn> | undefined> {
	const stash = globalThis as { __piFooterAutoBundleFor?: string };
	if (stash.__piFooterAutoBundleFor === version) return undefined;
	stash.__piFooterAutoBundleFor = version;
	if (process.env.PI_NO_AUTO_BUNDLE) return undefined;

	// Nothing to build when pi ships its own bundle. Spawning pi-bundle anyway
	// only logs a failure: run through ~/.pi/agent/bin/pi, the fork has no
	// install beside its bin for pi-bundle to find.
	if (pkgJson && (await shipsOwnBundle(pkgJson))) return undefined;

	const script = await piBundleScript();
	if (!script) return undefined;

	const dir = agentDir();
	// Redirect by path, not by inherited fd: Node opens files with O_CLOEXEC,
	// so fd numbers from this process don't exist in the detached child.
	const logPath = join(dir, AUTO_BUNDLE_LOG);
	const lockPath = join(dir, AUTO_BUNDLE_LOCK);
	const child = spawn("/bin/sh", ["-c", REBUILD_SCRIPT, "sh", lockPath, logPath, script, version], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
	});
	child.unref();
	return child;
}

/**
 * One footer version check. A new version on disk rebuilds; so does an
 * unchanged one whose bundle is stale. Version-change detection alone misses
 * the states that leave every launch on dist/cli.js: the rebuild that fired
 * mid-npm-install stamped a bundle older than the finished package.json, and
 * a pi launched after its own upgrade seeded the footer with the new version
 * so `changed` is never true. One check later the stale branch re-bundles.
 */
export async function onVersionCheck(
	event: PiVersionEvent,
	rebuild: (version: string, pkgJson: string | null) => Promise<unknown> = rebuildBundle,
): Promise<void> {
	const { version, bootVersion, changed, pkgJson } = event;
	if (changed && version !== bootVersion) await rebuild(version, pkgJson);
	else if (!changed && version && (await bundleIsStale(pkgJson))) await rebuild(version, pkgJson);
}

export default optIn("auto-bundle", "Re-run ~/bin/pi-bundle in the background when pi updates", (pi: ExtensionAPI) => {
	pi.events.on(PI_VERSION_EVENT, (data: unknown) => {
		if (!data || typeof data !== "object") return;
		void onVersionCheck(data as PiVersionEvent).catch(() => {});
	});
});
