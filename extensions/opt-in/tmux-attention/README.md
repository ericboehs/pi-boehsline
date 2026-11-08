# tmux-attention

*Opt-in:* `/boehsline enable tmux-attention`.

Brightens the tmux window number when pi needs you in a background window: a finished turn, or a question waiting on an answer (`ask`, a confirm or an input). A quiet run's settle does not brighten it; the quiet extension's `notify_user` or classifier result does, through `quiet:attention`.

It sets the window option `@special_activity` when pi needs you, and keeps `@agent_count` set while a pi in the window is working (a theme can dim the window number then). New work clears a stale `@special_activity` and `@job_done`. A quiet run leaves the flag alone, and `quiet:attention` sets or clears it as Eric's next input arrives. Your tmux theme decides how these look. Focusing any pane in the window should clear the attention flag, which takes a hook in `~/.tmux.conf`, for example:

```tmux
set-hook -g pane-focus-in 'set -w -u @special_activity ; set -w -u @job_done'
```

**Needs:** tmux, with `focus-events on`.
