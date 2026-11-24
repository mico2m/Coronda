// Puertas y teleports: objetos (o empties) que te llevan a otro punto, de la misma escena o de otra.
// El código no oculta ni modifica el objeto: se ve igual que cualquier otro.
//
// Dos formas de activarse:
//  - "E"    : al acercarte aparece "E Entrar"; al apretar E (o tocar el aviso) se hace el viaje.
//  - "auto" : se activa solo al entrar en la zona, sin apretar nada (como pisar una baldosa mágica).
//
// Cómo marcarlos en Blender (Object Properties > Custom Properties; al exportar el .glb tildá "Custom Properties"):
//  a) TELEPORT  (por defecto "auto")
//       "teleport" = destino
//       opcional: "teleport_modo" = "auto" | "E"   "teleport_radio" = 1   "teleport_texto" = "Entrar"
//  b) PUERTA    (por defecto "E", como antes)
//       "puerta" = destino
//       opcional: "puerta_modo", "puerta_radio" = 3, "puerta_texto" = "Entrar"
//  c) Por nombre: un objeto llamado puerta_casa1 (o empty_puerta_casa1) lleva a "scene_casa1".
//
// El destino puede ser (los puntos de llegada son spawns, ver spawns.js):
//   "spawn_muelle"              -> el spawn_muelle de la MISMA escena (mismo .glb)
//   "spawn"                     -> el spawn base de la misma escena
//   "scene_casa1:spawn_cocina"  -> otra escena, en su spawn_cocina
//   "scene_casa1:spawn"         -> otra escena, en su spawn base
//   "scene_casa1"               -> otra escena, en su spawn normal (spawn_<origen> si existe, si no spawn)
//
// Ajustes en el JSON de la escena (pisan lo de Blender), en "doors":
//   { "empty": "puerta_casa1", "target": "scene_casa1:spawn_cocina", "mode": "E", "radius": 3,
//     "label": "Entrar", "spawn": { "position": [0,1.7,4], "yaw": 0 } }
// Si el objeto todavía no está en el .glb, se puede dar "position": [x,y,z] y funciona como un punto.
// La distancia se mide hasta la superficie del objeto (caja envolvente), no hasta su centro.
// Un Empty es un volumen: su cubo (Display As = Cube, Size = 1, escalalo a gusto). Un teleport automático en un
// Empty se activa al entrar en el cubo (radio 0); en un objeto visible, a 1 m de su superficie.
// No le pongas col_ a un teleport: col_ lo vuelve una pared sólida y no podés entrar.
//
// Los teleports automáticos no se encadenan: después de cualquier viaje (o al entrar a una escena) hay que
// salir de todas las zonas automáticas antes de que una vuelva a activarse. Así el spawn destino puede estar
// encima de otro teleport (ida y vuelta) sin rebotar para siempre.
import * as THREE from 'three';
import { collectSpawns, normSpawnKey } from './spawns.js';

const NAME_RE = /^(?:empty_)?puerta_(.+)$/;
export const doorIdFromName = (name) => NAME_RE.exec(name ?? '')?.[1] ?? null;

const _p = new THREE.Vector3();

// Un valor como 1, 1.0, true o vacío (el que Blender pone por defecto) no es un destino
const destText = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && !/^(?:[\d.]+|true|false)$/i.test(s) ? s : '';
};
const normMode = (m) => (/^(?:auto|automatico|automático|solo)$/i.test(String(m ?? '').trim()) ? 'auto' : 'E');

// `blocked`: función que devuelve true mientras algo más usa la tecla E (una charla con un NPC); la puerta espera.
// `isScene(id)`: true si el id es una escena registrada (para distinguir "scene_casa1" de un Empty de la misma escena).
export function createDoors({ stage, onEnter, dev = false, blocked = () => false, isScene = () => false }) {
  let doors = [];
  let helpers = null;
  let busy = false;
  let near = null;       // puerta con E más cercana (la del aviso)
  let autoArmed = false; // los automáticos se rearman al salir de todas sus zonas
  let sceneId = null;

  // Aviso "Presioná E"
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.className = 'door-prompt';
  prompt.hidden = true;
  prompt.addEventListener('click', () => trigger(near));
  stage.parentElement.appendChild(prompt);

  function trigger(door) {
    if (!door || busy || blocked()) return;
    busy = true;
    autoArmed = false;
    near = null;
    prompt.hidden = true;
    Promise.resolve(onEnter(door)).catch((err) => console.error(err)).finally(() => { busy = false; });
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) trigger(near);
  });

  // "scene_casa1:spawn_cocina" / "scene_casa1" / "spawn_muelle" -> { scene, spawnName }
  function parseTarget(value) {
    const s = String(value).trim();
    const i = s.indexOf(':');
    if (i >= 0) return { scene: s.slice(0, i).trim() || sceneId, spawnName: s.slice(i + 1).trim() || null };
    if (isScene(s)) return { scene: s, spawnName: null };
    return { scene: sceneId, spawnName: s }; // spawn de la misma escena
  }

  function clearHelpers() {
    if (!helpers) return;
    helpers.parent?.remove(helpers);
    helpers.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    helpers = null;
  }

  const isMarked = (v) => v !== undefined && v !== false && v !== 0;

  // Busca puertas/teleports: no entra dentro de uno ya encontrado (sus piezas no cuentan aparte).
  function findNodes(root) {
    const found = [];
    (function walk(o) {
      const u = o.userData ?? {};
      const id = doorIdFromName(o.name) ?? (isMarked(u.teleport) || isMarked(u.puerta) ? o.name : null);
      if (id) { found.push({ id, node: o }); return; }
      o.children.forEach(walk);
    })(root);
    return found;
  }

  // Zona del objeto. Un Empty es un volumen: el cubo de ±1 en sus coordenadas, con su escala/rotación/posición
  // (igual que los Empties col_ de las colisiones: en Blender, Display As = Cube con Size = 1 y escalalo).
  function shapeOf(node) {
    const box = new THREE.Box3().setFromObject(node);
    const isEmpty = box.isEmpty();
    if (isEmpty) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)).applyMatrix4(node.matrixWorld);
    return { box, isEmpty };
  }

  return {
    // Llamar después de cargar cada escena. `data` es el JSON de la escena.
    setup(data, root) {
      clearHelpers();
      near = null;
      prompt.hidden = true;
      autoArmed = false; // si aparecés dentro de una zona automática, no se dispara hasta que salgas
      sceneId = data.id;
      doors = [];
      if (dev) { helpers = new THREE.Group(); helpers.name = 'door-helpers'; root.add(helpers); }
      root.updateMatrixWorld(true);

      const byId = new Map();
      const get = (id) => {
        if (!byId.has(id)) byId.set(id, { id, target: `scene_${id}`, mode: 'E', radius: 3, label: 'Entrar', spawn: undefined, shapes: [] });
        return byId.get(id);
      };

      // 1) Objetos y empties del .glb
      for (const { id, node } of findNodes(root)) {
        const door = get(id);
        const x = node.userData ?? {};
        const isTp = isMarked(x.teleport);
        const pre = isTp ? 'teleport' : 'puerta';
        const { box, isEmpty } = shapeOf(node);
        // automático: un Empty se activa al entrar en su cubo; un objeto visible, a 1 m de su superficie
        if (isTp) { door.mode = 'auto'; door.radius = isEmpty ? 0 : 1; }
        const v = destText(x[pre]);
        if (v) door.target = v;
        else if (isTp || !doorIdFromName(node.name)) {
          console.warn(`Objeto "${node.name}": la propiedad "${pre}" no tiene destino (vale "${x[pre]}"). Usando "scene_${id}".`);
        }
        if (x[`${pre}_modo`] !== undefined) door.mode = normMode(x[`${pre}_modo`]);
        if (x[`${pre}_radio`] !== undefined) door.radius = Number(x[`${pre}_radio`]);
        if (x[`${pre}_texto`] !== undefined) door.label = String(x[`${pre}_texto`]);
        door.shapes.push(box);
        if (/^(?:col|colision)_/i.test(node.name) && door.mode === 'auto' && door.radius < 0.5) {
          console.warn(`Teleport "${node.name}": empieza con col_, así que también es una pared sólida y nunca vas a entrar. Cambiale el nombre (ej. tp_${node.name.replace(/^(?:col|colision)_/i, '')}) o subí "teleport_radio" para que se active al tocarlo.`);
        }
      }

      // 2) Ajustes del JSON (o puertas que solo existen ahí, con "position")
      for (const cfg of data.doors ?? []) {
        const name = cfg.empty ?? cfg.object ?? cfg.name;
        const id = doorIdFromName(name) ?? name;
        if (!byId.has(id) && !cfg.position) {
          console.warn(`Puerta "${name}": no está en el .glb ni tiene "position" en el JSON.`);
          continue;
        }
        const door = get(id);
        if (!door.shapes.length && cfg.position) {
          const p = new THREE.Vector3(...cfg.position);
          door.shapes.push(new THREE.Box3(p.clone(), p.clone()));
        }
        for (const k of ['target', 'radius', 'label', 'spawn']) if (cfg[k] !== undefined) door[k] = cfg[k];
        if (cfg.mode !== undefined) door.mode = normMode(cfg.mode);
      }

      doors = [...byId.values()].filter((d) => d.shapes.length);
      const spawns = collectSpawns(root);
      for (const d of doors) {
        Object.assign(d, parseTarget(d.target));
        if (d.spawnName !== null) d.spawnName = normSpawnKey(d.spawnName);
        // El spawn destino de la misma escena tiene que existir
        if (d.scene === sceneId && d.spawnName !== null && !d.spawn && !spawns.has(d.spawnName)) {
          console.warn(`Teleport "${d.id}": no hay ningún Empty "${d.spawnName ? 'spawn_' + d.spawnName : 'spawn'}" en esta escena. ¿Es una escena sin registrar en scenes.json?`);
        }
      }
      if (helpers) {
        for (const d of doors) for (const b of d.shapes) {
          // verde agua = con E · naranja = automático
          helpers.add(new THREE.Box3Helper(b.clone().expandByScalar(d.radius), d.mode === 'auto' ? 0xf59e0b : 0x2dd4bf));
        }
      }
      const full = (k) => (k === null ? '' : k ? `:spawn_${k}` : ':spawn');
      console.info(`Puertas/teleports de "${sceneId}":`, doors.map((d) => `${d.id} [${d.mode}] -> ${d.scene}${full(d.spawnName)}`));
    },

    // Puertas/teleports de la escena actual (para el modo desarrollador)
    get list() { return doors; },

    // `focus`: punto del jugador (o de la cámara libre) que se compara con cada puerta
    update(focus) {
      if (busy) return;
      _p.copy(focus);
      let best = null, bestD = Infinity;
      let autoHit = null, insideAuto = false;
      for (const d of doors) {
        for (const b of d.shapes) {
          const dist = b.distanceToPoint(_p);
          if (dist > d.radius) continue; // radio 0 = hay que estar adentro de la zona
          if (d.mode === 'auto') { insideAuto = true; autoHit ??= d; }
          else if (dist < bestD) { best = d; bestD = dist; }
        }
      }

      if (blocked()) { // un NPC tiene prioridad: se esconde el aviso y los automáticos esperan
        if (near) { near = null; prompt.hidden = true; }
        return;
      }
      if (!insideAuto) autoArmed = true;
      else if (autoArmed && autoHit) { trigger(autoHit); return; }

      if (best !== near) {
        near = best;
        prompt.hidden = !near;
        if (near) prompt.innerHTML = `<kbd>E</kbd> ${near.label ?? 'Entrar'}`;
      }
    },
  };
}
