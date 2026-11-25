// Interiores de las casas de los lotes: cada casa tiene su propia escena ("casa_<lote>").
//
// - Se crea cuando alguien adquiere el lote (vacía) y se borra entera cuando el dueño destruye la casa (ver lotes.js).
//   Cada vez que un lote se adquiere de nuevo la casa tiene otro id (c): un interior viejo nunca reaparece.
// - Se entra desde el menú del lote (E). Todos pueden visitar; solo el dueño puede diseñar.
// - Salida: la puerta del frente ("E Salir"), te deja delante del lote.
//
// El cascarón (piso y paredes):
//   - Si la casa tiene "interior" en data/casas.json, se usa ese .glb (con su piso col_/colision, su Empty "spawn"
//     donde aparecés y un Empty "salida" donde está la puerta para salir).
//   - Si no, se arma una habitación simple de "tamano": [ancho, largo, alto] metros (por defecto 10 × 10 × 3,2).
//
// Muebles: data/muebles.json  { "muebles": [{ id, nombre, archivo, caja: [ancho, alto, largo] }] }
//   El .glb va en assets/models/muebles/ (origen en la base del mueble, al centro). Si no existe se muestra una
//   caja de prueba del tamaño de "caja" (así se puede probar antes de modelar). Los col_… del mueble chocan.
//
// Modo diseño (el dueño, adentro, tecla B o el botón 🛠):
//   - elegí un mueble del catálogo y aparece delante tuyo: caminá para llevarlo,
//   - Q / R giran 15°, clic o Enter lo apoya, Supr lo borra, Esc cancela,
//   - clic sobre un mueble ya puesto para agarrarlo y moverlo.
//
// Cómo se comparte (igual que los lotes): cada cambio se manda en vivo y se guarda en el broker MQTT (retained)
// bajo casa~<lote>. Registro: { c: id de la casa, o: dueño, v: versión, items: [{ i, m, p: [x, z], y: grados }] }.
// Jugando solo se guarda en el navegador (localStorage).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadJSON, loadGLB } from '../core/assets.js';
import { makeUnlit, setShade } from './shading.js';

const SOLO_STORE = 'coronda.casas.solo';
const MAX_ITEMS = 150;
const GRID = 0.25;          // m: los muebles se acomodan en una grilla de 25 cm
const CARRY_DIST = 1.8;     // m delante del jugador mientras lo llevás
const DEFAULT_SIZE = [10, 10, 3.2];
const EXIT_RADIUS = 1.3;    // m: cerca de la puerta aparece "E Salir"
const COLORS = [0xc8a27a, 0x8fb3c9, 0xa7c48a, 0xd98c7a, 0xb59ad1, 0xe2c86a];
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) ?? {}; } catch { return {}; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
const snap = (v) => Math.round(v / GRID) * GRID;
const beats = (a, b) => !b || a.v > b.v || (a.v === b.v && (a.o ?? '') < (b.o ?? ''));

export const houseSceneId = (loteKey) => `casa_${loteKey}`;

// opts: net, uid, lotes (para saber de quién es cada lote), stage, camera, getPlayer(), getShade(), notify(msg),
//       blocked() (otra cosa usa las teclas), onDesign(on) (para frenar/soltar al jugador), onChange() (rehacer colisiones)
export function createCasas({ net = null, uid, lotes, stage, camera, getPlayer, getShade = () => ({}), notify = () => {}, blocked = () => false, onChange }) {
  const solo = !net;
  const records = new Map(); // loteKey -> registro
  let catalog = new Map();
  let houseDefs = new Map();
  const templates = new Map();
  let inside = null;          // { key, group, items: Map(i -> obj), exit: Vector3, back: spotInfo }
  let design = false;
  let carry = null;           // { obj, item, isNew, before }

  const ready = Promise.all([
    loadJSON('data/muebles.json').catch(() => ({ muebles: [] })),
    loadJSON('data/casas.json').catch(() => ({ casas: [] })),
  ]).then(([m, c]) => {
    catalog = new Map((m.muebles ?? []).map((x, i) => [x.id, { id: x.id, nombre: x.nombre ?? x.id, archivo: x.archivo ?? `assets/models/muebles/${x.id}.glb`, caja: Array.isArray(x.caja) ? x.caja.map(Number) : [1, 1, 1], color: COLORS[i % COLORS.length] }]));
    houseDefs = new Map((c.casas ?? []).map((x) => [x.id, x]));
    if (solo) for (const [k, r] of Object.entries(readJSON(SOLO_STORE))) { const r2 = clean(r); if (r2) records.set(k, r2); }
  });

  // ---------- Estado ----------
  function clean(r) {
    if (!r || typeof r !== 'object') return null;
    const v = Math.floor(Number(r.v));
    if (!(v >= 1)) return null;
    const c = typeof r.c === 'string' ? r.c.slice(0, 24) : null;
    const items = Array.isArray(r.items) ? r.items.slice(0, MAX_ITEMS).map((it) => ({
      i: String(it?.i ?? '').slice(0, 16), m: String(it?.m ?? '').slice(0, 60),
      p: [Number(it?.p?.[0]) || 0, Number(it?.p?.[1]) || 0], y: Number(it?.y) || 0,
    })).filter((it) => it.i && it.m) : [];
    return { c, o: r.o ? String(r.o).slice(0, 40) : null, v, items };
  }
  // El interior vale solo si es de la casa que está hoy en el lote (mismo id c)
  function current(key) {
    const lot = lotes.record(key);
    const r = records.get(key);
    if (!lot?.o || !lot.c || !r || r.c !== lot.c) return { c: lot?.c ?? null, o: lot?.o ?? null, v: r?.v ?? 0, items: [] };
    return r;
  }
  function accept(key, rec) {
    const cur = records.get(key);
    if (cur && !beats(rec, cur)) return false;
    records.set(key, rec);
    if (solo) writeJSON(SOLO_STORE, Object.fromEntries(records));
    if (inside?.key === key && !carry) renderItems();
    return true;
  }
  async function receive(key, r) {
    await ready;
    const rec = clean(r);
    if (rec && /^[a-z0-9_.-]{1,80}$/i.test(key)) accept(key, rec);
  }
  function publish(key, rec) {
    if (solo) return;
    net.casas.send({ k: key, r: rec });
    net.casas.persist(key, rec);
  }
  function save(key, items) {
    const lot = lotes.record(key);
    if (lot?.o !== uid) return;
    const cur = records.get(key);
    const rec = { c: lot.c, o: uid, v: (cur?.v ?? 0) + 1, items };
    accept(key, rec);
    publish(key, rec);
  }

  if (net) {
    const C = net.casas;
    const { messages, saved } = C.take();
    const handle = (d, peerId) => {
      if (!d || typeof d !== 'object') return;
      if (d.ask) { const all = [...records].map(([k, r]) => ({ k, r })); if (all.length) C.send({ all }, peerId); return; }
      if (Array.isArray(d.all)) { for (const x of d.all.slice(0, 200)) if (x?.k) receive(String(x.k), x.r); return; }
      if (d.k) receive(String(d.k), d.r);
    };
    C.onMessage = handle;
    C.onPersisted = (k, r) => receive(k, r);
    messages.forEach(({ data, peerId }) => handle(data, peerId));
    saved.forEach(([k, r]) => receive(k, r));
    C.send({ ask: 1 });
  }

  // ---------- Escena del interior ----------
  // Datos de la escena para el gestor de escenas (scene-manager.js): se registra en la tabla de escenas
  function sceneEntry(key, back) {
    const lot = lotes.record(key);
    const def = houseDefs.get(lot?.m) ?? {};
    const [w, d, h] = Array.isArray(def.tamano) ? def.tamano.map(Number) : DEFAULT_SIZE;
    const id = houseSceneId(key);
    return {
      data: {
        id,
        environment: { background: '#1c1815', shading: 'unlit', tint: getShade()?.tint ?? '#ffffff', brightness: 1 },
        rooms: def.interior ? [{ id: 'interior', model: def.interior }] : [],
        spawn: { position: [0, 1.7, d / 2 - 2.4], yaw: 0 },
        collision: { default: 'none' },
      },
      build: async (group) => { await ready; await buildInterior(group, key, { w, d, h, glb: !!def.interior, back }); },
    };
  }

  function wallMat(color) { return new THREE.MeshBasicMaterial({ color }); }
  async function buildInterior(group, key, { w, d, h, glb, back }) {
    let exit = new THREE.Vector3(0, 0, d / 2 - 0.3);
    if (!glb) { // habitación simple: piso, paredes y techo (todo sólido)
      const shell = new THREE.Group();
      shell.name = 'casa-cascaron';
      const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, d), wallMat(0x8b6b4a));
      floor.position.y = -0.1; floor.userData.colision = 1; floor.name = 'piso';
      shell.add(floor);
      const walls = [
        [w, h, 0.2, 0, h / 2, -d / 2], [w, h, 0.2, 0, h / 2, d / 2],
        [0.2, h, d, -w / 2, h / 2, 0], [0.2, h, d, w / 2, h / 2, 0],
      ];
      walls.forEach(([sx, sy, sz, x, y, z], i) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), wallMat(i % 2 ? 0xd8cbb3 : 0xe6dac3));
        m.position.set(x, y, z); m.userData.colision = 1; m.name = `pared_${i}`;
        shell.add(m);
      });
      const ceil = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), wallMat(0xf1ebe0));
      ceil.position.y = h + 0.05; ceil.name = 'techo';
      shell.add(ceil);
      // La puerta para salir (un dibujo en la pared del frente)
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 0.05), wallMat(0x5b3a24));
      door.position.set(0, 1.1, d / 2 - 0.12); door.name = 'salida-puerta';
      shell.add(door);
      group.add(shell);
    } else {
      const s = group.getObjectByName('salida');
      if (s) exit = s.getWorldPosition(new THREE.Vector3());
    }
    if (getShade && group) setShade(group, getShade());
    const items = new THREE.Group();
    items.name = 'casa-muebles';
    group.add(items);
    // Hasta dónde se puede llevar un mueble (en la habitación armada: adentro de las paredes)
    const bounds = glb ? null : { x: w / 2 - 0.35, z: d / 2 - 0.35 };
    inside = { key, group, itemsGroup: items, items: new Map(), exit, back, bounds };
    await renderItems();
  }

  // ---------- Muebles ----------
  function template(file) {
    if (!templates.has(file)) templates.set(file, loadGLB(file).then((g) => { makeUnlit(g.scene); return g; }).catch(() => null));
    return templates.get(file);
  }
  async function makeItem(item) {
    const def = catalog.get(item.m);
    let obj;
    const g = def ? await template(def.archivo) : null;
    if (g) obj = cloneSkinned(g.scene);
    else { // todavía no existe el modelo: una caja de prueba
      const [bw, bh, bd] = def?.caja ?? [1, 1, 1];
      obj = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshBasicMaterial({ color: def?.color ?? 0x999999 }));
      box.position.y = bh / 2; box.userData.colision = 'caja';
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0x3b2f25 }));
      edge.position.copy(box.position);
      obj.add(box, edge);
    }
    obj.name = `mueble:${item.m}`;
    obj.userData.mueble = item.i;
    setShade(obj, getShade());
    return obj;
  }
  function place(obj, item) {
    obj.position.set(item.p[0], 0, item.p[1]);
    obj.rotation.y = THREE.MathUtils.degToRad(item.y);
  }
  let renderToken = 0;
  async function renderItems() {
    if (!inside) return;
    const my = ++renderToken;
    const want = current(inside.key).items;
    const keep = new Set(want.map((it) => it.i));
    let changed = false;
    for (const [i, obj] of inside.items) if (!keep.has(i)) { obj.removeFromParent(); inside.items.delete(i); changed = true; }
    for (const it of want) {
      let obj = inside.items.get(it.i);
      if (obj && obj.name !== `mueble:${it.m}`) { obj.removeFromParent(); inside.items.delete(it.i); obj = null; }
      if (!obj) {
        obj = await makeItem(it);
        if (my !== renderToken || !inside) return;
        inside.itemsGroup.add(obj); inside.items.set(it.i, obj); changed = true;
      }
      place(obj, it);
    }
    if (changed) onChange?.();
  }

  // ---------- Modo diseño ----------
  const ui = document.createElement('div');
  ui.className = 'casa-ui';
  ui.hidden = true;
  stage.parentElement.appendChild(ui);
  const exitPrompt = document.createElement('button');
  exitPrompt.type = 'button';
  exitPrompt.className = 'door-prompt';
  exitPrompt.hidden = true;
  exitPrompt.innerHTML = '<kbd>E</kbd> Salir de la casa';
  stage.parentElement.appendChild(exitPrompt);
  let onExit = null;
  exitPrompt.addEventListener('click', () => onExit?.());

  const isOwner = () => inside && lotes.record(inside.key)?.o === uid;
  function drawUI() {
    if (!inside) { ui.hidden = true; return; }
    const lot = lotes.record(inside.key);
    const own = isOwner();
    if (!design) {
      ui.innerHTML = `<div class="casa-bar"><b>Casa de ${esc(lot?.n || '…')}</b>${own ? '<button type="button" data-a="design">🛠 Diseñar <kbd>B</kbd></button>' : ''}</div>`;
    } else {
      const list = [...catalog.values()];
      ui.innerHTML = `<div class="casa-panel">
        <div class="casa-head"><b>Diseñar tu casa</b><button type="button" data-a="done">Listo <kbd>B</kbd></button></div>
        <div class="casa-cat">${list.map((m) => `<button type="button" data-m="${esc(m.id)}">${esc(m.nombre)}</button>`).join('') || '<p>No hay muebles en data/muebles.json</p>'}</div>
        <p class="casa-help">${carry ? 'Caminá para llevarlo · <kbd>Q</kbd>/<kbd>R</kbd> girar · <kbd>clic</kbd> o <kbd>Enter</kbd> apoyar · <kbd>Supr</kbd> borrar · <kbd>Esc</kbd> cancelar' : 'Elegí un mueble, o hacé clic sobre uno puesto para moverlo.'}</p>
        <p class="casa-count">${current(inside.key).items.length} / ${MAX_ITEMS} muebles</p>
      </div>`;
    }
    ui.hidden = false;
  }
  ui.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'design') setDesign(true);
    else if (b.dataset.a === 'done') setDesign(false);
    else if (b.dataset.m) startNew(b.dataset.m);
    b.blur();
  });

  function setDesign(on) {
    if (on && !isOwner()) return;
    if (!on && carry) cancelCarry();
    design = on;
    drawUI();
  }
  async function startNew(m) {
    if (carry) cancelCarry();
    if (current(inside.key).items.length >= MAX_ITEMS) { notify(`Máximo ${MAX_ITEMS} muebles`); return; }
    const item = { i: Math.random().toString(36).slice(2, 10), m, p: [0, 0], y: 0 };
    const obj = await makeItem(item);
    if (!inside || !design) return;
    inside.itemsGroup.add(obj);
    carry = { obj, item, isNew: true };
    drawUI();
  }
  function pickUp(i) {
    const it = current(inside.key).items.find((x) => x.i === i);
    const obj = inside.items.get(i);
    if (!it || !obj) return;
    carry = { obj, item: { ...it, p: [...it.p] }, isNew: false, before: { ...it } };
    drawUI();
  }
  function cancelCarry() {
    if (!carry) return;
    if (carry.isNew) carry.obj.removeFromParent();
    else place(carry.obj, carry.before);
    carry = null;
    drawUI();
  }
  function drop() {
    if (!carry) return;
    const items = current(inside.key).items.filter((x) => x.i !== carry.item.i);
    items.push({ ...carry.item, p: [snap(carry.item.p[0]), snap(carry.item.p[1])] });
    if (carry.isNew) { inside.items.set(carry.item.i, carry.obj); }
    carry = null;
    save(inside.key, items);
    onChange?.();
    drawUI();
  }
  function removeCarried() {
    if (!carry) return;
    carry.obj.removeFromParent();
    inside.items.delete(carry.item.i);
    const items = current(inside.key).items.filter((x) => x.i !== carry.item.i);
    const wasNew = carry.isNew;
    carry = null;
    if (!wasNew) { save(inside.key, items); onChange?.(); }
    drawUI();
  }

  // Clic (no arrastre) sobre el mundo: apoyar lo que llevás, o agarrar un mueble
  const ray = new THREE.Raycaster();
  let down = null;
  stage.addEventListener('pointerdown', (e) => { if (design) down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  stage.addEventListener('pointerup', (e) => {
    if (!design || !down || !inside) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 400;
    down = null;
    if (moved) return; // fue para girar la cámara
    if (carry) { drop(); return; }
    const r = stage.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObject(inside.itemsGroup, true)[0];
    if (!hit) return;
    let o = hit.object;
    while (o && o.userData.mueble === undefined) o = o.parent;
    if (o) pickUp(o.userData.mueble);
  });

  addEventListener('keydown', (e) => {
    if (!inside || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyE' && !e.repeat && !design && !exitPrompt.hidden && !blocked()) { onExit?.(); e.preventDefault(); return; }
    if (e.code === 'KeyB' && !e.repeat && !blocked()) { setDesign(!design); e.preventDefault(); return; }
    if (!design || !carry) return;
    if (e.code === 'KeyQ') { carry.item.y = (carry.item.y + 15) % 360; e.preventDefault(); }
    else if (e.code === 'KeyR') { carry.item.y = (carry.item.y + 345) % 360; e.preventDefault(); }
    else if (e.code === 'Enter') { drop(); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.code === 'Delete' || e.code === 'Backspace') { removeCarried(); e.preventDefault(); }
    else if (e.code === 'Escape') { cancelCarry(); e.preventDefault(); }
  }, true); // antes que el chat (Enter)

  // ---------- API ----------
  return {
    sceneEntry,
    // Después de cargar cualquier escena: si no es un interior, se apaga todo lo de las casas
    afterScene(sceneId) {
      if (inside && houseSceneId(inside.key) !== sceneId) inside = null;
      if (!inside) { design = false; carry = null; ui.hidden = true; exitPrompt.hidden = true; }
      else drawUI();
    },
    setOnExit(fn) { onExit = fn; },
    get inside() { return inside; },
    get designing() { return design; },
    // Se destruyó la casa (lotes.js): se borra su interior para todos
    clear(key) {
      const cur = records.get(key);
      const rec = { c: null, o: null, v: (cur?.v ?? 0) + 1, items: [] };
      records.set(key, rec);
      if (solo) writeJSON(SOLO_STORE, Object.fromEntries(records));
      publish(key, rec);
    },
    // Cada cuadro (adentro): llevar el mueble y el aviso de salida
    update(focus) {
      if (!inside) return;
      const p = getPlayer();
      if (carry && p) {
        const f = p.facing;
        carry.item.p = [p.position.x + Math.sin(f) * CARRY_DIST, p.position.z + Math.cos(f) * CARRY_DIST];
        const b = inside.bounds;
        if (b) carry.item.p = [THREE.MathUtils.clamp(carry.item.p[0], -b.x, b.x), THREE.MathUtils.clamp(carry.item.p[1], -b.z, b.z)];
        carry.obj.position.set(snap(carry.item.p[0]), 0, snap(carry.item.p[1]));
        carry.obj.rotation.y = THREE.MathUtils.degToRad(carry.item.y);
      }
      const nearExit = !design && Math.hypot(focus.x - inside.exit.x, focus.z - inside.exit.z) < EXIT_RADIUS;
      if (exitPrompt.hidden === nearExit) exitPrompt.hidden = !nearExit;
    },
    get nearExit() { return !!inside && !exitPrompt.hidden; },
  };
}
