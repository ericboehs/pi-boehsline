# subagent

A minimal subagent tool: runs a separate `pi` process (or Cursor's agent) for a focused task and returns its answer. **Tool:** `subagent`.

- **Deferred:** the tool isn't declared to the model at startup, so it costs no context until the model finds it with `tool_search`.
- Each child is `pi --mode json -p --no-session` with the agent's prompt appended. One `{agent, task}`, or `{tasks: [...]}` in parallel (up to 8, 4 at a time). For a pi child, a task's own `model` wins over the agent file's, and the call's `model` doesn't.
- Agents: `~/.pi/agent/agents/*.md`, plus the project's `.pi/agents/*.md` when `agentScope` is `project` or `both`. Three built-ins need no setup: `scout` (read-only), `worker`, and `cursor`.
- Children set `PI_SUBAGENT_CHILD`, so a child can't spawn more children.
- `background: true` hands each child to the [bg extension](../bg/README.md) and returns at once; each result arrives as a message when its child finishes.

## The cursor agent

`agent: "cursor"` runs [Cursor's agent CLI](../opt-in/cursor-agent/README.md) instead of a pi child, using the cursor-agent extension's own code (its checks, spawn, cost lookup and result block). Parallel tasks can mix `scout`, `worker` and `cursor`.

```js
subagent({ agent: "cursor", task: "Fix the failing fizz test", background: true })
subagent({ tasks: [{ agent: "scout", task: "Map the auth code" }, { agent: "cursor", task: "Add fizz_test.rb", cursorMode: "agent" }] })
```

- **Defaults:** the model is the task's `model`, else the call's `model`, else the agent file's, else the cursor-agent `defaultModel` (never the session's pi model). Each task runs in `agent` mode in a new git worktree (`worktree: true`), so several can run at once; `plan` and `ask` are read-only and skip the worktree unless asked. Only user-scope agent files may set `network: true`; a project agent file never turns Cursor's sandbox off. `cursorMode` (`agent`, `plan` or `ask`; the last two are read-only) and `worktree` override them, on the call or per task. With the default worktree, `cwd` must be a git repo with a commit; `worktree: false` runs in `cwd` itself.
- **Foreground:** the task's text is the same result block the cursor tool's background mode prints: Cursor's answer, then the model, duration, charge in dollars, worktree path, branch and changed files, session, exit code and error. `details.results[i].cursor` has the same facts: `{ model, durationMs, exitCode, chargedCents?, charged?, chargeError?, sessionId?, worktree?: {path, branch, changed}, error? }`. Cursor's cost isn't pi token usage, so it isn't in the tool's `usage`.
- **Background:** the job is the cursor tool's runner, started through the bg extension like a pi child (`sa:cursor` in `/bg`), and the completion message carries its result block.
- **Agent files:** frontmatter `runner: cursor` makes an agent run Cursor. It can also set `model`, `mode`, `worktree` and `network` (`true` turns Cursor's sandbox off); the call overrides all but `network`.
- **Needs** the cursor-agent extension turned on (`/boehsline enable cursor-agent`) and `cursor-agent` installed. Without either, that task fails with a message saying so; the call's other tasks still run.
- **Safety:** every run is billed to the user's Cursor account. The tool's description says a cursor task must never contain PII, PHI, secrets or credentials, and adds the cursor-agent settings' `note` and `rules` (for example a work seat's data rules) from the next session on.
