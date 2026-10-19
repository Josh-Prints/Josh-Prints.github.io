-- Founder announcements: a founder posts a message and every open page shows it as a notification
-- (update-check.js polls current_announcement() every 8 seconds). Each visitor sees an announcement once.
--   theme      blue | green | purple | red | orange | gold | dark | rainbow
--   show_secs  how long the notification stays on screen (0 = until closed)
--   ends_at    after this, visitors who haven't seen it yet won't get it

create table if not exists public.announcements (
  id bigserial primary key,
  title text,
  body text not null,
  theme text not null default 'blue',
  show_secs int not null default 8,
  ends_at timestamptz not null,
  stopped boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;
revoke all on public.announcements from public, anon, authenticated;

create or replace function public.ann_json(a public.announcements) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'theme', a.theme, 'show_secs', a.show_secs,
    'ends_at', a.ends_at, 'stopped', a.stopped, 'created_at', a.created_at);
$$;

-- the newest live announcement, for every visitor
create or replace function public.current_announcement() returns jsonb language sql stable security definer set search_path = public as $$
  select public.ann_json(a) from public.announcements a where not a.stopped and a.ends_at > now() order by a.id desc limit 1;
$$;

create or replace function public.founder_announce(p_title text, p_body text, p_theme text, p_show_secs int, p_live_mins int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.announcements;
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'write a message'; end if;
  if p_theme not in ('blue', 'green', 'purple', 'red', 'orange', 'gold', 'dark', 'rainbow') then raise exception 'unknown theme'; end if;
  insert into public.announcements (title, body, theme, show_secs, ends_at, created_by)
  values (nullif(left(btrim(coalesce(p_title, '')), 80), ''), left(btrim(p_body), 400), p_theme,
          least(greatest(coalesce(p_show_secs, 8), 0), 600), now() + make_interval(mins => least(greatest(coalesce(p_live_mins, 60), 1), 60 * 24 * 30)), auth.uid())
  returning * into a;
  return public.ann_json(a);
end $$;

create or replace function public.founder_announcements() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  return coalesce((select jsonb_agg(public.ann_json(a) order by a.id desc) from (select * from public.announcements order by id desc limit 20) a), '[]'::jsonb);
end $$;

create or replace function public.founder_announce_stop(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  update public.announcements set stopped = true where id = p_id;
end $$;

revoke all on function public.ann_json(public.announcements), public.current_announcement(), public.founder_announce(text, text, text, int, int),
  public.founder_announcements(), public.founder_announce_stop(bigint) from public, anon, authenticated;
grant execute on function public.current_announcement() to anon, authenticated;
grant execute on function public.founder_announce(text, text, text, int, int), public.founder_announcements(), public.founder_announce_stop(bigint) to authenticated;

-- ---------- custom styles and editing ----------
-- style: everything about the look (colours, font, size, position, animation, button...), read by update-check.js.
-- rev goes up when an edit should be shown again to people who already saw it.
alter table public.announcements add column if not exists style jsonb not null default '{}'::jsonb;
alter table public.announcements add column if not exists rev int not null default 1;
alter table public.announcements add column if not exists updated_at timestamptz;

create or replace function public.ann_json(a public.announcements) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', a.id, 'rev', a.rev, 'title', a.title, 'body', a.body, 'theme', a.theme, 'style', a.style, 'show_secs', a.show_secs,
    'ends_at', a.ends_at, 'stopped', a.stopped, 'created_at', a.created_at, 'updated_at', a.updated_at);
$$;

-- every live announcement, newest first (each visitor sees each id/rev once)
create or replace function public.live_announcements() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.ann_json(a) order by a.id desc), '[]'::jsonb)
  from (select * from public.announcements where not stopped and ends_at > now() order by id desc limit 5) a;
$$;

create or replace function public.ann_check(p_body text, p_style jsonb) returns void language plpgsql immutable as $$
begin
  if coalesce(btrim(p_body), '') = '' then raise exception 'write a message'; end if;
  if p_style is not null and (jsonb_typeof(p_style) <> 'object' or length(p_style::text) > 3000) then raise exception 'bad style'; end if;
  if coalesce(p_style->>'btn_url', '') <> '' and p_style->>'btn_url' !~ '^(https?://|/)' then raise exception 'links must start with https:// or /'; end if;
end $$;

create or replace function public.founder_announce(p_title text, p_body text, p_style jsonb, p_show_secs int, p_live_mins int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.announcements;
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  perform public.ann_check(p_body, p_style);
  insert into public.announcements (title, body, theme, style, show_secs, ends_at, created_by)
  values (nullif(left(btrim(coalesce(p_title, '')), 80), ''), left(btrim(p_body), 600), 'custom', coalesce(p_style, '{}'::jsonb),
          least(greatest(coalesce(p_show_secs, 8), 0), 3600), now() + make_interval(mins => least(greatest(coalesce(p_live_mins, 60), 1), 60 * 24 * 90)), auth.uid())
  returning * into a;
  return public.ann_json(a);
end $$;

-- edit one; p_reshow shows it again to people who already saw it. Saving also makes a stopped one live again.
create or replace function public.founder_announce_update(p_id bigint, p_title text, p_body text, p_style jsonb, p_show_secs int, p_live_mins int, p_reshow boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.announcements;
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  perform public.ann_check(p_body, p_style);
  update public.announcements set title = nullif(left(btrim(coalesce(p_title, '')), 80), ''), body = left(btrim(p_body), 600), theme = 'custom',
    style = coalesce(p_style, '{}'::jsonb), show_secs = least(greatest(coalesce(p_show_secs, 8), 0), 3600),
    ends_at = now() + make_interval(mins => least(greatest(coalesce(p_live_mins, 60), 1), 60 * 24 * 90)),
    stopped = false, rev = rev + case when p_reshow then 1 else 0 end, updated_at = now()
  where id = p_id returning * into a;
  if a.id is null then raise exception 'not found'; end if;
  return public.ann_json(a);
end $$;

revoke all on function public.live_announcements(), public.ann_check(text, jsonb), public.founder_announce(text, text, jsonb, int, int),
  public.founder_announce_update(bigint, text, text, jsonb, int, int, boolean) from public, anon, authenticated;
grant execute on function public.live_announcements() to anon, authenticated;
grant execute on function public.founder_announce(text, text, jsonb, int, int), public.founder_announce_update(bigint, text, text, jsonb, int, int, boolean) to authenticated;
