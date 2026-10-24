/* Edit / delete for chat messages (order page, admin order chat, admin team chat). Hold a message down (mouse or finger,
   about half a second) to show its Edit / Delete buttons; edits and deletes leave no mark (a deleted message just goes).
   A page renders each bubble with data-mid="<id>" and, where the viewer may change it, VoxMsg.buttons() inside it and its
   text in an element with class "msg-text". Then VoxMsg.wire(container, { body(id), save(id, text), remove(id) }) handles
   the clicks: Edit swaps the text for a box with Save / Cancel, Delete asks once. save / remove return a Promise.
   VoxMsg.busy(container) is true while a message is being edited, so polling pages can hold off re-rendering it.
   The server decides who may change what (edit_order_message / delete_order_message / edit_admin_message / delete_admin_message). */
(function(){
  var ico = function(n){ return '<svg class="ico" width="1em" height="1em" aria-hidden="true"><use href="/icons.svg#' + n + '"/></svg>'; };
  var css =
    '[data-mid]{position:relative}' +
    '.vm-acts{display:none;position:absolute;top:6px;right:6px;gap:2px;background:var(--bg-raised,var(--bg,#161b22));border:1px solid rgba(var(--border-tint,128,128,128),.25);border-radius:8px;padding:3px;z-index:5;box-shadow:0 6px 18px rgba(0,0,0,.35)}' +
    '[data-mid].vm-open>.vm-acts{display:flex}' +
    '[data-mid].vm-hold{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
    '[data-mid].vm-pressing{transform:scale(.98);transition:transform .45s ease}' +
    '.vm-acts button{display:flex;align-items:center;gap:5px;background:none;border:0;color:var(--ink,#e6edf3);cursor:pointer;padding:6px 9px;border-radius:5px;font:600 12.5px/1 inherit;font-family:inherit}' +
    '.vm-acts button:hover{color:var(--ink,#e6edf3);background:rgba(var(--border-tint,128,128,128),.12)}' +
    '.vm-acts button.vm-del:hover{color:var(--err,#f85149)}' +
    '.vm-edit textarea{display:block;width:100%;box-sizing:border-box;min-height:60px;margin:4px 0 6px;padding:8px 10px;font:inherit;font-size:14px;border-radius:6px;' +
      'border:1px solid rgba(var(--border-tint,128,128,128),.25);background:var(--bg,#0d1117);color:inherit;resize:vertical}' +
    '.vm-edit .vm-row{display:flex;gap:6px;justify-content:flex-end;align-items:center}' +
    '.vm-edit .vm-row button{font:inherit;font-size:12.5px;font-weight:600;padding:5px 10px;border-radius:6px;cursor:pointer;border:1px solid rgba(var(--border-tint,128,128,128),.25);background:none;color:inherit}' +
    '.vm-edit .vm-row .vm-save{background:var(--accent,#4493f8);border-color:var(--accent,#4493f8);color:#fff}' +
    '.vm-edit .vm-err,.vm-err{color:var(--err,#f85149);font-size:12px;margin-right:auto}' +
    '.vm-time{align-self:center;width:100%;text-align:center;font-size:11.5px;font-weight:600;color:var(--ink-dim,var(--fg-muted,#8b949e));margin:12px 0 4px}' +
    '.vm-time:first-child{margin-top:0}' +
    '.vm-acts{flex-wrap:wrap;max-width:min(270px,80vw)}' +
    '.vm-rx{display:flex;align-items:center;gap:2px;width:100%}' +
    '.vm-rx+button,.vm-rx~button{margin-top:2px}' +
    '.vm-acts .vm-r{font-size:19px;line-height:1;padding:6px 7px}' +
    '.vm-acts .vm-r.on{background:rgba(68,147,248,.18)}' +
    '.vm-acts .vm-plus{font-size:16px;padding:6px 8px}' +
    '.vm-custom{display:flex;gap:4px;width:100%;padding:2px}' +
    '.vm-custom input{width:84px;flex:1;min-width:0;font-size:18px;padding:4px 8px;border-radius:6px;border:1px solid rgba(var(--border-tint,128,128,128),.3);background:var(--bg,#0d1117);color:inherit}' +
    '.vm-reacts{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}' +
    '.vm-rc{display:inline-flex;align-items:center;gap:4px;font:600 12px/1 inherit;font-family:inherit;padding:3px 8px;border-radius:999px;cursor:pointer;' +
      'border:1px solid rgba(var(--border-tint,128,128,128),.28);background:rgba(var(--border-tint,128,128,128),.08);color:inherit}' +
    '.vm-rc .e{font-size:15px}' +
    '.vm-rc.on{border-color:var(--accent,#4493f8);background:rgba(68,147,248,.16)}';
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }

  // "3:41 pm", "Yesterday 3:41 pm", "Mon 3:41 pm", "12 Oct, 3:41 pm"
  function when(t){
    var d = new Date(t), now = new Date();
    var h = d.getHours(), time = (h % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (h < 12 ? 'am' : 'pm');   // always 12-hour
    var days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    if (days <= 0) return time;
    if (days === 1) return 'Yesterday ' + time;
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    var o = { day: 'numeric', month: 'short' }; if (d.getFullYear() !== now.getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString([], o) + ', ' + time;
  }
  var GAP = 10 * 60 * 1000;
  var QUICK = ['\uD83D\uDC4D', '\uD83D\uDC4E', '\u2764\uFE0F', '\uD83D\uDD25'];   // thumbs up, thumbs down, heart, fire
  // one emoji (with skin tone / joiners), nothing else
  function isEmoji(t){
    t = String(t || '').trim();
    if (!t || t.length > 16 || /[A-Za-z0-9\s<>&"'`\\/]/.test(t)) return false;
    try { return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(t); } catch (e) { return true; }
  }

  window.VoxMsg = {
    // time labels like a messaging app: one above the first message, then a new one only when a message comes
    // more than 10 minutes after the last label. Returns one string per message (mostly ''), to put before each bubble.
    times: function(list){
      var last = null;
      return (list || []).map(function(m){
        var t = m && m.created_at ? new Date(m.created_at).getTime() : Date.now();
        if (last !== null && t - last < GAP) return '';
        last = t;
        return '<div class="vm-time">' + esc(when(t)) + '</div>';
      });
    },
    // the little Edit / Delete buttons for one bubble (canEdit false: only Delete, e.g. a message that is only files)
    buttons: function(canEdit){
      return '<span class="vm-acts">' + (canEdit === false ? '' : '<button type="button" class="vm-edit-btn">' + ico('pencil') + 'Edit</button>') +
        '<button type="button" class="vm-del">' + ico('trash-2') + 'Delete</button></span>';
    },
    // no "(edited)" / "Message deleted" marks: an edited message just shows its new text, a deleted one is left out
    edited: function(){ return ''; },
    deleted: function(){ return ''; },
    busy: function(box){ return !!(box && box.querySelector('.vm-edit, .vm-custom')); },
    wire: function(box, opt){
      if (!box || box._vmWired) return; box._vmWired = true;
      // ---- reactions (opt.react(id, emoji) toggles one, opt.reactions() gives [{message_id, emoji, n, mine, names}]) ----
      var rx = {};   // message id -> [{emoji, n, mine, names}]
      function paint(){
        box.querySelectorAll('[data-mid]').forEach(function(el){
          var list = rx[el.getAttribute('data-mid')] || [];
          var cur = el.querySelector(':scope > .vm-reacts');
          if (!list.length){ if (cur) cur.remove(); return; }
          var html = list.map(function(r){
            return '<button type="button" class="vm-rc' + (r.mine ? ' on' : '') + '" data-emoji="' + esc(r.emoji) + '" title="' + esc((r.names || []).join(', ')) + '"><span class="e">' + esc(r.emoji) + '</span>' + (r.n > 1 ? r.n : '') + '</button>';
          }).join('');
          if (!cur){ cur = document.createElement('div'); cur.className = 'vm-reacts'; var acts = el.querySelector(':scope > .vm-acts'); el.insertBefore(cur, acts || null); }
          if (cur.innerHTML !== html) cur.innerHTML = html;
        });
      }
      function loadRx(){
        if (!opt.reactions) return Promise.resolve();
        return Promise.resolve(opt.reactions()).then(function(rows){
          var m = {}; (rows || []).forEach(function(r){ (m[r.message_id] = m[r.message_id] || []).push(r); });
          rx = m; paint();
        }, function(){});
      }
      function toggle(id, emoji){
        if (!isEmoji(emoji)) return;
        // show it straight away, then check with the server
        var list = rx[id] = rx[id] || [], r = list.filter(function(x){ return x.emoji === emoji; })[0];
        if (r){ r.n += r.mine ? -1 : 1; r.mine = !r.mine; if (r.n <= 0) list.splice(list.indexOf(r), 1); }
        else list.push({ emoji: emoji, n: 1, mine: true, names: [] });
        paint();
        Promise.resolve(opt.react(id, emoji)).then(loadRx, function(err){ loadRx(); alert((err && err.message) || 'Couldn’t react.'); });
      }
      if (opt.react){
        box._vmPaint = paint;
        new MutationObserver(paint).observe(box, { childList: true });
        loadRx();
        setInterval(function(){ if (!document.hidden) loadRx(); }, 6000);
        box.addEventListener('click', function(e){
          var c = e.target.closest && e.target.closest('.vm-rc');
          if (!c || !box.contains(c)) return;
          e.preventDefault(); e.stopPropagation();
          toggle(c.closest('[data-mid]').getAttribute('data-mid'), c.getAttribute('data-emoji'));
        });
      }
      // the emoji row at the top of the hold menu (every message can be reacted to, so every bubble gets a menu)
      function menuFor(el){
        var acts = el.querySelector(':scope > .vm-acts');
        if (!acts){ acts = document.createElement('span'); acts.className = 'vm-acts'; el.appendChild(acts); }
        if (opt.react && !acts.querySelector('.vm-rx')){
          var row = document.createElement('span'); row.className = 'vm-rx';
          var mine = (rx[el.getAttribute('data-mid')] || []).filter(function(r){ return r.mine; }).map(function(r){ return r.emoji; });
          row.innerHTML = QUICK.map(function(q){ return '<button type="button" class="vm-r' + (mine.indexOf(q) > -1 ? ' on' : '') + '" data-emoji="' + q + '">' + q + '</button>'; }).join('') +
            '<button type="button" class="vm-plus" aria-label="Other emoji" title="Other emoji">' + ico('plus') + '</button>';
          acts.insertBefore(row, acts.firstChild);
        }
        return acts;
      }
      // keep the menu inside the chat: a short bubble on the left would push it off the edge (and get cut off)
      function fit(acts, el){
        acts.style.transform = ''; el.classList.add('vm-open');
        var r = acts.getBoundingClientRect(), b = box.getBoundingClientRect();
        var lo = Math.max(b.left, 0) + 4, hi = Math.min(b.right, window.innerWidth) - 4, dx = 0;
        if (r.left < lo) dx = lo - r.left; else if (r.right > hi) dx = hi - r.right;
        if (dx) acts.style.transform = 'translateX(' + Math.round(dx) + 'px)';
      }
      box.addEventListener('click', function(e){
        var rb = e.target.closest && e.target.closest('.vm-acts .vm-r, .vm-acts .vm-plus, .vm-custom button');
        if (rb && box.contains(rb)){
          e.preventDefault(); e.stopPropagation();
          var bubble = rb.closest('[data-mid]'), mid = bubble.getAttribute('data-mid');
          if (rb.classList.contains('vm-r')){ bubble.classList.remove('vm-open'); toggle(mid, rb.getAttribute('data-emoji')); return; }
          if (rb.classList.contains('vm-plus')){
            var row = rb.closest('.vm-rx'), f = document.createElement('span'); f.className = 'vm-custom';
            f.innerHTML = '<input type="text" maxlength="16" placeholder="Emoji" aria-label="Emoji" enterkeyhint="done"><button type="button" class="vm-ok">Add</button>';
            row.replaceWith(f);
            var inp = f.querySelector('input'); inp.focus();
            inp.addEventListener('keydown', function(k){ if (k.key === 'Enter'){ k.preventDefault(); f.querySelector('.vm-ok').click(); } });
            return;
          }
          if (rb.classList.contains('vm-ok')){
            var v = rb.parentNode.querySelector('input').value.trim();
            if (!isEmoji(v)){ rb.parentNode.querySelector('input').value = ''; rb.parentNode.querySelector('input').placeholder = 'One emoji'; return; }
            bubble.classList.remove('vm-open'); rb.parentNode.remove(); toggle(mid, v); return;
          }
        }
      }, true);
      box.addEventListener('click', function(e){
        var b = e.target.closest && e.target.closest('.vm-acts button, .vm-edit .vm-row button');
        if (!b || !box.contains(b)) return;
        var el = b.closest('[data-mid]'); if (!el) return;
        var id = el.getAttribute('data-mid');
        e.preventDefault(); e.stopPropagation();
        if (b.classList.contains('vm-edit-btn')){
          if (box.querySelector('.vm-edit')) return;
          el.classList.remove('vm-open');
          var txt = el.querySelector('.msg-text');
          var holder = document.createElement('div'); holder.className = 'vm-edit';
          holder.innerHTML = '<textarea maxlength="5000"></textarea><div class="vm-row"><span class="vm-err"></span><button type="button" class="vm-cancel">Cancel</button><button type="button" class="vm-save">Save</button></div>';
          holder.querySelector('textarea').value = opt.body(id) || '';
          if (txt){ txt.hidden = true; txt.parentNode.insertBefore(holder, txt.nextSibling); } else el.appendChild(holder);
          var ta = holder.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
          ta.addEventListener('keydown', function(k){ if (k.key === 'Escape') holder.querySelector('.vm-cancel').click(); if (k.key === 'Enter' && (k.metaKey || k.ctrlKey)) holder.querySelector('.vm-save').click(); });
          return;
        }
        if (b.classList.contains('vm-cancel')){
          var h = el.querySelector('.vm-edit'); if (h) h.remove();
          var t = el.querySelector('.msg-text'); if (t) t.hidden = false;
          if (opt.refresh) opt.refresh();
          return;
        }
        if (b.classList.contains('vm-save')){
          var hh = el.querySelector('.vm-edit'), val = hh.querySelector('textarea').value;
          b.disabled = true;
          opt.save(id, val).then(function(){ hh.remove(); if (opt.refresh) opt.refresh(); },
            function(err){ b.disabled = false; hh.querySelector('.vm-err').textContent = (err && err.message) || 'Couldn’t save.'; });
          return;
        }
        if (b.classList.contains('vm-del')){
          if (!confirm('Delete this message?')) return;
          b.disabled = true;
          opt.remove(id).then(function(){ if (opt.refresh) opt.refresh(); },
            function(err){ b.disabled = false; alert((err && err.message) || 'Couldn’t delete.'); });
        }
      });
      // hold a message down (about half a second) to show its buttons
      var timer = null, held = null, sx = 0, sy = 0, justOpened = false;
      function closeAll(except){ box.querySelectorAll('.vm-open').forEach(function(o){ if (o !== except) o.classList.remove('vm-open'); }); }
      function cancel(){ clearTimeout(timer); timer = null; if (held) held.classList.remove('vm-pressing'); held = null; }
      function holdable(el){ return !!(opt.react || el.querySelector('.vm-acts')); }
      function mark(){ box.querySelectorAll('[data-mid]').forEach(function(el){ el.classList.toggle('vm-hold', holdable(el)); }); }
      mark(); new MutationObserver(mark).observe(box, { childList: true });
      box.addEventListener('pointerdown', function(e){
        if (e.button > 0 || (e.target.closest && e.target.closest('.vm-acts,.vm-edit,a,button,textarea,input,video'))) return;
        var el = e.target.closest && e.target.closest('[data-mid]'); if (!el || !holdable(el) || el.querySelector('.vm-edit')) return;
        cancel(); held = el; sx = e.clientX; sy = e.clientY; el.classList.add('vm-pressing');
        timer = setTimeout(function(){
          var h = held; cancel(); if (!h) return;
          closeAll(h); fit(menuFor(h), h); justOpened = true;
          if (navigator.vibrate) try { navigator.vibrate(15); } catch (er) {}
        }, 450);
      });
      box.addEventListener('pointermove', function(e){ if (held && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel(); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(t){ box.addEventListener(t, cancel); });
      // phones: a long press can also raise the browser's own menu; use ours instead
      box.addEventListener('contextmenu', function(e){ var el = e.target.closest && e.target.closest('[data-mid]'); if (el && holdable(el)) e.preventDefault(); });
      // the click that ends the hold shouldn't close the buttons again; any other click outside them does
      document.addEventListener('click', function(e){
        if (justOpened){ justOpened = false; return; }
        if (!(e.target.closest && e.target.closest('.vm-acts,.vm-custom'))) closeAll(null);
      }, true);
    },
    esc: esc
  };
})();
