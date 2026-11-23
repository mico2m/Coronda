// Jugador: personaje en tercera persona con cámara que lo sigue.
//  WASD / flechas = mover (relativo a la cámara) · Shift = correr · arrastrar = girar cámara · rueda = zoom
// El modelo (.glb) y los parámetros se configuran en data/tables/player.json.
// Si el .glb todavía no existe se muestra una cápsula con una "nariz" que indica hacia dónde mira.
import * as THREE from 'three';
import { loadGLB } from '../core/assets.js';

const DEFAULTS = {
  model: 'assets/models/objects/personaje.glb',
  scale: 1,         // escala del modelo
  yawOffset: 0,     // grados; si tu personaje mira para otro lado, corregilo acá (180 lo da vuelta)
  walkSpeed: 3,     // m/s
  runSpeed: 6.5,    // m/s con Shift
  turnSpeed: 12,    // qué rápido gira hacia donde camina
  camera: { distance: 4.5, minDistance: 1.5, maxDistance: 12, height: 1.5, pitch: 0.3 },
};

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
const ALIAS = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD', ShiftRight: 'ShiftLeft' };
const TAU = Math.PI * 2;

export async function createPlayer({ scene, camera, stage, pad, config = {} }) {
  const cfg = { ...DEFAULTS, ...config, camera: { ...DEFAULTS.camera, ...config.camera } };

  const root = new THREE.Group(); // posición = pies
  root.name = 'player';
  const pivot = new THREE.Group(); // gira hacia donde camina
  root.add(pivot);
  root.visible = false;
  scene.add(root);

  // Modelo
  let animations = [];
  let loadError = null;
  try {
    const gltf = await loadGLB(cfg.model);
    gltf.scene.scale.setScalar(cfg.scale);
    gltf.scene.rotation.y = THREE.MathUtils.degToRad(cfg.yawOffset);
    pivot.add(gltf.scene);
    animations = gltf.animations; // para las animaciones, más adelante
  } catch (err) {
    loadError = `Personaje: ${err.message}. Se muestra un cilindro de reemplazo.`;
    console.error(loadError);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe0a458 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1, 4, 12), mat);
    body.position.y = 0.85;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 12), new THREE.MeshStandardMaterial({ color: 0x2b2b2b }));
    nose.rotation.x = Math.PI / 2; // apunta a +Z (el frente de los modelos glTF)
    nose.position.set(0, 1.3, 0.4);
    pivot.add(body, nose);
  }

  // Estado
  let active = false;
  let frozen = false;
  let facing = 0;
  const cam = { yaw: 0, pitch: cfg.camera.pitch, dist: cfg.camera.distance };
  let keys = {};
  let floor = [];
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const tmp = new THREE.Vector3();
  const target = new THREE.Vector3();

  // Teclado
  window.addEventListener('keydown', (e) => {
    if (!active || !MOVE_KEYS.has(e.code)) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    keys[ALIAS[e.code] ?? e.code] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { delete keys[ALIAS[e.code] ?? e.code]; });
  window.addEventListener('blur', () => { keys = {}; });

  // Botones táctiles
  pad?.querySelectorAll('button').forEach((b) => {
    const k = b.dataset.key;
    b.addEventListener('pointerdown', (e) => { if (active) keys[k] = true; try { b.setPointerCapture(e.pointerId); } catch {} });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => b.addEventListener(ev, () => { delete keys[k]; }));
  });

  // Cámara: arrastrar para girar, rueda para el zoom
  let dragging = false, lx = 0, ly = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (!active) return;
    dragging = true; lx = e.clientX; ly = e.clientY;
    try { stage.setPointerCapture(e.pointerId); } catch {}
  });
  stage.addEventListener('pointermove', (e) => {
    if (!active || !dragging) return;
    cam.yaw -= (e.clientX - lx) * 0.005;
    cam.pitch = THREE.MathUtils.clamp(cam.pitch + (e.clientY - ly) * 0.004, -0.1, 1.3);
    lx = e.clientX; ly = e.clientY;
  });
  const endDrag = () => { dragging = false; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    if (!active) return;
    e.preventDefault();
    cam.dist = THREE.MathUtils.clamp(cam.dist * (e.deltaY < 0 ? 0.9 : 1.1), cfg.camera.minDistance, cfg.camera.maxDistance);
  }, { passive: false });

  // Altura del suelo bajo el jugador (raycast hacia abajo contra el mundo)
  function groundY(x, y, z) {
    if (!floor.length) return null;
    ray.set(tmp.set(x, y + 1.2, z), down); // sube hasta 1,2 m (escalones)
    ray.far = 200;
    const hit = ray.intersectObjects(floor, false)[0];
    return hit ? hit.point.y : null;
  }

  const angleLerp = (a, b, t) => {
    let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return a + d * Math.min(t, 1);
  };
  // Hacia dónde mira la cámara con ese yaw -> ángulo de giro del modelo (el frente del modelo es +Z)
  const facingFromYaw = (yaw) => Math.atan2(-Math.sin(yaw), -Math.cos(yaw));

  return {
    animations,
    loadError,
    get position() { return root.position; },
    get active() { return active; },
    set frozen(v) { frozen = v; if (v) keys = {}; },

    // Ponerlo en un punto (pies) mirando hacia `yaw` (mismo criterio que la cámara)
    place([x, y, z], yaw = 0) {
      root.position.set(x, y, z);
      const g = groundY(x, y, z);
      if (g !== null) root.position.y = g;
      facing = facingFromYaw(yaw);
      pivot.rotation.y = facing;
      cam.yaw = yaw;
    },
    // Las superficies sobre las que camina: las mallas de la escena actual
    setWorld(worldRoot) {
      floor = [];
      worldRoot?.traverse((o) => { if (o.isMesh) floor.push(o); });
    },
    setActive(v) {
      active = v;
      root.visible = v;
      keys = {};
      dragging = false;
    },
    get yaw() { return cam.yaw; },

    update(dt) {
      if (!active) return;

      // Movimiento relativo a la cámara
      const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      const side = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      if (!frozen && (fwd || side)) {
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
        let dx = -sy * fwd + cy * side;
        let dz = -cy * fwd - sy * side;
        const len = Math.hypot(dx, dz);
        dx /= len; dz /= len;
        const speed = keys.ShiftLeft ? cfg.runSpeed : cfg.walkSpeed;
        root.position.x += dx * speed * dt;
        root.position.z += dz * speed * dt;
        facing = angleLerp(facing, Math.atan2(dx, dz), cfg.turnSpeed * dt);
        pivot.rotation.y = facing;
      }

      // Pegado al suelo (suave)
      const g = groundY(root.position.x, root.position.y, root.position.z);
      if (g !== null) root.position.y += (g - root.position.y) * Math.min(1, dt * 18);

      // Cámara detrás del jugador
      target.copy(root.position).y += cfg.camera.height;
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      camera.position.set(
        target.x + Math.sin(cam.yaw) * cp * cam.dist,
        target.y + sp * cam.dist,
        target.z + Math.cos(cam.yaw) * cp * cam.dist
      );
      camera.lookAt(target);
    },
  };
}
