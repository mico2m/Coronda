// Panel "Escena": árbol de entidades (como la jerarquía de Unity / el árbol de escena de Godot)
import { kindOf, KIND, icon, TEMPLATES } from './components.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createHierarchy(app) {
  const tree = document.getElementById('tree');
  const filter = document.getElementById('hFilter');
  const addBtn = document.getElementById('bAdd');
  const addMenu = document.getElementById('addMenu');
  const convertBox = document.getElementById('convert');
  const collapsed = new Set();
  let renaming = null;

  addBtn.innerHTML = icon('plus');
  document.querySelector('#left .search .si').innerHTML = icon('search', { size: 14 });
  addMenu.innerHTML = `<div class="mh">Agregar</div>${TEMPLATES.map((t) =>
    `<button data-t="${t.id}">${icon(t.icon, { color: KIND[t.id === 'colbox' || t.id === 'colcyl' ? 'collider' : t.id]?.color ?? 'currentColor' })}${t.label}</button>`).join('')}
    <hr><div class="mh">Modelos</div><button data-t="asset">${icon('cube')}Desde Assets… <small>arrastrar</small></button>`;
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); app.toggleMenu(addMenu); });
  addMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]'); if (!b) return;
    app.closeMenus();
    if (b.dataset.t === 'asset') { app.toast('Arrastrá un modelo desde el panel Assets al visor'); return; }
    const t = TEMPLATES.find((x) => x.id === b.dataset.t);
    const sel = app.selected;
    app.addEntity(t.make(), { at: app.viewport.centerPoint(), parent: null, select: true, label: `Agregar ${t.label}` });
    void sel;
  });

  filter.addEventListener('input', render);

  function rows() {
    const ents = app.doc.entities ?? [];
    const ids = new Set(ents.map((e) => e.id));
    const kids = new Map();
    for (const e of ents) {
      const p = e.parent && ids.has(e.parent) ? e.parent : null;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(e);
    }
    const q = filter.value.trim().toLowerCase();
    let show = null;
    if (q) { // coincidencias + sus padres
      show = new Set();
      const byId = new Map(ents.map((e) => [e.id, e]));
      for (const e of ents) if (e.name.toLowerCase().includes(q)) for (let x = e; x; x = byId.get(x.parent)) show.add(x.id);
    }
    const out = [];
    (function walk(parent, depth) {
      for (const e of kids.get(parent) ?? []) {
        if (show && !show.has(e.id)) continue;
        const has = (kids.get(e.id) ?? []).length > 0;
        out.push({ e, depth, has });
        if (has && (q || !collapsed.has(e.id))) walk(e.id, depth + 1);
      }
    })(null, 0);
    return out;
  }

  function render() {
    const doc = app.doc;
    // escena todavía armada desde un .glb de Blender: ofrecer convertirla
    const rooms = (doc.rooms ?? []).filter((r) => r.model);
    convertBox.hidden = !rooms.length;
    if (rooms.length) {
      convertBox.innerHTML = `Esta escena todavía se arma desde <b>${esc(rooms.map((r) => r.model.split('/').pop()).join(', '))}</b>: sus objetos no se pueden mover acá.
        <br><button type="button" id="bConvert">Convertir en entidades editables</button>`;
      convertBox.querySelector('#bConvert').onclick = () => app.convertRooms();
    }
    const list = rows();
    if (!(doc.entities ?? []).length) {
      tree.innerHTML = `<div class="empty"><b>La escena está vacía</b>Arrastrá un modelo desde Assets o usá el botón ${icon('plus', { size: 12 }).replace('class="ic"', 'class="ic" style="display:inline;vertical-align:-2px"')} de arriba.</div>`;
      return;
    }
    if (!list.length) { tree.innerHTML = `<div class="empty">Nada coincide con “${esc(filter.value)}”.</div>`; return; }
    tree.innerHTML = list.map(({ e, depth, has }) => {
      const k = KIND[kindOf(e)];
      const hid = app.editorHidden.has(e.id);
      return `<div class="row${e.id === app.selected ? ' sel' : ''}${hid ? ' hiddenE' : ''}" data-id="${e.id}" draggable="true" style="padding-left:${6 + depth * 16}px">
        <span class="tw${has && !collapsed.has(e.id) ? ' open' : ''}">${has ? icon('chevron', { size: 12, stroke: 1.8 }) : ''}</span>
        <span class="badge" style="background:${k.color}1a;color:${k.color}">${icon(k.icon, { size: 14 })}</span>
        <span class="nm">${renaming === e.id ? `<input value="${esc(e.name)}" spellcheck="false">` : esc(e.name)}</span>
        ${e.hidden ? `<span class="meta" title="No se dibuja en el juego">oculto</span>` : ''}
        <button class="eye" title="${hid ? 'Mostrar en el editor' : 'Ocultar en el editor (el juego no cambia)'}">${icon(hid ? 'eyeOff' : 'eye', { size: 14 })}</button>
      </div>`;
    }).join('');
    const inp = tree.querySelector('.nm input');
    if (inp) {
      inp.focus(); inp.select();
      const done = (ok) => {
        if (renaming === null) return;
        const id = renaming; renaming = null;
        if (ok && inp.value.trim()) app.rename(id, inp.value.trim()); else render();
      };
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); ev.stopPropagation(); });
      inp.addEventListener('blur', () => done(true));
    }
    tree.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
  }

  tree.addEventListener('click', (ev) => {
    const row = ev.target.closest('.row');
    if (!row) { if (ev.target === tree) app.select(null); return; }
    const id = row.dataset.id;
    if (ev.target.closest('.eye')) { app.toggleEditorHidden(id); return; }
    if (ev.target.closest('.tw') && row.querySelector('.tw svg')) {
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); render(); return;
    }
    if (ev.target.closest('input')) return;
    app.select(id);
  });
  tree.addEventListener('dblclick', (ev) => {
    const row = ev.target.closest('.row');
    if (!row || ev.target.closest('.eye') || ev.target.closest('.tw')) return;
    if (ev.target.closest('.badge')) { app.viewport.focus(row.dataset.id); return; }
    startRename(row.dataset.id);
  });
  tree.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.row'); if (!row) return;
    ev.preventDefault();
    app.select(row.dataset.id);
    app.contextMenu(ev.clientX, ev.clientY, [
      ['Renombrar', 'F2', () => startRename(row.dataset.id)],
      ['Duplicar', 'Ctrl+D', () => app.duplicate(row.dataset.id)],
      ['Enfocar', 'F', () => app.viewport.focus(row.dataset.id)],
      app.entity(row.dataset.id)?.parent ? ['Sacar del padre', '', () => app.reparent(row.dataset.id, null)] : null,
      '-',
      ['Borrar', 'Supr', () => app.remove(row.dataset.id), 'danger'],
    ]);
  });

  // Arrastrar una fila sobre otra = hacerla hija; sobre el fondo = sacarla del padre
  let dragId = null;
  tree.addEventListener('dragstart', (ev) => {
    const row = ev.target.closest('.row'); if (!row) return;
    dragId = row.dataset.id;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', dragId);
  });
  tree.addEventListener('dragover', (ev) => {
    if (!dragId) return;
    ev.preventDefault();
    tree.querySelectorAll('.row.drop').forEach((r) => r.classList.remove('drop'));
    const row = ev.target.closest('.row');
    if (row && row.dataset.id !== dragId) row.classList.add('drop');
    tree.classList.toggle('droproot', !row);
  });
  tree.addEventListener('dragleave', (ev) => { if (!tree.contains(ev.relatedTarget)) { tree.classList.remove('droproot'); tree.querySelectorAll('.row.drop').forEach((r) => r.classList.remove('drop')); } });
  tree.addEventListener('drop', (ev) => {
    if (!dragId) return;
    ev.preventDefault();
    const row = ev.target.closest('.row');
    const target = row ? row.dataset.id : null;
    tree.classList.remove('droproot');
    const id = dragId; dragId = null;
    if (target === id) return;
    app.reparent(id, target);
  });
  tree.addEventListener('dragend', () => { dragId = null; tree.classList.remove('droproot'); render(); });

  function startRename(id) { renaming = id; render(); }

  return { render, startRename };
}
