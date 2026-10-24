/* Guest email check: VoxVerify.ensure(supabase, email, { google }) resolves true once the email is verified
   (rpc email_verified / send_order_code / check_order_code in migrations/email-verify-migration.sql). */
(function(){
  var css = '.vv-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55)}' +
    '.vv-box{width:100%;max-width:340px;padding:24px;border-radius:12px;background:var(--bg-raised,var(--canvas,#fff));color:var(--ink,var(--fg,#1f2328));border:1px solid rgba(var(--border-tint,128,128,128),.2);font-family:inherit}' +
    '.vv-box h3{margin:0 0 6px;font-size:17px}.vv-box p{margin:0 0 14px;font-size:13px;color:var(--ink-dim,var(--fg-muted,#656d76))}' +
    '.vv-box input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:20px;letter-spacing:6px;text-align:center;font-family:inherit;border:1px solid rgba(var(--border-tint,128,128,128),.25);border-radius:6px;background:transparent;color:inherit;margin-bottom:10px}' +
    '.vv-btn{width:100%;padding:10px;border-radius:8px;border:1px solid rgba(var(--border-tint,128,128,128),.2);background:transparent;color:inherit;font:600 14px inherit;font-family:inherit;cursor:pointer;margin-top:8px}' +
    '.vv-btn.main{background:var(--accent,#0969da);border-color:transparent;color:#fff}.vv-btn:disabled{opacity:.6;cursor:default}' +
    '.vv-msg{min-height:16px;font-size:12.5px;color:var(--err,#cf222e);margin:0 0 4px}.vv-msg.ok{color:var(--ink-dim,var(--fg-muted,#656d76))}' +
    '.vv-link{background:none;border:0;color:var(--accent,#0969da);font:inherit;font-size:13px;cursor:pointer;padding:6px 0 0;display:block;margin:0 auto}' +
    '.guest-signin{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 16px;padding:12px 14px;border-radius:10px;background:rgba(var(--border-tint,128,128,128),.07);font-size:14px}' +
    '.guest-signin[hidden]{display:none}.guest-signin button{padding:8px 14px;border-radius:8px;border:1px solid rgba(var(--border-tint,128,128,128),.25);background:var(--bg-raised,var(--canvas,#fff));color:inherit;font:600 13.5px inherit;font-family:inherit;cursor:pointer}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // the "Sign in" strip at the top of a form
  window.VoxGuestSignin = function(host){
    var d = document.createElement('div'); d.className = 'guest-signin'; d.hidden = true;
    d.innerHTML = '<span>Sign in to skip the email check</span><button type="button">Sign in</button>';
    d.querySelector('button').onclick = function(){ if (window.VoxSignIn) window.VoxSignIn(); else { var b = document.getElementById('google-signin-btn'); if (b) b.click(); } };
    host.insertBefore(d, host.firstChild);
    return d;
  };

  window.VoxVerify = {
    ensure: function(supabase, email, opts){
      opts = opts || {};
      return supabase.rpc('email_verified', { p_email: email }).then(function(r){
        if (r && r.data === true) return true;
        return new Promise(function(done){
          var ov = document.createElement('div'); ov.className = 'vv-ov';
          ov.innerHTML = '<div class="vv-box" role="dialog" aria-modal="true"><h3>Check your email</h3><p></p>' +
            '<input type="text" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code" aria-label="6-digit code">' +
            '<div class="vv-msg" role="alert"></div><button type="button" class="vv-btn main" data-v>Verify</button>' +
            '<button type="button" class="vv-link" data-r>Send a new code</button>' +
            '<button type="button" class="vv-btn" data-g>Sign in instead</button>' +
            '<button type="button" class="vv-link" data-c>Cancel</button></div>';
          document.body.appendChild(ov);
          var $ = function(s){ return ov.querySelector(s); }, msg = $('.vv-msg'), inp = $('input'), verifyBtn = $('[data-v]'), resend = $('[data-r]');
          function finish(ok){ ov.remove(); done(ok); }
          function say(t, ok){ msg.textContent = t || ''; msg.className = 'vv-msg' + (ok ? ' ok' : ''); }
          var last = 0;
          function send(){
            if (Date.now() - last < 45000) { say('Wait a moment, then try again.'); return; }
            last = Date.now(); resend.disabled = true; say('Sending…', true);
            $('p').textContent = 'We are sending a code to ' + email + '.';
            supabase.rpc('send_order_code', { p_email: email }).then(function(r){
              resend.disabled = false;
              if (r.error){ last = 0; $('p').textContent = 'We could not send a code to ' + email + '.'; say(r.error.message); return; }
              $('p').textContent = 'We sent a 6-digit code to ' + email + '. Check your spam.';
              say(''); inp.focus();
            });
          }
          verifyBtn.onclick = function(){
            if (!/^\d{6}$/.test(inp.value.trim())) { say('Enter the 6-digit code.'); return; }
            verifyBtn.disabled = true; say('');
            supabase.rpc('check_order_code', { p_email: email, p_code: inp.value.trim() }).then(function(r){
              verifyBtn.disabled = false;
              if (r.error) { say(r.error.message); return; }
              finish(true);
            });
          };
          inp.addEventListener('keydown', function(e){ if (e.key === 'Enter'){ e.preventDefault(); verifyBtn.click(); } });
          inp.addEventListener('input', function(){ inp.value = inp.value.replace(/\D/g, '').slice(0, 6); });
          resend.onclick = send;
          $('[data-g]').onclick = function(){ finish(false); if (opts.google) opts.google(); };
          $('[data-c]').onclick = function(){ finish(false); };
          send();
        });
      });
    }
  };
})();
