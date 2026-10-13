/* Update check, on every page.
   Every 30 seconds (while the tab is visible) it re-downloads this page and the site's own scripts and
   stylesheets it uses, skipping the browser cache, and compares them with what was there when the page
   loaded. If anything has changed, a bar offers a refresh. It doesn't reload by itself, so nobody loses a
   half-filled form, picked files or a game in progress. */
(function(){
  var EVERY = 30000;
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

  // take the starting fingerprint once the page has settled, then keep checking
  if (document.readyState === 'complete') setTimeout(check, 1500);
  else addEventListener('load', function(){ setTimeout(check, 1500); });
  setInterval(check, EVERY);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) check(); });
})();
