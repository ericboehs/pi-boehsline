# op-broker

*Opt-in:* `/boehsline enable op-broker`, then `/reload`.

Lets the agent read 1Password without a Touch ID prompt for every command. Instead, each item gets an approval card in the session, and one 1Password unlock is shared by all your pi sessions.

```
🔑 1Password: GitHub · token (Personal)
for: bash -c gh auth login --with-token
  > Allow once
    Allow for 1 hour
    Allow for 8 hours
    Deny
```

## How it works

- **The `op` shim.** This folder goes first on `PATH` for everything pi runs, so the bash tool's `op` is the shim. It takes these forms:
  - `op read <op://…> [-n]`
  - `op item get <item> [--vault V] --otp`
  - `op item get <item> [--vault V] --fields <f,g> --reveal`
  - `op signin` (answered at once) and `op whoami`

  Each accepts `--account A`. Every other `op` command, and any form with other flags, runs the real `op`, unchanged.
- **The card.** The session shows what's asked and the command it's for. A grant covers that item (every field) in this session: once, for 1 hour, or for 8 hours. Deny, Esc or no answer within 5 minutes refuses, and the command fails as `op` does.
- **The daemon.** One per user, started on demand inside a pseudo-terminal of its own (`script`). The 1Password CLI authorizes a terminal, so the first approved read pops **one** Touch ID, and every later read from any session goes through it. It stays warm with `op whoami` every 4 minutes (whoami never prompts) until 1Password's 12-hour limit or the app locks. Unlocked and unused for 30 minutes, it exits. There's no lock file: the daemon is whoever binds `daemon.sock`. A second one finds it answering and exits; a socket left by a daemon that died is taken over; anything else at that path is left alone (the new daemon logs why and exits). Each connection carries one request, and the daemon runs `op` without the starting shell's `OP_*` sign-in settings (a token or session there would otherwise apply to every session).
- **Values** go from `op` to the daemon to the shim's stdout, and nowhere else: not to a file, the log (`~/.local/state/pi-op-broker/daemon.log` names items, never values), or the session's own state.
- **The same checks everywhere.** The shim, the session and the daemon check item, vault, field, account and `op://` names by the same rules (`validate.mjs`): no newlines, zero-width or bidi characters, and no leading `-`. A request written straight to the session's socket gets no further than the shim's would. A session's requests end with it: after `/new`, `/resume` or `/fork`, nothing still waiting from the old session gets a card in the new one.

**From the phone (with Botsun's botsun-owner):** the card is offered the way `ask` questions are, so it shows in the session on the phone and pushes after 20 seconds unanswered. The phone's answer is signed by the device and checked again in the session, and the card is marked sensitive, so it's never answered by voice on a call: answer it on the phone screen or the keyboard. Whichever answers first, keyboard or phone, wins, and the other card closes.

`/op-broker` shows the daemon's state and this session's grants. `/op-broker revoke` drops this session's grants, and `/op-broker stop` stops the daemon (1Password access goes with it).

## The risk you're accepting

- **The card is a keyboard yes, not Touch ID.** An agent running as you, steered by a prompt injection, could approve its own card (for example with `tmux send-keys`) or talk to the daemon's socket directly (`~/.local/state/pi-op-broker/daemon.sock`, 0600, yours only). While the daemon is unlocked, that reaches every item your 1Password account can read. That's the trade for not touching the Mac for every read. Without op-broker, Touch ID gates each new terminal.
- **To last while you're away, 1Password must stay unlocked.** A lock (on sleep, or after idle) revokes the daemon's authorization, so relaxing auto-lock keeps 1Password unlocked while the Mac sleeps.

Don't turn it on if either is wrong for you. Without it, `op` behaves as always.

**Needs:** the 1Password desktop app with CLI integration on ("Integrate with 1Password CLI"), `op` 2.x, and `script` (macOS, or util-linux on Linux). Interactive sessions only: print, JSON and RPC modes don't get their own shim. A subagent or other child of a session inherits the session's shim, so its reads show on the parent's card and ride the parent's grants.

**Settings:** `PI_OP_BROKER_DIR` moves the daemon's folder, and `PI_OP_BROKER_OP` names the `op` binary the daemon runs.
