// Borde amarillo al apuntar con la mira (la cruceta del centro de la pantalla, en primera persona).
// Si en el centro hay un NPC o un jugador (a menos de MAX_DIST metros), se le dibuja un contorno amarillo.
//
// Cómo funciona:
//   - Cada cuadro se tira un rayo desde el centro de la cámara y se prueba contra una cápsula invisible alrededor de cada
//     personaje (barato: no se recorren los triángulos del modelo). Gana el que esté más cerca.
//   - El contorno es el truco del "casco invertido": una copia del modelo, solo con las caras de atrás, pintada de
//     amarillo y inflada unos píxeles hacia afuera. Sirve también para los modelos con huesos (SkinnedMesh): la copia
//     comparte el esqueleto, así que acompaña las animaciones.
//   - El grosor se mide en píxeles de la imagen del juego (con el modo retro son los píxeles grandes), no en metros.
//
// Uso (ver game.js):
//   const borde = createMiraBorde({ renderer, camera, getTargets, isActive });
//   borde.update();   // una vez por cuadro, antes de renderer.render
// getTargets() devuelve [{ id, root }]: los grupos 3D de los NPC y de los jugadores remotos.
import * as THREE from 'three';

const MAX_DIST = 12;      // m: más lejos que esto no se resalta
const COLOR = 0xffd23f;   // el mismo amarillo de la flecha de los lotes
const THICK_PX = 2;       // grosor del borde, en píxeles de la imagen del juego
const DEFAULT_H = 1.8;    // m: alto de la cápsula si no se puede medir el modelo
const DEFAULT_R = 0.5;    // m: radio de la cápsula si no se puede medir el modelo

// Distancia entre un rayo (origen o, dirección d unitaria) y un segmento vertical que sube h metros desde a.
// Devuelve { dist, s }: dist = qué tan cerca pasa el rayo del segmento · s = a cuántos metros, sobre el rayo, está lo más cercano.
const _w = new THREE.Vector3();
export function rayVsVertical(o, d, a, h) {
  _w.copy(o).sub(a);
  const b = d.y * h, c = h * h, dd = d.dot(_w), e = _w.y * h;
  const den = c - b * b; // (a·a = 1 porque d es unitario)
  // t = parámetro del segmento (0 = pie, 1 = cabeza); se recorta a [0, 1]
  let t = den > 1e-6 ? (e - b * dd) / den : (c > 0 ? e / c : 0);
  t = Math.min(1, Math.max(0, t));
  const s = Math.max(0, b * t - dd); // punto más cercano sobre el rayo (nunca detrás de la cámara)
  const px = o.x + d.x * s - a.x, py = o.y + d.y * s - (a.y + h * t), pz = o.z + d.z * s - a.z;
  return { dist: Math.hypot(px, py, pz), s };
}

export function createMiraBorde({ renderer, camera, getTargets, isActive = () => true }) {
  const uRes = { value: new THREE.Vector2(800, 600) };
  const material = new THREE.MeshBasicMaterial({ color: COLOR, side: THREE.BackSide, fog: false, toneMapped: false });
  material.customProgramCacheKey = () => 'mira-borde';
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uPx = { value: THICK_PX };
    sh.uniforms.uRes = uRes;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uPx;\nuniform vec2 uRes;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        #ifdef USE_SKINNING
          vec3 nrmB = normalize(transformedNormal);
        #else
          vec3 nrmB = normalize(normalMatrix * normal);
        #endif
        vec2 dirB = nrmB.xy;
        float lenB = length(dirB);
        if (lenB > 0.0001) gl_Position.xy += (dirB / lenB) * (uPx * 2.0 / uRes) * gl_Position.w;`);
  };

  const shapes = new WeakMap();   // root -> { h, r } (medido una vez, cuando el modelo ya cargó)
  const box = new THREE.Box3(), size = new THREE.Vector3();
  function shapeOf(root) {
    let s = shapes.get(root);
    if (s) return s;
    s = { h: DEFAULT_H, r: DEFAULT_R };
    root.updateWorldMatrix(true, true);
    box.setFromObject(root);
    if (!box.isEmpty()) {
      box.getSize(size);
      if (size.y > 0.5 && size.y < 6) {
        s = { h: size.y, r: Math.min(0.7, Math.max(0.35, Math.max(size.x, size.z) * 0.25)) };
        shapes.set(root, s); // solo se guarda si la medida es creíble (si el modelo todavía no cargó, se vuelve a medir)
      }
    }
    return s;
  }

  // ---- Contorno ----
  let current = null;   // { root, hulls: [Mesh] }
  function outline(root) {
    const hulls = [];
    root.traverse((m) => {
      if (!m.isMesh || m.userData.miraBorde || !m.visible) return;
      let h;
      if (m.isSkinnedMesh) { h = new THREE.SkinnedMesh(m.geometry, material); h.bind(m.skeleton, m.bindMatrix); } else h = new THREE.Mesh(m.geometry, material);
      h.userData.miraBorde = true;
      h.frustumCulled = false;
      h.raycast = () => {};
      h.renderOrder = (m.renderOrder ?? 0) - 1;
      hulls.push([m, h]);
    });
    for (const [m, h] of hulls) m.add(h);
    return hulls.map(([, h]) => h);
  }
  function clear() {
    if (!current) return;
    for (const h of current.hulls) h.removeFromParent(); // la geometría es del modelo: no se libera
    current = null;
  }

  const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _a = new THREE.Vector3(), _sz = new THREE.Vector2();
  function pick() {
    camera.getWorldPosition(_o);
    camera.getWorldDirection(_d);
    let best = null, bestS = Infinity;
    for (const t of getTargets() ?? []) {
      const root = t?.root;
      if (!root || !root.parent || !root.visible) continue;
      root.getWorldPosition(_a);
      if (_a.distanceToSquared(_o) > (MAX_DIST + 2) ** 2) continue;
      const { h, r } = shapeOf(root);
      const { dist, s } = rayVsVertical(_o, _d, _a, h);
      if (s > MAX_DIST || dist > r || s >= bestS) continue;
      best = root; bestS = s;
    }
    return best;
  }

  return {
    update() {
      const target = isActive() ? pick() : null;
      if (target === current?.root) {
        if (target) { renderer.getDrawingBufferSize(_sz); uRes.value.copy(_sz); }
        return;
      }
      clear();
      if (target) { current = { root: target, hulls: outline(target) }; renderer.getDrawingBufferSize(_sz); uRes.value.copy(_sz); }
    },
    clear,
    get target() { return current?.root ?? null; },
  };
}
