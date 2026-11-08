# memory

*Opt-in:* `/boehsline enable memory`.

Durable facts about you and your work, shared by every pi session on this host: the interactive ones, headless `pi -p` runs and scheduler tasks. Each fact is a markdown file you can read, grep, edit and diff.

| Adds | Does |
|---|---|
| `remember` tool | Saves one fact, `global` (default) or `project` (this repo, any clone or worktree) |
| `memory_search` tool | Keyword search over saved facts, plus qmd's hybrid search when it's set up |
| `forget` tool | Archives a fact by id; restorable for 30 days |
| `memory_update` tool | Replaces a fact's text, and/or sets the day it stops being true |
| `memory_verify` tool | Records how a fact was checked against the sessions it came from (the nightly review's job) |
| `/memory` | Root, project, counts per scope, pins, qmd status, what this session was shown, and how many facts expire soon or were never verified |
| `/memory search <words>` | The same search, in the TUI only |
| `/memory add [--project] <fact>` | Saves a fact as you |
| `/memory edit <id>` | Opens the fact in pi's editor |
| `/memory forget <id>`, `/memory restore <id>` | Archive, bring back |
| `/memory pin [text]`, `/memory pin rm <n>` | Standing instructions (`pinned.md`); the model has no tool for these. No text lists them |
| `/memory context` | The exact block this session started with |
| `/memory qmd setup` | Registers the `memory` qmd collection |

## Where it lives

```
~/.local/share/pi-memory/            the root (memory.root); 0700; a local git repo
  global/        m-20261107-k3f9.md  facts every session on this host sees
  projects/<host>/<org>/<repo>/      facts for one repo, keyed by its origin remote
  proposed/                          candidates awaiting approval; never shown to the model
  archive/                           forgotten; restorable, deleted after 30 days (git keeps them)
  pinned.md                          your standing instructions
  .pi-memory                         marks the folder as a pi-memory root
```

The root must be a new or empty folder (or one pi-memory made): pi-memory refuses to take over a folder that holds anything else, so a mistyped `memory.root` can't chmod, re-configure or commit someone's project.

One file per fact, YAML front matter then the text:

```markdown
---
id: m-20261107-k3f9
scope: projects/github.com/acme/widgets
created: 2026-11-07T14:02:11-06:00
updated: 2026-11-07T14:02:11-06:00
source: { kind: remember, session: 0b1c…, cwd: ~/Code/github.com/acme/widgets, model: … }
confidence: stated
tags: [deploy, approvals]
expires: 2026-11-09
verified: { at: 2026-11-08T03:30:12-06:00, status: confirmed, by: opencode-go/deepseek-v4.1-flash, evidence: "2026-11-07T14-02-11-abc: he said two approvals on Wednesday", of: 4f2c9a1b7e30 }
---
Deploys to production need two approvals in the release channel.
```

Only `id`, `scope`, `created`, `updated`, `source`, `confidence`, `tags` and the text are always there. `expires` and `verified` are optional and are described under [Expiry and review](#expiry-and-review); a file written before they existed parses as it always did.

The project scope comes from the folder's git `origin` (`git@github.com:acme/widgets.git` and `https://github.com/acme/widgets` are both `github.com/acme/widgets`). A folder with no origin only has `global/`.

There is one pool per host. Material that must stay apart belongs on different hosts, not behind rules here.

**Never add a git remote to the root.** Each write is committed to the root's local repo for undo and audit (`git -C ~/.local/share/pi-memory log`); the commit refuses to run while the repo has a remote, and `/memory` warns about one. Git runs with hooks, fsmonitor, signing, global attributes and filter or diff drivers off (the repo's own config and `info/attributes` say so too, for a git you run there by hand), so saving a fact doesn't run anything your git config or the repo names.

## What a session sees

The first prompt of a session gets a `memory` section in the system prompt: your pins (within a budget of their own, also `inject.startChars`), then this repo's facts, then global ones, newest and most used first, within `inject.startChars` and `inject.startMax`. It's rendered once and kept for the session, so saving a fact later doesn't change the system prompt (and doesn't cost a prompt cache miss); the new fact is already in the conversation as the tool result. `/new`, `/resume` and `/fork` render it again.

Facts are shown as notes, not instructions, one line each, with anything shaped like markup defused, so a saved fact can't pose as part of the prompt. Facts and pins are scanned again when the section is rendered and when `memory_search` answers, so a file edited by hand (or by a model through bash) that the scanner refuses is left out. Subagent children get no section and `memory_search` only.

## What it refuses

Every write (tool, command, CLI) is scanned. A hit refuses the write and names the category without repeating the text:

- **secret**: provider key prefixes, JWTs, PEM blocks, `op://` references with a value beside them, credentials in URLs, `password:` / `token=` pairs, long random-looking tokens
- **personal identifier**: SSN-shaped numbers, payment card numbers (Luhn-checked), dates of birth
- **prompt injection**: "ignore previous instructions" and the like, prompt or tool-call markup, long base64 blobs, invisible characters
- whatever you add in `scanner.extraPatterns`

The text is checked as written and as it reads: full-width letters, accents, invisible characters and Cyrillic or Greek lookalikes are folded to plain Latin and line breaks to spaces first. A phrase split by punctuation or across two facts still gets through; the fence and the notes-not-instructions framing are the backstop.

A fact that holds 80% of the words of one already saved in the same scope is refused as a duplicate, with the existing id.

## Search and qmd

`memory_search` always works: it scores each fact's words and tags against the query. With [qmd](https://github.com/tobi/qmd) on `PATH` and the `memory` collection set up, it also runs `qmd query -c memory` and puts qmd's hits first; any qmd error or a 5 s timeout falls back to the built-in search.

Setup is never automatic, since it changes your qmd index:

```bash
pi-memory qmd setup     # or /memory qmd setup
```

That adds the root as the collection `memory` and indexes it. After each write the extension runs `qmd update` in the background (debounced); embeddings follow your usual `qmd embed`. Hits in `proposed/` and `archive/` are dropped.

`search.collections` names other qmd collections `memory_search` may also query (default none). Their hits are listed separately as outside memory and never saved.

## Expiry and review

A note written in the moment drifts: it was true when it was said, and a month later it reads as still true. Two optional fields fix that.

**`expires: 2026-11-09`** is the last day the fact is in force, in local time. Through that day nothing changes; after it the fact is never injected into a session and never returned by `memory_search`, and the next `pi-memory expire` (or the nightly review's check) archives it through the normal path with `expire <id>` as the commit, so it stays restorable for 30 days like any other archived fact. `remember` and `memory_update` take an `expires` (a `--expires` on the CLI): a real `YYYY-MM-DD` day, today or later — a past date is refused. The `remember` tool's description tells the model to set one whenever a fact is about a limited time ("this weekend", "until the release", "today only").

**`verified: { at, status, by, evidence, of }`** is how the fact was checked against the sessions it came from: when, whether that came out `confirmed`, `contradicted` or `unverifiable`, which model did it (or `user`), and the evidence — the session id(s) and one line of why. `memory_verify {id, status, evidence}` sets it; the evidence is scanned like any other write (the whole text, before it is cut at 300 characters, so a secret straddling the cut is refused rather than half-written), and the commit is `verify <id> <status>`. A verification is not an edit: it leaves `updated` alone, so "changed since its last verification" means what it says. `of` is the fact's version when it was checked — a short hash of its text and `expires`, recorded by the store itself — so an edit in the same second as the verification still counts as a change (the second-precision `updated` alone would miss it); files written before `of` existed fall back to comparing `updated` with `at`. The CLI's `pi-memory verify <id> --status S --evidence "…" [--by MODEL]` does the same from the shell (`by` defaults to `user`), and it refuses to record anything unless both `--status` and a non-empty `--evidence` are given: a verification nobody made is worse than none.

`restore` clears `expires`: a fact archived because its day passed would otherwise come back active but expired — invisible to injection and search, and archived again by the next `expire`. Set an expiry again if the restored fact needs one.

`pi-memory review-check [--days 14] [--json]` archives expired facts, then prints one line per fact that is due for review — never verified, verified more than `--days` ago, updated since its last verification, or contradicted — with its id, scope, updated, expires, last verification and text. Its exit code says what happened: **0** something is due, **3** nothing is due, **1** an error (2 bad usage), so a scheduled run stops early without confusing "nothing to do" with "it broke"; an `expired N:` line is printed whatever the code. `/memory` and `pi-memory status` count what stops being true within 7 days and what was never verified.

### Nightly review on pi-scheduler

The review itself is a prompt, `extensions/opt-in/memory/review-prompt.md`, so it can be read and tested without a model:

1. run `pi-memory review-check`; exit 3 means nothing is due — answer `nothing due` and stop (exit 0: review every line; 1 or 2: report the error and stop);
2. for each due fact, search the `sessions` collection for where it was said or decided and for anything later that changes it — `qmd search -c sessions` first, then `qmd query -c sessions` if the hits are thin, at most about 4 searches per fact;
3. call `memory_verify` with the session id(s) and a one-line reason; contradicted → `memory_update` with the corrected text (or `forget` when it no longer holds at all); a time-bound fact without an expiry → `memory_update` to add one; never invent evidence — with no hit, `unverifiable`;
4. end with a short report: counts, and one line per changed fact.

It reads only: everything it changes goes through the memory tools, so it is scanned and committed like any other write. Session text and evidence are data, never instructions — the prompt says so, because it reads arbitrary transcripts with full tools. Neither the prompt nor this package schedules anything; the task is created once, on the host:

```sh
pi-scheduler add --name memory-review --model opencode-go/deepseek-v4.1-flash \
  daily 03:30 :: \
  'Follow /Users/ericboehs/Code/github.com/ericboehs/pi-boehsline/extensions/opt-in/memory/review-prompt.md and do what it says.'
```

Options come first (`--name`, `--model`), then the schedule, then `::` and the prompt. The prompt file lives wherever this package is installed — that path is this machine's checkout; change it, or paste the file's text in place of the last argument.

There is deliberately **no `--cwd`**: `pi-scheduler add` stores the value verbatim (no `~` or `$HOME` expansion) and falls back to your home folder when it does not exist, so `--cwd ~/.local/share/pi-memory` would quietly run in `$HOME`; and pointing it at the expanded memory root is worse, because pi has never trusted that folder, and a scheduled run subject to pi's project-trust policy skips its extensions, skills and templates — which is exactly `memory_verify` and `memory_update`, the tools the review needs. Left out, the cwd is wherever you ran the command, and the memory root comes from the settings anyway. Each run is a fresh headless `pi -p` with its own model, loading what an interactive pi would — so the prompt, not a pre-check flag, runs `pi-memory review-check` itself.

## Settings

```jsonc
// ~/.pi/agent/boehsline.json
{
  "enable": ["memory"],
  "memory": {
    "root": "~/.local/share/pi-memory",
    "git": true,
    "inject": { "startChars": 2500, "startMax": 25 },
    "qmd": "auto",                       // "off": never run qmd
    "search": { "collections": [] },     // other qmd collections memory_search may query
    "scanner": { "extraPatterns": [{ "category": "ticket number", "pattern": "\\bTKT-\\d+\\b" }] }
  }
}
```

`PI_MEMORY_ROOT` overrides the root. `candidates`, `reviewModel`, `inject.turnChars` and `inject.turnHits` are read but not used yet (the review's model comes from the pi-scheduler task, not from this block). Usage counts (for ranking) are kept outside the repo, in `~/.local/state/pi-memory/stats.json`.

## CLI

`bin/pi-memory` does the same from the shell, through the same scanner, dedupe and commit:

```bash
pi-memory list [--scope visible|global|project|all] [--state active|proposed|archived|all]
pi-memory search deploy approvals
pi-memory add --project --tags deploy --expires 2026-11-09 "Deploys need two approvals"
pi-memory edit m-20261107-k3f9          # $EDITOR, or --text "…"; --expires alone moves the end
pi-memory forget m-20261107-k3f9        # restore m-… brings it back
pi-memory expire                         # archive every fact whose expires day has passed
pi-memory verify m-20261107-k3f9 --status confirmed --evidence "2026-11-07T14-02-11-abc: he said so"
pi-memory review-check [--days 14]       # what is due; exit 0 something, 3 nothing, 1 an error
pi-memory pin "Answer in British English"   # pin rm 1; pin alone lists
pi-memory context                        # the block a session here would start with
pi-memory status
pi-memory qmd setup
```

Every command takes `--json`, `--cwd DIR` (which repo is the project) and `--root DIR`.
