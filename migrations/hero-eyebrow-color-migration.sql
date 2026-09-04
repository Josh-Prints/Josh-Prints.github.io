-- Run this once in Supabase → SQL Editor (or skip — applied directly to
-- the live project already, this file just documents it) to make the
-- hero eyebrow tag's colour (the small dot + text above the headline)
-- editable from the admin Debug modal's "Site" tab.
--
-- Left nullable with no default on purpose: NULL means "follow the site's
-- normal theme colours" (var(--fg-muted) for the text, var(--accent) for
-- the dot, both already light/dark aware) exactly as before this
-- migration. Only once an admin explicitly picks and saves a colour does
-- it override both the text and the dot with that fixed hex value in
-- both themes.

alter table settings add column if not exists hero_eyebrow_color text;
