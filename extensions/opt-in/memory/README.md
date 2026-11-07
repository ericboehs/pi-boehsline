# memory

*Opt-in:* `/boehsline enable memory`.

Durable facts about you and your work, shared by every pi session on this host: the interactive ones, headless `pi -p` runs and scheduler tasks. Each fact is a markdown file you can read, grep, edit and diff.

| Adds | Does |
|---|---|
| `remember` tool | Saves one fact, `global` (default) or `project` (this repo, any clone or worktree) |
| `memory_search` tool | Keyword search over saved facts, plus qmd's hybrid search when it's set up |
| `forget` tool | Archives a fact by id; restorable for 30 days |
| `memory_update` tool | Replaces a fact's text (git keeps the old one) |
| `/memory` | Root, project, counts per scope, pins, qmd status, and what this session was shown |
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
---
Deploys to production need two approvals in the release channel.
```

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

`PI_MEMORY_ROOT` overrides the root. `candidates`, `reviewModel`, `inject.turnChars` and `inject.turnHits` are read but not used yet. Usage counts (for ranking) are kept outside the repo, in `~/.local/state/pi-memory/stats.json`.

## CLI

`bin/pi-memory` does the same from the shell, through the same scanner, dedupe and commit:

```bash
pi-memory list [--scope visible|global|project|all] [--state active|proposed|archived|all]
pi-memory search deploy approvals
pi-memory add --project --tags deploy "Deploys need two approvals"
pi-memory edit m-20261107-k3f9          # $EDITOR, or --text "…"
pi-memory forget m-20261107-k3f9        # restore m-… brings it back
pi-memory pin "Answer in British English"   # pin rm 1; pin alone lists
pi-memory context                        # the block a session here would start with
pi-memory status
pi-memory qmd setup
```

Every command takes `--json`, `--cwd DIR` (which repo is the project) and `--root DIR`.
