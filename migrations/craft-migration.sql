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
