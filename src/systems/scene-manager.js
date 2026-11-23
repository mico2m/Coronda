// Gestor de escenas: lee data/scenes/<id>.json, arma el entorno, carga las salas (.glb) y la música.
// Idea tomada de Ocarina of Time: una escena = ambiente + salas; los datos van aparte del código.
import * as THREE from 'three';
import { loadJSON, loadGLB } from '../core/assets.js';

export function createSceneManager({ scene, camera, controls, audio, ui, scenesTable }) {
  let current = null; // { data, group }

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

  const EYE_HEIGHT = 1.7; // el empty va en el suelo; la cámara se pone a esta altura
  const spawnName = (n) => THREE.PropertyBinding.sanitizeNodeName(n);

  // Busca un empty de spawn en la escena y devuelve { position, yaw }. Mira hacia donde apunta
  // la flecha verde (eje Y) del empty en Blender.
  function findSpawn(group, fromId) {
    group.updateMatrixWorld(true);
    const names = [];
    if (fromId) names.push(`empty_spawn_${fromId.replace(/^scene_/, '')}`);
    names.push('empty_spawn');
    for (const n of names) {
      const node = group.getObjectByName(spawnName(n));
      if (!node) continue;
      const p = node.getWorldPosition(new THREE.Vector3());
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
      return { position: [p.x, p.y + EYE_HEIGHT, p.z], yaw: Math.atan2(-f.x, -f.z) };
    }
    return null;
  }

  async function loadScene(id, { spawn } = {}) {
    const fromId = current?.data.id ?? null; // escena de la que venimos (para empty_spawn_<origen>)
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
        group.add(gltf.scene);
      } catch {
        missing.push(room.model);
      }
    }

    // Posición inicial, por orden de prioridad:
    //  1) "spawn" de la puerta por la que entraste (JSON)
    //  2) empty "empty_spawn_<origen>" del .glb (solo cuando venís de esa escena; ej. empty_spawn_casa1)
    //  3) empty "empty_spawn" del .glb
    //  4) "spawn" del JSON de la escena
    const sp = spawn ?? findSpawn(group, fromId) ?? data.spawn;
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
    get current() { return current?.data ?? null; },
    get root() { return current?.group ?? null; },
  };
}
