# meeting

*Opt-in:* `/boehsline enable meeting`.

A live meeting copilot: it follows a meeting transcript and keeps a short list
of questions worth asking out loud, using only your work models. It starts and
stops by itself, and you can ask the session about the meeting in plain chat.
**Commands:** `/meeting`, `/q<N>` (research question N in the background).
**Tool:** `meeting` (status, transcript, slide), for the session model.
**Needs:** [meeting-capture](https://github.com/ericboehs/meeting-capture) (or
anything that writes its `state.json` and transcript, see its
`docs/canvas-contract.md`). The copilot only reads those files.

## Settings

In `~/.pi/agent/boehsline.json`. Environment variables (`PI_MEETING_*`) still override.

```jsonc
{
  "work": {
    "providers": ["github-copilot"],               // only these may read a meeting
    "models": ["github-copilot/<fast model>"],     // the scout that writes questions
    "researchModel": "github-copilot/<strong model>",  // /q research when the session model isn't a work model
    "ghHost": "github.acme.com"
  },
  "meeting": {
    "qmdCollections": ["notes"],   // background search, and /q research
    "dailyDir": "~/Notes/daily",   // the recap lands here
    "codeDir": "~/src",            // /q research can look here
    "owner": "earl"                // the session with this name runs the copilot by itself
  }
}
```

`PI_MEETING_OWNER` overrides `meeting.owner`. Environment only: `PI_MEETING_ME`
(your name, else git's `user.name`), `PI_MEETING_ABOUT` (a file about you, else
`~/.pi/agent/meeting-context.md`), `PI_MEETING_REASONING`, `PI_MEETING_WATCH=1`
(arm the session, for testing), `PI_MEETING_LOCK` (the lock file),
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

Watches the live
[meeting-capture](https://github.com/ericboehs/meeting-capture) transcript and
keeps a list of questions worth asking. The widget above the prompt shows the
three most worth asking right now:

```text
● meeting · Weekly Sync · 16m · cert rotation · 4 checks · /meeting stop
  Q3 Has the vendor confirmed the old service is out of prod too? — Sam said maybe only dev
  Q4 Who signs off before the cert fix deploys? — no approver named
  Q6 Does the fix wait for the security review? — review not done yet
  +2 more open · 1 answered or asked · /meeting list
```

```text
/meeting watch [off]                                   arm this session and take over now
/meeting replay [speed] [path] [--model provider/id]   play a finished transcript (testing)
/meeting ask | focus <text> | list | recap | stop      /meeting alone shows status
/q3 [what to look for]                                 research one question (/q to pick)
```

`/meeting` alone says whether this session is armed, the owner setting, who
holds the lock and the live meeting. `/meeting start` is gone: meetings start
by themselves.

## Asking in chat

The session model answers questions about the meeting with the read-only
`meeting` tool, so you can just type "what did I miss in the last 10 min",
"what did Amy say about the cert" or "what's this slide about". It runs on the
session's model, whichever it is. The tool is not limited to work models: it
hands the session model the transcript and the slide images, so use it only in
a session whose model may read work text. Only the scout (below) is limited to
work models.

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

A question leaves the list only when the scout sees it answered or asked. The
rest stay open even after the talk moves on. New questions show up right away.
Otherwise a question stays in view for three minutes before the scout's
re-ranking can swap it out. `/meeting list` expands the widget to every
question.

When the meeting ends, the recap goes into the session and into the daily note
(`meeting.dailyDir`, for the capture's date; none set, no note). It's a `###` block at the end of `## Meetings` that lists every question
as still open, answered (with the answer), or asked. A hidden marker ties the
block to its capture, so `/meeting recap` mid-meeting and the final recap
rewrite the same block. Replays never write to the note.

`/q3` researches Q3 in the background while you keep talking. It starts a
separate `pi -p` process at medium thinking, with read-only tools. It runs on
the session's model when that's a work model, and on `work.researchModel`
otherwise (`PI_MEETING_RESEARCH_MODEL` overrides it, work models only). That
process searches qmd (`meeting.qmdCollections`), Slack, your GitHub host
(`work.ghHost`), your code folder (`meeting.codeDir`) and the web. Nothing runs in the main session.
Text after the number steers the search (`/q3 check the security plan notes`), and `/q`
alone opens a picker. Each run has three minutes and at most two run at once.
The widget shows `Q3 🔎 1:20` while it works. The brief then lands as a
session message with an `Answer:` line, evidence with sources, a sharper version
of the question, and gaps. The answer also shows under the question in the
widget and as a `Researched:` line in the recap. A call that ends with research
still running waits for it before stopping. `/meeting stop` cancels research.
`/q` still works after the meeting, and a finished brief then rewrites the
daily-note recap.

`/meeting replay 30` plays a finished transcript back at 30× (the newest in
`PI_MEETING_DIR`, else the last meeting in `state.json`, or give a path), which
is how to tune the prompt without a meeting. A replay takes no lock and writes
nothing to the daily note.

The model is never polled on a timer. The file is polled, and code decides
when a check is worth a call. A check runs on:

- someone else saying your name, or "any questions?"
- about six new lines followed by a pause
- 45 seconds of unchecked talk
- a flood of lines

There is never more than one check per 15 seconds. Each check sends the
transcript to a small model (`PI_MEETING_MODEL`, default the first of `work.models`).
Meetings are work text, so only work models (`work.providers`) run the scout and
/q research. (The `meeting` tool is separate: it uses the session model.) A
model from any other provider, whether from `PI_MEETING_MODEL`, `--model` or the
session, is refused with a warning. With no work model, or while a call
fails, code rules carry on: being named or "any questions?" still shows in the
widget (`! Jordan Blake named you: "…"`), but no new questions appear. Each
call stays under about 60k tokens by keeping less of the transcript's start.
The system prompt holds the background:

- `~/.pi/agent/meeting-context.md`, a few lines on who you are
- the end of the previous transcript of the same meeting
- `qmd search` hits for the meeting title

The system prompt stays fixed and the transcript is append-only, so the
provider can cache the prompt prefix. A replay of a 33-minute meeting took
five checks.

New questions and suggested replies also go into the session as `meeting`
messages sent with `triggerTurn: false`. They land in the transcript and in the
main model's context, but the main model doesn't start a turn. Ask it "what
should I say?" and it already has them, plus the transcript path. The old
`--wake` flag is gone: a meeting never starts a turn. Meeting prep lives in the
[watcher](../watch/README.md#proactive).

Teams writes a caption only when it scrolls out of its ~3-line window, so the
copilot runs a couple of utterances behind the room.
