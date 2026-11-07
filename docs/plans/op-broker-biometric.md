# op-broker: approvals proven by the user, not a keypress

Status: plan. This replaces the "keyboard yes" accepted in docs/op-broker.md (Decisions, Accepted
risk). Code: extensions/opt-in/op-broker (daemon.mjs, index.ts, broker.ts, shim.mjs),
lib/remote-prompts.ts, extensions/opt-in/botsun-owner, and in Botsun the server relay and the iOS
app.

## Decision (Eric)

A read with no live grant runs only after a proof that a person approved that exact read: Touch ID
(or the login password) at the Mac, or a biometric-gated Secure Enclave signature on the phone.
The daemon checks the proof itself and holds the grants. The TUI card can deny but not approve.

## Today, and why it falls short

- The session (index.ts) shows the card and keeps grants in its own memory (broker.ts). The daemon
  runs any well-formed `{cmd:"op"}` it receives on daemon.sock. Anything running as Eric can
  connect to that socket and read every item while the daemon is armed.
- The keyboard answer is a `ctx.ui.select` pick, which `tmux send-keys` can make.
- The phone answer is a v2/v3 device signature (botsun-owner `answerAsk`, `canonicalAnswerV2`)
  checked by the session, not the daemon. The device key (iOS `EnclaveKey.device`) uses
  `.privateKeyUsage` only, so an unlocked phone signs without Face ID.

## Shape after

```
shim -> session socket -> session (status card, phone offer)
                              |
                              v
daemon.sock: {cmd:"op", token, ...}  --no live grant-->  challenge C (nonce, request hash, expiry)
   |                                                         |
   |   Mac: op-auth helper (LAContext) --ok--> proof         |  phone: card carries C; Face ID
   |                                                         |  signs C with the op key
   |   first valid proof wins; the other is cancelled        |  -> Botsun -> botsun-owner
   v                                                         |  -> session -> {cmd:"proof"}
grant (token + item, once or 1 h)  ->  op read  ->  value on the waiting connection only
```

The daemon is the only place an approval becomes a grant. The session only carries messages, and
gains nothing an attacker on the socket couldn't also send.

## (a) Touch ID at the Mac, asked by the daemon

**Helper.** `op-auth.swift` (about 150 lines, in the extension folder) is compiled on first use
with `swiftc -O` into `<brokerDir>/bin/op-auth`, then ad-hoc signed (`codesign -s -`). The daemon
records the sha256 of source and binary in `<brokerDir>/bin/op-auth.sha256`, recompiles when the
source hash changes, and checks the binary's hash before every spawn. No prebuilt binary ships, so
an open-source user can read what runs. If the Xcode command line tools are missing, the Mac
prompt is off (phone only) and `/op-broker` says why.

Subcommands:
- `op-auth probe` prints JSON: `{gui, locked, idle_s, policy_ok, biometry}`. `gui` comes from
  the audit session (`SessionGetInfo`, `sessionHasGraphicAccess`). `locked` comes from
  `CGSessionCopyCurrentDictionary` (`CGSSessionScreenIsLocked`). `idle_s` is IOHIDSystem's
  HIDIdleTime (the same value as `ioreg -c IOHIDSystem`), read with IOKit and no subprocess.
  `policy_ok` is `canEvaluatePolicy(.deviceOwnerAuthentication)`.
- `op-auth ask` reads one JSON line from stdin (`{reason}`), calls
  `LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason:)`, and prints `ok`,
  `cancel`, `fallback-unavailable` or `error <code>`. Exit code 0 means ok. It keeps reading
  stdin, and a `cancel` line, EOF or SIGTERM calls `context.invalidate()`, which dismisses the
  dialog, then exits 2.

**Why a process inside `script` gets the prompt.** LocalAuthentication doesn't need an app
bundle, an entitlement or a tty. It needs the process to be in the user's GUI (Aqua) security
session, where coreauthd can show its panel. The daemon inherits that session from pi through
`script`, so pi started in Terminal, iTerm, Ghostty or a tmux server launched from them works. pi
over plain ssh, or a tmux server started from ssh, doesn't: `probe` reports `gui:false` and the
daemon skips the Mac prompt. The panel names the binary ("op-auth") and shows the reason.
`.deviceOwnerAuthentication` takes Touch ID, an Apple Watch or the login password, so a Mac with
no sensor, or with the lid closed, still works through the password.

**Reason text.** It's built by the daemon from validated fields only (validate.mjs rules) and capped
at 160 characters:
`approve a 1Password read: GitHub · token (Personal) [acct] for 1 hour, for pi session "name" (ab12cd)`.
The command line from the shim is left out on purpose. It's untrusted text, it stays on the TUI
card, and it shouldn't make the system dialog read as something else. The session name passes the
same NAME rule, and a name that fails is shown as the session id only.

**Cancellation.** When the phone proof wins, the session denies, the card times out or the session
ends, the daemon writes `cancel` to the helper, then sends SIGTERM after 1 s. The helper calls
`invalidate()`, and the panel closes.

**What the daemon trusts.** The helper's exit status from a child it spawned itself, at a path in
its 0700 folder whose hash it checked. This doesn't defend against a same-user attacker who can
rewrite files (see the threat model). A Mac Secure Enclave key with a biometry ACL would make the
Mac proof cryptographic too. That's an open question, not v1.

## (b) Phone approvals with a biometry-gated key

**The key.** A third `EnclaveKey`, `com.boehs.botsun.op-key`, made with
`SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
[.privateKeyUsage, .biometryCurrentSet], …)`. Each signature passes an `LAContext` with a
`localizedReason` naming the item and the session, and
`touchIDAuthenticationAllowableReuseDuration = 0`, so every approval is a fresh Face ID. It signs
only op approvals and its own registration. It never signs answers, says or stops, and the daemon
accepts no other key. Adding a face or finger invalidates it (`.biometryCurrentSet`), and the app
then offers to register again. The simulator, with no Secure Enclave, can't make one, so no
software fallback exists for this key.

**Registration** (once per phone per Mac):
1. The phone asks the daemon for an enrollment challenge, relayed through Botsun and a live
   session: `{cmd:"enroll-begin"}` returns `{enroll_nonce, broker_id, expires}`. `broker_id` is
   a random id made once per install (`<brokerDir>/broker-id`).
2. The phone creates the op key and signs the enrollment payload twice: with the op key (proof of
   possession, and a check that Face ID works) and with its existing device key (binding it to the
   paired device).
3. botsun-owner hands the enrollment to op-broker through a new remote-approver hook (below). The
   session sends `{cmd:"enroll", …}`. The daemon checks both signatures. The device key comes from
   botsun-owner's pinned key (pins.ts) through the hook, not from Botsun's owner-keys.json alone.
4. The daemon runs `op-auth ask` with the reason `trust "Eric's iPhone" (key 1a2b 3c4d) to approve
   1Password reads`. The phone shows the same fingerprint (first 8 hex of sha256(raw key)) while
   it waits. Eric compares them and touches. That touch is the trust anchor. The device signature
   is defense in depth, and an approver without one (a generic open-source client) can still enroll
   on the Touch ID alone.
5. The daemon writes `<brokerDir>/approvers.json` (0600): `{broker_id, keys: [{id, label,
   pub_b64, added_at}]}`. It loads the file at start and after its own writes only, and keeps the
   sha256 of what it wrote. A file changed underneath it is refused until `/op-broker keys` sees a
   fresh enrollment.

Revoking (`/op-broker keys revoke <id>`) needs no proof, because removing trust is always safe.

**The proof the daemon checks.** It's a signature by an enrolled key over the canonical message
below, built from the daemon's own pending request, so the phone can only approve what the daemon
is about to run.

## Message formats

Request hash (all names already pass validate.mjs; each value is hashed, as in `fieldsPayload`):

```
pi-op-request-v1
kind <read|otp|fields>
account <sha256hex(account or "")>
vault <sha256hex(vault or "*")>
item <sha256hex(item)>
fields <sha256hex(fields joined "\n", in request order; for read: the ref's field)>
```

Approval, signed by the op key (P-256 ECDSA, SHA-256, DER, like botsun-sign-v2):

```
pi-op-approve-v1
<broker_id>                 per-install, so a proof for one Mac fails on another
<key_id>                    sha256hex(raw op key), first 16
<challenge>                 24 random bytes, base64url, single use
<session_id>                the pi session's id, as shown on the card
<decision>                  once | 1h | deny
<expires_ms>                the daemon's expiry for this challenge
<request hash>
```

Enrollment payload, signed by both keys (with the device key, as botsun-sign-v3 kind `op_key`,
scope = device id, decision `register`, payload = these lines):

```
pi-op-enroll-v1
<broker_id>
<enroll_nonce>
<label>                     NAME rule, 40 chars max
<base64 raw op public key (X9.63, 65 bytes)>
```

Daemon socket, new and changed commands (one JSON line each way, except `op`, which sends up to two):

| Command | Reply |
|---|---|
| `{cmd:"session", session_id}` | `{token}`, 32 random bytes. Grants are keyed by token, so a client naming another session's id gets nothing of its |
| `{cmd:"op", token, scope, label, ...req}` | With a live grant: the value. Without one: first `{pending, challenge, expires, request, mac: bool, phone: bool}`, then the final `{ok, value}` or error once it's decided |
| `{cmd:"proof", challenge, key_id, decision, signature}` | `{ok}` or `{error}`. Verified in the daemon |
| `{cmd:"scope", token, challenge, scope}` | Restarts the Mac prompt with the new reason. The phone signs its own decision |
| `{cmd:"deny", token, challenge}` | `{ok}` |
| `{cmd:"grants" / "revoke", token}` | This session's grants |
| `enroll-begin`, `enroll`, `keys`, `keys-revoke` | As above |
| `{cmd:"status"}` | Adds `mac_auth: {gui, locked, idle_s, available}` and `approvers: n` |

A proof is accepted once, before `expires`, for the pending challenge whose request hash and session
it names. Any failure spends the challenge (one try, like botsun-owner's nonces), and the read is
refused. `deny` signed or unsigned ends it. `once` grants this read only, and `1h` stores
`(token, grantKey) → now + 1h`. A Touch ID ok counts as a proof of the scope chosen when the
helper started.

Phone transport (Botsun):
- The remote prompt gains an optional `op` field (challenge, broker_id, session_id, the request's
  plain fields, expires, armed). botsun-owner's `askLine` passes it through, and owner_sessions.rb
  copies it into the ask it serves to the phone, next to `sensitive: true`.
- The phone renders the card from the `op` fields, not from the title text. It recomputes the
  request hash from those fields and signs.
- POST `/device/sessions/:id/op_approve` `{ask_id, challenge, key_id, decision, signature}`. The
  server checks the signature against the stored op key to fail fast (optional), then
  `session_request!` `{type:"op_approve", …}`.
- botsun-owner: a new handler hands it to the prompt's `proof(p)` (a new optional `RemotePrompt`
  method, set only by op-broker) and returns the daemon's result to the phone. No owner nonce is
  involved. The daemon's challenge is the nonce.
- lib/remote-prompts.ts also gains a small approver registry, so botsun-owner can deliver an
  enrollment and expose `verifyDeviceSignature(deviceId, text, sig)` against its pinned keys.
  Without botsun-owner, nothing registers and op-broker is Mac-only.

## (c) The TUI card becomes a status card

```
1Password: GitHub · token (Personal)
for: bash -c gh auth login --with-token
waiting for Touch ID on this Mac or your phone (4:52)
  > Deny
    Ask for 1 hour instead          (or "Ask for this read only")
```

There's no approve option. Picking the scope sends `{cmd:"scope"}`, which restarts the Touch ID
panel with a reason that names the new duration. A keystroke can widen what's asked, but the panel
says what you're approving, so a quiet once-to-1h swap is visible. Deny and Esc send `deny`. The card
closes when the daemon's final line arrives, whoever answered. With no way to prove (no GUI, no
enrolled phone), the card says so and offers only Deny, and the read fails with
`op-broker: no way to approve here (see /op-broker)`.

## (d) Both at once, and the idle skip

On a new challenge, the daemon runs `op-auth probe`. It skips the Mac prompt when `gui` is false,
the screen is locked, `idle_s > PI_OP_BROKER_MAC_IDLE_S` (default 300) or `policy_ok` is false.
Otherwise it starts `op-auth ask`. The session offers the phone card either way (`phone:true` when
any approver is enrolled). Whichever valid proof arrives first resolves the challenge. The daemon
then cancels the helper, and the session disposes the remote prompt, so the phone card closes
(prompt_end). A Touch ID cancel (the user hit Cancel) doesn't deny: the phone may still answer. Only
Deny, a signed deny or the 5-minute expiry ends it.

If the daemon isn't armed (1Password's own authorization), a phone approval can't run while Eric is
away: `op` would pop 1Password's Touch ID at an empty Mac. The `op` field carries `armed:false`, the
phone card says "approve, then unlock 1Password at the Mac", and the read fails cleanly after the
90 s op timeout.

## (e) Grants and lifetimes

- Choices: once, 1 hour. 8 hours goes away. Grants live in the daemon, keyed by session token and
  grantKey (account, vault, item), and come only from a proof. The session keeps none. The
  `/op-broker` list asks the daemon.
- A session's end (`/new`, `/resume`, `/fork`, exit) sends `revoke` for its token, and pending
  challenges for that token are cancelled.
- The 12-hour 1Password arm stays. Idle exit: unarmed and unused for 30 min (as now), and armed but
  with no read for 60 min (new, `PI_OP_BROKER_ARMED_IDLE_MS`). Since the longest grant is 1 h,
  an idle daemon holds nothing worth keeping.

## Hardening the daemon itself

The proof check only means something if same-user code can't steer the daemon process:
- Start node with `--disable-sigusr1` (Node 22.14+) so SIGUSR1 can't open the inspector. Refuse
  to start on an older node unless `PI_OP_BROKER_ALLOW_OLD_NODE` is set.
- Clear `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS` and `DYLD_*` in startDaemon's env.
- The helper binary, approvers.json and broker-id live in the 0700 folder and are checked as
  regular files owned by the user, never followed through symlinks.

## Threat model

| Threat | Before | After |
|---|---|---|
| Injected agent approves its own card (`tmux send-keys`) | Works: the keypress is the approval | Keys can only deny or change the scope. Approval needs a touch or Face ID showing the item and duration |
| Direct `daemon.sock` access by a same-user process | Reads any item while armed | `op` without a live grant for its own token waits for a proof it can't make. Other sessions' grants are keyed by tokens it doesn't have |
| Direct access to a session's socket (like the shim) | Rides that session's grants, and gets cards | The same: a grant is a deliberate window for that session's agent. New items still need a proof |
| Replay of a phone proof | Session nonce, one use | The daemon's challenge, one use, bound to request hash, session, broker and expiry |
| Swapped request (phone approves A, B runs) | v2 binds the card text | The hash is built from the daemon's own pending request, so B can't match |
| Compromised Botsun server or token | Can't forge device signatures | The same, and it can't upgrade once to 1h (the decision is signed) |
| Stolen phone, locked | Device key refuses (WhenUnlocked) | The same |
| Stolen phone, unlocked or passcode known | Device key signs a yes | Face ID required (`.biometryCurrentSet`). A passcode isn't enough, and a new face voids the key |
| Another local user | 0600 sockets in a 0700 folder | The same, and approvers.json is 0600 too |
| Same-user code that rewrites files (extension, helper, approvers.json) or kills the daemon | Total | Residual. A patched or restarted daemon needs a new 1Password Touch ID to arm. The approvers.json hash check and the helper hash check catch edits under a live daemon. SIGUSR1 is closed |
| Same-user debugger attach | Possible with dev tools | Needs developer-mode auth on macOS (an admin prompt). Out of scope |

## Failure modes

- **No Touch ID hardware, lid closed, Magic Keyboard without a sensor:** the password, or an
  Apple Watch, via `.deviceOwnerAuthentication`.
- **No GUI session (ssh, launchd background):** phone only. With no approver enrolled, the card
  says so and the read fails.
- **swiftc missing or the build fails:** phone only, with the reason in `/op-broker` and
  daemon.log.
- **Phone offline, no push, or the app closed:** the Mac prompt still races. Away and offline, the
  read is refused after 5 min.
- **Face ID re-enrolled:** the op key is void. The phone reports it and offers registration, which
  needs Touch ID at the Mac.
- **Daemon restarted mid-challenge:** the challenge is gone, the session gets "the daemon hung up"
  and the read fails. Grants are gone too. Accepted.
- **1Password locked after the approval:** as today, op fails and the daemon disarms.
- **Several sessions asking at once:** one Mac prompt at a time (a FIFO queue in the daemon). Phone
  cards can be answered in any order, and each proof names its own challenge.

## Linux and other platforms (open source, nothing Eric-specific)

The helper is pluggable: `PI_OP_BROKER_AUTH_HELPER` names any executable with the same
`probe`/`ask` contract. Shipped defaults:
- macOS: op-auth.swift as above.
- Linux with a desktop polkit agent: `op-auth-polkit` runs
  `pkcheck --action-id io.pi.op-broker.approve --process $$ --allow-user-interaction`. That
  needs a polkit action file (`auth_self`) that the README tells the user to install once with
  root. `probe` reports `available:false` when the action or agent is missing. fprintd isn't used
  directly, because it doesn't fall back to a password. PAM with `pam_authenticate` as the user
  was considered, but it needs a tty or conversation UI the daemon doesn't have.
- Anything else, or no polkit: phone only through the remote-approver hook (any client that can
  hold a P-256 key and sign `pi-op-approve-v1`). Botsun is one such client, not a dependency.
- No keyboard-approve fallback ships. If there's no way to prove, op-broker refuses, and the README
  says to run without it.

## Tests (test/op-broker.test.mjs, plus Botsun's)

- Fixtures: `test/fixtures/op-approve-v1.json` and `op-enroll-v1.json` (fields, canonical text,
  hash, a signature from a fixed P-256 key), copied byte for byte into Botsun's tests and checked
  by the iOS message builder test, like signing-v2.json.
- Daemon with a fake `op` that records its invocations and a fake helper (`PI_OP_BROKER_AUTH_HELPER`,
  a node script that answers ok, cancel or hangs, as told by a file):
  - `op` with no grant never invokes the fake op without a proof. A raw socket client gets
    `pending`, and nothing else.
  - Proofs: valid; wrong key; unknown key; tampered hash, session, broker or decision; expired;
    replayed; a second proof after the first; a proof for another challenge. Only the valid one
    runs op, and each failure spends the challenge.
  - Race: helper ok first, so the proof is refused as stale and the helper isn't cancelled late.
    Proof first, so the helper gets `cancel` and exits. A helper cancel alone doesn't deny.
  - Idle skip: probe with `idle_s` above N, locked, or `gui:false` never starts `ask`.
  - Scope change restarts the helper with the new reason. The reason text is built only from
    validated fields, and leaves out the command line.
  - Grants: keyed by token. Another token gets none. `1h` lapses. Revoke on session end cancels
    pending challenges.
  - Enrollment needs both signatures and a helper ok. A changed approvers.json is refused.
  - Armed idle exit after 60 min, with fake timers or env overrides.
  - startDaemon strips NODE_OPTIONS and passes `--disable-sigusr1`.
- Session: the card's options never include an approve. Deny sends `deny`. The phone proof is
  forwarded verbatim. A closed session's proof is refused.
- botsun-owner: `op_approve` routes only to a prompt with `proof`. Sensitive prompts still refuse
  voice and Watch answers.
- Manual checklist (Mac): Terminal, tmux from the GUI, tmux over ssh, lid closed with an external
  keyboard, Apple Watch, invalidate dismissing the panel, Face ID prompt on the phone.

## Rollout

0. **Spike:** op-auth from a daemon under `script` in tmux (GUI and ssh), invalidate timing,
   clamshell, probe values. Settles the reason length and the panel's wording.
1. **Mac proof:** daemon challenges, grants and helper, the status card, 8 h dropped, armed idle
   exit, hardening. The phone card stays as a status mirror that can only deny. README and
   docs/op-broker.md rewrite their "risk you're accepting" sections.
2. **Phone proof:** op key, registration, `op_approve` route and relay, botsun-owner hook. Botsun
   plan update (botsun docs/plans/op-broker.md).
3. **Race and idle skip** switched on together, once both proofs work.
4. **Linux polkit helper** and the pluggable-helper docs.
5. **Old path removed:** botsun-owner's sensitive `answerAsk` route no longer answers op-broker
   cards. `remote-prompts`' `sensitive` stays for other callers.

## Open questions (recommended default first)

1. `.biometryCurrentSet` or `.userPresence` for the op key? **biometryCurrentSet:** a known
   passcode shouldn't unlock secrets, and re-registering after a face change is rare.
2. Idle threshold N for skipping the Mac prompt? **5 minutes**, a setting, plus always skipping
   when locked or screen-shared (Botsun's MacIdle treats screen sharing as away).
3. Let the keyboard change the scope (once/1h)? **Yes**, because the panel names the duration.
   The alternative is two Touch ID buttons, which LAContext can't show.
4. Make the Mac proof cryptographic (a Mac Secure Enclave key with a biometry ACL, made by the
   helper) instead of trusting the exit status? **Not in v1.** Revisit if the helper's integrity
   becomes the weak point.
5. Keep approvers.json in a file, or in the keychain? **A 0600 file plus the in-memory hash
   check** for v1. Keychain only if the residual same-user write threat is worth the prompts.
6. Should an Apple Watch unlock count at the Mac? **Yes:** it's inside
   `.deviceOwnerAuthentication` and proves presence. Use `…WithBiometrics` plus a custom
   password fallback only if Eric says no.
7. Armed idle exit at 1 hour? **Yes**, `PI_OP_BROKER_ARMED_IDLE_MS` to tune it. The cost is a
   1Password Touch ID after an idle hour.
8. Offer an explicit keyboard-approve mode for headless Linux? **No.** Phone only, or don't use
   op-broker.
