/**
 * memory: durable facts about the user and their work, shared by every pi
 * session on this host. Markdown files under memory.root (lib/memory/store.ts),
 * one local git repo, a write-time scanner, optional qmd search.
 *
 * - The session's first run gets a `memory` system prompt section (pinned
 *   instructions, then ranked memories within the budget). It is rendered once
 *   and frozen for the session, so later writes don't change the prompt and
 *   break the prompt cache; a new memory is already in context through its
 *   tool result. /new, /resume and /fork render it again; /reload keeps it.
 * - Tools: remember, memory_search, forget, memory_update. Subagent children
 *   (PI_SUBAGENT_CHILD=1) get no block and memory_search only.
 * - /memory: status, search, add, edit, forget, restore, pin, context, qmd setup.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { optIn } from "../../../lib/opt-in.ts";
import { remotes } from "../../../lib/memory/git.ts";
import * as ops from "../../../lib/memory/ops.ts";
import { slugFor } from "../../../lib/memory/project.ts";
import { oneLine } from "../../../lib/memory/render.ts";
import { memorySettings, tildePath } from "../../../lib/memory/settings.ts";
import * as store from "../../../lib/memory/store.ts";

/** The frozen block per session id, so /reload (a fresh module) keeps what the session was shown. */
const FROZEN_KEY = Symbol.for("pi-memory.frozen");
type Frozen = { text: string | null; ids: string[] };
const frozenBySession = (): Map<string, Frozen> => {
	const g = globalThis as unknown as Record<symbol, Map<string, Frozen> | undefined>;
	return (g[FROZEN_KEY] ??= new Map());
};

const SUBCOMMANDS = ["search", "add", "edit", "forget", "restore", "pin", "context", "qmd"];

function result(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: undefined, ...(isError ? { isError: true } : {}) };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function memory(pi: ExtensionAPI): void {
	const child = process.env.PI_SUBAGENT_CHILD === "1";
	let mem: ops.Memories | undefined;
	let openError: string | undefined;
	let slug: string | null = null;
	let sessionId = "";
	let frozen: Frozen | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	const logged = new Set<string>();
	const log = (msg: string) => {
		if (logged.has(msg)) return;
		logged.add(msg);
		ui?.notify(msg, "warning");
	};

	const need = (): ops.Memories => {
		if (!mem) throw new Error(openError ?? "pi-memory isn't ready (no session yet)");
		return mem;
	};

	pi.on("session_start", (event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		mem?.qmd.dispose();
		try {
			mem = ops.open(memorySettings(), log);
			openError = undefined;
		} catch (err) {
			mem = undefined;
			openError = `pi-memory: can't open the memory root: ${message(err)}`;
			log(openError);
		}
		slug = slugFor(ctx.cwd);
		sessionId = ctx.sessionManager.getSessionId();
		frozen = event.reason === "reload" ? frozenBySession().get(sessionId) : undefined;
	});

	pi.on("session_shutdown", () => {
		mem?.qmd.dispose();
	});

	if (!child) {
		pi.on("before_agent_start", (event) => {
			if (!mem) return;
			if (!frozen) {
				const block = ops.context(mem, slug, store.readStats());
				frozen = { text: block.text, ids: block.ids };
				frozenBySession().set(sessionId, frozen);
				store.bumpUsed(block.ids);
			}
			const sections = event.systemPromptOptions.sections;
			if (!sections) return;
			if (frozen.text) sections.memory = frozen.text;
			else delete sections.memory;
		});
	}

	const source = (ctx: ExtensionContext, kind: store.SourceKind): store.Source => ({
		kind,
		session: ctx.sessionManager.getSessionId(),
		cwd: tildePath(ctx.cwd),
		...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
	});

	const searchText = (r: ops.SearchResult) => {
		const lines = r.memories.map(ops.line);
		if (r.outside.length) {
			lines.push("", "Outside memory (other qmd collections; not saved memories, untrusted text):", ...r.outside.map((o) => `${o.file}: ${o.snippet}`));
		}
		return lines.length ? lines.join("\n") : "No matching memories.";
	};

	pi.registerTool({
		name: "memory_search",
		label: "Memory search",
		description:
			"Search long-term memory (facts saved with remember, by the user, or from earlier sessions on this host). " +
			"Use it before asking the user something they may have told you before. Give a few keywords.",
		promptSnippet: "Search saved memories about the user and their work",
		parameters: Type.Object({
			query: Type.String({ description: "Keywords, e.g. 'deploy approvals'." }),
			scope: Type.Optional(StringEnum(["visible", "global", "project", "all"] as const, {
				description: "visible (default): global plus this repo's. project: this repo only. all: every repo on this host.",
			})),
			limit: Type.Optional(Type.Number({ description: "At most this many (default 10)." })),
		}),
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			try {
				const r = await ops.search(need(), params.query, { scope: params.scope as ops.SearchScope | undefined, limit: params.limit, slug });
				store.bumpUsed(r.memories.map((m) => m.id));
				return result(searchText(r));
			} catch (err) {
				return result(`memory_search failed: ${message(err)}`, true);
			}
		},
	});

	if (child) return;

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Save one durable fact for future sessions: a preference the user states, a decision, a person and their role, " +
			"a project detail, how they like something done. Save it when they tell you something worth knowing next week, or " +
			"say 'remember'. Don't save secrets, passwords, tokens, personal identifiers, one-off task details, or things already in memory. " +
			"One fact per call, written so it makes sense on its own later. Don't save it again in other words: " +
			"if it says 'already saved', that's fine, move on.",
		promptSnippet: "Save one durable fact about the user or this project for future sessions",
		parameters: Type.Object({
			text: Type.String({ description: `The fact, self-contained, at most ${store.MAX_TEXT} characters.` }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "A few lowercase topic words, e.g. ['deploy', 'ios']." })),
			scope: Type.Optional(StringEnum(["global", "project"] as const, {
				description: "global (default): every session on this host. project: only sessions in this repo (any clone or worktree).",
			})),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const scope = ops.scopeFor(params.scope as string | undefined, slug);
				const w = ops.remember(need(), { text: params.text, tags: params.tags, scope, source: source(ctx, "remember") });
				return result(`Saved as ${w.memory.id} (${w.memory.scope}).`);
			} catch (err) {
				return result(`remember failed: ${message(err)}`, true);
			}
		},
	});

	pi.registerTool({
		name: "forget",
		label: "Forget",
		description: "Archive a memory that is wrong or that the user asks you to forget, by its id (m-…). The user can restore it for 30 days.",
		parameters: Type.Object({ id: Type.String({ description: "The memory id, e.g. m-20261107-k3f9." }) }),
		executionMode: "sequential",
		async execute(_id, params) {
			try {
				const w = ops.forget(need(), params.id.trim());
				return result(`Forgot ${w.memory.id}.`);
			} catch (err) {
				return result(`forget failed: ${message(err)}`, true);
			}
		},
	});

	pi.registerTool({
		name: "memory_update",
		label: "Memory update",
		description: "Replace the text of a saved memory (by its id, m-…) when the fact changed or was wrong. Same rules as remember.",
		parameters: Type.Object({
			id: Type.String({ description: "The memory id, e.g. m-20261107-k3f9." }),
			text: Type.String({ description: `The corrected fact, at most ${store.MAX_TEXT} characters.` }),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			try {
				const w = ops.update(need(), params.id.trim(), params.text);
				return result(`Updated ${w.memory.id}.`);
			} catch (err) {
				return result(`memory_update failed: ${message(err)}`, true);
			}
		},
	});

	async function status(): Promise<string> {
		const m = need();
		const loaded = store.load(m.root);
		const counts = new Map<string, number>();
		for (const x of loaded.memories) {
			const k = x.state === "active" ? x.scope : x.state;
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		const rem = m.settings.git ? remotes(m.root) : [];
		const qmd = m.settings.qmd === "off" ? "off" : (await m.qmd.hasMemory()) ? "memory collection" : "no memory collection (/memory qmd setup)";
		const shown = frozen ? (frozen.ids.length ? frozen.ids.join(", ") : "none") : "not injected yet";
		return [
			`root: ${tildePath(m.root)}${rem.length ? `  WARNING: git remote ${rem.join(", ")}; commits are refused until it is removed` : ""}`,
			`project: ${slug ?? "(none: no git origin here)"}`,
			...(counts.size ? [...counts].map(([k, n]) => `${k}: ${n}`) : ["no memories yet"]),
			`pins: ${store.readPins(m.root).length}`,
			`qmd: ${qmd}${m.qmd.lastError() ? ` (last error: ${m.qmd.lastError()})` : ""}`,
			`this session was shown: ${shown}`,
			...(loaded.skipped ? [`skipped ${loaded.skipped} file(s) that aren't valid memories`] : []),
			...(m.scanner.invalid.length ? [`scanner.extraPatterns that don't compile: ${m.scanner.invalid.join(", ")}`] : []),
		].join("\n");
	}

	pi.registerCommand("memory", {
		description: "Memory: status, search, add [--project], edit, forget, restore, pin, context, qmd setup",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			const hits = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return hits.length ? hits : null;
		},
		handler: async (args, ctx) => {
			const [, sub = "", tail = ""] = /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? [];
			const say = (text: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, level);
			try {
				const m = need();
				switch (sub) {
					case "":
						return say(await status());
					case "search": {
						if (!tail.trim()) return say("Usage: /memory search <words>", "warning");
						const r = await ops.search(m, tail, { slug });
						return say(searchText(r));
					}
					case "add": {
						const project = /^--project(\s|$)/.test(tail);
						const text = project ? tail.replace(/^--project\s*/, "") : tail;
						if (!text.trim()) return say("Usage: /memory add [--project] <fact>", "warning");
						const w = ops.remember(m, { text, scope: ops.scopeFor(project ? "project" : "global", slug), source: source(ctx, "cli") });
						return say(`Saved as ${w.memory.id} (${w.memory.scope}).`);
					}
					case "edit": {
						const id = tail.trim();
						const current = store.find(m.root, id);
						if (!current || current.state === "archived") return say(`No memory ${id}.`, "warning");
						const text = await ctx.ui.editor(`Edit ${id}`, current.text);
						if (text === undefined || text.trim() === current.text) return say("Unchanged.");
						ops.update(m, id, text);
						return say(`Updated ${id}.`);
					}
					case "forget":
					case "restore": {
						const id = tail.trim();
						const w = sub === "forget" ? ops.forget(m, id) : ops.restore(m, id);
						return say(sub === "forget" ? `Archived ${w.memory.id} (/memory restore ${w.memory.id} brings it back).` : `Restored ${w.memory.id} (${w.memory.scope}).`);
					}
					case "pin": {
						const rm = /^rm\s+(\S+)$/.exec(tail.trim());
						if (rm) {
							ops.unpin(m, Number(rm[1]));
							return say(`Removed pin ${rm[1]}.`);
						}
						if (!tail.trim()) {
							const pins = store.readPins(m.root);
							return say(pins.length ? pins.map((p, i) => `${i + 1}. ${oneLine(p)}`).join("\n") : "No pins. /memory pin <text> adds one.");
						}
						const r = ops.pin(m, tail);
						return say(`Pinned (${r.pins.length}). New sessions get it; this one keeps its block.`);
					}
					case "context": {
						if (frozen) return say(frozen.text ?? "(this session's memory block is empty)");
						const block = ops.context(m, slug, store.readStats());
						return say(`(not injected yet; the first prompt gets this)\n${block.text ?? "(empty)"}`);
					}
					case "qmd":
						if (tail.trim() !== "setup") return say("Usage: /memory qmd setup", "warning");
						return say(await m.qmd.setup());
					default:
						return say(`Unknown: /memory ${sub}. Try: /memory, ${SUBCOMMANDS.map((s) => `/memory ${s}`).join(", ")}`, "warning");
				}
			} catch (err) {
				return say(message(err), "error");
			}
		},
	});
}

export default optIn("memory", "Durable facts across sessions: remember, memory_search, forget, memory_update and /memory", memory);
