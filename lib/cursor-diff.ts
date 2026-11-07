/**
 * The diff a finished Cursor run leaves for the phone (Botsun's Show work).
 *
 * The cursor tool's details and a background job's completion message carry the
 * capped diff. The runner also writes `<log>.details.json` beside the bg log so
 * the completion message and the child transcript can pick it up without the
 * diff going through the model-visible log tail. Files are 0600; the reader
 * opens with O_NOFOLLOW, re-masks, drops per-edit old/new bodies, and keeps
 * diffPath only when it is a regular 0600 file of ours inside the cursor state
 * dir (that dir not a symlink). Nothing is trusted because of where it sits.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { maskSecrets } from "../extensions/opt-in/op-broker/broker.ts";

/** Prefixes distinctive enough to mask on sight. */
const TOKEN = new RegExp(
	[
		String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
		String.raw`github_pat_[A-Za-z0-9_]{20,}`,
		String.raw`glpat-[A-Za-z0-9_-]{20,}`,
		String.raw`xox[abeoprs]-[A-Za-z0-9-]{10,}`,
		String.raw`xapp-[A-Za-z0-9-]{10,}`,
		String.raw`(?:AKIA|ASIA)[A-Z0-9]{16}`,
		String.raw`AIza[A-Za-z0-9_-]{30,}`,
		String.raw`ya29\.[A-Za-z0-9._-]{20,}`,
		String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
	]
		.map((p) => String.raw`\b${p}`)
		.join("|"),
	"g",
);
/** Prefixes that also start ordinary identifiers (pk_users_index, npm_config_cache): masked only with a digit in them, except letter-only sk-/pk- keys of 20+ characters. */
const WEAK_TOKEN = /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|\b(?:npm|hf)_[A-Za-z0-9]{20,}/g;
const PEM_HEAD = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_TAIL = /-----END [A-Z0-9 ]*PRIVATE KEY-----$/;
/** An unterminated block runs to the end. */
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** A key block's body masked, its line count kept (a diff's hunk counts still add up) and each line's diff marker. */
function maskPem(block: string): string {
	const head = PEM_HEAD.exec(block)?.[0] ?? "";
	const tail = PEM_TAIL.exec(block)?.[0] ?? "";
	const body = block.slice(head.length, block.length - tail.length);
	const lines = body.split("\n").map((l, i) => {
		if (i === 0) return l ? "•••" : "";
		if (/^[+\- ]?$/.test(l)) return l;
		return `${/^[+\- ]/.test(l) ? l[0] : ""}•••`;
	});
	return `${head}${lines.join("\n")}${tail}`;
}

/** Letter-only `sk-`/`pk-` keys (not `sk-learn`, and not underscore identifiers). */
function maskWeakToken(t: string): string {
	if (/\d/.test(t)) return "•••";
	if (t.length >= 20 && /^(?:sk|pk)-[A-Za-z-]+$/.test(t)) return "•••";
	return t;
}

/**
 * maskSecrets plus what a diff can carry that a command line rarely does: bare
 * tokens with a well-known prefix, credentials in a URL, and private key blocks.
 */
export function maskDiffSecrets(s: string): string {
	return maskSecrets(
		s
			.replace(PEM, maskPem)
			.replace(TOKEN, "•••")
			.replace(WEAK_TOKEN, maskWeakToken)
			.replace(URL_CREDS, "$1•••@"),
	);
}

/**
 * A path whose content is a credential more often than not (.env, keys, .npmrc,
 * .netrc, credentials*.json, keystores). Its change is one line naming it.
 * Backslashes and a trailing slash are normalized first, so `foo\.env\` counts.
 */
export function isSensitivePath(p: string): boolean {
	const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
	const name = (norm.split("/").pop() ?? "").toLowerCase();
	return (
		name.startsWith(".env") ||
		/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name) ||
		/^id_[a-z0-9_-]+$/.test(name) ||
		/^(?:\.npmrc|\.netrc|_netrc|\.pgpass|\.pypirc|\.git-credentials)$/.test(name) ||
		/^credentials.*\.json$/.test(name)
	);
}

export function cursorStateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CURSOR_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-cursor");
}

export interface DiffStats {
	files: number;
	insertions: number;
	deletions: number;
	truncated: boolean;
}

/** What a child transcript's `cursor_diff` entry and a tool result share. */
export interface CursorDiffInfo {
	diff: string;
	diffStats: DiffStats;
	/** Full masked diff on disk, when one was written. */
	diffPath?: string;
}

/** One edit step's content, when Cursor's event carried a patch or old/new text. */
export interface CursorEditArg {
	/** Index in the run's tool steps (0-based; a bg log line says `#<i + 1>`). */
	i: number;
	diff?: string;
	old?: string;
	new?: string;
}

/** Sidecar next to a background job's log (`<log>.details.json`). */
export interface JobDetails {
	diff: string;
	diffStats: DiffStats;
	diffPath?: string;
	/** Shorter than `diff`, so one transcript entry can hold it. */
	transcriptDiff?: string;
	transcriptStats?: DiffStats;
	edits?: CursorEditArg[];
}

export const detailsPath = (logPath: string) => `${logPath}.details.json`;

/** Reader refuses anything larger. Edit patches are dropped first so the diff still fits. */
export const MAX_SIDECAR = 1024 * 1024;

// ---- path headers (git diffs and ApplyPatch) --------------------------------

/** A git path as written in a header: C-quoted ("a/x\"y") when it has a quote, backslash or control character. */
function unquote(s: string): string {
	if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
	const body = s.slice(1, -1);
	const bytes: number[] = [];
	const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
	for (let i = 0; i < body.length; i++) {
		const c = body[i] ?? "";
		if (c !== "\\") {
			bytes.push(...Buffer.from(c));
			continue;
		}
		const next = body[i + 1] ?? "";
		const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
		if (oct) {
			bytes.push(Number.parseInt(oct[0], 8));
			i += 3;
		} else {
			bytes.push(ESC[next] ?? next.charCodeAt(0));
			i += 1;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

/**
 * A `---` / `+++` path: optional `a/` or `b/` prefix, tab-and-timestamp stripped,
 * `/dev/null` ignored. A noprefix header (`--- .env`) is the path itself.
 */
function headerPath(raw: string): string | undefined {
	const tab = raw.indexOf("\t");
	const p = unquote((tab >= 0 ? raw.slice(0, tab) : raw).trim());
	if (!p || p === "/dev/null") return undefined;
	if ((p.startsWith("a/") || p.startsWith("b/")) && p.length > 2) {
		const rest = p.slice(2);
		return rest && rest !== "/dev/null" ? rest : undefined;
	}
	return p;
}

/**
 * The paths a `diff --git` chunk is about, old and new. From `rename/copy
 * from/to` and `--- a/` / `+++ b/` lines first (one path each, so a space or
 * " b/" in a name can't split it), else the header when its halves agree.
 */
export function chunkPaths(chunk: string): { old?: string; new?: string } {
	const lines = chunk.split("\n");
	const out: { old?: string; new?: string } = {};
	for (const l of lines.slice(1)) {
		if (l.startsWith("@@") || l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) break;
		let m: RegExpExecArray | null;
		if ((m = /^(?:rename|copy) from (.+)$/.exec(l))) out.old = unquote(m[1] ?? "");
		else if ((m = /^(?:rename|copy) to (.+)$/.exec(l))) out.new = unquote(m[1] ?? "");
		else if (l.startsWith("--- ")) {
			const p = headerPath(l.slice(4));
			if (p) out.old ??= p;
		} else if (l.startsWith("+++ ")) {
			const p = headerPath(l.slice(4));
			if (p) out.new ??= p;
		}
	}
	if (out.old || out.new) return out;
	const rest = (lines[0] ?? "").replace(/^diff --git /, "");
	if (rest.startsWith('"')) {
		const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(rest);
		if (m) return { old: headerPath(m[1] ?? ""), new: headerPath(m[2] ?? "") };
	}
	const m = /^a\/(.*) ("(?:[^"\\]|\\.)*")$/.exec(rest);
	if (m) return { old: m[1], new: headerPath(m[2] ?? "") };
	// Unquoted and the same both sides (no rename here): "a/" + p + " b/" + p.
	const half = (rest.length - 5) / 2;
	if (Number.isInteger(half) && half > 0 && rest.startsWith("a/") && rest.slice(2, 2 + half) === rest.slice(half + 5)) {
		const p = rest.slice(2, 2 + half);
		return { old: p, new: p };
	}
	// noprefix, same path both sides: "diff --git .env .env" (no space in the name).
	const sp = rest.indexOf(" ");
	if (sp > 0 && !rest.includes('"') && rest.slice(0, sp) === rest.slice(sp + 1)) {
		const p = headerPath(rest.slice(0, sp));
		if (p) return { old: p, new: p };
	}
	return {};
}

function cleanHeaderPath(raw: string): string {
	const t = raw.trim();
	if (!t || t === "/dev/null") return "";
	return unquote(t);
}

/**
 * Every path a patch names: git rename/copy from/to, `---` / `+++` (with or
 * without an `a/` or `b/` prefix; `/dev/null` ignored), `diff --git` headers,
 * and ApplyPatch `*** Update|Add|Delete File:` / `*** Move to:`.
 */
export function pathsInText(text: string): string[] {
	const paths: string[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		let m: RegExpExecArray | null;
		if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) paths.push(unquote((m[1] ?? "").trim()));
		else if ((m = /^--- (.+)$/.exec(line))) {
			const p = headerPath(m[1] ?? "");
			if (p) paths.push(p);
		} else if ((m = /^\+\+\+ (.+)$/.exec(line))) {
			const p = headerPath(m[1] ?? "");
			if (p) paths.push(p);
		} else if ((m = /^\*\*\* (?:Update|Add|Delete) File:\s*(.*)$/.exec(line))) {
			const p = cleanHeaderPath(m[1] ?? "");
			if (p) paths.push(p);
		} else if ((m = /^\*\*\* Move to:\s*(.*)$/.exec(line))) {
			const p = cleanHeaderPath(m[1] ?? "");
			if (p) paths.push(p);
		} else if (line.startsWith("diff --git ")) {
			const got = chunkPaths(`${line}\n`);
			if (got.old) paths.push(got.old);
			if (got.new) paths.push(got.new);
		}
	}
	return paths;
}

/** One line naming a file whose body is omitted. Tokens in the path are masked. */
export function formatOmitted(path: string, what: "Binary" | "Sensitive" | "Large"): string {
	const shown = maskDiffSecrets(path.replace(/[\u0000-\u001f\u007f]/g, "?"));
	return `diff --git a/${shown} b/${shown}\n${what} file ${shown} changed\n`;
}

/** One `diff --git` file: sensitive and binary files reduced to a name, text secrets masked. */
export function normalizeChunk(chunk: string): string {
	const text = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
	if (!text.startsWith("diff --git ")) return "";
	const paths = chunkPaths(text);
	const path = paths.new ?? paths.old ?? "unknown";
	if ([paths.old, paths.new].some((p) => p !== undefined && isSensitivePath(p))) return formatOmitted(path, "Sensitive");
	if (/^Binary files /m.test(text) || /^GIT binary patch/m.test(text) || text.includes("\0")) return formatOmitted(path, "Binary");
	return maskDiffSecrets(text);
}

export function splitDiff(raw: string): string[] {
	return raw.split(/^(?=diff --git )/m).map((part) => part.trimEnd()).filter((part) => part.startsWith("diff --git "));
}

/**
 * Sensitive-file reduction (normalizeChunk) plus secret masking, for a diff that
 * may already have been capped. A trailing "N more files" note is kept. A patch
 * that is not a git diff is masked, or replaced with a one-liner when a header
 * names a sensitive path.
 */
export function reduceDiffText(raw: string): string {
	if (!raw) return raw;
	const noteMatch = raw.match(/\n… \d+ more files?, \d+ more bytes\n?$/);
	const note = noteMatch?.[0] ?? "";
	const body = note ? raw.slice(0, -note.length) : raw;
	const parts = splitDiff(body);
	if (parts.length === 0) {
		const paths = pathsInText(body);
		if (paths.some(isSensitivePath)) return formatOmitted(paths.find(isSensitivePath) ?? "unknown", "Sensitive") + note;
		return maskDiffSecrets(body) + note;
	}
	return parts.map(normalizeChunk).filter(Boolean).join("") + note;
}

/** A diff file the phone may open: at most this many bytes, then we reduce it. */
const MAX_DIFF_FILE = 8 * 1024 * 1024;

/**
 * A diffPath the phone may be told about. The state dir's final component must
 * not be a symlink (intermediate symlinks are fine: both sides are realpath'd).
 * The file's real directory must be that dir, and the file a regular 0600 file
 * with one link, owned by us (the dir 0700). Returns the real path, not the
 * path we were handed.
 */
export function acceptDiffPath(p: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!p || p.length > 4096 || p.includes("\0")) return undefined;
	try {
		const stateDir = cursorStateDir(env);
		const dirStat = lstatSync(stateDir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return undefined;
		const uid = process.getuid?.();
		if (uid !== undefined && dirStat.uid !== uid) return undefined;
		if ((dirStat.mode & 0o777) !== 0o700) return undefined;
		const realDir = realpathSync(stateDir);
		const realFile = realpathSync(p);
		if (dirname(realFile) !== realDir) return undefined;
		const st = lstatSync(realFile);
		if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return undefined;
		if (uid !== undefined && st.uid !== uid) return undefined;
		if ((st.mode & 0o777) !== 0o600) return undefined;
		return realFile;
	} catch {
		return undefined;
	}
}

/**
 * Open `realFile` without following a symlink and reduce its bytes before the
 * phone is told the path. False when it cannot be opened that way: omit it.
 */
function sealDiffFile(realFile: string): boolean {
	let fd: number | undefined;
	try {
		// O_NONBLOCK: a FIFO swapped in here must not block; fstat then rejects it.
		fd = openSync(realFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const st = fstatSync(fd);
		const uid = process.getuid?.();
		if (!st.isFile() || st.nlink !== 1 || st.size > MAX_DIFF_FILE) return false;
		if (uid !== undefined && st.uid !== uid) return false;
		if ((st.mode & 0o777) !== 0o600) return false;
		const raw = readFileSync(fd, "utf8");
		closeSync(fd);
		fd = undefined;
		const reduced = reduceDiffText(raw);
		if (reduced !== raw) writeExclusive(realFile, reduced);
		return true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function keptDiffPath(p: string | undefined, env?: NodeJS.ProcessEnv): string | undefined {
	const real = acceptDiffPath(p, env);
	if (!real || !sealDiffFile(real)) return undefined;
	return real;
}

/** A sidecar edit: old/new bodies are dropped; only a reduced diff is kept. */
export function trustEdit(e: CursorEditArg): CursorEditArg | undefined {
	if (typeof e.diff !== "string" || e.diff.length === 0) return undefined;
	const diff = reduceDiffText(e.diff);
	if (!diff) return undefined;
	return { i: e.i, diff };
}

/** Re-apply sensitive-file reduction and drop a diffPath that is not ours. The file's bytes are reduced before the path is kept. */
export function trustCursorDiff(info: CursorDiffInfo): CursorDiffInfo {
	const diff = reduceDiffText(info.diff);
	const diffPath = keptDiffPath(info.diffPath);
	const out: CursorDiffInfo = { diff, diffStats: info.diffStats };
	if (diffPath) out.diffPath = diffPath;
	return out;
}

/** Same reduction for a sidecar: diff, transcript copy, and each edit (diff only; old/new dropped). */
export function trustJobDetails(data: JobDetails): JobDetails {
	const diff = reduceDiffText(data.diff);
	const diffPath = keptDiffPath(data.diffPath);
	const edits = data.edits?.map(trustEdit).filter((e): e is CursorEditArg => e !== undefined);
	const out: JobDetails = { diff, diffStats: data.diffStats };
	if (diffPath) out.diffPath = diffPath;
	if (data.transcriptDiff !== undefined && data.transcriptStats) {
		out.transcriptDiff = reduceDiffText(data.transcriptDiff);
		out.transcriptStats = data.transcriptStats;
	}
	if (edits && edits.length > 0) out.edits = edits;
	return out;
}

// ---- which command is this package's runner ------------------------------------

/** This package's runner. A job's sidecar is read only when argv[1] realpaths here. */
export const cursorRunnerFile = fileURLToPath(new URL("../extensions/opt-in/cursor-agent/runner.ts", import.meta.url));

/**
 * Words the shell would run, or undefined when the command has operators or
 * expansions (so a lookalike argv[1] cannot hide extra work).
 */
export function shellArgv(command: string): string[] | undefined {
	const args: string[] = [];
	const n = command.length;
	let i = 0;
	const skipWs = () => {
		while (i < n && (command[i] === " " || command[i] === "\t")) i++;
	};
	skipWs();
	while (i < n) {
		let cur = "";
		let any = false;
		while (i < n) {
			const c = command[i] ?? "";
			if (c === " " || c === "\t") break;
			if (c === "\\") {
				if (i + 1 >= n) return undefined;
				cur += command[i + 1];
				i += 2;
				any = true;
				continue;
			}
			if (c === "'") {
				i++;
				any = true;
				while (i < n && command[i] !== "'") {
					cur += command[i];
					i++;
				}
				if (i >= n) return undefined;
				i++;
				continue;
			}
			if (c === '"') {
				i++;
				any = true;
				while (i < n && command[i] !== '"') {
					const d = command[i] ?? "";
					if (d === "\\" && i + 1 < n) {
						const next = command[i + 1] ?? "";
						if ("$`\"\\\n".includes(next)) {
							if (next !== "\n") cur += next;
							i += 2;
							continue;
						}
					}
					if (d === "$" || d === "`" || d === "\n") return undefined;
					cur += d;
					i++;
				}
				if (i >= n) return undefined;
				i++;
				continue;
			}
			if ("|&;<>()`$".includes(c) || c === "\n") return undefined;
			cur += c;
			i++;
			any = true;
		}
		if (!any) return undefined;
		args.push(cur);
		skipWs();
	}
	return args;
}

function isNodeBin(bin: string): boolean {
	const base = bin.replace(/\\/g, "/").split("/").pop() ?? "";
	return base === "node" || base === "node.exe" || base.startsWith("node");
}

/**
 * True when `command` is `node <this package's runner.ts> …`: parsed argv[1]
 * realpaths to runner.ts, and the shell would not also run something else.
 * A missing or lookalike path is false. Used at spawn and again at completion,
 * so a restored job is not trusted from a persisted flag.
 */
export function commandRunsCursorRunner(command: string | undefined): boolean {
	if (!command) return false;
	const argv = shellArgv(command);
	if (!argv || argv.length < 2 || !isNodeBin(argv[0] ?? "")) return false;
	try {
		return realpathSync(argv[1] ?? "") === realpathSync(cursorRunnerFile);
	} catch {
		return false;
	}
}

// ---- sidecar read / write ----------------------------------------------------

function fitSidecar(data: JobDetails): JobDetails {
	let edits = data.edits;
	const packed = (list: CursorEditArg[] | undefined): JobDetails => {
		const body: JobDetails = { ...data };
		if (list && list.length > 0) body.edits = list;
		else delete body.edits;
		return body;
	};
	let body = packed(edits);
	while (edits && edits.length > 0 && Buffer.byteLength(JSON.stringify(body)) > MAX_SIDECAR - 64) {
		edits = edits.slice(0, -1);
		body = packed(edits);
	}
	return body;
}

function isStats(v: unknown): v is DiffStats {
	if (!v || typeof v !== "object") return false;
	const s = v as Record<string, unknown>;
	return (
		typeof s.files === "number" && Number.isFinite(s.files) &&
		typeof s.insertions === "number" && Number.isFinite(s.insertions) &&
		typeof s.deletions === "number" && Number.isFinite(s.deletions) &&
		typeof s.truncated === "boolean"
	);
}

function editsOf(v: unknown): CursorEditArg[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: CursorEditArg[] = [];
	for (const raw of v.slice(0, 200)) {
		if (!raw || typeof raw !== "object") continue;
		const e = raw as Record<string, unknown>;
		if (typeof e.i !== "number" || !Number.isInteger(e.i) || e.i < 0) continue;
		const edit: CursorEditArg = { i: e.i };
		if (typeof e.diff === "string") edit.diff = e.diff;
		if (typeof e.old === "string") edit.old = e.old;
		if (typeof e.new === "string") edit.new = e.new;
		if (edit.diff || edit.old || edit.new) out.push(edit);
	}
	return out.length ? out : undefined;
}

/**
 * Read a job's diff sidecar. Undefined for a missing, linked, huge, or malformed
 * file. Opened O_NOFOLLOW (a symlink is not followed). Diff and edits are
 * reduced again (old/new bodies dropped), and diffPath is kept only when it
 * passes acceptDiffPath; its bytes are reduced before the path is returned.
 */
export function readJobDetails(logPath: string): JobDetails | undefined {
	const file = detailsPath(logPath);
	let fd: number | undefined;
	try {
		// O_NONBLOCK: a FIFO planted at the sidecar path must not freeze the session; fstat rejects it.
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const st = fstatSync(fd);
		if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_SIDECAR) return undefined;
		const data = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
		if (typeof data.diff !== "string" || !isStats(data.diffStats)) return undefined;
		const out: JobDetails = { diff: data.diff, diffStats: data.diffStats };
		if (typeof data.diffPath === "string" && data.diffPath.length > 0 && data.diffPath.length <= 4096) out.diffPath = data.diffPath;
		if (typeof data.transcriptDiff === "string" && isStats(data.transcriptStats)) {
			out.transcriptDiff = data.transcriptDiff;
			out.transcriptStats = data.transcriptStats;
		}
		const edits = editsOf(data.edits);
		if (edits) out.edits = edits;
		return trustJobDetails(out);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Write `body` to `file` (0600) without following a symlink. Only a random name
 * is opened O_EXCL|O_NOFOLLOW: a planted path is neither unlinked nor written.
 * The temp is removed only if the rename onto `file` fails (we created it).
 */
export function writeExclusive(file: string, body: string): void {
	const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	let fd: number;
	try {
		fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	} catch (err) {
		throw new Error(`could not create temp file for ${file}: ${(err as Error).message}`);
	}
	try {
		writeSync(fd, body);
		fchmodSync(fd, 0o600); // on the fd: a chmod by name after the rename could follow a swapped-in link
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, file);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// Already gone.
		}
		throw err;
	}
}

/** Write the sidecar (0600). A symlink at the path is replaced, not followed. */
export function writeJobDetails(logPath: string, data: JobDetails): void {
	const file = detailsPath(logPath);
	writeExclusive(file, JSON.stringify(fitSidecar(data)));
}
