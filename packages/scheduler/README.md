# pi-scheduler

Scheduled prompts for [pi](https://pi.dev). Two schedulers, split by *what the
task needs to survive* — the one distinction that actually changes the
implementation.

| | `/once`, `/loop` | `/schedule` |
|---|---|---|
| Runs in | this conversation | a fresh isolated `pi -p` |
| Needs pi open | yes | no |
| Survives quitting pi | no | yes |
| Model | whatever the session is using | per task |
| Stored in | a custom session entry | `~/.pi/agent/scheduler/tasks.json` |
| Missed fires | caught up once on the next resume, within 24h | caught up once, within a grace window |

**By default neither extension registers an LLM tool or adds anything to model
context.** The one exception is opt-in: enable `scheduler-tool` in Boehsline
and the agent gets a deferred `schedule` tool for session timers (see
[below](#letting-the-agent-set-timers-schedule-tool)). The durable half stays out of pi entirely between runs: a launchd/systemd tick
owns the schedule, so nothing is resident and pi's startup path is untouched.
Session timers (`/once`, `/loop`) are necessarily in-process — they hold
`setTimeout`s (in one-minute chunks, so a laptop sleep cannot leave one
looking on time) and read their snapshot back at `session_start` — but they
still register no tool and no context. They also publish a small index of who
has timers and when they are next due, for [the session timer
index](#the-session-timer-index).

## Install

```sh
pi install git:github.com/ericboehs/pi-scheduler
```

For durable tasks you also want the CLI on your `PATH`. The package is cloned
to `~/.pi/agent/git/github.com/ericboehs/pi-scheduler`:

```sh
ln -s ~/.pi/agent/git/github.com/ericboehs/pi-scheduler/bin/pi-scheduler ~/bin/pi-scheduler
pi-scheduler install    # per-minute launchd job, or systemd --user timer
```

Requires Node >= 22.18 (the CLI imports the extensions' `.ts` modules directly
under Node's type stripping).

## Session timers: `/once` and `/loop`

`extensions/session-scheduler.ts`. In-process timers that fire a prompt into
the current conversation.

```text
/once 15m check whether the deploy finished
/once at 8p check in on this
/once remind me about the PR in 2h
/once list | cancel <id>
/once edit <id> <duration|HH:MM|ISO> <prompt>
/loop 15m check CI
/loop review the deploy every 1h
/loop list | cancel <id> | clear
/loop pause <id|all> | resume <id|all>
/loop edit <id> <duration> <prompt>
```

`/once` is the one-shot counterpart to `/loop`. The time may lead (`/once 15m
check the build`, with an optional `in`/`at`) or trail (`/once check the build
in 15m`); the leading form wins when its first token parses as a time, so
`/once 8p check in on this` keeps the prompt's own "in" intact.

### Catch-up: a fire missed while pi was closed

A timer that came due while pi was not running is **delivered once**, when you
next resume the session, rather than being dropped:

```text
[Scheduled task 4a1f (one-shot) that you set with the schedule tool fired; it was due at 8:00:00 AM and is 4h late (1 missed run) because this session was not open]
```

- A recurring timer fires **once** for a miss, however many slots went by, then
  re-arms to the next future slot from its interval — one catch-up, never a
  replay.
- Missed fires are delivered oldest first, one at a time, waiting for the agent
  to settle between them, and at most `5` per restore. The rest are skipped
  with a notice (a recurring timer among them still re-arms).
- Anything older than the **misfire window is skipped** with a notice: `24h` by
  default, per task with `/once --misfire=6h …` (or `--misfire=skip` / `=always`),
  globally with `PI_SCHEDULER_SESSION_MISFIRE`.
- `paused` timers are untouched. `/loop resume` still skips what was missed
  while paused, and tree navigation never catches up: an older branch can hold
  a slot that already fired.
- **At most once, and never abandoned.** A one-shot — catch-up or live — is
  removed from the snapshot and saved *before* its prompt is sent, and put back
  if the send fails, so a crash between the two loses that prompt rather than
  repeating it. Until it is actually delivered a catch-up one-shot stays in the
  snapshot (unarmed), so quitting, crashing or `/reload`-ing first retries it on
  the next resume. A recurring catch-up is re-armed before it is queued, so a
  queued recurring fire that never gets sent is the one thing catch-up can lose.
- Nothing is armed or caught up in print mode (`pi -p --session`), or when
  another live pi holds the session: the list is restored, no timer is armed and
  nothing is written, so a second pi cannot double-fire or advance the first
  one's timers. The second case says which pid holds it.
- Timers are restored from the session, so `/new`, `/fork` and `/clone` inherit
  nothing: the snapshot names the session id that created it.

### `--wake`, for a session that is not open at all

Catch-up needs you to open the session. A timer can also ask pi to open it:

```text
/once --wake 8a check the backup          # after a crash or reboot
/once --wake=always 8a check the backup   # even if you quit last night
/once --no-wake 8a check the backup       # clear the mark again
```

`--wake` (a `crash`) means "reopen if the session died without being quit";
`--wake=always` means "reopen even though I closed it on purpose". The flag is
recorded on the task and published in the index, and the `pi-scheduler` tick
reopens the session when it comes due: see
[Waking closed sessions](#waking-closed-sessions).

The `schedule` tool takes `wake` only when the opt-in also says
`"allowWake": true` — an unattended reopened turn has your full tool set, and
the agent should not be able to grant itself that. Your own `--wake` flags are
always allowed. `misfire` and `wake` also survive `/once edit` and `/loop edit`,
and `--wake`/`--no-wake`/`--misfire=` change them there.

`pause` disarms a timer but keeps it listed, so it survives session resume
without firing or drifting. `resume` recomputes the next occurrence rather than
replaying what was missed: a recurring task advances to its next future slot,
and a one-shot whose time passed while paused is dropped with a warning instead
of firing late.

`edit` replaces a timer's time and prompt in place: the id, its place in the
list and its paused state stay. `/loop edit` takes an interval timer and
restarts it from now; `/once edit` takes a one-shot and moves it. Each refuses
the other kind. An edited timer the agent set fires as yours from then on. It
is read as an edit only when its time parses, so `/loop edit the docs every 1h`
is still a new timer.

### Letting the agent set timers: `schedule` tool

Off by default. Turn it on with `/boehsline enable scheduler-tool` (or add
`"scheduler-tool"` to `enable` in `~/.pi/agent/boehsline.json`), then
`/reload`. The agent gets one tool, `schedule`, that drives the same timers
as `/once` and `/loop`:

| action | needs | does |
|---|---|---|
| `once` | `when`, `prompt` | one-shot; `when` is `15m`, `2h`, `15:30`, `8p` or an ISO timestamp |
| `loop` | `every`, `prompt` | recurring, 1m minimum |
| `list` | | every timer in the session, yours included, with who set it |
| `cancel` | `id` | an id or unique prefix |
| `pause` / `resume` | `id` | an id, a prefix, or `all` |

`once` and `loop` also take `misfire` (`skip`, `always`, or a duration such as
`6h`), and `wake` when the settings say `"allowWake": true` — see
[`--wake`](#--wake-for-a-session-that-is-not-open-at-all).

It is the agent's version of the commands, not a separate scheduler: `/loop
list` shows what the agent set, the agent can cancel yours, and the same
limits apply (50 timers, 1m loop floor, catch-up on the next resume). You
see a notice whenever the agent adds, cancels, pauses or resumes a timer.

When an agent-set timer fires, its prompt arrives labelled
`[Scheduled task <id> (...) that you set with the schedule tool fired]`, so
the model reads it as its own reminder rather than a new request from you.
Timers you set fire verbatim, as before.

The tool is `deferred`: it is not in the prompt until the agent finds it with
`tool_search`, so enabling it costs nothing in sessions that never schedule.
To put it in every prompt instead:

```jsonc
{ "scheduler-tool": { "exposure": "direct" } }
```

In a non-interactive run (`pi -p`, including durable `/schedule` runs) the
tool refuses to set timers, since the process exits before any would fire;
use `pi-scheduler add` for that.

### Footer status

While timers exist the session status reads `2 timers`, `2 timers · 1
paused`, or `1 paused`, in plain text. Boehsline's footer turns it into a
`◷` Timers chip you can set to count, detailed or hidden in `/footer`; other
footers show the text as is.

### The session timer index

Timers live in the session file, which nothing outside pi can cheaply read, so
every session with timers also publishes a one-line entry to
`~/.pi/agent/scheduler/session-timers.json` (`PI_SCHEDULER_DIR`, then
`PI_AGENT_DIR`, as the durable registry does):

```json
{ "v": 1, "sessions": { "<sessionId>": {
  "sessionFile": "~/.pi/agent/sessions/…jsonl", "cwd": "/Users/you/Code/x",
  "pid": 4711, "pidStart": "Sat Nov 22 14:29:49 2026", "host": "laptop",
  "liveSince": 1763830000000, "closedAt": 1763833600000,
  "nextDueAt": 1763840000000, "nextWakeDueAt": 1763840000000,
  "nextAlwaysDueAt": 1763840000000,
  "wake": "always", "count": 2, "updatedAt": 1763833000000 } } }
```

- Metadata only: no prompts ever go in it, so a process that reads it learns
  when a session is next due and nothing about what you scheduled.
- `count` is unpaused timers; `nextWakeDueAt` and `wake` cover the tasks asking
  to be woken, strongest level wins (`always` > `crash`); `nextAlwaysDueAt` is
  the earliest `always` one alone, the only one that may reopen a session you
  quit on purpose. An entry disappears
  when the session has nothing unpaused left.
- `pid` plus `pidStart` (ps `lstart`) and `host` identify the live pi holding
  the session; both are cleared with `closedAt` on shutdown for any reason, so
  after `/resume` or `/fork` the old entry no longer claims a live process. A
  print-mode run, or a restore that found another holder, updates the timing
  fields only and leaves that pid alone on the way out, so `pi -p --session X`
  cannot mark a live `X` closed.
- Written under a lock, atomically, mode 0600 (directory 0700), and left alone
  when nothing changed. A session is indexed once its file exists (pi writes
  the file with the first reply); an entry is pruned only when its file is gone
  *and* its pi is dead.
- Two pi processes on one session would each catch up the same missed timer, so
  a restore checks this index first and leaves the catch-up to the live holder.

This is what the `pi-scheduler` tick reads to wake a session for a `--wake`
timer.

## Waking closed sessions

When a session is closed and one of its `--wake` timers comes due, or a
background job it started has finished since it closed, the per-minute
`pi-scheduler check` reopens it in a tmux window. The tick only spawns; pi's own
restore does the rest: the timer's catch-up fires, and bg re-adopts and reports
the job. No model runs in the tick.

**Off by default.** Turn it on per machine with `pi-scheduler wake on`, after
the device test passes there; until then `wake status` says `off (default)`.
Sessions keep writing lifecycle records either way, so turning it on later
covers sessions that were already open.

> **A woken session runs the model unattended.** The catch-up or bg report
> starts a turn with your full tool set and nobody watching. Anything that
> blocks on you (project trust, approval-guardian, a 1Password prompt) leaves
> the window waiting; the tick counts that as `stuck` and never kills it.

### Which closes are woken

Every interactive (TUI) session writes a small lifecycle record,
`~/.pi/agent/scheduler/sessions/<id>.json` (dir 0700, file 0600): `live` at
start, `closed` plus *how* at shutdown, and `crash` from a synchronous exit hook
when pi exits without a shutdown. `pi -p`, `--no-session` and subagent children
never write one, and **no record means never woken**.

| how it closed | `crash` timers, bg jobs | `always` timers |
|---|---|---|
| `/quit`, Ctrl+C, Ctrl+D (`user`) | no | yes |
| `/new`, `/resume`, `/fork` away (`switched`) | no | yes |
| SIGHUP/SIGTERM, and the tmux server outlived it (`kill-window`, Botsun) | no (someone closed the window) | yes |
| SIGHUP/SIGTERM, and the tmux server was gone right after (`tmux-gone`) | no (see below) | yes |
| SIGHUP/SIGTERM, not in tmux (a terminal window closed) | no | yes |
| SIGHUP/SIGTERM, and the machine booted within an hour after it (`reboot`) | yes, unless the tmux server outlived it | yes |
| `crash`: exited without a shutdown (uncaught error, dead terminal) | yes | yes |
| the record says live but its pid is dead (SIGKILL, OOM, power loss) | yes | yes |

A `crash` timer never reopens a session you closed on purpose; `always` does,
which is the "remind me at 8 AM even though I closed it" case. Every catch-up
that is due fires on restore, whichever timer woke it. A due time more than
24 h old does nothing (the catch-up would drop it), so it is dropped on its
own: a fresher reason (a later `always` timer, a new bg exit) still wakes the
session, and it is skipped as `stale` only when nothing fresher is due.

**A signal close is judged once, when it happens.** On a SIGHUP or SIGTERM,
the closing pi watches its tmux server (the `$TMUX` pid and its `ps` start)
for up to 300 ms and writes what it saw into the lifecycle record as
`closeVerdict` (`user`: the server outlived the close; `tmux-gone`: it was gone
or replaced) with `decidedAt`. The tick never looks at the tmux server to
judge a close: a server that dies an hour later, for whatever reason, does not
turn an old `kill-window` into a crash. The only later input is the boot time,
and only within an hour of the close (a restart or an OS update, not
yesterday's close and this morning's boot).

**The last window.** Closing the last window on a tmux server takes the
server with it (tmux exits once it has no sessions), so the closing pi sees
the server gone, exactly as it would after `tmux kill-server`, a tmux crash or
a logout without linger. Nothing the closing pi can observe tells these apart,
so `tmux-gone` is **not** crash-class: it is skipped as `user-closed
close=tmux-gone`, and only an `always` timer (or a reboot within the hour)
reopens it. A missed wake beats a surprise reopen.

**Known false negatives** (not woken, though nobody meant to close it):

- `tmux kill-server`, a tmux server crash, or a logout without linger
  (`tmux-gone`, above).
- A shutdown followed by more than an hour powered off: the boot is too long
  after the close to blame it.
- A shutdown whose SIGHUP/SIGTERM reached pi while its tmux server stayed up
  for another 300 ms: recorded as `user`.
- A bg job that finished while bg wakes were off (see bg jobs).

**Known false positives** (woken, though closed on purpose):

- A window closed outside tmux (Ghostty on its own: a SIGHUP with no server
  to check) or a `kill` of pi, followed by a reboot within the hour. `/quit`
  instead of closing the window avoids it.
- The closing pi could not run `ps` in time (no `closeVerdict`), then a
  reboot within the hour.

Liveness is pid + `ps` lstart + host, so a reused pid is not mistaken for pi,
and a `ps` that cannot answer means "unknown", which is never woken.

**Botsun:** closing a session from the phone, by `tmux kill-window` (a SIGHUP
with the server still alive) or by sending `/quit`, reads as `user` either way.
`always` timers still reopen it; `crash` timers and bg jobs don't.

### bg jobs

On by default once wake itself is on, for crash-class closes only. A job wakes
its session when its registry entry (`~/.local/state/pi-bg/<id>.json`) still
says running and unreported, and its `<log>.exit` is newer than the session's close and less than
24 h old. The session file and cwd come from the lifecycle record, never the
job's cwd. Off per job with `/bg --no-wake <id>` (`/bg --wake <id>` undoes it),
globally with `pi-scheduler wake bg off` or `PI_SCHEDULER_WAKE_BG=0` in the
service environment, and implicitly when the service's `PI_BG_WAKE` is `off` or
`nextTurn`, since the reopened session would then report the job without a turn.

A job that finished while bg wakes were off never wakes its session later.
`wake bg on` (when they were off) stamps `bgOnSince` in `wake.json`, and the
tick keeps its own `bgOffSince`/`bgOnSince` in `wake-state.json` for the
switches only it sees (`PI_SCHEDULER_WAKE_BG`, `PI_BG_WAKE`); a bg exit at or
before the later of the two stays quiet. A job that would have woken its
session while bg wakes are off (a crash-class close, a fresh exit) is logged
once per job as `skip <id> reason=bg-off`, and `wake run --dry-run` lists it.

### How a wake runs

The wake phase runs at the start of `check`, before any durable task (those are
sequential agent runs that can take minutes), under the `wake-state.json` lock.
It opens at most `perTick` windows a tick, oldest due first:

```text
tmux new-window -d -t pi-wake: -n wake:<id8> -c <cwd> -e PATH=<service PATH> \
  -e PI_WAKE_ID=<wakeId> -- <abs node> <abs pi-scheduler> wake-exec <wakeId>
tmux set-option -w -t <window> @pi-session <session id>
```

When the tick creates the `pi-wake` session (or a named `tmuxTarget`) itself,
tmux gives it a shell window of its own; the tick closes that once the wake
window is in, so no idle shell lingers there. A session that already existed is
left as it is.

Argv form only, never a shell string, and never a session id. `wake-exec`
checks again under the per-session lock, right before starting pi, that the
session is not live, the file exists, its header names this session, its cwd
exists and the host matches; then it runs `<abs pi> --session <abs file>` (pi
on a missing path would silently start a new empty session). A nonzero exit
goes to `wake.log` with the last 20 lines of stderr. The woken pi stamps its
lifecycle record with the wake id and `opener: "wake"`.

Skipped before spawning, each logged at most once an hour per session and
reason: another host, live, `ps` unknown, session file missing, header
mismatch, header cwd missing, tmux missing or older than 3.0, pi not found, a
window already tagged `@pi-session=<id>`, the hourly caps, a backoff. `stale`,
`user-closed` and `bg-off` cannot change until the due time (for `bg-off`, the
job's exit) does, so each is logged once per due time; no record (print mode,
subagents) is not logged at all.

`wake-exec` refusing (live, file or cwd gone, `ps` unknown, a lock timeout) is
the safety check working, not a failed wake: it is logged as `refuse`, and the
hourly ledger already bounds repeats. Only `pi-missing` counts as a failure,
since it would fail the same way every time.

The live record is written synchronously at `session_start`, before pi draws
its first frame, without a `pidStart` (read as "unknown", so never woken over)
until `ps` fills it in a moment later. If that moment finds another live pi on
this host already holding the session, pi warns "already open in pid N": the
residual race between a wake and a manual or Botsun open.

### Failures and backoff

- **Success:** a lifecycle record with the wake's id goes live and is still
  live 10 minutes later (or closed normally by then).
- **Failure:** no such record and no live pane after 3 minutes (a gap between
  ticks longer than 3 minutes is a sleep, and does not count); a pane alive but
  never live after 10 minutes (`stuck`, never killed); a crash or vanish within
  10 minutes of going live.
- Two failures in a row back the session off until you open it by hand
  (`opener: "manual"`) or run `pi-scheduler wake reset <id>`. A manual open
  after a single failure resets the count too.
- The sleep check is only a gap between ticks, so a tick that spends 15
  minutes on durable agent runs also reads as a sleep, and stretches grace and
  `stuck` by that much.
- Lifecycle records are pruned 7 days after a close, except while the index
  still has a pending wake or `always` timer for that session (a 30-day
  `--wake=always` timer after a `/quit`), and `live` records not seen for 7 days
  go once their pid is dead. Another host's in-flight wakes are dropped after
  24 h.
- Caps: 3 wakes per session and 10 in all per hour, 1 per tick, keyed by host;
  the tick acts only on records from its own host.

### Commands and config

```text
pi-scheduler wake status          # switch, paths under the service env, in-flight wakes,
                                  # backoffs, caps, next candidates, wake.log tail
pi-scheduler wake run --dry-run   # what the next tick would wake, and why the rest wait
pi-scheduler wake on|off          # the global switch (off by default)
pi-scheduler wake bg on|off       # bg-job wakes; on stamps bgOnSince, earlier exits stay quiet
pi-scheduler wake reset <id>      # clear a backoff
```

`~/.pi/agent/scheduler/wake.json`, all optional:

```json
{ "enabled": false, "bg": true, "bgOnSince": 1795000000000, "tmuxTarget": "pi-wake",
  "perSessionHourly": 3, "globalHourly": 10, "perTick": 1,
  "tmux": "/opt/homebrew/bin/tmux", "pi": "/Users/you/.pi/agent/bin/pi" }
```

`tmuxTarget` is `pi-wake` (a dedicated session, created if missing), `attached`
(the first attached session, else `pi-wake`) or a session name. `pi` defaults to
`~/.pi/agent/bin/pi`, then `pi` on the service PATH; the window's PATH puts the
tick's node first, so the wrapper's `exec node` resolves. Config lives in a file
because shell environment never reaches launchd or systemd.

`wake-state.json` (in-flight wakes, failures, the hourly ledger) and `wake.log`
(one line per wake, skip and failure, rotated at 1 MB keeping one `.1`) are both
0600. Like the lifecycle records they hold ids, paths, reasons and times only:
never a prompt, or a bg job's command, name, summary or meta. The one
exception: when a woken pi exits nonzero, the last 20 lines of its stderr go to
`wake.log` (JSON-escaped), and a crash stack can carry whatever pi printed.

### Platform notes

- **macOS (launchd):** the tick's job is `ProcessType Background` with
  `LowPriorityIO`, and everything it forks inherits that throttling. When no
  tmux server is running, the tick starts one through `launchctl asuser <uid>
  taskpolicy -d default -g default tmux new-session -d -s pi-wake`, falling back
  to a plain `new-session` if asuser fails. Either way it then moves the server
  out of the background band with `taskpolicy -B -p <pid>` (logged as
  `tmux-throttled` if that fails); `wake status` shows the server's pid, `pri`
  and `nice` so you can check. A server you started yourself is never affected.
  Windows inherit the tmux **server's** environment, not the tick's, hence the
  explicit `-e PATH`.
- **A server the tick started gives woken pi a thin environment:** the
  service's, which has no `LANG` and none of the keys your shell exports. A
  server you started yourself passes on your shell's environment. If a woken
  pi needs more, start the `pi-wake` session (or the server) yourself.
- **Linux (systemd --user):** the `Type=oneshot` unit's default
  `KillMode=control-group` would kill a tmux server the tick starts, so it is
  started in its own scope with `systemd-run --user --scope`; if that fails
  there is no plain fallback (the server would die with the unit), and the
  generated unit sets `KillMode=process` besides. Without linger
  (`sudo loginctl enable-linger $USER`) there is no tick until you log in, and
  logging out ends the tmux server.
- `install` captures `TMUX_TMPDIR`, `XDG_STATE_HOME`, the `PI_BG_*` dirs,
  `PI_BG_WAKE` and `PI_SCHEDULER_WAKE_BG` along with PATH, so the tick talks to
  your tmux server and reads your bg registry. Reinstall after changing them.
  Only PATH's absolute entries go into the plist or unit (and a woken window's
  `-e PATH`): a relative one such as `.git/safe/../../bin` would resolve against
  whatever cwd the service runs in.

## Durable tasks: `/schedule`

`extensions/durable-scheduler.ts` plus `bin/pi-scheduler`. These run whether or
not pi is open, which is the point: a weekday grade check at 15:30 cannot
depend on a terminal being left running.

```text
/schedule --name grades --model openai/gpt-5-mini daily 15:30 :: check the kids' grades
/schedule cron 30 15 * * 1-5 :: weekday grade check
/schedule --misfire always once 8p :: check in on the deploy
/schedule list [all] | show <id> | runs <id>
/schedule run <id> | pause <id|all> | resume <id|all> | remove <id>
/schedule edit <id> [--model <model>|--no-model] [--cwd <dir>] <schedule> :: <prompt>
```

`/schedule edit` replaces the schedule and prompt and keeps the rest (id,
name, delivery, history, paused): `pi-scheduler edit --schedule --prompt` in
one line. The model and cwd stay too, unless the edit names them: `--model`
sets a pattern as pi's `--model` takes it, `--no-model` goes back to pi's
default, and `--cwd` moves the task to another folder (an absolute path to a
directory that exists; quote one with spaces, `--cwd "/Users/me/My Project"`).
These go before the id or right after it, ahead of the schedule; no other
option is taken here (delivery and the rest: `pi-scheduler edit`). It refuses
a task that is running.

```text
/schedule edit grades --model openai/gpt-5-mini --cwd /Users/me/Code/school daily 15:30 :: check the kids' grades
```

`/schedule run` fires a task now, exactly as the timer would: **its own pi, its
own cwd and model, not this conversation and not this conversation's context.**
It does not block the session — a task's timeout defaults to 15 minutes, and
waiting that long to watch an unattended job is the wrong trade — so the footer
shows what is in flight and the output arrives as a notice when it lands.
`runs` (plural) is the read-only history.

Options go **first**, before the schedule: `--name --model --cwd
--with/--without --deliver --misfire --timeout`. Flags are only recognized
while they lead, because the schedule itself is variable length (a cron
expression is five bare words) and there is otherwise no reliable place to stop
scanning — so a prompt containing `--force` is never mistaken for an option.

The same tasks are managed from the shell:

```sh
pi-scheduler install          # per-minute launchd job, or systemd --user timer
pi-scheduler list
pi-scheduler add daily 15:30 :: check grades --name grades
pi-scheduler run grades       # ignore the schedule and run now
pi-scheduler runs grades      # recent history
pi-scheduler check            # what the timer calls (session wakes first, then due tasks)
pi-scheduler wake status      # see Waking closed sessions
pi-scheduler uninstall
```

Quote a cron expression in the shell — `cron 30 15 * * 1-5` is otherwise
expanded into filenames before the scheduler ever sees it.

### Nothing stays resident

A launchd job (or systemd `--user` timer on Linux) runs `pi-scheduler check`
every 60s; it reads a few small JSON files and exits when nothing is due. pi is
only spawned when a task is actually due, or a closed session is woken (in tmux,
not by the tick itself).

The launchd label is `com.ericboehs.pi-scheduler`; the systemd unit is
`pi-scheduler.timer`. Neither tick catches up on its own after a suspend —
launchd fires on wake and the systemd timer simply resumes its interval — so
catching up a slot that passed while the machine was asleep is the misfire
policy's job, which works identically on both. On Linux, user timers stop when
your last session ends unless you `sudo loginctl enable-linger <user>`.

The installed unit captures `PATH`, `HOME`, and `PI_SCHEDULER_DIR` /
`PI_AGENT_DIR` if you have them set, because launchd and systemd start jobs
with a bare environment. Reinstall after moving node, pi or mise, or after
changing where the registry lives.

### What a scheduled run loads

Each run is a fresh `pi -p` that loads **what an interactive pi would**: your
extensions, skills, prompt templates, and the `AGENTS.md` of the directory the
task was created in — subject to pi's own project-trust policy, so a task in a
directory you have never trusted will skip its extensions, skills and
templates. A task records its cwd at creation, so project context is the
context you had in mind when you wrote the prompt. That means the prompt
can simply be a slash command:

```sh
cd ~/Code/some/repo
pi-scheduler add --name checkin daily 9a :: /checkin
```

Full discovery costs a little more at startup than a stripped run, which is
nothing for something that runs once a day, and the alternative — a scheduled
run that behaves unlike the pi you tested the prompt in — is a worse trade.

**If the recorded directory no longer exists, the run falls back to `$HOME`**
rather than failing — a moved project should not silently stop a daily task.
That does mean a tool-enabled prompt written for one repo can end up running
against your home directory, so `pi-scheduler show <task>` after moving things
is worth the two seconds. A directory that still exists but cannot be entered
is an error, not a fallback.

`--without` strips pieces back out: `extensions`, `skills`, `templates`,
`context`, `tools`. `--without tools` makes a run answer-only, worth doing for
anything that just summarizes. `--with` is the inverse allowlist, and `--with
none` is a bare pi — fastest, and immune to a broken extension. Themes have no
switch and are always off: there is no TUI to theme, and `--no-session` is
always passed so an unattended daily job cannot grow a session file forever.

Runs are never messages into an existing session: pi appends to session JSONL
without file locking, so writing into a session that might be open in a
terminal risks interleaved entries. Each run is its own pi, which is also why a
task carries its own `--model` rather than inheriting whatever a human left
selected three days ago.

### Delivering the result

`--deliver` is a shell command that receives the output on stdin and in
`$PI_SCHEDULER_OUTPUT`. The prompt and the result both travel by stdin rather
than argv, so neither shows up in `ps`.

```sh
pi-scheduler add --name grades --model openai/gpt-5-mini \
  --deliver 'my-slack-webhook-script' \
  'cron 30 15 * * 1-5' :: 'Summarize these grades and flag anything below 80.'
```

A run is only recorded `ok` if the delivery command also exits 0, so a broken
webhook shows up in `pi-scheduler runs` instead of failing silently.

A failed run pages the same channel. When the tick runs a task and the run
fails — the model is unreachable, the run overran its timeout, or the delivery
itself errored — it sends a short `:rotating_light:` notice through the same
`--deliver` command: the task, what happened, and the error, with the error
also in `$PI_SCHEDULER_ERROR` for one-liners that want it structured. The
notice is best-effort and never rewrites the run record: a delivery channel
that is itself down is one more line in the tick's log, not a lost original
error. Manual `run` sends nothing — whoever asked for the run is already
watching.

### Missed fires

`--misfire` decides what a late run does, because machines sleep: `skip` never
runs late, `always` always does, and a duration (default `2h`) is the window
within which a catch-up is still wanted. Late runs **coalesce** — one catch-up,
never a replay of every missed slot.

### Storage and concurrency

The registry is `~/.pi/agent/scheduler/` (override with `PI_SCHEDULER_DIR`),
mode 0700 with 0600 files, since prompts and run output are routinely private.
Read-modify-write goes through a `mkdir` mutex held only for the JSON round
trip; the agent run itself happens outside the lock, guarded instead by a claim
recorded on the task, so two overlapping ticks cannot double-run one job and a
runner that dies has its claim reclaimed rather than wedging the task forever.

A claim is reclaimed either when the runner's process is gone (checked with
signal 0) or when it has outlived `--timeout` by six hours, whichever comes
first. The pid check only applies to claims this machine wrote — the claim
records its hostname, because a pid from another machine says nothing here.

**The registry assumes one machine.** Pointing two computers at one
`PI_SCHEDULER_DIR` on a synced or network volume is not supported: the lock
serialises writes to the JSON, but nothing stops both hosts deciding a task is
due and running the prompt twice. The hostname on the claim keeps the pid check
from making that *worse*; it does not make the arrangement work. Give each
machine its own directory.

## Cron syntax

Both schedulers take a standard 5-field crontab expression (minute, hour,
day-of-month, month, day-of-week) with ranges, lists, `*/n` steps, and
`jan`/`mon` style names, plus the `@hourly`, `@daily`, `@weekly`, `@monthly`
and `@yearly` macros. When both day-of-month and day-of-week are restricted
they are OR'd, matching Vixie cron. There is no seconds field — a 6-field
expression is rejected rather than reinterpreted, and an expression that can
never match (`0 0 30 2 *`) is refused at creation.

## Edge cases worth knowing

Session timers live in custom session entries, so they restore when you resume
that session and are not inherited by `/new`, `/fork` or `/clone`. A fire that
came due while pi was closed is delivered once on the next resume (see
[catch-up](#catch-up-a-fire-missed-while-pi-was-closed)); a fire that came due
while the *session* was paused or replaced is not. Recurring intervals have a
one-minute minimum, in both schedulers.

From pi's `SessionManager._persist`: pi does not create the session file until
the session holds at least one assistant message. A timer set before that is
buffered in memory and written out with the first reply — but one set in a
session that never prompts the model is lost on exit. `/once` and `/loop` warn
when they detect this state, and the task is still created. `/schedule` is
immune, since it writes to its own registry.

## Development

```sh
npm test          # node --test test/
npx tsc --noEmit  # needs node_modules/@earendil-works/pi-coding-agent linked
```

`erasableSyntaxOnly` in `tsconfig.json` is load-bearing rather than style. pi
transpiles extensions, but `bin/pi-scheduler` imports the same `.ts` modules
under Node's strip-only mode, which rejects parameter properties, enums and
namespaces outright. Fix the construct, never relax the flag.

`extensions/lib/` is imported by all three front-ends — the extension, the CLI,
and the tick — deliberately, so they agree exactly on when a task is due. It is
excluded from the `pi.extensions` glob in `package.json` so pi does not try to
load those modules as extensions.

## License

MIT
