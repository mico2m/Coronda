// La tienda de Claude (la Carpintería): edificio modelado en assets/models/objects/tienda.glb (lo genera
// blender/generar_tienda.py; podés reemplazarlo por el tuyo conservando los nombres de los Empties) y colocado en
// data/scenes/coronda_plaza.json > objects. Configuración: data/tables/tienda.json.
//
// Por ahora hace dos cosas:
//   - Oculta el techo mientras el jugador está adentro (la cámara no choca con las paredes y vería el techo desde arriba).
//   - Da los puntos del edificio en coordenadas del mundo (mostrador, cola, taller, slots…) para el NPC, los pedidos y el Studio:
//       tienda.point('pos_mostrador')  ->  { x, y, z, yaw } | null          tienda.slots()  ->  [ { n, x, y, z } ] (los 50 slots)
import * as THREE from 'three';
import { loadJSON } from '../core/assets.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export function createTienda({ getRoot }) {
  let cfg = { id: 'tienda', zona: [5, 10], techo: 'techo' };
  loadJSON('data/tables/tienda.json').then((c) => { cfg = { ...cfg, ...c }; }).catch(() => {});

  let root = null, spot = null, roofs = [];
  const points = new Map(); // nombre -> Object3D

  function find() {
    const r = getRoot?.() ?? null;
    if (r !== root) { root = r; spot = null; roofs = []; points.clear(); }
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

  // Cada cuadro: ¿el punto `p` (mundo) está adentro del edificio? Si sí, sin techo.
  function update(p) {
    if (!find() || !roofs.length || !p) return;
    spot.updateMatrixWorld(true);
    const l = spot.worldToLocal(_v.copy(p));
    const inside = Math.abs(l.x) <= cfg.zona[0] && Math.abs(l.z) <= cfg.zona[1] && l.y > -1 && l.y < 6;
    for (const r of roofs) r.visible = !inside;
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

  return { update, point, slots, get root() { return find(); } };
}
