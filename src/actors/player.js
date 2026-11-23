// Jugador: personaje en tercera persona con cámara que lo sigue.
//  WASD / flechas = mover (relativo a la cámara) · Shift = correr · arrastrar = girar cámara · rueda = zoom
// El modelo (.glb) y los parámetros se configuran en data/tables/player.json.
// Si el .glb todavía no existe se muestra una cápsula con una "nariz" que indica hacia dónde mira.
import * as THREE from 'three';
import { loadGLB } from '../core/assets.js';
import { makeUnlit, setShade } from '../systems/shading.js';

const DEFAULTS = {
  model: 'assets/models/objects/personaje.glb',
  scale: 1,         // escala del modelo
  yawOffset: 0,     // grados; si tu personaje mira para otro lado, corregilo acá (180 lo da vuelta)
  walkSpeed: 3,     // m/s
  runSpeed: 6.5,    // m/s con Shift
  turnSpeed: 12,    // qué rápido gira hacia donde camina
  camera: { distance: 4.5, minDistance: 1.5, maxDistance: 12, height: 1.5, pitch: 0.3 },
  // Animaciones: se buscan por nombre en el .glb (idle, walk, run).
  // fade = segundos de transición. walkAnimSpeed/runAnimSpeed = a qué velocidad (m/s) fue animado el ciclo;
  // con eso la animación se acelera o frena para que los pies no resbalen (0 = no ajustar).
  animation: { fade: 0.2, walkAnimSpeed: 0, runAnimSpeed: 0, clips: {} },
  // Colisiones (ver src/systems/collision.js):
  //  radius = ancho del cuerpo · height = altura · stepHeight = escalón máximo que sube sin saltar
  //  maxSlope = grados; más empinado que esto es pared (se lee al armar la escena) · gravity = m/s² al caer
  collision: { radius: 0.35, height: 1.7, stepHeight: 0.5, maxSlope: 50, gravity: 25 },
};

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
const ALIAS = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD', ShiftRight: 'ShiftLeft' };
const TAU = Math.PI * 2;

export async function createPlayer({ scene, camera, stage, pad, config = {} }) {
  const cfg = { ...DEFAULTS, ...config, camera: { ...DEFAULTS.camera, ...config.camera }, animation: { ...DEFAULTS.animation, ...config.animation }, collision: { ...DEFAULTS.collision, ...config.collision } };

  const root = new THREE.Group(); // posición = pies
  root.name = 'player';
  const pivot = new THREE.Group(); // gira hacia donde camina
  root.add(pivot);
  root.visible = false;
  scene.add(root);

  // Modelo
  let animations = [];
  let loadError = null;
  let animNotice = null;
  let mixer = null;
  const clips = {};      // idle / walk / run -> AnimationAction
  let currentClip = null;
  try {
    const gltf = await loadGLB(cfg.model);
    gltf.scene.scale.setScalar(cfg.scale);
    gltf.scene.rotation.y = THREE.MathUtils.degToRad(cfg.yawOffset);
    pivot.add(gltf.scene);
    animations = gltf.animations;

    // Animaciones por nombre (sin distinguir mayúsculas; acepta sufijos como "walk.001" o "Walk_loop")
    if (animations.length) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      // 1) el nombre que pusiste en player.json > animation.clips (ej. "walk": "gPlayerAnim_link_normal_walk")
      // 2) un clip llamado igual (idle/walk/run), 3) uno que empiece con ese nombre
      const byName = (n) => animations.find((c) => c.name.toLowerCase() === String(n).toLowerCase());
      const pick = (word) => (cfg.animation.clips?.[word] && byName(cfg.animation.clips[word])) || byName(word)
        || animations.find((c) => c.name.toLowerCase().startsWith(word));
      for (const key of ['idle', 'walk', 'run']) {
        const clip = pick(key);
        if (clip) { clips[key] = mixer.clipAction(clip); clips[key].setLoop(THREE.LoopRepeat, Infinity); }
      }
      clips.walk ??= clips.run;
      clips.run ??= clips.walk;
      const missing = ['idle', 'walk', 'run'].filter((k) => !pick(k));
      if (missing.length) {
        // Aviso corto: no listamos los 100+ clips, solo los que parecen de quieto / caminar / correr
        const likely = animations.map((c) => c.name).filter((n) => /idle|wait|stand|walk|run|dash|jog/i.test(n));
        const shown = likely.slice(0, 12);
        animNotice = `Animaciones: faltan ${missing.join(', ')}. El .glb trae ${animations.length} clips`
          + (shown.length ? `; posibles: ${shown.join(', ')}${likely.length > shown.length ? ', …' : ''}` : '')
          + '. Elegí cuál usar en data/tables/player.json > animation.clips.';
        console.info('Clips del personaje:', animations.map((c) => c.name));
      }
    } else {
      animNotice = 'El .glb del personaje no trae animaciones (exportá con Animation > Actions).';
    }
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

  makeUnlit(pivot); // sin luces: se ve la textura tal cual; el tono/brillo lo da la escena

  // Estado
  let active = false;
  let frozen = false;
  let facing = 0;
  const cam = { yaw: 0, pitch: cfg.camera.pitch, dist: cfg.camera.distance };
  let keys = {};
  let world = null;   // mundo de colisión de la escena actual (ver collision.js)
  let fallSpeed = 0;  // m/s hacia abajo
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

  // Altura del suelo bajo el jugador: la superficie sólida más alta que esté a un escalón o menos sobre los pies
  const col = cfg.collision;
  function groundY(x, y, z, reach = col.stepHeight) {
    return world ? world.groundAt(x, z, y + reach) : null;
  }

  // Cambia de animación con una transición suave
  function playClip(name) {
    const next = clips[name] ?? clips.idle;
    if (!next || next === currentClip) return;
    const fade = cfg.animation.fade;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    currentClip?.fadeOut(fade);
    currentClip = next;
    currentName = name;
  }
  let currentName = null;

  const angleLerp = (a, b, t) => {
    let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return a + d * Math.min(t, 1);
  };
  // Hacia dónde mira la cámara con ese yaw -> ángulo de giro del modelo (el frente del modelo es +Z)
  const facingFromYaw = (yaw) => Math.atan2(-Math.sin(yaw), -Math.cos(yaw));

  return {
    animations,
    loadError,
    get animNotice() { return animNotice; },
    get currentClip() { return currentName; },
    get position() { return root.position; },
    get active() { return active; },
    set frozen(v) { frozen = v; if (v) keys = {}; },

    // Ponerlo en un punto (pies) mirando hacia `yaw` (mismo criterio que la cámara)
    place([x, y, z], yaw = 0) {
      root.position.set(x, y, z);
      const g = groundY(x, y, z, 2); // al aparecer se tolera que el punto esté hasta 2 m más abajo del suelo
      if (g !== null) root.position.y = g;
      fallSpeed = 0;
      facing = facingFromYaw(yaw);
      pivot.rotation.y = facing;
      cam.yaw = yaw;
    },
    // El mundo de colisión de la escena actual (lo arma buildCollision en collision.js)
    setWorld(collisionWorld) {
      world = collisionWorld;
      fallSpeed = 0;
    },
    setActive(v) {
      active = v;
      root.visible = v;
      if (v && !currentClip) playClip('idle');
      keys = {};
      dragging = false;
    },
    get yaw() { return cam.yaw; },
    setShade(shade) { setShade(pivot, shade); },

    update(dt) {
      if (!active) return;
      mixer?.update(dt);
      let moving = false;

      // Movimiento relativo a la cámara
      const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      const side = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      if (!frozen && (fwd || side)) {
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
        let dx = -sy * fwd + cy * side;
        let dz = -cy * fwd - sy * side;
        const len = Math.hypot(dx, dz);
        dx /= len; dz /= len;
        const running = !!keys.ShiftLeft;
        const speed = running ? cfg.runSpeed : cfg.walkSpeed;
        moving = true;
        playClip(running ? 'run' : 'walk');
        const animSpeed = running ? cfg.animation.runAnimSpeed : cfg.animation.walkAnimSpeed;
        if (animSpeed > 0 && currentClip) currentClip.setEffectiveTimeScale(speed / animSpeed);
        // En pasos cortos (máx. medio radio) para no atravesar paredes finas a 20 fps
        const dist = speed * dt;
        const steps = Math.max(1, Math.ceil(dist / (col.radius * 0.5)));
        for (let i = 0; i < steps; i++) {
          root.position.x += (dx * dist) / steps;
          root.position.z += (dz * dist) / steps;
          world?.pushOut(root.position, col);
        }
        facing = angleLerp(facing, Math.atan2(dx, dz), cfg.turnSpeed * dt);
        pivot.rotation.y = facing;
      }

      if (!moving) { playClip('idle'); }

      // Suelo: sube escalones y rampas suavemente; si no hay suelo a un escalón de distancia, cae con gravedad.
      // Si no hay suelo en absoluto debajo (fuera del mapa) se queda a esa altura.
      const g = groundY(root.position.x, root.position.y, root.position.z);
      if (g === null) {
        fallSpeed = 0;
      } else if (g >= root.position.y - 0.12) {   // sube, o baja un poquito (rampa / escalón)
        root.position.y += (g - root.position.y) * Math.min(1, dt * 18);
        fallSpeed = 0;
      } else {                                    // vacío: caída libre hasta el suelo
        fallSpeed = Math.min(fallSpeed + col.gravity * dt, 40);
        root.position.y = Math.max(g, root.position.y - fallSpeed * dt);
        if (root.position.y === g) fallSpeed = 0;
      }

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
