// Modelo del editor de diálogos (solo dev): convierte entre el JSON del juego (data/dialogues/*.json) y un
// documento cómodo de editar. No toca el DOM, así se puede probar solo.
//
// En el editor, los textos de un nodo se escriben en una caja: una línea en blanco separa las páginas.
// Las condiciones y flags se escriben en una línea:  hablo_tokse, !tiene_espada, veces_tokse>=3, humor=alegre
// (ver src/systems/flags.js para qué significa cada forma).
// La posición de cada nodo se guarda en el mismo JSON, bajo "editor"; el juego no la lee.

const CMP = /^(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/;
const NAME = '[^\\s=<>!,]+';

const toVal = (v) => {
  const s = String(v).trim();
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (s !== '' && Number.isFinite(Number(s))) return Number(s);
  return s;
};

// "a, !b, c>=3, d=hola" -> { a: true, b: false, c: ">=3", d: "hola" }   (compare: acepta >=, <=, etc.)
export function parseFlags(str, { compare = false } = {}) {
  const out = {};
  for (const raw of String(str ?? '').split(',')) {
    const part = raw.trim();
    if (!part) continue;
    let m;
    if ((m = new RegExp(`^!\\s*(${NAME})$`).exec(part))) out[m[1]] = false;
    else if (compare && (m = new RegExp(`^(${NAME})\\s*(>=|<=|==|!=|>|<)\\s*(-?\\d+(?:\\.\\d+)?)$`).exec(part))) out[m[1]] = m[2] + m[3];
    else if ((m = new RegExp(`^(${NAME})\\s*=\\s*(.+)$`).exec(part))) out[m[1]] = toVal(m[2]);
    else out[part] = true;
  }
  return Object.keys(out).length ? out : undefined;
}

export function flagsToStr(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj).map(([k, v]) => {
    if (v === true) return k;
    if (v === false) return `!${k}`;
    if (typeof v === 'string' && CMP.test(v.trim())) return `${k}${v.trim().replace(/\s+/g, '')}`;
    return `${k}=${v}`;
  }).join(', ');
}

export const cleanId = (s) => String(s ?? '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '');

const newNode = (x, y) => ({ text: '', next: '', choices: [], set: '', anim: '', speaker: '', extra: {}, x, y });

export function emptyDoc(name) {
  const label = name.replace(/_+/g, ' ');
  return { name, speaker: label.charAt(0).toUpperCase() + label.slice(1), start: [{ if: '', goto: 'inicio' }], startPos: { x: 20, y: 40 },
    nodes: { inicio: newNode(400, 40) }, extra: {} };
}

export function newNodeId(doc, base = 'nodo') {
  let i = 1;
  while (doc.nodes[`${base}_${i}`]) i++;
  return `${base}_${i}`;
}

export function addNode(doc, x, y, id) {
  const key = id || newNodeId(doc);
  doc.nodes[key] = newNode(Math.round(x), Math.round(y));
  return key;
}

// ---- JSON del juego -> documento ----
export function fromJSON(data = {}, name = 'dialogo') {
  const ed = data.editor ?? {};
  const nodes = {};
  for (const [id, raw] of Object.entries(data.nodes ?? {})) {
    const { text, next, choices, set, anim, speaker, ...extra } = raw ?? {};
    const pos = ed.nodes?.[id];
    nodes[id] = {
      text: Array.isArray(text) ? text.map(String).join('\n\n') : text == null ? '' : String(text),
      next: next ?? '',
      choices: (Array.isArray(choices) ? choices : []).map((c) => {
        const { text: ct, if: cond, next: cn, ...cx } = c ?? {};
        return { text: String(ct ?? ''), if: flagsToStr(cond), next: cn ?? '', extra: cx };
      }),
      set: flagsToStr(set),
      anim: anim === undefined ? '' : anim === '' ? '-' : String(anim), // "-" = volver al idle (en el JSON, "")
      speaker: speaker ?? '',
      extra,
      x: pos?.x, y: pos?.y,
    };
  }
  const { speaker, start, nodes: _n, editor: _e, ...extra } = data;
  const rules = Array.isArray(start)
    ? start.map((r) => ({ if: flagsToStr(r?.if), goto: r?.goto ?? '' }))
    : [{ if: '', goto: start ?? Object.keys(nodes)[0] ?? '' }];
  return { name, speaker: speaker ?? '', start: rules, startPos: ed.start ? { x: ed.start.x, y: ed.start.y } : null, nodes, extra };
}

// ---- documento -> JSON del juego ----
export function toJSON(doc) {
  const out = {};
  if (doc.speaker.trim()) out.speaker = doc.speaker.trim();
  Object.assign(out, doc.extra);
  const rules = doc.start.filter((r) => r.goto);
  if (rules.length === 1 && !rules[0].if.trim()) out.start = rules[0].goto;
  else if (rules.length) out.start = rules.map((r) => { const o = {}; const c = parseFlags(r.if, { compare: true }); if (c) o.if = c; o.goto = r.goto; return o; });

  out.nodes = {};
  for (const [id, n] of Object.entries(doc.nodes)) {
    const o = {};
    const pages = n.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (pages.length === 1) o.text = pages[0]; else if (pages.length > 1) o.text = pages;
    const choices = n.choices.filter((c) => c.text.trim()).map((c) => {
      const o2 = { text: c.text.trim() };
      const cond = parseFlags(c.if, { compare: true });
      if (cond) o2.if = cond;
      if (c.next) o2.next = c.next;
      return Object.assign(o2, c.extra);
    });
    if (choices.length) o.choices = choices; else if (n.next) o.next = n.next;
    const set = parseFlags(n.set);
    if (set) o.set = set;
    const anim = n.anim.trim();
    if (anim) o.anim = anim === '-' ? '' : anim;
    if (n.speaker.trim()) o.speaker = n.speaker.trim();
    out.nodes[id] = Object.assign(o, n.extra);
  }

  const r = (v) => Math.round(v);
  out.editor = { nodes: {} };
  if (doc.startPos) out.editor.start = { x: r(doc.startPos.x), y: r(doc.startPos.y) };
  for (const [id, n] of Object.entries(doc.nodes)) if (Number.isFinite(n.x) && Number.isFinite(n.y)) out.editor.nodes[id] = { x: r(n.x), y: r(n.y) };
  return out;
}

// ---- conexiones ----
// Los nodos a los que apunta un nodo (si tiene opciones, el "next" se ignora: el juego usa las opciones)
export const outs = (n) => (n.choices.some((c) => c.text.trim()) ? n.choices.map((c) => c.next) : [n.next]).filter(Boolean);

export function removeNode(doc, id) {
  delete doc.nodes[id];
  for (const n of Object.values(doc.nodes)) {
    if (n.next === id) n.next = '';
    for (const c of n.choices) if (c.next === id) c.next = '';
  }
  for (const r of doc.start) if (r.goto === id) r.goto = '';
}

// Cambia el nombre de un nodo y todo lo que apunta a él. false si el nombre nuevo ya existe o no sirve.
export function renameNode(doc, oldId, newId) {
  if (!newId || oldId === newId || doc.nodes[newId]) return false;
  const nodes = {};
  for (const [k, v] of Object.entries(doc.nodes)) nodes[k === oldId ? newId : k] = v;
  doc.nodes = nodes;
  for (const n of Object.values(doc.nodes)) {
    if (n.next === oldId) n.next = newId;
    for (const c of n.choices) if (c.next === oldId) c.next = newId;
  }
  for (const r of doc.start) if (r.goto === oldId) r.goto = newId;
  return true;
}

// Avisos: enlaces rotos y nodos a los que no llega nadie
export function problems(doc) {
  const out = [];
  const bad = (from, t) => { if (t && !doc.nodes[t]) out.push(`${from} → «${t}» no existe`); };
  doc.start.forEach((r) => bad('INICIO', r.goto));
  for (const [id, n] of Object.entries(doc.nodes)) { bad(`«${id}»`, n.next); n.choices.forEach((c) => bad(`«${id}»`, c.next)); }
  const seen = new Set();
  const queue = doc.start.map((r) => r.goto).filter((g) => doc.nodes[g]);
  if (!queue.length) out.push('INICIO no apunta a ningún nodo');
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const t of outs(doc.nodes[id])) if (doc.nodes[t] && !seen.has(t)) queue.push(t);
  }
  for (const id of Object.keys(doc.nodes)) if (!seen.has(id)) out.push(`«${id}» no se alcanza desde INICIO`);
  return out;
}

// Acomoda los nodos en columnas según cuántos pasos están del inicio
export function layout(doc, { width = 280, gap = 90 } = {}) {
  const depth = {};
  const queue = [];
  for (const r of doc.start) if (doc.nodes[r.goto] && depth[r.goto] === undefined) { depth[r.goto] = 1; queue.push(r.goto); }
  while (queue.length) {
    const id = queue.shift();
    for (const t of outs(doc.nodes[id])) if (doc.nodes[t] && depth[t] === undefined) { depth[t] = depth[id] + 1; queue.push(t); }
  }
  const last = Math.max(0, ...Object.values(depth)) + 1;
  const colY = {};
  doc.startPos = { x: 20, y: 40 };
  for (const [id, n] of Object.entries(doc.nodes)) {
    const d = depth[id] ?? last;
    colY[d] ??= 40;
    n.x = 20 + d * (width + gap);
    n.y = colY[d];
    const lines = n.text ? n.text.split('\n').length : 1;
    colY[d] += 150 + lines * 16 + n.choices.length * 62 + 30;
  }
}

export const needsLayout = (doc) => !doc.startPos || Object.values(doc.nodes).some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y));
