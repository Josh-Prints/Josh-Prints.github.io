-- Dune: coins saved to the player's account, plus a shop of ball skins and world themes.
create table if not exists public.dune_wallet (
  user_id uuid primary key references auth.users(id) on delete cascade,
  coins bigint not null default 0 check (coins >= 0),
  lifetime_coins bigint not null default 0,
  owned text[] not null default array['skin:classic','theme:sunset'],
  skin text not null default 'classic',
  theme text not null default 'sunset',
  last_deposit timestamptz not null default now() - interval '1 hour',
  updated_at timestamptz not null default now()
);
alter table public.dune_wallet enable row level security;
revoke all on table public.dune_wallet from anon, authenticated;

-- the shop catalogue lives here so prices can't be changed from the browser
create or replace function public.dune_price(p_item text) returns int
language sql immutable as $$
  select case p_item
    when 'skin:classic' then 0   when 'skin:ruby' then 150   when 'skin:ice' then 250    when 'skin:emerald' then 300
    when 'skin:beach' then 400   when 'skin:gold' then 600   when 'skin:lava' then 800   when 'skin:galaxy' then 1200
    when 'skin:disco' then 1600
    when 'theme:sunset' then 0   when 'theme:day' then 300   when 'theme:night' then 500 when 'theme:mars' then 900
    when 'theme:aurora' then 1500
    else null end
$$;

create or replace function public.dune_profile() returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); w public.dune_wallet;
begin
  if uid is null then raise exception 'sign in first'; end if;
  insert into public.dune_wallet (user_id) values (uid) on conflict (user_id) do nothing;
  select * into w from public.dune_wallet where user_id = uid;
  return jsonb_build_object('coins', w.coins, 'lifetime', w.lifetime_coins, 'owned', to_jsonb(w.owned), 'skin', w.skin, 'theme', w.theme);
end $$;

-- add a run's coins. Capped by how long it's been since the last deposit (nobody collects coins faster than a
-- few a second), so a tampered browser can't mint a fortune in one go.
create or replace function public.dune_add_coins(p_coins int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); w public.dune_wallet; allowed int;
begin
  if uid is null then raise exception 'sign in first'; end if;
  insert into public.dune_wallet (user_id) values (uid) on conflict (user_id) do nothing;
  select * into w from public.dune_wallet where user_id = uid for update;
  allowed := least(greatest(coalesce(p_coins, 0), 0), 3000,
                   floor(extract(epoch from (now() - w.last_deposit)) * 6)::int + 20);
  update public.dune_wallet set coins = coins + allowed, lifetime_coins = lifetime_coins + allowed,
         last_deposit = now(), updated_at = now() where user_id = uid;
  return public.dune_profile() || jsonb_build_object('added', allowed);
end $$;

create or replace function public.dune_buy(p_item text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); w public.dune_wallet; price int := public.dune_price(p_item);
begin
  if uid is null then raise exception 'sign in first'; end if;
  if price is null then raise exception 'unknown item'; end if;
  insert into public.dune_wallet (user_id) values (uid) on conflict (user_id) do nothing;
  select * into w from public.dune_wallet where user_id = uid for update;
  if p_item = any(w.owned) then return public.dune_profile(); end if;
  if w.coins < price then raise exception 'not enough coins'; end if;
  update public.dune_wallet set coins = coins - price, owned = array_append(owned, p_item), updated_at = now() where user_id = uid;
  return public.dune_profile();
end $$;

create or replace function public.dune_equip(p_item text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); w public.dune_wallet; v_kind text := split_part(p_item, ':', 1); v_name text := split_part(p_item, ':', 2);
begin
  if uid is null then raise exception 'sign in first'; end if;
  if public.dune_price(p_item) is null or v_kind not in ('skin', 'theme') then raise exception 'unknown item'; end if;
  insert into public.dune_wallet (user_id) values (uid) on conflict (user_id) do nothing;
  select * into w from public.dune_wallet where user_id = uid for update;
  if not (p_item = any(w.owned)) then raise exception 'not owned'; end if;
  if v_kind = 'skin' then update public.dune_wallet set skin = v_name, updated_at = now() where user_id = uid;
  else update public.dune_wallet set theme = v_name, updated_at = now() where user_id = uid; end if;
  return public.dune_profile();
end $$;

revoke all on function public.dune_profile(), public.dune_add_coins(int), public.dune_buy(text), public.dune_equip(text) from public, anon;
grant execute on function public.dune_profile(), public.dune_add_coins(int), public.dune_buy(text), public.dune_equip(text) to authenticated;
