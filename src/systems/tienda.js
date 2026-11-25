// La Carpintería de Claude: Claude fabrica muebles a cambio de madera.
//
// Edificio: assets/models/objects/tienda.glb (lo genera blender/generar_tienda.py; podés reemplazarlo por el tuyo
// conservando los nombres de los Empties), colocado en data/scenes/coronda_plaza.json > objects.
// Configuración: data/tables/tienda.json · precios y tiempos: data/muebles.json (costo, tiempo_min) ·
// horario: data/tables/tiempo.json > tienda.
//
// Cómo funciona:
//  - Pedidos: le hablás a Claude en el mostrador → "Encargar un mueble" → pagás con madera de la mochila. El pedido
//    entra a la fila (se fabrica por orden de pedido, uno por vez) y ocupa un lugar de la grilla del taller (slot_01…50),
//    donde se ve una caja con tu nombre, el mueble y una barra de progreso. El que se está fabricando se ve en el banco
//    de trabajo (banco_obra), creciendo, y Claude martillando al lado (si nadie lo espera en el mostrador).
//  - Los pedidos son de todo el servidor (se guardan como los lotes: tienda~<id>) y el tiempo sale del reloj de la
//    compu, así todos ven lo mismo sin que nadie "maneje" la fabricación.
//  - Horario: el taller fabrica solo con la Carpintería abierta (tiempo.json > tienda). Un pedido de 10 min pedido a las
//    19:59 sale mañana a las 08:09; la hora de entrega = todo lo que ya está en la fila + lo nuevo, saltando la noche.
//  - Encargar hablando: la IA de Claude entiende "necesito 7 mesas y 4 sillas" y la tienda hace las cuentas (encargoIA):
//    nombres, límite de max_pedidos_por_jugador, lugar en el taller, madera y hora de entrega. Se confirma diciéndole
//    "dale" o con el botón "✅ Confirmar".
//  - Retirar: "Retirar mis pedidos" → uno o "todos", parado en la zona de entrega (Empty zona_entrega, frente al
//    mostrador). Claude va al slot de cada uno, lo trae al mostrador y te lo da (pasa a tu mochila). Si no estás en la
//    zona, te espera un minuto y lo devuelve a su lugar. Mientras tanto nadie más le puede hablar.
//  - Caminos: adentro de la tienda Claude esquiva paredes, mostrador y muebles (A* sobre las col_…, ver ruta()).
//    Si le hablás mientras trabaja en el taller, te contesta desde ahí.
//  - Al cerrar (data/tables/tiempo.json > tienda.cierra), Claude sale a dejar una nota en el buzón de cada dueño con
//    pedidos listos (lote_X_buzon, o delante del lote si la casa no tiene buzón). Si se le hace tarde
//    (reparto_horas), vuelve y sigue al día siguiente. Sin casa, no hay nota: hay que pasar a preguntar.
//  - Si no avanzás la charla en inactividad_seg segundos, se corta y tenés que esperar espera_seg para volver.
//
// Los movimientos de Claude los decide el juego que lo "maneja" (ver claude-npc.js) y los demás los ven.
// API para el resto del juego y el Studio:
//   tienda.point('pos_mostrador') -> { x, y, z, yaw }    tienda.slots()   tienda.pedidos()  (snapshot)
//   tienda.dynamic(entry, nombre)  (nodos de diálogo armados en el momento)   tienda.idle(entry)
import * as THREE from 'three';
import { loadJSON } from '../core/assets.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const ID_RE = /^[a-z0-9_]+$/i;
const esc = (t) => String(t ?? '');
const norm = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function createTienda({ stage = null, getRoot, net = null, claude = null, inventario = null, tiempo = null, lotes = null, casas = null,
  myName = 'Viajero', myUid = 'yo', getPlayer = () => null, getSceneId = () => null, notify = () => {} } = {}) {
  let cfg = { id: 'tienda', zona: [5, 10], techo: 'techo', inactividad_seg: 20, espera_seg: 5, reparto_horas: 3, max_pedidos_por_jugador: 5 };
  loadJSON('data/tables/tienda.json').then((c) => { cfg = { ...cfg, ...c }; }).catch(() => {});
  const catalog = new Map(); // id -> { id, nombre, costo, tiempo_min, caja, archivo }
  loadJSON('data/muebles.json').then((d) => { for (const m of d?.muebles ?? []) if (m?.id) catalog.set(m.id, m); }).catch(() => {});

  // ---------- Edificio: techo y puntos ----------
  let root = null, spot = null, roofs = [];
  const points = new Map(); // nombre -> Object3D
  function find() {
    const r = getRoot?.() ?? null;
    if (r !== root) { root = r; spot = null; roofs = []; points.clear(); clearVisuals(); grid = null; }
    if (!root) return null;
    spot ??= root.getObjectByName(cfg.id) ?? null;
    // el modelo se carga después de colocar el objeto: se vuelve a buscar hasta que aparezcan sus partes
    if (spot && !points.size && spot.children.length) {
      const roofRe = new RegExp(`^${cfg.techo}`, 'i');
      spot.traverse((o) => {
        if (!o.name) return;
        if (roofRe.test(o.name)) roofs.push(o);
        else if (/^(pos_|cola_|slot_|banco_obra|zona_)/.test(o.name)) points.set(o.name, o);
      });
    }
    return spot;
  }
  function point(name) {
    find();
    const o = points.get(name);
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    const w = o.getWorldPosition(new THREE.Vector3());
    _e.setFromQuaternion(o.getWorldQuaternion(_q), 'YXZ');
    return { x: w.x, y: w.y, z: w.z, yaw: _e.y };
  }
  function slots() {
    find();
    return [...points.keys()].filter((k) => k.startsWith('slot_')).sort().map((k) => ({ n: Number(k.slice(5)), ...point(k) }));
  }
  const ready = () => !!find() && points.size > 0;

  // ---------- Zona de entrega: para retirar hay que estar parado frente al mostrador ----------
  // Empty "zona_entrega" del modelo (caja: Display As = Cube, Size = 1, escalada). Sin ese Empty: 2,5 m de pos_cliente.
  const _zv = new THREE.Vector3(), _zm = new THREE.Matrix4();
  function enMostrador(pos) {
    if (!pos || !find()) return false;
    const z = points.get('zona_entrega');
    if (z) {
      z.updateWorldMatrix(true, false);
      _zv.set(pos.x, 0, pos.z).applyMatrix4(_zm.copy(z.matrixWorld).invert());
      return Math.abs(_zv.x) <= 1 && Math.abs(_zv.z) <= 1;
    }
    const pc = point('pos_cliente');
    return !!pc && Math.hypot(pos.x - pc.x, pos.z - pc.z) < 2.5;
  }
  function posDe(u) {
    if (u === myUid) return getPlayer()?.position ?? null;
    const r = net?.roster?.().find((x) => x.u === u);
    return r?.p ? { x: r.p[0], z: r.p[2] } : null;
  }

  // ---------- Caminos adentro de la tienda: Claude no atraviesa paredes, mostrador ni muebles ----------
  // Grilla de 25 cm en el espacio de la tienda, armada con sus cajas col_… (las que tocan la altura de una persona),
  // agrandadas por el ancho de Claude. A* entre las dos puntas y después se sacan los puntos que sobran. Sirve con
  // cualquier modelo de tienda que tenga sus col_… (ver blender/generar_tienda.py). Lo usa claude-npc.js (nav).
  const CELL = 0.25, RADIO = 0.35, MARGEN = 3; // margen: metros de afuera que entran en la grilla (la puerta)
  let grid = null;
  function buildGrid() {
    if (!find() || !spot.children.length) return null;
    spot.updateMatrixWorld(true);
    const inv = spot.matrixWorld.clone().invert();
    const boxes = [];
    spot.traverse((o) => {
      if (!/^col_/i.test(o.name ?? '') || !o.isMesh) return;
      const b = new THREE.Box3().setFromObject(o).applyMatrix4(inv);
      if (b.max.y > 0.25 && b.min.y < 1.7) boxes.push(b); // piso y dinteles no cuentan
    });
    if (!boxes.length) return null;
    const ext = new THREE.Box3(); boxes.forEach((b) => ext.union(b));
    const x0 = ext.min.x - MARGEN, z0 = ext.min.z - MARGEN;
    const w = Math.ceil((ext.max.x - ext.min.x + 2 * MARGEN) / CELL), h = Math.ceil((ext.max.z - ext.min.z + 2 * MARGEN) / CELL);
    const bloq = new Uint8Array(w * h);
    for (const b of boxes) {
      const i0 = Math.max(0, Math.floor((b.min.x - RADIO - x0) / CELL)), i1 = Math.min(w - 1, Math.floor((b.max.x + RADIO - x0) / CELL));
      const j0 = Math.max(0, Math.floor((b.min.z - RADIO - z0) / CELL)), j1 = Math.min(h - 1, Math.floor((b.max.z + RADIO - z0) / CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) bloq[j * w + i] = 1;
    }
    return { x0, z0, w, h, bloq, inv, mat: spot.matrixWorld.clone(), area: ext };
  }
  const _l = new THREE.Vector3();
  function aLocal(x, z) { _l.set(x, 0, z).applyMatrix4(grid.inv); return { x: _l.x, z: _l.z }; }
  function aMundo(x, z) { _l.set(x, 0, z).applyMatrix4(grid.mat); return { x: _l.x, z: _l.z }; }
  const celda = (p) => ({ i: Math.floor((p.x - grid.x0) / CELL), j: Math.floor((p.z - grid.z0) / CELL) });
  const dentro = (c) => c.i >= 0 && c.j >= 0 && c.i < grid.w && c.j < grid.h;
  const libre = (c) => dentro(c) && !grid.bloq[c.j * grid.w + c.i];
  // la celda libre más cercana (si el punto cae justo pegado a una pared)
  function soltar(c) {
    if (libre(c)) return c;
    for (let rr = 1; rr <= 6; rr++) for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
      const n = { i: c.i + di, j: c.j + dj };
      if (libre(n)) return n;
    }
    return null;
  }
  function vista(a, b) { // ¿se puede ir en línea recta de a a b (celdas)?
    const n = Math.ceil(Math.hypot(b.i - a.i, b.j - a.j) * 2);
    for (let k = 1; k < n; k++) if (!libre({ i: Math.round(a.i + ((b.i - a.i) * k) / n), j: Math.round(a.j + ((b.j - a.j) * k) / n) })) return false;
    return true;
  }
  function astar(a, b) {
    const W = grid.w, N = W * grid.h, key = (c) => c.j * W + c.i;
    const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), shut = new Uint8Array(N);
    const open = [key(a)]; g[key(a)] = 0;
    const hf = (k) => Math.hypot((k % W) - b.i, Math.floor(k / W) - b.j);
    const goal = key(b);
    for (let it = 0; open.length && it < 20000; it++) {
      let bi = 0; for (let q = 1; q < open.length; q++) if (g[open[q]] + hf(open[q]) < g[open[bi]] + hf(open[bi])) bi = q;
      const k = open.splice(bi, 1)[0];
      if (k === goal) break;
      if (shut[k]) continue; shut[k] = 1;
      const ci = k % W, cj = Math.floor(k / W);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const n = { i: ci + di, j: cj + dj };
        if (!libre(n) || (di && dj && (!libre({ i: ci + di, j: cj }) || !libre({ i: ci, j: cj + dj })))) continue; // sin cortar esquinas
        const nk = key(n), ng = g[k] + (di && dj ? 1.4142 : 1);
        if (ng < g[nk]) { g[nk] = ng; from[nk] = k; if (!shut[nk]) open.push(nk); }
      }
    }
    if (from[goal] < 0 && goal !== key(a)) return null;
    const path = []; for (let k = goal; k >= 0; k = from[k]) path.unshift({ i: k % W, j: Math.floor(k / W) });
    // sacar los puntos que sobran (si se ve el siguiente en línea recta, se saltea)
    const out = [path[0]];
    for (let q = 1; q < path.length; q++) if (q === path.length - 1 || !vista(out.at(-1), path[q + 1])) out.push(path[q]);
    return out;
  }
  // Camino para ir de `de` a `a` (mundo): puntos intermedios (mundo) o null si no hace falta (afuera, o en línea recta)
  function ruta(de, a) {
    if (!grid) { grid = buildGrid(); if (!grid) return null; }
    const la = aLocal(de.x, de.z), lb = aLocal(a.x, a.z);
    const ca = celda(la), cb = celda(lb);
    if (!dentro(ca) && !dentro(cb)) return null; // lejos de la tienda: camino libre
    const sa = soltar(ca), sb = soltar(cb);
    if (!sa || !sb || vista(sa, sb)) return null;
    const p = astar(sa, sb);
    if (!p) return null;
    return p.slice(1, -1).map((c) => aMundo(grid.x0 + (c.i + 0.5) * CELL, grid.z0 + (c.j + 0.5) * CELL));
  }
  if (claude) claude.nav = (de, a) => { try { return ruta(de, a); } catch { return null; } };

  // ---------- Pedidos ----------
  // { id, u, n (nombre), m (mueble), t (cuándo se pidió, ms), d (duración ms), s (slot 1..50), aviso (nota dejada) }
  const orders = new Map();
  const SOLO_KEY = 'coronda.tienda.solo';
  let plan = [], planAt = 0; // la fila calculada (ver schedule)
  // Va antes de cargar los pedidos: accept() ya calcula la fila, que usa el horario (ver hor() más abajo)
  let horario = null; // { abre, cierra } (tiempo.config hace una copia cada vez: se guarda acá)
  tiempo?.onConfig?.(() => { horario = null; planAt = 0; });
  function cleanOrder(id, r) {
    if (!r || typeof r !== 'object' || !ID_RE.test(String(r.m ?? ''))) return null;
    const t = Number(r.t), d = Number(r.d), s = Math.round(Number(r.s));
    if (!Number.isFinite(t) || !(d > 0) || !(s >= 1 && s <= 99)) return null;
    return { id, u: String(r.u ?? '').slice(0, 40), n: String(r.n ?? 'alguien').slice(0, 24), m: String(r.m), t, d: Math.min(d, 24 * 3600e3), s, aviso: !!r.aviso, ...(r.h ? { h: 1 } : {}) };
  }
  function accept(id, r) {
    const o = r ? cleanOrder(id, r) : null;
    if (o) orders.set(id, o); else orders.delete(id);
    changed();
  }
  function save(o) {
    if (net?.tienda) { net.tienda.send({ k: o.id, r: o }); net.tienda.persist(o.id, o); }
    else saveSolo();
  }
  function drop(id) {
    orders.delete(id);
    if (net?.tienda) { net.tienda.send({ k: id, r: null }); net.tienda.persist(id, null); }
    else saveSolo();
    changed();
  }
  function saveSolo() { try { localStorage.setItem(SOLO_KEY, JSON.stringify([...orders.values()])); } catch { /* nada */ } }
  if (net?.tienda) {
    const C = net.tienda;
    const { messages, saved } = C.take();
    C.onMessage = (d) => { if (d?.k) accept(String(d.k), d.r); };
    C.onPersisted = (k, d) => accept(k, d);
    messages.forEach(({ data }) => data?.k && accept(String(data.k), data.r));
    saved.forEach(([k, d]) => accept(k, d));
  } else {
    try { for (const r of JSON.parse(localStorage.getItem(SOLO_KEY)) ?? []) if (r?.id) accept(r.id, r); } catch { /* nada */ }
  }

  // ---------- Horario del taller: solo se trabaja con la Carpintería abierta ----------
  // Los pedidos con h (todos los nuevos) avanzan solo de tienda.abre a tienda.cierra (data/tables/tiempo.json, hora del
  // juego): uno que tarda 10 minutos, pedido 1 minuto antes del cierre, termina 9 minutos después de abrir al día
  // siguiente. Los pedidos viejos (sin h) siguen como antes, así ninguno que ya estaba listo vuelve atrás.
  function hor() { if (tiempo && !horario) horario = tiempo.config.tienda; return horario; }
  function abiertaEn(t) { const h = hor(); return !h || tiempo.enRango(tiempo.hora(t), h.abre, h.cierra); }
  function proximaApertura(t) { const h = hor(); return !h || abiertaEn(t) ? t : t + tiempo.hastaHora(h.abre, t); }
  // Cuándo termina un trabajo de `dur` ms que arranca en `t`, saltando las horas en que está cerrada
  function sumarTrabajo(t, dur) {
    const h = hor();
    if (!h) return t + dur;
    let now = proximaApertura(t), left = dur;
    for (let i = 0; left > 0 && i < 400; i++) {
      const paso = Math.min(left, tiempo.hastaHora(h.cierra, now));
      now += paso; left -= paso;
      if (left > 0) now = proximaApertura(now + 1);
    }
    return now;
  }
  // ms de taller abierto entre a y b
  function trabajoEntre(a, b) {
    const h = hor();
    if (!h) return Math.max(0, b - a);
    let now = a, total = 0;
    for (let i = 0; now < b && i < 400; i++) {
      if (!abiertaEn(now)) { now = Math.min(b, now + tiempo.hastaHora(h.abre, now)); continue; }
      const fin = Math.min(b, now + tiempo.hastaHora(h.cierra, now));
      total += fin - now; now = fin;
    }
    return total;
  }

  // Fila: por orden de pedido, uno por vez. Cada uno empieza cuando termina el anterior (o cuando se pidió).
  function schedule() {
    const list = [...orders.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
    let end = 0;
    plan = list.map((o, i) => {
      const desde = Math.max(o.t, end);
      const start = o.h ? proximaApertura(desde) : desde;
      end = o.h ? sumarTrabajo(start, o.d) : start + o.d;
      return { ...o, start, end, pos: i + 1 };
    });
    planAt = Date.now();
  }
  function changed() { schedule(); }
  function info(o, now = Date.now()) {
    const hecho = o.h ? trabajoEntre(o.start, Math.min(now, o.end)) : now - o.start;
    const p = Math.min(1, Math.max(0, hecho / o.d));
    return { ...o, progreso: p, listo: now >= o.end, fabricando: now >= o.start && now < o.end };
  }
  // Cuándo estarían listos muebles nuevos (lista de { m, d }) si se piden ahora: después de toda la fila
  function estimar(lista, now = Date.now()) {
    if (now - planAt > 1000) schedule();
    let end = plan.reduce((x, o) => Math.max(x, o.end), now);
    return lista.map((x) => { end = sumarTrabajo(Math.max(now, end), x.d); return { ...x, end }; });
  }
  function pedidos(now = Date.now()) { if (now - planAt > 1000) schedule(); return plan.map((o) => info(o, now)); }
  const mine = () => pedidos().filter((o) => o.u === myUid);
  const nombre = (m) => catalog.get(m)?.nombre ?? m;
  const costoTxt = (c) => Object.entries(c ?? {}).map(([k, v]) => `${v} ${k}`).join(' + ') || 'nada';
  // "a las 15:30" / "mañana a las 08:09" / "pasado mañana a las 10:00" (hora del juego)
  function cuando(t, now = Date.now()) {
    if (!tiempo) return '';
    const dd = tiempo.dia(t) - tiempo.dia(now), hh = tiempo.texto(tiempo.hora(t));
    return dd <= 0 ? `a las ${hh}` : dd === 1 ? `mañana a las ${hh}` : dd === 2 ? `pasado mañana a las ${hh}` : `en ${dd} días, a las ${hh}`;
  }
  const horaFin = (o) => cuando(o.end);
  // Hora de un pedido nuevo: siempre después del último (dos en el mismo milisegundo no se cruzan en la fila)
  function nuevaHora() { let t = Date.now(); for (const o of orders.values()) if (o.t >= t) t = o.t + 1; return t; }
  function freeSlot() {
    const used = new Set(pedidos().map((o) => o.s));
    const n = Math.max(1, slots().length || 50);
    for (let i = 1; i <= n; i++) if (!used.has(i)) return i;
    return 0;
  }
  function hasLot(u) { return (lotes?.list ?? []).some((sp) => lotes.record(sp.key)?.o === u); }
  function lotOf(u) { return (lotes?.list ?? []).find((sp) => lotes.record(sp.key)?.o === u) ?? null; }

  // ---------- Lo que se ve: slots, banco de trabajo, lo que lleva Claude ----------
  const group = new THREE.Group(); group.name = 'tienda:pedidos';
  const vis = new Map(); // id -> { g, label, key }
  let bench = null, benchKey = '', carried = null, carriedKey = '';
  const models = new Map(); // mueble -> Promise<Object3D> (plantilla)
  function model(m) {
    if (!models.has(m)) models.set(m, (casas?.modelo ? casas.modelo(m) : Promise.reject()).catch(() => {
      const [w, h, d] = catalog.get(m)?.caja ?? [0.8, 0.8, 0.8];
      const g = new THREE.Group();
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: 0xb98a55 }));
      b.position.y = h / 2; g.add(b); return g;
    }));
    return models.get(m).then((t) => fit(t.clone(true), 0.9));
  }
  // Achica (o agranda) el modelo para que entre en un cubo de `size` metros, apoyado en el piso
  function fit(obj, size) {
    const box = new THREE.Box3().setFromObject(obj);
    const s = box.getSize(_v);
    const k = size / Math.max(s.x, s.y, s.z, 0.01);
    const holder = new THREE.Group();
    obj.position.set(-(box.min.x + box.max.x) / 2 * k, -box.min.y * k, -(box.min.z + box.max.z) / 2 * k);
    obj.scale.setScalar(k);
    holder.add(obj);
    return holder;
  }
  const crateGeo = new THREE.BoxGeometry(0.7, 0.55, 0.7);
  const crateMat = new THREE.MeshBasicMaterial({ color: 0x9c6b3c });
  const crateEdge = new THREE.EdgesGeometry(crateGeo);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x4a3018 });
  function crate() {
    const g = new THREE.Group();
    const m = new THREE.Mesh(crateGeo, crateMat); m.position.y = 0.275;
    const e = new THREE.LineSegments(crateEdge, edgeMat); e.position.y = 0.275;
    g.add(m, e); return g;
  }
  // Cartelito sobre cada pedido: nombre, mueble y barra de progreso (se redibuja solo cuando cambia)
  function label() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 96;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
    sp.scale.set(1.15, 0.43, 1); sp.position.y = 1.55; sp.renderOrder = 3;
    sp.userData.canvas = c;
    return sp;
  }
  function drawLabel(sp, o) {
    const c = sp.userData.canvas, x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    x.fillStyle = 'rgba(12,20,26,0.86)'; roundRect(x, 2, 2, 252, 92, 14); x.fill();
    x.fillStyle = '#f6f9fa'; x.font = '600 26px system-ui, sans-serif'; x.textAlign = 'center';
    x.fillText(o.n.slice(0, 16), 128, 32);
    x.fillStyle = '#c9d4d8'; x.font = '500 20px system-ui, sans-serif';
    x.fillText(`${nombre(o.m)}${o.listo ? ' · listo' : o.fabricando ? ` · ${Math.round(o.progreso * 100)}%` : ` · en fila (#${o.pos})`}`, 128, 58);
    x.fillStyle = 'rgba(255,255,255,0.18)'; roundRect(x, 24, 68, 208, 14, 7); x.fill();
    x.fillStyle = o.listo ? '#5eead4' : '#ffd36e'; roundRect(x, 24, 68, Math.max(14, 208 * o.progreso), 14, 7); x.fill();
    sp.material.map.needsUpdate = true;
  }
  function roundRect(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
  function clearVisuals() {
    group.removeFromParent();
    for (const v of vis.values()) v.label.material.map.dispose();
    vis.clear(); group.clear();
    bench = null; benchKey = ''; carried = null; carriedKey = '';
  }
  let visT = 0;
  function drawVisuals(dt) {
    if (!ready()) return;
    if (group.parent !== root) root.add(group);
    visT -= dt;
    const list = pedidos();
    const live = new Set();
    for (const o of list) {
      live.add(o.id);
      let v = vis.get(o.id);
      const p = point(`slot_${String(o.s).padStart(2, '0')}`);
      if (!p) continue;
      if (!v) { v = { g: new THREE.Group(), label: label(), key: '', body: null, kind: '' }; v.g.add(v.label); group.add(v.g); vis.set(o.id, v); }
      v.g.position.set(p.x, p.y, p.z);
      const kind = o.listo ? 'mueble' : 'caja';
      if (kind !== v.kind) {
        v.kind = kind;
        if (v.body) v.g.remove(v.body);
        v.body = null;
        if (kind === 'caja') { v.body = crate(); v.g.add(v.body); }
        else model(o.m).then((m) => { if (v.kind === 'mueble' && !v.body) { v.body = m; v.g.add(m); } });
      }
      const key = `${o.n}|${o.listo}|${o.fabricando}|${Math.round(o.progreso * 50)}|${o.pos}`;
      if (key !== v.key) { v.key = key; drawLabel(v.label, o); }
    }
    for (const [id, v] of vis) if (!live.has(id)) { group.remove(v.g); v.label.material.map.dispose(); vis.delete(id); }
    // Banco de trabajo: el mueble que se está fabricando, creciendo con el progreso
    const now = list.find((o) => o.fabricando);
    const bp = point('banco_obra');
    if (bp) {
      const want = now ? `${now.id}` : '';
      if (want !== benchKey) {
        benchKey = want;
        if (bench) { group.remove(bench); bench = null; }
        if (now) model(now.m).then((m) => { if (benchKey === want) { bench = m; group.add(m); } });
      }
      if (bench && now) {
        bench.position.set(bp.x, bp.y, bp.z);
        bench.scale.setScalar(0.3 + 0.7 * now.progreso);
      }
    }
    // Lo que lleva Claude en los brazos
    const c = claude?.carry ?? '';
    const holder = claude?.entry?.holder;
    if (c !== carriedKey) {
      carriedKey = c;
      if (carried) { group.remove(carried); carried = null; }
      if (c) model(c).then((m) => { if (carriedKey === c) { carried = m; carried.scale.setScalar(0.7); group.add(m); } });
    }
    if (carried && holder) {
      const yaw = holder.rotation.y;
      carried.position.set(holder.position.x + Math.sin(yaw) * 0.45, holder.position.y + 0.55, holder.position.z + Math.cos(yaw) * 0.45);
      carried.rotation.y = yaw;
    }
  }

  // ---------- Notas en los buzones ----------
  const notes = new Map(); // lotKey -> Mesh
  const noteGeo = new THREE.PlaneGeometry(0.28, 0.2);
  const noteMat = new THREE.MeshBasicMaterial({ color: 0xfffbe8, side: THREE.DoubleSide });
  function mailbox(lotKey) {
    // 1) un objeto lote_X_buzon en la escena (el buzón de la casa, ver lotes.js); 2) delante del lote
    const nro = /(\d+)\s*$/.exec(lotKey)?.[1];
    if (root && nro) {
      const o = root.getObjectByName(`lote_${Number(nro)}_buzon`) ?? root.getObjectByName(`lote_${nro}_buzon`);
      if (o) { o.updateWorldMatrix(true, false); const w = o.getWorldPosition(new THREE.Vector3()); return { x: w.x, y: w.y, z: w.z, real: true }; }
    }
    const info = lotes?.spotInfo?.(lotKey);
    if (!info) return null;
    const q = new THREE.Quaternion().fromArray(info.quat);
    const out = new THREE.Vector3(0, 0, 1).applyQuaternion(q).setY(0).normalize();
    const dist = Math.abs(info.size?.[2] || 6) / 2 + 1.2;
    return { x: info.pos[0] + out.x * dist, y: info.pos[1], z: info.pos[2] + out.z * dist, real: false };
  }
  function drawNotes() {
    if (!root) return;
    const want = new Map(); // lotKey -> [pedidos]
    for (const o of pedidos()) {
      if (!o.aviso || !o.listo) continue;
      const lot = lotOf(o.u);
      if (lot) { if (!want.has(lot.key)) want.set(lot.key, []); want.get(lot.key).push(o); }
    }
    for (const [k, m] of notes) if (!want.has(k)) { m.removeFromParent(); notes.delete(k); }
    for (const k of want.keys()) {
      if (notes.has(k)) continue;
      const b = mailbox(k);
      if (!b) continue;
      const m = new THREE.Mesh(noteGeo, noteMat);
      m.position.set(b.x, (b.real ? b.y + 1.15 : b.y + 0.9), b.z);
      m.rotation.set(-0.3, Math.random() * 6, 0);
      m.name = `nota:${k}`;
      root.add(m);
      notes.set(k, m);
    }
    return want;
  }
  // Leer la nota de tu buzón: E cerca
  const notePrompt = document.createElement('button');
  notePrompt.type = 'button'; notePrompt.className = 'door-prompt nota-prompt'; notePrompt.hidden = true;
  notePrompt.innerHTML = '<kbd>E</kbd> Leer la nota del buzón';
  let myNote = null;
  function readNote() {
    if (!myNote) return;
    const ms = myNote.map((o) => nombre(o.m)).join(', ');
    notify(`📬 Nota de Claude: "¡Tu pedido está listo! (${ms}). Pasá a retirarlo por la Carpintería."`);
  }
  notePrompt.addEventListener('click', readNote);
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE' || e.repeat || notePrompt.hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    e.preventDefault(); e.stopImmediatePropagation(); readNote();
  }, true);
  let stageEl = null;
  function attachPrompt() { if (!stageEl) { stageEl = stage ?? document.getElementById('stage') ?? document.body; stageEl.appendChild(notePrompt); } }

  // ---------- Claude: qué hace (solo el juego que lo maneja) ----------
  const jobs = []; // { u, n, ids: [] }
  let doing = null; // 'buscar' | 'reparto' | null
  let at = '';      // dónde lo mandé por última vez (para no repetir)
  let repartoDia = -1;
  if (claude) {
    claude.onTienda = (d) => {
      if (d.tipo === 'buscar' && Array.isArray(d.ids)) {
        const ids = d.ids.map(String).filter((id) => orders.get(id)?.u === d.u).slice(0, 20);
        if (ids.length && !jobs.some((j) => j.u === d.u)) { jobs.push({ u: String(d.u), n: String(d.n ?? ''), ids }); claude.holdTalk(String(d.u), d.n); }
      }
    };
    claude.onTiendaMsg = (d) => {
      if (d?.tipo === 'entregado' && d.u === myUid && orders.has(d.id)) {
        const o = orders.get(d.id);
        inventario?.add('muebles', o.m, 1);
        drop(d.id);
        notify(`Claude te dio: ${nombre(o.m)} (ya está en tu mochila 🎒)`);
      }
    };
  }
  const walk = (p, opts) => claude.walkTo(p.x, p.z, opts);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Mira hacia: desde el mostrador, al cliente; en el taller, al banco
  const LOOK = { pos_mostrador: 'pos_cliente', pos_taller: 'banco_obra' };
  async function goPoint(name, opts = {}) {
    const p = point(name);
    if (!p) return false;
    at = name;
    const t = LOOK[name] && point(LOOK[name]);
    await walk(p, { face: t ? Math.atan2(t.x - p.x, t.z - p.z) : null, ...opts });
    return true;
  }
  async function runJob(job) {
    doing = 'buscar';
    for (const id of job.ids) {
      const o = orders.get(id);
      if (!o) continue;
      const sp = point(`slot_${String(o.s).padStart(2, '0')}`);
      if (!sp) continue;
      if (at !== 'pos_taller') await goPoint('pos_taller');
      at = 'slot';
      await walk(sp, { near: 0.7 });
      claude.play('talk'); await wait(700);
      claude.setCarry(o.m);
      await goPoint('pos_taller');
      await goPoint('pos_mostrador');
      // Lo da solo si el cliente está en la zona de entrega: lo espera hasta 60 s; si no vuelve, lo deja en su lugar
      let espera = 0;
      while (!enMostrador(posDe(job.u)) && espera < 60000) { await wait(500); espera += 500; }
      if (!enMostrador(posDe(job.u))) {
        claude.play(null);
        await goPoint('pos_taller'); at = 'slot';
        await walk(sp, { near: 0.7 });
        claude.setCarry('');
        await goPoint('pos_taller');
        break; // el resto queda listo para la próxima
      }
      claude.setCarry('');
      claude.play('talk');
      claude.tiendaMsg({ tipo: 'entregado', id, u: job.u });
      await wait(900);
    }
    claude.releaseTalk(job.u);
    doing = null;
  }
  async function runReparto() {
    doing = 'reparto';
    const dueños = new Map(); // u -> [pedidos]
    for (const o of pedidos()) if (o.listo && !o.aviso && hasLot(o.u)) { if (!dueños.has(o.u)) dueños.set(o.u, []); dueños.get(o.u).push(o); }
    if (dueños.size) {
      await goPoint('pos_entrada'); await goPoint('pos_afuera');
      for (const [u, list] of dueños) {
        if (!enReparto()) break; // se le hizo tarde: vuelve y sigue mañana
        const lot = lotOf(u); const b = lot && mailbox(lot.key);
        if (!b) continue;
        at = 'buzon';
        await walk(b, { near: 0.9, speed: 2.6 });
        claude.play('talk'); await wait(1200);
        for (const o of list) { const r = orders.get(o.id); if (r) { r.aviso = true; save(r); } }
        changed();
      }
      await goPoint('pos_afuera', { speed: 2.6 }); await goPoint('pos_entrada');
    }
    repartoDia = tiempo?.dia() ?? 0;
    doing = null;
  }
  function enReparto() {
    if (!tiempo) return false;
    const c = tiempo.config.tienda.cierra;
    return tiempo.enRango(tiempo.hora(), c, (c + Number(cfg.reparto_horas || 3)) % 24);
  }
  let thinkT = 0;
  function think(dt) {
    if (claude?.busyByAI) at = ''; // la IA lo mandó a otro lado: después vuelve a su puesto
    if (!claude?.driving || !claude.entry || claude.busyByAI || !ready()) return;
    if ((thinkT -= dt) > 0 || doing) return;
    thinkT = 0.5;
    if (jobs.length) { runJob(jobs.shift()).catch(() => { doing = null; }); return; }
    const abierta = tiempo ? tiempo.abierta() : true;
    const talking = claude.talkingWith;
    if (!abierta && enReparto() && repartoDia !== tiempo.dia() && !talking) { runReparto().catch(() => { doing = null; }); return; }
    // Si le hablan mientras trabaja en el taller, contesta desde ahí: no camina al mostrador (ni vuelve después)
    if (talking && at === 'pos_taller') return;
    // ¿Alguien esperando en el mostrador? (o hablándole)
    const pc = point('pos_cliente');
    const waiting = talking || (pc && (net ? net.roster() : [{ me: true }]).some((r) => {
      const pos = r.me ? getPlayer()?.position : r.p && { x: r.p[0], z: r.p[2] };
      return pos && Math.hypot(pos.x - pc.x, pos.z - pc.z) < 3.5;
    }));
    const working = abierta && pedidos().some((o) => o.fabricando);
    if (waiting || !working) {
      if (at !== 'pos_mostrador') { doing = 'ir'; goPoint('pos_mostrador').then(() => { doing = null; claude.play(null); }); }
    } else if (at !== 'pos_taller') {
      doing = 'ir'; goPoint('pos_taller').then(() => { doing = null; claude.play('work'); });
    } else if (claude.entry.current?.getClip?.().name !== 'work') claude.play('work');
  }

  // ---------- Charla: nodos armados en el momento (ver dialogue.js > hooks.dynamic) ----------
  const back = [{ text: 'Otra cosa', next: 'tienda' }, { text: 'Chau', next: 'despedida' }];
  function textNode(text, choices = back) { return { nodes: { __t: { text, choices } }, start: '__t' }; }
  async function dynamic(entry, name) {
    if (entry?.id !== 'claude') return null;
    const [cmd, arg] = name.split(':');
    const abierta = tiempo ? tiempo.abierta() : true;
    if (cmd === 'tienda_menu') {
      if (!abierta) {
        const abre = tiempo ? `${String(tiempo.config.tienda.abre).padStart(2, '0')}:00` : 'mañana';
        const listos = mine().filter((o) => o.listo);
        return textNode(`La Carpintería está cerrada. Abrimos a las ${abre}.${listos.length ? ' Tus pedidos listos te esperan acá, ¡pasá cuando abra!' : ''}`,
          [{ text: 'Charlar un rato', next: 'menu' }, { text: 'Chau', next: 'despedida' }]);
      }
      const mis = mine(), listos = mis.filter((o) => o.listo);
      const choices = [{ text: 'Encargar un mueble', next: '__cat' }];
      if (listos.length) choices.push({ text: `Retirar mis pedidos (${listos.length} listo${listos.length > 1 ? 's' : ''})`, next: '__ret' });
      if (mis.length) choices.push({ text: 'Ver mis pedidos', next: '__mis' });
      choices.push({ text: 'Charlar', next: 'menu' }, { text: 'Chau', next: 'despedida' });
      const madera = inventario?.count?.('recursos', 'madera') ?? 0;
      return { nodes: { __tm: { text: `¡Bienvenido a la Carpintería! Tenés ${madera} de madera. ¿Qué necesitás?`, choices },
        __cat: { dinamico: 'catalogo' }, __ret: { dinamico: 'retirar' }, __mis: { dinamico: 'mis' } }, start: '__tm' };
    }
    if (cmd === 'catalogo') {
      const list = [...catalog.values()].filter((m) => m.costo);
      const nodes = {};
      const choices = list.slice(0, 7).map((m) => {
        nodes[`__c_${m.id}`] = { text: `${m.nombre}: te sale ${costoTxt(m.costo)} y tardo unos ${m.tiempo_min ?? '?'} minutos. ¿Te la hago?`,
          choices: [{ text: '¡Sí, hacémela!', next: `__p_${m.id}` }, { text: 'Mejor otra cosa', next: '__cat' }] };
        nodes[`__p_${m.id}`] = { dinamico: `pedir:${m.id}` };
        return { text: `${m.nombre} · ${costoTxt(m.costo)} · ${m.tiempo_min ?? '?'} min`, next: `__c_${m.id}` };
      });
      choices.push({ text: 'Volver', next: 'tienda' });
      nodes.__cl = { text: `Esto es lo que hago (tenés ${inventario?.count?.('recursos', 'madera') ?? 0} de madera):`, choices };
      nodes.__cat = { dinamico: 'catalogo' };
      return { nodes, start: '__cl' };
    }
    if (cmd === 'pedir') {
      const m = catalog.get(arg);
      if (!m) return textNode('Uy, ese mueble no lo conozco.');
      if (!abierta) return textNode('Justo cerré. Volvé cuando abra y te lo hago.');
      if (mine().length >= cfg.max_pedidos_por_jugador) return textNode(`Ya tenés ${mine().length} pedidos conmigo. Retirá alguno y te hago otro.`);
      const slot = freeSlot();
      if (!slot) return textNode('No me entra nada más en el taller. Volvé en un rato, cuando retiren algo.');
      if (!inventario?.has(m.costo)) {
        const falta = Object.entries(m.costo).map(([k, v]) => `${Math.max(0, v - (inventario?.count?.('recursos', k) ?? 0))} de ${k}`).join(' y ');
        return textNode(`Te faltan ${falta}. Andá al Bosque de Coronda (el cartel del oeste de la plaza) y talá unos árboles.`);
      }
      inventario.pay(m.costo);
      const o = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, u: myUid, n: myName, m: m.id, t: nuevaHora(), d: Math.max(0.1, Number(m.tiempo_min) || 3) * 60000, s: slot, aviso: false, h: 1 };
      orders.set(o.id, o); changed(); save(o);
      const p = pedidos().find((x) => x.id === o.id);
      const fila = p.pos - pedidos().filter((x) => x.listo).length;
      const casa = hasLot(myUid) ? 'Cuando esté, te dejo una nota en tu buzón.' : 'Como todavía no tenés casa, pasá por acá a preguntar.';
      return textNode(`¡Hecho! Tu ${m.nombre.toLowerCase()} entra a la fila${fila > 1 ? ` (hay ${fila - 1} antes)` : ''}. Va a estar ${horaFin(p)}${abiertaEn(Date.now()) ? '' : ' (el taller trabaja de día)'}. ${casa}`);
    }
    if (cmd === 'ia_encargar') { // botón "✅ Confirmar" después de una cotización de la IA
      const p = pendienteIA;
      const otra = [{ text: 'Decile otra cosa', next: 'menu' }, { text: 'Chau', next: 'despedida' }];
      if (!p || Date.now() - p.t > 10 * 60000) return textNode('Uy, se me borró la cuenta. Decime de nuevo qué necesitás.', otra);
      const g = new Map(); for (const u of p.us) g.set(u.m, (g.get(u.m) ?? 0) + 1);
      const r = encargoIA([...g].map(([m, n]) => ({ mueble: m, cantidad: n })), true);
      return textNode(r.hecho ? r.texto : `No pude anotarlo: ${r.texto}`, otra);
    }
    if (cmd === 'mis') {
      const mis = mine();
      if (!mis.length) return textNode('No tenés pedidos conmigo.');
      const lines = mis.map((o) => `${nombre(o.m)}: ${o.listo ? 'listo ✓' : o.fabricando ? `${Math.round(o.progreso * 100)}% (sale ${horaFin(o)})` : `en la fila (sale ${horaFin(o)})`}`);
      return textNode(lines.join('\n'));
    }
    if (cmd === 'retirar') {
      const listos = mine().filter((o) => o.listo);
      if (listos.length && !enMostrador(getPlayer()?.position)) return textNode('Para retirar tenés que estar en el mostrador: parate enfrente mío, del lado de los clientes, y pedímelo de nuevo.');
      if (!listos.length) return textNode('Todavía no hay nada listo. ¡Paciencia, que estoy en eso!');
      const nodes = {};
      const choices = listos.slice(0, 6).map((o) => { nodes[`__l_${o.id}`] = { dinamico: `llevar:${o.id}` }; return { text: `Retirar ${nombre(o.m)}`, next: `__l_${o.id}` }; });
      if (listos.length > 1) { nodes.__l_todos = { dinamico: 'llevar:todos' }; choices.unshift({ text: `Retirar TODOS (${listos.length})`, next: '__l_todos' }); }
      choices.push({ text: 'Volver', next: 'tienda' });
      nodes.__rl = { text: '¿Qué venís a buscar?', choices };
      return { nodes, start: '__rl' };
    }
    if (cmd === 'llevar') {
      const listos = mine().filter((o) => o.listo);
      const ids = arg === 'todos' ? listos.map((o) => o.id) : listos.filter((o) => o.id === arg).map((o) => o.id);
      if (!ids.length) return textNode('Mmm, no lo encuentro. ¿Ya lo retiraste?');
      if (!enMostrador(getPlayer()?.position)) return textNode('Parate en el mostrador, del lado de los clientes, y te lo alcanzo.');
      claude?.tiendaReq({ tipo: 'buscar', ids, u: myUid, n: myName });
      return { nodes: { __ll: { text: ids.length > 1 ? `¡Ya te los traigo! Voy uno por uno, esperame acá en el mostrador.` : '¡Ya te lo traigo! Esperame acá en el mostrador.' } }, start: '__ll' };
    }
    return null;
  }
  // ---------- Encargos por charla (la IA de Claude, ver claude-npc.js) ----------
  // La IA entiende "necesito 7 mesas y 4 sillas" y pasa { muebles: [{ mueble, cantidad }], confirmado }. Las cuentas las
  // hace el juego (nunca la IA): nombres, límite de pedidos, lugar en el taller, madera y hora de entrega.
  const sing = (t) => norm(t).replace(/[^a-z0-9]/g, '').replace(/(es|s)$/, '');
  function resolver(items) {
    const ok = [], raros = [];
    for (const it of (Array.isArray(items) ? items : []).slice(0, 8)) {
      const q = sing(it?.mueble ?? it?.nombre ?? '');
      const cant = Math.max(1, Math.min(20, Math.round(Number(it?.cantidad) || 1)));
      const m = q && [...catalog.values()].find((c) => c.costo && (sing(c.id) === q || sing(c.nombre) === q))
        || (q.length >= 3 && [...catalog.values()].find((c) => c.costo && (sing(c.nombre).startsWith(q) || q.startsWith(sing(c.nombre)))));
      if (m) { const prev = ok.find((x) => x.m === m.id); if (prev) prev.cantidad += cant; else ok.push({ m: m.id, cantidad: cant }); }
      else if (it?.mueble) raros.push(String(it.mueble).slice(0, 30));
    }
    return { ok, raros };
  }
  const plural = (m, n) => { const nb = nombre(m).toLowerCase(); return n === 1 ? `1 ${nb}` : `${n} ${/[aeiouáéíóú]$/.test(nb) ? `${nb}s` : nb.endsWith('ón') ? `${nb.slice(0, -2)}ones` : `${nb}es`}`; };
  const lista = (arr) => { const t = arr.filter(Boolean); return t.length <= 1 ? (t[0] ?? '') : `${t.slice(0, -1).join(', ')} y ${t.at(-1)}`; };
  const agrupar = (us) => { const g = new Map(); for (const u of us) g.set(u.m, (g.get(u.m) ?? 0) + 1); return lista([...g].map(([m, n]) => plural(m, n))); };
  const costoDe = (us) => { const c = {}; for (const u of us) for (const [k, v] of Object.entries(catalog.get(u.m)?.costo ?? {})) c[k] = (c[k] ?? 0) + v; return c; };
  const tieneDe = (c) => Object.entries(c).every(([k, v]) => (inventario?.count?.('recursos', k) ?? 0) >= v);
  let pendienteIA = null; // la última cotización que se puede confirmar con el botón: { us, t }

  // Calcula (y si hacer = true, encarga) lo que pidió. Devuelve { resumen (texto exacto para la IA), texto (lo mismo
  // dicho por Claude, por si la IA no contesta), pendiente (se puede confirmar), hecho, boton }
  function encargoIA(items, hacer = false) {
    const { ok, raros } = resolver(items);
    const pidio = ok.flatMap((x) => Array.from({ length: x.cantidad }, () => ({ m: x.m })));
    const abierta = tiempo ? tiempo.abierta() : true;
    const max = Number(cfg.max_pedidos_por_jugador) || 5;
    const tiene = mine().length;
    const libres = Math.max(0, (slots().length || 50) - pedidos().length);
    const entran = Math.max(0, Math.min(max - tiene, libres));
    const us = pidio.slice(0, entran), afuera = pidio.slice(entran);
    const costo = costoDe(us), alcanza = tieneDe(costo);
    const madera = inventario?.count?.('recursos', 'madera') ?? 0;
    const partes = [];
    if (!pidio.length) {
      partes.push(raros.length ? `Pidió ${lista(raros)}, pero eso no lo fabricás.` : 'No quedó claro qué mueble quiere.');
      partes.push(`Lo que hacés: ${lista([...catalog.values()].filter((m) => m.costo).map((m) => `${m.nombre.toLowerCase()} (${costoTxt(m.costo)}, ${m.tiempo_min} min)`))}.`);
      return { resumen: partes.join(' '), texto: partes.join(' '), pendiente: false, hecho: false };
    }
    partes.push(`Pidió: ${agrupar(pidio)}.${raros.length ? ` (${lista(raros)} no lo fabricás.)` : ''}`);
    if (afuera.length) {
      partes.push(entran
        ? `Solo puede tener ${max} pedidos a la vez y ya tiene ${tiene}: ahora entran ${agrupar(us)}; ${agrupar(afuera)} no entran, que vuelva a encargarlos cuando retire.`
        : `Ya tiene ${tiene} pedidos y el máximo es ${max}${libres ? '' : ' (o el taller está lleno)'}: no entra nada más hasta que retire alguno.`);
    }
    if (!us.length) return { resumen: partes.join(' '), texto: partes.join(' '), pendiente: false, hecho: false };
    partes.push(`Cuesta ${costoTxt(costo)} en total y tiene ${madera} de madera: ${alcanza ? 'le alcanza' : `no le alcanza (le faltan ${Math.max(0, (costo.madera ?? 0) - madera)} de madera)`}.`);
    let quizas = us;
    if (!alcanza) { // ¿para cuántos le alcanza, en el orden que los pidió?
      const tmp = []; for (const u of us) { if (tieneDe(costoDe([...tmp, u]))) tmp.push(u); }
      quizas = tmp;
      partes.push(quizas.length ? `Con lo que tiene le alcanza para ${agrupar(quizas)}.` : 'No le alcanza ni para uno: que tale en el Bosque de Coronda (cartel del oeste de la plaza).');
    }
    const etas = estimar(quizas.map((u) => ({ m: u.m, d: Math.max(0.1, Number(catalog.get(u.m)?.tiempo_min) || 3) * 60000 })));
    if (etas.length) partes.push(`Si encarga ${agrupar(quizas)} ahora, ${etas.length > 1 ? 'todo estaría listo' : 'estaría listo'} ${cuando(etas.at(-1).end)}${etas.length > 1 ? ` (el primero ${cuando(etas[0].end)})` : ''}${pedidos().some((o) => !o.listo) ? ', después de los pedidos que ya están en la fila' : ''}; el taller trabaja de ${String(hor()?.abre ?? 8).padStart(2, '0')}:00 a ${String(hor()?.cierra ?? 20).padStart(2, '0')}:00.`);
    if (!abierta) partes.push('Ahora la Carpintería está cerrada: no podés tomar el pedido hasta que abra.');
    // Se puede confirmar lo que entra y le alcanza (si no le alcanza para todo, se ofrece lo que sí puede pagar)
    const ofrecer = abierta && quizas.length > 0;
    if (!hacer || !abierta || !alcanza) {
      pendienteIA = ofrecer ? { us: quizas, t: Date.now() } : null;
      const boton = ofrecer ? `✅ Confirmar: ${agrupar(quizas)} (${costoTxt(costoDe(quizas))})` : '';
      if (hacer && ofrecer && !alcanza) partes.push(`Todavía no anotaste nada: que confirme si quiere ${agrupar(quizas)}.`);
      return { resumen: partes.join(' '), texto: partes.join(' '), pendiente: ofrecer, hecho: false, boton };
    }
    // Encargar de verdad
    pendienteIA = null;
    inventario.pay(costo);
    const hechos = [];
    for (const u of quizas) {
      const slot = freeSlot();
      if (!slot) break;
      const o = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, u: myUid, n: myName, m: u.m, t: nuevaHora(), d: Math.max(0.1, Number(catalog.get(u.m)?.tiempo_min) || 3) * 60000, s: slot, aviso: false, h: 1 };
      orders.set(o.id, o); changed(); save(o); hechos.push(o);
    }
    const fin = pedidos().filter((x) => hechos.some((o) => o.id === x.id)).reduce((a, x) => Math.max(a, x.end), 0);
    const casa = hasLot(myUid) ? 'Cuando esté, le dejás una nota en el buzón.' : 'Como no tiene casa, que pase a preguntar.';
    const hecho = `Pedido anotado (ya está hecho): ${agrupar(hechos)}, pagó ${costoTxt(costo)} (le queda ${inventario?.count?.('recursos', 'madera') ?? 0} de madera). Todo listo ${cuando(fin)}. ${casa}${afuera.length ? ` ${agrupar(afuera)} no entraron por el límite de ${max} pedidos.` : ''}`;
    return { resumen: hecho, texto: `¡Listo! Te anoté ${agrupar(hechos)}. Va a estar todo ${cuando(fin)}.`, pendiente: false, hecho: true };
  }

  const idle = (entry) => (entry?.id === 'claude'
    ? { secs: Number(cfg.inactividad_seg) || 20, wait: Number(cfg.espera_seg) || 5, msg: `Te quedaste callado y Claude siguió con lo suyo. Esperá ${Number(cfg.espera_seg) || 5} segundos para volver a hablarle.` }
    : null);

  // ---------- Cada cuadro ----------
  function update(p, dt = 0.016) {
    if (!find()) { notePrompt.hidden = true; return; }
    // Techo: se oculta con el jugador adentro
    if (roofs.length && p) {
      spot.updateMatrixWorld(true);
      const l = spot.worldToLocal(_v.copy(p));
      const inside = Math.abs(l.x) <= cfg.zona[0] && Math.abs(l.z) <= cfg.zona[1] && l.y > -1 && l.y < 6;
      for (const r of roofs) r.visible = !inside;
    }
    drawVisuals(dt);
    think(dt);
    // Nota en mi buzón
    attachPrompt();
    const want = drawNotes();
    const lot = lotOf(myUid);
    myNote = null;
    if (lot && want?.has(lot.key) && p) {
      const b = mailbox(lot.key);
      if (b && Math.hypot(p.x - b.x, p.z - b.z) < 2.2) myNote = want.get(lot.key);
    }
    notePrompt.hidden = !myNote;
  }

  // Para la IA de Claude (systems/claude-npc.js): los pedidos del que le habla y el estado de la Carpintería, en datos
  // cortos, para que pueda contestar "¿para cuándo están mis cosas?" sin inventar. Solo los tuyos: nunca los de otros.
  function resumenIA(now = Date.now()) {
    const todos = pedidos(now);
    const pendientes = todos.filter((o) => !o.listo);
    const mis = todos.filter((o) => o.u === myUid).map((o) => ({
      mueble: nombre(o.m),
      estado: o.listo ? 'listo' : o.fabricando ? 'fabricandose' : 'en_fila',
      progreso: Math.round(o.progreso * 100),
      antes_en_fila: o.listo || o.fabricando ? 0 : pendientes.filter((x) => x.start < o.start).length,
      listo_a_las: o.listo ? '' : horaFin(o),                          // hora del juego: "a las 15:30" / "mañana a las 08:09"
      faltan_min: o.listo ? 0 : Math.max(1, Math.ceil((o.end - now) / 60000)), // minutos reales
    }));
    const t = tiempo?.config?.tienda;
    return {
      abierta: tiempo ? tiempo.abierta() : true,
      abre: t ? `${String(t.abre).padStart(2, '0')}:00` : '', cierra: t ? `${String(t.cierra).padStart(2, '0')}:00` : '',
      hora: tiempo ? tiempo.texto() : '',
      pedidos_en_fila: pendientes.length,
      mis_pedidos: mis.slice(0, cfg.max_pedidos_por_jugador || 5),
      encargos: true, // este juego sabe hacer las cuentas de un encargo por charla (encargoIA)
      madera: inventario?.count?.('recursos', 'madera') ?? 0,
      max_pedidos: Number(cfg.max_pedidos_por_jugador) || 5,
      catalogo: [...catalog.values()].filter((m) => m.costo && m.id !== 'cubo_prueba').map((m) => `${m.nombre} (${costoTxt(m.costo)}, ${m.tiempo_min} min de taller)`),
    };
  }

  return {
    update, point, slots, dynamic, idle, resumenIA, encargoIA, enMostrador,
    pedidos: () => pedidos().map((o) => ({ id: o.id, jugador: o.n, uid: o.u, mueble: o.m, nombre: nombre(o.m), slot: o.s, pedido: o.t, empieza: o.start, termina: o.end, progreso: o.progreso, listo: o.listo, fabricando: o.fabricando, aviso: o.aviso })),
    borrar: (id) => drop(id), // (Studio) saca un pedido
    setConfig(c) { if (c && typeof c === 'object') cfg = { ...cfg, ...c }; },                 // (Studio) en vivo
    setCatalog(list) { for (const m of list ?? []) if (m?.id) catalog.set(m.id, { ...catalog.get(m.id), ...m }); }, // (Studio) precios
    get catalogo() { return [...catalog.values()]; },
    get claudeHace() { return doing; },
    get root() { return find(); },
  };
}
