/* Live: who's playing what right now, and live scores on the leaderboards.
   Every game page joins one Supabase Realtime presence channel for the whole site and shares
   { game, title, name, score } about once a second while you play. Everyone else's pages show:
   - a "N playing" button in the top bar,
   - a "Playing now" list in the side drawer (who, which game, their score ticking up),
   - the leaderboard updating live: when someone's run beats a score on the board, their number ticks up and
     the rows reorder.
   Live numbers are display only. The real leaderboard still comes from the server (game_record / casino),
   and is re-read from the server regularly. */

const CHANNEL = 'vox-live';
const TAB = Math.random().toString(36).slice(2, 10);
const fmt = n => Math.round(Number(n) || 0).toLocaleString();
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let opts = null, channel = null, people = [], subscribed = false, lastSent = 0, sentSig = '', name = null, nameFor = undefined, hiddenSince = 0;
const watchers = [];

/* ---------- numbers that tick up (or down) to their new value ---------- */
function tickTo(el, to){
  const from = Number(el.dataset.shown != null ? el.dataset.shown : String(el.textContent).replace(/[^0-9.-]/g, '')) || 0;
  el.dataset.shown = to;
  if (from === to){ el.textContent = fmt(to); return; }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches){ el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = Math.min(900, 250 + Math.abs(to - from) * 2);
  el.classList.add('live-tick');
  cancelAnimationFrame(el._tick);
  const step = now => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) el._tick = requestAnimationFrame(step); else el.classList.remove('live-tick');
  };
  el._tick = requestAnimationFrame(step);
}

/* ---------- styles (injected once) ---------- */
function style(){
  if (document.getElementById('live-css')) return;
  const s = document.createElement('style'); s.id = 'live-css';
  s.textContent = '.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#2ea043;box-shadow:0 0 0 0 rgba(46,160,67,.6);animation:livePulse 1.8s infinite;flex:none}' +
    '@keyframes livePulse{70%{box-shadow:0 0 0 7px rgba(46,160,67,0)}100%{box-shadow:0 0 0 0 rgba(46,160,67,0)}}' +
    '.tbtn.live-pill{display:inline-flex !important;align-items:center;gap:7px;height:34px;font-size:12.5px !important}' +
    '.tbtn.live-pill[hidden]{display:none !important}' +
    '.live-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}' +
    '.live-list li{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;font-size:13.5px;padding:6px 8px;border-radius:8px}' +
    '.live-list li.me{background:color-mix(in srgb,var(--accent,#4493f8) 16%,transparent);font-weight:700}' +
    '.live-list .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.live-list .gm{display:block;font-size:11.5px;font-weight:400;color:var(--fg-muted,#8b949e)}' +
    '.live-list .vl{font-weight:700;font-variant-numeric:tabular-nums}.live-empty{font-size:13px;color:var(--fg-muted,#8b949e);padding:4px 2px}' +
    'li.lb-live .vl{color:#3fb950}li.lb-live .nm::after{content:"";display:inline-block;width:7px;height:7px;margin-left:6px;border-radius:50%;background:#2ea043;vertical-align:1px;animation:livePulse 1.8s infinite}' +
    '.live-tick{color:#3fb950 !important}';
  document.head.appendChild(s);
}

/* ---------- presence ---------- */
function flatten(state){
  const out = [];
  for (const key of Object.keys(state)){ const m = state[key] && state[key][0]; if (m && m.game) out.push({ key, game: m.game, title: m.title || m.game, name: m.name || 'Guest', score: m.score == null ? null : Number(m.score), playing: !!m.playing }); }
  return out;
}
function payload(){
  const sc = opts.score ? opts.score() : null;
  return { game: opts.game, title: opts.title || opts.game, name: name || 'Guest', score: sc == null || !isFinite(sc) ? null : Math.round(sc), playing: sc != null };
}
async function refreshName(){
  const u = opts.user ? opts.user() : null, id = u ? u.id : null;
  if (id === nameFor) return; nameFor = id;
  if (!id){ name = null; return; }
  try { const { data } = await opts.sb().rpc('game_my_stats', { p_game: opts.statsGame || opts.game }); name = data && data.name && data.name !== 'Player' ? data.name : 'Player'; } catch (e) { name = 'Player'; }
}
function send(force){
  if (!channel || !subscribed || opts.watchOnly) return;
  if (document.hidden){ if (!hiddenSince) hiddenSince = Date.now(); if (Date.now() - hiddenSince > 60000 && sentSig !== 'gone'){ channel.untrack(); sentSig = 'gone'; } return; }
  hiddenSince = 0;
  const p = payload(), sig = JSON.stringify(p), now = Date.now();
  if (sig === sentSig || (!force && now - lastSent < 450)) return;
  sentSig = sig; lastSent = now; channel.track(p);
}
function connect(){
  const sb = opts.sb && opts.sb(); if (!sb || channel) return;
  try {
    channel = sb.channel(CHANNEL, { config: { presence: { key: TAB } } });
    channel.on('presence', { event: 'sync' }, () => { people = flatten(channel.presenceState()); render(); });
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED'){ subscribed = true; sentSig = ''; send(true); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){ subscribed = false; }
    });
  } catch (e) { channel = null; }
}

/* ---------- drawing ---------- */
function render(){
  watchers.forEach(fn => { try { fn(people); } catch (e) {} });
  const others = people.length;
  const pill = document.getElementById('live-pill');
  if (pill){ pill.hidden = !others; const t = pill.querySelector('b'); if (t) t.textContent = others + ' playing'; }
  const list = document.getElementById('live-list');
  if (list){
    const here = people.slice().sort((a, b) => (b.game === opts.game) - (a.game === opts.game) || (b.score || 0) - (a.score || 0));
    if (!here.length){ list.innerHTML = '<li class="live-empty">No one else is playing right now.</li>'; }
    else {
      const keep = {}; list.querySelectorAll('li[data-k]').forEach(li => keep[li.dataset.k] = li);
      list.innerHTML = '';
      for (const p of here){
        let li = keep[p.key];
        if (!li){ li = document.createElement('li'); li.dataset.k = p.key; li.innerHTML = '<span class="live-dot"></span><span class="nm"></span><span class="vl"></span>'; }
        li.classList.toggle('me', p.key === TAB);
        li.querySelector('.nm').innerHTML = esc(p.name) + (p.key === TAB ? ' (you)' : '') + '<span class="gm">' + esc(p.title) + (p.playing ? '' : ' · in the menu') + '</span>';
        const vl = li.querySelector('.vl'); if (p.score != null) tickTo(vl, p.score); else { vl.textContent = ''; delete vl.dataset.shown; }
        list.appendChild(li);
      }
    }
  }
  overlay();
}
// the leaderboard: live scores that beat the board tick up, and rows reorder
let lbObserver = null, applying = false;
function overlay(){
  const lb = opts.board && opts.board(); if (!lb || applying) return;
  if (opts.kind && opts.kind() !== 'score'){ lb.querySelectorAll('li.lb-live').forEach(li => li.classList.remove('lb-live')); return; }
  applying = true; if (lbObserver) lbObserver.disconnect();
  try {
    const rows = [...lb.querySelectorAll('li')].filter(li => li.querySelector('.nm') && li.querySelector('.vl'));
    const num = s => Number(String(s).replace(/[^0-9.-]/g, '')) || 0;
    rows.forEach(li => { if (li.dataset.base == null) li.dataset.base = num(li.querySelector('.vl').textContent); });
    const live = people.filter(p => p.game === (opts.boardGame || opts.game) && p.playing && p.score != null && p.name && p.name !== 'Guest');
    const seen = new Set();
    for (const p of live){
      const nameOf = li => li.querySelector('.nm').textContent.trim();
      let li = rows.find(r => nameOf(r) === p.name && !seen.has(r));
      const base = li ? Number(li.dataset.base) : 0;
      const value = opts.replace ? p.score : Math.max(base, p.score);
      if (!li){
        const lowest = rows.length ? Math.min(...rows.map(r => Number(r.dataset.live || r.dataset.base))) : 0;
        if (rows.length >= 10 && value <= lowest) continue;
        li = document.createElement('li'); li.innerHTML = '<span class="rk"></span><span class="nm"></span><span class="vl">0</span>';
        li.querySelector('.nm').textContent = p.name; li.dataset.base = 0; li.dataset.added = '1'; rows.push(li);
      }
      seen.add(li);
      const beating = opts.replace ? true : p.score > base;
      li.classList.toggle('lb-live', beating);
      li.dataset.live = value;
      if (beating) tickTo(li.querySelector('.vl'), value);
    }
    rows.forEach(li => { if (!seen.has(li)){ if (li.dataset.added){ li.remove(); return; } li.classList.remove('lb-live'); if (li.dataset.live != null){ delete li.dataset.live; tickTo(li.querySelector('.vl'), Number(li.dataset.base)); } } });
    const kept = rows.filter(li => li.isConnected || li.dataset.added && seen.has(li));
    kept.sort((a, b) => Number(b.dataset.live != null ? b.dataset.live : b.dataset.base) - Number(a.dataset.live != null ? a.dataset.live : a.dataset.base));
    const empty = lb.querySelector('.lb-empty, .clb-empty'); if (empty && kept.length) empty.remove();
    kept.slice(0, Math.max(10, kept.length)).forEach((li, i) => { const rk = li.querySelector('.rk'); if (rk) rk.textContent = i + 1; lb.appendChild(li); });
  } finally {
    applying = false;
    if (lbObserver) lbObserver.observe(lb, { childList: true });
  }
}
function watchBoard(){
  const lb = opts.board && opts.board(); if (!lb) return;
  lbObserver = new MutationObserver(() => { if (!applying) overlay(); });
  lbObserver.observe(lb, { childList: true });
}
function addUi(){
  style();
  const bar = document.querySelector('.topbar');
  if (bar && !document.getElementById('live-pill')){
    const b = document.createElement('button'); b.type = 'button'; b.id = 'live-pill'; b.className = 'tbtn live-pill'; b.hidden = true; b.title = 'Who’s playing now';
    b.innerHTML = '<span class="live-dot"></span><b>0 playing</b>';
    b.addEventListener('click', e => { e.stopPropagation(); const side = document.getElementById('side-right'); if (side){ side.classList.add('open'); const l = document.getElementById('live-panel'); if (l) l.scrollIntoView({ block: 'start' }); } });
    const title = bar.querySelector('.title'); if (title && title.nextSibling) bar.insertBefore(b, title.nextSibling); else bar.appendChild(b);
  }
  const side = document.getElementById('side-right');
  if (side && !document.getElementById('live-panel')){
    const panel = document.createElement('div'); panel.className = 'panel'; panel.id = 'live-panel';
    panel.innerHTML = '<h3>Playing now</h3><ol class="live-list" id="live-list"><li class="live-empty">Connecting…</li></ol>';
    const acct = document.getElementById('account');
    if (acct && acct.parentNode === side) side.insertBefore(panel, acct.nextSibling); else side.appendChild(panel);
  }
}

/* ---------- start ---------- */
// opts: { sb(), user(), game, title, score() -> number or null (null = not in a game), board() -> <ol>, kind() -> 'score' | 'time',
//         boardGame, statsGame, replace (live value replaces the board value, e.g. casino chips), reload() (re-read the board),
//         watchOnly (just watch), ui (false: no top-bar button or drawer panel) }
export function startLive(o){
  if (opts) return; opts = o;
  if (o.ui !== false) addUi(); else style();
  watchBoard();
  setInterval(async () => {
    if (!channel) connect();
    if (!o.watchOnly){ await refreshName(); send(false); }
  }, 200);
  // the real leaderboard, re-read from the server regularly (and right away when the page comes back)
  if (o.reload){ setInterval(() => { if (!document.hidden) o.reload(); }, 15000); document.addEventListener('visibilitychange', () => { if (!document.hidden) o.reload(); }); }
}
export function onPeople(fn){ watchers.push(fn); fn(people); }
export { tickTo };
