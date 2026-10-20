# Boehsline

> The baseline for [pi](https://pi.dev). *(Say "bays-line.")*

https://github.com/user-attachments/assets/2f726e72-28ee-4ffe-a9ba-221c91432414

Boehsline is Eric Boehs's pi setup, packaged so anyone can install it: more than 30 extensions in one package, plus the skills that come with agent-link. Most extensions are on by default; the ones that only make sense with particular tools or habits are opt-in.

**Status:** early. The contents are still moving in from separate repos.

## Install

```bash
pi install git:github.com/ericboehs/pi-boehsline
```

## Extensions

Each extension is a folder under [`extensions/`](extensions) with its own README. Core extensions load by default; turn one off with `pi config` or a filter on the package entry. Opt-in extensions stay off until `/boehsline enable <name>` (or the `/boehsline` menu).

### Core

| Extension | What it does | Adds |
|---|---|---|
| [ask](extensions/ask/README.md) | A minimal AskUserQuestion: 2–4 options, multi-select, several questions at once | `ask` tool |
| [aa-info](extensions/aa-info/README.md) | An Artificial Analysis briefing line whenever you switch models |  |
| [auto-session-name](extensions/auto-session-name/README.md) | Names a fresh session after its first turn | `/auto-name` |
| [bg](extensions/bg/README.md) | Background jobs through a `background` flag on `bash`, with a widget and logs | `/bg` |
| [canvas](extensions/canvas/README.md) | A live local web page per session for tables, charts, diffs and findings | `canvas` tool, `/canvas` |
| [code-lint](extensions/code-lint/README.md) | Runs your linters after `edit`/`write` and feeds errors back |  |
| [color](extensions/color/README.md) | Tints the session's editor border, like Claude Code | `/color` |
| [compact-progress](extensions/compact-progress/README.md) | Progress bar and learned ETA while compaction runs |  |
| [compaction](extensions/compaction/README.md) | Cache-replay compaction, and idle compaction before the cache expires | `/idle` |
| [cursor-focus](extensions/cursor-focus/README.md) | Your terminal's real cursor instead of pi's drawn one |  |
| [footer](extensions/footer/README.md) | A lean status line you can reorder and trim | `/footer`, `/boot`, `/bypass` |
| [image-preview](extensions/image-preview/README.md) | Real images inside tmux, and a full-size popup | `/preview` |
| [next-steps](extensions/next-steps/README.md) | Type `/2` to pick option 2 of a "Next steps:" list |  |
| [openrouter-route](extensions/openrouter-route/README.md) | Which upstream OpenRouter routed each turn to, in the footer |  |
| [pr-tracker](extensions/pr-tracker/README.md) | A canvas card for the current branch's GitHub PR, kept up to date | `/pr-tracker` |
| [prompt-history](extensions/prompt-history/README.md) | Shell-style prompt history shared by every pi, with Ctrl+R search | Ctrl+R |
| [provider-usage](extensions/provider-usage/README.md) | Usage and quota chips for codex, copilot, grok and more | `provider_usage` tool |
| [stash](extensions/stash/README.md) | Park a draft with Ctrl+S and get it back later | Ctrl+S, `/stash` |
| [subagent](extensions/subagent/README.md) | Run a separate pi for a focused task | `subagent` tool |
| [todo](extensions/todo/README.md) | A shared task list for you and other agents at `.pi/TODO.md`, with locked claims | `todo` tool, `/todo` |
| [turn-timer](extensions/turn-timer/README.md) | A toast when a run ends, and per-model step and time stats | `/turn stats` |
| [web](extensions/web/README.md) | Web search across backends you order, and a fetch that escalates until it works | `web_search`, `web_fetch`, `/web` |
| [boehsline](extensions/boehsline/README.md) | The menu for opt-ins, default keybindings, bundled packages and config | `/boehsline` |

### Opt-in

| Extension | What it does | Adds |
|---|---|---|
| [approval-guardian](extensions/opt-in/approval-guardian/README.md) | Fail-closed gate: a reviewer model checks risky tool calls | `/approval-guardian` |
| [image-prune](extensions/opt-in/image-prune/README.md) | Shrinks big tool result images on arrival, and swaps old images for a note with their path past a size threshold | `/image-prune` |
| [watch](extensions/opt-in/watch/README.md) | Slack, bot feed and notification watcher with digests and drafts | `/watch`, `watch_items` tool |
| [meeting](extensions/opt-in/meeting/README.md) | Live meeting copilot: questions worth asking, from the transcript | `/meeting`, `/q<N>` |
| [omlx](extensions/opt-in/omlx/README.md) | Adds models loaded in a local oMLX server to `/model` |  |
| [sc](extensions/opt-in/sc/README.md) | Attach the newest screenshot from iCloud Downloads | `/sc` |
| [skill-modes](extensions/opt-in/skill-modes/README.md) | Sticky skill modes: a `mode: true` skill stays on until `/mode off` | `/mode` |
| [tmux-attention](extensions/opt-in/tmux-attention/README.md) | Highlights the tmux window when pi needs you |  |
| [update](extensions/opt-in/update/README.md) | `/update` for a mise-pinned pi | `/update` |
| [wiki-session-log](extensions/opt-in/wiki-session-log/README.md) | Runs a command with the session file after each turn |  |

### Bundled packages

Git subtrees under [`packages/`](packages), kept verbatim (see [below](#bundled-packages-git-subtrees)). The approval guardian is one too, loaded through its opt-in wrapper.

| Package | What it does | From |
|---|---|---|
| [context](packages/context/README.md) | `/context`, like Claude Code's: what fills the context window | pi-context |
| [goal](packages/goal/README.md) | Work toward a goal until a check passes or the budget runs out (`/goal`, `start_goal`) | pi-goal |
| [scheduler](packages/scheduler/README.md) | `/loop` and `/once` in the session; `/schedule` for durable unattended runs | pi-scheduler |
| [agent-link](packages/agent-link/README.md) | pi and Claude Code sessions on one machine talk to each other (`@name`, `/agent-link`) | pi-agent-link |

## What it costs

Boehsline adds about 100ms to pi's startup and about 2,800 tokens to the context each conversation starts with, the largest part the canvas tool and its guidelines. Details, a per-extension breakdown and how to rerun it: [docs/benchmarks.md](docs/benchmarks.md).

## Configuration reference

Everything below goes in `~/.pi/agent/boehsline.json`, or comes from a package that supplies settings. Environment variables (`PI_WATCH_*`, `PI_MEETING_*`) still override. The file may have `//` and `/* */` comments and trailing commas, so this example works pasted as is; `/boehsline enable` keeps your comments when it changes the list. If the file doesn't parse, every opt-in is off and pi says why when a session starts. [`defaults/boehsline.json`](defaults/boehsline.json) is a minimal file to start from.

```jsonc
{
  "enable": ["approval-guardian", "watch", "meeting", "tmux-attention"],

  // Secret lookups after the environment. {name} is replaced, else appended. [] = env only.
  "secrets": { "command": ["fnox", "get"], "timeoutMs": 10000 },

  // Work routing for watch and meeting. With no providers, no model reads work text.
  "work": {
    "label": "Acme Copilot",
    "providers": ["github-copilot"],
    "models": ["github-copilot/<fast model>"],
    "researchModel": "github-copilot/<strong model>",
    "sensitive": "employee IDs, customer names",     // named in the scout prompt as never to repeat
    "ghHost": "github.acme.com",                      // research hint; "" for github.com only
    "redact": [{ "pattern": "\\bEMP\\d{6}\\b", "flags": "g", "replace": "[EMP]" }]  // also passed to notif-watch
  },

  "watch": {
    "workspaces": ["acme", "home"],
    "workWorkspaces": ["acme"],
    "feed": { "cli": "team-bot-feed", "workspace": "acme", "channel": "C0123", "label": "#bot-feed" },
    "vips": ["Sam Rivera"],
    "prepSources": ["Acme (Work)"],                   // ical sources that count as work
    "snowUrl": "https://acme.service-now.com",
    "personalModels": ["opencode-go/deepseek-v4.1-flash"],
    "dailyDir": "~/Notes/daily",                      // recap goes here; "" turns it off
    "notifBin": ""                                    // "" = Boehsline's build, else PATH
  },

  "meeting": { "qmdCollections": ["notes"], "dailyDir": "~/Notes/daily", "codeDir": "~/src" },
  "image-prune": { "thresholdMB": 5, "keepTurns": 2, "shrinkMaxPx": 1568, "shrinkMinKB": 512 },  // "enabled": false pauses it; /image-prune now still works
  "update": { "dir": "~/dotfiles", "task": "update:pi" },  // no dir: the checkout that holds ~/.config/mise/config.toml
  "wiki-session-log": { "command": ["~/bin/pi-session-sync"] }
}
```

## Default keybindings

`stash` and `prompt-history` use Ctrl+S and Ctrl+R, which pi also binds, so pi warns at startup until you pick. `/boehsline defaults` shows [`defaults/keybindings.json`](defaults/keybindings.json) as a diff against your `keybindings.json` and merges it after you confirm. It only adds keys you haven't set; `--force` also replaces yours. It moves pi's shortcuts to Alt+S and Alt+R and adds a few more opinionated bindings.

## Opt-in extensions and config

Some extensions are off until you turn them on:

```
/boehsline                  list opt-in extensions and whether each is on
/boehsline enable <name>    turn one on (writes ~/.pi/agent/boehsline.json, then reloads)
/boehsline disable <name>
/boehsline config           the merged config, and where each value came from
```

Settings come from three layers, each overriding the one before:

1. Defaults written in each extension's code.
2. Other packages that supply settings. A private companion package can supply work-specific settings this way.
3. Your `~/.pi/agent/boehsline.json`. See [`defaults/boehsline.json`](defaults/boehsline.json) for a sample.

To turn off a core extension, use pi's own tools: `pi config`, or a filter on the package entry in `settings.json`.

### Supplying settings from another package

A package doesn't need to import Boehsline. Its extension adds its settings to a shared registry on `globalThis`, and the packages can load in either order:

```ts
const key = Symbol.for("boehsline.config.sources");
((globalThis as any)[key] ??= new Map()).set("my-package", { watch: { workspaces: ["acme"] } });
```

Only your own file can turn opt-in extensions on. A package can supply settings but can't enable anything.

## Bundled packages (git subtrees)

`packages/` holds the repos that used to ship on their own. Each is a git subtree with its full history, and stays verbatim so pulls apply cleanly. The root `package.json` lists their entry files.

| Folder | From | Upstream (forks) |
|---|---|---|
| `packages/context` | ericboehs/pi-context | |
| `packages/scheduler` | ericboehs/pi-scheduler | |
| `packages/agent-link` | ericboehs/pi-agent-link | alonw0/pi-claude-link |
| `packages/approval-guardian` | ericboehs/pi-approval-guardian | mics8128/pi-approval-guardian |
| `packages/goal` | ericboehs/pi-goal | |

Remotes aren't stored in git. Set them up once per clone:

```bash
git remote add --no-tags agent-link-upstream https://github.com/alonw0/pi-claude-link.git
git remote add --no-tags approval-guardian-upstream https://github.com/mics8128/pi-approval-guardian.git
```

Pull upstream changes into a subtree:

```bash
git subtree pull --prefix=packages/approval-guardian approval-guardian-upstream main
```

Change subtree code directly in this repo. If you want a change to go back upstream, `git subtree split --prefix=packages/<name>` produces a branch you can open a PR from.

See [NOTICE](NOTICE) for credits and licenses.

## Development

```bash
npm install
npm run typecheck              # links the pi you run (mise/npm -g); CI pins PI_VERSION
npm test                       # node --test (Node >= 22.18)
npm run build:notif-watch      # macOS: build bin/notif-watch (watch does this on /watch start)
pi -ne -e .                    # try the working tree without your installed extensions
```

## License

MIT. See [LICENSE](LICENSE). Code adapted from other projects keeps its original notices; see [NOTICE](NOTICE).
