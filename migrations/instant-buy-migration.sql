-- Instant buy: designs a founder ticks as "Instant buy" skip the quote. Ordering one takes the customer straight to
-- checkout on the order page (cash on pickup, or card / Apple Pay through stripe-pay), and the order's progress bar
-- is New -> Printing -> Done -> Sold.
--   designs.instant_buy   the tick box (only works with a price set)
--   orders.instant_buy    set by the server when the order is placed, never by the customer
--   orders.pay_choice     null until they choose: 'cash' (pay on pickup) or 'card' (paid online)
-- The price is the design's price, copied by the server at insert time.

alter table public.designs add column if not exists instant_buy boolean not null default false;
alter table public.orders add column if not exists instant_buy boolean not null default false;
alter table public.orders add column if not exists pay_choice text;

-- runs after the main insert guard: instant orders get the design's price as their quote
create or replace function public.instant_buy_order_insert() returns trigger language plpgsql security definer set search_path = public as $$
declare d public.designs;
begin
  new.instant_buy := false; new.pay_choice := null;
  if new.design_id is not null then
    select * into d from public.designs where id = new.design_id;
    if d.instant_buy and d.price is not null and d.price >= 0.5 then
      new.instant_buy := true;
      new.quote_amount := d.price;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_c_instant_buy on public.orders;
create trigger trg_c_instant_buy before insert on public.orders for each row execute function public.instant_buy_order_insert();

-- what the order page needs for checkout (anyone with the order link, like get_order)
create or replace function public.get_order_checkout(p_id uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('instant', o.instant_buy, 'pay_choice', o.pay_choice, 'paid', o.paid_at is not null,
    'paid_method', o.paid_method, 'amount', o.quote_amount, 'status', o.status, 'deleted', o.deleted)
  from public.orders o where o.id = p_id;
$$;

-- "I'll pay cash on pickup"
create or replace function public.instant_pay_cash(p_id uuid) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update public.orders set pay_choice = 'cash'
  where id = p_id and instant_buy and paid_at is null and not deleted and coalesce(pay_choice, '') <> 'card';
  if not found then raise exception 'This order can''t be changed'; end if;
  return public.get_order_checkout(p_id);
end $$;

-- the payment box: admins (experimental card payments) and instant-buy orders
create or replace function public.get_order_payment(p_id uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select case when (public.is_admin() and not public.is_suspended()) or o.instant_buy then
    jsonb_build_object('paid_at', o.paid_at, 'paid_amount', o.paid_amount, 'paid_method', o.paid_method,
      'refunded_at', o.refunded_at, 'refunded_amount', o.refunded_amount, 'instant', o.instant_buy, 'pay_choice', o.pay_choice,
      'can_pay', o.paid_at is null and not o.deleted and o.quote_amount >= 0.5
        and (o.status in ('quoted', 'printing', 'completed') or (o.instant_buy and o.status in ('new', 'acknowledged', 'quoted', 'printing', 'completed'))),
      'amount', o.quote_amount) end
  from public.orders o where o.id = p_id;
$$;

revoke all on function public.instant_buy_order_insert(), public.get_order_checkout(uuid), public.instant_pay_cash(uuid) from public, anon, authenticated;
grant execute on function public.get_order_checkout(uuid), public.instant_pay_cash(uuid) to anon, authenticated;

-- Opening an order in admin acknowledges it (status new -> acknowledged), quietly: no customer email. An instant buy is
-- stored as acknowledged too but every page shows it as New; the admin list's blue "new" glow only marks status = 'new'.
create or replace function public.admin_mark_order_viewed(p_id uuid) returns text language plpgsql security definer set search_path = public as $$
declare s text;
begin
  if not public.can_edit() then return null; end if;
  perform set_config('orders.skip_status_mail', 'on', true);
  update public.orders set status = 'acknowledged' where id = p_id and status = 'new' and not deleted returning status into s;
  return coalesce(s, (select status from public.orders where id = p_id));
end $$;
revoke all on function public.admin_mark_order_viewed(uuid) from public, anon;
grant execute on function public.admin_mark_order_viewed(uuid) to authenticated;
-- notify_order_status_change returns early when current_setting('orders.skip_status_mail', true) = 'on' (patched with a DO block like test-orders-migration.sql)
