# ask

A minimal AskUserQuestion. **Tool:** `ask`.

Registers one `ask` tool, the pi equivalent of Claude's
AskUserQuestion: a single question with 2–4 options, optional one-line
descriptions, and a `Type something.` row that opens an input dialog for a free
answer. `multiSelect: true` turns the rows into checkboxes (space/click
toggles, `a` toggles all, enter submits with a live count); `questions: [...]`
asks several questions sequentially in one call and keeps the transcript so far
if one is cancelled midway. The run's abort (Esc, or the phone's Stop) cancels
it and withdraws the question from the phone.

Single-select reuses pi's `SelectList`, which already handles mouse
press/click/wheel; the multi-select dialog renders its own rows and hit-tests
clicks zone-style, click-only so transcript drag-select keeps working (the same
trade next-steps chips make). RPC mode falls back to the dialog protocol — a
single `select`, or one `input` round-trip of comma-separated numbers for
multi — and print/JSON mode gets an error instead of a hang. The schema stays
small on purpose (one tool, short description) and the extension does no work
at session start, so the boot and per-turn cost is near zero.

Pure helpers (`buildItems`, `parseMultiPicks`, `formatAnswerLines`) are
exported for [`test/ask.test.mjs`](../../test/ask.test.mjs); the dialogs themselves need a terminal.

Both TUI pickers report `blocked` over OSC 7501 (`kind=question`, the title
"Answer the agent's question") while they wait, so a terminal that shows the
program status shows a question, not `working`. The question text never goes
in the report, only in the dialog.
