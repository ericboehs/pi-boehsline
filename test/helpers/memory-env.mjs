/**
 * A temp world for pi-memory tests: its own boehsline.json, memory root, state
 * folder and an empty git config, so nothing reads or writes the real ones.
 * Import it before lib/memory or the extension.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const world = realpathSync(mkdtempSync(join(tmpdir(), "pi-memory-test-")));
export const configPath = join(world, "boehsline.json");
export const stateHome = join(world, "state");

process.env.BOEHSLINE_CONFIG = configPath;
process.env.XDG_STATE_HOME = stateHome;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.PI_SUBAGENT_CHILD;
writeFileSync(configPath, "{}\n");

let n = 0;
/** A fresh, not yet created root path. */
export function freshRoot(name = "root") {
	return join(world, `${name}-${++n}`);
}

/** Point the memory settings at `root` (and any extra `memory` settings). */
export function useRoot(root, extra = {}) {
	process.env.PI_MEMORY_ROOT = root;
	writeFileSync(configPath, JSON.stringify({ memory: extra }));
}

/**
 * git for test repos: no user or system config, no hooks, no signing, a fixed
 * identity, and none of the GIT_* variables a calling git may have set.
 */
export function testGit(cwd, ...args) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
	Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
	const safe = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "user.name=test", "-c", "user.email=test@example.com"];
	return execFileSync("git", [...safe, "-C", cwd, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

/** Commit subjects, newest first; [] for a repo with no commits yet. */
export function gitLog(root) {
	try {
		testGit(root, "rev-parse", "--verify", "-q", "HEAD");
	} catch {
		return [];
	}
	return testGit(root, "log", "--format=%s").trim().split("\n").filter(Boolean);
}

/** A bin folder with an executable `name` script; returns the folder. */
export function stubBin(name, script) {
	const dir = join(world, `bin-${++n}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, script);
	chmodSync(file, 0o755);
	return dir;
}

/**
 * Secret-looking values built at runtime, so no literal fake token sits in the
 * repo for secret scanners to flag.
 */
export const fake = {
	github: () => ["gh", "p_"].join("") + "Zq7".repeat(12),
	aws: () => ["AK", "IA"].join("") + "Q7RW2XK9PL3MN8VB",
	jwt: () => ["ey", "J"].join("") + "hbGciOiJIUzI1NiJ9." + ["ey", "J"].join("") + "zdWIiOiIxMjM0NTY3ODkwIn0." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
	pem: () => ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
	random: () => "Xk9" + "pQ2" + "vL7" + "mN4" + "tR8" + "wB3" + "yH6" + "cJ1" + "fD5",
	bearer: () => ["Author", "ization: Bea", "rer "].join("") + "aB3dE5" + "fG7hJ9" + "kL2mN4",
	password: () => ["pass", "word"].join("") + ": " + "hunt" + "er2" + "!x",
	urlCreds: () => "https://" + "deploy" + ":" + "s3cr3t" + "Pw" + "@git.example.com/repo",
	opValue: () => "op://" + "Private/api/credential" + " = " + "abc" + "123",
	ssn: () => ["123", "45", "6789"].join("-"),
	card: () => ["4111", "1111", "1111", "1111"].join(" "),
};
