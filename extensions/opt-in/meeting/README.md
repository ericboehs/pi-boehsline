# meeting

*Opt-in:* `/boehsline enable meeting`.

A live meeting copilot: it follows a meeting transcript, keeps rolling notes
(topics, decisions, action items, and a question or two only when one is worth
asking), alerts you when someone says your name or hands you an action, and
suggests a reply when someone is waiting on you. It starts and stops by itself,
and you can ask the session about the meeting in plain chat.
**Command:** `/meeting`. **Tool:** `meeting` (status, transcript, slide), for the session model.
**Needs:** [meeting-capture](https://github.com/ericboehs/meeting-capture) (or
anything that writes its `state.json` and transcript, see its
`docs/canvas-contract.md`). The copilot only reads those files.

## Settings

In `~/.pi/agent/boehsline.json`. Environment variables (`PI_MEETING_*`) still override.

```jsonc
{
  "meeting": {
    "model": "github-copilot/claude-haiku-5.5",   // the notes scout (the default); comma-separate to add fallbacks
    "qmdCollections": ["notes"],   // background search for the scout's context
    "dailyDir": "~/Notes/daily",   // the recap lands here
    "owner": "earl"                // the session with this name runs the copilot by itself
  }
}
```

`PI_MEETING_MODEL` overrides `meeting.model` and `PI_MEETING_OWNER` overrides
`meeting.owner`. Environment only: `PI_MEETING_ME`
(your name, else git's `user.name`), `PI_MEETING_ABOUT` (a file about you, else
`~/.pi/agent/meeting-context.md`), `PI_MEETING_REASONING`, `PI_MEETING_WATCH=1`
(arm the session, for testing), `PI_MEETING_LOCK` (the lock file),
`PI_MEETING_NOTES_FILE` (the notes file the canvas reads, see below;
`PI_CANVAS_ROOT` moves its default), `PI_MEETING_NOTES_DIR` (the archive of
every meeting's notes, default `<canvas root>/meetings`),
`MEETING_CAPTURE_STATE_DIR` (where meeting-capture's `state.json` is, default
`~/.local/state/meeting-capture`) and `PI_MEETING_DIR` (where `/meeting replay`
looks for a transcript when you give no path).

## Who runs it

Every session checks `state.json` every 2 seconds, but exactly one runs the
copilot. A meeting is live when `state.json` isn't marked ended and the
recorder's pid is alive. A session is eligible when it is **armed** with
`/meeting watch` (saved in the session, so `/reload` and resume keep it), or when
its session name equals `meeting.owner` (trimmed, case-insensitive; that is also
its agent-link name). An eligible session claims `~/.pi/agent/meeting-owner.json`
(`{pid, sessionId, name, via, at}`, mode 600) and starts the copilot on the live
meeting:

- It claims the lock when there is none, the holder's process is gone, it
  already holds it, or it is armed and the holder is only the owner session.
  With no lock it creates the file exclusively. To take over a dead or
  owner-held one it writes the file, waits a random 100 to 300 ms, reads it back
  and starts only if it is still its own, so two sessions claiming at once
  don't both start.
- `/meeting watch` takes the lock at once, even from a running owner session.
  The old holder stops quietly (one notice: "Meeting copilot moved to X") and
  doesn't take it back until the lock is free again.
- `/meeting watch off` disarms and releases the lock. Quitting releases it too.
- With no transcript yet the widget says "waiting for captions" and starts
  reading when `state.json` names one.
- A meeting ends when `state.json` says so (or the recorder dies): the recap is
  posted and written as before. It never restarts, not after it ended and not
  after `/meeting stop` (that is remembered in `meeting-stopped.json` beside the
  lock, last 5 meetings, so another session or a `/reload` doesn't restart it
  either). A recorder restart is a new meeting (a new `started_at`),
  so there is no wait for a reconnect.

Sessions that aren't eligible do nothing, but can still use the `meeting` tool
(it reads files and needs no lock).

## How it works

```text
/meeting watch [off]                                   arm this session and take over now
/meeting replay [speed] [path] [--model provider/id]   play a finished transcript (testing)
/meeting ask | notes | focus <text> | recap | stop     /meeting alone shows status
```

`/meeting` alone says whether this session is armed, the owner setting, who
holds the lock and the live meeting. `/meeting start` is gone: meetings start
by themselves. `/meeting ask` runs the notes scout right now, `/meeting notes`
posts the current notes to chat as one message (only when you ask),
`/meeting focus` tells the scout what you want out of the meeting, and
`/meeting recap` writes the recap so far.

### The status line

One line above the prompt, zero parts left out:

```text
● Weekly Sync · 16m · slide 4 · 2 alerts · 1 question
```

It says `waiting for captions` until there are some, `call ended` (or
`replay done`) after, `updating notes…` during a call and `error: …` if the
scout fails.

### The notes scout

One model call does all the thinking: the notes scout, `github-copilot/claude-haiku-5.5`
unless `meeting.model` (or `PI_MEETING_MODEL`) says otherwise. It is called in
process through pi's model registry, and it is no longer limited to work
models: it reads the meeting, so use a model you are happy to show it to. With
no usable model you get one warning, and name alerts (a code rule, below) still
work; no notes appear.

Each call sends:

- who you are: `~/.pi/agent/meeting-context.md` and your name
- the meeting's title, app, `/meeting focus` and people
- a digest of the pi session running the copilot: its name, your last five
  messages (300 characters each) and the last assistant message (600): what
  you are working on right now
- the OCR text of the slides shown so far, newest first, about 4k characters
- the previous notes, so it updates them instead of rewriting
- the transcript, with the part that is new since the last call marked

and gets back JSON: `topics` (at most 8, newest last, one sentence each),
`decisions`, `actions` (`who`, `what`, `mine`: assigned to or taken by you),
`questions` (**at most 2**, usually none: only a question worth interrupting
for, grounded in your session digest, `meeting-context.md` or the slides, never
generic) and `reply` (only when someone is waiting on you right now, a short
reply in your voice; else null). The system prompt holds the background
(`meeting-context.md`, the end of the previous transcript of the same meeting
and `qmd search` hits for the title) and stays fixed, so the provider can cache
it. A call stays under about 60k tokens by dropping the oldest transcript first.

The model is never polled. Code decides when a call is worth it:

- about 3 minutes of new caption talk
- sooner on a new slide or a slide you go back to, or on a name alert, once the
  sentence has landed, but never twice within a minute
- never while a call is in flight
- once at the end of the meeting, before the recap (if it fails, the recap goes
  out without it)

`/meeting ask` forces one.

### Alerts

Two kinds, and nothing else alerts:

- **name:** someone other than you says your name. A code rule, immediate, no
  model; one alert per speaker per two minutes (repeats collapse). It also asks
  for an early scout call, so a reply can follow.
- **action:** the scout reports a new action with `mine: true` that wasn't in
  the previous notes (compared by normalized text).

Each alert is one short chat message, sent as a `meeting` custom message with
`triggerTurn: false`: it lands in the transcript and in the main model's
context, but the main model doesn't start a turn.

```text
🔔 Ada said your name (14:12): "Eric, can you own moving the legacy services…"
✅ Action on you: own moving the legacy services onto canary (Ada, 14:12)
↳ Katherine is waiting on you. You could say: "I can have a plan by Friday."
```

The last line above is a reply from the scout, posted on its own, once per
reply (the same words, or another reply to the same person within two minutes,
don't post again). A reply that arrives together with an action alert rides on
that message as `↳ You could say: "…"`. Nothing else posts during a meeting:
no per-question messages and no "check" messages. The start and stop messages
are one line.

### The notes file for the canvas

Whenever the notes or the alerts change, the extension writes
`~/.pi/canvas/.meeting-notes.json` (`PI_MEETING_NOTES_FILE`, or under
`PI_CANVAS_ROOT`): atomic, mode 600.

```jsonc
{ "v": 1, "pid": 4242, "session": { "id": "…", "name": "earl" },
  "meeting": { "started_at": "…", "app_id": "teams", "title": "Weekly Sync" },
  "at": "ISO", "ended": false, "me": ["eric", "boehs"],
  "topics": [{ "title": "…", "summary": "…" }], "decisions": [{ "text": "…", "at": "ISO" }],
  "actions": [{ "who": "…", "what": "…", "mine": true, "at": "ISO" }],
  "questions": [{ "q": "…", "why": "…" }], "reply": { "to": "…", "text": "…", "at": "ISO" },
  "alerts": [{ "id": "a1", "kind": "name", "who": "Ada", "text": "…", "at": "ISO" }],  // newest last, the last 20
  "alertSeq": 1 }                                                                      // the last alert id's number
```

The [canvas](../../canvas/README.md) shows it on the Meeting card and on
`/meeting`, only while `meeting.started_at` matches the live meeting and the
pid is alive (or the file says `ended`). It is removed when the copilot stops
for any reason but the meeting ending (`/meeting stop`, `watch off`, the lock
moving) and when pi quits mid-meeting. A `/reload`, `/resume` or `/fork` keeps
it: the new instance reads it back (when `started_at` matches) so its notes,
alerts and "already alerted" list carry on instead of starting over. When the
meeting ends it stays, marked `ended: true`, even after pi quits, so the
canvas can show the final notes. A replay writes none.

Every write is also kept for good as `~/.pi/canvas/meetings/<meeting id>.json`
(`PI_MEETING_NOTES_DIR`; atomic, files mode 600, the folder mode 700), the same
content under the meeting's id: `sha1("<app_id>|<started_at>")`, 12 hex
characters (`meetingId` in `capture.ts`, and the same in the canvas's
`meeting-feed.mjs`). The "removed when pi quits" rule is for the live file only; the
archive is never removed, never written for a replay, and it is what the
canvas's `/meetings` history shows (topics, ★ action items, search) and what
`/meeting?id=<id>` shows in its Notes column for a past meeting.

### The recap

When the meeting ends, the recap goes into the session and into the daily note
(`meeting.dailyDir`, for the capture's date; none set, no note). It is a `###`
block at the end of `## Meetings` with **Topics**, **Decisions**, **Action
items** (yours first, starred) and **Open questions**. A hidden marker ties the
block to its capture, so `/meeting recap` mid-meeting and the final recap
rewrite the same block. Replays never write to the note.

`/meeting replay 30` plays a finished transcript back at 30× (the newest in
`PI_MEETING_DIR`, else the last meeting in `state.json`, or give a path), which
is how to tune the prompt without a meeting. The waits shrink with the speed. A
replay takes no lock and writes nothing to the daily note or the notes file.

Teams writes a caption only when it scrolls out of its ~3-line window, so the
copilot runs a couple of utterances behind the room.

## Asking in chat

The session model answers questions about the meeting with the read-only
`meeting` tool, so you can just type "what did I miss in the last 10 min",
"what did Amy say about the cert" or "what's this slide about". It runs on the
session's model, whichever it is: it hands the session model the transcript
and the slide images, so use it only in a session whose model may read them.

| action | what it returns |
|---|---|
| `status` | title, app, start and elapsed, people, slide count, the slide on screen, whether OCR exists |
| `transcript` | `[HH:MM:SS] Speaker: text`; chat as `(chat)`, `▣ slide N`, `↺ back to slide N`, `👥 N in the meeting`; lines still being spoken come last, marked "(still speaking)" |
| `slide` | the slide's time first shown and every revisit, its OCR text ("OCR not ready yet" if missing) and the jpg as an image, scaled and re-encoded like the read tool does (skipped over 4 MB) |

`transcript` takes `minutes` (the last N), `since` / `until` (`HH:MM`,
`HH:MM:SS` in the meeting's own time zone, or ISO), `speaker` (a case-insensitive part of the name; a
first name works), `query` (words that must all appear) and `limit` (lines,
default 400). It keeps the newest lines under about 16k characters and opens
with a line saying what it cut. `slide` defaults to the slide on screen (the
last slide or revisit).

It reads the live meeting. With none live it reads the most recent one in
`state.json`, even an ended one, and says so; with no `state.json` it says
there's nothing. It also works during a replay. While this session runs a live
meeting, one line goes into the system prompt each turn (`A meeting is live:
Weekly Sync (Microsoft Teams), 16 min in, slide 4 on screen. Use the meeting tool
for anything about it.`) and none otherwise. The minutes move in steps of 5
("just started" under 5), so the line only changes every five minutes.
