/**
 * Per-repo watchers: the session's git toplevel, its remote's owner/name, and
 * the state folder name for a (watcher, repo) pair.
 *
 * git runs with async execFile (argv only, no shell), under one overall time
 * budget per session start, with a minimal environment and
 * `-c core.fsmonitor=` (so no fsmonitor hook runs). A cwd that isn't in a git
 * work tree, or one git refuses (dubious ownership), has no toplevel. Paths
 * are realpath'd with `realpathSync.native`.
 *
 * Pure node, no pi imports.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { REPO_RE } from "./contract.ts";

/** The whole budget for git at one session start (every call together). */
export const GIT_TIMEOUT_MS = 2000;

export type ToplevelResult = { path: string } | { error: string };

/** How the host asks git; tests inject their own (sync or async). The signal aborts at the budget. */
export interface GitResolver {
	/** The realpath'd git toplevel of `cwd`, or why there's none. */
	toplevel(cwd: string, signal?: AbortSignal): ToplevelResult | Promise<ToplevelResult>;
	/** The fetch URL of `origin`, else of the first remote; undefined when there's none. */
	remoteUrl(toplevel: string, signal?: AbortSignal): string | undefined | Promise<string | undefined>;
}

/** realpath (native), falling back to the path as given. */
export function realNative(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}

const gitEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
	const out: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
	for (const k of ["PATH", "HOME"]) if (env[k]) out[k] = env[k] as string;
	return out;
};

interface GitError {
	code?: unknown;
	signal?: unknown;
	stderr?: unknown;
	aborted?: boolean;
}

/** Run `git -c core.fsmonitor= -C dir ...args`; stdout, or rejects with a GitError. Never blocks the event loop. */
function git(dir: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject({ aborted: true } satisfies GitError);
		execFile(
			"git",
			["-c", "core.fsmonitor=", "-C", dir, ...args],
			{ encoding: "utf8", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", env: gitEnv(env), maxBuffer: 64 * 1024, shell: false, ...(signal ? { signal } : {}) },
			(err, stdout, stderr) => {
				if (!err) return resolve(stdout);
				const e = err as NodeJS.ErrnoException & { signal?: unknown; killed?: boolean };
				reject({ code: e.code, signal: e.signal, stderr, aborted: e.name === "AbortError" || !!signal?.aborted } satisfies GitError);
			},
		).stdin?.end();
	});
}

const errOut = (e: unknown): string => {
	const err = e as GitError;
	if (err?.aborted || err?.code === "ABORT_ERR") return "git timed out";
	if (err?.code === "ENOENT") return "git not found";
	if (err?.signal) return "git timed out";
	return typeof err?.stderr === "string" ? err.stderr : "";
};

/** The real resolver: runs git asynchronously. */
export function systemGit(env: NodeJS.ProcessEnv = process.env): GitResolver {
	return {
		async toplevel(cwd, signal) {
			let out: string;
			try {
				out = await git(cwd, ["rev-parse", "--show-toplevel"], env, signal);
			} catch (e) {
				const msg = errOut(e);
				if (/dubious ownership|unsafe repository/i.test(msg)) return { error: "not a git repo (git refuses it: dubious ownership)" };
				if (msg === "git not found" || msg === "git timed out") return { error: `not a git repo (${msg})` };
				return { error: "not a git repo" };
			}
			const path = out.replace(/\r?\n$/, "");
			if (!path || path.includes("\n")) return { error: "not a git repo" };
			return { path: realNative(path) };
		},
		async remoteUrl(toplevel, signal) {
			const get = async (name: string): Promise<string | undefined> => {
				try {
					const url = (await git(toplevel, ["remote", "get-url", name], env, signal)).trim();
					return url && !url.includes("\n") ? url : undefined;
				} catch {
					return undefined;
				}
			};
			const origin = await get("origin");
			if (origin) return origin;
			if (signal?.aborted) return undefined;
			let names: string[];
			try {
				names = (await git(toplevel, ["remote"], env, signal)).split("\n").map((s) => s.trim()).filter(Boolean);
			} catch {
				return undefined;
			}
			const first = names[0];
			return first && !first.startsWith("-") ? get(first) : undefined;
		},
	};
}

export interface RemoteRepo {
	/** Lowercased host. */
	host: string;
	/** Lowercased `owner/name`, without `.git`. */
	repo: string;
}

/**
 * `owner/name` and host from a git remote URL: `https://host/owner/name(.git)`,
 * `ssh://[user@]host[:port]/owner/name(.git)` or `[user@]host:owner/name(.git)`.
 * The host must be on `hosts`. Anything else (another scheme, a deeper path,
 * a host off the list) is undefined: the pin then stays empty.
 */
export function parseRemote(url: string | undefined, hosts: string[]): RemoteRepo | undefined {
	if (typeof url !== "string" || !url || url.length > 500 || /\s/.test(url)) return undefined;
	let host: string;
	let path: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		let u: URL;
		try {
			u = new URL(url);
		} catch {
			return undefined;
		}
		if (u.protocol !== "https:" && u.protocol !== "ssh:") return undefined;
		if (u.search || u.hash) return undefined;
		host = u.hostname;
		try {
			path = decodeURIComponent(u.pathname);
		} catch {
			return undefined; // a malformed escape such as %zz
		}
	} else {
		// scp-like: [user@]host:path (no slash before the colon)
		const m = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(url);
		if (!m) return undefined;
		host = m[1] as string;
		path = m[2] as string;
	}
	host = host.toLowerCase();
	if (!host || !hosts.includes(host)) return undefined;
	const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
	if (parts.length !== 2) return undefined;
	const [owner, name0] = parts as [string, string];
	const name = name0.replace(/\.git$/i, "");
	const repo = `${owner}/${name}`.toLowerCase();
	if (!REPO_RE.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(name)) return undefined;
	return { host, repo };
}

/** A toplevel's basename as a folder-name slug: `[a-z0-9._-]{1,40}`, never starting with a dot or dash. */
export function repoSlug(toplevel: string): string {
	const slug = basename(toplevel)
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[.-]+/, "")
		.slice(0, 40)
		.replace(/[.-]+$/, "");
	return slug || "repo";
}

/** `<slug>-<sha256(toplevel)[0:8]>`: the (watcher, repo) state folder under `<stateRoot>/<id>/`. */
export function repoDirName(toplevel: string): string {
	return `${repoSlug(toplevel)}-${createHash("sha256").update(toplevel).digest("hex").slice(0, 8)}`;
}
