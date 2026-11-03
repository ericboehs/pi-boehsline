/**
 * auto-bundle (opt-in): re-runs ~/bin/pi-bundle when the footer's version
 * check sees an update. Never touches the real ~/bin/pi-bundle: HOME points
 * at a temp dir holding a fake script.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bundleIsStale, onVersionCheck, PI_VERSION_EVENT, rebuildBundle, shipsOwnBundle } from "../extensions/opt-in/auto-bundle/index.ts";

process.env.BOEHSLINE_CONFIG = join(mkdtempSync(join(tmpdir(), "auto-bundle-cfg-")), "none.json");

const pkgDir = (version = "1.0.0") => {
	const dir = mkdtempSync(join(tmpdir(), "auto-bundle-pkg-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
	return join(dir, "package.json");
};

/** Run `fn` with HOME holding a fake bin/pi-bundle and the agent dir at `agent`. */
async function withFakeHome(agent, fn) {
	const home = mkdtempSync(join(tmpdir(), "auto-bundle-home-"));
	mkdirSync(join(home, "bin"));
	writeFileSync(join(home, "bin", "pi-bundle"), "#!/bin/sh\necho bundled\n", { mode: 0o755 });
	mkdirSync(agent, { recursive: true });
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_NO_AUTO_BUNDLE: process.env.PI_NO_AUTO_BUNDLE };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agent;
	delete process.env.PI_NO_AUTO_BUNDLE;
	try {
		return await fn(home);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

// rebuildBundle unrefs its detached child. Re-ref it while waiting, or on some
// Node versions (22.18) the loop drains first and the test is cancelled.
const exited = (child) =>
	new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
		child.ref();
		child.on("exit", resolve);
	});

test("the event name matches the footer's", async () => {
	const footer = readFileSync(new URL("../extensions/footer/index.ts", import.meta.url), "utf8");
	assert.match(footer, new RegExp(`PI_VERSION_EVENT = "${PI_VERSION_EVENT}"`));
});

test("rebuild passes paths and version as arguments, never as shell text", async () => {
	// Quotes, $(...) and backticks in the agent dir and the version must stay inert.
	const root = mkdtempSync(join(tmpdir(), "auto-bundle-quote-"));
	const agent = join(root, `a "dir" $(touch ${root}/pwned-dir) \`x\``);
	await withFakeHome(agent, async () => {
		const version = `9.9.9"; touch ${root}/pwned-version; echo "$(touch ${root}/pwned-sub)`;
		const child = await rebuildBundle(version, null);
		assert.ok(child, "spawned");
		await exited(child);
		const log = readFileSync(join(agent, "auto-bundle.log"), "utf8");
		assert.ok(log.includes(`=== auto-rebuild for ${version} at `), log);
		assert.match(log, /\nbundled\n$/);
		for (const f of ["pwned-dir", "pwned-version", "pwned-sub"]) assert.equal(existsSync(join(root, f)), false, f);
		assert.equal(existsSync(join(agent, "pi-bundle.lock")), false, "lock released");
	});
});

test("rebuild runs once per version, and honors PI_NO_AUTO_BUNDLE", async () => {
	const agent = mkdtempSync(join(tmpdir(), "auto-bundle-once-"));
	await withFakeHome(agent, async () => {
		const child = await rebuildBundle("7.0.0-once", null);
		assert.ok(child);
		await exited(child);
		assert.equal(await rebuildBundle("7.0.0-once", null), undefined, "same version again");
		process.env.PI_NO_AUTO_BUNDLE = "1";
		assert.equal(await rebuildBundle("7.0.1-off", null), undefined);
	});
});

test("a held lock skips the rebuild", async () => {
	const agent = mkdtempSync(join(tmpdir(), "auto-bundle-lock-"));
	mkdirSync(join(agent, "pi-bundle.lock"));
	await withFakeHome(agent, async () => {
		const child = await rebuildBundle("7.1.0-locked", null);
		await exited(child);
		assert.equal(existsSync(join(agent, "auto-bundle.log")), false);
		assert.ok(existsSync(join(agent, "pi-bundle.lock")), "someone else's lock stays");
	});
});

test("skips a pi that ships dist/bundle/cli.js, such as a built fork", async () => {
	// Spawning pi-bundle for these only logged "no pi install found next to
	// ~/.pi/agent/bin" on every version change.
	const pkg = pkgDir("1.4.0");
	assert.equal(await shipsOwnBundle(pkg), false);
	mkdirSync(join(pkg, "..", "dist", "bundle"), { recursive: true });
	writeFileSync(join(pkg, "..", "dist", "bundle", "cli.js"), "");
	assert.equal(await shipsOwnBundle(pkg), true);
	const agent = mkdtempSync(join(tmpdir(), "auto-bundle-own-"));
	await withFakeHome(agent, async () => {
		assert.equal(await rebuildBundle("7.2.0-own", pkg), undefined);
	});
});

test("bundleIsStale: missing or older dist/bundle.mjs is stale", async () => {
	const pkg = pkgDir();
	assert.equal(await bundleIsStale(null), false);
	assert.equal(await bundleIsStale(pkg), true, "no bundle yet");
	const bundle = join(pkg, "..", "dist", "bundle.mjs");
	mkdirSync(join(pkg, "..", "dist"));
	writeFileSync(bundle, "");
	const t = Date.now() / 1000;
	utimesSync(pkg, t - 60, t - 60);
	utimesSync(bundle, t, t);
	assert.equal(await bundleIsStale(pkg), false);
	utimesSync(pkg, t + 60, t + 60);
	assert.equal(await bundleIsStale(pkg), true, "package.json newer than the bundle");
});

test("onVersionCheck: rebuild on a new version, or an unchanged one with a stale bundle", async () => {
	const calls = [];
	const rebuild = async (v, p) => calls.push([v, p]);
	const stale = pkgDir();
	await onVersionCheck({ version: "2.0.0", bootVersion: "1.0.0", changed: true, pkgJson: "/x/package.json" }, rebuild);
	await onVersionCheck({ version: "1.0.0", bootVersion: "1.0.0", changed: true, pkgJson: stale }, rebuild); // back to boot
	await onVersionCheck({ version: "1.0.0", bootVersion: "1.0.0", changed: false, pkgJson: stale }, rebuild);
	await onVersionCheck({ version: "", bootVersion: "1.0.0", changed: false, pkgJson: stale }, rebuild);
	assert.deepEqual(calls, [["2.0.0", "/x/package.json"], ["1.0.0", stale]]);
});

test("enabled, it listens for the footer's version checks", async () => {
	const { stubPi } = await import("./helpers/stub-pi.mjs");
	process.env.BOEHSLINE_ENABLE = "auto-bundle";
	try {
		const mod = await import(`../extensions/opt-in/auto-bundle/index.ts?on=${Math.random()}`);
		const s = stubPi();
		await mod.default(s.pi);
		assert.deepEqual(s.names(), []);
		const agent = mkdtempSync(join(tmpdir(), "auto-bundle-event-"));
		await withFakeHome(agent, async () => {
			s.pi.events.emit(PI_VERSION_EVENT, { version: "8.0.0-event", bootVersion: "1.0.0", changed: true, pkgJson: null });
			for (let i = 0; i < 100 && !existsSync(join(agent, "auto-bundle.log")); i++) await new Promise((r) => setTimeout(r, 20));
			assert.ok(existsSync(join(agent, "auto-bundle.log")));
		});
	} finally {
		delete process.env.BOEHSLINE_ENABLE;
	}
});
