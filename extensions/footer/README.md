# footer

A lean status line. **Commands:** `/footer` (choose and order chips; Alt+S
saves), `/boot` (startup timing), `/bypass` (the approval guardian's bypass).
Quota chips come from [provider-usage](../provider-usage/README.md); the
OpenRouter route from [openrouter-route](../openrouter-route/README.md).

Renders the status line (dir, provider, model, git, context/cost, provider
quota chips, boot time) plus `/bypass`, `/boot` and `/footer`.

`/footer` opens a checklist of the chips in footer order, each with its live
value; the selected row's description says what it shows and what a click
does. Enter or Space cycles the row's value: `shown`/`hidden`, or for chips
with display modes, each mode then `hidden` (Directory name/full path, Git
full/branch, Context tokens/percent, Cost and
Rate limits compact/detailed, Token rate number/with TTFT, Timers
count/detailed, Session name border/footer). A Git condition
row under Git can hide the branch on a clean default branch (origin/HEAD's,
else main or master) with nothing to push or pull. Git status is cached for
5s; after a `!` command it's re-checked every 0.5s for 10s, so `!git switch`
or `!git commit` shows within about a second. A Context
threshold row under Context hides that chip until the context passes 50k,
100k or 200k tokens, or 25%, 50% or 75% of the window. `j`/`k` move the
selection; `J`/`K` or Shift+↑/↓ move the chip itself (the session name and the
status row stay put). While the list is open the real footer is the preview:
the selected chip blinks underlined, the rest go faint gray, hidden chips show
struck through, and a chip with nothing to show right now stands in with an
example.

The session name (or, for an unnamed session, the dim peer name other agents
use) sits in the editor's top border by default, the way Claude Code frames
the prompt: `── my-session ────────`, in the border's own colour (the `/color`
tint when there is one; a peer name stays dim); pi's "↑ 3 more" moves to the right end, and a narrow pane
truncates the name. The Session name row's `footer` mode puts it back at the
right end of the footer. A click on the name prefills `/auto-name` (in the
border too, in fullscreen, where pi passes clicks to the editor).

While Approval Guardian is bypassed (`/bypass`), the Bypass row picks the
marker: `name` (the default) turns the session name red with `⚠` in front,
`chip` shows a red `bypass` chip, `both` does both. In `name` mode, when no
name is on screen (the name chip hidden, or nothing to show), the chip shows
instead: the footer replaces the guardian's own warning, so bypass stays
visible unless the row is `hidden`. Clicking the red name, like the chip,
turns the guardian back on.

The Placement row, first in `/footer`, can move the chips themselves into
that border, just after the name (`top border left`:
`── my-session ─ dotfiles main* opus ────`) or at its right end
(`top border right`: `── my-session ──── dotfiles main* opus ──`), or into
the editor's bottom border, leaving the name alone on top: at its start
(`bottom border left`: `── dotfiles main* ───── ↓ 3 more ──`) or
right-aligned before pi's "↓ N more" (`bottom border right`). A
`footer.json` saved before the split, with plain `top border` or
`bottom border`, means the right one.
Chips go up in footer order while they fit whole; the rest stay below, so a
narrow pane loses nothing, and with every chip up there is no footer row at
all. Extension statuses keep their own row below. In fullscreen the chips in
the border are clickable like the footer's. While `/footer` is open the
editor isn't drawn, so the preview shows every chip below.

Changes apply to the current session only, and a warning under the list says
so until Alt+S saves them to `footer.json` in the agent directory, defaults
left out:

```json
{ "hidden": ["boot"], "modes": { "context": "percent" }, "order": ["git", "dir", "..."] }
```

The directory chip shows the folder's name, or `~` at home. To rename or hide
it in particular folders, add `dirNames` to `footer.json` by hand (exact
directories, `~` allowed; an empty name hides the chip; the full-path mode
ignores it). `/footer` keeps it when it saves:

```json
{ "dirNames": { "~/Code/dotfiles": ".", "~/Documents/Notes": "" } }
```

To leave the model chip out on a provider's everyday model, name it under
`defaultModels`; with the Model condition at `unless default` those pairs
count as defaults too (the same id on another provider still shows):

```json
{ "defaultModels": { "opencode-go": "deepseek-v4.1-flash" } }
```

In a linked git worktree, the Worktree chip after it names the main repository
(`eert-feature ⎇ eert`); it's hidden in a main checkout. It reads the `.git`
file and `commondir` rather than running git, so a submodule doesn't count.
When the worktree's directory has the branch's name, the directory chip drops
out so the name shows once: `⎇ eert feature` rather than
`feature ⎇ eert feature`.

Settings that belong to a chip sit indented under it: Git condition, Context
threshold, Copilot OOO days, and a condition each for Provider, Model and
Thinking. Set those to "unless default" to hide the chip while it matches the
`defaultProvider` or `defaultModel` a new session starts on (or the
provider's `defaultModels` entry in `footer.json`), or the thinking level
this model starts on: its `modelThinkingLevels` entry, else
`defaultThinkingLevel`, else pi's `medium` (settings.json, a project's
`.pi/settings.json` first). Switching away shows it again.

Each provider's current flagship drops the model chip, so the provider letter
stands for it: `a` is Anthropic's Claude Opus 5.5, `gh` Copilot's Claude Opus
5.5, and `x` Grok 4.7. Other releases show their model as usual.

The Rate limits chip has three modes: `compact` (`61.4% 4.3%/d`), `detailed`
(`12.1/20.2W: 61.4% 4.3%/d`) and `mini`, just an arrow from pace: `↓` slow
down when any window is more than 5 points ahead (yellow, orange past 10, red
past 20 or at a limit), `↑` speed up when every window is more than 5 behind
(green, brighter past 10, bold past 20), and nothing on pace. Clicking cycles
the three. Its Usage condition hides the chip by pace in any mode: `unless on
pace` (within ±5), `when > 10 ahead`, `when > 20 ahead`. A limit or an
unreadable format always shows. Usage pace `on` adds each window's pace after its %:
`↓8` is 8 points ahead (slow down), `↑12` is 12 behind (speed up), nothing
within ±5, on the same colour ladders (`4%↑66h/22%↓8w`, `61.4%↓8 4.3%/d`);
mini then shows `↓8` instead of `↓`. When a provider has more than one window
the mark also names the window's span — `h` under a day (the 5h), `d` under a
week, `w` under a month (the weekly), `m` beyond — so `↓6w` is 6 points ahead
of the weekly window; single-window chips (Copilot, Grok, Cerebras) stay bare.
In mini the letter rides the bare arrow too (`↓w`), since there are no window
labels around it. Copilot's `4.3%/d` is the share left per
remaining workday, not pace.

The Token rate chip's Rate condition (`after 2s`, `5s`, `10s`, `30s`) shows it
only for slow turns: nothing until a request has run that long, then the
waiting counter, the live rate and its final rate. A faster turn hides it
again rather than leaving the slow turn's rate up.

The Timers chip shows the scheduler's `/once` and `/loop` timers for this
session: `◷ 2` (count), `◷ 2 timers · 1 paused` (detailed), or `◷ 1 paused`
when nothing is armed. Clicking it flips count/detailed for the session. It reads the scheduler's plain-text status and takes
it off the statuses row; hide the chip to hide timers altogether. A status
in any other shape stays on the row.

Reopening `/footer` keeps the session's unsaved changes; a new session starts
from the saved file. A saved mode is where each session starts; clicking a chip
still flips it, for that session only. Chips added later start shown, in their default mode, after
the ones the file orders. `/footer off` and `/footer on` switch the whole
footer for this session. Click zones are keyed by chip id, so hiding or moving
a chip never breaks the others' clicks.

`/footer minimal`, `/footer full` and `/footer saved` switch this session's
view, and so does the View row at the top of `/footer`. A view is never saved.
Minimal keeps dir, branch, provider/model, thinking, bypass, context, usage
(mini) and the session name, and only those the saved layout shows. Full shows
every chip in its most detailed mode, ignores the conditions and flagship
hiding, and shows the $ estimate even on subscriptions. Red ⚠ alarms (such
as Claude extra-usage billing) show in every view, even with the statuses row
hidden.

It also watches
pi's on-disk version: when an install lands while instances are running — via
`pi update`, `npm i -g`, anything — each running footer shows a green, right-aligned
"Update installed v0.52.1 → v0.53.0 · Restart to update" line above the prompt
within ~30s, like Claude Code.

If you keep a `~/bin/pi-bundle` (a script that prebuilds pi into one file for
faster launches), the same detection runs it in a detached background process,
since an update leaves the bundle stale. Concurrent pi instances serialize on a
lock directory; output lands in `~/.pi/agent/auto-bundle.log`. Without the
script this does nothing; `PI_NO_AUTO_BUNDLE=1` opts out.

## Boot timing

Every cold start is appended to `boot-times.jsonl` with the gap back to the
previous launch and the 1-minute load average, and `/boot stats` reports the
two cohorts separately. This is not decoration: relaunching pi a few times in a
row boots ~350ms faster than a one-off launch, purely from a warm page cache
and an idle machine. Measured on one machine, same commit, minutes apart:

| launch | gap since previous | boot |
| --- | --- | --- |
| one-off | 743s | 972ms |
| relaunch | 13s | 600ms |
| relaunch | 6s | 607ms |

That spread is wider than most changes worth measuring, so an undivided p50
mostly reports how you happened to be using pi that day — and a benchmark burst
sitting next to real launches reads as a regression that was never there.
Compare cohort to cohort.
