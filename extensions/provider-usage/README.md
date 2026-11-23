# provider-usage

Usage and quota chips for your providers, shown by the [footer](../footer/README.md). **Tool:** `provider_usage`, deferred: the model finds it with `tool_search` when needed, so it costs no context otherwise (reads the cache; refreshes one named provider on request). Each provider also gets a command, such as `/copilot-window`.

| Provider | Shows | Credentials |
|---|---|---|
| openai-codex | rate-limit windows | pi's own login |
| github-copilot | premium request allowance and pace | pi's own login |
| xai (grok) | rate-limit windows | pi's own login |
| anthropic (Claude Pro/Max) | the 5h session plus the weekly meter of the model family in use (opus/sonnet; `weekly_all` when the family has none), from the response's `limits[]`; a meter with no reset (an unused window) has nothing to pace against, so it is skipped until you use that model family. `is_active` says which window is being enforced, not which has usage. `/claude-window`'s detail lists every meter. The footer hides the $ estimate | pi's own OAuth login (`/login` → Anthropic) |
| cerebras | rate-limit windows | `CEREBRAS_API_KEY` |
| opencode-go | usage windows | `OPENCODE_SESSION_COOKIE` + `OPENCODE_WORKSPACE_ID`, or Safari's cookies |
| ollama | usage | `OLLAMA_SESSION_COOKIE`, or Safari's cookies |
| baseten | spend this month | `BASETEN_API_KEY`; `BASETEN_MONTHLY_BUDGET` sets the bar |
| openrouter | spend | `OPENROUTER_API_KEY`; `OPENROUTER_MONTHLY_BUDGET` sets the bar |

The window providers (Claude, Copilot, Codex, Grok) also publish their numbers as data through `lib/usage-snapshot.ts` (`{provider, windows: [{label, percent, resets_at?}], extra_usage?, stale?}`), whether or not the footer shows the chip: [botsun-owner](../opt-in/botsun-owner/README.md) sends them to the phone. Claude publishes every meter with a reset (`5h`, `week`, `opus week`, ...), and `extra_usage` while the overage alarm is on; `stale` means the last fetch failed or nothing refreshed in 15 minutes.

Keys come from the environment, then the secret command (`secrets.command` in `boehsline.json`, `fnox get` by default). Reading Safari's cookie store needs Full Disk Access for your terminal; only the one cookie is read.

A chip shows only while you're on that provider. Fetches never block startup or the model picker: each refresh is fire-and-forget, and a late response is discarded if a newer one started. A failed fetch keeps the last value and warns once.

`~/.pi/agent/usage-cache.json` holds one entry per chip: `value` (the text), `resetDate`/`resetMs`, `fetchedAt`, and — for Copilot — `quota` with the numbers behind the text (`entitlement`, `remaining`, `usedPercent`, `perDayPercent`, `workdaysElapsed`, `workdaysTotal`, `allowanceWorkdays`, `resetDate`). The window drivers also write `windows` — the same meters as data (`{label, percent, resets_at?}`) — and, for Codex and OpenCode Go, the soonest meter as `resetMs`, so a reader can tell a provider is used up and when its window reopens without parsing the text ([failover](../failover/README.md) does). Claude's entry is keyed per model family (`claude-window:opus`, `claude-window:sonnet`) so concurrent sessions on different families never adopt each other's filtered value. Other tools read those rather than parsing `"13.6/22.2W: 66.5% 3.7%/d"`; botsun's work budget uses `remaining` and `allowanceWorkdays` to set its daily dollars. Entries without `quota` were written by an older session and are replaced on the next fetch.

Chips refresh when a session starts, when you switch models, after each turn, and on a 2-minute poll. The poll only calls provider APIs during a run or within 10 minutes of the last turn. An idle session reads the shared cache file instead, picking up whatever an active session fetched, and its next turn refreshes right away. After each turn a session also adopts any newer value in the shared file, even while its own copy is still fresh.

## Background polls

A provider nobody is on would never refresh: its cache entry goes stale, and its OAuth token expires unrefreshed. So SuperGrok (`xai`) is also polled every 30 minutes while any pi is running, whatever model it uses, as long as you are signed in with `/login` (never with an `xai-` API key). Set the interval per provider:

```jsonc
// ~/.pi/agent/boehsline.json
{ "provider-usage": { "backgroundPollMinutes": { "xai": 30 } } }
// 0 turns one off; "openai-codex" and "github-copilot" may be added (minimum 5)
```

Only pi's own OAuth sign-ins qualify (Grok, Codex, Copilot); Claude's entry is per model family, and key- or cookie-based providers are never polled in the background. The poll goes through pi's auth (`getProviderAuth`), so pi refreshes the token itself, which keeps the sign-in alive.

One pi on the machine fetches per interval: each checks every 5 minutes (first 15 s after start) and skips when the cache entry is younger than the interval. The winner of the shared fetch lock stamps the attempt in `usage-background.json` before fetching, so a failed refresh or a sign-out is retried at most once per interval machine-wide. Failures are quiet: no UI, one line per streak in `provider-usage.log`, and the cache keeps the last value with its `fetchedAt`. Timers don't keep pi alive, stop at session shutdown, and never start in `-p` or json mode.
