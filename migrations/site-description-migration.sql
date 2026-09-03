-- Run this once in Supabase → SQL Editor to make the homepage's hero
-- description editable from the admin Debug modal ("Site" tab), instead of
-- being hardcoded in index.html.
--
-- Defaults to the current copy minus Oliver Horsfoll (no longer a
-- partner, per the request that prompted this migration) so the site
-- is correct as soon as this runs. settings already has a public SELECT
-- policy and an admin-only UPDATE policy covering every column, so no new
-- RLS is needed for this one.

alter table settings add column if not exists site_description text
  not null default 'Founded by Joshua Paterson and co-owned with Kaisyn Hazer. Send a model or describe what you need. Get a quote back, track progress, and message me directly, start to finish.';
