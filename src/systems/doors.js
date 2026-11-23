// Puertas: un objeto visible y normal al que vos le das la propiedad de "interactuable".
// Al acercarte aparece "E Entrar"; al apretar E (o tocar el aviso) se hace el cambio de escena.
// El código no oculta ni modifica el objeto: se ve igual que cualquier otro.
//
// Cómo marcar un objeto como puerta (cualquiera de las dos formas):
//  a) Propiedad personalizada en Blender: Object Properties > Custom Properties, agregá
//     "puerta" = "scene_casa1" (la escena destino). Al exportar el .glb tildá "Custom Properties".
//     Opcional: "puerta_radio" = 3 (metros), "puerta_texto" = "Entrar".
//  b) Por nombre: un objeto llamado puerta_casa1 (o empty_puerta_casa1) lleva a "scene_casa1"
//     (puerta_X -> scene_X). Si existen los dos, cuentan como la misma puerta.
//
// Para cambiar el destino, el radio o dónde aparecés, agregá una entrada en "doors" del JSON de la escena:
//   "doors": [{ "empty": "puerta_casa1", "target": "scene_casa1", "radius": 3,
//               "label": "Entrar", "spawn": { "position": [0,1.7,4], "yaw": 0 } }]
// ("empty" acepta cualquiera de los nombres de la puerta). Si el objeto todavía no está en el .glb,
// se puede dar "position": [x,y,z] y funciona como un punto.
// La distancia se mide hasta la superficie del objeto (caja envolvente), no hasta su centro.
import * as THREE from 'three';

const NAME_RE = /^(?:empty_)?puerta_(.+)$/;
export const doorIdFromName = (name) => NAME_RE.exec(name ?? '')?.[1] ?? null;

const _p = new THREE.Vector3();

export function createDoors({ camera, stage, onEnter, dev = false }) {
  let doors = [];
  let helpers = null;
  let busy = false;
  let near = null;

  // Aviso "Presioná E"
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.className = 'door-prompt';
  prompt.hidden = true;
  prompt.addEventListener('click', () => trigger());
  stage.parentElement.appendChild(prompt);

  function trigger() {
    if (!near || busy) return;
    const door = near;
    busy = true;
    prompt.hidden = true;
    Promise.resolve(onEnter(door)).catch((err) => console.error(err)).finally(() => { busy = false; });
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) trigger();
  });

  function clearHelpers() {
    if (!helpers) return;
    helpers.parent?.remove(helpers);
    helpers.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    helpers = null;
  }

  // Busca las puertas en la escena: no entra dentro de una puerta ya encontrada (sus piezas no cuentan aparte).
  function findNodes(root) {
    const found = [];
    (function walk(o) {
      const prop = o.userData?.puerta;
      const id = prop !== undefined && prop !== false && prop !== 0 ? o.name : doorIdFromName(o.name);
      if (id) { found.push({ id, node: o }); return; }
      o.children.forEach(walk);
    })(root);
    return found;
  }

  return {
    // Llamar después de cargar cada escena.
    setup(data, root) {
      clearHelpers();
      near = null;
      prompt.hidden = true;
      doors = [];
      if (dev) { helpers = new THREE.Group(); helpers.name = 'door-helpers'; root.add(helpers); }
      root.updateMatrixWorld(true);

      const byId = new Map();
      const get = (id) => {
        if (!byId.has(id)) byId.set(id, { id, target: `scene_${id}`, radius: 3, label: 'Entrar', spawn: undefined, shapes: [] });
        return byId.get(id);
      };

      // 1) Objetos y empties del .glb
      for (const { id, node } of findNodes(root)) {
        const door = get(id);
        const x = node.userData ?? {};
        // Un valor como 1, 1.0, true o vacío (el que Blender pone por defecto) no es un destino:
        // en ese caso se deduce del nombre del objeto (puerta_casa1 -> scene_casa1).
        const v = typeof x.puerta === 'string' ? x.puerta.trim() : '';
        if (v && !/^(?:[\d.]+|true|false)$/i.test(v)) door.target = v;
        else if (!doorIdFromName(node.name)) {
          console.warn(`Objeto "${node.name}": la propiedad "puerta" no tiene una escena destino (vale "${x.puerta}"). Usando "scene_${id}".`);
        }
        if (x.puerta_radio !== undefined) door.radius = Number(x.puerta_radio);
        if (x.puerta_texto !== undefined) door.label = String(x.puerta_texto);
        const box = new THREE.Box3().setFromObject(node);
        if (box.isEmpty()) { // empty: es solo un punto
          const p = node.getWorldPosition(new THREE.Vector3());
          box.set(p.clone(), p.clone());
        }
        door.shapes.push(box);
      }

      // 2) Ajustes del JSON (o puertas que solo existen ahí, con "position")
      for (const cfg of data.doors ?? []) {
        const name = cfg.empty ?? cfg.object ?? cfg.name;
        const id = doorIdFromName(name) ?? name;
        const exists = byId.has(id);
        if (!exists && !cfg.position) {
          console.warn(`Puerta "${name}": no está en el .glb ni tiene "position" en el JSON.`);
          continue;
        }
        const door = get(id);
        if (!door.shapes.length && cfg.position) {
          const p = new THREE.Vector3(...cfg.position);
          door.shapes.push(new THREE.Box3(p.clone(), p.clone()));
        }
        for (const k of ['target', 'radius', 'label', 'spawn']) if (cfg[k] !== undefined) door[k] = cfg[k];
      }

      doors = [...byId.values()].filter((d) => d.shapes.length);
      if (helpers) {
        for (const d of doors) for (const b of d.shapes) {
          const h = new THREE.Box3Helper(b.clone().expandByScalar(d.radius), 0x2dd4bf);
          helpers.add(h);
        }
      }
    },

    update() {
      if (busy) return;
      camera.getWorldPosition(_p);
      let best = null, bestD = Infinity;
      for (const d of doors) {
        for (const b of d.shapes) {
          const dist = b.distanceToPoint(_p);
          if (dist < d.radius && dist < bestD) { best = d; bestD = dist; }
        }
      }
      if (best !== near) {
        near = best;
        prompt.hidden = !near;
        if (near) prompt.innerHTML = `<kbd>E</kbd> ${near.label ?? 'Entrar'}`;
      }
    },
  };
}
