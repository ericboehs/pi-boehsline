# pr-tracker

A [canvas](../canvas/README.md) tracker card for the GitHub PR on the current branch. It shows the number, a colored state, the title linked to the PR, and a note with the checks, review and merge status. **Command:** `/pr-tracker` refreshes it now.

- It reads `gh pr view` when the session starts, after every run, and once a minute while the PR is open.
- State: `merged` and `closed` once the PR is done. While open: `draft`, then `failed` (a check failed), then `review` (review required or changes requested), otherwise `open`.
- The note reads like `8/8 checks passed · approved · ready to merge`.
- Without `gh`, outside a git repo, or on a branch with no PR it posts nothing. A card it posted earlier is removed, for example after you switch back to `main`.
- An unchanged card isn't posted again, so polling doesn't mark it as changed. Polling stops once the PR is merged or closed, and gh is asked again only when the branch changes or a run ends.

The card is section `github-pr`, titled "GitHub". On a wide canvas it sits just above Contents.
