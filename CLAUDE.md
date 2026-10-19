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
- Keep UI text short, like a normal website: labels, short headings and one-line
  hints. No explanatory paragraphs, long rule lists or chatty messages ("Not enough
  chips.", not "You don't have that many chips free."). The user called this out.
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
- Vox points (`migrations/vox-points-migration.sql`): Dune coins -> points 1:1 (one way),
  casino chips <-> points 1:1. Points reset to 0 every Sunday midnight Sydney time; the
  top 3 of each week are stored in `vox_winners` (closed lazily by `vox_close_weeks()`
  on the next Vox call). There are no free chips: out of chips means buying chips with
  points. The UI is the "Vox points" tab on games.html (#vox) plus the Vox block in
  every casino side panel (`voxHtml`/`wireVox` in casino.js).
- Casino safe word (`migrations/casino-safe-word-migration.sql`): a trigger on
  `casino_wallet` refuses any update that lowers chips by more than the player's
  `sw_limit` unless they entered their safe word in the last minute (hint
  `casino_safeword`; the pages ask and retry via `safeRpc` in casino.js). Admin fixes that
  lower someone's chips must `set_config('casino.sw_bypass', 'on', true)` first.
- Live presence (`live.js`): every game page joins the Supabase Realtime presence channel
  `vox-live` and shares {game, title, name, score} about twice a second. It drives the
  "N playing" top-bar button, the "Playing now" drawer panel, the strip on games.html,
  and live ticking on the leaderboards (display only; the server's board is re-read
  every 15 s). New game pages should call `startLive` too (and bump `live.js?v=N`).
