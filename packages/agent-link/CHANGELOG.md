# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Two-stage delivery between pi sessions: `send` reports "Delivered into its
  conversation" only once the receiver's `message_start` shows the message, waits
  up to 5 s for that, and otherwise says it was received but is still queued; a
  later drop comes back as a notice. The sender asks with `ack: "conversation"` on
  the user frame; the receiver answers `delivered` (with `ack`), then
  `in_conversation` or `dropped`, matched by a `ref <nonce>` in the message header,
  or `refused` with a reason. Claude Code senders and targets are unaffected. `ask`
  fails at once on a refusal or drop. See `delivery.ts`.
- Print-mode sessions (`pi -p`, `--mode json`) take messages only while their run
  lasts and refuse them otherwise ("… is a print-mode subagent and can't take
  messages: its run has ended. Start a new task instead.") instead of reporting a
  message delivered that the exiting process never reads.
- Subagent children (`PI_SUBAGENT_CHILD` with `PI_SUBAGENT_TITLE`, set by the
  subagent extension) register under their task title, marked `subagent: true` with
  their `parent` (`PI_SUBAGENT_PARENT`); `list` shows `<title> (subagent of
  <parent>)` and has structured `details.sessions`. A label copied from the list
  resolves as a target. `agent-link:whoami` on `pi.events` returns this session's
  name.

### Changed
- Name handles turn every run of spaces and punctuation into one hyphen
  ("Pill face + Esc" is `@pill-face-esc`); a token with no letters or digits no
  longer matches every name by prefix.
- `reload` action: `agent-link({ action: "reload", to })` asks another pi session to
  run pi's `/reload` (a control frame, never a chat message), and gets back
  `reloaded`, `queued (busy, reloads when it is free)`, or a refusal with its
  reason. `to: "*idle"` reloads every idle pi session (at most once a minute per
  sender); no `to` reloads the caller after its response. Targets refuse over
  unsent editor text (`force: true` overrides) and reload at most once per 30 s;
  frames from a socket outside the registry get no answer. A busy target waits for
  `agent_settled`, or outside a run (manual `/compact`, an open dialog) re-checks
  until free and gives up after 2 minutes; an aborted run skips a queued reload.
  A reload keeps the session's name. Also
  `/agent-link reload <name|*idle> [--force]`, with completions.
- Typing `@` in the pi prompt autocompletes live agent-link session names alongside
  files. `@foo …` is annotated so the model messages that session with the
  `agent-link` tool instead of treating it as a file.
- `reply` answers the sole pending inbound ask without reconstructing its sender;
  `to` disambiguates when multiple agents are waiting.
- `pending` lists unanswered inbound asks with sender, age, and a short preview.
- Pi peers now publish live `idle`, `thinking`, and `tool:<name>` status in Claude's
  session registry and `agent-link` session lists.
- Spaced session names ("Chicken Door Tamer") resolve from their lowercase, hyphenated
  handle and its unique prefixes (`@chicken-door-tamer`, `@chicken-door`); autocomplete
  inserts the handle, since a space ends an @mention.

### Security
- The socket directory is checked before binding: a symlink, one owned by another
  user, or one open to group/other writes is refused (one of yours with extra
  read bits is tightened to `0700`). The shared `/tmp/cc-socks` fallback could
  otherwise be pre-created by another user.


### Removed
- Agent-view activity summaries (the cheap-model polish and registry `summary`
  field). Session titles belong to pi (`/name`, `--name`, or auto-name).

### Changed
- The package is now `pi-agent-link`, with `agent-link` and `/agent-link` as the
  model-facing tool and UI command. Claude-specific transport internals retain
  their descriptive names.
- Startup banner is now off by default. Opt in via env `PI_AGENT_LINK_BANNER`
  or the sentinel file `/tmp/pi-agent-link-banner.on`.

### Fixed
- Peer name now tracks the pi session's display name. Previously the name was
  captured once at `session_start`, so a name set via `/name`, `--name`, RPC, or
  `pi.setSessionName()` after that moment was ignored and the session appeared in
  Claude's `/list-agents` as the `pi-<cwd>` fallback. The extension now listens for
  `session_info_changed` (and reconciles on `turn_start`) and pushes the current
  name to Claude's registry so `/list-agents` updates live.

## [0.1.0] - 2026-08-08

Initial release.

### Added
- Pi sessions auto-register as peers in Claude Code's registry and appear in
  `/list-agents` (on `session_start`; cleaned up on `session_shutdown`).
- Real-time inbound: messages from Claude are injected into the live pi session via
  `pi.sendUserMessage` (idle → new turn; busy → steer), with delivery receipts.
- Reply relay: pi's answer is sent back to the originating Claude session on `agent_end`.
- Model-facing `claude-link` tool with `list` / `send` / `ask` (blocking) actions,
  a `/claude-link` command, and a bundled skill.
- Sender display names resolved from Claude's registry to match `/list-agents`.
- Dependency-free `claude-protocol.ts` port of Claude's cross-session wire protocol.

[0.1.0]: https://github.com/ericboehs/pi-agent-link/releases/tag/v0.1.0
