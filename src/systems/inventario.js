// Inventario del jugador: lo que lleva encima.
//   recursos  madera y lo que se agregue en data/tables/recursos.json  { id: cantidad }
//   muebles   muebles que retiró de la tienda y todavía no puso en su casa (ids de data/muebles.json)  { id: cantidad }
//
// API (la usan la tienda, los árboles y el modo diseño):
//   inv.count('recursos', 'madera')            cantidad
//   inv.add('recursos', 'madera', 3)           suma (respeta el tope "max"); devuelve cuánto sumó realmente
//   inv.remove('muebles', 'mesa', 1)           resta si alcanza; devuelve true/false
//   inv.has({ madera: 5 })                     ¿alcanzan estos recursos?        (costo = { recurso: cantidad })
//   inv.pay({ madera: 5 })                     los descuenta de una sola vez o no toca nada; devuelve true/false
//   inv.onChange((kind, id, delta, total) => …)  avisa cada cambio; devuelve la función para dejar de escuchar
//   inv.open() / close() / toggle()            panel de la mochila (tecla I, o el botón 🎒)
//   inv.snapshot()                             copia { recursos, muebles } (para el Studio y para depurar)
//
// Se guarda en el navegador (localStorage 'coronda.inventario'), igual que los flags y los lotes.
// OJO: no hay cuentas ni servidor que valide, así que un jugador tramposo puede editar sus datos. Cuando haya servidor propio
// (ver README, "Lotes"), solo cambian load() y save(): el resto del juego usa esta misma API.
import { loadJSON } from '../core/assets.js';

const STORE = 'coronda.inventario';
const KINDS = ['recursos', 'muebles'];
const ID_RE = /^[a-z0-9_.-]{1,60}$/i;
const DEFAULT_MAX = 999;

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// opts: stage (donde se dibuja), dev, notify(msg), blocked() (true si algo más usa el teclado: una charla)
export function createInventario({ stage = null, dev = false, notify = () => {}, blocked = () => false } = {}) {
  const app = stage ?? document.querySelector('.app') ?? document.body;
  let data = { recursos: {}, muebles: {} };
  let defs = { recursos: new Map(), muebles: new Map() }; // id -> { nombre, icono, max }
  const listeners = new Set();

  // ---------- Guardado ----------
  function clean(raw) {
    const out = { recursos: {}, muebles: {} };
    for (const kind of KINDS) {
      for (const [id, n] of Object.entries(raw?.[kind] ?? {})) {
        const v = Math.floor(Number(n));
        if (ID_RE.test(id) && v > 0) out[kind][id] = Math.min(v, limit(kind, id));
      }
    }
    return out;
  }
  function load() { try { data = clean(JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { data = clean({}); } }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(data)); } catch { /* modo privado: queda en memoria */ } }
  const limit = (kind, id) => (kind === 'recursos' ? (defs.recursos.get(id)?.max ?? DEFAULT_MAX) : DEFAULT_MAX);

  const ready = Promise.all([
    loadJSON('data/tables/recursos.json').catch(() => ({ recursos: {} })),
    loadJSON('data/muebles.json').catch(() => ({ muebles: [] })),
  ]).then(([r, m]) => {
    defs.recursos = new Map(Object.entries(r.recursos ?? {}).map(([id, x]) => [id, { nombre: x.nombre ?? id, icono: x.icono ?? '•', max: Math.max(1, Number(x.max) || DEFAULT_MAX) }]));
    defs.muebles = new Map((m.muebles ?? []).map((x) => [x.id, { nombre: x.nombre ?? x.id, icono: '🪑', max: DEFAULT_MAX }]));
    load();
    redraw();
  });
  load(); // por si algo lo usa antes de que lleguen las tablas

  // ---------- API ----------
  const kindOk = (kind) => KINDS.includes(kind);
  const count = (kind, id) => (kindOk(kind) ? data[kind][id] ?? 0 : 0);
  function emit(kind, id, delta) { listeners.forEach((f) => { try { f(kind, id, delta, count(kind, id)); } catch (e) { console.error(e); } }); }

  function add(kind, id, n = 1) {
    n = Math.floor(Number(n));
    if (!kindOk(kind) || !ID_RE.test(String(id)) || !(n > 0)) return 0;
    const have = count(kind, id);
    const put = Math.min(n, limit(kind, id) - have);
    if (put <= 0) { notify(`No podés llevar más ${nameOf(kind, id).toLowerCase()}`); return 0; }
    data[kind][id] = have + put;
    save(); emit(kind, id, put); redraw();
    notify(`+${put} ${nameOf(kind, id)}`);
    return put;
  }
  function remove(kind, id, n = 1) {
    n = Math.floor(Number(n));
    if (!kindOk(kind) || !(n > 0) || count(kind, id) < n) return false;
    const left = count(kind, id) - n;
    if (left > 0) data[kind][id] = left; else delete data[kind][id];
    save(); emit(kind, id, -n); redraw();
    return true;
  }
  const has = (costo) => Object.entries(costo ?? {}).every(([id, n]) => count('recursos', id) >= Math.floor(Number(n) || 0));
  function pay(costo) {
    if (!has(costo)) return false;
    for (const [id, n] of Object.entries(costo ?? {})) if (Math.floor(Number(n)) > 0) remove('recursos', id, n);
    return true;
  }
  const nameOf = (kind, id) => defs[kind]?.get(id)?.nombre ?? id;
  const snapshot = () => structuredClone(data);
  function reset() { data = clean({}); save(); redraw(); KINDS.forEach((k) => emit(k, null, 0)); }

  // ---------- Panel ----------
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'inv-btn'; btn.title = 'Mochila (I)'; btn.setAttribute('aria-label', 'Abrir la mochila');
  btn.textContent = '🎒';
  const panel = document.createElement('div');
  panel.className = 'inv-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Mochila');
  app.append(btn, panel);

  function rows(kind) {
    const ids = kind === 'recursos' ? [...defs.recursos.keys()] : Object.keys(data.muebles);
    const list = ids.filter((id) => kind === 'recursos' || data.muebles[id] > 0);
    if (!list.length) return '<li class="inv-empty">Nada por ahora</li>';
    return list.map((id) => {
      const d = defs[kind].get(id);
      return `<li><span class="inv-ico">${esc(d?.icono ?? '•')}</span><span class="inv-name">${esc(d?.nombre ?? id)}</span><b class="inv-n">${count(kind, id)}</b></li>`;
    }).join('');
  }
  function redraw() {
    if (panel.hidden) return;
    panel.innerHTML = `
      <div class="inv-head"><b>Mochila</b><button type="button" class="inv-x" aria-label="Cerrar">✕</button></div>
      <div class="inv-sec">Recursos</div><ul>${rows('recursos')}</ul>
      <div class="inv-sec">Muebles</div><ul>${rows('muebles')}</ul>`;
  }
  const isOpen = () => !panel.hidden;
  function open() { if (blocked()) return; panel.hidden = false; redraw(); }
  function close() { panel.hidden = true; }
  const toggle = () => (isOpen() ? close() : open());

  btn.addEventListener('click', toggle);
  panel.addEventListener('click', (e) => { if (e.target.closest('.inv-x')) close(); });
  addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    if (e.code === 'Escape' && isOpen()) close();
    else if (e.code === 'KeyI' && !dev) toggle(); // en dev.html la I es del inspector: ahí se usa el botón 🎒
  });
  addEventListener('storage', (e) => { if (e.key === STORE) { load(); redraw(); KINDS.forEach((k) => emit(k, null, 0)); } }); // otra pestaña

  const api = {
    ready, count, add, remove, has, pay, snapshot, reset, open, close, toggle, isOpen,
    nameOf, defs: () => defs,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  if (dev && typeof window !== 'undefined') window.inventario = api; // para probar: inventario.add('recursos', 'madera', 20)
  return api;
}
