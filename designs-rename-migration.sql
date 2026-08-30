-- Renames "presets" to "designs" throughout the database, to match the
-- site-wide rename from "Presets" to "Designs" in the UI. Safe to re-run.

alter table if exists presets rename to designs;

alter table if exists orders rename column preset_id to design_id;
alter table if exists orders rename column preset_name to design_name;
alter table if exists orders rename column preset_price to design_price;

-- The order_type column has a CHECK constraint listing 'preset' as one of
-- the allowed values. Drop it, update existing rows from 'preset' to
-- 'design', then add it back allowing 'design' instead of 'preset' — doing
-- this in the other order would have the update rejected by whichever
-- constraint is in place at the time.
alter table orders drop constraint if exists orders_order_type_check;

update orders set order_type = 'design' where order_type = 'preset';

alter table orders add constraint orders_order_type_check
  check (order_type = ANY (ARRAY['custom_model'::text, 'custom_print'::text, 'design'::text]));

-- Cosmetic: the foreign key constraint name still says "preset_id".
do $$ begin
  alter table orders rename constraint orders_preset_id_fkey to orders_design_id_fkey;
exception when undefined_object then null;
end $$;

-- Cosmetic: keep the RLS policy names in sync with the new table name.
-- (The policies themselves stay attached to the table across the rename
-- above — this just relabels them so they don't say "presets" anymore.)
do $$ begin
  alter policy "anon can read active presets" on designs rename to "anon can read active designs";
exception when undefined_object then null;
end $$;

do $$ begin
  alter policy "admins can delete presets" on designs rename to "admins can delete designs";
exception when undefined_object then null;
end $$;

do $$ begin
  alter policy "admins can insert presets" on designs rename to "admins can insert designs";
exception when undefined_object then null;
end $$;

do $$ begin
  alter policy "admins can read all presets" on designs rename to "admins can read all designs";
exception when undefined_object then null;
end $$;

do $$ begin
  alter policy "admins can update presets" on designs rename to "admins can update designs";
exception when undefined_object then null;
end $$;

-- get_order() is a SECURITY DEFINER RPC (bypasses RLS for the single-order
-- customer view) whose return signature names these columns explicitly —
-- it must be recreated to match the renamed orders columns above, or every
-- call to it starts failing immediately.
drop function if exists public.get_order(uuid);
create function public.get_order(p_id uuid)
returns table(
  id uuid, full_name text, email text, order_type text, notes text,
  file_path text, file_name text, files jsonb, status text, quote_amount numeric,
  deleted boolean, created_at timestamptz, design_id uuid, design_name text, design_price numeric
)
language sql
security definer
set search_path to 'public'
as $$
  select id, full_name, email, order_type, notes,
         file_path, file_name, files, status, quote_amount, deleted, created_at,
         design_id, design_name, design_price
  from orders
  where id = p_id;
$$;
