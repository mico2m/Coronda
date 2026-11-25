// Recorre todas las escenas del proyecto: qué NPC hay (con su diálogo y recorrido), qué puntos ruta_ existen,
// qué música usa cada escena. Sirve al editor de diálogos para ofrecer las animaciones reales del NPC.
import * as THREE from 'three';
import { loadGLB } from '/src/core/assets.js';
import { classifyClip } from '/src/actors/npc-anim.js';

const npcIdOf = (name) => /^npc_(.+?)(?:\.\d+)?$/i.exec(name ?? '')?.[1] ?? null;
const modelUrl = (v, id) => {
  const s = String(v ?? '').trim();
  if (!s) return id ? `assets/models/objects/${id}.glb` : null;
  return /[\\/]/.test(s) ? s : `assets/models/objects/${s.replace(/\.glb$/i, '')}.glb`;
};

let cache = null;
export function forgetIndex() { cache = null; }

export async function projectIndex(app) {
  if (cache) return cache;
  cache = (async () => {
    const npcs = [], points = [], music = new Map();
    for (const [id, entry] of Object.entries(app.scenes)) {
      let doc;
      try { doc = await app.api.readJSON(entry.file); } catch { continue; }
      if (doc.music) { if (!music.has(doc.music)) music.set(doc.music, []); music.get(doc.music).push(id); }
      const visit = (o, roomFile) => {
        const name = o.name;
        if (!name) return;
        const u = o.userData ?? {};
        const p = o.getWorldPosition(new THREE.Vector3());
        const nid = npcIdOf(name);
        const model = modelUrl(u.npc_modelo, nid);
        if (nid) npcs.push({ scene: id, sceneFile: roomFile, name, id: nid, model, modelFile: model?.split('/').pop() ?? null, dialogue: u.npc_dialogo ? String(u.npc_dialogo).replace(/\.json$/i, '') : null, route: u.npc_ruta ? String(u.npc_ruta) : null });
        if (!o.isMesh && !o.getObjectByProperty('isMesh', true)) points.push({ scene: id, name, x: p.x, y: p.y, z: p.z });
      };
      // salas .glb exportadas de Blender
      for (const room of doc.rooms ?? []) {
        if (!room.model) continue;
        try {
          const g = await loadGLB(`/${room.model}`);
          g.scene.updateMatrixWorld(true);
          g.scene.traverse((o) => { if (o !== g.scene) visit(o, String(room.model).split('/').pop()); });
        } catch { /* sala sin exportar */ }
      }
    }
    return { npcs, points, music };
  })();
  return cache;
}

// Animaciones de un modelo: [{ name, kind, duration }] (se cachean)
const clipCache = new Map();
export function clipsOf(url) {
  if (!url) return Promise.resolve([]);
  if (!clipCache.has(url)) {
    clipCache.set(url, loadGLB(`/${url}`).then((g) => g.animations.map((c) => ({ name: c.name, kind: classifyClip(c.name), duration: c.duration }))).catch(() => []));
  }
  return clipCache.get(url);
}
export function forgetClips(url) { clipCache.delete(url); }
