-- Security hardening (applied to the live project from the security audit).
-- Safe to re-run: every statement is idempotent.
--
-- Threat model: the Supabase publishable key is public by design, so anyone can
-- call the API as `anon`, or as `authenticated` after signing in with Google.
-- Row-level security plus the guards below are what keep those callers honest.

------------------------------------------------------------------------------
-- 1. Customers must not be able to edit their own store credit / perks.
--    (RLS let them update their own row, including store_credit.)
------------------------------------------------------------------------------
create or replace function public.guard_customer_profile_changes() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  -- Direct database / service-role access (no end-user role) and editors keep full control.
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if public.can_edit() then return new; end if;

  if tg_op = 'INSERT' then
    new.store_credit := 0;
    new.discount_available := true;
    return new;
  end if;

  new.store_credit := old.store_credit;
  new.discount_available := old.discount_available;
  new.id := old.id;
  new.email := old.email;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists trg_guard_customer_profile on public.customer_profiles;
create trigger trg_guard_customer_profile
  before insert or update on public.customer_profiles
  for each row execute function public.guard_customer_profile_changes();

------------------------------------------------------------------------------
-- 2. Orders: a customer/guest chooses what they want, never status, quote,
--    credit, prices, claims or discounts. Catalogue prices come from the
--    catalogue; attachments must belong to the order; inserts are rate-limited.
------------------------------------------------------------------------------
create or replace function public.guard_order_insert() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare
  fil record; des record; promo record; fr record; disc boolean; recent int;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if public.can_edit() then return new; end if;

  new.full_name := btrim(coalesce(new.full_name, ''));
  new.email := btrim(coalesce(new.email, ''));
  if length(new.full_name) < 1 or length(new.full_name) > 120 then raise exception 'Please enter a valid name.'; end if;
  if length(new.email) > 254 or new.email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Please enter a valid email address.'; end if;
  if new.notes is not null and length(new.notes) > 5000 then raise exception 'Notes are too long (5000 characters max).'; end if;

  new.created_at := now();
  new.status := 'new';
  new.quote_amount := null;
  new.deleted := false;
  new.claimed_by := null;
  new.claimed_by_id := null;
  new.use_store_credit := false;
  new.store_credit_use_amount := 0;
  new.store_credit_awarded := 0;
  new.discord_thread_id := null;
  new.discord_last_seen := null;
  new.unread_reminder_sent_at := null;
  new.customer_last_seen_at := null;

  if new.filament_id is not null then
    select color_name, type, price_per_100g into fil from public.filaments where id = new.filament_id and active;
    if not found then raise exception 'That filament is not available.'; end if;
    new.filament_color := fil.color_name;
    new.filament_type := fil.type;
    new.filament_price_per_100g := fil.price_per_100g;
  else
    new.filament_price_per_100g := null;
    new.filament_color := left(new.filament_color, 60);
    new.filament_type := left(new.filament_type, 40);
  end if;

  if new.design_id is not null then
    select name, price into des from public.designs where id = new.design_id and active;
    if not found then raise exception 'That design is not available.'; end if;
    new.design_name := des.name;
    new.design_price := des.price;
  else
    new.design_name := null;
    new.design_price := null;
  end if;

  if new.promo_code is not null and btrim(new.promo_code) <> '' then
    select code, discount_type, discount_value into promo from public.promo_codes
      where active and lower(code) = lower(btrim(new.promo_code));
    if found then
      new.promo_code := promo.code;
      new.promo_description := case when promo.discount_type = 'percent'
        then trim(to_char(promo.discount_value, 'FM999990.##')) || '% off'
        else '$' || trim(to_char(promo.discount_value, 'FM999990.##')) || ' off' end;
    else
      new.promo_code := null; new.promo_description := null;
    end if;
  else
    new.promo_code := null; new.promo_description := null;
  end if;

  if new.user_id is null then
    new.signup_discount_snapshot := false;
  else
    select coalesce(discount_available, false) into disc from public.customer_profiles where id = new.user_id;
    new.signup_discount_snapshot := coalesce(new.signup_discount_snapshot, false) and coalesce(disc, false);
  end if;

  if new.files is null or jsonb_typeof(new.files) <> 'array' then new.files := '[]'::jsonb; end if;
  if jsonb_array_length(new.files) > 10 then raise exception 'Too many files (10 max).'; end if;
  for fr in select value from jsonb_array_elements(new.files) loop
    if jsonb_typeof(fr.value) <> 'object' or (fr.value->>'path') is null
       or (fr.value->>'path') not like new.id::text || '/%' or (fr.value->>'path') like '%..%'
       or length(coalesce(fr.value->>'name', '')) > 255 then
      raise exception 'Invalid file attachment.';
    end if;
  end loop;
  if new.file_path is not null and (new.file_path not like new.id::text || '/%' or new.file_path like '%..%') then
    raise exception 'Invalid file attachment.';
  end if;

  -- Flood control: every order sends emails and a Discord alert.
  select count(*) into recent from public.orders where lower(email) = lower(new.email) and created_at > now() - interval '1 hour';
  if recent >= 5 then raise exception 'Too many orders from this email address. Please try again later.'; end if;
  select count(*) into recent from public.orders where user_id is null and created_at > now() - interval '1 hour';
  if recent >= 60 then raise exception 'We are receiving a lot of orders right now. Please try again shortly.'; end if;

  return new;
end;
$$;

drop trigger if exists trg_a_guard_order_insert on public.orders;
create trigger trg_a_guard_order_insert
  before insert on public.orders
  for each row execute function public.guard_order_insert();

------------------------------------------------------------------------------
-- 3. Customer messages: size limits, attachment paths, per-order flood control.
------------------------------------------------------------------------------
create or replace function public.add_customer_message(p_order_id uuid, p_body text, p_file_path text default null, p_file_name text default null, p_files jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
declare fr record; pref text := 'messages/' || p_order_id::text || '/';
begin
  if not exists (select 1 from orders where id = p_order_id and deleted = false) then
    raise exception 'Order not found or closed';
  end if;
  p_body := nullif(btrim(coalesce(p_body, '')), '');
  p_files := coalesce(p_files, '[]'::jsonb);
  if jsonb_typeof(p_files) <> 'array' then raise exception 'Invalid attachments'; end if;
  if p_body is null and p_file_path is null and jsonb_array_length(p_files) = 0 then
    raise exception 'Message must have text or an attachment';
  end if;
  if p_body is not null and length(p_body) > 5000 then raise exception 'Message is too long (5000 characters max)'; end if;
  if jsonb_array_length(p_files) > 10 then raise exception 'Too many attachments (10 max)'; end if;
  for fr in select value from jsonb_array_elements(p_files) loop
    if jsonb_typeof(fr.value) <> 'object' or (fr.value->>'path') is null or (fr.value->>'path') not like pref || '%'
       or (fr.value->>'path') like '%..%' or length(coalesce(fr.value->>'name', '')) > 255 then
      raise exception 'Invalid attachment';
    end if;
  end loop;
  if p_file_path is not null and (p_file_path not like pref || '%' or p_file_path like '%..%') then raise exception 'Invalid attachment'; end if;
  if length(coalesce(p_file_name, '')) > 255 then raise exception 'Invalid attachment'; end if;
  if (select count(*) from messages where order_id = p_order_id and sender = 'customer' and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'You are sending messages too quickly. Please wait a moment.';
  end if;
  insert into messages (order_id, sender, body, file_path, file_name, files)
  values (p_order_id, 'customer', p_body, p_file_path, p_file_name, p_files);
end;
$$;

create or replace function public.add_customer_message(p_order_id uuid, p_body text, p_file_path text default null, p_file_name text default null)
returns void language sql security definer set search_path to 'public' as $$
  select public.add_customer_message(p_order_id, p_body, p_file_path, p_file_name, '[]'::jsonb);
$$;

------------------------------------------------------------------------------
-- 4. Function execute rights. Postgres grants EXECUTE to everyone by default.
------------------------------------------------------------------------------
do $$
declare f record;
begin
  -- anthropic_api spends the saved Claude key and nothing in the app calls it.
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'anthropic_api' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  -- Admin/founder tools: signed-in only (each also checks the role inside).
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('ai_build_context','ai_finish_turn','ai_get_order_detail','ai_list_orders','ai_run_tool',
             'ai_send_customer_email','ai_send_customer_message','ai_status','ai_update_order_status','discord_relay_status','resend_status',
             'my_admin_state') loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
  -- Internal helpers only ever called from other SECURITY DEFINER functions / triggers.
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('log_email','discord_mention') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

------------------------------------------------------------------------------
-- 5. Table privileges: RLS stays the main control, but nobody needs TRUNCATE etc.
------------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') loop
    execute format('revoke truncate, trigger, references on table public.%I from anon, authenticated', t.relname);
    execute format('revoke all on table public.%I from anon', t.relname);
  end loop;
  -- Anonymous visitors: read the public catalogue and place an order. Nothing else.
  grant select on public.designs, public.filaments, public.design_filaments, public.settings to anon;
  grant insert on public.orders to anon;
end $$;

------------------------------------------------------------------------------
-- 6. Storage: cap upload size on the public order-files bucket.
------------------------------------------------------------------------------
update storage.buckets set file_size_limit = 104857600 where id = 'order-files';

------------------------------------------------------------------------------
-- 7. Trigger functions are only ever run by their triggers, never via the API,
--    and the email/Discord payload helpers get a fixed search_path.
------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prorettype = 'trigger'::regtype loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  alter function public.order_discord_payload(public.orders) set search_path = public;
  alter function public.order_confirmation_email(public.orders) set search_path = public;
  alter function public.order_status_change_email(public.orders) set search_path = public;
end $$;

------------------------------------------------------------------------------
-- NOTE: new tables get anon/authenticated grants by default in Supabase. After
-- creating a table, enable RLS and add policies in the same migration, and run
--   revoke all on public.<table> from anon;
-- unless anonymous visitors really need it.
------------------------------------------------------------------------------
