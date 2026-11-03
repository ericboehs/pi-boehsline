# update

*Opt-in:* `/boehsline enable update`.

`/update` for a pi that runs from a fork checkout (`~/.pi/agent/bin/pi` execs the checkout's `dist/`), which `pi update` can't touch. **Command:** `/update [check]`.

`/update` runs the fork's `scripts/sync-upstream.sh`: merge `upstream/main`, `npm ci` when the lockfile moved, build, test, and push `main` so other machines pull the same merge. A merge that conflicts or a build or test that fails stops there and leaves the tree to inspect. Once it merges, restart pi to run the new build. `/update check` fetches upstream and says how many commits the fork is behind, changing nothing.

It also replaces pi's startup "Update Available" banner, which compares against npm and only says `pi update`, with one that compares the running pi against `upstream/main`'s version and names `/update`. The check runs at most every 6 hours, shared across sessions through `update-check.json` in the agent directory. Banners are saved as UI-only entries (never sent to the model) and hide themselves once the running pi catches up.

```jsonc
// ~/.pi/agent/boehsline.json
{ "update": { "dir": "~/Code/github.com/ericboehs/pi", "args": ["--quick-tests", "--push"] } }
```

With no `dir`, the checkout is the one the running pi was started from. `args` go to `sync-upstream.sh` (`--quick-tests`, `--skip-tests`, `--push`; drop `--quick-tests` for the full suite). `PI_OFFLINE` turns the startup check off.
