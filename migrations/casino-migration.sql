-- Casino: one chip wallet shared by every gambling game (Blackjack, Roulette), and one casino-wide leaderboard.
--
-- casino_wallet : each player's chips. Only the game RPCs below touch it.
-- game_stats    : the 'casino' row holds the leaderboard numbers: best_score = current chips,
--                 total_seconds = time at the tables, games_played = hands + spins.
-- Blackjack keeps its own table (shoe, hands) but its chips now live in the wallet: bj_row() loads them into
-- bj_table.chips and a trigger writes every chips change straight back.

alter table public.game_stats drop constraint if exists game_stats_game_check;
alter table public.game_stats add constraint game_stats_game_check check (game in ('squish', 'dune', 'blackjack', 'casino'));
do $$
declare d text;
begin
  d := pg_get_functiondef('public.game_record(text,bigint,integer,boolean)'::regprocedure);
  d := replace(d, 'p_game not in (''squish'', ''dune'', ''blackjack'')', 'p_game not in (''squish'', ''dune'', ''blackjack'', ''casino'')');
  execute d;
end $$;

create table if not exists public.casino_wallet (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chips bigint not null default 1000 check (chips >= 0),
  updated_at timestamptz not null default now()
);
alter table public.casino_wallet enable row level security;
revoke all on table public.casino_wallet from anon, authenticated;

-- existing blackjack players bring their chips, time and hands with them
insert into public.casino_wallet (user_id, chips) select user_id, chips from public.bj_table on conflict (user_id) do nothing;
insert into public.game_stats (user_id, game, best_score, total_seconds, games_played, last_seen)
  select w.user_id, 'casino', w.chips, coalesce(s.total_seconds, 0), coalesce(s.games_played, 0), coalesce(s.last_seen, now())
  from public.casino_wallet w left join public.game_stats s on s.user_id = w.user_id and s.game = 'blackjack'
on conflict (user_id, game) do nothing;

-- the caller's wallet, locked for this transaction
create or replace function public.casino_row() returns public.casino_wallet language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); w public.casino_wallet;
begin
  if uid is null then raise exception 'sign in first'; end if;
  insert into public.casino_wallet (user_id) values (uid) on conflict (user_id) do nothing;
  select * into w from public.casino_wallet where user_id = uid for update;
  return w;
end $$;

create or replace function public.casino_publish(uid uuid, p_chips bigint, played boolean) returns void language sql security definer set search_path = public as $$
  insert into public.game_stats as s (user_id, game, best_score, total_seconds, games_played, last_seen)
  values (uid, 'casino', least(p_chips, 100000000000), 0, case when played then 1 else 0 end, now())
  on conflict (user_id, game) do update set best_score = least(excluded.best_score, 100000000000),
    games_played = s.games_played + excluded.games_played, last_seen = now()
$$;

-- blackjack: chips come from the wallet, and every change goes back to it
create or replace function public.bj_sync_wallet() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.casino_wallet set chips = new.chips, updated_at = now() where user_id = new.user_id;
  return null;
end $$;
drop trigger if exists bj_table_wallet on public.bj_table;
create trigger bj_table_wallet after update of chips on public.bj_table for each row execute function public.bj_sync_wallet();

create or replace function public.bj_row() returns public.bj_table language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); t public.bj_table; w public.casino_wallet;
begin
  if uid is null then raise exception 'sign in first'; end if;
  w := public.casino_row();
  insert into public.bj_table (user_id) values (uid) on conflict (user_id) do nothing;
  update public.bj_table set chips = w.chips where user_id = uid returning * into t;
  return t;
end $$;

create or replace function public.bj_publish(uid uuid, chips bigint, played boolean) returns void language sql security definer set search_path = public as $$
  select public.casino_publish(uid, chips, played)
$$;

-- what any casino page needs on load
create or replace function public.casino_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row();
begin
  perform public.casino_publish(w.user_id, w.chips, false);
  return jsonb_build_object('chips', w.chips);
end $$;

-- below 1,000 chips you can reset back to 1,000 (not while a blackjack hand is on the table)
create or replace function public.casino_topup() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row();
begin
  if w.chips < 1000 and not exists (select 1 from public.bj_table where user_id = w.user_id and phase = 'play') then
    update public.casino_wallet set chips = 1000, updated_at = now() where user_id = w.user_id returning * into w;
    perform public.casino_publish(w.user_id, w.chips, false);
  end if;
  return jsonb_build_object('chips', w.chips);
end $$;

-- Roulette (single zero). p_bets: [{"k": "n17" | "red" | "black" | "odd" | "even" | "low" | "high" | "d1".."d3" | "c1".."c3", "a": amount}, ...]
-- Straight numbers pay 35 to 1, dozens and columns 2 to 1, the rest 1 to 1. Zero loses every outside bet.
create or replace function public.rl_wins(k text, n int) returns int language plpgsql immutable as $$
declare red boolean := n = any (array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
begin
  if k ~ '^n([0-9]|[12][0-9]|3[0-6])$' then return case when substr(k, 2)::int = n then 36 else 0 end; end if;
  if n = 0 then return 0; end if;
  return case k
    when 'red' then case when red then 2 else 0 end
    when 'black' then case when not red then 2 else 0 end
    when 'odd' then case when n % 2 = 1 then 2 else 0 end
    when 'even' then case when n % 2 = 0 then 2 else 0 end
    when 'low' then case when n <= 18 then 2 else 0 end
    when 'high' then case when n >= 19 then 2 else 0 end
    when 'd1' then case when n <= 12 then 3 else 0 end
    when 'd2' then case when n between 13 and 24 then 3 else 0 end
    when 'd3' then case when n >= 25 then 3 else 0 end
    when 'c1' then case when n % 3 = 1 then 3 else 0 end
    when 'c2' then case when n % 3 = 2 then 3 else 0 end
    when 'c3' then case when n % 3 = 0 then 3 else 0 end
    else 0 end;
end $$;

create or replace function public.rl_spin(p_bets jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); b jsonb; k text; a bigint; total bigint := 0; pay bigint := 0; n int;
begin
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 or jsonb_array_length(p_bets) > 60 then raise exception 'invalid bets'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    k := b->>'k'; a := (b->>'a')::bigint;
    if k is null or a is null or a < 1 or not (k ~ '^(n([0-9]|[12][0-9]|3[0-6])|red|black|odd|even|low|high|d[1-3]|c[1-3])$') then raise exception 'invalid bet'; end if;
    total := total + a;
  end loop;
  if total < 5 or total > w.chips then raise exception 'invalid bet'; end if;
  n := floor(random() * 37)::int;
  for b in select * from jsonb_array_elements(p_bets) loop
    pay := pay + (b->>'a')::bigint * public.rl_wins(b->>'k', n);
  end loop;
  update public.casino_wallet set chips = chips - total + pay, updated_at = now() where user_id = w.user_id returning * into w;
  perform public.casino_publish(w.user_id, w.chips, true);
  return jsonb_build_object('chips', w.chips, 'number', n, 'staked', total, 'payout', pay, 'net', pay - total);
end $$;

revoke all on function public.casino_row(), public.casino_publish(uuid, bigint, boolean), public.bj_sync_wallet(), public.bj_row(),
  public.bj_publish(uuid, bigint, boolean), public.casino_state(), public.casino_topup(), public.rl_spin(jsonb) from public, anon, authenticated;
grant execute on function public.casino_state(), public.casino_topup(), public.rl_spin(jsonb) to authenticated;
