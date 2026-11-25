// Gestor de escenas: lee data/scenes/<id>.json, arma el entorno, carga las salas (.glb) y la música.
// Idea tomada de Ocarina of Time: una escena = ambiente + salas; los datos van aparte del código.
//
// OBJETOS REUTILIZABLES (prefabs): un Empty de la escena con la Custom Property
//   objeto = "puerta_casa"   -> carga assets/models/objects/puerta_casa.glb y lo pone ahí (con la posición, giro y
//                               escala del Empty). También acepta una ruta: "assets/models/otros/x.glb".
// Se modela y anima una sola vez y se usa en todas las escenas que quieras. Lo que va adentro del archivo (sus
// animaciones, sus col_…, sus propiedades) viaja con él; lo que cambia en cada escena (ej. "puerta" = destino) va en el Empty.
// Usá Display As = Plain Axes o Arrows con escala 1 (si escalás el Empty, el objeto también se escala).
// Para VERLO en Blender mientras lo ubicás: File > Link > puerta_casa.blend > Collection, y Add > Collection Instance.
// Esa instancia es un Empty que muestra la puerta: ponele "objeto" ahí. Si el exportador mete una copia de la puerta
// adentro del Empty, el juego la saca y pone la del .glb (que es la que trae la animación), así no queda duplicada.
import * as THREE from 'three';
import { loadJSON, loadGLB } from '../core/assets.js';
import { makeUnlit, setShade, isSkyName } from './shading.js';
import { findSpawn } from './spawns.js';

const _v = new THREE.Vector3();

export function createSceneManager({ scene, camera, controls, audio, ui, scenesTable }) {
  let current = null; // { data, group }
  let skies = [];       // objetos "cielo": siguen a la cámara
  let shade = { tint: '#ffffff', brightness: 1 };
  let lastSpawn = null; // { position (a la altura de los ojos), yaw } usado en la última carga

  function disposeGroup(group) {
    group.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => {
        Object.values(m).forEach((v) => v?.isTexture && v.dispose());
        m.dispose();
      });
    });
  }

  function unload() {
    if (!current) return;
    scene.remove(current.group);
    disposeGroup(current.group);
    current = null;
  }

  function applyEnvironment(env = {}, group) {
    const bg = new THREE.Color(env.background ?? '#c9d4d9');
    scene.background = bg;
    scene.fog = env.fog ? new THREE.Fog(env.fog.color ?? bg, env.fog.near ?? 80, env.fog.far ?? 400) : null;

    if (env.shading !== 'lit') return; // sin luces: el aspecto lo da el tono/brillo (ver shading.js)
    if (env.ambient) {
      const a = env.ambient;
      group.add(new THREE.HemisphereLight(a.sky ?? '#ffffff', a.ground ?? '#888888', a.intensity ?? 1));
    }
    if (env.sun) {
      const s = env.sun;
      const sun = new THREE.DirectionalLight(s.color ?? '#ffffff', s.intensity ?? 1);
      sun.position.set(...(s.position ?? [20, 40, 10]));
      group.add(sun);
    }
  }

  const objectUrl = (v) => {
    const s = String(v).trim();
    return /[/\\]|\.glb$/i.test(s) ? s : `assets/models/objects/${s}.glb`;
  };

  // Empties con "objeto": carga cada archivo una vez por escena y pone una copia en cada Empty
  async function placeObjects(group) {
    const spots = [];
    group.traverse((o) => {
      const v = o.userData?.objeto;
      if (typeof v === 'string' && v.trim() && !o.userData.objectPlaced) spots.push(o);
    });
    if (!spots.length) return;
    const unlit = current?.data.environment?.shading !== 'lit';
    const files = new Map(); // url -> Promise<gltf>
    const failed = new Set();
    await Promise.all(spots.map(async (spot) => {
      const url = objectUrl(spot.userData.objeto);
      if (!files.has(url)) files.set(url, loadGLB(url));
      let gltf;
      try { gltf = await files.get(url); } catch (err) {
        if (!failed.has(url)) { failed.add(url); console.warn(`Objeto "${spot.name}": no se pudo cargar ${url}.`, err.message); }
        return;
      }
      // lo que Blender exportó adentro del Empty (la vista previa de la Collection Instance) se reemplaza
      for (const c of [...spot.children]) {
        spot.remove(c);
        c.traverse((o) => { o.geometry?.dispose?.(); });
      }
      const inst = gltf.scene.clone(true);
      inst.name = `objeto:${spot.userData.objeto}`;
      // sus animaciones (ej. abrir la puerta) se reproducen sobre ESTA copia (ver doors.js)
      inst.userData = { animations: gltf.animations, objectFile: url };
      inst.traverse((o) => { o.userData.sourceFile = url; o.userData.roomId = spot.userData.roomId; });
      if (unlit) { makeUnlit(inst); setShade(inst, shade); }
      spot.add(inst);
      spot.userData.objectPlaced = true;
    }));
    if (failed.size) ui.setStatus(`Objetos: no se encontró ${[...failed].join(', ')}`);
  }

  async function loadScene(id, { spawn, spawnName } = {}) {
    const fromId = current?.data.id ?? null; // escena de la que venimos (para spawn_<origen>)
    const entry = scenesTable[id];
    if (!entry) throw new Error(`La escena "${id}" no está en data/tables/scenes.json`);

    ui.setStatus(`Cargando ${id}…`);
    // Una escena puede venir armada desde el código (entry.data, ej. el interior de una casa, ver casas.js)
    const data = entry.data ? structuredClone(entry.data) : await loadJSON(entry.file);
    unload();

    const group = new THREE.Group();
    group.name = data.id;
    scene.add(group);
    current = { data, group };

    applyEnvironment(data.environment, group);
    const unlit = data.environment?.shading !== 'lit';
    shade = { tint: data.environment?.tint ?? '#ffffff', brightness: data.environment?.brightness ?? 1 };
    skies = [];

    // Salas
    const missing = [];
    for (const room of data.rooms ?? []) {
      try {
        const gltf = await loadGLB(room.model, (p) => ui.setStatus(`Cargando sala "${room.id}"… ${Math.round(p * 100)}%`));
        gltf.scene.name = `room:${room.id}`;
        // Para el inspector: de qué archivo y sala viene cada objeto
        gltf.scene.userData.isRoomRoot = true;
        gltf.scene.userData.animations = gltf.animations; // animaciones de objetos de la sala (ej. puertas, ver doors.js)
        gltf.scene.traverse((o) => {
          o.userData.sourceFile = room.model;
          o.userData.roomId = room.id;
        });
        if (unlit) {
          makeUnlit(gltf.scene);
          gltf.scene.traverse((o) => {
            if (!isSkyName(o.name)) return;
            skies.push(o);
            o.traverse((c) => {
              c.frustumCulled = false;
              c.renderOrder = -1;
              for (const m of Array.isArray(c.material) ? c.material : c.material ? [c.material] : []) {
                m.fog = false; m.depthWrite = false; // el cielo no recibe niebla ni tapa a nada
                m.side = THREE.DoubleSide;           // se ve desde adentro aunque las normales estén al revés
              }
            });
          });
          setShade(gltf.scene, shade);
        }
        group.add(gltf.scene);
      } catch {
        missing.push(room.model);
      }
    }

    // Lo que arma el código para esta escena (entry.build, ej. paredes y muebles de una casa)
    if (entry.build) await entry.build(group, data);

    // Objetos colocados desde el JSON de la escena (sin Empty en el .glb):
    //   "objects": [{ "id": "tienda", "objeto": "tienda", "position": [30, 0, -22], "yaw": 0, "scale": 1 }]
    // Es lo mismo que un Empty con objeto = "tienda": carga assets/models/objects/<objeto>.glb en ese lugar.
    for (const o of data.objects ?? []) {
      if (!o?.objeto || !Array.isArray(o.position)) continue;
      const spot = new THREE.Group();
      spot.name = String(o.id ?? `objeto_${o.objeto}`);
      spot.position.set(...o.position.map(Number));
      spot.rotation.y = (Number(o.yaw) || 0) * Math.PI / 180;
      if (Number(o.scale)) spot.scale.setScalar(Number(o.scale));
      spot.userData.objeto = String(o.objeto);
      group.add(spot);
    }

    // Objetos reutilizables (Empties con "objeto"): se cargan antes de las colisiones, puertas y NPC
    await placeObjects(group);

    // Posición inicial, por orden de prioridad (los spawns se explican en spawns.js):
    //  1) "spawn" de la puerta por la que entraste (JSON)
    //  2) el spawn que pide el teleport ("scene_casa1:spawn_cocina", o "scene_casa1:spawn" para el base)
    //  3) spawn_<origen>, solo cuando venís de esa escena (desde scene_casa1 -> spawn_casa1)
    //  4) spawn (el de por defecto)
    //  5) "spawn" del JSON de la escena
    const fromKey = fromId ? fromId.replace(/^scene_/, '') : null;
    if (spawnName && !spawn && !findSpawn(group, [spawnName]))
      console.warn(`Escena "${id}": no hay ningún Empty "spawn_${spawnName}"; se usa el spawn normal.`);
    const sp = spawn ?? findSpawn(group, [spawnName, fromKey, '']) ?? data.spawn;
    lastSpawn = sp ?? null;
    if (sp) {
      camera.position.set(...sp.position);
      controls.setLook(sp.yaw ?? 0, 0);
    }

    // Si todavía no exportaste el mundo desde Blender, mostramos una cuadrícula de referencia.
    if (missing.length) {
      group.add(new THREE.GridHelper(40, 40, 0x555555, 0x888888));
      ui.setStatus(`Falta exportar desde Blender: ${missing.join(', ')}`);
    } else {
      ui.clearStatus();
    }

    if (data.music) audio.playMusic(data.music);
    return data;
  }

  return {
    loadScene,
    unload,
    // Punto de aparición desde un Empty de la escena actual: { position (ojos), yaw } o null
    // Spawn de la escena actual por su nombre corto ("arriba" -> Empty spawn_arriba): { position (ojos), yaw } o null
    findSpawnByName(name) { return current ? findSpawn(current.group, [name]) : null; },
    get spawn() { return lastSpawn; },
    get shade() { return shade; },
    // El cielo acompaña a la cámara para que nunca se acabe
    updateSky(cameraPos) {
      for (const o of skies) o.position.copy(o.parent.worldToLocal(_v.copy(cameraPos)));
    },
    get current() { return current?.data ?? null; },
    get root() { return current?.group ?? null; },
  };
}
