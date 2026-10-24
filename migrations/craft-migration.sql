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
