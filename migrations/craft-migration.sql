-- Vox Craft (craft.html, edge function supabase/functions/craft): an Infinite Craft style game. Claude (Haiku) decides
-- what two items make; every pair is worked out once and saved here, so it's the same for everyone.
set lock_timeout = '5s';
create table if not exists public.craft_items(
  name_key text primary key,              -- lower-case name
  name text not null,
  first_by uuid,                          -- signed-in player who discovered it first (null = base item or a guest)
  created_at timestamptz not null default now()
);
create table if not exists public.craft_recipes(
  a text not null, b text not null,       -- the two item keys, a <= b
  result_key text not null references public.craft_items(name_key),
  created_at timestamptz not null default now(),
  primary key (a, b)
);
create table if not exists public.craft_log(id bigserial primary key, at timestamptz not null default now(), who text);   -- rate limit for new pairs
create index if not exists craft_log_at on public.craft_log(at);
alter table public.craft_items enable row level security;
alter table public.craft_recipes enable row level security;
alter table public.craft_log enable row level security;
revoke all on public.craft_items, public.craft_recipes, public.craft_log from anon, authenticated;
insert into public.craft_items(name_key, name) values ('water','Water'),('fire','Fire'),('wind','Wind'),('earth','Earth') on conflict do nothing;

-- which model made each recipe ('groq:llama-3.1-8b-instant', 'joined' when every model failed)
alter table public.craft_recipes add column if not exists made_by text;
insert into public.private_config(key, value) values ('craft_provider','groq') on conflict (key) do nothing;

-- queue + key rotation: a new pair being worked out (other players wait for it), and Groq keys resting after a rate limit
create table if not exists public.craft_pending(a text not null, b text not null, started_at timestamptz not null default now(), primary key (a, b));
create table if not exists public.craft_key_wait(key_id text primary key, until timestamptz not null);   -- key_id = first 8 bytes of sha256(key)
alter table public.craft_pending enable row level security;
alter table public.craft_key_wait enable row level security;
revoke all on public.craft_pending, public.craft_key_wait from anon, authenticated;

-- Leaderboard: most first discoveries (craft_items.first_by; guests get no credit)
create or replace function public.craft_leaderboard(p_limit integer default 20)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'total', (select count(*) from public.craft_items),
    'mine', (select count(*) from public.craft_items where auth.uid() is not null and first_by = auth.uid()),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', rnk, 'name', public.game_player_name(first_by), 'value', n, 'me', first_by = auth.uid()) order by rnk)
      from (select first_by, n, rank() over (order by n desc) rnk
            from (select first_by, count(*) n from public.craft_items where first_by is not null group by first_by) t
            order by n desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) r), '[]'::jsonb));
$$;
revoke all on function public.craft_leaderboard(integer) from public, anon, authenticated;
grant execute on function public.craft_leaderboard(integer) to anon, authenticated;

-- Every known pair for the page (all, or new since p_since), so known pairs combine instantly without the edge function
create or replace function public.craft_known(p_since timestamptz default null)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('at', now(), 'r', coalesce(jsonb_agg(jsonb_build_array(r.a, r.b, coalesce(i.name, r.result_key))), '[]'::jsonb))
  from public.craft_recipes r left join public.craft_items i on i.name_key = r.result_key
  where p_since is null or r.created_at > p_since - interval '5 seconds';
$$;
revoke all on function public.craft_known(timestamptz) from public, anon, authenticated;
grant execute on function public.craft_known(timestamptz) to anon, authenticated;

-- Real Infinite Craft recipes (~205k pairs) so results match the real game; Groq only answers pairs not in here.
-- Loaded 2026-10-24 from https://icscdn.vantezzen.io/recipes.json (infinite-craft-solver dataset: {items: [...], recipes: [[i, j, k], ...]})
-- via net.http_get, keys lower-cased + sorted like craft_recipes, no word filter (the user asked).
create table if not exists public.craft_ic (a text not null, b text not null, result text not null, primary key (a, b));
alter table public.craft_ic enable row level security;
revoke all on public.craft_ic from anon, authenticated;
-- load (resp = the net._http_response id of the download):
-- with j as (select content::jsonb c from net._http_response where id = <resp>),
-- it as (select (ord - 1)::int i, v #>> '{}' name from j, jsonb_array_elements(j.c->'items') with ordinality t(v, ord)),
-- r as (select (x->>0)::int a, (x->>1)::int b, (x->>2)::int c from j, jsonb_array_elements(j.c->'recipes') x),
-- n as (select lower(regexp_replace(trim(ia.name), '\s+', ' ', 'g')) ka, lower(regexp_replace(trim(ib.name), '\s+', ' ', 'g')) kb,
--        regexp_replace(trim(ic.name), '\s+', ' ', 'g') res from r join it ia on ia.i = r.a join it ib on ib.i = r.b join it ic on ic.i = r.c)
-- insert into public.craft_ic (a, b, result) select least(ka, kb), greatest(ka, kb), res from n where res <> '' and length(res) <= 40 on conflict do nothing;
-- Existing pairs were switched to the real answer: update craft_recipes set result_key = lower(ic.result), made_by = 'ic', created_at = now() ...
