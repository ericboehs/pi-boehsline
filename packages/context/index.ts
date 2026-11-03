/**
 * pi-context — a `/context` command for pi.
 *
 * Shows what is consuming your context window, broken down by:
 *   - Tool schemas (grouped by the extension/package that registered them)
 *   - System prompt text (base prompt + guidelines + tool one-liners + pi docs)
 *   - Context files (AGENTS.md / CLAUDE.md), per file when expanded
 *   - Skills listing, per skill when expanded
 *   - Conversation (messages)
 *
 * Expanding (Ctrl+O) also lists extensions that are loaded but cost no context
 * (they register commands/hooks but no tool schemas).
 *
 * The report renders in the transcript via a custom entry, so it is durable and
 * is NEVER sent to the LLM (it does not add to your context).
 *
 * Token counts use a fast local estimator. When pi has a measured context total
 * available (`ctx.getContextUsage()`), the per-section estimates are calibrated
 * so they reconcile to that real number.
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { registerSelfCompact } from "./self-compact.ts";

// Base characters-per-token divisors used only for a model we've never measured.
// A single divisor can't fit every tokenizer (Claude counts denser than GPT),
// so these are a neutral middle ground. Once pi reports a measured total for a
// model, pi-context learns that model's calibration scale and reuses it on
// future pre-response reports (see calibration cache below). Both overridable.
const CPT_PROSE = Number(process.env.PI_CONTEXT_CPT_PROSE) || 3.6;
const CPT_JSON = Number(process.env.PI_CONTEXT_CPT_JSON) || 3.0;

// Persisted per-model calibration: { "provider/model": scale }. Lets a
// pre-response /context reuse the scale learned from a prior measured session.
const CALIB_PATH = join(homedir(), ".pi-context", "calibration.json");

function loadCalibration(): Record<string, number> {
	try {
		return JSON.parse(readFileSync(CALIB_PATH, "utf8")) as Record<string, number>;
	} catch {
		return {};
	}
}

function saveCalibration(data: Record<string, number>): void {
	try {
		mkdirSync(dirname(CALIB_PATH), { recursive: true });
		writeFileSync(CALIB_PATH, JSON.stringify(data, null, 2));
	} catch {
		/* read-only fs: calibration just won't persist */
	}
}

const ENTRY_TYPE = "context-report";

interface ToolStat {
	name: string;
	tokens: number;
}

interface GroupStat {
	label: string;
	source: string;
	tokens: number;
	count: number;
	commands: number;
	tools: ToolStat[];
}

interface SkillStat {
	name: string;
	origin: string;
	tokens: number;
}

interface FileStat {
	path: string;
	tokens: number;
}

interface ContextReport {
	model: string;
	contextWindow: number;
	realTokens: number | null;
	// "measured" = reconciled to pi's live total; "learned" = scaled by a saved
	// per-model calibration; "raw" = neutral estimate for an unseen model.
	source: "measured" | "learned" | "raw";
	// Section totals (already calibrated when calibrated === true).
	toolsTotal: number;
	systemBase: number;
	contextFiles: number;
	skills: number;
	conversation: number;
	overhead: number; // system + tools (everything that isn't conversation)
	total: number; // grand total shown in the header
	groups: GroupStat[];
	/** Loaded extensions that register no tool schemas (zero context cost). */
	freeExtensions: Array<{ label: string; commands: number }>;
	skillList: SkillStat[];
	/** Skills-block tokens not attributable to an individual skill (wrapper tags). */
	skillsOverhead: number;
	contextFileList: FileStat[];
	generatedAt: number;
}

function estTokens(text: string, cpt: number): number {
	if (!text) return 0;
	return Math.ceil(text.length / cpt);
}

/**
 * Human name for whatever registered a tool/command.
 *
 * Packages carry their name in `source` (npm:… / git:…). Loose extension files
 * only say "auto" or "local", which would collapse every hand-written extension
 * into one meaningless group — so those fall back to the file name.
 */
function friendlyLabel(info: { source?: string; path?: string } | undefined): string {
	const source = info?.source;
	if (!source || source === "builtin") return "pi core (built-in)";
	if (source === "sdk") return "sdk (host app)";
	let m = source.match(/^npm:(@?[^@]+?)(?:@[^@]*)?$/);
	if (m) return m[1];
	m = source.match(/^git:.*?\/([^/@]+?)(?:@[^@]*)?$/);
	if (m) return m[1];
	const path = info?.path;
	if (path && !path.startsWith("<")) return basename(path).replace(/\.[cm]?[jt]sx?$/, "");
	if (path) return path.replace(/^<|>$/g, "");
	return source;
}

function shortPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Where a skill came from. Package skills use the package name; loose skills use
 * the directory that owns the `skills/` folder (a plugin name, usually), since
 * every skill file is just called SKILL.md.
 */
function skillOrigin(info: { source?: string; path?: string } | undefined): string {
	const source = info?.source ?? "";
	let m = source.match(/^npm:(@?[^@]+?)(?:@[^@]*)?$/);
	if (m) return m[1];
	m = source.match(/^git:.*?\/([^/@]+?)(?:@[^@]*)?$/);
	if (m) return m[1];
	const path = info?.path ?? "";
	const parts = path.split("/");
	const idx = parts.lastIndexOf("skills");
	if (idx > 0) return parts[idx - 1].replace(/^\./, "");
	return "";
}

function extractAll(text: string, re: RegExp): string {
	const matches = text.match(re);
	return matches ? matches.join("\n") : "";
}

function buildReport(pi: ExtensionAPI, ctx: any): ContextReport {
	const systemPrompt: string = ctx.getSystemPrompt?.() ?? "";
	const opts = ctx.getSystemPromptOptions?.() ?? {};

	const activeNames = new Set<string>(pi.getActiveTools?.() ?? []);
	const allTools: ToolInfo[] = (pi.getAllTools?.() ?? []).filter((t: ToolInfo) =>
		activeNames.size === 0 ? true : activeNames.has(t.name),
	);

	// --- Tool schemas, grouped by originating source ---
	const groupMap = new Map<string, GroupStat>();
	let toolsTotalRaw = 0;
	for (const t of allTools) {
		const schema = JSON.stringify({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		});
		const tok = estTokens(schema, CPT_JSON);
		toolsTotalRaw += tok;
		const source = t.sourceInfo?.source ?? "unknown";
		const label = friendlyLabel(t.sourceInfo);
		let g = groupMap.get(label);
		if (!g) {
			g = { label, source, tokens: 0, count: 0, commands: 0, tools: [] };
			groupMap.set(label, g);
		}
		g.tokens += tok;
		g.count += 1;
		g.tools.push({ name: t.name, tokens: tok });
	}

	// --- Extensions that registered commands (some register no tools at all) ---
	const skillSourceByName = new Map<string, string>();
	for (const c of (pi.getCommands?.() ?? []) as Array<{
		name: string;
		source?: string;
		sourceInfo?: { source?: string; path?: string };
	}>) {
		if (c.source === "skill") {
			skillSourceByName.set(c.name.replace(/^skill:/, ""), skillOrigin(c.sourceInfo));
			continue;
		}
		if (c.source && c.source !== "extension") continue; // prompt templates aren't extensions
		const label = friendlyLabel(c.sourceInfo);
		let g = groupMap.get(label);
		if (!g) {
			g = {
				label,
				source: c.sourceInfo?.source ?? "unknown",
				tokens: 0,
				count: 0,
				commands: 0,
				tools: [],
			};
			groupMap.set(label, g);
		}
		g.commands += 1;
	}

	// --- System prompt text sections ---
	const contextFileEntries: Array<{ path: string; content: string }> = opts.contextFiles ?? [];
	const contextFilesText = contextFileEntries.map((f) => f.content ?? "").join("\n");
	const contextFilesRaw = estTokens(contextFilesText, CPT_PROSE);
	const contextFileListRaw: FileStat[] = contextFileEntries.map((f) => ({
		path: shortPath(f.path ?? "(unknown)"),
		tokens: estTokens(f.content ?? "", CPT_PROSE),
	}));

	const skillsBlock = extractAll(systemPrompt, /<available_skills>[\s\S]*?<\/available_skills>/g);
	const skillsRaw = estTokens(skillsBlock, CPT_PROSE);

	// Per-skill breakdown: each <skill> element as it appears in the prompt.
	const skillListRaw: SkillStat[] = [];
	let skillItemsRaw = 0;
	for (const m of skillsBlock.matchAll(/[ \t]*<skill>[\s\S]*?<\/skill>\n?/g)) {
		const text = m[0];
		const name = /<name>([\s\S]*?)<\/name>/.exec(text)?.[1]?.trim() ?? "(unnamed)";
		const tok = estTokens(text, CPT_PROSE);
		skillItemsRaw += tok;
		skillListRaw.push({
			name,
			origin: (() => {
				const o = skillSourceByName.get(name) ?? "";
				return o === name ? "" : o; // don't repeat the name back at the reader
			})(),
			tokens: tok,
		});
	}
	const skillsOverheadRaw = Math.max(0, skillsRaw - skillItemsRaw);

	const systemTotalRaw = estTokens(systemPrompt, CPT_PROSE);
	// Base = everything in the system prompt string that isn't a context file or
	// the skills listing (base prompt + guidelines + tool one-liners + pi docs).
	const systemBaseRaw = Math.max(0, systemTotalRaw - contextFilesRaw - skillsRaw);

	// --- Conversation (messages) ---
	let conversationRaw = 0;
	try {
		const sm = ctx.sessionManager;
		const entries: any[] = sm?.buildContextEntries?.() ?? sm?.getBranch?.() ?? [];
		for (const e of entries) {
			const msg = e?.message ?? e;
			if (!msg) continue;
			const content = msg.content;
			if (typeof content === "string") conversationRaw += estTokens(content, CPT_PROSE);
			else if (content != null) conversationRaw += estTokens(JSON.stringify(content), CPT_PROSE);
		}
	} catch {
		/* best effort */
	}

	// --- Calibrate to pi's measured total when available ---
	const usage = ctx.getContextUsage?.();
	const realTokens: number | null = usage?.tokens ?? null;
	const contextWindow: number = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

	const rawTotal =
		systemBaseRaw + contextFilesRaw + skillsRaw + toolsTotalRaw + conversationRaw;
	const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
	const calib = loadCalibration();

	let scale = 1;
	let source: "measured" | "learned" | "raw" = "raw";
	if (realTokens && rawTotal > 0) {
		// Live measured total: reconcile exactly and remember this model's scale
		// (exponential smoothing so one odd turn doesn't dominate).
		scale = realTokens / rawTotal;
		source = "measured";
		const prior = calib[modelKey];
		calib[modelKey] = prior ? prior * 0.6 + scale * 0.4 : scale;
		saveCalibration(calib);
	} else if (calib[modelKey] && rawTotal > 0) {
		// No live total yet, but we've measured this model before.
		scale = calib[modelKey];
		source = "learned";
	}
	const calibrated = source === "measured";

	const s = (n: number) => Math.round(n * scale);

	const allGroups: GroupStat[] = [...groupMap.values()]
		.map((g) => ({
			...g,
			tokens: s(g.tokens),
			tools: g.tools.map((t) => ({ name: t.name, tokens: s(t.tokens) })).sort((a, b) => b.tokens - a.tokens),
		}))
		.sort((a, b) => b.tokens - a.tokens);
	const groups = allGroups.filter((g) => g.count > 0);
	const freeExtensions = allGroups
		.filter((g) => g.count === 0)
		.map((g) => ({ label: g.label, commands: g.commands }))
		.sort((a, b) => a.label.localeCompare(b.label));

	const skillList = skillListRaw
		.map((sk) => ({ ...sk, tokens: s(sk.tokens) }))
		.sort((a, b) => b.tokens - a.tokens);
	const contextFileList = contextFileListRaw
		.map((f) => ({ ...f, tokens: s(f.tokens) }))
		.sort((a, b) => b.tokens - a.tokens);

	const toolsTotal = s(toolsTotalRaw);
	const systemBase = s(systemBaseRaw);
	const contextFiles = s(contextFilesRaw);
	const skills = s(skillsRaw);
	const conversation = s(conversationRaw);
	const overhead = toolsTotal + systemBase + contextFiles + skills;
	const total = calibrated ? (realTokens as number) : overhead + conversation;

	return {
		model: modelKey,
		contextWindow,
		realTokens,
		source,
		toolsTotal,
		systemBase,
		contextFiles,
		skills,
		conversation,
		overhead,
		total,
		groups,
		freeExtensions,
		skillList,
		skillsOverhead: s(skillsOverheadRaw),
		contextFileList,
		generatedAt: Date.now(),
	};
}

// ---------- rendering ----------

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Pad or ellipsize so a label always occupies exactly `width` cells. */
function fit(s: string, width: number): string {
	if (s.length <= width) return pad(s, width);
	return width <= 1 ? s.slice(0, width) : `${s.slice(0, width - 1)}\u2026`;
}

/** Ellipsize a path from the front so the file name stays visible. */
function fitPath(p: string, width: number): string {
	if (p.length <= width) return p;
	return `\u2026${p.slice(p.length - (width - 1))}`;
}

function padLeft(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function bar(fraction: number, width = 12): string {
	const clamped = Math.max(0, Math.min(1, fraction || 0));
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function humanTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Column layout (monospace character cells).
const LABEL_W = 28;
const COUNT_W = 3;
const TOK_W = 8;
const BAR_W = 12;
const PCT_W = 5;
const LINE_W = LABEL_W + COUNT_W + TOK_W + 2 + BAR_W + PCT_W;

export default function (pi: ExtensionAPI) {
	registerSelfCompact(pi);

	pi.registerEntryRenderer<ContextReport>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const r = entry.data;
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		if (!r) {
			box.addChild(new Text(theme.fg("error", "No context data."), 0, 0));
			return box;
		}

		const line = (t: string) => box.addChild(new Text(t, 0, 0));
		const spacer = () => box.addChild(new Text(" ", 0, 0));
		const denom = r.total || 1;

		// Bars scale to the largest single data row so the biggest one fills.
		let maxRow = 1;
		for (const g of r.groups) maxRow = Math.max(maxRow, g.tokens);
		maxRow = Math.max(maxRow, r.systemBase, r.contextFiles, r.skills, r.conversation);

		// Build each row as plain, width-exact text, then colorize whole segments
		// so ANSI codes never throw off column alignment.
		const dataRow = (
			label: string,
			tokens: number,
			opts: { indent?: number; count?: number; color?: Parameters<typeof theme.fg>[0] } = {},
		) => {
			const lbl = fit(" ".repeat(opts.indent ?? 0) + label, LABEL_W);
			const cnt = padLeft(opts.count != null ? String(opts.count) : "", COUNT_W);
			const tok = padLeft(fmt(tokens), TOK_W);
			const b = bar(tokens / maxRow, BAR_W);
			const p = padLeft(`${Math.round((tokens / denom) * 100)}%`, PCT_W);
			const head = `${lbl}${cnt}${tok}`;
			line(`${opts.color ? theme.fg(opts.color, head) : head} ${theme.fg("dim", b)} ${theme.fg("dim", p)}`);
		};

		const sectionHeader = (title: string, subtotal: number) => {
			const left = pad(title, LABEL_W + COUNT_W);
			line(theme.bold(theme.fg("accent", `${left}${padLeft(fmt(subtotal), TOK_W)}`)));
		};

		// Dim, comma-joined list wrapped to the report width (used for zero-cost rows).
		const wrappedList = (items: string[], indent: number) => {
			const prefix = " ".repeat(indent);
			const width = Math.max(20, LINE_W - indent);
			let cur = "";
			for (const item of items) {
				const next = cur ? `${cur}, ${item}` : item;
				if (next.length > width && cur) {
					line(theme.fg("dim", `${prefix + cur},`));
					cur = item;
				} else {
					cur = next;
				}
			}
			if (cur) line(theme.fg("dim", prefix + cur));
		};

		// ---- Header ----
		const winPct = r.contextWindow ? `${((r.total / r.contextWindow) * 100).toFixed(1)}%` : "?";
		line(
			`${theme.bold(theme.fg("accent", "/context"))}  ${theme.bold(fmt(r.total))} tokens  ` +
				`${theme.fg("dim", `· ${winPct} of ${humanTokens(r.contextWindow)}`)}`,
		);
		const sourceNote =
			r.source === "measured"
				? "calibrated to measured total"
				: r.source === "learned"
					? "estimated (saved calibration for this model)"
					: "estimated (pre-response)";
		line(theme.fg("dim", `${r.model}  ·  ${sourceNote}`));
		spacer();

		// ---- Tool schemas ----
		sectionHeader("TOOL SCHEMAS", r.toolsTotal);
		for (const g of r.groups) {
			dataRow(g.label, g.tokens, { indent: 1, count: g.count, color: "accent" });
			if (expanded) for (const t of g.tools) dataRow(t.name, t.tokens, { indent: 3 });
		}
		if (expanded && r.freeExtensions?.length) {
			line(theme.fg("dim", " other extensions loaded (no tool schemas, 0 tokens):"));
			wrappedList(
				r.freeExtensions.map((e) => (e.commands ? `${e.label} (${e.commands})` : e.label)),
				3,
			);
		}
		spacer();

		// ---- System prompt & resources ----
		sectionHeader("SYSTEM PROMPT", r.systemBase + r.contextFiles + r.skills);
		dataRow("base + guidelines + docs", r.systemBase, { indent: 1 });
		dataRow("context files", r.contextFiles, {
			indent: 1,
			count: r.contextFileList?.length,
			color: expanded && r.contextFileList?.length ? "accent" : undefined,
		});
		if (expanded)
			for (const f of r.contextFileList ?? [])
				dataRow(fitPath(f.path, LABEL_W - 3), f.tokens, { indent: 3 });
		dataRow("skills listing", r.skills, {
			indent: 1,
			count: r.skillList?.length,
			color: expanded && r.skillList?.length ? "accent" : undefined,
		});
		if (expanded) {
			for (const sk of r.skillList ?? []) {
				const withOrigin = sk.origin ? `${sk.name} · ${sk.origin}` : sk.name;
				// Truncating the origin off is noise; drop it entirely when it won't fit.
				dataRow(withOrigin.length > LABEL_W - 3 ? sk.name : withOrigin, sk.tokens, { indent: 3 });
			}
			if (r.skillsOverhead) dataRow("(listing wrapper)", r.skillsOverhead, { indent: 3 });
		}
		spacer();

		// ---- Conversation ----
		sectionHeader("CONVERSATION", r.conversation);
		dataRow("messages", r.conversation, { indent: 1 });
		spacer();

		// ---- Total ----
		line(theme.fg("dim", "─".repeat(LINE_W)));
		const totLbl = pad("TOTAL", LABEL_W + COUNT_W);
		line(
			theme.bold(theme.fg("success", `${totLbl}${padLeft(fmt(r.total), TOK_W)}`)) +
				theme.fg("dim", `  ${winPct} of window`),
		);
		spacer();
		line(
			theme.fg(
				"dim",
				expanded
					? "Local estimate · per-item detail shown (Ctrl+O to collapse) · not sent to the LLM"
					: "Local estimate · press Ctrl+O for per-tool/skill detail · not sent to the LLM",
			),
		);

		return box;
	});

	pi.registerCommand("context", {
		description: "Show what's using your context window (system prompt, tools, files, skills)",
		handler: async (_args, ctx) => {
			try {
				const report = buildReport(pi, ctx);
				if (process.env.PI_CONTEXT_DEBUG) {
					console.error("[pi-context] " + JSON.stringify(report, null, 2));
				}
				if (ctx.mode === "tui") {
					pi.appendEntry<ContextReport>(ENTRY_TYPE, report);
				} else {
					// Non-interactive fallback: compact one-liner.
					ctx.ui.notify(
						`context: ${fmt(report.total)} tokens · tools ${fmt(report.toolsTotal)} · ` +
							`system ${fmt(report.systemBase + report.contextFiles + report.skills)} · ` +
							`conversation ${fmt(report.conversation)}`,
						"info",
					);
				}
			} catch (err) {
				ctx.ui.notify(`/context failed: ${(err as Error).message}`, "error");
			}
		},
	});
}
