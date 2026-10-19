# canvas

A live local web page for each session, where the agent posts tables, charts, diffs, checklists, timelines and findings beside the terminal. **Tool:** `canvas`. **Command:** `/canvas`.

Gives each pi session a live local web page for output
that is too wide or long for the terminal. One shared daemon
([`daemon.mjs`](daemon.mjs)) serves `http://127.0.0.1:8790`: an index of
sessions at `/`, and one page per session at `/s/<session-id>`. The page
updates through server-sent events with no reload. Each row of the index
shows the session's goal, its Now line and a one-line plain-text preview of
the agent's last response.

- **Status.** After each settled turn that ran tools, Claude Haiku 5.5 on
  Copilot rewrites the status block (goal, now, done, open, next) from a
  digest of that turn and the previous status. It is an in-process
  `modelRegistry.complete()` call, the same pattern as `auto-session-name.ts`.
  The main model does nothing, and a new turn aborts a run still in progress.
  Each run uses one Copilot premium request; tool-free short replies skip it.
  Between Now and the Next / Open / Done columns, **Last response** shows the
  agent's final message of the last turn, without its closing "Next steps"
  block, rendered, below the prompt it answered (clipped to two lines; a click
  shows it all). canvas.ts writes it to `reply.json` when a turn settles (no
  model involved), so a short turn updates it too. The heading folds it,
  remembered per browser. The reply's Next steps options show under it as
  buttons; a click sends that option to pi (see Talk-back). When they are
  there, the status's own Next column is left out, as it would repeat them.
- **Talk-back.** Under Last response, a message box writes to this
  session's pi (`i` focuses it, Esc leaves). Enter sends; while a turn runs
  Enter steers it and ⌥Enter queues the message for after, ⇧Enter is a new
  line. Next steps buttons, an `options` card's Pick and a kanban card's
  Send to pi send at once, with 3 s to undo, and queue behind a running
  turn; ⌥-click copies instead. On an ended session the box is disabled and
  the buttons copy. How it works:
  - The page posts `/s/<id>/send` (`X-Canvas: 1` and a matching Origin, like
    `/clip`). The daemon refuses sessions that aren't running and writes
    `inbox/<ms><seq>-<hex>.json` (mode 600, folder 700), at most 20 waiting.
    The counter keeps two writes in the same millisecond oldest first.
  - canvas.ts watches `inbox/` (with a 1 s poll as backup), removes each
    file before acting on it, and calls `pi.sendUserMessage`: a new turn
    when pi is idle, else `deliverAs` steer or followUp.
  - It records each message in `inbox-ack.json` (the last 10); the page
    turns "Sending…" into "Sent ✓: started a turn / steered / queued", and
    says so if pi hasn't picked a message up within 5 s.
  - A file queue, not a socket, so a message survives the daemon
    restarting (as it does after every code change).
  - Dialogs open in pi's terminal (an `ask`, a confirm) can't be answered
    from the page.
- **Review mode.** On `diff` and `code` sections, hovering a line number
  shows a +; a click opens a comment box under that line (drag down the
  gutter, or ⇧-click another line's + while the box is open, for a range;
  ⌘Enter adds it, Esc cancels). In a diff a comment sits on the new line,
  or the old one for a deletion; in split view on the side you clicked.
  Drafts show under their lines with Edit and Delete, and survive a reload
  and the Unified / Split switch (localStorage per session). Once there is
  one, a bar at the bottom gathers them: the count (a click jumps to the
  next), an optional summary, a verdict (Comment, Approve, Request
  changes), Discard (click twice) and **Send review**, which sends one
  message through talk-back: the verdict, the summary, then each comment
  under `path:lines` and its section, with up to 30 of its lines quoted.
  Sent comments stay on their lines, dashed and marked Sent, until their
  section is replaced. On an ended session Send becomes Copy review. The
  Files changed modal's diffs don't take comments.
- **Session info.** Click the session name in the header (or press `I`) for
  a read-only panel: model and thinking level, context use with a bar,
  prompts, replies and cost, repo status (branch, ahead/behind, staged,
  modified and untracked counts, last commit), UniiChat's live stats, and
  provider usage from `provider-usage.ts`'s shared cache (this session's
  provider first; entries over a week old left out). canvas.ts writes
  `info.json` after each reply and on a model, thinking level or compaction
  change; the daemon adds `git status` (with `GIT_OPTIONAL_LOCKS=0`, so it
  never takes the index lock) and the usage cache when the panel opens
  (`GET /api/s/<id>/info`). The panel redraws in place while it's open.
  UniiChat's stats come from `globalThis[Symbol.for("pi-uniichat")]`,
  which pi-uniichat publishes; the row shows only when it is loaded.
- **Sections.** The `canvas` tool adds or replaces a section by id: `markdown`
  (GFM, with ```` ```mermaid ```` fences), `html` (a page in a frame that fits
  its height), `html-plan` (a packed `/html-plan` file), `image`, `mermaid`,
  `chart`, `terminal`, `stats`, `table`, `compare`, `steps`, `pipeline`, `kanban`, `json`,
  `timeline`, `diff`, `code`, `tree`, `options`, `tracker`, `pdf`, `video`, and `finding`
  (one append-only line in the findings log).
  The tool's guidelines tell the agent to pick the lightest kind that fits:
  markdown for short tables, table for data, stats for headline numbers,
  chart for numbers over time, mermaid for flows, html only for
  something to interact with. `html` sections get the **design kit**
  (`canvas/kit.css`, put in by the daemon): the page's colours as CSS
  variables in light and dark, styled buttons, inputs, sliders and tables,
  and `k-` classes for rows, grids, cards, stats, fields, tags and bars, so an
  agent-made calculator matches the page with almost no CSS. A page opts out
  with `<meta name="canvas-kit" content="off">`. A `chart` is a small JSON
  spec (`bar` grouped, stacked or horizontal, `line`, `area`, `scatter`,
  `pie`, `donut`; labels, series, axis label, unit and prefix), checked by
  the tool and drawn by the page as SVG in the page's colours, with legends
  and hover values. A `terminal` is command output (raw, or JSON with the
  command, exit code, duration and cwd): ANSI colours (16, 256 and true
  colour) mapped to theme-aware variables, `\r` redraws applied, error,
  warning and pass lines tinted when the output has no colour of its own, the
  middle of long output folded, and a filter box that marks matches. `stats`
  is a row of number cards with an optional change (green or red by which
  way is good) and a sparkline. A `table` is JSON rows (arrays or objects) or
  a `.csv`/`.tsv` path: click a header to sort (numbers high-first, empties
  last, a third click turns it off), type to filter, sticky headers, numbers
  right-aligned, and typed cells (`bar`, `spark`, `tag` coloured by word,
  `link`, `code`); types are inferred when left out, and 500 rows are drawn
  at a time. `compare` takes two image `paths` (copied in and removed with
  the section) and shows them with a draggable before/after slider (arrow
  keys too), side by side, or as an onion skin with an opacity slider.
  `steps` is a checklist (done, active, todo, failed, skipped, blocked, each
  with an optional note and detail) under a progress bar that leaves skipped
  steps out; the agent replaces the same id as work moves. `pipeline` is a live
  metro map of a multi-stage, multi-agent workflow: stages left to right, each
  one node (a bar at the ends, a pill between), a row of steps, or parallel
  lanes (lanes in a row with the same label share a box, like a package of
  work), with an optional `loop` arc such as "revise". Steps are todo, active,
  done, back (sent back), failed or skipped, with an optional note and badge
  ("9/10"); lines turn blue where work has reached, and the active node pulses.
  A numbered chip per stage runs along the bottom and highlights its stage.
  A map too wide for its card (past 15% smaller) wraps into rows that snake:
  the second row runs right to left, joined by a U-turn at the edge, and so
  on. Rows break between stages; a stage too wide for a row on its own spreads
  over rows in even chunks of steps (one with lanes or a loop stays whole and
  scrolls). Each row is as tall as what it holds, step labels take up to two
  lines, and the map lays out again as the card changes width.
  Under 700px the map and legend drop out, leaving the current step and the
  chips; a tapped chip spells out its stage in one line ("Build: Package 1 ›
  Implementer ✓ · critic ↩").
  While the newest pipeline still runs, the side panel carries a compact copy:
  the current step ("Build › Package 2 › critic: sent back") and the chips,
  which jump to the section. Its × hides that pipeline from the panel (per
  browser, kept across reloads) until the agent updates it again, and one
  nobody updated for 30 minutes leaves by itself. A `kanban` is a board of work items by state:
  up to 8 columns left to right, each with a tone, an optional WIP `limit`
  (the count reads `3/2` in amber past it) and `more` ("+6 more" for cards
  left out); a card has a title and an optional `#id`, note, tag, owner,
  tone (a stripe down its left edge) and `href` (http or https; the title
  becomes the link). Titles and notes take `` `code` ``, **bold** and
  `[links](https://...)`, built as DOM so nothing becomes markup; long titles
  clamp at four lines. `progress: true` adds a bar of counts per column
  ("2 open · 1 claimed · 10 done"), and a `compact` column has one-line,
  dim cards and folds when nothing else is on the board (a click opens it,
  remembered for the tab). Empty columns shrink to a thin strip with the
  label running down. In a narrow card (the side panel, a
  phone) the columns stack, by a container query, so one board fits both.
  An owner like `pi-a1b2` (the todo tool's name for a session) shows that
  session's name and state dot (working, your turn, or a hollow ring once
  it has ended) and links to its canvas, or reads "this session"; the dots
  follow the session list as states change. Cards that are **new or moved**
  since this browser last saw the board get a `new` or `→ Done` badge,
  kept for 15 minutes after they were first seen (a board that changed in a
  background tab keeps its marks until you look). A click on a card (or
  Enter on a focused one) opens its **details** over the page: the full
  title and note, tag, owner and link, and a prompt to paste into pi with
  a Copy prompt button (and Send to pi, see Talk-back); ← / → step through the board's cards. On the Tasks
  board the prompt is the todo's next move for its column ("Claim todo #5
  (...) and start on it.", "Help unblock todo #6 (...): it's blocked on
  ..."); on any other board it hands over the card with the board and
  column. The daemon never writes to the project, so the page can't move
  cards; the prompt is how a card becomes work. `json` shows any
  JSON (body or a `.json` path, stored as written) as a tree built as nodes
  open: two levels open to start, a filter that keeps and opens the paths to
  matching keys and values, Expand all and Collapse, 200 children at a time,
  and a click on a key copies its jq-style path (`.shop["created-at"]`). It
  is stored as `.jsonv`, since a section called `meta` or `sections` would
  otherwise overwrite the page's own files. A `timeline` lists events down a
  line with a coloured dot per tone and an optional tag; when every event
  has a real time they are sorted, grouped under day headings and marked with
  the gap since the one before (`+1h 32m`), and text times (`T+5m`) are
  shown as written in the given order. A `diff`
  takes a unified patch in `body` or `path`, or `ref` (default `HEAD`; a
  commit, a `a..b` range, or `staged`), `paths` and `repo`, and the extension
  runs `git diff` itself. Untracked files named in `paths` show as new, and
  secret-looking files are left out and named in the result. The page shows
  a file list with +/− counts, then one collapsible block per file:
  unified or split (the toggle is remembered per browser), coloured by
  extension, with the changed words marked in paired −/+ lines, and Expand
  opens it in the modal. A `code` section shows lines of a source file: the
  tool reads `path` when posted (the copy stays put when the file changes;
  secret-looking files are refused) and the body picks `lines` (`"40-80"`, at
  most 2,000), `highlight` ranges (a tinted band) and `notes`, each a callout
  under the last line of its range with a tone stripe that runs down those
  lines, and text that takes `` `code` ``, **bold** and links. Line numbers,
  the path and "lines 40–80 of 312" head it; highlight.js colours the whole
  range at once and the result is split back into rows, so a comment that
  spans lines stays coloured. Its copy button copies the code itself (⇧ for a
  Slack ``` block). A `tree` is a file tree from flat paths
  (`{"src/a.ts": "added"}`, a note, or `{tag, note}`; a trailing `/` names a
  folder): folders first, natural order, a chain of lone folders merged
  (`src/lib/util/`), tags colouring the name (added green, changed amber,
  deleted struck through red, renamed/moved purple), and folders that fold
  (remembered per browser; trees over 150 entries start with only the top
  level open) and show "3 changed · 1 added" while folded. It copies as
  `tree`-command text. `options` puts 2–6 choices side by side as cards
  (A, B, C): a summary, ✓ pros, ✗ cons, a cost, 0–5 score bars per
  criterion, and at most one Recommended card, outlined. Each card's **Pick**
  sends pi a prompt that picks it (its `pick` text, or "Go with option B:
  ..."), or copies it on ⌥-click or once the session has ended; the section copies as markdown. `pdf` and `video` (mp4, m4v, webm,
  mov) copy a file in by `path` (up to 50 and 200 MB) and show it in the
  browser's own PDF viewer or a `<video>` player with controls, opened on
  its first frame. The daemon streams both from disk and answers byte
  ranges (206), which Safari needs to play video. `/html-plan` now puts
  its packed page here instead of opening Safari. The tool's guidelines tell
  the main agent to use it without being asked: a finding for each confirmed
  root cause, gotcha or decision, a section for tables, diagrams and
  command lists, plans as a `steps` checklist, work run through other agents
  (subagents, agent-link handoffs, pstack) as a `pipeline` kept current as
  each one starts, finishes or sends work back (independent items that move
  at once, like several PRs, as parallel lanes of one stage rather than
  stages in a row), and a file `path` instead of
  an inline body over ~2 KB so the data stays out of its context. The status
  digest names each canvas post by kind and id, and lists the page's
  sections with their kinds so Haiku doesn't restate one in another form.
- **Auto content.** The same Haiku call may add up to two findings and one
  `auto-*` section per turn. Findings are tagged `auto` and deduplicated.
  Haiku's section is skipped when the agent wrote one that turn, and only the
  newest six are kept. After every turn the page also updates a **Files
  changed** table (paths and edit counts from tool calls, with the last change
  as "4m ago" within 18 h; the newest five
  show, the rest behind "Show N more", which stays open across updates) and a
  **Screenshots** gallery of the last 12 images the agent `read`, copied into
  the session folder (the newest four show, the rest behind "Show N more";
  captions use the same relative times). On startup and `/reload` these cards
  and Agents are redrawn at once, so new markup shows without waiting a turn.
  When the project has a `.pi/TODO.md` (the todo tool's shared checklist)
  with a task in it, a **Tasks** card at the top of the side panel shows it
  as a kanban with a progress bar: Open, Claimed (with the owner, linked to
  its session), Blocked (with the reason) and Done (compact, the newest
  five, folded when nothing is open; dropped ones are only
  counted). It is built on startup and after each turn, and a watch on
  `.pi/` redraws it within a second when another session claims or finishes
  a task. The extension parses the file itself; it doesn't need the todo tool.
  When this session has used agent-link, an **Agents**
  card lists each agent it sent to or heard from, newest exchange first: a
  live dot (working, idle, or a hollow ring once it has exited; the page asks
  the daemon every 4 s while the tab is visible, and `GET /api/peers` reads
  agent-link's registry in `~/.claude/sessions` and returns live names and
  statuses only), ↑ sent / ↓ received counts
  and the last message's first line. Agents that have exited wait behind
  "Show N inactive" (refolded as the dots change; an open row stays). Times
  within the last 18 h read "4m ago" and stay current; older ones show the
  date and time. A click opens the agent full screen: its last 30 messages
  (newest first, each in full) and its folder, with a link to its canvas
  page if it has one; ← / → step through the agents. It's
  rebuilt from the session's own history (sends, asks and their answers,
  replies, and agent-link's headers on incoming messages) after each turn,
  when a message arrives, and on startup, so nothing in agent-link changes.
  A `bash` command still running after 5 s gets a **Running** card (a
  terminal section, `auto-running`): the command, a ticking elapsed time and
  the newest 40 of its last 200 lines, rewritten at most once a second from
  pi's `tool_execution_update` events. When it ends the card becomes **Last
  long command** with the exit code and duration, until the next long command
  replaces it; one cut off by a dying pi is marked interrupted on the next
  start. Commands likely to print secrets (`op read`, `security
  find-generic-password`, `printenv`, `env`, `gh auth token` and the like)
  never stream. Haiku neither trims nor sees the Running card.
  While a background job runs (the `bg.ts` extension: a `bash` call sent to
  the background or adopted after its budget), a **Background jobs** card
  (`auto-jobs`) sits at the top of the side panel, above Tasks. Each job is
  a row: a pulsing dot, its name, a ticking elapsed time and the command.
  A click (or Enter) opens the job full screen: the whole command, when it
  started and ended, its newest 200 log lines (colours dropped, a redrawn
  progress line kept at its last state) and **Copy log path**; ← / → step
  through the jobs. The modal follows the log while the card is rewritten
  (every 2 s while a job runs, only when something changed, with no flash on
  the card), staying at the bottom unless you scrolled up. A finished job stays, with ✓ or ✗ and its exit
  code or signal and duration, for 10 minutes; when no job is left the card
  goes. The extension learns about jobs from `bg.ts`'s `bg:jobs` events and
  asks with `bg:list` on startup, so neither imports the other. Commands
  likely to print secrets show no output, as with Running. Haiku neither
  trims nor sees this card.
  While `/watch` runs, in this session or another, a **Watching** card
  (`auto-watch`) sits at the top of every session's side panel, above
  Background jobs: the watcher
  is one per Mac, so it is not a section of one session. The status line
  (how many need you, offers, waits, snoozed, a meeting, when it last read,
  errors), then each "needs you" row: its #, icon, sender, where, the
  scout's why, age, `×3` for a burst, up to three lines of the message
  text (clipped to 280 characters, codes and `work.redact` patterns masked as in the ledger)
  and any offer. Each row copies `/watch do N` and opens the message in
  Slack; below come offers with no row, **Waiting on** (a maybe-answered
  wait copies `/watch waits close Wn`) and the last hour's **Cleared**; a
  click on either heading folds it, remembered per browser (Cleared starts
  folded).
  The watching session's canvas writes the snapshot to
  `~/.pi/canvas/.watch.json` (mode 600, only when it changed; removed when
  the watcher stops or pi exits) and the daemon adds it to every page's
  state while that pi lives; a change refreshes every open page. The card
  flashes only when a new item arrives. Haiku neither trims nor sees it.
  `PI_CANVAS_AUTO=0` turns all of this off.
- **Diffs and lightbox.** Before the agent's first `edit` or `write` to a file,
  the extension copies what the file held (`base-<id>`, never served). After
  each turn, `git diff --no-index` writes `diff-<id>.patch`, the change since
  then, and `cur-<id>.txt` copies the file as it is now (same skips). Files
  changed shows +/− counts, and clicking a path opens it in the modal with
  Diff and File tabs; markdown files get Diff, Preview (rendered, frontmatter
  as a code block) and Source. The tab you pick holds as you step through files.
  Clicking a screenshot opens it large. Both use one modal: ←/→ step through the card's items, Esc closes, and ↗
  (or a ⌘-click) opens the raw file. **Clippy** (the paperclip on each section, and in the
  modal) puts the file itself on the clipboard via `clippy <file>`, to paste
  into Slack, Mail or Finder: a changed file's real path, a diff as
  `<name>.patch`, else the section's file. It is the daemon's one write
  route (`POST /s/<id>/clip`), refused without the page's header or from
  another origin. Code blocks with a named language
  are syntax-highlighted (highlight.js, loaded on first use; no guessing, up to
  16 KB a block, output cut down to `<span class>`). No diff is kept for binary files,
  files over 1 MB, or secret-looking names (`.env`, `*.pem`, `~/.ssh/…`,
  `*token*`); their row says why. Changes made through `bash` aren't tracked.
- **Layout.** Status and Findings stay on top, and findings read newest first.
  Sections follow, newest change first. **Pinned** sections sit between Status
  and Findings, in the order they were pinned: the pin in a card's header,
  `p` on the current section, or Pin in Cmd-K. Pins are per browser and per
  session (localStorage, dropped after 60 days unused, shared by the page's
  tabs), a pinned Tasks or Files changed card leaves the side panel for the
  top of the page, and Contents lists pins first with a pin glyph.
  The side panel (Contents and the automatic cards) can be **reordered**: drag
  a card by its header (a line shows where it lands), or `K` / `J` (Shift-k,
  Shift-j) on the current side card, or Move up / down in Cmd-K. The order is
  one for every session, per browser (localStorage, shared across tabs); a card
  added later slots in at its default place, and Cmd-K's **Reset side panel
  order** puts Contents back on top.
  A section's header is the title and its pin (filled when pinned, shown on
  hover otherwise), then the age and three quiet icons: copy source, Clippy
  and open in a new tab. ⌥-click on any copy button (the source, a code
  block, a finding, a prompt) copies the text as a markdown blockquote, `> `
  on every line. ⇧-click copies it as Slack markup for the composer
  (`**b**` → `*b*`, `*i*` → `_i_`, `~~s~~` → `~s~`, a heading → a bold
  line, `-` items → `•`, a table → an aligned code block; links, code and
  quotes stay), and a code block or command output in a ``` block; ⇧⌥-click
  does the same, quoted. Drafts (a Slack post, an email, a PR comment) are written
  as blockquotes, not code fences, so they wrap and read in full colour; the
  tool's guidance says so. Each top-level quote has its own copy icon (on
  hover): it copies the quote's markdown without the `>` markers (a nested
  quote keeps its own), so the header copies the whole section and the quote
  just the draft. The age has a tooltip, on hover or for 5 s after a
  tap (touch has no hover): the kind, "kept up to date by the canvas" for the
  extension's own sections (Tasks, Agents, Files changed, Screenshots), the
  exact time, and the last-turn note. Status's age tells which model wrote
  it; Findings' age is the newest finding's, and its tooltip counts the ones
  new this turn. Copy all is a copy icon there too.
  Click a card's header to collapse it.
  Each browser remembers that choice per session, and Collapse all / Expand all
  sit in the page header. A section nobody has opened or collapsed starts
  collapsed once its last change is over an hour old. A collapsed section isn't
  rendered until it's opened, and it shows a dot when it changes while
  collapsed. On a window 1200px or wider, a sticky sidebar holds Contents (every
  section with its age; a click opens and scrolls to it; past six, older
  collapsed sections wait behind "Show N older"), Agents, Files changed and
  Screenshots. A `tracker` section sits just above Contents: one card, a number,
  a title, a state, a note and a link. The section title names the tracker.
  Canvas does not know which tracker it is. Narrower, those widgets sit among
  the sections in time order.
- **Last turn.** Sections, findings and side cards written since the current
  (or last) turn began get an accent bar down the left edge, and the age's
  tooltip says when that turn ran ("Changed in the last turn (7:10–7:24
  PM)"). Contents bolds those entries and adds an **All N | Last
  turn M** toggle that lists only them. canvas.ts writes `turn.json`
  (`started`, then `ended`) at agent_start and agent_settled, so the marks
  survive a refresh and agree across tabs, and clear when the next turn starts.
  Auto cards count only when their content changed. Colours come from
  `--accent` and `--tint`, so they follow the theme.
- **Follow tmux.** A per-tab mode (the **Follow tmux** button in the header,
  shown once a live session runs in tmux, or Cmd-K) that keeps the page and
  tmux on the same pi session. Move to a pi pane in tmux and the tab opens
  its page. Open a session in the tab (Cmd-K, a waiting chip) and tmux
  switches to its pane, across tmux sessions if needed, on the client you
  used last. Panes that aren't running pi leave the page alone, and a reload
  doesn't move tmux. How it works:
  - canvas.ts records `$TMUX_PANE` and the server socket in `meta.json`. The
    page only gets a `tmux: true` flag.
  - Hooks in `.tmux.conf` (`session-window-changed`, `client-session-changed`,
    `after-select-pane`) run `~/.tmux/canvas-follow.sh`. It posts the pane
    to the daemon's `/follow`, which sends a `follow` event to open pages.
  - A follow-mode page posts `/s/<id>/focus`. The daemon then runs `tmux
    switch-client`, `select-window` and `select-pane`, and does nothing if
    that pane is already current.
  - Both POSTs need an `X-Canvas: 1` header and a matching Origin, like
    `/clip`.
  - The mode is saved in `sessionStorage`, so each tab chooses for itself.
    `PI_CANVAS_TMUX=0` turns it off everywhere: the daemon refuses both
    routes and pi stops recording panes.
- **Waiting on you.** The header row has a chip for each other
  live session that is blocked, done or failed and changed since you last had
  its page in view. Most urgent comes first, and a click opens it. The chips
  share the title's line and never wrap, so they can't push the page around;
  ones that don't fit fold into "+N", which opens Cmd-K. "Seen" times
  are kept in `localStorage` (`canvas:seen`), so every canvas tab agrees. On
  the first run every session counts as seen.
- **Cmd-K** (or Ctrl-K, or the ⌘K button) opens a picker matched on titles.
  It lists waiting sessions first, then the other live ones, then recent ones,
  followed by actions: fold or open all, copy the page link, the sessions
  index, Change theme… and Keyboard shortcuts. ↵ opens in the same tab and
  ⌘↵ in a new one; Ctrl-j / Ctrl-k move as well as the arrows. A session page
  uses only the global event stream, so a tab holds one of the browser's six
  connections per host.
- **Vim keys.** `j` / `k` move a highlighted current section and focus it, so
  Tab carries on from its first control (`esc` clears it; once it scrolls
  away, the section at the top of the window stands in). `l` moves right to
  the side panel and `h` back left, and `j` / `k` stay in the column you're in. `l`
  lands on the current section's entry in Contents; there `j` / `k` step
  through the entries (then on to Agents, Files changed and Screenshots), and Enter or
  `h` opens the highlighted section and moves the ring to it.
  `gg` / `G` top and bottom, `gr` the agent's last response (Status opens and
  scrolls to it), `d` / `u` or Ctrl-d / Ctrl-u half a page, `n` /
  `N` the next or previous section with the changed-while-folded dot or the
  last-turn mark. Enter, `o`
  or `za` folds or opens the current section, `zo` / `zc` open or fold it, `zR` /
  `zM` open or fold every section. `yy` copies the section's file through
  Clippy and `yc` its source as text (`yC` as Slack markup, like ⇧-click; the page link is in Cmd-K), `p` pins or
  unpins it. `?` lists them all; the
  list and the handler share one table (`VIM_KEYS` in `canvas/nav.mjs`).
- **Themes.** All of Omarchy's first-party themes are bundled
  (`canvas/themes.json`, MIT; `node canvas/build-themes.mjs [sha]` rebuilds
  it). You pick one for when macOS is dark and one for light, or keep the
  Canvas default, and every canvas page uses the pair. The picker previews
  each theme as you move through it. `canvas/theme.mjs` maps a palette onto
  the page's variables using the mixes from Omarchy's `pi.json` template, and
  the terminal colours follow its alacritty template. Mermaid, charts and the
  terminal follow the theme, and `html` frames get it by `postMessage`.
  `theme-boot.js` applies the cached palette before the first paint.
- **Omarchy (system).** On an Omarchy machine the theme picker also offers
  Omarchy (system): the canvas then uses whatever theme Omarchy has applied,
  custom and installed themes included, and changes with it live. The daemon
  reads `~/.local/state/omarchy/current/theme/colors.toml` (same format as
  the bundle; `PI_CANVAS_OMARCHY` points elsewhere), watches `current/` (its
  theme folder is replaced on each switch), and sends open pages a
  `system-theme` event. No Omarchy hook is needed, and picking any named theme
  stops following. It reads the machine pi runs on, so a canvas on a laptop
  can't follow a separate Omarchy box. `PI_CANVAS_THEME=system` makes Omarchy
  (system) the default for any browser that hasn't picked a theme yet, so a
  new profile or a dotfiles setup follows it without the picker. A theme
  picked on the page still wins. The daemon reads it when it starts; a pi
  with a different value restarts the daemon on its next canvas write.
- **Opening it.** Safari never opens by itself. `/canvas` opens this session's
  page on display 1, left half, or focuses the tab if it is already open.
  `/canvas url` prints the address, `/canvas status` forces a status run, and
  `/canvas off` / `on` pauses status runs for this process.

Files live in `~/.pi/canvas/<session-id>/` (`meta.json`, `status.json`,
`sections.json`, section bodies, `findings.md`). A session gets a folder only
on its first status or section. The daemon deletes folders idle for 30 days
whose pi process is gone (`PI_CANVAS_RETAIN_DAYS`).

The daemon is spawned detached on `session_start` when none answers
`/health`. Its version is a hash of `daemon.mjs` and `page.mjs` on disk, so
after an edit the next pi to start replaces it. Logs go to
`~/.pi/canvas/.daemon.log`. Browser libraries (marked, DOMPurify, highlight.js, mermaid) are
fetched once from jsdelivr, checked against the sha256 pins in `daemon.mjs`,
and cached in `~/.pi/canvas/.vendor`; mermaid alone is 5.5 MB, too heavy to
commit here.

Loopback only. The daemon answers only 127.0.0.1 with a loopback `Host`
header, which stops DNS rebinding. It serves reads plus a few writes, each
needing the page's own header and origin: Clippy's `POST /s/<id>/clip`,
which only copies that session's files, tmux follow's `/follow` and
`/focus`, and talk-back's `/s/<id>/send`, which only queues a message for a
running session. Anything that can make those requests can type into your
pi, so the same trust as the terminal applies. `html` and `html-plan` sections
run in an opaque-origin frame (no `allow-same-origin`): they can't touch the
page or call the daemon. Anything served that can run script (html, svg, xml)
also carries a CSP `sandbox`, so it stays opaque-origin even when a section
opens it in a popup. Both have a CSP with `connect-src 'none'`. A small script
the daemon adds to `html` reports its height and stands in an in-memory
`localStorage`. For `html-plan` it stands in a `localStorage` that the page
keeps per section, so a plan's answers survive a reload. Other local processes are trusted. The page can hold
anything the session saw; it is not a redaction layer.

`PI_CANVAS=0` disables everything, `PI_CANVAS_STATUS=0` keeps the tool without
status runs, `PI_CANVAS_TMUX=0` turns off tmux follow mode,
`PI_CANVAS_THEME=system` follows Omarchy until a theme is picked, and
`PI_CANVAS_MODEL=provider/id` changes the status model.
Subagent children skip the canvas.

```sh
node --test test/canvas.test.mjs test/canvas-nav.test.mjs
```
