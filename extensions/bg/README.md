# bg

Background jobs for the built-in `bash` tool, without extra tools. **Command:** `/bg` (or Ctrl+Shift+B).

Adds `background: true` to the Bash tool and automatically
backgrounds commands that exceed the foreground budget without an explicit
timeout. Explicit foreground timeouts remain hard deadlines.

Running background jobs appear in a compact widget **above the prompt**, not
in the footer:

```text
● 2 background jobs · rspec 1m12s · vite 12s · /bg
```

The widget updates elapsed times without waking the model, shows up to three
jobs plus an overflow count, and disappears when none remain. Foreground jobs
stay hidden unless they are moved to the background. `/bg` (or Ctrl+Shift+B in
a compatible terminal) opens the job list and live logs; `x` stops a job. The
session canvas shows the same jobs, with log tails, in a Background jobs card:
bg emits `bg:jobs` on `pi.events` whenever a job starts, is adopted or
exits, and answers `bg:list`, so other extensions can follow along without
importing it. `bg:kill` (`{ id, wake?, reply }`) stops one job as `x` does;
with `wake: true` the model still gets the "killed" completion (a background
subagent stopped from Eric's phone, so its parent doesn't wait on it).

There are no periodic model wakeups. Completion still sends the exit status
and log tail, controlled by `PI_BG_WAKE=followUp|nextTurn|off` (default
`followUp`). User-stopped jobs only notify the UI.


The `background` flag costs about 55 tokens of context. Logs are plain files the model reads with `read`.
