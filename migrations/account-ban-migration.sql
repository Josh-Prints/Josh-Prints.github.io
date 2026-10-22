-- Account bans: a founder bans a customer from the Customers page. A banned account can still sign in and read the
-- site (home, terms, privacy, its own orders and messages) but can't place orders or play any games.
-- Enforced here, not just in the pages:
--   * new orders: refused for a banned signed-in account, and for anyone ordering with a banned account's email
--   * games: every game / casino / Vox action checks assert_account_ok() first (the guard is added to the existing
--     functions below; if one of them is redefined later, keep the `perform public.assert_account_ok();` line)

alter table public.customer_profiles add column if not exists banned_at timestamptz;
alter table public.customer_profiles add column if not exists ban_reason text;
alter table public.customer_profiles add column if not exists banned_by uuid;

create or replace function public.account_banned(uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select uid is not null and exists (select 1 from public.customer_profiles where id = uid and banned_at is not null);
$$;

create or replace function public.account_banned_email(p_email text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(btrim(p_email), '') <> '' and exists (
    select 1 from public.customer_profiles where banned_at is not null and lower(email) = lower(btrim(p_email)));
$$;

create or replace function public.assert_account_ok() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.account_banned(auth.uid()) then raise exception 'This account is banned' using hint = 'account_banned'; end if;
end $$;

-- the signed-in person's own ban, for the pages
create or replace function public.my_account_ban() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('banned', p.banned_at is not null, 'reason', p.ban_reason, 'at', p.banned_at)
  from public.customer_profiles p where p.id = auth.uid();
$$;

-- founders ban / unban
create or replace function public.admin_set_customer_ban(p_user uuid, p_ban boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.customer_profiles;
begin
  if not public.is_founder() or public.is_suspended() then raise exception 'founders only'; end if;
  if exists (select 1 from public.admin_profiles where id = p_user) then raise exception 'can''t ban an admin'; end if;
  update public.customer_profiles set
    banned_at = case when p_ban then coalesce(banned_at, now()) end,
    ban_reason = case when p_ban then nullif(left(btrim(coalesce(p_reason, '')), 200), '') end,
    banned_by = case when p_ban then auth.uid() end
  where id = p_user returning * into r;
  if r.id is null then raise exception 'customer not found'; end if;
  return jsonb_build_object('banned', r.banned_at is not null, 'reason', r.ban_reason, 'at', r.banned_at);
end $$;

revoke all on function public.account_banned(uuid), public.account_banned_email(text), public.assert_account_ok(),
  public.my_account_ban(), public.admin_set_customer_ban(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.my_account_ban(), public.admin_set_customer_ban(uuid, boolean, text) to authenticated;
grant execute on function public.assert_account_ok() to anon, authenticated;

-- new orders
create or replace function public.ban_guard_order_insert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if public.account_banned(auth.uid()) or public.account_banned(new.user_id) or public.account_banned_email(new.email) then
    raise exception 'This account is banned' using hint = 'account_banned';
  end if;
  return new;
end $$;
drop trigger if exists trg_b_ban_order_insert on public.orders;
create trigger trg_b_ban_order_insert before insert on public.orders for each row execute function public.ban_guard_order_insert();

-- the casino's own ban check also counts account bans (casino pages show their ban screen)
create or replace function public.casino_banned(uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.casino_wallet where user_id = uid and banned_at is not null) or public.account_banned(uid);
$$;

-- games: add the guard as the first statement of each action function
do $$
declare f record; def text; patched text;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and l.lanname = 'plpgsql'
      and p.proname in ('casino_row', 'bj_row', 'casino_borrow', 'vox_from_dune', 'game_record', 'dune_add_coins', 'dune_buy',
                        'dune_equip', 'beat_tapper_save_profile', 'beat_tapper_save_take')
  loop
    def := pg_get_functiondef(f.oid);
    if position('assert_account_ok' in def) > 0 then continue; end if;
    patched := regexp_replace(def, '(\$function\$.*?\mbegin\M)', '\1 perform public.assert_account_ok();');
    if patched = def then raise exception 'could not patch %', f.oid::regprocedure; end if;
    execute patched;
  end loop;
end $$;

-- Block list for guest orders: bans only catch accounts, so a banned person can still order as a guest with a new
-- email. Rows here (lower-case email or full name) are refused by the same order trigger. No policies = server only;
-- add rows with SQL.
create table if not exists public.blocked_identities (
  kind text not null check (kind in ('email','name')), value text not null, reason text, created_at timestamptz not null default now(),
  primary key (kind, value));
alter table public.blocked_identities enable row level security;

create or replace function public.ban_guard_order_insert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if public.account_banned(auth.uid()) or public.account_banned(new.user_id) or public.account_banned_email(new.email)
     or exists (select 1 from public.blocked_identities b where (b.kind = 'email' and b.value = lower(btrim(coalesce(new.email, ''))))
                or (b.kind = 'name' and b.value = lower(btrim(coalesce(new.full_name, ''))))) then
    raise exception 'This account is banned' using hint = 'account_banned';
  end if;
  return new;
end $$;
