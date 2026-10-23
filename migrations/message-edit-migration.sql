-- Edit / delete messages in every chat: the customer order page (order.html), the order chat on admin/order.html and the
-- admin team chat (admin/index.html). /msg-actions.js draws the buttons; these functions decide who may change what:
--   order messages: the customer (anyone with the order link) their own, an admin their own, a founder any message
--   admin chat:     your own, or any as a founder
-- Deleting keeps the message's place in the thread ("Message deleted") but removes its text and files. Edits show "(edited)".
-- Both are refused while emergency mode is on (order messages).

alter table public.messages add column if not exists edited_at timestamptz, add column if not exists deleted_at timestamptz;
alter table public.admin_messages add column if not exists edited_at timestamptz, add column if not exists deleted_at timestamptz;
alter table public.messages drop constraint if exists messages_has_content,
  add constraint messages_has_content check (deleted_at is not null or body is not null or file_path is not null);

-- the customer's order page (a deleted message keeps only its place in the thread)
create or replace function public.get_order_messages_v2(p_order_id uuid) returns table(id uuid, sender text, sender_name text, body text, file_path text, file_name text, files jsonb, created_at timestamptz, edited_at timestamptz, deleted boolean)
language sql stable security definer set search_path = public as $$
  select m.id, m.sender, m.sender_name, case when m.deleted_at is null then m.body end, case when m.deleted_at is null then m.file_path end,
    case when m.deleted_at is null then m.file_name end, case when m.deleted_at is null then m.files else '[]'::jsonb end, m.created_at, m.edited_at, m.deleted_at is not null
  from public.messages m
  where m.order_id = p_order_id and not public.site_emergency_active()
  order by m.created_at asc;
$$;

create or replace function public.order_message_can_change(m public.messages, p_order_id uuid) returns boolean language sql stable security definer set search_path = public as $$
  select m.order_id = p_order_id and (
    (m.sender = 'customer' and not public.is_admin())
    or (m.sender <> 'customer' and public.can_edit() and (m.sender_id = auth.uid() or public.is_founder()))
    or (public.is_founder() and not public.is_suspended()));
$$;

create or replace function public.edit_order_message(p_order_id uuid, p_id uuid, p_body text) returns void language plpgsql security definer set search_path = public as $$
declare m public.messages;
begin
  perform public.assert_site_open();
  select * into m from public.messages where id = p_id;
  if m.id is null or m.deleted_at is not null or not public.order_message_can_change(m, p_order_id) then raise exception 'Can''t edit this message'; end if;
  p_body := nullif(btrim(coalesce(p_body, '')), '');
  if p_body is null and jsonb_array_length(coalesce(m.files, '[]'::jsonb)) = 0 and m.file_path is null then raise exception 'Message can''t be empty'; end if;
  if length(coalesce(p_body, '')) > 5000 then raise exception 'Message is too long (5000 characters max)'; end if;
  update public.messages set body = p_body, edited_at = now() where id = p_id;
end $$;

create or replace function public.delete_order_message(p_order_id uuid, p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare m public.messages;
begin
  perform public.assert_site_open();
  select * into m from public.messages where id = p_id;
  if m.id is null or not public.order_message_can_change(m, p_order_id) then raise exception 'Can''t delete this message'; end if;
  update public.messages set deleted_at = coalesce(deleted_at, now()), body = null, file_path = null, file_name = null, files = '[]'::jsonb where id = p_id;
end $$;

create or replace function public.edit_admin_message(p_id uuid, p_body text) returns void language plpgsql security definer set search_path = public as $$
declare m public.admin_messages;
begin
  select * into m from public.admin_messages where id = p_id;
  if m.id is null or m.deleted_at is not null or not public.can_edit() or not (m.sender_id = auth.uid() or public.is_founder()) then raise exception 'Can''t edit this message'; end if;
  p_body := nullif(btrim(coalesce(p_body, '')), '');
  if p_body is null and jsonb_array_length(coalesce(m.files, '[]'::jsonb)) = 0 and m.file_path is null then raise exception 'Message can''t be empty'; end if;
  if length(coalesce(p_body, '')) > 5000 then raise exception 'Message is too long (5000 characters max)'; end if;
  update public.admin_messages set body = p_body, edited_at = now() where id = p_id;
end $$;

create or replace function public.delete_admin_message(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare m public.admin_messages;
begin
  select * into m from public.admin_messages where id = p_id;
  if m.id is null or not public.can_edit() or not (m.sender_id = auth.uid() or public.is_founder()) then raise exception 'Can''t delete this message'; end if;
  update public.admin_messages set deleted_at = coalesce(deleted_at, now()), body = null, file_path = null, file_name = null, files = '[]'::jsonb where id = p_id;
end $$;

revoke all on function public.get_order_messages_v2(uuid), public.order_message_can_change(public.messages, uuid), public.edit_order_message(uuid, uuid, text),
  public.delete_order_message(uuid, uuid), public.edit_admin_message(uuid, text), public.delete_admin_message(uuid) from public, anon, authenticated;
grant execute on function public.get_order_messages_v2(uuid), public.edit_order_message(uuid, uuid, text), public.delete_order_message(uuid, uuid) to anon, authenticated;
grant execute on function public.edit_admin_message(uuid, text), public.delete_admin_message(uuid) to authenticated;
