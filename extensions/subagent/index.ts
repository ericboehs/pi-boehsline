/**
 * Minimal subagent tool — DIY subprocess version.
 *
 * Boot cost: near zero.
 * - One small file; its only runtime import is lib/tool-search.ts (factory only
 *   calls pi.registerTool and pi.on, no fs/process access, nothing awaited).
 * - `exposure: "deferred"`: the tool is NOT declared to the model at boot,
 *   costs ~0 tokens until the model finds it via `tool_search`
 *   (activated automatically on session_start; no settings needed).
 * - One tiny renderCall (single Text line). No Markdown/container machinery.
 * - All heavy imports (child_process, fs, agent discovery) are lazy,
 *   inside execute(), so they never touch startup time.
 *
 * Runtime: spawns an isolated `pi --mode json -p --no-session` subprocess
 * per child, with the agent's system prompt via --append-system-prompt.
 * Supports single {agent, task} and parallel {tasks: [...]} (max 8, 4 at a time).
 * Agent files: <agentDir>/agents/*.md (user, always) + .pi/agents/*.md
 * (project, only with agentScope "project"/"both"). Plus zero-setup
 * built-ins: "scout" (read-only) and "worker" (general).
 *
 * The "cursor" built-in (or an agent file with `runner: cursor`) runs Cursor's
 * agent CLI instead of a pi child, through the cursor-agent extension's own
 * run.ts and runner.ts (lazy imports): the same checks, spawn, cost lookup and
 * result block as the cursor tool, and in background the same bg job.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ChargeLookup, RunSpec, WorktreeInfo } from "../opt-in/cursor-agent/run.ts";
import { activateToolSearch } from "../../lib/tool-search.ts";

const MAX_TASKS = 8;
const CONCURRENCY = 4;
const OUTPUT_CAP = 50 * 1024; // per-task bytes visible to the parent model
const BG_WAKE_CHARS = 24 * 1024; // background: log tail carried by the bg extension's completion wake

// Background progress filter (run with `node -e`): child JSONL in, one line per
// turn out, then a result banner and the final answer. Exit 1 when there is no
// answer, so the bg extension reports the job as failed.
const PROGRESS_FILTER = `
let buf = "", turns = 0, final = "";
const u = { input: 0, cached: 0, output: 0, cost: 0 };
const short = (s, n) => { s = String(s ?? "").replace(/\\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const onLine = (line) => {
  let ev; try { ev = JSON.parse(line); } catch { return; }
  const m = ev.type === "message_end" ? ev.message : undefined;
  if (!m || m.role !== "assistant") return;
  turns++;
  const mu = m.usage ?? {};
  u.input += (mu.input ?? 0) + (mu.cacheRead ?? 0) + (mu.cacheWrite ?? 0); u.cached += mu.cacheRead ?? 0;
  u.output += mu.output ?? 0; u.cost += mu.cost?.total ?? 0;
  const calls = []; let text = "";
  for (const p of m.content ?? []) {
    if (p.type === "text" && p.text) { text = p.text; final = p.text; }
    if (p.type === "toolCall") { const a = p.arguments ?? {}; calls.push(p.name + " " + (a.command ?? a.path ?? a.pattern ?? a.url ?? "")); }
  }
  console.log("· turn " + turns + " · " + (short(calls.join(" | "), 110) || short(text, 110) || "(no text)"));
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { buf += d; const ls = buf.split("\\n"); buf = ls.pop(); for (const l of ls) if (l.trim()) onLine(l); });
process.stdin.on("end", () => {
  if (buf.trim()) onLine(buf);
  const k = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  console.log("── result · " + turns + " turns · " + k(u.input) + " in (" + k(u.cached) + " cached) / " + k(u.output) + " out" + (u.cost ? " · $" + u.cost.toFixed(4) : "") + " ──");
  console.log(final || "(no output)");
  process.exitCode = final ? 0 : 1;
});
`;

const cursorFields = {
	cursorMode: Type.Optional(
		Type.Union([Type.Literal("agent"), Type.Literal("plan"), Type.Literal("ask")], {
			description: "cursor agent only: agent (default) edits and runs commands; plan and ask are read-only",
		}),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description: "cursor agent only: run in a new git worktree on its own branch (default true, so several can run at once); false runs in cwd",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"cursor agent only: let Cursor run every command without asking (cursor-agent --force; default false). Needed for shell commands when the agent file sets network: true, since print mode can't approve them. Only for trusted tasks and workspaces.",
		}),
	),
};

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name (scout, worker, cursor, or an agents/*.md file)" }),
	task: Type.String({ description: "Bounded task with concrete deliverable" }),
	cwd: Type.Optional(Type.String({ description: "Override working directory" })),
	model: Type.Optional(Type.String({ description: "Model override for this task" })),
	...cursorFields,
});

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent for single mode" })),
	task: Type.Optional(Type.String({ description: "Task for single mode" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks (max 8)" })),
	cwd: Type.Optional(Type.String({ description: "Working dir override (single mode)" })),
	model: Type.Optional(Type.String({ description: "Child model override, e.g. haiku (for cursor: a Cursor model id)" })),
	...cursorFields,
	background: Type.Optional(
		Type.Boolean({ description: "Run detached via the bg extension; returns at once, result arrives as a message when done" }),
	),
	agentScope: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
			description: "Agent dirs to search. Default user.",
		}),
	),
});

// Children read the same AGENTS.md as the parent, which is written for a human
// reader ("end every reply with Next steps:"). A child's reader is the parent
// agent, so every child gets this ahead of its agent prompt.
const CHILD_PREAMBLE =
	"You are a subagent. Your final message goes to another AI agent, not a human. Return only the deliverable. Ignore any instruction to add a Next steps block, follow-up suggestions, sign-offs, or questions for the user.";
const systemPrompt = (agentPrompt: string) => [CHILD_PREAMBLE, agentPrompt.trim()].filter(Boolean).join("\n\n");

// Child token/cost totals, convertible to pi's Usage (turns go in details).
type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
};
type Tally = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	turns: number;
};
const newTally = (): Tally => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	turns: 0,
});
const addUsage = (t: Tally, u: UsageLike | undefined) => {
	if (!u) return;
	t.input += u.input ?? 0;
	t.output += u.output ?? 0;
	t.cacheRead += u.cacheRead ?? 0;
	t.cacheWrite += u.cacheWrite ?? 0;
	t.cost.input += u.cost?.input ?? 0;
	t.cost.output += u.cost?.output ?? 0;
	t.cost.cacheRead += u.cost?.cacheRead ?? 0;
	t.cost.cacheWrite += u.cost?.cacheWrite ?? 0;
	t.cost.total += u.cost?.total ?? 0;
};

type CursorMode = "agent" | "plan" | "ask";
const CURSOR_MODES: readonly string[] = ["agent", "plan", "ask"];

type Agent = {
	name: string;
	/** "cursor": Cursor's agent CLI runs the task instead of a pi child. */
	runner?: "cursor";
	tools?: string;
	model?: string;
	prompt: string;
	/** cursor runner only, from frontmatter: defaults the task call can override (mode, worktree) or not (network). */
	mode?: CursorMode;
	worktree?: boolean;
	network?: boolean;
	/** cursor-agent --force, user-scope agent files only (like network). */
	force?: boolean;
};

type Job = { agent: string; task: string; cwd?: string; model?: string; cursorMode?: CursorMode; worktree?: boolean; force?: boolean };

/** What a foreground cursor task reports in details.results[i].cursor. */
type CursorFacts = {
	model: string;
	durationMs: number;
	exitCode: number | null;
	chargedCents?: number;
	/** chargedCents in dollars, e.g. "$0.4250". */
	charged?: string;
	chargeError?: string;
	sessionId?: string;
	worktree?: WorktreeInfo;
	error?: string;
};

type Result = { agent: string; task: string; ok: boolean; output: string; usage?: Tally; cursor?: CursorFacts };

// Zero-setup fallback agents so the tool works before any agents/*.md exist.
const BUILTINS: Record<string, Omit<Agent, "name">> = {
	scout: {
		tools: "read,grep,find,ls,bash",
		prompt:
			"You are a read-only recon scout. Never edit files. Return: objective, relevant files with line refs, entry points, risks, where to start. Keep it under 40 lines.",
	},
	worker: {
		tools: "read,bash,edit,write,grep,find,ls",
		prompt:
			"You are a general worker. Make the requested change, verify it (build/test/lint as appropriate), and report files changed + verification output. Keep it concise.",
	},
	cursor: {
		runner: "cursor",
		prompt:
			"Do the task in this workspace with your own tools. When it asks for a change, make it and verify it (build/test/lint as appropriate). Report what you found or changed and how you verified it. Keep it concise.",
	},
};

const DESCRIPTION =
	"Delegate to an isolated fresh-context subagent (subprocess). Single {agent, task} or parallel {tasks}. Use for recon, plans, independent review, parallel exploration. scout=read-only pi, worker=edits (pi), " +
	"cursor=Cursor's agent CLI instead of pi (needs the opt-in cursor-agent extension; billed to the user's Cursor account; edits land uncommitted in a new git worktree unless worktree: false; cursorMode plan/ask is read-only). " +
	"A cursor task must be self-contained and must never contain PII, PHI, secrets or credentials.";

export interface SubagentDeps {
	/** The cursor agent's cost lookup (default: Cursor's dashboard API). */
	findCharge?: ChargeLookup;
}

export function subagentExtension(deps: SubagentDeps = {}) {
	return (pi: ExtensionAPI) => setup(pi, deps);
}

export default subagentExtension();

function setup(pi: ExtensionAPI, deps: SubagentDeps) {
	// A deferred tool is unreachable unless tool_search is active (lib/tool-search.ts).
	activateToolSearch(pi);

	register(pi, deps, DESCRIPTION);
	// The cursor-agent settings' note and rules (e.g. a work seat's data rules)
	// come from config sources that may load after this extension, so they are
	// added at session_start, as the cursor tool does.
	pi.on("session_start", async () => {
		if (process.env.PI_SUBAGENT_CHILD) return;
		const { loadSettings } = await import("../opt-in/cursor-agent/settings.ts");
		const s = loadSettings();
		const notes = [s.note, ...s.rules].filter(Boolean).join(" ");
		if (notes) register(pi, deps, `${DESCRIPTION} Cursor rules: ${notes}`);
	});
}

function register(pi: ExtensionAPI, deps: SubagentDeps, description: string) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		exposure: "deferred", // <-- the whole trick: 0 boot tokens until tool_search finds it
		description,
		parameters: Params,

		renderCall(args, theme) {
			const summary = args.tasks?.length
				? `${args.tasks.length} tasks: ${args.tasks.slice(0, 3).map((t) => t.agent).join(", ")}${args.tasks.length > 3 ? ", …" : ""}`
				: `${args.agent ?? "?"}: ${(args.task ?? "").slice(0, 60)}`;
			return new Text(theme.fg("accent", "subagent ") + theme.fg("muted", summary), 0, 0);
		},

		async execute(_id, params, signal, onUpdate, ctx) {
			const { spawn } = await import("node:child_process");
			const fs = await import("node:fs");
			const os = await import("node:os");
			const path = await import("node:path");
			const sdk = await import("@earendil-works/pi-coding-agent");
			const getAgentDir = sdk.getAgentDir as () => string;
			const parseFrontmatter = sdk.parseFrontmatter as <T>(c: string) => { frontmatter: T; body: string };
			const CONFIG = (sdk.CONFIG_DIR_NAME as string | undefined) ?? ".pi";

			const loadDir = (dir: string): Agent[] => {
				let entries: import("node:fs").Dirent[];
				try {
					entries = fs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return [];
				}
				const out: Agent[] = [];
				for (const e of entries) {
					if (!e.name.endsWith(".md") || (!e.isFile() && !e.isSymbolicLink())) continue;
					let content: string;
					try {
						content = fs.readFileSync(path.join(dir, e.name), "utf-8");
					} catch {
						continue;
					}
					try {
						const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
						if (typeof frontmatter.name !== "string") continue;
						const tools =
							typeof frontmatter.tools === "string"
								? frontmatter.tools
								: Array.isArray(frontmatter.tools)
									? (frontmatter.tools as unknown[]).filter((t): t is string => typeof t === "string").join(",")
									: undefined;
						const { mode, worktree, network, force } = frontmatter;
						out.push({
							name: frontmatter.name,
							tools,
							model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
							prompt: body,
							...(frontmatter.runner === "cursor" ? { runner: "cursor" as const } : {}),
							...(typeof mode === "string" && CURSOR_MODES.includes(mode) ? { mode: mode as CursorMode } : {}),
							...(typeof worktree === "boolean" ? { worktree } : {}),
							...(typeof network === "boolean" ? { network } : {}),
							...(typeof force === "boolean" ? { force } : {}),
						});
					} catch {
						/* skip bad file */
					}
				}
				return out;
			};

			const scope = params.agentScope ?? "user";
			const byName = new Map<string, Agent>();
			if (scope !== "project") for (const a of loadDir(path.join(getAgentDir(), "agents"))) byName.set(a.name, a);
			if (scope !== "user") {
				let dir: string | null = null;
				let cur = ctx.cwd;
				for (;;) {
					const cand = path.join(cur, CONFIG, "agents");
					try {
						if (fs.statSync(cand).isDirectory()) {
							dir = cand;
							break;
						}
					} catch {
						/* keep walking */
					}
					const parent = path.dirname(cur);
					if (parent === cur) break;
					cur = parent;
				}
				// A repo's agent file never turns Cursor's sandbox or approvals off: network and force are user-scope only.
				if (dir) for (const a of loadDir(dir)) byName.set(a.name, { ...a, network: undefined, force: undefined });
			}
			for (const [name, b] of Object.entries(BUILTINS)) if (!byName.has(name)) byName.set(name, { name, ...b });

			// Single mode's model stays params.model (below an agent file's model for pi children);
			// a per-task model wins over the agent's.
			const single: Job[] =
				params.agent && params.task
					? [{ agent: params.agent, task: params.task, cwd: params.cwd, cursorMode: params.cursorMode, worktree: params.worktree, force: params.force }]
					: [];
			const jobs = (params.tasks ?? single) as Job[];
			if (jobs.length === 0 || jobs.length > MAX_TASKS || (params.tasks && params.agent)) {
				return {
					content: [{ type: "text" as const, text: `Pass single {agent, task} or {tasks: [...]} (1-${MAX_TASKS}). Agents: ${[...byName.keys()].join(", ") || "none"}.` }],
					details: { results: [] },
				};
			}

			const defaultModel = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

			const piInvocation = (args: string[]) => {
				const currentScript = process.argv[1];
				return currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)
					? { cmd: process.execPath, args: [currentScript, ...args] }
					: { cmd: "pi", args };
			};

			// A cursor task's run, checked up front so a problem fails that task only.
			// Model: the task's, the call's, the agent file's, else the cursor-agent
			// settings default (never the parent's pi model).
			const cursorSpec = async (job: Job, agent: Agent): Promise<{ spec: RunSpec } | { error: string }> => {
				const { enabled } = await import("../../lib/config.ts");
				if (!enabled("cursor-agent")) {
					return { error: "The cursor agent needs the cursor-agent extension, which is opt-in and not enabled. Turn it on with /boehsline enable cursor-agent." };
				}
				const { binFound, prepareRun } = await import("../opt-in/cursor-agent/run.ts");
				const { loadSettings } = await import("../opt-in/cursor-agent/settings.ts");
				const mode = job.cursorMode ?? agent.mode ?? "agent";
				// Read-only modes (plan, ask) edit nothing, so they skip the worktree by default.
				const worktree = job.worktree ?? agent.worktree ?? mode === "agent";
				let spec: RunSpec;
				try {
					spec = await prepareRun(
						{
							prompt: `${systemPrompt(agent.prompt)}\n\nTask: ${job.task}`,
							model: job.model ?? params.model ?? agent.model,
							mode,
							cwd: job.cwd,
							network: agent.network,
							force: job.force ?? agent.force,
							worktree,
						},
						ctx.cwd,
						loadSettings(),
					);
				} catch (err) {
					const message = (err as Error).message;
					return { error: worktree && message.startsWith("worktree needs") ? `${message} (or pass worktree: false)` : message };
				}
				if (!binFound(spec.bin)) {
					return { error: `The cursor agent needs Cursor's CLI, and ${spec.bin} was not found. Install it from https://cursor.com/cli and run cursor-agent login.` };
				}
				return { spec };
			};

			// Background: hand each child to the bg extension as a shell job (its widget, /bg live
			// log, kill, and completion wake). The progress filter turns the child's
			// JSONL into one line per turn plus the final answer, so the log is
			// readable live and the wake tail ends with the actual result. A cursor
			// task's job is the cursor tool's runner, whose log ends with its result block.
			if (params.background) {
				const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
				const noBg = {
					content: [{ type: "text" as const, text: "background needs the bg extension (extensions/bg), which is not loaded. Rerun without background." }],
					details: { results: [] },
				};
				const lines: string[] = [];
				for (const job of jobs) {
					const agent = byName.get(job.agent);
					if (!agent) {
						lines.push(`[${job.agent}] unknown agent. Available: ${[...byName.keys()].join(", ")}.`);
						continue;
					}
					if (agent.runner === "cursor") {
						const prep = await cursorSpec(job, agent);
						if ("error" in prep) {
							lines.push(`[${job.agent}] ${prep.error}`);
							continue;
						}
						const { startJob } = await import("../opt-in/cursor-agent/runner.ts");
						const reply = await startJob(pi.events, prep.spec, { ctx, name: `sa:${job.agent}`, summary: `subagent ${job.agent}: ${job.task}` });
						if (reply === null) return noBg;
						const where = prep.spec.worktree ? "new worktree" : prep.spec.cwd;
						lines.push("error" in reply ? `[${job.agent}] failed: ${reply.error}` : `[${job.agent}] bg ${reply.id} · log ${reply.logPath} · ${prep.spec.model} · ${where}`);
						continue;
					}
					const args = ["--mode", "json", "-p", "--no-session"];
					const model = job.model ?? agent.model ?? defaultModel;
					if (model) args.push("--model", model);
					if (agent.tools) args.push("--tools", agent.tools);
					args.push("--append-system-prompt", systemPrompt(agent.prompt)); // accepts text or path
					args.push(`Task: ${job.task}`);
					const inv = piInvocation(args);
					const command = `PI_SUBAGENT_CHILD=1 ${[inv.cmd, ...inv.args].map(q).join(" ")} | ${q(process.execPath)} -e ${q(PROGRESS_FILTER)}`;
					const reply = await new Promise<{ id: string; logPath: string } | { error: string } | null>((resolve) => {
						const req = {
							command,
							cwd: job.cwd ?? ctx.cwd,
							ctx,
							name: `sa:${job.agent}`,
							summary: `subagent ${job.agent}: ${job.task}`,
							tailLines: 1000,
							tailMaxChars: BG_WAKE_CHARS,
							accepted: false,
							reply: resolve,
						};
						pi.events.emit("bg:start", req);
						if (!req.accepted) resolve(null); // no listener: the bg extension isn't loaded
					});
					if (reply === null) return noBg;
					lines.push("error" in reply ? `[${job.agent}] failed: ${reply.error}` : `[${job.agent}] bg ${reply.id} · log ${reply.logPath}`);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Started in background:\n${lines.join("\n")}\nEach result arrives as a message when its child finishes. /bg watches or stops them.`,
						},
					],
					details: { results: [], background: true },
				};
			}

			// Live progress for the TUI + `tool_execution_update` JSONL events. Child
			// message_end events arrive per turn (not per token), so emitting here
			// is naturally low-volume — no throttling needed. Cursor streams partial
			// output, so its updates are throttled like the cursor tool's.
			type JobStatus = { agent: string; progress: string; preview: string };
			const status: JobStatus[] = jobs.map((j) => ({
				agent: j.agent,
				progress: byName.get(j.agent)?.runner === "cursor" ? "step 0" : "turn 0",
				preview: "starting…",
			}));
			let completed = 0;
			const previewOf = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
			const emit = () => {
				if (!onUpdate) return;
				const lines = status.map((s) => `▶ ${s.agent} · ${s.progress}\n${previewOf(s.preview)}`);
				onUpdate({
					content: [{ type: "text" as const, text: `subagent ${completed}/${jobs.length} done\n\n${lines.join("\n\n")}` }],
					details: { running: true, done: completed, total: jobs.length },
				});
			};
			const capped = (out: string) => {
				const over = Buffer.byteLength(out) - OUTPUT_CAP;
				return over > 0 ? `${out.slice(0, OUTPUT_CAP)}\n\n[${over} bytes over cap omitted]` : out;
			};

			// Foreground cursor task: the output is the result block the cursor
			// runner prints in background (answer in full, the cap applies).
			const runCursorJob = async (job: Job, agent: Agent, index: number): Promise<Result> => {
				const prep = await cursorSpec(job, agent);
				if ("error" in prep) return { agent: job.agent, task: job.task, ok: false, output: prep.error };
				const { spec } = prep;
				let runner: typeof import("../opt-in/cursor-agent/runner.ts");
				let api: typeof import("../opt-in/cursor-agent/api.ts");
				try {
					runner = await import("../opt-in/cursor-agent/runner.ts");
					api = await import("../opt-in/cursor-agent/api.ts");
				} catch (e) {
					return { agent: job.agent, task: job.task, ok: false, output: `Could not load the cursor runner: ${(e as Error).message}` };
				}
				const { resultBlock, runAndCharge } = runner;
				const { dollars } = api;
				let lastEmit = 0;
				let r: Awaited<ReturnType<typeof runAndCharge>>;
				try {
					r = await runAndCharge(spec, {
						signal,
						findCharge: deps.findCharge,
						onEvent: (run, changed) => {
							const now = Date.now();
							if (!changed && now - lastEmit < 150) return;
							lastEmit = now;
							const s = run.state;
							status[index] = { agent: job.agent, progress: `step ${s.tools.length}`, preview: s.live || s.tools.at(-1)?.summary || "(working…)" };
							emit();
						},
					});
				} catch (err) {
					return { agent: job.agent, task: job.task, ok: false, output: `could not start Cursor: ${(err as Error).message}` };
				}
				const { outcome, charge, chargeError } = r;
				const failed = outcome.exitCode !== 0 || r.stopped || !!outcome.refused;
				const cursor: CursorFacts = {
					model: spec.model,
					durationMs: outcome.durationMs,
					exitCode: outcome.exitCode,
					...(charge ? { chargedCents: charge.chargedCents ?? 0, charged: dollars(charge.chargedCents ?? 0) } : {}),
					...(chargeError ? { chargeError } : {}),
					...(outcome.state.sessionId ? { sessionId: outcome.state.sessionId } : {}),
					...(outcome.worktree ? { worktree: outcome.worktree } : {}),
					...(failed
						? { error: outcome.refused || outcome.stderr || (r.stopped ? "stopped" : `exit ${outcome.exitCode ?? "none (killed)"}`) }
						: {}),
				};
				return { agent: job.agent, task: job.task, ok: !failed, output: capped(resultBlock(spec, r, Infinity).join("\n")), cursor };
			};

			const runOne = async (job: Job, index: number): Promise<Result> => {
				const agent = byName.get(job.agent);
				if (!agent) return { agent: job.agent, task: job.task, ok: false, output: `Unknown agent "${job.agent}". Available: ${[...byName.keys()].join(", ")}.` };
				if (agent.runner === "cursor") return runCursorJob(job, agent, index);
				const args = ["--mode", "json", "-p", "--no-session"];
				const model = job.model ?? agent.model ?? defaultModel;
				if (model) args.push("--model", model);
				if (agent.tools) args.push("--tools", agent.tools);
				const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
				const tmpFile = path.join(tmpDir, "system.md");
				await fs.promises.writeFile(tmpFile, systemPrompt(agent.prompt), { mode: 0o600 });
				args.push("--append-system-prompt", tmpFile);
				args.push(`Task: ${job.task}`);
				const invocation = piInvocation(args);
				try {
					const usage = newTally();
					let final = "";
					const stderr: string[] = [];
					let killedBy: string | undefined;
					let spawnError: string | undefined;
					const exitCode: number = await new Promise((resolve) => {
						const proc = spawn(invocation.cmd, invocation.args, { cwd: job.cwd ?? ctx.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_SUBAGENT_CHILD: "1" } });
						let buf = "";
						const onLine = (line: string) => {
							if (!line.trim()) return;
							let ev: { type?: string; message?: { role?: string; content?: { type: string; text?: string }[]; usage?: UsageLike } };
							try {
								ev = JSON.parse(line);
							} catch {
								return;
							}
							const m = ev.type === "message_end" ? ev.message : undefined;
							if (m?.role === "assistant") {
								usage.turns++;
								addUsage(usage, m.usage);
								for (const p of m.content ?? []) if (p.type === "text" && p.text) final = p.text;
								status[index] = { agent: job.agent, progress: `turn ${usage.turns}`, preview: final || "(working…)" };
								emit();
							}
						};
						proc.stdout.on("data", (d) => {
							buf += d.toString();
							const lines = buf.split("\n");
							buf = lines.pop() ?? "";
							for (const l of lines) onLine(l);
						});
						proc.stderr.on("data", (d) => stderr.push(d.toString()));
						proc.on("close", (c, sig) => {
							if (buf.trim()) onLine(buf);
							// A child killed by a signal has no exit code: that's a failure, not 0.
							killedBy = sig ?? undefined;
							resolve(c ?? 1);
						});
						proc.on("error", (err) => {
							spawnError = err.message;
							resolve(1);
						});
						if (signal) {
							if (signal.aborted) proc.kill("SIGTERM");
							else signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
						}
					});
					// Couldn't start, or killed mid-run (abort, OOM, timeout): not ok, even
					// with a partial reply, which is kept so the work isn't lost.
					if (spawnError || killedBy) {
						const why = spawnError ? `could not start pi: ${spawnError}` : `killed by ${killedBy}`;
						const partial = final ? `${final}\n\n` : "";
						return { agent: job.agent, task: job.task, ok: false, output: `${partial}[${why}]${stderr.length ? `\n${stderr.join("").slice(-2000)}` : ""}`, usage };
					}
					if (exitCode !== 0 && !final) return { agent: job.agent, task: job.task, ok: false, output: stderr.join("").slice(-2000) || `exit ${exitCode}`, usage };
					return { agent: job.agent, task: job.task, ok: true, output: capped(final || "(no output)"), usage };
				} finally {
					fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
				}
			};

			// concurrency-limited parallel
			const results: Result[] = new Array(jobs.length);
			let next = 0;
			emit(); // show "starting…" immediately so live watchers see the launch
			await Promise.all(
				Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
					for (;;) {
						const i = next++;
						const job = jobs[i];
						if (!job) return;
						results[i] = await runOne(job, i);
						completed++;
						emit();
					}
				}),
			);

			const okCount = results.filter((r) => r.ok).length;
			const text =
				results.length === 1
					? (results[0]?.output ?? "(no output)")
					: `${okCount}/${results.length} succeeded\n\n` +
						results.map((r) => `### [${r.agent}] ${r.ok ? "ok" : "FAILED"}\n\n${r.output}`).join("\n\n---\n\n");
			const total = newTally();
			for (const r of results) {
				if (!r.usage) continue;
				addUsage(total, r.usage);
				total.turns += r.usage.turns;
			}
			const { turns, ...tokens } = total;
			return {
				content: [{ type: "text" as const, text }],
				details: { results: results.map((r) => ({ agent: r.agent, ok: r.ok, ...(r.cursor ? { cursor: r.cursor } : {}) })), turns },
				...(turns > 0
					? { usage: { ...tokens, totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite } }
					: {}),
			};
		},
	});
}
