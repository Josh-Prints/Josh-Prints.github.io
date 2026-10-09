# Security notes

Voxprints is a static site (GitHub Pages) talking straight to Supabase. There is no
server code of our own, so **the browser is untrusted and the database is the
security boundary**. The Supabase publishable key in the HTML is public by design;
Row-Level Security, the guard triggers and function grants decide what it can do.

Last audited: 2026-10-06. Database hardening is in
`migrations/security-hardening-migration.sql`.

## Where secrets live (nothing sensitive is in this repo)

| Secret | Stored in | Who can read it |
|---|---|---|
| Claude API key, Resend key, Discord bot token | `private_config` table | founders only (RLS), plus SECURITY DEFINER functions |
| Edge-function env (`SUPABASE_URL`, anon key) | Supabase function secrets | the function |

Never put a `service_role` key, API key or password in an `.html` file. If one is
ever committed, rotate it first, then remove it.

## Rules the code relies on

- A customer or guest may only choose *what they want* on an order. Status, quote,
  credit, discounts, catalogue prices and claims are forced server-side
  (`guard_order_insert`, `guard_customer_profile_changes`).
- Every new table needs RLS **and** `revoke all on public.<table> from anon;`
  (Supabase grants new tables to `anon` by default). Policies should name the role
  (`to authenticated`) and use `is_admin()` / `can_edit()` / `is_founder()`.
- Every new `SECURITY DEFINER` function needs `set search_path`, a role check inside,
  and `revoke all ... from public, anon;` unless anonymous visitors really need it.
- Anything user-supplied that goes into `innerHTML` must go through `escapeHtml()`.
  Prefer `textContent`.
- URLs that come from the query string must be validated before use
  (see `safeFileUrl` in `viewer.html`).

## Error log

Every page loads `/error-log.js`, which reports crashes, failed requests and failed
script loads to `log_client_error()` (public, but rate-limited and validated). It never
records typed text, message bodies or request bodies; ids in URLs are cut to 8 characters.
The data is only readable by founders (Founder > Errors). Rows are not pruned yet; see the
end of `migrations/error-log-migration.sql`.

## Known, accepted or open items

1. **Order links are bearer links.** `get_order`, `get_order_messages`,
   `add_customer_message` and `mark_order_seen` work for anyone who has the order's
   UUID (guests have no account). UUIDs are unguessable, but anyone who is sent the
   link can see the order. Option: for orders that have a `user_id`, require that
   user (or an admin) to be signed in. This would break email links opened signed-out.
2. **Third-party scripts are not integrity-pinned.** `@supabase/supabase-js@2` and
   `three@0.160.0` load from jsDelivr, `jspdf` and `jspdf-autotable` from cdnjs, with no
   Subresource Integrity. Pin an exact supabase-js version and add
   `integrity="sha384-…" crossorigin="anonymous"` to the two `<script src>` tags
   (hashes: `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`).
   Also upgrade `jspdf` 2.5.1 to the current 3.x (has published DoS advisories) and
   `jspdf-autotable` to a matching release (call style changes to `autoTable(doc, …)`).
3. **AI assistant and prompt injection.** The assistant reads customer-written text
   and has tools that can email/message a customer and change an order's status.
   Consider requiring a confirmation click for those write tools.
4. **Security headers.** GitHub Pages cannot set `Content-Security-Policy`,
   `X-Frame-Options` or `Referrer-Policy`. Putting Cloudflare in front would allow a CSP
   and clickjacking protection for `/admin`.
5. **Store credit is changed from the browser by admins** (`admin/order.html`,
   `admin/customers.html`). Admins are trusted; moving the award/spend logic into a
   database function would make it atomic and auditable.
6. **Founder page loads the saved Claude key** into the browser to show "saved".
   It only needs to know a key exists; return a boolean instead.
7. `get_recent_customers` (home page social proof) shows customers' first names and
   what they ordered to anyone. Intentional, but a privacy trade-off.
8. `orders.quote_draft` is an unused, empty column from an earlier attempt; drop it
   when convenient (`alter table public.orders drop column quote_draft;`).
9. Supabase dashboard checks: keep the Auth redirect URL allow-list to
   `https://voxprints.com/*` only, turn on 2-step verification for the Google accounts
   of every founder/admin, and rotate the Discord bot token if a transcript that
   contained it was shared.

## Large uploads (Cloudflare R2)

- Order files over 50 MB (up to 500 MB) are uploaded straight from the browser to the `voxprints-files` R2 bucket; smaller files still go to Supabase storage.
- The R2 keys are stored in `private_config` (founder-readable only, like the other API keys) and are only read by the `r2-sign` edge function using the service role. They are never in the site's code. Rotate by creating a new R2 token and updating the `r2_*` rows.
- `r2-sign` is public on purpose (guests place orders) with the gateway JWT check off; it requires the site's publishable key, caps files at 500 MB, and the upload address is single-use for one file, valid 15 minutes, locked to the declared size. Accepted risk: anyone with the site key could still upload within those limits (R2 free tier is 10 GB).
- Files on R2 are stored in `orders.files` as full `https://pub-….r2.dev/...` addresses; every page that opens files passes full addresses straight through.
