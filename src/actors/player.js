// Jugador: personaje en tercera persona con cámara que lo sigue.
//  WASD = mover (relativo a la cámara) · Shift = correr · arrastrar = girar cámara · rueda = zoom
//  Celular (ver ui/touch-controls.js): joystick analógico (poco = caminar despacio, al borde = correr) ·
//  un dedo en la pantalla = girar la cámara · dos dedos = zoom · doble toque o botón 🎥 = centrar la cámara
//  Cámara como en Ocarina: te sigue de atrás sola mientras caminás · Z = centrarla detrás del personaje ·
//  flechas = mirar alrededor desde la cabeza (un rango corto); al soltarlas vuelve despacio a donde estaba.
//  Ajustes en data/tables/player.json > camera: follow, lookYaw, lookPitch, lookSpeed, lookReturn, recenterTime.
// El modelo (.glb) y los parámetros se configuran en data/tables/player.json.
// Si el .glb todavía no existe se muestra una cápsula con una "nariz" que indica hacia dónde mira.
//
// ACCIONES INTERACTIVAS (acostarse, saludar, sentarse…): no hace falta tocar el código.
// En Blender nombrá la acción `accion_<nombre>` (ej. accion_acostarse) y exportá el .glb: el juego la
// detecta sola, crea un botón en pantalla y le asigna una tecla (1, 2, 3… en orden alfabético).
//   accion_acostarse          se reproduce una vez y se queda en la última pose hasta que te movés
//   accion_acostarse_quieto   igual que el anterior (es el comportamiento por defecto, solo más explícito)
//   accion_saludar_vuelve     se reproduce una vez y vuelve solo a quieto
//   accion_bailar_loop        se repite hasta que te movés
// Opcional, en player.json > actions: { "acostarse": { "key": "KeyL", "label": "Acostarse" } }
// (también "loop": true/false y "hold": true/false para pisar lo que dice el nombre).
// Para usar un clip que ya existe sin renombrarlo: { "caer": { "clip": "nombre_exacto_del_clip", "label": "Caerse" } }.
// Para que una acción NO tenga botón ni tecla: { "saludar": { "hidden": true } }.
//
// ABRIR PUERTAS: un clip llamado abrirpuerta / abrir_puerta (o accion_abrirpuerta) se usa solo al apretar E en una
// puerta (ver systems/doors.js > puerta_anim): Link mira a la puerta, hace la animación y después viene el fundido.
// Ese clip no aparece como botón de acción.
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
  camera: {
    distance: 4.5, minDistance: 1.5, maxDistance: 12, height: 1.5, pitch: 0.3,
    follow: 1.6,        // qué tan rápido se acomoda detrás tuyo al caminar (0 = no sigue)
    lookYaw: 45,        // flechas: cuánto se puede mirar a los costados (grados)
    lookPitch: 25,      // flechas: cuánto arriba/abajo (grados)
    lookSpeed: 120,     // flechas: grados por segundo
    lookReturn: 2.5,    // al soltar, qué tan rápido vuelve (más alto = más rápido)
    recenterTime: 0.25, // Z: segundos que tarda en ponerse detrás
  },
  // Animaciones: se buscan por nombre en el .glb (idle, walk, run).
  // fade = segundos de transición. walkAnimSpeed/runAnimSpeed = a qué velocidad (m/s) fue animado el ciclo;
  // con eso la animación se acelera o frena para que los pies no resbalen (0 = no ajustar).
  animation: { fade: 0.2, walkAnimSpeed: 0, runAnimSpeed: 0, clips: {} },
  // Colisiones (ver src/systems/collision.js):
  //  radius = ancho del cuerpo · height = altura · stepHeight = escalón máximo que sube sin saltar
  //  maxSlope = grados; más empinado que esto es pared (se lee al armar la escena) · gravity = m/s² al caer
  collision: { radius: 0.35, height: 1.7, stepHeight: 0.5, maxSlope: 50, gravity: 25 },
  // Ajustes de acciones (ver arriba); por nombre de acción: { key, label, loop, hold }. Todo es opcional.
  actions: {},
};

const ACTION_RE = /^(?:accion|action)_(.+)$/i;
// Clip por defecto para abrir puertas (con o sin accion_, con o sin guion bajo, sufijos .001 incluidos)
const DOOR_CLIP_RE = /^(?:(?:accion|action)_)?abrir_?puerta(?:[._]\d+)?$/i;
// "accion_saludar_vuelve.001" -> { id: "saludar", mode: "vuelve" }
function parseActionName(clipName) {
  const m = ACTION_RE.exec(String(clipName).replace(/\.\d+$/, ''));
  if (!m) return null;
  let id = m[1], mode = 'hold';
  const s = /_(loop|vuelve|quieto)$/i.exec(id);
  if (s) { mode = s[1].toLowerCase() === 'quieto' ? 'hold' : s[1].toLowerCase(); id = id.slice(0, -s[0].length); }
  return id ? { id, mode } : null;
}
const humanize = (id) => { const t = id.replace(/_+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const ALIAS = { ShiftRight: 'ShiftLeft' }; // las flechas no mueven: miran (ver la cámara)
const TAU = Math.PI * 2;
const INTERACT = 'interactuar'; // clave de la animación de puertas en `clips`

export async function createPlayer({ scene, camera, stage, pad, touch = null, config = {} }) {
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
  const clips = {};      // idle / walk / run -> AnimationAction (y "accion:<id>" para las acciones)
  const actions = [];    // acciones interactivas detectadas: { id, label, key, hold }
  let doing = null;      // id de la acción en curso
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
      // Sin nada que se llame idle (ej. un NPC con un solo clip "Armature.001Action"): el primero
      if (!clips.idle) { clips.idle = mixer.clipAction(animations[0]); clips.idle.setLoop(THREE.LoopRepeat, Infinity); }

      // Acciones interactivas: todo clip llamado accion_<nombre> (ver el comentario de arriba)
      const found = animations.map((c) => ({ clip: c, ...parseActionName(c.name) })).filter((a) => a.id);
      // También se pueden enlazar clips que ya existen sin renombrarlos, desde player.json:
      //   "actions": { "caer": { "clip": "gPlayerAnim_link_normal_back_downA", "label": "Caerse" } }
      for (const [id, o] of Object.entries(cfg.actions ?? {})) {
        const clip = o?.clip && byName(o.clip);
        if (clip && !found.some((f) => f.id === id)) found.push({ clip, id, mode: 'hold' });
        else if (o?.clip && !clip) console.warn(`Acción "${id}": no hay un clip llamado "${o.clip}" en el .glb`);
      }
      found.sort((a, b) => a.id.localeCompare(b.id));
      let shown = 0;
      found.forEach(({ clip, id, mode }) => {
        const o = cfg.actions?.[id] ?? {};
        const loop = o.loop ?? mode === 'loop';
        const act = mixer.clipAction(clip);
        act.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        act.clampWhenFinished = true; // se queda en la última pose
        clips[`accion:${id}`] = act;
        // sin botón: las marcadas "hidden" en player.json y la de abrir puertas (la usa doors.js)
        if (o.hidden ?? DOOR_CLIP_RE.test(clip.name)) return;
        const i = shown++;
        actions.push({ id, label: o.label ?? humanize(id), key: o.key ?? (i < 9 ? `Digit${i + 1}` : null), hold: o.hold ?? mode !== 'vuelve' });
      });
      mixer.addEventListener('finished', (e) => {
        const cur = actions.find((a) => a.id === doing);
        if (cur && e.action === clips[`accion:${cur.id}`] && !cur.hold) doing = null; // vuelve a quieto solo
      });
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
  const look = { yaw: 0, pitch: 0 };   // flechas: desvío de la mirada (radianes), vuelve solo a 0
  let recenter = null;                 // Z: { from, to, pitchFrom, t }
  let preset = null;                   // cámara fija por un rato (ej. adentro de una casa): { distance, pitch, locked }
  let keys = {};
  let world = null;   // mundo de colisión de la escena actual (ver collision.js)
  let fallSpeed = 0;  // m/s hacia abajo
  let lastSafe = null; // último punto con suelo (si se cae del mapa, vuelve ahí)
  let obstacles = []; // círculos { x, z, r } que no se atraviesan (NPC)
  const target = new THREE.Vector3();

  // Teclado
  window.addEventListener('keydown', (e) => {
    if (!active || !MOVE_KEYS.has(e.code)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable) return; // escribiendo: las letras no mueven
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    keys[ALIAS[e.code] ?? e.code] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { delete keys[ALIAS[e.code] ?? e.code]; });
  window.addEventListener('blur', () => { keys = {}; });

  // Botones táctiles
  pad?.querySelectorAll('button[data-key]').forEach((b) => {
    const k = b.dataset.key;
    b.addEventListener('pointerdown', (e) => { if (active) keys[k] = true; try { b.setPointerCapture(e.pointerId); } catch {} });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => b.addEventListener(ev, () => { delete keys[k]; }));
  });

  // Acciones: botones en pantalla (se arman solos) y teclas
  const actionPanel = document.createElement('div');
  actionPanel.className = 'actions';
  actionPanel.hidden = true;
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    if (a.key) {
      const k = document.createElement('kbd');
      k.textContent = a.key.replace(/^(?:Digit|Key)/, '');
      b.append(k, ' ');
    }
    b.append(a.label); // textContent-style: el nombre viene de un archivo externo
    b.addEventListener('click', () => { triggerAction(a.id); b.blur(); });
    actionPanel.append(b);
  }
  stage.parentElement.appendChild(actionPanel);

  function triggerAction(id) {
    if (!active || frozen || !clips[`accion:${id}`]) return;
    keys = {};
    doing = id;
    playClip(`accion:${id}`);
  }
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === 'KeyZ' && active && !frozen) { centerCamera(); return; }
    const a = actions.find((x) => x.key === e.code);
    if (a) triggerAction(a.id);
  });

  // Z: la cámara se pone detrás del personaje (a la altura de siempre), en un ratito
  function centerCamera() {
    const to = facing - Math.PI; // yaw de la cámara que queda detrás de hacia donde mira
    recenter = { from: cam.yaw, to: cam.yaw + angleDiff(cam.yaw, to), pitchFrom: cam.pitch, t: 0 };
  }

  // Cámara: arrastrar para girar (mouse o un dedo), dos dedos = zoom, doble toque = centrar; rueda = zoom
  const pointers = new Map(); // dedos / mouse sobre la escena: id -> { x, y, sx, sy, t, touch }
  let pinch = null;           // { d: distancia inicial entre los dedos, dist: zoom de ese momento }
  let lastTap = null;         // { t, x, y } del último toque corto (para el doble toque)
  const pair = () => { const [a, b] = pointers.values(); return Math.hypot(a.x - b.x, a.y - b.y); };
  stage.addEventListener('pointerdown', (e) => {
    if (!active) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), touch: e.pointerType === 'touch' });
    try { stage.setPointerCapture(e.pointerId); } catch {}
    if (pointers.size === 2) pinch = { d: Math.max(1, pair()), dist: cam.dist };
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!active || !p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size >= 2) { // dos dedos: zoom (pellizcar), sin girar
      if (pinch && !preset?.locked) {
        cam.dist = THREE.MathUtils.clamp(pinch.dist * (pinch.d / Math.max(1, pair())), cfg.camera.minDistance, cfg.camera.maxDistance);
      }
      return;
    }
    recenter = null;
    // En pantalla táctil el dedo recorre menos que el mouse: más sensible
    cam.yaw -= dx * (p.touch ? 0.009 : 0.005);
    cam.pitch = THREE.MathUtils.clamp(cam.pitch + dy * (p.touch ? 0.007 : 0.004), -0.1, 1.3);
  });
  const endDrag = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    // Toque corto sin arrastrar: si es el segundo seguido en el mismo lugar, centra la cámara
    if (p.touch && e.type === 'pointerup' && performance.now() - p.t < 250 && Math.hypot(p.x - p.sx, p.y - p.sy) < 12) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) { lastTap = null; if (!frozen) centerCamera(); }
      else lastTap = { t: now, x: p.x, y: p.y };
    }
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    if (!active) return;
    e.preventDefault();
    if (preset?.locked) return; // la distancia está fija (ej. adentro de una casa)
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
  const angleDiff = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const facingFromYaw = (yaw) => Math.atan2(-Math.sin(yaw), -Math.cos(yaw));

  // Se desliza (rápido, ~0,25 s) hasta un punto { x, y, z, yaw } girando hacia yaw. Mientras, camina en el lugar.
  function slideTo(at) {
    const sx = root.position.x, sy = root.position.y, sz = root.position.z, f0 = facing;
    const f1 = facingFromYaw(at.yaw ?? 0);
    const dist = Math.hypot(at.x - sx, at.z - sz);
    const dur = Math.min(0.5, 0.12 + dist / 4);
    keys = {};
    doing = INTERACT; // que el update no lo pase a quieto mientras se acomoda
    if (dist > 0.05) playClip('walk');
    return new Promise((res) => {
      const t0 = performance.now();
      (function step() {
        const t = Math.min(1, (performance.now() - t0) / 1000 / dur), e = t * (2 - t);
        root.position.set(sx + (at.x - sx) * e, sy + ((at.y ?? sy) - sy) * e, sz + (at.z - sz) * e);
        facing = angleLerp(f0, f1, e); pivot.rotation.y = facing;
        if (t < 1) requestAnimationFrame(step); else { facing = f1; pivot.rotation.y = f1; res(); }
      })();
    });
  }

  return {
    animations,
    loadError,
    get animNotice() { return animNotice; },
    get currentClip() { return currentName; },
    // Cámara fija (ej. adentro de una casa: lejos y desde arriba, sin zoom). null = la de siempre
    setCameraPreset(p) {
      if (!p && !preset) return; // ya estaba la de siempre: no se toca el zoom que eligió el jugador
      preset = p ?? null;
      cam.dist = preset?.distance ?? cfg.camera.distance;
      cam.pitch = preset?.pitch ?? cfg.camera.pitch;
    },
    get maxDistance() { return cfg.camera.maxDistance; },
    get minDistance() { return cfg.camera.minDistance; },
    // Nombre real del clip que se está viendo y hacia dónde mira (para el multijugador)
    get clipName() { return currentClip?.getClip?.().name ?? null; },
    get facing() { return facing; },
    get actions() { return actions; },
    triggerAction,
    get position() { return root.position; },
    get active() { return active; },
    set frozen(v) { frozen = v; if (v) keys = {}; },

    // Ponerlo en un punto (pies) mirando hacia `yaw` (mismo criterio que la cámara)
    place([x, y, z], yaw = 0) {
      if (doing === INTERACT) { doing = null; playClip('idle'); } // llegó al destino de una puerta: vuelve a quieto
      root.position.set(x, y, z);
      const g = groundY(x, y, z, 2); // al aparecer se tolera que el punto esté hasta 2 m más abajo del suelo
      if (g !== null) root.position.y = g;
      fallSpeed = 0;
      facing = facingFromYaw(yaw);
      pivot.rotation.y = facing;
      cam.yaw = yaw;
      look.yaw = look.pitch = 0;
      recenter = null;
    },
    // Animación de interactuar (abrir una puerta…): mira hacia `face` ({x,z}), reproduce el clip una vez y
    // espera a que termine (o `wait` segundos). Se queda en la última pose hasta que se mueva o se lo ubique de nuevo.
    //   name: nombre del clip (con o sin accion_); undefined = el de abrir puertas (abrirpuerta / abrir_puerta)
    // Devuelve false si no hay clip (no hace nada).
    // at: { x, y, z, yaw } -> antes de animar se desliza hasta ese punto (pies) mirando hacia `yaw` (como los spawns)
    async interact(name, { face = null, wait = null, at = null } = {}) {
      if (!active) return false;
      if (at) await slideTo(at);
      if (!mixer) return false;
      const want = name === undefined ? null : String(name).trim();
      const clip = want
        ? animations.find((c) => c.name.toLowerCase() === want.toLowerCase())
          ?? animations.find((c) => c.name.toLowerCase() === `accion_${want.toLowerCase()}`)
          ?? animations.find((c) => c.name.toLowerCase().startsWith(want.toLowerCase()))
        : animations.find((c) => DOOR_CLIP_RE.test(c.name));
      if (!clip) {
        if (want) console.warn(`Puerta: el personaje no tiene un clip "${want}". Clips: ${animations.map((c) => c.name).join(', ')}`);
        return false;
      }
      if (face) {
        const dx = face.x - root.position.x, dz = face.z - root.position.z;
        if (Math.hypot(dx, dz) > 0.05) { facing = Math.atan2(dx, dz); pivot.rotation.y = facing; }
      }
      keys = {};
      const act = mixer.clipAction(clip);
      act.setLoop(THREE.LoopOnce, 1);
      act.clampWhenFinished = true;
      act.setEffectiveTimeScale(1);
      clips[INTERACT] = act;
      currentClip = currentClip === act ? null : currentClip; // fuerza a reiniciarlo si ya era el actual
      doing = INTERACT;
      playClip(INTERACT);
      const secs = Number.isFinite(Number(wait)) && wait !== null && wait !== '' ? Math.max(0, Number(wait)) : clip.duration;
      await new Promise((res) => {
        const t = setTimeout(done, (secs + 0.5) * 1000); // por si el evento no llega
        function done() { clearTimeout(t); mixer.removeEventListener('finished', onFin); res(); }
        function onFin(e) { if (e.action === act && wait == null) done(); }
        mixer.addEventListener('finished', onFin);
        if (wait != null) { clearTimeout(t); setTimeout(done, secs * 1000); }
      });
      return true;
    },
    // Se acomoda en un punto { x, y, z, yaw } (pies) antes de interactuar, ej. el pos_jugador de una puerta
    alignTo(at) { return active && at ? slideTo(at) : Promise.resolve(); },
    // Termina la animación de interactuar (ej. la puerta no llevaba a ningún lado) y vuelve a quieto
    endInteract() { if (doing === INTERACT) { doing = null; playClip('idle'); } },
    // NPC u otros obstáculos redondos: lista de { x, z, r } (se lee en cada cuadro, puede cambiar)
    setObstacles(list) { obstacles = list ?? []; },
    // El mundo de colisión de la escena actual (lo arma buildCollision en collision.js)
    setWorld(collisionWorld) {
      world = collisionWorld;
      fallSpeed = 0;
      lastSafe = null;
    },
    setActive(v) {
      active = v;
      root.visible = v;
      actionPanel.hidden = !v || !actions.length;
      if (v && !currentClip) playClip('idle');
      keys = {};
      pointers.clear();
      pinch = null;
    },
    // Cámara detrás del personaje (tecla Z / botón 🎥 del celular)
    recenterCamera() { if (active && !frozen) centerCamera(); },
    get yaw() { return cam.yaw; },
    setShade(shade) { setShade(pivot, shade); },

    update(dt) {
      if (!active) return;
      mixer?.update(dt);
      let moving = false;

      // Movimiento relativo a la cámara: teclado, o el joystick del celular si no hay teclas apretadas
      let fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      let side = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      const stick = touch?.move;
      const analog = !fwd && !side && stick?.mag > 0 ? stick.mag : 0; // 0 = teclado
      if (analog) { fwd = stick.y; side = stick.x; }
      if (doing && !frozen && (fwd || side)) doing = null; // moverse cancela la acción (te levantás)
      if (!frozen && !doing && (fwd || side)) {
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
        let dx = -sy * fwd + cy * side;
        let dz = -cy * fwd - sy * side;
        const len = Math.hypot(dx, dz);
        dx /= len; dz /= len;
        const running = analog ? stick.run : !!keys.ShiftLeft;
        let speed = running ? cfg.runSpeed : cfg.walkSpeed;
        // Joystick inclinado de a poco: camina más despacio (como en Ocarina), nunca menos de un tercio
        if (analog && !running) speed *= THREE.MathUtils.clamp(analog / 0.85, 0.35, 1);
        moving = true;
        playClip(running ? 'run' : 'walk');
        // La animación acompaña la velocidad para que los pies no resbalen
        const animSpeed = running ? cfg.animation.runAnimSpeed : cfg.animation.walkAnimSpeed;
        currentClip?.setEffectiveTimeScale(animSpeed > 0 ? speed / animSpeed : running ? 1 : speed / cfg.walkSpeed);
        // En pasos cortos (máx. medio radio) para no atravesar paredes finas a 20 fps
        const dist = speed * dt;
        const steps = Math.max(1, Math.ceil(dist / (col.radius * 0.5)));
        for (let i = 0; i < steps; i++) {
          root.position.x += (dx * dist) / steps;
          root.position.z += (dz * dist) / steps;
          for (const o of obstacles) { // NPC: círculo en el piso (las paredes tienen la última palabra)
            const ox = root.position.x - o.x, oz = root.position.z - o.z, min = o.r + col.radius;
            const d2 = ox * ox + oz * oz;
            if (d2 >= min * min) continue;
            const d = Math.sqrt(d2);
            const nx = d > 1e-4 ? ox / d : 1, nz = d > 1e-4 ? oz / d : 0;
            root.position.x = o.x + nx * min;
            root.position.z = o.z + nz * min;
          }
          world?.pushOut(root.position, col);
        }
        facing = angleLerp(facing, Math.atan2(dx, dz), cfg.turnSpeed * dt);
        pivot.rotation.y = facing;
      }

      if (!moving && !doing) { playClip('idle'); }

      // Suelo: sube escalones y rampas suavemente; si no hay suelo a un escalón de distancia, cae con gravedad.
      // Si no hay suelo en absoluto debajo (fuera del mapa) se queda a esa altura.
      const g = groundY(root.position.x, root.position.y, root.position.z);
      if (g === null) {
        if (world?.hasGround && lastSafe) {      // fuera del mapa (la escena sí tiene suelo): cae, y si se va muy abajo vuelve al último lugar seguro
          fallSpeed = Math.min(fallSpeed + col.gravity * dt, 40);
          root.position.y -= fallSpeed * dt;
          if (root.position.y < lastSafe[1] - 15) { root.position.set(lastSafe[0], lastSafe[1] + 0.1, lastSafe[2]); fallSpeed = 0; }
        } else fallSpeed = 0;                    // escena sin suelo sólido: se queda a esa altura
      } else if (g >= root.position.y - 0.12) {   // sube, o baja un poquito (rampa / escalón)
        root.position.y += (g - root.position.y) * Math.min(1, dt * 18);
        fallSpeed = 0;
        if (Math.abs(g - root.position.y) < 0.3) (lastSafe ??= [0, 0, 0]), (lastSafe[0] = root.position.x, lastSafe[1] = root.position.y, lastSafe[2] = root.position.z);
      } else {                                    // vacío: caída libre hasta el suelo
        fallSpeed = Math.min(fallSpeed + col.gravity * dt, 40);
        root.position.y = Math.max(g, root.position.y - fallSpeed * dt);
        if (root.position.y === g) fallSpeed = 0;
      }

      // Cámara detrás del jugador (como en Ocarina)
      const cc = cfg.camera;
      if (recenter) { // Z: se acomoda detrás, con aceleración suave
        recenter.t = Math.min(1, recenter.t + dt / Math.max(0.01, cc.recenterTime));
        const k = recenter.t * recenter.t * (3 - 2 * recenter.t);
        cam.yaw = recenter.from + (recenter.to - recenter.from) * k;
        cam.pitch = recenter.pitchFrom + ((preset?.pitch ?? cc.pitch) - recenter.pitchFrom) * k;
        if (recenter.t >= 1) recenter = null;
      } else if (moving && cc.follow > 0 && !pointers.size) {
        // Caminando te sigue de atrás de a poco; si venís hacia la cámara no da la vuelta
        const d = angleDiff(cam.yaw, facing - Math.PI);
        if (Math.abs(d) < 2.2) cam.yaw += d * Math.min(1, cc.follow * dt * Math.min(1, Math.abs(d) * 1.5));
      }
      // Flechas: mirar alrededor desde la cabeza, un rango corto; al soltar vuelve despacio
      const lx = (keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0);
      const ly = (keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0);
      const lim = THREE.MathUtils.degToRad;
      const spd = lim(cc.lookSpeed) * dt, back = Math.min(1, cc.lookReturn * dt);
      if (lx && !frozen) look.yaw = THREE.MathUtils.clamp(look.yaw + lx * spd, -lim(cc.lookYaw), lim(cc.lookYaw));
      else look.yaw -= look.yaw * back;
      if (ly && !frozen) look.pitch = THREE.MathUtils.clamp(look.pitch + ly * spd, -lim(cc.lookPitch), lim(cc.lookPitch));
      else look.pitch -= look.pitch * back;

      target.copy(root.position).y += cc.height;
      // La cámara gira alrededor de la cabeza: hacia arriba con la flecha arriba (mira hacia arriba, baja la cámara)
      const yaw = cam.yaw + look.yaw;
      const pitch = THREE.MathUtils.clamp(cam.pitch - look.pitch, -0.25, 1.4);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      camera.position.set(
        target.x + Math.sin(yaw) * cp * cam.dist,
        target.y + sp * cam.dist,
        target.z + Math.cos(yaw) * cp * cam.dist
      );
      camera.lookAt(target);
    },
  };
}
