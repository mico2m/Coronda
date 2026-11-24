// Editor de recorridos de NPC — versión LISTA (sin cables). Vive en el Studio, no en el juego.
// El NPC recorre las paradas en el orden de la lista, de arriba hacia abajo. Cada parada tiene:
//   punto (Empty del .glb) · cuánto espera · qué animación hace · y opciones extra.
// Al final puede volver a la primera parada o quedarse ahí.
// Para casos especiales (según flags o al azar), una parada puede tener «Después» = Personalizado.
// No toca archivos: el Studio le pasa el JSON con load() y recibe el texto nuevo en onChange(texto, pasoNuevo).
// Formato del JSON: src/actors/npc-route.js (acepta también rutas con modificadores: se convierten en atributos de la parada).

const el = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; parent?.appendChild(e); return e; };
const cleanId = (s) => String(s ?? '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '');
const numOrEmpty = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));
const CMP = /^(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/;

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

// ---- Modelo ----
// doc = { speed, walk, loopBack, stops:[{id, point, wait, waitMax, anim, loop, face, walk, speed, custom:null|[{to,weight,if}], extra}], extra }
function fromJSON(raw, name) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const { speed, walk, start, nodes, modifiers, editor, ...extra } = d;
  const eff = {};
  for (const [id, n0] of Object.entries(nodes ?? {})) {
    const n = { ...(n0 ?? {}) };
    for (const mid of Array.isArray(n.mods) ? n.mods : []) { const { type, ...p } = modifiers?.[mid] ?? {}; Object.assign(n, p); }
    delete n.mods; eff[id] = n;
  }
  const outsOf = (n) => (typeof n.next === 'string' ? (n.next ? [{ to: n.next, weight: '', if: '' }] : [])
    : Array.isArray(n.next) ? n.next.map((c) => ({ to: c?.to ?? '', weight: numOrEmpty(c?.weight), if: condStr(c?.if) })) : []);
  // orden: desde el inicio siguiendo el primer destino; el resto, al final
  const order = [], seen = new Set();
  let cur = start && eff[start] ? start : Object.keys(eff)[0];
  while (cur && eff[cur] && !seen.has(cur)) { seen.add(cur); order.push(cur); cur = outsOf(eff[cur])[0]?.to; }
  for (const id of Object.keys(eff)) if (!seen.has(id)) order.push(id);
  const doc = { name, speed: numOrEmpty(speed), walk: walk ?? '', loopBack: false, stops: [], extra };
  order.forEach((id, i) => {
    const n = eff[id], outs = outsOf(n);
    const { point, wait, waitMax, anim, loop, walk: wk, face, speed: sp, next, ...rest } = n;
    const isLast = i === order.length - 1, nextId = order[i + 1];
    const plain = outs.length === 1 && !outs[0].weight && !outs[0].if;
    let custom = null;
    if (isLast) {
      if (plain && outs[0].to === order[0]) doc.loopBack = true;
      else if (outs.length && !(plain && !eff[outs[0].to])) custom = outs;
    } else if (!(plain && outs[0].to === nextId)) custom = outs;
    doc.stops.push({ id, point: point ?? '', wait: numOrEmpty(wait), waitMax: numOrEmpty(waitMax), anim: anim ?? '', loop: loop === true, face: face === 'point' || face === 'punto', walk: wk ?? '', speed: numOrEmpty(sp), custom, extra: rest });
  });
  return doc;
}
function toJSON(doc) {
  const o = {};
  if (doc.speed !== '') o.speed = doc.speed;
  if (String(doc.walk).trim()) o.walk = String(doc.walk).trim();
  if (doc.stops.length) o.start = doc.stops[0].id;
  o.nodes = {};
  doc.stops.forEach((s, i) => {
    const r = {};
    if (s.point.trim()) r.point = s.point.trim();
    if (s.wait !== '') r.wait = s.wait;
    if (s.waitMax !== '') r.waitMax = s.waitMax;
    if (s.anim.trim()) r.anim = s.anim.trim();
    if (s.loop) r.loop = true;
    if (s.face) r.face = 'point';
    if (s.walk.trim()) r.walk = s.walk.trim();
    if (s.speed !== '') r.speed = s.speed;
    let outs;
    if (s.custom) outs = s.custom.filter((c) => c.to);
    else if (i < doc.stops.length - 1) outs = [{ to: doc.stops[i + 1].id, weight: '', if: '' }];
    else outs = doc.loopBack && doc.stops.length > 1 ? [{ to: doc.stops[0].id, weight: '', if: '' }] : [];
    if (outs.length === 1 && outs[0].weight === '' && !outs[0].if.trim()) r.next = outs[0].to;
    else if (outs.length) r.next = outs.map((c) => { const x = { to: c.to }; if (c.weight !== '') x.weight = c.weight; const f = parseCond(c.if); if (f) x.if = f; return x; });
    Object.assign(r, s.extra);
    o.nodes[s.id] = r;
  });
  return { ...doc.extra, ...o };
}
const uniq = (stops, base) => { let id = base, i = 1; while (stops.some((s) => s.id === id)) id = `${base}_${++i}`; return id; };
const blank = (id) => ({ id, point: '', wait: 2, waitMax: '', anim: '', loop: false, face: false, walk: '', speed: '', custom: null, extra: {} });

const CSS = `
.rl-wrap { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
.rl-col { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; align-items: stretch; }
.rl-intro { color: var(--muted); margin: 0 0 12px; }
.rl-card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.rl-head { display: flex; align-items: center; gap: 8px; }
.rl-num { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--accent); color: #062; font-weight: 700; display: grid; place-items: center; }
.rl-id { flex: 1; min-width: 0; background: transparent; border: 1px solid transparent; color: var(--fg); font: 600 14px var(--font-body); padding: 3px 6px; border-radius: 6px; }
.rl-id:hover, .rl-id:focus { border-color: var(--line); background: var(--bg); }
.rl-mini { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.rl-mini:hover:not(:disabled) { border-color: var(--accent); } .rl-mini:disabled { opacity: .35; cursor: default; }
.rl-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.rl-row > label { display: flex; align-items: center; gap: 6px; }
.rl-lab { color: var(--muted); min-width: 92px; }
.rl-card input:not([type=checkbox]), .rl-card select, .rl-end select { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 7px; font: 13px var(--font-body); min-width: 0; }
.rl-card input[type=number] { width: 70px; }
.rl-point { flex: 1; min-width: 160px; } .rl-point.bad { outline: 2px solid #d4543a; }
.rl-card details { border-top: 1px dashed var(--line); padding-top: 6px; } .rl-card summary { cursor: pointer; color: var(--muted); }
.rl-card details .rl-row { margin-top: 6px; }
.rl-arrow { text-align: center; color: var(--muted); padding: 4px 0; font-size: 12px; }
.rl-custom { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px; background: var(--bg); width: 100%; box-sizing: border-box; }
.rl-custom .rl-row input[list] { flex: 1; min-width: 120px; }
.rl-hint { color: var(--muted); font-size: 12px; margin: 0; }
.rl-add { margin-top: 10px; align-self: center; }
.rl-end { text-align: center; margin-top: 4px; color: var(--muted); }
.rl-pal { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; padding: 10px; border: 1px dashed var(--line); border-radius: 10px; } .rl-pal .rl-lab { width: 100%; }
.rl-chip { border: 1px solid var(--line); background: var(--panel); color: var(--fg); border-radius: 999px; padding: 3px 10px; cursor: pointer; font: 13px var(--font-body); } .rl-chip:hover { border-color: var(--accent); }
.rl-empty { text-align: center; color: var(--muted); padding: 40px 0; }
`;

export function createRouteEditor(root, { onChange = () => {}, onUndo = () => {}, onRedo = () => {}, points = () => [], clips = () => ({ npc: null, clips: [] }), onShow = () => {}, flags = () => [] } = {}) {
  let doc = null, showing = false, lastEmit = 0, showT = 0;
  root.classList.add('de');
  root.tabIndex = -1;
  if (!document.getElementById('rl-css')) { const s = el('style', '', document.head); s.id = 'rl-css'; s.textContent = CSS; }

  const bar = el('div', 'de-bar', root);
  const btn = (label, fn, title) => { const b = el('button', 'de-btn', bar, label); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); return b; };
  btn('↶ Deshacer', () => onUndo(), 'Ctrl+Z');
  btn('↷ Rehacer', () => onRedo(), 'Ctrl+Y');
  btn('+ Parada', () => addStop(), 'Agrega una parada al final');
  const bShow = btn('👁 Ver ruta', () => { showing = !showing; bShow.classList.toggle('on', showing); pushShow(); }, 'Dibuja el recorrido dentro de la vista previa');
  const speedLab = el('label', 'de-barfield', bar); el('span', '', speedLab, 'm/s');
  const speedIn = el('input', '', speedLab); speedIn.type = 'number'; speedIn.step = '0.1'; speedIn.min = '0'; speedIn.placeholder = '1.4'; speedIn.title = 'Velocidad por defecto (metros por segundo)';
  speedIn.addEventListener('input', () => { if (doc) { doc.speed = numOrEmpty(speedIn.value); changed(); } });
  const walkLab = el('label', 'de-barfield', bar); el('span', '', walkLab, 'Caminar');
  const walkIn = el('input', '', walkLab); walkIn.placeholder = 'clip (auto)'; walkIn.setAttribute('list', 'rt-clips'); walkIn.title = 'Clip al caminar. Vacío = el marcado con 🚶 en el panel NPC o el primero que parezca "caminar"';
  walkIn.addEventListener('input', () => { if (doc) { doc.walk = walkIn.value; changed(); } });
  const status = el('span', 'de-status', bar);

  const wrap = el('div', 'rl-wrap', root);
  const col = el('div', 'rl-col', wrap);
  const dlPts = el('datalist', '', root); dlPts.id = 'rt-points';
  const dlClips = el('datalist', '', root); dlClips.id = 'rt-clips';
  const dlFlags = el('datalist', '', root); dlFlags.id = 'rt-flags';

  function problems() {
    const out = []; if (!doc) return out;
    const pts = new Set(points().map((p) => p.name)), known = pts.size > 0;
    if (!doc.stops.length) out.push('La ruta no tiene paradas.');
    for (const s of doc.stops) {
      if (!s.point.trim() && !s.extra.position) out.push(`«${s.id}»: falta elegir el punto (Empty).`);
      else if (known && s.point.trim() && !pts.has(s.point.trim())) out.push(`«${s.id}»: el Empty «${s.point}» no está en el .glb de la escena abierta.`);
      for (const c of s.custom ?? []) if (c.to && !doc.stops.some((x) => x.id === c.to)) out.push(`«${s.id}»: va a «${c.to}», que no existe.`);
    }
    return out;
  }
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
    dlClips.replaceChildren();
    for (const k of ({ clips: [], ...(clips() || {}) }).clips) { const o = el('option', '', dlClips); o.value = k.name; o.label = `${k.kind} · ${k.duration}s`; }
  }

  function changed() {
    updateStatus();
    if (!doc) return;
    const now = Date.now();
    onChange(`${JSON.stringify(toJSON(doc), null, 2)}\n`, now - lastEmit > 600);
    lastEmit = now;
    if (showing) pushShow();
  }
  function pushShow() { clearTimeout(showT); showT = setTimeout(() => { try { onShow(showing && !!doc, doc ? toJSON(doc) : null); } catch { /* sin vista previa */ } }, 120); }
  function addStop() {
    if (!doc) return;
    const id = uniq(doc.stops, 'parada');
    doc.stops.push(blank(id)); changed(); render();
    requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
  }
  function rename(s, neu) {
    if (doc.stops.some((x) => x !== s && x.id === neu)) return false;
    for (const x of doc.stops) for (const c of x.custom ?? []) if (c.to === s.id) c.to = neu;
    s.id = neu; return true;
  }

  function field(parent, label, value, onInput, { type = 'text', list, placeholder, step, title } = {}) {
    const l = el('label', '', parent); if (label) el('span', 'rl-lab', l, label);
    const i = el('input', '', l); i.type = type; i.value = value;
    if (step) { i.step = step; i.min = '0'; }
    if (list) { i.setAttribute('list', list); i.autocomplete = 'off'; }
    if (placeholder) i.placeholder = placeholder;
    if (title) l.title = title;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }

  function buildStop(s, i) {
    const n = doc.stops.length;
    const card = el('div', 'rl-card', col); card.dataset.id = s.id;
    const head = el('div', 'rl-head', card);
    el('span', 'rl-num', head, String(i + 1));
    el('span', 'rl-id', head, s.point || '(elegí un punto)');
    const mini = (t, title, fn, dis) => { const b = el('button', 'rl-mini', head, t); b.type = 'button'; b.title = title; b.disabled = !!dis; b.addEventListener('click', fn); return b; };
    const move = (d) => { const j = i + d; [doc.stops[i], doc.stops[j]] = [doc.stops[j], doc.stops[i]]; changed(); render(); };
    mini('↑', 'Subir', () => move(-1), i === 0);
    mini('↓', 'Bajar', () => move(1), i === n - 1);
    mini('⧉', 'Duplicar parada', () => { const c = structuredClone(s); c.id = uniq(doc.stops, `${s.id}_copia`); doc.stops.splice(i + 1, 0, c); changed(); render(); });
    mini('×', 'Borrar parada', () => {
      doc.stops.splice(i, 1);
      for (const x of doc.stops) if (x.custom) x.custom = x.custom.filter((c) => c.to !== s.id);
      changed(); render();
    });

    const known = new Set(points().map((p) => p.name));
    const r1 = el('div', 'rl-row', card);
    el('span', 'rl-lab', r1, '📍 Punto');
    const pIn = el('select', 'rl-point', r1);
    pIn.append(new Option('— elegí un Empty —', ''));
    const names = points().map((p) => p.name);
    if (s.point && !names.includes(s.point.trim())) pIn.append(new Option(`${s.point} (no está en el .glb)`, s.point));
    for (const nm of names) pIn.append(new Option(nm, nm));
    pIn.value = s.point.trim();
    pIn.classList.toggle('bad', !!s.point && !names.includes(s.point.trim()) && names.length > 0);
    pIn.addEventListener('change', () => { s.point = pIn.value; changed(); render(); });

    const r2 = el('div', 'rl-row', card);
    el('span', 'rl-lab', r2, '⏱ Espera');
    const w = el('input', '', r2); w.type = 'number'; w.min = '0'; w.step = '0.5'; w.value = s.wait; w.placeholder = '0'; w.title = 'Segundos';
    w.addEventListener('input', () => { s.wait = numOrEmpty(w.value); changed(); });
    el('span', '', r2, 'a'); 
    const wm = el('input', '', r2); wm.type = 'number'; wm.min = '0'; wm.step = '0.5'; wm.value = s.waitMax; wm.placeholder = 'al azar'; wm.title = 'Opcional: si lo completás, espera un tiempo al azar entre los dos números';
    wm.addEventListener('input', () => { s.waitMax = numOrEmpty(wm.value); changed(); });
    el('span', '', r2, 'segundos');

    const det = el('details', '', card);
    if (s.anim || s.loop || s.face || s.walk || s.speed !== '' || s.custom) det.open = true;
    el('summary', '', det, 'Más opciones (animación, mirar, destinos…)');
    const r3 = el('div', 'rl-row', det);
    const aIn = field(r3, '🎞 Hace', s.anim, (v) => { s.anim = v; changed(); }, { list: 'rt-clips', placeholder: 'idle (vacío)', title: 'Animación mientras está en la parada. Un clip que termina en _vuelve se hace una vez.' });
    aIn.parentElement.style.flex = '1';
    const lp = el('label', '', r3); lp.title = 'Se queda repitiendo la animación y no avanza; solo sale por un destino con condición (Personalizado).';
    const lc = el('input', '', lp); lc.type = 'checkbox'; lc.checked = s.loop; el('span', '', lp, '♾ repetir sin fin');
    lc.addEventListener('change', () => { s.loop = lc.checked; changed(); render(); });
    if (s.loop && !(s.custom ?? []).some((c) => c.if.trim())) el('p', 'rl-hint', det, '♾ Se queda acá para siempre. Para que siga, elegí «Después → Personalizado» y poné un destino con condición.');

    const d1 = el('div', 'rl-row', det);
    const fl = el('label', '', d1); const fc = el('input', '', fl); fc.type = 'checkbox'; fc.checked = s.face; el('span', '', fl, '🧭 Al llegar, mira hacia donde apunta el Empty');
    fc.addEventListener('change', () => { s.face = fc.checked; changed(); });
    const d2 = el('div', 'rl-row', det);
    field(d2, '🚶 Caminar hacia acá', s.walk, (v) => { s.walk = v; changed(); }, { list: 'rt-clips', placeholder: 'el de la ruta' });
    field(d2, 'Velocidad', s.speed, (v) => { s.speed = numOrEmpty(v); changed(); }, { type: 'number', step: '0.1', placeholder: 'm/s' });

    const r4 = el('div', 'rl-row', det);
    el('span', 'rl-lab', r4, '➜ Después');
    const sel = el('select', '', r4);
    const nextTxt = i < n - 1 ? `va a la siguiente (${i + 2})` : (doc.loopBack ? 'vuelve a la parada 1' : 'se queda acá (fin)');
    sel.append(new Option(nextTxt, 'seq'), new Option('Personalizado: según flags / al azar…', 'custom'));
    sel.value = s.custom ? 'custom' : 'seq';
    sel.addEventListener('change', () => { s.custom = sel.value === 'custom' ? (i < n - 1 ? [{ to: doc.stops[i + 1].id, weight: '', if: '' }] : []) : null; changed(); render(); });
    if (s.custom) {
      const box = el('div', 'rl-custom', det);
      el('p', 'rl-hint', box, s.custom.length ? 'Elige entre estos destinos. Con varios, al azar (más «peso» = más probable); los que tienen condición solo cuentan si se cumple.' : 'Sin destinos: el NPC termina la ruta acá.');
      s.custom.forEach((c, k) => {
        const r = el('div', 'rl-row', box);
        const to = el('select', '', r); to.append(new Option('— elegir parada —', ''));
        for (const o of doc.stops) to.append(new Option(`${doc.stops.indexOf(o) + 1}. ${o.id}`, o.id));
        to.value = c.to; to.addEventListener('change', () => { c.to = to.value; changed(); updateStatus(); });
        const wi = el('input', '', r); wi.type = 'number'; wi.min = '0'; wi.value = c.weight; wi.placeholder = 'peso 1'; wi.title = 'Probabilidad relativa (1 por defecto)';
        wi.addEventListener('input', () => { c.weight = numOrEmpty(wi.value); changed(); });
        const ci = el('input', '', r); ci.value = c.if; ci.placeholder = 'solo si… (opcional)'; ci.title = 'Ej: hablo_tokse, !tiene_espada, veces_tokse>=2'; ci.setAttribute('list', 'rt-flags'); ci.autocomplete = 'off';
        ci.addEventListener('input', () => { c.if = ci.value; changed(); });
        const x = el('button', 'rl-mini', r, '×'); x.type = 'button'; x.title = 'Quitar destino'; x.addEventListener('click', () => { s.custom.splice(k, 1); changed(); render(); });
      });
      const add = el('button', 'rl-mini', box, '+ destino'); add.type = 'button'; add.style.alignSelf = 'flex-start';
      add.addEventListener('click', () => { s.custom.push({ to: '', weight: '', if: '' }); changed(); render(); });
    }
    return card;
  }

  function render() {
    const keep = wrap.scrollTop;
    col.replaceChildren(); fillLists();
    if (!doc) { el('div', 'rl-empty', col).innerHTML = 'Abrí una ruta desde el árbol de archivos<br>(<code>data/routes/…</code>) o creá una con <b>+ Ruta</b>.'; return; }
    speedIn.value = doc.speed; walkIn.value = doc.walk;
    el('p', 'rl-intro', col, 'La ruta es la lista de Empties por los que pasa el NPC, de arriba hacia abajo.');
    const pal = el('div', 'rl-pal', col);
    el('div', 'rl-lab', pal, 'Empties detectados en el .glb — tocá uno para agregarlo a la ruta:');
    const pts = points().map((p) => p.name).sort((a, b) => (/^ruta/i.test(b) - /^ruta/i.test(a)) || a.localeCompare(b));
    if (!pts.length) el('p', 'rl-hint', pal, 'No encuentro Empties: esperá a que cargue la vista previa (o abrí la escena donde están).');
    for (const nm of pts) {
      const used = doc.stops.filter((x) => x.point.trim() === nm).length;
      const b = el('button', 'rl-chip', pal, used ? `${nm} ×${used}` : nm); b.type = 'button'; b.title = 'Agregar como nueva parada';
      b.addEventListener('click', () => { const st = blank(uniq(doc.stops, cleanId(nm) || 'parada')); st.point = nm; doc.stops.push(st); changed(); render(); requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; }); });
    }
    doc.stops.forEach((s, i) => {
      buildStop(s, i);
      if (i < doc.stops.length - 1) el('div', 'rl-arrow', col, '↓ camina');
    });
    if (!doc.stops.length) el('div', 'rl-empty', col, 'Todavía no hay paradas.');
    const add = el('button', 'de-btn rl-add', col, '+ Agregar parada'); add.type = 'button'; add.addEventListener('click', addStop);
    if (doc.stops.length > 1 && !doc.stops[doc.stops.length - 1].custom) {
      const end = el('label', 'rl-end', col); const c = el('input', '', end); c.type = 'checkbox'; c.checked = doc.loopBack;
      el('span', '', end, ' Al llegar a la última, volver a la primera (repetir siempre)');
      c.addEventListener('change', () => { doc.loopBack = c.checked; changed(); render(); });
    }
    updateStatus();
    wrap.scrollTop = keep;
  }

  function load(raw, name) {
    let data;
    try { data = JSON.parse(raw); } catch (err) { doc = null; render(); setStatus(`El JSON tiene un error: ${err.message}. Corregilo en «Código».`); return false; }
    doc = fromJSON(data, name);
    render(); if (showing) pushShow();
    return true;
  }
  function setStatus(msg) { status.textContent = msg; status.classList.add('err'); }
  return { load, show: () => {}, refresh: () => { if (doc) render(); }, hideRoute: () => { showing = false; bShow.classList.remove('on'); onShow(false, null); } };
}
