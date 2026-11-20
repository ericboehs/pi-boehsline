# Security

pi-agent-link bridges two AI coding agents so they can send each other messages.
Because a delivered message becomes input to an agent that can run tools with your
permissions, please read this before enabling it broadly.

## Trust model

- **Boundary is your user account, not the session.** The transport is a Unix domain
  socket at mode `0600` inside a `0700` directory. Any process running as the same OS
  user can reach it — the same trust boundary as your files and credentials. It does
  **not** add a network-reachable surface.
- **The directory check enforces that boundary.** The socket directory can be the
  shared `/tmp/cc-socks` (always on macOS, where `XDG_RUNTIME_DIR` is unset), which
  another user could create first. Before binding, agent-link `lstat`s the directory
  and refuses to start unless it is a real directory (not a symlink) owned by your
  uid with no group or other access (`mode & 0o077 === 0`). A directory of yours
  with only extra read/search bits is tightened to `0700`; one that others could
  write to is refused, since something may already have been planted in it.
- **Cross-agent messages are untrusted peer input, not user authority.**
  - On the Claude side, messages arrive as `origin.kind:"peer"` and are subject to
    Claude's `crossSessionInbound` gate. Set `crossSessionInbound: "hold"` in
    `~/.claude/settings.json` to require explicit approval for each inbound message.
  - On the pi side, injected messages are framed *"from another agent, not your user"*
    and the model is instructed to treat them as peer requests — not as your approval,
    and not grounds to change its own permissions/config.
- **Sender identity fields are advisory.** `from` / display name are set by the sender
  and are not authenticated; they are used for routing and display only. Do not rely on
  them for trust decisions.

## Remote reload

A `reload` control frame asks a pi session to run pi's `/reload`. It never reaches
the target's model, so it isn't subject to the peer-input framing above; instead:

- **Same user, same machine only.** The frame arrives on the same `0600` socket as
  messages, in a directory checked to be yours alone (above), so the sender already
  runs as your user. The target also checks that the frame's reply address (`from`)
  is the socket of a session in this user's registry (`~/.claude/sessions`), and
  drops anything else without answering, so a frame can't make it write to an
  arbitrary socket.
- **A spoofed `from` is accepted.** A same-user process can name another
  registered session's socket as `from`. That triggers the reload and sends the
  answer to that session, not to the spoofer; it grants nothing a same-user
  process couldn't already do.
- **Rate-limited, both ends.** A target reloads for a request at most once per 30
  seconds (refused and queued requests don't count; the window starts when it
  actually reloads). A sender sends `*idle` at most once per 60 seconds, so a
  looping or prompt-injected model can't keep every idle session reloading. Both
  windows live on `globalThis`, so they hold across a reload.
- **Unsent work is protected.** A target with text in its editor refuses unless the
  sender passes `force: true`, and a queued reload is dropped (with a notice) if the
  user starts typing before it runs, or ends the run with Esc (unless forced). pi's
  RPC mode can't read the editor, so the editor check only protects the
  interactive TUI.
- **Dialogs are left alone.** A reload waits while any extension's blocking dialog
  (`ctx.ui.select`/`confirm`/`input`/`editor`/`custom`, seen through pi's
  `ui_prompt_start`/`ui_prompt_end` events) or one of agent-link's own commands is
  open. Another extension's command that is busy without a dialog can't be
  detected, and a reload then would invalidate its `ctx`.
- **Bounded effect.** A reload re-reads extensions, skills, prompts, themes and
  context files from disk; it runs no code a same-user process couldn't already
  place there, and it never interrupts a turn or a compaction (it waits, and a wait
  outside an agent run expires after 2 minutes with a notice).

## Guidance

- **Do not wire this extension to external or automated inputs** (webhooks, queues,
  scraped content, email). That would turn it into a path for untrusted content to
  reach a permissioned agent. Keep the sending side to messages a human initiates.
- Prefer `crossSessionInbound: "hold"` on machines where you run sessions with elevated
  or auto-approving permission modes.
- Review what tools your agents can run before letting peers message them freely.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via a
[GitHub security advisory](https://github.com/ericboehs/pi-agent-link/security/advisories/new)
rather than a public issue. Include reproduction steps and the impact you observed.
We aim to acknowledge within a few days.

## Scope

This is a community project, not affiliated with Anthropic or the pi project. It
interoperates with Claude Code's cross-session messaging protocol, which is external
and may change; such changes are compatibility issues, not vulnerabilities in this
project unless they enable a new attack.
