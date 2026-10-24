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
- No emojis anywhere in the site's UI (except message reactions, which the user asked for) (buttons, labels, messages, toasts). The
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
- Vox Craft (`/craft.html`, `migrations/craft-migration.sql`, edge function `craft`): Infinite Craft style. Drag items onto the board and
  drop one onto another; the function asks Claude (Haiku, Anthropic key from private_config, server side only) what they make. Every pair is
  saved in craft_recipes so everyone gets the same answer and Claude is only asked once; both inputs must already be in craft_items (no free
  text reaches Claude). New pairs: 60/hour per player, 1500/hour site-wide (craft_log). Found items live in the browser (localStorage
  `vxcraft-items`). "First discovery" = the result was new to the whole site. Items are plain text (no emoji, site rule).
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
- Designs are added / edited on their own page, admin/design.html (?id=… to edit; admin/designs.html is the grid). Quantity + bulk
  prices (`migrations/design-quantity-migration.sql`): designs.allow_quantity / max_quantity / bulk_tiers [{min, price each}]. browse.html
  shows a quantity picker with the live total; the server sets orders.quantity (clamped) and orders.unit_price at insert, and an instant
  buy's quote_amount = unit price x quantity (trigger trg_c_instant_buy). Change the price rule in both browse.html and design_unit_price.
  The browse design page needs a filament (when any colour is available): it shows the colours ticked "Featured" in admin
  Filaments (`filaments.featured`; none ticked = the 8 most ordered, rpc `filament_popularity`), "More colours" lists them all grouped by type, most used type first. Designs open at browse.html?d=<id>.
- Printing only: custom modelling was dropped (2026-10-23). The order form only offers Custom Print (type picker hidden), the estimator and
  quote tools hide modelling time, and the server turns non-admin custom_model orders into custom_print. Old custom_model orders keep their label.
  order-form.html is in 3 steps (Your details = name + email, File and colour, Description + promo + terms + Send; `.step` sections,
  step script before the module). Each Next checks its step (filament is required, the file is optional); a step with nothing to fill in is skipped
  (signed in: no name / email), Enter moves on, and the page's own submit handler runs only on the last step. The colour picker
  matches the designs page (Featured first, "More colours" grouped by type).
- Claimed-order unread (`migrations/claimed-unread-migration.sql`): admin/index.html polls rpc `my_unread_claimed` every 6 s and shows a
  yellow message icon with the count next to "You" on your claimed orders, plus a toast and a system notification (when the tab is hidden and
  allowed). admin/order.html marks the order read on the server (`admin_mark_order_read`, table admin_order_reads); a shop reply also counts as read.
- Opening an order in admin/order.html acknowledges it (rpc `admin_mark_order_viewed`, new -> acknowledged, no customer email via the
  `orders.skip_status_mail` setting). Instant buys are stored as acknowledged too but shown as New (`shownStatus`); the list's blue glow is `status = 'new'` only.
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
- Guest email check (`migrations/email-verify-migration.sql`, `/email-verify.js`): a guest (no account) must verify their email with a
  6-digit code (Resend) before an order is accepted; trigger trg_b_email_verified enforces it, signed-in customers and admins skip it.
  order-form.html and the browse.html order modal call `VoxVerify.ensure(supabase, email, {google})` before inserting and show a
  "Sign in with Google" strip at the top (`VoxGuestSignin`). The code screen says "Check your spam". New pages that insert guest orders must do the same.
- Emergency mode (`migrations/emergency-mode-migration.sql`, edge function `site-emergency`, `/emergency.html`): the switch at the bottom
  of Founder > Settings needs a founder AND the site master key (SITE_MASTER_KEY edge function secret, never in the repo or DB; 5 wrong
  keys = 15 min lock). On: every page pulses red with a warning bar + "Learn more" (update-check.js, `window.VoxEmergency`), and the
  server refuses new orders (admins too), messages, cash choice, email codes, games (`assert_account_ok`) and new card payments
  (stripe-pay). Turning it on also runs rpc `emergency_lockdown` (service role only): copies every people-data table into the
  private `secure_store` schema (`<table>__<stamp>`, logged in secure_store.snapshots), deletes every login session except founders',
  and pages sign non-founders out locally. Restrictive `emergency_lock` policies + wrapped get_order* / get_recent_customers hide
  customer data from everyone but founders while it's on. Every step is logged to `site_emergency_log` (rpc `emergency_log`, founders only):
  shown live in the switch window and as a history under the switch. Instant spread: the function broadcasts `emergency` on the Realtime
  channel `vox-emergency` (REST broadcast API) and update-check.js keeps a plain websocket on it, so open pages go red / sign out within
  a second; the 8 s (visible) / 20 s (background) status check is the fallback. The bot also posts (@everyone) the title + report as a red embed in the
  Discord #anouncements channel (private_config `discord_announce_channel_id`), and a green "Back online" post when it's switched off. /emergency.html is also the public status page: current
  state, the last emergency in full and recent ones (`site_emergency_history`, filled by trigger trg_site_emergency_track; rpc `emergency_history`). New customer-facing actions should call `assert_site_open()` first;
  new tables with people's data need an `emergency_lock` policy and a place in emergency_snapshot's list. DROP FUNCTION / CREATE TRIGGER on this DB tend
  to hang through the MCP tool: prefer `create or replace` inside existing functions.
- Edit / delete messages (`migrations/message-edit-migration.sql`, `/msg-actions.js` = `VoxMsg`): every chat (order.html, the admin
  order chat, the admin team chat) marks bubbles `data-mid`, wraps text in `.msg-text` and calls `VoxMsg.wire`. Customers change their
  own order messages (order link), admins their own, founders any (rpc edit_/delete_order_message, edit_/delete_admin_message). Hold a
  message down (~0.45 s, mouse or finger) to show Edit / Delete. Deleted = `deleted_at` set and text/files cleared, and the message is
  left out of every chat; edits leave no mark (the user wanted no "(edited)" / "deleted" labels). order.html reads `get_order_messages_v2`.
  Time labels: `VoxMsg.times(list)` gives one label above a group; a new one only once a message is 10+ min after the last label.
  Reactions (`migrations/message-reactions-migration.sql`, table message_reactions): holding any message shows a row of 4 emoji
  (thumbs up/down, heart, fire) plus "+" for any one emoji; chips under the bubble toggle. Pass `react` / `reactions` to VoxMsg.wire
  (rpc toggle_/get_order_reactions, toggle_/get_admin_reactions). These emoji are the one exception to the no-emoji rule (the user asked).
  New chats should use the same helper.
- Sign in: one "Sign in" button everywhere for customers, opening /signin.html?next=<path> (Continue with Google, or an email code;
  goes back to next after). Google uses Google's own button (Google Identity Services, client 403954063345-bs7v….apps.googleusercontent.com,
  needs https://voxprints.com as an Authorised JavaScript origin) + supabase.auth.signInWithIdToken with a hashed nonce, so Google shows
  voxprints.com instead of the Supabase address; if Google's script can't load, the old redirect button shows instead. Customer pages load /signin-link.js (turns #google-signin-btn into "Sign in", hides #email-code-btn, `VoxSignIn()`);
  game sign-in panels (casino.js, dune, roulette, solitaire, squish) link there directly. Admin logins are separate and unchanged.
  signin-link.js also gives sign-out a ~1 s "Signing out…" screen (#account-signout-btn, game #sign-out, #cz-ban-out); it's on customer
  and game pages, so new pages with sign-out should load it too.
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

- Admin pages are always near-black (the user asked): `/admin/mobile.css` forces one dark palette over each page's own light/dark colours and
  hides the dark-mode switch (`.theme-row:has(#theme-switch)`; other `.theme-row` setting rows stay). Use the CSS variables (not hard-coded light colours) in new admin UI.
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

- Database functions are callable from any browser with the public key: new SECURITY DEFINER functions must `revoke all ... from public, anon, authenticated`
  and grant only what a page needs, and must never run caller-supplied SQL (a leftover `exec_sql(sql_query)` did, open to anon; revoked 2026-10-23).
  Run the Supabase security advisor after schema changes. New tables: enable RLS and revoke anon/authenticated table grants unless a page reads them.
  Audit 2026-10-23 (`migrations/security-audit-2026-10-23-migration.sql`): storage listing is admins-only and uploads are limited to
  `<order id>/…` and `messages/<order id>/…`; customers can't clear their ban or create pre-paid orders (guards); the Anthropic key never
  leaves the server (ai-chat reads it with the service role); send_order_code has a site-wide hourly cap; r2-sign is rate-limited;
  send-order-link is retired. Every edge function's source is in supabase/functions/ — redeploy from there.

## To do (remind the user)
- Stripe go-live: live account "VoxPrints" has bank details, the live publishable key is stored
  (private_config `stripe_publishable_key_live`), and the $8 test payment was refunded. Left: the user
  swaps STRIPE_SECRET_KEY to the live restricted key (never via chat), does a small real payment +
  refund to check, then decides whether card payments open beyond admins (and rechecks the Terms
  payment wording). Klarna/Zip are blocked by the site (excluded on every payment); turning them off in Stripe's dashboard too is optional.
