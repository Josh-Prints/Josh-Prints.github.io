/* Swipe-to-act rows, like iOS Mail. Swipe a row left to show a button (red Delete by default); tap the
   button, or keep swiping past most of the row, to run it. Works with touch and mouse drag; vertical
   scrolling still works because only clearly sideways drags count.
   It moves in clicks: a stiff peek, then it snaps out to the full button and resists, then pulled further
   it slides the whole row away (let go to act). Each step ticks the phone's haptics (vibrate on Android;
   the iOS 18+ switch tick on iPhone).

     import { swipeRow } from '/swipe.js?v=3';
     swipeRow(rowEl, { label: 'Delete', icon: 'trash-2', color: '#cf222e', action: async () => { ... } });

   action() returning (or resolving to) false, or throwing, snaps the row back. Otherwise the row folds
   away and is removed, unless keep: true (then it just closes, for actions like Restore that re-render). */

const BTN = 84;            // width of the revealed button
let openRow = null;        // only one row open at a time

/* ---------- haptics ---------- */
// Android: navigator.vibrate. iPhone: Safari has no vibrate, but toggling an <input type=checkbox switch>
// (iOS 18+) plays the system haptic tick, so a hidden one is clicked through its label.
let iosTick = null;
export function haptic(strong){
  try { if (navigator.vibrate){ navigator.vibrate(strong ? 18 : 8); return; } } catch (_) {}
  try {
    if (!iosTick){
      iosTick = document.createElement('label');
      iosTick.setAttribute('aria-hidden', 'true');
      iosTick.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.setAttribute('switch', ''); inp.tabIndex = -1;
      iosTick.appendChild(inp); document.body.appendChild(iosTick);
    }
    iosTick.click();
  } catch (_) {}
}

/* ---------- the resistance curve: finger distance -> how far the row moves ---------- */
// Step 0: a stiff peek, up to PEEK px. Step 1: it clicks out to the full button and then resists.
// Step 2: pulled far enough, it slides all the way off (let go to act, pull back to cancel).
const PEEK = 44, RAW_OPEN = 64, K_OPEN = 0.22;
const RAW_OPEN_REST = RAW_OPEN + 4;                       // where an already-open row starts
const commitAt = w => Math.max(RAW_OPEN + 110, w * 0.5);  // finger distance where it slides away
function travel(raw, w){
  if (raw <= 0) return 0;
  if (raw < RAW_OPEN) return PEEK * (1 - Math.pow(1 - raw / RAW_OPEN, 1.6));   // stiff, easing into the peek
  if (raw < commitAt(w)) return BTN + (raw - RAW_OPEN) * K_OPEN;              // clicked open, resisting
  return w;                                                                    // slid away
}

function style(){
  if (document.getElementById('swipe-css')) return;
  const s = document.createElement('style'); s.id = 'swipe-css';
  s.textContent =
    '.sw-wrap{position:relative;overflow:hidden;border-radius:var(--sw-radius,10px);touch-action:pan-y}' +
    '.sw-wrap>.sw-row{position:relative;z-index:1;touch-action:pan-y;will-change:transform}' +
    '.sw-wrap.sw-moving>.sw-row{transition:none !important}' +
    '.sw-wrap:not(.sw-on)>.sw-act{visibility:hidden}' +
    '.sw-wrap.sw-on>.sw-row{opacity:1 !important}' +
    '.sw-wrap>.sw-row.sw-anim{transition:transform .25s cubic-bezier(.2,.8,.2,1) !important}' +
    '.sw-wrap.sw-moving>.sw-row.sw-snap{transition:transform .16s cubic-bezier(.2,.9,.3,1.25) !important}' +
    '.sw-wrap.sw-moving.sw-far>.sw-row.sw-snap{transition:transform .22s cubic-bezier(.3,.8,.3,1) !important}' +
    '.sw-act{position:absolute;inset:0 0 0 auto;width:100%;display:flex;align-items:center;justify-content:flex-end;padding:0 18px;border:0;margin:0;' +
      'background:var(--sw-color,#cf222e);color:#fff;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}' +
    '.sw-act .sw-in{display:flex;flex-direction:column;align-items:center;gap:5px;width:' + (BTN - 36) + 'px;transition:transform .18s cubic-bezier(.2,.9,.3,1.4),opacity .15s;opacity:.55;transform:scale(.82)}' +
    '.sw-act svg{width:18px;height:18px}' +
    '.sw-wrap.sw-ready .sw-act .sw-in{opacity:1;transform:scale(1)}' +
    '.sw-wrap.sw-far .sw-act .sw-in{transform:scale(1.18)}' +
    '.sw-wrap.sw-far .sw-act{filter:brightness(1.12)}' +
    '.sw-wrap.sw-gone{transition:height .25s ease,margin .25s ease,opacity .25s ease;opacity:0}' +
    '@media (prefers-reduced-motion:reduce){.sw-wrap>.sw-row.sw-anim,.sw-wrap.sw-gone{transition:none !important}}';
  document.head.appendChild(s);
}

// the colour actually showing behind the row, so the row covers the button until it's swiped
function solidBg(el){
  for (let n = el; n && n.nodeType === 1; n = n.parentElement){
    const c = getComputedStyle(n).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)){
      const m = c.match(/rgba\(([^,]+),([^,]+),([^,]+),\s*([\d.]+)\)/);
      if (!m || Number(m[4]) > 0.95) return c;
    }
  }
  const root = getComputedStyle(document.documentElement);
  return root.getPropertyValue('--bg-raised').trim() || root.getPropertyValue('--card').trim() || root.getPropertyValue('--bg').trim() || '#0d1117';
}

function closeOpen(except){ if (openRow && openRow !== except) openRow.close(); }
document.addEventListener('pointerdown', e => { if (openRow && !openRow.wrap.contains(e.target)) openRow.close(); }, true);

export function swipeRow(row, opts = {}){
  style();
  const o = { label: 'Delete', icon: 'trash-2', color: '#cf222e', ...opts };
  if (row.closest('.sw-wrap')) return;
  const wrap = document.createElement('div'); wrap.className = 'sw-wrap';
  const cs = getComputedStyle(row);
  // the row's outer spacing and corners move to the wrapper, so the red shows exactly behind it
  wrap.style.margin = cs.margin; row.style.margin = '0';
  wrap.style.setProperty('--sw-radius', cs.borderRadius || '0px');
  wrap.style.setProperty('--sw-color', o.color);
  row.parentNode.insertBefore(wrap, row);
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sw-act'; btn.tabIndex = -1;
  btn.innerHTML = '<span class="sw-in"><svg aria-hidden="true"><use href="/icons.svg#' + o.icon + '"/></svg>' + o.label + '</span>';
  wrap.appendChild(btn); wrap.appendChild(row);
  row.classList.add('sw-row');
  if (o.bg !== false && getComputedStyle(row).backgroundColor.replace(/\s/g, '').match(/^(transparent|rgba\(0,0,0,0\))$/)) row.style.background = o.bg || solidBg(wrap.parentElement);

  let x0 = 0, y0 = 0, dx = 0, base = 0, raw0 = 0, raw = 0, step = 0, dragging = false, decided = false, busy = false, moved = false;
  const set = (v, anim) => {
    row.classList.toggle('sw-anim', !!anim); row.style.transform = v ? 'translateX(' + v + 'px)' : '';
    if (v) wrap.classList.add('sw-on');
    else if (anim) setTimeout(() => { if (!row.style.transform) wrap.classList.remove('sw-on'); }, 260);
    else wrap.classList.remove('sw-on');
  };
  const api = {
    wrap,
    close(){ base = 0; set(0, true); wrap.classList.remove('sw-ready', 'sw-far'); if (openRow === api) openRow = null; },
    open(){ closeOpen(api); base = -BTN; set(-BTN, true); wrap.classList.add('sw-ready'); wrap.classList.remove('sw-far'); openRow = api; },
  };
  async function run(){
    if (busy) return; busy = true;
    haptic(true);
    set(-wrap.offsetWidth, true);
    let ok;
    try { ok = await o.action(); } catch (e) { ok = false; }
    busy = false;
    if (ok === false){ api.close(); return; }
    if (o.keep){ base = 0; set(0, false); if (openRow === api) openRow = null; return; }
    // fold the row away
    wrap.style.height = wrap.offsetHeight + 'px'; wrap.offsetHeight;
    wrap.classList.add('sw-gone'); wrap.style.height = '0px'; wrap.style.marginTop = wrap.style.marginBottom = '0px';
    if (openRow === api) openRow = null;
    setTimeout(() => wrap.remove(), 280);
  }
  btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); run(); });

  row.addEventListener('pointerdown', e => {
    if (busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    x0 = e.clientX; y0 = e.clientY; dx = base; dragging = true; decided = false; moved = false;
    raw0 = base ? RAW_OPEN_REST : 0; step = base ? 1 : 0;
  });
  row.addEventListener('pointermove', e => {
    if (!dragging) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!decided){
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      if (Math.abs(my) > Math.abs(mx)){ dragging = false; return; }   // a scroll, not a swipe
      moved = true; closeOpen(api); wrap.classList.add('sw-moving');
      row.style.animation = 'none';   // an entrance animation holding its last frame would override the drag
      try { row.setPointerCapture(e.pointerId); } catch (_) {}
    }
    const w = wrap.offsetWidth;
    raw = raw0 - mx;
    dx = -travel(raw, w);
    // the clicks: button fully out (1), broke free (2); each crossing ticks the haptics
    const now = raw >= commitAt(w) ? 2 : raw >= RAW_OPEN ? 1 : 0;
    if (now !== step){
      haptic(now === 2);
      row.classList.add('sw-snap'); clearTimeout(row._snap); row._snap = setTimeout(() => row.classList.remove('sw-snap'), now === 2 || step === 2 ? 230 : 150);
      step = now;
    }
    wrap.classList.toggle('sw-ready', step >= 1);
    wrap.classList.toggle('sw-far', step === 2);
    set(dx, false);
  });
  const end = () => {
    if (!dragging) return; dragging = false;
    wrap.classList.remove('sw-moving');
    if (!moved) return;
    row.classList.remove('sw-snap');
    if (step === 2){ wrap.classList.remove('sw-far'); run(); }
    else if (step === 1) api.open();
    else api.close();
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', () => { if (dragging){ dragging = false; wrap.classList.remove('sw-moving'); api.close(); } });
  // a swipe or a tap on an open row must not follow the row's link
  row.addEventListener('click', e => {
    if (moved){ e.preventDefault(); e.stopPropagation(); moved = false; return; }   // the click that ends a drag
    if (base !== 0){ e.preventDefault(); e.stopPropagation(); api.close(); }          // tapping an open row closes it
  }, true);
  row.addEventListener('dragstart', e => e.preventDefault());
  return api;
}
