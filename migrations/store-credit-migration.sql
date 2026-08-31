-- Run this once in Supabase → SQL Editor to enable store credit and
-- per-design color restrictions.

-- ---- Store credit ----

alter table settings add column if not exists store_credit_rate numeric not null default 0.10;
alter table settings add column if not exists store_credit_enabled boolean not null default false;

alter table customer_profiles add column if not exists store_credit numeric not null default 0;

alter table orders add column if not exists use_store_credit boolean not null default false;
alter table orders add column if not exists store_credit_use_amount numeric not null default 0;
alter table orders add column if not exists store_credit_awarded numeric not null default 0;

-- ---- Per-design color restriction ----
-- No rows for a design = unrestricted (every active filament is offered),
-- so this is safe to add without touching any existing design.

create table if not exists design_filaments (
  design_id uuid not null references designs(id) on delete cascade,
  filament_id uuid not null references filaments(id) on delete cascade,
  primary key (design_id, filament_id)
);

alter table design_filaments enable row level security;

create policy "public read design_filaments"
  on design_filaments for select
  using (true);

create policy "admin manage design_filaments"
  on design_filaments for all
  using (public.is_admin())
  with check (public.is_admin());
