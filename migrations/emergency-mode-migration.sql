-- Emergency mode: a founder switch (Founder > Settings, bottom) for when the site is under attack.
-- Turning it on or off goes through the site-emergency edge function, which needs a signed-in founder AND the site master key
-- (SITE_MASTER_KEY function secret; never stored in the database or the repo). Wrong keys lock the switch for 15 minutes
-- (5 per founder / 20 total); every attempt is logged in site_emergency_attempts. The switch also pings Discord.
-- While it is on:
--   * every page pulses red with flashing warning lights and a "Learn more" bar to /emergency.html (update-check.js)
--   * no new orders, admins included (ban_guard_order_insert, trigger trg_b_ban_order_insert)
--   * no customer messages, cash-on-pickup choice, spam review requests, order hiding, guest email codes (assert_site_open())
--   * no games / casino / Vox (assert_account_ok() is the first line of every game action)
--   * no new card payments (stripe-pay refuses intent / checkout; checking a payment and refunds still work)
-- Admins can still open and update existing orders.

create table if not exists public.site_emergency (
  id int primary key default 1 check (id = 1), active boolean not null default false, title text, report text,
  started_at timestamptz, ended_at timestamptz, changed_by uuid, updated_at timestamptz not null default now());
insert into public.site_emergency(id) values (1) on conflict do nothing;
alter table public.site_emergency enable row level security;
revoke all on table public.site_emergency from anon, authenticated;

create table if not exists public.site_emergency_attempts (
  id bigserial primary key, user_id uuid, ok boolean not null, action text, at timestamptz not null default now());
alter table public.site_emergency_attempts enable row level security;
revoke all on table public.site_emergency_attempts from anon, authenticated;

create or replace function public.site_emergency_active() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select active from public.site_emergency where id = 1), false);
$$;

create or replace function public.assert_site_open() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.site_emergency_active() then raise exception 'The site is paused' using hint = 'site_emergency'; end if;
end $$;

-- what every page reads (anyone); the report only while active
create or replace function public.emergency_status() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('active', active, 'title', case when active then title end, 'report', case when active then report end,
    'started_at', case when active then started_at end, 'updated_at', updated_at)
  from public.site_emergency where id = 1;
$$;

revoke all on function public.site_emergency_active(), public.assert_site_open(), public.emergency_status() from public, anon, authenticated;
grant execute on function public.emergency_status() to anon, authenticated;
grant execute on function public.assert_site_open(), public.site_emergency_active() to anon, authenticated;

-- games / casino / Vox
create or replace function public.assert_account_ok() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.site_emergency_active() then raise exception 'The site is paused' using hint = 'site_emergency'; end if;
  if public.account_banned(auth.uid()) then raise exception 'This account is banned' using hint = 'account_banned'; end if;
end $$;

-- customer actions on existing orders, and the guest email code: assert_site_open() as the first statement
do $$
declare f record; def text; patched text;
begin
  for f in
    select p.oid from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace and l.lanname = 'plpgsql'
      and p.proname in ('add_customer_message', 'instant_pay_cash', 'request_spam_review', 'send_order_code', 'check_order_code', 'set_my_order_hidden')
  loop
    def := pg_get_functiondef(f.oid);
    if position('assert_site_open' in def) > 0 then continue; end if;
    patched := regexp_replace(def, '(\$function\$.*?\mbegin\M)', '\1 perform public.assert_site_open();');
    if patched = def then raise exception 'could not patch %', f.oid::regprocedure; end if;
    execute patched;
  end loop;
end $$;

-- new orders: checked first in the existing ban guard (creating a new trigger on orders kept hanging on a lock)
create or replace function public.ban_guard_order_insert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.site_emergency_active() then raise exception 'Orders are paused' using hint = 'site_emergency'; end if;
  if public.is_admin() then return new; end if;
  if public.account_banned(auth.uid()) or public.account_banned(new.user_id) or public.account_banned_email(new.email)
     or exists (select 1 from public.blocked_identities b where (b.kind = 'email' and b.value = lower(btrim(coalesce(new.email, ''))))
                or (b.kind = 'name' and b.value = lower(btrim(coalesce(new.full_name, ''))))) then
    raise exception 'This account is banned' using hint = 'account_banned';
  end if;
  return new;
end $$;
