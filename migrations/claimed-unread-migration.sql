-- Yellow "unread" icon on your claimed orders (admin/index.html) + toast / system notification.
-- Read state lives on the server so it follows an admin across devices: admin/order.html calls admin_mark_order_read
-- while the order is open (at most every 15 s); my_unread_claimed() lists my claimed, not-deleted orders with customer
-- messages newer than both my last read and the last admin / shop reply.

set lock_timeout = '5s';
create table if not exists public.admin_order_reads(
  admin_id uuid not null,
  order_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (admin_id, order_id)
);
alter table public.admin_order_reads enable row level security;
revoke all on public.admin_order_reads from anon, authenticated;

create or replace function public.admin_mark_order_read(p_order_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then return; end if;
  insert into public.admin_order_reads(admin_id, order_id, read_at) values (auth.uid(), p_order_id, now())
  on conflict (admin_id, order_id) do update set read_at = now();
end $$;

create or replace function public.my_unread_claimed() returns table(order_id uuid, full_name text, n int, last_at timestamptz, last_body text)
language sql stable security definer set search_path to 'public' as $$
  select o.id, o.full_name, count(m.*)::int, max(m.created_at),
    (array_agg(coalesce(nullif(m.body, ''), case when m.file_path is not null or jsonb_array_length(coalesce(m.files, '[]'::jsonb)) > 0 then 'Sent a file' end) order by m.created_at desc))[1]
  from public.orders o
  join public.messages m on m.order_id = o.id and m.sender = 'customer' and m.deleted_at is null
  left join public.admin_order_reads r on r.admin_id = auth.uid() and r.order_id = o.id
  where public.is_admin() and o.claimed_by_id = auth.uid() and not coalesce(o.deleted, false) and not public.site_emergency_active()
    and m.created_at > greatest(coalesce(r.read_at, '-infinity'),
      coalesce((select max(a.created_at) from public.messages a where a.order_id = o.id and a.sender <> 'customer' and a.deleted_at is null), '-infinity'))
  group by o.id, o.full_name
  order by max(m.created_at) desc
$$;
revoke all on function public.admin_mark_order_read(uuid) from public, anon, authenticated;
revoke all on function public.my_unread_claimed() from public, anon, authenticated;
grant execute on function public.admin_mark_order_read(uuid) to authenticated;
grant execute on function public.my_unread_claimed() to authenticated;
