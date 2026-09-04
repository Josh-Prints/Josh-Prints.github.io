-- Run this once in Supabase → SQL Editor (or skip — it's applied directly
-- to the live project already, this file just documents it) to make the
-- hero eyebrow tag and headline on index.html editable from the admin
-- Debug modal's "Site" tab, alongside the existing site_description.
--
-- Defaults match the current live copy so nothing changes until an admin
-- edits and saves it.

alter table settings add column if not exists hero_eyebrow text
  not null default 'Now taking orders';

alter table settings add column if not exists hero_headline text
  not null default 'Custom 3D printing,
made to order.';
