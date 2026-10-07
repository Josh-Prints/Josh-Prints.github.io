-- Beat tapper: per-account saving (Founder -> Tools -> Beat tapper). Applied to the live project.
--
-- Two tables, one row per account:
--   beat_tapper_profiles : that person's buttons (names, descriptions, keys, colours) + calibration offset
--   beat_tapper_takes    : the taps they recorded for a given song (song itself is never uploaded)
-- No table privileges for anon/authenticated. Everything goes through the functions below,
-- which only work for signed-in admins and only ever touch the caller's own rows.

create table if not exists public.beat_tapper_profiles (
  user_id uuid primary key,
  lanes jsonb not null default '[]'::jsonb,
  cal_ms integer not null default 0,
  compat boolean,
  updated_at timestamptz not null default now(),
  constraint beat_tapper_profiles_lanes_size check (pg_column_size(lanes) < 40000)
);
alter table public.beat_tapper_profiles enable row level security;
revoke all on table public.beat_tapper_profiles from anon, authenticated;

create table if not exists public.beat_tapper_takes (
  user_id uuid not null,
  song_key text not null,
  song_name text not null default '',
  duration_sec real not null default 0,
  lanes jsonb not null default '[]'::jsonb,
  taps jsonb not null default '[]'::jsonb,
  passes integer not null default 0,
  nudge_ms integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, song_key),
  constraint beat_tapper_takes_key_len check (length(song_key) <= 300),
  constraint beat_tapper_takes_size check (pg_column_size(taps) < 2000000 and pg_column_size(lanes) < 40000)
);
alter table public.beat_tapper_takes enable row level security;
revoke all on table public.beat_tapper_takes from anon, authenticated;

create or replace function public.beat_tapper_get_profile() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r public.beat_tapper_profiles;
begin
  if auth.uid() is null or not public.is_admin() then return null; end if;
  select * into r from public.beat_tapper_profiles where user_id = auth.uid();
  if not found then return null; end if;
  return jsonb_build_object('lanes', r.lanes, 'cal_ms', r.cal_ms, 'compat', r.compat, 'updated_at', r.updated_at);
end $$;

create or replace function public.beat_tapper_save_profile(p_lanes jsonb, p_cal_ms integer, p_compat boolean) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_lanes) is distinct from 'array' or jsonb_array_length(p_lanes) > 16 then raise exception 'bad lanes'; end if;
  insert into public.beat_tapper_profiles as t (user_id, lanes, cal_ms, compat, updated_at)
  values (auth.uid(), p_lanes, greatest(-500, least(500, coalesce(p_cal_ms, 0))), p_compat, now())
  on conflict (user_id) do update set lanes = excluded.lanes, cal_ms = excluded.cal_ms, compat = excluded.compat, updated_at = now();
end $$;

create or replace function public.beat_tapper_get_take(p_key text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r public.beat_tapper_takes;
begin
  if auth.uid() is null or not public.is_admin() then return null; end if;
  select * into r from public.beat_tapper_takes where user_id = auth.uid() and song_key = left(coalesce(p_key, ''), 300);
  if not found then return null; end if;
  return jsonb_build_object('song_name', r.song_name, 'duration_sec', r.duration_sec, 'lanes', r.lanes, 'taps', r.taps, 'passes', r.passes, 'nudge_ms', r.nudge_ms, 'updated_at', r.updated_at);
end $$;

create or replace function public.beat_tapper_save_take(p_key text, p_name text, p_duration real, p_lanes jsonb, p_taps jsonb, p_passes integer, p_nudge_ms integer) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(p_key, '') = '' or length(p_key) > 300 then raise exception 'bad key'; end if;
  if jsonb_typeof(p_lanes) is distinct from 'array' or jsonb_array_length(p_lanes) > 16 then raise exception 'bad lanes'; end if;
  if jsonb_typeof(p_taps) is distinct from 'array' or jsonb_array_length(p_taps) > 20000 then raise exception 'bad taps'; end if;
  insert into public.beat_tapper_takes as t (user_id, song_key, song_name, duration_sec, lanes, taps, passes, nudge_ms, updated_at)
  values (auth.uid(), p_key, left(coalesce(p_name, ''), 200), coalesce(p_duration, 0), p_lanes, p_taps, greatest(0, coalesce(p_passes, 0)), coalesce(p_nudge_ms, 0), now())
  on conflict (user_id, song_key) do update set song_name = excluded.song_name, duration_sec = excluded.duration_sec, lanes = excluded.lanes,
    taps = excluded.taps, passes = excluded.passes, nudge_ms = excluded.nudge_ms, updated_at = now();
end $$;

revoke all on function public.beat_tapper_get_profile() from public, anon;
revoke all on function public.beat_tapper_save_profile(jsonb, integer, boolean) from public, anon;
revoke all on function public.beat_tapper_get_take(text) from public, anon;
revoke all on function public.beat_tapper_save_take(text, text, real, jsonb, jsonb, integer, integer) from public, anon;
grant execute on function public.beat_tapper_get_profile() to authenticated;
grant execute on function public.beat_tapper_save_profile(jsonb, integer, boolean) to authenticated;
grant execute on function public.beat_tapper_get_take(text) to authenticated;
grant execute on function public.beat_tapper_save_take(text, text, real, jsonb, jsonb, integer, integer) to authenticated;
