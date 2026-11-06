# auto-session-name

Names a fresh session after its first turn, unless you already named it. **Command:** `/auto-name` (regenerate now).

Names read like a character on the job: the thing being worked on, then one role noun, in Title Case with spaces and at most 30 characters. A chicken coop door that alerts every morning becomes **Chicken Door Alert Tamer**; a flaky CI test, **Flaky CI Wrangler**.

- `--name` and `/name` always win, and a resumed session is never renamed automatically.
- Names that look like agent-link's derived peer ids (`pi-myrepo`, `pi-myrepo-2`) count as unnamed, so they still get a real title.
- One cheap call to a fast model, trying a short list in order until one answers; a 402 or quota error just moves to the next. The default list is OpenCode Go's flash models (a flat subscription). Without OpenCode Go, the session's own model names it, so the conversation only goes to a provider the session already uses. With no usable model at all, it stays quiet.

| Variable | Effect |
|---|---|
| `PI_AUTO_NAME=0` | turns it off |
| `PI_AUTO_NAME_MODEL=provider/id[,provider/id…]` | the models to try, in order; an explicit list never falls back to the session's model |
