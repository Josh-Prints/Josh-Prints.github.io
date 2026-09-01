-- Run this once in Supabase → SQL Editor to power the "Recent activity"
-- widget at the bottom of the public main page (index.html).
--
-- This does NOT open up the orders table itself — it stays locked down
-- exactly as before (customers can only read their own orders, admins can
-- read all). Instead this is a narrow, security-definer function that
-- hands back only a first name, a short order label, and a timestamp —
-- nothing else (no email, no full name, no notes, no files) — safe to
-- expose to anonymous site visitors.

create or replace function public.get_recent_customers(p_limit int default 6)
returns table (first_name text, order_label text, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select
    split_part(full_name, ' ', 1) as first_name,
    case
      when order_type = 'design' and design_name is not null and trim(design_name) <> ''
        then 'the ' || design_name
      when order_type = 'custom_model' then 'a custom model'
      else 'a custom print'
    end as order_label,
    created_at
  from orders
  where coalesce(deleted, false) = false
    and full_name is not null
    and trim(full_name) <> ''
  order by created_at desc
  limit greatest(1, least(p_limit, 20));
$$;

grant execute on function public.get_recent_customers(int) to anon, authenticated;
