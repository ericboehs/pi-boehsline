# cursor-agent

*Opt-in:* `/boehsline enable cursor-agent`.

Adds a `cursor` tool that hands a coding task to [Cursor's agent CLI](https://cursor.com/cli) (`cursor-agent -p`). Cursor uses its own models and tools on your Cursor plan, and pi shows what it did and what the run cost. **Tool:** `cursor`. **Command:** `/cursor-usage`.

- **Live view.** Cursor's steps stream in as it works (✓ read fizz.rb, ✓ shell ruby fizz_test.rb), followed by its final answer.
- **Sandboxed by default.** Commands can write only inside the workspace and can't reach the network. `network: true` turns the sandbox off for that run.
- **Real cost.** After each run, the tool looks up that run on Cursor's dashboard API and reports the cents charged, including Cursor's fee, plus token counts. The footer keeps a running total for the session.
- **`/cursor-usage`** shows this billing cycle's spend against your per-user limit, broken down by model.

Tool arguments: `prompt` (must be self-contained, since Cursor doesn't see the conversation), `model` (default from settings, otherwise `auto`), `mode` (`agent`, `plan` or `ask`; the last two are read-only), `cwd` and `network`.

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
