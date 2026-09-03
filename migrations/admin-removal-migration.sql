-- Run this once in Supabase → SQL Editor to fix admin removal.
--
-- admin_profiles has RLS enabled but was missing a DELETE policy entirely
-- (only INSERT/SELECT/UPDATE exist). That means the "Remove" button in
-- Manage Admins has always silently deleted zero rows — no error, the
-- dashboard shows "Removed ✓", but the row stays and that person keeps
-- full admin access. This adds the missing policy, and — since adding a
-- new admin itself requires already being one (chicken-and-egg), removing
-- every admin would permanently lock everyone out with no recovery path —
-- so the policy also blocks removing yourself or the last remaining admin.

drop policy if exists "admins can delete admin_profiles" on admin_profiles;
create policy "admins can delete admin_profiles"
  on admin_profiles for delete to authenticated
  using (
    public.is_admin()
    and id <> auth.uid()
    and (select count(*) from admin_profiles) > 1
  );
