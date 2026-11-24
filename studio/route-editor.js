// Editor de recorridos de NPC por nodos. Vive en el Studio (studio/studio.html), NO en el juego.
//
// Hay dos clases de nodos:
//  - PARADAS (las grandes): un punto del .glb (Empty) y hacia dónde sigue. Se conectan entre sí con los círculos de la derecha.
//  - MODIFICADORES (las tarjetas de colores): atributos sueltos (⏱ espera, 🎞 animación, ♾ repetir sin fin, 🚶 caminar, 🧭 mirar).
//    Se crean con «+ Modificador», se mueven por donde quieras y se conectan arrastrando desde su círculo hasta una parada.
//    Un mismo modificador puede enchufarse a varias paradas. Si una parada tiene dos del mismo tipo, vale el último conectado.
// Arrastrar desde un círculo y soltar en el vacío crea una parada nueva · clic en el círculo = desconectar ·
// rueda = zoom · arrastrar el fondo (o el botón del medio) = mover la vista.
// - No toca archivos: el Studio le pasa el JSON con load() y recibe el texto nuevo en onChange(texto, pasoNuevo).
// - points(): [{ name, x, y, z }] Empties del .glb · clips(): { npc, clips } animaciones del NPC · flags(): nombres de flags
// - onShow(on, json): dibuja (o borra) el recorrido dentro de la vista previa.
// Formato del JSON: src/actors/npc-route.js (los atributos sueltos de versiones anteriores se convierten en modificadores al abrir).

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; parent?.appendChild(e); return e; };
const svgEl = (tag, attrs = {}, parent) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent?.appendChild(e); return e; };
const curve = (a, b) => { const d = Math.max(40, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + d},${a.y} ${b.x - d},${b.y} ${b.x},${b.y}`; };
const cleanId = (s) => String(s ?? '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '');
const numOrEmpty = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));
const CMP = /^(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/;

// ---- Tipos de modificador ----
// fields: [propiedad, etiqueta, clase de campo]   props: lo que escribe en el JSON del juego
const MOD = {
  wait: { icon: '⏱', label: 'Espera', color: '#60a5fa', base: 'espera', fields: [['wait', 'Espera (s)', 'num'], ['waitMax', 'hasta (opc.)', 'num']], hint: 'Cuánto se queda en la parada (si ponés «hasta», un tiempo al azar entre los dos).' },
  anim: { icon: '🎞', label: 'Animación', color: '#c084fc', base: 'anim', fields: [['anim', 'Clip mientras espera', 'clip']], hint: 'Vacío = idle. Un clip que termina en _vuelve se hace una sola vez.' },
  loop: { icon: '♾', label: 'Repetir sin fin', color: '#fbbf24', base: 'loop', fields: [], fixed: { loop: true }, hint: 'Se queda repitiendo la animación; ignora la espera y solo sigue cuando se cumple la condición de un destino.' },
  walk: { icon: '🚶', label: 'Caminar', color: '#4ade80', base: 'caminar', fields: [['walk', 'Animación al caminar', 'clip'], ['speed', 'Velocidad (m/s)', 'num']], hint: 'Vale para el tramo que llega a la parada.' },
  face: { icon: '🧭', label: 'Mirar como el Empty', color: '#f472b6', base: 'mirar', fields: [], fixed: { face: 'point' }, hint: 'Al llegar, mira hacia donde apunta la flecha verde del Empty.' },
};
const MOD_KEYS = { wait: ['wait', 'waitMax'], anim: ['anim'], loop: [], walk: ['walk', 'speed'], face: [] };

// "hablo_tokse, !tiene_espada, veces>=3"  <->  { hablo_tokse: true, tiene_espada: false, veces: ">=3" }
function parseCond(str) {
  const out = {};
  for (const raw of String(str ?? '').split(',')) {
    const part = raw.trim(); let m;
    if (!part) continue;
    if ((m = /^!\s*([^\s=<>!,]+)$/.exec(part))) out[m[1]] = false;
    else if ((m = /^([^\s=<>!,]+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(part))) out[m[1]] = m[2] + m[3];
    else if ((m = /^([^\s=<>!,]+)\s*=\s*(.+)$/.exec(part))) out[m[1]] = /^true$/i.test(m[2]) ? true : /^false$/i.test(m[2]) ? false : Number.isFinite(Number(m[2])) ? Number(m[2]) : m[2].trim();
    else out[part] = true;
  }
  return Object.keys(out).length ? out : undefined;
}
function condStr(o) {
  if (!o || typeof o !== 'object') return '';
  return Object.entries(o).map(([k, v]) => (v === true ? k : v === false ? `!${k}` : typeof v === 'string' && CMP.test(v.trim()) ? `${k}${v.trim().replace(/\s+/g, '')}` : `${k}=${v}`)).join(', ');
}

// ---- Modelo: JSON del juego <-> documento editable ----
const uniq = (taken, base) => { let id = base, i = 1; while (taken[id]) id = `${base}_${++i}`; return id; };
function fromJSON(raw, name) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const { speed, walk, start, nodes, modifiers, editor, ...extra } = d;
  const doc = { name, speed: numOrEmpty(speed), walk: walk ?? '', start: start ?? '', nodes: {}, mods: {}, startPos: editor?.start ?? null, extra, migrated: false };
  const pos = (kind, id) => ({ x: Number.isFinite(editor?.[kind]?.[id]?.x) ? editor[kind][id].x : NaN, y: Number.isFinite(editor?.[kind]?.[id]?.y) ? editor[kind][id].y : NaN });
  // modificadores guardados
  for (const [id, m] of Object.entries(modifiers ?? {})) {
    const { type, ...rest } = m ?? {};
    const t = MOD[type] ? type : 'anim';
    const mod = { type: t, extra: {}, ...pos('mods', id) };
    for (const k of MOD_KEYS[t]) mod[k] = k === 'anim' || k === 'walk' ? (rest[k] ?? '') : numOrEmpty(rest[k]);
    for (const [k, v] of Object.entries(rest)) if (!MOD_KEYS[t].includes(k) && !(MOD[t].fixed && k in MOD[t].fixed)) mod.extra[k] = v;
    doc.mods[id] = mod;
  }
  for (const [id, n] of Object.entries(nodes ?? {})) {
    const { point, wait, waitMax, anim, loop, walk: wk, face, speed: sp, next, mods, ...rest } = n ?? {};
    const outs = typeof next === 'string' ? (next ? [{ to: next, weight: '', if: '' }] : [])
      : Array.isArray(next) ? next.map((c) => ({ to: c?.to ?? '', weight: numOrEmpty(c?.weight), if: condStr(c?.if) })) : [];
    const node = { point: point ?? '', next: outs, mods: Array.isArray(mods) ? mods.filter((m) => typeof m === 'string') : [], extra: rest, ...pos('nodes', id) };
    // atributos escritos directo en la parada (versiones anteriores): pasan a ser modificadores
    const mk = (type, props, suffix) => {
      const mid = uniq(doc.mods, `${id}_${suffix}`);
      doc.mods[mid] = { type, extra: {}, x: NaN, y: NaN, wait: '', waitMax: '', anim: '', walk: '', speed: '', ...props };
      node.mods.push(mid); doc.migrated = true;
    };
    if (wait !== undefined || waitMax !== undefined) mk('wait', { wait: numOrEmpty(wait), waitMax: numOrEmpty(waitMax) }, 'espera');
    if (anim) mk('anim', { anim: String(anim) }, 'anim');
    if (loop === true) mk('loop', {}, 'loop');
    if (wk || sp !== undefined) mk('walk', { walk: wk ?? '', speed: numOrEmpty(sp) }, 'caminar');
    if (face === 'point' || face === 'punto') mk('face', {}, 'mirar');
    doc.nodes[id] = node;
  }
  for (const m of Object.values(doc.mods)) for (const k of ['wait', 'waitMax', 'anim', 'walk', 'speed']) if (!(k in m)) m[k] = k === 'anim' || k === 'walk' ? '' : '';
  if (!doc.start || !doc.nodes[doc.start]) doc.start = Object.keys(doc.nodes)[0] ?? '';
  return doc;
}
const c0 = (c) => c.weight === '' && !c.if.trim();
function toJSON(doc) {
  const o = {};
  if (doc.speed !== '') o.speed = doc.speed;
  if (String(doc.walk).trim()) o.walk = String(doc.walk).trim();
  if (doc.start) o.start = doc.start;
  o.nodes = {};
  const ed = { nodes: {}, mods: {} };
  for (const [id, n] of Object.entries(doc.nodes)) {
    const r = {};
    if (n.point.trim()) r.point = n.point.trim();
    const mods = n.mods.filter((m) => doc.mods[m]);
    if (mods.length) r.mods = mods;
    const outs = n.next.filter((c) => c.to);
    if (outs.length === 1 && c0(outs[0])) r.next = outs[0].to;
    else if (outs.length) r.next = outs.map((c) => { const x = { to: c.to }; if (c.weight !== '') x.weight = c.weight; const f = parseCond(c.if); if (f) x.if = f; return x; });
    Object.assign(r, n.extra);
    o.nodes[id] = r;
    ed.nodes[id] = { x: Math.round(n.x), y: Math.round(n.y) };
  }
  const mo = {};
  for (const [id, m] of Object.entries(doc.mods)) {
    const r = { type: m.type };
    for (const k of MOD_KEYS[m.type]) if (m[k] !== '' && m[k] !== undefined && String(m[k]).trim() !== '') r[k] = typeof m[k] === 'string' ? m[k].trim() : m[k];
    Object.assign(r, MOD[m.type].fixed ?? {}, m.extra);
    mo[id] = r;
    ed.mods[id] = { x: Math.round(m.x), y: Math.round(m.y) };
  }
  if (Object.keys(mo).length) o.modifiers = mo; else delete ed.mods;
  if (doc.startPos) ed.start = { x: Math.round(doc.startPos.x), y: Math.round(doc.startPos.y) };
  o.editor = ed;
  return { ...doc.extra, ...o };
}
function layout(doc) {
  const depth = {};
  const q = doc.start ? [doc.start] : []; if (doc.start) depth[doc.start] = 0;
  while (q.length) { const id = q.shift(); for (const c of doc.nodes[id]?.next ?? []) if (doc.nodes[c.to] && !(c.to in depth)) { depth[c.to] = depth[id] + 1; q.push(c.to); } }
  let extra = Math.max(-1, ...Object.values(depth)) + 1;
  for (const id of Object.keys(doc.nodes)) if (!(id in depth)) depth[id] = extra++;
  const rows = {};
  for (const id of Object.keys(doc.nodes)) { const n = doc.nodes[id], d = depth[id]; rows[d] = rows[d] ?? 0; n.x = 380 + d * 660; n.y = 30 + rows[d]++ * 340; }
  placeMods(doc, true);
  doc.startPos = { x: 20, y: 40 };
}
// Los modificadores se acomodan a la izquierda de la primera parada que los usa (los sueltos, abajo)
function placeMods(doc, all) {
  const used = new Set(); let loose = 0;
  for (const [sid, n] of Object.entries(doc.nodes)) {
    let k = 0;
    for (const mid of n.mods) {
      const m = doc.mods[mid]; if (!m || used.has(mid)) continue;
      used.add(mid);
      if (all || !Number.isFinite(m.x) || !Number.isFinite(m.y)) { m.x = n.x - 290; m.y = n.y + k * 130; }
      k++;
    }
  }
  for (const [mid, m] of Object.entries(doc.mods)) if (!used.has(mid) && (all || !Number.isFinite(m.x) || !Number.isFinite(m.y))) { m.x = 20; m.y = 300 + loose++ * 130; }
}
const needsLayout = (doc) => !doc.startPos || Object.values(doc.nodes).some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y));
function addNode(doc, x, y) { const id = uniq(doc.nodes, 'parada'); doc.nodes[id] = { point: '', next: [], mods: [], extra: {}, x, y }; if (!doc.start) doc.start = id; return id; }
function addMod(doc, type, x, y) {
  const id = uniq(doc.mods, MOD[type].base);
  doc.mods[id] = { type, wait: type === 'wait' ? 2 : '', waitMax: '', anim: '', walk: '', speed: '', extra: {}, x, y };
  return id;
}
function removeNode(doc, id) {
  delete doc.nodes[id];
  for (const n of Object.values(doc.nodes)) n.next = n.next.filter((c) => c.to !== id);
  if (doc.start === id) doc.start = Object.keys(doc.nodes)[0] ?? '';
}
function removeMod(doc, id) { delete doc.mods[id]; for (const n of Object.values(doc.nodes)) n.mods = n.mods.filter((m) => m !== id); }
function renameNode(doc, id, neu) {
  if (doc.nodes[neu]) return false;
  const nodes = {}; for (const [k, v] of Object.entries(doc.nodes)) nodes[k === id ? neu : k] = v;
  doc.nodes = nodes;
  for (const n of Object.values(doc.nodes)) for (const c of n.next) if (c.to === id) c.to = neu;
  if (doc.start === id) doc.start = neu;
  return true;
}
function renameMod(doc, id, neu) {
  if (doc.mods[neu]) return false;
  const mods = {}; for (const [k, v] of Object.entries(doc.mods)) mods[k === id ? neu : k] = v;
  doc.mods = mods;
  for (const n of Object.values(doc.nodes)) n.mods = n.mods.map((m) => (m === id ? neu : m));
  return true;
}
// Copia de un elemento: queda al lado y con un nombre libre
function duplicate(map, id, dx = 40, dy = 40) {
  const src = map[id]; if (!src) return null;
  let k = 1, neu = `${id}_copia`;
  while (map[neu]) neu = `${id}_copia${++k}`;
  const copy = structuredClone(src); copy.x = src.x + dx; copy.y = src.y + dy;
  const out = {};
  for (const [key, v] of Object.entries(map)) { out[key] = v; if (key === id) out[neu] = copy; }
  for (const key of Object.keys(map)) delete map[key];
  Object.assign(map, out);
  return neu;
}
const summary = (m) => {
  const t = MOD[m.type];
  if (m.type === 'wait') return `${t.icon} ${m.wait === '' ? '0' : m.wait}${m.waitMax !== '' ? `–${m.waitMax}` : ''} s`;
  if (m.type === 'anim') return `${t.icon} ${m.anim || 'idle'}`;
  if (m.type === 'walk') return `${t.icon} ${[m.walk, m.speed !== '' ? `${m.speed} m/s` : ''].filter(Boolean).join(' · ') || 'caminar'}`;
  return `${t.icon} ${t.label}`;
};

export function createRouteEditor(root, { onChange = () => {}, onUndo = () => {}, onRedo = () => {}, points = () => [], clips = () => ({ npc: null, clips: [] }), onShow = () => {}, flags = () => [] } = {}) {
  let doc = null;
  const view = { x: 30, y: 30, k: 1 };
  let ports = [], nodeEls = new Map(), modEls = new Map(), sockets = new Map(), chips = [], showing = false;

  root.classList.add('de');
  root.tabIndex = -1;
  const bar = el('div', 'de-bar', root);
  const btn = (label, fn, title) => { const b = el('button', 'de-btn', bar, label); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); return b; };
  btn('↶ Deshacer', () => onUndo(), 'Ctrl+Z');
  btn('↷ Rehacer', () => onRedo(), 'Ctrl+Y');
  btn('+ Parada', () => { if (!doc) return; const c = viewCenter(); addNode(doc, c.x - 140, c.y - 60); changed(); render(); }, 'Un punto del recorrido');
  const addSel = el('select', 'de-btn', bar); addSel.title = 'Atributos que se conectan a las paradas';
  addSel.append(new Option('+ Modificador…', ''));
  for (const [k, t] of Object.entries(MOD)) addSel.append(new Option(`${t.icon} ${t.label}`, k));
  addSel.addEventListener('change', () => { const t = addSel.value; addSel.value = ''; if (!t || !doc) return; const c = viewCenter(); addMod(doc, t, c.x - 110, c.y - 40); changed(); render(); });
  btn('Ordenar', () => { if (!doc) return; layout(doc); changed(); render(); }, 'Acomoda paradas y modificadores');
  const bShow = btn('👁 Ver ruta', () => { showing = !showing; bShow.classList.toggle('on', showing); pushShow(); }, 'Dibuja el recorrido dentro de la vista previa');
  const speedLab = el('label', 'de-barfield', bar); el('span', '', speedLab, 'm/s');
  const speedIn = el('input', '', speedLab); speedIn.type = 'number'; speedIn.step = '0.1'; speedIn.min = '0'; speedIn.placeholder = '1.4'; speedIn.title = 'Velocidad por defecto (metros por segundo)';
  speedIn.addEventListener('input', () => { if (doc) { doc.speed = numOrEmpty(speedIn.value); changed(); } });
  const walkLab = el('label', 'de-barfield', bar); el('span', '', walkLab, 'Caminar');
  const walkIn = el('input', '', walkLab); walkIn.placeholder = 'clip (auto)'; walkIn.setAttribute('list', 'rt-clips'); walkIn.title = 'Clip que se usa al caminar. Vacío = el que parezca "caminar" o el marcado con 🚶 en el panel NPC';
  walkIn.addEventListener('input', () => { if (doc) { doc.walk = walkIn.value; changed(); } });
  const status = el('span', 'de-status', bar);

  const canvas = el('div', 'de-canvas', root);
  const world = el('div', 'de-world', canvas);
  const svg = svgEl('svg', { class: 'de-links' }, world);
  const linkG = svgEl('g', {}, svg);
  const tmpLink = svgEl('path', { class: 'de-link tmp' }, svg); tmpLink.style.display = 'none';
  const nodesEl = el('div', 'de-nodes', world);
  const empty = el('div', 'de-empty', canvas);
  empty.innerHTML = '<p>Abrí una ruta desde el árbol de archivos<br>(<code>data/routes/…</code>) o creá una con <b>+ Ruta</b>.</p>';
  const dlPts = el('datalist', '', root); dlPts.id = 'rt-points';
  const dlClips = el('datalist', '', root); dlClips.id = 'rt-clips';
  const dlFlags = el('datalist', '', root); dlFlags.id = 'rt-flags';

  // ---------- Vista ----------
  const applyView = () => { world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`; };
  const toWorld = (cx, cy) => { const r = world.getBoundingClientRect(); return { x: (cx - r.left) / view.k, y: (cy - r.top) / view.k }; };
  const viewCenter = () => { const r = canvas.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); };
  const portPos = (e) => { const r = e.getBoundingClientRect(), w = world.getBoundingClientRect(); return { x: (r.left + r.width / 2 - w.left) / view.k, y: (r.top + r.height / 2 - w.top) / view.k }; };

  // Un solo arrastre a la vez, y siempre termina (soltar fuera de la ventana, Alt+Tab, etc.)
  let endDrag = null;
  function trackDrag(target, e, onMove, onEnd) {
    endDrag?.(null, false);
    try { target.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
    const ac = new AbortController(); let done = false;
    const end = (ev, ok) => { if (done) return; done = true; endDrag = null; ac.abort(); try { target.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ } onEnd(ev, ok); };
    endDrag = end;
    const on = (t, type, fn) => t.addEventListener(type, fn, { signal: ac.signal });
    on(target, 'pointermove', (m) => { if (m.pointerId !== e.pointerId) return; if (m.buttons === 0) return end(m, true); onMove(m); });
    on(target, 'pointerup', (u) => { if (u.pointerId === e.pointerId) end(u, true); });
    on(target, 'pointercancel', (u) => end(u, false));
    on(target, 'lostpointercapture', (u) => end(u, false));
    on(window, 'blur', () => end(null, false));
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!(e.button === 1 || (e.button === 0 && !e.target.closest('.de-node')))) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    canvas.classList.add('panning');
    trackDrag(canvas, e, (m) => { view.x = ox + m.clientX - sx; view.y = oy + m.clientY - sy; applyView(); }, () => canvas.classList.remove('panning'));
  }, true);
  canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k2 = Math.min(1.6, Math.max(0.3, view.k * Math.exp(-e.deltaY * 0.0015)));
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    view.x = mx - (mx - view.x) * (k2 / view.k); view.y = my - (my - view.y) * (k2 / view.k); view.k = k2; applyView();
  }, { passive: false });

  // ---------- Avisos ----------
  function problems() {
    const out = [], pts = new Set(points().map((p) => p.name)), known = pts.size > 0;
    if (!doc) return out;
    if (!Object.keys(doc.nodes).length) out.push('La ruta no tiene paradas.');
    for (const [id, n] of Object.entries(doc.nodes)) {
      if (!n.point.trim() && !n.extra.position) out.push(`«${id}»: falta elegir el punto (Empty).`);
      else if (known && n.point.trim() && !pts.has(n.point.trim())) out.push(`«${id}»: el Empty «${n.point}» no está en el .glb de la escena abierta.`);
      for (const c of n.next) if (c.to && !doc.nodes[c.to]) out.push(`«${id}»: sigue a «${c.to}», que no existe.`);
      const types = n.mods.map((m) => doc.mods[m]?.type).filter(Boolean);
      for (const t of new Set(types)) if (types.filter((x) => x === t).length > 1) out.push(`«${id}»: tiene más de un modificador «${MOD[t].label}»; vale el último conectado.`);
    }
    return out;
  }
  function setStatus(msg, err = false) { status.textContent = msg; status.classList.toggle('err', err); }
  function updateStatus() {
    if (!doc) return;
    const pr = problems();
    status.classList.toggle('err', pr.length > 0); status.title = pr.join('\n');
    status.textContent = pr.length ? `⚠ ${pr.length} aviso${pr.length > 1 ? 's' : ''} (pasá el mouse)` : 'Sin avisos';
  }
  function fillLists() {
    dlPts.replaceChildren();
    for (const p of points()) { const o = el('option', '', dlPts); o.value = p.name; o.label = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`; }
    dlFlags.replaceChildren();
    for (const f of flags()) el('option', '', dlFlags).value = f;
    const c = { npc: null, clips: [], ...(clips() || {}) };
    dlClips.replaceChildren();
    for (const k of c.clips) { const o = el('option', '', dlClips); o.value = k.name; o.label = `${k.kind} · ${k.duration}s`; }
    return c;
  }
  const updateChips = () => { for (const c of chips) { const m = doc?.mods[c.id]; if (m) c.span.textContent = summary(m); } };

  // ---------- Dibujo ----------
  function render() {
    nodesEl.replaceChildren(); ports = []; nodeEls = new Map(); modEls = new Map(); sockets = new Map(); chips = [];
    empty.hidden = !!doc;
    if (!doc) { linkG.replaceChildren(); return; }
    fillLists();
    speedIn.value = doc.speed; walkIn.value = doc.walk;
    nodesEl.append(buildStart());
    for (const id of Object.keys(doc.mods)) nodesEl.append(buildMod(id));
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
      const a = portPos(p.el), target = nodeEls.get(t);
      if (target) svgEl('path', { class: 'de-link', d: curve(a, portPos(target.querySelector('.de-in'))) }, linkG);
      else svgEl('path', { class: 'de-link broken', d: `M${a.x},${a.y} l 50,0` }, linkG);
    }
    // modificador -> parada
    for (const [sid, n] of Object.entries(doc.nodes)) {
      const sock = sockets.get(sid); if (!sock) continue;
      for (const mid of n.mods) {
        const m = doc.mods[mid], me = modEls.get(mid); if (!m || !me) continue;
        const l = svgEl('path', { class: 'de-link modlink', d: curve(portPos(me.querySelector('.de-port')), portPos(sock)) }, linkG);
        l.style.stroke = MOD[m.type].color;
      }
    }
    for (const [mid, me] of modEls) me.querySelector('.de-port').classList.toggle('on', Object.values(doc.nodes).some((n) => n.mods.includes(mid)));
  }
  const redraw = () => requestAnimationFrame(drawLinks);

  function makePort(parent, get, set) {
    const e = el('span', 'de-port', parent);
    e.title = 'Arrastrá hasta una parada para conectar (soltá en el vacío para crear una nueva). Clic: desconectar.';
    const port = { el: e, get, set };
    ports.push(port);
    e.addEventListener('pointerdown', (ev) => startLink(ev, port));
    return e;
  }
  function startLink(ev, port) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const e = port.el, sx = ev.clientX, sy = ev.clientY, from = portPos(e);
    let moved = false;
    trackDrag(e, ev, (m) => {
      if (Math.hypot(m.clientX - sx, m.clientY - sy) > 5) moved = true;
      if (!moved) return;
      tmpLink.style.display = ''; tmpLink.setAttribute('d', curve(from, toWorld(m.clientX, m.clientY)));
    }, (u, ok) => {
      tmpLink.style.display = 'none';
      if (!ok || !u) return;
      if (!moved) { if (port.get()) { port.set(''); changed(); render(); } return; }
      const hit = document.elementFromPoint(u.clientX, u.clientY)?.closest('.de-node');
      if (hit) { if (hit.dataset.id) { port.set(hit.dataset.id); changed(); render(); } } else { const p = toWorld(u.clientX, u.clientY); port.set(addNode(doc, p.x, p.y - 20)); changed(); render(); }
    });
  }
  // Salida de un modificador: arrastrar hasta una parada la conecta; clic la desconecta de todas
  function startModLink(ev, mid, portEl) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const sx = ev.clientX, sy = ev.clientY, from = portPos(portEl), color = MOD[doc.mods[mid].type].color;
    let moved = false;
    trackDrag(portEl, ev, (m) => {
      if (Math.hypot(m.clientX - sx, m.clientY - sy) > 5) moved = true;
      if (!moved) return;
      tmpLink.style.display = ''; tmpLink.style.stroke = color; tmpLink.setAttribute('d', curve(from, toWorld(m.clientX, m.clientY)));
    }, (u, ok) => {
      tmpLink.style.display = 'none'; tmpLink.style.stroke = '';
      if (!ok || !u) return;
      if (!moved) { let any = false; for (const n of Object.values(doc.nodes)) if (n.mods.includes(mid)) { n.mods = n.mods.filter((x) => x !== mid); any = true; } if (any) { changed(); render(); } return; }
      const hit = document.elementFromPoint(u.clientX, u.clientY)?.closest('.de-node');
      const stop = hit?.dataset.id ? doc.nodes[hit.dataset.id] : null;
      if (stop) { if (!stop.mods.includes(mid)) { stop.mods.push(mid); changed(); render(); } else setStatus('Esa parada ya tiene ese modificador.'); }
    });
  }
  function makeDraggable(head, nodeEl, pos) {
    head.addEventListener('pointerdown', (e) => {
      const onName = !!e.target.closest('.de-id');
      if (e.button !== 0 || e.target.closest('button,textarea,select') || (!onName && e.target.closest('input'))) return;
      if (!onName) e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y; let moved = false;
      trackDrag(head, e, (m) => {
        if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
        moved = true; pos.x = ox + (m.clientX - sx) / view.k; pos.y = oy + (m.clientY - sy) / view.k;
        nodeEl.style.left = `${pos.x}px`; nodeEl.style.top = `${pos.y}px`; drawLinks();
      }, () => { if (moved) changed(); });
    });
  }
  function field(parent, label, value, onInput, { placeholder, type = 'input', list, step, title } = {}) {
    const row = el('label', 'de-field', parent); el('span', '', row, label);
    const i = el(type, '', row); i.value = value;
    if (type === 'input' && step) { i.type = 'number'; i.step = step; i.min = '0'; }
    if (placeholder) i.placeholder = placeholder;
    if (list) { i.setAttribute('list', list); i.autocomplete = 'off'; }
    if (title) i.title = title;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }

  function buildStart() {
    const node = el('div', 'de-node de-startnode'); node.dataset.start = '1';
    node.style.left = `${doc.startPos.x}px`; node.style.top = `${doc.startPos.y}px`;
    const head = el('div', 'de-head', node); el('span', 'de-badge', head, '▶ INICIO');
    makeDraggable(head, node, doc.startPos);
    const body = el('div', 'de-body', node);
    const row = el('div', 'de-row', body); el('span', '', row, 'Empieza en');
    makePort(row, () => doc.start, (v) => { doc.start = v; });
    el('p', 'de-hint', body, 'Si el NPC no está ya en ese punto, camina hasta él.');
    return node;
  }

  function buildMod(id) {
    const m = doc.mods[id], t = MOD[m.type];
    const node = el('div', 'de-node rt-mod'); node.dataset.mod = id;
    node.style.left = `${m.x}px`; node.style.top = `${m.y}px`; node.style.setProperty('--mc', t.color);
    modEls.set(id, node);
    const head = el('div', 'de-head', node);
    el('span', 'rt-ico', head, t.icon);
    const idIn = el('input', 'de-id', head); idIn.value = id; idIn.spellcheck = false; idIn.title = `${t.label}: nombre del modificador`;
    idIn.addEventListener('change', () => {
      const neu = cleanId(idIn.value);
      if (neu && neu !== id && renameMod(doc, id, neu)) { changed(); render(); } else { idIn.value = id; if (neu && neu !== id) setStatus(`Ya existe un modificador «${neu}».`, true); }
    });
    const dup = el('button', 'de-mini', head, '⧉'); dup.type = 'button'; dup.title = 'Duplicar modificador (sin conexiones)';
    dup.addEventListener('click', () => { if (duplicate(doc.mods, id)) { changed(); render(); } });
    const del = el('button', 'de-mini', head, '×'); del.type = 'button'; del.title = 'Borrar modificador (se quita de todas las paradas)';
    del.addEventListener('click', () => { removeMod(doc, id); changed(); render(); });
    makeDraggable(head, node, m);
    const body = el('div', 'de-body', node);
    el('div', 'rt-kind', body, t.label);
    for (const [key, label, kind] of t.fields) {
      field(body, label, m[key], (v) => { m[key] = kind === 'num' ? numOrEmpty(v) : v; changed(); }, kind === 'num' ? { step: key === 'speed' ? '0.1' : '0.5', placeholder: key === 'waitMax' ? 'al azar' : '' } : { list: 'rt-clips', placeholder: 'idle (vacío)' });
    }
    el('p', 'de-hint', body, t.hint);
    const row = el('div', 'de-row', body); el('span', '', row, 'Conectar a paradas');
    const port = el('span', 'de-port', row); port.title = 'Arrastrá hasta una parada. Clic: desconectar de todas.';
    port.addEventListener('pointerdown', (ev) => startModLink(ev, id, port));
    return node;
  }

  function buildNode(id) {
    const n = doc.nodes[id];
    const node = el('div', 'de-node'); node.dataset.id = id;
    node.style.left = `${n.x}px`; node.style.top = `${n.y}px`;
    nodeEls.set(id, node);
    const head = el('div', 'de-head', node);
    el('span', 'de-in', head);
    const idIn = el('input', 'de-id', head); idIn.value = id; idIn.spellcheck = false; idIn.title = 'Nombre de la parada';
    idIn.addEventListener('change', () => {
      const neu = cleanId(idIn.value);
      if (neu && neu !== id && renameNode(doc, id, neu)) { changed(); render(); } else { idIn.value = id; if (neu && neu !== id) setStatus(`Ya existe una parada «${neu}».`, true); }
    });
    const dup = el('button', 'de-mini', head, '⧉'); dup.type = 'button'; dup.title = 'Duplicar parada (mismo punto, modificadores y destinos)';
    dup.addEventListener('click', () => { if (duplicate(doc.nodes, id)) { changed(); render(); } });
    const del = el('button', 'de-mini', head, '×'); del.type = 'button'; del.title = 'Borrar parada';
    del.addEventListener('click', () => { if (confirm(`¿Borrar la parada «${id}»?`)) { removeNode(doc, id); changed(); render(); } });
    makeDraggable(head, node, n);

    const body = el('div', 'de-body', node);
    const pIn = field(body, 'Punto (Empty del .glb)', n.point, (v) => { n.point = v; changed(); updateStatus(); }, { placeholder: n.extra.position ? `posición fija ${JSON.stringify(n.extra.position)}` : 'ruta_tokse_1', list: 'rt-points' });
    const known = new Set(points().map((p) => p.name));
    if (n.point && known.size && !known.has(n.point)) pIn.style.outline = '2px solid #d4543a';

    // Modificadores conectados: el círculo de la izquierda es donde llegan los cables
    const mrow = el('div', 'de-row rt-modrow', body);
    const sock = el('span', 'rt-sock', mrow); sock.title = 'Conectá acá los modificadores (arrastrando desde su círculo)';
    sockets.set(id, sock);
    el('span', '', mrow, 'Modificadores');
    const chipBox = el('div', 'rt-chips', body);
    if (!n.mods.length) el('span', 'rt-none', chipBox, 'Ninguno: espera 0 s con el idle. Conectá uno desde «+ Modificador».');
    for (const mid of n.mods) {
      const m = doc.mods[mid]; if (!m) continue;
      const chip = el('span', 'rt-chip', chipBox); chip.style.setProperty('--mc', MOD[m.type].color); chip.title = `${MOD[m.type].label}: ${mid}`;
      const sp = el('span', '', chip, summary(m)); chips.push({ id: mid, span: sp });
      const x = el('button', '', chip, '×'); x.type = 'button'; x.title = 'Quitar de esta parada';
      x.addEventListener('click', () => { n.mods = n.mods.filter((q) => q !== mid); changed(); render(); });
    }

    const loops = n.mods.some((mid) => doc.mods[mid]?.type === 'loop');
    el('div', 'de-hint', body, n.next.length > 1 ? 'Después va a… (elige uno al azar)' : 'Después va a…');
    n.next.forEach((c, i) => {
      const box = el('div', 'de-choice', body);
      const r = el('div', 'de-row', box);
      if (n.next.length > 1) { const wi = el('input', '', r); wi.type = 'number'; wi.min = '0'; wi.step = '1'; wi.value = c.weight; wi.placeholder = 'peso 1'; wi.title = 'Probabilidad relativa (1 por defecto)'; wi.style.maxWidth = '70px'; wi.addEventListener('input', () => { c.weight = numOrEmpty(wi.value); changed(); }); }
      else el('span', '', r, c.to ? `→ ${c.to}` : '(sin destino)');
      makePort(r, () => c.to, (v) => { c.to = v; });
      const r2 = el('div', 'de-row', box);
      const ci = el('input', 'de-cond', r2); ci.value = c.if; ci.placeholder = 'solo si… (opcional)'; ci.title = 'Va por acá solo si se cumple. Ej: hablo_tokse, !tiene_espada, veces_tokse>=2';
      ci.setAttribute('list', 'rt-flags'); ci.autocomplete = 'off';
      ci.addEventListener('input', () => { c.if = ci.value; changed(); });
      const x = el('button', 'de-mini', r2, '×'); x.type = 'button'; x.title = 'Quitar destino';
      x.addEventListener('click', () => { n.next.splice(i, 1); changed(); render(); });
    });
    if (loops) el('p', 'de-hint', body, n.next.some((c) => c.if.trim()) ? '♾ Sigue solo cuando se cumple una condición (los destinos sin condición no se usan).' : '♾ Sin condiciones: se queda acá para siempre.');
    else if (n.next.some((c) => c.if.trim())) el('p', 'de-hint', body, 'Si ninguna condición se cumple, espera acá y vuelve a mirar.');
    const add = el('button', 'de-add', body, n.next.length ? '+ otro destino (al azar)' : '+ destino'); add.type = 'button';
    add.addEventListener('click', () => { n.next.push({ to: '', weight: '', if: '' }); changed(); render(); });
    return node;
  }

  // ---------- Conexión con el Studio ----------
  let lastEmit = 0, showT = 0;
  const text = () => `${JSON.stringify(toJSON(doc), null, 2)}\n`;
  function pushShow() { clearTimeout(showT); showT = setTimeout(() => { try { onShow(showing && !!doc, doc ? toJSON(doc) : null); } catch { /* sin vista previa */ } }, 120); }
  function changed() {
    updateStatus(); updateChips();
    if (!doc) return;
    const now = Date.now();
    onChange(text(), now - lastEmit > 600);
    lastEmit = now;
    if (showing) pushShow();
  }
  function load(raw, name) {
    let data;
    try { data = JSON.parse(raw); } catch (err) { doc = null; render(); setStatus(`El JSON tiene un error: ${err.message}. Corregilo en «Código».`, true); return false; }
    const same = doc?.name === name;
    doc = fromJSON(data, name);
    if (needsLayout(doc)) layout(doc); else placeMods(doc, false);
    if (!same) { view.x = 30; view.y = 30; view.k = 1; }
    applyView(); render(); if (showing) pushShow();
    return true;
  }
  const show = () => { applyView(); redraw(); };
  const refresh = () => { if (doc) render(); }; // cuando cambian los Empties o los clips disponibles
  return { load, show, refresh, hideRoute: () => { showing = false; bShow.classList.remove('on'); onShow(false, null); } };
}
