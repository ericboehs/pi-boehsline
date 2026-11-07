/**
 * Project scope: a repo's slug, `host/org/repo`, from the cwd's `origin` remote,
 * so every clone and worktree of a repo shares one scope. No origin, or a local
 * path remote, means no project scope.
 *
 * Pure node: no pi imports.
 */

import { spawnSync } from "node:child_process";
import { gitEnv, SAFE_CONFIG } from "./git.ts";

const SEGMENT = /^[a-z0-9_][a-z0-9._-]*$/;
const HOST = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/** `host/org/repo` (more path segments kept, lowercased, `.git` dropped), or null. */
export function slugFromRemote(url: string): string | null {
	const u = url.trim();
	if (!u || /\s/.test(u)) return null;
	let host: string;
	let path: string;
	if (u.includes("://")) {
		let parsed: URL;
		try {
			parsed = new URL(u);
		} catch {
			return null;
		}
		if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) return null;
		host = parsed.hostname;
		path = decodeURIComponent(parsed.pathname);
	} else {
		// scp-like: [user@]host:path
		const m = /^(?:[^@/:]+@)?([^@/:]+):(.+)$/.exec(u);
		if (!m) return null;
		host = m[1]!;
		path = m[2]!;
	}
	host = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (!HOST.test(host)) return null;
	const segments = path.toLowerCase().replace(/\.git\/?$/, "").split("/").filter(Boolean);
	if (segments.length < 2) return null;
	if (!segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) return null;
	return [host, ...segments].join("/");
}

/** The slug of the repo `cwd` is in, or null. */
export function slugFor(cwd: string): string | null {
	const r = spawnSync("git", [...SAFE_CONFIG, "-C", cwd, "remote", "get-url", "origin"], { env: gitEnv(), encoding: "utf8", timeout: 3000 });
	return r.status === 0 ? slugFromRemote(r.stdout) : null;
}
