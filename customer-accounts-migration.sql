-- Run this once in Supabase → SQL Editor to enable customer accounts
-- (Google sign-in, "My orders", and the signup discount).
--
-- IMPORTANT: this also closes a live security hole. The `orders` table
-- currently has Row Level Security switched OFF entirely, so every
-- policy on it is inert and anyone who copies the public anon key out
-- of the site's page source can read or modify every order — names,
-- emails, notes, quote amounts. This migration turns RLS on.
--
-- It also re-scopes the "admin only" policies. They were written as
-- "any authenticated user", which was fine when the admin password
-- form was the only way to log in at all. Once customers can sign in
-- with Google they become `authenticated` too, and would otherwise
-- inherit full admin access — including inserting themselves into
-- admin_profiles to grant themselves admin rights.

-- Helper: is the current caller an admin?
-- SECURITY DEFINER so it bypasses RLS on admin_profiles. Without this,
-- an admin policy that reads admin_profiles would recurse infinitely
-- once admin_profiles has its own RLS policy doing the same check.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from admin_profiles where id = auth.uid());
$$;

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

drop policy if exists "customers can read own profile" on customer_profiles;
create policy "customers can read own profile"
  on customer_profiles for select to authenticated
  using (auth.uid() = id);

drop policy if exists "customers can insert own profile" on customer_profiles;
create policy "customers can insert own profile"
  on customer_profiles for insert to authenticated
  with check (auth.uid() = id);

drop policy if exists "customers can update own profile" on customer_profiles;
create policy "customers can update own profile"
  on customer_profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "admins can read all customer profiles" on customer_profiles;
create policy "admins can read all customer profiles"
  on customer_profiles for select to authenticated
  using (public.is_admin());

drop policy if exists "admins can update all customer profiles" on customer_profiles;
create policy "admins can update all customer profiles"
  on customer_profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 2. Orders: link to an account + track the signup discount
-- ============================================================
alter table orders add column if not exists user_id uuid references auth.users(id);
alter table orders add column if not exists signup_discount_snapshot boolean not null default false;

-- THE CRITICAL FIX: turn RLS on so the policies below actually apply.
alter table orders enable row level security;

-- Guests may still place orders, but only unattributed ones — an
-- anonymous caller must not be able to file an order under someone
-- else's account id.
drop policy if exists "anon can insert orders" on orders;
create policy "guests can insert orders"
  on orders for insert to anon
  with check (user_id is null);

-- Signed-in customers place orders too. They are role `authenticated`,
-- not `anon`, so without this policy their checkout would be rejected
-- the moment RLS is enabled. user_id null is allowed (the browse.html
-- preset flow doesn't attach an account yet); claiming someone else's
-- id is not.
drop policy if exists "customers can insert orders" on orders;
create policy "customers can insert orders"
  on orders for insert to authenticated
  with check (user_id is null or auth.uid() = user_id);

drop policy if exists "customers can read own orders" on orders;
create policy "customers can read own orders"
  on orders for select to authenticated
  using (auth.uid() = user_id);

-- ============================================================
-- 3. Security fix: admin-only policies must check real admin
--    membership, not merely "is logged in at all"
-- ============================================================
drop policy if exists "authenticated can read orders" on orders;
create policy "admins can read orders"
  on orders for select to authenticated using (public.is_admin());

drop policy if exists "authenticated can update orders" on orders;
create policy "admins can update orders"
  on orders for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated can insert messages" on messages;
create policy "admins can insert messages"
  on messages for insert to authenticated with check (public.is_admin());

drop policy if exists "authenticated can read messages" on messages;
create policy "admins can read messages"
  on messages for select to authenticated using (public.is_admin());

drop policy if exists "authenticated can delete presets" on presets;
create policy "admins can delete presets"
  on presets for delete to authenticated using (public.is_admin());

drop policy if exists "authenticated can manage presets" on presets;
create policy "admins can insert presets"
  on presets for insert to authenticated with check (public.is_admin());

drop policy if exists "authenticated can read all presets" on presets;
create policy "admins can read all presets"
  on presets for select to authenticated using (public.is_admin());

drop policy if exists "authenticated can update presets" on presets;
create policy "admins can update presets"
  on presets for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin manage filaments" on filaments;
create policy "admins can manage filaments"
  on filaments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated insert admin_profiles" on admin_profiles;
create policy "admins can insert admin_profiles"
  on admin_profiles for insert to authenticated with check (public.is_admin());

drop policy if exists "authenticated read admin_profiles" on admin_profiles;
create policy "admins can read admin_profiles"
  on admin_profiles for select to authenticated using (public.is_admin());

drop policy if exists "authenticated update admin_profiles" on admin_profiles;
create policy "admins can update admin_profiles"
  on admin_profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Authenticated update rates" on settings;
create policy "admins can update rates"
  on settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins can insert admin_messages" on admin_messages;
create policy "admins can insert admin_messages"
  on admin_messages for insert to authenticated with check (public.is_admin());

drop policy if exists "Admins can read admin_messages" on admin_messages;
create policy "admins can read admin_messages"
  on admin_messages for select to authenticated using (public.is_admin());
