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
| `click {x, y}` | A left click at the page's CSS pixels (pressed then released). |
| `type {text}` | Insert text into the focused element (CDP `Input.insertText`). |
| `key {key}` | `Enter`, `Tab`, `Escape`, `Backspace` or an arrow (`ArrowUp` / `Up`, …), key down and up. |
| `eval {expression}` | `Runtime.evaluate` with `returnByValue`: the value as JSON, capped at 8 KB. |
| `tabs` | The page targets (`id`, `title`, `url`) from `/json/list`. |
| `release` | Stop the desk. Its Chromium profile is kept for the session. |

Every action is a tool result. A failure — Botsun missing, the VM down, Chromium wedged, a bad argument — is one line, never a thrown error.

## How it works

- **CLI:** `execFile` with no shell, 120 s timeout; the last stdout line is the JSON. The session id comes from the extension context (`sessionOf(ctx)`); without one the tool answers in one line.
- **CDP:** HTTP `/json/list` and `/json/new?about:blank` (PUT) over the 0600 Unix socket with `http.request({socketPath})`; the page commands over a minimal RFC 6455 client in [`ws.ts`](ws.ts) (masked client frames, 7/16/64-bit lengths, fragmentation, ping→pong, close) on `net.connect(socketPath)`. No npm dependencies. If Chromium has no page, one is created. Each call is its own connection and times out in 30 s.
- **Socket check:** `cdp_socket` must be an absolute path under `$HOME` ending in `.cdp.sock`; anything else is refused rather than connected to.
- **Keep-alive:** while a desk is open here, `desk session --session …` is repeated every 90 s (an unref'd timer), so Botsun never takes it for idle (it stops desks after 30 min and evicts past 4). The timer stops on `release` and on session shutdown.
- **No Botsun, no tool:** without the Botsun checkout (or `$BOTSUN_BIN`) every action says so in one line.

## Needs

- macOS, Botsun checked out (or `$BOTSUN_BIN` / `botsun` on `PATH`).
- The `botsun-workers` VM up, with its desktop packages (`bin/botsun desk install`).
- Opted in: `/boehsline enable computer`. Off by default because it drives a real desktop the user is looking at, and it needs Botsun's VM.
