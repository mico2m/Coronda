// Texturas: configuración común, textura de prueba y carga desde un archivo del usuario.
import * as THREE from 'three';

export function configureTexture(t, renderer) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.needsUpdate = true;
  return t;
}

// Baldosas grises con un poco de ruido, para que se note la repetición.
export function makeDefaultTexture(renderer) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const tones = ['#9aa19c', '#8a918d', '#a4aaa4', '#868d89'];
  g.fillStyle = '#6f7673';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      g.fillStyle = tones[i * 2 + j];
      g.fillRect(i * 256 + 5, j * 256 + 5, 246, 246);
    }
  }
  for (let n = 0; n < 2600; n++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
    g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  return configureTexture(new THREE.CanvasTexture(c), renderer);
}

// Devuelve una promesa con la textura lista para usar (PNG, JPG o WebP).
export function loadTextureFromFile(file, renderer) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    new THREE.TextureLoader().load(
      url,
      (t) => {
        URL.revokeObjectURL(url);
        resolve(configureTexture(t, renderer));
      },
      undefined,
      () => {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer ' + file.name));
      }
    );
  });
}