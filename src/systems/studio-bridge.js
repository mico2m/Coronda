// Puente entre el juego (dentro de la vista previa) y el Coronda Studio (la página de afuera).
// Solo se carga en dev.html. El Studio lo usa así:  iframe.contentWindow.coronda
//   .npcs · .camera · .controls            los motores del juego
//   .getInventario()                       inventario del jugador (recursos y muebles; .snapshot(), .add(), .remove())
//   .getTienda()                           la tienda: .point('pos_mostrador'), .slots()
//   .forgetJSON(url)                       olvida un JSON cacheado
//   .routePoints()                         Empties de la escena: [{ name, x, y, z, file }] (file: el .glb de donde sale)
//   .showRoute(json | null)                dibuja un recorrido (data/routes/*.json) dentro de la vista previa
import * as THREE from 'three';
import { forgetJSON } from '../core/assets.js';

const sanitize = THREE.PropertyBinding.sanitizeNodeName;

export function createStudioBridge(game) {
  const { scene, getRoot } = game;
  let gizmo = null;

  // Empties = nodos sin malla (ni hijos con malla). Se ofrecen primero los que empiezan con "ruta".
  function routePoints() {
    const root = getRoot?.(); if (!root) return [];
    const out = [];
    for (const room of root.children.filter((c) => c.userData?.isRoomRoot)) {
      room.updateMatrixWorld(true);
      room.traverse((o) => {
        if (o === room || !o.name || o.isMesh || o.isLight || o.isCamera || o.getObjectByProperty('isMesh', true)) return;
        const p = o.getWorldPosition(new THREE.Vector3());
        out.push({ name: o.name, x: p.x, y: p.y, z: p.z, file: o.userData?.sourceFile ?? null });
      });
    }
    return out.sort((a, b) => (/^ruta/i.test(b.name) - /^ruta/i.test(a.name)) || a.name.localeCompare(b.name));
  }

  function clearGizmo() {
    if (!gizmo) return;
    scene.remove(gizmo);
    gizmo.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    gizmo = null;
  }
  function showRoute(data) {
    clearGizmo();
    if (!data?.nodes) return;
    const root = getRoot?.(); if (!root) return;
    const at = {};
    for (const [id, n] of Object.entries(data.nodes)) {
      const o = n.point ? root.getObjectByName(sanitize(String(n.point))) : null;
      if (o) at[id] = o.getWorldPosition(new THREE.Vector3());
      else if (Array.isArray(n.position)) at[id] = new THREE.Vector3(...n.position.map(Number));
    }
    gizmo = new THREE.Group(); gizmo.name = 'studio:route';
    const mat = (c) => { const m = new THREE.MeshBasicMaterial({ color: c, depthTest: false }); return m; };
    for (const [id, p] of Object.entries(at)) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), mat(id === data.start ? 0x4ade80 : 0xfacc15));
      s.position.copy(p).add(new THREE.Vector3(0, 0.25, 0)); s.renderOrder = 999; gizmo.add(s);
    }
    const pts = [];
    for (const [id, n] of Object.entries(data.nodes)) {
      const a = at[id]; if (!a) continue;
      const outs = typeof n.next === 'string' ? [{ to: n.next }] : Array.isArray(n.next) ? n.next : [];
      for (const c of outs) { const b = at[c.to]; if (b) pts.push(a.clone().setY(a.y + 0.25), b.clone().setY(b.y + 0.25)); }
    }
    if (pts.length) {
      const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false }));
      l.renderOrder = 998; l.frustumCulled = false; gizmo.add(l);
    }
    scene.add(gizmo);
  }

  return { ...game, forgetJSON, routePoints, showRoute };
}
