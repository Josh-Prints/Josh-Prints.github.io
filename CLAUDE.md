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
  `supabase/functions/stripe-pay`): EXPERIMENTAL; paying is open to all admins who aren't suspended (the user asked),
  customers still don't see it. Refunds and marking orders paid by hand stay founder-only. Checkout
  for quoted orders; the order is marked paid only after the function checks the session with
  Stripe. Secret key = STRIPE_SECRET_KEY function secret; never put it in the repo or a page.
  The order page uses a fully custom form (Stripe Payment Element, `intent` action, styled from the
  page's CSS variables); publishable keys live in private_config as `stripe_publishable_key_test` /
  `stripe_publishable_key_live` (public keys, picked to match the secret key's mode).
  Apple Pay / Google Pay: an Express Checkout Element above the card form (only shown when the device has a wallet);
  voxprints.com is registered as a payment method domain on the live account (pmd_1USvrvEMFfJwllH0xzMDlgaL). A new
  domain (or test mode) needs registering too, or Apple Pay won't show.
  No buy-now-pay-later: stripe-pay passes excluded_payment_method_types (klarna, zip, afterpay_clearpay, affirm) on every
  PaymentIntent / Checkout Session (the user wanted them gone). Don't use payment_method_types: this account's API
  version rejects it ("no longer supported"); payment methods otherwise follow the Stripe dashboard.
- Instant buy (`migrations/instant-buy-migration.sql`): designs ticked "Instant buy" in admin/designs.html (needs a
  price) skip the quote. Browse shows "Buy now"; ordering goes to order.html?order=..&checkout=1 where the customer picks
  card / Apple Pay (stripe-pay, open to anyone with the link for instant orders) or cash on pickup (rpc `instant_pay_cash`).
  The server sets orders.instant_buy and quote_amount = design price at insert (trigger trg_c_instant_buy), never the
  customer. Their progress bar is New -> Printing -> Done -> Sold (acknowledged/quoted show as New). Admin pages show
  "Instant buy" with Paid / Cash on pickup / Awaiting payment to every admin.
- Test orders (`migrations/test-orders-migration.sql`): admins tick "Test order" on order-form.html / the browse order
  modal (`orders.is_test` on insert; trigger trg_d_test_order clears it for non-admins). A test order stays
  quiet: notify_new_order (Discord), notify_order_confirmation, notify_order_status_change, discord_push_pending,
  send_unread_reminders and the founder digest / to-do all skip `is_test`. Any new notification or report that reads
  orders should skip is_test too. Admin pages tag them "Test".
- Spam scan (`migrations/spam-scan-migration.sql`): trigger trg_e_spam_scan scores every non-admin order with spam_scan()
  (guest email / name / notes checks, offensive or repeated text for everyone). score >= 5 sets `orders.is_spam` and the order
  stays quiet like a test order (same functions skip it; keep them skipping `is_spam` too); 3-4 only shows a "Review" tag.
  Admin orders list has a Spam chip; the order page has "Not spam" / "Mark as spam". Tune weights with create or replace on spam_scan.
  The customer's order page shows a "Held for review" box with a "Request review" button (rpc `request_spam_review` sets
  `orders.review_requested_at` and pings Discord; `get_order_checkout` returns `spam` / `review_requested`, never the reasons).
  Admin list and order page show "Review requested".
- SEO: public pages (index, browse, estimate, order-form, games, terms, privacy) have a description, canonical, Open Graph /
  Twitter tags and og-image.png in <head>; index also has LocalBusiness JSON-LD. Private pages (order, quote, viewer, admin/*,
  game pages) carry `noindex, nofollow`. robots.txt and sitemap.xml are at the root: add new public pages to sitemap.xml and
  give them the same tags; add `noindex` to any new private or game page.
- Swipe actions (`swipe.js`, `swipeRow(row, {label, icon, color, action})`): swipe a row left for a
  button, or all the way to run it. Used on My orders (deletes go both ways: rpc `set_my_order_hidden` sets
  `orders.deleted` and `customer_hidden_at` = deleted by the customer; shop deletes show in the
  customer's "Show deleted"; restoring either side clears both), the admin
  orders list (delete / restore) and the founder Inbox (archive). Use it for new list rows with a
  delete-like action.

- Admin pages on phones: every admin page loads `/admin/mobile.css` last (dark controls via color-scheme, iOS control
  resets, 16px text boxes so iPhone doesn't zoom, nothing wider than the screen). New admin pages should link it too;
  check new admin UI at 390px wide for anything wider than the screen (iPhone then zooms the whole page out).

- Account bans (`migrations/account-ban-migration.sql`): founders ban/unban customers on admin/customers.html
  (rpc `admin_set_customer_ban`, `customer_profiles.banned_at/ban_reason`). Banned accounts can't place orders (trigger
  on orders, also matches a banned account's email for guest orders) or play: `assert_account_ok()` is the first line of
  casino_row, bj_row, casino_borrow, vox_from_dune, game_record, dune_add_coins/buy/equip, beat_tapper_save_*; keep it
  when redefining those, and add it to new game action functions. update-check.js covers game pages and the order form
  with an "Account banned" screen (path list `GATED`; add new game pages there).
  Guests dodge account bans with a new email, so `blocked_identities` (kind email/name, lower-case) is also checked by the order
  trigger; add rows by SQL for anyone who keeps coming back.

## To do (remind the user)
- Stripe go-live: live account "VoxPrints" has bank details, the live publishable key is stored
  (private_config `stripe_publishable_key_live`), and the $8 test payment was refunded. Left: the user
  swaps STRIPE_SECRET_KEY to the live restricted key (never via chat), does a small real payment +
  refund to check, then decides whether card payments open beyond admins (and rechecks the Terms
  payment wording). Klarna/Zip are blocked by the site (excluded on every payment); turning them off in Stripe's dashboard too is optional.
