// Objetos que giran para mirar al jugador (carteles, cabezas, torretas, girasoles…).
// Se configura en Blender con Custom Properties en el objeto (o en el Empty de un `objeto`):
//
//   seguir            = z          eje (local, como en Blender) sobre el que gira: x, y o z
//                                  dos o tres ejes (xz, xyz, todos) = apunta de lleno, sin ladearse
//                                  1 = z (girar de costado, lo más común)
//   seguir_frente     = -y         qué lado del objeto mira al jugador (x, -x, y, -y, z, -z). Por defecto -y,
//                                  que es el "frente" en Blender (vista Front, tecla 1 del teclado numérico)
//   seguir_velocidad  = 0          0 = gira al instante. Más alto = más rápido (probá 3 a 8 para que sea suave)
//   seguir_distancia  = 0          0 = siempre. Si no, solo sigue al jugador a menos de esos metros;
//                                  cuando se aleja vuelve a su posición original
//   seguir_giro       = 0          grados extra (por si el modelo quedó torcido)
//
// Los ejes son los de Blender: el exportador de glTF los convierte (Z arriba en Blender = Y arriba acá).
import * as THREE from 'three';

const DEG = Math.PI / 180;
// Eje de Blender -> eje de three.js (Blender X, Y, Z = three X, -Z, Y)
const AXES = {
  x: new THREE.Vector3(1, 0, 0), '-x': new THREE.Vector3(-1, 0, 0),
  y: new THREE.Vector3(0, 0, -1), '-y': new THREE.Vector3(0, 0, 1),
  z: new THREE.Vector3(0, 1, 0), '-z': new THREE.Vector3(0, -1, 0),
};

const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _goal = new THREE.Quaternion();

function parseAxes(v) {
  if (v === true || v === 1 || v === '1' || v === '') return ['z'];
  const s = String(v).toLowerCase().trim();
  if (s === 'todos' || s === 'all') return ['x', 'y', 'z'];
  const set = [...new Set(s.replace(/[^xyz]/g, ''))];
  return set.length ? set : null;
}

function parseFront(v, axes) {
  const s = String(v ?? '-y').toLowerCase().replace(/\s/g, '');
  const f = AXES[s] ? s : '-y';
  // Si el frente está sobre el mismo eje en que gira, nunca podría mirar al jugador: se elige otro
  if (axes.length === 1 && f.replace('-', '') === axes[0]) return axes[0] === 'y' ? '-x' : '-y';
  return f;
}

export function createFollowers() {
  let list = [];

  function setup(root) {
    list = [];
    if (!root) return list;
    root.traverse((node) => {
      const u = node.userData ?? {};
      if (u.seguir === undefined || u.seguir === 0 || u.seguir === '0' || u.seguir === false) return;
      const axes = parseAxes(u.seguir);
      if (!axes) { console.warn(`seguir: valor "${u.seguir}" no válido en "${node.name}" (usá x, y, z, xz o todos)`); return; }
      const front = parseFront(u.seguir_frente, axes);
      list.push({
        node,
        rest: node.quaternion.clone(),           // orientación original (la del .glb)
        axis: axes.length === 1 ? AXES[axes[0]].clone() : null,
        front: AXES[front].clone(),
        up: AXES[front.replace('-', '') === 'z' ? '-y' : 'z'].clone(), // "arriba" del objeto para no ladearse
        speed: Math.max(0, Number(u.seguir_velocidad) || 0),
        range: Math.max(0, Number(u.seguir_distancia) || 0),
        offset: (Number(u.seguir_giro) || 0) * DEG,
      });
    });
    if (list.length) console.info(`Objetos que siguen al jugador: ${list.map((f) => f.node.name).join(', ')}`);
    return list;
  }

  // target: punto del mundo al que miran (el jugador o la cámara libre)
  function update(target, dt) {
    for (const f of list) {
      const { node, rest } = f;
      if (!node.parent) continue;
      node.getWorldPosition(_p);
      const near = !f.range || _p.distanceTo(target) <= f.range;

      if (!near) _goal.copy(rest);
      else {
        // Dirección al jugador, en el espacio "en reposo" del objeto
        _t.copy(target); node.parent.worldToLocal(_t);
        _d.copy(_t).sub(node.position).applyQuaternion(_inv.copy(rest).invert());
        if (_d.lengthSq() < 1e-8) continue;

        if (f.axis) {
          // Un eje: ángulo entre el frente y el jugador, proyectado en el plano del giro
          const a = f.axis;
          _d.addScaledVector(a, -_d.dot(a));
          if (_d.lengthSq() < 1e-8) continue;
          const ang = Math.atan2(a.dot(_c.crossVectors(f.front, _d)), f.front.dot(_d)) + f.offset;
          _goal.copy(rest).multiply(_q.setFromAxisAngle(a, ang));
        } else {
          // Varios ejes: apunta el frente al jugador y endereza el "arriba" (sin ladearse)
          _d.normalize();
          _q.setFromUnitVectors(f.front, _d);
          _u.copy(f.up).applyQuaternion(_q);                       // arriba después de apuntar
          // arriba deseado: el "arriba" del mundo, perpendicular a la mirada
          node.parent.getWorldQuaternion(_q2);
          _c.set(0, 1, 0).applyQuaternion(_q2.invert()).applyQuaternion(_inv);
          if (f.up.y < 0) _c.negate();
          _c.addScaledVector(_d, -_c.dot(_d));
          if (_c.lengthSq() > 1e-8) {
            _c.normalize();
            const roll = Math.atan2(_d.dot(_p.crossVectors(_u, _c)), _u.dot(_c));
            _q.premultiply(_q2.setFromAxisAngle(_d, roll));
          }
          if (f.offset) _q.multiply(_q2.setFromAxisAngle(f.up, f.offset));
          _goal.copy(rest).multiply(_q);
        }
      }

      if (f.speed) node.quaternion.slerp(_goal, 1 - Math.exp(-f.speed * dt));
      else node.quaternion.copy(_goal);
    }
  }

  return { setup, update, get list() { return list; } };
}
