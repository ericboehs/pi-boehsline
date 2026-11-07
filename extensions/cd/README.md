# cd

`/cd <dir>` continues this conversation in another directory, like a shell `cd`. It needs pi
running in tmux, with the [restart](../restart/README.md) extension's live record: it forks the
session into the new directory, then lets `pi-restart-all` relaunch pi in the same pane.

```
/cd ~/Code/github.com/ericboehs/pi-boehsline
/cd ../another-project
```

- `~` and `~/…` expand; a relative path resolves against the session's cwd.
- A missing path, a file, or the current directory is reported and nothing changes. With no
  argument it shows the usage.
- Outside tmux, or without the restart extension's record, it says
  `/cd needs pi running in tmux` and changes nothing.
- It waits for an idle agent, then forks the session file into the target directory with
  `SessionManager.forkFrom`: a new session with the same conversation, the target `cwd`, and the
  source session as its parent. The source session stays where it is.
- Before relaunching it says `Continuing in <dir> (new session <short id>)`.
- It runs `bin/pi-restart-all --only <pane> --session <new file> --cd <dir>`, detached under the
  tmux server. That sends this pi `SIGUSR2` (it shuts down once idle) and starts
  `cd -- <dir> && pi --session <new file>` in the pane, restoring the approval guardian's bypass
  as a restart does.

Plain `pi-restart-all` (no `--session`/`--cd`) still restarts every session where it is.
