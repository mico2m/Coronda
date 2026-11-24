// Solo modo desarrollador: dibuja lo que el juego considera colisión.
//   rojo  = paredes (frenan al jugador)
//   verde = suelo (se camina sobre ellos)
// Los objetos sin colisión no aparecen. Sirve para comprobar qué exportó Blender
// (mallas col_…, Empties col_…, objetos con colision = 1).
// Se prende y apaga con la tecla K o con el botón "Colisiones" (al lado del de Inspector).
// La elección se recuerda al recargar la página.
import * as THREE from 'three';

const STORE_KEY = 'coronda.dev.colisiones';

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
  try { visible = localStorage.getItem(STORE_KEY) === '1'; } catch {}
  let group = null;
  let stats = null;

  // Botón (si dev.html no lo trae, se crea)
  let btn = document.getElementById('collisionToggle');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'collisionToggle';
    btn.type = 'button';
    btn.className = 'inspect-toggle collision-toggle';
    (document.getElementById('inspectToggle')?.parentElement ?? document.body).append(btn);
  }

  function refresh() {
    btn.setAttribute('aria-pressed', String(visible));
    btn.textContent = visible ? 'Colisiones: visibles (K)' : 'Colisiones: ocultas (K)';
    btn.title = stats
      ? `Rojo = paredes (${stats.walls}) · Verde = suelo (${stats.floors}) · Empties col_: ${stats.empties ?? 0} · Reemplazados por col_: ${stats.replaced ?? 0}`
      : 'Rojo = paredes · Verde = suelo';
  }

  function setVisible(on) {
    visible = !!on;
    if (group) group.visible = visible;
    try { localStorage.setItem(STORE_KEY, visible ? '1' : '0'); } catch {}
    refresh();
  }

  btn.addEventListener('click', () => { setVisible(!visible); btn.blur(); });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyK' || e.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    setVisible(!visible);
  });
  // Al lado del botón Inspector (su ancho cambia con el texto "activado/apagado")
  const inspBtn = document.getElementById('inspectToggle');
  function place() {
    if (!inspBtn || inspBtn.hidden) return;
    const parent = btn.offsetParent ?? btn.parentElement;
    const pr = parent?.getBoundingClientRect?.() ?? { left: 0 };
    btn.style.left = `${Math.round(inspBtn.getBoundingClientRect().right - pr.left + 8)}px`;
  }
  if (inspBtn && 'ResizeObserver' in window) new ResizeObserver(place).observe(inspBtn);
  window.addEventListener('resize', place);

  refresh();
  place();

  return {
    // Se llama después de cargar cada escena. `parent` es el grupo de la escena (se libera junto con ella).
    attach(parent, world) {
      group = new THREE.Group();
      group.name = 'collision-debug';
      group.visible = visible;
      group.add(makeMesh(world.triangles.walls, 0xff3b3b), makeMesh(world.triangles.floors, 0x3bff6b));
      parent.add(group);
      stats = world.stats;
      refresh();
    },
    setVisible,
    get visible() { return visible; },
  };
}
