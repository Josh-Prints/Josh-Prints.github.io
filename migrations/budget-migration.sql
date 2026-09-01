-- Run this once in Supabase → SQL Editor to enable the admin Budget &
-- analytics page (admin/budget.html).
--
-- Orders don't record how many grams of filament or how many hours a job
-- actually took (only a price snapshot), so there's no way to reconstruct
-- real per-order material cost from history. Instead, costs are tracked as
-- logged expenses (e.g. "$40 spool of PLA") against a monthly budget target
-- per category — a normal purchase/budget tracker, decoupled from
-- individual orders.

create table if not exists budget_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  monthly_target numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references budget_categories(id) on delete set null,
  description text,
  amount numeric not null,
  spent_at date not null default current_date,
  created_at timestamptz not null default now()
);

alter table budget_categories enable row level security;
alter table expenses enable row level security;

create policy "admin manage budget_categories"
  on budget_categories for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "admin manage expenses"
  on expenses for all
  using (public.is_admin())
  with check (public.is_admin());

-- Seed a starting "Filament" category so the page isn't empty on first
-- load — only if no categories exist yet, so this is safe to re-run.
insert into budget_categories (name, monthly_target)
select 'Filament', 100
where not exists (select 1 from budget_categories);
