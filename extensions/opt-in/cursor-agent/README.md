# cursor-agent

*Opt-in:* `/boehsline enable cursor-agent`.

Adds a `cursor` tool that hands a coding task to [Cursor's agent CLI](https://cursor.com/cli) (`cursor-agent -p`). Cursor uses its own models and tools on your Cursor plan, and pi shows what it did and what the run cost. **Tool:** `cursor`. **Command:** `/cursor-usage`.

- **Live view.** Cursor's steps stream in as it works (✓ read fizz.rb, ✓ shell ruby fizz_test.rb), followed by its final answer.
- **Sandboxed by default.** Commands can write only inside the workspace and can't reach the network. `network: true` turns the sandbox off for that run.
- **Real cost.** After each run, the tool looks up that run on Cursor's dashboard API and reports the cents charged, including Cursor's fee, plus token counts. The footer keeps a running total for the session.
- **`/cursor-usage`** shows this billing cycle's spend against your per-user limit, broken down by model.
- **Shared usage cache.** After each run (a background refresh that never delays the result) and on `/cursor-usage`, the cycle's spend is written to pi's `~/.pi/agent/usage-cache.json` under `cursor-usage` (value like `$0.65 / $200 (0.3%)`, reset at cycle end, numbers in `quota`), next to provider-usage's entries, so cache readers like `pi-usage` list Cursor. Only that key is touched. Nothing polls.

Tool arguments: `prompt` (must be self-contained, since Cursor doesn't see the conversation), `model` (default from settings, otherwise `auto`), `mode` (`agent`, `plan` or `ask`; the last two are read-only), `cwd`, `network`, `worktree` and `worktreeBase`.

- **`worktree: true`** runs Cursor in a new git worktree at `~/.cursor/worktrees/<repo>/pi-…`, on its own branch, so parallel calls can't overwrite each other or your checkout. The result names the path, the branch and `git status --short` there. Changes are left uncommitted for you to review, merge or delete (`git worktree remove`). `worktreeBase` picks the starting ref. `cwd` must be a git repo with at least one commit.
- **`/cursor-worktrees`** reviews the `pi-*` worktrees left behind. Pick one to see its branch and changed files, then apply its changes to the repo (uncommitted, including any commits Cursor made and new files) and remove it, apply and keep it, remove it (asks first when that discards work), or skip it. A patch that doesn't apply cleanly isn't applied at all, and the worktree is kept. `/cursor-worktrees list`, or no UI, only lists them.
- **Structured output for scripts.** Codemode scripts get an object instead of text: `{ answer, steps: [{kind, summary, ok?}], chargedCents?, tokens, sessionId?, model, exitCode, durationMs, worktree?: {path, branch, changed}, error? }`. `chargedCents` is missing when the server charge couldn't be found, and `error` holds stderr when the run failed.

  ```js
  const [fix, tests] = await Promise.all([
    tools.cursor({ prompt: "Fix the bug in fizz.rb", worktree: true }),
    tools.cursor({ prompt: "Add fizz_test.rb", worktree: true }),
  ]);
  return [fix, tests].map((r) => `${r.worktree?.branch}: ${r.chargedCents}¢`);
  ```

## Requirements

- `cursor-agent` on your PATH, logged in (`cursor-agent login`).
- macOS for the cost lookup. It reuses the CLI's login from the Keychain (`cursor-access-token`). The token is read for each call, kept only in memory and sent only to `api2.cursor.sh`. On other systems the tool still runs, but the cost shows as not found.
- The dashboard endpoints are undocumented (`aiserver.v1.DashboardService`, taken from the CLI's bundle). A Cursor update can break the cost lookup without breaking the tool.

## Settings

Neutral by default. An organization's rules go in Boehsline config: your own `~/.pi/agent/boehsline.json`, or a config source such as a private work package.

```jsonc
"cursor-agent": {
  "defaultModel": "composer-2.5",          // when the call names none; default "auto"
  "blockedModels": ["fable"],              // refuse model ids containing these (case-insensitive)
  "blockedReason": "no zero data retention",
  "note": "Work seat: never send customer data.",  // appended to the tool description
  "rules": ["Never put customer data in the cursor tool's prompt."]  // extra prompt rules
}
```

Env vars replace a setting for one shell or one `pi -e` run:

| Variable | Replaces |
|---|---|
| `PI_CURSOR_MODEL` | `defaultModel` |
| `PI_CURSOR_BLOCKED_MODELS` | `blockedModels` (comma-separated) |
| `PI_CURSOR_BLOCKED_REASON` | `blockedReason` |
| `PI_CURSOR_NOTE` | `note` |
| `PI_CURSOR_RULES` | `rules` (one per line, or separated by ` \|\| `) |

The model, blocked list and reason are read on every call. The note and rules are part of the tool's prompt, so they apply from the next session (or `/reload`).
