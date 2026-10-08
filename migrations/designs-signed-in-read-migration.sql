-- Signed-in customers (logged in but not admins) got an EMPTY designs list with no error:
-- the only read rules were "anon" and "admins". Applied to the live project.
create policy "signed-in users can read active designs" on public.designs for select to authenticated using (active = true);
