# Working notes for Claude

- After committing and pushing a change to the working branch, merge it into
  `main` and push `main` too (fast-forward when possible) without asking
  first. The user explicitly asked for this to be standing behavior. GitHub
  Pages deploys from `main`, so a change isn't live on voxprints.com until
  it's merged there.
- Still use judgment: if a merge isn't a clean fast-forward (main has
  diverged, real conflicts), stop and check with the user rather than
  resolving it silently.
