// Editor de diálogos por nodos. Vive en el Studio (studio/studio.html), NO en el juego.
//
// - Cada cuadro es un nodo de data/dialogues/<nombre>.json: arrastrá desde el círculo de una salida hasta otro nodo
//   para conectarlos; soltando en el vacío se crea un nodo nuevo ahí; un clic en el círculo desconecta.
//   Rueda = zoom, arrastrar el fondo = mover la vista.
// - Un clic en el texto de un nodo abre una caja grande para escribir. {animación} sale de otro color, un salto de línea
//   se marca con ↵ y una línea en blanco (otra página) con ¶; escribir \n también hace un salto de línea.
//   Condiciones y flags en una línea: "hablo_tokse, !tiene_espada, veces_tokse>=3".
// - No toca archivos: el Studio le pasa el texto del JSON con load() y recibe el texto nuevo en onChange(texto, pasoNuevo).
//   Guardar, deshacer y rehacer los resuelve el Studio (el historial es el mismo del modo Código).
// El formato del JSON y el significado de cada campo están en src/systems/dialogue.js; el modelo, en dialogue-doc.js.
import { emptyDoc, fromJSON, toJSON, layout, needsLayout, addNode, removeNode, renameNode, cleanId, problems, highlightText } from './dialogue-doc.js';

const SVGNS = 'http://www.w3.org/2000/svg';

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

// clips(): { npc, clips: [{ name, kind, duration }] } con las animaciones reales del NPC que usa este diálogo (lo da el Studio)
export function createNodeEditor(root, { onChange = () => {}, onUndo = () => {}, onRedo = () => {}, clips = () => ({ npc: null, clips: [] }) } = {}) {
  let doc = null;
  const view = { x: 30, y: 30, k: 1 };
  let ports = [];          // salidas dibujadas: { el, get(), set(v) }
  let nodeEls = new Map(); // id -> elemento

  // ---------- Estructura ----------
  root.classList.add('de');
  root.tabIndex = -1;

  const bar = el('div', 'de-bar', root);
  const btn = (label, fn, title) => { const b = el('button', 'de-btn', bar, label); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); return b; };
  btn('↶ Deshacer', () => onUndo(), 'Ctrl+Z');
  btn('↷ Rehacer', () => onRedo(), 'Ctrl+Y');
  btn('+ Nodo', () => { if (!doc) return; const c = viewCenter(); addNode(doc, c.x - 140, c.y - 60); changed(); render(); });
  btn('Ordenar', () => { if (!doc) return; layout(doc); changed(); render(); }, 'Acomoda los nodos en columnas');
  const status = el('span', 'de-status', bar);

  const canvas = el('div', 'de-canvas', root);
  const world = el('div', 'de-world', canvas);
  const svg = svgEl('svg', { class: 'de-links' }, world);
  const linkG = svgEl('g', {}, svg);
  const tmpLink = svgEl('path', { class: 'de-link tmp' }, svg);
  tmpLink.style.display = 'none';
  const nodesEl = el('div', 'de-nodes', world);
  const empty = el('div', 'de-empty', canvas);
  empty.innerHTML = '<p>Abrí un diálogo desde el árbol de archivos<br>(<code>data/dialogues/…</code>) o creá uno con <b>+ Diálogo</b>.</p>';

  // ---------- Vista (mover y zoom) ----------
  const applyView = () => { world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`; };
  const toWorld = (cx, cy) => { const r = world.getBoundingClientRect(); return { x: (cx - r.left) / view.k, y: (cy - r.top) / view.k }; };
  const viewCenter = () => { const r = canvas.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); };
  const portPos = (e) => { const r = e.getBoundingClientRect(); const w = world.getBoundingClientRect(); return { x: (r.left + r.width / 2 - w.left) / view.k, y: (r.top + r.height / 2 - w.top) / view.k }; };

  // Arrastres (mover la vista, un nodo o un cable). Un solo arrastre a la vez y siempre termina: si el navegador pierde el puntero
  // (soltar fuera de la ventana, Alt+Tab, menú contextual, selección de texto...) o el botón ya no está apretado, se cierra solo.
  // Antes un "soltar" perdido dejaba un movimiento colgado que se peleaba con el siguiente arrastre y la vista dejaba de deslizar.
  let endDrag = null;
  function trackDrag(target, e, onMove, onEnd) {
    endDrag?.(null, false);
    try { target.setPointerCapture(e.pointerId); } catch { /* sin captura: sigue funcionando mientras el puntero esté encima */ }
    const ac = new AbortController(); let done = false;
    const end = (ev, ok) => {
      if (done) return; done = true; endDrag = null; ac.abort();
      try { target.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
      onEnd(ev, ok);
    };
    endDrag = end;
    const on = (t, type, fn) => t.addEventListener(type, fn, { signal: ac.signal });
    on(target, 'pointermove', (m) => { if (m.pointerId !== e.pointerId) return; if (m.buttons === 0) return end(m, true); onMove(m); });
    on(target, 'pointerup', (u) => { if (u.pointerId === e.pointerId) end(u, true); });
    on(target, 'pointercancel', (u) => end(u, false));
    on(target, 'lostpointercapture', (u) => end(u, false));
    on(window, 'blur', () => end(null, false));
    return end;
  }

  canvas.addEventListener('pointerdown', (e) => {
    // clic izquierdo en el fondo, o botón del medio en cualquier lado (incluso encima de un nodo)
    if (!(e.button === 1 || (e.button === 0 && !e.target.closest('.de-node')))) return;
    e.preventDefault(); // sin selección de texto ni arrastre nativo que cancelen el movimiento
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    canvas.classList.add('panning');
    trackDrag(canvas, e, (m) => { view.x = ox + m.clientX - sx; view.y = oy + m.clientY - sy; applyView(); }, () => canvas.classList.remove('panning'));
  }, true);
  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
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
    if (!doc) return;
    const pr = problems(doc);
    status.classList.toggle('err', pr.length > 0);
    status.title = pr.join('\n');
    status.textContent = pr.length ? `⚠ ${pr.length} aviso${pr.length > 1 ? 's' : ''} (pasá el mouse)` : 'Sin avisos';
  }

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
    const sx = ev.clientX, sy = ev.clientY;
    const from = portPos(e);
    let moved = false;
    trackDrag(e, ev, (m) => {
      if (Math.hypot(m.clientX - sx, m.clientY - sy) > 5) moved = true;
      if (!moved) return;
      tmpLink.style.display = '';
      tmpLink.setAttribute('d', curve(from, toWorld(m.clientX, m.clientY)));
    }, (u, ok) => {
      tmpLink.style.display = 'none';
      if (!ok || !u) return; // cancelado
      if (!moved) { if (port.get()) { port.set(''); changed(); render(); } return; }
      const hit = document.elementFromPoint(u.clientX, u.clientY)?.closest('.de-node');
      if (hit) {
        if (hit.dataset.id) { port.set(hit.dataset.id); changed(); render(); }
      } else {
        const p = toWorld(u.clientX, u.clientY);
        port.set(addNode(doc, p.x, p.y - 20));
        changed(); render();
      }
    });
  }

  // El nodo se arrastra desde toda su cabecera, también desde el nombre (un clic ahí sigue sirviendo para escribirlo).
  function makeDraggable(head, nodeEl, pos) {
    head.addEventListener('pointerdown', (e) => {
      const onName = !!e.target.closest('.de-id');
      if (e.button !== 0 || e.target.closest('button,textarea,select') || (!onName && e.target.closest('input'))) return;
      if (!onName) e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
      let moved = false;
      trackDrag(head, e, (m) => {
        if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return; // todavía es un clic
        moved = true;
        pos.x = ox + (m.clientX - sx) / view.k;
        pos.y = oy + (m.clientY - sy) / view.k;
        nodeEl.style.left = `${pos.x}px`; nodeEl.style.top = `${pos.y}px`;
        drawLinks();
      }, () => { if (moved) changed(); });
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

  // Copia de un nodo: queda al lado, con las mismas salidas (sus conexiones de entrada no se copian) y un nombre libre
  function duplicateNode(id) {
    const src = doc.nodes[id]; if (!src) return null;
    let k = 1, neu = `${id}_copia`;
    while (doc.nodes[neu]) neu = `${id}_copia${++k}`;
    const copy = structuredClone(src); copy.x = src.x + 40; copy.y = src.y + 40;
    const nodes = {};
    for (const [key, v] of Object.entries(doc.nodes)) { nodes[key] = v; if (key === id) nodes[neu] = copy; }
    doc.nodes = nodes;
    return neu;
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
    const dup = el('button', 'de-mini', head, '⧉'); dup.type = 'button'; dup.title = 'Duplicar nodo';
    dup.addEventListener('click', () => { if (duplicateNode(id)) { changed(); render(); } });
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
    fillClips();
    const animIn = field(more, 'Animación', n.anim, (v) => { n.anim = v; changed(); }, (clips() || {}).npc ? `clip de ${clips().npc} · - = idle` : 'clip del NPC · - = idle');
    animIn.setAttribute('list', 'de-clips-list'); // sugerencias: los clips reales del .glb
    animIn.autocomplete = 'off';
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
  const dl = el('datalist', '', root); dl.id = 'de-clips-list';
  function fillClips() {
    const c = { npc: null, clips: [], ...(clips() || {}) };
    dl.replaceChildren(); el('option', '', dl).value = '-';
    for (const k of c.clips) { const o = el('option', '', dl); o.value = k.name; o.label = `${k.kind} · ${k.duration}s`; }
    return c;
  }
  const mclips = el('div', 'de-clips', mcard);
  function drawChips() {
    const c = fillClips(); mclips.replaceChildren();
    if (!c.npc) { el('span', '', mclips, 'Animaciones: abrí la vista previa con un NPC que use este diálogo (npc_dialogo) para ver sus clips acá.'); return; }
    el('span', '', mclips, `Insertar animación de ${c.npc}:`);
    const add = (label, token) => {
      const b = el('button', 'de-chip', mclips, label); b.type = 'button'; b.title = `Inserta ${token} donde está el cursor`;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // no le saca el foco al texto
      b.addEventListener('click', () => {
        const a = mta.selectionStart, z = mta.selectionEnd;
        mta.setRangeText(token, a, z, 'end'); mta.focus();
        mta.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    add('idle', '{}');
    for (const k of c.clips) if (k.kind !== 'idle') add(k.name, `{${k.name}}`);
  }
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
    drawChips();
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
  });

  // ---------- Conexión con el Studio ----------
  let lastEmit = 0;
  const text = () => `${JSON.stringify(toJSON(doc), null, 2)}\n`;

  // Cada edición avisa al Studio con el JSON nuevo. Si pasaron más de 600 ms desde la anterior, es un paso nuevo del historial
  // (así un Ctrl+Z deshace "lo último que hiciste" y no cada letra).
  function changed() {
    updateStatus();
    if (!doc) return;
    const now = Date.now();
    onChange(text(), now - lastEmit > 600);
    lastEmit = now;
  }

  // Muestra el JSON que le pasa el Studio (al abrir el archivo, al deshacer/rehacer o si se editó en modo Código)
  function load(raw, name) {
    let data;
    try { data = JSON.parse(raw); } catch (err) {
      doc = null; modal.hidden = true; editing = null; render();
      setStatus(`El JSON tiene un error: ${err.message}. Corregilo en «Código».`, true);
      return false;
    }
    const same = doc?.name === name;
    doc = fromJSON(data, name);
    if (!Object.keys(doc.nodes).length) doc.nodes.inicio = emptyDoc(name).nodes.inicio;
    if (needsLayout(doc)) layout(doc); // solo en memoria: se guarda cuando hagas un cambio
    modal.hidden = true;
    editing = null;
    if (!same) { view.x = 30; view.y = 30; view.k = 1; }
    applyView();
    render();
    return true;
  }

  // Al volver a mostrarse (estaba oculto) hay que recalcular dónde caen los cables
  const show = () => { applyView(); redraw(); };

  return { load, show };
}
