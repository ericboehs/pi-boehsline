# subagent

A minimal subagent tool: runs a separate `pi` process (or Cursor's agent) for a focused task and returns its answer. **Tool:** `subagent`.

- **Deferred:** the tool isn't declared to the model at startup, so it costs no context until the model finds it with `tool_search`.
- Each child is `pi --mode json -p --no-session` with the agent's prompt appended. One `{agent, task}`, or `{tasks: [...]}` in parallel (up to 8, 4 at a time). For a pi child, a task's own `model` wins over the agent file's, and the call's `model` doesn't.
- Agents: `~/.pi/agent/agents/*.md`, plus the project's `.pi/agents/*.md` when `agentScope` is `project` or `both`. Three built-ins need no setup: `scout` (read-only), `worker`, and `cursor`.
- Children set `PI_SUBAGENT_CHILD`, so a child can't spawn more children.
- `background: true` hands each child to the [bg extension](../bg/README.md) and returns at once; each result arrives as a message when its child finishes.
- Every child, foreground or background, goes on its session's subagents list (`lib/children.ts`): its agent, task, state, turns, what it is doing now, its last text and work lines, emitted as `subagents:update` on `pi.events`. [botsun-owner](../opt-in/botsun-owner/README.md) shows the list on Eric's phone, which can stop one child (a foreground one by its own abort, the call's other children keep running; a background one by its bg job's kill). A finished child stays on the list for 10 minutes. Each child also keeps its conversation (its task, text, tool calls and short results, then its final reply; at most 400 entries or 512 KB, the oldest work dropped first), which the phone opens as a read-only chat (`child_transcript`). A foreground child's comes from its JSON events; a background one's and a Cursor run's are read back from their logs, as far as the logs show it.

## The sandbox

`sandbox: true` (on the call or a task, or in an agent file's frontmatter) runs the task in Botsun's workers VM instead of this Mac (Botsun's `docs/plans/sandbox-workers.md`, Part 1 Phase 2). The child is still a host process — `bin/botsun worker exec` — so the subagents list, the bg log and "stop from the phone" are unchanged: Botsun copies the repo in as one tar, starts pi in the VM as the unprivileged `botsun-worker` user inside a transient systemd unit, and relays its JSONL stdout back on that process's stdout.

- **Read-only, enforced on the host side.** `sandbox.ts` composes only `worker exec --cwd … --agent … --task … --prompt … [--model] [--pi-version] [--child <id>]`; Botsun builds the guest invocation itself with `-ne -na` (no extensions, project trust off) and `--tools read,grep,find,ls`. Nothing in the clone — its `AGENTS.md` is read, its `.pi/settings.json` is not — can add a tool back. `--child` is the id of the child row `trackChild` makes for the same job (`lib/children.ts`'s `newChildId`), so the phone can show that child's Computer row; an id Botsun wouldn't accept is dropped, never an error.
- **Phase 2 is `scout` only.** `worker` (or any other agent) is refused with one line naming the patch gate, before anything is spawned. `scout`, and an agent file with `sandbox: true`, both work.
- **What travels:** the bundle (`--all`), the uncommitted tracked delta and the untracked files, never gitignored ones. What comes back is the guest's answer text; a sandboxed run has no write path home until Part 1 Phase 3's patch gate.
- **Needs:** Botsun checked out (or `$BOTSUN_BIN`), its workers VM up (`bin/botsun worker up`) with the same pi version (`vm/workers.yaml`'s `PI_VERSION`), and `bin/botsun worker creds` run once. That version check is a compatibility gate, not an integrity check.
- **No Mac fallback, ever.** A cursor agent (or any agent running something other than the VM's pi) asked for the sandbox is refused with one line, in the foreground and in the background, before anything spawns: a `sandbox: true` request never quietly becomes a Cursor run on this Mac.

## The cursor agent

`agent: "cursor"` runs [Cursor's agent CLI](../opt-in/cursor-agent/README.md) instead of a pi child, using the cursor-agent extension's own code (its checks, spawn, cost lookup and result block). Parallel tasks can mix `scout`, `worker` and `cursor`.

```js
subagent({ agent: "cursor", task: "Fix the failing fizz test", background: true })
subagent({ tasks: [{ agent: "scout", task: "Map the auth code" }, { agent: "cursor", task: "Add fizz_test.rb", cursorMode: "agent" }] })
```

- **Defaults:** the model is the task's `model`, else the call's `model`, else the agent file's, else the cursor-agent `defaultModel` (never the session's pi model). Each task runs in `agent` mode in a new git worktree (`worktree: true`), so several can run at once; `plan` and `ask` are read-only and skip the worktree unless asked. Only user-scope agent files may set `network: true`; a project agent file never turns Cursor's sandbox off. `cursorMode` (`agent`, `plan` or `ask`; the last two are read-only) and `worktree` override them, on the call or per task. With the default worktree, `cwd` must be a git repo with a commit; `worktree: false` runs in `cwd` itself.
- **Foreground:** the task's text is the same result block the cursor tool's background mode prints: Cursor's answer, then the model, duration, charge in dollars, worktree path, branch and changed files, session, exit code and error. `details.results[i].cursor` has the same facts: `{ model, durationMs, exitCode, chargedCents?, charged?, chargeError?, sessionId?, worktree?: {path, branch, changed}, error? }`. Cursor's cost isn't pi token usage, so it isn't in the tool's `usage`.
- **Background:** the job is the cursor tool's runner, started through the bg extension like a pi child (`sa:cursor` in `/bg`), and the completion message carries its result block.
- **Agent files:** frontmatter `runner: cursor` makes an agent run Cursor. It can also set `model`, `mode`, `worktree`, `network` (`true` turns Cursor's sandbox off) and `force` (`true` passes `--force`, which shell commands need when the sandbox is off, since print mode can't approve them); the call overrides all but `network`, and can pass `force` itself. `network` and `force` count only in user-scope agent files; a repo's agent files can't set them.
- **Needs** the cursor-agent extension turned on (`/boehsline enable cursor-agent`) and `cursor-agent` installed. Without either, that task fails with a message saying so; the call's other tasks still run.
- **Safety:** every run is billed to the user's Cursor account. The tool's description says a cursor task must never contain PII, PHI, secrets or credentials, and adds the cursor-agent settings' `note` and `rules` (for example a work seat's data rules) from the next session on.
