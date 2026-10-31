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
| `ask` / `ask_end` | the `ask` tool has a question open / it's answered | `ask` (`{id, questions}`) |
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

Each session also listens on its own socket, `~/.local/state/botsun/owner/<pid>.sock` (`$BOTSUN_OWNER_DIR`), for Botsun's requests. A request first takes a single-use `nonce`; the phone signs `botsun-decide-v1\n<device>\n<nonce>\nsession\n<session id>\n<kind>\n<sha256>` with its device key, and the session verifies it against `~/.local/state/botsun/owner-keys.json` (`$BOTSUN_OWNER_KEYS`) before acting.

| request | does |
|---|---|
| `say` | Eric's words as if typed (steering a running turn), with photos; files are saved to `~/.local/state/botsun/inbox/<pid>/` and named in the message |
| `say_audio` | a call into the session: the transcribed words, signed over the audio with the call key. With `hold: true` they're verified and held (`{ok, held: id}`) instead of put in; with `proposal_sha256` the hash of an answer read back to him is signed with them |
| `release` | `{ids, mode}` from the voice helper: held words go in as `queue` (a follow-up after the turn), `steer`, or `interrupt` (steer; abort the run first only when the released words themselves say stop, then send them once pi settles). It adds no words, so it isn't signed |
| `confirm` | `{id, ask_id, answers}` from the voice helper: his held reply means yes to the answer read back on the call. Answers the open `ask` only when that utterance was signed with this answer's hash (`say_audio` with `proposal_sha256`, an extra line of the signed message) and its words don't say no (`saysNo`) |
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
