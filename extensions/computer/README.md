# computer

*Opt-in:* `/boehsline enable computer`.

Drives this pi session's own Linux desktop's Chromium — the **Computer** [Botsun](../../extensions/opt-in/botsun-owner/README.md) shows on Eric's phone. **Tool:** `computer`.

The desk is one per pi session: `bin/botsun desk session --session <pi session id>` leases it in Botsun's workers VM (Xvnc + openbox + Chromium) and prints one JSON line naming a VNC socket (the phone's viewer) and a CDP socket. This tool talks CDP down the second one, so Eric can watch the same page on his phone while the agent clicks and types.

## Actions

| action | what it does |
|---|---|
| `open` | Lease (or reuse) the desk and print `display :N · ready`. Every other action does this first if nothing is open in this pi yet. |
| `navigate {url}` | Open an `http(s)` URL. Any other scheme (`file:`, `javascript:`, `data:` …) is refused before Chromium sees it. |
| `screenshot` | The active page as a PNG, as an image block (CDP `Page.captureScreenshot`). |
| `click {x, y, button?, clickCount?}` | A click at the page's CSS pixels. `button` is `left` (default), `right` (a context menu) or `middle`; `clickCount: 2` is a double-click, sent as Chrome expects (a pressed/released pair counting 1, then one counting 2). The release always carries `buttons: 0`. |
| `hover {x, y}` | Move the pointer there with no button held. |
| `drag {x, y, toX, toY, steps?}` | Press the left button at `x, y`, move in `steps` (default 12) interpolated moves, release at `toX, toY`. If anything fails midway a `mouseReleased` is still sent, so the button is never left down. |
| `scroll {x?, y?, deltaX?, deltaY?}` | Turn the wheel at `x, y` (default the viewport's centre) by `deltaX` / `deltaY` CSS pixels (`deltaY` default 600, positive scrolls down), then report the new offsets from one `Runtime.evaluate` that waits two animation frames first (smooth scrolling and momentum land late): the nearest scrollable ancestor of `document.elementFromPoint(x, y)` when the wheel hit an inner scroller (`scroller at scrollX …`), else the page (`page at scrollX …`). |
| `type {text}` | Insert text into the focused element (CDP `Input.insertText`). |
| `key {key}` | Any key or `+` combo: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, the arrows, `F1`–`F12`, a letter, a digit or punctuation; `Control+a`, `Control+Shift+t`, `Alt+ArrowLeft`, `Meta+l`, `Shift+Tab`. Modifier key downs, the key's down (`rawKeyDown` when it types nothing, e.g. a shortcut) and up, then the modifier ups in reverse, each event carrying CDP's `modifiers` mask (Alt 1, Control 2, Meta 4, Shift 8). An unknown name is one line naming a few valid examples. |
| `eval {expression}` | `Runtime.evaluate` with `returnByValue`: the value as JSON, capped at 8 KB. |
| `tabs` | The page targets (`id`, `title`, `url`) from `/json/list`. |
| `wait {selector, timeoutMs?}` | Poll `document.querySelector(selector)` every 100 ms until it matches, for SPAs; `timeoutMs` defaults to 5000 and is capped at 30000. |
| `upload {selector, path}` | Copy a file **on this Mac** into the desk with `botsun desk put --session <id> <path>` and hand the guest path to that `<input type=file>`. `path` expands a leading `~/` and is made absolute before the CLI sees it (so a name can never be read as a flag). The path is checked first (missing, a directory, not a regular file: one line, no CLI call) and so is the element (via `DOM.getDocument` → `DOM.querySelector` → `DOM.describeNode`, before the copy) — then `DOM.setFileInputFiles` on a second connection, by the **`backendNodeId`** `DOM.describeNode` gave (node ids are per CDP session and would not be valid there; a backend node id is stable across CDP sessions; if the page replaces the input while the file copies, the old one gets the file). |
| `release` | Stop the desk. Its Chromium profile is kept for the session. |

`upload` and `wait` see the **main frame only**: `DOM.getDocument` and `document.querySelector` don't reach a file input or an element inside an `<iframe>` or a shadow root, so a page that keeps its form in one is not drivable by those two actions.

Every action is a tool result. A failure — Botsun missing, the VM down, Chromium wedged, a bad argument — is one line, never a thrown error.

## How it works

- **CLI:** `execFile` with no shell, 120 s timeout; the last stdout line is the JSON. The session id comes from the extension context (`sessionOf(ctx)`); without one the tool answers in one line. `upload` uses the same runner for `botsun desk put --session <id> <path>`, whose one JSON line is `{"path":"<guest path>","bytes":N}`.
- **CDP:** HTTP `/json/list` and `/json/new?about:blank` (PUT) over the 0600 Unix socket with `http.request({socketPath})`; the page commands over a minimal RFC 6455 client in [`ws.ts`](ws.ts) (masked client frames, 7/16/64-bit lengths, fragmentation, ping→pong, close) on `net.connect(socketPath)`. No npm dependencies. If Chromium has no page, one is created. Each call is its own connection and times out in 30 s.
- **Socket check:** `cdp_socket` must be an absolute path under `$HOME` ending in `.cdp.sock`; anything else is refused rather than connected to.
- **Keep-alive:** while a desk is open here, `desk session --session …` is repeated every 90 s (an unref'd timer), so Botsun never takes it for idle (it stops desks after 30 min and evicts past 4). The timer stops on `release` and on session shutdown.
- **No Botsun, no tool:** without the Botsun checkout (or `$BOTSUN_BIN`) every action says so in one line.

## Needs

- macOS, Botsun checked out (or `$BOTSUN_BIN` / `botsun` on `PATH`). `upload` needs a Botsun whose `desk put` prints `{"path":"<guest path>","bytes":N}`.
- The `botsun-workers` VM up, with its desktop packages (`bin/botsun desk install`).
- Opted in: `/boehsline enable computer`. Off by default because it drives a real desktop the user is looking at, and it needs Botsun's VM.
