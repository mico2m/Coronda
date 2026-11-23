// Carga de archivos externos (datos y modelos), con caché.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const jsonCache = new Map();
const gltfLoader = new GLTFLoader();

export async function loadJSON(url) {
  if (jsonCache.has(url)) return jsonCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo leer ${url} (${res.status})`);
  const data = await res.json();
  jsonCache.set(url, data);
  return data;
}

export function loadGLB(url, onProgress) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      resolve,
      (e) => onProgress?.(e.total ? e.loaded / e.total : 0),
      () => reject(new Error(`No se pudo cargar ${url}`))
    );
  });
}
