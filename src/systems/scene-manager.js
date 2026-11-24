// Gestor de escenas: lee data/scenes/<id>.json, arma el entorno, carga las salas (.glb) y la música.
// Idea tomada de Ocarina of Time: una escena = ambiente + salas; los datos van aparte del código.
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

  async function loadScene(id, { spawn, spawnName } = {}) {
    const fromId = current?.data.id ?? null; // escena de la que venimos (para spawn_<origen>)
    const entry = scenesTable[id];
    if (!entry) throw new Error(`La escena "${id}" no está en data/tables/scenes.json`);

    ui.setStatus(`Cargando ${id}…`);
    const data = await loadJSON(entry.file);
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
