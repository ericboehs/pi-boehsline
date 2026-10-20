# provider-usage

Usage and quota chips for your providers, shown by the [footer](../footer/README.md). **Tool:** `provider_usage`, deferred: the model finds it with `tool_search` when needed, so it costs no context otherwise (reads the cache; refreshes one named provider on request). Each provider also gets a command, such as `/copilot-window`.

| Provider | Shows | Credentials |
|---|---|---|
| openai-codex | rate-limit windows | pi's own login |
| github-copilot | premium request allowance and pace | pi's own login |
| xai (grok) | rate-limit windows | pi's own login |
| anthropic (Claude Pro/Max) | 5h and weekly windows; the footer hides the $ estimate | pi's own OAuth login (`/login` → Anthropic) |
| cerebras | rate-limit windows | `CEREBRAS_API_KEY` |
| opencode-go | usage windows | `OPENCODE_SESSION_COOKIE` + `OPENCODE_WORKSPACE_ID`, or Safari's cookies |
| ollama | usage | `OLLAMA_SESSION_COOKIE`, or Safari's cookies |
| baseten | spend this month | `BASETEN_API_KEY`; `BASETEN_MONTHLY_BUDGET` sets the bar |
| openrouter | spend | `OPENROUTER_API_KEY`; `OPENROUTER_MONTHLY_BUDGET` sets the bar |

Keys come from the environment, then the secret command (`secrets.command` in `boehsline.json`, `fnox get` by default). Reading Safari's cookie store needs Full Disk Access for your terminal; only the one cookie is read.

A chip shows only while you're on that provider. Fetches never block startup or the model picker: each refresh is fire-and-forget, and a late response is discarded if a newer one started. A failed fetch keeps the last value and warns once.

`~/.pi/agent/usage-cache.json` holds one entry per chip: `value` (the text), `resetDate`/`resetMs`, `fetchedAt`, and — for Copilot — `quota` with the numbers behind the text (`entitlement`, `remaining`, `usedPercent`, `perDayPercent`, `workdaysElapsed`, `workdaysTotal`, `allowanceWorkdays`, `resetDate`). Other tools read those rather than parsing `"13.6/22.2W: 66.5% 3.7%/d"`; botsun's VA budget uses `remaining` and `allowanceWorkdays` to set its daily dollars. Entries without `quota` were written by an older session and are replaced on the next fetch.

Chips refresh when a session starts, when you switch models, after each turn, and on a 2-minute poll. The poll only calls provider APIs during a run or within 10 minutes of the last turn. An idle session reads the shared cache file instead, picking up whatever an active session fetched, and its next turn refreshes right away. After each turn a session also adopts any newer value in the shared file, even while its own copy is still fresh.
