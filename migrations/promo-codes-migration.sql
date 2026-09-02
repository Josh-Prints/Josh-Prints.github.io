-- Run this once in Supabase → SQL Editor to enable promo codes.
--
-- Like everything else on this site, pricing is quoted manually per order
-- (there's no automatic checkout math) — a promo code doesn't change any
-- price by itself. A customer enters a code at order time, it's validated
-- and snapshotted onto the order, and the admin sees it on the order card
-- to factor into the quote they type in — the same pattern already used
-- for the signup discount and store credit.

create table if not exists promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  discount_value numeric not null check (discount_value > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table promo_codes enable row level security;

create policy "admin manage promo_codes"
  on promo_codes for all
  using (public.is_admin())
  with check (public.is_admin());

-- Orders remember which code (if any) was used, and a text snapshot of the
-- discount description at order time — so an order keeps showing the right
-- thing even if the code is later edited or deleted.
alter table orders add column if not exists promo_code text;
alter table orders add column if not exists promo_description text;

-- Narrow, anonymous-callable lookup: returns whether a code is currently
-- valid and its discount description — never the whole table (no way to
-- list all codes this way), matched case-insensitively.
create or replace function public.validate_promo_code(p_code text)
returns table (code text, discount_type text, discount_value numeric, description text)
language sql
security definer
set search_path = public
as $$
  select
    code,
    discount_type,
    discount_value,
    case when discount_type = 'percent'
      then trim(to_char(discount_value, 'FM999990.##')) || '% off'
      else '$' || trim(to_char(discount_value, 'FM999990.##')) || ' off'
    end as description
  from promo_codes
  where active = true
    and lower(code) = lower(trim(p_code))
  limit 1;
$$;

grant execute on function public.validate_promo_code(text) to anon, authenticated;

-- NOTE: the customer-facing order tracking page (order.html) reads orders
-- through a get_order() RPC that isn't in any tracked migration (created
-- directly in the dashboard, like get_order_messages). If you also want
-- the promo code visible there, that function needs to select the two new
-- promo_code / promo_description columns too — this migration doesn't
-- touch it since its current definition isn't available here.
