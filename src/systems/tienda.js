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
//  - Retirar: "Retirar mis pedidos" → uno o "todos". Claude va al slot de cada uno, lo trae al mostrador y te lo da
//    (pasa a tu mochila). Mientras tanto nadie más le puede hablar.
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
    if (r !== root) { root = r; spot = null; roofs = []; points.clear(); clearVisuals(); }
    if (!root) return null;
    spot ??= root.getObjectByName(cfg.id) ?? null;
    // el modelo se carga después de colocar el objeto: se vuelve a buscar hasta que aparezcan sus partes
    if (spot && !points.size && spot.children.length) {
      const roofRe = new RegExp(`^${cfg.techo}`, 'i');
      spot.traverse((o) => {
        if (!o.name) return;
        if (roofRe.test(o.name)) roofs.push(o);
        else if (/^(pos_|cola_|slot_|banco_obra)/.test(o.name)) points.set(o.name, o);
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

  // ---------- Pedidos ----------
  // { id, u, n (nombre), m (mueble), t (cuándo se pidió, ms), d (duración ms), s (slot 1..50), aviso (nota dejada) }
  const orders = new Map();
  const SOLO_KEY = 'coronda.tienda.solo';
  let plan = [], planAt = 0; // la fila calculada (ver schedule)
  function cleanOrder(id, r) {
    if (!r || typeof r !== 'object' || !ID_RE.test(String(r.m ?? ''))) return null;
    const t = Number(r.t), d = Number(r.d), s = Math.round(Number(r.s));
    if (!Number.isFinite(t) || !(d > 0) || !(s >= 1 && s <= 99)) return null;
    return { id, u: String(r.u ?? '').slice(0, 40), n: String(r.n ?? 'alguien').slice(0, 24), m: String(r.m), t, d: Math.min(d, 24 * 3600e3), s, aviso: !!r.aviso };
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

  // Fila: por orden de pedido, uno por vez. Cada uno empieza cuando termina el anterior (o cuando se pidió).
  function schedule() {
    const list = [...orders.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
    let end = 0;
    plan = list.map((o, i) => {
      const start = Math.max(o.t, end);
      end = start + o.d;
      return { ...o, start, end, pos: i + 1 };
    });
    planAt = Date.now();
  }
  function changed() { schedule(); }
  function info(o, now = Date.now()) {
    const p = Math.min(1, Math.max(0, (now - o.start) / o.d));
    return { ...o, progreso: p, listo: now >= o.end, fabricando: now >= o.start && now < o.end };
  }
  function pedidos(now = Date.now()) { if (now - planAt > 1000) schedule(); return plan.map((o) => info(o, now)); }
  const mine = () => pedidos().filter((o) => o.u === myUid);
  const nombre = (m) => catalog.get(m)?.nombre ?? m;
  const costoTxt = (c) => Object.entries(c ?? {}).map(([k, v]) => `${v} ${k}`).join(' + ') || 'nada';
  const horaFin = (o) => (tiempo ? tiempo.texto(tiempo.hora(o.end)) : '');
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
      const o = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, u: myUid, n: myName, m: m.id, t: Date.now(), d: Math.max(0.1, Number(m.tiempo_min) || 3) * 60000, s: slot, aviso: false };
      orders.set(o.id, o); changed(); save(o);
      const p = pedidos().find((x) => x.id === o.id);
      const fila = p.pos - pedidos().filter((x) => x.listo).length;
      const casa = hasLot(myUid) ? 'Cuando esté, te dejo una nota en tu buzón.' : 'Como todavía no tenés casa, pasá por acá a preguntar.';
      return textNode(`¡Hecho! Tu ${m.nombre.toLowerCase()} entra a la fila${fila > 1 ? ` (hay ${fila - 1} antes)` : ''}. Va a estar a eso de las ${horaFin(p)}. ${casa}`);
    }
    if (cmd === 'mis') {
      const mis = mine();
      if (!mis.length) return textNode('No tenés pedidos conmigo.');
      const lines = mis.map((o) => `${nombre(o.m)}: ${o.listo ? 'listo ✓' : o.fabricando ? `${Math.round(o.progreso * 100)}% (a las ${horaFin(o)})` : `en la fila (a las ${horaFin(o)})`}`);
      return textNode(lines.join('\n'));
    }
    if (cmd === 'retirar') {
      const listos = mine().filter((o) => o.listo);
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
      claude?.tiendaReq({ tipo: 'buscar', ids, u: myUid, n: myName });
      return { nodes: { __ll: { text: ids.length > 1 ? `¡Ya te los traigo! Voy uno por uno, esperame acá en el mostrador.` : '¡Ya te lo traigo! Esperame acá en el mostrador.' } }, start: '__ll' };
    }
    return null;
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

  return {
    update, point, slots, dynamic, idle,
    pedidos: () => pedidos().map((o) => ({ id: o.id, jugador: o.n, uid: o.u, mueble: o.m, nombre: nombre(o.m), slot: o.s, pedido: o.t, empieza: o.start, termina: o.end, progreso: o.progreso, listo: o.listo, fabricando: o.fabricando, aviso: o.aviso })),
    borrar: (id) => drop(id), // (Studio) saca un pedido
    get catalogo() { return [...catalog.values()]; },
    get claudeHace() { return doing; },
    get root() { return find(); },
  };
}
