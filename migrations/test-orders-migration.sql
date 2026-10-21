-- Test orders: an admin ticks "Test order" when starting an order. A test order is a normal order in every way
-- except it stays quiet: no Discord alert, no confirmation or status emails, no "unread reply" reminder, no Discord
-- relay of its messages, and it's left out of the founder Home summary and to-do lists.
--   orders.is_test   set only for editors (admins who aren't suspended); the server clears it for everyone else.

alter table public.orders add column if not exists is_test boolean not null default false;

create or replace function public.test_order_insert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.is_test := coalesce(new.is_test, false) and public.can_edit();
  return new;
end $$;
drop trigger if exists trg_d_test_order on public.orders;
create trigger trg_d_test_order before insert on public.orders for each row execute function public.test_order_insert();

-- stay quiet for test orders: Discord alert, confirmation email, status-change emails
do $$
declare f text; def text; patched text;
begin
  foreach f in array array['notify_new_order', 'notify_order_confirmation', 'notify_order_status_change'] loop
    select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f;
    if position('is_test' in def) > 0 then continue; end if;
    patched := regexp_replace(def, '(\$function\$.*?\mbegin\M)', E'\\1\n  if new.is_test then return new; end if;');
    if patched = def then raise exception 'could not patch %', f; end if;
    execute patched;
  end loop;
end $$;

-- Discord relay of customer messages: test orders are skipped (marked as already sent)
do $$
declare def text; patched text;
begin
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'discord_push_pending';
  if position('is_test' in def) = 0 then
    patched := replace(def, 'where o.id = m.order_id and m.discord_pushed = false and o.deleted = true;', 'where o.id = m.order_id and m.discord_pushed = false and (o.deleted = true or o.is_test);');
    patched := replace(patched, 'where m.sender = ''customer'' and m.discord_pushed = false and o.deleted = false', 'where m.sender = ''customer'' and m.discord_pushed = false and o.deleted = false and not o.is_test');
    if patched = def then raise exception 'could not patch discord_push_pending'; end if;
    execute patched;
  end if;
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'send_unread_reminders';
  if position('is_test' in def) = 0 then
    patched := replace(def, 'where o.deleted = false' || E'\n', 'where o.deleted = false and not o.is_test' || E'\n');
    if patched = def then raise exception 'could not patch send_unread_reminders'; end if;
    execute patched;
  end if;
  -- founder Home: daily summary and to-do lists leave test orders out
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'founder_daily_digest';
  if position('is_test' in def) = 0 then
    patched := replace(def, 'public.orders where not deleted', 'public.orders where not deleted and not is_test');
    if patched = def then raise exception 'could not patch founder_daily_digest'; end if;
    execute patched;
  end if;
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'founder_todo';
  if position('is_test' in def) = 0 then
    patched := replace(replace(def, 'public.orders where not deleted', 'public.orders where not deleted and not is_test'), 'where not ord.deleted', 'where not ord.deleted and not ord.is_test');
    if patched = def then raise exception 'could not patch founder_todo'; end if;
    execute patched;
  end if;
end $$;
