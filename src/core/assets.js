// Carga de archivos externos (datos y modelos), con caché.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { padUVTextures } from './texture-padding.js';

const jsonCache = new Map();
const gltfLoader = new GLTFLoader();

// Avisa qué archivo empieza y termina de bajar (la pantalla de carga lo muestra abajo, ver ui/boot.js)
const avisar = (url, on) => { try { dispatchEvent(new CustomEvent('coronda:carga', { detail: { url, on } })); } catch { /* sin ventana */ } };

export async function loadJSON(url) {
  if (jsonCache.has(url)) return jsonCache.get(url);
  avisar(url, true);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo leer ${url} (${res.status})`);
    const data = await res.json();
    jsonCache.set(url, data);
    return data;
  } finally { avisar(url, false); }
}

// Olvida un JSON cacheado (el editor de diálogos lo usa después de guardar, para que el juego lea la versión nueva)
export function forgetJSON(url) { jsonCache.delete(url); }

// En vivo con Blender (ver systems/live.js): después de exportar, los .glb se piden de nuevo y no del caché del navegador
let freshTag = '';
export function freshModels() { freshTag = `v=${Date.now()}`; }

// opts.pad = false: no rellena los bordes de UV (más rápido; lo usa la vista previa del menú)
export function loadGLB(url, onProgress, { pad = true } = {}) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      freshTag ? `${url}${url.includes('?') ? '&' : '?'}${freshTag}` : url,
      (gltf) => { if (pad) padUVTextures(gltf.scene); resolve(gltf); },
      (e) => onProgress?.(e.total ? e.loaded / e.total : 0),
      (err) => reject(new Error(`No se pudo cargar ${url}${err?.message ? ` (${err.message})` : ''}`))
    );
  });
}
