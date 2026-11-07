# restart

Lets `bin/pi-restart-all` restart every pi running in tmux and resume each one where it was, for
example after a pi update that `/reload` can't pick up. No command.

Each interactive pi in a tmux pane keeps a record in `~/.local/state/pi-restart/live/<pid>.json`
(mode 0600): its session file, cwd, tmux pane and socket, whether the approval guardian is
bypassed, and whether the agent is idle. `SIGUSR2` asks pi to shut down; pi waits until the
agent is idle, so a running turn finishes first.

`pi-restart-all` (in this package's `bin/`) then, for every session at once:

1. sends `SIGUSR2` and waits for pi to exit (15 minutes at most, `--wait`);
2. starts `pi --session <file>` in the same pane (typed into the pane's shell, or the pane is
   respawned when it closed with pi);
3. if the guardian was bypassed, types `/approval-guardian bypass` into the new pi. The bypass
   is turned back on by the guardian's own command, never by a flag or a file that could start
   pi bypassed.

It runs in the background (under the tmux server, so it can restart the pi that started it) and
logs to `~/.local/state/pi-restart/last.log`. `--dry-run` lists what it would do, `--only %12`
restarts one pane. Sessions started before this extension are listed; `/reload` them once, or
pass `--reload-old` to type `/reload` into the ones agent-link shows idle (text left unsent in
that pane's editor would be sent with it).

[botsun-owner](../opt-in/botsun-owner/README.md)'s Restart (the phone's info sheet) runs
`pi-restart-all --only <its pane>` for its own session, and offers it only while this record is there.
