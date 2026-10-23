-- Quantity + bulk prices for designs (admin/design.html).
-- designs.allow_quantity turns the quantity picker on in browse.html; max_quantity caps it (null = 999);
-- bulk_tiers = [{min, price}]: buying `min` or more costs `price` each (the biggest matching break wins).
-- The server works the price out at insert (instant_buy_order_insert): orders.quantity is clamped, orders.unit_price
-- set from the design, and an instant buy's quote_amount = unit_price * quantity. The customer never sets the price.

set lock_timeout = '4s';
alter table public.designs add column if not exists allow_quantity boolean not null default false,
  add column if not exists max_quantity int, add column if not exists bulk_tiers jsonb not null default '[]'::jsonb;
alter table public.orders add column if not exists quantity int not null default 1, add column if not exists unit_price numeric;

create or replace function public.design_unit_price(d public.designs, qty int) returns numeric
language sql stable set search_path to 'public' as $$
  select coalesce((select (t->>'price')::numeric from jsonb_array_elements(case when jsonb_typeof(d.bulk_tiers)='array' then d.bulk_tiers else '[]'::jsonb end) t
    where (t->>'min')::int <= qty and (t->>'price')::numeric >= 0 order by (t->>'min')::int desc limit 1), d.price)
$$;
revoke all on function public.design_unit_price(public.designs, int) from public, anon, authenticated;

create or replace function public.instant_buy_order_insert() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare d public.designs; q int;
begin
  new.instant_buy := false; new.pay_choice := null; new.unit_price := null;
  q := coalesce(new.quantity, 1);
  if new.design_id is not null then
    select * into d from public.designs where id = new.design_id;
    -- quantity only counts on designs with it turned on, capped at the design's max (999 without one)
    if d.allow_quantity then q := greatest(1, least(q, coalesce(d.max_quantity, 999))); else q := 1; end if;
    new.quantity := q;
    if d.price is not null then new.unit_price := public.design_unit_price(d, q); end if;
    if d.instant_buy and d.price is not null and d.price >= 0.5 and new.unit_price * q >= 0.5 then
      new.instant_buy := true;
      new.quote_amount := round(new.unit_price * q, 2);
    end if;
  else
    new.quantity := 1;
  end if;
  return new;
end $function$;

-- get_order_checkout also returns 'quantity' and 'unit_price' (order.html reads them; get_order's fixed columns stay as they are).
-- order_discord_payload adds a "Quantity" field when > 1; order_confirmation_email says "3 × <design>".
-- Both were patched in place (replace on pg_get_functiondef) so their emergency / is_test logic stays untouched.
