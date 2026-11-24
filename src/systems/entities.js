// Entidades: los objetos de una escena armada en el editor (el motor manda; Blender es solo para modelar assets).
// Viven en data/scenes/<escena>.json > "entities":
//
//   { "id": "e7",                         identificador estable (lo usa el editor)
//     "name": "puerta_torre",             nombre: los sistemas lo leen igual que en Blender (spawn_, npc_, col_, puerta_…)
//     "parent": "e2",                     (opcional) entidad padre
//     "position": [x, y, z],              metros, Y hacia arriba (como en el juego)
//     "rotation": [x, y, z],              grados (orden XYZ)
//     "scale": [x, y, z],
//     "model": "assets/models/objects/puerta_casa.glb",   (opcional) qué se ve
//     "node": "Plane",                    (opcional) solo ese objeto del .glb (para escenas convertidas desde Blender)
//     "props": { "puerta": "spawn_torre" },               las mismas Custom Properties de Blender
//     "hidden": true }                    (opcional) no se dibuja en el juego
//
// Cada entidad se vuelve un Object3D con ese nombre y userData = props, así puertas, colisiones, spawns, NPC
// y objetos reutilizables funcionan exactamente igual que con un .glb exportado de Blender.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLB } from '../core/assets.js';

export const DEG = Math.PI / 180;

export function applyTransform(obj, e) {
  const p = e.position ?? [0, 0, 0], r = e.rotation ?? [0, 0, 0], s = e.scale ?? [1, 1, 1];
  obj.position.set(p[0], p[1], p[2]);
  obj.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ');
  obj.scale.set(s[0], s[1], s[2]);
}

// Copia lista para usar del modelo de una entidad (todo el .glb, o solo `node`), con sus animaciones
export function instantiateModel(gltf, e) {
  const src = e.node ? gltf.scene.getObjectByName(e.node) : gltf.scene;
  if (!src) return null;
  const inst = cloneSkinned(src);
  let clips = gltf.animations;
  if (e.node) {
    inst.position.set(0, 0, 0); inst.quaternion.identity(); inst.scale.set(1, 1, 1); // la entidad tiene la transformación
    const names = new Set();
    src.traverse((o) => names.add(o.name));
    clips = gltf.animations.filter((c) => c.tracks.some((t) => names.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName)));
  }
  inst.name = `modelo:${e.node || e.model}`;
  // las propiedades viven en la entidad: el modelo no las repite (si no, una puerta se detectaría dos veces)
  inst.userData = { animations: clips, sourceFile: e.model };
  inst.traverse((o) => { if (o !== inst) o.userData.sourceFile = e.model; });
  return inst;
}

// Crea las entidades dentro de `parent`. onModel(inst, entity) se llama con cada modelo cargado (ej. para el sombreado).
// Devuelve { byId: Map id -> Object3D, missing: [rutas que no cargaron] }
export async function buildEntities(parent, entities = [], { onModel, load = loadGLB } = {}) {
  const byId = new Map();
  const files = new Map();
  const missing = new Set();
  for (const e of entities) {
    const obj = new THREE.Group();
    obj.name = e.name || e.id;
    obj.userData = { ...(e.props ?? {}), entityId: e.id };
    applyTransform(obj, e);
    if (e.hidden) obj.visible = false;
    byId.set(e.id, obj);
  }
  for (const e of entities) (byId.get(e.parent) ?? parent).add(byId.get(e.id));
  await Promise.all(entities.filter((e) => e.model).map(async (e) => {
    if (!files.has(e.model)) files.set(e.model, load(e.model));
    let gltf;
    try { gltf = await files.get(e.model); } catch (err) {
      if (!missing.has(e.model)) console.warn(`Entidad "${e.name}": no se pudo cargar ${e.model}.`, err.message);
      missing.add(e.model);
      return;
    }
    const inst = instantiateModel(gltf, e);
    if (!inst) { console.warn(`Entidad "${e.name}": no hay ningún objeto "${e.node}" en ${e.model}.`); return; }
    byId.get(e.id).add(inst);
    onModel?.(inst, e);
  }));
  return { byId, missing: [...missing] };
}
