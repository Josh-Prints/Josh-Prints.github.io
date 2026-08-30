-- Run this once in Supabase → SQL Editor to enable multiple photos per preset.
-- `image_path` stays the cover photo (unchanged); `image_paths` holds any
-- additional photos, in display order, that customers can swipe through.

alter table presets add column if not exists image_paths jsonb not null default '[]'::jsonb;
