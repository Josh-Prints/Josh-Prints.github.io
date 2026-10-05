# Working notes for Claude

- After committing and pushing a change to the working branch, merge it into
  `main` and push `main` too (fast-forward when possible) without asking
  first. The user explicitly asked for this to be standing behavior. GitHub
  Pages deploys from `main`, so a change isn't live on voxprints.com until
  it's merged there.
- Still use judgment: if a merge isn't a clean fast-forward (main has
  diverged, real conflicts), stop and check with the user rather than
  resolving it silently.
- See `THEME.md` for the site's color palette, typography, and component
  conventions — match it when building or editing any page.
- If a push to `main` doesn't show up on voxprints.com, check the "pages build
  and deployment" runs in Actions. A run stuck in `queued` (or cancelled by a
  newer push) means nothing deployed; cancelling it and pushing a fresh commit
  to `main` starts a new one. Don't cancel a run that is `in_progress`.
