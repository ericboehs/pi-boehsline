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
has timers and when they are next due, for [#the-session-timer-index](#the-session-timer-index).

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
- **At most once.** A catch-up one-shot is recorded as delivered *before* the
  prompt is sent, so a crash in between loses that reminder rather than
  repeating it. A recurring catch-up is re-armed before it is queued, so a
  queued fire that never gets sent is the one thing catch-up can lose.
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
recorded on the task and published in the index; the tick that actually
reopens a session is a separate change, so today it changes nothing else.

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
  "wake": "always", "count": 2, "updatedAt": 1763833000000 } } }
```

- Metadata only: no prompts ever go in it, so a process that reads it learns
  when a session is next due and nothing about what you scheduled.
- `count` is unpaused timers; `nextWakeDueAt` and `wake` cover the tasks asking
  to be woken, strongest level wins (`always` > `crash`). An entry disappears
  when the session has nothing unpaused left.
- `pid` plus `pidStart` (ps `lstart`) and `host` identify the live pi holding
  the session; both are cleared with `closedAt` on shutdown for any reason, so
  after `/resume` or `/fork` the old entry no longer claims a live process.
- Written under a lock, atomically, mode 0600 (directory 0700), and left alone
  when nothing changed. A session is indexed once its file exists (pi writes
  the file with the first reply); an entry is pruned only when its file is gone
  *and* its pi is dead.
- Two pi processes on one session would each catch up the same missed timer, so
  a restore checks this index first and leaves the catch-up to the live holder.

This is what a future `pi-scheduler` tick can use to wake a session for a
`--wake` timer. Nothing reads it to fire timers yet.

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
pi-scheduler check            # what the timer calls
pi-scheduler uninstall
```

Quote a cron expression in the shell — `cron 30 15 * * 1-5` is otherwise
expanded into filenames before the scheduler ever sees it.

### Nothing stays resident

A launchd job (or systemd `--user` timer on Linux) runs `pi-scheduler check`
every 60s; it reads one JSON file and exits when nothing is due. pi is only
spawned when a task is actually due.

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
