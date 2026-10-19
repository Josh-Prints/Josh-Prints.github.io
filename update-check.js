/* Update check and founder announcements, on every page.
   Every 8 seconds (while the tab is visible) it re-downloads this page and the site's own scripts and
   stylesheets it uses, skipping the browser cache, and compares them with what was there when the page
   loaded. If anything has changed, a bar offers a refresh. It doesn't reload by itself, so nobody loses a
   half-filled form, picked files or a game in progress.
   On the same timer it asks for the newest founder announcement (current_announcement) and shows it once
   as a notification. window.VoxAnnounce.show() is also used by the founder page's preview. */
(function(){
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
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:12px;' +
      'padding:10px 12px 10px 16px;border-radius:999px;background:#161b22;color:#e6edf3;border:1px solid #30363d;box-shadow:0 10px 30px rgba(0,0,0,.35);' +
      'font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:calc(100% - 24px);';
    bar.innerHTML = '<span>A new version of this page is available.</span>' +
      '<button type="button" style="font:inherit;padding:7px 14px;border-radius:999px;border:0;background:#4493f8;color:#fff;cursor:pointer;white-space:nowrap">Refresh</button>' +
      '<button type="button" aria-label="Dismiss" style="font:inherit;font-size:18px;line-height:1;padding:2px 6px;border:0;background:none;color:#8b949e;cursor:pointer">&times;</button>';
    var b = bar.querySelectorAll('button');
    b[0].onclick = function(){ location.reload(); };
    b[1].onclick = function(){ bar.remove(); };
    (document.body || document.documentElement).appendChild(bar);
  }

  /* ---------- founder announcements ---------- */
  var SB = 'https://paycasfatsakidsriwqt.supabase.co', KEY = 'sb_publishable_Yk3l_-tXm4qtaRnrfw54pw_Awel9tCv';
  var THEMES = {
    blue: 'linear-gradient(135deg,#1f6feb,#4493f8)', green: 'linear-gradient(135deg,#1a7f37,#2ea043)',
    purple: 'linear-gradient(135deg,#6e40c9,#8957e5)', red: 'linear-gradient(135deg,#b62324,#e5534b)',
    orange: 'linear-gradient(135deg,#bc4c00,#f0883e)', gold: 'linear-gradient(135deg,#9a6700,#d4a72c)',
    dark: 'linear-gradient(135deg,#161b22,#2d333b)',
    rainbow: 'linear-gradient(90deg,#ff3b3b,#ff9f1c,#ffe14d,#3ddc84,#3b9cff,#8b5cf6,#ff3bd4,#ff3b3b)'
  };
  var annBusy = false, annStyled = false;
  function seenId(){ try { return +localStorage.getItem('vox-ann-seen') || 0; } catch (e) { return 0; } }
  function annStyle(){
    if (annStyled) return; annStyled = true;
    var st = document.createElement('style');
    st.textContent = '.vox-ann-wrap{position:fixed;top:16px;right:16px;z-index:2147483001;display:grid;gap:10px;width:min(360px,calc(100% - 32px))}' +
      '@media (max-width:600px){.vox-ann-wrap{left:16px;right:16px;width:auto}}' +
      '.vox-ann{position:relative;overflow:hidden;display:flex;gap:12px;align-items:flex-start;padding:14px 40px 16px 14px;border-radius:14px;color:#fff;' +
      'box-shadow:0 12px 34px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.18);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'animation:vox-ann-in .35s cubic-bezier(.2,.9,.3,1.2)}' +
      '.vox-ann.rainbow{background-size:300% 100% !important;animation:vox-ann-in .35s cubic-bezier(.2,.9,.3,1.2),vox-ann-rb 4s linear infinite}' +
      '.vox-ann.rainbow .vox-ann-txt{text-shadow:0 1px 2px rgba(0,0,0,.45)}' +
      '.vox-ann.out{transition:opacity .3s,transform .3s;opacity:0;transform:translateY(-8px)}' +
      '.vox-ann-ico{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.2)}' +
      '.vox-ann-ico svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
      '.vox-ann-txt{min-width:0;overflow-wrap:anywhere}.vox-ann-k{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.85}' +
      '.vox-ann-t{font-weight:700;font-size:15px;margin-top:1px}.vox-ann-b{margin-top:2px;white-space:pre-line}' +
      '.vox-ann-x{position:absolute;top:8px;right:8px;width:26px;height:26px;border:0;border-radius:50%;background:rgba(0,0,0,.18);color:#fff;font-size:17px;line-height:1;cursor:pointer}' +
      '.vox-ann-x:hover{background:rgba(0,0,0,.32)}' +
      '.vox-ann-bar{position:absolute;left:0;bottom:0;height:3px;background:rgba(255,255,255,.75);transform-origin:left;animation:vox-ann-bar linear forwards}' +
      '@keyframes vox-ann-in{from{opacity:0;transform:translateY(-12px) scale(.97)}to{opacity:1;transform:none}}' +
      '@keyframes vox-ann-rb{from{background-position:0 0}to{background-position:300% 0}}' +
      '@keyframes vox-ann-bar{from{transform:scaleX(1)}to{transform:scaleX(0)}}' +
      '@media (prefers-reduced-motion:reduce){.vox-ann,.vox-ann.rainbow{animation:none}}';
    document.head.appendChild(st);
  }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // a: { title, body, theme, show_secs }; opts.into: element to show it in (the founder preview), opts.loop: restart the timer bar
  function showAnn(a, opts){
    opts = opts || {}; annStyle();
    var host = opts.into;
    if (!host){
      host = document.querySelector('.vox-ann-wrap');
      if (!host){ host = document.createElement('div'); host.className = 'vox-ann-wrap'; (document.body || document.documentElement).appendChild(host); }
    }
    var theme = THEMES[a.theme] ? a.theme : 'blue', secs = Math.max(0, +a.show_secs || 0);
    var n = document.createElement('div');
    n.className = 'vox-ann' + (theme === 'rainbow' ? ' rainbow' : ''); n.setAttribute('role', 'status');
    n.style.background = THEMES[theme];
    n.innerHTML = '<div class="vox-ann-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg></div>' +
      '<div class="vox-ann-txt"><div class="vox-ann-k">Announcement</div>' + (a.title ? '<div class="vox-ann-t">' + esc(a.title) + '</div>' : '') +
      '<div class="vox-ann-b">' + esc(a.body) + '</div></div><button type="button" class="vox-ann-x" aria-label="Close">&times;</button>' +
      (secs ? '<div class="vox-ann-bar" style="animation-duration:' + secs + 's"></div>' : '');
    var gone = false;
    function close(){ if (gone) return; gone = true; n.classList.add('out'); setTimeout(function(){ n.remove(); }, 300); }
    n.querySelector('.vox-ann-x').onclick = close;
    if (secs && !opts.into){
      // the timer pauses while the pointer is over it
      var left = secs * 1000, t0 = Date.now(), tm = setTimeout(close, left), bar = n.querySelector('.vox-ann-bar');
      n.addEventListener('mouseenter', function(){ clearTimeout(tm); left -= Date.now() - t0; bar.style.animationPlayState = 'paused'; });
      n.addEventListener('mouseleave', function(){ t0 = Date.now(); tm = setTimeout(close, Math.max(0, left)); bar.style.animationPlayState = 'running'; });
    }
    if (opts.into) host.innerHTML = '';
    host.appendChild(n);
    return n;
  }
  window.VoxAnnounce = { show: showAnn, themes: Object.keys(THEMES) };
  function checkAnn(){
    if (annBusy || document.hidden || window.VOX_NO_ANNOUNCE) return;
    annBusy = true;
    fetch(SB + '/rest/v1/rpc/current_announcement', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(a){
        annBusy = false;
        if (!a || !a.id || a.id <= seenId()) return;
        try { localStorage.setItem('vox-ann-seen', String(a.id)); } catch (e) {}
        showAnn(a);
      }, function(){ annBusy = false; });
  }

  // take the starting fingerprint once the page has settled, then keep checking
  if (document.readyState === 'complete') setTimeout(check, 1500);
  else addEventListener('load', function(){ setTimeout(check, 1500); });
  setTimeout(checkAnn, 1000);
  setInterval(function(){ check(); checkAnn(); }, EVERY);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden){ check(); checkAnn(); } });
})();
