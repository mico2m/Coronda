// El suelo: un plano con tamaño en metros, textura repetible y cuadrícula opcional.
import * as THREE from 'three';

export function createFloor(scene) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  );
  mesh.rotation.x = -Math.PI / 2;
  scene.add(mesh);

  let width = 20;
  let depth = 20;
  let texture = null;
  let grid = null;
  let gridOn = false;

  function rebuildGrid() {
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      grid.material.dispose();
      grid = null;
    }
    if (!gridOn) return;
    const size = Math.max(width, depth);
    grid = new THREE.GridHelper(size, size, 0x000000, 0x000000);
    grid.material.transparent = true;
    grid.material.opacity = 0.25;
    grid.position.y = 0.01;
    scene.add(grid);
  }

  return {
    mesh,
    setSize(w, d) {
      width = w;
      depth = d;
      mesh.scale.set(w, d, 1);
      rebuildGrid();
    },
    setRepeat(x, z) {
      if (texture) texture.repeat.set(x, z);
    },
    setTexture(t, repeatX = 1, repeatZ = 1) {
      if (texture) texture.dispose();
      texture = t;
      texture.repeat.set(repeatX, repeatZ);
      mesh.material.map = t;
      mesh.material.needsUpdate = true;
    },
    setGrid(on) {
      gridOn = on;
      rebuildGrid();
    },
  };
}