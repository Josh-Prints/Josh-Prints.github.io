-- Run this once in Supabase → SQL Editor before using the new filament features.

-- 1. New table to hold your filament colours/types/pricing
create table if not exists filaments (
  id uuid primary key default gen_random_uuid(),
  color_name text not null,
  type text not null,
  price_per_100g numeric not null default 0,
  image_path text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table filaments enable row level security;

-- Anyone (customers browsing the site) can read active filaments
create policy "public read active filaments"
  on filaments for select
  using (active = true);

-- Only signed-in admins (you) can insert/update/delete
create policy "admin manage filaments"
  on filaments for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- 2. New columns on orders so the chosen filament is saved with each order
alter table orders add column if not exists filament_id uuid;
alter table orders add column if not exists filament_color text;
alter table orders add column if not exists filament_type text;
alter table orders add column if not exists filament_price_per_100g numeric;
