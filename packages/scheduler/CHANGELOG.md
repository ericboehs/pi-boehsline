# Changelog

Notable changes to pi-scheduler. While the major version is 0, a minor bump may
change behaviour; each one says what it breaks.

## [Unreleased]

### Added

- **Waking closed sessions.** `pi-scheduler check` now reopens a closed
  session in tmux when one of its `--wake` timers is due, or when a bg job it
  started finished after it closed; pi's own restore then fires the catch-up
  or reports the job. The wake phase runs before the durable tasks, under the
  `wake-state.json` lock, at most one spawn per tick (oldest due first), 3 per
  session and 10 in all per hour. Windows open in a dedicated `pi-wake` tmux
  session via `tmux new-window … -- <abs node> <abs pi-scheduler> wake-exec
  <wakeId>` (argv form, `-e PATH`, `-e PI_WAKE_ID`, tagged `@pi-session`);
  `wake-exec` re-checks liveness, the session file, its header id and cwd and
  the host under a per-session lock, then runs `<abs pi> --session <abs
  file>`. When the tick has to start the tmux server, Linux uses
  `systemd-run --user --scope` and macOS `launchctl asuser` + `taskpolicy`.
- Session lifecycle records, `sessions/<id>.json`, written by the session
  scheduler in TUI mode: `live` at start, `closed` with `how`
  (`user`, `switched`, `signal:SIGHUP|SIGTERM`, `crash`) at shutdown or from a
  synchronous exit hook. `crash` timers and bg jobs wake only crash-class closes
  (a crash, a vanished pid, or a signal after a reboot or with the tmux server
  gone); `always` timers also wake a deliberate quit. No record, never woken.
- The index gains `nextAlwaysDueAt`, the earliest `always` timer alone.
- Grace (3 min, stretched over sleep), `stuck` (10 min, never killed), crash
  within 10 minutes as a failure, and a backoff after two failures in a row
  until a manual open or `wake reset`.
- `pi-scheduler wake status | on | off | bg on|off | reset <id> | run
  --dry-run`, and `wake.json` (`enabled`, `bg`, `tmuxTarget`,
  `perSessionHourly`, `globalHourly`, `perTick`, `tmux`, `pi`). `wake.log`
  (0600, rotated at 1 MB) holds ids, paths, reasons and times only.
- `install` also captures `TMUX_TMPDIR`, `XDG_STATE_HOME`, `PI_BG_STATE_DIR`,
  `PI_BG_DIR`, `PI_BG_WAKE` and `PI_SCHEDULER_WAKE_BG` into the service
  environment. Reinstall to pick them up.

- Session timers survive pi being closed. A `/once` or `/loop` fire that came
  due while pi was not running is **delivered once** when the session is next
  resumed (before, it was dropped silently), prefixed with when it was due and
  how late it is. A recurring timer fires once for a miss and then re-arms to
  its next future slot from its interval, so a week away is one catch-up, not a
  week of them. Missed fires are delivered oldest first, one per settle, at most
  `MAX_CATCHUPS` (5) per restore; the overflow is skipped with a notice.
- A staleness cap for catch-up: a fire more than 24h late is skipped with a
  notice instead of delivered. Per task with `/once --misfire=6h …` (also
  `skip` and `always`), globally with `PI_SCHEDULER_SESSION_MISFIRE`.
- `wake` on a session timer: `/once --wake` (`crash`: reopen after an
  unexpected exit), `--wake=always` (reopen even after a deliberate quit), and
  `--no-wake` to clear it. The `schedule` tool takes `wake` only when the
  opt-in also sets `"allowWake": true` (default false), because an unattended
  reopened turn has the user's full tool set. The tick reopens the session
  (see "Waking closed sessions" above).
- `~/.pi/agent/scheduler/session-timers.json`: a small, locked, atomically
  written index saying which sessions have timers, when the earliest is due and
  when the next `wake` timer is due, plus the pid/lstart/host of the live pi
  holding it. Metadata only — never a prompt — so an outside process can decide
  when to wake a session without reading session files. Entries are removed at
  zero unpaused timers and pruned when their session file is gone and their pi
  is dead.
- Opt-in `schedule` tool so the agent can set and manage session timers:
  `once`, `loop`, `list`, `cancel`, `pause`, `resume`. Off unless
  `scheduler-tool` is in Boehsline's `enable` list; deferred by default
  (`"scheduler-tool": { "exposure": "direct" }` to always declare it).
  Agent-set timers are marked `source: "agent"` and fire with a label saying
  so. Nothing changes with it off.
- `/schedule edit` takes `--model <model>`, `--no-model` (pi's default) and
  `--cwd <dir>` (absolute, an existing directory; quote one with spaces),
  before the id or after it, to move a task's model or folder while keeping
  its id, name, delivery and history. Any other option is refused there.
- `extensions/lib/locked-file.ts`: the mkdir-mutex read-modify-write pulled out
  of `task-registry.ts`, now shared with the session index; `withRegistry`
  wraps it. `extensions/lib/process-identity.ts` holds the `ps` lstart lookup
  that `extensions/bg` and the index both need, so the two cannot disagree
  about whether a pid is still that process.

### Changed

- **Session timers now catch up instead of dropping missed fires.** Deferring
  to `/schedule` for anything that must happen while pi is closed is still the
  right advice for work, but a reminder that came due during a reboot is no
  longer lost. Catch-up happens on `session_start` with reason `startup`,
  `resume` or `reload` only: `/new`, `/fork` and `/clone` inherit nothing (the
  snapshot names the session id), tree navigation never replays a slot an
  older branch already fired, and `/loop resume` still skips what was missed
  while paused. In print mode (`pi -p --session`) the snapshot is left exactly
  as it is: no catch-up, no drop, no write.
- **At most once, and never abandoned.** A one-shot — catch-up or live — is
  removed from the snapshot and persisted before its prompt is sent, and put
  back (and persisted again) if the send throws; a crash between the two loses
  that prompt rather than repeating it. Until it is delivered, a catch-up
  one-shot stays in the snapshot unarmed, so a quit, crash or `/reload` before
  delivery leaves it there and the next resume retries it. A recurring catch-up
  is re-armed before it is queued, so a queued recurring fire lost to a quit is
  the one gap.
- A restore that finds another live pi holding the session (pid, `ps` lstart and
  host in the index) now leaves the session to it: the list is restored, but
  nothing is armed, caught up, dropped or persisted, and a notice names the
  holder's pid. Before, it still ran the resume normalization, which advanced
  recurring timers and dropped due one-shots the holder owned, and persisted
  that over its view.
- The index knows who is writing. A claim puts this pi's pid in; a release
  clears it only when it is ours (or its holder is dead); a passive write (print
  mode, held elsewhere) updates the timing fields and never takes the pid from a
  live holder. `pi -p --session X` can no longer mark a live `X` closed on exit.
- A missing `pidStart` no longer counts as a match, so a reused pid cannot
  masquerade as the holder. The index is quarantined only for a parse or shape
  error; an index from a newer pi (or one that cannot be read at all) is
  reported and never rewritten.
- Live `setTimeout`s are armed in 60s chunks and re-check `Date.now()`, because
  libuv's clock does not advance during macOS sleep; a live fire more than 2
  minutes late now takes the catch-up path (prefix and cap) instead of looking
  on time, and its prefix says "because the computer was asleep" rather than
  claiming the session was not open.
- Two pi processes on one session no longer both catch up: the restore checks
  the index for another live holder (pid, `ps` lstart and host) and leaves the
  missed fires to it.
- The session status is plain text (`2 timers · 1 paused`) instead of
  `⏰ 2 ⏸1`. Boehsline's footer renders it as a `◷` Timers chip.
- `list` and the `schedule` tool's output show `wake` / `wake always`, and the
  `/once` notice now says a missed fire is delivered on the next resume rather
  than "keep this session open or it will not fire".

### Fixed

- `/once help`, `/loop help` and the bare-command usage now document `--wake`,
  `--misfire` and the catch-up behaviour they used to deny.
- `--wake` / `--no-wake` / `--misfire=` are only read as flags in the positions
  they belong in — leading, right after the time, or trailing (and after the id
  or time on an `edit`) — so a prompt that mentions `--no-wake` keeps it, and
  `--misfire 6h` says to write `--misfire=6h`.
- The index `count` is the unpaused timers, as documented: a queued fire moves
  `nextDueAt` earlier but is not a timer of its own.
- The missed-slot walk starts at the cap window instead of at the stored slot,
  so a minute-granularity cron missed for weeks is measured at its newest slot
  (a minute ago) rather than 1000 steps in and hours out of date.
- The index lock is tried for ~200ms, not ~2s, before giving up: a lock left
  behind by a crashed holder used to freeze the TUI for two seconds on every
  persist and every fire. Taking a stale lock is a rename now, so two waiters
  cannot both decide it is stale and one delete the other's fresh lock. Pruning
  makes at most four `ps` calls per write.


## [0.2.0] — 2026-08-24

A correctness pass over the durable scheduler, from a multi-pass review of the
whole repository. There are no new features. Every entry is a case where the
scheduler could run a task twice, lose something, or report success for
something that did not happen.

### Upgrading

Re-run `pi-scheduler install`. The generated launchd plist and systemd units
changed, and an existing install keeps running the old ones until it is
replaced.

Two things are stricter and may break a script:

- Unknown or misplaced flags are errors instead of being ignored.
- `resume` on a one-shot whose time has passed leaves it paused and exits 1.
  Give it a new time with `edit --schedule`.

### Fixed — running a task twice

- `pi-scheduler run` did not claim the task. A manual run and the minute tick
  could both spawn pi for the same prompt, double-advance the schedule, and pay
  for the model twice.
- A claim left by a runner that was SIGKILLed blocked its task for the full
  six-hour stale window. A claim is now also stale once its runner's pid is
  gone.
- That pid probe is per-host. A claim records `runnerHost` and a foreign one is
  never probed, so two machines sharing a registry do not each read the other's
  live runner as dead — which would have been worse than the age rule it
  replaced.
- A run that overran the stale window and was reclaimed by another runner could
  report its result over the new claim and release it, returning a task to the
  pool while it was still running. `settleRun` now settles only as the claim it
  was handed.

### Fixed — losing data

- A corrupt or unreadable registry read as empty, and the next `add` wrote that
  emptiness over the file. Every task, gone. It is now an error.
- A single malformed task entry was silently dropped by the next write. Entries
  that fail validation are quarantined instead: kept verbatim, written back,
  never scheduled or matched.
- `forgetRuns` swallowed every failure, so `remove` reported success with the
  prompts and outputs still on disk.
- A `/once` was removed from the list before delivery was attempted, so one
  that failed to deliver vanished without a record.
- A failed history write inside `settleRun` took the claim release with it.

### Fixed — reporting success for something that did not happen

- `install` and `uninstall` ignored every `launchctl` and `systemctl` exit
  code. "Installed" over a scheduler that was not running; "Removed" over one
  still firing every minute.
- `uninstall` deleted the unit files even when the job could not be stopped,
  taking with them the configuration needed to retry or diagnose.
- `runs` reported "no runs recorded" over a log it could not open.
- A delivery whose output exceeded 128KiB failed the entire spawn with `E2BIG`
  on Linux — one env var over `MAX_ARG_STRLEN` — so the task ran and delivered
  nothing. Only the environment copy is capped now; stdin still carries it all.
- EPIPE writing a prompt to pi was swallowed along with the harmless kind, so a
  pi that never received its prompt could report a confident answer to a
  question that was never fully asked. The two cases are now distinguished.

### Fixed — crashing, hanging, or stranding the tick

- A grandchild holding the stdio pipes meant `close` never fired and a run hung
  to its timeout. Children are spawned detached and signalled as a group.
- A history line carrying a non-string `error` took down the whole `runs`
  command through `record.error.split`.
- One task failing to settle stranded every other due task in the same tick.
- `die()` called `process.exit` from inside the registry lock, skipping the
  release, so one bad argument blocked every other invocation — including the
  tick — for 60 seconds.
- Kill-escalation timers survived a child that exited promptly, so `SIGKILL`
  could later be sent to a pid the OS had reassigned.

### Fixed — doing nothing, quietly

- A typo'd or misplaced flag was accepted and ignored (`list --model x`,
  `--nmae nightly`). Flags are now checked against the command invoked.
- Short flags were positional, so `run -x` took `-x` as the task selector and
  `check -x` succeeded silently.
- `runs <id>` failed for a one-shot that had already retired, which is exactly
  the case people ask about: the reminder that should have fired last night.
- Resuming a durable one-shot whose moment had passed fired it immediately —
  the one thing pausing was meant to prevent.
- A session snapshot that was corrupt, or had no session id, fell through to an
  older one and re-armed timers the user had cancelled.
- The installed service read the default registry even when installed from a
  different `PI_SCHEDULER_DIR`, which looks exactly like a scheduler that
  silently does nothing. The units now carry `PI_SCHEDULER_DIR` and
  `PI_AGENT_DIR`.
- `nameTaken` was case-sensitive while lookup was not, so `add --name Nightly`
  alongside `nightly` created a task that could never be selected.

### Changed

- `Persistent=true` is gone from the systemd timer. It applies only to
  `OnCalendar=`, and this unit uses `OnBootSec=`/`OnUnitActiveSec=`; catching up
  after sleep is the misfire policy's job on both platforms.
- Environment values in the systemd unit are quoted as systemd.exec(5)
  documents, and the plist is XML-escaped, so a path containing a space or `&`
  survives installation.
- A task whose recorded cwd was deleted falls back to `$HOME`; one that exists
  but cannot be used is an error rather than a fallback. This was only ever in
  a source comment and is now in the README.
- Two benchmark figures in the README had no measurement behind them and have
  been removed rather than restated more precisely.

### Added

- `test/cli.test.mjs` — `bin/pi-scheduler` exercised end to end as a real
  subprocess against a fake `pi` that records its invocations, so exactly-once
  behaviour is asserted rather than reasoned about.
- `test/invariants.test.mjs` — source-level checks for the one bug class that
  behaviour tests cannot see: a fix applied to the CLI but not the extension,
  or the reverse. Both paths work; they just disagree.
- `test/runner.test.mjs` — the subprocess layer on its own.
- 113 tests to 176.

## [0.1.0] — 2026-08-24

First release.

- `/once` and `/loop` — timers that fire a prompt into the current
  conversation.
- `/schedule` — durable tasks that run in their own `pi -p` whether or not pi
  is open, with per-task model, cwd, delivery command and misfire policy.
- `pi-scheduler install` — a per-minute launchd job or systemd `--user` timer.

Neither extension registers an LLM tool or adds anything to model context.

[0.2.0]: https://github.com/ericboehs/pi-scheduler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ericboehs/pi-scheduler/releases/tag/v0.1.0
