-- Casino safe word: a signed-in player can set a safe word and an amount. Anything that takes more than that
-- amount from their chips in one go (a bet, a double, a Vox conversion) is refused until the safe word is
-- entered, so someone else on their device can't bet big. Changing or turning it off needs the safe word too.
--
-- It's enforced by a trigger on casino_wallet, so every game is covered without changing each one: when chips
-- would drop by more than the limit and no safe word was entered in the last minute, the whole action is
-- rolled back with hint 'casino_safeword'. The page then asks for the word (casino_sw_approve) and retries.
-- The word is stored only as a bcrypt hash, compared case-insensitively with spaces trimmed.

alter table public.casino_wallet add column if not exists sw_hash text;
alter table public.casino_wallet add column if not exists sw_limit bigint;
alter table public.casino_wallet add column if not exists sw_ok_until timestamptz;
alter table public.casino_wallet add column if not exists sw_fails int not null default 0;
alter table public.casino_wallet add column if not exists sw_fail_at timestamptz;

create or replace function public.casino_sw_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if new.sw_hash is not null and new.sw_limit is not null and old.chips - new.chips > new.sw_limit
     and coalesce(new.sw_ok_until, '-infinity'::timestamptz) < now()
     and coalesce(current_setting('casino.sw_bypass', true), '') <> 'on' then
    raise exception 'safe word needed' using hint = 'casino_safeword', detail = (old.chips - new.chips)::text;
  end if;
  return new;
end $$;
create or replace trigger casino_sw_guard before update of chips on public.casino_wallet
  for each row when (new.chips < old.chips) execute function public.casino_sw_guard();

create or replace function public.casino_sw_norm(p text) returns text language sql immutable as $$
  select lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')));
$$;

-- checks the safe word against the signed-in player's, counting wrong tries (5 wrong = 10 minutes locked)
create or replace function public.casino_sw_check(uid uuid, p_word text) returns boolean language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet;
begin
  select * into w from public.casino_wallet where user_id = uid for update;
  if w.sw_hash is null then return true; end if;
  if w.sw_fails >= 5 and w.sw_fail_at > now() - interval '10 minutes' then
    raise exception 'too many wrong tries' using hint = 'casino_sw_locked';
  end if;
  if extensions.crypt(public.casino_sw_norm(p_word), w.sw_hash) = w.sw_hash then
    update public.casino_wallet set sw_fails = 0, sw_fail_at = null where user_id = uid;
    return true;
  end if;
  update public.casino_wallet set sw_fails = case when sw_fail_at > now() - interval '10 minutes' then sw_fails + 1 else 1 end, sw_fail_at = now() where user_id = uid;
  return false;
end $$;

create or replace function public.casino_sw_status() returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); w public.casino_wallet;
begin
  if uid is null then raise exception 'sign in first'; end if;
  select * into w from public.casino_wallet where user_id = uid;
  return jsonb_build_object('on', w.sw_hash is not null, 'limit', w.sw_limit);
end $$;

-- set, change or turn off (p_word null) the safe word; needs the current one if there is one
create or replace function public.casino_sw_set(p_current text, p_word text, p_limit bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); ok boolean;
begin
  if uid is null then raise exception 'sign in first'; end if;
  insert into public.casino_wallet (user_id) values (uid) on conflict (user_id) do nothing;
  ok := public.casino_sw_check(uid, p_current);
  if not ok then return jsonb_build_object('ok', false, 'error', 'wrong'); end if;
  if p_word is null then
    update public.casino_wallet set sw_hash = null, sw_limit = null, sw_ok_until = null where user_id = uid;
  else
    if char_length(public.casino_sw_norm(p_word)) < 3 then raise exception 'safe word too short'; end if;
    if p_limit is null or p_limit < 1 then raise exception 'pick an amount'; end if;
    update public.casino_wallet set sw_hash = extensions.crypt(public.casino_sw_norm(p_word), extensions.gen_salt('bf')), sw_limit = p_limit, sw_ok_until = null
    where user_id = uid;
  end if;
  return jsonb_build_object('ok', true) || public.casino_sw_status();
end $$;

-- enter the safe word before a big bet: big bets are allowed for the next minute
create or replace function public.casino_sw_approve(p_word text) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first'; end if;
  if not public.casino_sw_check(uid, p_word) then return jsonb_build_object('ok', false); end if;
  update public.casino_wallet set sw_ok_until = now() + interval '1 minute' where user_id = uid;
  return jsonb_build_object('ok', true);
end $$;

-- bans reset chips to 1,000; that's an admin action, not a bet
create or replace function public.casino_ban(p_user uuid, p_reason text default null, p_ban boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'not allowed'; end if;
  perform set_config('casino.sw_bypass', 'on', true);
  insert into public.casino_wallet (user_id) values (p_user) on conflict (user_id) do nothing;
  if p_ban then
    update public.casino_wallet set banned_at = now(), ban_reason = coalesce(p_reason, 'Cheating'), chips = 1000, owed = 0, owed_at = null where user_id = p_user;
    update public.game_stats set best_score = 1000 where user_id = p_user and game = 'casino';
  else
    update public.casino_wallet set banned_at = null, ban_reason = null where user_id = p_user;
  end if;
  perform set_config('casino.sw_bypass', '', true);
  return public.casino_ban_info(p_user);
end $$;

revoke all on function public.casino_sw_guard(), public.casino_sw_norm(text), public.casino_sw_check(uuid, text),
  public.casino_sw_status(), public.casino_sw_set(text, text, bigint), public.casino_sw_approve(text) from public, anon, authenticated;
grant execute on function public.casino_sw_status(), public.casino_sw_set(text, text, bigint), public.casino_sw_approve(text) to authenticated;
