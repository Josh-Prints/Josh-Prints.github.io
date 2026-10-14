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
export const bank = {
  get(){ try { const v = localStorage.getItem('casino-bank') ?? localStorage.getItem('bj-bank'); const c = Number(v); return v !== null && c >= 0 && isFinite(c) ? Math.floor(c) : 1000; } catch (e) { return 1000; } },
  set(c){ try { localStorage.setItem('casino-bank', String(Math.max(0, Math.floor(c)))); } catch (e) {} },
  topup(){ let c = this.get(); if (c < 1000){ c = 1000; this.set(c); } return c; },
};

/* ---------- chips shown in the stats ---------- */
let shownChips = null;
export function showChips(v, pulse){
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
export function chipRack(el, { values = [5, 25, 100, 500], start = 25, onPick } = {}){
  let val = start;
  el.classList.add('chips-row');
  el.innerHTML = values.map(v => '<button type="button" class="chip" data-v="' + v + '" style="--c:' + chipColour(v) + '" aria-label="Chip size ' + v + '"><span>' + short(v) + '</span></button>').join('');
  el.addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b || b.disabled) return; val = +b.dataset.v; sfx.unlock(); sfx.chip(); rack.refresh(); onPick && onPick(val); });
  const rack = {
    get value(){ return val; },
    refresh(max, disabled){ el.querySelectorAll('.chip').forEach(b => { b.classList.toggle('sel', +b.dataset.v === val); if (max !== undefined) b.disabled = !!disabled || +b.dataset.v > Math.max(0, max); }); },
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

/* ======================= accounts, leaderboard, time played ======================= */
export const casino = {
  sb: null, user: null, pendingSecs: 0, kind: 'score', lastInput: 0, listeners: [],
  async rpc(name, args){ const { data, error } = await this.sb.rpc(name, args || {}); if (error) throw error; return data; },
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
    if (!this.sb){ el.innerHTML = '<li class="lb-empty">Leaderboard unavailable right now.</li>'; return; }
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
    box.innerHTML = '<span>Chips</span><b>' + fmt(st.best_score || 0) + (st.score_rank ? ' <small>#' + st.score_rank + '</small>' : '') + '</b>' +
      '<span>Time played</span><b>' + fmtLong(st.total_seconds || 0) + (st.time_rank ? ' <small>#' + st.time_rank + '</small>' : '') + '</b>' +
      '<span>Rounds played</span><b>' + fmt(st.games_played || 0) + '</b>';
    const nm = $('me-name'); if (nm) nm.textContent = st.name;
    const setName = $('name-box'); if (setName) setName.hidden = st.name !== 'Player';
  },
  renderAccount(){
    const box = $('account'); if (!box) return;
    if (!this.sb){ box.innerHTML = '<p>Sign-in is unavailable right now. You can still play.</p>'; return; }
    if (this.user){
      box.innerHTML = '<h3>Playing as <span id="me-name">…</span></h3><div class="me-row" id="me-stats"></div>' +
        '<div id="name-box" hidden><p style="margin-top:10px">Pick a name for the leaderboard:</p><input class="pinput" id="name-in" maxlength="40" placeholder="Your name"><button type="button" class="pbtn primary" id="name-save">Save name</button><div class="pmsg" id="name-msg"></div></div>' +
        '<button type="button" class="link" id="sign-out">Sign out</button>';
      $('sign-out').onclick = async () => { await this.sb.auth.signOut(); };
      $('name-save').onclick = async () => {
        const name = $('name-in').value.trim(), m = $('name-msg');
        if (!name){ m.textContent = 'Type a name first.'; return; }
        const { error } = await this.sb.from('customer_profiles').upsert({ id: this.user.id, email: this.user.email, full_name: name });
        if (error){ m.textContent = 'Couldn’t save: ' + error.message; return; }
        const { data } = await this.sb.rpc('game_my_stats', { p_game: 'casino' }); this.renderMe(data); this.loadBoard();
      };
      this.sb.rpc('game_my_stats', { p_game: 'casino' }).then(({ data }) => this.renderMe(data));
      return;
    }
    box.innerHTML = '<h3>Save your chips</h3><p>Sign in to keep your chips on any device and get on the casino leaderboard.</p>' +
      '<button type="button" class="pbtn" id="g-in"><svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>Sign in with Google</button>' +
      '<input class="pinput" id="em-in" type="email" placeholder="or your email" autocomplete="email">' +
      '<button type="button" class="pbtn" id="em-send">Email me a code</button>' +
      '<div id="code-box" hidden><input class="pinput" id="code-in" inputmode="numeric" maxlength="6" placeholder="6-digit code"><button type="button" class="pbtn primary" id="code-go">Sign in</button></div>' +
      '<div class="pmsg" id="em-msg"></div>';
    $('g-in').onclick = () => { this.sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }); };
    let pendingEmail = '';
    $('em-send').onclick = async () => {
      const email = $('em-in').value.trim(), m = $('em-msg');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ m.textContent = 'Type your email first.'; return; }
      m.textContent = 'Sending…';
      const { error } = await this.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (error){ m.textContent = error.message; return; }
      pendingEmail = email; $('code-box').hidden = false; m.textContent = 'Check your email for a 6-digit code.';
    };
    $('code-go').onclick = async () => {
      const token = $('code-in').value.trim(), m = $('em-msg');
      const { error } = await this.sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
      m.textContent = error ? 'That code didn’t work. Try again.' : '';
    };
  },
  guestNote(){ document.querySelectorAll('.guest-note').forEach(n => n.hidden = !!this.user); },
  changed(){ this.renderAccount(); this.loadBoard(); this.guestNote(); this.listeners.forEach(fn => { try { fn(this.user); } catch (e) { console.error(e); } }); },
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
    const t = side.querySelector('#g-in, #em-in'); if (t) t.scrollIntoView({ block: 'center' });
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
