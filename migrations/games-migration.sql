-- Games: saved progress and leaderboards (signed-in players only). Applied to the live project.
--
-- game_saves  : one in-progress game per player per game (players read/write only their own row).
-- game_stats  : best score, total play time and games played. Written only through game_record(),
--               which caps what a browser can claim; read through game_leaderboard() / game_my_stats().
-- Leaderboard names are first name + last initial from customer_profiles ("Player" if none).

create table if not exists public.game_saves (
  user_id uuid not null references auth.users(id) on delete cascade,
  game text not null check (game in ('squish')),
  state jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, game),
  constraint game_saves_size check (pg_column_size(state) < 60000)
);
alter table public.game_saves enable row level security;
revoke all on table public.game_saves from anon;
grant select, insert, update, delete on table public.game_saves to authenticated;
drop policy if exists game_saves_own on public.game_saves;
create policy game_saves_own on public.game_saves for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.game_stats (
  user_id uuid not null references auth.users(id) on delete cascade,
  game text not null check (game in ('squish')),
  best_score bigint not null default 0,
  total_seconds bigint not null default 0,
  games_played int not null default 0,
  last_seen timestamptz,
  primary key (user_id, game)
);
alter table public.game_stats enable row level security;
revoke all on table public.game_stats from anon, authenticated;

create or replace function public.game_player_name(p_user uuid) returns text
language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select case when cardinality(parts) > 1 then parts[1] || ' ' || left(parts[cardinality(parts)], 1) || '.' else parts[1] end
       from (select regexp_split_to_array(trim(full_name), '\s+') parts from public.customer_profiles where id = p_user and coalesce(trim(full_name), '') <> '') x),
    'Player');
$$;
revoke all on function public.game_player_name(uuid) from public, anon, authenticated;

-- p_seconds: play time since the last call. Capped by the real time that has passed (+30s slack, max 10 min a call).
create or replace function public.game_record(p_game text, p_score bigint, p_seconds int, p_finished boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); prev public.game_stats; allowed int; add_s int;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if p_game not in ('squish') then raise exception 'unknown game'; end if;
  select * into prev from public.game_stats where user_id = uid and game = p_game;
  allowed := case when prev.last_seen is null then 600 else least(600, extract(epoch from now() - prev.last_seen)::int + 30) end;
  add_s := least(greatest(coalesce(p_seconds, 0), 0), allowed);
  insert into public.game_stats as s (user_id, game, best_score, total_seconds, games_played, last_seen)
  values (uid, p_game, least(greatest(coalesce(p_score, 0), 0), 100000000), add_s, case when p_finished then 1 else 0 end, now())
  on conflict (user_id, game) do update set
    best_score = greatest(s.best_score, excluded.best_score),
    total_seconds = s.total_seconds + excluded.total_seconds,
    games_played = s.games_played + excluded.games_played,
    last_seen = now();
  return public.game_my_stats(p_game);
end $$;

create or replace function public.game_my_stats(p_game text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare uid uuid := auth.uid(); s public.game_stats;
begin
  if uid is null then return null; end if;
  select * into s from public.game_stats where user_id = uid and game = p_game;
  if not found then return jsonb_build_object('best_score', 0, 'total_seconds', 0, 'games_played', 0, 'name', public.game_player_name(uid)); end if;
  return jsonb_build_object('best_score', s.best_score, 'total_seconds', s.total_seconds, 'games_played', s.games_played,
    'name', public.game_player_name(uid),
    'score_rank', (select count(*) + 1 from public.game_stats o where o.game = p_game and o.best_score > s.best_score),
    'time_rank', (select count(*) + 1 from public.game_stats o where o.game = p_game and o.total_seconds > s.total_seconds));
end $$;

-- p_kind: 'score' or 'time'. Anyone can view.
create or replace function public.game_leaderboard(p_game text, p_kind text, p_limit int default 10) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('rank', rnk, 'name', public.game_player_name(user_id), 'value', val, 'me', user_id = auth.uid()) order by rnk), '[]'::jsonb)
  from (
    select user_id, val, rank() over (order by val desc) rnk
    from (select user_id, case when p_kind = 'time' then total_seconds else best_score end val from public.game_stats where game = p_game) t
    where val > 0
    order by val desc
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
  ) r;
$$;

revoke all on function public.game_record(text, bigint, int, boolean) from public, anon;
revoke all on function public.game_my_stats(text) from public, anon;
grant execute on function public.game_record(text, bigint, int, boolean) to authenticated;
grant execute on function public.game_my_stats(text) to authenticated;
grant execute on function public.game_leaderboard(text, text, int) to anon, authenticated;

-- Dune (added later): allow 'dune' rows and scores.
alter table public.game_stats drop constraint if exists game_stats_game_check;
alter table public.game_stats add constraint game_stats_game_check check (game in ('squish', 'dune'));
alter table public.game_saves drop constraint if exists game_saves_game_check;
alter table public.game_saves add constraint game_saves_game_check check (game in ('squish', 'dune'));
-- game_record: the game check reads  if p_game not in ('squish', 'dune') then raise exception 'unknown game'; end if;
