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

## Across /reload, restarts and resume

Jobs are detached, so they keep running when pi reloads or quits. bg keeps
track of them too:

- **`/reload`**: the new bg instance takes over the whole job table (running
  and finished jobs, same ids), so the widget, `/bg`, `bg:list`, `bg:jobs`,
  stopping a job, and the completion wake carry on as before. A job that ends
  during the reload is reported once the reload finishes.
- **Restart, `pi --resume`, `/resume`** of the same session: bg re-adopts the
  session's jobs that are still running and checks every 2 s whether they have
  ended. Jobs that ended in the meantime are reported once, marked "while the
  session was closed". The model is woken only when the job would have
  woken it anyway: a job you stopped only shows a notice. A job is adopted
  only if its process is provably the same one: same pid, same start time
  (`ps -o lstart`), and bg's wrapper with this job's exit file in its arguments.
  A reused pid is reported as "ended (exit unknown)" and is never signalled.
  When `ps` can't tell (it fails, or never recorded the start time), the job
  is neither adopted nor reported. Its entry stays for the next resume and
  ages out after 24 h.
- **`/new`, `/fork`**: a new session id, so the job list starts empty. As
  before, a job from the previous session still sends its completion to the
  session that is open when it ends. Resuming the old session later picks up
  its jobs that are still running.

Every job runs under a small `/bin/sh` wrapper that writes its exit status
to `<log>.exit` when it ends, so an adopted job (no longer a child of this pi)
still reports its exit code. When even that is missing (for example, the
wrapper was SIGKILLed), the job is reported as "ended (exit unknown)". Like
any shell, the wrapper reports a job killed by signal N as exit 128+N. bg
reads that back as the signal only for a stop you asked for. Otherwise (for
example, a `kill -9` from elsewhere) the job reads "exited 137".

Each persisted session's jobs are listed in
`~/.local/state/pi-bg/<session id>.json` (`$XDG_STATE_HOME`, or
`PI_BG_STATE_DIR`). The file holds metadata only, never output: id, name,
command, cwd, log path, pid and start time, start and end times, exit code
and signal, and the stop and wake flags. The directory is 0700 and the files
are 0600, written atomically (temp file + rename). A file that isn't yours,
is writable by others, is a symlink, or names a log outside the bg log
directory is ignored. Entries leave once their ending has been reported.
Entries that are not running and were last seen more than 24 h ago are
dropped without a report. Other sessions' files untouched for 24 h keep only
jobs that are still running. Sessions without a file (`--no-session`) and
Windows keep the in-process `/reload` hand-off but no registry.


The `background` flag costs about 55 tokens of context. Logs are plain files the model reads with `read`
(in `/tmp/pi-bg-<uid>/`, or `PI_BG_DIR`; pruned after 7 days). That directory must be yours and not
writable by anyone else. Otherwise bg refuses background jobs, and foreground commands run as the
built-in bash tool runs them.
