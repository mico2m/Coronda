// Solo modo desarrollador: muestra los recorridos de los NPC (data/routes/*.json) dentro del juego.
//   Cada recorrido tiene su color. Las bolitas son las paradas (verde = donde empieza) con una etiqueta
//   "número · nombre · espera"; las flechas van de cada parada a la siguiente. Las punteadas tienen
//   condición ("if": solo se toman cuando se cumple un flag).
// Con el inspector, apuntá a una bolita para ver los datos de esa parada y a dónde puede ir.
// Se prende y apaga con la tecla R o con el botón "Rutas" (al lado de "Spawns"). La elección se recuerda.
// Si guardás la ruta en el Studio, el juego se recarga (sin moverte) y el dibujo se actualiza.
import * as THREE from 'three';
import { loadJSON } from '../core/assets.js';

const STORE_KEY = 'coronda.dev.rutas';
const PALETTE = [0x38bdf8, 0xf472b6, 0xa3e635, 0xfb923c, 0xc084fc, 0x2dd4bf, 0xfacc15];
const START = 0x4ade80;
const LIFT = 0.3; // las bolitas van un poco arriba del suelo
const sanitize = THREE.PropertyBinding.sanitizeNodeName;
const noRay = (o) => o.traverse((c) => { c.raycast = () => {}; });
const num = (v) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function makeLabel(text, color) {
  const pad = 10, size = 26;
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
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = 0.28;
  s.scale.set((h * c.width) / c.height, h, 1);
  s.renderOrder = 999;
  return s;
}

function dispose(group) {
  group.traverse((o) => {
    o.geometry?.dispose?.();
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) { m.map?.dispose?.(); m.dispose(); }
  });
}

// Destinos de una parada: [{ to, weight, if }]
function outsOf(node) {
  if (typeof node.next === 'string') return node.next ? [{ to: node.next }] : [];
  if (Array.isArray(node.next)) return node.next.map((c) => (typeof c === 'string' ? { to: c } : c)).filter((c) => c?.to);
  return [];
}

// Espera, animación… pueden estar en la parada o en sus nodos modificadores ("mods")
function attrsOf(node, data) {
  const a = { wait: num(node.wait), waitMax: num(node.waitMax), anim: node.anim ?? null, loop: !!node.loop, walk: node.walk ?? null, speed: num(node.speed) };
  for (const id of node.mods ?? []) {
    const m = data.modifiers?.[id];
    if (!m) continue;
    if (m.wait !== undefined && a.wait === null) a.wait = num(m.wait);
    if (m.waitMax !== undefined && a.waitMax === null) a.waitMax = num(m.waitMax);
    if (m.anim !== undefined && !a.anim) a.anim = m.anim;
    if (m.loop) a.loop = true;
    if (m.walk !== undefined && !a.walk) a.walk = m.walk;
    if (m.speed !== undefined && a.speed === null) a.speed = num(m.speed);
  }
  return a;
}

const condText = (cond) => Object.entries(cond ?? {}).map(([k, v]) => `${k} = ${v}`).join(' y ');

export function createRouteDebug() {
  let visible = true;
  try { visible = localStorage.getItem(STORE_KEY) !== '0'; } catch {}
  let group = null;
  let count = 0;
  let token = 0;

  const btn = document.createElement('button');
  btn.id = 'routeToggle';
  btn.type = 'button';
  btn.className = 'inspect-toggle route-toggle';
  (document.getElementById('inspectToggle')?.parentElement ?? document.body).append(btn);

  function refresh() {
    btn.setAttribute('aria-pressed', String(visible));
    btn.textContent = `Rutas: ${visible ? 'visibles' : 'ocultas'} (R)`;
    btn.title = `Recorridos de los NPC (data/routes) · verde = donde empieza · punteado = con condición · ${count} recorrido(s)`;
  }
  function setVisible(on) {
    visible = !!on;
    if (group) group.visible = visible;
    try { localStorage.setItem(STORE_KEY, visible ? '1' : '0'); } catch {}
    refresh();
  }
  btn.addEventListener('click', () => { setVisible(!visible); btn.blur(); });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyR' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    setVisible(!visible);
  });

  // A la derecha del botón "Spawns" (o del último que haya)
  function place() {
    const prev = ['spawnToggle', 'collisionToggle', 'inspectToggle'].map((id) => document.getElementById(id)).find((b) => b && !b.hidden);
    if (!prev) return;
    const parent = btn.offsetParent ?? btn.parentElement;
    const pr = parent?.getBoundingClientRect?.() ?? { left: 0 };
    btn.style.left = `${Math.round(prev.getBoundingClientRect().right - pr.left + 8)}px`;
  }
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(place);
    for (const id of ['inspectToggle', 'collisionToggle', 'spawnToggle']) { const b = document.getElementById(id); if (b) ro.observe(b); }
  }
  window.addEventListener('resize', place);
  refresh();
  setTimeout(place, 0);

  function drawRoute(g, root, name, data, npcIds, color, scene) {
    const ids = Object.keys(data.nodes ?? {});
    const at = new Map();
    for (const id of ids) {
      const n = data.nodes[id];
      const o = n.point ? root.getObjectByName(sanitize(String(n.point))) : null;
      if (o) at.set(id, o.getWorldPosition(new THREE.Vector3()));
      else if (Array.isArray(n.position)) at.set(id, new THREE.Vector3(...n.position.map(Number)));
    }
    const missing = ids.filter((id) => !at.has(id));
    if (missing.length) console.warn(`Ruta "${name}": no encontré en el .glb los puntos de ${missing.map((id) => `${id} (${data.nodes[id].point ?? 'sin point'})`).join(', ')}`);

    // Paradas
    const order = new Map(ids.map((id, i) => [id, i + 1]));
    for (const [id, p] of at) {
      const n = data.nodes[id];
      const a = attrsOf(n, data);
      const isStart = id === data.start;
      const c = isStart ? START : color;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.9 }));
      ball.position.copy(p).y += LIFT;
      ball.renderOrder = 998;
      ball.userData.routeMarker = {
        route: name, file: `data/routes/${name}.json`, npcs: npcIds, stop: id, number: order.get(id), start: isStart,
        point: n.point ?? null, position: [p.x, p.y, p.z], ...a,
        next: outsOf(n).map((o) => ({ to: o.to, weight: num(o.weight), cond: condText(o.if) })),
        from: ids.filter((k) => outsOf(data.nodes[k]).some((o) => o.to === id)),
        routeSpeed: num(data.speed), scene,
      };
      g.add(ball);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 28), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(p).y += 0.03;
      noRay(ring);
      g.add(ring);
      let txt = `${order.get(id)} · ${id}`;
      if (a.loop) txt += ' · loop';
      else if (a.wait !== null) txt += ` · ${a.wait}${a.waitMax ? '–' + a.waitMax : ''} s`;
      if (isStart) txt = `▶ ${name}: ${txt}`;
      const label = makeLabel(txt, c);
      label.position.copy(p).y += LIFT + 0.45;
      noRay(label);
      g.add(label);
    }

    // Flechas entre paradas
    const solid = [], dashed = [];
    for (const id of ids) {
      const a = at.get(id); if (!a) continue;
      for (const o of outsOf(data.nodes[id])) {
        const b = at.get(o.to); if (!b) continue;
        const p0 = a.clone().setY(a.y + LIFT), p1 = b.clone().setY(b.y + LIFT);
        if (p0.distanceTo(p1) < 0.01) continue; // misma posición (ej. esperar en el lugar)
        (o.if ? dashed : solid).push(p0, p1);
        // punta de flecha a 70 % del camino
        const dir = p1.clone().sub(p0);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 10), new THREE.MeshBasicMaterial({ color, depthTest: false }));
        tip.position.copy(p0).addScaledVector(dir, 0.7);
        tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        tip.renderOrder = 997;
        noRay(tip);
        g.add(tip);
      }
    }
    if (solid.length) {
      const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(solid), new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 996; l.frustumCulled = false; noRay(l); g.add(l);
    }
    if (dashed.length) {
      const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(dashed), new THREE.LineDashedMaterial({ color, dashSize: 0.3, gapSize: 0.2, depthTest: false }));
      l.computeLineDistances();
      l.renderOrder = 996; l.frustumCulled = false; noRay(l); g.add(l);
    }
  }

  return {
    // Después de cargar los NPC de cada escena. `npcs` = npcs.list (cada uno con id y routeName).
    async attach(root, data, npcs = []) {
      const my = ++token;
      if (group) { group.parent?.remove(group); dispose(group); group = null; }
      const byRoute = new Map();
      for (const n of npcs) {
        const r = String(n.routeName ?? '').replace(/\.json$/i, '').trim();
        if (!r) continue;
        if (!byRoute.has(r)) byRoute.set(r, []);
        byRoute.get(r).push(n.id);
      }
      root.updateMatrixWorld(true);
      const g = new THREE.Group();
      g.name = 'route-debug';
      g.visible = visible;
      let i = 0;
      for (const [name, ids] of byRoute) {
        try {
          const json = await loadJSON(`data/routes/${name}.json`);
          if (my !== token) return; // cambiaste de escena mientras cargaba
          const rg = new THREE.Group(); // un grupo por ruta (el inspector ignora lo que está oculto dos niveles arriba)
          rg.name = `route-debug:${name}`;
          g.add(rg);
          drawRoute(rg, root, name, json, ids, PALETTE[i++ % PALETTE.length], data?.id);
        } catch (err) { console.warn(`Rutas: no se pudo leer data/routes/${name}.json (${err.message})`); }
      }
      if (my !== token) return;
      count = byRoute.size;
      group = g;
      root.add(g);
      refresh();
    },
    setVisible,
    get visible() { return visible; },
  };
}
