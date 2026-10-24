/* One "Sign in" button: on customer pages the old "Sign in with Google" / "Sign in with email code" pair becomes a single
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
})();
