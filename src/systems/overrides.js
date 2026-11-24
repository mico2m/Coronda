// Ajustes de objetos hechos desde el Studio (posición, rotación, escala, opacidad).
// NO se toca el .glb: los cambios viven en data/objects/<escena>.json y se aplican encima del modelo al cargar la escena.
//
//   { "objects": { "NombreDelObjeto": { "position": [x,y,z], "rotation": [gx,gy,gz], "scale": [x,y,z], "scaleLock": true, "opacity": 0.5 } } }
//
// Solo se guardan los valores que cambiaste. Rotación en grados. Los nombres son los del .glb (los mismos que ves en Blender).
import * as THREE from 'three';

const DEG = Math.PI / 180;
const _e = new THREE.Euler();
export const overridesUrl = (sceneId) => `data/objects/${sceneId}.json`;
const matsOf = (o) => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);
const round = (n) => Math.round(n * 1e4) / 1e4;
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

export function createOverrides() {
  let sceneId = null, root = null, objects = {};
  const listeners = new Set();
  const emit = (name) => listeners.forEach((f) => f(name));

  const roomRoots = () => (root ? root.children.filter((c) => c.userData?.isRoomRoot) : []);
  const find = (name) => { for (const r of roomRoots()) { const n = r.getObjectByName(name); if (n) return n; } return null; };

  // Valores del .glb tal como vienen (se guardan la primera vez que se toca un objeto)
  function original(node) {
    if (!node.userData.__orig) {
      node.userData.__orig = { position: node.position.toArray(), rotation: eulerDeg(node), scale: node.scale.toArray(), opacity: 1 };
    }
    return node.userData.__orig;
  }
  function eulerDeg(node) { _e.setFromQuaternion(node.quaternion, 'XYZ'); return [_e.x / DEG, _e.y / DEG, _e.z / DEG].map(round); }

  function applyOpacity(node, value) {
    node.traverse((o) => {
      if (!o.isMesh) return;
      const mats = matsOf(o);
      if (!mats.length) return;
      if (!o.userData.__opClone) { // los materiales se comparten entre objetos: este mesh se queda con los suyos
        const clones = mats.map((m) => { const c = m.clone(); c.userData.baseColor = m.userData?.baseColor; c.userData.__op0 = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite }; return c; });
        o.material = Array.isArray(o.material) ? clones : clones[0];
        o.userData.__opClone = true;
      }
      for (const m of matsOf(o)) {
        const b = m.userData.__op0;
        m.opacity = b.opacity * value;
        m.transparent = b.transparent || value < 1;
        m.depthWrite = value < 1 ? false : b.depthWrite;
        m.needsUpdate = true;
      }
    });
  }

  function apply(node, o) {
    const orig = original(node);
    node.position.set(...(o.position ?? orig.position));
    const r = o.rotation ?? orig.rotation;
    node.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ');
    node.scale.set(...(o.scale ?? orig.scale));
    if (o.opacity !== undefined || node.userData.__opClone) applyOpacity(node, o.opacity ?? 1);
    node.updateMatrixWorld(true);
  }

  return {
    get sceneId() { return sceneId; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // Carga el archivo de la escena (si existe) y lo aplica sobre `rootGroup` (el grupo de la escena)
    async load(id, rootGroup) {
      sceneId = id; root = rootGroup; objects = {};
      try {
        const res = await fetch(overridesUrl(id), { cache: 'no-store' });
        if (res.ok) objects = (await res.json()).objects ?? {};
      } catch { /* sin archivo: no hay ajustes */ }
      for (const [name, o] of Object.entries(objects)) {
        const node = find(name);
        if (node) apply(node, o); else console.warn(`Ajustes de objetos: "${name}" ya no existe en el .glb de ${id}.`);
      }
    },

    // Para el Studio ---------------------------------------------------------
    find,
    // Objetos de las salas, en orden de jerarquía: [{ name, depth, kind: 'mesh'|'empty'|'group', changed }]
    list() {
      const out = [];
      const walk = (n, depth) => {
        for (const c of n.children) {
          if (!c.name) { walk(c, depth); continue; }
          const hasMesh = c.isMesh || !!c.getObjectByProperty('isMesh', true);
          out.push({ name: c.name, depth, kind: c.isMesh ? 'mesh' : hasMesh ? 'group' : 'empty', changed: !!objects[c.name] });
          walk(c, depth + 1);
        }
      };
      roomRoots().forEach((r) => walk(r, 0));
      return out;
    },
    // Valores actuales y originales de un objeto
    get(name) {
      const n = find(name); if (!n) return null;
      const orig = original(n), o = objects[name] ?? {};
      return {
        name, hasMesh: n.isMesh || !!n.getObjectByProperty('isMesh', true), isNpc: /^npc_/i.test(name),
        original: orig,
        current: { position: n.position.toArray().map(round), rotation: eulerDeg(n), scale: n.scale.toArray().map(round), opacity: o.opacity ?? 1 },
        scaleLock: o.scaleLock ?? true, changed: !!objects[name],
      };
    },
    // patch: { position?, rotation?, scale?, opacity?, scaleLock? }
    set(name, patch) {
      const n = find(name); if (!n) return;
      const orig = original(n);
      const o = { ...(objects[name] ?? {}) };
      for (const k of ['position', 'rotation', 'scale']) if (patch[k]) o[k] = patch[k].map(round);
      if (patch.opacity !== undefined) o.opacity = round(Math.min(1, Math.max(0, patch.opacity)));
      if (patch.scaleLock !== undefined) o.scaleLock = !!patch.scaleLock;
      // lo que quedó igual que el original no se guarda
      for (const k of ['position', 'rotation', 'scale']) if (o[k] && same(o[k], orig[k])) delete o[k];
      if (o.opacity === 1) delete o.opacity;
      if (o.scaleLock === true) delete o.scaleLock;
      const hasData = Object.keys(o).some((k) => k !== 'scaleLock');
      if (hasData || o.scaleLock === false) objects[name] = o; else delete objects[name];
      apply(n, objects[name] ?? {});
      emit(name);
    },
    reset(name) {
      const n = find(name); if (!n) return;
      delete objects[name]; apply(n, {}); emit(name);
    },
    toJSON() { return { objects }; },
    isEmpty() { return !Object.keys(objects).length; },
  };
}
