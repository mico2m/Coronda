// Recorrido de un NPC: camina de punto en punto, se queda esperando y elige el próximo destino.
//
// Cómo se arma (ver README > "NPC que caminan"):
//  1. En Blender, Empties para cada parada (ej. ruta_tokse_1, ruta_tokse_2…), en el suelo. Exportá el .glb como siempre.
//  2. Al Empty del NPC (npc_tokse) agregale la Custom Property  npc_ruta = "tokse"   (usa data/routes/tokse.json)
//  3. En el Coronda Studio, abrí data/routes/tokse.json en modo "Nodos": cada nodo es una parada.
//
// Formato de data/routes/<nombre>.json (el Studio lo escribe por vos):
//  Los atributos (espera, animación, loop, caminar, mirar) se arman en el Studio como NODOS MODIFICADORES sueltos que se conectan
//  a una o varias paradas:   "mods": ["espera_1", "barrer"]  en la parada  +  "modifiers": { "espera_1": { "type": "wait", "wait": 3 } }
//  (el motor también lee los mismos atributos escritos directo en la parada, como en los ejemplos de abajo).
//  { "speed": 1.4,                       velocidad por defecto (m/s)
//    "walk": "caminar",                  clip al caminar (si no, el del modelo en data/tables/npcs.json, o el primero que parezca "camina")
//    "start": "a",                       nodo donde empieza
//    "nodes": {
//      "a": { "point": "ruta_tokse_1",   Empty del .glb donde va   (o "position": [x, y, z] si no tenés Empty)
//             "wait": 3, "waitMax": 6,   espera entre wait y waitMax segundos (waitMax opcional: al azar)
//             "anim": "mirar",           clip mientras espera ("" = idle; uno que termine en _vuelve se hace una vez)
//             "walk": "correr",             clip al caminar HACIA este nodo (opcional; pisa el de la ruta)
//             "loop": true,                repetir sin fin: se queda en este nodo repitiendo "anim" (ignora "wait") y solo sigue por un
//                                         destino con "if" cuando se cumple (los destinos sin condición no se usan)
//             "face": "point",           al llegar, mira hacia donde apunta la flecha verde del Empty ("" = como venía)
//             "speed": 2,                velocidad para llegar a ESTE nodo (opcional)
//             "next": "b" } ,            siguiente nodo; o una lista al azar:
//                                         [ { "to": "b", "weight": 2 }, { "to": "c", "if": { "hablo_tokse": true } } ]
//    },
//    "editor": { ... } }
//
// Arrancar o elegir camino según lo que hacés (usa los flags de systems/flags.js, los mismos de los diálogos):
//  - Cuando termina de esperar, el NPC mira los destinos de "next". Los que tienen "if" solo valen si se cumple.
//    Si hay destinos pero NINGUNO vale todavía, se queda esperando en esa parada y vuelve a mirar (no termina la ruta).
//  - Entonces "empezar a caminar después de hablarle" es: una parada en el mismo lugar del NPC (point: "npc_tokse")
//    con un destino  { "to": "plaza", "if": { "hablo_tokse": true } }.   hablo_<id> se prende solo al hablarle.
//  - "Depende de mi respuesta": en el diálogo, cada opción lleva a un nodo con  "set": { "tokse_va_a_casa": true }  y la
//    ruta tiene destinos distintos con  "if": { "tokse_va_a_casa": true }  /  { "tokse_va_a_casa": false }.
//  Los flags quedan guardados en el navegador (flags.reset() en la consola, o el botón "Reiniciar flags" del Studio, los borra).
//  La posición del NPC no se guarda: al recargar la página vuelve a su Empty y sigue según los flags.                 posiciones de los nodos en el Studio (el juego no lo lee)
// Sin "next" el NPC se queda ahí para siempre. Mientras le hablás, se frena y te mira; después sigue.
import * as THREE from 'three';
import { flags } from '../systems/flags.js';
import { classifyClip } from './npc-anim.js';

const sanitize = THREE.PropertyBinding.sanitizeNodeName;
const num = (v, d) => (v !== undefined && v !== '' && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
const TAU = Math.PI * 2;
const angleDiff = (a, b) => ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;

export function createRoute(entry, data, sceneRoot, api, { name = '' } = {}) {
  const h = entry.holder;
  const label = `NPC "${entry.id}" (ruta ${name || '?'})`;
  const warned = new Set();
  const warn = (k, msg) => { if (!warned.has(k)) { warned.add(k); console.warn(`${label}: ${msg}`); } };

  // Cada parada = sus propios datos + los de sus modificadores ("mods": ["espera_1", ...] -> data.modifiers). El último pisa al anterior.
  const nodes = {};
  for (const [id, n] of Object.entries(data?.nodes ?? {})) {
    const eff = { ...n };
    for (const mid of Array.isArray(n.mods) ? n.mods : []) {
      const m = data.modifiers?.[mid];
      if (!m) { warn(`m:${id}:${mid}`, `la parada "${id}" usa el modificador "${mid}", que no existe.`); continue; }
      const { type, ...props } = m;
      Object.assign(eff, props);
    }
    nodes[id] = eff;
  }

  // Dónde queda cada nodo: Empty del .glb (con hacia dónde mira) o "position" escrita a mano
  const cache = {};
  function pointOf(id) {
    if (id in cache) return cache[id];
    const n = nodes[id]; let p = null;
    if (n?.point) {
      const o = sceneRoot.getObjectByName(sanitize(String(n.point)));
      if (o) {
        o.updateWorldMatrix(true, false);
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
        p = { pos: o.getWorldPosition(new THREE.Vector3()), yaw: Math.atan2(f.x, f.z) };
      } else warn(`p:${id}`, `el nodo "${id}" usa el Empty "${n.point}", que no está en el .glb de esta escena.`);
    } else if (Array.isArray(n?.position)) p = { pos: new THREE.Vector3(...n.position.map(Number)), yaw: 0 };
    else if (n) warn(`p:${id}`, `el nodo "${id}" no tiene "point" ni "position".`);
    return (cache[id] = p);
  }

  // clip al caminar: el de la parada a la que va > el de la ruta > el del modelo (🚶 en el Studio) > el que parezca "camina"
  const walkName = () => String(nodes[cur]?.walk ?? '').trim() || String(data.walk ?? '').trim() || entry.walkName || entry.clips.find((c) => classifyClip(c.name) === 'walk')?.name || null;
  const setObstacle = () => { if (entry.obstacle) { entry.obstacle.x = h.position.x; entry.obstacle.z = h.position.z; } };
  const heading = (dx, dz) => Math.atan2(dx, dz) + entry.yawOffset; // mismo criterio que faceTowards

  let state = 'idle';          // 'walk' | 'wait' | 'done' | 'idle'
  let cur = null;              // id del nodo al que va o en el que está
  let paused = false;
  const from = new THREE.Vector3(), to = new THREE.Vector3();
  let dist = 0, walked = 0, speed = 1.4, timer = 0, turning = 0, walking = false;

  function stopAt(why) { state = 'done'; if (why) warn('stop', why); api.play(entry, null); walking = false; }

  // forever = parada con "loop": solo valen los destinos con "if" (los que no tienen condición nunca se eligen)
  function pickNext(n, forever = false) {
    const nx = n.next;
    if (!nx) return null;
    if (typeof nx === 'string') return forever ? undefined : (nodes[nx] ? nx : null);
    const cand = (Array.isArray(nx) ? nx : []).filter((c) => c && nodes[c.to] && (!forever || (c.if && Object.keys(c.if).length)));
    if (forever && !cand.length) return undefined;
    if (!cand.length) return null;
    const ok = cand.filter((c) => flags.check(c.if));
    if (!ok.length) return undefined; // hay destinos pero ninguna condición se cumple todavía: espera acá y vuelve a mirar
    let r = Math.random() * ok.reduce((s, c) => s + Math.max(0, num(c.weight, 1)), 0);
    for (const c of ok) { r -= Math.max(0, num(c.weight, 1)); if (r <= 0) return c.to; }
    return ok[ok.length - 1].to;
  }

  function arrive(id) {
    const p = pointOf(id), n = nodes[id];
    h.position.copy(p.pos); setObstacle();
    cur = id; walking = false;
    if (n.face === 'point' || n.face === 'punto') api.turnTo(entry, p.yaw + entry.yawOffset);
    const w = num(n.wait, 0), wm = num(n.waitMax, 0);
    timer = wm > w ? w + Math.random() * (wm - w) : w;
    state = 'wait';
    playNode(n);
  }

  function goTo(id) {
    const p = id && nodes[id] ? pointOf(id) : null;
    if (!p) return stopAt(id ? `el nodo "${id}" no existe o no tiene punto: me quedo quieto.` : null);
    cur = id; from.copy(h.position); to.copy(p.pos);
    dist = Math.hypot(to.x - from.x, to.z - from.z); walked = 0; turning = 0; walking = false;
    speed = num(nodes[id].speed, num(data.speed, 1.4));
    if (dist < 0.15) return arrive(id);
    state = 'walk';
    entry.targetYaw = heading(to.x - from.x, to.z - from.z);
  }

  const playNode = (n) => api.play(entry, n.anim || null, { loop: n.loop === true });
  const resumeAnim = () => { if (state === 'wait') playNode(nodes[cur] ?? {}); }; // después de una charla

  const first = data.start && nodes[data.start] ? data.start : Object.keys(nodes)[0];
  if (first) goTo(first); else warn('empty', 'la ruta no tiene nodos.');

  return {
    name, get state() { return state; }, get node() { return cur; },
    hold(on) { // charla: se frena
      paused = !!on;
      if (paused) { walking = false; api.play(entry, null); }
    },
    // al terminar la charla: sigue, mirando hacia donde iba (o como lo dejó el nodo)
    resume() {
      paused = false;
      if (state === 'walk') { entry.targetYaw = heading(to.x - h.position.x, to.z - h.position.z); from.copy(h.position); dist = Math.hypot(to.x - from.x, to.z - from.z); walked = 0; turning = 0; walking = false; }
      else { const p = cur && pointOf(cur); entry.targetYaw = nodes[cur]?.face && p ? p.yaw + entry.yawOffset : h.rotation.y; resumeAnim(); }
    },
    update(dt) {
      if (paused) return;
      if (state === 'wait') {
        const n = nodes[cur], forever = n.loop === true;
        if (!forever) timer -= dt;
        if (forever || timer <= 0) { const nx = pickNext(n, forever); if (nx === undefined) return; nx ? goTo(nx) : stopAt(null); }
      } else if (state === 'walk') {
        // primero gira hacia donde va (máx. ~0,8 s), después camina
        if (Math.abs(angleDiff(h.rotation.y, entry.targetYaw)) > 0.5 && turning < 0.8) { turning += dt; return; }
        if (!walking) {
          walking = true;
          const w = walkName();
          if (w) api.play(entry, w); else warn('nowalk', 'el modelo no tiene un clip de caminar; se desliza con el idle. Marcá uno con 🚶 en el Studio (panel NPC) o ponelo en "walk" de la ruta.');
        }
        walked = Math.min(dist, walked + speed * dt);
        const f = dist > 0 ? walked / dist : 1;
        h.position.set(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, from.z + (to.z - from.z) * f);
        setObstacle();
        if (walked >= dist) arrive(cur);
      }
    },
  };
}
