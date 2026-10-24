import { startLive } from '/live.js?v=2';
/* Shared by the casino game pages: sign-in panel, the casino leaderboard, time played, the guests' chip bank,
   sound, playing cards, dice, the chip rack and a betting board. Each game page imports what it needs and
   supplies its own rules: a `remote` engine (the server deals and pays out for signed-in players, so the
   leaderboard can't be faked) and a `local` engine with the same rules for guests. */

export const $ = id => document.getElementById(id);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const fmt = v => Number(v).toLocaleString();
export const short = v => v >= 1e6 ? +(v / 1e6).toFixed(1) + 'm' : v >= 1e4 ? Math.round(v / 1e3) + 'k' : v >= 1e3 ? +(v / 1e3).toFixed(1) + 'k' : String(v);
export function fmtLong(s){ s = Math.round(Number(s) || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's'; }
// a fair random integer 0..n-1
export function rand(n){
  try { const a = new Uint32Array(1), lim = 4294967296 - 4294967296 % n; do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % n; }
  catch (e) { return Math.floor(Math.random() * n); }
}
export function shuffle(arr){ for (let i = arr.length - 1; i > 0; i--){ const j = rand(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
export function newDeck(decks){ const s = []; for (let d = 0; d < (decks || 1); d++) for (let c = 0; c < 52; c++) s.push(c); return shuffle(s); }

/* ---------- guests: one chip bank on this device for every casino game ---------- */
// Guest chips are signed, so editing them by hand (a bookmarklet, the console) is caught.
// It's only a speed bump: anything in the browser can be undone. Signed-in chips live on the server.
const sig = v => { let h = 0x811c9dc5; const t = 'vx' + v + 'c4s1n0'; for (let i = 0; i < t.length; i++){ h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); };
let lastGoodChips = null;
try { ['casino-loan', 'casino-loan-k', 'casino-grant', 'casino-grant-k'].forEach(k => localStorage.removeItem(k)); } catch (e) {}
function signedRead(key, sigKey, fallback){
  const v = localStorage.getItem(key), g = localStorage.getItem(sigKey);
  if (v === null){ if (g !== null) localStorage.removeItem(sigKey); return null; }
  if (g === null){ localStorage.setItem(sigKey, sig(v)); return v; }   // first run since signing started
  if (g === sig(v)) return v;
  guard.flag('edited-storage', key);
  fallback === null ? localStorage.removeItem(key) : localStorage.setItem(key, fallback);
  fallback === null ? localStorage.removeItem(sigKey) : localStorage.setItem(sigKey, sig(fallback));
  return fallback;
}
export const bank = {
  get(){
    try {
      const v = signedRead('casino-bank', 'casino-bank-k', lastGoodChips === null ? '1000' : String(lastGoodChips)) ?? localStorage.getItem('bj-bank');
      const c = Number(v); const out = v !== null && c >= 0 && isFinite(c) ? Math.floor(c) : 1000; lastGoodChips = out; return out;
    } catch (e) { return 1000; }
  },
  set(c){ try { const v = String(Math.max(0, Math.floor(c))); localStorage.setItem('casino-bank', v); localStorage.setItem('casino-bank-k', sig(v)); lastGoodChips = +v; } catch (e) {} },
  // is a guest hand still being played? (chips are out on the table)
  busy(){ try { const b = JSON.parse(localStorage.getItem('bj-guest') || 'null'); return !!localStorage.getItem('tcp-guest') || !!localStorage.getItem('hl-guest') || !!(b && b.phase && b.phase !== 'bet'); } catch (e) { return false; } },
  // there are no free chips any more: signed-in players buy chips with Vox points
  topup(){ throw Object.assign(new Error('free chips are gone: turn Vox points into chips'), { hint: 'casino_nofree' }); },
};

/* ---------- chips shown in the stats ---------- */
function loanChips(v){ const c = $('ln-chips'); if (c) c.textContent = fmt(v); }

/* ---------- Vox points: 1 chip = 1 point, both ways (signed-in players only) ---------- */
// Points reset every week and the week's top 3 go on the Vox leaderboard (games.html#vox). Free chips are gone:
// out of chips, you turn points (from Dune coins or earlier winnings) back into chips.
export function voxHtml(signed){
  return '<div class="loan" id="vox"><div class="me-row"><span>Chips</span><b id="ln-chips">…</b><span>Vox points</span><b id="vx-pts">' + (signed ? '…' : 'Sign in') + '</b></div>' +
    (signed
      ? '<input class="pinput" id="vx-amt" type="number" min="1" step="1" inputmode="numeric" placeholder="Amount" aria-label="Amount">' +
        '<div class="vx-fill"><button type="button" class="link" id="vx-allc">All chips</button><button type="button" class="link" id="vx-allp">All points</button></div>' +
        '<div class="loan-btns"><button type="button" class="pbtn" id="vx-in">Chips → points</button><button type="button" class="pbtn primary" id="vx-out">Points → chips</button></div><div class="pmsg" id="vx-msg" aria-live="polite"></div>'
      : '<p class="loan-note">Sign in to swap chips and <a href="/games.html#vox">Vox points</a>.</p>') +
    '</div>';
}
// api: { rpc(name, args), signed(), after(result) }; after() lets the page reload its chips
export function wireVox(api){
  const msgEl = $('vx-msg'), say = t => { if (msgEl) msgEl.textContent = t; };
  let last = null;
  const show = d => { last = d; const p = $('vx-pts'); if (p) p.textContent = fmt(d.points); loanChips(d.chips); };
  const refresh = async () => { if (!api.signed() || !$('vx-pts')) return; try { show(await api.rpc('vox_me')); } catch (e) {} };
  const amount = () => { const v = Math.floor(Number(($('vx-amt') || {}).value)); return v >= 1 && isFinite(v) ? v : 0; };
  const go = async (fn, verb) => {
    const n = amount(); if (!n){ say('Enter an amount.'); return; }
    $('vx-in').disabled = $('vx-out').disabled = true; say('');
    try { const d = await api.rpc(fn, { p_amount: n }); show(d); say(verb.replace('{n}', fmt(n))); $('vx-amt').value = ''; api.after && api.after(d); }
    catch (e) { say(/safe word/.test(e.message || '') ? 'Safe word needed.' : /chips/.test(e.message || '') ? 'Not enough chips.' : /points/.test(e.message || '') ? 'Not enough points.' : /locked|banned/.test(e.message || '') ? 'Casino locked.' : 'Something went wrong.'); }
    $('vx-in').disabled = $('vx-out').disabled = false;
  };
  if ($('vx-in')){
    $('vx-in').onclick = () => go('vox_from_chips', '+{n} points');
    $('vx-out').onclick = () => go('vox_to_chips', '+{n} chips');
    $('vx-allc').onclick = () => { if (last) $('vx-amt').value = last.chips || ''; };
    $('vx-allp').onclick = () => { if (last) $('vx-amt').value = last.points || ''; };
  }
  refresh();
  return refresh;
}
// the table's "Get chips" button: open the side panel at the Vox points block
export function openVox(){
  const side = $('side-right'); if (side) side.classList.add('open');
  const box = $('vox'); if (box) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const amt = $('vx-amt'); if (amt) setTimeout(() => amt.focus(), 300);
}
let shownChips = null;
export function showChips(v, pulse){
  loanChips(v);
  document.querySelectorAll('[data-stat="chips"]').forEach(e => {
    e.textContent = fmt(v);
    if (pulse && shownChips !== null && v > shownChips){ e.classList.remove('pulse'); void e.offsetWidth; e.classList.add('pulse'); }
  });
  shownChips = v;
}
export function msg(t, s, cls){ const m = $('msg'); if (!m) return; m.className = 'cz-msg ' + (cls || ''); m.innerHTML = '<div class="t">' + t + '</div>' + (s ? '<div class="s">' + s + '</div>' : ''); }

/* ---------- playing cards: 0..51, rank = c % 13 (0 = A), suit = c / 13 (♠ ♥ ♦ ♣); -1 = face down ---------- */
export const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export function paintCard(el, c){
  const down = c < 0 || c == null, s = down ? '' : SUITS[Math.floor(c / 13)], r = down ? '' : RANKS[c % 13], red = s === '♥' || s === '♦';
  el.className = 'pcard' + (down ? ' back' : red ? ' red' : '');
  el.innerHTML = down ? '' : '<div class="c">' + r + '<small>' + s + '</small></div><div class="m">' + s + '</div>';
  el.setAttribute('aria-label', down ? 'face-down card' : r + ' of ' + ['spades', 'hearts', 'diamonds', 'clubs'][Math.floor(c / 13)]);
  return el;
}
export const cardEl = c => paintCard(document.createElement('div'), c);

/* ---------- dice ---------- */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
export function dieEl(v, red){ const d = document.createElement('div'); d.className = 'die' + (red ? ' red' : ''); d.innerHTML = '<i></i>'.repeat(9); setDie(d, v); return d; }
export function setDie(d, v){ d.querySelectorAll('i').forEach((p, i) => p.style.visibility = (PIPS[v] || []).includes(i) ? 'visible' : 'hidden'); d.setAttribute('aria-label', 'die showing ' + v); }
export async function rollDice(els, values){
  if (!reduced){
    els.forEach(d => { d.classList.remove('roll'); void d.offsetWidth; d.classList.add('roll'); });
    const t0 = performance.now();
    while (performance.now() - t0 < 480){ els.forEach(d => setDie(d, 1 + rand(6))); sfx.dice(); await sleep(70); }
  }
  els.forEach((d, i) => setDie(d, values[i]));
}

/* ---------- sound ---------- */
export const sfx = (() => {
  let ac = null, master = null, muted = false;
  try { muted = (localStorage.getItem('casino-mute') ?? localStorage.getItem('bj-mute')) === '1'; } catch (e) {}
  function a(){ if (!ac){ try { ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = 0.45; master.connect(ac.destination); } catch (e) { ac = null; } } if (ac && ac.state === 'suspended') ac.resume(); return ac; }
  function tone(f, f2, len, vol, type, delay){ const x = !muted && a(); if (!x) return; const t = x.currentTime + (delay || 0), o = x.createOscillator(), g = x.createGain(); o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + len); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + len); o.connect(g); g.connect(master); o.start(t); o.stop(t + len + 0.02); }
  function noise(len, vol, freq, type, delay){ const x = !muted && a(); if (!x) return; const n = Math.ceil(x.sampleRate * len), buf = x.createBuffer(1, n, x.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n); const src = x.createBufferSource(), f = x.createBiquadFilter(), g = x.createGain(); src.buffer = buf; f.type = type || 'highpass'; f.frequency.value = freq || 1800; g.gain.value = vol; src.connect(f); f.connect(g); g.connect(master); src.start(x.currentTime + (delay || 0)); }
  return {
    get muted(){ return muted; }, unlock(){ if (!muted) a(); }, tone, noise,
    toggle(){ muted = !muted; try { localStorage.setItem('casino-mute', muted ? '1' : '0'); } catch (e) {} if (!muted) a(); },
    card(){ noise(0.08, 0.25); }, flip(){ noise(0.06, 0.2); tone(500, 380, 0.05, 0.04, 'triangle'); },
    chip(){ tone(1800, 1400, 0.04, 0.05, 'triangle'); tone(2600, 2200, 0.03, 0.03, 'sine', 0.02); },
    dice(){ noise(0.04, 0.18, 1200, 'bandpass'); },
    tick(k){ tone(2400 + Math.random() * 600, 1800, 0.025, 0.02 + 0.05 * Math.max(0, k || 0.5), 'square'); },
    reelStop(){ tone(160, 90, 0.09, 0.12, 'triangle'); noise(0.05, 0.12, 600, 'lowpass'); },
    win(){ [0, 0.09, 0.18].forEach((d, i) => tone(523 * Math.pow(1.26, i), 523 * Math.pow(1.26, i) * 1.02, 0.18, 0.1, 'triangle', d)); },
    big(){ [0, .08, .16, .24, .32, .44].forEach((d, i) => tone(523 * Math.pow(1.19, i), 523 * Math.pow(1.19, i) * 1.02, 0.2, 0.1, 'triangle', d)); },
    lose(){ tone(300, 200, 0.25, 0.08, 'triangle'); },
    coins(n){ for (let i = 0; i < Math.min(n || 6, 14); i++) tone(2000 + Math.random() * 900, 1500, 0.05, 0.035, 'triangle', i * 0.06); },
  };
})();

/* ---------- the chip rack (pick a chip size) ---------- */
export const CHIPS = [[5, '#b3262e'], [25, '#1f5a99'], [100, '#222'], [500, '#6b3fa0'], [1000, '#c9a24b']];
export const chipColour = v => ([...CHIPS].reverse().find(([c]) => v >= c) || CHIPS[0])[1];
// The last chip is "All in": it bets everything you have left on the spot you tap (value Infinity, which
// betBoard clamps to the chips still free).
export function chipRack(el, { values = [5, 25, 100, 500], start = 25, onPick } = {}){
  let val = start;
  const num = b => b.dataset.v === 'all' ? Infinity : +b.dataset.v;
  el.classList.add('chips-row');
  el.innerHTML = values.map(v => '<button type="button" class="chip" data-v="' + v + '" style="--c:' + chipColour(v) + '" aria-label="Chip size ' + v + '"><span>' + short(v) + '</span></button>').join('') +
    '<button type="button" class="chip allin" data-v="all" aria-label="All in: bet everything you have left"><span>ALL<br>IN</span></button>';
  el.addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b || b.disabled) return; val = num(b); sfx.unlock(); sfx.chip(); rack.refresh(); onPick && onPick(val); });
  const rack = {
    get value(){ return val; },
    refresh(max, disabled){ el.querySelectorAll('.chip').forEach(b => { const v = num(b); b.classList.toggle('sel', v === val); if (max !== undefined) b.disabled = !!disabled || (v === Infinity ? max < 1 : v > Math.max(0, max)); }); },
  };
  rack.refresh();
  return rack;
}

/* ---------- a betting board: chips placed on spots, with undo / clear / rebet ---------- */
// spots: { key: buttonElement }. canBet(key, bets) may return false (or a message) to refuse a bet there.
export function betBoard({ spots, rack, free, canBet, onChange, maxPer }){
  let bets = {}, hist = [], last = null, locked = false, settled = false;
  const total = () => Object.values(bets).reduce((s, v) => s + v, 0);
  function draw(){
    for (const k in spots){
      let s = spots[k].querySelector(':scope > .stake');
      if (!bets[k]){ if (s && !s.classList.contains('lost')) s.remove(); continue; }
      if (!s || s.classList.contains('lost')){ if (s) s.remove(); s = document.createElement('span'); s.className = 'stake'; spots[k].appendChild(s); }
      s.style.setProperty('--c', chipColour(bets[k])); s.textContent = short(bets[k]);
    }
  }
  function clearMarks(){ for (const k in spots){ spots[k].classList.remove('won'); spots[k].querySelectorAll(':scope > .stake.lost').forEach(s => s.remove()); } }
  const b = {
    get bets(){ return bets; }, get total(){ return total(); }, get last(){ return last; }, get settled(){ return settled; },
    list(){ return Object.entries(bets).filter(([, a]) => a > 0).map(([k, a]) => ({ k, a })); },
    lock(v){ locked = v; for (const k in spots) spots[k].disabled = v; },
    // start a fresh table after a result (the old chips stay on the felt until the next bet)
    fresh(){ if (settled){ settled = false; clearMarks(); bets = {}; hist = []; draw(); } },
    add(k){
      if (locked || !spots[k]) return false;
      b.fresh();
      const room = free() - total();
      let v = Math.min(rack.value, room);
      if (maxPer) v = Math.min(v, maxPer(k, bets[k] || 0));
      if (v < 1){ msg('Not enough chips', 'Take a chip off or pick a smaller chip', 'lose'); return false; }
      if (canBet){ const ok = canBet(k, bets); if (ok !== true){ if (ok) msg(ok, '', 'lose'); return false; } }
      bets[k] = (bets[k] || 0) + v; hist.push([k, v]); sfx.chip(); draw(); onChange && onChange(); return true;
    },
    undo(){ if (locked) return; const h = hist.pop(); if (!h) return; bets[h[0]] -= h[1]; if (bets[h[0]] <= 0) delete bets[h[0]]; draw(); onChange && onChange(); },
    clear(){ if (locked) return; bets = {}; hist = []; draw(); onChange && onChange(); },
    rebet(){
      if (locked || !last) return;
      const need = last.reduce((s, x) => s + x.a, 0); if (need > free()) return;
      settled = false; clearMarks(); bets = {}; hist = [];
      for (const x of last){ bets[x.k] = x.a; hist.push([x.k, x.a]); }
      sfx.chip(); draw(); onChange && onChange();
    },
    canRebet(){ return !locked && last && !total() && last.reduce((s, x) => s + x.a, 0) <= free(); },
    // show the outcome: winners glow, losers fade; keep `keep` (a {key: amount} of bets that stay up, e.g. craps)
    settle(winKeys, keep){
      const placed = b.list(); if (placed.length) last = placed;
      for (const k in spots){
        const s = spots[k].querySelector(':scope > .stake');
        if (winKeys.includes(k)) spots[k].classList.add('won');
        else if (s && !(keep && keep[k])) s.classList.add('lost');
      }
      hist = [];
      if (keep){ bets = { ...keep }; draw(); settled = false; } else { bets = {}; settled = true; }
      onChange && onChange();
    },
    set(next){ bets = { ...next }; hist = []; settled = false; draw(); onChange && onChange(); },
    draw,
  };
  for (const k in spots) spots[k].addEventListener('click', () => { sfx.unlock(); b.add(k); });
  return b;
}

/* ======================= bans ======================= */
// Cheating (bookmarklets, scripts, console tricks, exploiting bugs) gets an account banned. The server
// refuses every casino call for a banned account; this just tells the player why.
export const isLockError = e => !!e && (e.hint === 'casino_locked' || /locked out of the casino/.test(e.message || ''));
export const isBanError = e => !!e && (e.hint === 'casino_banned' || /banned from the casino/.test(e.message || ''));
export function showBan(reason, sb){
  if (document.getElementById('cz-ban')) return;
  const d = document.createElement('div'); d.id = 'cz-ban'; d.className = 'ban'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'cz-ban-h');
  d.innerHTML = '<div class="ban-box"><svg class="ico" width="28" height="28" aria-hidden="true"><use href="/icons.svg#triangle-alert"/></svg>' +
    '<h2 id="cz-ban-h">You’re banned from the casino</h2>' +
    '<p>' + (reason ? 'Reason: ' + esc(reason) + '. ' : '') + 'Mistake? Email <a href="mailto:josh@voxprints.com">josh@voxprints.com</a>.</p>' +
    '<div class="ban-btns"><a class="pbtn" href="/terms.html#casino">Rules</a>' + (sb ? '<button type="button" class="pbtn primary" id="cz-ban-out">Sign out</button>' : '') + '<a class="pbtn" href="/games.html">Back to games</a></div></div>';
  document.body.appendChild(d);
  const out = document.getElementById('cz-ban-out');
  if (out) out.onclick = async () => { await sb.auth.signOut(); d.remove(); };
}

/* ======================= cheat lockouts ======================= */
// Catches common bookmarklet tricks: fake clicks and key presses, scripts pulled in from other sites,
// a rigged random number generator, patched built-ins (storage, JSON, arrays), and hand-edited guest chips. Each catch locks you out of the casino:
// 5 minutes the first time, 10 the second, an hour every time after. Signed-in strikes are kept and
// enforced by the server (casino_flag); guests' are kept on the device.
const LOCK_MINS = n => n <= 1 ? 5 : n === 2 ? 10 : 60;
// the real random functions, kept from page load so a swapped-in fake is spotted
const RNG = { random: Math.random, grv: self.Crypto && Crypto.prototype.getRandomValues };
const rngSwapped = () => { try { return Math.random !== RNG.random ? 'Math.random' : RNG.grv && (crypto.getRandomValues !== RNG.grv || Crypto.prototype.getRandomValues !== RNG.grv) ? 'getRandomValues' : ''; } catch (e) { return ''; } };
// the built-ins the games deal, shuffle and keep chips with: a patched one (e.g. Storage getItem rewritten to stack
// the deck) is spotted whether it was swapped before this file loaded (not native code) or after (changed since load)
const fnSrc = Function.prototype.toString;
const BUILTINS = () => ({
  'Storage.getItem': Storage.prototype.getItem, 'Storage.setItem': Storage.prototype.setItem, 'Storage.removeItem': Storage.prototype.removeItem,
  'JSON.parse': JSON.parse, 'JSON.stringify': JSON.stringify,
  'Array.pop': Array.prototype.pop, 'Array.push': Array.prototype.push, 'Array.slice': Array.prototype.slice,
  'Array.splice': Array.prototype.splice, 'Array.sort': Array.prototype.sort, 'Math.floor': Math.floor,
  'Function.toString': Function.prototype.toString,
});
const BUILTINS0 = BUILTINS();
const isNative = f => { try { return typeof f === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(fnSrc.call(f)); } catch (e) { return false; } };
const builtinPatched = () => { try { const now = BUILTINS(); for (const k in now) if (now[k] !== BUILTINS0[k] || !isNative(now[k])) return k; } catch (e) {} return ''; };
const SCRIPT_HOSTS = new Set([location.host, 'cdn.jsdelivr.net']);
export const guard = {
  sb: () => null, user: () => casino.user, until: 0, strikes: 0, timer: null, started: false, pending: false, onUnlock: [],
  locked(){ return Date.now() < this.until; },
  guestState(){ try { const g = JSON.parse(localStorage.getItem('casino-lock')); return g && typeof g.n === 'number' ? g : { n: 0, until: 0 }; } catch (e) { return { n: 0, until: 0 }; } },
  async flag(kind, detail){
    if (this.locked() || this.pending) return;
    const sb = this.sb();
    if (sb && this.user()){
      this.pending = true;
      try { const { data } = await sb.rpc('casino_flag', { p_kind: kind, p_detail: String(detail || '').slice(0, 300) }); if (data) this.apply(data); }
      catch (e) {} finally { this.pending = false; }
      return;
    }
    const g = this.guestState(); g.n += 1; g.until = Date.now() + LOCK_MINS(g.n) * 60000;
    try { localStorage.setItem('casino-lock', JSON.stringify(g)); } catch (e) {}
    this.show(g.until, g.n);
  },
  // signed-in status from casino_ban_status()
  apply(st){ if (st && st.locked && st.seconds_left > 0) this.show(Date.now() + st.seconds_left * 1000, st.strikes); },
  async check(){
    const sb = this.sb();
    if (sb && this.user()){ try { const { data } = await sb.rpc('casino_ban_status'); if (data && data.banned) showBan(data.reason, sb); else this.apply(data); } catch (e) {} return; }
    const g = this.guestState(); if (g.until > Date.now()) this.show(g.until, g.n);
  },
  show(until, strikes){
    this.until = until; this.strikes = strikes;
    let d = document.getElementById('cz-lock');
    if (!d){
      d = document.createElement('div'); d.id = 'cz-lock'; d.className = 'ban'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'cz-lock-h');
      d.innerHTML = '<div class="ban-box"><svg class="ico" width="28" height="28" aria-hidden="true"><use href="/icons.svg#lock"/></svg>' +
        '<h2 id="cz-lock-h">Locked out</h2><div class="lock-time" id="cz-lock-t" aria-live="off">5:00</div>' +
        '<p>Script or bookmarklet detected. <span id="cz-lock-n"></span></p>' +
        '<p>Mistake? Email <a href="mailto:josh@voxprints.com">josh@voxprints.com</a>.</p>' +
        '<div class="ban-btns"><a class="pbtn" href="/terms.html#casino">Rules</a><a class="pbtn" href="/games.html">Back to games</a></div></div>';
      document.body.appendChild(d);
    }
    document.getElementById('cz-lock-n').textContent = 'Offence ' + strikes + '.';
    clearInterval(this.timer);
    const tick = () => {
      const left = Math.max(0, Math.ceil((this.until - Date.now()) / 1000));
      const t = document.getElementById('cz-lock-t'); if (t) t.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      if (!left){ clearInterval(this.timer); this.timer = null; d.remove(); this.onUnlock.forEach(fn => { try { fn(); } catch (e) {} }); }
    };
    tick(); this.timer = setInterval(tick, 1000);
  },
  clear(){ this.until = 0; clearInterval(this.timer); const d = document.getElementById('cz-lock'); if (d) d.remove(); },
  // sb / user: functions returning the Supabase client and signed-in user (or null); onUnlock: reload the table
  start({ sb, user, onUnlock } = {}){
    if (sb) this.sb = sb; if (user) this.user = user;
    if (onUnlock) this.onUnlock.push(onUnlock);
    if (this.started) return; this.started = true;
    // 1) fake input: el.click(), dispatchEvent(new MouseEvent(...)), synthetic key presses
    const skip = t => t && t.closest && t.closest('input, textarea, select, form, [contenteditable], #account, .ban');
    const onFake = e => {
      if (e.isTrusted) return;
      if (this.locked()){ e.stopImmediatePropagation(); e.preventDefault(); return; }
      if (skip(e.target)) return;
      e.stopImmediatePropagation(); e.preventDefault();
      const t = e.target, what = t && t.nodeType === 1 ? t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') : 'document';
      this.flag('fake-input', e.type + ' on ' + what);
    };
    ['click', 'pointerdown', 'mousedown', 'mouseup', 'touchstart', 'keydown', 'keyup'].forEach(k => window.addEventListener(k, onFake, true));
    // while locked, real key presses don't reach the table either
    window.addEventListener('keydown', e => { if (this.locked() && e.isTrusted && !skip(e.target)){ e.stopImmediatePropagation(); if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); } }, true);
    // 2) scripts loaded from other sites (bookmarklets usually pull their code in this way)
    new MutationObserver(list => {
      for (const m of list) for (const n of m.addedNodes){
        if (n.nodeName !== 'SCRIPT' || !n.src) continue;
        let u; try { u = new URL(n.src, location.href); } catch (e) { continue; }
        if (/^https?:$/.test(u.protocol) && !SCRIPT_HOSTS.has(u.host)) this.flag('injected-script', u.host + u.pathname);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    // 3) a rigged random number generator
    setInterval(() => { const w = rngSwapped(); if (w) this.flag('rigged-random', w); const b = builtinPatched(); if (b) this.flag('patched-builtin', b); }, 1500);
    // 4) hand-edited guest chips (also checked on every read in bank.get)
    setInterval(() => { if (!this.user()) bank.get(); }, 3000);
    this.check();
  },
};

/* ======================= safe word ======================= */
// A signed-in player can set a safe word and an amount: anything that takes more than that from their chips in one go
// is refused by the server (hint 'casino_safeword') until the word is entered. safeRpc() asks for it and retries.
let swStyled = false;
function swStyle(){
  if (swStyled) return; swStyled = true;
  const st = document.createElement('style');
  st.textContent = '.sw-back{position:fixed;inset:0;z-index:120;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.62);backdrop-filter:blur(4px)}' +
    '.sw-box{max-width:380px;width:100%;background:var(--canvas,#fff);color:var(--fg,#1f2328);border:1px solid var(--border,#d1d9e0);border-radius:14px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:inherit}' +
    '.sw-box h2{font-size:18px;margin:6px 0 8px;display:flex;align-items:center;gap:8px}.sw-box p{margin:0 0 12px;font-size:14px;line-height:1.5;color:var(--fg-muted,#59636e)}' +
    '.sw-box input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:10px 12px;border-radius:9px;border:1px solid var(--border,#d1d9e0);background:var(--canvas-inset,#f6f8fa);color:inherit}' +
    '.sw-box .sw-msg{min-height:20px;margin:8px 0 0;font-size:13px;color:#d1242f}.sw-box .sw-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}' +
    '.sw-box button{font:inherit;font-size:14px;font-weight:700;padding:10px;border-radius:9px;cursor:pointer;border:1px solid var(--border,#d1d9e0);background:var(--canvas,#fff);color:inherit}' +
    '.sw-box button.go{background:#1f8a5f;color:#fff;border-color:transparent}.sw-box button:disabled{opacity:.5;cursor:default}';
  document.head.appendChild(st);
}
// rawRpc(name, args) -> { data, error }, like a Supabase client's rpc
export function askSafeWord(rawRpc, amount){
  swStyle();
  return new Promise(resolve => {
    const d = document.createElement('div'); d.className = 'sw-back'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'sw-h');
    d.innerHTML = '<form class="sw-box" autocomplete="off"><h2 id="sw-h"><svg class="ico" width="1em" height="1em" aria-hidden="true"><use href="/icons.svg#lock"/></svg>Safe word</h2>' +
      '<p>' + (amount ? '<b>' + fmt(amount) + '</b> chips is over your limit.' : 'This is over your limit.') + '</p>' +
      '<input type="password" id="sw-in" aria-label="Safe word" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="sw-msg" id="sw-msg" aria-live="polite"></div>' +
      '<div class="sw-btns"><button type="button" id="sw-no">Cancel</button><button type="submit" class="go" id="sw-ok">Go ahead</button></div></form>';
    document.body.appendChild(d);
    const inp = d.querySelector('#sw-in'), msgEl = d.querySelector('#sw-msg'), okBtn = d.querySelector('#sw-ok');
    const done = v => { d.remove(); resolve(v); };
    d.querySelector('#sw-no').onclick = () => done(false);
    d.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); });
    d.querySelector('form').onsubmit = async e => {
      e.preventDefault(); if (!inp.value.trim()) { msgEl.textContent = 'Enter your safe word.'; return; }
      okBtn.disabled = true; msgEl.textContent = '';
      const { data, error } = await rawRpc('casino_sw_approve', { p_word: inp.value });
      okBtn.disabled = false;
      if (error) { msgEl.textContent = error.hint === 'casino_sw_locked' ? 'Too many tries. Wait 10 minutes.' : 'Something went wrong.'; return; }
      if (data && data.ok) return done(true);
      msgEl.textContent = 'Wrong safe word.'; inp.select();
    };
    setTimeout(() => inp.focus(), 50);
  });
}
// an rpc that asks for the safe word when the server wants it, then tries once more
export async function safeRpc(rawRpc, name, args){
  let r = await rawRpc(name, args);
  if (r.error && r.error.hint === 'casino_safeword' && await askSafeWord(rawRpc, Number(r.error.details) || 0)) r = await rawRpc(name, args);
  return r;
}
// the safe word block in the side panel
export function swHtml(){
  return '<div class="loan" id="sw"><div class="sw-head"><b>Safe word</b> <span id="sw-state">…</span></div><div id="sw-body"></div><div class="pmsg" id="sw-pmsg" aria-live="polite"></div></div>';
}
export function wireSafeWord(rawRpc){
  const body = $('sw-body'), state = $('sw-state'), say = t => { $('sw-pmsg').textContent = t; };
  if (!body) return;
  const field = (id, label, type, extra) => '<input class="pinput" id="' + id + '" type="' + type + '" placeholder="' + label + '" aria-label="' + label + '" autocomplete="off"' + (extra || '') + '>';
  const show = st => {
    state.textContent = st.on ? 'On' : 'Off';
    body.innerHTML = st.on
      ? '<p class="loan-note">Asks over <b>' + fmt(st.limit) + '</b> chips.</p>' +
        '<div class="loan-btns"><button type="button" class="pbtn" id="sw-change">Change</button><button type="button" class="pbtn" id="sw-off">Turn off</button></div><div id="sw-form"></div>'
      : '<p class="loan-note">Ask for a word before big bets.</p>' +
        '<div class="loan-btns one"><button type="button" class="pbtn" id="sw-set">Set safe word</button></div><div id="sw-form"></div>';
    const form = (needCurrent, newWord) => {
      $('sw-form').innerHTML = (needCurrent ? field('sw-cur', 'Current safe word', 'password') : '') +
        (newWord ? field('sw-new', 'New safe word', 'password') + field('sw-new2', 'Type it again', 'password') + field('sw-lim', 'Limit (chips)', 'number', ' min="1" step="1" inputmode="numeric" value="' + (st.limit || '') + '"') : '') +
        '<button type="button" class="pbtn primary" id="sw-save">' + (newWord ? 'Save safe word' : 'Turn off safe word') + '</button>';
      $('sw-save').onclick = async () => {
        let word = null, lim = null;
        if (newWord) {
          word = $('sw-new').value.trim(); lim = Math.floor(Number($('sw-lim').value));
          if (word.length < 3) return say('At least 3 letters.');
          if (word.toLowerCase() !== $('sw-new2').value.trim().toLowerCase()) return say('Words don’t match.');
          if (!(lim >= 1)) return say('Enter a limit.');
        }
        $('sw-save').disabled = true; say('');
        const { data, error } = await rawRpc('casino_sw_set', { p_current: needCurrent ? $('sw-cur').value : null, p_word: word, p_limit: lim });
        if (error) { $('sw-save').disabled = false; return say(error.hint === 'casino_sw_locked' ? 'Too many tries. Wait 10 minutes.' : 'Something went wrong.'); }
        if (!data.ok) { $('sw-save').disabled = false; return say('Wrong safe word.'); }
        show(data); say(data.on ? 'Saved.' : 'Turned off.');
      };
    };
    if ($('sw-set')) $('sw-set').onclick = () => form(false, true);
    if ($('sw-change')) $('sw-change').onclick = () => form(true, true);
    if ($('sw-off')) $('sw-off').onclick = () => form(true, false);
  };
  rawRpc('casino_sw_status').then(({ data }) => { if (data) show(data); });
}

/* ======================= accounts, leaderboard, time played ======================= */
export const casino = {
  sb: null, user: null, pendingSecs: 0, kind: 'score', lastInput: 0, listeners: [],
  async rpc(name, args){ const { data, error } = await safeRpc((n, a) => this.sb.rpc(n, a || {}), name, args || {}); if (error){ if (isBanError(error)) showBan(null, this.sb); else if (isLockError(error)) guard.check(); throw error; } return data; },
  onUser(fn){ this.listeners.push(fn); },
  markInput(){ this.lastInput = performance.now(); },
  async record(){
    if (!this.sb || !this.user) return;
    const secs = Math.round(this.pendingSecs); this.pendingSecs -= secs;
    const { data } = await this.sb.rpc('game_record', { p_game: 'casino', p_score: 0, p_seconds: secs, p_finished: false });
    if (data) this.renderMe(data);
    this.loadBoard();
  },
  async loadBoard(){
    const el = $('lb'); if (!el) return;
    if (!this.sb){ el.innerHTML = '<li class="lb-empty">Unavailable right now.</li>'; return; }
    const { data, error } = await this.sb.rpc('game_leaderboard', { p_game: 'casino', p_kind: this.kind, p_limit: 10 });
    if (error){ el.innerHTML = '<li class="lb-empty">Couldn’t load the leaderboard.</li>'; return; }
    const val = v => this.kind === 'time' ? fmtLong(v) : fmt(v);
    el.innerHTML = (data || []).length
      ? data.map(r => '<li class="' + (r.me ? 'me' : '') + '"><span class="rk">' + r.rank + '</span><span class="nm">' + esc(r.name) + '</span><span class="vl">' + val(r.value) + '</span></li>').join('')
      : '<li class="lb-empty">No one yet. Be the first!</li>';
  },
  renderMe(st){
    if (!this.user || !st) return;
    const box = $('me-stats'); if (!box) return;
    box.innerHTML = '<span>Leaderboard</span><b>' + fmt(st.best_score || 0) + (st.score_rank ? ' <small>#' + st.score_rank + '</small>' : '') + '</b>' +
      '<span>Time played</span><b>' + fmtLong(st.total_seconds || 0) + (st.time_rank ? ' <small>#' + st.time_rank + '</small>' : '') + '</b>' +
      '<span>Rounds played</span><b>' + fmt(st.games_played || 0) + '</b>';
    const nm = $('me-name'); if (nm) nm.textContent = st.name;
    const setName = $('name-box'); if (setName) setName.hidden = st.name !== 'Player';
  },
  renderAccount(){
    const box = $('account'); if (!box) return;
    if (!this.sb){ box.innerHTML = voxHtml(false) + '<p style="margin-top:12px">Sign-in unavailable.</p>'; return; }
    if (this.user){
      box.innerHTML = '<h3>Playing as <span id="me-name">…</span></h3><div class="me-row" id="me-stats"></div>' + voxHtml(true) + swHtml() +
        '<div id="name-box" hidden><p style="margin-top:10px">Leaderboard name:</p><input class="pinput" id="name-in" maxlength="40" placeholder="Your name"><button type="button" class="pbtn primary" id="name-save">Save name</button><div class="pmsg" id="name-msg"></div></div>' +
        '<button type="button" class="link" id="sign-out">Sign out</button>';
      $('sign-out').onclick = async () => { await this.sb.auth.signOut(); };
      $('name-save').onclick = async () => {
        const name = $('name-in').value.trim(), m = $('name-msg');
        if (!name){ m.textContent = 'Enter a name.'; return; }
        const { error } = await this.sb.from('customer_profiles').upsert({ id: this.user.id, email: this.user.email, full_name: name });
        if (error){ m.textContent = 'Couldn’t save: ' + error.message; return; }
        const { data } = await this.sb.rpc('game_my_stats', { p_game: 'casino' }); this.renderMe(data); this.loadBoard();
      };
      this.sb.rpc('game_my_stats', { p_game: 'casino' }).then(({ data }) => this.renderMe(data));
      wireSafeWord((n, a) => this.sb.rpc(n, a || {}));
      this.refreshVox = wireVox({ rpc: (n, a) => this.rpc(n, a), signed: () => signedIn(), after: () => { this.loadBoard(); this.listeners.forEach(fn => { try { fn(this.user); } catch (e) {} }); } });
      return;
    }
    box.innerHTML = voxHtml(false) + '<h3 style="margin-top:14px">Sign in</h3><p>Save your chips and join the leaderboard.</p>' +
      '<button type="button" class="pbtn primary" id="g-in"><svg class="ico" width="1em" height="1em" aria-hidden="true"><use href="/icons.svg#user"/></svg> Sign in</button>' +
      '<div hidden><input class="pinput" id="em-in" type="email" placeholder="or your email" autocomplete="email">' +
      '<button type="button" class="pbtn" id="em-send">Email me a code</button>' +
      '<div id="code-box" hidden><input class="pinput" id="code-in" inputmode="numeric" maxlength="6" placeholder="6-digit code"><button type="button" class="pbtn primary" id="code-go">Sign in</button></div></div>' +
      '<div class="pmsg" id="em-msg"></div>';
    $('g-in').onclick = () => { location.href = '/signin.html?next=' + encodeURIComponent(location.pathname + location.search); };
    loanChips(bank.get());
    let pendingEmail = '';
    $('em-send').onclick = async () => {
      const email = $('em-in').value.trim(), m = $('em-msg');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ m.textContent = 'Enter your email.'; return; }
      m.textContent = 'Sending…';
      const { error } = await this.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (error){ m.textContent = error.message; return; }
      pendingEmail = email; $('code-box').hidden = false; m.textContent = 'Code sent. Check your email.';
    };
    $('code-go').onclick = async () => {
      const token = $('code-in').value.trim(), m = $('em-msg');
      const { error } = await this.sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
      m.textContent = error ? 'Wrong code.' : '';
    };
  },
  guestNote(){ document.querySelectorAll('.guest-note').forEach(n => n.hidden = !!this.user); },
  // refreshes the Vox points block (set by renderAccount when signed in)
  refreshVox: () => {},
  changed(){ const b = document.getElementById('cz-ban'); if (b && !this.user) b.remove(); guard.clear(); guard.check(); this.renderAccount(); this.loadBoard(); this.guestNote(); this.listeners.forEach(fn => { try { fn(this.user); } catch (e) { console.error(e); } }); },
};

// wire up the page shell: mute button, leaderboard tabs and drawer, time played, guest note, sign-in
export function startShell(){
  const muteBtn = $('mute');
  const showMute = () => { muteBtn.textContent = sfx.muted ? 'Sound off' : 'Sound on'; muteBtn.setAttribute('aria-pressed', String(sfx.muted)); };
  if (muteBtn){ muteBtn.addEventListener('click', () => { sfx.toggle(); showMute(); }); showMute(); }
  document.querySelectorAll('.tab[data-kind]').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab[data-kind]').forEach(x => x.classList.toggle('on', x === t));
    casino.kind = t.dataset.kind; casino.loadBoard();
  }));
  const side = $('side-right');
  $('lb-toggle').addEventListener('click', () => side.classList.toggle('open'));
  document.addEventListener('click', e => { if (side.classList.contains('open') && !side.contains(e.target) && e.target.id !== 'lb-toggle') side.classList.remove('open'); });
  document.querySelectorAll('.guest-note button').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation(); side.classList.add('open');
    const btn = side.querySelector('#g-in, #em-in'); if (btn){ btn.scrollIntoView({ block: 'center', behavior: 'smooth' }); const pnl = btn.closest('.panel') || btn; pnl.animate([{ boxShadow: '0 0 0 0 rgba(68,147,248,0)' }, { boxShadow: '0 0 0 4px rgba(68,147,248,.9)' }, { boxShadow: '0 0 0 0 rgba(68,147,248,0)' }], { duration: 1200, easing: 'ease-out' }); btn.focus({ preventScroll: true }); }  // the panel may already be on screen: flash it so the tap visibly does something
  }));
  // time played: counts while the tab is visible and you've done something in the last 2 minutes
  let playSecs = 0, lastT = performance.now(), lastShown = -1;
  (function tick(now){
    const dt = Math.min(1, (now - lastT) / 1000); lastT = now;
    if (!document.hidden && now - casino.lastInput < 120000){ playSecs += dt; casino.pendingSecs += dt; }
    if (Math.floor(playSecs) !== lastShown){ lastShown = Math.floor(playSecs); const m = Math.floor(playSecs / 60), s = Math.floor(playSecs % 60); document.querySelectorAll('[data-stat="time"]').forEach(e => e.textContent = m + ':' + String(s).padStart(2, '0')); }
    requestAnimationFrame(tick);
  })(lastT);
  addEventListener('pointerdown', () => casino.markInput());
  addEventListener('keydown', () => casino.markInput());
  setInterval(() => { if (casino.pendingSecs >= 5) casino.record(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden && casino.pendingSecs >= 1) casino.record(); });

  guard.start({ sb: () => casino.sb, user: () => casino.user, onUnlock: () => casino.changed() });
  // who's playing, and live chips on the casino leaderboard
  startLive({ sb: () => casino.sb, user: () => casino.user, game: 'casino', title: ((document.querySelector('.topbar .title') || {}).textContent || 'Casino').trim(),
    score: () => shownChips, board: () => $('lb'), kind: () => casino.kind, replace: true, reload: () => casino.loadBoard() });
  (async () => {
    try {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      casino.sb = createClient('https://paycasfatsakidsriwqt.supabase.co', 'sb_publishable_Yk3l_-tXm4qtaRnrfw54pw_Awel9tCv');
    } catch (e) { casino.sb = null; }
    if (casino.sb){
      const { data } = await casino.sb.auth.getSession();
      casino.user = data && data.session ? data.session.user : null;
      casino.sb.auth.onAuthStateChange((_ev, session) => {
        const u = session ? session.user : null;
        if ((u && u.id) === (casino.user && casino.user.id)) return;
        casino.user = u; casino.changed();
      });
    }
    casino.changed();
  })();
  return casino;
}
// which engine to use: the server for signed-in players, this device for guests
export const signedIn = () => !!(casino.sb && casino.user);
