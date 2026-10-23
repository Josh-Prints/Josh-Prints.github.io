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
    '.vm-edit .vm-err,.vm-err{color:var(--err,#f85149);font-size:12px;margin-right:auto}';
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }

  window.VoxMsg = {
    // the little Edit / Delete buttons for one bubble (canEdit false: only Delete, e.g. a message that is only files)
    buttons: function(canEdit){
      return '<span class="vm-acts">' + (canEdit === false ? '' : '<button type="button" class="vm-edit-btn">' + ico('pencil') + 'Edit</button>') +
        '<button type="button" class="vm-del">' + ico('trash-2') + 'Delete</button></span>';
    },
    // no "(edited)" / "Message deleted" marks: an edited message just shows its new text, a deleted one is left out
    edited: function(){ return ''; },
    deleted: function(){ return ''; },
    busy: function(box){ return !!(box && box.querySelector('.vm-edit')); },
    wire: function(box, opt){
      if (!box || box._vmWired) return; box._vmWired = true;
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
      function mark(){ box.querySelectorAll('[data-mid]').forEach(function(el){ el.classList.toggle('vm-hold', !!el.querySelector('.vm-acts')); }); }
      mark(); new MutationObserver(mark).observe(box, { childList: true });
      box.addEventListener('pointerdown', function(e){
        if (e.button > 0 || (e.target.closest && e.target.closest('.vm-acts,.vm-edit,a,button,textarea,input,video'))) return;
        var el = e.target.closest && e.target.closest('[data-mid]'); if (!el || !el.querySelector('.vm-acts')) return;
        cancel(); held = el; sx = e.clientX; sy = e.clientY; el.classList.add('vm-pressing');
        timer = setTimeout(function(){
          var h = held; cancel(); if (!h) return;
          closeAll(h); h.classList.add('vm-open'); justOpened = true;
          if (navigator.vibrate) try { navigator.vibrate(15); } catch (er) {}
        }, 450);
      });
      box.addEventListener('pointermove', function(e){ if (held && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) cancel(); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(t){ box.addEventListener(t, cancel); });
      // phones: a long press can also raise the browser's own menu; use ours instead
      box.addEventListener('contextmenu', function(e){ var el = e.target.closest && e.target.closest('[data-mid]'); if (el && el.querySelector('.vm-acts')) e.preventDefault(); });
      // the click that ends the hold shouldn't close the buttons again; any other click outside them does
      document.addEventListener('click', function(e){
        if (justOpened){ justOpened = false; return; }
        if (!(e.target.closest && e.target.closest('.vm-acts'))) closeAll(null);
      }, true);
    },
    esc: esc
  };
})();
