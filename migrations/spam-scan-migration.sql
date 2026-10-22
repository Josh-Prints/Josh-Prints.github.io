-- Spam scan: every new order from a non-admin is scored by spam_scan() in a before-insert trigger.
--   score >= 5   is_spam = true: held back quietly (no Discord alert, no emails, no reminders, no Discord relay, left out of
                  founder Home), listed under "Spam" in the admin orders list
--   score 3-4    kept as a normal order but tagged "Review" in the admin list and banner on the order page
-- Guests are checked on email (misspelled / invalid ending / throwaway / generic), name (numbers, sentence, fake-looking,
-- one word), missing notes or file, and looking like an existing customer or reusing an email under another name.
-- Offensive and repeated-word text is checked for everyone. Admins' own orders and test orders are never scanned.
-- Admins can flip is_spam from the order page ("Not spam" / "Mark as spam"). Spam orders still load for the customer.
-- Quiet places that skip spam like test orders: notify_new_order, notify_order_confirmation, notify_order_status_change,
-- discord_push_pending, send_unread_reminders, founder_daily_digest, founder_todo (see test-orders-migration.sql).

alter table public.orders add column if not exists is_spam boolean not null default false;
alter table public.orders add column if not exists spam_score int not null default 0;
alter table public.orders add column if not exists spam_reasons text[] not null default '{}';

create or replace function public.spam_scan(p_name text, p_email text, p_notes text, p_type text, p_has_files boolean, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  score int := 0; why text[] := '{}';
  n text := lower(btrim(coalesce(p_name, ''))); e text := lower(btrim(coalesce(p_email, ''))); nt text := lower(btrim(coalesce(p_notes, '')));
  lp text; dom text; tld text; first text; guest boolean := p_user is null; cnt int;
begin
  -- content: checked for everyone
  if (n || ' ' || nt) ~ '(fuck|shit|bitch|cunt|nigg|fagg|retard|kike|hitler|nazi|\mrape\M|\mkys\M)' then score := score + 4; why := array_append(why, 'offensive words'); end if;
  if (n || ' ' || nt) ~ '(\m\w+\M)(\s+\1\M){3,}' then score := score + 3; why := array_append(why, 'repeated words'); end if;
  if not guest then return jsonb_build_object('score', score, 'reasons', to_jsonb(why)); end if;

  -- email
  lp := split_part(e, '@', 1); dom := split_part(e, '@', 2); tld := regexp_replace(dom, '^.*\.', '');
  if dom in ('gmil.com','gmal.com','gamil.com','gnail.com','gmaill.com','gmail.co','gmail.con','gmail.comm','gmail.cm','gmail.om','hotmial.com','hotmal.com','hotmail.con','outlok.com','outlook.con','yaho.com','yahho.com','yahoo.con','icoud.com','iclould.com','icloud.con') then
    score := score + 3; why := array_append(why, 'misspelled email address');
  elsif tld !~ '^(com|net|org|edu|gov|au|nz|uk|us|ca|co|io|me|info|biz|dev|app|xyz|de|fr|jp|in|sg|hk|eu)$' then
    score := score + 3; why := array_append(why, 'invalid email ending');
  end if;
  if dom in ('mailinator.com','guerrillamail.com','tempmail.com','yopmail.com','10minutemail.com','trashmail.com','sharklasers.com','ejeje.com','temp-mail.org') then score := score + 3; why := array_append(why, 'throwaway email'); end if;
  if lp in ('test','tester','abc','asdf','qwerty','user','admin','chat','tim','tom','hello','email','example','me','you','a','aa','aaa','xxx','no','none','null','temp') or length(lp) <= 3 then score := score + 2; why := array_append(why, 'generic email'); end if;

  -- name
  if n ~ '[0-9]{3,}' or n ~ '(x|×)\s*[0-9]{2,}\s*$' then score := score + 2; why := array_append(why, 'numbers in name'); end if;
  if array_length(string_to_array(n, ' '), 1) >= 5 then score := score + 2; why := array_append(why, 'name is a sentence'); end if;
  if n ~ '^(test|asdf|qwerty?|abc|xxx|aaa|name|none|null|admin)\M' or n ~ '(.)\1{3,}' then score := score + 2; why := array_append(why, 'fake-looking name'); end if;
  if n <> '' and position(' ' in n) = 0 then score := score + 1; why := array_append(why, 'one-word name'); end if;

  -- details
  if nt = '' then score := score + 1; why := array_append(why, 'no notes'); end if;
  if p_type in ('custom_print', 'custom_model') and not coalesce(p_has_files, false) and length(nt) < 15 then score := score + 2; why := array_append(why, 'custom order with no file or details'); end if;

  -- looks like someone else: same name as a customer, different email
  if n <> '' and not exists (select 1 from public.customer_profiles where lower(email) = e) then
    if exists (select 1 from public.customer_profiles c where lower(btrim(c.full_name)) = n) then
      score := score + 2; why := array_append(why, 'name of an existing customer');
    else
      first := split_part(n, ' ', 1);
      if length(first) >= 3 and exists (select 1 from public.customer_profiles c where lower(split_part(btrim(c.full_name), ' ', 1)) = first) then
        score := score + 1; why := array_append(why, 'first name of an existing customer');
      end if;
    end if;
  end if;
  -- the same email under different names
  select count(*) into cnt from public.orders o where lower(o.email) = e and lower(btrim(o.full_name)) <> n and o.created_at > now() - interval '14 days';
  if cnt >= 1 then score := score + 2; why := array_append(why, 'same email, different name'); end if;

  return jsonb_build_object('score', score, 'reasons', to_jsonb(why));
end $$;
revoke all on function public.spam_scan(text, text, text, text, boolean, uuid) from public, anon, authenticated;

create or replace function public.spam_order_insert() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  new.is_spam := false; new.spam_score := 0; new.spam_reasons := '{}';
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or public.can_edit() or new.is_test then return new; end if;
  r := public.spam_scan(new.full_name, new.email, new.notes, new.order_type,
    (jsonb_array_length(coalesce(new.files, '[]'::jsonb)) > 0 or new.file_path is not null), new.user_id);
  new.spam_score := (r->>'score')::int;
  new.spam_reasons := coalesce(array(select jsonb_array_elements_text(r->'reasons')), '{}');
  new.is_spam := new.spam_score >= 5;
  return new;
end $$;
drop trigger if exists trg_e_spam_scan on public.orders;
create trigger trg_e_spam_scan before insert on public.orders for each row execute function public.spam_order_insert();
