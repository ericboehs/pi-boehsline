# botsun-owner

*Opt-in:* `/boehsline enable botsun-owner`.

Puts this pi session on Eric's phone through Botsun: it shows in the Sessions list (name, folder, transcript, working, idle or waiting on a prompt), and Eric can reply, attach photos and files, call into it, answer its `ask` questions, run slash commands and switch models from the phone. Everything that changes the session is signed on the phone and checked here, not just by Botsun.

## Reporting state

**Where:** a Unix socket at `~/.local/state/botsun/owner.sock`, or `$BOTSUN_OWNER_SOCK`. Botsun's web process creates and listens on it; this extension only connects. When it isn't there (Botsun not running), the extension retries quietly every 5 seconds, backing off to once a minute, and sends the full state when it connects.

**What it sends** (newline-delimited JSON, protocol `botsun-owner v1`; every line has `v`, `type`, `pid`, `at` and `name`):

| type | when | extra fields |
|---|---|---|
| `hello` | on every (re)connect | `cwd`, `session_file`, `session_id`, `busy`, `prompt`, `model`, `ask`, `commands`, `models`, `stash`, `footer`, `context`, `compacting`, `bypass` |
| `busy` / `idle` | a run starts / pi has settled | |
| `prompt` / `prompt_end` | a dialog (`ask`, select, confirm, input, editor, custom) opens / closes | `kind`, `title` (≤ 500 chars) |
| `stream` / `stream_end` | the reply as it's written / done | `text` |
| `model` | `/model`, Ctrl+P, a thinking-level change | `model` (`{name, provider, id, thinking}`) |
| `ask` / `ask_end` | the `ask` tool has a question open / it's answered | `ask` (`{id, questions, sensitive?}`; `sensitive: true` marks a secret's approval, e.g. op-broker's, which only a signed `answer` can take) |
| `commands` / `models` | after `/reload` (also in `hello`) | the phone's `/` list; the models its picker offers |
| `stash` | the message stash changed (Ctrl+S, `/stash`, the phone; also in `hello`) | `stash` (`[{id, text, ts}]`, oldest first) |
| `context` | after each run, after a compaction, after `/reload` | `context` (`{tokens, window, percent}`) |
| `footer` | the footer's chips changed (at most once a second) | `footer` (`[{id, segments: [{text, fg?, dim?}]}]`, from `lib/footer-snapshot.ts`) |
| `compacting` | a compaction starts (`/compact` or pi's own) / ends or fails | `reason` (`manual`, `threshold`, `overflow`; `null` when it ends) |
| `bypass` | the approval guardian's bypass turns on or off | `active` |
| `held` | call words held, released or dropped | `held` (`[{id, chars, at}]`: no text) |
| `session` | `/new`, `/resume`, `/fork`: same pid, new transcript | `session_file`, `session_id`, `cwd` |
| `bye` | pi quits | |

## Taking input from the phone

Each session also listens on its own socket, `~/.local/state/botsun/owner/<pid>.sock` (`$BOTSUN_OWNER_DIR`), for Botsun's requests. A request first takes a single-use `nonce`; the phone signs it with its device key, and the session verifies it against `~/.local/state/botsun/owner-keys.json` (`$BOTSUN_OWNER_KEYS`) and its own key pins (below) before acting.

**Signing v1** (no `sig_v`): `botsun-decide-v1\n<device>\n<nonce>\nsession\n<session id>\n<decision>\n<sha256>`.

**Signing v2** (`sig_v: 2`; the nonce reply's `features` include `sign_v2` and `ask_v2`): `botsun-sign-v2\n<device>\n<nonce>\n<kind>\n<scope>\n<decision>\n<sha256(payload)>`, built by `lib/signing-v2.ts` and pinned to Botsun's `Botsun::Signing` by `test/fixtures/signing-v2.json` (a byte-identical copy of Botsun's vectors). The scope is the session id. Per request:

| request | kind | decision | payload |
|---|---|---|---|
| `say`, text only | `session` | `say` | `botsun-propose-text-v1\n<text>` |
| `say` with photos / files | `session` | `say_images` / `say_attach` | the lines v1 hashes: `sha256(text)`, then one per photo / file |
| `say_audio` (call key) | `session` | `say_audio` | `<wav sha256>` and, with a proposal, `\n<proposal sha256>` |
| `answer` | `answer` | `answer` | `canonicalAnswerV2`: `botsun-answer-v2`, the ask id, then per question `q<i> <sha(question)> <0\|1 multi>`, its options `o<i>.<j> <sha(label)> <sha(description)>`, and `a<i> <picks> <sha(text)>`, built from the open prompt's own questions (looked up before the digest), so a yes can't carry over to a reworded question or option |
| `stash` | `session` | `stash` | `push\n<sha256(text)>`, `take\n<id>` or `drop\n<id>` |
| `stop` | `session` | `stop` | `stop` |

A `confirm` of an `ask` answer checks the proposal hash the way his words were signed: a v2-signed `say_audio` carries `sha256(canonicalAnswerV2(…))`, a v1 one `sha256(canonicalAnswer(…))`. A reworded message's proposal is `sha256("botsun-propose-text-v1\n<text>")` either way.

**Device key pinning** (trust on first use): Botsun writes `owner-keys.json`, so this session keeps its own record of which key each paired device signs with, in `~/.local/state/pi-botsun-owner/pins.json` (`$BOTSUN_OWNER_PIN_DIR`). The first request a device's key verifies pins `sha256(public key)` for that device id (decision and call keys pinned apart). It pins silently in two cases only:

- **The first pairing:** nothing is pinned at all, of either kind (a fresh install, or the move to pinning). That key is trusted blindly, whatever `owner-keys.json` says: whoever controls Botsun at that moment gets pinned. Deleting `pins.json` or the pin dir (or removing a malformed pin file to get unstuck) opens that blind first pairing again.
- **The same phone's other key:** a device id already pinned for one kind, getting its first key of the other kind (its call key, the first time Eric calls, while no call key is pinned yet).

Anything else is refused and put to the keyboard:

- A key that differs from the pinned one is refused, "this device's key changed: confirm at the keyboard".
- A device id with no pin is refused, "new device: confirm at the keyboard" (a new device id's call key too, while only decision keys are pinned).

Either way the session asks at the keyboard: a TUI confirm naming the device id, the key kind and the fingerprints, never answerable from the phone. Only a yes there pins, from the pin shown (or none) to the key shown. One such dialog is open at a time, across devices; a request meanwhile is refused without another, whatever key it brings. After a no, that device and key kind are refused without a dialog for 10 minutes, and every other device for 2 minutes; and at most 3 pin dialogs open in 10 minutes, across devices. Requests beyond those are refused without a dialog.

The trade-off: a compromised Botsun can keep Eric from pairing a new phone or re-pairing one, by holding the single dialog open with requests of its own or by spending the cap and cooldowns (a denial of service against Eric, never a way in). Devices already pinned keep working throughout; to pair anyway, wait out the cooldown or restart pi (the limits live in the session).

The pin dir must be a real 0700 directory of Eric's (not a symlink; created 0700 when missing), and the file a 0600 file of his, opened without following a symlink. A pin file others could write, or a malformed entry, refuses every request rather than counting as "not pinned". Writes take an O_EXCL lock file (`pins.lock`, broken after 10 s as a crashed writer's: moved aside, then put back if what was moved isn't the stale lock judged, so two waiters breaking it at once can't both hold it), re-read the file inside it and replace it atomically, so two pi sessions pinning at once keep both pins. A lock still held after 2 s refuses the request.

What pinning can and can't do: it protects against a Botsun whose logic is compromised (a bad pairing flow, a hostile web request that gets a key into `owner-keys.json` or a device id handed out). It doesn't protect against code running as Eric's user, Botsun included if it gets that far: that could rewrite `pins.json` or this extension itself.

| request | does |
|---|---|
| `say` | Eric's words as if typed (steering a running turn), with photos; files are saved to `~/.local/state/botsun/inbox/<pid>/` and named in the message |
| `say_audio` | a call into the session: the transcribed words, signed over the audio with the call key. With `hold: true` they're verified and held (`{ok, held: id}`) instead of put in; with `proposal_sha256` the hash of an answer read back to him is signed with them |
| `release` | `{ids, mode}` from the voice helper: held words go in as `queue` (a follow-up after the turn), `steer`, or `interrupt` (steer; abort the run first only when the released words themselves say stop, then send them once pi settles). It adds no words, so it isn't signed |
| `confirm` | `{id, ask_id, answers}` from the voice helper: his held reply means yes to the answer read back on the call. Answers the open `ask` only when that utterance was signed with this answer's hash (`say_audio` with `proposal_sha256`, an extra line of the signed message) and its words don't say no (`saysNo`). Never a `sensitive` prompt: "answer this one on the phone screen or the keyboard" |
| `drop` / `call_end` | forget the held words named, or all of them |
| `stop` | the phone's Stop button: ends the running turn (or a compaction) as Esc does; signed over `stop` with the decision key; `{ok, stopped}` |
| `answer` | answers the open `ask` question; the tool takes it as if picked at the keyboard and closes its dialog |
| `stash` | the message stash (with the stash extension): `push` a draft, `take` one back to the phone, `drop` one; signed over `push\n<sha256(text)>`, `take\n<id>` or `drop\n<id>` |
| `footer_tap` | flips a display chip (`dir`, `context`, `cost`, `usage`, `rate`, `timers`) as a click on the footer does, and answers with the new row; display only, so not signed |

**Slash commands in `say`:** extension commands, prompt templates and skills run as typed; `/compact [notes]`, `/model <name>`, `/thinking <level>` and `/name <name>` are rebuilt on the extension API; `/bypass on|off` turns the approval guardian's bypass on or off through its control event (the terminal shows its warning), mid-turn too; other built-ins answer "only works at the keyboard". A path like `/Users/…` or an unknown `/word` goes in as text.

**During a compaction** pi refuses a prompt, so words from the phone are held and sent once it ends (or fails); slash commands that would start a turn answer "wait for the compaction to finish".

## Notes

**Name:** the agent-link name (`~/.claude/sessions/<pid>.json`), else the pi session name, else the folder name. Re-read on every line, so a rename shows up on the next event.

**Only interactive sessions:** subagent children (`PI_SUBAGENT_CHILD=1`) and sessions without the TUI (print, JSON and RPC modes, including Botsun's own pi runs) send nothing.

`BOTSUN_OWNER_DEBUG=1` appends connection events to `~/.local/state/botsun/owner-client.log`.
