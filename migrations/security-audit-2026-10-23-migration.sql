-- Security audit fixes (2026-10-23). Applied live; kept here for the record.

-- 1. File storage: only admins can list the order-files bucket (listing exposed every order id, and an order id opens
--    that order's page), and visitors / customers can only upload into "<order id>/file" or "messages/<order id>/file".
alter policy order_files_admin_select on storage.objects using (bucket_id = 'order-files' and public.is_admin());
alter policy order_files_anon_upload on storage.objects with check (bucket_id = 'order-files' and (
  name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$'
  or name ~ '^messages/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$'));
alter policy order_files_authenticated_upload on storage.objects with check (bucket_id = 'order-files' and (
  public.is_admin()
  or name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$'
  or name ~ '^messages/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$'));

-- 2. guard_customer_profile_changes: a customer can no longer clear their own ban (banned_at / ban_reason / banned_by
--    are kept from the old row for non-editors, and nulled on a customer's own insert).
-- 3. guard_order_insert: a customer can no longer create an order already marked paid / refunded / with Stripe ids,
--    review requested, hidden or with a quote draft (paid_at, paid_amount, paid_method, pay_choice, refunded_at,
--    refunded_amount, stripe_payment_intent, stripe_session_id, review_requested_at, customer_hidden_at, quote_draft
--    are all reset). Both were patched in place with create or replace (see the live definitions).

-- 4. ai_build_context no longer returns the Anthropic API key (any admin could call it directly and read the key);
--    it returns has_key instead and the ai-chat edge function reads the key with the service role.

-- 5. send_order_code: site-wide cap of 300 codes an hour on top of the per-address limits.

-- 6. r2-sign edge function: 40 upload addresses / 30 GB an hour site-wide, 50 files per order, paused in emergency mode.
create table if not exists public.r2_sign_log (id bigserial primary key, at timestamptz not null default now(), order_id uuid, bytes bigint);
alter table public.r2_sign_log enable row level security;
revoke all on table public.r2_sign_log from anon, authenticated;

-- 7. send-order-link edge function retired (it emailed any address any HTML through the shop's Resend account).
