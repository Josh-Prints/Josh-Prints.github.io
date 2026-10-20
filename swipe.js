/* Swipe-to-act rows, like iOS Mail. Swipe a row left to show a button (red Delete by default); tap the
   button, or keep swiping past most of the row, to run it. Works with touch and mouse drag; vertical
   scrolling still works because only clearly sideways drags count.

     import { swipeRow } from '/swipe.js?v=1';
     swipeRow(rowEl, { label: 'Delete', icon: 'trash-2', color: '#cf222e', action: async () => { ... } });

   action() returning (or resolving to) false, or throwing, snaps the row back. Otherwise the row folds
   away and is removed, unless keep: true (then it just closes, for actions like Restore that re-render). */

const BTN = 84;            // width of the revealed button
let openRow = null;        // only one row open at a time

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
    '.sw-act{position:absolute;inset:0 0 0 auto;width:100%;display:flex;align-items:center;justify-content:flex-end;padding:0 18px;border:0;margin:0;' +
      'background:var(--sw-color,#cf222e);color:#fff;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}' +
    '.sw-act .sw-in{display:flex;flex-direction:column;align-items:center;gap:5px;width:' + (BTN - 36) + 'px;transition:transform .2s}' +
    '.sw-act svg{width:18px;height:18px}' +
    '.sw-wrap.sw-far .sw-act .sw-in{transform:scale(1.12)}' +
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

  let x0 = 0, y0 = 0, dx = 0, base = 0, dragging = false, decided = false, busy = false, moved = false;
  const set = (v, anim) => {
    row.classList.toggle('sw-anim', !!anim); row.style.transform = v ? 'translateX(' + v + 'px)' : '';
    if (v) wrap.classList.add('sw-on');
    else if (anim) setTimeout(() => { if (!row.style.transform) wrap.classList.remove('sw-on'); }, 260);
    else wrap.classList.remove('sw-on');
  };
  const api = {
    wrap,
    close(){ base = 0; set(0, true); if (openRow === api) openRow = null; },
    open(){ closeOpen(api); base = -BTN; set(-BTN, true); openRow = api; },
  };
  async function run(){
    if (busy) return; busy = true;
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
    x0 = e.clientX; y0 = e.clientY; dx = 0; dragging = true; decided = false; moved = false;
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
    dx = Math.min(0, base + mx);
    if (dx < -wrap.offsetWidth) dx = -wrap.offsetWidth;
    set(dx, false);
    wrap.classList.toggle('sw-far', dx < -wrap.offsetWidth * 0.55);
  });
  const end = () => {
    if (!dragging) return; dragging = false;
    wrap.classList.remove('sw-moving');
    if (!moved) return;
    if (dx < -wrap.offsetWidth * 0.55){ wrap.classList.remove('sw-far'); run(); }
    else if (dx < -BTN / 2) api.open();
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
