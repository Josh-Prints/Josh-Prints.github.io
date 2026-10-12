/* Customer pages share the home page's look for the visit.
   The home page picks a look at random on every load and saves it here; the other customer pages
   (browse, estimate, order form, order tracking) read it so the whole visit matches; the games page
   picks a new one on every load.
   ?style=<name> forces one. Styling lives in /looks.css. Admin pages don't load this. */
(function(){
  var L = ['glow', 'particles', 'holo', 'neon', 'wire', 'glass', 'kinetic', 'iso', 'ascii', 'mesh', 'flap', 'vhs', 'blue'];
  var s = null, q = null;
  // <script src="/looks.js" data-pick> picks a fresh look on every load (games page), using the same
  // no-repeat rounds as the home page; other pages keep the visit's current look.
  var pick = !!(document.currentScript && document.currentScript.hasAttribute('data-pick'));
  try { q = new URLSearchParams(location.search).get('style'); } catch (e) {}
  if (L.indexOf(q) >= 0) s = q;
  else if (pick){
    var seen = [], last = null;
    try { seen = JSON.parse(localStorage.getItem('vx-look-seen') || '[]'); last = localStorage.getItem('vx-look'); } catch (e) {}
    if (!Array.isArray(seen)) seen = [];
    seen = seen.filter(function(x, i){ return L.indexOf(x) >= 0 && seen.indexOf(x) === i; });
    var left = L.filter(function(x){ return seen.indexOf(x) < 0; });
    if (!left.length){ seen = []; left = L.filter(function(x){ return x !== last; }); }
    s = left[Math.floor(Math.random() * left.length)];
    seen.push(s);
    try { localStorage.setItem('vx-look-seen', JSON.stringify(seen)); } catch (e) {}
  } else {
    try { s = sessionStorage.getItem('vx-look') || localStorage.getItem('vx-look'); } catch (e) {}
    if (L.indexOf(s) < 0) s = L[Math.floor(Math.random() * L.length)];
  }
  try { sessionStorage.setItem('vx-look', s); localStorage.setItem('vx-look', s); } catch (e) {}
  document.documentElement.setAttribute('data-hs', s);
  if (s === 'glow') return;
  if (s === 'ascii' || s === 'vhs'){
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=VT323&display=swap';
    document.head.appendChild(l);
  }
  document.addEventListener('DOMContentLoaded', function(){
    var bg = document.createElement('div');
    bg.className = 'lk-bg'; bg.setAttribute('aria-hidden', 'true');
    if (s === 'kinetic'){
      bg.innerHTML = '<div class="lk-marq">' + ['PRINT · MODEL · SLICE · LAYER · BUILD · ', 'CUSTOM · MADE · TO · ORDER · ', 'PLA · PETG · TPU · RESIN · ', 'IDEA · FILE · QUOTE · PRINT · ']
        .map(function(t){ var r = t + t + t + t; return '<div>' + r + r + '</div>'; }).join('') + '</div>';
    }
    if (s === 'glass' || s === 'mesh') bg.innerHTML = '<span></span><span></span><span></span><span></span>';
    document.body.insertBefore(bg, document.body.firstChild);
  });
})();
