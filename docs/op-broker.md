# op-broker: 1Password for pi sessions, approved by a card

Status: plan. Opt-in extension `extensions/opt-in/op-broker`, a shared daemon and an `op` shim.
Botsun adds phone approvals (botsun docs/plans/op-broker.md).

## The problem

The 1Password CLI's desktop integration asks for Touch ID once per terminal (tty plus start time).
pi's bash tool has no terminal of its own, so agents hit the prompt over and over, the prompt
doesn't say what the secret is for, and when Eric is away the session just waits.

## Decisions (Eric, 2026-10-31)

| | Decision |
|---|---|
| Vault | Any the account can read, Personal included: nothing moves, no service account |
| Holder | **One shared daemon per user**, holding one authorized `op` terminal (one Touch ID per 12 h) |
| Gate | **An approval card in the session** (pi dialog): who, which item and field, for what command; **Once · 1 h · 8 h** · Deny |
| Accepted risk | The card is a TUI yes. An injected agent running as the same user could approve itself (`tmux send-keys`) or talk to the daemon socket directly. Eric accepts that, as with pi's other dialogs. The README says so |
| Botsun | Optional: botsun-owner already mirrors dialogs to the phone, so the card is answerable there with a signed reply |
| Where | pi-boehsline, publishable: nothing Eric-specific, and the Botsun bits switch on only when present |

## How 1Password's CLI authorization works (developer.1password.com, app-integration-security)

- **Scope:** Touch ID or Apple Watch authorizes one terminal session (on macOS: tty + start time),
  and sub-processes share it.
- **Lifetime:** 10 minutes idle, refreshed on each use, with a 12-hour hard limit.
- **Locking the 1Password app revokes it all.** Auto-lock on sleep or idle has to be relaxed for
  it to last while away.

## Shape

```
bash tool: op read "op://Personal/GitHub/token"
  └─ op shim (PATH from the extension, bash tool only)
       ├─ a form it doesn't know → the real op, unchanged
       └─ $PI_OP_BROKER_SOCK: the session's extension (peer pid must descend from this pi)
            ├─ live grant for (item) → daemon read
            └─ card: "GitHub · token, for `gh auth login --with-token`" Once · 1 h · 8 h · Deny
                 → grant (in the extension's memory) → daemon read → value to that shim only
op daemon (~/.local/state/pi-op-broker/daemon.sock, 0600; started on demand, exits when idle and unarmed)
  └─ its own pty (PTY: own session, controlling terminal) → `op read`, `op whoami` every ~5 min
```

- **Grants live in the extension,** per session. The daemon only holds the authorization and runs
  allowed commands for local clients.
- **One daemon, no lock file:** the daemon is whoever binds `daemon.sock`. On `EADDRINUSE` a
  starter exits 0 if a daemon answers there, takes the path over (once) if it's a stale socket
  (removed only if a second look still finds nobody answering and it's still the same file, by
  device and inode, so two starters can't remove each other's fresh socket), and otherwise leaves
  the path alone, logs why and exits. On exit, or when its socket is replaced, a daemon removes the
  socket only if it's still the one it bound (same device, inode and birth time: inodes are reused). One request per connection; later lines are ignored.
- **One set of rules** (`validate.mjs`) for item, vault, field, account and `op://` names, used by
  the shim, the session's socket (a same-user process can write to it directly) and the daemon.
  The card's `parseRef` uses the same segment pattern. Names can't hold invisible, surrogate,
  private-use or unassigned characters, runs of whitespace, or the card's own separators (`·`, `›`).
  An `OP_ACCOUNT` the rules refuse sends the command to the real op, never to the default account.
- **What the daemon runs:** `op read <ref>` (a strict `op://` pattern), `op item get <item>
  [--vault V] --fields <f> --reveal`, `whoami`, and `arm` (pops the one Touch ID). Nothing else,
  no shell. Values go back over the socket only, never to a file or log.
- **Sessions kept apart:** grants, open cards and queued reads belong to the session they arrived
  in. After `/new`, `/resume` or `/fork` they're refused, never carded in the next session.
- **Daemon status:** armed until (time), not armed, or locked. The footer can show a small key
  chip while armed.
- **The shim** (stdlib Node or a tiny script, fast start) blocks for the card up to 5 minutes,
  then exits 1 with "not approved". `op signin [--account x]` answers ok when armed.
- **The card** says what's asked in plain words, plus the parent command line (truncated; likely inline
  secrets such as `TOKEN=…`, `--password=…` or `Authorization: Bearer …` masked as `•••`) the read
  is for. Esc means Deny. With Botsun, the phone gets the same card through
  botsun-owner, offered as a sensitive prompt: answered on the phone screen (device-signed) or the
  keyboard, never by a voice confirm.

## Steps

0. **O0 spike (Eric at the Mac, one Touch ID):** do a PTY-held process's children share one
   authorization? Does `op whoami` keep it alive without prompting when not armed? What does the
   daemon see after a 1Password lock?
1. **O1 daemon:** socket, pty holder, allowed commands, arm/status/keep-warm. Tests with a fake
   `op` on PATH.
2. **O2 extension + shim:** session socket and peer check, cards and grants, PATH for the bash
   tool, footer chip, `/op` command (status, arm, revoke). README with the risk stated.
3. **O3 Botsun:** the card reaches the phone through botsun-owner's dialog mirror. A push
   category for it if the generic one is too thin.
4. **O4 live:** relax auto-lock, arm, read from a session, approve at the keyboard and from the
   phone.
