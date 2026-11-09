/**
 * A subagent task that runs in the workers VM instead of on this Mac
 * (docs/plans/sandbox-workers.md Part 1 Phase 2, in the Botsun repo).
 *
 * `sandbox: true` on the subagent call (or in an agent file's frontmatter) swaps
 * the child's invocation for Botsun's `worker exec`: the repo is copied in as one
 * tar over `limactl shell --tty=false` stdin, pi runs in the VM as the
 * unprivileged `botsun-worker` user inside a transient systemd unit with `-ne
 * -na`, and its JSONL stdout is relayed back on that host process's stdout — so
 * this extension's parser, the progress filter, the subagent row and the phone's
 * stop all work exactly as for a host child.
 *
 * The read-only tool set and the `-ne -na` flags are decided on the *host* side
 * (Botsun::WorkerRun), not here and not by an agent file: an agent file in the
 * clone, or its `.pi/settings.json`, cannot turn a tool back on.
 *
 * Phase 2 is `scout` only. `worker` — anything that could write — is refused
 * with one line until Part 1 Phase 3 lands the patch gate.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Agents Phase 2 will run sandboxed: read-only recon. */
export const SANDBOX_AGENTS = ["scout"] as const;

/** What a sandboxed run may use in the VM (kept in step with Botsun::WorkerRun). */
export const READ_ONLY_TOOLS = "read,grep,find,ls";

/** Where Botsun lives when nothing overrides it. */
export const DEFAULT_BOTSUN = join(homedir(), "Code", "github.com", "ericboehs", "botsun", "bin", "botsun");

/** Botsun's id shape for a pi child (a sandboxed run's --child). */
export const CHILD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type SandboxRequest = {
	/** The folder to copy in: a git repo (or a subdirectory of one). */
	cwd: string;
	/** The task text, as the child's final user turn. */
	task: string;
	/** The agent's system prompt (already wrapped with the child preamble). */
	prompt: string;
	/** Agent name, checked against SANDBOX_AGENTS. */
	agent: string;
	/** The pi child this run is for (lib/children.ts trackChild's id), so the phone can show its Computer. */
	child?: string;
	model?: string;
	/** This pi's version, so the VM's pi can be checked against it. */
	version?: string;
};

export type Invocation = { cmd: string; args: string[] };

/**
 * A sandboxed task whose agent runs on a path other than this VM's pi (a cursor
 * agent, or any agent file with `runner: cursor`): there is no VM side to such an
 * agent, so the task is refused with one line rather than run unsandboxed on the
 * Mac — a request for the sandbox must never quietly become a Mac run.
 */
export function unsandboxable(agent: string): string {
	return `sandbox: true runs the VM's pi, and "${agent}" runs Cursor on this Mac instead. Drop sandbox for that agent, or ask for a scout.`;
}

/** Where the Botsun CLI is: $BOTSUN_BIN, then the checkout, then PATH's `botsun`. */
export function sandboxBin(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
	const explicit = env.BOTSUN_BIN?.trim();
	if (explicit) return explicit;
	if (exists(DEFAULT_BOTSUN)) return DEFAULT_BOTSUN;
	return "botsun";
}

/**
 * The host command that runs one sandboxed task. Returns {error} (one line, no
 * child) for a refusal, so the task fails on its own instead of taking the call
 * down: no Mac fallback, ever.
 */
export function sandboxInvocation(req: SandboxRequest, env: NodeJS.ProcessEnv = process.env): Invocation | { error: string } {
	const agent = req.agent?.trim();
	if (!agent) return { error: "sandbox: true needs an agent name (scout)." };
	if (!(SANDBOX_AGENTS as readonly string[]).includes(agent)) {
		return {
			error: `sandbox: true runs readonly agents only (${SANDBOX_AGENTS.join(", ")}): "${agent}" needs the patch gate, which lands in Part 1 Phase 3. Drop sandbox or ask for a scout.`,
		};
	}
	if (!req.cwd?.trim()) return { error: "sandbox: true needs a folder to copy in (cwd)." };
	if (!req.task?.trim()) return { error: "sandbox: true needs a task." };

	const args = ["worker", "exec", "--cwd", req.cwd, "--agent", agent, "--task", req.task];
	if (req.prompt?.trim()) args.push("--prompt", req.prompt);
	if (req.model?.trim()) args.push("--model", req.model.trim());
	if (req.version?.trim()) args.push("--pi-version", req.version.trim());
	// A bad child id is dropped, never an error: the run still happens, just without
	// a Computer row (Botsun validates the id too).
	const child = req.child?.trim();
	if (child && CHILD_ID.test(child)) args.push("--child", child);
	return { cmd: sandboxBin(env), args };
}
