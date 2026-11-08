# failover

When a model hits its usage limit, continue on the next model in your chain, then come back
when the window resets.

Stock pi does not retry a subscription or quota limit: the turn ends with an assistant
message whose `stopReason` is `"error"` and whose `errorMessage` says so. This extension reads
that message when the run settles, switches models, and sends `continue` so the work does not
stop there.

## Settings

In `~/.pi/agent/boehsline.json` (`PI_CODING_AGENT_DIR` honoured, as for every extension):

```json
{
  "failover": {
    "chain": ["anthropic/claude-opus-5.5", "opencode-go/glm-5.3", "openai-codex/gpt-5.5-codex"],
    "enabled": true,
    "maxSwitches": 3
  }
}
```

| Key | Meaning |
| --- | --- |
| `chain` | Ordered `provider/model` ids, preferred first. Only the first slash splits, so `openrouter/moonshotai/Kimi-K2` works. |
| `enabled` | Default `true` when a chain is set; `false` turns the extension off without deleting the chain. |
| `maxSwitches` | Switches allowed for one task (a user request plus the continues it caused). Default `3`. |

With no `chain` the extension does nothing, so it is inert until you name a model.

## What counts as a usage limit

`stopReason` must be `"error"` and the message must match one of the non-retryable
quota/usage-limit cases pi-ai itself refuses to retry, plus the ways the providers in a chain
word the same thing: `GoUsageLimitError`, `FreeUsageLimitError`, `insufficient_quota`,
`quota exceeded`, `out of budget`, `available balance`, any "usage limit" wording
(monthly/weekly/daily), GitHub Copilot's "premium requests", a limit the message reports with
the verb first ("You have exceeded your premium requests limit", "exceeded your monthly quota",
"You have reached your limit for this window"), account billing failures
(`billing_hard_limit_reached`, "billing account is suspended" — but not "billing country not
enabled", which no other model will fix), the ChatGPT subscription-sharing limits, and Zhipu's
plan limit (`code` 1308).

Left alone: ordinary network and overload errors (pi already retries those), throttles — a bare
`429 Too Many Requests`, "rate limit exceeded", "exceeded your per-minute rate limit", "retry
after" — context overflow (pi-ai's own `isContextOverflow` decides, so this list cannot drift
from the one pi uses: `prompt is too long`, `context_length_exceeded`, "context window exceeded
limit" — compaction is the fix), and an abort (`stopReason: "aborted"`, or a message that says
the request was aborted/cancelled — an account whose subscription was cancelled is a real
failure, not an abort). A run Eric aborts is never failed over, and neither print mode nor JSON
mode is ever touched.

## Switching

The next usable model in the chain is picked in chain order, starting after the model that
hit its limit and wrapping once. Skipped: models the registry does not know, models with no
configured auth, models already tried for this task, models whose cached usage
(`~/.pi/agent/usage-cache.json`, provider-usage's drivers) shows the window used up, and models
that hit a limit minutes ago and have not reached their reset yet (that memory survives into
the next task: another request would only fail again).

Anthropic meters each model family separately, so `claude-window:<family>` is read on its own
when the cache has it: a full Opus week does not mark Sonnet used up, nor hand it Opus's reset.

The opencode-go and codex cache entries carry their meters as `windows` (with `percent` and
`resets_at`) plus the soonest `resetMs`, which is what makes them usable here.

One line says what happened:

```
failover: anthropic/claude-opus-5.5 hit its usage limit; continuing on opencode-go/glm-5.3 (back after 3:00PM)
```

With no cached reset the wait is a 30-minute guess, and the line says so (`retry ~3:30PM`)
instead of promising a switch-back time.

Then `pi.sendUserMessage("continue")` starts the work again on the new model.

## Coming back

The reset time comes from the same usage cache (`resetMs`, `resetDate`, `windows[].resets_at`,
the `claude-window:opus`-style variant included). The reset of the window that is actually
used up wins; otherwise the soonest future reset. With no cache entry for that provider the
extension retries after 30 minutes.

- Only a switch arms the wake (and a wake that has to wait for a later window re-arms itself).
  A stop never leaves a timer behind: a stop that rescheduled itself would resume its own loop.
- The wake switches back to the chain's first model when it is idle and the cache no longer
  shows that window used up; a timer that fires early re-schedules itself.
- It sends `continue` there only if the interrupted work never resumed. That means: the branch
  still ends on the message that hit the limit, `ctx.hasPendingMessages()` is false (a queued
  message continues the run, not ours), the editor is empty (never types over a draft), and the
  work stopped with the chain exhausted or the budget spent. Work that continued on a backup
  model is not disturbed.
- One wake-driven `continue` per task: if the work hits another limit after that, the wake
  reports it through quiet instead of sending another `continue`.
- A wake during a run waits for the next idle point (the next settle) before switching back,
  and retries every 60 s meanwhile, because idle compaction leaves no settle to wait for; an
  aborted settle drops that deferred switch back.
- If Eric picks a model himself after a switch (`/model`), the wake leaves it alone.
- Timers are cleared on `session_shutdown`; a resumed session starts clean.
- Settings are read once per session and re-read only when `boehsline.json`'s mtime changes (or
  on the next `session_start`), because a settle is a hot path.

## When it stops

It stops, once, and asks for Eric through quiet's `notify_user` path (the shared
`quiet:attention` state plus the `Needs you (…): …` line; `ctx.ui.notify` when quiet is not
loaded):

- the whole chain is exhausted or has no usable model left,
- the switch budget (`maxSwitches`) is spent,
- two `pi.setModel` attempts fail in the same task.

It never loops: each failed or skipped model leaves the chain, and the budget is counted per
task, not per agent run. A wake does not reset it (a `continue` buys no extra switches), and a
message Eric types starts a new task with a fresh budget and clears the stopped-work state. If
the chain runs out on the model it started from, there is no switch to come back from and so no
timer: the one line is the whole signal.

## Tests

`test/failover.test.mjs` has the pure decision functions (classifier, chain selection, reset
time, per-family cache entries, the no-loop guard, the settings cache) and mounts the extension
with a fake clock, cache, model registry and editor: switching, skipping, aborts, print/json,
the wake, the deferred wake and its retry, one-continue-per-limit (and six more backoffs that
change nothing), the queued-message / draft / branch-moved guards, a rejecting `setModel` and an
unreadable config, a model Eric picked by hand, and a shutdown clearing its timers. Cache
entries are built with provider-usage's own display functions, so they have the shape the real
`usage-cache.json` holds. `node scripts/test.mjs` runs them.
