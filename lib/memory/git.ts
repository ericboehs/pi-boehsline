/**
 * The memory root's local git repo: one commit per write, for undo and audit.
 *
 * Commits are serialized by <root>/.git/pi-memory.lock and never throw: a
 * failing git is reported through the result (and `log`), never by failing the
 * write that came before it. The repo must never get a remote; commit refuses
 * to run when it has one, so a pool can't leave the host by a later `git push`.
 *
 * Git runs with hooks, fsmonitor, signing, global attributes and filter or
 * diff drivers off, and without the GIT_* variables that would point it at
 * another repo or inject config, so nothing in the environment, the user's git
 * config or a .gitattributes in the root runs code when a memory is saved.
 *
 * Pure node: no pi imports.
 */

import { execFile, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SAFE_CONFIG = [
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "core.attributesFile=/dev/null",
	"-c", "commit.gpgsign=false",
	"-c", "user.name=pi-memory",
	"-c", "user.email=pi-memory@localhost",
];

/** GIT_* variables kept: the ones that only choose which user config to read. */
const KEEP = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);

export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!k.startsWith("GIT_") || KEEP.has(k)) out[k] = v;
	out.GIT_TERMINAL_PROMPT = "0";
	return out;
}

export interface GitResult {
	ok: boolean;
	/** Set when nothing was committed because nothing changed. */
	unchanged?: boolean;
	error?: string;
}

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;
const GIT_TIMEOUT_MS = 15_000;

/** This repo exactly: never one found by walking up from the root. */
const repoArgs = (root: string) => [`--git-dir=${join(root, ".git")}`, `--work-tree=${root}`];

function run(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile("git", [...SAFE_CONFIG, ...repoArgs(root), ...args], { env: gitEnv(), timeout: GIT_TIMEOUT_MS, encoding: "utf8" }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
		});
	});
}

/** Written to the repo's own config too, so a git run by hand in the root runs no hooks either. */
const LOCAL_CONFIG: [string, string][] = [
	["core.hooksPath", "/dev/null"],
	["core.fsmonitor", "false"],
	["commit.gpgsign", "false"],
	["user.name", "pi-memory"],
	["user.email", "pi-memory@localhost"],
];

/**
 * Read before any .gitattributes in the tree, so no attribute there can name a
 * filter or diff driver from the user's config for `git add` to run.
 */
export const INFO_ATTRIBUTES = "* -filter -diff -merge -text -ident -working-tree-encoding\n";

/**
 * `git init` the root when it isn't a repo yet, with no template (so no sample
 * hooks), and make sure its local config turns hooks off and its
 * info/attributes turns drivers off. Throws on failure.
 */
export function gitInit(root: string): void {
	const sync = (args: string[]) => spawnSync("git", [...SAFE_CONFIG, ...args], { env: gitEnv(), encoding: "utf8", timeout: GIT_TIMEOUT_MS });
	const fresh = !existsSync(join(root, ".git"));
	if (fresh) {
		const r = sync(["init", "-q", "--template=", root]);
		if (r.status !== 0) throw new Error(`git init failed: ${(r.stderr || r.error?.message || "").trim()}`);
	}
	if (fresh || sync([...repoArgs(root), "config", "--local", "--get", "core.hooksPath"]).stdout.trim() !== "/dev/null") {
		for (const [key, value] of LOCAL_CONFIG) {
			const r = sync([...repoArgs(root), "config", "--local", key, value]);
			if (r.status !== 0) throw new Error(`git config ${key} failed: ${(r.stderr || r.error?.message || "").trim()}`);
		}
	}
	const info = join(root, ".git", "info");
	const attributes = join(info, "attributes");
	if (!existsSync(attributes) || readFileSync(attributes, "utf8") !== INFO_ATTRIBUTES) {
		mkdirSync(info, { recursive: true, mode: 0o700 });
		writeFileSync(attributes, INFO_ATTRIBUTES, { mode: 0o600 });
	}
	const ignore = join(root, ".gitignore");
	if (!existsSync(ignore)) writeFileSync(ignore, ".tmp-*\n", { mode: 0o600 });
}

/** The repo's remote names (none expected). */
export function remotes(root: string): string[] {
	if (!existsSync(join(root, ".git"))) return [];
	const r = spawnSync("git", [...SAFE_CONFIG, ...repoArgs(root), "remote"], { env: gitEnv(), encoding: "utf8", timeout: GIT_TIMEOUT_MS });
	return r.status === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

async function lock(path: string): Promise<boolean> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			closeSync(openSync(path, "wx", 0o600));
			return true;
		} catch {
			try {
				if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
			} catch {}
		}
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
	}
}

/** Commit everything under the root as one commit. Never throws. */
export async function commit(root: string, message: string, log: (msg: string) => void = () => {}): Promise<GitResult> {
	const fail = (error: string): GitResult => {
		log(`pi-memory: git: ${error}`);
		return { ok: false, error };
	};
	try {
		if (!existsSync(join(root, ".git"))) return fail("the memory root is not a git repo");
		const lockPath = join(root, ".git", "pi-memory.lock");
		if (!(await lock(lockPath))) return fail("timed out waiting for the commit lock");
		try {
			const rem = await run(root, ["remote"]);
			if (rem.code !== 0) return fail(rem.stderr.trim() || "git remote failed");
			if (rem.stdout.trim()) return fail(`refusing to commit: the memory repo has a remote (${rem.stdout.trim().split("\n").join(", ")}); memory must stay on this host, remove it with git remote remove`);
			const add = await run(root, ["add", "-A"]);
			if (add.code !== 0) return fail(add.stderr.trim() || "git add failed");
			const staged = await run(root, ["diff", "--cached", "--quiet", "--no-ext-diff"]);
			if (staged.code === 0) return { ok: true, unchanged: true };
			const done = await run(root, ["commit", "-q", "--no-verify", "-m", message]);
			if (done.code !== 0) return fail(done.stderr.trim() || "git commit failed");
			return { ok: true };
		} finally {
			try {
				unlinkSync(lockPath);
			} catch {}
		}
	} catch (err) {
		return fail((err as Error).message);
	}
}
