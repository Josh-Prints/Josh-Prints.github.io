/* Every game page: icon buttons in the top bar, a close button in the side drawer, and a full screen button.
   Pages keep their own button handlers; this only changes how the buttons look. */
(function(){
  'use strict';
  var ico = function(name){ return '<svg class="ico gui-ico" aria-hidden="true"><use href="/icons.svg#' + name + '"/></svg>'; };
  // id -> [icon, label] (the mute button's icon follows its aria-pressed)
  var BTN = {
    'lb-toggle': ['crown', 'Leaderboard, account and rules'],
    'restart': ['repeat', 'New game'],
    'new': ['repeat', 'New game'],
    'undo': ['skip-back', 'Undo'],
    'pause': ['pause', 'Pause'],
    'mute': ['volume-2', 'Sound']
  };
  function dress(b){
    var id = b.id, spec = BTN[id]; if (!spec) return;
    var name = spec[0], label = spec[1];
    if (id === 'mute'){ var off = b.getAttribute('aria-pressed') === 'true'; name = off ? 'volume-x' : 'volume-2'; label = off ? 'Sound off' : 'Sound on'; }
    if (b.getAttribute('data-gui') === name) return;
    b.setAttribute('data-gui', name); b.classList.add('gui-icon');
    b.innerHTML = ico(name); b.setAttribute('aria-label', label); b.title = label;
  }
  function init(){
    var bar = document.querySelector('.topbar'); if (!bar) return;
    Object.keys(BTN).forEach(function(id){
      var b = document.getElementById(id); if (!b || !bar.contains(b)) return;
      dress(b);
      // the page rewrites its buttons (e.g. "Sound on"/"Sound off"): put the icon back
      new MutationObserver(function(){
        var want = id === 'mute' ? (b.getAttribute('aria-pressed') === 'true' ? 'volume-x' : 'volume-2') : BTN[id][0];
        if (!b.querySelector('.gui-ico') || b.getAttribute('data-gui') !== want){ b.removeAttribute('data-gui'); dress(b); }
      }).observe(b, { attributes: true, attributeFilter: ['aria-pressed'], childList: true, characterData: true, subtree: true });
    });
    // close button inside the side drawer
    var side = document.getElementById('side-right');
    if (side && !side.querySelector('.gui-close')){
      var c = document.createElement('button'); c.type = 'button'; c.className = 'gui-close'; c.innerHTML = ico('x') + 'Close';
      c.addEventListener('click', function(e){ e.stopPropagation(); side.classList.remove('open'); });
      side.insertBefore(c, side.firstChild);
    }
    // full screen (not offered where the browser can't do it, e.g. iPhone Safari)
    var root = document.documentElement;
    var can = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    if (can && !document.getElementById('gui-fs')){
      var f = document.createElement('button'); f.type = 'button'; f.id = 'gui-fs'; f.className = 'tbtn gui-icon';
      var isFs = function(){ return !!(document.fullscreenElement || document.webkitFullscreenElement); };
      var show = function(){ var on = isFs(); f.innerHTML = ico(on ? 'minimize-2' : 'maximize-2'); f.title = on ? 'Exit full screen' : 'Full screen'; f.setAttribute('aria-label', f.title); };
      f.addEventListener('click', function(){
        if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        else { var r = (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' }); if (r && r.catch) r.catch(function(){}); }
      });
      document.addEventListener('fullscreenchange', show); document.addEventListener('webkitfullscreenchange', show);
      show(); bar.appendChild(f);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
