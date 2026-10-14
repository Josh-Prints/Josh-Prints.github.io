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
- No emojis anywhere in the site's UI (buttons, labels, messages, toasts). The
  user dislikes them. Use the line icons from `/icons.svg` instead
  (`<svg class="ico" width="1em" height="1em" aria-hidden="true"><use href="/icons.svg#name"/></svg>`),
  or plain text. Playing-card suit symbols (♠♥♦♣) are fine.
- Casino games (Gambling tab): every game page shares `/casino.js` and
  `/casino.css` (sign-in panel, casino leaderboard, chip wallet, cards, dice,
  chip rack). Pages import them as `?v=N`; bump N on every page when either
  file changes so browsers pick it up. Each game's rules exist twice: in the
  page (guests play in the browser) and in Supabase
  (`migrations/casino-games-migration.sql`, for signed-in players). Change
  both together and cross-check them with the same inputs.
