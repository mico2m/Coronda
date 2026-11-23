// Solo modo desarrollador: dibuja lo que el juego considera colisión (tecla K).
//   rojo  = paredes (frenan al jugador)
//   verde = suelo (se camina sobre ellos)
// Los objetos sin colisión no aparecen. Sirve para comprobar qué exportó Blender.
import * as THREE from 'three';

function makeMesh(tris, color) {
  const n = tris.length / 12;
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) pos[i * 9 + k] = tris[i * 12 + k];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  const lines = new THREE.LineSegments(new THREE.WireframeGeometry(g), new THREE.LineBasicMaterial({ color }));
  const group = new THREE.Group();
  group.add(fill, lines);
  group.traverse((o) => { o.raycast = () => {}; }); // el inspector no apunta a esto
  return group;
}

export function createCollisionDebug() {
  let visible = false;
  let group = null;

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyK' || e.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    visible = !visible;
    if (group) group.visible = visible;
  });

  return {
    // Se llama después de cargar cada escena. `parent` es el grupo de la escena (se libera junto con ella).
    attach(parent, world) {
      group = new THREE.Group();
      group.name = 'collision-debug';
      group.visible = visible;
      group.add(makeMesh(world.triangles.walls, 0xff3b3b), makeMesh(world.triangles.floors, 0x3bff6b));
      parent.add(group);
    },
  };
}
