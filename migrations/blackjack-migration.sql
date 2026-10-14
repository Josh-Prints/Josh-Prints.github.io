-- Blackjack: dealt and settled on the server for signed-in players, so the chips leaderboard can't be faked.
-- Cards are ints 0..51: rank = c % 13 (0 = A, 1..9 = 2..10, 10..12 = J Q K), suit = c / 13 (0 ♠, 1 ♥, 2 ♦, 3 ♣).
alter table public.game_stats drop constraint if exists game_stats_game_check;
alter table public.game_stats add constraint game_stats_game_check check (game in ('squish', 'dune', 'blackjack'));
alter table public.game_saves drop constraint if exists game_saves_game_check;
alter table public.game_saves add constraint game_saves_game_check check (game in ('squish', 'dune', 'blackjack'));
do $$
declare d text;
begin
  d := pg_get_functiondef('public.game_record(text,bigint,integer,boolean)'::regprocedure);
  d := replace(d, 'p_game not in (''squish'', ''dune'')', 'p_game not in (''squish'', ''dune'', ''blackjack'')');
  execute d;
end $$;

create table if not exists public.bj_table (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chips bigint not null default 1000 check (chips >= 0),
  shoe int[] not null default '{}',
  player int[] not null default '{}',
  dealer int[] not null default '{}',
  wager bigint not null default 0,
  phase text not null default 'bet' check (phase in ('bet', 'play')),
  hands_played int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.bj_table enable row level security;
revoke all on table public.bj_table from anon, authenticated;

create or replace function public.bj_total(h int[]) returns int language plpgsql immutable as $$
declare t int := 0; aces int := 0; c int; r int;
begin
  foreach c in array coalesce(h, '{}') loop
    r := c % 13;
    if r = 0 then t := t + 11; aces := aces + 1; elsif r >= 9 then t := t + 10; else t := t + r + 1; end if;
  end loop;
  while t > 21 and aces > 0 loop t := t - 10; aces := aces - 1; end loop;
  return t;
end $$;

create or replace function public.bj_soft(h int[]) returns boolean language plpgsql immutable as $$
declare t int := 0; aces int := 0; c int; r int;
begin
  foreach c in array coalesce(h, '{}') loop
    r := c % 13;
    if r = 0 then t := t + 11; aces := aces + 1; elsif r >= 9 then t := t + 10; else t := t + r + 1; end if;
  end loop;
  while t > 21 and aces > 0 loop t := t - 10; aces := aces - 1; end loop;
  return aces > 0;
end $$;

create or replace function public.bj_new_shoe() returns int[] language sql volatile as $$
  select array_agg(c order by random()) from generate_series(0, 51) c, generate_series(1, 6) d
$$;

-- what the browser gets to see: the dealer's hole card stays hidden during play
create or replace function public.bj_view(t public.bj_table, p_result jsonb default null) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'chips', t.chips, 'wager', t.wager, 'phase', t.phase, 'player', to_jsonb(t.player),
    'dealer', to_jsonb(case when t.phase = 'play' and array_length(t.dealer, 1) >= 2 then array[t.dealer[1], -1] else t.dealer end),
    'result', p_result)
$$;

create or replace function public.bj_row() returns public.bj_table language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); t public.bj_table;
begin
  if uid is null then raise exception 'sign in first'; end if;
  insert into public.bj_table (user_id) values (uid) on conflict (user_id) do nothing;
  select * into t from public.bj_table where user_id = uid for update;
  return t;
end $$;

-- record chips for the leaderboard (best_score holds the current chip count for blackjack)
create or replace function public.bj_publish(uid uuid, chips bigint, played boolean) returns void language sql security definer set search_path = public as $$
  insert into public.game_stats as s (user_id, game, best_score, total_seconds, games_played, last_seen)
  values (uid, 'blackjack', least(chips, 100000000000), 0, case when played then 1 else 0 end, now())
  on conflict (user_id, game) do update set best_score = least(excluded.best_score, 100000000000),
    games_played = s.games_played + excluded.games_played, last_seen = now()
$$;

-- settle the hand on the table (dealer has finished): pays out and returns the view with the result
create or replace function public.bj_settle(t public.bj_table) returns jsonb language plpgsql security definer set search_path = public as $$
declare p int := public.bj_total(t.player); d int := public.bj_total(t.dealer);
        pb boolean := array_length(t.player, 1) = 2 and public.bj_total(t.player) = 21;
        db boolean := array_length(t.dealer, 1) = 2 and public.bj_total(t.dealer) = 21;
        pay bigint := 0; txt text; cls text := 'lose'; res jsonb;
begin
  if p > 21 then txt := 'Bust';
  elsif pb and db then txt := 'Both blackjack: push'; pay := t.wager; cls := 'push';
  elsif pb then txt := 'Blackjack!'; pay := floor(t.wager * 2.5); cls := 'win';
  elsif db then txt := 'Dealer has blackjack';
  elsif d > 21 then txt := 'Dealer busts. You win!'; pay := t.wager * 2; cls := 'win';
  elsif p > d then txt := 'You win!'; pay := t.wager * 2; cls := 'win';
  elsif p < d then txt := 'Dealer wins';
  else txt := 'Push'; pay := t.wager; cls := 'push'; end if;
  res := jsonb_build_object('text', txt, 'net', pay - t.wager, 'cls', cls, 'bust', p > 21);
  update public.bj_table set chips = chips + pay, wager = 0, phase = 'bet', hands_played = hands_played + 1, updated_at = now()
    where user_id = t.user_id returning * into t;
  perform public.bj_publish(t.user_id, t.chips, true);
  return public.bj_view(t, res);
end $$;

create or replace function public.bj_dealer_play(t public.bj_table) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  while public.bj_total(t.dealer) < 17 loop
    t.dealer := t.dealer || t.shoe[array_length(t.shoe, 1)];
    t.shoe := t.shoe[1:array_length(t.shoe, 1) - 1];
  end loop;
  update public.bj_table set dealer = t.dealer, shoe = t.shoe where user_id = t.user_id;
  return public.bj_settle(t);
end $$;

create or replace function public.bj_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.bj_table := public.bj_row();
begin
  perform public.bj_publish(t.user_id, t.chips, false);
  return public.bj_view(t);
end $$;

create or replace function public.bj_deal(p_bet bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.bj_table := public.bj_row(); n int;
begin
  if t.phase <> 'bet' then return public.bj_view(t); end if;
  if p_bet is null or p_bet < 5 or p_bet > t.chips then raise exception 'invalid bet'; end if;
  if coalesce(array_length(t.shoe, 1), 0) < 60 then t.shoe := public.bj_new_shoe(); end if;
  n := array_length(t.shoe, 1);
  -- player, dealer, player, dealer (cards come off the end of the shoe)
  t.player := array[t.shoe[n], t.shoe[n - 2]];
  t.dealer := array[t.shoe[n - 1], t.shoe[n - 3]];
  t.shoe := t.shoe[1:n - 4];
  t.chips := t.chips - p_bet; t.wager := p_bet; t.phase := 'play';
  update public.bj_table set chips = t.chips, wager = t.wager, phase = 'play', player = t.player, dealer = t.dealer, shoe = t.shoe, updated_at = now()
    where user_id = t.user_id;
  if public.bj_total(t.player) = 21 or public.bj_total(t.dealer) = 21 then return public.bj_settle(t); end if;
  return public.bj_view(t);
end $$;

create or replace function public.bj_hit() returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.bj_table := public.bj_row(); n int; p int;
begin
  if t.phase <> 'play' then return public.bj_view(t); end if;
  n := array_length(t.shoe, 1);
  t.player := t.player || t.shoe[n]; t.shoe := t.shoe[1:n - 1];
  update public.bj_table set player = t.player, shoe = t.shoe, updated_at = now() where user_id = t.user_id;
  p := public.bj_total(t.player);
  if p > 21 then return public.bj_settle(t); end if;
  if p = 21 then return public.bj_dealer_play(t); end if;
  return public.bj_view(t);
end $$;

create or replace function public.bj_stand() returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.bj_table := public.bj_row();
begin
  if t.phase <> 'play' then return public.bj_view(t); end if;
  return public.bj_dealer_play(t);
end $$;

create or replace function public.bj_double() returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.bj_table := public.bj_row(); n int;
begin
  if t.phase <> 'play' or array_length(t.player, 1) <> 2 or t.chips < t.wager then return public.bj_view(t); end if;
  n := array_length(t.shoe, 1);
  t.chips := t.chips - t.wager; t.wager := t.wager * 2;
  t.player := t.player || t.shoe[n]; t.shoe := t.shoe[1:n - 1];
  update public.bj_table set chips = t.chips, wager = t.wager, player = t.player, shoe = t.shoe, updated_at = now() where user_id = t.user_id;
  if public.bj_total(t.player) > 21 then return public.bj_settle(t); end if;
  return public.bj_dealer_play(t);
end $$;

-- below 1,000 chips (and not in the middle of a hand) you can top up by 1,000
create or replace function public.bj_topup() returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.bj_table := public.bj_row();
begin
  if t.phase = 'bet' and t.chips < 1000 then
    update public.bj_table set chips = chips + 1000, updated_at = now() where user_id = t.user_id returning * into t;
    perform public.bj_publish(t.user_id, t.chips, false);
  end if;
  return public.bj_view(t);
end $$;

revoke all on function public.bj_row(), public.bj_publish(uuid, bigint, boolean), public.bj_settle(public.bj_table), public.bj_dealer_play(public.bj_table),
  public.bj_state(), public.bj_deal(bigint), public.bj_hit(), public.bj_stand(), public.bj_double(), public.bj_topup() from public, anon, authenticated;
grant execute on function public.bj_state(), public.bj_deal(bigint), public.bj_hit(), public.bj_stand(), public.bj_double(), public.bj_topup() to authenticated;
