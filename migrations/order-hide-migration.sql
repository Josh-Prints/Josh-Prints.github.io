-- Customers can remove an order from their own "My orders" list (swipe left, Delete). It's only hidden for
-- them: the order itself stays, admins see "Removed by customer", and the customer can bring it back with
-- "Show deleted".
alter table public.orders add column if not exists customer_hidden_at timestamptz;

create or replace function public.set_my_order_hidden(p_id uuid, p_hidden boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  update public.orders set customer_hidden_at = case when p_hidden then now() else null end
  where id = p_id and user_id = auth.uid();
  return found;
end $$;
revoke all on function public.set_my_order_hidden(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_my_order_hidden(uuid, boolean) to authenticated;
