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

-- ===== Lockdown: secure copy of everyone's data, sign everyone out, hide customer data =====
-- Run by the site-emergency function right after the switch turns on (service role only).

-- private schema the website API can't reach (only public / graphql_public are exposed)
create schema if not exists secure_store;
revoke all on schema secure_store from public, anon, authenticated;
create table if not exists secure_store.snapshots (id bigserial primary key, taken_at timestamptz not null default now(), reason text, tables jsonb, signed_out int);
revoke all on all tables in schema secure_store from public, anon, authenticated;

-- copies every table that holds people's data into secure_store as <table>__<YYYYMMDD_HHMISS> (Sydney time)
create or replace function public.emergency_snapshot(p_reason text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  stamp text := to_char(now() at time zone 'Australia/Sydney', 'YYYYMMDD_HH24MISS');
  r record; copied jsonb := '{}'::jsonb; n bigint;
begin
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname in ('customer_profiles','orders','messages','admin_messages','admin_profiles','order_quote_drafts','casino_wallet',
                        'vox_wallet','vox_log','dune_wallet','game_stats','game_saves','promo_codes','email_log','blocked_identities')
  loop
    execute format('create table secure_store.%I as table public.%I', r.relname || '__' || stamp, r.relname);
    execute format('select count(*) from secure_store.%I', r.relname || '__' || stamp) into n;
    copied := copied || jsonb_build_object(r.relname, n);
  end loop;
  execute 'revoke all on all tables in schema secure_store from public, anon, authenticated';
  insert into secure_store.snapshots(reason, tables) values (left(p_reason, 200), copied);
  return jsonb_build_object('snapshot', stamp, 'tables', copied);
end $$;

-- ends every login session except founders' (refresh tokens go with them: ON DELETE CASCADE), so nobody stays signed in
create or replace function public.emergency_signout() returns int language plpgsql security definer set search_path = public as $$
declare out int;
begin
  delete from auth.sessions s where not exists (select 1 from public.admin_profiles a where a.id = s.user_id and a.is_founder);
  get diagnostics out = row_count;
  return out;
end $$;

create or replace function public.emergency_lockdown(p_reason text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare snap jsonb; outn int;
begin
  snap := public.emergency_snapshot(p_reason);
  outn := public.emergency_signout();
  update secure_store.snapshots set signed_out = outn where id = (select max(id) from secure_store.snapshots);
  return snap || jsonb_build_object('signed_out', outn);
end $$;
revoke all on function public.emergency_lockdown(text), public.emergency_snapshot(text), public.emergency_signout() from public, anon, authenticated;
grant execute on function public.emergency_lockdown(text) to service_role;

-- while emergency mode is on, nobody but founders can read or write people's data through the website API
-- (restrictive policies: they only bite while site_emergency_active())
do $$
declare t text;
begin
  foreach t in array array['admin_messages','admin_profiles','ai_messages','ai_usage','customer_profiles','email_log','game_saves','messages',
                           'order_quote_drafts','orders','private_config','promo_codes'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'emergency_lock') then
      execute format('create policy emergency_lock on public.%I as restrictive for all to public using (not public.site_emergency_active() or public.is_founder()) with check (not public.site_emergency_active() or public.is_founder())', t);
    end if;
  end loop;
end $$;

-- the order-link and home-page reads (security definer, so they skip the policies above) return nothing while it's on
do $$
declare f record; body text; nb text; def text; patched text;
begin
  for f in
    select p.oid, p.prosrc, p.proretset from pg_proc p join pg_language l on l.oid = p.prolang
    where p.pronamespace = 'public'::regnamespace and l.lanname = 'sql'
      and p.proname in ('get_order', 'get_order_messages', 'get_order_messages_named', 'get_order_checkout', 'get_order_payment', 'get_recent_customers')
  loop
    if position('site_emergency_active' in f.prosrc) > 0 then continue; end if;
    body := regexp_replace(btrim(f.prosrc), ';\s*$', '');
    nb := case when f.proretset
      then E'\n  -- emergency mode: customer data is locked away\n  select * from (' || body || E') _q where not public.site_emergency_active();\n'
      else E'\n  -- emergency mode: customer data is locked away\n  select (' || body || E') where not public.site_emergency_active();\n' end;
    def := pg_get_functiondef(f.oid);
    patched := replace(def, f.prosrc, nb);
    execute patched;
  end loop;
end $$;
-- Note: a function that copied auth.users too never got through the Supabase MCP tool (the request hung every time), so
-- logins stay in auth only; customer_profiles holds the names / emails and is copied. If any of these functions are
-- redefined later (get_order etc.), keep the "where not public.site_emergency_active()" wrapper.
