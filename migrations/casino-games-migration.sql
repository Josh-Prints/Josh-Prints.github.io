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
