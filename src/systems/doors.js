// Puertas: al acercarte a un empty de Blender se dispara el cambio de escena.
//
// En Blender: poné un Empty cerca de la puerta (ej. empty_puerta_casa1) y exportá a .glb;
// los empties salen como nodos vacíos con su nombre.
// En data/scenes/<escena>.json, la lista "doors" dice qué empty es cada puerta y a dónde lleva:
//
//   "doors": [
//     { "empty": "empty_puerta_casa1", "radius": 2.5, "target": "scene_casa1" }
//   ]
//
// Opcionales: "spawn": { "position": [x,y,z], "yaw": n } (dónde aparecés en la escena destino;
// si falta se usa el spawn de la escena destino) y "position": [x,y,z] (si el empty todavía no
// está en el .glb, se usa esta posición en lugar de buscarlo).
import * as THREE from 'three';

const _p = new THREE.Vector3();

export function createDoors({ camera, onEnter, dev = false }) {
  let doors = [];
  let helpers = null;
  let busy = false;

  function clearHelpers() {
    if (!helpers) return;
    helpers.parent?.remove(helpers);
    helpers.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    helpers = null;
  }

  return {
    // Llamar después de cargar cada escena.
    setup(data, root) {
      clearHelpers();
      busy = false;
      doors = [];
      if (dev) { helpers = new THREE.Group(); helpers.name = 'door-helpers'; root.add(helpers); }

      root.updateMatrixWorld(true);
      for (const d of data.doors ?? []) {
        const pos = new THREE.Vector3();
        // GLTFLoader quita puntos de los nombres (Puerta.001 -> Puerta001), igual que acá.
        const node = d.empty ? root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(d.empty)) : null;
        if (node) node.getWorldPosition(pos);
        else if (d.position) pos.set(...d.position);
        else { console.warn(`Puerta "${d.empty}": no está en el .glb ni tiene "position" en el JSON.`); continue; }

        const radius = d.radius ?? 2.5;
        // "armed": la puerta no dispara hasta que salgas de su radio (así no rebotás al aparecer encima).
        const door = { ...d, pos, radius, armed: false };
        doors.push(door);

        if (helpers) {
          const m = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0x2dd4bf, wireframe: true, transparent: true, opacity: 0.4 })
          );
          m.position.copy(pos);
          helpers.add(m);
        }
      }
    },

    update() {
      if (busy) return;
      camera.getWorldPosition(_p);
      for (const d of doors) {
        const inside = _p.distanceTo(d.pos) < d.radius;
        if (!inside) d.armed = true;
        else if (d.armed) {
          busy = true;
          Promise.resolve(onEnter(d)).catch((err) => { console.error(err); busy = false; });
          return;
        }
      }
    },
  };
}
