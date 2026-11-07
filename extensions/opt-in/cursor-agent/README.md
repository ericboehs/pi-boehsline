# cursor-agent

*Opt-in:* `/boehsline enable cursor-agent`.

Adds a `cursor` tool that hands a coding task to [Cursor's agent CLI](https://cursor.com/cli) (`cursor-agent -p`). Cursor uses its own models and tools on your Cursor plan, and pi shows what it did and what the run cost. **Tool:** `cursor`. **Command:** `/cursor-usage`.

- **Live view.** Cursor's steps stream in as it works (✓ read fizz.rb, ✓ shell ruby fizz_test.rb), followed by its final answer.
- **Sandboxed by default.** Commands can write only inside the workspace and can't reach the network. `network: true` turns the sandbox off for that run.
- **Real cost.** After each run, the tool looks up that run on Cursor's dashboard API and reports the cents charged, including Cursor's fee, plus token counts. The footer's **Cursor spend** chip (with session cost and provider quota chips on the border row) shows this billing cycle's spend (the same figure as `pi-usage`, e.g. `⬡ $81`), pace-colored over the cycle. A click cycles mini → compact (`⬡ $81/$200`) → detailed (`⬡ $81.60/$200 (41%)`, plus a dim `· +$0.02 here` for this session's foreground `cursor` tool runs); see the [footer README](../../footer/README.md).
- **`/cursor-usage`** shows this billing cycle's spend against your per-user limit, broken down by model.
- **Shared usage cache.** After each run (a background refresh that never delays the result) and on `/cursor-usage`, the cycle's spend is written to pi's `~/.pi/agent/usage-cache.json` under `cursor-usage` (value like `$0.65 / $200 (0.3%)`, reset at cycle end, numbers in `quota`), next to provider-usage's entries, so cache readers like `pi-usage` list Cursor. Only that key is touched. Nothing polls.

Tool arguments: `prompt` (must be self-contained, since Cursor doesn't see the conversation), `model` (default from settings, otherwise `auto`), `mode` (`agent`, `plan` or `ask`; the last two are read-only), `cwd`, `network`, `worktree`, `worktreeBase`, `background` and `force`.

- **`network: true` needs `force: true` for shell commands.** Outside the sandbox, cursor-agent asks before every shell command (and web fetch, web search and subagent call), and print mode can't answer, so each comes back refused and nothing runs. `force: true` passes `--force` ("run everything"), and the call header shows `[run everything]` next to `[no sandbox]`. `network` never turns it on by itself; use it only for prompts and workspaces you trust, since commands then run with your full access. Inside the sandbox (the default), commands run without asking. Refused steps show as `(refused)`, and after 3 refusals the run is stopped with an error that names these fixes (or an allow rule in `~/.cursor/cli-config.json`), instead of spinning until Cursor gives up.
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

## Show work (diffs)

When a run in a git repo finishes — success, failure or stop, worktree or in place — what it changed is saved for the phone.

The tool result's `details`, and a background run's completion message (`customType: "bg"`, same `details`), carry:

- `diff` — unified diff, secrets masked, capped at 256 KB. The cut is on a file boundary and ends with `… N more files, M more bytes`. A first file bigger than the cap is kept cut. Gitignored paths are left out. Some files are one line naming them, never their content:
  - `Binary file <path> changed` — a binary file.
  - `Sensitive file <path> changed` — `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_*` keys (`id_rsa`, `id_ed25519` …), `.npmrc`, `.netrc`, `.pgpass`, `credentials*.json`. A trailing slash or backslash still counts (`foo\.env\`). A token in the path is masked.
  - `Large file <path> changed` — a changed file over 1 MB, or an untracked file over 5 MB (which is never staged, so it isn't written into `.git/objects`). An untracked large file that was already there, unchanged, is not listed.
- `diffStats` — `{ files, insertions, deletions, truncated }`.
- `diffPath` — the full masked diff (not the cap), mode `0600`, in a `0700` directory: `~/.local/state/pi-cursor/<run id>-<random>.diff` (`$XDG_STATE_HOME/pi-cursor`, or `$PI_CURSOR_STATE_DIR`). The run id is Cursor's session id, else the bg job id; the random suffix keeps two runs with the same id apart. Each write prunes the directory: diffs older than 14 days go, and only the newest 200 are kept.

Masking covers `name=value` secrets and Bearer/Basic headers, bare tokens with a well-known prefix (`ghp_`/`gho_`/`ghs_`…, `github_pat_`, `AKIA`/`ASIA`, `sk-`, `xox*-`, `glpat-`, `AIza`, `ya29.`, `npm_`, JWTs), letter-only `sk-`/`pk-` keys of 20 or more characters (`sk-learn` stays), credentials in URLs, and private key blocks (the BEGIN/END lines stay; each body line becomes `•••`, so hunk line counts still add up). Tokens in an omitted file's path are masked too.

Tracked changes are against the run's base: the commit a worktree started from, or a tree of an in-place checkout taken before the run (dirt that was already there is not the run's). Untracked files git does not ignore are included. The whole repo counts, even when the run's cwd is a subdirectory. Rename detection is forced (`diff.renames=true` and `-M1%`), so a repo configured with `diff.renames=false`, or a small `.env` that was renamed and edited, cannot show that file as an add of its body. The snapshots use a scratch index copied from the real one, so unchanged files aren't hashed again. If a snapshot fails or times out (30 s per git call), there is no diff at all, rather than a partial one that could credit the run with the wrong files.

After a stop, the capture is cut short so Stop stays fast: each git call gets 5 s, and files are re-read only if the base already had them. Edits to existing files show up; files the run created don't.

A Cursor subagent's conversation (`childTranscript`) ends with one more entry, after the reply. It is not a message, so a reader that only handles `type: "message"` skips it and still works:

```json
{
  "seq": 4,
  "type": "custom",
  "customType": "cursor_diff",
  "id": "4",
  "timestamp": "2026-11-07T15:00:00.000Z",
  "data": {
    "diff": "diff --git a/fizz.rb b/fizz.rb\n…",
    "diffStats": { "files": 1, "insertions": 1, "deletions": 1, "truncated": false },
    "diffPath": "/home/eric/.local/state/pi-cursor/sess-1f2e3d4c.diff"
  }
}
```

`data.diff` may be shorter than `details.diff` (one transcript entry is at most 32 KB). `data.diffPath` is the full masked diff. `diffPath` is omitted when nothing was written.

When a completed edit event included a patch or old/new text, that step's tool call arguments also carry `diff` and/or `old_string` / `new_string`. These are masked the same way as the run diff, capped at 8,000 characters, with newlines kept. They come from EditSuccess's `diffString` and the call's `old_string` / `new_string` (camelCase or the snake_case proto names). Whole-file content is never kept: not `beforeFullFileContent` / `afterFullFileContent`, a write's `fileText`, or a delete's `prevContent`. A step keeps nothing beyond its path when any path is sensitive: every path key on the call and on its success (`path`, `filePath`, `file_path`, `targetFile`, `target_file`, `old_path`, `new_path`, `uri`, `fileUri`, …; a `file://` value is decoded), and every path in a diff or patch header (`rename`/`copy` from/to, `---` / `+++` with or without an `a/` or `b/` prefix, `/dev/null` ignored, `*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:`). A started event usually only names a path, so a step with no patch still shows up; the run-level diff above is the one Show work can always render.

A background run's log numbers its steps (`→ #3 edit fizz.rb`, then `✓ #3 …`). Those lines are secret-masked, and so is the tail a completion message carries. The child transcript gives each step's call the id `bg-step-<n-1>`, and attaches the sidecar's edits by that id, but only when the job command's argv[1] realpaths to this package's runner. An edit whose step isn't in the transcript (trimmed, or never logged) attaches nothing, rather than landing on another call. Only that runner marks a job for a sidecar (an unexported set in `runner.ts`; `details: true` on a plain `bg:start` does not, and a forged stack cannot). The flag is not saved across reload; completion re-derives it from the command. cursor-agent itself is spawned without any `PI_BG_*` variable, so it cannot see the job id or overwrite the sidecar. The sidecar is opened without following a symlink, and reduced again on read (sensitive files become one line, secrets masked, per-edit old/new bodies dropped). `diffPath` is kept only when the state dir is not a symlink, the file's real directory is that dir, and the file is a regular `0600` file with one link, owned by us (the dir `0700`). The path returned is the real path, and its bytes are reduced before the phone is told.

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
