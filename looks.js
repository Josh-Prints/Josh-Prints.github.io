/* Customer pages share the home page's look for the visit.
   The home page picks a look at random on every load and saves it here; the other customer pages
   (browse, estimate, order form, order tracking) read it so the whole visit matches.
   ?style=<name> forces one. Styling lives in /looks.css. Admin pages don't load this. */
(function(){
  var L = ['glow', 'particles', 'holo', 'neon', 'wire', 'glass', 'kinetic', 'iso', 'ascii', 'mesh', 'flap', 'vhs', 'blue'];
  var s = null;
  try { s = sessionStorage.getItem('vx-look') || localStorage.getItem('vx-look'); } catch (e) {}
  try { var q = new URLSearchParams(location.search).get('style'); if (L.indexOf(q) >= 0) s = q; } catch (e) {}
  if (L.indexOf(s) < 0) s = L[Math.floor(Math.random() * L.length)];
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
