-- Run this once in Supabase → SQL Editor to enable the site announcement banner.

alter table settings add column if not exists banner_enabled boolean not null default false;
alter table settings add column if not exists banner_message text not null default '';
alter table settings add column if not exists banner_force_scroll boolean not null default false;
