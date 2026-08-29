-- Run this once in Supabase → SQL Editor to enable customer accounts
-- (Google sign-in, "My orders", and the signup discount).
--
-- IMPORTANT: this also fixes a real security gap. Every existing
-- "authenticated" policy below trusted *any* logged-in Supabase user,
-- because until now the only way to log in at all was the admin
-- password form. Once customers can sign in with Google, they become
-- "authenticated" too — so without this fix, any customer who signs in
-- would silently gain the same access as an admin (read/write every
-- order, manage presets and filaments, read admin chat, and even
-- insert themselves into admin_profiles to grant themselves admin
-- access). This migration re-scopes those policies to actual admins
-- only (membership in admin_profiles), and leaves every existing admin
-- workflow working exactly as before.

-- ============================================================
-- 1. Customer profiles
-- ============================================================
create table if not exists customer_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  discount_available boolean not null default true,
  created_at timestamptz not null default now()
);

alter table customer_profiles enable row level security;

create policy "customers can read own profile"
  on customer_profiles for select
  using (auth.uid() = id);

create policy "customers can insert own profile"
  on customer_profiles for insert
  with check (auth.uid() = id);

create policy "customers can update own profile"
  on customer_profiles for update
  using (auth.uid() = id);

create policy "admins can read all customer profiles"
  on customer_profiles for select
  using (exists (select 1 from admin_profiles where id = auth.uid()));

create policy "admins can update all customer profiles"
  on customer_profiles for update
  using (exists (select 1 from admin_profiles where id = auth.uid()));

-- ============================================================
-- 2. Orders: link to an account + track the signup discount
-- ============================================================
alter table orders add column if not exists user_id uuid references auth.users(id);
alter table orders add column if not exists signup_discount_snapshot boolean not null default false;

-- Customers can see their own orders (for "My orders"). Scoped to their
-- own user_id only — not a blanket "any authenticated user" grant.
create policy "customers can read own orders"
  on orders for select
  using (auth.uid() = user_id);

-- ============================================================
-- 3. Security fix: admin-only policies must check admin_profiles
--    membership, not just "is logged in at all"
-- ============================================================
drop policy if exists "authenticated can read orders" on orders;
create policy "admins can read orders"
  on orders for select
  using (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "authenticated can update orders" on orders;
create policy "admins can update orders"
  on orders for update
  using (exists (select 1 from admin_profiles where id = auth.uid()))
  with check (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "authenticated can insert messages" on messages;
create policy "admins can insert messages"
  on messages for insert
  with check (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "authenticated can read messages" on messages;
create policy "admins can read messages"
  on messages for select
  using (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "authenticated can delete presets" on presets;
create policy "admins can delete presets"
  on presets for delete
  using (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "authenticated can manage presets" on presets;
create policy "admins can insert presets"
  on presets for insert
  with check (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "authenticated can read all presets" on presets;
create policy "admins can read all presets"
  on presets for select
  using (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "authenticated can update presets" on presets;
create policy "admins can update presets"
  on presets for update
  using (exists (select 1 from admin_profiles where id = auth.uid()))
  with check (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "admin manage filaments" on filaments;
create policy "admins can manage filaments"
  on filaments for all
  using (exists (select 1 from admin_profiles where id = auth.uid()))
  with check (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "authenticated insert admin_profiles" on admin_profiles;
create policy "admins can insert admin_profiles"
  on admin_profiles for insert
  with check (exists (select 1 from admin_profiles ap where ap.id = auth.uid()));

drop policy if exists "authenticated read admin_profiles" on admin_profiles;
create policy "admins can read admin_profiles"
  on admin_profiles for select
  using (exists (select 1 from admin_profiles ap where ap.id = auth.uid()));

drop policy if exists "authenticated update admin_profiles" on admin_profiles;
create policy "admins can update admin_profiles"
  on admin_profiles for update
  using (exists (select 1 from admin_profiles ap where ap.id = auth.uid()));

drop policy if exists "Authenticated update rates" on settings;
create policy "admins can update rates"
  on settings for update
  using (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "Admins can insert admin_messages" on admin_messages;
create policy "admins can insert admin_messages"
  on admin_messages for insert
  with check (exists (select 1 from admin_profiles where id = auth.uid()));

drop policy if exists "Admins can read admin_messages" on admin_messages;
create policy "admins can read admin_messages"
  on admin_messages for select
  using (exists (select 1 from admin_profiles where id = auth.uid()));
