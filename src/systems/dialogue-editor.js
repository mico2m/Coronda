// Editor de diálogos por nodos (solo dev.html). Botón "Diálogos" arriba a la izquierda.
//
// - Cada cuadro es un nodo de data/dialogues/<nombre>.json: arrastrá desde el círculo de una salida
//   hasta otro nodo para conectarlos; soltando en el vacío se crea un nodo nuevo ahí; un clic en el
//   círculo desconecta. Rueda = zoom, arrastrar el fondo = mover la vista.
// - Textos: un clic en el texto de un nodo abre una caja grande para escribir. {animación} sale de otro color, un salto de línea
//   se marca con ↵ y una línea en blanco (otra página) con ¶; escribir \n también hace un salto de línea.
//   Una línea en blanco separa las páginas. Condiciones y flags en una línea: "hablo_tokse, !tiene_espada, veces_tokse>=3".
// - En Chrome/Edge: "Carpeta" te deja elegir data/dialogues una vez (el navegador se acuerda) y "Guardar" escribe
//   directo en el archivo. En otros navegadores: "Abrir…" y "Guardar" (descarga el .json para copiarlo a la carpeta).
// El formato del JSON y el significado de cada campo están en systems/dialogue.js; el modelo, en dialogue-doc.js.
import { forgetJSON } from '../core/assets.js';
import { emptyDoc, fromJSON, toJSON, layout, needsLayout, addNode, removeNode, renameNode, cleanId, problems, highlightText } from './dialogue-doc.js';

const DIR = 'data/dialogues/';
const SVGNS = 'http://www.w3.org/2000/svg';
const JSON_TYPES = [{ description: 'Diálogo (JSON)', accept: { 'application/json': ['.json'] } }];
const hasDirPicker = () => typeof window.showDirectoryPicker === 'function';

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}
function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}
const curve = (a, b) => { const d = Math.max(40, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + d},${a.y} ${b.x - d},${b.y} ${b.x},${b.y}`; };

// Guardar la carpeta elegida entre sesiones (IndexedDB)
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('coronda-dev', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const kvGet = async (k) => { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } };
const kvSet = async (k, v) => { try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch { /* sin permiso: no se recuerda */ } };

export function createDialogueEditor({ host = document.querySelector('.app') ?? document.body } = {}) {
  let doc = null;
  let dirty = false;
  let dirHandle = null;
  let fileHandle = null;
  const view = { x: 30, y: 30, k: 1 };
  let ports = [];          // salidas dibujadas: { el, get(), set(v) }
  let nodeEls = new Map(); // id -> elemento

  // ---------- Estructura ----------
  const toggle = el('button', 'de-toggle', host, 'Diálogos');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');

  const root = el('div', 'de', host);
  root.hidden = true;
  root.tabIndex = -1;
  // El editor tapa el juego: que ninguna tecla, clic o rueda llegue a la cámara o al personaje
  for (const t of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'wheel', 'contextmenu', 'click', 'dblclick']) {
    root.addEventListener(t, (e) => e.stopPropagation());
  }

  const bar = el('div', 'de-bar', root);
  const btn = (label, fn, title) => { const b = el('button', 'de-btn', bar, label); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); return b; };
  el('strong', 'de-title', bar, 'Diálogos');
  const fileSel = el('select', 'de-file', bar);
  fileSel.title = 'Archivos de la carpeta elegida';
  const bDir = btn('Carpeta', () => pickDir(), 'Elegí la carpeta data/dialogues de tu proyecto (Chrome / Edge)');
  btn('Abrir…', () => openFile());
  btn('Nuevo', () => newDoc());
  const bSave = btn('Guardar', () => save());
  btn('Guardar como…', () => saveAs());
  btn('+ Nodo', () => { if (!doc) return; const c = viewCenter(); addNode(doc, c.x - 140, c.y - 60); changed(); render(); });
  btn('Ordenar', () => { if (!doc) return; layout(doc); changed(); render(); }, 'Acomoda los nodos en columnas');
  const status = el('span', 'de-status', bar);
  const spacer = el('span', 'de-spacer', bar);
  btn('Cerrar', () => close());

  const canvas = el('div', 'de-canvas', root);
  const world = el('div', 'de-world', canvas);
  const svg = svgEl('svg', { class: 'de-links' }, world);
  const linkG = svgEl('g', {}, svg);
  const tmpLink = svgEl('path', { class: 'de-link tmp' }, svg);
  tmpLink.style.display = 'none';
  const nodesEl = el('div', 'de-nodes', world);
  const empty = el('div', 'de-empty', canvas);
  empty.innerHTML = '<p>Elegí con <b>Carpeta</b> la carpeta <code>data/dialogues</code> de tu proyecto,<br>o usá <b>Abrir…</b> / <b>Nuevo</b>.</p>';

  // ---------- Vista (mover y zoom) ----------
  const applyView = () => { world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`; };
  const toWorld = (cx, cy) => { const r = world.getBoundingClientRect(); return { x: (cx - r.left) / view.k, y: (cy - r.top) / view.k }; };
  const viewCenter = () => { const r = canvas.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); };
  const portPos = (e) => { const r = e.getBoundingClientRect(); const w = world.getBoundingClientRect(); return { x: (r.left + r.width / 2 - w.left) / view.k, y: (r.top + r.height / 2 - w.top) / view.k }; };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.de-node') || e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    canvas.classList.add('panning');
    const move = (ev) => { view.x = ox + ev.clientX - sx; view.y = oy + ev.clientY - sy; applyView(); };
    const up = () => { canvas.classList.remove('panning'); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k2 = Math.min(1.6, Math.max(0.3, view.k * Math.exp(-e.deltaY * 0.0015)));
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    view.x = mx - (mx - view.x) * (k2 / view.k);
    view.y = my - (my - view.y) * (k2 / view.k);
    view.k = k2;
    applyView();
  }, { passive: false });

  // ---------- Estado ----------
  function setStatus(msg, isError = false) { status.textContent = msg; status.classList.toggle('err', isError); }
  function updateStatus() {
    if (!doc) { setStatus(''); return; }
    const pr = problems(doc);
    status.classList.toggle('err', pr.length > 0);
    status.title = pr.join('\n');
    const name = `${doc.name}.json${dirty ? ' •' : ''}`;
    status.textContent = pr.length ? `${name} · ⚠ ${pr.length} aviso${pr.length > 1 ? 's' : ''} (pasá el mouse)` : name;
  }
  function changed() { dirty = true; updateStatus(); }
  const confirmDiscard = () => !dirty || confirm('Hay cambios sin guardar en este diálogo. ¿Descartarlos?');

  // ---------- Dibujo ----------
  function render() {
    nodesEl.replaceChildren();
    ports = [];
    nodeEls = new Map();
    empty.hidden = !!doc;
    if (!doc) { linkG.replaceChildren(); return; }
    nodesEl.append(buildStart());
    for (const id of Object.keys(doc.nodes)) nodesEl.append(buildNode(id));
    updateStatus();
    requestAnimationFrame(drawLinks);
  }

  function drawLinks() {
    linkG.replaceChildren();
    for (const p of ports) {
      const t = p.get();
      p.el.classList.toggle('on', !!t);
      if (!t) continue;
      const a = portPos(p.el);
      const target = nodeEls.get(t);
      if (target) svgEl('path', { class: 'de-link', d: curve(a, portPos(target.querySelector('.de-in'))) }, linkG);
      else svgEl('path', { class: 'de-link broken', d: `M${a.x},${a.y} l 50,0` }, linkG);
    }
  }
  const redraw = () => requestAnimationFrame(drawLinks);

  function makePort(parent, get, set) {
    const e = el('span', 'de-port', parent);
    e.title = 'Arrastrá hasta un nodo para conectar (soltá en el vacío para crear uno nuevo). Clic: desconectar.';
    const port = { el: e, get, set };
    ports.push(port);
    e.addEventListener('pointerdown', (ev) => startLink(ev, port));
    return e;
  }

  function startLink(ev, port) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const e = port.el;
    e.setPointerCapture(ev.pointerId);
    const sx = ev.clientX, sy = ev.clientY;
    const from = portPos(e);
    let moved = false;
    const move = (m) => {
      if (Math.hypot(m.clientX - sx, m.clientY - sy) > 5) moved = true;
      if (!moved) return;
      tmpLink.style.display = '';
      tmpLink.setAttribute('d', curve(from, toWorld(m.clientX, m.clientY)));
    };
    const up = (u) => {
      e.removeEventListener('pointermove', move); e.removeEventListener('pointerup', up); e.removeEventListener('pointercancel', cancel);
      tmpLink.style.display = 'none';
      if (!moved) { if (port.get()) { port.set(''); changed(); render(); } return; }
      const hit = document.elementFromPoint(u.clientX, u.clientY)?.closest('.de-node');
      if (hit) {
        if (hit.dataset.id) { port.set(hit.dataset.id); changed(); render(); }
      } else {
        const p = toWorld(u.clientX, u.clientY);
        port.set(addNode(doc, p.x, p.y - 20));
        changed(); render();
      }
    };
    const cancel = () => { e.removeEventListener('pointermove', move); e.removeEventListener('pointerup', up); e.removeEventListener('pointercancel', cancel); tmpLink.style.display = 'none'; };
    e.addEventListener('pointermove', move);
    e.addEventListener('pointerup', up);
    e.addEventListener('pointercancel', cancel);
  }

  function makeDraggable(head, nodeEl, pos) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('input,button,textarea,select')) return;
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
      const move = (m) => {
        pos.x = ox + (m.clientX - sx) / view.k;
        pos.y = oy + (m.clientY - sy) / view.k;
        nodeEl.style.left = `${pos.x}px`; nodeEl.style.top = `${pos.y}px`;
        drawLinks();
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); changed(); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  function field(parent, label, value, onInput, placeholder, tag = 'input') {
    const row = el('label', 'de-field', parent);
    el('span', '', row, label);
    const i = el(tag, '', row);
    i.value = value;
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }

  function buildStart() {
    const node = el('div', 'de-node de-startnode');
    node.dataset.id = '';
    node.style.left = `${doc.startPos.x}px`; node.style.top = `${doc.startPos.y}px`;
    node.style.width = '300px';
    const head = el('div', 'de-head', node);
    el('span', 'de-badge', head, 'INICIO');
    makeDraggable(head, node, doc.startPos);
    const body = el('div', 'de-body', node);
    field(body, 'Nombre', doc.speaker, (v) => { doc.speaker = v; changed(); }, 'quién habla (opcional)');
    el('p', 'de-hint', body, 'Al hablarle gana la primera regla cuya condición se cumple. Una sin condición vale siempre.');
    doc.start.forEach((r, i) => {
      const row = el('div', 'de-rule', body);
      const ci = el('input', '', row);
      ci.value = r.if; ci.placeholder = 'siempre';
      ci.title = 'Condición, por ejemplo: hablo_tokse, !tiene_espada, veces_tokse>=3';
      ci.addEventListener('input', () => { r.if = ci.value; changed(); });
      const up = el('button', 'de-mini', row, '↑'); up.type = 'button'; up.title = 'Subir (se evalúa antes)'; up.disabled = i === 0;
      up.addEventListener('click', () => { [doc.start[i - 1], doc.start[i]] = [doc.start[i], doc.start[i - 1]]; changed(); render(); });
      const del = el('button', 'de-mini', row, '×'); del.type = 'button'; del.title = 'Quitar regla';
      del.addEventListener('click', () => { doc.start.splice(i, 1); changed(); render(); });
      makePort(row, () => r.goto, (v) => { r.goto = v; });
    });
    const add = el('button', 'de-add', body, '+ regla'); add.type = 'button';
    add.addEventListener('click', () => { doc.start.splice(Math.max(0, doc.start.length - 1), 0, { if: '', goto: '' }); changed(); render(); });
    return node;
  }

  function buildNode(id) {
    const n = doc.nodes[id];
    const node = el('div', 'de-node');
    node.dataset.id = id;
    node.style.left = `${n.x}px`; node.style.top = `${n.y}px`;
    nodeEls.set(id, node);

    const head = el('div', 'de-head', node);
    el('span', 'de-in', head);
    const idIn = el('input', 'de-id', head);
    idIn.value = id; idIn.title = 'Nombre del nodo (lo que usan "next" y las opciones)'; idIn.spellcheck = false;
    idIn.addEventListener('change', () => {
      const neu = cleanId(idIn.value);
      if (neu && neu !== id && renameNode(doc, id, neu)) { changed(); render(); } else { idIn.value = id; if (neu && neu !== id) setStatus(`Ya existe un nodo "${neu}".`, true); }
    });
    const del = el('button', 'de-mini', head, '×'); del.type = 'button'; del.title = 'Borrar nodo';
    del.addEventListener('click', () => { if (confirm(`¿Borrar el nodo "${id}"?`)) { removeNode(doc, id); changed(); render(); } });
    makeDraggable(head, node, n);

    const body = el('div', 'de-body', node);
    const prev = el('div', 'de-preview', body);
    prev.tabIndex = 0;
    prev.setAttribute('role', 'button');
    prev.title = 'Clic para escribir el texto';
    if (n.text.trim()) prev.innerHTML = highlightText(n.text); // el texto va escapado dentro de highlightText
    else el('span', 'de-ph', prev, 'Clic para escribir lo que dice…');
    prev.addEventListener('click', () => openText(id));
    prev.addEventListener('keydown', (e) => { if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); openText(id); } });

    if (!n.choices.length) {
      const row = el('div', 'de-row', body);
      el('span', '', row, 'Al terminar, sigue en');
      makePort(row, () => n.next, (v) => { n.next = v; });
    }

    n.choices.forEach((c, i) => {
      const box = el('div', 'de-choice', body);
      const r1 = el('div', 'de-row', box);
      const ti = el('input', '', r1);
      ti.value = c.text; ti.placeholder = `Opción ${i + 1}`;
      ti.addEventListener('input', () => { c.text = ti.value; changed(); });
      makePort(r1, () => c.next, (v) => { c.next = v; });
      const r2 = el('div', 'de-row', box);
      const ci = el('input', 'de-cond', r2);
      ci.value = c.if; ci.placeholder = 'solo si… (opcional)';
      ci.title = 'La opción solo aparece si se cumple. Ej: tiene_espada, !hablo_tokse, veces_tokse>=2';
      ci.addEventListener('input', () => { c.if = ci.value; changed(); });
      const x = el('button', 'de-mini', r2, '×'); x.type = 'button'; x.title = 'Quitar opción';
      x.addEventListener('click', () => { n.choices.splice(i, 1); changed(); render(); });
    });
    const add = el('button', 'de-add', body, '+ opción'); add.type = 'button';
    add.addEventListener('click', () => { n.choices.push({ text: '', if: '', next: '', extra: {} }); changed(); render(); });

    const more = el('details', 'de-more', body);
    if (n.set || n.anim || n.speaker) more.open = true;
    el('summary', '', more, 'Más');
    field(more, 'Flags al llegar', n.set, (v) => { n.set = v; changed(); }, 'tiene_espada, !enojado, humor=alegre');
    field(more, 'Animación', n.anim, (v) => { n.anim = v; changed(); }, 'clip del NPC · - = idle');
    field(more, 'Nombre', n.speaker, (v) => { n.speaker = v; changed(); }, 'si cambia quién habla');
    return node;
  }

  // ---------- Caja grande para escribir ----------
  const modal = el('div', 'de-modal', root);
  modal.hidden = true;
  const mcard = el('div', 'de-modal-card', modal);
  const mhead = el('div', 'de-modal-head', mcard);
  const mtitle = el('strong', '', mhead);
  const mclose = el('button', 'de-btn', mhead, 'Listo');
  mclose.type = 'button';
  const mwrap = el('div', 'de-hl-wrap', mcard);
  const mpre = el('pre', 'de-hl', mwrap);
  mpre.setAttribute('aria-hidden', 'true');
  const mta = el('textarea', 'de-hl-input', mwrap);
  mta.spellcheck = true;
  mta.placeholder = 'Lo que dice. Una línea en blanco = otra página.';
  const mfoot = el('div', 'de-legend', mcard);
  mfoot.innerHTML = '<span class="hl-anim">{animación}</span> clip del NPC · <span class="hl-nl-demo">↵</span> salto de línea (también podés escribir \\n) · <span class="hl-page-demo">¶</span> otra página (línea en blanco)';
  const mcount = el('span', 'de-count', mfoot);
  let editing = null;

  function syncText() {
    mpre.innerHTML = highlightText(mta.value);
    mpre.scrollTop = mta.scrollTop;
    const pages = mta.value.split(/\n\s*\n/).filter((t) => t.trim()).length;
    mcount.textContent = pages ? `${pages} página${pages > 1 ? 's' : ''}` : '';
  }
  function openText(id) {
    if (!doc?.nodes[id]) return;
    editing = id;
    mtitle.textContent = `Texto de «${id}»`;
    mta.value = doc.nodes[id].text;
    modal.hidden = false;
    syncText();
    mta.focus();
    mta.setSelectionRange(mta.value.length, mta.value.length);
    mta.scrollTop = mta.scrollHeight;
  }
  function closeText() {
    if (modal.hidden) return;
    modal.hidden = true;
    editing = null;
    render();
  }
  mta.addEventListener('input', () => {
    // Escribir "\n" hace un salto de línea de verdad
    if (mta.value.includes('\\n')) {
      const pos = mta.selectionStart;
      const before = mta.value.slice(0, pos).replace(/\\n/g, '\n').length;
      mta.value = mta.value.replace(/\\n/g, '\n');
      mta.setSelectionRange(before, before);
    }
    if (editing && doc?.nodes[editing]) { doc.nodes[editing].text = mta.value; changed(); }
    syncText();
  });
  mta.addEventListener('scroll', () => { mpre.scrollTop = mta.scrollTop; });
  mclose.addEventListener('click', closeText);
  modal.addEventListener('pointerdown', (e) => { if (e.target === modal) closeText(); });
  modal.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); closeText(); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); e.stopPropagation(); save(); }
  });

  // ---------- Archivos ----------
  function load(data, name, fh) {
    doc = fromJSON(data, name);
    if (!Object.keys(doc.nodes).length) doc.nodes.inicio = emptyDoc(name).nodes.inicio;
    if (needsLayout(doc)) layout(doc);
    fileHandle = fh ?? null;
    modal.hidden = true;
    editing = null;
    dirty = false;
    view.x = 30; view.y = 30; view.k = 1; applyView();
    render();
  }

  async function refreshList() {
    fileSel.replaceChildren(new Option('— archivo —', ''));
    if (!dirHandle) return;
    const names = [];
    try { for await (const [name, h] of dirHandle.entries()) if (h.kind === 'file' && /\.json$/i.test(name)) names.push(name); } catch (err) { setStatus(`No se pudo leer la carpeta: ${err.message}`, true); return; }
    names.sort();
    for (const nm of names) fileSel.append(new Option(nm.replace(/\.json$/i, ''), nm));
    if (doc && names.includes(`${doc.name}.json`)) fileSel.value = `${doc.name}.json`;
  }

  async function readFile(fh) {
    const f = await fh.getFile();
    return { data: JSON.parse(await f.text()), name: f.name.replace(/\.json$/i, '') };
  }

  fileSel.addEventListener('change', async () => {
    const nm = fileSel.value;
    if (!nm) return;
    if (!confirmDiscard()) { fileSel.value = doc && dirHandle ? `${doc.name}.json` : ''; return; }
    try {
      const fh = await dirHandle.getFileHandle(nm);
      const { data, name } = await readFile(fh);
      load(data, name, fh);
    } catch (err) { setStatus(`No se pudo abrir ${nm}: ${err.message}`, true); }
  });

  async function pickDir() {
    if (!hasDirPicker()) { setStatus('Este navegador no puede abrir carpetas: usá Abrir… y Guardar (Chrome o Edge sí pueden).', true); return; }
    try {
      const stored = await kvGet('dir');
      let ok = false;
      if (stored && !dirHandle) { try { ok = (await stored.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { ok = false; } }
      if (ok) { dirHandle = stored; }
      else {
        dirHandle = await window.showDirectoryPicker({ id: 'coronda-dialogos', mode: 'readwrite', startIn: dirHandle ?? stored ?? 'documents' });
        kvSet('dir', dirHandle);
      }
      await refreshList();
      setStatus(`Carpeta: ${dirHandle.name}`);
    } catch (err) { if (err.name !== 'AbortError') setStatus(`Carpeta: ${err.message}`, true); }
  }

  async function openFile() {
    if (!confirmDiscard()) return;
    try {
      if (typeof window.showOpenFilePicker === 'function') {
        const [fh] = await window.showOpenFilePicker({ types: JSON_TYPES, id: 'coronda-dialogos' });
        const { data, name } = await readFile(fh);
        load(data, name, fh);
      } else {
        const inp = el('input'); inp.type = 'file'; inp.accept = '.json,application/json';
        inp.addEventListener('change', async () => {
          const f = inp.files?.[0];
          if (!f) return;
          try { load(JSON.parse(await f.text()), f.name.replace(/\.json$/i, ''), null); } catch (err) { setStatus(`No se pudo abrir: ${err.message}`, true); }
        });
        inp.click();
      }
    } catch (err) { if (err.name !== 'AbortError') setStatus(`No se pudo abrir: ${err.message}`, true); }
  }

  function newDoc() {
    if (!confirmDiscard()) return;
    const name = cleanId(prompt('Nombre del diálogo (se guarda como <nombre>.json; el mismo que va en npc_dialogo):', ''));
    if (!name) return;
    const d = emptyDoc(name);
    load(toJSON(d), name, null);
    changed();
  }

  const json = () => `${JSON.stringify(toJSON(doc), null, 2)}\n`;
  const download = (name, text) => {
    const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  async function write(fh) {
    const w = await fh.createWritable();
    await w.write(json());
    await w.close();
  }
  function saved(how) {
    forgetJSON(`${DIR}${doc.name}.json`); // el juego vuelve a leer el archivo la próxima vez que le hablen a un NPC
    dirty = false;
    updateStatus();
    status.textContent += ` · ${how} ${new Date().toLocaleTimeString()}`;
    refreshList();
  }

  async function save() {
    if (!doc) return;
    try {
      if (!fileHandle && dirHandle) fileHandle = await dirHandle.getFileHandle(`${doc.name}.json`, { create: true });
      if (fileHandle) { await write(fileHandle); saved('guardado'); return; }
      if (typeof window.showSaveFilePicker === 'function') { await saveAs(); return; }
      download(`${doc.name}.json`, json());
      saved('descargado: copialo a data/dialogues/');
    } catch (err) { if (err.name !== 'AbortError') setStatus(`No se pudo guardar: ${err.message}`, true); }
  }

  async function saveAs() {
    if (!doc) return;
    try {
      if (typeof window.showSaveFilePicker !== 'function') { download(`${doc.name}.json`, json()); saved('descargado: copialo a data/dialogues/'); return; }
      const fh = await window.showSaveFilePicker({ suggestedName: `${doc.name}.json`, types: JSON_TYPES, id: 'coronda-dialogos' });
      doc.name = fh.name.replace(/\.json$/i, '');
      fileHandle = fh;
      await write(fh);
      saved('guardado');
    } catch (err) { if (err.name !== 'AbortError') setStatus(`No se pudo guardar: ${err.message}`, true); }
  }

  // ---------- Abrir y cerrar ----------
  async function open() {
    root.hidden = false;
    toggle.setAttribute('aria-pressed', 'true');
    root.focus();
    applyView();
    if (!dirHandle && hasDirPicker()) {
      const stored = await kvGet('dir');
      try { if (stored && (await stored.queryPermission({ mode: 'readwrite' })) === 'granted') { dirHandle = stored; await refreshList(); } } catch { /* hay que tocar "Carpeta" */ }
    }
    if (!doc) setStatus(dirHandle ? `Carpeta: ${dirHandle.name}` : '');
  }
  function close() { root.hidden = true; toggle.setAttribute('aria-pressed', 'false'); }

  toggle.addEventListener('click', () => (root.hidden ? open() : close()));
  root.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { if (e.target.closest('input,textarea,select')) e.target.blur(); else close(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  return { open, close, get dirty() { return dirty; } };
}
