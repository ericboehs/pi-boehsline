/**
 * The worktrees the cursor tool leaves behind (`worktree: true`): Cursor creates them
 * at ~/.cursor/worktrees/<repo>/<name>, and the tool always names them `pi-…`. The
 * changes stay uncommitted there, so /cursor-worktrees lists them and applies or
 * discards each one.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const WORKTREE_ROOT = join(homedir(), ".cursor", "worktrees");

/** Runs git in `cwd`, optionally feeding `input` on stdin; rejects with stderr on a non-zero exit. */
export function git(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
	return new Promise((done, fail) => {
		const env = opts.env ? { ...process.env, ...opts.env } : process.env;
		const proc = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
		proc.stdout.on("data", (b: Buffer) => out.push(b));
		proc.stderr.on("data", (b: Buffer) => err.push(b));
		proc.on("error", (e) => {
			clearTimeout(timer);
			fail(e);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) done(Buffer.concat(out).toString());
			else fail(new Error(Buffer.concat(err).toString().trim() || `git ${args[0]} exited with code ${code}`));
		});
		proc.stdin.end(opts.input ?? "");
	});
}

export interface CursorWorktree {
	/** The worktree directory, e.g. ~/.cursor/worktrees/app/pi-mw00oczn-gamk. */
	path: string;
	name: string;
	/** The main checkout it belongs to; absent when git no longer knows the worktree. */
	repo?: string;
	branch: string;
	/** `git status --short` lines: the uncommitted changes. */
	changed: string[];
	/** Commits on the worktree's branch that the main checkout's HEAD doesn't have. */
	ahead: number;
	/** Why git couldn't read it, for a stale directory. */
	problem?: string;
}

const isDir = (p: string) => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

/** Every `pi-*` worktree under `root`, newest name last. */
export async function listWorktrees(root = WORKTREE_ROOT): Promise<CursorWorktree[]> {
	if (!isDir(root)) return [];
	const paths = readdirSync(root)
		.map((r) => join(root, r))
		.filter(isDir)
		.flatMap((repoDir) =>
			readdirSync(repoDir)
				.filter((n) => n.startsWith("pi-"))
				.map((n) => join(repoDir, n)),
		)
		.filter(isDir)
		.sort();
	return Promise.all(paths.map(inspect));
}

async function inspect(path: string): Promise<CursorWorktree> {
	const wt: CursorWorktree = { path, name: basename(path), branch: "", changed: [], ahead: 0 };
	try {
		const common = (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
		wt.repo = dirname(common);
		const [branch, status, base] = await Promise.all([
			git(path, ["branch", "--show-current"]),
			git(path, ["status", "--short"]),
			forkPoint(path, wt.repo),
		]);
		wt.branch = branch.trim();
		wt.changed = status.split("\n").filter(Boolean);
		wt.ahead = Number((await git(path, ["rev-list", "--count", `${base}..HEAD`])).trim()) || 0;
	} catch (err) {
		wt.problem = (err as Error).message.split("\n")[0];
	}
	return wt;
}

/** Where the worktree's branch left the main checkout's HEAD. */
async function forkPoint(path: string, repo: string): Promise<string> {
	const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
	return (await git(path, ["merge-base", "HEAD", head])).trim();
}

/**
 * Applies everything the worktree has beyond its fork point (commits and uncommitted
 * changes, untracked files included) to the main checkout's working tree, uncommitted.
 * Nothing is applied when the patch doesn't apply cleanly.
 */
export async function applyToRepo(wt: CursorWorktree): Promise<{ files: number }> {
	if (!wt.repo) throw new Error(`git no longer tracks ${wt.path}`);
	const base = await forkPoint(wt.path, wt.repo);
	// Diff a throwaway index so untracked files are included without touching the worktree's own index.
	const scratch = mkdtempSync(join(tmpdir(), "pi-cursor-apply-"));
	const index = join(scratch, "index");
	let patch: string;
	try {
		const env = { GIT_INDEX_FILE: index };
		await git(wt.path, ["read-tree", "HEAD"], { env });
		await git(wt.path, ["add", "-A"], { env });
		patch = await git(wt.path, ["diff", "--cached", "--binary", base], { env });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	if (!patch.trim()) return { files: 0 };
	try {
		await git(wt.repo, ["apply", "--check"], { input: patch });
	} catch (err) {
		throw new Error(`doesn't apply cleanly to ${wt.repo}: ${(err as Error).message.split("\n")[0]}`);
	}
	await git(wt.repo, ["apply"], { input: patch });
	return { files: (patch.match(/^diff --git /gm) ?? []).length };
}

/** Deletes the worktree and its `pi-*` branch. */
export async function removeWorktree(wt: CursorWorktree): Promise<void> {
	if (!wt.name.startsWith("pi-")) throw new Error(`refusing to remove ${wt.path}: not a pi-* worktree`);
	if (wt.repo && existsSync(wt.repo)) {
		await git(wt.repo, ["worktree", "remove", "--force", wt.path]);
		if (wt.branch.startsWith("pi-")) await git(wt.repo, ["branch", "-D", wt.branch]).catch(() => {});
	} else {
		rmSync(wt.path, { recursive: true, force: true });
	}
	try {
		rmdirSync(dirname(wt.path)); // the per-repo folder, once empty
	} catch {}
}

export function describe(wt: CursorWorktree): string {
	const repo = wt.repo ? basename(wt.repo) : basename(dirname(wt.path));
	if (wt.problem) return `${repo}/${wt.name} · unreadable (${wt.problem})`;
	const parts = [`${wt.changed.length} changed`];
	if (wt.ahead) parts.push(`${wt.ahead} commit${wt.ahead === 1 ? "" : "s"}`);
	return `${repo}/${wt.name} · ${parts.join(", ")}`;
}
