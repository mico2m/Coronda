// Puntos de aparición (spawns): una sola regla para todos los lugares donde puede aparecer el jugador.
//
// Un spawn es un Empty en el suelo; el jugador mira hacia su flecha verde (eje Y) en Blender.
// Se reconoce de cualquiera de estas dos formas (igual que las puertas):
//  a) Por nombre:    "spawn"          -> el spawn por defecto de la escena
//                    "spawn_arriba"   -> el spawn "arriba"
//                    (el prefijo "empty_" es opcional: "empty_spawn", "empty_spawn_arriba")
//  b) Por propiedad: Custom Property "spawn" = "arriba" (con el nombre de objeto que quieras).
//                    "spawn" = 1 / true / vacío -> spawn por defecto.
//
// En los teleports y puertas se escribe el nombre del Empty:
//   teleport = "spawn_muelle"              -> spawn_muelle de la misma escena
//   teleport = "scene_casa1:spawn_cocina"  -> spawn_cocina de scene_casa1
//   teleport = "scene_casa1:spawn"         -> spawn base de scene_casa1
//   llegar desde scene_casa1 (sin pedir spawn) -> spawn_casa1, si existe
// Internamente se guardan por su nombre corto ('' = base, 'muelle', 'cocina').
import * as THREE from 'three';

const EYE_HEIGHT = 1.7; // el empty va en el suelo; la cámara se pone a esta altura
const NAME_RE = /^(?:empty_)?spawn(?:_(.+))?$/;

// Nombre corto del spawn de un nodo: '' = por defecto, 'arriba', … o null si no es un spawn
export function spawnKey(node) {
  const prop = node.userData?.spawn;
  if (prop !== undefined && prop !== false && prop !== 0) {
    const s = typeof prop === 'string' ? prop.trim() : '';
    return s && !/^(?:[\d.]+|true)$/i.test(s) ? normSpawnKey(s) : '';
  }
  const m = NAME_RE.exec(node.name ?? '');
  return m ? (m[1] ?? '') : null;
}

// Todos los spawns de una escena: Map nombre corto -> nodo (el primero que aparece gana)
export function collectSpawns(root) {
  const map = new Map();
  root.traverse((o) => {
    const k = spawnKey(o);
    if (k !== null && !map.has(k)) map.set(k, o);
  });
  return map;
}

// Limpia lo que escribiste como destino: "spawn_arriba", "empty_spawn_arriba" y "arriba" son lo mismo
export const normSpawnKey = (k) =>
  String(k ?? '').trim().replace(/^(?:empty_)?spawn(?:_|$)/, '');

// Busca el primer spawn de la lista de nombres cortos y devuelve { position (ojos), yaw } o null
export function findSpawn(root, keys) {
  root.updateMatrixWorld(true);
  const spawns = collectSpawns(root);
  for (const k of keys) {
    if (k === null || k === undefined) continue;
    const node = spawns.get(normSpawnKey(k));
    if (node) return spawnFromNode(node);
  }
  return null;
}

export function spawnFromNode(node) {
  const p = node.getWorldPosition(new THREE.Vector3());
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
  return { position: [p.x, p.y + EYE_HEIGHT, p.z], yaw: Math.atan2(-f.x, -f.z) };
}
