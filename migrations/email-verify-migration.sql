-- Guest email check: a guest (no account) can only place an order from an email they verified with a 6-digit code.
--   send_order_code(email)        emails a code (Resend, 10 min, 45 s between sends, 6 per hour); refuses banned / blocked emails
--   check_order_code(email, code) 5 tries per code; on success the email counts as verified for 30 minutes
--   email_verified(email)         used by the pages to skip the prompt
--   trg_b_email_verified          before-insert on orders: refuses an unverified guest order (hint email_unverified).
--                                 Signed-in customers (Google or email-code sign-in) and admins skip it.
-- Pages: /email-verify.js (VoxVerify.ensure + the "Sign in with Google" strip, VoxGuestSignin) used by order-form.html and
-- the browse.html order modal. Any new page that inserts guest orders must call VoxVerify.ensure first.

create table if not exists public.order_email_codes (
  email text primary key, code_hash text, expires_at timestamptz, attempts int not null default 0,
  sent_at timestamptz, verified_at timestamptz, hour_start timestamptz, hour_sends int not null default 0);
alter table public.order_email_codes enable row level security;

create or replace function public.send_order_code(p_email text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare e text := lower(btrim(coalesce(p_email, ''))); r public.order_email_codes; code text; res jsonb; st int;
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(e) > 200 then raise exception 'Enter a valid email'; end if;
  if public.account_banned_email(e) or exists (select 1 from public.blocked_identities b where b.kind = 'email' and b.value = e) then
    raise exception 'This account is banned' using hint = 'account_banned';
  end if;
  select * into r from public.order_email_codes where email = e;
  if r.email is not null and r.sent_at > now() - interval '45 seconds' then raise exception 'Wait a moment, then try again'; end if;
  if r.email is not null and r.hour_start > now() - interval '1 hour' and r.hour_sends >= 6 then raise exception 'Too many codes. Try again later'; end if;
  code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  insert into public.order_email_codes(email, code_hash, expires_at, attempts, sent_at, verified_at, hour_start, hour_sends)
  values (e, encode(extensions.digest(e || ':' || code, 'sha256'), 'hex'), now() + interval '10 minutes', 0, now(), null, now(), 1)
  on conflict (email) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = now(), verified_at = null,
    hour_start = case when public.order_email_codes.hour_start > now() - interval '1 hour' then public.order_email_codes.hour_start else now() end,
    hour_sends = case when public.order_email_codes.hour_start > now() - interval '1 hour' then public.order_email_codes.hour_sends + 1 else 1 end;
  res := public.resend_api('POST', '/emails', jsonb_build_object(
    'from', public.resend_from_header(), 'to', jsonb_build_array(e), 'subject', 'Your Voxprints code: ' || code,
    'html', '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:420px;margin:0 auto;color:#1a1a1a"><p>Your code to place an order:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:12px 0">' || code || '</p><p style="font-size:13px;color:#666">It works for 10 minutes. If you did not ask for it, ignore this email.</p></div>',
    'text', 'Your Voxprints code: ' || code || E'\nIt works for 10 minutes. If you did not ask for it, ignore this email.'));
  st := coalesce((res->>'status')::int, 0);
  if st not between 200 and 299 then raise exception 'Could not send the code. Try again'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.check_order_code(p_email text, p_code text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare e text := lower(btrim(coalesce(p_email, ''))); r public.order_email_codes;
begin
  select * into r from public.order_email_codes where email = e;
  if r.email is null or r.code_hash is null or r.expires_at < now() then raise exception 'Code expired. Send a new one'; end if;
  if r.attempts >= 5 then raise exception 'Too many tries. Send a new code'; end if;
  if r.code_hash <> encode(extensions.digest(e || ':' || btrim(coalesce(p_code, '')), 'sha256'), 'hex') then
    update public.order_email_codes set attempts = attempts + 1 where email = e;
    raise exception 'Wrong code';
  end if;
  update public.order_email_codes set verified_at = now(), code_hash = null where email = e;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.email_verified(p_email text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.order_email_codes where email = lower(btrim(coalesce(p_email, ''))) and verified_at > now() - interval '30 minutes');
$$;

create or replace function public.require_verified_email() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or public.is_admin() then return new; end if;
  if auth.uid() is null and new.user_id is null and not public.email_verified(new.email) then
    raise exception 'Verify your email first' using hint = 'email_unverified';
  end if;
  return new;
end $$;

revoke all on function public.send_order_code(text), public.check_order_code(text, text), public.email_verified(text), public.require_verified_email() from public, anon, authenticated;
grant execute on function public.send_order_code(text), public.check_order_code(text, text), public.email_verified(text) to anon, authenticated;

-- turn the check on only once the pages above are live
drop trigger if exists trg_b_email_verified on public.orders;
create trigger trg_b_email_verified before insert on public.orders for each row execute function public.require_verified_email();
