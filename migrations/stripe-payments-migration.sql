-- Online card payments with Stripe Checkout (edge function: stripe-pay).
-- The customer's order page asks stripe-pay for a Checkout link for the quoted amount; after paying, Stripe sends
-- them back and stripe-pay checks the session with Stripe before marking the order paid. The secret key lives only
-- in the edge function's STRIPE_SECRET_KEY secret.
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists paid_amount numeric;
alter table public.orders add column if not exists paid_method text;          -- 'card' (Stripe), 'cash', 'payid'
alter table public.orders add column if not exists stripe_session_id text;
alter table public.orders add column if not exists stripe_payment_intent text;

-- what the order page needs to show the Pay button / paid badge. EXPERIMENTAL: founders only for now
-- (everyone else gets null, so the page shows nothing); stripe-pay checks the same.
create or replace function public.get_order_payment(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_founder() then (
    select jsonb_build_object('paid_at', paid_at, 'paid_amount', paid_amount, 'paid_method', paid_method,
      'can_pay', paid_at is null and not deleted and quote_amount >= 0.5 and status in ('quoted', 'printing', 'completed'),
      'amount', quote_amount)
    from public.orders where id = p_id) end;
$$;

-- founders: mark an order paid by cash / PayID, or clear it
create or replace function public.admin_set_order_paid(p_id uuid, p_method text, p_paid boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_founder() then raise exception 'founders only'; end if;
  if p_paid then
    if p_method not in ('cash', 'payid', 'card') then raise exception 'pick a payment method'; end if;
    update public.orders set paid_at = coalesce(paid_at, now()), paid_amount = coalesce(paid_amount, quote_amount), paid_method = p_method where id = p_id;
  else
    update public.orders set paid_at = null, paid_amount = null, paid_method = null where id = p_id;
  end if;
  return public.get_order_payment(p_id);
end $$;

revoke all on function public.get_order_payment(uuid), public.admin_set_order_paid(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.get_order_payment(uuid) to anon, authenticated;
grant execute on function public.admin_set_order_paid(uuid, text, boolean) to authenticated;
