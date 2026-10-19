-- Higher or Lower: one card is shown; guess whether the next card from the same shuffled deck is higher or lower.
-- Aces are low (A = 1 ... K = 13). A card of the same rank loses. Each right guess multiplies your winnings by
-- 97% of the fair odds for that guess, worked out from the cards still in the deck. Cash out after any right
-- guess; a wrong guess loses the bet. Multipliers are whole numbers of basis points (10000 = 1x), rounded down,
-- capped at 1000x, so the page (guests) and the server (signed-in players) always agree exactly.

-- the rest of the deck: how many cards, and how many are higher / lower than the current card
create or replace function public.hl_odds(p_deck int[], p_idx int, p_cur int) returns jsonb language sql immutable as $$
  select jsonb_build_object('n', count(*), 'hi', count(*) filter (where c % 13 > p_cur % 13), 'lo', count(*) filter (where c % 13 < p_cur % 13))
  from unnest(p_deck[p_idx:52]) c;
$$;
create or replace function public.hl_step(p_mult bigint, p_n int, p_k int) returns bigint language sql immutable as $$
  select case when p_k > 0 then least(10000000::bigint, (p_mult * 97 * p_n) / (100 * p_k)) else 0 end;
$$;
create or replace function public.hl_deck(s jsonb) returns int[] language sql immutable as $$
  select array_agg(x::int order by o) from jsonb_array_elements_text(s->'deck') with ordinality t(x, o);
$$;

-- what the page sees of a round in play (never the rest of the deck)
create or replace function public.hl_view(s jsonb, p_chips bigint) returns jsonb language plpgsql immutable as $$
declare d int[] := public.hl_deck(s); i int := (s->>'idx')::int; cur int := (s->>'cur')::int; m bigint := (s->>'mult')::bigint; o jsonb;
begin
  o := public.hl_odds(d, i, cur);
  return jsonb_build_object('chips', p_chips, 'phase', 'play', 'bet', (s->>'bet')::bigint, 'cur', cur, 'shown', s->'shown', 'mult', m,
    'left', (o->>'n')::int, 'hi', (o->>'hi')::int, 'lo', (o->>'lo')::int,
    'hiMult', public.hl_step(m, (o->>'n')::int, (o->>'hi')::int), 'loMult', public.hl_step(m, (o->>'n')::int, (o->>'lo')::int),
    'cashout', case when jsonb_array_length(s->'shown') > 1 then (s->>'bet')::bigint * m / 10000 else 0 end);
end $$;

create or replace function public.hl_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('hl');
begin
  if s ? 'deck' then return public.hl_view(s, w.chips); end if;
  return jsonb_build_object('chips', w.chips, 'phase', 'bet');
end $$;

create or replace function public.hl_start(p_bet bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('hl'); d int[]; c bigint;
begin
  if s ? 'deck' then return public.hl_view(s, w.chips); end if;
  if p_bet is null or p_bet < 5 or p_bet > w.chips then raise exception 'invalid bet'; end if;
  d := public.cz_deck(1);
  s := jsonb_build_object('deck', to_jsonb(d), 'idx', 2, 'cur', d[1], 'shown', jsonb_build_array(d[1]), 'mult', 10000, 'bet', p_bet);
  perform public.cz_save('hl', s);
  c := public.cz_settle(p_bet, 0, false);
  return public.hl_view(s, c);
end $$;

create or replace function public.hl_finish(s jsonb, p_payout bigint, p_card int, p_won boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare c bigint;
begin
  perform public.cz_save('hl', '{}'::jsonb);
  c := public.cz_settle(0, p_payout, true);
  return jsonb_build_object('chips', c, 'phase', 'bet', 'bet', (s->>'bet')::bigint, 'shown', s->'shown', 'mult', (s->>'mult')::bigint,
    'card', p_card, 'won', p_won, 'payout', p_payout, 'net', p_payout - (s->>'bet')::bigint);
end $$;

create or replace function public.hl_cashout() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('hl');
begin
  if not s ? 'deck' then raise exception 'no round in play'; end if;
  if jsonb_array_length(s->'shown') < 2 then raise exception 'guess at least once first'; end if;
  return public.hl_finish(s, (s->>'bet')::bigint * (s->>'mult')::bigint / 10000, null, true);
end $$;

create or replace function public.hl_guess(p_dir text) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('hl'); d int[]; i int; cur int; nxt int; o jsonb; k int; m bigint; won boolean;
begin
  if not s ? 'deck' then raise exception 'no round in play'; end if;
  if p_dir not in ('hi', 'lo') then raise exception 'pick higher or lower'; end if;
  d := public.hl_deck(s); i := (s->>'idx')::int; cur := (s->>'cur')::int;
  o := public.hl_odds(d, i, cur); k := (o->>p_dir)::int;
  if k = 0 then raise exception 'that can''t happen'; end if;
  nxt := d[i];
  won := (p_dir = 'hi' and nxt % 13 > cur % 13) or (p_dir = 'lo' and nxt % 13 < cur % 13);
  s := jsonb_set(s, '{shown}', (s->'shown') || to_jsonb(nxt));
  if not won then return public.hl_finish(s, 0, nxt, false); end if;
  m := public.hl_step((s->>'mult')::bigint, (o->>'n')::int, k);
  s := s || jsonb_build_object('idx', i + 1, 'cur', nxt, 'mult', m);
  -- out of cards, or at the 1000x cap: cash out for the player
  if i + 1 > 52 or m >= 10000000 then return public.hl_finish(s, (s->>'bet')::bigint * m / 10000, nxt, true); end if;
  perform public.cz_save('hl', s);
  return public.hl_view(s, w.chips) || jsonb_build_object('card', nxt, 'won', true);
end $$;

-- a round of Higher or Lower in play counts as "mid-hand"
create or replace function public.casino_busy(uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.mtcp_seats s join public.mtcp_tables t on t.id = s.table_id
                 where s.user_id = uid and t.phase <> 'showdown' and (s.ante + s.pair > 0 or cardinality(s.cards) = 3))
    or exists (select 1 from public.casino_play where user_id = uid and (
      (game = 'bj2' and coalesce(state->>'phase', 'bet') <> 'bet') or (game in ('vp', 'tcp') and (state ? 'hand' or state ? 'player')) or (game = 'war' and state ? 'p')
      or (game = 'craps' and coalesce(state->'bets', '{}') <> '{}'::jsonb) or (game = 'hl' and state ? 'deck')));
$$;

revoke all on function public.hl_odds(int[], int, int), public.hl_step(bigint, int, int), public.hl_deck(jsonb), public.hl_view(jsonb, bigint),
  public.hl_state(), public.hl_start(bigint), public.hl_finish(jsonb, bigint, int, boolean), public.hl_cashout(), public.hl_guess(text) from public, anon, authenticated;
grant execute on function public.hl_state(), public.hl_start(bigint), public.hl_cashout(), public.hl_guess(text) to authenticated;
