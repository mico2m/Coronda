// Interiores de las casas de los lotes: cada casa tiene su propia escena "scene_lote<nro>_<dueño>"
// (ej. scene_lote04_mirko), armada con el modelo base del interior: assets/models/interiores/interior_base.glb.
//
// - Se crea cuando alguien adquiere el lote (vacía) y se borra entera cuando el dueño destruye o cede el lote (ver lotes.js).
//   Cada vez que un lote se adquiere de nuevo la casa tiene otro id (c): un interior viejo nunca reaparece.
// - Se entra desde el menú del lote (E). Todos pueden visitar; solo el dueño puede diseñar.
// - Salida: la puerta del frente ("E Salir"), te deja delante del lote.
//
// El cascarón (piso y paredes):
//   - assets/models/interiores/interior_base.glb (o el "interior" de esa casa en data/casas.json), con su piso
//     sólido (col_… o colision = 1), un Empty "spawn" donde aparecés y un Empty "salida" en la puerta para salir.
//   - Mientras ese archivo no exista, se arma una habitación simple de "tamano": [ancho, largo, alto] metros (10 × 10 × 3,2).
//
// Muebles: data/muebles.json  { "muebles": [{ id, nombre, archivo, caja: [ancho, alto, largo] }] }
//   El .glb va en assets/models/muebles/ (origen en la base del mueble, al centro). Si no existe se muestra una
//   caja de prueba del tamaño de "caja" (así se puede probar antes de modelar). Los col_… del mueble chocan.
//
// Modo diseño (el dueño, adentro, tecla B o el botón 🛠):
//   - elegí un mueble del catálogo y aparece delante tuyo: caminá para llevarlo,
//   - Q / R giran 15°, clic o Enter lo apoya, Supr lo borra, Esc cancela,
//   - clic sobre un mueble ya puesto para agarrarlo y moverlo,
//   - V: vista desde arriba (la cámara mira el cuarto entero y el mueble sigue al mouse) · G: grilla de 25 cm en el piso,
//   - Pósters (cuadrado, rectangular o circular): se pega la dirección https de una imagen; se cuelga en la pared y
//     la imagen se vuelve a pedir cada 5 minutos (si cambia en internet, cambia en la casa).
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

// Modelo base del interior (una casa vacía). Lo modelás vos: ver el README, "Interiores de las casas".
export const INTERIOR_BASE = 'assets/models/interiores/interior_base.glb';
const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
// "coronda_plaza.lote_04" + dueño "Mirko" -> "scene_lote04_mirko"
export function houseSceneId(loteKey, ownerName) {
  const lot = String(loteKey).replace(/^.*\.lote_?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `scene_lote${lot}_${norm(ownerName) || 'casa'}`;
}
async function fileExists(url) { try { return (await fetch(url, { method: 'HEAD' })).ok; } catch { return false; } }

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
  let topView = false;        // vista desde arriba (cenital) para acomodar muebles con el mouse
  let showGrid = false;       // grilla en el piso (se recuerda)
  try { showGrid = localStorage.getItem('coronda.casas.grilla') === '1'; } catch { /* nada */ }
  let grid = null;
  const mouse = { x: 0, y: 0, in: false };
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const _hit = new THREE.Vector3();

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
      ...(it?.m === 'poster' ? { k: cleanPoster(it.k) } : {}),
    })).filter((it) => it.i && it.m) : [];
    return { c, o: r.o ? String(r.o).slice(0, 40) : null, v, items };
  }
  // Póster: { f: 'cuadrado' | 'rectangular' | 'circular', u: url https de la imagen }
  function cleanPoster(k) {
    const f = ['cuadrado', 'rectangular', 'circular'].includes(k?.f) ? k.f : 'cuadrado';
    let u = String(k?.u ?? '').trim().slice(0, 500);
    if (!/^https:\/\/[^\s"'<>]+$/i.test(u)) u = '';
    return { f, u };
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
  // Escena del interior: scene_lote<nro>_<dueño>. Usa el modelo base (INTERIOR_BASE, o el "interior" de esa casa en
  // data/casas.json); si todavía no existe, una habitación simple para poder probar.
  async function sceneEntry(key, back) {
    await ready;
    const lot = lotes.record(key);
    const def = houseDefs.get(lot?.m) ?? {};
    const [w, d, h] = Array.isArray(def.tamano) ? def.tamano.map(Number) : DEFAULT_SIZE;
    const id = houseSceneId(key, lot?.n);
    const file = def.interior || INTERIOR_BASE;
    const glb = await fileExists(file);
    if (!glb) console.info(`Casas: todavía no existe ${file}; se arma una habitación simple de ${w} × ${d} m.`);
    return {
      id,
      data: {
        id,
        environment: { background: '#1c1815', shading: 'unlit', tint: getShade()?.tint ?? '#ffffff', brightness: 1 },
        rooms: glb ? [{ id: 'interior', model: file }] : [],
        spawn: { position: [0, 1.7, d / 2 - 2.4], yaw: 0 }, // si el modelo tiene un Empty "spawn", se usa ese
        collision: { default: 'none' },
      },
      build: async (group) => { await buildInterior(group, key, { id, w, d, h, glb, back }); },
    };
  }

  function wallMat(color) { return new THREE.MeshBasicMaterial({ color }); }
  async function buildInterior(group, key, { id, w, d, h, glb, back }) {
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
      // Sin techo: así la cámara ve todo desde arriba
      // La puerta para salir (un dibujo en la pared del frente)
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 0.05), wallMat(0x5b3a24));
      door.position.set(0, 1.1, d / 2 - 0.12); door.name = 'salida-puerta';
      shell.add(door);
      group.add(shell);
    } else {
      const s = group.getObjectByName('salida');
      if (s) exit = s.getWorldPosition(new THREE.Vector3());
      // El techo no se ve (la cámara mira desde arriba): todo lo que se llame techo…, roof… o ceiling…
      group.traverse((o) => { if (/^(?:techo|roof|ceiling)/i.test(o.name ?? '')) o.visible = false; });
    }
    if (getShade && group) setShade(group, getShade());
    const items = new THREE.Group();
    items.name = 'casa-muebles';
    group.add(items);
    // Hasta dónde se puede llevar un mueble (en la habitación armada: adentro de las paredes)
    const bounds = glb ? null : { x: w / 2 - 0.35, z: d / 2 - 0.35 };
    // Tamaño del cuarto (para la vista desde arriba y la grilla)
    let room = { cx: 0, cz: 0, w, d };
    if (glb) {
      const box = new THREE.Box3().setFromObject(group);
      if (!box.isEmpty()) room = { cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2, w: box.max.x - box.min.x, d: box.max.z - box.min.z };
    }
    inside = { key, id, group, itemsGroup: items, items: new Map(), exit, back, bounds, room };
    grid = null;
    if (showGrid && design) makeGrid();
    await renderItems();
  }

  // ---------- Muebles ----------
  function template(file) {
    if (!templates.has(file)) templates.set(file, loadGLB(file).then((g) => { makeUnlit(g.scene); return g; }).catch(() => null));
    return templates.get(file);
  }
  const itemName = (it) => (it.m === 'poster' ? `mueble:poster:${it.k?.f}:${it.k?.u}` : `mueble:${it.m}`);
  async function makeItem(item) {
    if (item.m === 'poster') return makePoster(item);
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
  // ---------- Pósters ----------
  // Una imagen de internet (https) en un marco: cuadrado (1 × 1 m), rectangular (1,2 m de ancho, alto según la
  // imagen) o circular (1 m). Se cuelga a 1,6 m de altura; en la habitación armada se pega sola a la pared más cercana.
  // La imagen se vuelve a pedir cada POSTER_REFRESH: si cambia en internet, cambia en la casa.
  // Si el sitio de la imagen no deja usarla en 3D (CORS), se pide a través de images.weserv.nl (un servicio gratuito).
  const POSTER_Y = 1.6, POSTER_REFRESH = 5 * 60 * 1000;
  const posterLoader = new THREE.TextureLoader();
  posterLoader.setCrossOrigin('anonymous');
  const loadImage = (url) => new Promise((res, rej) => posterLoader.load(url, res, undefined, rej));
  async function posterTexture(u) {
    const bust = `${u.includes('?') ? '&' : '?'}_c=${Math.floor(Date.now() / POSTER_REFRESH)}`;
    try { return await loadImage(u + bust); }
    catch { return loadImage(`https://images.weserv.nl/?url=${encodeURIComponent(u)}&w=1024&_c=${Math.floor(Date.now() / POSTER_REFRESH)}`); }
  }
  function makePoster(item) {
    const k = item.k ?? { f: 'cuadrado', u: '' };
    const g = new THREE.Group();
    g.name = itemName(item);
    g.userData.mueble = item.i;
    g.userData.poster = true;
    const holder = new THREE.Group();
    holder.position.y = POSTER_Y;
    g.add(holder);
    const frameMat = new THREE.MeshBasicMaterial({ color: 0x2b2118 });
    const picMat = new THREE.MeshBasicMaterial({ color: 0xbfb6a8 });
    let w = 1, h = 1;
    const build = () => {
      holder.clear();
      if (k.f === 'circular') {
        const frame = new THREE.Mesh(new THREE.CylinderGeometry(0.54, 0.54, 0.03, 48), frameMat);
        frame.rotation.x = Math.PI / 2;
        const pic = new THREE.Mesh(new THREE.CircleGeometry(0.5, 48), picMat);
        pic.position.z = 0.017;
        holder.add(frame, pic);
      } else {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.03), frameMat);
        const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h), picMat);
        pic.position.z = 0.017;
        holder.add(frame, pic);
      }
    };
    if (k.f === 'rectangular') { w = 1.2; h = 0.8; }
    build();
    const refresh = async () => {
      if (!k.u || !g.parent) return;
      try {
        const tex = await posterTexture(k.u);
        tex.colorSpace = THREE.SRGBColorSpace;
        if (k.f === 'rectangular' && tex.image?.width) { // el alto sigue la forma de la imagen
          h = Math.min(2, Math.max(0.3, w * (tex.image.height / tex.image.width)));
          build();
        }
        picMat.map?.dispose();
        picMat.map = tex; picMat.color.set(0xffffff); picMat.needsUpdate = true;
      } catch { console.warn(`Casas: no se pudo cargar la imagen del póster (${k.u})`); }
    };
    g.userData.refresh = refresh;
    setTimeout(refresh, 0);
    return g;
  }
  // Cada tanto se vuelven a pedir las imágenes de los pósters de la casa en la que estás
  setInterval(() => { if (inside) for (const obj of inside.items.values()) obj.userData.refresh?.(); }, POSTER_REFRESH);
  // En la habitación armada el póster se pega a la pared más cercana, mirando hacia adentro
  function stickToWall(item) {
    const b = inside?.bounds;
    if (!b) return;
    const [x, z] = item.p;
    const wx = b.x + 0.35 - 0.12, wz = b.z + 0.35 - 0.12; // la cara de adentro de cada pared
    const opts = [
      { d: wz + z, p: [x, -wz], y: 0 },      // pared de atrás (norte): mira hacia +z
      { d: wz - z, p: [x, wz], y: 180 },     // pared del frente
      { d: wx + x, p: [-wx, z], y: 90 },     // izquierda
      { d: wx - x, p: [wx, z], y: 270 },     // derecha
    ];
    const best = opts.reduce((a, o) => (o.d < a.d ? o : a));
    item.p = [THREE.MathUtils.clamp(best.p[0], -b.x, b.x), THREE.MathUtils.clamp(best.p[1], -b.z, b.z)];
    if (best.p[0] !== x) item.p[0] = best.p[0];
    if (best.p[1] !== z) item.p[1] = best.p[1];
    item.y = best.y;
  }

  // Ubica lo que llevás: los muebles en la grilla; los pósters, pegados a la pared (y en la grilla a lo largo de ella)
  function placeCarry() {
    const it = carry.item;
    if (it.m === 'poster' && inside.bounds) {
      stickToWall(it);
      if (it.y === 0 || it.y === 180) it.p[0] = snap(it.p[0]); else it.p[1] = snap(it.p[1]);
    } else it.p = [snap(it.p[0]), snap(it.p[1])];
    carry.obj.position.set(it.p[0], 0, it.p[1]);
    carry.obj.rotation.y = THREE.MathUtils.degToRad(it.y);
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
      if (obj && obj.name !== itemName(it)) { obj.removeFromParent(); inside.items.delete(it.i); obj = null; }
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

  // Grilla del piso: una línea cada 25 cm (la misma grilla en la que se acomodan los muebles), más marcada cada metro
  function makeGrid() {
    if (!inside || grid) return;
    const { cx, cz, w, d } = inside.room;
    const size = Math.ceil(Math.max(w, d));
    grid = new THREE.Group();
    grid.name = 'casa-grilla';
    const fine = new THREE.GridHelper(size, Math.round(size / GRID), 0x2b2b2b, 0x2b2b2b);
    fine.material.transparent = true; fine.material.opacity = 0.28; fine.material.depthWrite = false;
    const coarse = new THREE.GridHelper(size, size, 0x111111, 0x111111);
    coarse.material.transparent = true; coarse.material.opacity = 0.55; coarse.material.depthWrite = false;
    grid.add(fine, coarse);
    grid.position.set(snap(cx), 0.015, snap(cz));
    grid.renderOrder = 2;
    inside.group.add(grid);
  }
  function setGrid(on) {
    showGrid = on;
    try { localStorage.setItem('coronda.casas.grilla', on ? '1' : '0'); } catch { /* nada */ }
    if (grid) { grid.removeFromParent(); grid = null; }
    if (on && design) makeGrid();
    drawUI();
  }
  function setTopView(on) {
    topView = on;
    if (!on) camera.up.set(0, 1, 0);
    drawUI();
  }

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
        <div class="casa-modes">
          <button type="button" data-a="top" aria-pressed="${topView}">Vista desde arriba <kbd>V</kbd></button>
          <button type="button" data-a="grid" aria-pressed="${showGrid}">Grilla <kbd>G</kbd></button>
        </div>
        <div class="casa-cat">${list.map((m) => `<button type="button" data-m="${esc(m.id)}">${esc(m.nombre)}</button>`).join('') || '<p>No hay muebles en data/muebles.json</p>'}</div>
        <div class="casa-cat casa-posters"><span>Pósters:</span>
          <button type="button" data-poster="cuadrado">▢ Cuadrado</button>
          <button type="button" data-poster="rectangular">▭ Rectangular</button>
          <button type="button" data-poster="circular">◯ Circular</button>
        </div>
        ${carry?.item.m === 'poster' ? `<form class="casa-url"><input class="casa-url-in" type="url" inputmode="url" placeholder="https://… dirección de la imagen" value="${esc(carry.item.k?.u ?? '')}" aria-label="Dirección de la imagen del póster"><button type="submit">Usar imagen</button></form>` : ''}
        <p class="casa-help">${carry ? `${topView ? 'Mové el mouse para llevarlo' : 'Caminá para llevarlo'} · <kbd>Q</kbd>/<kbd>R</kbd> girar · <kbd>clic</kbd> o <kbd>Enter</kbd> apoyar · <kbd>Supr</kbd> borrar · <kbd>Esc</kbd> cancelar` : 'Elegí un mueble, o hacé clic sobre uno puesto para moverlo.'}</p>
        <p class="casa-count">${current(inside.key).items.length} / ${MAX_ITEMS} muebles</p>
      </div>`;
    }
    ui.hidden = false;
  }
  ui.addEventListener('submit', (e) => {
    e.preventDefault();
    setPosterUrl(ui.querySelector('.casa-url-in')?.value ?? '');
  });
  ui.addEventListener('keydown', (e) => { if (e.target.classList?.contains('casa-url-in')) e.stopPropagation(); }); // escribir no mueve al personaje
  ui.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'design') setDesign(true);
    else if (b.dataset.a === 'done') setDesign(false);
    else if (b.dataset.a === 'top') setTopView(!topView);
    else if (b.dataset.a === 'grid') setGrid(!showGrid);
    else if (b.dataset.m) startNew(b.dataset.m);
    else if (b.dataset.poster) startNew('poster', { f: b.dataset.poster, u: '' }).then(() => ui.querySelector('.casa-url-in')?.focus());
    b.blur();
  });

  function setDesign(on) {
    if (on && !isOwner()) return;
    if (!on && carry) cancelCarry();
    design = on;
    if (!on) { if (topView) setTopView(false); if (grid) { grid.removeFromParent(); grid = null; } }
    else if (showGrid) makeGrid();
    drawUI();
  }
  async function startNew(m, k) {
    if (carry) cancelCarry();
    if (current(inside.key).items.length >= MAX_ITEMS) { notify(`Máximo ${MAX_ITEMS} muebles`); return; }
    const item = { i: Math.random().toString(36).slice(2, 10), m, p: [0, 0], y: 0, ...(m === 'poster' ? { k: cleanPoster(k) } : {}) };
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
  // Cambiar la imagen del póster que llevás
  function setPosterUrl(url) {
    if (!carry || carry.item.m !== 'poster') return;
    const k = cleanPoster({ f: carry.item.k?.f, u: url });
    if (url.trim() && !k.u) { notify('La dirección tiene que empezar con https://'); return; }
    carry.item.k = k;
    const old = carry.obj;
    const obj = makePoster(carry.item);
    old.parent?.add(obj);
    old.removeFromParent();
    carry.obj = obj;
    if (!carry.isNew) inside.items.set(carry.item.i, obj);
    placeCarry();
    drawUI();
  }
  function cancelCarry() {
    if (!carry) return;
    if (carry.isNew) carry.obj.removeFromParent();
    else if (carry.item.m === 'poster' && carry.obj.name !== itemName(carry.before)) { // le habías cambiado la imagen
      const obj = makePoster(carry.before);
      carry.obj.parent?.add(obj); carry.obj.removeFromParent();
      inside.items.set(carry.before.i, obj); place(obj, carry.before);
    } else place(carry.obj, carry.before);
    carry = null;
    drawUI();
  }
  function drop() {
    if (!carry) return;
    const items = current(inside.key).items.filter((x) => x.i !== carry.item.i);
    items.push({ ...carry.item, p: [...carry.item.p] });
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
  stage.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.in = true; });
  stage.addEventListener('pointerleave', () => { mouse.in = false; });
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
    if (design && !e.repeat && e.code === 'KeyV') { setTopView(!topView); e.preventDefault(); return; }
    if (design && !e.repeat && e.code === 'KeyG') { setGrid(!showGrid); e.preventDefault(); return; }
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
      if (inside && inside.id !== sceneId) inside = null;
      if (!inside) { design = false; carry = null; topView = false; camera.up.set(0, 1, 0); grid = null; ui.hidden = true; exitPrompt.hidden = true; }
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
      // Vista desde arriba: la cámara mira el cuarto entero, derecho hacia abajo (el norte arriba)
      if (topView && design) {
        const { cx, cz, w, d } = inside.room;
        const half = Math.max(w / 2 / Math.max(camera.aspect, 0.1), d / 2) + 1;
        const h = half / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        camera.up.set(0, 0, -1);
        camera.position.set(cx, h, cz);
        camera.lookAt(cx, 0, cz);
        camera.updateMatrixWorld();
      }
      if (carry && topView && design && mouse.in) { // el mueble sigue al mouse sobre el piso
        const r = stage.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(((mouse.x - r.left) / r.width) * 2 - 1, -((mouse.y - r.top) / r.height) * 2 + 1), camera);
        if (ray.ray.intersectPlane(floorPlane, _hit)) carry.item.p = [_hit.x, _hit.z];
        const b = inside.bounds;
        if (b) carry.item.p = [THREE.MathUtils.clamp(carry.item.p[0], -b.x, b.x), THREE.MathUtils.clamp(carry.item.p[1], -b.z, b.z)];
        placeCarry();
      } else if (carry && p) {
        const f = p.facing;
        carry.item.p = [p.position.x + Math.sin(f) * CARRY_DIST, p.position.z + Math.cos(f) * CARRY_DIST];
        const b = inside.bounds;
        if (b) carry.item.p = [THREE.MathUtils.clamp(carry.item.p[0], -b.x, b.x), THREE.MathUtils.clamp(carry.item.p[1], -b.z, b.z)];
        placeCarry();
      }
      const nearExit = !design && Math.hypot(focus.x - inside.exit.x, focus.z - inside.exit.z) < EXIT_RADIUS;
      if (exitPrompt.hidden === nearExit) exitPrompt.hidden = !nearExit;
    },
    get nearExit() { return !!inside && !exitPrompt.hidden; },
  };
}
