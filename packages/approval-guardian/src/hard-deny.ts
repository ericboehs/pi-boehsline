/**
 * Hard deny: secret folders no tool call may read, and keychain dumps no command may run, decided
 * before (and instead of) the reviewer model. Nothing approves these; only the user's explicit
 * `/approval-guardian bypass` lets them through. Local Boehsline addition; see CHANGELOG.
 *
 * Path tools (read, grep, find, ls, write, edit, and any tool with a string `path`) are exact: the
 * path is resolved the way the guardian resolves every path (`~`, `@`, `file://`, relative to the
 * cwd) and checked both as written and with every symlink followed. Bash is best effort: every
 * shell word is checked for a deny root written out (`~/.ssh`, `$HOME/.ssh`, `/Users/me/.ssh`, a
 * glob or brace form that reaches one), resolved as a path against the cwd and any `cd` target
 * (symlinks followed, so a link made earlier still counts), and, in a word that reads as code (a
 * Python/Ruby/Node one-liner, a heredoc line), for a home-relative root (`'.ssh'`, `/.aws`). A
 * recursive reader (rg, grep -r, tar, zip, rsync, cp -r, find -exec, …) pointed at a folder that
 * holds a deny root is refused too. Programs that use a key without printing it may still name
 * one: `ssh -i`/`-F`/`-o IdentityFile=`, `scp`/`sftp` the same, `ssh-add <key>`, and
 * `kubectl`/`helm --kubeconfig`. `ssh host` and `git push` name nothing and run as before.
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Home-relative unless absolute. Configurable as `deny.paths` (global replaces, project adds). */
export const DEFAULT_DENY_PATHS: readonly string[] = [
	"~/.ssh",
	"~/.gnupg",
	"~/.aws",
	"~/.config/gh",
	"~/.config/op",
	// Botsun's host secrets (its 0600 files); the folder's other files (rings.json, budgets.json)
	// are settings Botsun work edits.
	"~/.config/botsun/host.env",
	"~/.config/botsun/ios-devices",
	"~/.netrc",
	"~/.docker/config.json",
	"~/.kube",
	"~/Library/Keychains",
	"~/Library/Cookies",
	"~/Library/Safari",
	"~/Library/Containers/com.apple.Safari",
	"~/Library/Application Support/Google/Chrome",
	"~/Library/Application Support/Firefox",
	"~/Library/Application Support/BraveSoftware",
	"~/Library/Application Support/Microsoft Edge",
	"~/Library/Application Support/Arc",
];

/**
 * Keychain dumps, refused outright whatever spells the program (`security`, `/usr/bin/security`, a
 * subprocess list): `dump-keychain` and `security export`. A single item's password
 * (`find-generic-password -w`) is a secret CLI instead (reviewed, below): the credentials skill
 * reads API keys that way. To refuse those too, add `KEYCHAIN_PASSWORD_RULE` to the global
 * `deny.commands`. `deny.commands` (global config only): case-sensitive regular expressions, tried
 * against the command with line continuations joined.
 */
export const KEYCHAIN_PASSWORD_RULE =
	"(?<![\\w-])find-(?:generic|internet)-password(?![\\w-])[^;&|\\n]*?(?:^|[\\s'\",\\[])-[a-z]*[wg][a-z]*(?=$|[\\s'\",\\])])";
export const DEFAULT_DENY_COMMANDS: readonly string[] = [
	"(?<![\\w-])dump-keychain(?![\\w-])",
	"(?<![\\w-])security\\s+(?:-\\S+\\s+)*export(?![\\w-])",
];

/**
 * Inside a deny folder, what isn't secret and normal work reads (ssh's config and host keys,
 * public keys, AWS's region file). Reads only: write and edit stay refused. `deny.allow` in the
 * global config replaces these (a trailing `*.ext` name glob works); a project can't add any.
 */
export const DEFAULT_DENY_ALLOW: readonly string[] = [
	"~/.ssh/config",
	"~/.ssh/config.d",
	"~/.ssh/known_hosts",
	"~/.ssh/known_hosts.old",
	"~/.ssh/authorized_keys",
	"~/.ssh/*.pub",
	"~/.aws/config",
];

export interface DenyConfig {
	paths: string[];
	commands: string[];
	/** Exceptions inside the deny folders, for reads (DEFAULT_DENY_ALLOW when absent). */
	allow?: string[];
	/**
	 * The guardian's own config files: never written or edited by a tool call (a reviewer-approved
	 * write could otherwise empty the deny list). Not configurable; loadGuardianConfig fills it.
	 */
	protect?: string[];
}

export const DEFAULT_DENY_CONFIG: DenyConfig = {
	paths: [...DEFAULT_DENY_PATHS],
	commands: [...DEFAULT_DENY_COMMANDS],
	allow: [...DEFAULT_DENY_ALLOW],
};

export interface DenyHit {
	/** What was refused, for the user and the model: a path or the command rule. */
	target: string;
	why: string;
}

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const fold = (s: string) => (CASE_INSENSITIVE ? s.normalize("NFC").toLowerCase() : s.normalize("NFC"));
// macOS: /System/Volumes/Data is a firmlink to /, which realpath leaves as it is.
const FIRMLINK = /^\/System\/Volumes\/Data(?=\/)/i;
const unfirm = (p: string) => (process.platform === "darwin" ? p.replace(FIRMLINK, "") : p);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Root {
	/** As configured, for messages. */
	label: string;
	/** Absolute forms: as written, and with symlinks followed when that differs. */
	absolute: string[];
	/** The home-relative form (`.ssh`, `Library/Keychains`), when the root is under home. */
	tail?: string;
	/** Precompiled: an absolute form written out in a word, at path boundaries. */
	mention: RegExp;
	/** Precompiled: the home-relative form as its own segment (in code). */
	tailRe?: RegExp;
	/** Write-protected only (the guardian's config): reads are fine. */
	writeOnly?: boolean;
	/** Global form of `mention`, to look at each occurrence. */
	mentionAll: RegExp;
	/** Allowed paths inside this root (absolute, folded; a last segment may be a glob). */
	except: string[];
}

function home(): string {
	return homedir();
}

function expandRoot(path: string): string {
	if (path === "~") return home();
	if (path.startsWith("~/")) return join(home(), path.slice(2));
	return resolve(home(), path);
}

const rootCache = new Map<string, Root[]>();

function rootsOf(config: DenyConfig): Root[] {
	const allow = [...new Set((config.allow ?? DEFAULT_DENY_ALLOW).flatMap((a) => {
		const lexical = expandRoot(a);
		const glob = /[*?[][^/]*$/.test(lexical);
		// A glob's folder is made canonical, its name pattern kept.
		const real = glob ? join(canonical(dirname(lexical)), basename(lexical)) : canonical(lexical);
		return [lexical, real].map((x) => fold(unfirm(x)));
	}))];
	const key = `${home()}\0${config.paths.join("\0")}\0\0${(config.protect ?? []).join("\0")}\0\0${allow.join("\0")}`;
	const cached = rootCache.get(key);
	if (cached) return cached;
	const make = (label: string, writeOnly: boolean): Root => {
		const lexical = expandRoot(label);
		const real = canonical(lexical);
		const rel = relative(home(), lexical);
		const tail = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
		const absolute = [...new Set([lexical, real].map(unfirm))];
		const alt = absolute.map((abs) => escapeRe(fold(abs))).join("|");
		return {
			label,
			absolute,
			tail,
			mention: new RegExp(`(?:^|[^A-Za-z0-9_.-])(?:${alt})(?=$|[^A-Za-z0-9_.-])`),
			mentionAll: new RegExp(`(?:^|[^A-Za-z0-9_.-])((?:${alt})(?=$|[^A-Za-z0-9_.-])[^\\s'"\`;|&<>()$,]*)(.?)`, "g"),
			except: writeOnly ? [] : allow.filter((a) => absolute.some((abs) => inside(a.replace(/\/[^/]*[*?[][^/]*$/, ""), abs))),
			tailRe: tail ? new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRe(fold(tail))}(?=$|[^A-Za-z0-9_.-])`) : undefined,
			writeOnly,
		};
	};
	const roots = [...config.paths.map((label) => make(label, false)), ...(config.protect ?? []).map((label) => make(label, true))];
	rootCache.set(key, roots);
	return roots;
}

/** Follow every symlink on the way, as far as the path exists (the rest is kept as written). */
export function canonical(path: string, depth = 0): string {
	if (depth > 40) return path;
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return canonical(resolve(dirname(path), readlinkSync(path)), depth + 1);
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		if (parent === path) return path;
		return join(canonical(parent, depth + 1), basename(path));
	}
}

function inside(path: string, root: string): boolean {
	const rel = relative(fold(unfirm(root)), fold(unfirm(path)));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** An allowed path (DEFAULT_DENY_ALLOW) inside a root: the entry itself or under it; a glob last segment matches names. */
function excepted(path: string, root: Root): boolean {
	const p = fold(unfirm(path));
	return root.except.some((e) => {
		if (/[*?[]/.test(e)) {
			try {
				return matchesGlob(p, e);
			} catch {
				return false;
			}
		}
		return inside(p, e);
	});
}

function rootHolding(path: string, roots: Root[], honorAllow = true): Root | undefined {
	path = unfirm(path);
	return roots.find((root) => root.absolute.some((abs) => inside(path, abs)) && !(honorAllow && excepted(path, root)));
}

/** A folder above a root (home, ~/Library, ~/.config): a recursive read there reaches the root. */
function holdsRoot(path: string, roots: Root[]): Root | undefined {
	path = unfirm(path);
	return roots.find((root) => !root.writeOnly && root.absolute.some((abs) => inside(abs, path) && fold(abs) !== fold(path)));
}

function normalizeToolPath(path: string): string {
	let p = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return home();
	if (p.startsWith("~/")) return join(home(), p.slice(2));
	if (/^file:\/\//.test(p)) {
		try {
			return fileURLToPath(p);
		} catch {
			return p;
		}
	}
	return p;
}

function pathHit(path: string, cwd: string, roots: Root[], honorAllow = true): Root | undefined {
	const lexical = resolve(normalizeToolPath(cwd), normalizeToolPath(path));
	return rootHolding(lexical, roots, honorAllow) ?? rootHolding(canonical(lexical), roots, honorAllow);
}

const MUTATING_TOOLS = new Set(["write", "edit"]);
// Keys a tool may carry a path in (pi's own use `path`; extension and MCP tools vary).
const PATH_KEYS = ["path", "file", "file_path", "filePath", "filename", "target", "dir", "directory", "cwd"];

function pathsOf(toolName: string, input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of PATH_KEYS) {
		const v = input[key];
		if (typeof v === "string" && v.trim()) out.push(v);
	}
	for (const key of ["paths", "files"]) {
		const v = input[key];
		if (Array.isArray(v)) for (const item of v) if (typeof item === "string" && item.trim()) out.push(item);
	}
	// grep, find and ls default to the cwd.
	if (!out.length && (toolName === "grep" || toolName === "find" || toolName === "ls")) out.push(".");
	return out;
}

/** Every name in a folder tree (at most 2000, symlinks not followed); the root's own name too. */
// Folders macOS guards (TCC): reading them may prompt or fail, so treat them as holding anything.
const OPAQUE = /\/Library\/(?:Safari|Cookies|Containers\/com\.apple\.Safari)(?:\/|$)/i;
const walkCache = new Map<string, { at: number; names: string[] | null }>();
function cachedWalk(kind: string, root: string, walk: () => string[]): string[] | null {
	if (OPAQUE.test(root)) return null;
	const key = `${kind}\0${root}`;
	const hit = walkCache.get(key);
	if (hit && Date.now() - hit.at < 5000) return hit.names;
	let names: string[] | null;
	try {
		readdirSync(root); // unreadable (permissions, TCC): unknown, not empty
		names = walk();
	} catch (error) {
		names = (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR" ? [] : null;
	}
	walkCache.set(key, { at: Date.now(), names });
	return names;
}

function namesUnder(root: string): string[] {
	const names = [basename(root)];
	const pending = [root];
	while (pending.length && names.length < 2000) {
		const dir = pending.pop()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			names.push(e.name);
			if (e.isDirectory()) pending.push(join(dir, e.name));
		}
	}
	return names;
}

/** A find pattern that may match something inside a root under the folder searched. */
function findReaches(searched: string, pattern: unknown, roots: Root[]): Root | undefined {
	const glob = typeof pattern === "string" && pattern.trim() ? pattern : "*";
	return roots.find((root) =>
		!root.writeOnly &&
		root.absolute.some((abs) => {
			if (!inside(abs, searched) || fold(abs) === fold(searched)) return false;
			const rel = relative(fold(unfirm(searched)), fold(unfirm(abs)));
			const g = fold(glob);
			if (g.includes(fold(basename(abs)))) return true;
			try {
				// fd --glob matches a file's name, or its path when the pattern has a slash.
				if (matchesGlob(`${rel}/x`, g) || matchesGlob(rel, g)) return true;
				// A name pattern matches anywhere below: try it on what the root holds.
				if (g.includes("/")) return false;
				// find lists names; a folder it can't read lists none.
				const names = cachedWalk("names", abs, () => namesUnder(abs));
				return names !== null && names.some((name) => matchesGlob(fold(name), g));
			} catch {
				return true;
			}
		}),
	);
}

/**
 * A tool call carrying paths: exact. grep (which reads contents, hidden files included) is refused
 * above a root too, and find there when its pattern may reach into one. write and edit may not
 * touch the guardian's own config.
 */
export function denyToolPath(toolName: string, input: Record<string, unknown>, cwd: string, config: DenyConfig): DenyHit | undefined {
	const all = rootsOf(config);
	const roots = MUTATING_TOOLS.has(toolName) ? all : all.filter((r) => !r.writeOnly);
	if (!roots.length) return;
	for (const path of pathsOf(toolName, input)) {
		const hit = pathHit(path, cwd, roots, !MUTATING_TOOLS.has(toolName));
		if (hit) return { target: hit.label, why: `${toolName} of ${path}` };
		const lexical = resolve(normalizeToolPath(cwd), normalizeToolPath(path));
		if (toolName === "grep") {
			const above = holdsRoot(lexical, roots) ?? holdsRoot(canonical(lexical), roots);
			if (above) return { target: above.label, why: `${toolName} of ${path} searches ${above.label}` };
		}
		if (toolName === "find") {
			const reach = findReaches(unfirm(lexical), input.pattern, roots) ?? findReaches(unfirm(canonical(lexical)), input.pattern, roots);
			if (reach) return { target: reach.label, why: `find in ${path} may list ${reach.label}` };
		}
	}
	return;
}

// ── bash ──────────────────────────────────────────────────────────────────────

interface Word {
	/** As the shell passes it on: quotes removed, unquoted `\x` → `x`. */
	value: string;
	/** True when any part was quoted or escaped. */
	quoted: boolean;
	/** True when an unquoted `*`, `?` or `[` is in it: the shell expands it. */
	glob: boolean;
	/** The word as written, single-quoted and escaped characters masked: where `$(…)` and backticks are live. */
	live: string;
	/** A redirection's target (`< file`, `2>/dev/null`) or its fd number: not an argument. */
	redirect?: boolean;
}

const MASK = "\u0001";

/** The closing backtick of the one at i, skipping `\x` pairs; -1 if there is none. */
function backtickClose(text: string, i: number): number {
	for (let j = i + 1; j < text.length; j++) {
		if (text[j] === "\\") j++;
		else if (text[j] === "`") return j;
	}
	return -1;
}
/** Simple commands that read stdin (piped or redirected): a reader there has no implicit cwd. */
const STDIN = new WeakSet<Word[]>();
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// Programs that take a heredoc as text (a file's contents, a commit message), never run it.
// Programs whose input may name a file (SQL's \\i, a manifest's hostPath): only a deny root written
// out in it counts, not a home-relative name.
const TEXT_RECEIVERS = new Set(["kubectl", "psql", "sqlite3", "mysql", "curl", "helm", "jq", "yq"]);
const DATA_RECEIVERS = new Set(["cat", "tee", "git", "gh", "pbcopy", "wc", "head", "tail", "less", "more", "mail", "glab", "slk", "base64"]);

/**
 * The command as simple commands of words: split at unquoted `;`, `|`, `&`, `(`, `)`, newlines.
 * Nothing is dropped but those and unquoted blanks, so every character the shell (or a heredoc
 * reader) may see is in some word. `$(…)` and backticks stay inside their word.
 */
export function simpleCommands(command: string): Word[][] {
	const out: Word[][] = [];
	let cmd: Word[] = [];
	let value = "";
	let quoted = false;
	let glob = false;
	let live = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	// What is open inside the word, kept raw until it closes: ")" for $( and ((, "}" for ${, "]" for $[.
	const raw: string[] = [];
	const rawBack: (string | undefined)[] = []; // the inner quote each level returns to when it closes
	const rawCmd: boolean[] = []; // whether each level is a command list ($( or a ( inside one), where # starts a comment
	let backtickOpen = false;
	const flush = () => {
		if (started) cmd.push({ value, quoted, glob, live, ...(redirNext || /^\d+$/.test(value) && nextIsRedir ? { redirect: true } : {}) });
		if (started) redirNext = false;
		value = "";
		live = "";
		quoted = false;
		glob = false;
		started = false;
	};
	let stdin = false; // this command reads a pipe or a `<` redirection
	let redirNext = false; // the next word is a redirection's target
	let nextIsRedir = false; // the word being closed is a redirection's fd number (`2` in `2>`)
	const end = (pipeNext = false) => {
		flush();
		if (cmd.length) {
			if (stdin) STDIN.add(cmd);
			out.push(cmd);
		}
		cmd = [];
		stdin = pipeNext;
	};
	let subQuote: string | undefined; // a quote inside $( … ), kept raw
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		const next = command[i + 1] ?? "";
		if (raw.length && quote !== "'") {
			// Inside $( … ), ${ … }, $[ … ] or (( … )): raw text, its own quotes (a # is never a
			// comment here), until the matching closer. Escapes, $'…' and backticks are skipped whole
			// so their brackets don't count; only $( ${ $[ open a level (and a bare ( inside $( or (( ).
			let take = c;
			if (!subQuote && c === "#" && rawCmd[raw.length - 1] && /[\s;|&()]/.test(command[i - 1] ?? " ")) {
				// A comment inside $( … ): to the end of the line, its backticks and quotes included.
				let j = i;
				while (j + 1 < command.length && command[j + 1] !== "\n") j++;
				take = command.slice(i, j + 1);
			} else if (subQuote === '"' && c === "$" && (next === "(" || next === "{" || next === "[")) {
				// An expansion inside a quote inside the region: its own level, back in the quote after.
				raw.push(next === "(" ? ")" : next === "{" ? "}" : "]");
				rawBack[raw.length - 1] = '"';
				rawCmd[raw.length - 1] = next === "(" && command[i + 2] !== "(";
				subQuote = undefined;
				take = c + next;
			} else if (subQuote === '"' && c === "`") {
				const close = backtickClose(command, i);
				if (close < 0) backtickOpen = true;
				take = close < 0 ? command.slice(i) : command.slice(i, close + 1);
			} else if (subQuote) {
				if (c === subQuote) subQuote = undefined;
				else if (c === "\\" && (subQuote === '"' || subQuote === "$'")) take = c + next;
			} else if (c === "\\") take = c + next;
			else if (c === "$" && next === "'") {
				subQuote = "$'";
				take = "$'";
			} else if (c === "'" || c === '"') subQuote = c;
			else if (c === "`") {
				const close = backtickClose(command, i);
				if (close < 0) backtickOpen = true;
				take = close < 0 ? command.slice(i) : command.slice(i, close + 1);
			} else if (c === "$" && (next === "(" || next === "{" || next === "[")) {
				raw.push(next === "(" ? ")" : next === "{" ? "}" : "]");
				rawBack[raw.length - 1] = undefined;
				rawCmd[raw.length - 1] = next === "(" && command[i + 2] !== "(";
				take = c + next;
			} else if (c === "(" && raw.at(-1) === ")") {
				raw.push(")");
				rawBack[raw.length - 1] = undefined;
				rawCmd[raw.length - 1] = rawCmd[raw.length - 2] === true;
			} else if (c === raw.at(-1)) {
				raw.pop();
				subQuote = rawBack[raw.length];
				rawBack.length = raw.length;
				rawCmd.length = raw.length;
			}
			value += take;
			live += take;
			i += take.length - 1;
			continue;
		}
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else {
				value += c;
				live += MASK;
			}
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = undefined;
			else if (c === "\\" && /["$`\\\n]/.test(next)) {
				value += next;
				live += MASK;
				i++;
			} else if (c === "`") {
				// A backtick inside "…": whole, with \" unescaped as bash does there (the rest of its
				// unescaping happens where its body is scanned).
				const close = backtickClose(command, i);
				if (close < 0) backtickOpen = true;
				const body = (close < 0 ? command.slice(i) : command.slice(i, close + 1)).replace(/\\"/g, '"');
				value += body;
				live += body;
				i = close < 0 ? command.length : close;
			} else if (c === "$" && (next === "(" || next === "{" || next === "[")) {
				// An expansion inside "…": raw until it closes (its own quotes nest), then back in the quotes.
				raw.push(next === "(" ? ")" : next === "{" ? "}" : "]");
				rawCmd[raw.length - 1] = next === "(" && command[i + 2] !== "(";
				value += c + next;
				live += c + next;
				i++;
			} else {
				value += c;
				live += c;
			}
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			quoted = true;
			started = true;
			continue;
		}
		if (c === "#" && !started) {
			// A comment, to the end of the line: nothing in it (a trailing \ included) is a word.
			while (i + 1 < command.length && command[i + 1] !== "\n") i++;
			continue;
		}
		if (c === "\\") {
			if (next === "\n") {
				i++;
				continue;
			}
			value += next;
			live += MASK;
			quoted = true;
			started = true;
			i++;
			continue;
		}
		if (c === "$" && next === "'") {
			// ANSI-C quoting: $'…' with its escapes decoded (\x68 is h).
			let j = i + 2;
			let text = "";
			for (; j < command.length && command[j] !== "'"; j++) {
				if (command[j] !== "\\") {
					text += command[j];
					continue;
				}
				const e = command[++j] ?? "";
				const hex = /^x([0-9A-Fa-f]{1,2})/.exec(command.slice(j));
				const uni = /^[uU]([0-9A-Fa-f]{1,8})/.exec(command.slice(j));
				const oct = /^[0-7]{1,3}/.exec(command.slice(j));
				if (hex) {
					text += String.fromCharCode(parseInt(hex[1]!, 16));
					j += hex[0].length - 1;
				} else if (uni) {
					text += String.fromCodePoint(Math.min(parseInt(uni[1]!, 16), 0x10ffff));
					j += uni[0].length - 1;
				} else if (oct) {
					text += String.fromCharCode(parseInt(oct[0], 8));
					j += oct[0].length - 1;
				} else text += ({ n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" } as Record<string, string>)[e] ?? e;
			}
			value += text;
			live += MASK.repeat(text.length);
			quoted = true;
			started = true;
			i = j;
			continue;
		}
		if (c === "$" && (next === "(" || next === "{" || next === "[")) {
			raw.push(next === "(" ? ")" : next === "{" ? "}" : "]");
			rawCmd[raw.length - 1] = next === "(" && command[i + 2] !== "(";
			value += c + next;
			live += c + next;
			started = true;
			i++;
			continue;
		}
		if (c === "(" && next === "(" && !started && arithmeticCloses(command, i)) {
			// (( … )): arithmetic, one word to the matching )) (two nested subshells otherwise)
			raw.push(")", ")");
			rawCmd[raw.length - 2] = false;
			rawCmd[raw.length - 1] = false;
			value += "((";
			live += "((";
			started = true;
			i++;
			continue;
		}
		if (c === "`" && !raw.length) {
			// A backtick substitution stays in its word, as `$(…)` does.
			const close = backtickClose(command, i);
			if (close < 0) backtickOpen = true;
			const inner = close < 0 ? command.slice(i) : command.slice(i, close + 1);
			value += inner;
			live += inner;
			started = true;
			i = close < 0 ? command.length : close;
			continue;
		}

		if (/[ \t]/.test(c)) {
			flush();
			continue;
		}
		if (/[;|&()\n<>]/.test(c)) {
			if (c === "<" || c === ">") {
				// Only stdin: a bare `<` or `0<`, not `3<` (and not `<<`, a heredoc).
				const fd = /(\d+)$/.exec(value)?.[1];
				if (c === "<" && next !== "<" && command[i - 1] !== "<" && (fd === undefined || fd === "0")) stdin = true;
				nextIsRedir = true;
				flush(); // a redirection's target is the next word, same command
				nextIsRedir = false;
				redirNext = true;
				if (next === "&") i++; // `2>&1`: a duplication, not a background `&`
				continue;
			}
			// `a | b`: b reads a's output (`||` is not a pipe, `|&` is).
			const pipe = c === "|" && next !== "|" && command[i - 1] !== "|";
			end(pipe);
			continue;
		}
		if (c === "*" || c === "?" || c === "[") glob = true;
		value += c;
		live += c;
		started = true;
	}
	end();
	// Something left open at the end: we can't tell where it ends, so the caller fails closed.
	if (raw.length || quote || subQuote || backtickOpen) UNBALANCED.add(out);
	return out;
}

/** simpleCommands results that ended with a quote or an expansion still open. */
export const UNBALANCED = new WeakSet<Word[][]>();

/** Whether the (( at i closes as a pair, `))`, as arithmetic does; otherwise it is two subshells. */
function arithmeticCloses(command: string, i: number): boolean {
	let depth = 0;
	let q: string | undefined;
	for (let j = i; j < command.length; j++) {
		const c = command[j]!;
		if (q) {
			if (c === "\\" && q !== "'") j++;
			else if (c === q) q = undefined;
			continue;
		}
		if (c === "\\") j++;
		else if (c === "'" || c === '"' || c === "`") q = c;
		else if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 1) return command[j + 1] === ")"; // the inner level closed: is the outer right after?
			if (depth <= 0) return false;
		}
	}
	return false;
}

/**
 * Heredoc bodies taken out of a command: the shell never reads them as words, so they are never
 * resolved as paths or globs. A body fed to `cat`/`tee` with nothing piped on is data (a file
 * being written); any other receiver (an interpreter, a shell, a pipe) runs it as code.
 */
type Body = { id: number; text: string; code: boolean; shell: boolean; paths?: boolean; mentions?: boolean; live?: boolean; prose?: boolean };
let bodySeq = 0;

interface HeredocStart {
	index: number;
	/** Just past the tag. */
	end: number;
	dash: boolean;
	quoted: boolean;
	tag: string;
}

/**
 * The real `<<TAG` operators in a line: outside quotes (a quote may carry over from an earlier
 * line), not escaped, not in a comment, and not `<<<` (a here-string).
 */
function heredocStarts(line: string, state: { q?: string; stack?: string[]; restore?: (string | undefined)[]; comment?: boolean }): HeredocStart[] {
	const out: HeredocStart[] = [];
	state.comment = false; // set when this line ends in a comment
	let closedSubshell = -2; // where the last plain subshell's ) was
	// What is open, innermost last: ")" for $( and (, "`", "}" for ${, "]" for $[, "A" for $(( / ((.
	// restore[k] is the quote to return to when stack[k] closes (an expansion opened inside "…").
	const stack = (state.stack ??= []);
	const restore = (state.restore ??= []);
	const push = (closer: string, back?: string) => {
		stack.push(closer);
		restore.push(back);
	};
	const pop = () => {
		stack.pop();
		const back = restore.pop();
		if (back !== undefined) state.q = back;
	};
	// `<<` inside ${…}, $[…] or arithmetic is text or a shift, never a heredoc.
	const wordContext = () => stack.some((x) => x === "}" || x === "]" || x === "A" || x === "P");
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		const next = line[i + 1];
		if (state.q === "$'") {
			// ANSI-C quoting: a backslash escapes the next character, \' included.
			if (c === "\\") i++;
			else if (c === "'") state.q = undefined;
			continue;
		}
		if (state.q === "'") {
			if (c === "'") state.q = undefined;
			continue;
		}
		if (state.q === '"') {
			if (c === "\\") i++;
			else if (c === '"') state.q = undefined;
			else if (c === "$" && next === "(" && line[i + 2] === "(") {
				// An expansion inside "…": lexed unquoted until it closes, then back in the quotes.
				state.q = undefined;
				push("A", '"');
				i += 2;
			} else if (c === "$" && (next === "(" || next === "{" || next === "[")) {
				state.q = undefined;
				push(next === "(" ? ")" : next === "{" ? "}" : "]", '"');
				i++;
			} else if (c === "`") {
				state.q = undefined;
				push("`", '"');
			}
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "$" && next === "'") {
			state.q = "$'";
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			state.q = c;
			continue;
		}
		if (c === "$" && next === "(" && line[i + 2] === "(") {
			push("A");
			i += 2;
			continue;
		}
		if (c === "(" && next === "(" && line[i - 1] !== "$") {
			push("P"); // an arithmetic command: a # right after its )) starts a comment
			i++;
			continue;
		}
		if (c === "$" && (next === "(" || next === "{" || next === "[")) {
			push(next === "(" ? ")" : next === "{" ? "}" : "]");
			i++;
			continue;
		}
		if (c === "(") {
			push("S"); // a plain subshell or group: a # right after its ) starts a comment
			continue;
		}
		if (c === "`") {
			if (stack.at(-1) === "`") pop();
			else push("`");
			continue;
		}
		if (c === ")") {
			const top = stack.at(-1);
			if ((top === "A" || top === "P") && next === ")") {
				pop();
				i++;
				if (top === "P") closedSubshell = i;
			} else if (top === "S") {
				pop();
				closedSubshell = i;
			} else if (top === ")") pop();
			else if (top === undefined || top === "`") closedSubshell = i; // a case pattern's )
			continue;
		}
		if ((c === "{" && stack.at(-1) === "}") || (c === "[" && stack.at(-1) === "]")) {
			push(c === "{" ? "}" : "]");
			continue;
		}
		if ((c === "}" || c === "]") && stack.at(-1) === c) {
			pop();
			continue;
		}
		if (c === "#" && !wordContext() && (i === 0 || /[\s;&|(<>]/.test(line[i - 1]!) || closedSubshell === i - 1)) {
			state.comment = true; // a comment: a trailing \ in it continues nothing
			break;
		}
		if (c !== "<" || next !== "<") continue;
		if (line[i + 2] === "<") {
			i += 2; // a here-string; its operand is an ordinary word
			continue;
		}
		if (wordContext()) {
			i++;
			continue;
		}
		let j = i + 2;
		const dash = line[j] === "-";
		if (dash) j++;
		while (line[j] === " " || line[j] === "\t") j++;
		let tag = "";
		let quoted = false;
		const open = line[j];
		if (open === "'" || open === '"') {
			const close = line.indexOf(open, j + 1);
			if (close < 0) continue;
			tag = line.slice(j + 1, close);
			quoted = true;
			j = close + 1;
		} else {
			if (open === "\\") {
				quoted = true;
				j++;
			}
			const m = /^[A-Za-z_][\w.-]*/.exec(line.slice(j));
			if (!m) continue;
			tag = m[0];
			j += tag.length;
		}
		if (!tag) continue;
		// Already split (a nested scan sees the outer scan's marker): its body is gone.
		if (line.startsWith("\u0002", j)) {
			i = j - 1;
			continue;
		}
		out.push({ index: i, end: j, dash, quoted, tag });
		i = j - 1;
	}
	return out;
}

/**
 * Whether a quote, a backtick, or an expansion the shell reads to its close (`$(`, `<(`, `>(`,
 * `${`, `$[`) is still open at the end of the text.
 */
function openAtEnd(text: string): boolean {
	let q: string | undefined;
	const close: string[] = []; // the closers expected, innermost last
	const restore: (string | undefined)[] = []; // the quote to return to when each closes
	let tick = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		const next = text[i + 1];
		if (q === "$'") {
			if (c === "\\") i++;
			else if (c === "'") q = undefined;
			continue;
		}
		if (q === "'") {
			if (c === "'") q = undefined;
			continue;
		}
		if (q === '"') {
			if (c === "\\") i++;
			else if (c === '"') q = undefined;
			else if (c === "$" && (next === "(" || next === "{" || next === "[")) {
				// An expansion inside double quotes: lexed unquoted until it closes, then back in quotes.
				close.push(next === "(" ? ")" : next === "{" ? "}" : "]");
				restore[close.length - 1] = '"';
				q = undefined;
				i++;
			} else if (c === "`") tick = !tick;
			continue;
		}
		if (c === "\\") i++;
		else if (c === "$" && next === "'") {
			q = "$'";
			i++;
		} else if (c === "'" || c === '"') q = c;
		else if ((c === "$" || c === "<" || c === ">") && next === "(") {
			close.push(")");
			i++;
		} else if (c === "$" && next === "{") {
			close.push("}");
			i++;
		} else if (c === "$" && next === "[") {
			close.push("]");
			i++;
		} else if (close.length && (c === "(" || c === "{" || c === "[")) close.push(c === "(" ? ")" : c === "{" ? "}" : "]");
		else if (close.length && c === close.at(-1)) {
			close.pop();
			q = restore[close.length];
			restore.length = close.length;
		}
		else if (c === "`") tick = !tick;
		else if (c === "#" && !close.length && (i === 0 || /[\s;&|(]/.test(text[i - 1]!))) break;
	}
	return q !== undefined || close.length > 0 || tick;
}

/** The text after the last still-open `(`, `$(` or backtick: the command a heredoc there belongs to. */
function innermost(text: string): string {
	const open: number[] = [];
	const back: (string | undefined)[] = []; // the quote each open one returns to
	let q: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (q === '"' && ((c === "$" && text[i + 1] === "(") || c === "`")) {
			// A substitution inside "…": its command is what a heredoc there belongs to.
			if (c === "$") i++;
			open.push(i);
			back.push('"');
			q = undefined;
			continue;
		}
		if (q) {
			if (c === q) q = undefined;
			else if (c === "\\" && q === '"') i++;
			continue;
		}
		if (c === "\\") i++;
		else if (c === "$" && text[i + 1] === "'") {
			// $'…': skip to its unescaped closing quote.
			let j = i + 2;
			while (j < text.length && text[j] !== "'") j += text[j] === "\\" ? 2 : 1;
			i = j;
		} else if (c === "'" || c === '"') q = c;
		else if (c === "(") {
			open.push(i);
			back.push(undefined);
		} else if (c === ")" || (c === "`" && open.length && text[open.at(-1)!] === "`")) {
			open.pop();
			const b = back.pop();
			if (b !== undefined) q = b;
		} else if (c === "`") {
			open.push(i);
			back.push(undefined);
		}
	}
	return open.length ? text.slice(open.at(-1)! + 1) : text;
}

/** The quote state after lexing a line, without touching the caller's state. */
function lexEnd(line: string, state: { q?: string; stack?: string[]; restore?: (string | undefined)[] }): { q?: string; comment?: boolean } {
	const copy: { q?: string; stack?: string[]; restore?: (string | undefined)[]; comment?: boolean } = { q: state.q, stack: [...(state.stack ?? [])], restore: [...(state.restore ?? [])] };
	heredocStarts(line, copy);
	return { q: copy.q, comment: copy.comment };
}

export function splitHeredocs(command: string): { rest: string; bodies: Body[] } {
	const lines = command.split("\n");
	const rest: string[] = [];
	const bodies: Body[] = [];
	const state: { q?: string; stack?: string[]; restore?: (string | undefined)[] } = {};
	// A command line ending in an odd run of backslashes (outside single quotes) continues on the
	// next: one logical line, as the shell reads it. Body lines are never joined here.
	const continues = (l: string, st: { q?: string; comment?: boolean }) => !st.comment && st.q !== "'" && st.q !== "$'" && /(?:^|[^\\])(?:\\\\)*\\\r?$/.test(l);
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i]!;
		while (i + 1 < lines.length && continues(line, { ...state, ...lexEnd(line, state) })) line = line.replace(/\\\r?$/, "") + lines[++i]!;
		// Anything carried in from earlier lines (an open quote or expansion) makes this line unsure.
		const enteredOpen = !!state.q || !!state.stack?.length;
		let starts = heredocStarts(line, state);
		// A quote or substitution still open after the tag: the shell reads the body only after it
		// closes, lines later. Don't split here (those lines stay commands, checked as such).
		if (starts.length && (state.q || openAtEnd(line.slice(starts.at(-1)!.end)))) starts = [];
		const ids = starts.map(() => ++bodySeq);
		// Each heredoc's tag gets a marker, so the command it belongs to (and the folder that
		// command runs in, even inside a nested scan) is known: \u0002<id>\u0002 right after the tag.
		let marked = line;
		for (let k = starts.length - 1; k >= 0; k--) {
			const endAt = starts[k]!.end;
			marked = `${marked.slice(0, endAt)}\u0002${ids[k]}\u0002${marked.slice(endAt)}`;
		}
		rest.push(marked);
		for (const [k, m] of starts.entries()) {
			const tag = m.tag;
			const strip = m.dash;
			const body: string[] = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				// An unquoted body joins `\⏎` (bash does); a quoted one is raw, so `x \` then the tag
				// still ends it.
				let raw = lines[j]!;
				while (!m.quoted && j + 1 < lines.length && /(?:^|[^\\])(?:\\\\)*\\$/.test(raw)) {
					body.push(lines[j]!);
					raw = raw.slice(0, -1) + lines[++j]!;
				}
				const l = strip ? raw.replace(/^\t+/, "") : raw;
				if (l === tag) break;
				body.push(lines[j]!);
			}
			const before = innermost(line.slice(0, m.index)).trim();
			const mEnd = m.end;
			const last = simpleCommands(before).at(-1) ?? [];
			const at = programIndex(last);
			const receiver = at >= 0 ? basename(last[at]!.value) : "";
			const after = line.slice(mEnd);
			// Code when a program runs it (an interpreter, a shell, ssh's remote shell, xargs) or it is
			// piped on; anything else (cat, tee, git commit -F -, gh --body-file -) takes it as data.
			// xargs makes the body arguments; git --stdin-paths reads the files it names.
			const viaXargs = last.slice(0, Math.max(at, 0)).some((w) => basename(w.value) === "xargs");
			const readsPathsDirect = viaXargs || (receiver === "git" && last.some((w) => /^--stdin-paths$|^--stdin$/.test(w.value)));
			// Piped on (every stage of the pipeline, and a trailing `|` continues on the line after
			// the closing tag): code unless every stage only takes text (pbcopy, tee).
			let pipeline = after;
			// (readsPaths is settled below, once the stages are known.)
			if (/\|\s*$/.test(after)) pipeline += ` ${lines[j + 1] ?? ""}`;
			let stageXargs = false;
			let stageSources = false;
			const stages = pipeline.split(/\|(?!\|)/).slice(1).map((seg) => {
				const words = simpleCommands(seg)[0] ?? [];
				const k = programIndex(words);
				if (k > 0 && words.slice(0, k).some((w) => basename(w.value) === "xargs")) stageXargs = true;
				const prog = k >= 0 ? basename(words[k]!.value) : "";
				if ((prog === "." || prog === "source") && words.slice(k + 1).some((w) => w.value === "/dev/stdin" || w.value === "-")) stageSources = true;
				return stageXargs ? "xargs" : prog;
			}).filter(Boolean);
			const readsPaths = readsPathsDirect || stageXargs;
			const pipedCode = stages.some((st) => !DATA_RECEIVERS.has(st));
			const code = readsPaths || !(DATA_RECEIVERS.has(receiver) || TEXT_RECEIVERS.has(receiver)) || pipedCode;
			const text = !code && TEXT_RECEIVERS.has(receiver);
			// A shell runs it (its `$(…)` and backticks are live): sh/bash/…, `. /dev/stdin`, or piped into one.
			const sourcesStdin = (receiver === "." || receiver === "source") && last.slice(at + 1).some((w) => w.value === "/dev/stdin" || w.value === "-");
			const shell = SHELLS.has(receiver) || sourcesStdin || stageSources || stages.some((st) => SHELLS.has(st)) || (receiver === "ssh" && /\bbash\s+-s\b|\bsh\b/.test(before));
			// An unquoted tag: the shell runs the body's `$(…)` and backticks, whoever reads it.
			const live = !m.quoted;
			// Fail closed on lines this lexer can't be sure of: a heredoc on a line with an expansion
			// (`$(`, backtick, `${`, `$[`, `((`, `$'`) or a `case` is scanned as shell, data or not.
			// The one shape agents write all the time stays data: `…"$(cat <<'EOF'` alone on its line,
			// closed by a line starting with `)`.
			const rawBefore = line.slice(0, m.index);
			const unsure =
				enteredOpen ||
				/\$\(|`|\$\{|\$\[|\(\(|\$'/.test(rawBefore) ||
				lines.slice(0, i + 1).some((l) => /(?:^|[\s;&|(`])case(?:\s|$)/.test(l));
			const commitShape =
				new RegExp(`^[^$\`]*?"?\\$\\(\\s*(?:cat|tee)\\s+<<-?\\s*(['"]?)${escapeRe(tag)}\\1\\s*$`).test(line.replace(/\u0002\d+\u0002/g, "")) &&
				/^\s*\)/.test(lines[j + 1] ?? "");
			const failClosed = unsure && !(commitShape && !enteredOpen);
			bodies.push({ id: ids[k]!, text: body.join("\n"), code: code || sourcesStdin || failClosed, shell: shell || failClosed, paths: readsPaths, mentions: text && !failClosed, live, prose: failClosed && !shell });
			i = j; // the closing tag line is dropped too
		}
	}
	return { rest: rest.join("\n"), bodies };
}

const USER = (() => {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? "";
	}
})();

/** `~`, `~me`, `$HOME`, `${HOME}`, `$USER`/`$LOGNAME` written out, wherever they appear in a word. */
function expandWord(value: string, vars?: Map<string, string>, base?: string): string {
	let v = value;
	// `${HOME:?}`, `${HOME%/}`, `${HOME:-x}`: still home, as far as a path goes.
	v = v.replace(/\$\{HOME[:%#?=+\-/^,@][^}]*\}/g, "${HOME}");
	if (base !== undefined) {
		v = v.replace(/\$\{PWD%\/\*\}/g, dirname(base));
		v = v.replace(/^(?:\$\(\s*dirname\s+"?(?:\$PWD|\$\{PWD\}|\.)"?\s*\))/, dirname(base));
		v = v.replace(/\$\{PWD(?:[:%#?=+\-/^,@][^}]*)?\}|\$PWD(?![A-Za-z0-9_])/g, base);
		v = v.replace(/^(?:\$\(\s*pwd\s*\)|`\s*pwd\s*`)/, base);
	}
	if (vars?.size) v = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => vars.get(a ?? b) ?? m);
	v = v.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home());
	if (USER) v = v.replace(/\$\{(?:USER|LOGNAME)\}|\$(?:USER|LOGNAME)(?![A-Za-z0-9_])/g, USER);
	if (USER) v = v.replace(new RegExp(`(^|[^A-Za-z0-9_~])~${escapeRe(USER)}(?=/|$|[^A-Za-z0-9_.-])`, "g"), `$1${home()}`);
	v = v.replace(/(^|[^A-Za-z0-9_~])~(?=\/|$|[^A-Za-z0-9_.~-])/g, `$1${home()}`);
	return process.platform === "darwin" ? v.replace(/(^|[^A-Za-z0-9_.-])\/System\/Volumes\/Data(?=\/)/gi, "$1") : v;
}

function braceVariants(word: string, depth = 0): string[] {
	if (depth >= 4) return [word];
	const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
	if (!m) return [word];
	const options = m[1]!.split(",");
	if (options.length > 16) return [word];
	return options.flatMap((o) => braceVariants(word.slice(0, m.index) + o + word.slice(m.index + m[0].length), depth + 1)).slice(0, 256);
}

/** A deny root written out inside a word: absolute (after expanding ~ and $HOME) at a path boundary. */
/** A deny root written out in a word, unless every occurrence is an allowed path (`~/.ssh/config`). */
function mentionedRoot(word: string, roots: Root[]): Root | undefined {
	const text = fold(word);
	return roots.find((root) => {
		if (!root.mention.test(text)) return false;
		if (!root.except.length) return true;
		for (const m of text.matchAll(root.mentionAll)) {
			const token = m[1]!.replace(/[.:]+$/, "");
			// Cut short by a substitution, a quote or a space mid-path: what follows may climb out.
			if (/[$`'"]/.test(m[2]!) || (/\s/.test(m[2]!) && token.endsWith("/"))) return true;
			if (!excepted(token, root)) return true;
		}
		return false;
	});
}

/** Code (a one-liner, a heredoc line): a home-relative root as its own segment, `'.ssh'`, `+ "/.aws/"`. */
const CODE_LIKE = /[\s'"(),+$`[\]]/;
function codeTailRoot(word: string, roots: Root[]): Root | undefined {
	if (!CODE_LIKE.test(word)) return;
	const text = fold(word);
	return roots.find((root) => !root.writeOnly && root.tailRe?.test(text));
}

// Programs whose arguments are code: a home-relative root in them (`'.ssh'`) counts.
const INTERPRETERS = /^(?:python[\d.]*|ruby|node|nodejs|perl|php|osascript|sh|bash|zsh|dash|ksh|fish|eval|deno|bun|tsx|ts-node|lua|Rscript|swift|irb|jq)$/;
// A word that is itself a command line handed to another program: `GIT_SSH_COMMAND='ssh -i k'`,
// `git -c core.sshCommand='ssh -i k'`, `rsync -e 'ssh -i k'`. Checked as a command of its own,
// so its program's exemptions apply.
const NESTED_COMMAND = /^(?:\S*\/)?(?:ssh|scp|sftp|autossh)(?:\s|$)/;

const GLOB = /[*?[]/;

/**
 * A glob that may name a root or something under it (`~/.ss*`, `~/.*\/*`). One that stops above a
 * root (`~/*`) only counts for a recursive reader. `**` reaches any depth.
 */
function globRoot(word: string, base: string, roots: Root[], recursive: boolean): Root | undefined {
	if (!GLOB.test(word)) return;
	const pattern = resolve(base, word);
	const patternSegs = pattern.split("/").filter(Boolean);
	const deep = patternSegs.includes("**");
	return roots.find((root) =>
		root.absolute.some((abs) => {
			const segs = abs.split("/").filter(Boolean);
			if (deep) {
				const prefix = patternSegs.slice(0, patternSegs.indexOf("**"));
				if (prefix.length > segs.length) return false;
				try {
					return matchesGlob(fold(`/${segs.slice(0, prefix.length).join("/")}`), fold(`/${prefix.join("/")}`)) || prefix.length === 0;
				} catch {
					return false;
				}
			}
			if (patternSegs.length < segs.length && !recursive) return false;
			const n = Math.min(segs.length, patternSegs.length);
			const p = `/${patternSegs.slice(0, n).join("/")}`;
			const a = `/${segs.slice(0, n).join("/")}`;
			try {
				if (!(matchesGlob(fold(a), fold(p)) || (CASE_INSENSITIVE && matchesGlob(a, p)))) return false;
				if (patternSegs.length <= segs.length) return true;
				// Deeper than the root: only if the rest matches something it holds that isn't allowed.
				const restPattern = fold(patternSegs.slice(segs.length).join("/"));
				const under = cachedWalk("paths", abs, () => pathsUnder(abs));
				return under === null || under.some((rel) => matchesGlob(fold(rel), restPattern) && !excepted(join(abs, rel), root));
			} catch {
				return true;
			}
		}),
	);
}

/** An ssh config file: named config, in ~/.ssh or its config.d. */
function sshConfigFile(word: string): boolean {
	const p = expandWord(word);
	const ssh = join(home(), ".ssh");
	return (basename(p) === "config" && fold(dirname(p)) === fold(ssh)) || inside(p, join(ssh, "config.d"));
}

/** Args a key-using program may name a deny root in, since it reads the key without printing it. */
function exemptArgs(words: Word[], program: string): Set<number> {
	const exempt = new Set<number>();
	const name = basename(program);
	const sshLike = name === "ssh" || name === "scp" || name === "sftp" || name === "autossh" || name === "mosh";
	for (let i = 1; i < words.length; i++) {
		const w = words[i]!.value;
		if (sshLike) {
			// -F reads an ssh config (whose bad lines it echoes): only a file named config.
			if ((w === "-i" || w === "-S") && i + 1 < words.length) exempt.add(i + 1);
			else if (w === "-F" && i + 1 < words.length && sshConfigFile(words[i + 1]!.value)) exempt.add(i + 1);
			else if (/^-[iS]./.test(w)) exempt.add(i);
			else if (/^-F./.test(w) && sshConfigFile(w.slice(2))) exempt.add(i);
			else if (w === "-o" && i + 1 < words.length && /^(?:IdentityFile|CertificateFile|UserKnownHostsFile|GlobalKnownHostsFile|ControlPath|IdentityAgent)[= ]/i.test(words[i + 1]!.value)) exempt.add(i + 1);
			else if (/^-o(?:IdentityFile|CertificateFile|UserKnownHostsFile|GlobalKnownHostsFile|ControlPath|IdentityAgent)=/i.test(w)) exempt.add(i);
		} else if (name === "ssh-keygen") {
			// Prints fingerprints and public keys, never a private key.
			if (w === "-f" && i + 1 < words.length) exempt.add(i + 1);
			else if (/^-f./.test(w)) exempt.add(i);
		} else if (name === "ssh-add") {
			if (!w.startsWith("-")) exempt.add(i);
		} else if (name === "kubectl" || name === "helm" || name === "k9s") {
			if (w === "--kubeconfig" && i + 1 < words.length) exempt.add(i + 1);
			else if (w.startsWith("--kubeconfig=")) exempt.add(i);
		}
	}
	return exempt;
}

const RUNNERS: Record<string, Set<string>> = {
	bundle: new Set(["exec"]),
	uv: new Set(["run"]),
	poetry: new Set(["run"]),
	pipenv: new Set(["run"]),
	mise: new Set(["exec", "x"]),
	asdf: new Set(["exec"]),
	rbenv: new Set(["exec"]),
	pnpm: new Set(["exec", "dlx"]),
	yarn: new Set(["exec", "dlx"]),
};
const WRAPPERS = new Set(["npx", "bunx", "uvx", "xcrun", "sudo", "env", "command", "builtin", "exec", "nice", "nohup", "time", "timeout", "caffeinate", "xargs", "doas", "stdbuf"]);

/** The program a simple command runs, past assignments and wrappers (`sudo`, `env`, `timeout 5`). */
function programIndex(words: Word[]): number {
	let i = 0;
	while (i < words.length) {
		const w = words[i]!.value;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
			i++;
			continue;
		}
		const name = basename(w);
		if (RUNNERS[name] && words[i + 1] && RUNNERS[name]!.has(words[i + 1]!.value)) {
			i += 2;
			continue;
		}
		if (WRAPPERS.has(name)) {
			i++;
			while (i < words.length && (words[i]!.value.startsWith("-") || /^\d+[smhd]?$/.test(words[i]!.value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.value))) i++;
			continue;
		}
		return i;
	}
	return -1;
}

function recursiveReader(words: Word[], at: number, wholeCommand: string): boolean {
	const name = basename(words[at]!.value);
	const args = words.slice(at + 1).map((w) => w.value);
	const flag = (re: RegExp) => args.some((a) => re.test(a));
	switch (name) {
		case "rg":
		case "ag":
		case "ack":
		case "tar":
		case "bsdtar":
		case "gtar":
		case "zip":
		case "7z":
		case "7za":
		case "rsync":
		case "ditto":
		case "restic":
		case "borg":
			return true;
		case "grep":
		case "egrep":
		case "fgrep":
		case "ggrep":
			return flag(/^-[A-Za-z]*[rR]|^--recursive$|^--dereference-recursive$|^--directories=recurse$/);
		case "cp":
		case "gcp":
		case "scp":
			return flag(/^-[A-Za-z]*[rRa]/);
		case "find":
		case "fd":
			return flag(/^-(?:exec|execdir|ok|okdir)$|^-x$|^--exec(?:-batch)?$/) || /\|\s*xargs\b/.test(wholeCommand);
		default:
			return false;
	}
}

/** A cd target we can't resolve that names nothing suspicious: relative words resolve under it to nothing. */
const UNKNOWN_DIR = "/\u0000unknown";

/** Where a simple command runs: the cwd, or the last plain `cd`/`pushd` before it. */
function cdTarget(words: Word[], base: string, roots?: Root[], scan?: Scan): string | undefined {
	const at = programIndex(words);
	if (at < 0) return;
	const name = words[at]!.value;
	if (name !== "cd" && name !== "pushd") return;
	let j = at + 1;
	while (j < words.length && /^-[PLe@]+$|^--$/.test(words[j]!.value)) j++;
	if (!words[j]) return name === "cd" ? home() : undefined; // a bare cd goes home
	const raw = words[j]!.value;
	if (raw === "-" || raw === "~-" || raw === "$OLDPWD" || raw === "${OLDPWD}") return scan?.prev ?? UNKNOWN_DIR;
	const target = expandWord(raw, scan?.vars, base);
	if (words[j]!.glob || target.includes("$") || target === "-") {
		// Unknown target: if what it is built from names home or a folder above a root
		// (`cd $(echo ~)`), assume it went there.
		if (roots && scan) {
			for (const inner of [...substitutions(words[j]!.live), target]) {
				// `$(dirname X)`: X's parent.
				const cmds = simpleCommands(inner);
				const first = cmds[0] ?? [];
				const k = programIndex(first);
				if (k >= 0 && basename(first[k]!.value) === "dirname" && first[k + 1]) {
					const r = dirname(resolve(base, expandWord(first[k + 1]!.value, scan.vars, base)));
					if (holdsRoot(r, roots) || rootHolding(r, roots)) return r;
				}
				for (const w of cmds.flat()) {
					const p = expandWord(w.value, scan.vars, base);
					if (!p || p.startsWith("-") || /\$/.test(p)) continue;
					const r = resolve(base, p);
					if (holdsRoot(r, roots) || rootHolding(r, roots)) return r;
				}
			}
		}
		// `cd ~/x/versions/*/`: somewhere under the glob's fixed part.
		if (words[j]!.glob && !target.includes("$")) {
			const fixed = target.split("/").filter((seg, k, all) => !/[*?[]/.test(all.slice(0, k + 1).join("/"))).join("/");
			return resolve(base, fixed || ".");
		}
		return UNKNOWN_DIR; // somewhere we can't tell, named by nothing above
	}
	return resolve(base, target);
}

// What a substitution's output is: names from a finder count as read by the outer command.
const FINDERS = new Set(["find", "fd", "locate", "mdfind"]);

/** Names and relative paths under a folder (at most 2000, links not followed). */
function pathsUnder(root: string): string[] {
	const out: string[] = [];
	const pending = [""];
	while (pending.length && out.length < 2000) {
		const rel = pending.pop()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const child = rel ? `${rel}/${e.name}` : e.name;
			out.push(child);
			if (e.isDirectory()) pending.push(child);
		}
	}
	return out;
}

/**
 * Whether a find's name and path tests may pick something inside a root: no test (`find ~ -exec
 * cat`) may; `-name`/`-iname` are tried on the names the root holds, `-path`/`-ipath` on their
 * full paths. Anything else it can't read (`-regex`) counts as may.
 */
function findFilterReaches(words: Word[], at: number, root: Root): boolean {
	const tests: { kind: "name" | "path"; pattern: string; ci: boolean }[] = [];
	for (let i = at + 1; i < words.length - 1; i++) {
		const w = words[i]!.value;
		if (w === "-name" || w === "-iname") tests.push({ kind: "name", pattern: words[i + 1]!.value, ci: w === "-iname" });
		else if (w === "-path" || w === "-ipath" || w === "-wholename" || w === "-iwholename") tests.push({ kind: "path", pattern: words[i + 1]!.value, ci: w.startsWith("-i") });
		else if (/^-i?regex$/.test(w)) return true;
	}
	if (!tests.length) return true;
	return root.absolute.some((abs) => {
		const walked = cachedWalk("paths", abs, () => pathsUnder(abs));
		if (walked === null) return true;
		const under = [basename(abs), ...walked];
		return tests.some((t) =>
			under.some((rel) => {
				const target = t.kind === "name" ? basename(rel) : `${abs}/${rel}`;
				try {
					return matchesGlob(t.ci || CASE_INSENSITIVE ? fold(target) : target, t.ci || CASE_INSENSITIVE ? fold(t.pattern) : t.pattern);
				} catch {
					return true;
				}
			}),
		);
	});
}

/** The commands inside live `$(…)` and backticks (pass Word.live: single quotes already masked). */
function substitutions(live: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < live.length; i++) {
		if (live[i] === "`") {
			const close = backtickClose(live, i);
			if (close < 0) break;
			// bash unescapes \\, \` and \$ in a backtick body before it parses it, and \" too when
			// the backtick is double-quoted (which depends on context we don't track here): both readings.
			const body = live.slice(i + 1, close);
			out.push(body.replace(/\\([\\`$])/g, "$1"));
			if (body.includes('\\"')) out.push(body.replace(/\\([\\`$"])/g, "$1"));
			i = close;
			continue;
		}
		if (live[i] !== "$" || live[i + 1] !== "(") continue;
		let depth = 0;
		let quote: string | undefined;
		for (let j = i + 1; j < live.length; j++) {
			const c = live[j]!;
			if (quote) {
				if (c === quote) quote = undefined;
				else if (c === "\\") j++;
				continue;
			}
			if (c === "'" || c === '"') quote = c;
			else if (c === "\\") j++;
			else if (c === "`") {
				const close = backtickClose(live, j);
				j = close < 0 ? live.length : close;
			} else if (c === "#" && depth >= 1 && /[\s;|&()]/.test(live[j - 1] ?? " ")) {
				// A comment inside $( … ): to the end of the line.
				while (j + 1 < live.length && live[j + 1] !== "\n") j++;
			} else if (c === "(") depth++;
			else if (c === ")" && --depth === 0) {
				out.push(live.slice(i + 2, j));
				i = j;
				break;
			}
		}
	}
	return out;
}

interface Scan {
	base: string;
	roots: Root[];
	config: DenyConfig;
	depth: number;
	/** Inside a substitution whose output another command reads. */
	readsOutput: boolean;
	/** Variables assigned earlier in the command (shared with nested scans). */
	vars: Map<string, string>;
	/** The directory before the last cd (for `cd -`). */
	prev?: string;
	/** Every heredoc body seen so far, by marker id, shared with nested scans (a tag line may sit in `$(…)`). */
	heredocs: Map<number, Body>;
	/** Bodies already scanned. */
	scanned: Set<number>;
	/** Scanning text as shell only to fail closed (a prose body): an unclosed quote there is just an apostrophe. */
	prose?: boolean;
}

/** A word with each `$(…)` and backtick substitution replaced. */
function stripSubs(word: string, by: string): string {
	let out = word.replace(/`(?:\\.|[^`\\])*`/g, by);
	for (let i = out.indexOf("$("); i >= 0; i = out.indexOf("$(")) {
		let depth = 0;
		let j = i + 1;
		for (; j < out.length; j++) {
			if (out[j] === "(") depth++;
			else if (out[j] === ")" && --depth === 0) break;
		}
		out = out.slice(0, i) + by + out.slice(j + 1);
	}
	return out;
}

function existsOnDisk(word: string, base: string): boolean {
	try {
		statSync(resolve(base, expandWord(word)));
		return true;
	} catch {
		return false;
	}
}

/** Whether a recursive reader runs with no path argument, so on its cwd. */
const VALUE_FLAGS = new Set(["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-j", "-M", "-d", "-E", "-S", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--context", "--after-context", "--before-context", "--threads", "--max-columns", "--include", "--exclude", "--exclude-dir", "--max-depth", "--maxdepth", "--extension", "--size", "--changed-within", "--changed-before", "--owner"]);
function implicitCwd(words: Word[], at: number, base: string): boolean {
	const program = basename(words[at]!.value);
	// Reading a pipe: no implicit cwd, except BSD grep -r (it searches . anyway), and not when xargs
	// took the pipe.
	const viaXargs = words.slice(0, at).some((w) => basename(w.value) === "xargs");
	if (STDIN.has(words) && !viaXargs && !/^(?:e|f|g)?grep$/.test(program) && program !== "find" && program !== "fd") return false;
	if (program === "find") {
		const first = words[at + 1]?.value;
		return !first || first.startsWith("-") || first === "(" || first === "!";
	}
	if (["tar", "bsdtar", "gtar", "zip", "7z", "7za", "rsync", "ditto", "restic", "borg", "cp", "gcp", "scp"].includes(program)) return false;
	let positional = 0;
	let pattern = true; // rg/grep/ag/ack/fd take a pattern first, unless -e/-f gave one
	for (let k = at + 1; k < words.length; k++) {
		const w = words[k]!.value;
		if (program === "fd" && /^-[A-Za-z]*[xX]$|^--exec/.test(w)) break; // the rest is fd's command
		if (w === "--") {
			for (const rest of words.slice(k + 1)) if (existsOnDisk(rest.value, base)) positional++;
			break;
		}
		if (w.startsWith("-")) {
			if (w === "-e" || w === "-f" || w === "--regexp" || w === "--file" || /^--(?:regexp|file)=/.test(w)) pattern = false;
			if (VALUE_FLAGS.has(w)) k++;
			continue;
		}
		if (words[k]!.redirect) continue;
		// The pattern comes first (unless -e/-f gave it); after it, a word is a path when it exists,
		// is a glob or a variable, or has a slash. A flag's unlisted value usually is none of these.
		if (pattern && (program === "rg" || program === "ag" || program === "ack" || /grep$/.test(program) || program === "fd")) {
			pattern = false;
			continue;
		}
		if (words[k]!.glob || w.includes("$") || w.includes("/") || existsOnDisk(w, base)) positional++;
	}
	return positional === 0;
}

function wordHit(raw: Word, i: number, at: number, words: Word[], scan: Scan, recursive: boolean): DenyHit | undefined {
	const { base, roots } = scan;
	const program = at >= 0 ? basename(words[at]!.value) : "";
	const code = INTERPRETERS.test(program);
	// `$(…)` and backticks: what runs inside is checked as a command of its own.
	for (const inner of substitutions(raw.live)) {
		const hit = scanCommand(inner, { ...scan, depth: scan.depth + 1, readsOutput: true, vars: new Map(scan.vars) });
		if (hit) return hit;
	}
	// `--file=~/.ssh/x`, `VAR=~/.ssh`: the value after `=` is a word of its own too.
	const candidates = new Set<string>();
	for (const v of braceVariants(raw.value)) {
		candidates.add(v);
		const eq = v.indexOf("=");
		if (eq >= 0 && eq < v.length - 1) candidates.add(v.slice(eq + 1));
	}
	for (const candidate of candidates) {
		if (NESTED_COMMAND.test(candidate) && /\s/.test(candidate)) {
			const hit = scanCommand(candidate, { ...scan, depth: scan.depth + 1, vars: new Map(scan.vars) });
			if (hit) return hit;
			continue;
		}
	}
	for (const candidate of candidates) {
		if (NESTED_COMMAND.test(candidate) && /\s/.test(candidate)) continue;
		const nested = [...candidates].some((c) => NESTED_COMMAND.test(c) && /\s/.test(c));
		if (nested && candidate === raw.value) continue; // `VAR=ssh -i k`: its command was checked above
		// Checked as written and with earlier assignments filled in: an assignment that didn't
		// happen (`false && D=x`) can't hide what the word names.
		const plain = expandWord(candidate, undefined, base);
		const word = expandWord(candidate, scan.vars, base);
		for (const form of plain === word ? [word] : [plain, word]) {
			const mentioned = mentionedRoot(form, roots) ?? (code ? codeTailRoot(form, roots) : undefined);
			if (mentioned) return { target: mentioned.label, why: `the command names ${mentioned.label}` };
		}
		// A start we can't know (`$(echo ~)/.ssh/x`, `$d/.ssh/x`, `` `pwd`/.aws ``): what follows
		// it naming a root by its home-relative name counts.
		// After `cd` somewhere unknown, a relative word starts there: unknown too.
		const unknownStart = /^(?:\$\(|`|\$\{?[A-Za-z_])/.test(word) || (base === UNKNOWN_DIR && !word.startsWith("/"));
		if (unknownStart) {
			const tail = codeTailRoot(` ${stripSubs(word, "").replace(/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, "")}`, roots);
			if (tail) return { target: tail.label, why: `${raw.value} may name ${tail.label}` };
		}
		if (!word || word.startsWith("-")) continue;
		// A script handed to an interpreter isn't a path; any other word with spaces may be one
		// (`"Application Support/…/Cookies"`).
		if (code && /\s/.test(word)) continue;
		// A substitution's output is unknown: as a path it is nothing (`config.d/$(true)/../..`), as
		// a glob anything (`~/.ss*/id_rsa$(true)`).
		// Only past a known start: `$(cmd)/x` is wherever cmd says, not under the cwd.
		const hasSub = /\$\(|`/.test(word) && !/^(?:\$\(|`)/.test(word);
		if (/^(?:\$\(|`)/.test(word)) continue;
		const asPath = hasSub ? stripSubs(word, "") : word;
		const asGlob = hasSub ? stripSubs(word, "*") : word;
		const isGlob = raw.glob && GLOB.test(word); // `${HOME:?}` has a ? that expands away
		if (isGlob || (hasSub && asGlob !== asPath)) {
			const glob = globRoot(asGlob, base, roots, recursive && i !== at);
			if (glob) return { target: glob.label, why: `${raw.value} may reach ${glob.label}` };
			if (isGlob) continue;
		}
		const lexical = resolve(base, asPath);
		const hit = rootHolding(lexical, roots) ?? rootHolding(canonical(lexical), roots);
		if (hit) return { target: hit.label, why: `${raw.value} is in ${hit.label}` };
		if (recursive && i !== at) {
			const above = holdsRoot(lexical, roots) ?? holdsRoot(canonical(lexical), roots);
			if (above && (program !== "find" || findFilterReaches(words, at, above))) return { target: above.label, why: `${program} of ${raw.value} reads ${above.label}` };
		}
	}
	return;
}

const ruleCache = new Map<string, RegExp | null>();
function rule(source: string, flags = ""): RegExp | null {
	const key = `${flags}/${source}`;
	if (!ruleCache.has(key)) {
		try {
			ruleCache.set(key, new RegExp(source, flags));
		} catch {
			ruleCache.set(key, null);
		}
	}
	return ruleCache.get(key)!;
}

function commandRuleHit(text: string, config: DenyConfig): DenyHit | undefined {
	for (const source of config.commands) {
		const m = rule(source)?.exec(text);
		if (m) return { target: m[0].trim().slice(0, 80), why: "reads keychain secrets" };
	}
	return;
}

/** A bash command: the deny command rules, then every word (see the module comment). */
export function denyBashCommand(command: string, cwd: string, config: DenyConfig): DenyHit | undefined {
	// The guardian's config files count as deny roots here, reads included: bash can't say which.
	const roots = rootsOf(config);
	return scanCommand(command, { base: normalizeToolPath(cwd), roots, config, depth: 0, readsOutput: false, vars: new Map(), heredocs: new Map(), scanned: new Set() });
}

const MAX_DEPTH = 6;

function scanCommand(command: string, scan: Scan): DenyHit | undefined {
	if (scan.depth > MAX_DEPTH) return { target: "nested commands", why: "too deeply nested to check" };
	// `\⏎` continues a line: the rules see one line.
	// Line continuations are joined inside splitHeredocs, outside heredoc bodies only.
	const joined = command;
	const { rest, bodies } = splitHeredocs(joined);
	const ruled = commandRuleHit(rest, scan.config) ?? bodies.filter((b) => b.code).map((b) => commandRuleHit(b.text, scan.config)).find(Boolean);
	if (ruled) return ruled;
	const { roots } = scan;
	if (!roots.length) return;
	// A heredoc body is text, never words the shell resolves. One an interpreter or a shell runs is
	// code: a deny root written out in it, or a home-relative one, counts. One cat/tee writes to a
	// file is data and is left alone (running that file later is a known gap).
	for (const body of bodies) scan.heredocs.set(body.id, body);
	const checkBodies = (b: string, ids: number[]): DenyHit | undefined => {
	for (const id of ids) {
		const body = scan.heredocs.get(id);
		if (!body) continue;
		scan.scanned.add(id);
		if (body.live && !body.shell) {
			for (const inner of substitutions(body.text)) {
				const hit = scanCommand(inner, { ...scan, base: b, depth: scan.depth + 1, readsOutput: true, vars: new Map(scan.vars) });
				if (hit) return hit;
			}
		}
		if (body.mentions) {
			for (const line of body.text.split("\n")) {
				const mentioned = mentionedRoot(expandWord(line), roots);
				if (mentioned) return { target: mentioned.label, why: `the command names ${mentioned.label}` };
			}
			continue;
		}
		if (!body.code) continue;
		if (body.paths) {
			// Each line is a path the receiver opens.
			for (const line of body.text.split("\n")) {
				const p = expandWord(line.trim());
				if (!p) continue;
				const lexical = resolve(b, p);
				// In a root, or a folder above one (xargs may hand it to a recursive reader).
				const hit = rootHolding(lexical, roots) ?? rootHolding(canonical(lexical), roots) ?? holdsRoot(lexical, roots);
				if (hit) return { target: hit.label, why: `${line.trim()} is in ${hit.label}` };
			}
		}
		if (body.shell) {
			// A shell runs it: every check, as for the command itself.
			const hit = scanCommand(body.text, { ...scan, base: b, depth: scan.depth + 1, vars: new Map(scan.vars), prose: body.prose === true });
			if (hit) return hit;
			continue;
		}
		for (const line of body.text.split("\n")) {
			const word = expandWord(line);
			const mentioned = mentionedRoot(word, roots) ?? codeTailRoot(word, roots);
			if (mentioned) return { target: mentioned.label, why: `the command names ${mentioned.label}` };
		}
	}
	return;
	};
	// Every folder the command passes through: a body runs in whichever its command reached.
	const bases = [scan.base];
	let base = scan.base;
	let allWords: Word[] | undefined;
	let xargsChecked = false;
	const cmds = simpleCommands(rest);
	// (Only the command itself: a body scanned as shell only to fail closed is prose, apostrophes and all.)
	if (!scan.prose && UNBALANCED.has(cmds)) return { target: "the command", why: "a quote or expansion is never closed, so where it ends can't be told" };
	for (const words of cmds) {
		const at = programIndex(words);
		const exempt = at >= 0 ? exemptArgs(words, words[at]!.value) : new Set<number>();
		const program = at >= 0 ? basename(words[at]!.value) : "";
		const recursive = at >= 0 && (recursiveReader(words, at, rest) || (program === "fd" && words.some((w) => /^-[A-Za-z]*[xX]$|^--exec/.test(w.value))) || (scan.readsOutput && (FINDERS.has(program) || (program === "ls" && words.some((w) => /^-[A-Za-z]*R/.test(w.value))))));
		// `bash -c '…'`, `eval '…'`: the script is a command of its own.
		if (at >= 0 && (SHELLS.has(program) || program === "eval")) {
			const c = words.findIndex((w, k) => k > at && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.value));
			const scripts = program === "eval" ? words.slice(at + 1) : c > 0 && words[c + 1] ? [words[c + 1]!] : [];
			for (const w of scripts) {
				const hit = scanCommand(w.value, { ...scan, base, depth: scan.depth + 1, vars: new Map(scan.vars) });
				if (hit) return hit;
			}
		}
		// This command's heredocs run here.
		// (A marker inside `$(…)` belongs to the substitution's scan, in its folder.)
		const marks = words.flatMap((w) => [...stripSubs(w.value, "").matchAll(/\u0002(\d+)\u0002/g)].map((mm) => Number(mm[1])));
		if (marks.length) {
			const hit = checkBodies(base, marks);
			if (hit) return hit;
		}
		const local = { ...scan, base };
		for (let i = 0; i < words.length; i++) {
			// An exempt argument with a substitution in it isn't exempt: `ssh-add "$(cat key)"`.
			if (exempt.has(i) && !/\$\(|`/.test(words[i]!.live)) continue;
			const hit = wordHit(words[i]!, i, at, words, local, recursive);
			if (hit) return hit;
		}
		// rg, grep -r, fd, find … with no path argument read their cwd.
		if (recursive && implicitCwd(words, at, base)) {
			const above = rootHolding(base, roots) ?? holdsRoot(base, roots) ?? holdsRoot(canonical(base), roots);
			if (above && (program !== "find" || findFilterReaches(words, at, above))) return { target: above.label, why: `${program} in ${base} reads ${above.label}` };
		}
		// `echo ~ | xargs rg …`: xargs hands it paths from the pipe; a folder above a root named
		// anywhere in the command may be one.
		if (recursive && !xargsChecked && at > 0 && words.slice(0, at).some((w) => basename(w.value) === "xargs")) {
			xargsChecked = true;
			allWords ??= simpleCommands(rest).flat();
			for (const other of allWords) {
				const p = expandWord(other.value);
				if (!p || p.startsWith("-") || /\s/.test(p)) continue;
				const above = holdsRoot(resolve(base, p), roots) ?? rootHolding(resolve(base, p), roots);
				if (above) return { target: above.label, why: `xargs ${program} may read ${above.label}` };
			}
		}
		// Assignments carry on to later words (`D=~/.ss; cat ${D}h/id_rsa`): bare assignment
		// commands and export/declare/local/readonly/typeset only, never HOME/USER/LOGNAME, at most
		// 4 KB; one from a substitution is forgotten (unknown).
		const assigns = at < 0 ? words : ["export", "declare", "local", "readonly", "typeset"].includes(program) ? words.slice(at + 1) : [];
		for (const w of assigns) {
			const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w.value);
			if (!m || /^(?:HOME|USER|LOGNAME)$/.test(m[1]!)) continue;
			const value = expandWord(m[2]!, scan.vars);
			if (/\$\(|`/.test(m[2]!) || value.length > 4096) scan.vars.delete(m[1]!);
			else scan.vars.set(m[1]!, value);
		}
		const next = cdTarget(words, base, roots, scan);
		if (next !== undefined) {
			scan.prev = base;
			base = next;
			bases.push(base);
		}
	}
	// Bodies whose marker didn't land in a command this scan saw: every folder it reached.
	const pending = bodies.map((body) => body.id).filter((id) => !scan.scanned.has(id));
	for (const b of new Set(bases)) {
		const hit = checkBodies(b, pending);
		if (hit) return hit;
	}
	return;
}

// ── secret CLIs: not denied, but reviewed as a private-data read ─────────────

/**
 * Commands that hand out secrets once the user has unlocked them (1Password's `op` keeps a Touch ID
 * approval for about 10 minutes). Not denied (the credentials skill uses `op`), but reviewed as a
 * private-data read: the reviewer gets no tools and must find the user's explicit authorization.
 * `secretCommands.patterns`: each matches one simple command (or a script word inside one: `sh -c
 * '…'`, `$(…)`); `secretCommands.allow`: a simple command matching one is never flagged (known
 * wrappers such as `fnox`). Global lists replace these, a trusted project's add patterns only.
 */
export const DEFAULT_SECRET_COMMAND_PATTERNS: readonly string[] = [
	KEYCHAIN_PASSWORD_RULE,
	"(?:^|[\\s;&|('\"`]|\\$\\()(?:\\S*/)?gh\\s+auth\\s+token(?![\\w-])",
	"(?:^|[\\s;&|('\"`]|\\$\\()(?:\\S*/)?kubectl\\s+(?:\\S+\\s+)*config\\s+view\\s+(?:\\S+\\s+)*--raw(?![\\w-])",
	"(?:^|[\\s;&|('\"`]|\\$\\()(?:\\S*/)?git\\s+(?:-\\S+\\s+)*credential(?:-\\S+)?\\s+(?:fill|get)(?![\\w-])",
	"(?:^|[\\s;&|('\"`]|\\$\\()(?:\\S*/)?aws\\s+(?:\\S+\\s+)*configure\\s+(?:export-credentials|get)(?![\\w-])",
	"(?:^|[\\s;&|('\"`]|\\$\\()(?:\\S*/)?docker-credential-[\\w-]+\\s+get(?![\\w-])",
	"(?:^|[\\s;&|('\"`]|\\$\\()(?:\\S*/)?op\\s+(?:--?[\\w-]+(?:[ =](?!read|item|inject|run|signin|document|vault)\\S+)?\\s+)*(?:read|item|inject|run|signin|document|vault)(?![\\w-])",
];
export const DEFAULT_SECRET_COMMAND_ALLOW: readonly string[] = ["^\\s*(?:\\S*/)?fnox(?:\\s|$)"];

export interface SecretCommandConfig {
	patterns: string[];
	allow: string[];
}

export const DEFAULT_SECRET_COMMANDS: SecretCommandConfig = {
	patterns: [...DEFAULT_SECRET_COMMAND_PATTERNS],
	allow: [...DEFAULT_SECRET_COMMAND_ALLOW],
};

const compiled = new Map<string, RegExp | null>();
function re(source: string): RegExp | null {
	if (!compiled.has(source)) {
		try {
			compiled.set(source, new RegExp(source));
		} catch {
			compiled.set(source, null);
		}
	}
	return compiled.get(source)!;
}

/** The secret-CLI call a bash command makes (the matched text), or undefined. */
export function secretCommandIn(command: string, config: SecretCommandConfig): string | undefined {
	if (!config.patterns.length) return;
	const { rest, bodies } = splitHeredocs(command);
	const texts = [rest, ...bodies.filter((b) => b.code).map((b) => b.text)];
	for (const text of texts) {
		for (const words of simpleCommands(text)) {
			const line = words.map((w) => w.value).join(" ");
			if (config.allow.some((a) => re(a)?.test(line))) continue;
			for (const p of config.patterns) {
				const m = re(p)?.exec(line);
				if (m) return m[0].replace(/^[\s;&|('"`$(]+/, "").trim().slice(0, 80);
			}
		}
	}
	return;
}

/** What the model and the user are told. */
export function denyReason(hit: DenyHit): string {
	return `Blocked by Approval Guardian's deny list: ${hit.why} (${hit.target} holds secrets). No reviewer can approve this; do not retry or work around it. If the user needs it, they can run /approval-guardian bypass themselves.`;
}
