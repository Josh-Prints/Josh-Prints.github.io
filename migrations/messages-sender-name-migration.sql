-- Customers saw every admin message labelled "Josh" because get_order_messages() did not return the sender's name.
-- This variant returns sender_name too (same access as get_order_messages). Applied to the live project.
create or replace function public.get_order_messages_named(p_order_id uuid)
returns table(id uuid, sender text, sender_name text, body text, file_path text, file_name text, files jsonb, created_at timestamp with time zone)
language sql security definer set search_path to 'public' as $$
  select id, sender, sender_name, body, file_path, file_name, files, created_at
  from messages
  where order_id = p_order_id
  order by created_at asc;
$$;
