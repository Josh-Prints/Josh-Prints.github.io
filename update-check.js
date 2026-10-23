/* Update check and founder announcements, on every page.
   Every 8 seconds (while the tab is visible) it re-downloads this page and the site's own scripts and
   stylesheets it uses, skipping the browser cache, and compares them with what was there when the page
   loaded. If anything has changed, a bar offers a refresh. It doesn't reload by itself, so nobody loses a
   half-filled form, picked files or a game in progress.
   On the same timer it asks for the live founder announcements (live_announcements) and shows each once
   as a notification. window.VoxAnnounce.show() is also used by the founder page's preview. */
/* Taps: on iPhone, two quick taps on a button count as "double-tap to zoom" and the second tap is swallowed, so
   buttons tapped in a row (bets, chips, + / -, hit / stand) seemed to work only half the time. touch-action:
   manipulation turns that off for controls only; pinch-zoom and scrolling still work. Injected here because this
   script is on every page. */
(function(){
  try {
    var st = document.createElement('style'); st.id = 'vx-taps';
    st.textContent = 'a,button,input,select,textarea,label,summary,[role=button],[onclick],.btn{touch-action:manipulation}';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}
})();

/* Mouse clicks: many buttons shrink or shift a few pixels while pressed (:active transforms). A click only counts if
   the button is still under the pointer when the mouse button comes up, so pressing near a button's edge could
   shrink it out from under the pointer and the click was silently lost: buttons seemed to work at random on a PC.
   While a mouse button is held on a control, its transform is locked where it was; the press shows as a slight
   darkening instead. Touch keeps the press animation (taps don't have this problem). */
(function(){
  var held = null;
  function release(){
    var el = held; held = null; if (!el) return;
    // after the click has been dispatched
    setTimeout(function(){ el.style.removeProperty('transform'); el.style.removeProperty('filter'); }, 0);
  }
  addEventListener('pointerdown', function(e){
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    var el = e.target && e.target.closest && e.target.closest('a[href], button, [role=button], label, summary, .btn');
    if (!el || el.closest('.sw-wrap') || el.style.transform) return;
    release();
    var t = getComputedStyle(el).transform;
    el.style.setProperty('transform', t && t !== 'none' ? t : 'none', 'important');
    el.style.setProperty('filter', 'brightness(.92)');
    held = el;
  }, true);
  addEventListener('pointerup', release, true);
  addEventListener('pointercancel', release, true);
  addEventListener('blur', release);
})();

(function(){
  try { var cu = new URL(location.href); if (cu.searchParams.has('_r')){ cu.searchParams.delete('_r'); history.replaceState(null, '', cu.pathname + cu.search + cu.hash); } } catch (e) {}
  var EVERY = 8000;
  var base = null, shown = false, busy = false;

  // the page itself plus same-site scripts and stylesheets (not third-party ones)
  function urls(){
    var list = [location.pathname];
    document.querySelectorAll('script[src], link[rel="stylesheet"][href]').forEach(function(el){
      var u; try { u = new URL(el.getAttribute('src') || el.getAttribute('href'), location.href); } catch (e) { return; }
      if (u.origin === location.origin && list.indexOf(u.pathname) < 0) list.push(u.pathname);
    });
    return list;
  }
  // a short fingerprint of a file's text
  function hash(s){ var h = 5381; for (var i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0; return h; }
  function fetchAll(){
    var stamp = Date.now();
    return Promise.all(urls().map(function(p){
      // the query string makes the site's CDN fetch a fresh copy too, not just the browser
      return fetch(p + (p.indexOf('?') < 0 ? '?' : '&') + '_uc=' + stamp, { cache: 'no-store', credentials: 'same-origin' })
        .then(function(r){ return r.ok ? r.text() : null; })
        .then(function(t){ return [p, t === null ? null : hash(t)]; })
        .catch(function(){ return [p, null]; });
    }));
  }
  function check(){
    if (busy || shown || document.hidden) return;
    busy = true;
    fetchAll().then(function(res){
      busy = false;
      if (!base){ base = {}; res.forEach(function(r){ if (r[1] !== null) base[r[0]] = r[1]; }); return; }
      var changed = res.some(function(r){ return r[1] !== null && base[r[0]] !== undefined && base[r[0]] !== r[1]; });
      if (changed) show();
    }, function(){ busy = false; });
  }
  function show(){
    shown = true;
    var bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.id = 'vx-update-bar';
    bar.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);touch-action:manipulation;z-index:2147483000;display:flex;align-items:center;gap:12px;' +
      'padding:10px 12px 10px 16px;border-radius:999px;background:#161b22;color:#e6edf3;border:1px solid #30363d;box-shadow:0 10px 30px rgba(0,0,0,.35);' +
      'font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:calc(100% - 24px);';
    bar.innerHTML = '<span>A new version of this page is available.</span>' +
      '<button type="button" style="font:inherit;min-height:40px;padding:9px 18px;border-radius:999px;border:0;background:#4493f8;color:#fff;cursor:pointer;white-space:nowrap">Refresh</button>' +
      '<button type="button" aria-label="Dismiss" style="font:inherit;font-size:22px;line-height:1;min-width:40px;min-height:40px;padding:2px 6px;border:0;background:none;color:#8b949e;cursor:pointer">&times;</button>';
    var b = bar.querySelectorAll('button');
    // iPhone Safari keeps old scripts and styles cached after a plain reload, so the page came back unchanged and the
    // button seemed broken: first re-download this page and its scripts / styles into the cache, then reload.
    b[0].onclick = function(){
      if (b[0].disabled) return;
      b[0].disabled = true; b[0].textContent = 'Refreshing…';
      // load the page under a one-off address so iOS can't serve it from its cache (the marker is removed again on load)
      var go = function(){
        var u = new URL(location.href); u.searchParams.set('_r', Date.now());
        location.replace(u.href);
      };
      var fresh = urls().map(function(p){ return fetch(p, { cache: 'reload', credentials: 'same-origin' }).catch(function(){}); });
      Promise.all(fresh).then(go, go);
      setTimeout(go, 4000);   // never get stuck if a download hangs
    };
    b[1].onclick = function(){ bar.remove(); };
    (document.body || document.documentElement).appendChild(bar);
  }

  /* ---------- founder announcements ---------- */
  var SB = 'https://paycasfatsakidsriwqt.supabase.co', KEY = 'sb_publishable_Yk3l_-tXm4qtaRnrfw54pw_Awel9tCv';
  var RAINBOW = '#ff3b3b,#ff9f1c,#ffe14d,#3ddc84,#3b9cff,#8b5cf6,#ff3bd4,#ff3b3b';
  // the old named themes (announcements saved before custom styles)
  var PRESETS = {
    blue: { c1: '#1f6feb', c2: '#4493f8' }, green: { c1: '#1a7f37', c2: '#2ea043' }, purple: { c1: '#6e40c9', c2: '#8957e5' },
    red: { c1: '#b62324', c2: '#e5534b' }, orange: { c1: '#bc4c00', c2: '#f0883e' }, gold: { c1: '#9a6700', c2: '#d4a72c' },
    dark: { c1: '#161b22', c2: '#2d333b' }, rainbow: { bg: 'rainbow' }
  };
  var ICONS = ['megaphone', 'sparkles', 'party-popper', 'triangle-alert', 'lightbulb', 'tag', 'crown', 'music', 'mail', 'printer', 'package', 'shopping-cart', 'check', 'puzzle', 'pin', 'circle-dollar-sign', 'none'];
  var FONTS = {
    system: '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif', serif: 'Georgia,"Times New Roman",serif',
    mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace', rounded: 'ui-rounded,"SF Pro Rounded","Nunito","Trebuchet MS",sans-serif',
    display: 'Impact,"Arial Black","Helvetica Neue",sans-serif', hand: '"Comic Sans MS","Chalkboard SE","Marker Felt",cursive'
  };
  var SIZES = { s: [12, 13, 28], m: [14, 15, 34], l: [16, 19, 42], xl: [19, 25, 52] };   // body px, title px, icon px
  var POS = ['tr', 'tc', 'tl', 'br', 'bc', 'bl', 'c'];
  var ANIMS = ['slide', 'pop', 'fade', 'bounce', 'shake', 'drop', 'spin', 'none'];
  var annBusy = false, annStyled = false;
  var hex = function(v, d){ return /^#[0-9a-f]{6}$/i.test(v || '') ? v : d; };
  var num = function(v, lo, hi, d){ v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  var pick = function(v, list, d){ return list.indexOf(v) >= 0 ? v : d; };
  // a saved style (or an old theme name) -> a complete, safe style
  function fullStyle(a){
    var s = {}, k, p = PRESETS[a.theme] || PRESETS.blue, st = a.style || {};
    for (k in p) s[k] = p[k];
    for (k in st) s[k] = st[k];
    var c1 = hex(s.c1, '#1f6feb');
    return {
      bg: pick(s.bg, ['solid', 'gradient', 'rainbow'], 'gradient'), c1: c1, c2: hex(s.c2, c1), angle: num(s.angle, 0, 360, 135),
      text: hex(s.text, '#ffffff'), speed: num(s.speed, 0.5, 30, 4), icon: pick(s.icon, ICONS, 'megaphone'),
      kicker: s.kicker == null ? 'Announcement' : String(s.kicker).slice(0, 40), pos: pick(s.pos, POS, 'tr'), size: pick(s.size, ['s', 'm', 'l', 'xl'], 'm'),
      width: num(s.width, 220, 720, 360), radius: num(s.radius, 0, 40, 14), anim: pick(s.anim, ANIMS, 'slide'), font: pick(s.font, Object.keys(FONTS), 'system'),
      align: pick(s.align, ['left', 'center'], 'left'), glow: pick(s.glow, ['none', 'soft', 'strong'], 'none'), border: hex(s.border, ''),
      bar: s.bar !== false, dim: !!s.dim, upper: !!s.upper,
      btn_text: s.btn_text ? String(s.btn_text).slice(0, 40) : '', btn_url: /^(https?:\/\/|\/)/.test(s.btn_url || '') ? String(s.btn_url) : '',
      btn_bg: hex(s.btn_bg, '#ffffff'), btn_text_c: hex(s.btn_text_c, '#111111')
    };
  }
  function annStyle(){
    if (annStyled) return; annStyled = true;
    var st = document.createElement('style');
    st.textContent = '.vox-ann-wrap{position:fixed;z-index:2147483001;display:grid;gap:10px;pointer-events:none;inset:16px}' +
      '.vox-ann-wrap.in-stage{position:absolute;inset:12px;z-index:1}' +
      '.vox-ann-wrap.tr{justify-items:end;align-content:start}.vox-ann-wrap.tc{justify-items:center;align-content:start}.vox-ann-wrap.tl{justify-items:start;align-content:start}' +
      '.vox-ann-wrap.br{justify-items:end;align-content:end}.vox-ann-wrap.bc{justify-items:center;align-content:end}.vox-ann-wrap.bl{justify-items:start;align-content:end}' +
      '.vox-ann-wrap.c{justify-items:center;align-content:center}' +
      '.vox-ann-dim{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);animation:vox-ann-fade .3s}.vox-ann-dim.in-stage{position:absolute;z-index:0;border-radius:inherit}' +
      '.vox-ann{pointer-events:auto;position:relative;overflow:hidden;display:flex;gap:12px;align-items:flex-start;padding:14px 40px 16px 14px;box-sizing:border-box;max-width:100%;' +
      'box-shadow:0 12px 34px rgba(0,0,0,.35);line-height:1.4;text-align:left}' +
      '.vox-ann.center{flex-direction:column;align-items:center;text-align:center;padding:18px 40px 20px}' +
      '.vox-ann.rainbow{background-size:300% 100% !important}.vox-ann.rainbow .vox-ann-txt{text-shadow:0 1px 2px rgba(0,0,0,.45)}' +
      '.vox-ann.out{transition:opacity .3s,transform .3s;opacity:0;transform:scale(.96)}' +
      '.vox-ann-ico{flex:none;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.2)}' +
      '.vox-ann-ico svg{width:52%;height:52%}' +
      '.vox-ann-txt{min-width:0;overflow-wrap:anywhere}.vox-ann-k{font-size:.78em;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.85}' +
      '.vox-ann-t{font-weight:700;margin-top:1px}.vox-ann-b{margin-top:2px;white-space:pre-line}.vox-ann.upper .vox-ann-t{text-transform:uppercase}' +
      '.vox-ann-btn{display:inline-block;margin-top:10px;padding:7px 14px;border-radius:999px;font-weight:700;text-decoration:none;font-size:.92em}' +
      '.vox-ann-btn:hover{filter:brightness(.92)}' +
      '.vox-ann-x{position:absolute;top:8px;right:8px;width:26px;height:26px;border:0;border-radius:50%;background:rgba(0,0,0,.18);color:inherit;font-size:17px;line-height:1;cursor:pointer;font-family:Arial,sans-serif}' +
      '.vox-ann-x:hover{background:rgba(0,0,0,.32)}' +
      '.vox-ann-bar{position:absolute;left:0;bottom:0;height:3px;width:100%;background:currentColor;opacity:.7;transform-origin:left;animation:vox-ann-bar linear forwards}' +
      '@keyframes vox-ann-slide{from{opacity:0;transform:translateY(var(--vox-dy,-14px))}to{opacity:1;transform:none}}' +
      '@keyframes vox-ann-pop{0%{opacity:0;transform:scale(.6)}70%{opacity:1;transform:scale(1.05)}100%{transform:scale(1)}}' +
      '@keyframes vox-ann-fade{from{opacity:0}to{opacity:1}}' +
      '@keyframes vox-ann-bounce{0%{opacity:0;transform:translateY(var(--vox-dy2,-60px))}60%{opacity:1;transform:translateY(8px)}80%{transform:translateY(-4px)}100%{transform:none}}' +
      '@keyframes vox-ann-shake{0%{opacity:0}10%,50%,90%{opacity:1;transform:translateX(-8px)}30%,70%{transform:translateX(8px)}100%{transform:none}}' +
      '@keyframes vox-ann-drop{0%{opacity:0;transform:translateY(-120vh) rotate(-8deg)}70%{opacity:1;transform:translateY(10px) rotate(2deg)}100%{transform:none}}' +
      '@keyframes vox-ann-spin{from{opacity:0;transform:rotate(-200deg) scale(.3)}to{opacity:1;transform:none}}' +
      '@keyframes vox-ann-rb{from{background-position:0 0}to{background-position:300% 0}}' +
      '@keyframes vox-ann-bar{from{transform:scaleX(1)}to{transform:scaleX(0)}}' +
      '@media (prefers-reduced-motion:reduce){.vox-ann{animation:none !important}}';
    document.head.appendChild(st);
  }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // a: { title, body, theme, style, show_secs }; opts.into: element to show it in (the founder preview)
  function showAnn(a, opts){
    opts = opts || {}; annStyle();
    var s = fullStyle(a), secs = Math.max(0, +a.show_secs || 0), into = opts.into, host, dim = null;
    if (into){
      into.querySelectorAll('.vox-ann-wrap,.vox-ann-dim').forEach(function(x){ x.remove(); });
      host = document.createElement('div'); into.appendChild(host);
    } else {
      host = document.querySelector('.vox-ann-wrap.' + s.pos + ':not(.in-stage)');
      if (!host){ host = document.createElement('div'); (document.body || document.documentElement).appendChild(host); }
    }
    host.className = 'vox-ann-wrap ' + s.pos + (into ? ' in-stage' : '');
    if (s.dim){ dim = document.createElement('div'); dim.className = 'vox-ann-dim' + (into ? ' in-stage' : ''); host.parentNode.insertBefore(dim, host); }
    var sz = SIZES[s.size], bg = s.bg === 'solid' ? s.c1 : s.bg === 'rainbow' ? 'linear-gradient(90deg,' + RAINBOW + ')' : 'linear-gradient(' + s.angle + 'deg,' + s.c1 + ',' + s.c2 + ')';
    var n = document.createElement('div');
    n.className = 'vox-ann' + (s.bg === 'rainbow' ? ' rainbow' : '') + (s.align === 'center' ? ' center' : '') + (s.upper ? ' upper' : '');
    n.setAttribute('role', 'status');
    var glowC = s.border || (s.bg === 'rainbow' ? '#8b5cf6' : s.c1), anims = [];
    if (s.anim !== 'none') anims.push('vox-ann-' + s.anim + ' ' + (s.anim === 'shake' ? '.6s' : s.anim === 'fade' ? '.4s' : '.55s') + ' cubic-bezier(.2,.9,.3,1.1) both');
    if (s.bg === 'rainbow') anims.push('vox-ann-rb ' + s.speed + 's linear infinite');
    n.style.cssText = 'background:' + bg + ';color:' + s.text + ';font-family:' + FONTS[s.font] + ';font-size:' + sz[0] + 'px;width:' + s.width + 'px;border-radius:' + s.radius + 'px;' +
      'border:' + (s.border ? '2px solid ' + s.border : '1px solid rgba(255,255,255,.18)') + ';' +
      (s.glow !== 'none' ? 'box-shadow:0 12px 34px rgba(0,0,0,.35),0 0 ' + (s.glow === 'strong' ? '40px 8px ' : '22px 2px ') + glowC + ';' : '') +
      (anims.length ? 'animation:' + anims.join(',') + ';' : '') +
      (s.pos.charAt(0) === 'b' ? '--vox-dy:14px;--vox-dy2:60px;' : '');
    var icon = s.icon === 'none' ? '' : '<div class="vox-ann-ico" style="width:' + sz[2] + 'px;height:' + sz[2] + 'px"><svg aria-hidden="true"><use href="/icons.svg#' + s.icon + '"/></svg></div>';
    n.innerHTML = icon + '<div class="vox-ann-txt">' + (s.kicker ? '<div class="vox-ann-k">' + esc(s.kicker) + '</div>' : '') +
      (a.title ? '<div class="vox-ann-t" style="font-size:' + sz[1] + 'px">' + esc(a.title) + '</div>' : '') +
      '<div class="vox-ann-b">' + esc(a.body) + '</div>' +
      (s.btn_text && s.btn_url ? '<a class="vox-ann-btn" href="' + esc(s.btn_url) + '" style="background:' + s.btn_bg + ';color:' + s.btn_text_c + '"' + (/^https?:/.test(s.btn_url) ? ' target="_blank" rel="noopener"' : '') + '>' + esc(s.btn_text) + '</a>' : '') +
      '</div><button type="button" class="vox-ann-x" aria-label="Close">&times;</button>' +
      (secs && s.bar ? '<div class="vox-ann-bar" style="animation-duration:' + secs + 's"></div>' : '');
    var gone = false;
    function close(){
      if (gone) return; gone = true; n.classList.add('out');
      setTimeout(function(){ n.remove(); if (dim) dim.remove(); if (!host.children.length) host.remove(); }, 300);
    }
    n.querySelector('.vox-ann-x').onclick = close;
    if (dim && !into) dim.onclick = close;
    if (secs && !into){
      // the timer pauses while the pointer is over it
      var left = secs * 1000, t0 = Date.now(), tm = setTimeout(close, left), bar = n.querySelector('.vox-ann-bar');
      n.addEventListener('mouseenter', function(){ clearTimeout(tm); left -= Date.now() - t0; if (bar) bar.style.animationPlayState = 'paused'; });
      n.addEventListener('mouseleave', function(){ t0 = Date.now(); tm = setTimeout(close, Math.max(0, left)); if (bar) bar.style.animationPlayState = 'running'; });
    }
    host.appendChild(n);
    return n;
  }
  window.VoxAnnounce = { show: showAnn, style: fullStyle, icons: ICONS, fonts: Object.keys(FONTS), anims: ANIMS };
  // which announcements this browser has shown: { id: rev }
  function seenMap(){
    var m = {}; try { m = JSON.parse(localStorage.getItem('vox-ann-seen2')) || {}; } catch (e) {}
    if (!m._old){ var old = 0; try { old = +localStorage.getItem('vox-ann-seen') || 0; } catch (e) {} m._old = old || -1; }
    return m;
  }
  function checkAnn(){
    if (annBusy || document.hidden || window.VOX_NO_ANNOUNCE) return;
    annBusy = true;
    fetch(SB + '/rest/v1/rpc/live_announcements', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(list){
        annBusy = false;
        if (!Array.isArray(list)) return;
        var m = seenMap(), keep = { _old: m._old }, show = [];
        list.forEach(function(a){
          var rev = a.rev || 1, had = m[a.id] || (a.id <= m._old ? 1 : 0);
          keep[a.id] = Math.max(had, rev);
          if (rev > had) show.push(a);
        });
        try { localStorage.setItem('vox-ann-seen2', JSON.stringify(keep)); } catch (e) {}
        show.reverse().forEach(function(a){ showAnn(a); });
      }, function(){ annBusy = false; });
  }

  // take the starting fingerprint once the page has settled, then keep checking
  if (document.readyState === 'complete') setTimeout(check, 1500);
  else addEventListener('load', function(){ setTimeout(check, 1500); });
  setTimeout(checkAnn, 1000);
  setInterval(function(){ check(); checkAnn(); }, EVERY);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden){ check(); checkAnn(); } });
})();

/* Account bans: a banned customer can still read the site, but game pages and the order form are covered by a
   "banned" screen. The server refuses their orders and game actions too (account-ban-migration.sql); this is
   just so they see why. */
(function(){
  var GATED = /^\/(games|blackjack|beat-tapper|dune|higher-or-lower|keno|roulette|slots|solitaire|squish|three-card-poker|three-card-poker-live|order-form)(\.html)?$/;
  if (!GATED.test(location.pathname)) return;
  var SB = 'https://paycasfatsakidsriwqt.supabase.co', KEY = 'sb_publishable_Yk3l_-tXm4qtaRnrfw54pw_Awel9tCv';
  var TOKEN_KEY = 'sb-paycasfatsakidsriwqt-auth-token', shown = false, busy = false;
  function token(){ try { var t = JSON.parse(localStorage.getItem(TOKEN_KEY)); return t && t.access_token; } catch (e) { return null; } }
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function show(b){
    if (shown) return; shown = true;
    var st = document.createElement('style');
    st.textContent = '#vx-ban{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}' +
      ':root[data-theme="light"] #vx-ban{background:#f6f8fa;color:#1f2328}' +
      '#vx-ban *{text-shadow:none;letter-spacing:normal;text-transform:none;font-family:inherit;animation:none}' +
      '#vx-ban .bx{max-width:380px;width:100%;text-align:center}' +
      '#vx-ban .ic{width:52px;height:52px;margin:0 auto 14px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(248,81,73,.14);color:#f85149}' +
      '#vx-ban .ic svg{width:24px;height:24px}' +
      '#vx-ban h1{margin:0 0 6px;font-size:22px;font-weight:700;color:inherit;background:none;-webkit-text-fill-color:currentColor}' +
      '#vx-ban p{margin:0 0 18px;opacity:.7;font-size:14px}' +
      '#vx-ban .why{margin:-8px 0 18px;font-size:13.5px;opacity:.85}' +
      '#vx-ban nav{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}' +
      '#vx-ban a,#vx-ban button{font:inherit;font-size:13.5px;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:none;color:inherit;text-decoration:none;cursor:pointer}' +
      '#vx-ban a.main{background:#4493f8;border-color:#4493f8;color:#fff}';
    var d = document.createElement('div'); d.id = 'vx-ban'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-modal', 'true');
    d.innerHTML = '<div class="bx"><div class="ic"><svg aria-hidden="true"><use href="/icons.svg#lock"/></svg></div>' +
      '<h1>Account banned</h1><p>This account can’t place orders or play games.</p>' +
      (b.reason ? '<div class="why">Reason: ' + esc(b.reason) + '</div>' : '') +
      '<nav><a class="main" href="/">Home</a><a href="/order.html">My orders</a><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a><button type="button" id="vx-ban-out">Sign out</button></nav></div>';
    document.documentElement.appendChild(st); document.documentElement.appendChild(d);
    if (document.body){ document.body.inert = true; document.body.style.overflow = 'hidden'; }
    document.getElementById('vx-ban-out').onclick = function(){
      var t = token();
      var done = function(){ try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} location.href = '/'; };
      if (!t) return done();
      fetch(SB + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t } }).then(done, done);
    };
  }
  function check(){
    var t = token(); if (!t || shown || busy) return;
    // an expired login is refreshed by the page's own client (the storage event below re-runs this); calling with it only gets a 401
    try { var exp = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp; if (exp && exp * 1000 < Date.now()) return; } catch (e) {}
    busy = true;
    fetch(SB + '/rest/v1/rpc/my_account_ban', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: '{}' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(b){ busy = false; if (b && b.banned) show(b); }, function(){ busy = false; });
  }
  check();
  setInterval(check, 30000);
  addEventListener('storage', function(e){ if (e.key === TOKEN_KEY) check(); });
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) check(); });
})();

/* Emergency mode (migrations/emergency-mode-migration.sql): while a founder has it on, every page pulses red, shows
   flashing warning lights and a bar with a "Learn more" link to /emergency.html (the founder's report), and anyone signed
   in who isn't a founder is signed out in this browser too (the server already ended their sessions). The server refuses
   orders, payments, messages and games and hides customer data on its own; this is only the look. The last state is kept for the tab
   so the next page shows it straight away. */
(function(){
  var SB = 'https://paycasfatsakidsriwqt.supabase.co', KEY = 'sb_publishable_Yk3l_-tXm4qtaRnrfw54pw_Awel9tCv';
  var on = false, busy = false, onReportPage = /\/emergency(\.html)?$/.test(location.pathname);
  var CSS =
    ':root:root:root:root{--accent:#ff3b3b;--accent-dim:rgba(255,59,59,.18);--btn-primary-hover:#ff5c5c}' +
    '@keyframes vxEmPulse{0%,100%{opacity:.55}50%{opacity:1}}' +
    '@keyframes vxEmLight{0%,49%{opacity:1;box-shadow:0 0 14px 4px #ff2a2a}50%,100%{opacity:.25;box-shadow:none}}' +
    '#vx-em-glow{position:fixed;inset:0;pointer-events:none;z-index:2147482000;' +
      'background:radial-gradient(ellipse at center,rgba(255,0,0,0) 45%,rgba(255,0,0,.28) 100%),rgba(255,0,0,.07);' +
      'box-shadow:inset 0 0 120px 24px rgba(255,0,0,.55);animation:vxEmPulse 1.6s ease-in-out infinite}' +
    '#vx-em-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147482001;display:flex;align-items:center;gap:12px;' +
      'padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:#140000;color:#fff;border-top:2px solid #ff2a2a;' +
      'font:600 14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 -6px 24px rgba(255,0,0,.35)}' +
    '#vx-em-bar .l{width:12px;height:12px;border-radius:50%;background:#ff2a2a;flex:none;animation:vxEmLight .9s steps(1) infinite}' +
    '#vx-em-bar .l.b{animation-delay:.45s}' +
    '#vx-em-bar .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#vx-em-bar .t b{letter-spacing:.08em;color:#ff5c5c;margin-right:6px}' +
    '#vx-em-bar a{flex:none;color:#fff;background:#ff2a2a;text-decoration:none;padding:7px 14px;border-radius:8px;font-weight:700}' +
    'html.vx-em body{padding-bottom:64px}' +
    '@media (prefers-reduced-motion:reduce){#vx-em-glow,#vx-em-bar .l{animation:none}}';
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function apply(st){
    var want = !!(st && st.active);
    try { sessionStorage.setItem('vx-em', JSON.stringify(want ? { active: true, title: st.title } : { active: false })); } catch (e) {}
    var html = document.documentElement;
    if (!want){
      if (!on) return; on = false;
      html.classList.remove('vx-em');
      ['vx-em-css', 'vx-em-glow', 'vx-em-bar'].forEach(function(id){ var n = document.getElementById(id); if (n) n.remove(); });
      return;
    }
    on = true;
    html.classList.add('vx-em');
    if (!document.getElementById('vx-em-css')){ var c = document.createElement('style'); c.id = 'vx-em-css'; c.textContent = CSS; (document.head || html).appendChild(c); }
    if (!document.body){ document.addEventListener('DOMContentLoaded', function(){ apply(st); }, { once: true }); return; }
    if (!document.getElementById('vx-em-glow')){ var g = document.createElement('div'); g.id = 'vx-em-glow'; g.setAttribute('aria-hidden', 'true'); document.body.appendChild(g); }
    if (onReportPage) return;
    var bar = document.getElementById('vx-em-bar');
    if (!bar){ bar = document.createElement('div'); bar.id = 'vx-em-bar'; bar.setAttribute('role', 'alert'); document.body.appendChild(bar); }
    bar.innerHTML = '<span class="l" aria-hidden="true"></span><span class="l b" aria-hidden="true"></span>' +
      '<span class="t"><b>EMERGENCY</b>' + esc(st.title || 'The site is paused') + '</span><a href="/emergency.html">Learn more</a>';
  }
  // everyone except founders is signed out: the server already ended their sessions, this clears the login in this browser too
  var TOKEN_KEY = 'sb-paycasfatsakidsriwqt-auth-token', outChecked = false;
  function signOutHere(){
    if (outChecked) return; outChecked = true;
    var raw = null; try { raw = localStorage.getItem(TOKEN_KEY); } catch (e) {}
    if (!raw) return;
    var t = null; try { var o = JSON.parse(raw); t = o.access_token || (o.currentSession && o.currentSession.access_token); } catch (e) {}
    var drop = function(){
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
      try { if (!sessionStorage.getItem('vx-em-out')){ sessionStorage.setItem('vx-em-out', '1'); location.reload(); } } catch (e) {}
    };
    if (!t) return drop();
    fetch(SB + '/rest/v1/rpc/is_founder', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: '{}' })
      .then(function(r){ return r.ok ? r.json() : false; }, function(){ return null; })
      .then(function(f){ if (f === true) return; if (f === null){ outChecked = false; return; } drop(); });
  }
  function check(){
    if (busy) return; busy = true;
    fetch(SB + '/rest/v1/rpc/emergency_status', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(st){ busy = false; if (st){ apply(st); if (st.active) signOutHere(); else { outChecked = false; try { sessionStorage.removeItem('vx-em-out'); } catch (e) {} } } }, function(){ busy = false; });
  }
  window.VoxEmergency = { check: check };
  try { var last = JSON.parse(sessionStorage.getItem('vx-em') || 'null'); if (last && last.active) apply(last); } catch (e) {}
  check();
  setInterval(function(){ if (!document.hidden) check(); }, 8000);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) check(); });
})();
