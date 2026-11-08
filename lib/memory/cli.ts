/**
 * pi-memory: the memory pool from the shell, for scripts and Botsun. The same
 * scanner, dedupe and git commit as the extension (ops.ts).
 *
 *   pi-memory list [--scope visible|global|project|all] [--state active|proposed|archived|all]
 *   pi-memory search <words…> [--scope …] [--limit N]
 *   pi-memory add [--project] [--tags a,b] [--expires YYYY-MM-DD] <fact…>
 *   pi-memory edit <id> [--text T] [--expires YYYY-MM-DD]   without --text: opens $EDITOR
 *   pi-memory forget <id> | restore <id> | expire
 *   pi-memory verify <id> --status confirmed|contradicted|unverifiable --evidence "…"
 *   pi-memory review-check [--days 14] [--json]   expires stale facts, lists what is due
 *   pi-memory pin [text…] | pin rm <n>        no text: list the pins
 *   pi-memory context                         the block a session here would start with
 *   pi-memory status | qmd setup
 *
 * Every command takes --json, --cwd DIR (which repo is "the project"; default
 * the current folder) and --root DIR (default memory.root, else
 * ~/.local/share/pi-memory). Exit 0 on success, 1 on an error, 2 on bad usage.
 * `review-check` is the one exception: 0 when something is due, 3 when nothing
 * is (1 stays an error), so a scheduled run stops early without confusing the
 * two.
 *
 * Pure node: no pi imports.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { remotes } from "./git.ts";
import { VERIFIED_STATUSES } from "./frontmatter.ts";
import * as ops from "./ops.ts";
import { slugFor } from "./project.ts";
import { oneLine } from "./render.ts";
import * as review from "./review.ts";
import { expandHome, memorySettings, tildePath } from "./settings.ts";
import * as store from "./store.ts";
import { type Memory, MemoryError } from "./store.ts";

export interface Io {
	out: (s: string) => void;
	err: (s: string) => void;
	env: NodeJS.ProcessEnv;
	cwd: string;
}

const VALUE_FLAGS = new Set(["cwd", "tags", "scope", "limit", "root", "text", "state", "expires", "status", "evidence", "by", "days"]);
const BOOL_FLAGS = new Set(["json", "project", "help"]);

class Usage extends Error {}

export function parseArgs(argv: readonly string[]): { flags: Record<string, string | true>; rest: string[] } {
	const flags: Record<string, string | true> = {};
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--") {
			rest.push(...argv.slice(i + 1));
			break;
		}
		if (a === "-h") {
			flags.help = true;
			continue;
		}
		const m = /^--([a-z][\w-]*)(?:=(.*))?$/.exec(a);
		if (!m) {
			rest.push(a);
			continue;
		}
		const name = m[1]!;
		if (BOOL_FLAGS.has(name)) flags[name] = true;
		else if (VALUE_FLAGS.has(name)) {
			const v = m[2] ?? argv[++i];
			if (v === undefined) throw new Usage(`--${name} needs a value`);
			flags[name] = v;
		} else throw new Usage(`unknown option --${name}`);
	}
	return { flags, rest };
}

const HELP = `pi-memory: durable facts for pi sessions on this host

  list [--scope visible|global|project|all] [--state active|proposed|archived|all]
  search <words…> [--scope …] [--limit N]
  add [--project] [--tags a,b] [--expires YYYY-MM-DD] <fact…>
  edit <id> [--text T] [--expires YYYY-MM-DD]   (no --text: $EDITOR)
  forget <id>  |  restore <id>  |  expire
  verify <id> --status confirmed|contradicted|unverifiable --evidence "…" [--by MODEL]
  review-check [--days 14]              what is due; exit 0 when something is, 3 when nothing is
  pin [text…]  |  pin rm <n>     (no text: list pins)
  context                        the block a session here starts with
  status  |  qmd setup

Options: --json, --cwd DIR, --root DIR`;

/** Edit `current` in $VISUAL or $EDITOR, run by sh as git runs it (so "code --wait" works); the file is passed as an argument, never interpolated. */
function editText(current: string, env: NodeJS.ProcessEnv): string | undefined {
	const editor = env.VISUAL?.trim() || env.EDITOR?.trim() || "vi";
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-edit-"));
	const file = join(dir, "memory.md");
	try {
		writeFileSync(file, `${current}\n`, { mode: 0o600 });
		const r = spawnSync("/bin/sh", ["-c", `${editor} "$@"`, editor, file], { stdio: "inherit", env });
		if (r.status !== 0) return undefined;
		return readFileSync(file, "utf8").trim();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const asJson = (m: Memory) => ({ id: m.id, scope: m.scope, state: m.state, text: m.text, tags: m.tags, created: m.created, updated: m.updated, confidence: m.confidence, source: m.source, ...(m.expires ? { expires: m.expires } : {}), ...(m.verified ? { verified: m.verified } : {}), ...(m.archived ? { archived: m.archived } : {}) });

export async function main(argv: readonly string[], io: Io): Promise<number> {
	let json = false;
	const say = (text: string, data: Record<string, unknown> = {}) => io.out(json ? JSON.stringify({ ok: true, ...data }) : text);
	const end = argv.indexOf("--");
	json = (end < 0 ? argv : argv.slice(0, end)).includes("--json");
	try {
		const { flags, rest } = parseArgs(argv);
		const [cmd, ...args] = rest;
		if (flags.help || !cmd) {
			io.out(HELP);
			return cmd || flags.help ? 0 : 2;
		}
		const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
			const v = flags[name];
			if (v === undefined) return fallback;
			if (typeof v !== "string" || !allowed.includes(v as T)) throw new Usage(`--${name} is one of ${allowed.join(", ")}`);
			return v as T;
		};
		const whole = (name: string, fallback: number, min: number): number => {
			const v = flags[name];
			if (v === undefined) return fallback;
			const n = typeof v === "string" ? Number(v) : Number.NaN;
			if (!Number.isInteger(n) || n < min) throw new Usage(`--${name} is a whole number, ${min} or more`);
			return n;
		};
		const base = memorySettings(io.env);
		const settings = typeof flags.root === "string" ? { ...base, root: resolve(io.cwd, expandHome(flags.root)) } : base;
		const cwd = typeof flags.cwd === "string" ? resolve(io.cwd, expandHome(flags.cwd)) : io.cwd;
		const mem = ops.open(settings, (msg) => io.err(msg));
		const slug = () => slugFor(cwd);
		const settle = async (w: { committed: Promise<unknown> }) => {
			await w.committed;
			await mem.qmd.updateDetached();
		};
		const id = () => {
			const v = args[0];
			if (!v) throw new Usage(`${cmd} needs a memory id`);
			return v;
		};

		switch (cmd) {
			case "list": {
				const state = oneOf("state", ["active", "proposed", "archived", "all"], "active");
				const scope = oneOf("scope", ops.SEARCH_SCOPES, "all");
				const s = slug();
				const project = s ? store.projectScope(s) : null;
				const list = store.load(mem.root).memories.filter((m) =>
					(state === "all" || m.state === state) &&
					(scope === "all" || (scope === "global" ? m.scope === "global" : scope === "project" ? m.scope === project : m.scope === "global" || m.scope === project)));
				say(list.length ? list.map(ops.line).join("\n") : "No memories.", { memories: list.map(asJson) });
				return 0;
			}
			case "search": {
				const query = args.join(" ");
				if (!query.trim()) throw new Usage("search needs words");
				const limit = typeof flags.limit === "string" ? Number(flags.limit) : 10;
				if (!Number.isInteger(limit) || limit < 1) throw new Usage("--limit is a whole number, 1 or more");
				const r = await ops.search(mem, query, { scope: oneOf("scope", ops.SEARCH_SCOPES, "visible"), limit, slug: slug() });
				store.bumpUsed(r.memories.map((m) => m.id), store.statsPath(io.env));
				const lines = r.memories.map(ops.line);
				if (r.outside.length) lines.push("", "Outside memory (qmd):", ...r.outside.map((o) => `${o.file}: ${o.snippet}`));
				say(lines.length ? lines.join("\n") : "No matching memories.", { memories: r.memories.map(asJson), outside: r.outside, via: r.via });
				return 0;
			}
			case "add": {
				const text = args.join(" ");
				const scope = ops.scopeFor(flags.project ? "project" : "global", flags.project ? slug() : null);
				const tags = typeof flags.tags === "string" ? flags.tags.split(",") : [];
				const expires = typeof flags.expires === "string" ? flags.expires : undefined;
				const w = ops.remember(mem, { text, tags, scope, source: { kind: "cli", cwd: tildePath(cwd) }, ...(expires ? { expires } : {}) });
				await settle(w);
				say(`Saved as ${w.memory.id} (${w.memory.scope}).`, { memory: asJson(w.memory) });
				return 0;
			}
			case "edit": {
				const target = id();
				const current = store.find(mem.root, target);
				if (!current || current.state === "archived") throw new MemoryError(`no memory ${target}`);
				const expires = typeof flags.expires === "string" ? store.cleanExpires(flags.expires) : undefined;
				let text: string | undefined;
				if (typeof flags.text === "string") text = flags.text;
				else if (expires === undefined) text = editText(current.text, io.env);
				if (text === undefined && expires === undefined) throw new MemoryError("the editor exited without saving");
				const sameText = text === undefined || text === current.text;
				if (sameText && (expires === undefined || expires === current.expires)) {
					say("Unchanged.", { memory: asJson(current), unchanged: true });
					return 0;
				}
				const w = ops.update(mem, target, sameText ? undefined : text, undefined, expires !== undefined ? { expires } : {});
				await settle(w);
				say(`Updated ${target}.`, { memory: asJson(w.memory) });
				return 0;
			}
			case "expire": {
				const gone = await ops.expire(mem);
				await mem.qmd.updateDetached();
				say(gone.length ? gone.map((m) => `Expired ${m.id}.`).join("\n") : "Nothing expired.", { expired: gone.map((m) => m.id) });
				return 0;
			}
			case "verify": {
				const target = id();
				// Both are required: a verification nobody made is worse than none.
				const { status, evidence } = flags;
				if (typeof status !== "string" || typeof evidence !== "string" || !evidence.trim()) {
					throw new Usage(`verify needs --status ${VERIFIED_STATUSES.join("|")} and --evidence`);
				}
				if (!(VERIFIED_STATUSES as readonly string[]).includes(status)) throw new Usage(`--status is one of ${VERIFIED_STATUSES.join(", ")}`);
				const by = typeof flags.by === "string" ? flags.by : "user";
				const w = ops.verify(mem, target, { status, evidence, by });
				await settle(w);
				say(`Verified ${w.memory.id} as ${status}.`, { memory: asJson(w.memory) });
				return 0;
			}
			case "review-check": {
				const days = whole("days", review.DEFAULT_REVIEW_DAYS, 0);
				const now = new Date();
				const expired = await ops.expire(mem, now);
				await mem.qmd.updateDetached();
				const list = review.due(store.load(mem.root).memories, { now, days });
				const lines = [
					...(expired.length ? [`expired ${expired.length}: ${expired.map((m) => m.id).join(", ")}`] : []),
					...(list.length ? list.map(review.line) : ["Nothing due."]),
				];
				say(lines.join("\n"), {
					expired: expired.map((m) => m.id),
					due: list.map((d) => ({ id: d.memory.id, scope: d.memory.scope, text: d.memory.text, updated: d.memory.updated, expires: d.memory.expires ?? null, verified: d.memory.verified ?? null, reasons: d.reasons })),
				});
				return list.length ? 0 : 3;
			}
			case "forget":
			case "restore": {
				const w = cmd === "forget" ? ops.forget(mem, id()) : ops.restore(mem, id());
				await settle(w);
				say(cmd === "forget" ? `Archived ${w.memory.id} (restore with: pi-memory restore ${w.memory.id}).` : `Restored ${w.memory.id} (${w.memory.scope}).`, { memory: asJson(w.memory) });
				return 0;
			}
			case "pin": {
				if (args[0] === "rm") {
					if (args.length !== 2 || !/^\d+$/.test(args[1]!)) throw new Usage("pin rm takes one pin number (pi-memory pin lists them)");
					const n = Number(args[1]);
					const r = ops.unpin(mem, n);
					await settle(r);
					say(`Removed pin ${n}.`, { pins: r.pins });
					return 0;
				}
				if (args.length === 0) {
					const pins = store.readPins(mem.root);
					say(pins.length ? pins.map((p, i) => `${i + 1}. ${oneLine(p)}`).join("\n") : "No pins.", { pins });
					return 0;
				}
				const r = ops.pin(mem, args.join(" "));
				await settle(r);
				say(`Pinned (${r.pins.length}).`, { pins: r.pins });
				return 0;
			}
			case "context": {
				const block = ops.context(mem, slug(), store.readStats(store.statsPath(io.env)));
				say(block.text ?? "(empty: no pins and no memories for this folder)", { text: block.text, ids: block.ids });
				return 0;
			}
			case "status": {
				const s = slug();
				const loaded = store.load(mem.root);
				const counts: Record<string, number> = {};
				for (const m of loaded.memories) {
					const k = m.state === "active" ? m.scope : m.state;
					counts[k] = (counts[k] ?? 0) + 1;
				}
				const qmd = settings.qmd === "off" ? "off" : (await mem.qmd.hasMemory()) ? "memory collection" : "no memory collection";
				const rem = settings.git ? remotes(mem.root) : [];
				const soon = review.expiringSoon(loaded.memories).length;
				const never = review.neverVerified(loaded.memories).length;
				const lines = [
					`root: ${tildePath(mem.root)}${rem.length ? `  (WARNING: git remote ${rem.join(", ")}; commits are refused)` : ""}`,
					`project: ${s ?? "(none: no git origin)"}`,
					...Object.entries(counts).map(([k, n]) => `${k}: ${n}`),
					`pins: ${store.readPins(mem.root).length}`,
					`qmd: ${qmd}`,
					`expiring within ${review.SOON_DAYS} days: ${soon}`,
					`never verified: ${never}`,
				];
				say(lines.join("\n"), { root: mem.root, project: s, counts, pins: store.readPins(mem.root).length, qmd, remotes: rem, skipped: loaded.skipped, expiringSoon: soon, neverVerified: never });
				return 0;
			}
			case "qmd": {
				if (args[0] !== "setup") throw new Usage("qmd setup is the only qmd command");
				const message = await mem.qmd.setup();
				say(message, { message });
				return 0;
			}
			default:
				throw new Usage(`unknown command ${cmd}`);
		}
	} catch (err) {
		const msg = (err as Error).message;
		if (json) io.out(JSON.stringify({ ok: false, error: msg }));
		else io.err(`pi-memory: ${msg}`);
		if (err instanceof Usage) {
			if (!json) io.err(HELP);
			return 2;
		}
		return 1;
	}
}
