# Runbooks

How a change gets merged and rolled out. Agents read this when they need it; their session summaries keep only
a pointer here.

## Merging a branch

1. Work on a branch in its own worktree. Leave uncommitted files in the main checkout alone.
2. Commit on the branch with a CHANGELOG entry under `## Unreleased` / `### Added` (or `### Changed`,
   `### Fixed`). Conventional commit messages; never `--no-verify`.
3. `git rebase main`, then:
   - `npm run -s typecheck` (if it rewrote `package-lock.json`, `git checkout package-lock.json`);
   - `node scripts/test.mjs`.
4. In main: `git merge --ff-only <branch>`, push to every remote, remove the worktree and branch.

## Rolling it out to running sessions

pi loads extensions at startup, so restart the other pi sessions after a merge:

```sh
for p in $(pi-restart-all --dry-run | grep -oE '%[0-9]+' | grep -vx "$TMUX_PANE"); do
  pi-restart-all --only "$p"
done
```

Exclude the pane you are running in. A restarted session resumes its session file and, if the approval
guardian was bypassed, types `/approval-guardian bypass` back in.
