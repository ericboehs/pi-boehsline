# auto-bundle

*Opt-in:* `/boehsline enable auto-bundle`.

If you keep a `~/bin/pi-bundle` (a script that prebuilds pi into one file for faster launches), this runs it in a detached background process whenever pi updates, since an update leaves the bundle stale and every launch ~115ms slower until it's rebuilt. It also re-runs it when the bundle is older than pi's `package.json` without a version change (an update that finished after the last rebuild started).

It rides on the [footer](../../footer/README.md)'s update check: the footer reads pi's on-disk version every 30s and announces each check on `pi.events` (`boehsline:pi-version`), so this adds no extra `mise which pi` spawns. With the footer off, nothing triggers it.

Runs once per detected version. Concurrent pi instances serialize on a lock directory (`pi-bundle.lock`, stolen after 10 minutes); output lands in `~/.pi/agent/auto-bundle.log`. Skipped for a pi that ships its own `dist/bundle/cli.js` (pi 0.85+, a built fork). Without the script this does nothing; `PI_NO_AUTO_BUNDLE=1` turns it off for one process.
