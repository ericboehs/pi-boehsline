# quiet

Background work stays quiet. Eric hears from a session only when it needs him.

A run Eric started — typed in the TUI, sent over RPC, or relayed from Botsun —
behaves as it always did. Every other run is **quiet**: a bg job finishing, a
subagent result, an agent-link message, a `codemode_bg` result, a scheduler or
Botsun trigger. A quiet run raises no attention unless the agent calls
`notify_user`, or the classifier safety net decides Eric is needed.

## Run origin

pi's `input` event carries `source`:

| Source | Run |
| --- | --- |
| `interactive` | Eric's |
| `rpc` | Eric's |
| `extension` with a fresh `quiet:mine` mark | Eric's |
| any other `extension` input | quiet |
| no input at all (`pi.sendMessage(..., { triggerTurn: true })`) | quiet |

`quiet:mine` is the opt-in for an extension relaying Eric's own words. Emit it
synchronously just before `pi.sendUserMessage`; the next `extension` input
within 2 seconds consumes it. botsun-owner does this in `sendUser()`.

A steer of Eric's arriving mid-run makes that run his. Runs are otherwise
settled at `agent_settled`.

## Events and shared state

No imports between extensions. Subscribe on `pi.events`:

- `quiet:run` — `{ quiet: boolean }` on `agent_start`, and again if the run
  flips to Eric's.
- `quiet:attention` — `{ kind, text, at }` when attention is raised, `null`
  when Eric's next input clears it. A classifier result also carries
  `source: "classifier"`.
- `quiet:mine` — emitted by another extension to mark its next input as Eric's.

A late subscriber can read `globalThis[Symbol.for("pi-boehsline.quiet")]`, which
is `{ quiet, attention }`. `quiet` reflects the most recent run (it is not
reset at settle, so a settle handler registered after this extension still sees
the right answer); `attention` is the current attention or `null`.

## `notify_user`

| Parameter | Value |
| --- | --- |
| `kind` | `ready`, `decision`, `blocked`, `failed`, `deadline`, `asked` |
| `text` | one line, 1–140 characters |

Use it only when Eric is needed: something ready to test, a decision, a blocker,
a failure, a deadline, or something he asked to hear about. Never for progress.
In a run Eric started, the reply itself reaches him, so it is rarely needed
there.

It sets the attention, emits `quiet:attention`, and shows a warning line in the
TUI: `Needs you (<kind>): <text>`.

## Classifier safety net

When a quiet run settles and `notify_user` was not called, the last assistant
text (at most the last 4,000 characters) is sent to one cheap side call:

- model: `opencode-go/deepseek-v4.1-flash`, or `quietClassifierModel`
- timeout: 10 seconds; any error or missing model is silent
- reply: JSON `{"notify": bool, "kind": "...", "one_line": "..."}`

The prompt defaults to not notifying; it notifies for a decision, a deadline, a
failure, something ready for Eric to test, or something he explicitly asked to
hear about. A notify sets attention exactly as `notify_user` would, with
`source: "classifier"`. The settle never waits for the call.

## Digest

Every quiet run appends one line to
`~/.local/state/pi-quiet/YYYY-MM-DD.log` (`XDG_STATE_HOME` honoured; directory
`0700`, best effort):

```
2026-11-07 14:03:22	1a2b3c4d	proj	notified ready: Tests are green
2026-11-07 14:08:01	1a2b3c4d	proj	classifier failed: Build broke on main
2026-11-07 14:11:40	1a2b3c4d	proj	quiet: All three jobs finished without errors
```

The fields are local time, the first 8 characters of the session id, the cwd's
basename, and the outcome.

## Prompt hint

`before_agent_start` appends one line to the system prompt for a quiet run only:

> This turn was started by a background event, not by Eric. Act on it; don't
> report or summarise. End with at most one line. If Eric is needed, call
> notify_user.

Stock pi runs `input` → `before_agent_start` → `agent_start`, so the hint can
see the origin. A run of Eric's gets no hint.

## Settings

In `~/.pi/agent/settings.json` (`PI_CODING_AGENT_DIR` honoured):

```json
{
  "quietMode": "background",
  "quietClassifier": true,
  "quietClassifierModel": "opencode-go/deepseek-v4.1-flash"
}
```

- `quietMode`: `"background"` (default) or `"off"`. Off treats every run as
  Eric's: no hint, no classifier, no digest. `notify_user` still works.
- `quietClassifier`: default `true`; `false` disables the side call.
- `quietClassifierModel`: optional `"provider/id"`.

## Related extensions

- `tmux-attention` reads the shared state: a quiet settle does not mark the tmux
  window, and a non-null `quiet:attention` marks it (null clears it).
- `botsun-owner` sends `busy` with `{ quiet }`, repeats `busy` if a run flips to
  Eric's, and sends an `attention` line whenever `quiet:attention` changes.
