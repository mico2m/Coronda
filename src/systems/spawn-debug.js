// Solo modo desarrollador: muestra los spawns (puntos de aparición) de la escena.
//   amarillo = spawn base ("spawn")        celeste = los demás (spawn_muelle, spawn_casa1, …)
//   gris     = "spawn" del JSON de la escena (respaldo, solo si el .glb no tiene un Empty spawn)
// Cada spawn se dibuja como un poste de la altura del jugador, con una flecha en el suelo hacia donde vas a mirar
// y una etiqueta con su nombre (se ve a través de las paredes para encontrarlo fácil).
// Las líneas naranjas van desde cada teleport/puerta hasta el spawn de esta escena al que lleva; los que llevan a
// otra escena muestran su destino en una etiqueta.
// Con el inspector, apuntá a un poste para ver sus datos y cómo escribirlo en un teleport.
// Se prende y apaga con la tecla P o con el botón "Spawns" (al lado de "Colisiones"). La elección se recuerda.
import * as THREE from 'three';
import { collectSpawns, spawnFromNode } from './spawns.js';

const STORE_KEY = 'coronda.dev.spawns';
const EYE = 1.7;
const COLORS = { base: 0xffd400, other: 0x38bdf8, json: 0x9ca3af, link: 0xf59e0b };

const fullName = (key) => (key ? `spawn_${key}` : 'spawn');
const noRay = (o) => o.traverse((c) => { c.raycast = () => {}; });

function makeLabel(text, color) {
  const pad = 10, size = 28;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `600 ${size}px Inter, sans-serif`;
  c.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  c.height = size + pad * 2;
  ctx.font = `600 ${size}px Inter, sans-serif`;
  ctx.fillStyle = 'rgba(15,17,21,0.82)';
  ctx.beginPath(); ctx.roundRect(0, 0, c.width, c.height, 8); ctx.fill();
  ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = 0.32; // metros
  sprite.scale.set((h * c.width) / c.height, h, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function makeMarker(info, color) {
  const g = new THREE.Group();
  g.name = `spawn-marker:${info.name}`;
  g.position.set(...info.feet);
  g.rotation.y = info.yaw; // con yaw 0 se mira hacia -Z

  const mat = (opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  // Poste (es lo que detecta el inspector)
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, EYE, 16, 1, true), mat(0.25));
  pole.position.y = EYE / 2;
  pole.userData.spawnMarker = info;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 32), mat(0.9));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  // Flecha en el suelo: hacia dónde mira el jugador al aparecer
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 3), mat(0.9));
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.05, -0.7);
  // Ojos: a qué altura queda la cámara libre
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), mat(1));
  eye.position.set(0, EYE, -0.3);
  noRay(ring); noRay(arrow); noRay(eye);
  g.add(pole, ring, arrow, eye);

  const label = makeLabel(info.name, color);
  label.position.y = EYE + 0.35;
  noRay(label);
  g.add(label);
  return g;
}

function dispose(group) {
  group.traverse((o) => {
    o.geometry?.dispose?.();
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) { m.map?.dispose?.(); m.dispose(); }
  });
}

export function createSpawnDebug() {
  let visible = true;
  try { visible = localStorage.getItem(STORE_KEY) !== '0'; } catch {}
  let group = null;
  let count = 0;

  let btn = document.getElementById('spawnToggle');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'spawnToggle';
    btn.type = 'button';
    btn.className = 'inspect-toggle spawn-toggle';
    (document.getElementById('inspectToggle')?.parentElement ?? document.body).append(btn);
  }

  function refresh() {
    btn.setAttribute('aria-pressed', String(visible));
    btn.textContent = `Spawns: ${visible ? 'visibles' : 'ocultos'} (P)`;
    btn.title = `Amarillo = spawn base · Celeste = otros spawns · Naranja = teleports hacia esta escena · ${count} spawn(s)`;
  }

  function setVisible(on) {
    visible = !!on;
    if (group) group.visible = visible;
    try { localStorage.setItem(STORE_KEY, visible ? '1' : '0'); } catch {}
    refresh();
  }

  btn.addEventListener('click', () => { setVisible(!visible); btn.blur(); });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyP' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    setVisible(!visible);
  });

  // A la derecha del botón "Colisiones" (o del Inspector si no está)
  function place() {
    const prev = document.getElementById('collisionToggle') ?? document.getElementById('inspectToggle');
    if (!prev || prev.hidden) return;
    const parent = btn.offsetParent ?? btn.parentElement;
    const pr = parent?.getBoundingClientRect?.() ?? { left: 0 };
    btn.style.left = `${Math.round(prev.getBoundingClientRect().right - pr.left + 8)}px`;
  }
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(place);
    for (const id of ['inspectToggle', 'collisionToggle']) { const b = document.getElementById(id); if (b) ro.observe(b); }
  }
  window.addEventListener('resize', place);

  refresh();
  place();

  return {
    // Después de cargar cada escena. `root` es el grupo de la escena (se libera junto con ella),
    // `data` el JSON de la escena y `doors` la lista de puertas/teleports (doors.list).
    attach(root, data, doors = []) {
      if (group) { group.parent?.remove(group); dispose(group); }
      group = new THREE.Group();
      group.name = 'spawn-debug';
      group.visible = visible;
      root.updateMatrixWorld(true);

      // Teleports de esta escena que llevan a cada spawn
      const arrivals = new Map();
      for (const d of doors) {
        if (d.scene !== data.id) continue;
        const k = d.spawnName ?? '';
        if (!arrivals.has(k)) arrivals.set(k, []);
        arrivals.get(k).push(d);
      }

      const spawns = collectSpawns(root);
      const at = new Map(); // nombre corto -> posición de los pies
      for (const [key, node] of spawns) {
        const sp = spawnFromNode(node);
        const feet = [sp.position[0], sp.position[1] - EYE, sp.position[2]];
        at.set(key, feet);
        const info = {
          name: fullName(key), key, object: node.name, file: node.userData.sourceFile ?? null,
          feet, yaw: sp.yaw, scene: data.id, fromJson: false,
          teleports: (arrivals.get(key) ?? []).map((d) => d.id),
        };
        group.add(makeMarker(info, key ? COLORS.other : COLORS.base));
      }
      // Respaldo del JSON, solo si no hay un spawn base en el .glb (es el que se usaría)
      if (!spawns.has('') && data.spawn?.position) {
        const p = data.spawn.position;
        const feet = [p[0], p[1] - EYE, p[2]];
        at.set('', feet);
        group.add(makeMarker({
          name: 'spawn (JSON)', key: '', object: null, file: `data/scenes/${data.id}.json`,
          feet, yaw: data.spawn.yaw ?? 0, scene: data.id, fromJson: true,
          teleports: (arrivals.get('') ?? []).map((d) => d.id),
        }, COLORS.json));
      }
      count = spawns.size;

      // Líneas teleport -> spawn (misma escena) y etiquetas de destino (otra escena)
      const linePts = [];
      for (const d of doors) {
        const c = d.shapes[0]?.getCenter(new THREE.Vector3());
        if (!c) continue;
        if (d.scene === data.id) {
          const f = at.get(d.spawnName ?? '');
          if (f) linePts.push(c, new THREE.Vector3(f[0], f[1] + 0.05, f[2]));
        } else {
          const label = makeLabel(`→ ${d.scene}${d.spawnName === null ? '' : ':' + fullName(d.spawnName)}`, COLORS.link);
          label.position.copy(c).y += Math.max(1, d.shapes[0].max.y - c.y + 0.4);
          noRay(label);
          group.add(label);
        }
      }
      if (linePts.length) {
        const lines = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(linePts),
          new THREE.LineDashedMaterial({ color: COLORS.link, dashSize: 0.3, gapSize: 0.2, depthTest: false, transparent: true }),
        );
        lines.computeLineDistances();
        lines.renderOrder = 998;
        noRay(lines);
        group.add(lines);
      }

      root.add(group);
      refresh();
    },
    setVisible,
    get visible() { return visible; },
  };
}
