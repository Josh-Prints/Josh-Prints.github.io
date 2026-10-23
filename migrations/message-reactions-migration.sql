-- Message reactions (thumbs up / down, heart, fire, or any one emoji) on every chat: order chats (customer via the order
-- link + admins) and the admin team chat. UI: msg-actions.js (hold a message -> emoji row; chips under the bubble).
-- Applied in pieces (one big statement timed out through the MCP tool).

set lock_timeout = '5s';
create table if not exists public.message_reactions(
  id uuid primary key default gen_random_uuid(),
  chat text not null check (chat in ('order','admin')),
  message_id uuid not null,
  reactor text not null,          -- an admin's user id, or 'customer' (order chats, via the order link)
  reactor_name text,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  unique (chat, message_id, reactor, emoji)
);
create index if not exists message_reactions_msg on public.message_reactions(chat, message_id);
alter table public.message_reactions enable row level security;
revoke all on public.message_reactions from anon, authenticated;
create policy emergency_lock on public.message_reactions as restrictive for all using ((not public.site_emergency_active()) or public.is_founder());

create or replace function public.reaction_ok(p text) returns boolean language sql immutable as $$
  select p is not null and char_length(p) between 1 and 16 and p !~ '[[:alnum:][:space:]<>&"''`\\/]'
$$;
revoke all on function public.reaction_ok(text) from public, anon, authenticated;

-- toggle_order_reaction(order, message, emoji): admins react as themselves, anyone else with the order link as 'customer';
-- max 6 different emoji per person per message. get_order_reactions(order) -> (message_id, emoji, n, mine, names).
-- toggle_admin_reaction(message, emoji) / get_admin_reactions(): admins only.
-- (full bodies as applied: see the live functions; writes call assert_site_open(), reads return nothing in emergency mode)
alter function public.reaction_ok(text) set search_path = public;
