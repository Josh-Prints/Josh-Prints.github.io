/* Edit / delete for chat messages (order page, admin order chat, admin team chat).
   A page renders each bubble with data-mid="<id>" and, where the viewer may change it, VoxMsg.buttons() inside it and its
   text in an element with class "msg-text". Then VoxMsg.wire(container, { body(id), save(id, text), remove(id) }) handles
   the clicks: Edit swaps the text for a box with Save / Cancel, Delete asks once. save / remove return a Promise.
   VoxMsg.busy(container) is true while a message is being edited, so polling pages can hold off re-rendering it.
   The server decides who may change what (edit_order_message / delete_order_message / edit_admin_message / delete_admin_message). */
(function(){
  var ico = function(n){ return '<svg class="ico" width="1em" height="1em" aria-hidden="true"><use href="/icons.svg#' + n + '"/></svg>'; };
  var css =
    '[data-mid]{position:relative}' +
    '.vm-acts{display:none;position:absolute;top:4px;right:4px;gap:2px;background:var(--bg-raised,var(--bg,#161b22));border:1px solid rgba(var(--border-tint,128,128,128),.18);border-radius:6px;padding:2px;z-index:2}' +
    '[data-mid]:hover>.vm-acts,[data-mid]:focus-within>.vm-acts,[data-mid].vm-open>.vm-acts{display:flex}' +
    '.vm-acts button{background:none;border:0;color:var(--ink-dim,#8b949e);cursor:pointer;padding:4px 6px;border-radius:4px;font-size:13px;line-height:1}' +
    '.vm-acts button:hover{color:var(--ink,#e6edf3);background:rgba(var(--border-tint,128,128,128),.12)}' +
    '.vm-acts button.vm-del:hover{color:var(--err,#f85149)}' +
    '.vm-edited{font-size:10.5px;color:var(--ink-dim,#8b949e);margin-left:4px}' +
    '.vm-deleted{font-style:italic;color:var(--ink-dim,#8b949e);font-size:13px}' +
    '.vm-edit textarea{display:block;width:100%;box-sizing:border-box;min-height:60px;margin:4px 0 6px;padding:8px 10px;font:inherit;font-size:14px;border-radius:6px;' +
      'border:1px solid rgba(var(--border-tint,128,128,128),.25);background:var(--bg,#0d1117);color:inherit;resize:vertical}' +
    '.vm-edit .vm-row{display:flex;gap:6px;justify-content:flex-end;align-items:center}' +
    '.vm-edit .vm-row button{font:inherit;font-size:12.5px;font-weight:600;padding:5px 10px;border-radius:6px;cursor:pointer;border:1px solid rgba(var(--border-tint,128,128,128),.25);background:none;color:inherit}' +
    '.vm-edit .vm-row .vm-save{background:var(--accent,#4493f8);border-color:var(--accent,#4493f8);color:#fff}' +
    '.vm-edit .vm-err,.vm-err{color:var(--err,#f85149);font-size:12px;margin-right:auto}' +
    '@media (hover:none){.vm-acts{display:flex;position:static;width:max-content;margin:6px 0 0 auto;background:none;border:0;padding:0}}';
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }

  window.VoxMsg = {
    // the little Edit / Delete buttons for one bubble (canEdit false: only Delete, e.g. a message that is only files)
    buttons: function(canEdit){
      return '<span class="vm-acts">' + (canEdit === false ? '' : '<button type="button" class="vm-edit-btn" title="Edit" aria-label="Edit message">' + ico('pencil') + '</button>') +
        '<button type="button" class="vm-del" title="Delete" aria-label="Delete message">' + ico('trash-2') + '</button></span>';
    },
    edited: function(m){ return m && m.edited_at ? '<span class="vm-edited">(edited)</span>' : ''; },
    deleted: function(){ return '<div class="vm-deleted">Message deleted</div>'; },
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
      // touch: a tap on the bubble shows its buttons
      box.addEventListener('click', function(e){
        if (e.target.closest && (e.target.closest('a,button,textarea,img,video'))) return;
        var el = e.target.closest && e.target.closest('[data-mid]'); if (!el || !el.querySelector('.vm-acts')) return;
        box.querySelectorAll('.vm-open').forEach(function(o){ if (o !== el) o.classList.remove('vm-open'); });
        el.classList.toggle('vm-open');
      });
    },
    esc: esc
  };
})();
