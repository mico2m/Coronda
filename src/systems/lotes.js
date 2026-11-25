// Lotes: terrenos del mapa que cada jugador puede adquirir y donde se levanta una casa.
//
// En Blender: un Empty llamado lote_01, lote_03… (o con la Custom Property "lote" = 1) marca el terreno.
//   - Display As = Cube, Size = 1: el cubo (±1 en X e Y de Blender) es la zona del lote. Escalalo al tamaño del terreno.
//   - La casa aparece en el CENTRO del Empty, apoyada en su altura, con SU GIRO (la flecha verde / el frente del Empty).
//     La escala del Empty NO se le aplica: el modelo de la casa sale en metros reales.
//   - Si un modelo de casa trae objetos col_… (o colision = 1), la casa colisiona (ver collision.js).
//
// Flecha: sobre cada lote LIBRE flota una flecha que sube y baja, pero solo aparece cuando el jugador se acerca (a menos de
//   30 m del centro). Se achica y desaparece al alejarse o cuando alguien adquiere el lote.
//   En el Empty se puede ajustar con Custom Properties: lote_aviso_radio (m, 0 = sin flecha) y lote_flecha_altura (m).
//
// Casas disponibles: data/casas.json  { "maxPorJugador": 1, "casas": [{ id, nombre, archivo }] }
// El .glb de cada casa va en assets/models/objects/. El origen del modelo = el centro del lote, a nivel del suelo.
// Si el archivo todavía no existe se muestra una caja de prueba (así se puede probar el sistema antes de modelar).
//
// Cómo se juega: al entrar a la zona de un lote libre aparece "E Adquirir lote"; se elige el modelo de casa.
// Tu propio lote: "E Tu casa" para cambiar el modelo o liberar el lote. Un lote ajeno solo muestra de quién es.
//
// Cómo se comparte (sin servidor propio, ver net/multiplayer.js):
//   - cada cambio se manda en vivo a los demás jugadores,
//   - se guarda en el broker MQTT (retained), así los que entran después ven las casas aunque no haya nadie conectado,
//   - al entrar alguien le pasa el estado a los nuevos.
//   Cada lote tiene un registro { o: dueño, n: nombre, m: modelo, v: versión }. Gana la versión más alta; si dos
//   jugadores lo adquieren a la vez (misma versión) gana el de id menor, igual para todos, y el otro se entera.
//   Sin conexión ("jugar solo") el estado se guarda en el navegador (localStorage).
//
// OJO: no hay cuentas ni servidor que valide. El "dueño" es un id al azar guardado en el navegador del jugador
// (borrar los datos del sitio = perder sus lotes) y un cliente tramposo podría escribir en el broker público.
// Para algo serio hace falta un servidor propio que decida (ver README, "Lotes").
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadJSON, loadGLB } from '../core/assets.js';
import { makeUnlit, setShade } from './shading.js';

const NAME_RE = /^(?:empty_)?lote_(.+)$/i;
const KEY_RE = /^[a-z0-9_.-]{1,80}$/;
const UID_STORE = 'coronda.uid';
const MINE_STORE = 'coronda.lotes.mios';
const SOLO_STORE = 'coronda.lotes.solo';
const HEAL_DELAY = 4000; // ms: se espera a recibir lo guardado en el broker antes de reponer lo propio
const ARROW_RADIUS = 30;   // m: a esta distancia del centro del lote (o menos) aparece la flecha
const ARROW_HEIGHT = 4.5;  // m sobre el Empty
const ARROW_BOB = 0.45;    // m que sube y baja
const ARROW_COLOR = 0xffd23f;
const FALLBACK_COLORS = [0xd9a066, 0x6fa8dc, 0x93c47d, 0xe06666, 0xc27ba0];

// ¿Este modelo trae colisión propia (col_… o colision en sus propiedades)? Si no, poner o sacar la casa no cambia las colisiones
const COL_RE = /^(?:col|colision)_/i;
function hasCollision(obj) {
  let yes = false;
  obj?.traverse((o) => { const c = o.userData?.colision; if (COL_RE.test(o.name ?? '') || (c !== undefined && c !== false && c !== 0 && c !== '0')) yes = true; });
  return yes;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

function makeUid() {
  const r = () => Math.random().toString(36).slice(2, 10);
  try {
    let u = localStorage.getItem(UID_STORE);
    if (!u) { u = (globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16)) || (r() + r()); localStorage.setItem(UID_STORE, u); }
    return u;
  } catch { return r() + r(); }
}
const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)) ?? {}; } catch { return {}; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Gana la versión más alta; con la misma versión, el id de dueño menor (igual en todos los navegadores)
const beats = (a, b) => !b || a.v > b.v || (a.v === b.v && (a.o ?? '') < (b.o ?? ''));

// opts:
//   stage        elemento donde se dibujan los avisos (como en doors.js)
//   net          multijugador (o null = jugando solo)
//   name         nombre del jugador
//   blocked()    true mientras algo más usa la tecla E (una charla)
//   yieldE()     true si hay una puerta cerca: la E es de la puerta
//   onOpen/onClose   se abre/cierra el menú de casas (para frenar al jugador)
//   onChange()   cambió una casa de la escena actual (hay que rehacer las colisiones)
//   notify(msg)  avisos en pantalla
//   getShade()   tono/brillo de la escena
export function createLotes({ stage, net = null, name = 'Viajero', dev = false, blocked = () => false, yieldE = () => false, onOpen, onClose, onChange, notify = () => {}, getShade = () => ({}) }) {
  const uid = makeUid();
  const solo = !net;
  const state = new Map();       // clave -> { o, n, m, v }
  const mine = new Map(Object.entries(solo ? {} : readJSON(MINE_STORE)));
  let casas = { max: 1, map: new Map() };
  let spots = [];                // lotes de la escena actual
  let root = null, sceneId = null, unlit = true;
  let near = null, panelKey = null, sig = '';
  let templates = new Map();     // archivo -> Promise<gltf> (por escena)

  const ready = loadJSON('data/casas.json').catch(() => ({ casas: [] })).then((c) => {
    casas = { max: Math.max(1, Number(c.maxPorJugador) || 1), map: new Map((c.casas ?? []).map((x) => [x.id, { id: x.id, nombre: x.nombre ?? x.id, archivo: x.archivo ?? `assets/models/objects/${x.id}.glb` }])) };
    if (!casas.map.size) console.warn('Lotes: data/casas.json no tiene casas.');
    if (solo) for (const [k, r] of Object.entries(readJSON(SOLO_STORE))) { const c2 = clean(k, r); if (c2) state.set(k, c2); }
  });

  // ---------- Estado ----------
  function clean(key, r) {
    if (!KEY_RE.test(key) || !r || typeof r !== 'object') return null;
    const v = Math.floor(Number(r.v));
    if (!(v >= 1)) return null;
    if (r.o == null) return { o: null, n: '', m: null, v };
    const m = String(r.m ?? '');
    if (!casas.map.has(m)) return null; // un modelo que no existe
    return { o: String(r.o).slice(0, 40), n: String(r.n ?? 'Viajero').slice(0, 20), m, v };
  }

  function accept(key, rec) {
    const cur = state.get(key);
    if (cur && !beats(rec, cur)) return false;
    state.set(key, rec);
    if (solo) writeJSON(SOLO_STORE, Object.fromEntries(state));
    else {
      if (rec.o === uid) mine.set(key, rec); else mine.delete(key);
      writeJSON(MINE_STORE, Object.fromEntries(mine));
    }
    if (cur?.o === uid && rec.o !== uid) notify(rec.o ? `${rec.n || 'Alguien'} adquirió el lote antes que vos` : 'Tu lote quedó libre');
    if (panelKey === key && rec.o && rec.o !== uid) closePanel();
    render(key);
    return true;
  }

  async function receive(key, r) {
    await ready;
    const rec = clean(key, r);
    if (rec) accept(key, rec);
  }

  function publish(key, rec) {
    if (solo) return;
    net.lotes.send({ k: key, r: rec });
    net.lotes.persist(key, rec);
  }

  const stateList = () => [...state].map(([k, r]) => ({ k, r }));

  function claim(key, modelId) {
    const cur = state.get(key);
    if (cur?.o && cur.o !== uid) { notify('Ese lote ya tiene dueño'); return; }
    if (!casas.map.has(modelId)) return;
    const owned = [...state].filter(([k, r]) => r.o === uid && k !== key).length;
    if (owned >= casas.max) { notify(`Solo podés tener ${casas.max} lote${casas.max > 1 ? 's' : ''}`); return; }
    const rec = { o: uid, n: name, m: modelId, v: (cur?.v ?? 0) + 1 };
    accept(key, rec);
    publish(key, rec);
  }
  function release(key) {
    const cur = state.get(key);
    if (cur?.o !== uid) return;
    const rec = { o: null, n: '', m: null, v: cur.v + 1 };
    accept(key, rec);
    publish(key, rec);
  }

  // ---------- Red ----------
  if (net) {
    const L = net.lotes;
    const { messages, saved } = L.take();
    const handle = (d, peerId) => {
      if (!d || typeof d !== 'object') return;
      if (d.ask) { if (state.size) L.send({ all: stateList() }, peerId); return; }
      if (Array.isArray(d.all)) { for (const x of d.all.slice(0, 200)) if (x?.k) receive(String(x.k), x.r); return; }
      if (d.k) receive(String(d.k), d.r);
    };
    L.onMessage = handle;
    L.onPersisted = (k, r) => receive(k, r);
    L.onPeer = (id) => { if (state.size) L.send({ all: stateList() }, id); };
    messages.forEach(({ data, peerId }) => handle(data, peerId));
    saved.forEach(([k, r]) => receive(k, r));
    L.send({ ask: 1 }); // que los que ya están jugando me pasen el estado
    // Un rato después: lo que es mío y el broker olvidó (los brokers públicos no garantizan guardar para siempre) se repone
    setTimeout(async () => {
      await ready;
      for (const [k, r] of [...mine]) {
        const cur = state.get(k);
        if (!cur) { const rec = clean(k, r); if (rec) { accept(k, rec); publish(k, rec); } }
        else if (cur.o !== uid) mine.delete(k);
      }
      writeJSON(MINE_STORE, Object.fromEntries(mine));
    }, HEAL_DELAY);
  }

  // ---------- Flecha indicadora ----------
  function makeArrow() {
    const mat = new THREE.MeshBasicMaterial({ color: ARROW_COLOR, fog: false });
    const g = new THREE.Group();
    g.name = 'lote-flecha';
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.4, 4), mat); // punta hacia abajo
    head.rotation.x = Math.PI; head.position.y = 0.7;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.7), mat);
    shaft.position.y = 1.95;
    g.add(head, shaft);
    g.visible = false;
    return g;
  }

  // ---------- Casas en el mundo ----------
  function template(file) {
    if (!templates.has(file)) templates.set(file, loadGLB(file));
    return templates.get(file);
  }

  async function buildHouse(modelId, spot) {
    const def = casas.map.get(modelId);
    let obj;
    try {
      const gltf = await template(def.archivo);
      obj = cloneSkinned(gltf.scene);
      obj.userData = { animations: gltf.animations, objectFile: def.archivo };
      obj.traverse((o) => { o.userData.sourceFile = def.archivo; });
    } catch (err) { // todavía no existe el .glb: una caja de prueba del tamaño del lote
      console.warn(`Lotes: no se pudo cargar ${def.archivo} (${err.message}). Se muestra una caja de prueba.`);
      const w = Math.min(spot.size.x, spot.size.z) * 0.5, h = w * 0.6;
      const idx = [...casas.map.keys()].indexOf(modelId);
      obj = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), new THREE.MeshBasicMaterial({ color: FALLBACK_COLORS[idx % FALLBACK_COLORS.length] }));
      body.position.y = h / 2;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.78, h * 0.6, 4), new THREE.MeshBasicMaterial({ color: 0x7a4a3a }));
      roof.position.y = h + h * 0.3; roof.rotation.y = Math.PI / 4;
      obj.add(body, roof);
    }
    if (unlit) { makeUnlit(obj); setShade(obj, getShade()); }
    obj.name = `lote-casa:${modelId}`;
    return obj;
  }

  async function render(key) {
    const s = spots.find((x) => x.key === key);
    if (!s) return;
    const rec = state.get(key);
    const want = rec?.o ? rec.m : null;
    if (s.helper) s.helper.material.color.setHex(rec?.o ? (rec.o === uid ? 0x2dd4bf : 0xef4444) : 0x84cc16);
    if (s.model === want) return;
    s.model = want;
    const token = ++s.token;
    let house = null;
    if (want) house = await buildHouse(want, s);
    if (token !== s.token || !spots.includes(s)) return; // cambió otra vez mientras cargaba, o cambió la escena
    const hadCol = hasCollision(s.house);
    if (s.house) { s.house.removeFromParent(); s.house = null; }
    if (house) {
      house.position.copy(s.pos); house.quaternion.copy(s.quat);
      root.add(house);
      house.updateMatrixWorld(true);
      s.house = house;
    }
    // Solo se rehacen las colisiones si la casa nueva o la que se fue tenían (así no se toca nada de lo que ya funciona)
    if (!s.silent && (hadCol || hasCollision(house))) onChange?.(key);
  }

  // ---------- Panel para elegir la casa ----------
  const panel = document.createElement('div');
  panel.className = 'lote-panel';
  panel.hidden = true;
  stage.parentElement.appendChild(panel);

  function openPanel(key) {
    const s = spots.find((x) => x.key === key);
    const cur = state.get(key);
    if (!s || (cur?.o && cur.o !== uid)) return;
    panelKey = key;
    const own = cur?.o === uid;
    const items = [...casas.map.values()];
    panel.innerHTML = `<div class="lote-box">
      <h3>${esc(s.label)}${own ? ' · tu casa' : ''}</h3>
      <div class="lote-list">${items.map((c, i) => `<button type="button" data-id="${esc(c.id)}"${own && cur.m === c.id ? ' class="on"' : ''}><kbd>${i + 1}</kbd> ${esc(c.nombre)}${own && cur.m === c.id ? ' ✓' : ''}</button>`).join('') || '<p>No hay casas en data/casas.json</p>'}</div>
      <div class="lote-foot">${own ? '<button type="button" data-act="release">Liberar lote</button>' : ''}<button type="button" data-act="close">Cancelar <kbd>Esc</kbd></button></div>
    </div>`;
    panel.hidden = false;
    near = null; prompt.hidden = true; sig = '';
    onOpen?.();
  }
  function closePanel() {
    if (panelKey === null) return;
    panelKey = null;
    panel.hidden = true;
    onClose?.();
  }
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) { if (e.target === panel) closePanel(); return; }
    const key = panelKey;
    if (b.dataset.act === 'close') closePanel();
    else if (b.dataset.act === 'release') { closePanel(); release(key); }
    else if (b.dataset.id) { closePanel(); if (state.get(key)?.m !== b.dataset.id) claim(key, b.dataset.id); }
  });

  // ---------- Aviso "E Adquirir lote" ----------
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.className = 'door-prompt lote-prompt';
  prompt.hidden = true;
  prompt.addEventListener('click', () => { if (near && !blocked()) openPanel(near.key); });
  stage.parentElement.appendChild(prompt);

  window.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (panelKey !== null) {
      if (e.code === 'Escape') closePanel();
      else if (/^Digit[1-9]$/.test(e.code)) {
        const c = [...casas.map.values()][Number(e.code.slice(5)) - 1];
        const key = panelKey;
        if (c) { closePanel(); if (state.get(key)?.m !== c.id) claim(key, c.id); }
      }
      e.stopPropagation();
      return;
    }
    if (e.code === 'KeyE' && !e.repeat && near && !blocked() && !yieldE()) openPanel(near.key);
  });

  // ---------- API ----------
  return {
    // Después de cargar cada escena (y antes de armar las colisiones: las casas también pueden chocar)
    async setup(data, rootGroup) {
      await ready;
      closePanel();
      near = null; prompt.hidden = true; sig = '';
      root = rootGroup; sceneId = data.id; unlit = data.environment?.shading !== 'lit';
      templates = new Map();
      spots = [];
      root.updateMatrixWorld(true);
      (function walk(o) {
        const m = NAME_RE.exec(o.name ?? '');
        const marked = o.userData?.lote !== undefined && o.userData.lote !== false && o.userData.lote !== 0;
        if (m || marked) {
          const base = (m ? m[1] : o.name).toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
          const key = `${sceneId}.${m ? 'lote_' : ''}${base}`.slice(0, 80);
          o.matrixWorld.decompose(_p, _q, _s);
          const spot = {
            key, node: o, label: m ? `Lote ${m[1]}` : o.name, model: null, token: 0, house: null, silent: true, helper: null,
            pos: _p.clone(), quat: _q.clone(), size: _s.clone().multiplyScalar(2),
            inv: o.matrixWorld.clone().invert(),
          };
          const rad = o.userData?.lote_aviso_radio;
          spot.arrowRadius = rad !== undefined && rad !== '' && Number.isFinite(Number(rad)) ? Number(rad) : ARROW_RADIUS;
          const hgt = Number(o.userData?.lote_flecha_altura);
          spot.arrowHeight = Number.isFinite(hgt) && hgt > 0 ? hgt : ARROW_HEIGHT;
          spot.arrowK = 0;
          if (spot.arrowRadius > 0) { spot.arrow = makeArrow(); root.add(spot.arrow); }
          if (dev) { // modo desarrollador: se dibuja la zona (verde = libre · celeste = tuyo · rojo = de otro)
            const h = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: 0x84cc16 }));
            h.matrixAutoUpdate = false; h.matrix.copy(o.matrixWorld); h.name = 'lote-helper';
            root.add(h); spot.helper = h;
          }
          if (spots.some((x) => x.key === key)) console.warn(`Lotes: hay dos Empties que dan la misma clave "${key}".`);
          spots.push(spot);
          return;
        }
        o.children.forEach(walk);
      })(root);
      await Promise.all(spots.map((s) => render(s.key)));
      spots.forEach((s) => { s.silent = false; });
      console.info(`Lotes de "${sceneId}":`, spots.map((s) => `${s.key}${state.get(s.key)?.o ? ` (${state.get(s.key).n})` : ''}`));
      return spots.filter((s) => hasCollision(s.house)).length; // casas con colisión propia (si hay, hay que rehacer las colisiones)
    },

    get blocked() { return panelKey !== null; },
    get list() { return spots; },
    get uid() { return uid; },
    claim, release,

    // `focus`: punto del jugador (o de la cámara libre). Cada cuadro.
    update(focus, feetY = focus.y - 1, dt = 1 / 60) {
      // Flechas: aparecen (crecen) cuando te acercás a un lote libre y suben y bajan
      const t = performance.now() / 1000;
      const k = Math.min(1, dt * 8);
      for (const s of spots) {
        if (!s.arrow) continue;
        const free = !state.get(s.key)?.o;
        const close = Math.hypot(focus.x - s.pos.x, focus.z - s.pos.z) < s.arrowRadius;
        s.arrowK += ((free && close ? 1 : 0) - s.arrowK) * k;
        const on = s.arrowK > 0.02;
        s.arrow.visible = on;
        if (!on) continue;
        s.arrow.scale.setScalar(s.arrowK);
        s.arrow.position.set(s.pos.x, s.pos.y + s.arrowHeight + Math.sin(t * 2.6) * ARROW_BOB, s.pos.z);
        s.arrow.rotation.y = t * 1.2;
      }
      if (panelKey !== null) return;
      let best = null, bestD = Infinity;
      if (!blocked()) {
        for (const s of spots) {
          _p.copy(focus).applyMatrix4(s.inv);
          if (Math.abs(_p.x) > 1 || Math.abs(_p.z) > 1 || Math.abs(feetY - s.pos.y) > 8) continue;
          const d = Math.hypot(_p.x, _p.z);
          if (d < bestD) { best = s; bestD = d; }
        }
      }
      near = null;
      let html = '';
      if (best) {
        const r = state.get(best.key);
        if (!r?.o) { near = best; html = `<kbd>E</kbd> Adquirir ${esc(best.label.toLowerCase())}`; }
        else if (r.o === uid) { near = best; html = `<kbd>E</kbd> Tu casa`; }
        else html = `${esc(best.label)} · casa de ${esc(r.n || 'otro jugador')}`;
      }
      if (yieldE() && near) { near = null; html = ''; } // la E es de la puerta
      if (html !== sig) {
        sig = html;
        prompt.innerHTML = html;
        prompt.hidden = !html;
        prompt.classList.toggle('passive', !!html && !near);
      }
    },
  };
}
