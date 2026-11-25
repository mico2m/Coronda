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
//                                              en la compu (mouse) es un menú al centro estilo Minecraft, con casilleros;
//                                              en el celular, la lista al costado de siempre
//   inv.snapshot()                             copia { recursos, muebles } (para el Studio y para depurar)
//
// En el servidor (index.html) la mochila la guarda y la decide el SERVIDOR: acá solo se muestra lo que él manda
// (net.onYo). add/remove/pay no hacen nada en ese modo: talar, encargar, retirar o poner muebles se le piden al
// servidor (net.rpc) y él cambia la mochila. Así editar el navegador (F12) no sirve para nada.
// Sin servidor (dev.html, para probar) se guarda en el navegador como antes (localStorage 'coronda.inventario').
//
// Íconos: "icono" de data/tables/recursos.json y data/muebles.json es una imagen (assets/icons/…svg). Con imágenes
// todos ven lo mismo: un emoji nuevo (🪵, 🪑) en un Windows viejo se ve como un cuadrado vacío. iconoHtml() lo dibuja.
import { loadJSON } from '../core/assets.js';

const STORE = 'coronda.inventario';
const KINDS = ['recursos', 'muebles'];
const ID_RE = /^[a-z0-9_.-]{1,60}$/i;
const DEFAULT_MAX = 999;

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICONO_RE = /^assets\/[\w/.-]+\.(svg|png|webp)$/i;
// Ícono de un objeto: imagen si "icono" es un archivo, si no el texto (emoji). Si la imagen no carga: un "?" gris.
export function iconoHtml(icono, nombre = '') {
  if (ICONO_RE.test(String(icono ?? ''))) return `<img class="inv-img" src="${esc(icono)}" alt="${esc(nombre)}" draggable="false" onerror="this.onerror=null;this.src='assets/icons/desconocido.svg'">`;
  return `<span class="inv-emoji">${esc(icono || '•')}</span>`;
}

// opts: stage (donde se dibuja), dev, notify(msg), blocked() (true si algo más usa el teclado: una charla),
//       onOpen() / onClose() (el menú del centro frena al personaje, como una charla)
const FILAS = 9; // casilleros por fila, como el inventario de Minecraft
export function createInventario({ stage = null, dev = false, net = null, notify = () => {}, blocked = () => false, onOpen = () => {}, onClose = () => {} } = {}) {
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
  function load() { if (net) return; try { data = clean(JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { data = clean({}); } }
  function save() { if (net) return; try { localStorage.setItem(STORE, JSON.stringify(data)); } catch { /* modo privado: queda en memoria */ } }
  const limit = (kind, id) => (kind === 'recursos' ? (defs.recursos.get(id)?.max ?? DEFAULT_MAX) : DEFAULT_MAX);

  const ready = Promise.all([
    loadJSON('data/tables/recursos.json').catch(() => ({ recursos: {} })),
    loadJSON('data/muebles.json').catch(() => ({ muebles: [] })),
  ]).then(([r, m]) => {
    defs.recursos = new Map(Object.entries(r.recursos ?? {}).map(([id, x]) => [id, { nombre: x.nombre ?? id, icono: x.icono ?? '•', max: Math.max(1, Number(x.max) || DEFAULT_MAX) }]));
    defs.muebles = new Map((m.muebles ?? []).map((x) => [x.id, { nombre: x.nombre ?? x.id, icono: x.icono ?? 'assets/icons/desconocido.svg', max: DEFAULT_MAX }]));
    load();
    redraw();
  });
  load(); // por si algo lo usa antes de que lleguen las tablas

  // ---------- API ----------
  const kindOk = (kind) => KINDS.includes(kind);
  const count = (kind, id) => (kindOk(kind) ? data[kind][id] ?? 0 : 0);
  function emit(kind, id, delta) { listeners.forEach((f) => { try { f(kind, id, delta, count(kind, id)); } catch (e) { console.error(e); } }); }

  // Mochila del servidor: llega entera cada vez que cambia. Se avisan las diferencias (+2 Madera, etc.)
  function desdeServidor(inv) {
    const antes = data;
    data = clean(inv ?? {});
    for (const kind of KINDS) {
      for (const id of new Set([...Object.keys(antes[kind]), ...Object.keys(data[kind])])) {
        const d = (data[kind][id] ?? 0) - (antes[kind][id] ?? 0);
        if (d) { emit(kind, id, d); if (d > 0 && primeraVez) notify(`+${d} ${nameOf(kind, id)}`); }
      }
    }
    primeraVez = true;
    redraw();
  }
  let primeraVez = false;
  if (net) net.onYo((yo) => ready.then(() => desdeServidor(yo.inv)));

  function add(kind, id, n = 1) {
    if (net) { console.warn('Inventario: la mochila la cambia el servidor.'); return 0; }
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
    if (net) { console.warn('Inventario: la mochila la cambia el servidor.'); return false; }
    n = Math.floor(Number(n));
    if (!kindOk(kind) || !(n > 0) || count(kind, id) < n) return false;
    const left = count(kind, id) - n;
    if (left > 0) data[kind][id] = left; else delete data[kind][id];
    save(); emit(kind, id, -n); redraw();
    return true;
  }
  const has = (costo) => Object.entries(costo ?? {}).every(([id, n]) => count('recursos', id) >= Math.floor(Number(n) || 0));
  function pay(costo) {
    if (net || !has(costo)) return false;
    for (const [id, n] of Object.entries(costo ?? {})) if (Math.floor(Number(n)) > 0) remove('recursos', id, n);
    return true;
  }
  const nameOf = (kind, id) => defs[kind]?.get(id)?.nombre ?? id;
  const snapshot = () => structuredClone(data);
  function reset() { if (net) return; data = clean({}); save(); redraw(); KINDS.forEach((k) => emit(k, null, 0)); }

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
      return `<li><span class="inv-ico">${iconoHtml(d?.icono, d?.nombre ?? id)}</span><span class="inv-name">${esc(d?.nombre ?? id)}</span><b class="inv-n">${count(kind, id)}</b></li>`;
    }).join('');
  }
  // Casilleros estilo Minecraft: solo lo que tenés, y el resto de la fila vacía (mínimo `filas` filas)
  function slots(kind, filas) {
    const ids = Object.keys(data[kind]).filter((id) => data[kind][id] > 0);
    const total = Math.max(filas, Math.ceil(ids.length / FILAS)) * FILAS;
    let html = '';
    for (let i = 0; i < total; i++) {
      const id = ids[i];
      if (!id) { html += '<div class="inv-slot"></div>'; continue; }
      const d = defs[kind].get(id);
      const n = count(kind, id);
      html += `<div class="inv-slot lleno" data-nombre="${esc(d?.nombre ?? id)}" data-n="${n}"><span class="inv-ico">${iconoHtml(d?.icono, d?.nombre ?? id)}</span>${n > 1 ? `<b class="inv-n">${n}</b>` : ''}</div>`;
    }
    return html;
  }
  let central = false; // ¿menú al centro (compu) o lista al costado (celular)?
  const esCompu = () => typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  const tip = document.createElement('div');
  tip.className = 'inv-tip'; tip.hidden = true;
  function redraw() {
    if (panel.hidden) return;
    if (central) {
      panel.innerHTML = `
        <div class="inv-mc" role="document">
          <div class="inv-mc-head"><span>Mochila</span><button type="button" class="inv-x" aria-label="Cerrar">✕</button></div>
          <div class="inv-mc-sec">Recursos</div><div class="inv-grid">${slots('recursos', 1)}</div>
          <div class="inv-mc-sec">Muebles</div><div class="inv-grid">${slots('muebles', 3)}</div>
          <div class="inv-mc-pie">I o Esc para cerrar</div>
        </div>`;
      panel.append(tip);
      tip.hidden = true;
      return;
    }
    panel.innerHTML = `
      <div class="inv-head"><b>Mochila</b><button type="button" class="inv-x" aria-label="Cerrar">✕</button></div>
      <div class="inv-sec">Recursos</div><ul>${rows('recursos')}</ul>
      <div class="inv-sec">Muebles</div><ul>${rows('muebles')}</ul>`;
  }
  const isOpen = () => !panel.hidden;
  function open() {
    if (blocked() || isOpen()) return;
    central = esCompu();
    panel.classList.toggle('inv-central', central);
    panel.hidden = false; redraw();
    if (central) { onOpen(); btn.blur(); }
  }
  function close() {
    if (!isOpen()) return;
    panel.hidden = true; tip.hidden = true;
    if (central) onClose();
  }
  const toggle = () => (isOpen() ? close() : open());

  // Cartelito con el nombre al pasar el mouse por un casillero (como en Minecraft)
  panel.addEventListener('mousemove', (e) => {
    const s = central && e.target.closest?.('.inv-slot.lleno');
    if (!s) { tip.hidden = true; return; }
    tip.textContent = `${s.dataset.nombre} ×${s.dataset.n}`;
    tip.hidden = false;
    const r = panel.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left + 14}px`;
    tip.style.top = `${e.clientY - r.top - 30}px`;
  });
  // El botón y la mochila están dentro de #stage: sin esto, la cámara "agarra" el mouse al apretar
  // (setPointerCapture) y el clic nunca llega al botón; además arrastrar sobre el menú giraría la cámara.
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  panel.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (central && e.target === panel) close(); // clic afuera de la ventana (en lo oscuro): cierra
  });
  panel.addEventListener('wheel', (e) => { if (central) e.stopPropagation(); }, { passive: true }); // la rueda no hace zoom detrás
  // Con el menú del centro abierto, las teclas del juego (moverse, E, saltar…) no llegan al mundo
  addEventListener('keydown', (e) => {
    if (!central || !isOpen() || e.code === 'KeyI' || e.code === 'Escape') return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    e.stopImmediatePropagation(); e.preventDefault();
  }, true);

  btn.addEventListener('click', toggle);
  panel.addEventListener('click', (e) => { if (e.target.closest?.('.inv-x')) close(); });
  addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    if (e.code === 'Escape' && isOpen()) close();
    else if (e.code === 'KeyI' && !dev) toggle(); // en dev.html la I es del inspector: ahí se usa el botón 🎒
  });
  if (!net) addEventListener('storage', (e) => { if (e.key === STORE) { load(); redraw(); KINDS.forEach((k) => emit(k, null, 0)); } }); // otra pestaña

  const api = {
    ready, count, add, remove, has, pay, snapshot, reset, open, close, toggle, isOpen,
    nameOf, defs: () => defs, icono: (kind, id) => iconoHtml(defs[kind]?.get(id)?.icono, nameOf(kind, id)),
    get remoto() { return !!net; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  if (dev && typeof window !== 'undefined') window.inventario = api; // para probar: inventario.add('recursos', 'madera', 20)
  return api;
}
