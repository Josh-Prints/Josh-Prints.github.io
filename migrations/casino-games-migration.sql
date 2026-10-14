-- More casino games. All of them draw from casino_wallet (see casino-migration.sql) and record to the 'casino'
-- leaderboard row through casino_publish(). The browser shows the result; the server decides it.
-- casino_play holds the in-progress state of games that span more than one call (cards still in the deck, a
-- craps point). It is never readable from the browser, so hidden cards stay hidden.

create table if not exists public.casino_play (
  user_id uuid not null references auth.users(id) on delete cascade,
  game text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, game)
);
alter table public.casino_play enable row level security;
revoke all on table public.casino_play from anon, authenticated;

-- uniform random integer 0..n-1
create or replace function public.cz_rand(n int) returns int language sql volatile as $$ select floor(random() * n)::int $$;
-- a shuffled pack (or several), cards 0..51
create or replace function public.cz_deck(decks int default 1) returns int[] language sql volatile as $$
  select array_agg(c order by random()) from generate_series(0, 51) c, generate_series(1, decks) d
$$;
-- the caller's saved state for a game (locked), creating an empty one
create or replace function public.cz_state(p_game text) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); s jsonb;
begin
  insert into public.casino_play (user_id, game) values (uid, p_game) on conflict do nothing;
  select state into s from public.casino_play where user_id = uid and game = p_game for update;
  return s;
end $$;
create or replace function public.cz_save(p_game text, p_state jsonb) returns void language sql security definer set search_path = public as $$
  update public.casino_play set state = p_state, updated_at = now() where user_id = auth.uid() and game = p_game
$$;
-- move chips: take the stake, add the payout, record for the leaderboard; returns the new balance
create or replace function public.cz_settle(p_stake bigint, p_payout bigint, p_round boolean default true) returns bigint language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); c bigint;
begin
  update public.casino_wallet set chips = chips - p_stake + p_payout, updated_at = now() where user_id = uid returning chips into c;
  perform public.casino_publish(uid, c, p_round);
  return c;
end $$;

/* ======================= Slots ======================= */
-- Three reels of 22 stops, five lines. Returns 94.99% over the long run (computed exactly from the strips).
create or replace function public.slots_spin(p_line_bet bigint, p_lines int) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row();
  strips text[] := array['BPLDLSCBLPBPRLCSPRLBCP', 'LBLSLRBCPLBLPSPCPLPRDB', 'LRPBLPBLBCRCSPLPLPCDCB'];
  lines int[] := array[1,1,1, 0,0,0, 2,2,2, 0,1,2, 2,1,0];
  stops int[] := array[public.cz_rand(22), public.cz_rand(22), public.cz_rand(22)];
  staked bigint; pay bigint := 0; wins jsonb := '[]'; l int; a text; b text; c text; m int; n int; chips bigint;
begin
  if p_lines is null or p_lines < 1 or p_lines > 5 or p_line_bet is null or p_line_bet not in (1, 2, 5, 10, 25, 50, 100, 250, 500) then raise exception 'invalid bet'; end if;
  staked := p_line_bet * p_lines;
  if staked > w.chips then raise exception 'not enough chips'; end if;
  for l in 0 .. p_lines - 1 loop
    a := substr(strips[1], ((stops[1] + lines[l * 3 + 1] - 1 + 22) % 22) + 1, 1);
    b := substr(strips[2], ((stops[2] + lines[l * 3 + 2] - 1 + 22) % 22) + 1, 1);
    c := substr(strips[3], ((stops[3] + lines[l * 3 + 3] - 1 + 22) % 22) + 1, 1);
    m := 0; n := 0;
    if a = b and b = c then
      m := case a when 'D' then 800 when 'S' then 150 when 'R' then 50 when 'C' then 20 when 'B' then 20 when 'P' then 15 when 'L' then 10 else 0 end; n := 3;
    elsif a = 'C' and b = 'C' then m := 5; n := 2;
    elsif a = 'C' then m := 2; n := 1;
    end if;
    if m > 0 then
      pay := pay + m * p_line_bet;
      wins := wins || jsonb_build_object('line', l + 1, 'pay', m * p_line_bet, 'n', n, 'sym', a);
    end if;
  end loop;
  chips := public.cz_settle(staked, pay);
  return jsonb_build_object('chips', chips, 'stops', to_jsonb(stops), 'wins', wins, 'payout', pay, 'staked', staked, 'net', pay - staked);
end $$;

revoke all on function public.cz_rand(int), public.cz_deck(int), public.cz_state(text), public.cz_save(text, jsonb), public.cz_settle(bigint, bigint, boolean),
  public.slots_spin(bigint, int) from public, anon, authenticated;
grant execute on function public.slots_spin(bigint, int) to authenticated;
/* ======================= Video Poker (Jacks or Better 9/6) ======================= */
-- rank a five-card hand: royal, sf, quads, full, flush, straight, trips, twopair, jacks, or null
create or replace function public.vp_rank(h int[]) returns text language plpgsql immutable as $$
declare r int[]; u int[]; counts int[]; flush boolean; straight boolean; broadway boolean; pr int;
begin
  select array_agg(x % 13 order by x % 13) into r from unnest(h) x;
  select array_agg(distinct x) into u from unnest(r) x;
  select array_agg(n order by n desc) into counts from (select count(*) n from unnest(r) x group by x) t;
  select count(distinct x / 13) = 1 into flush from unnest(h) x;
  broadway := u = array[0, 9, 10, 11, 12];
  straight := array_length(u, 1) = 5 and (u[5] - u[1] = 4 or broadway);
  if straight and flush then return case when broadway then 'royal' else 'sf' end; end if;
  if counts[1] = 4 then return 'quads'; end if;
  if counts[1] = 3 and counts[2] = 2 then return 'full'; end if;
  if flush then return 'flush'; end if;
  if straight then return 'straight'; end if;
  if counts[1] = 3 then return 'trips'; end if;
  if counts[1] = 2 and counts[2] = 2 then return 'twopair'; end if;
  if counts[1] = 2 then
    select x into pr from unnest(r) x group by x having count(*) = 2;
    if pr = 0 or pr >= 10 then return 'jacks'; end if;
  end if;
  return null;
end $$;

create or replace function public.vp_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('vp');
begin
  perform public.casino_publish(w.user_id, w.chips, false);
  if s ? 'hand' then
    return jsonb_build_object('chips', w.chips, 'phase', 'draw', 'hand', s->'hand', 'coins', s->'coins', 'denom', s->'denom');
  end if;
  return jsonb_build_object('chips', w.chips, 'phase', 'deal');
end $$;

create or replace function public.vp_deal(p_coins int, p_denom bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('vp'); d int[]; bet bigint; c bigint;
begin
  if s ? 'hand' then return public.vp_state(); end if;
  if p_coins is null or p_coins < 1 or p_coins > 5 or p_denom is null or p_denom not in (1, 5, 25, 100) then raise exception 'invalid bet'; end if;
  bet := p_coins * p_denom;
  if bet > w.chips then raise exception 'not enough chips'; end if;
  d := public.cz_deck(1);
  perform public.cz_save('vp', jsonb_build_object('deck', to_jsonb(d[6:52]), 'hand', to_jsonb(d[1:5]), 'coins', p_coins, 'denom', p_denom));
  c := public.cz_settle(bet, 0, false);
  return jsonb_build_object('chips', c, 'phase', 'draw', 'hand', to_jsonb(d[1:5]), 'coins', p_coins, 'denom', p_denom);
end $$;

create or replace function public.vp_draw(p_hold boolean[]) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('vp'); hand int[]; deck int[]; i int; k int := 0;
  rk text; coins int; denom bigint; pay bigint := 0; c bigint;
begin
  if not (s ? 'hand') then return public.vp_state(); end if;
  if p_hold is null or array_length(p_hold, 1) <> 5 then raise exception 'invalid hold'; end if;
  select array_agg(x::int order by o) into hand from jsonb_array_elements_text(s->'hand') with ordinality t(x, o);
  select array_agg(x::int order by o) into deck from jsonb_array_elements_text(s->'deck') with ordinality t(x, o);
  for i in 1..5 loop
    if not coalesce(p_hold[i], false) then k := k + 1; hand[i] := deck[k]; end if;
  end loop;
  coins := (s->>'coins')::int; denom := (s->>'denom')::bigint;
  rk := public.vp_rank(hand);
  if rk is not null then
    pay := denom * case rk when 'royal' then case when coins = 5 then 4000 else 250 * coins end
      when 'sf' then 50 * coins when 'quads' then 25 * coins when 'full' then 9 * coins when 'flush' then 6 * coins
      when 'straight' then 4 * coins when 'trips' then 3 * coins when 'twopair' then 2 * coins else coins end;
  end if;
  perform public.cz_save('vp', '{}'::jsonb);
  c := public.cz_settle(0, pay, true);
  return jsonb_build_object('chips', c, 'phase', 'deal', 'hand', to_jsonb(hand), 'coins', coins, 'denom', denom, 'rank', rk, 'payout', pay);
end $$;

revoke all on function public.vp_rank(int[]), public.vp_state(), public.vp_deal(int, bigint), public.vp_draw(boolean[]) from public, anon, authenticated;
grant execute on function public.vp_state(), public.vp_deal(int, bigint), public.vp_draw(boolean[]) to authenticated;
/* ======================= Baccarat (Punto Banco) ======================= */
create or replace function public.bac_val(c int) returns int language sql immutable as $$ select case when c % 13 >= 9 then 0 else c % 13 + 1 end $$;
create or replace function public.bac_tot(h int[]) returns int language sql immutable as $$ select coalesce(sum(public.bac_val(x)), 0)::int % 10 from unnest(h) x $$;

create or replace function public.bac_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('bac');
begin
  perform public.casino_publish(w.user_id, w.chips, false);
  return jsonb_build_object('chips', w.chips, 'road', coalesce(s->'road', '[]'), 'left', coalesce(jsonb_array_length(s->'shoe'), 0));
end $$;

-- p_bets: [{"k": "player" | "banker" | "tie" | "ppair" | "bpair", "a": amount}]
create or replace function public.bac_deal(p_bets jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('bac'); shoe int[]; road jsonb; fresh boolean := false;
  b jsonb; k text; a bigint; staked bigint := 0; pay bigint := 0; back bigint; n int;
  p int[]; bk int[]; p3 int; v int; bt int; pt int; draw boolean; r text; pp boolean; bp boolean; has_p boolean := false; has_b boolean := false; c bigint;
begin
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 or jsonb_array_length(p_bets) > 5 then raise exception 'invalid bets'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    k := b->>'k'; a := (b->>'a')::bigint;
    if k not in ('player', 'banker', 'tie', 'ppair', 'bpair') or a is null or a < 1 then raise exception 'invalid bet'; end if;
    if k = 'player' then has_p := true; end if; if k = 'banker' then has_b := true; end if;
    staked := staked + a;
  end loop;
  if has_p and has_b then raise exception 'bet player or banker, not both'; end if;
  if staked < 5 or staked > w.chips then raise exception 'invalid bet'; end if;
  select array_agg(x::int order by o) into shoe from jsonb_array_elements_text(coalesce(s->'shoe', '[]')) with ordinality t(x, o);
  road := coalesce(s->'road', '[]');
  if coalesce(array_length(shoe, 1), 0) < 15 then shoe := public.cz_deck(8); road := '[]'; fresh := true; end if;
  -- cards come off the end of the shoe: player, banker, player, banker
  n := array_length(shoe, 1);
  p := array[shoe[n], shoe[n - 2]]; bk := array[shoe[n - 1], shoe[n - 3]]; n := n - 4;
  if public.bac_tot(p) < 8 and public.bac_tot(bk) < 8 then
    p3 := null;
    if public.bac_tot(p) <= 5 then p3 := shoe[n]; n := n - 1; p := p || p3; end if;
    bt := public.bac_tot(bk);
    if p3 is null then draw := bt <= 5;
    else
      v := public.bac_val(p3);
      draw := bt <= 2 or (bt = 3 and v <> 8) or (bt = 4 and v between 2 and 7) or (bt = 5 and v between 4 and 7) or (bt = 6 and v in (6, 7));
    end if;
    if draw then bk := bk || shoe[n]; n := n - 1; end if;
  end if;
  shoe := shoe[1:n];
  pt := public.bac_tot(p); bt := public.bac_tot(bk);
  r := case when pt > bt then 'P' when bt > pt then 'B' else 'T' end;
  pp := p[1] % 13 = p[2] % 13; bp := bk[1] % 13 = bk[2] % 13;
  for b in select * from jsonb_array_elements(p_bets) loop
    k := b->>'k'; a := (b->>'a')::bigint;
    back := case k
      when 'player' then case r when 'P' then 2 * a when 'T' then a else 0 end
      when 'banker' then case r when 'B' then a + floor(a * 95 / 100.0)::bigint when 'T' then a else 0 end
      when 'tie' then case when r = 'T' then 9 * a else 0 end
      when 'ppair' then case when pp then 12 * a else 0 end
      when 'bpair' then case when bp then 12 * a else 0 end
      else 0 end;
    pay := pay + back;
  end loop;
  road := road || jsonb_build_array(jsonb_build_array(r, case when pp then 1 else 0 end, case when bp then 1 else 0 end));
  if jsonb_array_length(road) > 84 then road := (select jsonb_agg(e order by o) from jsonb_array_elements(road) with ordinality t(e, o) where o > jsonb_array_length(road) - 84); end if;
  perform public.cz_save('bac', jsonb_build_object('shoe', to_jsonb(shoe), 'road', road));
  c := public.cz_settle(staked, pay);
  return jsonb_build_object('chips', c, 'player', to_jsonb(p), 'banker', to_jsonb(bk), 'result', r, 'payout', pay, 'staked', staked, 'net', pay - staked,
    'road', road, 'left', coalesce(array_length(shoe, 1), 0), 'fresh', fresh);
end $$;

revoke all on function public.bac_val(int), public.bac_tot(int[]), public.bac_state(), public.bac_deal(jsonb) from public, anon, authenticated;
grant execute on function public.bac_state(), public.bac_deal(jsonb) to authenticated;
/* ======================= Three Card Poker ======================= */
-- returns {cat, high, score}: cat 0 high card, 1 pair, 2 flush, 3 straight, 4 trips, 5 straight flush
create or replace function public.tcp_eval(h int[]) returns jsonb language plpgsql immutable as $$
declare v int[]; flush boolean; wheel boolean; straight boolean; t int[]; cat int;
begin
  select array_agg(case when x % 13 = 0 then 14 else x % 13 + 1 end order by case when x % 13 = 0 then 14 else x % 13 + 1 end desc) into v from unnest(h) x;
  flush := h[1] / 13 = h[2] / 13 and h[2] / 13 = h[3] / 13;
  wheel := v = array[14, 3, 2];
  straight := (v[1] - v[2] = 1 and v[2] - v[3] = 1) or wheel;
  if straight and flush then cat := 5; t := case when wheel then array[3, 2, 1] else v end;
  elsif v[1] = v[3] then cat := 4; t := v;
  elsif straight then cat := 3; t := case when wheel then array[3, 2, 1] else v end;
  elsif flush then cat := 2; t := v;
  elsif v[1] = v[2] or v[2] = v[3] then cat := 1; t := array[v[2], v[2], case when v[1] = v[2] then v[3] else v[1] end];
  else cat := 0; t := v; end if;
  return jsonb_build_object('cat', cat, 'high', t[1], 'score', ((cat * 15 + t[1]) * 15 + t[2]) * 15 + t[3]);
end $$;

-- settle the saved hand (play: true, false = fold, null = Pair Plus only), clear it, pay out
create or replace function public.tcp_finish(s jsonb, p_play boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare player int[]; dealer int[]; ante bigint := (s->>'ante')::bigint; pair bigint := (s->>'pair')::bigint; pe jsonb; de jsonb; q boolean;
  payout bigint := 0; outcome text; bonus bigint := 0; pp bigint := 0; staked bigint; c bigint;
begin
  select array_agg(x::int order by o) into player from jsonb_array_elements_text(s->'player') with ordinality t(x, o);
  select array_agg(x::int order by o) into dealer from jsonb_array_elements_text(s->'dealer') with ordinality t(x, o);
  pe := public.tcp_eval(player); de := public.tcp_eval(dealer);
  q := (de->>'cat')::int >= 1 or (de->>'high')::int >= 12;
  if pair > 0 and (pe->>'cat')::int >= 1 then
    pp := pair * (array[0, 1, 3, 6, 30, 40])[(pe->>'cat')::int + 1]; payout := payout + pair + pp;
  end if;
  if ante > 0 then
    if not coalesce(p_play, false) then outcome := 'fold';
    else
      bonus := ante * (array[0, 0, 0, 1, 4, 5])[(pe->>'cat')::int + 1]; payout := payout + bonus;
      if not q then outcome := 'noqual'; payout := payout + 3 * ante;
      elsif (pe->>'score')::int > (de->>'score')::int then outcome := 'win'; payout := payout + 4 * ante;
      elsif (pe->>'score')::int < (de->>'score')::int then outcome := 'lose';
      else outcome := 'push'; payout := payout + 2 * ante; end if;
    end if;
  end if;
  staked := ante + pair + case when coalesce(p_play, false) then ante else 0 end;
  perform public.cz_save('tcp', '{}'::jsonb);
  -- the Ante and Pair Plus were taken at the deal and the Play bet just now; pay what comes back
  c := public.cz_settle(0, payout, true);
  return jsonb_build_object('chips', c, 'phase', 'bet', 'player', s->'player', 'dealer', s->'dealer', 'ante', ante, 'pair', pair, 'played', coalesce(p_play, false),
    'result', jsonb_build_object('outcome', outcome, 'qualifies', q, 'bonus', bonus, 'pairPay', pp,
      'pcat', (pe->>'cat')::int, 'dcat', (de->>'cat')::int),
    'payout', payout, 'staked', staked, 'net', payout - staked);
end $$;

create or replace function public.tcp_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('tcp');
begin
  perform public.casino_publish(w.user_id, w.chips, false);
  if s ? 'player' then
    return jsonb_build_object('chips', w.chips, 'phase', 'decide', 'player', s->'player', 'dealer', '[-1, -1, -1]'::jsonb, 'ante', (s->>'ante')::bigint, 'pair', (s->>'pair')::bigint);
  end if;
  return jsonb_build_object('chips', w.chips, 'phase', 'bet');
end $$;

create or replace function public.tcp_deal(p_ante bigint, p_pair bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('tcp'); d int[]; c bigint;
begin
  if s ? 'player' then return public.tcp_state(); end if;
  if p_ante is null or p_pair is null or p_ante < 0 or p_pair < 0 or p_ante + p_pair < 5 or p_ante + p_pair > w.chips then raise exception 'invalid bet'; end if;
  d := public.cz_deck(1);
  s := jsonb_build_object('player', to_jsonb(d[1:3]), 'dealer', to_jsonb(d[4:6]), 'ante', p_ante, 'pair', p_pair);
  perform public.cz_save('tcp', s);
  c := public.cz_settle(p_ante + p_pair, 0, false);
  if p_ante = 0 then return public.tcp_finish(s, null); end if;
  return jsonb_build_object('chips', c, 'phase', 'decide', 'player', s->'player', 'dealer', '[-1, -1, -1]'::jsonb, 'ante', p_ante, 'pair', p_pair);
end $$;

create or replace function public.tcp_decide(p_play boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('tcp');
begin
  if not (s ? 'player') then return public.tcp_state(); end if;
  if coalesce(p_play, false) then
    if w.chips < (s->>'ante')::bigint then raise exception 'not enough chips'; end if;
    update public.casino_wallet set chips = chips - (s->>'ante')::bigint, updated_at = now() where user_id = w.user_id;
  end if;
  return public.tcp_finish(s, coalesce(p_play, false));
end $$;

revoke all on function public.tcp_eval(int[]), public.tcp_finish(jsonb, boolean), public.tcp_state(), public.tcp_deal(bigint, bigint), public.tcp_decide(boolean) from public, anon, authenticated;
grant execute on function public.tcp_state(), public.tcp_deal(bigint, bigint), public.tcp_decide(boolean) to authenticated;
/* ======================= Craps ======================= */
-- one roll against the bets on the table: returns {point, bets, pay, res}. Mirrors resolveRoll() in craps.html.
create or replace function public.craps_resolve(p_point int, p_bets jsonb, d1 int, d2 int) returns jsonb language plpgsql immutable as $$
declare s int := d1 + d2; hard boolean := d1 = d2; nxt jsonb := p_bets; res jsonb := '{}'; pay bigint := 0; k text; a bigint; n int; m int; np int := p_point; ret bigint; outcome text;
  ord text[] := array['come4', 'come5', 'come6', 'come8', 'come9', 'come10', 'pass', 'odds', 'dontpass', 'dpodds', 'come', 'field',
    'place4', 'place5', 'place6', 'place8', 'place9', 'place10', 'hard4', 'hard6', 'hard8', 'hard10', 'any7', 'anycraps', 'yo', 'aces', 'boxcars', 'acedeuce'];
begin
  foreach k in array ord loop
    a := coalesce((p_bets->>k)::bigint, 0);
    continue when a <= 0;
    outcome := null; ret := 0;
    if k ~ '^come[0-9]+$' then
      n := substr(k, 5)::int;
      if s = n then outcome := 'win'; ret := 2 * a; elsif s = 7 then outcome := 'lose'; end if;
    elsif k = 'pass' then
      if p_point is null then
        if s in (7, 11) then outcome := 'win'; ret := 2 * a; elsif s in (2, 3, 12) then outcome := 'lose'; end if;
      elsif s = p_point then outcome := 'win'; ret := 2 * a; elsif s = 7 then outcome := 'lose'; end if;
    elsif k = 'odds' then
      if p_point is not null then
        if s = p_point then outcome := 'win'; ret := a + case when p_point in (4, 10) then 2 * a when p_point in (5, 9) then a * 3 / 2 else a * 6 / 5 end;
        elsif s = 7 then outcome := 'lose'; end if;
      end if;
    elsif k = 'dontpass' then
      if p_point is null then
        if s in (2, 3) then outcome := 'win'; ret := 2 * a; elsif s = 12 then outcome := 'push'; ret := a; elsif s in (7, 11) then outcome := 'lose'; end if;
      elsif s = 7 then outcome := 'win'; ret := 2 * a; elsif s = p_point then outcome := 'lose'; end if;
    elsif k = 'dpodds' then
      if p_point is not null then
        if s = 7 then outcome := 'win'; ret := a + case when p_point in (4, 10) then a / 2 when p_point in (5, 9) then a * 2 / 3 else a * 5 / 6 end;
        elsif s = p_point then outcome := 'lose'; end if;
      end if;
    elsif k = 'come' then
      if s in (7, 11) then outcome := 'win'; ret := 2 * a; elsif s in (2, 3, 12) then outcome := 'lose';
      else
        nxt := (nxt - 'come') || jsonb_build_object('come' || s, coalesce((nxt->>('come' || s))::bigint, 0) + a);
        res := res || jsonb_build_object('come', 'move');
      end if;
    elsif k = 'field' then
      if s = 2 then outcome := 'win'; ret := 3 * a; elsif s = 12 then outcome := 'win'; ret := 4 * a;
      elsif s in (3, 4, 9, 10, 11) then outcome := 'win'; ret := 2 * a; else outcome := 'lose'; end if;
    elsif k like 'place%' then
      n := substr(k, 6)::int;
      if p_point is not null then
        if s = n then
          pay := pay + case when n in (4, 10) then a * 9 / 5 when n in (5, 9) then a * 7 / 5 else a * 7 / 6 end;
          res := res || jsonb_build_object(k, 'win');
        elsif s = 7 then outcome := 'lose'; end if;
      end if;
    elsif k like 'hard%' then
      n := substr(k, 5)::int;
      if p_point is not null then
        if s = n and hard then pay := pay + a * case when n in (4, 10) then 7 else 9 end; res := res || jsonb_build_object(k, 'win');
        elsif s = n or s = 7 then outcome := 'lose'; end if;
      end if;
    else
      m := case k when 'any7' then case when s = 7 then 4 else 0 end
        when 'anycraps' then case when s in (2, 3, 12) then 7 else 0 end
        when 'yo' then case when s = 11 then 15 else 0 end
        when 'aces' then case when s = 2 then 30 else 0 end
        when 'boxcars' then case when s = 12 then 30 else 0 end
        when 'acedeuce' then case when s = 3 then 15 else 0 end else 0 end;
      if m > 0 then outcome := 'win'; ret := a * (m + 1); else outcome := 'lose'; end if;
    end if;
    if outcome is not null then
      pay := pay + ret; res := res || jsonb_build_object(k, outcome); nxt := nxt - k;
    end if;
  end loop;
  if p_point is null then
    if s in (4, 5, 6, 8, 9, 10) then np := s; end if;
  elsif s = p_point or s = 7 then np := null;
  end if;
  return jsonb_build_object('point', np, 'bets', nxt, 'pay', pay, 'res', res);
end $$;

create or replace function public.craps_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('craps');
begin
  perform public.casino_publish(w.user_id, w.chips, false);
  return jsonb_build_object('chips', w.chips, 'point', s->'point', 'bets', coalesce(s->'bets', '{}'));
end $$;

-- p_add: new chips to put down before this roll, {key: amount}
create or replace function public.craps_roll(p_add jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('craps'); pt int; bets jsonb; k text; a bigint; staked bigint := 0;
  d1 int; d2 int; r jsonb; c bigint; lim int;
begin
  pt := nullif(s->>'point', '')::int;
  bets := coalesce(s->'bets', '{}');
  if p_add is null or jsonb_typeof(p_add) <> 'object' then raise exception 'invalid bets'; end if;
  for k, a in select key, (value #>> '{}')::bigint from jsonb_each(p_add) loop
    if a is null or a < 1 then raise exception 'invalid bet'; end if;
    if k not in ('pass', 'dontpass', 'odds', 'dpodds', 'come', 'field', 'place4', 'place5', 'place6', 'place8', 'place9', 'place10',
      'hard4', 'hard6', 'hard8', 'hard10', 'any7', 'anycraps', 'yo', 'aces', 'boxcars', 'acedeuce') then raise exception 'invalid bet'; end if;
    if k in ('pass', 'dontpass') and pt is not null then raise exception 'line bets go down before a point'; end if;
    if k = 'come' and pt is null then raise exception 'come bets need a point'; end if;
    if k = 'odds' then
      lim := case when pt in (4, 10) then 3 when pt in (5, 9) then 4 else 5 end;
      if pt is null or coalesce((bets->>'pass')::bigint, 0) = 0 or coalesce((bets->>'odds')::bigint, 0) + a > lim * (bets->>'pass')::bigint then raise exception 'odds over the limit'; end if;
    end if;
    if k = 'dpodds' then
      if pt is null or coalesce((bets->>'dontpass')::bigint, 0) = 0 or coalesce((bets->>'dpodds')::bigint, 0) + a > 6 * (bets->>'dontpass')::bigint then raise exception 'lay odds over the limit'; end if;
    end if;
    bets := bets || jsonb_build_object(k, coalesce((bets->>k)::bigint, 0) + a);
    staked := staked + a;
  end loop;
  if staked > w.chips then raise exception 'not enough chips'; end if;
  if bets = '{}'::jsonb then raise exception 'no bets'; end if;
  d1 := 1 + public.cz_rand(6); d2 := 1 + public.cz_rand(6);
  r := public.craps_resolve(pt, bets, d1, d2);
  perform public.cz_save('craps', jsonb_build_object('point', r->'point', 'bets', r->'bets'));
  c := public.cz_settle(staked, (r->>'pay')::bigint, true);
  return jsonb_build_object('chips', c, 'point', r->'point', 'bets', r->'bets', 'dice', jsonb_build_array(d1, d2), 'pay', (r->>'pay')::bigint, 'res', r->'res', 'staked', staked);
end $$;

-- take the place bets and hardways back
create or replace function public.craps_takedown() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('craps'); bets jsonb := coalesce(s->'bets', '{}'); back bigint := 0; k text; c bigint;
begin
  for k in select key from jsonb_each(bets) where key ~ '^(place|hard)' loop
    back := back + (bets->>k)::bigint; bets := bets - k;
  end loop;
  perform public.cz_save('craps', jsonb_build_object('point', s->'point', 'bets', bets));
  c := public.cz_settle(0, back, false);
  return jsonb_build_object('chips', c, 'point', s->'point', 'bets', bets, 'back', back);
end $$;

revoke all on function public.craps_resolve(int, jsonb, int, int), public.craps_state(), public.craps_roll(jsonb), public.craps_takedown() from public, anon, authenticated;
grant execute on function public.craps_state(), public.craps_roll(jsonb), public.craps_takedown() to authenticated;
