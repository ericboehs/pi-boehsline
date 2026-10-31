# botsun-owner

*Opt-in:* `/boehsline enable botsun-owner`.

Puts this pi session on Eric's phone through Botsun: it shows in the Sessions list (name, folder, transcript, working, idle or waiting on a prompt), and Eric can reply, attach photos and files, call into it, answer its `ask` questions, run slash commands and switch models from the phone. Everything that changes the session is signed on the phone and checked here, not just by Botsun.

## Reporting state

**Where:** a Unix socket at `~/.local/state/botsun/owner.sock`, or `$BOTSUN_OWNER_SOCK`. Botsun's web process creates and listens on it; this extension only connects. When it isn't there (Botsun not running), the extension retries quietly every 5 seconds, backing off to once a minute, and sends the full state when it connects.

**What it sends** (newline-delimited JSON, protocol `botsun-owner v1`; every line has `v`, `type`, `pid`, `at` and `name`):

| type | when | extra fields |
|---|---|---|
| `hello` | on every (re)connect | `cwd`, `session_file`, `session_id`, `busy`, `prompt`, `model`, `ask`, `commands`, `models` |
| `busy` / `idle` | a run starts / pi has settled | |
| `prompt` / `prompt_end` | a dialog (`ask`, select, confirm, input, editor, custom) opens / closes | `kind`, `title` (≤ 500 chars) |
| `stream` / `stream_end` | the reply as it's written / done | `text` |
| `model` | `/model`, Ctrl+P, a thinking-level change | `model` (`{name, provider, id, thinking}`) |
| `ask` / `ask_end` | the `ask` tool has a question open / it's answered | `ask` (`{id, questions}`) |
| `commands` / `models` | after `/reload` (also in `hello`) | the phone's `/` list; the models its picker offers |
| `session` | `/new`, `/resume`, `/fork`: same pid, new transcript | `session_file`, `session_id`, `cwd` |
| `bye` | pi quits | |

## Taking input from the phone

Each session also listens on its own socket, `~/.local/state/botsun/owner/<pid>.sock` (`$BOTSUN_OWNER_DIR`), for Botsun's requests. A request first takes a single-use `nonce`; the phone signs `botsun-decide-v1\n<device>\n<nonce>\nsession\n<session id>\n<kind>\n<sha256>` with its device key, and the session verifies it against `~/.local/state/botsun/owner-keys.json` (`$BOTSUN_OWNER_KEYS`) before acting.

| request | does |
|---|---|
| `say` | Eric's words as if typed (steering a running turn), with photos; files are saved to `~/.local/state/botsun/inbox/<pid>/` and named in the message |
| `say_audio` | a call into the session: the transcribed words, signed over the audio with the call key |
| `answer` | answers the open `ask` question; the tool takes it as if picked at the keyboard and closes its dialog |

**Slash commands in `say`:** extension commands, prompt templates and skills run as typed; `/compact [notes]`, `/model <name>`, `/thinking <level>` and `/name <name>` are rebuilt on the extension API; other built-ins answer "only works at the keyboard". A path like `/Users/…` or an unknown `/word` goes in as text.

## Notes

**Name:** the agent-link name (`~/.claude/sessions/<pid>.json`), else the pi session name, else the folder name. Re-read on every line, so a rename shows up on the next event.

**Only interactive sessions:** subagent children (`PI_SUBAGENT_CHILD=1`) and sessions without the TUI (print, JSON and RPC modes, including Botsun's own pi runs) send nothing.

`BOTSUN_OWNER_DEBUG=1` appends connection events to `~/.local/state/botsun/owner-client.log`.
