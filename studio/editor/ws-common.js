// Piezas compartidas por los espacios de trabajo (Diálogos, Rutas, Música, Menús, Proyecto)
import { icon } from './components.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const baseName = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');
export const slug = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');

// Un archivo de texto abierto, con su propio historial (Ctrl+Z / Ctrl+Y) y su estado guardado
export function fileDoc(path, text) {
  const d = {
    path, text, saved: text, undo: [], redo: [],
    get dirty() { return d.text !== d.saved; },
    // newStep = true: empieza un paso nuevo de deshacer; false: sigue el mismo (ej. mientras se escribe)
    set(t, newStep = true) {
      if (t === d.text) return false;
      if (newStep || !d.undo.length) { d.undo.push(d.text); if (d.undo.length > 300) d.undo.shift(); }
      d.text = t; d.redo.length = 0;
      return true;
    },
    undoOne() { if (!d.undo.length) return false; d.redo.push(d.text); d.text = d.undo.pop(); return true; },
    redoOne() { if (!d.redo.length) return false; d.undo.push(d.text); d.text = d.redo.pop(); return true; },
  };
  return d;
}

// Columna izquierda con buscador y lista (como el panel de archivos de cualquier motor)
export function listPane(el, { title, addLabel, onAdd, onSelect, empty = 'No hay nada todavía.' }) {
  el.classList.add('panel', 'wl');
  el.innerHTML = `<div class="ph"><h2>${esc(title)}</h2>${addLabel ? `<button class="ib sm" data-add title="${esc(addLabel)}">${icon('plus')}</button>` : ''}</div>
    <div class="search"><span class="si">${icon('search', { size: 14 })}</span><input placeholder="Buscar" spellcheck="false"></div>
    <div class="wl-list"></div>`;
  const list = el.querySelector('.wl-list'), q = el.querySelector('input');
  let items = [], sel = null;
  function render() {
    const f = q.value.trim().toLowerCase();
    const shown = items.filter((it) => !f || `${it.label} ${it.sub ?? ''}`.toLowerCase().includes(f));
    list.innerHTML = shown.length ? shown.map((it) => `<div class="wl-item${it.id === sel ? ' sel' : ''}" data-id="${esc(it.id)}">
        <span class="badge" style="background:${it.color ?? '#3d6df2'}1a;color:${it.color ?? '#3d6df2'}">${icon(it.icon ?? 'file', { size: 14 })}</span>
        <span class="tx"><b>${esc(it.label)}${it.dirty ? ' <i class="dd"></i>' : ''}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
        ${it.warn ? `<span class="wv" title="${esc(it.warn)}">${icon('warn', { size: 14 })}</span>` : ''}</div>`).join('')
      : `<div class="empty">${f ? 'Nada coincide.' : esc(empty)}</div>`;
  }
  list.addEventListener('click', (e) => { const it = e.target.closest('.wl-item'); if (it) onSelect?.(it.dataset.id); });
  q.addEventListener('input', render);
  el.querySelector('[data-add]')?.addEventListener('click', () => onAdd?.());
  return { set(next, selected) { items = next; sel = selected; render(); } };
}

// Campo de formulario con etiqueta (mismo aspecto que el inspector)
export const fieldRow = (label, ctl, hint = '') => `<div class="f"><label title="${esc(label)}">${esc(label)}</label><div class="ctl">${ctl}</div></div>${hint ? `<p class="help sm">${hint}</p>` : ''}`;
export const options = (list, cur, empty) => `${empty !== undefined ? `<option value="">${esc(empty)}</option>` : ''}${cur && !list.some((o) => (Array.isArray(o) ? o[0] : o) === cur) ? `<option value="${esc(cur)}">${esc(cur)} (no encontrado)</option>` : ''}${list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`; }).join('')}`;
