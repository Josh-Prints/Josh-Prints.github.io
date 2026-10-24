/* Signing out shows a short "Signing out…" screen first (an instant swap looked like a glitch), on every page with a
   #account-signout-btn or a game panel's #sign-out button.
   One "Sign in" button: on customer pages the old "Sign in with Google" / "Sign in with email code" pair becomes a single
   Sign in button that opens /signin.html (choose Google or an email code there), then comes back to this page.
   VoxSignIn() does the same from code (game panels, the guest email check). */
(function(){
  function go(){ location.href = '/signin.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash); }
  window.VoxSignIn = go;
  var st = document.createElement('style');
  st.textContent = '#email-code-btn{display:none!important}';
  (document.head || document.documentElement).appendChild(st);
  // the page's own Google handler never runs; a click from code (e.g. the guest email check) lands here too
  document.addEventListener('click', function(e){
    var b = e.target && e.target.closest && e.target.closest('#google-signin-btn');
    if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation(); go();
  }, true);
  function relabel(){
    var b = document.getElementById('google-signin-btn');
    if (b && !b.dataset.vxSignin){ b.dataset.vxSignin = '1'; b.innerHTML = '<svg class="ico" width="1em" height="1em" aria-hidden="true"><use href="/icons.svg#user"/></svg> Sign in'; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', relabel); else relabel();

  // ---- sign out: a moment of "Signing out…", then the page's own sign-out runs ----
  var outCss = document.createElement('style');
  outCss.textContent =
    '#vx-out{position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
      'background:rgba(13,17,23,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);color:#e6edf3;' +
      'font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;transition:opacity .2s ease}' +
    '#vx-out.on{opacity:1}' +
    '#vx-out i{width:30px;height:30px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#4493f8;animation:vxspin .7s linear infinite}' +
    '@keyframes vxspin{to{transform:rotate(360deg)}}';
  (document.head || document.documentElement).appendChild(outCss);
  var passing = false;
  document.addEventListener('click', function(e){
    var b = e.target && e.target.closest && e.target.closest('#account-signout-btn, #sign-out, #cz-ban-out');
    if (!b || passing || b.disabled) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var ov = document.createElement('div'); ov.id = 'vx-out'; ov.setAttribute('role', 'status');
    ov.innerHTML = '<i></i><span>Signing out…</span>';
    document.body.appendChild(ov);
    requestAnimationFrame(function(){ ov.classList.add('on'); });
    setTimeout(function(){
      passing = true; try { b.click(); } finally { passing = false; }
      setTimeout(function(){ ov.classList.remove('on'); setTimeout(function(){ ov.remove(); }, 250); }, 500);
    }, 900);
  }, true);
})();
