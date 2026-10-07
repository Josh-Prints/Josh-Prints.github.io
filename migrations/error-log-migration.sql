-- Site-wide error log (founder "Errors" tab). Applied to the live project.
--
-- Visitors' browsers report errors through log_client_error() (see /error-log.js).
-- Only founders can read them, through the founder_error_* functions.
-- No table privileges are granted to anon/authenticated: everything goes through functions.

create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code text not null,                 -- stable per kind of error + page, e.g. E-8FNRA
  kind text not null,                 -- js | promise | http | network | resource
  message text not null default '',
  stack text,
  page text not null default '',
  url_detail text,                    -- path + query keys only; values redacted, ids cut to 8 chars
  referrer text,
  user_id uuid,                       -- set by the server from the login, never by the browser
  visitor_id text not null,           -- random per browser; lets repeats from the same person be spotted
  ua text,
  viewport text,
  breadcrumbs jsonb not null default '[]'::jsonb,   -- last few clicks/page views/API calls (no typed text)
  extra jsonb not null default '{}'::jsonb,
  resolved_at timestamptz
);
alter table public.client_errors enable row level security;
revoke all on table public.client_errors from anon, authenticated;
create index if not exists client_errors_code_idx on public.client_errors (code, created_at desc);
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);
create index if not exists client_errors_visitor_idx on public.client_errors (visitor_id, created_at desc);

-- Anyone may report; junk is dropped silently and floods are capped (20/min per visitor, 3000/hour site-wide).
create or replace function public.log_client_error(p jsonb) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_code text; v_vid text; v_n int; v_bc jsonb; v_kind text; v_extra jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' then return; end if;
  v_code := left(coalesce(p->>'code', ''), 12);
  v_vid := left(coalesce(p->>'visitor', ''), 64);
  if v_code !~ '^E-[0-9A-Z]{4,8}$' or length(v_vid) < 8 then return; end if;
  select count(*) into v_n from public.client_errors where visitor_id = v_vid and created_at > now() - interval '1 minute';
  if v_n >= 20 then return; end if;
  select count(*) into v_n from public.client_errors where created_at > now() - interval '1 hour';
  if v_n >= 3000 then return; end if;
  v_kind := left(coalesce(p->>'kind', 'js'), 16);
  if v_kind not in ('js', 'promise', 'http', 'network', 'resource') then v_kind := 'js'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('t', left(x.b->>'t', 16), 'k', left(x.b->>'k', 12), 'd', left(x.b->>'d', 160)) order by x.i), '[]'::jsonb)
    into v_bc
  from (select e.b, e.i from jsonb_array_elements(case when jsonb_typeof(p->'bc') = 'array' then p->'bc' else '[]'::jsonb end) with ordinality as e(b, i)
        where jsonb_typeof(e.b) = 'object' order by e.i desc limit 25) x;
  v_extra := case when jsonb_typeof(p->'extra') = 'object' and length((p->'extra')::text) <= 1000 then p->'extra' else '{}'::jsonb end;
  insert into public.client_errors (code, kind, message, stack, page, url_detail, referrer, user_id, visitor_id, ua, viewport, breadcrumbs, extra)
  values (v_code, v_kind, left(coalesce(p->>'message', ''), 500), left(p->>'stack', 3000), left(coalesce(p->>'page', ''), 200),
          left(p->>'url', 300), left(p->>'ref', 200), auth.uid(), v_vid, left(p->>'ua', 300), left(p->>'vp', 30), v_bc, v_extra);
exception when others then
  return;
end;
$$;

-- Founder-only reads / actions. See the live definitions for founder_error_summary and
-- founder_error_occurrences (grouped per code with distinct people/devices; per-occurrence detail).
-- founder_error_resolve(code) marks a code resolved; it reappears if the error happens again.

revoke all on function public.log_client_error(jsonb) from public;
grant execute on function public.log_client_error(jsonb) to anon, authenticated, service_role;
revoke all on function public.founder_error_summary(int) from public, anon;
revoke all on function public.founder_error_occurrences(text, text, int) from public, anon;
revoke all on function public.founder_error_resolve(text) from public, anon;
grant execute on function public.founder_error_summary(int) to authenticated, service_role;
grant execute on function public.founder_error_occurrences(text, text, int) to authenticated, service_role;
grant execute on function public.founder_error_resolve(text) to authenticated, service_role;

-- Retention (NOT yet applied: deleting needs an explicit confirmation in the database tool).
-- Run once to keep the last 30 days only:
--   select cron.schedule('purge-client-errors', '17 3 * * *',
--     $$ delete from public.client_errors where created_at < now() - interval '30 days' $$);
