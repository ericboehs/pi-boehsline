/**
 * What a Cursor run changed, as a unified diff the phone can show.
 *
 * Tracked changes are against the run's base (a worktree's starting commit, or
 * a tree of the checkout as it was when an in-place run started, so dirt that
 * was already there is not the run's). Untracked files are included by staging
 * them into a throwaway index seeded from the real one (gitignore still
 * applies: that is the noise list). The whole repo counts, whatever subdir the
 * run started in. Binary, sensitive (.env, keys, .npmrc …) and large files are
 * one line naming them. Secrets are masked. The copy in tool details is
 * capped; the file on disk is the full masked diff.
 *
 * A snapshot that fails (a git error, a timeout) is no diff at all, never a
 * partial one that would credit the run with the wrong files.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type DiffStats, cursorStateDir, isSensitivePath, maskDiffSecrets, normalizeChunk, splitDiff, writeExclusive } from "../../../lib/cursor-diff.ts";

export { cursorStateDir };

export type { DiffStats };

/** Details string: cut here, on a file boundary. */
export const DETAILS_DIFF_BYTES = 256 * 1024;
/** Transcript entry: under lib/children.ts ENTRY_BYTES with the envelope. */
export const TRANSCRIPT_DIFF_BYTES = 24 * 1024;
/** Safety ceiling on what we read from git and write to disk. */
const MAX_COLLECT = 8 * 1024 * 1024;
/** An untracked file past this is not staged (not hashed into .git/objects); it is a `Large file` line. */
export const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
/** A changed file whose blob is past this is a `Large file` line, not a body. */
export const MAX_FILE_DIFF_BYTES = 1024 * 1024;
/** More large files than this and the snapshot gives up (the pathspec would not fit). */
const MAX_LARGE = 500;
const GIT_TIMEOUT_MS = 30_000;
/** Per git call once the run was stopped, so Stop stays fast. */
export const STOP_GIT_TIMEOUT_MS = 5_000;
/** Kept in the state dir: files newer than this, at most PRUNE_KEEP of them. */
export const PRUNE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const PRUNE_KEEP = 200;

const GIT_CFG = [
	"-c", "commit.gpgsign=false",
	"-c", "tag.gpgsign=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.pager=cat",
	"-c", "core.quotepath=off",
	"-c", "core.fsmonitor=false",
	"-c", "core.splitIndex=false",
	"-c", "diff.external=",
	"-c", "diff.noprefix=false",
	"-c", "diff.mnemonicPrefix=false",
	"-c", "diff.relative=false",
	"-c", "filter.lfs.required=false",
	"-c", "filter.lfs.process=",
	"-c", "filter.lfs.clean=",
	"-c", "filter.lfs.smudge=",
];

interface GitOut {
	code: number;
	stdout: string;
	truncated: boolean;
}

interface GitOpts {
	env?: Record<string, string>;
	ok?: number[];
	input?: string;
	timeoutMs?: number;
}

function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<GitOut> {
	const ok = opts.ok ?? [0];
	return new Promise((done, fail) => {
		const proc = spawn("git", ["-C", cwd, ...GIT_CFG, ...args], {
			stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
		});
		const out: Buffer[] = [];
		let bytes = 0;
		let truncated = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, opts.timeoutMs ?? GIT_TIMEOUT_MS);
		proc.stdout?.on("data", (b: Buffer) => {
			if (truncated) return;
			bytes += b.length;
			if (bytes > MAX_COLLECT) {
				truncated = true;
				proc.kill("SIGKILL");
				return;
			}
			out.push(b);
		});
		proc.on("error", (e) => {
			clearTimeout(timer);
			fail(e);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) fail(new Error(`git ${args[0] ?? ""} timed out`));
			else if (code !== null && ok.includes(code)) done({ code, stdout: Buffer.concat(out).toString("utf8"), truncated });
			else if (truncated) done({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), truncated: true });
			else fail(new Error(`git ${args[0] ?? ""} exited ${code}`));
		});
		if (proc.stdin) {
			proc.stdin.on("error", () => {});
			proc.stdin.end(opts.input);
		}
	});
}

/** The repo's top directory, or undefined when `dir` is not in a work tree. */
async function toplevel(dir: string, timeoutMs?: number): Promise<string | undefined> {
	try {
		return (await git(dir, ["rev-parse", "--show-toplevel"], { timeoutMs })).stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** `path` from the repo top, matched literally (no globs), excluded. */
const excludeSpec = (path: string) => `:(top,literal,exclude)${path}`;

/** An untracked file too big to stage, as it was: a later snapshot reports it only if it is new or changed. */
export interface LargeFile {
	path: string;
	size: number;
	mtimeMs: number;
}

export interface Snapshot {
	tree: string;
	/** Untracked files left out for size. */
	large: LargeFile[];
}

export interface SnapshotOpts {
	timeoutMs?: number;
	/**
	 * Stop path: start from this tree and only refresh what it already has
	 * (no untracked walk, no new files staged). Files the run created are missed;
	 * nothing it did not do is reported.
	 */
	trackedFrom?: string;
}

/**
 * The real index, copied, so `add` reuses its stat cache instead of hashing every file. Else HEAD's tree.
 * The copy keeps the real one's mtime: git re-reads an entry as racily clean only when the file is not
 * older than the index, and a fresh mtime would hide a same-size edit made in the same second.
 */
async function seedIndex(top: string, index: string, timeoutMs: number | undefined): Promise<void> {
	try {
		const real = resolve(top, (await git(top, ["rev-parse", "--git-path", "index"], { timeoutMs })).stdout.trim());
		const st = statSync(real);
		copyFileSync(real, index);
		utimesSync(index, st.atime, st.mtime);
		return;
	} catch {
		rmSync(index, { force: true });
	}
	await git(top, ["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: index }, timeoutMs });
}

function largeUntracked(top: string, listing: string): LargeFile[] | undefined {
	const large: LargeFile[] = [];
	for (const path of listing.split("\0")) {
		if (!path) continue;
		try {
			const st = lstatSync(join(top, path));
			if (st.isFile() && st.size > MAX_UNTRACKED_BYTES) large.push({ path, size: st.size, mtimeMs: st.mtimeMs });
		} catch {
			// Gone since the listing: nothing to stage.
		}
		if (large.length > MAX_LARGE) return undefined;
	}
	return large;
}

/**
 * A tree of the whole work tree as it is now (from its top, whatever subdir
 * `dir` is), including untracked files git does not ignore, except ones over
 * MAX_UNTRACKED_BYTES. Undefined when any step fails or times out.
 */
export async function snapshotTree(dir: string, opts: SnapshotOpts = {}): Promise<Snapshot | undefined> {
	const timeoutMs = opts.timeoutMs;
	const top = await toplevel(dir, timeoutMs);
	if (!top) return undefined;
	try {
		await git(top, ["rev-parse", "--verify", "-q", "HEAD"], { timeoutMs });
	} catch {
		return undefined;
	}
	const scratch = mkdtempSync(join(tmpdir(), "pi-cursor-index-"));
	const index = join(scratch, "index");
	const env = { GIT_INDEX_FILE: index };
	try {
		await seedIndex(top, index, timeoutMs);
		let large: LargeFile[] = [];
		if (opts.trackedFrom) {
			// One tree: entries whose content matches keep the seeded stat info, so only changed files are hashed.
			// -i: a scratch index, so dirt in the work tree is not a reason to refuse.
			await git(top, ["read-tree", "-m", "-i", opts.trackedFrom], { env, timeoutMs });
			await git(top, ["add", "-u", "--", ":/"], { env, timeoutMs });
		} else {
			const others = await git(top, ["ls-files", "-z", "--others", "--exclude-standard", "--", ":/"], { env, timeoutMs });
			if (others.truncated) return undefined;
			const found = largeUntracked(top, others.stdout);
			if (!found) return undefined;
			large = found;
			await git(top, ["add", "-A", "--", ":/", ...large.map((f) => excludeSpec(f.path))], { env, timeoutMs });
		}
		const tree = (await git(top, ["write-tree"], { env, timeoutMs })).stdout.trim();
		return tree ? { tree, large } : undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export interface Base {
	base: string;
	kind: "commit" | "tree";
	/** Untracked files too big for the base tree (in-place runs). */
	large?: LargeFile[];
}

/**
 * The run's base, recorded before cursor-agent starts. A worktree's starting
 * commit, or a tree of an in-place checkout (dirt included, so it is not later
 * reported as the run's).
 */
export async function captureBase(dir: string, worktree: boolean, worktreeBase?: string): Promise<Base | undefined> {
	try {
		if (worktree) {
			const ref = worktreeBase?.trim() || "HEAD";
			if (ref.startsWith("-") || /[\n\0]/.test(ref)) return undefined;
			const sha = (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
			return sha ? { base: sha, kind: "commit" } : undefined;
		}
		const snap = await snapshotTree(dir);
		if (!snap) return undefined;
		return { base: snap.tree, kind: "tree", ...(snap.large.length ? { large: snap.large } : {}) };
	} catch {
		return undefined;
	}
}

// ---- one file of the diff

/** A path as one safe line. Tokens in the path are masked, so a secret in a filename is not shown. */
const showPath = (p: string) => p.replace(/[\u0000-\u001f\u007f]/g, "?");

const oneLine = (path: string, what: "Binary" | "Sensitive" | "Large") => {
	const shown = maskDiffSecrets(showPath(path));
	return `diff --git a/${shown} b/${shown}\n${what} file ${shown} changed\n`;
};

function countHunk(chunk: string): { ins: number; del: number } {
	let ins = 0;
	let del = 0;
	for (const line of chunk.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Binary file ")) continue;
		if (line.startsWith("+")) ins++;
		else if (line.startsWith("-")) del++;
	}
	return { ins, del };
}

export interface Assembled {
	/** Every file, masked. */
	full: string;
	/** Capped for details.diff. */
	diff: string;
	diffStats: DiffStats;
	/** Capped again for one transcript entry. */
	transcriptDiff: string;
	transcriptStats: DiffStats;
}

/** The longest prefix of `s` that fits `maxBytes`, cut at a line boundary (or at `maxBytes`). */
function cutBytes(s: string, maxBytes: number): string {
	const buf = Buffer.from(s);
	if (buf.length <= maxBytes) return s;
	const head = buf.subarray(0, Math.max(0, maxBytes)).toString("utf8");
	const at = head.lastIndexOf("\n");
	return at > 0 ? head.slice(0, at + 1) : head;
}

/**
 * Whole files, in order, up to `maxBytes`; then a note saying how much was left out. A first
 * file too big for the cap is kept cut, so the phone still sees something.
 */
function capChunks(chunks: string[], maxBytes: number): { text: string; truncated: boolean; omittedBytes: number } {
	let used = 0;
	const kept: string[] = [];
	let cut = false;
	for (const chunk of chunks) {
		const n = Buffer.byteLength(chunk);
		if (used + n <= maxBytes) {
			kept.push(chunk);
			used += n;
			continue;
		}
		if (kept.length === 0) {
			const head = cutBytes(chunk, Math.max(0, maxBytes - 64));
			if (head) {
				kept.push(`${head}${head.endsWith("\n") ? "" : "\n"}… (file cut at ${Buffer.byteLength(head)} bytes)\n`);
				used = Buffer.byteLength(kept[0] ?? "");
				cut = true;
			}
		}
		break;
	}
	const rest = chunks.slice(kept.length);
	const omittedBytes = rest.reduce((sum, c) => sum + Buffer.byteLength(c), 0);
	let text = kept.join("");
	if (rest.length > 0) {
		const which = `${rest.length} more file${rest.length === 1 ? "" : "s"}`;
		text += `${text === "" || text.endsWith("\n") ? "" : "\n"}… ${which}, ${omittedBytes} more bytes\n`;
	}
	return { text, truncated: rest.length > 0 || cut, omittedBytes };
}

/** Mask, drop binary bodies, count, and cap. `rawTruncated` means git's output was cut. `large` are paths to name only. */
export function assembleDiff(
	raw: string,
	rawTruncated = false,
	detailsBytes = DETAILS_DIFF_BYTES,
	transcriptBytes = TRANSCRIPT_DIFF_BYTES,
	large: string[] = [],
): Assembled {
	const chunks = [
		...splitDiff(raw).map(normalizeChunk).filter(Boolean),
		...large.map((p) => oneLine(p, isSensitivePath(p) ? "Sensitive" : "Large")),
	];
	let insertions = 0;
	let deletions = 0;
	for (const chunk of chunks) {
		const n = countHunk(chunk);
		insertions += n.ins;
		deletions += n.del;
	}
	const full = chunks.join("");
	const details = capChunks(chunks, detailsBytes);
	const transcript = capChunks(chunks, transcriptBytes);
	const stats = (truncated: boolean): DiffStats => ({ files: chunks.length, insertions, deletions, truncated: truncated || rawTruncated });
	return {
		full,
		diff: details.text,
		diffStats: stats(details.truncated),
		transcriptDiff: transcript.text,
		transcriptStats: stats(transcript.truncated),
	};
}

export interface RunDiff extends Assembled {
	diffPath?: string;
}

function safeId(id: string): string {
	const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
	return cleaned || "run";
}

/** 0700 directory of ours, or undefined (a symlink, or not ours). */
function stateDirReady(dir: string): boolean {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const st = lstatSync(dir);
		const uid = process.getuid?.();
		if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) return false;
		if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
		return true;
	} catch {
		return false;
	}
}

/** Drop diffs (and stray temp files) older than PRUNE_AGE_MS, then all but the newest PRUNE_KEEP. */
export function pruneStateDir(dir: string, now = Date.now()): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	const files: { file: string; mtime: number }[] = [];
	for (const name of names) {
		if (!name.endsWith(".diff") && !name.endsWith(".tmp")) continue;
		const file = join(dir, name);
		try {
			const st = lstatSync(file);
			if (st.isFile()) files.push({ file, mtime: st.mtimeMs });
		} catch {
			// Gone already.
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	files.forEach(({ file, mtime }, i) => {
		if (i >= PRUNE_KEEP || now - mtime > PRUNE_AGE_MS) rmSync(file, { force: true });
	});
}

export function writeDiffFile(dir: string, id: string, body: string): string | undefined {
	if (!stateDirReady(dir)) return undefined;
	const file = join(dir, `${safeId(id)}.diff`);
	// O_EXCL|O_NOFOLLOW, random temp name: a planted symlink is not followed.
	writeExclusive(file, body);
	pruneStateDir(dir);
	return file;
}

export interface CaptureOpts {
	detailsBytes?: number;
	transcriptBytes?: number;
	stateDir?: string;
	/** The file's name starts with it; a random suffix keeps two runs apart. */
	runId?: string;
	env?: NodeJS.ProcessEnv;
	/** The base's untracked large files (Base.large): unchanged ones are not the run's. */
	baseLarge?: LargeFile[];
	/** The run was stopped: short git timeouts, no untracked walk (files the run created are missed). */
	stopped?: boolean;
}

/** Changed paths whose old or new blob is over MAX_FILE_DIFF_BYTES. */
async function largeChanged(top: string, base: string, end: string, timeoutMs: number | undefined): Promise<string[] | undefined> {
	const raw = await git(top, ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", base, end, "--"], { ok: [0, 1], timeoutMs });
	if (raw.truncated) return undefined;
	const parts = raw.stdout.split("\0");
	const entries: { path: string; shas: string[] }[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const meta = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) [A-Z]/.exec(parts[i] ?? "");
		const path = parts[i + 1];
		if (!meta || path === undefined) continue;
		entries.push({ path, shas: [meta[1] ?? "", meta[2] ?? ""].filter((s) => s && !/^0+$/.test(s)) });
	}
	const shas = [...new Set(entries.flatMap((e) => e.shas))];
	if (shas.length === 0) return [];
	const sizes = new Map<string, number>();
	const check = await git(top, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: `${shas.join("\n")}\n`, timeoutMs });
	for (const line of check.stdout.split("\n")) {
		const [sha, size] = line.split(" ");
		if (sha && size && /^\d+$/.test(size)) sizes.set(sha, Number(size));
	}
	const large = entries.filter((e) => e.shas.some((s) => (sizes.get(s) ?? 0) > MAX_FILE_DIFF_BYTES)).map((e) => e.path);
	return large.length > MAX_LARGE ? undefined : large;
}

const sameFile = (a: LargeFile, b: LargeFile) => a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * Diff `dir`'s repo against `base` (a commit, or a tree from snapshotTree)
 * plus a snapshot of its untracked files. Never throws. Undefined when a
 * snapshot or the diff failed; empty when nothing changed. The file is written
 * only when the diff is non-empty.
 */
export async function captureChanges(dir: string, base: string, opts: CaptureOpts = {}): Promise<RunDiff | undefined> {
	if (!base || !/^[0-9a-f]{4,64}$/i.test(base)) return undefined;
	const timeoutMs = opts.stopped ? STOP_GIT_TIMEOUT_MS : undefined;
	const top = await toplevel(dir, timeoutMs);
	if (!top) return undefined;
	const snap = await snapshotTree(top, { timeoutMs, ...(opts.stopped ? { trackedFrom: base } : {}) }).catch(() => undefined);
	if (!snap) return undefined;
	const baseLarge = opts.baseLarge ?? [];
	const newLarge = snap.large.filter((f) => !baseLarge.some((b) => sameFile(b, f))).map((f) => f.path);
	let raw = "";
	let rawTruncated = false;
	let large: string[];
	try {
		const changed = await largeChanged(top, base, snap.tree, timeoutMs);
		if (!changed) return undefined;
		const skip = [...new Set([...changed, ...snap.large.map((f) => f.path)])];
		large = [...new Set([...changed, ...newLarge])].sort();
		const got = await git(
			top,
			// -c and -M1% force rename detection down to 1% similarity, so a repo with
			// diff.renames=false, or a small .env renamed and edited, cannot show the body as an add.
			["-c", "diff.renames=true", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "-M1%", base, snap.tree, "--", ":/", ...skip.map(excludeSpec)],
			{ ok: [0, 1], timeoutMs },
		);
		raw = got.stdout;
		rawTruncated = got.truncated;
		if (rawTruncated) {
			// The last file may be cut mid-body; drop it so the cap stays on a boundary.
			const parts = splitDiff(raw);
			raw = parts.slice(0, -1).join("\n");
		}
	} catch {
		return undefined;
	}
	const assembled = assembleDiff(raw, rawTruncated, opts.detailsBytes, opts.transcriptBytes, large);
	const runId = `${safeId(opts.runId || "run").slice(0, 60)}-${randomBytes(4).toString("hex")}`;
	const diffPath = assembled.full.trim() ? writeDiffFile(opts.stateDir || cursorStateDir(opts.env), runId, assembled.full) : undefined;
	return { ...assembled, ...(diffPath ? { diffPath } : {}) };
}
