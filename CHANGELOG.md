# Changelog

## Unreleased

### Changed

- cursor-agent: the footer **Cursor spend** chip shows billing-cycle Cursor spend on the border row (matching `pi-usage`), pace-colored over the cycle, instead of a `cursor` line on the status row; foreground runs still append a dim `· +$… here` when they charged something.

### Fixed

- subagent: an answer over the 50 KB cap keeps its `[N bytes over cap omitted]` note; the cut used to remove the note along with the excess.
- image-prune: saved images (`~/.pi/agent/tmp/image-prune/`) are owner-only (files 0600, folder 0700) and no longer kept forever: each session start deletes ones older than 7 days and keeps at most the newest 200.
- auto-bundle: the detached rebuild gets the lock, log, script path and version as positional arguments instead of `JSON.stringify` spliced into shell text, so a `$`, backtick or quote in a path or version is never run.
- stash: a session's entry is deleted from the shared store when its stack empties, and creating one drops other sessions' empty ones, so a long-lived process no longer keeps an entry per session it saw.
- provider-usage: an idle Claude 5h window no longer looks like a missing one. Anthropic returns `resets_at: null` while `five_hour` has no active usage, and the chip needs a reset to show elapsed/total, so the window was dropped silently; the code now says why.

- compaction: a model whose thinking map has no `off` level (Copilot Sonnet 5.5) gets low-effort adaptive thinking instead of `thinking: disabled`, which the API rejects. Opus 5.5 is unchanged. Models with `off: null` other than Opus 5.5 still fall back to pi.
- compaction: an update may grow the summary by 4,000 characters, and the checkpoint is kept at or under 32,000. The old instruction said to preserve every earlier bullet, so a long session's summary grew until the next compaction had to re-emit it and could hit the output limit. The split-turn block and file lists are kept; the oldest Done bullets are what get dropped.

### Added

- cursor-agent: background runs and `cursor` subagent runs refresh the shared usage cache (`cursor-usage`) when they end, like foreground runs, so `pi-usage` shows their spend.
- subagent: a built-in `cursor` agent (or an agent file with `runner: cursor`) runs Cursor's agent CLI instead of a pi child, through cursor-agent's own run.ts and runner.ts. Foreground tasks return the same result block as a background cursor run (answer, model, duration, charge in dollars, worktree, exit code, error) and put those facts in `details.results[i].cursor`. `background: true` starts the cursor runner as a bg job, so the completion message carries that block. Parallel `tasks` can mix `scout`, `worker` and `cursor`. Each cursor task gets its own git worktree by default; `model`, `cursorMode` and `worktree` override per call or per task (a per-task `model` also applies to pi children). Without cursor-agent enabled or `cursor-agent` installed, only that task fails, with a message saying which. The tool's description says cursor tasks must never carry PII, PHI or secrets, and adds cursor-agent's configured `note` and `rules`.
- cursor-agent: runner.ts exports `startJob`, `runAndCharge` and `resultBlock`, and run.ts exports `binFound`, so the cursor tool and the subagent tool start and report runs the same way.
- cursor-agent: `background: true` runs Cursor as a bg job (runner.ts) and returns at once. `/bg` shows each step live, and a message brings back the answer, the charge, the worktree and the exit code when it finishes. The foreground and background paths share run.ts.
- cursor-agent: Cursor's billing-cycle spend goes into pi's shared `usage-cache.json` as `cursor-usage` after each `cursor` run and on `/cursor-usage`, so `pi-usage` lists it with the other providers.
- cursor-agent: `/cursor-worktrees` lists the `pi-*` worktrees the tool left behind, with their changed files, and applies each to its repo (uncommitted) or removes it.
- cursor-agent: `worktree` (and `worktreeBase`) runs each call in its own git worktree and branch, so parallel calls can't collide; the result names the path, branch and changed files. The tool also declares an `outputSchema`, so codemode scripts get `{answer, steps, chargedCents, tokens, sessionId, …}` instead of text.
- cursor-agent (opt-in): a `cursor` tool that delegates a task to Cursor's agent CLI (`cursor-agent -p`, sandboxed by default), streams its steps, returns its final answer, and reports the run's real charged cost from Cursor's dashboard API (macOS Keychain login). A footer chip keeps the session's Cursor spend; `/cursor-usage` shows the billing cycle against the per-user limit. Neutral by default: a default model, blocked models, a description note and extra prompt rules come from Boehsline config (so a work package can supply them) or `PI_CURSOR_*` env vars.
- op-broker (opt-in): agents read 1Password through an approval card in the session (Allow once, 1 hour or 8 hours per item), and one shared daemon holds a single 1Password CLI authorization for every session, so it's one Touch ID per 12 hours, not one per command. An `op` shim takes `op read`, `op item get --otp` and `op item get --fields --reveal`, and everything else runs the real `op`. The card is a keyboard yes; the README states the risk.
- botsun-owner (opt-in): puts each interactive pi session on Eric's phone through Botsun. It reports state over `~/.local/state/botsun/owner.sock` (`$BOTSUN_OWNER_SOCK`) for the Sessions list (`hello`, `busy`/`idle`, `prompt`/`prompt_end`, `stream`, `model`, `ask`, `commands`, `models`, `session`, `bye`), and takes signed input on its own `owner/<pid>.sock`: replies with photos and files, call audio, `ask` answers, slash commands (`/compact`, `/model`, `/thinking`, `/name`, extension commands, templates, skills). The session verifies every signature itself against `owner-keys.json`. It never creates the shared socket, retries quietly with backoff, and stays off in subagent children and print, JSON and RPC sessions.
- botsun-owner: more of the session on the phone. The message stash (`stash` line; signed `push`/`take`/`drop`), context use (`context`), the footer's chips (`footer`, with `footer_tap` flipping a display chip and answering with the new row), compactions (`compacting`, holding the phone's words until pi takes prompts again), and the guardian's bypass (`bypass`; a signed `/bypass on|off`). `/reload` re-sends commands, models, context and stash.
- botsun-owner: a call's words can wait for a voice helper. `say_audio` with `hold: true` verifies them and holds them; `release {ids, mode}` puts them in as a follow-up, a steer, or an interrupt that aborts the run only when Eric's own words say stop; `drop` and `call_end` forget them. A `held` line carries ids and sizes only.
- botsun-owner: `ask` answered by voice. `say_audio` can carry `proposal_sha256` (signed with the audio), and `confirm` answers the open ask with the read-back answer only when his held reply carries its hash and doesn't say no (`saysNo`).
- botsun-owner: a reworded message confirmed by voice (feature `confirm_text`). `confirm {id, text, mode}` puts in the message Botsun read back, as a steer or a follow-up, never a stop, and only when his held reply carries `sha256("botsun-propose-text-v1\n" + text)` and says yes. At most 600 characters.
- botsun-owner: a signed `stop` request (feature `stop`) for the phone's Stop button; it ends the running turn as Esc does.
- stash: the stack lives in `lib/stash-store.ts`, so another extension (botsun-owner) can push, take and drop entries with the same file locking.
- footer: publishes its chips through `lib/footer-snapshot.ts` (`publishFooter`, ANSI split into coloured segments) for other extensions to mirror, and takes chip taps from them (`onFooterTap`; display toggles only).
- ask: a question can be answered from elsewhere. Each call offers its questions in `lib/remote-prompts.ts`; the TUI dialog and a remote answer race, and when the remote one wins the dialog closes and the tool returns what a keypress would have. botsun-owner answers from Eric's phone.
- footer: pace marks name the window. When a provider has more than one usage window (Codex, Claude, OpenCode Go), the arrow carries the window's span letter — `↓6w` is 6 points ahead of the weekly, `↓6h` of the 5h, `↓6m` of the monthly — in compact, detailed and mini (the bare `↓` becomes `↓w`); single-window chips (Copilot, Grok, Cerebras) stay bare. In mini the letter is the only window name there is.
- provider-usage: Claude's chip shows the meters of the model in use — the 5h session plus the weekly meter of the model's family (opus/sonnet), `weekly_all` when the family has none — instead of every weekly meter side by side; `/claude-window`'s detail still lists them all. The shared cache entry is keyed per family (`claude-window:opus`), so concurrent sessions on different families never adopt each other's value; canvas's usage table folds the family keys into one row, the freshest winning.
- footer: `defaultModels` in `footer.json` names each provider's everyday model (`{ "opencode-go": "deepseek-v4.1-flash" }`); with the Model condition at `unless default` the model chip hides for that model too. Hand-edited like `dirNames`, and kept when `/footer` saves.
- image-prune (opt-in): pi resends every image in context on every request until compaction, and base64 doesn't compress. Once the visible images pass `thresholdMB` (default 5), one batch of `context_edit` replacements at `turn_end` swaps every image older than the last `keepTurns` (2) user turns for a note with a path the read tool can open; pasted images are saved under `~/.pi/agent/tmp/image-prune/` first. One batch, not one image per turn, so the prompt cache is rewritten once. `/image-prune` shows the images in context; `/image-prune now` forces a batch. Tool result images over `shrinkMinKB` (512 KB) are also re-encoded on arrival to at most `shrinkMaxPx` (1568) and under 512 KB, with a note giving the coordinate scale: earl's 3.3 MB PNG camera photos become ~200 KB JPEGs.

### Changed

- canvas: the daemon no longer has a key. No route needs a cookie or `Authorization: Bearer`, `.daemon.json` holds only pid, port and version, `/canvas` and `/canvas url` use the plain URL, and the page has no "Canvas (locked)" state. An old `?k=` link redirects to the same URL without it. What stays: loopback only, the `Host` allowlist (DNS rebinding), no CORS headers, `frame-ancestors 'none'`, and the page's header and Origin on every POST. Anything local that can reach 127.0.0.1 can read sessions and type into pi; see "Access" in the canvas README. The tmux follow hook no longer needs to send a key.

- auto-bundle is now an opt-in extension (`/boehsline enable auto-bundle`), split out of the footer because it depends on a personal `~/bin/pi-bundle`. Behaviour when enabled is unchanged; it listens for the footer's version checks, which the footer now announces on `pi.events` as `boehsline:pi-version`, so it adds no `mise which pi` spawns. Without it enabled nothing re-runs pi-bundle.
- footer: drop the redundant `updateTimerStarted` flag; the update poll checks its own timer (pi rebinds extensions on every session switch).
- footer: OpenCode Go's provider chip reads `oc` (was `ocg`).
- provider-usage: drop the claude-bridge driver and its chip. It read Claude Code's own Keychain/OAuth credential to show the same windows `claude-window` already shows from pi's Anthropic login (`/login` → Anthropic).
- provider-usage: Claude reads the response's `limits[]` instead of inferring spans from `five_hour`/`seven_day`. Each meter names its own `kind`, `group`, `percent`, `severity`, and `resets_at`, so a new meter (Opus, Sonnet, cowork) needs no code, and only a meter with no reset is dropped. `is_active` flags which window is currently enforced, not whether it has usage — Anthropic reports `weekly_all` with `is_active: false` at 33% used — so it never gates rendering. A response where every meter lacks a reset reports `idle` instead of failing the fetch.
- footer, canvas: drop the retired claude-bridge special cases (`INLINE_STATUS_KEYS`, its provider abbreviation and model-name rule, and its canvas usage label). Canvas usage rows now name `claude-window` ("Claude") instead.

## 0.2.6 — 2026-10-17

### Added

- canvas: when the daemon doesn't start, the `/canvas` notice shows the last line of `.daemon.log` (e.g. the port being in use) instead of only naming the file.

### Fixed

- web: a search backend is benched only for a real failure (an HTTP error, a network failure, a timeout). Any other error, such as a bug in a response parser, no longer looks like an outage that benches the backend for ten minutes: it's listed as `backend: TypeError: … (search.ts:242:28)` and the chain moves on.
- web: only a missing `web.json` counts as empty. One that exists but can't be read (permissions, a directory) is reported by `/web` and never overwritten, like one that doesn't parse.
- web: the fetch smoke test loads `index.ts` again (it still imported `web.ts`, gone since each extension became a folder).
- subagent: the background error names the `bg` extension instead of the old `bg.ts`.

### Changed

- `npm test` runs agent-link's tests that don't need a live pi (mentions, naming, relay, send-close).
- CI runs the full suite on macOS as well as Linux (it ran only the notif-watch tests there).

## 0.2.5 — 2026-10-16

### Security

- approval-guardian: 0.2.4's heredoc reading took an escaped or quoted operator as a real one, so in `xargs cat \| python3 - <<'EOF'` it judged the body as Python and dropped a `# .env` line that `xargs` would read; arguments after the heredoc (`python3 <<'EOF' reader.py`) weren't checked either. A quote, backslash or backtick before `<<`, or any argument after it that isn't a value-less flag, now keeps the old reading. Found by re-review.

## 0.2.4 — 2026-10-16

### Added

- footer: the session name sits in the editor's top border (`── my-session ────`), like Claude Code. The `name` chip's modes are `border` (default) and `footer`; an unnamed session shows its dim agent-link name, a `/color` tint colours it, and clicking it runs `/auto-name`. pi's own working status takes the border while it shows.
- footer: a **Placement** row, first in `/footer`, moves the chips into the editor's borders: `below` (default) · `top border left` (just after the name) · `top border right` · `bottom border left` · `bottom border right` (before pi's "↓ N more"). Chips go up in footer order while they fit whole, the rest stay below, and they stay clickable in fullscreen.
- footer: while the guardian is bypassed, the session name turns red with ⚠ (`⚠ my-session`); clicking it turns bypass back on. The bypass row's modes are `name` (default) · `chip` · `both` · `hidden`, and the chip shows whenever the name isn't on screen.

### Changed

- approval-guardian (local change to the subtree): a quoted heredoc that `python3`/`python` or `node` runs as its program (`python3 - <<'EOF'`, flags without values only) is lexed in that language, and its comments don't count as private names, so an edit script whose `#` comment says "credentials" no longer needs explicit approval as a private-data read. String contents stay evidence, and any other receiver (xargs, tar -T -, cat, `python3 -c`, a script file, Ruby, Perl, anything unknown) keeps the old reading: stdin there may be file names. Private only when both readings agree; every bash command is still model-reviewed. The guardian's own tests now run in `npm test`.

### Fixed

- web: a `web.json` that doesn't parse is never overwritten (it used to be replaced with defaults, losing the file); `/web` shows a ⚠ line saying what's wrong. Marking a backend skipped can no longer reject unhandled and end pi.
- canvas: when the daemon's port is taken it says so ("port N is in use …; exiting") instead of dying silently, and `.daemon.json` is written only once it is listening, so a dead daemon isn't advertised.
- subagent: a child killed by a signal reports "killed by SIG…" (keeping its partial reply) and one that can't start reports "could not start pi: …", instead of either passing as success.
- auto-session-name: the session-model fallback has room to answer (1024 tokens) and fails quietly.

## 0.2.3 — 2026-10-16

### Security

- canvas: an `html-plan` section ran same-origin with the canvas page, so its script could reach the page and post to `/send`, typing into pi; an `html` section could do the same by opening an unsandboxed popup on the daemon's origin. Both can come from any file path, an untrusted repo included. Plan frames are now opaque-origin like html, and anything served that can run script (html, svg, xml) carries a CSP `sandbox`, so it stays opaque even in a popup. A plan's answers still survive a reload: the page keeps them per section and hands them back through the frame's name.
- image-preview: `/preview`'s popup title is a tmux format, so an image named `#(cmd).png` ran `cmd`. Every `#` is now doubled.

### Added

- **skill-modes (opt-in).** Sticky skill modes, moved here from Eric's dotfiles: a skill with `mode: true` stays on after `/skill:<name>` and adds a one-line reminder to each run until `/mode off`. Turn it on with `/boehsline enable skill-modes`.
- `boehsline.json` may have `//` and `/* */` comments and trailing commas, so the README's examples work pasted as is. `/boehsline enable` keeps the comments (it edits only the `enable` list), and a file that doesn't parse gets a warning when a session starts instead of silently turning every opt-in off.

### Fixed

- Three unhandled promise rejections that could end pi: provider-usage rethrowing inside background refreshes (now logged to `provider-usage.log` in the agent dir, along with the fetch failed/recovered lines that used to garble the footer through `console.error`), canvas `ensureDaemon` when the canvas root can't be created or the spawn fails, and canvas status runs.
- auto-session-name: without OpenCode Go, every session warned "auto-name gave up". The session's own model now names it when none of the default models has credentials; an explicit `PI_AUTO_NAME_MODEL` list never falls back; with no usable model it stays quiet.
- `defaults/boehsline.json` is a safe starting file: no opt-ins on (it enabled omlx, which needs a local server) and no stale `wiki-session-log` setting.

## 0.2.2 — 2026-10-16

### Added

- **todo**, a new default extension: a shared task list for you and other pi agents at `.pi/TODO.md` (a plain markdown checklist), with locked claims so two agents never own the same task. `todo` tool for agents, `/todo` for you, and one static line above the editor while tasks are open. Nothing is written until a task is added. Moved from an untracked folder in dotfiles, where it only loaded for that one project.
- footer: a Worktree chip after the directory, `⎇ eert` in a linked git worktree of `eert`, hidden in a main checkout. It reads the `.git` file and `commondir` (no git process), so submodules don't count and a bare repo's worktree names `repo` for `repo.git`. A chip added since `footer.json` was saved now lands after its default predecessor instead of last.
- footer: `~` for the home directory, and an optional `dirNames` map in `footer.json` that renames the directory chip per folder (`""` hides it). Rows in `/footer` that configure a chip are indented under it, and the list shows up to 22 rows.
- footer: a "Provider/Model/Thinking condition" under each of those chips; "unless default" hides the chip while it matches settings.json's `defaultProvider`, `defaultModel`, or the level the model starts on (its `modelThinkingLevels` entry, else `defaultThinkingLevel`).
- footer: a `mini` mode for the Rate limits chip, just `↑` speed up or `↓` slow down from the worst window's pace on a green or yellow/orange/red ladder, hidden on pace. Clicking cycles compact → detailed → mini. A "Usage condition" row hides the chip by pace in any mode (`unless on pace`, `when > 10 ahead`, `when > 20 ahead`); a limit always shows. `/footer` supports several setting rows per chip.
- footer: a "Usage pace" row under Rate limits. `on` adds each window's pace after its % (`↓8` ahead, `↑12` behind, nothing within ±5) in compact and detailed, and points to mini (`↓8`).
- footer: a "Rate condition" row under Token rate (`always`, `after 2s`, `5s`, `10s`, `30s`) shows the chip only for turns that run at least that long; a faster turn hides it.
- **CI checks the context budget.** `node scripts/bench.mjs --check docs/benchmarks.md` measures starting context offline (a stand-in model, nothing sent) and the `context-budget` job fails if it's more than 10% over the documented number. `scripts/bench.mjs` gains `--offline`, `--context-only`, `--check` and `PI_BIN`.
- `npm test` saves each run's output to `/tmp/test-runs/` (`TEST_RUNS_DIR` overrides), headed with the commit, dirty files and load average, keeping the newest 50, so an intermittent failure can be read afterwards. `npm test -- FILE` runs just those files.

### Changed

- aa-info: reads every page of Artificial Analysis's free `language/models/free` endpoint and nothing else. The legacy `/api/v2/data/llms/models` it read quality, speed and rates from retires on 2026-11-04. The old code read only page 1 of the cost endpoint, so $/task now covers every model AA has priced, not just the first 200 rows. `$/1M` is computed as AA's 3:1 blend; Kimi models count as Moonshot for the peer line.
- provider-usage: Copilot's per-workday allowance reads `4.3%/d`, without the `↓` that now means "slow down" in the footer.
- One `lib/tool-search.ts` helper for every extension with a deferred tool (agent-link and goal had their own copies), and `test/deferred-tools.test.mjs` checks every deferred tool in the manifest stays reachable with subagent turned off.
- The `todo` tool is declared in every session. If you also load another extension that registers a tool named `todo` (pi's `examples/extensions/todo.ts`, for one), drop one of them.

### Fixed

- aa-info: a failed refresh backs off instead of retrying on every model switch. It's recorded in the cache as `retryAt`, so every pi sharing the cache holds off for an hour (or a 429's `Retry-After`, if longer), and briefings keep coming from the stale snapshot rather than going blank.
- agent-link removes its `~/.claude/sessions/<pid>.json` on a hard exit too, not only on `session_shutdown`. Print-mode runs that `process.exit` (such as `scripts/bench.mjs`) leaked one file each, and a later process reusing the pid showed it as its session name; the footer now also ignores a registry file older than its process.
- footer: the git chip lost its dirty marker (and "unless clean default" stopped working) in repos where `git status` took over 1s, such as dotfiles with 4 submodules: the timeout blanked the state. A timeout or failed spawn now keeps the last state, the limit is 3s, and status runs with `--ignore-submodules=dirty` (1.6s → 0.5s in dotfiles).

## 0.2.1 — 2026-10-16

### Fixed

- scheduler: a task whose pi failed before reading its prompt was reported as "could not send the prompt" (the broken pipe) instead of pi's own error, depending on which landed first. pi's exit code and stderr now win; the broken-pipe error still catches a pi that exits 0 without its prompt. This also made two scheduler tests flaky in CI; a new test reproduces the race deterministically.

## 0.2.0 — 2026-10-16

### Breaking

- **Each extension is a folder.** `extensions/<name>.ts` moved to `extensions/<name>/index.ts`, and opt-ins to `extensions/opt-in/<name>/index.ts`. `web-providers/` and `web-fetch-resilient/` are now `web/providers/` and `web/fetch/`. pi lists extensions by folder name (`canvas`, not `canvas.ts`), so a settings filter like `-extensions/foo.ts` needs updating.
- **approval-guardian is opt-in.** It was on by default, a fail-closed gate nobody had set up. Turn it on with `/boehsline enable approval-guardian`.
- **start_goal, provider_usage and agent-link are deferred tools.** They aren't declared to the model until `tool_search` finds them (agent-link switches itself on for an `@name` or a message from another session). `/goal`, the footer chips and `@name` work as before.
- Only agent-link's `pi-agent-link` skill ships; `grok-bot-pi-link` drove a personal phone bridge.

### Added

- **`/boehsline` menu**, like `/footer`: toggle opt-in extensions (saved, with one reload, when it closes), apply the default keybindings, see which bundled packages loaded with their versions, and show the merged config. The subcommands still work, and without a UI it prints text.
- **`/boehsline defaults`** shows Boehsline's keybindings ([`defaults/keybindings.json`](defaults/keybindings.json)) as a diff against yours and merges them after you confirm. It moves pi's own Ctrl+S and Ctrl+R actions to Alt, so stash and prompt-history stop colliding with them. A startup hint names the conflict until it's resolved.
- **A README beside every extension**, with the detailed docs that used to live in dotfiles (VA specifics replaced by settings). The root README is an index of them, and `test/readmes.test.mjs` keeps it that way.
- **Benchmarks:** [`docs/benchmarks.md`](docs/benchmarks.md) and `scripts/bench.mjs` measure startup time and starting context against stock pi, overall or one extension at a time (`--each`).
- `canvas:put` event so other extensions can post canvas sections.
- footer and provider-usage: Copilot's allowance per workday (↓%/d) and a days-off row in `/footer`.

### Changed

- **Smaller starting context: +2,779 tokens over stock pi, down from +4,597.**
  - canvas: ~1,200 fewer tokens. Each kind was described twice (in the tool and in the "lightest kind" guideline); one line per kind now carries both, and `kind` is a plain string enum. No kind, field or rule dropped.
  - start_goal, provider_usage and agent-link deferred (~610 tokens). `lib/tool-search.ts` keeps `tool_search` on for any extension with a deferred tool.
- **Faster startup: +100ms over stock pi, down from +144ms.** `session_start` work across all extensions went from 83ms to 7ms:
  - agent-link binds its socket and probes peers in the background instead of before the prompt shows (~60ms with a dozen sessions open).
  - bg prunes old logs asynchronously, after boot.
  - tmux-attention stamps its pane a second after boot.
- `npm test` and CI also run the goal and scheduler package tests (190 more), plus new smoke tests for code-lint, image-preview, omlx, sc and update. 881 tests.

### Fixed

- `/boehsline enable` and `/boehsline defaults` write through a symlinked `boehsline.json` or `keybindings.json` instead of replacing the link.
- `boehsline.json` is found in `PI_CODING_AGENT_DIR`.
- bg's `bash` returns `structuredContent` for codemode scripts.
- bg's tests no longer leave temp directories behind.

## 0.1.0 — 2026-10-16

First release: Eric's pi extensions in one package. Core extensions (canvas, footer, compaction, web, bg, ask, next-steps and more), opt-ins gated by `boehsline.json` (watch, meeting, omlx, sc, tmux-attention, update, wiki-session-log), layered config with package-supplied settings, and pi-context, pi-scheduler, pi-agent-link, pi-approval-guardian and pi-goal bundled as git subtrees.
