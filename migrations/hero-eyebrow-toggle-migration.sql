-- Lets the founder switch the home page's eyebrow tag on or off (Founder -> Settings -> Site). Applied to the live project.
alter table public.settings add column if not exists hero_eyebrow_enabled boolean not null default true;
