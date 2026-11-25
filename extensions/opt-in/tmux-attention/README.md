# tmux-attention

*Opt-in:* `/boehsline enable tmux-attention`.

Brightens the tmux window number when pi needs you in a background window: a finished turn, or a question waiting on an answer (`ask`, a confirm or an input). A quiet run's settle does not brighten it; the quiet extension's `notify_user` or classifier result does, through `quiet:attention`.

It sets the window option `@special_activity` when pi needs you, and keeps `@agent_count` set while a pi in the window is working (a theme can dim the window number then). New work clears a stale `@special_activity` and `@job_done`. A quiet run leaves the flag alone, and `quiet:attention` sets or clears it as Eric's next input arrives. Your tmux theme decides how these look. Focusing any pane in the window should clear the attention flag, which takes a hook in `~/.tmux.conf`, for example:

```tmux
set-hook -g pane-focus-in 'set -w -u @special_activity ; set -w -u @job_done'
```

**Needs:** tmux, with `focus-events on`.

## Program status (OSC 7501)

**Off by default.** pi reports what it is doing to the terminal through the
[Program Status Protocol](https://mitchellh.com/writing/program-status-osc7501)
(`working`, `blocked`, `done`, …), but only to a terminal that answered its
query, and tmux answers none: it drops an OSC it does not know, so a pane's pi
never reports anything.

With this setting on, the same states are written to stdout wrapped in tmux's
DCS passthrough (`ESC P tmux; … ESC \`), which tmux unwraps and the outer
terminal draws — the window tab shows what the pi in it is doing.

```jsonc
// ~/.pi/agent/boehsline.json
"tmux-attention": { "programStatus": true }
```

Checked against tmux 3.8: a pane's raw report never reaches the client (with `allow-passthrough` off or `all`), and the wrapped one arrives as the OSC pi wrote.

It needs tmux's `allow-passthrough` (`on`, the active pane only, or `all`);
without it nothing is written at all, and the probe is one `tmux show-options` at
session start. It also stays quiet when pi reports for itself
(`PI_PROGRAM_STATUS` is set), so no state goes out twice, and it writes `clear`
on exit.

One `ActivityTracker` (`lib/program-status.ts`) feeds both this and the window
flag, so the window and the terminal never disagree: a dialog that blocks is
`blocked` in the terminal and `@special_activity` on the window, and closing it
clears both.
