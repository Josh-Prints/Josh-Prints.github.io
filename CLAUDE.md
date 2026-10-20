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
  every 15 s). Presence is only re-sent when who/where/playing changes (Supabase drops clients that
  update presence too often: ClientPresenceRateLimitReached); scores go out as a "score" broadcast
  about once a second. New game pages should call `startLive` too (and bump `live.js?v=N`).
- Founder announcements (`migrations/announcements-migration.sql`): the Announce tab in
  admin/founder.html posts them; `update-check.js` (on every page) polls `live_announcements`
  every 8 s alongside the update check and shows each id/rev once per visitor (`vox-ann-seen2`); the look is a `style` jsonb.
  `window.VoxAnnounce.show()` renders it (also used for the founder preview).
- Stripe card payments (`migrations/stripe-payments-migration.sql`, edge function
  `supabase/functions/stripe-pay`): EXPERIMENTAL and founder-only (the user asked). Checkout
  for quoted orders; the order is marked paid only after the function checks the session with
  Stripe. Secret key = STRIPE_SECRET_KEY function secret; never put it in the repo or a page.
  The order page uses a fully custom form (Stripe Payment Element, `intent` action, styled from the
  page's CSS variables); publishable keys live in private_config as `stripe_publishable_key_test` /
  `stripe_publishable_key_live` (public keys, picked to match the secret key's mode).
- Swipe actions (`swipe.js`, `swipeRow(row, {label, icon, color, action})`): swipe a row left for a
  button, or all the way to run it. Used on My orders (deletes go both ways: rpc `set_my_order_hidden` sets
  `orders.deleted` and `customer_hidden_at` = deleted by the customer; shop deletes show in the
  customer's "Show deleted"; restoring either side clears both), the admin
  orders list (delete / restore) and the founder Inbox (archive). Use it for new list rows with a
  delete-like action.

## To do (remind the user)
- Stripe go-live: live account "VoxPrints" has bank details, the live publishable key is stored
  (private_config `stripe_publishable_key_live`), and the $8 test payment was refunded. Left: the user
  swaps STRIPE_SECRET_KEY to the live restricted key (never via chat), does a small real payment +
  refund to check, then decides whether card payments open beyond founders (and rechecks the Terms
  payment wording); optionally turn off Klarna/Zip in Stripe's payment methods.
