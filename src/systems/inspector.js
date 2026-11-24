// Inspector: una mira en el centro de la pantalla. Al apuntar a un objeto muestra
// su nombre, archivo de origen, tamaño en metros, texturas, triángulos y distancia.
// Se activa y desactiva con la tecla I o con el botón de arriba a la izquierda.
import * as THREE from 'three';

const MAP_SLOTS = [
  ['map', 'Color'],
  ['normalMap', 'Normal'],
  ['roughnessMap', 'Rugosidad'],
  ['metalnessMap', 'Metal'],
  ['emissiveMap', 'Emisión'],
  ['aoMap', 'Oclusión (AO)'],
  ['alphaMap', 'Transparencia'],
];

const fmt = (n) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2));

// Si la malla es una pieza de un objeto de Blender con varios materiales,
// GLTFLoader la mete en un Group: en ese caso medimos el grupo entero.
function pickObjectNode(mesh) {
  const p = mesh.parent;
  if (p && !p.userData.isRoomRoot && p.type === 'Group' && p.children.length <= 8 && p.children.every((c) => c.isMesh)) {
    return p;
  }
  return mesh;
}

function describeTexture(t) {
  const img = t.image;
  const w = img?.width ?? img?.naturalWidth;
  const h = img?.height ?? img?.naturalHeight;
  return { name: t.name || '(sin nombre)', width: w || null, height: h || null };
}

function describeMaterial(m) {
  const maps = [];
  for (const [slot, label] of MAP_SLOTS) {
    if (m[slot]) maps.push({ label, ...describeTexture(m[slot]) });
  }
  return {
    name: m.name || '(sin nombre)',
    type: m.type,
    color: m.color ? '#' + m.color.getHexString() : null,
    transparent: !!m.transparent || m.opacity < 1,
    doubleSided: m.side === THREE.DoubleSide,
    maps,
  };
}

export function describeHit(hit) {
  const mesh = hit.object;
  const node = pickObjectNode(mesh);

  const box = new THREE.Box3().setFromObject(node);
  const size = box.getSize(new THREE.Vector3());

  let triangles = 0;
  const mats = new Set();
  node.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && mats.add(m));
  });

  return {
    key: node.uuid,
    name: node.name || mesh.name || '(sin nombre)',
    file: mesh.userData.sourceFile ?? 'desconocido',
    room: mesh.userData.roomId ?? null,
    size,
    box,
    distance: hit.distance,
    triangles: Math.round(triangles),
    collision: mesh.userData.collision ?? null,
    materials: [...mats].map(describeMaterial),
  };
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text; // textContent: los nombres vienen de archivos externos
  return e;
}

export function createInspector({ scene, camera, getRoot }) {
  const panel = document.getElementById('inspector');
  const crosshair = document.getElementById('crosshair');
  const toggleBtn = document.getElementById('inspectToggle');

  const raycaster = new THREE.Raycaster();
  raycaster.far = 300;
  const center = new THREE.Vector2(0, 0);

  const highlight = new THREE.Box3Helper(new THREE.Box3(), 0xffd400);
  highlight.visible = false;
  scene.add(highlight);

  let active = true;
  let lastKey = null;
  let distanceEl = null;
  let acc = 0;

  function showEmpty() {
    lastKey = null;
    distanceEl = null;
    highlight.visible = false;
    panel.replaceChildren(el('p', 'insp-empty', 'Apuntá a un objeto con la mira.'));
  }

  function render(info) {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', 'insp-title', info.name));

    const dl = el('dl', 'insp-list');
    const add = (k, v) => {
      dl.append(el('dt', null, k));
      const dd = el('dd', null, v);
      dl.append(dd);
      return dd;
    };
    add('Archivo', info.file);
    if (info.room) add('Sala', info.room);
    add('Tamaño (X·Y·Z)', `${fmt(info.size.x)} × ${fmt(info.size.y)} × ${fmt(info.size.z)} m`);
    distanceEl = add('Distancia', `${fmt(info.distance)} m`);
    add('Triángulos', info.triangles.toLocaleString('es-AR'));
    if (info.collision) add('Colisión', info.collision.solid ? `sí (${info.collision.shape})` : 'no');
    frag.append(dl);

    frag.append(el('h3', 'insp-sub', info.materials.length === 1 ? 'Material' : `Materiales (${info.materials.length})`));
    for (const m of info.materials) {
      const box = el('div', 'insp-mat');
      const head = el('div', 'insp-mat-name', m.name);
      if (m.color) {
        const sw = el('span', 'insp-swatch');
        sw.style.background = m.color;
        head.prepend(sw);
      }
      box.append(head);
      const flags = [m.type];
      if (m.transparent) flags.push('transparente');
      if (m.doubleSided) flags.push('doble cara');
      box.append(el('div', 'insp-flags', flags.join(' · ')));
      if (m.maps.length === 0) {
        box.append(el('div', 'insp-tex', `Sin textura, color sólido ${m.color ?? ''}`.trim()));
      }
      for (const t of m.maps) {
        const dim = t.width ? ` · ${t.width}×${t.height} px` : '';
        box.append(el('div', 'insp-tex', `${t.label}: ${t.name}${dim}`));
      }
      frag.append(box);
    }
    panel.replaceChildren(frag);
  }

  // Un spawn (poste del modo "Spawns", ver spawn-debug.js)
  function renderSpawn(s, distance) {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', 'insp-title', s.name));
    const dl = el('dl', 'insp-list');
    const add = (k, v, cls) => { dl.append(el('dt', null, k)); const dd = el('dd', cls, v); dl.append(dd); return dd; };
    add('Tipo', s.fromJson ? 'Spawn de respaldo (JSON de la escena)' : s.key ? 'Spawn' : 'Spawn base de la escena');
    if (s.object) add('Objeto en Blender', s.object);
    if (s.file) add('Archivo', s.file);
    add('Posición (pies)', s.feet.map((n) => fmt(n)).join(' · '));
    add('Mira hacia', `${Math.round(((THREE.MathUtils.radToDeg(s.yaw) % 360) + 360) % 360)}°`);
    distanceEl = add('Distancia', `${fmt(distance)} m`);
    frag.append(dl);

    frag.append(el('h3', 'insp-sub', 'Para llegar acá'));
    const how = el('div', 'insp-mat');
    how.append(el('div', 'insp-tex', 'Desde esta escena:'));
    how.append(el('div', 'insp-code', `teleport = ${s.key ? s.name : 'spawn'}`));
    how.append(el('div', 'insp-tex', 'Desde otra escena:'));
    how.append(el('div', 'insp-code', `teleport = ${s.scene}:${s.key ? s.name : 'spawn'}`));
    if (s.key && !s.fromJson) how.append(el('div', 'insp-flags', `Al llegar desde "scene_${s.key}" sin pedir spawn, también se usa este.`));
    frag.append(how);

    frag.append(el('h3', 'insp-sub', 'Teleports de esta escena que llegan acá'));
    frag.append(el('div', 'insp-tex', s.teleports.length ? s.teleports.join(', ') : 'Ninguno'));
    panel.replaceChildren(frag);
  }

  function pick() {
    const root = getRoot();
    if (!root) return showEmpty();
    camera.updateMatrixWorld();
    raycaster.setFromCamera(center, camera);
    const hits = raycaster.intersectObjects(root.children, true);
    const hit = hits.find((h) => h.object.isMesh && h.object.visible && h.object.parent?.parent?.visible !== false);
    if (!hit) return showEmpty();

    const spawn = hit.object.userData.spawnMarker;
    if (spawn) {
      const key = `spawn:${spawn.name}`;
      if (key !== lastKey) { lastKey = key; renderSpawn(spawn, hit.distance); }
      else if (distanceEl) distanceEl.textContent = `${fmt(hit.distance)} m`;
      highlight.box.setFromObject(hit.object);
      highlight.visible = true;
      return;
    }

    const info = describeHit(hit);
    if (info.key !== lastKey) {
      lastKey = info.key;
      render(info);
    } else if (distanceEl) {
      distanceEl.textContent = `${fmt(info.distance)} m`;
    }
    highlight.box.copy(info.box);
    highlight.visible = true;
  }

  function setActive(on) {
    active = on;
    crosshair.hidden = !on;
    panel.hidden = !on;
    toggleBtn.setAttribute('aria-pressed', String(on));
    toggleBtn.textContent = on ? 'Inspector: activado (I)' : 'Inspector: apagado (I)';
    if (on) showEmpty();
    else highlight.visible = false;
  }

  toggleBtn.addEventListener('click', () => setActive(!active));
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyI' || e.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    setActive(!active);
  });

  setActive(true);

  return {
    // Se llama en cada cuadro; el rayo se lanza unas 12 veces por segundo.
    update(dt) {
      if (!active) return;
      acc += dt;
      if (acc < 0.08) return;
      acc = 0;
      pick();
    },
    setActive,
    get active() { return active; },
  };
}
