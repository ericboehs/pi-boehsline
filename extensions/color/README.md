# color

Tints this session's editor border, like Claude Code's `/color`. **Command:** `/color`.

`/color`, Claude Code's trick for telling four
identical panes apart:

```text
/color              # picker
/color blue         # red orange yellow green cyan blue purple pink gray
/color #ff0088      # any hex, long or short (#f08)
/color 204          # xterm palette index; bare digits beat hex shorthand
/color auto         # derived from the session name, stable across /reload
/color list         # the palette, swatched
/color off          # back to the theme
```

It recolors the editor border only, by cloning the live theme with the seven
thinking-level tokens overwritten — nothing else in pi reads those, so the
transcript, tools and syntax colors stay exactly as the theme author wrote
them. `bashMode` is left alone, so `!` still flips the border to its own color.
The footer paints the session name in the same color, but only a name you set
with `/name`: a name agent-link derived for the peer registry stays dim,
since it says "nobody named this" and a bright color would claim otherwise.
Like Claude's, the choice is not persisted: it lives in the process (through
`/reload`, via a `globalThis` stash) and dies with it.

Other extensions drive it over `pi.events`, with no import either way:
`color:set` `{spec, at, from?}` applies a color (null is off) and marks the
request `handled` synchronously, `color:state` `{spec, at, source}` is
announced on every change, and `color:query` `{reply}` answers with the
current `{spec, at}`. [botsun-owner](../opt-in/botsun-owner/README.md) uses
them to keep `/color` and the session's color on Botsun's phone the same.

Two side effects of handing pi a theme instance instead of a name, both
cleared by `/color off`: the theme file watcher stops, so editing the active
custom theme's JSON no longer hot-reloads, and `light/dark` auto-switching
stops following the terminal. Picking a theme in `/settings` drops the tint;
the next `/color` re-tints from whatever is current.
