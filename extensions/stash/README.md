# stash

Park a half-typed message with Ctrl+S, as in Claude Code, and get it back later. **Command:** `/stash`. **Key:** Ctrl+S.

- Ctrl+S with text pushes the draft onto a stack; Ctrl+S on an empty editor pops it back. The draft also returns after your next send.
- `/stash`, or a click on the stashed bar above the editor, opens the stack: `j`/`k` select, `J`/`K` reorder, Enter restores, `e` edits in `$EDITOR`, `d` drops, Esc closes.
- Safe mid-turn: it's local UI only and never steers or interrupts the run.
- Drafts live in memory (they survive `/reload`), never on disk and never in model context.
- The stacks live in `lib/stash-store.ts`, shared with [botsun-owner](../opt-in/botsun-owner/README.md): Eric's phone can stash a draft, take one back or drop one, and the stashed bar follows.

pi also binds Ctrl+S (save model or thinking level, sort sessions). Run `/boehsline defaults` to move pi's to Alt+S. Don't load `@nicknisi/pi-stash` alongside it; both bind Ctrl+S.
