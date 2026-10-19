-- Vox points: one currency shared by the games.
--   Dune coins -> Vox points, 1:1 (one way only)
--   casino chips <-> Vox points, 1:1 (both ways)
-- Points reset to 0 every week (weeks end at midnight on Sunday, Sydney time). When a week ends, the three
-- players with the most points that week are recorded on that week's leaderboard.
-- Free casino chips are gone: once you're out of chips, you buy more with Vox points.
--
-- The weekly close happens lazily: every Vox call first closes any finished weeks (recording their top 3)
-- before anyone's points are reset, so it doesn't need a scheduler.

create table if not exists public.vox_wallet (
  user_id uuid primary key references auth.users(id) on delete cascade,
  points bigint not null default 0 check (points >= 0),
  week_start date not null,
  changed_at timestamptz not null default now()
);
create table if not exists public.vox_weeks (
  week_start date primary key,
  closed_at timestamptz not null default now()
);
create table if not exists public.vox_winners (
  week_start date not null,
  place int not null check (place between 1 and 3),
  user_id uuid not null,
  name text not null,
  points bigint not null,
  primary key (week_start, place)
);
create table if not exists public.vox_log (
  id bigserial primary key,
  user_id uuid not null,
  kind text not null,          -- 'dune_to_points' | 'chips_to_points' | 'points_to_chips'
  amount bigint not null,
  created_at timestamptz not null default now()
);
alter table public.vox_wallet enable row level security;
alter table public.vox_weeks enable row level security;
alter table public.vox_winners enable row level security;
alter table public.vox_log enable row level security;
revoke all on public.vox_wallet, public.vox_weeks, public.vox_winners, public.vox_log from public, anon, authenticated;
create index if not exists vox_log_user on public.vox_log (user_id, created_at desc);

-- the Monday a week starts on, in Sydney time
create or replace function public.vox_week(p_at timestamptz default now()) returns date language sql stable as $$
  select date_trunc('week', p_at at time zone 'Australia/Sydney')::date;
$$;
-- when a week ends (midnight at the end of Sunday, Sydney time)
create or replace function public.vox_week_end(p_week date) returns timestamptz language sql stable as $$
  select ((p_week + 7)::timestamp at time zone 'Australia/Sydney');
$$;

-- record the top 3 of every finished week that hasn't been closed yet
create or replace function public.vox_close_weeks() returns void language plpgsql security definer set search_path = public as $$
declare wk date; cur date := public.vox_week();
begin
  if not exists (select 1 from public.vox_wallet w where w.week_start < cur
                 and not exists (select 1 from public.vox_weeks k where k.week_start = w.week_start)) then return; end if;
  perform pg_advisory_xact_lock(hashtext('vox_close_weeks'));
  for wk in select distinct w.week_start from public.vox_wallet w
            where w.week_start < cur and not exists (select 1 from public.vox_weeks k where k.week_start = w.week_start) order by 1 loop
    insert into public.vox_winners (week_start, place, user_id, name, points)
    select wk, rn, user_id, public.game_player_name(user_id), points from (
      select v.user_id, v.points, row_number() over (order by v.points desc, v.changed_at asc) rn
      from public.vox_wallet v where v.week_start = wk and v.points > 0 and not public.casino_banned(v.user_id)
    ) t where rn <= 3
    on conflict do nothing;
    insert into public.vox_weeks (week_start) values (wk) on conflict do nothing;
  end loop;
end $$;

-- the signed-in player's points row for this week (locked), after closing finished weeks and resetting theirs
create or replace function public.vox_row() returns public.vox_wallet language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); cur date := public.vox_week(); v public.vox_wallet;
begin
  if uid is null then raise exception 'sign in first'; end if;
  perform public.vox_close_weeks();
  insert into public.vox_wallet (user_id, week_start) values (uid, cur) on conflict (user_id) do nothing;
  update public.vox_wallet set points = 0, week_start = cur, changed_at = now() where user_id = uid and week_start < cur;
  select * into v from public.vox_wallet where user_id = uid for update;
  return v;
end $$;

create or replace function public.vox_me() returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.vox_wallet := public.vox_row(); coins bigint; chips bigint; place int;
begin
  select d.coins into coins from public.dune_wallet d where d.user_id = v.user_id;
  select c.chips into chips from public.casino_wallet c where c.user_id = v.user_id;
  if v.points > 0 then
    select count(*) + 1 into place from public.vox_wallet o
    where o.week_start = v.week_start and not public.casino_banned(o.user_id)
      and (o.points > v.points or (o.points = v.points and o.changed_at < v.changed_at));
  end if;
  return jsonb_build_object('points', v.points, 'coins', coalesce(coins, 0), 'chips', coalesce(chips, 1000), 'place', place,
    'week_start', v.week_start, 'week_ends', public.vox_week_end(v.week_start));
end $$;

create or replace function public.vox_from_dune(p_amount bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.vox_wallet := public.vox_row(); left_coins bigint;
begin
  if p_amount is null or p_amount < 1 then raise exception 'pick an amount'; end if;
  update public.dune_wallet set coins = coins - p_amount, updated_at = now() where user_id = v.user_id and coins >= p_amount returning coins into left_coins;
  if not found then raise exception 'not enough coins' using hint = 'vox_short'; end if;
  update public.vox_wallet set points = points + p_amount, changed_at = now() where user_id = v.user_id;
  insert into public.vox_log (user_id, kind, amount) values (v.user_id, 'dune_to_points', p_amount);
  return public.vox_me();
end $$;

create or replace function public.vox_from_chips(p_amount bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); v public.vox_wallet := public.vox_row();
begin
  if p_amount is null or p_amount < 1 then raise exception 'pick an amount'; end if;
  if w.chips < p_amount then raise exception 'not enough chips' using hint = 'vox_short'; end if;
  update public.casino_wallet set chips = chips - p_amount, updated_at = now() where user_id = w.user_id returning * into w;
  perform public.casino_publish(w.user_id, w.chips, false);
  update public.vox_wallet set points = points + p_amount, changed_at = now() where user_id = v.user_id;
  insert into public.vox_log (user_id, kind, amount) values (v.user_id, 'chips_to_points', p_amount);
  return public.vox_me();
end $$;

create or replace function public.vox_to_chips(p_amount bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); v public.vox_wallet := public.vox_row();
begin
  if p_amount is null or p_amount < 1 then raise exception 'pick an amount'; end if;
  if v.points < p_amount then raise exception 'not enough points' using hint = 'vox_short'; end if;
  update public.vox_wallet set points = points - p_amount, changed_at = now() where user_id = v.user_id;
  update public.casino_wallet set chips = chips + p_amount, updated_at = now() where user_id = w.user_id returning * into w;
  perform public.casino_publish(w.user_id, w.chips, false);
  insert into public.vox_log (user_id, kind, amount) values (v.user_id, 'points_to_chips', p_amount);
  return public.vox_me();
end $$;

-- this week's top 3 so far, and the top 3 of each finished week (newest first)
create or replace function public.vox_board(p_weeks int default 8) returns jsonb language plpgsql security definer set search_path = public as $$
declare cur date := public.vox_week(); live jsonb; past jsonb;
begin
  perform public.vox_close_weeks();
  select coalesce(jsonb_agg(jsonb_build_object('place', rn, 'name', public.game_player_name(user_id), 'points', points, 'me', user_id = auth.uid()) order by rn), '[]'::jsonb)
  into live from (
    select v.user_id, v.points, row_number() over (order by v.points desc, v.changed_at asc) rn
    from public.vox_wallet v where v.week_start = cur and v.points > 0 and not public.casino_banned(v.user_id)
  ) t where rn <= 3;
  select coalesce(jsonb_agg(jsonb_build_object('week_start', k.week_start, 'week_ends', public.vox_week_end(k.week_start),
      'winners', (select coalesce(jsonb_agg(jsonb_build_object('place', w.place, 'name', w.name, 'points', w.points, 'me', w.user_id = auth.uid()) order by w.place), '[]'::jsonb)
                  from public.vox_winners w where w.week_start = k.week_start)) order by k.week_start desc), '[]'::jsonb)
  into past from (select week_start from public.vox_weeks order by week_start desc limit least(greatest(coalesce(p_weeks, 8), 1), 52)) k;
  return jsonb_build_object('week_start', cur, 'week_ends', public.vox_week_end(cur), 'live', live, 'past', past);
end $$;

-- no more free chips: you buy chips with Vox points
create or replace function public.casino_borrow() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  raise exception 'free chips are gone: turn Vox points into chips' using hint = 'casino_nofree';
end $$;

revoke all on function public.vox_week(timestamptz), public.vox_week_end(date), public.vox_close_weeks(), public.vox_row(),
  public.vox_me(), public.vox_from_dune(bigint), public.vox_from_chips(bigint), public.vox_to_chips(bigint), public.vox_board(int) from public, anon, authenticated;
grant execute on function public.vox_me(), public.vox_from_dune(bigint), public.vox_from_chips(bigint), public.vox_to_chips(bigint) to authenticated;
grant execute on function public.vox_board(int) to anon, authenticated;
