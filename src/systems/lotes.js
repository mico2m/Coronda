// Lotes: terrenos del mapa que cada jugador puede adquirir y donde se levanta una casa.
//
// En Blender: un Empty llamado lote_01, lote_03… (o con la Custom Property "lote" = 1) marca el terreno.
//   - Display As = Cube, Size = 1: el cubo (±1 en X e Y de Blender) es la zona del lote. Escalalo al tamaño del terreno.
//   - La casa aparece en el CENTRO del Empty, apoyada en su altura, con SU GIRO (la flecha verde / el frente del Empty).
//     En el .glb de la casa, un Empty "casa_centro" (en el suelo, en el medio de la casa) es el punto que se pone sobre el
//     Empty del lote, con su giro en vertical (el frente de la casa). Sin ese Empty se usa el origen del modelo.
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
// Tu propio lote: "E Tu casa" para entrar, cederlo o destruir la casa. El modelo queda fijo: para cambiarlo hay que
// destruirla y volver a adquirir el lote (se pierde todo). Un lote ajeno se puede visitar.
//
// PUERTA DE LA CASA: si el .glb de la casa trae un objeto (Empty o malla) llamado "casa_puerta", se entra por ahí:
// al acercarte a esa puerta aparece "E Entrar" (tuya) o "E Casa de <dueño>" (ajena) y la E te mete directo a la casa.
// Ya NO se entra acercándose al Empty del lote: con una casa que trae casa_puerta, ese Empty solo sirve para adquirir el
// lote (cuando está libre) y, siendo el dueño, para administrarlo (vender, ceder o destruir la casa).
// Las casas que NO traen casa_puerta siguen como siempre (se entra desde la zona del lote).
//   En casa_puerta se puede ajustar con la Custom Property puerta_radio (m, por defecto 2): hasta dónde se te ofrece entrar.
//
// Cómo se comparte (sin servidor propio, ver net/multiplayer.js):
//   - cada cambio se manda en vivo a los demás jugadores,
//   - se guarda en el broker MQTT (retained), así los que entran después ven las casas aunque no haya nadie conectado,
//   - al entrar alguien le pasa el estado a los nuevos.
//   Cada lote tiene un registro { o: dueño, n: nombre, m: modelo, v: versión }. Gana la versión más alta; si dos
//   jugadores lo adquieren a la vez (misma versión) gana el de id menor, igual para todos, y el otro se entera.
//   Sin conexión ("jugar solo") el estado se guarda en el navegador (localStorage).
//
// Con el servidor propio (index.html) el que decide es el SERVIDOR: adquirir, destruir y ceder se le piden con
// net.rpc('lote.…') y él valida (que esté libre, el máximo por jugador, que sea tuyo) y avisa a todos.
// El dueño es el id de tu CUENTA (no el nombre): nadie puede quedarse con tu lote poniéndose tu nombre.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadJSON, loadGLB } from '../core/assets.js';
import { makeUnlit, setShade } from './shading.js';
import { getUid } from '../net/uid.js';

const EYE_HEIGHT = 1.7; // el Empty va en el suelo; la cámara se pone a esta altura (igual que en spawns.js)

const NAME_RE = /^(?:empty_)?lote_(.+)$/i;
const PUERTA_RE = /^casa_puerta(?:[._]?\d+)?$/i; // el objeto de la puerta dentro del .glb de la casa (Blender agrega .001 si se duplica)
const PUERTA_RADIO = 2;                            // m: a esta distancia de la puerta (o menos) aparece "E Entrar"
const KEY_RE = /^[a-z0-9_.-]{1,80}$/;
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

const makeUid = getUid; // ver net/uid.js (sin servidor: id del navegador)
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
export function createLotes({ stage, net = null, name = 'Viajero', dev = false, blocked = () => false, yieldE = () => false, onOpen, onClose, onChange, onRedraw, onEnterHouse, onReleased, notify = () => {}, getShade = () => ({}), getInventario = () => null }) {
  const uid = net ? net.uid : makeUid(); // con servidor: el id de tu cuenta
  const solo = !net;
  const state = new Map();       // clave -> { o, n, m, v }
  const mine = new Map(); // (con servidor, lo tuyo lo sabe el servidor)
  let casas = { max: 1, map: new Map() };
  let spots = [];                // lotes de la escena actual
  let root = null, sceneId = null, unlit = true;
  let adminDoor = null; // lote tuyo cuya casa_puerta tenés cerca: se ofrece "Administrar" (vender · ceder · destruir)
  let near = null, nearDoor = null, panelKey = null, sig = ''; // near: zona del lote · nearDoor: lote cuya casa_puerta tenés cerca
  let templates = new Map();     // archivo -> Promise<gltf> (por escena)

  // costo: lo que cuesta adquirir el lote con esa casa, { madera: 50 } (data/casas.json, o el Studio). Vacío = gratis.
  const limpiarCosto = (c) => Object.fromEntries(Object.entries(c ?? {}).map(([k, v]) => [k, Math.max(0, Math.floor(Number(v) || 0))]).filter(([, v]) => v > 0));
  const costoTxt = (c) => Object.entries(c ?? {}).map(([k, v]) => `${v} ${getInventario()?.nameOf?.('recursos', k) ?? k}`).join(' + ');
  function leerCasas(c) {
    return { max: Math.max(1, Number(c.maxPorJugador) || 1), map: new Map((c.casas ?? []).map((x) => [x.id, { id: x.id, nombre: x.nombre ?? x.id, archivo: x.archivo ?? `assets/models/objects/${x.id}.glb`, costo: limpiarCosto(x.costo) }])) };
  }
  const ready = loadJSON('data/casas.json').catch(() => ({ casas: [] })).then((c) => {
    casas = leerCasas(c);
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
    // c: id de esta casa (cambia cada vez que el lote se adquiere de nuevo: su interior arranca vacío, ver casas.js)
    const c = typeof r.c === 'string' && /^[a-z0-9]{4,24}$/i.test(r.c) ? r.c : null;
    return { o: String(r.o).slice(0, 40), n: String(r.n ?? 'Viajero').slice(0, 20), m, v, c };
  }

  function accept(key, rec) {
    const cur = state.get(key);
    if (cur && !beats(rec, cur)) return false;
    state.set(key, rec);
    if (solo) writeJSON(SOLO_STORE, Object.fromEntries(state));
    if (rec.o === uid && cur?.o && cur.o !== uid) notify(`${cur.n || 'Alguien'} te cedió un lote: ¡ya es tuyo!`);
    if (cur?.o === uid && rec.o !== uid) notify(rec.o ? `${rec.n || 'Alguien'} adquirió el lote antes que vos` : 'Tu lote quedó libre');
    if (panelKey === key && rec.o && rec.o !== uid) closePanel();
    render(key);
    return true;
  }

  async function receive(key, r) {
    await ready;
    if (!r && net) { if (state.delete(key)) render(key); return; }
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
    if (net) { net.rpc('lote.adquirir', { k: key, m: modelId }).then(() => notify('¡El lote es tuyo!')).catch((e) => notify(e.message)); return; }
    const cur = state.get(key);
    if (cur?.o && cur.o !== uid) { notify('Ese lote ya tiene dueño'); return; }
    if (!casas.map.has(modelId)) return;
    const owned = [...state].filter(([k, r]) => r.o === uid && k !== key).length;
    if (owned >= casas.max) { notify(`Solo podés tener ${casas.max} lote${casas.max > 1 ? 's' : ''}`); return; }
    // Jugando solo se cobra acá (con servidor lo cobra el servidor)
    const costo = cur?.o === uid ? {} : casas.map.get(modelId).costo;
    if (Object.keys(costo).length) {
      const inv = getInventario();
      if (!inv?.pay?.(costo)) { notify(`Te falta para el lote: cuesta ${costoTxt(costo)}`); return; }
    }
    // Si ya era tuyo (cambiás el modelo) la casa sigue siendo la misma; si no, es una casa nueva con su interior vacío
    const c = cur?.o === uid && cur.c ? cur.c : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const rec = { o: uid, n: name, m: modelId, v: (cur?.v ?? 0) + 1, c };
    accept(key, rec);
    publish(key, rec);
  }
  function release(key) {
    const cur = state.get(key);
    if (cur?.o !== uid) return;
    if (net) {
      net.rpc('lote.liberar', { k: key }).then((r) => notify(r?.perdido ? `Destruiste tu casa. ${r.perdido} cosas de los cofres no entraron en tu mochila.` : 'Destruiste tu casa: el lote quedó libre (lo de los cofres volvió a tu mochila)')).catch((e) => notify(e.message));
      return;
    }
    const rec = { o: null, n: '', m: null, v: cur.v + 1 };
    accept(key, rec);
    publish(key, rec);
    onReleased?.(key); // se borra el interior (ver casas.js)
  }

  // Ceder el lote a otro jugador (por su nombre): pasa a ser suyo, con una casa NUEVA (el interior se borra)
  async function cede(key, targetName) {
    const cur = state.get(key);
    if (cur?.o !== uid || solo) return 'no';
    try { return (await net.rpc('lote.ceder', { k: key, nombre: targetName })).r; } catch { return 'no'; }
    const who = net.findPlayer(targetName);
    if (!who) return 'nadie';
    if (who.u === uid) return 'vos';
    const owned = [...state].filter(([k, r]) => r.o === who.u && k !== key).length;
    if (owned >= casas.max) return 'lleno';
    const c = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const rec = { o: who.u, n: String(who.n).slice(0, 20), m: cur.m, v: cur.v + 1, c };
    accept(key, rec);
    publish(key, rec);
    onReleased?.(key); // se borra el interior (ver casas.js)
    return 'ok';
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
    obj.userData.centro = centroCasa(obj); // antes de mover la casa
    await addMailbox(obj, spot);
    if (unlit) { makeUnlit(obj); setShade(obj, getShade()); }
    obj.name = `lote-casa:${modelId}`;
    return obj;
  }
  // Buzón de la casa: un objeto "buzon" en el .glb de la casa (ver blender/agregar_buzon.py). Se renombra
  // lote_<número>_buzon para que la tienda sepa dónde dejar la nota. Si la casa no trae, se pone buzon.glb al frente.
  async function addMailbox(obj, spot) {
    const nro = Number(/(\d+)\s*$/.exec(spot.key)?.[1] ?? 0);
    let b = null;
    obj.traverse((o) => { if (!b && /^buzon$/i.test(o.name)) b = o; });
    if (!b) {
      try {
        const g = await template('assets/models/objects/buzon.glb');
        b = cloneSkinned(g.scene);
        const box = new THREE.Box3().setFromObject(obj);
        b.position.set(box.max.x - 1, 0, box.max.z + 0.8); // al frente (+Z) a la derecha
        obj.add(b);
      } catch { return; }
    }
    b.name = `lote_${nro}_buzon`;
  }

  // Centro de la casa: un Empty "casa_centro" dentro del .glb de la casa. Ese punto (y hacia dónde mira, solo el giro en
  // vertical) es el que se pone sobre el Empty del lote del mundo. Va en el suelo, en el medio de la casa; así el origen del
  // modelo da igual. Sin ese Empty se usa el origen del modelo, como siempre. Se lee con la casa todavía sin mover.
  function centroCasa(house) {
    let punto = null;
    house.updateMatrixWorld(true);
    house.traverse((o) => { if (!punto && /^casa_centro(?:[._]?\d+)?$/i.test(o.name)) punto = o; });
    if (!punto) return null;
    const pos = punto.getWorldPosition(new THREE.Vector3());
    const yaw = new THREE.Euler().setFromQuaternion(punto.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y;
    return { pos, yaw };
  }
  // Puerta de la casa: el objeto "casa_puerta" del .glb. Se guarda su caja en el mundo (la casa ya está colocada y no se mueve)
  // para medir cuánto falta hasta ella. Devuelve null si la casa no trae esa puerta.
  function buscarPuerta(house) {
    if (!house) return null;
    let obj = null;
    house.traverse((o) => { if (!obj && PUERTA_RE.test(o.name ?? '')) obj = o; });
    if (!obj) return null;
    house.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) { const p = obj.getWorldPosition(new THREE.Vector3()); box.set(p.clone(), p.clone()); } // un Empty: es un punto
    const r = Number(obj.userData?.puerta_radio);
    return { obj, box, radio: Number.isFinite(r) && r > 0 ? r : PUERTA_RADIO };
  }
  // Distancia (en el piso) desde el jugador hasta la puerta; Infinity si está en otro piso o la casa no trae puerta
  function distPuerta(s, focus, feetY) {
    const pu = s.puerta;
    if (!pu) return Infinity;
    if (feetY < pu.box.min.y - 2.5 || feetY > pu.box.max.y + 1.5) return Infinity;
    const dx = Math.max(pu.box.min.x - focus.x, 0, focus.x - pu.box.max.x);
    const dz = Math.max(pu.box.min.z - focus.z, 0, focus.z - pu.box.max.z);
    return Math.hypot(dx, dz);
  }
  // Entrar a la casa de un lote (la tuya o, para visitar, la de otro)
  function entrarPorPuerta(key) {
    nearDoor = null; near = null; adminDoor = null; prompt.hidden = true; adminPrompt.hidden = true; sig = '';
    onEnterHouse?.(key, spotInfo(key));
  }

  // Pone la casa en el lote: el casa_centro (o el origen del modelo) queda sobre el centro del lote, con el giro del lote
  function colocarCasa(house, spot) {
    const c = house.userData.centro;
    house.quaternion.copy(spot.quat);
    house.position.copy(spot.pos);
    if (!c) return;
    house.quaternion.multiply(_q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -c.yaw));
    house.position.sub(_p.copy(c.pos).applyQuaternion(house.quaternion));
  }

  async function render(key) {
    const s = spots.find((x) => x.key === key);
    if (!s) return;
    const rec = state.get(key);
    const want = rec?.o ? rec.m : null;
    if (s.helper) s.helper.material.color.setHex(rec?.o ? (rec.o === uid ? 0x2dd4bf : 0xef4444) : 0x84cc16);
    if (s.model === want) { cartelDueño(s.house, rec?.n); return; } // misma casa, quizá otro dueño (la cedieron)
    s.model = want;
    const token = ++s.token;
    let house = null;
    if (want) house = await buildHouse(want, s);
    if (token !== s.token || !spots.includes(s)) return; // cambió otra vez mientras cargaba, o cambió la escena
    const hadCol = hasCollision(s.house);
    if (s.house) { s.house.removeFromParent(); s.house = null; }
    s.puerta = null;
    if (house) {
      colocarCasa(house, s);
      root.add(house);
      house.updateMatrixWorld(true);
      s.house = house;
      s.puerta = buscarPuerta(house); // si la casa trae casa_puerta, se entra por ahí (ver update)
      if (s.puerta) console.info(`Lotes: la casa de "${s.key}" trae "${s.puerta.obj.name}": se entra por la puerta.`);
      cartelDueño(house, state.get(key)?.n);
    }
    // Solo se rehacen las colisiones si la casa nueva o la que se fue tenían (así no se toca nada de lo que ya funciona)
    if (!s.silent && (hadCol || hasCollision(house))) onChange?.(key);
    if (!s.silent) onRedraw?.(key); // cambió el dibujo del mapa (minimapa)
  }

  // Cartel con el nombre del dueño: en el Empty "cartel_dueno" del modelo de la casa (ver blender/agregar_cartel_casa.py).
  // El nombre NO está en el .glb: se escribe acá, con el dueño que dice el servidor, y cambia si la casa cambia de dueño.
  // Sin ese Empty se pone sobre la puerta, al frente de la casa.
  function cartelDueño(house, nombre) {
    if (!house) return;
    let punto = null;
    house.traverse((o) => { if (!punto && /^cartel_dueno$/i.test(o.name)) punto = o; });
    let cartel = house.getObjectByName('cartel-dueño-texto');
    const texto = nombre ? `Casa de ${nombre}` : '';
    if (cartel?.userData.texto === texto) return;
    if (cartel) { cartel.removeFromParent(); cartel.material.map.dispose(); cartel.material.dispose(); cartel = null; }
    if (!texto) return;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const size = 44;
    ctx.font = `700 ${size}px Cinzel, Georgia, serif`;
    c.width = Math.min(1024, Math.ceil(ctx.measureText(texto).width) + 48); c.height = 84;
    ctx.font = `700 ${size}px Cinzel, Georgia, serif`;
    ctx.fillStyle = '#f3e3c3'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#6f421f'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, c.width - 6, c.height - 6);
    ctx.fillStyle = '#3b2412'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(texto, c.width / 2, c.height / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const alto = 0.4, ancho = Math.min(1.9, (alto * c.width) / c.height);
    // un plano (no un sprite): queda pegado al cartel de madera, como algo pintado; se ve de los dos lados
    cartel = new THREE.Mesh(new THREE.PlaneGeometry(ancho, alto), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: false }));
    cartel.name = 'cartel-dueño-texto';
    cartel.userData.texto = texto;
    if (punto) {
      // el Empty mira hacia adelante (-Y de Blender = +Z del juego): el texto se apoya en esa cara
      punto.add(cartel);
      cartel.position.set(0, 0, 0.03);
    } else {
      // medidas de la casa en sus propias coordenadas (sin el lugar ni el giro del lote)
      const p0 = house.position.clone(), q0 = house.quaternion.clone();
      house.position.set(0, 0, 0); house.quaternion.identity(); house.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(house);
      house.position.copy(p0); house.quaternion.copy(q0); house.updateMatrixWorld(true);
      cartel.position.set(0, Math.max(1.2, box.max.y - 0.6), box.max.z + 0.05);
      house.add(cartel);
    }
  }

  // Dónde está el lote (para volver al salir de la casa): escena, centro, giro y tamaño
  // Entrada de la casa: un Empty "casa_entrada" dentro del .glb de la casa (también vale el nombre viejo "entrada_casa").
  // Es el punto de la puerta, afuera, por donde aparece el jugador al salir de la casa:
  // el Empty va en el suelo, delante de la puerta, y su frente (el mismo que el del cartel_dueno: -Y de Blender = +Z del juego)
  // marca hacia dónde mira el jugador al aparecer. Sin ese Empty se usa el cálculo de siempre (delante del lote, en game.js).
  function entradaCasa(house, sp = null) {
    if (!house) return null;
    let punto = null;
    house.updateMatrixWorld(true);
    house.traverse((o) => { if (!punto && /^(?:casa_entrada|entrada_casa)(?:[._]?\d+)?$/i.test(o.name)) punto = o; });
    if (!punto && sp?.puerta) {
      // Sin casa_entrada: se sale por la casa_puerta, afuera de la casa (del centro del lote hacia la puerta), mirando hacia afuera
      const pu = sp.puerta, c = pu.box.getCenter(new THREE.Vector3());
      const out = new THREE.Vector3(c.x - sp.pos.x, 0, c.z - sp.pos.z);
      if (out.lengthSq() > 1e-4) {
        out.normalize();
        const dist = 0.5 * Math.max(pu.box.max.x - pu.box.min.x, pu.box.max.z - pu.box.min.z) + 1.2;
        return { position: [c.x + out.x * dist, pu.box.min.y + EYE_HEIGHT, c.z + out.z * dist], yaw: Math.atan2(-out.x, -out.z) };
      }
    }
    if (!punto) {
      // Diagnóstico: qué nodos sin geometría (Empties) llegaron del .glb, para ver si el nombre quedó distinto
      const empties = [];
      house.traverse((o) => { if (o !== house && !o.isMesh && !o.isBone && !o.isLight && !o.isCamera && o.name) empties.push(o.name); });
      console.warn(`Lotes: la casa "${house.name}" no trae el Empty "casa_entrada". Nodos sin geometría que sí llegaron: ${empties.join(', ') || '(ninguno)'}. Se sale delante del lote.`);
      return null;
    }
    const p = punto.getWorldPosition(new THREE.Vector3());
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(punto.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
    console.info(`Lotes: se sale por "${punto.name}" en (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}).`);
    return { position: [p.x, p.y + EYE_HEIGHT, p.z], yaw: Math.atan2(-f.x, -f.z) };
  }

  // Dónde está el lote (para volver al salir de la casa): escena, centro, giro y tamaño (+ entrada, si la casa trae el Empty casa_entrada)
  function spotInfo(key) {
    const sp = spots.find((x) => x.key === key);
    if (!sp) return null;
    return { scene: sceneId, key, pos: sp.pos.toArray(), quat: sp.quat.toArray(), size: sp.size.toArray(), label: sp.label, entrada: entradaCasa(sp.house, sp) };
  }

  // ---------- Panel para elegir la casa ----------
  const panel = document.createElement('div');
  panel.className = 'lote-panel';
  panel.hidden = true;
  stage.parentElement.appendChild(panel);

  function openPanel(key, view = 'main') {
    const s = spots.find((x) => x.key === key);
    const cur = state.get(key);
    if (!s) return;
    panelKey = key;
    const own = cur?.o === uid;
    const other = cur?.o && !own;
    const items = [...casas.map.values()];
    let body;
    if (view === 'sell') { // vender a otro jugador por madera: él tiene que aceptar
      body = `<h3>Vender ${esc(s.label.toLowerCase())}</h3>
        <label class="lote-field">Nombre del jugador (tiene que estar conectado)<input class="lote-input" data-f="nombre" maxlength="20" autocomplete="off" spellcheck="false"></label>
        <label class="lote-field">Precio en madera<input class="lote-input" data-f="precio" type="number" min="1" max="999" step="1" value="50"></label>
        <p class="lote-warn">Le llega la oferta y puede aceptarla o no. Si acepta, se le pasan el lote y la casa y recibís la madera, pero <b>todo lo que tenés adentro se borra</b> (lo de los cofres vuelve a tu mochila). No se puede deshacer.</p>
        <p class="lote-msg" aria-live="polite"></p>
        <div class="lote-foot"><button type="button" data-act="sell" class="danger">Ofrecer</button><button type="button" data-act="back">Cancelar <kbd>Esc</kbd></button></div>`;
    } else if (view === 'cede') { // ceder a otro jugador: también se borra todo lo de adentro
      body = `<h3>Ceder ${esc(s.label.toLowerCase())}</h3>
        <label class="lote-field">Nombre del jugador<input class="lote-input" maxlength="20" autocomplete="off" spellcheck="false"></label>
        <p class="lote-warn">El lote y la casa pasan a ser de ese jugador, pero <b>todo lo que tiene adentro se borra</b> (los muebles y el diseño). No se puede deshacer.</p>
        <p class="lote-msg" aria-live="polite"></p>
        <div class="lote-foot"><button type="button" data-act="cede" class="danger">Ceder lote</button><button type="button" data-act="back">Cancelar <kbd>Esc</kbd></button></div>`;
    } else if (view === 'destroy') { // confirmación antes de destruir: se borra todo
      body = `<h3>¿Destruir tu casa?</h3>
        <p class="lote-warn">Se borra la casa y <b>todo lo que tiene adentro</b> (los muebles y el diseño). El lote queda libre para cualquiera. No se puede deshacer.</p>
        <div class="lote-foot"><button type="button" data-act="destroy" class="danger">Sí, destruir</button><button type="button" data-act="back">Cancelar <kbd>Esc</kbd></button></div>`;
    } else if (other) { // casa de otro jugador: se puede visitar
      body = `<h3>${esc(s.label)} · casa de ${esc(cur.n || 'otro jugador')}</h3>
        <div class="lote-foot"><button type="button" data-act="enter">Visitar la casa <kbd>E</kbd></button><button type="button" data-act="close">Cancelar <kbd>Esc</kbd></button></div>`;
    } else {
      body = `<h3>${esc(s.label)}${own ? ' · tu casa' : ''}</h3>
        ${own ? `${s.puerta ? '' : '<button type="button" data-act="enter" class="lote-enter">Entrar a la casa <kbd>E</kbd></button>'}
          <p class="lote-note">Tu casa: ${esc(casas.map.get(cur.m)?.nombre ?? cur.m)}.${s.puerta ? ' Para entrar, usá la puerta de la casa.' : ''} Para cambiar de modelo hay que destruirla y volver a adquirir el lote (se pierde todo lo de adentro).</p>`
          : `<div class="lote-list">${items.map((c, i) => `<button type="button" data-id="${esc(c.id)}"><kbd>${i + 1}</kbd> ${esc(c.nombre)}${Object.keys(c.costo).length ? ` <small>· ${esc(costoTxt(c.costo))}</small>` : ' <small>· gratis</small>'}</button>`).join('') || '<p>No hay casas en data/casas.json</p>'}</div>`}
        <div class="lote-foot">${own && !solo ? '<button type="button" data-act="ask-sell">Vender lote</button><button type="button" data-act="ask-cede">Ceder lote</button>' : ''}${own ? '<button type="button" data-act="ask-destroy" class="danger">Destruir casa</button>' : ''}<button type="button" data-act="close">Cancelar <kbd>Esc</kbd></button></div>`;
    }
    panel.innerHTML = `<div class="lote-box" data-view="${view}">${body}</div>`;
    panel.hidden = false;
    near = null; nearDoor = null; adminDoor = null; prompt.hidden = true; adminPrompt.hidden = true; sig = '';
    if (view === 'cede' || view === 'sell') setTimeout(() => panel.querySelector('.lote-input')?.focus(), 0);
    onOpen?.();
  }
  panel.addEventListener('keydown', (e) => {
    if (!e.target.classList?.contains('lote-input')) return;
    if (e.key === 'Enter') { e.preventDefault(); if (panel.querySelector('.lote-box')?.dataset.view === 'sell') doSell(panelKey); else doCede(panelKey); }
    else if (e.key === 'Escape') { e.preventDefault(); openPanel(panelKey); }
    else panel.querySelector('.lote-msg').textContent = '';
    e.stopPropagation(); // las letras no mueven al personaje
  });
  // Vender: le manda la oferta al otro jugador (el servidor la valida); él acepta o rechaza
  async function doSell(key) {
    const name = panel.querySelector('[data-f="nombre"]')?.value.trim() ?? '';
    const precio = Math.floor(Number(panel.querySelector('[data-f="precio"]')?.value));
    const msg = panel.querySelector('.lote-msg');
    if (!name) { if (msg) msg.textContent = 'Escribí el nombre del jugador.'; return; }
    if (!(precio >= 1)) { if (msg) msg.textContent = 'Poné un precio de al menos 1.'; return; }
    try {
      const r = await net.rpc('lote.vender', { k: key, nombre: name, precio });
      const texts = { nadie: `No hay ningún jugador llamado "${name}".`, vos: 'Ese sos vos.', desconectado: 'Ese jugador no está conectado.', lleno: `Ese jugador ya tiene ${casas.max} lote${casas.max > 1 ? 's' : ''}.` };
      if (r?.r !== 'ok') { if (msg) msg.textContent = texts[r?.r] ?? 'No se pudo ofrecer el lote.'; return; }
      closePanel();
      notify(`Le ofreciste el lote a ${r.nombre ?? name} por ${precio} de madera. Esperá su respuesta.`);
    } catch (e) { if (msg) msg.textContent = e.message; }
  }

  // Oferta que te llega (otro jugador te vende su lote): un cartel con Comprar / Rechazar, sin frenar al personaje
  const oferta = document.createElement('div');
  oferta.className = 'lote-oferta lote-box';
  oferta.hidden = true;
  stage.parentElement.appendChild(oferta);
  let ofertaT = null;
  function cerrarOferta() { clearTimeout(ofertaT); oferta.hidden = true; oferta.innerHTML = ''; }
  function mostrarOferta(m) {
    clearTimeout(ofertaT);
    oferta.innerHTML = `<h3>💰 ${esc(m.de)} te vende el lote ${esc(m.nro ?? '')}</h3>
      <p class="lote-warn">Cuesta <b>${esc(m.precio)} de ${esc(m.moneda ?? 'madera')}</b>. Es una casa nueva: el interior arranca vacío. La oferta vence en ${esc(m.seg ?? 60)} segundos.</p>
      <p class="lote-msg" aria-live="polite"></p>
      <div class="lote-foot"><button type="button" data-of="si">Comprar</button><button type="button" data-of="no" class="danger">Rechazar</button></div>`;
    oferta.dataset.id = m.id;
    oferta.hidden = false;
    ofertaT = setTimeout(cerrarOferta, (Number(m.seg) || 60) * 1000);
  }
  oferta.addEventListener('pointerdown', (e) => e.stopPropagation());
  oferta.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-of]'); if (!b || !net) return;
    const ok = b.dataset.of === 'si', msg = oferta.querySelector('.lote-msg');
    try {
      await net.rpc('lote.responder', { id: oferta.dataset.id, ok });
      cerrarOferta();
      notify(ok ? '¡Compraste el lote! Ya es tuyo.' : 'Rechazaste la oferta.');
    } catch (err) { if (msg) msg.textContent = err.message; if (/venci|disponible|cambi/i.test(err.message)) setTimeout(cerrarOferta, 2500); }
  });
  if (net) net.onOfertaLote = mostrarOferta;

  async function doCede(key) {
    const name = panel.querySelector('.lote-input')?.value.trim() ?? '';
    const msg = panel.querySelector('.lote-msg');
    const r = await cede(key, name);
    const texts = { nadie: `No hay ningún jugador llamado "${name}".`, vos: 'Ese sos vos.', lleno: `Ese jugador ya tiene ${casas.max} lote${casas.max > 1 ? 's' : ''}.`, no: 'No se puede ceder este lote.' };
    if (r !== 'ok') { if (msg) msg.textContent = texts[r] ?? ''; return; }
    closePanel();
    notify(`Le cediste el lote a ${state.get(key)?.n ?? name}`);
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
    else if (b.dataset.act === 'ask-destroy') openPanel(key, 'destroy');
    else if (b.dataset.act === 'ask-cede') openPanel(key, 'cede');
    else if (b.dataset.act === 'ask-sell') openPanel(key, 'sell');
    else if (b.dataset.act === 'sell') doSell(key);
    else if (b.dataset.act === 'cede') doCede(key);
    else if (b.dataset.act === 'back') openPanel(key);
    else if (b.dataset.act === 'destroy') { closePanel(); release(key); if (!net) notify('Destruiste tu casa: el lote quedó libre'); }
    else if (b.dataset.act === 'enter') { closePanel(); onEnterHouse?.(key, spotInfo(key)); }
    else if (b.dataset.id) { closePanel(); if (!state.get(key)?.o) claim(key, b.dataset.id); }
  });

  // ---------- Aviso "E Adquirir lote" ----------
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.className = 'door-prompt lote-prompt';
  prompt.hidden = true;
  prompt.addEventListener('click', () => {
    if (blocked()) return;
    if (nearDoor) entrarPorPuerta(nearDoor.key);
    else if (near) openPanel(near.key);
  });
  stage.parentElement.appendChild(prompt);
  // Segundo aviso, solo para el dueño frente a su casa_puerta: abre el menú de vender / ceder / destruir
  const adminPrompt = document.createElement('button');
  adminPrompt.type = 'button';
  adminPrompt.className = 'door-prompt lote-prompt admin';
  adminPrompt.hidden = true;
  adminPrompt.innerHTML = '<kbd>G</kbd> Administrar lote';
  adminPrompt.addEventListener('click', () => { if (!blocked() && adminDoor) openPanel(adminDoor.key); });
  stage.parentElement.appendChild(adminPrompt);

  window.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (panelKey !== null) {
      const view = panel.querySelector('.lote-box')?.dataset.view;
      const r = state.get(panelKey);
      if (e.code === 'Escape') { if (view === 'destroy' || view === 'cede' || view === 'sell') openPanel(panelKey); else closePanel(); }
      else if (e.code === 'KeyE' && !e.repeat && view === 'main' && r?.o && !spots.find((x) => x.key === panelKey)?.puerta) { const key = panelKey; closePanel(); onEnterHouse?.(key, spotInfo(key)); } // (con casa_puerta se entra por la puerta)
      else if (/^Digit[1-9]$/.test(e.code) && view === 'main' && !r?.o) { // solo para adquirir: el modelo no se cambia después
        const c = [...casas.map.values()][Number(e.code.slice(5)) - 1];
        const key = panelKey;
        if (c) { closePanel(); if (state.get(key)?.m !== c.id) claim(key, c.id); }
      }
      e.stopPropagation();
      return;
    }
    if (e.code === 'KeyG' && !e.repeat && !blocked() && !yieldE() && adminDoor) { openPanel(adminDoor.key); return; } // el dueño, frente a su casa_puerta: vender · ceder · destruir
    if (e.code === 'KeyE' && !e.repeat && !blocked() && !yieldE()) {
      if (nearDoor) entrarPorPuerta(nearDoor.key); // frente a la casa_puerta: directo adentro
      else if (near) openPanel(near.key);
    }
  });

  // ---------- API ----------
  return {
    // Después de cargar cada escena (y antes de armar las colisiones: las casas también pueden chocar)
    async setup(data, rootGroup) {
      await ready;
      closePanel();
      near = null; nearDoor = null; adminDoor = null; prompt.hidden = true; adminPrompt.hidden = true; sig = '';
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
          // Un Empty espejado (escala negativa, ej. Ctrl+M o Scale -1) no se puede traducir a un giro: la casa NO sale espejada
          // y su orientación no coincide con lo que se ve en Blender. Para mirar al revés se rota 180° en Z, con escala positiva.
          if (o.matrixWorld.determinant() < 0) console.warn(`Lotes: el Empty "${o.name}" está espejado (escala negativa). En Blender usá rotación Z 180° con escala positiva (Ctrl+A > Scale) o la casa saldrá mal orientada y corrida.`);
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
    record: (key) => state.get(key) ?? null,   // { o, n, m, v, c } del lote
    spotInfo,
    // Para el minimapa: los lotes libres (amarillo) y los tuyos (celeste)
    mapMarks() {
      const out = [];
      for (const sp of spots) {
        const r = state.get(sp.key);
        if (!r?.o) out.push({ x: sp.pos.x, z: sp.pos.z, color: '#ffd23f' });
        else if (r.o === uid) out.push({ x: sp.pos.x, z: sp.pos.z, color: '#2dd4bf' });
      }
      return out;
    },
    get list() { return spots; },
    get uid() { return uid; },
    // Tus lotes en esta escena (para "¿Dónde querés aparecer?"): los que el estado dice que son tuyos y, si el estado
    // todavía no llegó del servidor, los que este navegador recuerda como tuyos
    myLots() {
      return spots.map((sp) => sp.key).filter((k) => {
        const r = state.get(k);
        return r ? r.o === uid : mine.has(k);
      });
    },
    // Antes de entrar a tu casa: espera un poco a que llegue el registro del lote; si no llega, se repone el que recordás
    async ensureMine(key, ms = 3000) {
      await ready;
      const t0 = performance.now();
      while (!state.get(key) && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 150));
      if (!net && !state.get(key) && mine.has(key)) { const rec = clean(key, mine.get(key)); if (rec) { accept(key, rec); publish(key, rec); } }
      return state.get(key)?.o === uid;
    },
    claim, release,
    // (Studio) cambia en vivo el máximo por jugador y el costo de cada casa: el contenido de data/casas.json
    setCasas(c) { if (c && typeof c === 'object') casas = leerCasas(c); },

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
      near = null; nearDoor = null;
      let html = '';
      // 1) Puerta de una casa (casa_puerta): tiene prioridad sobre la zona del lote
      let door = null, doorD = Infinity;
      if (!blocked()) {
        for (const s of spots) {
          if (!s.puerta || !state.get(s.key)?.o) continue;
          const d = distPuerta(s, focus, feetY);
          if (d <= s.puerta.radio && d < doorD) { door = s; doorD = d; }
        }
      }
      adminDoor = null;
      if (door) {
        const r = state.get(door.key);
        nearDoor = door;
        if (r.o === uid) adminDoor = door;
        html = r.o === uid ? `<kbd>E</kbd> Entrar a tu casa` : `<kbd>E</kbd> Entrar a la casa de ${esc(r.n || 'otro jugador')}`;
      } else if (best) {
        // 2) Zona del lote: solo sirve para adquirirlo cuando está libre. Con dueño y casa_puerta, la zona ya no ofrece nada:
        //    entrar, vender, ceder y destruir se hacen por la puerta. Si el lote se libera, la zona vuelve a funcionar sola.
        const r = state.get(best.key);
        if (!r?.o) { near = best; html = `<kbd>E</kbd> Adquirir ${esc(best.label.toLowerCase())}`; }
        else if (best.puerta) { /* con dueño y casa_puerta: todo se hace por la puerta (entrar, vender, ceder, destruir) */ }
        else if (r.o === uid) { near = best; html = `<kbd>E</kbd> Tu casa`; }
        else { near = best; html = `<kbd>E</kbd> Casa de ${esc(r.n || 'otro jugador')}`; }
      }
      if (yieldE() && (near || nearDoor)) { near = null; nearDoor = null; adminDoor = null; html = ''; } // la E es de la puerta del mundo (doors.js)
      if (adminPrompt.hidden === !!adminDoor) adminPrompt.hidden = !adminDoor;
      if (html !== sig) {
        sig = html;
        prompt.innerHTML = html;
        prompt.hidden = !html;
        prompt.classList.toggle('passive', !!html && !near && !nearDoor);
      }
    },
  };
}
