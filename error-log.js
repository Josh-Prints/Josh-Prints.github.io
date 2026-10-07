/* Voxprints error reporter.
 *
 * Loaded on every page. Catches crashes, failed requests and failed script
 * loads, gives each distinct error a short stable code (e.g. E-7F3K9), and
 * reports it to the founder's Errors tab with a short trail of what the visitor
 * was doing. Signed-in visitors are identified by the server from their login;
 * everyone else gets a random id kept in their browser so repeats can be spotted.
 *
 * It never records what people type: no input values, no message text, no
 * request bodies. Click labels are capped to 40 characters.
 * Everything here is wrapped so that reporting an error can never cause one.
 */
(function () {
  'use strict';
  if (window.__vxErrLoaded) return;
  window.__vxErrLoaded = true;

  var SB = 'https://paycasfatsakidsriwqt.supabase.co';
  var KEY = 'sb_publishable_Yk3l_-tXm4qtaRnrfw54pw_Awel9tCv';   // public publishable key, same as the pages use
  var AUTH_KEY = 'sb-paycasfatsakidsriwqt-auth-token';
  var ENDPOINT = SB + '/rest/v1/rpc/log_client_error';
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  var unloading = false;
  var sentTotal = 0;
  var sentByCode = {};
  var toastShown = false;
  var hiddenAt = 0; // last time the tab/app went to the background (phones cancel in-flight requests then)
  var navAt = 0;   // last time the visitor clicked a link / submitted a form (the page is probably about to unload)

  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

  /* ---- who: a random id per browser (signed-in people are identified server-side) ---- */
  var visitor = (function () {
    var v = safe(function () { return localStorage.getItem('vx_vid'); });
    if (v && v.length >= 8) return v;
    v = safe(function () { return crypto.randomUUID(); }) ||
      (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2) + Date.now().toString(16)).slice(0, 32);
    safe(function () { localStorage.setItem('vx_vid', v); });
    return v;
  })();

  /* ---- device summary ---- */
  function deviceSummary() {
    var ua = navigator.userAgent || '', b = 'Browser', os = '';
    var m;
    if ((m = ua.match(/Edg\/(\d+)/))) b = 'Edge ' + m[1];
    else if ((m = ua.match(/(?:Chrome|CriOS)\/(\d+)/))) b = 'Chrome ' + m[1];
    else if ((m = ua.match(/(?:Firefox|FxiOS)\/(\d+)/))) b = 'Firefox ' + m[1];
    else if ((m = ua.match(/Version\/(\d+).*Safari/))) b = 'Safari ' + m[1];
    if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    return b + (os ? ' · ' + os : '') + (/Mobi|iPhone|Android/.test(ua) ? ' · mobile' : '');
  }

  /* ---- page + url (query values are redacted; ids are cut to 8 characters) ---- */
  function pagePath() { return clip((location.pathname || '/').replace(/\/index\.html$/, '/'), 160); }
  function redactedUrl() {
    var q = [];
    safe(function () {
      new URLSearchParams(location.search).forEach(function (v, k) {
        var val = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? v.slice(0, 8) + '…' : (/^(preview|tab|view|filter|status)$/.test(k) ? clip(v, 20) : '…');
        q.push(k + '=' + val);
      });
    });
    return clip(pagePath() + (q.length ? '?' + q.join('&') : ''), 300);
  }
  function refDesc() {
    var r = document.referrer;
    if (!r) return 'direct';
    return safe(function () {
      var u = new URL(r);
      return u.origin === location.origin ? u.pathname : 'external: ' + u.hostname;
    }) || 'direct';
  }

  /* ---- breadcrumbs: the last few things the visitor did, kept across page loads ---- */
  var crumbs = safe(function () { return JSON.parse(sessionStorage.getItem('vx_bc') || '[]'); }) || [];
  if (!Array.isArray(crumbs)) crumbs = [];
  function addCrumb(k, d) {
    safe(function () {
      d = clip(String(d).replace(/\s+/g, ' ').trim(), 100);
      var last = crumbs[crumbs.length - 1];
      if (last && last.k === k && last.d.replace(/ ×\d+$/, '') === d) {
        var n = (parseInt((last.d.match(/ ×(\d+)$/) || [0, 1])[1], 10) || 1) + 1;   // collapse repeats (polling)
        last.d = d + ' ×' + n; last.t = Date.now();
      } else {
        crumbs.push({ t: Date.now(), k: k, d: d });
        if (crumbs.length > 20) crumbs = crumbs.slice(-20);
      }
      sessionStorage.setItem('vx_bc', JSON.stringify(crumbs));
    });
  }
  addCrumb('page', pagePath() + '  (from ' + refDesc() + ')');

  document.addEventListener('click', function (e) {
    safe(function () {
      var el = e.target && e.target.closest && e.target.closest('button, a, [role=button], summary, label, select, input[type=checkbox], input[type=radio], input[type=submit]');
      if (!el) return;
      var tag = el.tagName.toLowerCase();
      var label = el.id ? '#' + el.id : '';
      var text = el.getAttribute('aria-label') || el.getAttribute('title') || (tag === 'select' ? '' : (el.innerText || el.value || ''));
      text = clip(String(text).replace(/\s+/g, ' ').trim(), 40);
      var dest = '';
      if (tag === 'a' && el.getAttribute('href')) {
        dest = ' → ' + clip(el.getAttribute('href').split('?')[0], 60);
        if (el.getAttribute('href').charAt(0) !== '#' && el.target !== '_blank') navAt = Date.now();
      }
      addCrumb('click', tag + (label || '') + (text ? ' "' + text + '"' : '') + dest);
    });
  }, true);
  document.addEventListener('submit', function (e) {
    safe(function () { navAt = Date.now(); addCrumb('submit', 'form' + (e.target && e.target.id ? '#' + e.target.id : '')); });
  }, true);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); });
  window.addEventListener('pagehide', function () { unloading = true; hiddenAt = Date.now(); });
  window.addEventListener('beforeunload', function () { unloading = true; });

  /* ---- the code: stable for the same kind of error on the same page ---- */
  var B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
      .replace(/https?:\/\/[^\s"')]+/g, '<url>')
      .replace(/"[^"]*"|'[^']*'/g, '"…"')
      .replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  function makeCode(kind, message, extra) {
    var s = kind + '|' + (extra && extra.endpoint ? extra.endpoint + '|' + (extra.method || '') + '|' + (extra.status || '') + '|' : '') + norm(message) + '|' + pagePath().toLowerCase();
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    var out = '';
    for (var j = 0; j < 5; j++) { out += B32.charAt(h & 31); h >>>= 5; }
    return 'E-' + out;
  }

  /* ---- sending ---- */
  function readToken() {
    return safe(function () {
      var raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && (o.access_token || (o.currentSession && o.currentSession.access_token))) || null;
    });
  }
  function send(payload) {
    if (!realFetch) return;
    var body = JSON.stringify({ p: payload });
    function go(token) {
      // Same headers supabase-js sends: the login token if there is one, otherwise the publishable key.
      var headers = { 'Content-Type': 'application/json', 'apikey': KEY, 'Authorization': 'Bearer ' + (token || KEY) };
      return realFetch(ENDPOINT, { method: 'POST', headers: headers, body: body, keepalive: true });
    }
    var token = readToken();
    go(token).then(function (res) {
      if (res && res.status === 401 && token) return go(null);   // expired login: still report, anonymously
    }).catch(function () { /* never throw from reporting */ });
  }

  function showToast(code) {
    safe(function () {
      if (toastShown || !document.body) return;
      toastShown = true;
      var d = document.createElement('div');
      d.setAttribute('role', 'status');
      d.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;max-width:92vw;' +
        'display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'background:var(--bg-raised,#161b22);color:var(--ink,#e6edf3);border:1px solid rgba(128,128,128,0.35);box-shadow:0 10px 30px rgba(0,0,0,0.3);';
      var t = document.createElement('span');
      t.appendChild(document.createTextNode('Something went wrong. Code '));
      var c = document.createElement('b'); c.style.fontFamily = 'ui-monospace,SFMono-Regular,Menlo,monospace'; c.textContent = code;
      t.appendChild(c);
      t.appendChild(document.createTextNode('. Tell us this code if it keeps happening.'));
      var x = document.createElement('button');
      x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
      x.style.cssText = 'background:none;border:none;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;';
      x.onclick = function () { d.remove(); };
      d.appendChild(t); d.appendChild(x);
      document.body.appendChild(d);
      setTimeout(function () { safe(function () { d.remove(); }); }, 15000);
    });
  }

  function report(kind, message, extra, stack, opts) {
    safe(function () {
      message = clip(message || 'Unknown error', 500);
      extra = extra || {};
      var code = makeCode(kind, message, extra);
      if (sentTotal >= 12 || (sentByCode[code] || 0) >= 3) return;   // no floods from a loop
      sentTotal++; sentByCode[code] = (sentByCode[code] || 0) + 1;
      var bc = crumbs.slice(-20).map(function (c) { return { t: c.t, k: c.k, d: c.d }; });
      send({
        code: code, visitor: visitor, kind: kind, message: message, stack: clip(stack, 3000),
        page: pagePath(), url: redactedUrl(), ref: refDesc(), ua: deviceSummary(),
        vp: window.innerWidth + 'x' + window.innerHeight, bc: bc, extra: extra
      });
      addCrumb('error', code + ' ' + clip(message, 60));
      if (opts && opts.toast) showToast(code);
    });
  }
  window.vxReportError = function (message, extra) { report('js', message, extra, null, { toast: false }); };

  /* ---- what we catch ---- */
  window.addEventListener('error', function (e) {
    safe(function () {
      var t = e.target;
      if (t && t !== window && t.nodeType === 1) {
        // An element (script, stylesheet, image, ...) failed to load. Not a JS error.
        var attr = t.getAttribute && (t.getAttribute('src') || t.getAttribute('href'));
        if (!attr || /^(data|blob|about):/i.test(attr)) return;       // nothing real was requested
        var tag = (t.tagName || '').toLowerCase();
        var host = safe(function () { var u = new URL(attr, location.href); return u.hostname + u.pathname; }) || attr;
        report('resource', 'Failed to load ' + tag + ' ' + clip(host, 120), { tag: tag }, null, { toast: false });
        return;
      }
      var msg = e.message || '';
      if (/ResizeObserver loop/i.test(msg)) return;
      var file = e.filename || '';
      if (/extension:\/\//i.test(file)) return;   // browser extensions are not our bugs
      var crossOrigin = !file && /^Script error\.?$/i.test(msg);
      report('js', msg || 'Script error', { file: clip(file.replace(location.origin, ''), 80), line: e.lineno, col: e.colno },
        e.error && e.error.stack, { toast: !crossOrigin });
    });
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    safe(function () {
      var r = e.reason, msg = (r && r.message) || String(r);
      if (r && (r.name === 'AbortError' || /aborted/i.test(msg))) return;
      if (unloading) return;
      var stack = r && r.stack;
      report('promise', msg, {}, stack, { toast: true });
    });
  });

  /* failed requests to our backend (every Supabase call goes through fetch) */
  function endpointOf(url) {
    var p = url.slice(SB.length).split('?')[0];
    var m;
    if ((m = p.match(/^\/rest\/v1\/rpc\/([\w]+)/))) return 'rpc/' + m[1];
    if ((m = p.match(/^\/rest\/v1\/([\w]+)/))) return 'rest/' + m[1];
    if ((m = p.match(/^\/functions\/v1\/([\w-]+)/))) return 'fn/' + m[1];
    if ((m = p.match(/^\/auth\/v1\/([\w]+)/))) return 'auth/' + m[1];
    if (/^\/storage\//.test(p)) return 'storage';
    return clip(p, 40);
  }
  if (realFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var tracked = url.indexOf(SB) === 0 && url.indexOf('/rpc/log_client_error') === -1;
      if (!tracked) return realFetch(input, init);
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var ep = endpointOf(url);
      return realFetch(input, init).then(function (res) {
        safe(function () {
          addCrumb('api', method + ' ' + ep + ' → ' + res.status);
          var s = res.status;
          if (s < 400) return;
          if (s === 406 || (s === 404 && method === 'GET')) return;      // "no row found" is normal
          if (ep === 'auth/verify') return;                              // a mistyped sign-in code is not a bug
          res.clone().text().then(function (txt) {
            var msg = '';
            safe(function () { var j = JSON.parse(txt); msg = j.message || j.msg || j.error_description || j.error || ''; });
            if (!msg) msg = clip(txt, 160);
            if (ep === 'auth/token' && s === 400 && /refresh token/i.test(msg)) return;   // an old login that expired: the page just asks them to sign in again
            report('http', method + ' ' + ep + ' → ' + s + (msg ? ': ' + msg : ''), { endpoint: ep, method: method, status: s },
              null, { toast: s >= 500 });
          }, function () {
            report('http', method + ' ' + ep + ' → ' + s, { endpoint: ep, method: method, status: s }, null, { toast: s >= 500 });
          });
        });
        return res;
      }, function (err) {
        safe(function () {
          if (unloading || (err && err.name === 'AbortError')) return;
          if (navigator.onLine === false) { addCrumb('net', 'offline'); return; }
          var msg = err && err.message;
          // Leaving the page cancels in-flight requests ("Load failed" in Safari). Wait a moment: if the page
          // is going away, this code never runs again; otherwise it is a real failure.
          setTimeout(function () {
            safe(function () {
              if (unloading || document.visibilityState === 'hidden' || Date.now() - navAt < 4000 || Date.now() - hiddenAt < 20000) return;
              addCrumb('api', method + ' ' + ep + ' → network error');
              report('network', method + ' ' + ep + ' → network error: ' + (msg || 'failed'),
                { endpoint: ep, method: method, status: 0 }, null, { toast: true });
            });
          }, 400);
        });
        throw err;
      });
    };
  }
})();
