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
/* ======================= Sic Bo ======================= */
create or replace function public.sicbo_back(k text, a bigint, d int[]) returns bigint language plpgsql immutable as $$
declare s int := d[1] + d[2] + d[3]; triple boolean := d[1] = d[2] and d[2] = d[3]; n int; c int;
begin
  if k = 'small' then return case when s between 4 and 10 and not triple then 2 * a else 0 end; end if;
  if k = 'big' then return case when s between 11 and 17 and not triple then 2 * a else 0 end; end if;
  if k = 'anyt' then return case when triple then 31 * a else 0 end; end if;
  if k ~ '^c[1-6][1-6]$' then
    return case when substr(k, 2, 1)::int = any(d) and substr(k, 3, 1)::int = any(d) then 6 * a else 0 end;
  end if;
  n := substr(k, 2)::int;
  select count(*) into c from unnest(d) x where x = n;
  return case left(k, 1)
    when 't' then case when triple and d[1] = n then 181 * a else 0 end
    when 'd' then case when c >= 2 then 11 * a else 0 end
    when 's' then case when s = n then a * (1 + (array[60, 30, 17, 12, 8, 6, 6, 6, 6, 8, 12, 17, 30, 60])[n - 3]) else 0 end
    when 'n' then case when c > 0 then a * (1 + c) else 0 end
    else 0 end;
end $$;

create or replace function public.sicbo_roll(p_bets jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); b jsonb; k text; a bigint; staked bigint := 0; pay bigint := 0; d int[]; c bigint;
begin
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 or jsonb_array_length(p_bets) > 60 then raise exception 'invalid bets'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    k := b->>'k'; a := (b->>'a')::bigint;
    if a is null or a < 1 or not (k ~ '^(small|big|anyt|[tdn][1-6]|s([4-9]|1[0-7])|c(12|13|14|15|16|23|24|25|26|34|35|36|45|46|56))$') then raise exception 'invalid bet'; end if;
    staked := staked + a;
  end loop;
  if staked > w.chips then raise exception 'not enough chips'; end if;
  d := array[1 + public.cz_rand(6), 1 + public.cz_rand(6), 1 + public.cz_rand(6)];
  for b in select * from jsonb_array_elements(p_bets) loop pay := pay + public.sicbo_back(b->>'k', (b->>'a')::bigint, d); end loop;
  c := public.cz_settle(staked, pay);
  return jsonb_build_object('chips', c, 'dice', to_jsonb(d), 'payout', pay, 'staked', staked, 'net', pay - staked);
end $$;

/* ======================= Keno ======================= */
create or replace function public.keno_pay(spots int, hits int) returns int language sql immutable as $$
  select coalesce((('{"1":{"1":3},"2":{"2":15},"3":{"2":2,"3":46},"4":{"2":1,"3":5,"4":160},"5":{"3":3,"4":12,"5":810},"6":{"3":1,"4":7,"5":110,"6":1800},'
    || '"7":{"3":1,"4":2,"5":21,"6":400,"7":7000},"8":{"4":2,"5":12,"6":98,"7":1652,"8":10000},"9":{"4":1,"5":6,"6":44,"7":335,"8":4700,"9":10000},'
    || '"10":{"5":5,"6":22,"7":142,"8":1000,"9":4500,"10":10000}}')::jsonb -> spots::text ->> hits::text)::int, 0)
$$;

create or replace function public.keno_draw(p_picks int[], p_bet bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); drawn int[]; hits int; n int; pay bigint; c bigint;
begin
  n := coalesce(array_length(p_picks, 1), 0);
  if n < 1 or n > 10 or (select count(distinct x) from unnest(p_picks) x where x between 1 and 80) <> n then raise exception 'invalid picks'; end if;
  if p_bet is null or p_bet not in (1, 2, 5, 10, 25, 50, 100, 250, 500) or p_bet > w.chips then raise exception 'invalid bet'; end if;
  select (array_agg(x order by random()))[1:20] into drawn from generate_series(1, 80) x;
  select count(*) into hits from unnest(p_picks) x where x = any(drawn);
  pay := public.keno_pay(n, hits)::bigint * p_bet;
  c := public.cz_settle(p_bet, pay);
  return jsonb_build_object('chips', c, 'drawn', to_jsonb(drawn), 'hits', hits, 'payout', pay, 'staked', p_bet, 'net', pay - p_bet);
end $$;

/* ======================= Big Six ======================= */
create or replace function public.bigsix_spin(p_bets jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); wheel text := 'J21512X121152T121152X112115L21211X521211T25121X1251211';
  b jsonb; k text; a bigint; staked bigint := 0; pay bigint := 0; i int; sym text; m int; c bigint;
begin
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 or jsonb_array_length(p_bets) > 7 then raise exception 'invalid bets'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    k := b->>'k'; a := (b->>'a')::bigint;
    if a is null or a < 1 or k not in ('1', '2', '5', 'X', 'T', 'J', 'L') then raise exception 'invalid bet'; end if;
    staked := staked + a;
  end loop;
  if staked > w.chips then raise exception 'not enough chips'; end if;
  i := public.cz_rand(54); sym := substr(wheel, i + 1, 1);
  m := case sym when '1' then 1 when '2' then 2 when '5' then 5 when 'X' then 10 when 'T' then 20 else 40 end;
  for b in select * from jsonb_array_elements(p_bets) loop
    if b->>'k' = sym then pay := pay + (b->>'a')::bigint * (m + 1); end if;
  end loop;
  c := public.cz_settle(staked, pay);
  return jsonb_build_object('chips', c, 'index', i, 'sym', sym, 'payout', pay, 'staked', staked, 'net', pay - staked);
end $$;

/* ======================= Casino War ======================= */
create or replace function public.war_rank(c int) returns int language sql immutable as $$ select case when c % 13 = 0 then 14 else c % 13 + 1 end $$;

-- settle a saved hand: war null (no tie), true (went to war), false (surrendered). Returns {pay, outcome}
create or replace function public.war_settle(g jsonb, p_war boolean) returns jsonb language plpgsql immutable as $$
declare a bigint := (g->>'bet')::bigint; t bigint := (g->>'tie')::bigint; p int := public.war_rank((g->>'p')::int); d int := public.war_rank((g->>'d')::int);
  pay bigint := 0; outcome text; p2 int; d2 int;
begin
  if p = d and t > 0 then pay := 11 * t; end if;
  if p > d then outcome := 'win'; pay := pay + 2 * a;
  elsif p < d then outcome := 'lose';
  elsif p_war = false then outcome := 'surrender'; pay := pay + a / 2;
  else
    p2 := public.war_rank((g->>'p2')::int); d2 := public.war_rank((g->>'d2')::int);
    if p2 > d2 then outcome := 'warwin'; pay := pay + 3 * a;
    elsif p2 = d2 then outcome := 'wartie'; pay := pay + 4 * a;
    else outcome := 'warlose'; end if;
  end if;
  return jsonb_build_object('pay', pay, 'outcome', outcome);
end $$;

create or replace function public.war_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('war');
begin
  perform public.casino_publish(w.user_id, w.chips, false);
  if s ? 'p' then return jsonb_build_object('chips', w.chips, 'phase', 'tie', 'p', s->'p', 'd', s->'d', 'bet', s->'bet', 'tie', s->'tie'); end if;
  return jsonb_build_object('chips', w.chips, 'phase', 'bet');
end $$;

create or replace function public.war_deal(p_bet bigint, p_tie bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('war'); dk int[]; g jsonb; r jsonb; c bigint; tie_pay bigint;
begin
  if s ? 'p' then return public.war_state(); end if;
  if p_bet is null or p_tie is null or p_bet < 5 or p_tie < 0 or p_bet + p_tie > w.chips then raise exception 'invalid bet'; end if;
  dk := public.cz_deck(6);
  g := jsonb_build_object('p', dk[1], 'd', dk[2], 'bet', p_bet, 'tie', p_tie, 'burn', to_jsonb(dk[3:5]), 'p2', dk[6], 'd2', dk[7]);
  if public.war_rank(dk[1]) <> public.war_rank(dk[2]) then
    r := public.war_settle(g, null);
    c := public.cz_settle(p_bet + p_tie, (r->>'pay')::bigint);
    return jsonb_build_object('chips', c, 'phase', 'bet', 'p', dk[1], 'd', dk[2], 'bet', p_bet, 'tie', p_tie, 'outcome', r->>'outcome', 'pay', (r->>'pay')::bigint,
      'staked', p_bet + p_tie, 'net', (r->>'pay')::bigint - p_bet - p_tie);
  end if;
  -- a tie: pay the Tie bet now, keep the hand for the war-or-surrender choice
  tie_pay := case when p_tie > 0 then 11 * p_tie else 0 end;
  perform public.cz_save('war', g || jsonb_build_object('tiePaid', tie_pay));
  c := public.cz_settle(p_bet + p_tie, tie_pay, false);
  return jsonb_build_object('chips', c, 'phase', 'tie', 'p', dk[1], 'd', dk[2], 'bet', p_bet, 'tie', p_tie, 'tiePay', tie_pay);
end $$;

create or replace function public.war_decide(p_war boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); g jsonb := public.cz_state('war'); r jsonb; a bigint; staked bigint; c bigint; go boolean := coalesce(p_war, false);
begin
  if not (g ? 'p') then return public.war_state(); end if;
  a := (g->>'bet')::bigint;
  if go and w.chips < a then raise exception 'not enough chips'; end if;
  r := public.war_settle(g, go);
  staked := a + (g->>'tie')::bigint + case when go then a else 0 end;
  perform public.cz_save('war', '{}'::jsonb);
  c := public.cz_settle(case when go then a else 0 end, (r->>'pay')::bigint - (g->>'tiePaid')::bigint, true);
  return jsonb_build_object('chips', c, 'phase', 'bet', 'p', g->'p', 'd', g->'d', 'bet', a, 'tie', g->'tie', 'outcome', r->>'outcome', 'pay', (r->>'pay')::bigint,
    'p2', case when go then g->'p2' end, 'd2', case when go then g->'d2' end, 'burn', case when go then g->'burn' end, 'staked', staked, 'net', (r->>'pay')::bigint - staked);
end $$;

revoke all on function public.sicbo_back(text, bigint, int[]), public.sicbo_roll(jsonb), public.keno_pay(int, int), public.keno_draw(int[], bigint), public.bigsix_spin(jsonb),
  public.war_rank(int), public.war_settle(jsonb, boolean), public.war_state(), public.war_deal(bigint, bigint), public.war_decide(boolean) from public, anon, authenticated;
grant execute on function public.sicbo_roll(jsonb), public.keno_draw(int[], bigint), public.bigsix_spin(jsonb), public.war_state(), public.war_deal(bigint, bigint), public.war_decide(boolean) to authenticated;
/* ======================= Blackjack (full rules) ======================= */
-- Replaces the first blackjack table (bj_table / bj_*). Six-deck shoe kept in casino_play 'bj2', dealer peeks
-- and stands on all 17s, 3:2 blackjack, double any two, split to four hands (aces get one card), late
-- surrender, insurance. bj2_apply() mirrors bjApply() in blackjack.html step for step.

-- hands left half-played on the old table get their bet back
update public.casino_wallet w set chips = w.chips + b.wager, updated_at = now() from public.bj_table b where b.user_id = w.user_id and b.phase = 'play' and b.wager > 0;
update public.bj_table set wager = 0, phase = 'bet', player = '{}', dealer = '{}' where phase = 'play';

create or replace function public.bj2_ints(j jsonb) returns int[] language sql immutable as $$
  select coalesce(array_agg(x::int order by o), '{}') from jsonb_array_elements_text(coalesce(j, '[]')) with ordinality t(x, o)
$$;
create or replace function public.bj2_val(c int) returns int language sql immutable as $$ select case when c % 13 = 0 then 11 when c % 13 >= 9 then 10 else c % 13 + 1 end $$;
create or replace function public.bj2_bj(j jsonb) returns boolean language sql immutable as $$ select jsonb_array_length(j) = 2 and public.bj_total(public.bj2_ints(j)) = 21 $$;
-- take the last card off the shoe; it lands in s.last
create or replace function public.bj2_draw(s jsonb) returns jsonb language sql immutable as $$
  select jsonb_set(jsonb_set(s, '{last}', s->'shoe'->-1), '{shoe}', (s->'shoe') - (-1))
$$;

create or replace function public.bj2_finish(s jsonb, play boolean) returns jsonb language plpgsql immutable as $$
declare i int; h jsonb; t int; dt int; live boolean := false; pay bigint := (s->>'pay')::bigint; bet bigint;
begin
  if play then
    for i in 0 .. jsonb_array_length(s->'hands') - 1 loop
      h := s->'hands'->i;
      if (h->>'res') is null and public.bj_total(public.bj2_ints(h->'c')) <= 21 then live := true; end if;
    end loop;
    if live then
      while public.bj_total(public.bj2_ints(s->'dealer')) < 17 loop
        s := public.bj2_draw(s); s := jsonb_set(s, '{dealer}', (s->'dealer') || (s->'last'));
      end loop;
    end if;
  end if;
  dt := public.bj_total(public.bj2_ints(s->'dealer'));
  for i in 0 .. jsonb_array_length(s->'hands') - 1 loop
    h := s->'hands'->i;
    continue when (h->>'res') is not null;
    t := public.bj_total(public.bj2_ints(h->'c')); bet := (h->>'bet')::bigint;
    if t > 21 then h := jsonb_set(h, '{res}', '"bust"');
    elsif dt > 21 or t > dt then h := jsonb_set(h, '{res}', '"win"'); pay := pay + 2 * bet;
    elsif t < dt then h := jsonb_set(h, '{res}', '"lose"');
    else h := jsonb_set(h, '{res}', '"push"'); pay := pay + bet; end if;
    s := jsonb_set(s, array['hands', i::text], h);
  end loop;
  return s || jsonb_build_object('pay', pay, 'phase', 'bet');
end $$;

create or replace function public.bj2_after_peek(s jsonb) returns jsonb language plpgsql immutable as $$
declare dbj boolean := public.bj2_bj(s->'dealer'); h jsonb := s->'hands'->0; pbj boolean := public.bj2_bj(s->'hands'->0->'c');
  ins bigint := coalesce((s->>'ins')::bigint, 0); pay bigint := (s->>'pay')::bigint; bet bigint := (s->'hands'->0->>'bet')::bigint;
begin
  if ins > 0 then s := s || jsonb_build_object('insRes', case when dbj then 'win' else 'lose' end); if dbj then pay := pay + 3 * ins; end if; end if;
  if dbj then
    h := jsonb_set(h, '{res}', to_jsonb(case when pbj then 'push' else 'lose' end)); if pbj then pay := pay + bet; end if;
    return public.bj2_finish(jsonb_set(s, '{hands,0}', h) || jsonb_build_object('pay', pay), false);
  end if;
  if pbj then
    h := jsonb_set(h, '{res}', '"blackjack"'); pay := pay + bet + bet * 3 / 2;
    return public.bj2_finish(jsonb_set(s, '{hands,0}', h) || jsonb_build_object('pay', pay), false);
  end if;
  return s || jsonb_build_object('pay', pay, 'phase', 'play');
end $$;

create or replace function public.bj2_advance(s jsonb) returns jsonb language plpgsql immutable as $$
declare a int := (s->>'active')::int; n int := jsonb_array_length(s->'hands'); h jsonb;
begin
  while a < n and (s->'hands'->a->>'done')::boolean loop
    a := a + 1;
    if a < n then
      h := s->'hands'->a;
      if jsonb_array_length(h->'c') = 1 then
        s := public.bj2_draw(s); h := jsonb_set(h, '{c}', (h->'c') || (s->'last'));
        if (h->>'aces')::boolean or public.bj_total(public.bj2_ints(h->'c')) = 21 then h := jsonb_set(h, '{done}', 'true'); end if;
        s := jsonb_set(s, array['hands', a::text], h);
      end if;
    end if;
  end loop;
  s := jsonb_set(s, '{active}', to_jsonb(a));
  if a >= n then return public.bj2_finish(s, true); end if;
  return s;
end $$;

create or replace function public.bj2_options(s jsonb) returns jsonb language plpgsql immutable as $$
declare h jsonb; two boolean;
begin
  if coalesce(s->>'phase', 'bet') <> 'play' then return jsonb_build_object('hit', false, 'stand', false, 'double', false, 'split', false, 'surrender', false); end if;
  h := s->'hands'->((s->>'active')::int);
  two := jsonb_array_length(h->'c') = 2;
  return jsonb_build_object('hit', true, 'stand', true, 'double', two,
    'split', two and public.bj2_val((h->'c'->>0)::int) = public.bj2_val((h->'c'->>1)::int) and jsonb_array_length(s->'hands') < 4,
    'surrender', two and jsonb_array_length(s->'hands') = 1);
end $$;

create or replace function public.bj2_apply(s jsonb, act text) returns jsonb language plpgsql immutable as $$
declare a int; h jsonb; base bigint; d jsonb; p jsonb; aces boolean; bet bigint; nh jsonb;
begin
  s := s || jsonb_build_object('stake', 0, 'pay', 0);
  if act = 'deal' then
    base := (s->>'base')::bigint;
    s := public.bj2_draw(s); p := jsonb_build_array(s->'last');
    s := public.bj2_draw(s); d := jsonb_build_array(s->'last');
    s := public.bj2_draw(s); p := p || (s->'last');
    s := public.bj2_draw(s); d := d || (s->'last');
    s := s || jsonb_build_object('stake', base, 'dealer', d, 'active', 0, 'ins', 0, 'insRes', null,
      'hands', jsonb_build_array(jsonb_build_object('c', p, 'bet', base, 'dbl', false, 'done', false, 'split', false, 'aces', false, 'res', null)));
    if (d->>0)::int % 13 = 0 then return s || jsonb_build_object('phase', 'insurance'); end if;
    return public.bj2_after_peek(s);
  end if;
  if act in ('insure', 'noinsure') then
    if act = 'insure' then s := s || jsonb_build_object('ins', (s->'hands'->0->>'bet')::bigint / 2, 'stake', (s->'hands'->0->>'bet')::bigint / 2); end if;
    return public.bj2_after_peek(s);
  end if;
  a := (s->>'active')::int; h := s->'hands'->a; bet := (h->>'bet')::bigint;
  if act = 'hit' then
    s := public.bj2_draw(s); h := jsonb_set(h, '{c}', (h->'c') || (s->'last'));
    if public.bj_total(public.bj2_ints(h->'c')) >= 21 then h := jsonb_set(h, '{done}', 'true'); end if;
  elsif act = 'stand' then h := jsonb_set(h, '{done}', 'true');
  elsif act = 'double' then
    s := s || jsonb_build_object('stake', bet); s := public.bj2_draw(s);
    h := h || jsonb_build_object('bet', 2 * bet, 'dbl', true, 'done', true, 'c', (h->'c') || (s->'last'));
  elsif act = 'split' then
    aces := (h->'c'->>0)::int % 13 = 0;
    nh := jsonb_build_object('c', jsonb_build_array(h->'c'->1), 'bet', bet, 'dbl', false, 'done', false, 'split', true, 'aces', aces, 'res', null);
    s := s || jsonb_build_object('stake', bet); s := public.bj2_draw(s);
    h := h || jsonb_build_object('split', true, 'aces', aces, 'c', jsonb_build_array(h->'c'->0, s->'last'));
    if aces or public.bj_total(public.bj2_ints(h->'c')) = 21 then h := jsonb_set(h, '{done}', 'true'); end if;
    s := jsonb_set(s, '{hands}', (select jsonb_agg(e order by o) from (
      select e, o::numeric as o from jsonb_array_elements(s->'hands') with ordinality t(e, o)
      union all select nh, a + 1.5) x));
  elsif act = 'surrender' then
    h := jsonb_set(h, '{res}', '"surrender"');
    return public.bj2_finish(jsonb_set(s, array['hands', a::text], h) || jsonb_build_object('pay', bet / 2), false);
  end if;
  s := jsonb_set(s, array['hands', a::text], h);
  return public.bj2_advance(s);
end $$;

-- what the browser may see: the hole card stays hidden until the hand is over
create or replace function public.bj2_view(s jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('phase', coalesce(s->>'phase', 'bet'),
    'dealer', case when coalesce(s->>'phase', 'bet') = 'bet' then coalesce(s->'dealer', '[]') else jsonb_build_array(s->'dealer'->0, -1) end,
    'hands', coalesce(s->'hands', '[]'), 'active', coalesce(s->'active', '0'), 'ins', coalesce(s->'ins', '0'), 'insRes', s->'insRes', 'options', public.bj2_options(s))
$$;

create or replace function public.bj2_state() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('bj2');
begin
  perform public.casino_publish(w.user_id, w.chips, false);
  if coalesce(s->>'phase', 'bet') = 'bet' then return jsonb_build_object('chips', w.chips, 'phase', 'bet', 'dealer', '[]'::jsonb, 'hands', '[]'::jsonb, 'active', 0); end if;
  return jsonb_build_object('chips', w.chips) || public.bj2_view(s);
end $$;

create or replace function public.bj2_deal(p_bet bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('bj2'); r jsonb; fresh boolean := false; c bigint;
begin
  if coalesce(s->>'phase', 'bet') <> 'bet' then return public.bj2_state(); end if;
  if p_bet is null or p_bet < 5 or p_bet > w.chips then raise exception 'invalid bet'; end if;
  if coalesce(jsonb_array_length(s->'shoe'), 0) < 78 then s := s || jsonb_build_object('shoe', to_jsonb(public.cz_deck(6))); fresh := true; end if;
  r := public.bj2_apply(s || jsonb_build_object('base', p_bet), 'deal');
  perform public.cz_save('bj2', r - 'last');
  c := public.cz_settle((r->>'stake')::bigint, (r->>'pay')::bigint, r->>'phase' = 'bet');
  return jsonb_build_object('chips', c, 'stake', r->'stake', 'pay', r->'pay', 'fresh', fresh) || public.bj2_view(r);
end $$;

create or replace function public.bj2_act(p_action text) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row(); s jsonb := public.cz_state('bj2'); r jsonb; c bigint; ph text := coalesce(s->>'phase', 'bet');
begin
  if ph = 'insurance' then
    if p_action not in ('insure', 'noinsure') then return public.bj2_state(); end if;
  elsif ph = 'play' then
    if p_action not in ('hit', 'stand', 'double', 'split', 'surrender') or not coalesce((public.bj2_options(s)->>p_action)::boolean, false) then return public.bj2_state(); end if;
  else return public.bj2_state(); end if;
  r := public.bj2_apply(s, p_action);
  if (r->>'stake')::bigint > w.chips then raise exception 'not enough chips'; end if;
  perform public.cz_save('bj2', r - 'last');
  c := public.cz_settle((r->>'stake')::bigint, (r->>'pay')::bigint, r->>'phase' = 'bet');
  return jsonb_build_object('chips', c, 'stake', r->'stake', 'pay', r->'pay') || public.bj2_view(r);
end $$;

-- no resetting to 1,000 while chips are out on a hand in any game
create or replace function public.casino_topup() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row();
begin
  if w.chips < 1000
    and not exists (select 1 from public.bj_table where user_id = w.user_id and phase = 'play')
    and not exists (select 1 from public.casino_play where user_id = w.user_id and (
      (game = 'bj2' and coalesce(state->>'phase', 'bet') <> 'bet') or (game in ('vp', 'tcp') and (state ? 'hand' or state ? 'player')) or (game = 'war' and state ? 'p')
      or (game = 'craps' and coalesce(state->'bets', '{}') <> '{}'::jsonb)))
  then
    update public.casino_wallet set chips = 1000, updated_at = now() where user_id = w.user_id returning * into w;
    perform public.casino_publish(w.user_id, w.chips, false);
  end if;
  return jsonb_build_object('chips', w.chips);
end $$;

revoke all on function public.bj2_ints(jsonb), public.bj2_val(int), public.bj2_bj(jsonb), public.bj2_draw(jsonb), public.bj2_finish(jsonb, boolean), public.bj2_after_peek(jsonb),
  public.bj2_advance(jsonb), public.bj2_options(jsonb), public.bj2_apply(jsonb, text), public.bj2_view(jsonb), public.bj2_state(), public.bj2_deal(bigint), public.bj2_act(text),
  public.casino_topup() from public, anon, authenticated;
grant execute on function public.bj2_state(), public.bj2_deal(bigint), public.bj2_act(text), public.casino_topup() to authenticated;
/* ======================= Three Card Poker: multiplayer tables ======================= */
-- Shared tables: everyone seated bets in the same window, gets their own three cards, and plays against the
-- same dealer hand. There's no game server, so the table moves on whenever anyone at it calls in after a
-- deadline (mtcp_tick): betting (15s from the first bet) -> deciding (20s) -> showdown (7s) -> betting.
-- Pays exactly as the single-player game (tcp_eval, Pair Plus 40/30/6/3/1, ante bonus 5/4/1).

create table if not exists public.mtcp_tables (
  id int primary key,
  name text not null,
  min_bet bigint not null,
  phase text not null default 'betting' check (phase in ('betting', 'deciding', 'showdown')),
  deadline timestamptz,
  round int not null default 0,
  dealer int[] not null default '{}',
  updated_at timestamptz not null default now()
);
create table if not exists public.mtcp_seats (
  table_id int not null references public.mtcp_tables(id),
  seat int not null check (seat between 0 and 5),
  user_id uuid references auth.users(id) on delete set null,   -- null: the seat is free
  ante bigint not null default 0,
  pair bigint not null default 0,
  cards int[] not null default '{}',
  decision text check (decision in ('play', 'fold', 'auto')),
  result jsonb,
  leaving boolean not null default false,
  last_seen timestamptz not null default now(),
  primary key (table_id, seat),
  unique (table_id, user_id)
);
alter table public.mtcp_tables enable row level security;
alter table public.mtcp_seats enable row level security;
revoke all on table public.mtcp_tables, public.mtcp_seats from anon, authenticated;
insert into public.mtcp_tables (id, name, min_bet) values (1, 'Table 1', 5), (2, 'Table 2', 25), (3, 'High rollers', 100) on conflict (id) do nothing;
-- six seats per table, always there; taking a seat fills one, leaving empties it
insert into public.mtcp_seats (table_id, seat) select t, s from generate_series(1, 3) t, generate_series(0, 5) s on conflict do nothing;

-- what one hand pays (play: true / false = fold / null = Pair Plus only). Same maths as tcp_finish().
create or replace function public.mtcp_resolve(player int[], dealer int[], ante bigint, pair bigint, play boolean) returns jsonb language plpgsql immutable as $$
declare pe jsonb := public.tcp_eval(player); de jsonb := public.tcp_eval(dealer); q boolean; payout bigint := 0; outcome text; bonus bigint := 0; pp bigint := 0; staked bigint;
begin
  q := (de->>'cat')::int >= 1 or (de->>'high')::int >= 12;
  if pair > 0 and (pe->>'cat')::int >= 1 then pp := pair * (array[0, 1, 3, 6, 30, 40])[(pe->>'cat')::int + 1]; payout := payout + pair + pp; end if;
  if ante > 0 then
    if not coalesce(play, false) then outcome := 'fold';
    else
      bonus := ante * (array[0, 0, 0, 1, 4, 5])[(pe->>'cat')::int + 1]; payout := payout + bonus;
      if not q then outcome := 'noqual'; payout := payout + 3 * ante;
      elsif (pe->>'score')::int > (de->>'score')::int then outcome := 'win'; payout := payout + 4 * ante;
      elsif (pe->>'score')::int < (de->>'score')::int then outcome := 'lose';
      else outcome := 'push'; payout := payout + 2 * ante; end if;
    end if;
  end if;
  staked := ante + pair + case when coalesce(play, false) then ante else 0 end;
  return jsonb_build_object('payout', payout, 'outcome', outcome, 'bonus', bonus, 'pairPay', pp, 'staked', staked, 'net', payout - staked,
    'pcat', (pe->>'cat')::int, 'phigh', (pe->>'high')::int, 'dcat', (de->>'cat')::int, 'dhigh', (de->>'high')::int, 'qualifies', q);
end $$;

-- move the table along if a deadline has passed. Call with the table row already locked.
create or replace function public.mtcp_tick(p_table int) returns void language plpgsql security definer set search_path = public as $$
declare t public.mtcp_tables; s public.mtcp_seats; d int[]; i int; r jsonb; c bigint; steps int := 0;
begin
  loop
    steps := steps + 1; exit when steps > 3;
    select * into t from public.mtcp_tables where id = p_table;
    if t.phase = 'betting' then
      -- people who wandered off without a bet down lose their seat
      update public.mtcp_seats set user_id = null, ante = 0, pair = 0, cards = '{}', decision = null, result = null, leaving = false where table_id = p_table and user_id is not null and ante = 0 and pair = 0 and last_seen < now() - interval '90 seconds';
      exit when t.deadline is null or now() < t.deadline;
      if not exists (select 1 from public.mtcp_seats where table_id = p_table and ante + pair > 0) then
        update public.mtcp_tables set deadline = null where id = p_table; exit;
      end if;
      d := public.cz_deck(1); i := 0;
      for s in select * from public.mtcp_seats where table_id = p_table and user_id is not null and ante + pair > 0 order by seat loop
        update public.mtcp_seats set cards = d[i * 3 + 1 : i * 3 + 3], decision = case when s.ante = 0 then 'auto' end, result = null
          where table_id = p_table and seat = s.seat;
        i := i + 1;
      end loop;
      update public.mtcp_tables set phase = 'deciding', deadline = now() + interval '20 seconds', dealer = d[i * 3 + 1 : i * 3 + 3], updated_at = now() where id = p_table;
    elsif t.phase = 'deciding' then
      exit when now() < t.deadline and exists (select 1 from public.mtcp_seats where table_id = p_table and user_id is not null and cardinality(cards) = 3 and decision is null);
      for s in select * from public.mtcp_seats where table_id = p_table and user_id is not null and cardinality(cards) = 3 order by seat loop
        r := public.mtcp_resolve(s.cards, t.dealer, s.ante, s.pair, case when s.ante = 0 then null else s.decision = 'play' end);
        update public.mtcp_seats set result = r, decision = coalesce(decision, 'fold') where table_id = p_table and seat = s.seat;
        update public.casino_wallet set chips = chips + (r->>'payout')::bigint, updated_at = now() where user_id = s.user_id returning chips into c;
        perform public.casino_publish(s.user_id, c, true);
      end loop;
      update public.mtcp_tables set phase = 'showdown', deadline = now() + interval '7 seconds', updated_at = now() where id = p_table;
    else
      exit when now() < t.deadline;
      update public.mtcp_seats set user_id = null, ante = 0, pair = 0, cards = '{}', decision = null, result = null, leaving = false where table_id = p_table and leaving;
      update public.mtcp_seats set ante = 0, pair = 0, cards = '{}', decision = null, result = null where table_id = p_table;
      update public.mtcp_tables set phase = 'betting', deadline = null, dealer = '{}', round = round + 1, updated_at = now() where id = p_table;
    end if;
  end loop;
end $$;

-- the table as one player sees it
create or replace function public.mtcp_view(p_table int) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); t public.mtcp_tables; me int; seats jsonb; chips bigint;
begin
  perform 1 from public.mtcp_tables where id = p_table for update;
  if not found then raise exception 'no such table'; end if;
  perform public.mtcp_tick(p_table);
  select * into t from public.mtcp_tables where id = p_table;
  if uid is not null then
    update public.mtcp_seats set last_seen = now() where table_id = p_table and user_id = uid returning seat into me;
    select w.chips into chips from public.casino_wallet w where w.user_id = uid;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'seat', s.seat, 'name', public.game_player_name(s.user_id), 'me', s.user_id = uid, 'ante', s.ante, 'pair', s.pair, 'leaving', s.leaving,
      'decision', s.decision,
      'cards', case when cardinality(s.cards) = 0 then '[]'::jsonb
                    when s.user_id = uid or t.phase = 'showdown' then to_jsonb(s.cards) else '[-1, -1, -1]'::jsonb end,
      'result', case when t.phase = 'showdown' then s.result end) order by s.seat), '[]') into seats
  from public.mtcp_seats s where s.table_id = p_table and s.user_id is not null;
  return jsonb_build_object('id', t.id, 'name', t.name, 'min', t.min_bet, 'phase', t.phase, 'round', t.round,
    'secs', case when t.deadline is null then null else greatest(0, ceil(extract(epoch from t.deadline - now())))::int end,
    'dealer', case when t.phase = 'showdown' then to_jsonb(t.dealer) when t.phase = 'deciding' then '[-1, -1, -1]'::jsonb else '[]'::jsonb end,
    'seats', seats, 'me', me, 'chips', chips);
end $$;

create or replace function public.mtcp_lobby() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'min', t.min_bet, 'phase', t.phase,
    'players', (select count(*) from public.mtcp_seats s where s.table_id = t.id and s.user_id is not null and s.last_seen > now() - interval '90 seconds'),
    'mine', exists (select 1 from public.mtcp_seats s where s.table_id = t.id and s.user_id = auth.uid())) order by t.id), '[]')
  from public.mtcp_tables t
$$;

create or replace function public.mtcp_sit(p_table int, p_seat int) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first'; end if;
  perform 1 from public.mtcp_tables where id = p_table for update;
  if not found then raise exception 'no such table'; end if;
  if exists (select 1 from public.mtcp_seats where user_id = uid and table_id <> p_table) then raise exception 'leave your other table first'; end if;
  if not exists (select 1 from public.mtcp_seats where table_id = p_table and user_id = uid) then
    if p_seat is null or p_seat < 0 or p_seat > 5 or exists (select 1 from public.mtcp_seats where table_id = p_table and seat = p_seat and user_id is not null) then raise exception 'seat taken'; end if;
    perform public.casino_row();
    update public.mtcp_seats set user_id = uid, ante = 0, pair = 0, cards = '{}', decision = null, result = null, leaving = false, last_seen = now() where table_id = p_table and seat = p_seat;
  end if;
  return public.mtcp_view(p_table);
end $$;

create or replace function public.mtcp_leave(p_table int) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); t public.mtcp_tables; s public.mtcp_seats;
begin
  select * into t from public.mtcp_tables where id = p_table for update;
  select * into s from public.mtcp_seats where table_id = p_table and user_id = uid;
  if found then
    if cardinality(s.cards) = 3 then
      -- in a hand: an unplayed hand folds now, and the seat goes after the showdown
      update public.mtcp_seats set leaving = true, decision = coalesce(decision, 'fold') where table_id = p_table and seat = s.seat;
    else
      perform public.casino_row();
      if s.ante + s.pair > 0 then update public.casino_wallet set chips = chips + s.ante + s.pair, updated_at = now() where user_id = uid; end if;
      update public.mtcp_seats set user_id = null, ante = 0, pair = 0, cards = '{}', decision = null, result = null, leaving = false where table_id = p_table and seat = s.seat;
    end if;
  end if;
  return public.mtcp_lobby();
end $$;

-- put down (or change) this round's Ante and Pair Plus
create or replace function public.mtcp_bet(p_table int, p_ante bigint, p_pair bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); t public.mtcp_tables; s public.mtcp_seats; w public.casino_wallet;
begin
  select * into t from public.mtcp_tables where id = p_table for update;
  perform public.mtcp_tick(p_table);
  select * into t from public.mtcp_tables where id = p_table;
  if t.phase <> 'betting' then raise exception 'betting is closed'; end if;
  select * into s from public.mtcp_seats where table_id = p_table and user_id = uid;
  if not found then raise exception 'take a seat first'; end if;
  if p_ante is null or p_pair is null or p_ante < 0 or p_pair < 0 or (p_ante > 0 and p_ante < t.min_bet) or (p_pair > 0 and p_pair < t.min_bet)
    or (p_ante = 0 and p_pair = 0 and s.ante + s.pair = 0) then raise exception 'invalid bet'; end if;
  w := public.casino_row();
  if w.chips + s.ante + s.pair < p_ante + p_pair then raise exception 'not enough chips'; end if;
  update public.casino_wallet set chips = chips + s.ante + s.pair - p_ante - p_pair, updated_at = now() where user_id = uid;
  update public.mtcp_seats set ante = p_ante, pair = p_pair, last_seen = now() where table_id = p_table and seat = s.seat;
  if p_ante + p_pair > 0 then
    -- the first bet starts the clock; once everyone seated has bet, deal almost straight away
    if t.deadline is null then t.deadline := now() + interval '15 seconds'; end if;
    if not exists (select 1 from public.mtcp_seats where table_id = p_table and user_id is not null and ante + pair = 0) then t.deadline := least(t.deadline, now() + interval '3 seconds'); end if;
    update public.mtcp_tables set deadline = t.deadline where id = p_table;
  end if;
  return public.mtcp_view(p_table);
end $$;

create or replace function public.mtcp_decide(p_table int, p_play boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); t public.mtcp_tables; s public.mtcp_seats; w public.casino_wallet;
begin
  select * into t from public.mtcp_tables where id = p_table for update;
  perform public.mtcp_tick(p_table);
  select * into t from public.mtcp_tables where id = p_table;
  select * into s from public.mtcp_seats where table_id = p_table and user_id = uid;
  if t.phase = 'deciding' and found and cardinality(s.cards) = 3 and s.ante > 0 and s.decision is null then
    if coalesce(p_play, false) then
      w := public.casino_row();
      if w.chips < s.ante then raise exception 'not enough chips'; end if;
      update public.casino_wallet set chips = chips - s.ante, updated_at = now() where user_id = uid;
    end if;
    update public.mtcp_seats set decision = case when coalesce(p_play, false) then 'play' else 'fold' end, last_seen = now() where table_id = p_table and seat = s.seat;
  end if;
  return public.mtcp_view(p_table);
end $$;

-- no resetting to 1,000 while chips are out on a hand in any game, multiplayer tables included
create or replace function public.casino_topup() returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.casino_wallet := public.casino_row();
begin
  if w.chips < 1000
    and not exists (select 1 from public.bj_table where user_id = w.user_id and phase = 'play')
    and not exists (select 1 from public.mtcp_seats where user_id = w.user_id and (ante + pair > 0 or cardinality(cards) = 3))
    and not exists (select 1 from public.casino_play where user_id = w.user_id and (
      (game = 'bj2' and coalesce(state->>'phase', 'bet') <> 'bet') or (game in ('vp', 'tcp') and (state ? 'hand' or state ? 'player')) or (game = 'war' and state ? 'p')
      or (game = 'craps' and coalesce(state->'bets', '{}') <> '{}'::jsonb)))
  then
    update public.casino_wallet set chips = 1000, updated_at = now() where user_id = w.user_id returning * into w;
    perform public.casino_publish(w.user_id, w.chips, false);
  end if;
  return jsonb_build_object('chips', w.chips);
end $$;

revoke all on function public.mtcp_resolve(int[], int[], bigint, bigint, boolean), public.mtcp_tick(int), public.mtcp_view(int), public.mtcp_lobby(),
  public.mtcp_sit(int, int), public.mtcp_leave(int), public.mtcp_bet(int, bigint, bigint), public.mtcp_decide(int, boolean), public.casino_topup() from public, anon, authenticated;
grant execute on function public.mtcp_view(int), public.mtcp_lobby(), public.mtcp_sit(int, int), public.mtcp_leave(int), public.mtcp_bet(int, bigint, bigint),
  public.mtcp_decide(int, boolean), public.casino_topup() to authenticated;
grant execute on function public.mtcp_lobby(), public.mtcp_view(int) to anon;
