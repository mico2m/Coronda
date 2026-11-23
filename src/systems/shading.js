// Sombreado "sin luces" (como las consolas de la época): cada superficie muestra su textura tal cual.
// En lugar de luces dinámicas, cada escena define un TONO y un BRILLO globales (environment.tint / brightness)
// que multiplican el color de todo lo que se ve.
import * as THREE from 'three';

const _tint = new THREE.Color();

const matsOf = (o) => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);

// Un material cualquiera -> MeshBasicMaterial (no reacciona a la luz) con la misma textura, color y transparencia
function toBasic(m) {
  if (m.isMeshBasicMaterial) { m.userData.baseColor ??= m.color.clone(); return m; }
  const b = new THREE.MeshBasicMaterial({
    name: m.name,
    color: m.color ? m.color.clone() : new THREE.Color(1, 1, 1),
    map: m.map ?? m.emissiveMap ?? null,
    alphaMap: m.alphaMap ?? null,
    transparent: m.transparent,
    opacity: m.opacity,
    alphaTest: m.alphaTest,
    side: m.side,
    depthWrite: m.depthWrite,
    vertexColors: m.vertexColors,
  });
  b.userData.baseColor = b.color.clone();
  return b;
}

// Convierte todos los materiales debajo de `root`. Devuelve `root`.
export function makeUnlit(root) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const conv = (m) => {
      if (!cache.has(m)) { const b = toBasic(m); cache.set(m, b); if (b !== m) m.dispose(); }
      return cache.get(m);
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });
  return root;
}

// Aplica tono y brillo: color final = color original × tono × brillo
export function setShade(root, { tint = '#ffffff', brightness = 1 } = {}) {
  _tint.set(tint);
  root.traverse((o) => {
    for (const m of matsOf(o)) {
      const base = m.userData?.baseColor;
      if (base) m.color.copy(base).multiply(_tint).multiplyScalar(brightness);
    }
  });
}

// Objetos del cielo: se llaman "cielo..." o "sky..." en Blender
export const isSkyName = (name) => /^(cielo|sky)/i.test(name ?? '');
