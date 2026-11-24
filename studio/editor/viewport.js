// Visor de edición: dibuja las entidades como en el juego (mismo sombreado), con gizmos y ayudas visuales.
// Navegación (como Unity / Unreal):
//   clic derecho + arrastrar = mirar · clic derecho + WASD / Q E = volar (Shift = rápido, rueda = velocidad)
//   rueda = acercar · ruedita apretada = desplazar · Alt + clic izquierdo = orbitar · F = enfocar la selección
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { loadGLB } from '/src/core/assets.js';
import { applyTransform, instantiateModel, DEG } from '/src/systems/entities.js';
import { makeUnlit, setShade } from '/src/systems/shading.js';
import { kindOf, KIND, isSky } from './components.js';

const objectUrl = (v) => { const s = String(v ?? '').trim(); return /[/\\]|\.glb$/i.test(s) ? s : `assets/models/objects/${s}.glb`; };
const npcUrl = (e) => {
  const v = String(e.props?.npc_modelo ?? '').trim();
  if (v) return /[/\\]/.test(v) ? v : `assets/models/objects/${v.replace(/\.glb$/i, '')}.glb`;
  const id = /^npc_(.+?)(?:\.\d+)?$/i.exec(e.name ?? '')?.[1];
  return id ? `assets/models/objects/${id}.glb` : null;
};
const r4 = (v) => Math.round(v * 1e4) / 1e4;

export function createViewport(el, hooks = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dfe6ee');
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 5000);
  const root = new THREE.Group(); root.name = 'entidades';
  scene.add(root);
  // salas .glb de escenas que todavía no se convirtieron: se ven, pero no se pueden elegir ni mover
  const roomsGroup = new THREE.Group(); roomsGroup.name = 'salas';
  scene.add(roomsGroup);
  let roomsKey = '';

  // Grilla: fina cada 1 m, marcada cada 10 m, ejes X (rojo) y Z (azul)
  const fine = new THREE.GridHelper(400, 400, 0xc9d1db, 0xd6dce4);
  const major = new THREE.GridHelper(400, 40, 0xb3bdc9, 0xb3bdc9);
  for (const g of [fine, major]) { g.material.transparent = true; g.material.opacity = g === fine ? 0.55 : 0.8; g.material.depthWrite = false; g.renderOrder = -2; }
  const axes = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-200, 0, 0), new THREE.Vector3(200, 0, 0), new THREE.Vector3(0, 0, -200), new THREE.Vector3(0, 0, 200)]),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false }));
  axes.geometry.setAttribute('color', new THREE.Float32BufferAttribute([0.9, 0.3, 0.3, 0.9, 0.3, 0.3, 0.25, 0.4, 0.87, 0.25, 0.4, 0.87], 3));
  const gridGroup = new THREE.Group(); gridGroup.add(fine, major, axes); gridGroup.position.y = 0.001;
  scene.add(gridGroup);

  const selBox = new THREE.Box3Helper(new THREE.Box3(), 0x3d6df2);
  selBox.visible = false; selBox.material.depthTest = false; selBox.renderOrder = 10;
  scene.add(selBox);

  const tc = new TransformControls(camera, canvas);
  tc.setSize(0.85);
  scene.add(tc);
  const pathGroup = new THREE.Group(); // recorrido del NPC elegido (ver showPath)
  pathGroup.userData.helper = true;
  scene.add(pathGroup);

  // ---------- Entidades ----------
  const recs = new Map(); // id -> { obj, e, modelKey, model, helper, helperKey }
  const cache = new Map(); // url -> Promise<gltf>
  let shade = { tint: '#ffffff', brightness: 1 };
  let editorHidden = new Set();
  let selected = null;
  let pending = 0, framedOnce = false;

  const loadModel = (url) => { if (!cache.has(url)) cache.set(url, loadGLB(`/${url.replace(/^\/+/, '')}`)); return cache.get(url); };

  function prepareLook(inst) {
    makeUnlit(inst);
    setShade(inst, shade);
  }

  function previewKey(e) {
    const k = kindOf(e);
    if (e.model) return `${e.model}#${e.node ?? ''}`;
    if (typeof e.props?.objeto === 'string' && e.props.objeto.trim()) return `${objectUrl(e.props.objeto)}#`;
    if (k === 'npc') { const u = npcUrl(e); return u ? `${u}#npc` : null; }
    return null;
  }

  function line(points, color, opacity = 1) {
    const g = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  }
  function pickProxy(geo, y = 0) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
    m.position.y = y; return m;
  }
  function arrow(color, len = 0.7, y = 0.03) { // apunta a -Z (hacia donde mira un spawn / NPC / pos_jugador)
    const g = new THREE.Group();
    g.add(line([[0, y, 0], [0, y, -len]], color));
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 12), new THREE.MeshBasicMaterial({ color }));
    cone.rotation.x = -Math.PI / 2; cone.position.set(0, y, -len);
    g.add(cone);
    return g;
  }
  function volume(color, cylinder) {
    const g = new THREE.Group();
    const geo = cylinder ? new THREE.CylinderGeometry(1, 1, 2, 24) : new THREE.BoxGeometry(2, 2, 2);
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color }));
    g.add(fill, edges);
    return g;
  }

  function makeHelper(e, hasModel, hasChildren) {
    const k = kindOf(e), color = new THREE.Color(KIND[k].color);
    const g = new THREE.Group(); g.userData.helper = true;
    if ((k === 'collider' || k === 'door' || k === 'teleport') && !hasModel && !hasChildren) {
      g.add(volume(color, e.props?.colision_forma === 'cilindro'));
    } else if ((e.props?.colision_forma === 'cilindro' || e.props?.colision_forma === 'caja') && !hasModel && !hasChildren && 'colision' in (e.props ?? {})) {
      g.add(volume(new THREE.Color(KIND.collider.color), e.props.colision_forma === 'cilindro'));
    } else if (k === 'spawn' || k === 'stand') {
      const ring = new THREE.Mesh(new THREE.RingGeometry(k === 'spawn' ? 0.32 : 0.22, k === 'spawn' ? 0.4 : 0.28, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
      g.add(ring, arrow(color, k === 'spawn' ? 0.8 : 0.5));
      if (k === 'spawn') g.add(line([[0, 0, 0], [0, 1.7, 0]], color, 0.5));
      g.add(pickProxy(new THREE.CylinderGeometry(0.45, 0.45, 1.8, 8), 0.9));
    } else if (k === 'npc' && !hasModel) {
      const cap = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CapsuleGeometry(0.35, 1, 4, 10), 30), new THREE.LineBasicMaterial({ color }));
      cap.position.y = 0.85;
      g.add(cap, arrow(color, 0.7), pickProxy(new THREE.CylinderGeometry(0.4, 0.4, 1.8, 8), 0.9));
    } else if (k === 'npc') {
      g.add(arrow(color, 0.7));
    } else if (k === 'route') {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 10), new THREE.MeshBasicMaterial({ color })), line([[0, 0, 0], [0, 0.6, 0]], color, 0.6));
      g.add(pickProxy(new THREE.SphereGeometry(0.35, 8, 6), 0.2));
    } else if (!hasModel && k !== 'sky') {
      g.add(line([[0, 0, 0], [0.5, 0, 0]], 0xe5484d), line([[0, 0, 0], [0, 0.5, 0]], 0x30a46c), line([[0, 0, 0], [0, 0, 0.5]], 0x3e63dd));
      g.add(pickProxy(new THREE.SphereGeometry(0.3, 8, 6)));
    }
    return g;
  }

  function sync(doc) {
    const ents = doc.entities ?? [];
    const env = doc.environment ?? {};
    scene.background.set(env.background ?? '#dfe6ee');
    const nextShade = { tint: env.tint ?? '#ffffff', brightness: env.brightness ?? 1 };
    const shadeChanged = nextShade.tint !== shade.tint || nextShade.brightness !== shade.brightness;
    shade = nextShade;
    const rk = (doc.rooms ?? []).map((r) => r.model).filter(Boolean).join('|');
    if (rk !== roomsKey) {
      roomsKey = rk; roomsGroup.clear();
      for (const url of rk ? rk.split('|') : []) {
        pending++;
        loadModel(url).then((gltf) => {
          if (roomsKey !== rk) return;
          const inst = instantiateModel(gltf, { model: url });
          prepareLook(inst);
          inst.traverse((o) => { if (isSky(o.name)) for (const m of [o.material].flat().filter(Boolean)) { m.side = THREE.DoubleSide; m.depthWrite = false; } });
          roomsGroup.add(inst);
        }).catch(() => {}).finally(() => { pending--; if (!pending && !framedOnce) { framedOnce = true; frameAll(); } });
      }
    } else if (shadeChanged) setShade(roomsGroup, shade);
    const kids = new Map();
    for (const e of ents) if (e.parent) kids.set(e.parent, (kids.get(e.parent) ?? 0) + 1);
    const seen = new Set();
    for (const e of ents) {
      seen.add(e.id);
      let rec = recs.get(e.id);
      if (!rec) {
        const obj = new THREE.Group();
        rec = { obj, e, modelKey: null, model: null, helper: null, helperKey: null };
        recs.set(e.id, rec);
      }
      rec.e = e;
      const nKids = kids.get(e.id) ?? 0;
      const { obj } = rec;
      obj.name = e.name; obj.userData.entityId = e.id;
      if (!(tc.dragging && tc.object === obj)) applyTransform(obj, e);
      obj.visible = !editorHidden.has(e.id);
      // modelo (o vista previa del objeto reutilizable / NPC)
      const key = previewKey(e);
      if (rec.modelKey !== key) {
        if (rec.model) { obj.remove(rec.model); rec.model = null; }
        rec.modelKey = key; rec.modelFailed = false;
        if (key) {
          const [url, node] = key.split('#');
          pending++;
          loadModel(url).then((gltf) => {
            if (rec.modelKey !== key) return;
            const inst = instantiateModel(gltf, { model: url, node: node && node !== 'npc' ? node : undefined });
            if (!inst) { rec.modelFailed = true; return; }
            if (node === 'npc') {
              const s = Number(e.props?.npc_escala) || 1;
              inst.scale.setScalar(s);
              inst.rotation.y = (Number(e.props?.npc_giro) || 0) * DEG;
            }
            prepareLook(inst);
            if (isSky(e.name)) inst.traverse((o) => { for (const m of [o.material].flat().filter(Boolean)) m.side = THREE.DoubleSide; });
            rec.model = inst; obj.add(inst);
            rec.helperKey = null; sync.last && sync(sync.last); // ayuda acorde (con o sin modelo)
          }).catch(() => { rec.modelFailed = true; rec.helperKey = null; sync.last && sync(sync.last); })
            .finally(() => { pending--; if (!pending && !framedOnce) { framedOnce = true; frameAll(); } });
        }
      } else if (shadeChanged && rec.model) setShade(rec.model, shade);
      const hasModel = !!rec.model;
      const hk = `${kindOf(e)}|${e.props?.colision_forma ?? ''}|${'colision' in (e.props ?? {})}|${hasModel}|${nKids > 0}`;
      if (rec.helperKey !== hk) {
        if (rec.helper) obj.remove(rec.helper);
        rec.helper = makeHelper(e, hasModel, nKids > 0); rec.helperKey = hk;
        obj.add(rec.helper);
      }
    }
    for (const e of ents) {
      const rec = recs.get(e.id);
      const parent = recs.get(e.parent)?.obj ?? root;
      if (rec.obj.parent !== parent) parent.add(rec.obj);
    }
    for (const [id, rec] of recs) if (!seen.has(id)) { rec.obj.removeFromParent(); recs.delete(id); }
    if (selected && !recs.has(selected)) select(null);
    sync.last = doc;
    if (!pending && !framedOnce && (ents.length || rk)) { framedOnce = true; frameAll(); }
  }

  // ---------- Selección y gizmo ----------
  function select(id) {
    selected = id;
    const rec = id ? recs.get(id) : null;
    if (rec) tc.attach(rec.obj); else tc.detach();
  }
  let tool = 'translate', space = 'world', snap = false, ctrlSnap = false;
  function applySnap() {
    const on = snap !== ctrlSnap;
    tc.setTranslationSnap(on ? 0.25 : null);
    tc.setRotationSnap(on ? 15 * DEG : null);
    tc.setScaleSnap(on ? 0.1 : null);
  }
  function setTool(t) { tool = t; tc.setMode(t); }
  function setSpace(s) { space = s; tc.setSpace(s); }
  function setSnap(v) { snap = v; applySnap(); }

  const transformOf = (obj) => ({
    position: obj.position.toArray().map(r4),
    rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z].map((v) => Math.round((v / DEG) * 100) / 100),
    scale: obj.scale.toArray().map(r4),
  });
  tc.addEventListener('dragging-changed', (ev) => {
    nav.blocked = ev.value;
    if (!selected) return;
    if (ev.value) hooks.onGizmoStart?.(selected);
    else hooks.onGizmoEnd?.(selected, transformOf(recs.get(selected).obj));
  });
  tc.addEventListener('objectChange', () => { if (selected && tc.dragging) hooks.onGizmoChange?.(selected, transformOf(recs.get(selected).obj)); });

  // ---------- Cámara ----------
  const nav = { yaw: 0, pitch: -0.35, dist: 12, speed: 8, blocked: false, keys: {}, look: false, pan: false, orbit: false };
  const pivot = new THREE.Vector3();
  const fwd = () => new THREE.Vector3(-Math.sin(nav.yaw) * Math.cos(nav.pitch), Math.sin(nav.pitch), -Math.cos(nav.yaw) * Math.cos(nav.pitch));
  function applyCam() {
    camera.rotation.set(nav.pitch, nav.yaw, 0, 'YXZ');
  }
  function placeFromPivot() { camera.position.copy(pivot).addScaledVector(fwd(), -nav.dist); applyCam(); }
  function setView(pos, yaw, pitch = -0.2) {
    nav.yaw = yaw; nav.pitch = pitch; camera.position.set(...pos); applyCam();
    pivot.copy(camera.position).addScaledVector(fwd(), nav.dist);
  }
  setView([0, 6, 14], 0, -0.35);

  function frameBox(box) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    pivot.copy(c);
    nav.dist = Math.max(1.5, size * 0.9 + 1);
    placeFromPivot();
  }
  function focus(id) {
    const rec = recs.get(id ?? selected);
    if (!rec) return;
    frameBox(new THREE.Box3().setFromObject(rec.obj, true));
  }
  function frameAll() {
    const box = new THREE.Box3();
    for (const rec of recs.values()) if (!isSky(rec.e.name) && rec.obj.visible) box.expandByObject(rec.obj, true);
    roomsGroup.traverse((o) => { if (o.isMesh && !isSky(o.name) && !isSky(o.parent?.name)) box.expandByObject(o, true); });
    if (!box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3());
      if (size.length() > 600) { // escena enorme (o un cielo sin nombre): mejor mirar desde el spawn
        const sp = [...recs.values()].find((r) => kindOf(r.e) === 'spawn');
        if (sp) { pivot.setFromMatrixPosition(sp.obj.matrixWorld); nav.dist = 14; placeFromPivot(); return; }
      }
      frameBox(box);
    }
  }

  let downAt = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    if (e.button === 2) { nav.look = true; }
    else if (e.button === 1) { nav.pan = true; e.preventDefault(); }
    else if (e.button === 0 && e.altKey) { nav.orbit = true; }
    else if (e.button === 0) { downAt = { x: e.clientX, y: e.clientY }; return; }
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const dx = e.movementX, dy = e.movementY;
    if (nav.look) {
      nav.yaw -= dx * 0.0035; nav.pitch = THREE.MathUtils.clamp(nav.pitch - dy * 0.0035, -1.55, 1.55);
      applyCam(); pivot.copy(camera.position).addScaledVector(fwd(), nav.dist);
    } else if (nav.orbit) {
      nav.yaw -= dx * 0.006; nav.pitch = THREE.MathUtils.clamp(nav.pitch - dy * 0.006, -1.55, 1.55);
      placeFromPivot();
    } else if (nav.pan) {
      const s = nav.dist * 0.0016;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      const d = right.multiplyScalar(-dx * s).add(up.multiplyScalar(dy * s));
      camera.position.add(d); pivot.add(d);
    }
  });
  const endNav = (e) => {
    if (e.button === 0 && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5 && !tc.dragging && !nav.blocked) pick(e);
    downAt = null;
    nav.look = nav.pan = nav.orbit = false; nav.keys = {};
  };
  canvas.addEventListener('pointerup', endNav);
  canvas.addEventListener('pointercancel', endNav);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (nav.look) { nav.speed = THREE.MathUtils.clamp(nav.speed * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.5, 200); hooks.onSpeed?.(nav.speed); return; }
    const f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    if (nav.dist * f < 0.6 && f < 1) pivot.addScaledVector(fwd(), nav.dist * 0.5); // muy cerca: avanza en vez de frenarse
    nav.dist = THREE.MathUtils.clamp(nav.dist * f, 0.6, 3000);
    placeFromPivot();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control') { ctrlSnap = true; applySnap(); }
    if (nav.look) { nav.keys[e.code] = true; e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') { ctrlSnap = false; applySnap(); }
    delete nav.keys[e.code];
  });
  window.addEventListener('blur', () => { nav.keys = {}; nav.look = nav.pan = nav.orbit = false; ctrlSnap = false; applySnap(); });

  function flyStep(dt) {
    if (!nav.look) return;
    const k = nav.keys;
    const f = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), r = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0), u = (k.KeyE ? 1 : 0) - (k.KeyQ ? 1 : 0);
    if (!f && !r && !u) return;
    const sp = nav.speed * (k.ShiftLeft || k.ShiftRight ? 3 : 1) * dt;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(fwd(), f * sp).addScaledVector(right, r * sp);
    camera.position.y += u * sp;
    pivot.copy(camera.position).addScaledVector(fwd(), nav.dist);
  }

  // ---------- Elegir con el mouse / soltar assets ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function castFrom(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  const visibleChain = (o) => { for (let p = o; p; p = p.parent) if (!p.visible && !p.userData.helper) return false; return true; };
  function entityHits(clientX, clientY) {
    castFrom(clientX, clientY);
    const out = [];
    for (const h of ray.intersectObject(root, true)) {
      if (!visibleChain(h.object)) continue;
      let o = h.object; while (o && !o.userData.entityId) o = o.parent;
      if (!o) continue;
      const rec = recs.get(o.userData.entityId);
      if (!rec || isSky(rec.e.name)) continue;
      out.push({ id: o.userData.entityId, point: h.point, helper: !!h.object.parent?.userData.helper || !!h.object.userData.helper });
    }
    return out;
  }
  function pick(e) {
    const hits = entityHits(e.clientX, e.clientY);
    // un clic sobre lo ya elegido pasa al siguiente objeto que está detrás (como Blender)
    let hit = hits[0];
    if (hit && hit.id === selected) hit = hits.find((h) => h.id !== selected) ?? hit;
    hooks.onPick?.(hit?.id ?? null, e);
  }
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function dropPoint(clientX, clientY) {
    const solid = entityHits(clientX, clientY).find((h) => !h.helper);
    if (solid) return solid.point.toArray().map(r4);
    castFrom(clientX, clientY);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(ground, p)) return p.toArray().map(r4);
    return camera.position.clone().addScaledVector(fwd(), 6).toArray().map(r4);
  }
  // punto frente a la cámara, apoyado en lo que haya (para "agregar" sin arrastrar)
  function centerPoint() {
    const r = canvas.getBoundingClientRect();
    return dropPoint(r.left + r.width / 2, r.top + r.height / 2);
  }

  // ---------- Bucle ----------
  let paused = false, last = performance.now();
  function resize() {
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    renderer.setSize(w, h, false);
    canvas.style.width = '100%'; canvas.style.height = '100%';
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(el);
  resize();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    if (paused) return;
    flyStep(dt);
    const rec = selected && recs.get(selected);
    if (rec) { selBox.box.setFromObject(rec.obj, true); selBox.visible = !selBox.box.isEmpty(); } else selBox.visible = false;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  return {
    sync, select, focus, frameAll, setTool, setSpace, setSnap, dropPoint, centerPoint,
    get tool() { return tool; }, get space() { return space; }, get snap() { return snap; },
    setPaused(v) { paused = v; },
    get flying() { return nav.look; },
    resetFraming() { framedOnce = false; },
    setEditorHidden(set) { editorHidden = set; if (sync.last) sync(sync.last); },
    invalidate(url) { // un .glb cambió (Blender exportó de nuevo): se recarga en todas las entidades que lo usan
      cache.delete(url);
      if (roomsKey.split('|').includes(url)) roomsKey = '__recargar';
      for (const rec of recs.values()) if (rec.modelKey?.startsWith(`${url}#`)) rec.modelKey = '__recargar';
      if (sync.last) sync(sync.last);
    },
    // posición y orientación de la cámara, en el piso (para "Play desde acá")
    cameraPose() {
      const p = camera.position;
      return { x: r4(p.x), y: r4(p.y), z: r4(p.z), yawDeg: Math.round(nav.yaw / DEG) };
    },
    worldTransformOf(id) { const r = recs.get(id); return r ? r.obj.matrixWorld.clone() : null; },
    objectOf(id) { return recs.get(id)?.obj ?? null; },
    // Foto de la escena vista desde arriba (sin cielo ni ayudas), para el mapa de Rutas.
    // Devuelve { url, minX, maxX, minZ, maxZ } (el norte -Z queda arriba) o null si la escena está vacía.
    topView(maxPx = 1000, extra = []) {
      const box = new THREE.Box3();
      for (const rec of recs.values()) if (!isSky(rec.e.name) && rec.obj.visible) box.expandByObject(rec.obj, true);
      roomsGroup.traverse((o) => { if (o.isMesh && !isSky(o.name) && !isSky(o.parent?.name)) box.expandByObject(o, true); });
      for (const p of extra) box.expandByPoint(new THREE.Vector3(p.x, p.y ?? 0, p.z));
      if (box.isEmpty()) return null;
      const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 10);
      const pad = span * 0.05 + 1;
      const minX = box.min.x - pad, maxX = box.max.x + pad, minZ = box.min.z - pad, maxZ = box.max.z + pad;
      const w = maxX - minX, h = maxZ - minZ, k = maxPx / Math.max(w, h);
      const W = Math.max(2, Math.round(w * k)), H = Math.max(2, Math.round(h * k));
      const hidden = [];
      const hide = (o) => { if (o.visible) { o.visible = false; hidden.push(o); } };
      scene.traverse((o) => { if (isSky(o.name)) hide(o); });
      [gridGroup, selBox, tc, pathGroup].forEach(hide);
      const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, (box.max.y - box.min.y) + 400);
      cam.position.set((minX + maxX) / 2, box.max.y + 200, (minZ + maxZ) / 2);
      cam.up.set(0, 0, -1);
      cam.lookAt(cam.position.x, box.min.y, cam.position.z);
      const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
      const bg = scene.background;
      scene.background = new THREE.Color(0xe8ecef);
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      const px = new Uint8Array(W * H * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
      renderer.setRenderTarget(null);
      scene.background = bg;
      rt.dispose();
      hidden.forEach((o) => { o.visible = true; });
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const img = c.getContext('2d').createImageData(W, H);
      // a un render target three.js lo deja en color lineal: se pasa a sRGB (y los píxeles vienen de abajo hacia arriba)
      const lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) { const v = i / 255; lut[i] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)); }
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4, dst = y * W * 4;
        for (let i = 0; i < W * 4; i += 4) { img.data[dst + i] = lut[px[src + i]]; img.data[dst + i + 1] = lut[px[src + i + 1]]; img.data[dst + i + 2] = lut[px[src + i + 2]]; img.data[dst + i + 3] = 255; }
      }
      c.getContext('2d').putImageData(img, 0, 0);
      return { url: c.toDataURL('image/png'), minX, maxX, minZ, maxZ };
    },
    // Vistas fijas (como el teclado numérico de Blender): mira al punto de giro desde arriba, el frente o un costado
    viewPreset(which) {
      const P = { top: [nav.yaw, -1.55], front: [0, -0.02], back: [Math.PI, -0.02], right: [Math.PI / 2, -0.02], left: [-Math.PI / 2, -0.02] }[which];
      if (!P) return;
      [nav.yaw, nav.pitch] = P;
      placeFromPivot();
    },
    // Altura del suelo debajo de una entidad (lo primero que hay abajo que no sea ella misma ni sus hijas), o null
    groundBelow(id) {
      const rec = recs.get(id); if (!rec) return null;
      const from = new THREE.Vector3().setFromMatrixPosition(rec.obj.matrixWorld);
      // base del objeto: la caja de sus mallas (las animadas con huesos no sirven: su caja es la de la pose de reposo)
      const box = new THREE.Box3();
      rec.obj.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh && !o.userData.helper && !o.parent?.userData.helper) box.expandByObject(o, true); });
      const bottom = box.isEmpty() ? from.y : box.min.y;
      // el rayo sale un poco arriba de la base o del origen (así no lo frena un techo o una copa de árbol de arriba)
      const r = new THREE.Raycaster(new THREE.Vector3(from.x, Math.max(from.y, bottom) + 0.6, from.z), new THREE.Vector3(0, -1, 0), 0, 2000);
      const mine = (o) => { for (let p = o; p; p = p.parent) if (p === rec.obj) return true; return false; };
      const targets = [root, roomsGroup];
      for (const h of r.intersectObjects(targets, true)) {
        if (!h.object.isMesh || mine(h.object) || !visibleChain(h.object)) continue;
        if (h.object.userData.helper || h.object.parent?.userData.helper) continue;
        let o = h.object; while (o && !o.userData.entityId) o = o.parent;
        if (o && isSky(recs.get(o.userData.entityId)?.e.name)) continue;
        if (isSky(h.object.name) || isSky(h.object.parent?.name)) continue;
        return { y: h.point.y, offset: from.y - bottom }; // offset: cuánto hay entre el origen y la base del objeto
      }
      return null;
    },
    // Camino de un recorrido (lista de puntos del mundo) dibujado en la escena; [] lo borra
    showPath(pts = []) {
      pathGroup.clear();
      if (pts.length < 2) return;
      const v = pts.map((p) => new THREE.Vector3(p.x, p.y + 0.08, p.z));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineDashedMaterial({ color: 0x7c3aed, dashSize: 0.5, gapSize: 0.25, depthTest: false, transparent: true }));
      line.computeLineDistances(); line.renderOrder = 998;
      pathGroup.add(line);
      const dot = new THREE.SphereGeometry(0.16, 12, 8), mat = new THREE.MeshBasicMaterial({ color: 0x7c3aed, depthTest: false, transparent: true });
      v.forEach((p) => { const m = new THREE.Mesh(dot, mat); m.position.copy(p); m.renderOrder = 999; pathGroup.add(m); });
    },
    root, camera, scene, renderer,
  };
}
