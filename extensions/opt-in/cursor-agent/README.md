# cursor-agent

*Opt-in:* `/boehsline enable cursor-agent`.

Adds a `cursor` tool that hands a coding task to [Cursor's agent CLI](https://cursor.com/cli) (`cursor-agent -p`). Cursor uses its own models and tools on your Cursor plan, and pi shows what it did and what the run cost. **Tool:** `cursor`. **Command:** `/cursor-usage`.

- **Live view.** Cursor's steps stream in as it works (✓ read fizz.rb, ✓ shell ruby fizz_test.rb), followed by its final answer.
- **Sandboxed by default.** Commands can write only inside the workspace and can't reach the network. `network: true` turns the sandbox off for that run.
- **Real cost.** After each run, the tool looks up that run on Cursor's dashboard API and reports the cents charged, including Cursor's fee, plus token counts. The footer's **Cursor spend** chip (with session cost and provider quota chips on the border row) shows this billing cycle's spend (the same figure as `pi-usage`, e.g. `⬡ $81.60/$200 (41%)`), pace-colored over the cycle, and appends this session's foreground `cursor` tool runs when there are any (a dim `· +$0.02 here`).
- **`/cursor-usage`** shows this billing cycle's spend against your per-user limit, broken down by model.
- **Shared usage cache.** After each run (a background refresh that never delays the result) and on `/cursor-usage`, the cycle's spend is written to pi's `~/.pi/agent/usage-cache.json` under `cursor-usage` (value like `$0.65 / $200 (0.3%)`, reset at cycle end, numbers in `quota`), next to provider-usage's entries, so cache readers like `pi-usage` list Cursor. Only that key is touched. Nothing polls.

Tool arguments: `prompt` (must be self-contained, since Cursor doesn't see the conversation), `model` (default from settings, otherwise `auto`), `mode` (`agent`, `plan` or `ask`; the last two are read-only), `cwd`, `network`, `worktree`, `worktreeBase` and `background`.

- **`worktree: true`** runs Cursor in a new git worktree at `~/.cursor/worktrees/<repo>/pi-…`, on its own branch, so parallel calls can't overwrite each other or your checkout. The result names the path, the branch and `git status --short` there. Changes are left uncommitted for you to review, merge or delete (`git worktree remove`). `worktreeBase` picks the starting ref. `cwd` must be a git repo with at least one commit.
- **`background: true`** runs Cursor detached, as a job of the [bg extension](../../bg/README.md), so a long run (they can take half an hour) doesn't block the session, and subagents can hand work off too. The call returns at once with `Started in background … bg <id> · log /tmp/pi-bg-<uid>/<id>.log`. Same model, sandbox, network and worktree handling as a foreground call. While it runs, the log gets one line per Cursor step (`→ shell npm test`, then `✓`/`✗`), so `/bg` shows it live. When Cursor finishes, a message arrives in the session with the answer (shortened past 6,000 characters; the full text stays in the log), the charge in dollars (`chargedCents`), the model, the duration, the worktree's path, branch and changed files, and the exit code and error. Stopping the job in `/bg` (`x`) kills cursor-agent with it. Recommended for anything longer than a few minutes, and pairs well with `worktree: true`. Needs the bg extension; without it the call fails and says to rerun without `background`. Background runs refresh the shared usage cache when they end and the footer chip picks up the new cycle total on the next turn; foreground `cursor` runs also append their charge to the chip's `· +$… here` suffix.
- **As a subagent.** The [subagent tool](../../subagent/README.md)'s built-in `cursor` agent (or an agent file with `runner: cursor`) runs the same code, so `subagent({ agent: "cursor", task, background: true })` and parallel `tasks` mixing `scout`, `worker` and `cursor` work too. There a task gets a new worktree by default, and its result is the same block as a background run's. Its tool description carries this extension's `note` and `rules`.
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
