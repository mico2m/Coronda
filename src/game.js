// Motor del juego, compartido por index.html (versión final) y dev.html (modo desarrollador).
// En modo dev se carga además el inspector; la versión final no descarga ese código.
import * as THREE from 'three';
import { loadJSON } from './core/assets.js';
import { createCameraControls } from './systems/camera.js';
import { createAudio } from './systems/audio.js';
import { createSceneManager } from './systems/scene-manager.js';
import { createUI } from './ui/ui.js';
import { createFade } from './systems/fade.js';
import { createDoors } from './systems/doors.js';
import { createPlayer } from './actors/player.js';
import { buildCollision } from './systems/collision.js';
import { createNpcs } from './actors/npc.js';
import { createDialogue } from './systems/dialogue.js';
import { createTextbox } from './ui/textbox.js';
import { isSkyName } from './systems/shading.js';

const _focus = new THREE.Vector3();

// retro: { width, height, fps, antialias } -> se dibuja a esa resolución fija y se escala a toda la pantalla,
// con un máximo de fps cuadros por segundo (estilo consola vieja). null = resolución y fps completos.
export async function startGame({ dev = false, retro = null } = {}) {
  const stage = document.getElementById('stage');

  const renderer = new THREE.WebGLRenderer({ antialias: retro?.antialias ?? true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(retro ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  stage.appendChild(renderer.domElement);
  if (retro) stage.classList.add('retro');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  camera.position.set(0, 1.7, 8);

  const controls = createCameraControls(camera, stage, {
    pad: document.getElementById('pad'),
    speedOut: document.getElementById('speedOut'),
  });
  const ui = createUI();
  const fade = createFade({ duration: 0.6 });

  function resize() {
    if (retro) { // resolución interna fija; el navegador escala la imagen (ver css .retro)
      renderer.setSize(retro.width, retro.height, false);
      camera.aspect = retro.width / retro.height;
      camera.updateProjectionMatrix();
      return;
    }
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  let inspector = null;
  let collisionDebug = null;
  const npcs = createNpcs();
  let dialogue = null;
  let doors = null;
  let player = null;
  let world = null; // gestor de escenas (para mover el cielo)
  let mode = 'free'; // 'player' (tercera persona) o 'free' (cámara libre)
  const hintFree = document.getElementById('hintFree');
  const hintPlayer = document.getElementById('hintPlayer');
  const EYE = 1.7; // altura de los ojos de la cámara libre sobre el suelo

  // Charlas con NPC (ver systems/dialogue.js): mientras dura, el jugador (o la cámara libre) no se mueve.
  // Se libera un instante después para que la tecla que cierra la charla no active otra cosa (ej. una acción 1, 2, 3).
  // La caja de texto se dibuja dentro de la imagen del juego (ui/textbox.js), encima del mundo y en el mismo cuadro
  const textbox = createTextbox({ renderer, retro });
  dialogue = createDialogue({
    stage,
    npcs,
    textbox,
    onStart: () => { player.frozen = true; if (mode === 'free') controls.setEnabled(false); },
    onEnd: () => setTimeout(() => { player.frozen = false; if (mode === 'free') controls.setEnabled(true); }, 0),
    onError: (msg) => ui.setStatus(msg),
  });

  function setMode(m) {
    mode = m;
    const asPlayer = m === 'player';
    if (asPlayer) {
      // desde la cámara libre: el jugador aparece debajo de la cámara, mirando hacia donde mirabas
      player.place([camera.position.x, camera.position.y - EYE, camera.position.z], controls.getYaw());
    } else if (player.active) {
      controls.setLook(player.yaw, -0.2);
    }
    controls.setEnabled(!asPlayer);
    player.setActive(asPlayer);
    if (hintFree) hintFree.hidden = asPlayer;
    if (hintPlayer) hintPlayer.hidden = !asPlayer;
  }
  // En dev, C alterna entre cámara libre y personaje
  if (dev) window.addEventListener('keydown', (e) => { if (e.code === 'KeyC' && !e.repeat && player && !dialogue?.active) setMode(mode === 'player' ? 'free' : 'player'); });

  let last = performance.now();
  const interval = retro?.fps ? 1000 / retro.fps : 0;
  function frame(now) {
    requestAnimationFrame(frame);
    // Límite de cuadros: se salta el cuadro si todavía no pasó el intervalo (2 ms de margen por el redondeo del navegador)
    if (interval && now - last < interval - 2) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    controls.update(dt);
    player?.update(dt);
    npcs.update(dt);
    inspector?.update(dt);
    world?.updateSky(camera.position);
    // Punto que se compara con puertas y NPC: el jugador (a la altura del pecho) o la cámara libre
    const focus = mode === 'player' && player ? _focus.copy(player.position).setY(player.position.y + 1) : camera.position;
    dialogue?.update(focus, dt);
    doors?.update(focus);
    renderer.render(scene, camera);
    textbox.render(); // caja de diálogo, encima del mundo
  }
  requestAnimationFrame(frame);

  // Datos y escena inicial
  try {
    const [scenesTable, musicTable] = await Promise.all([
      loadJSON('data/tables/scenes.json'),
      loadJSON('data/tables/music.json'),
    ]);
    const playerConfig = await loadJSON('data/tables/player.json').catch(() => ({}));
    player = await createPlayer({ scene, camera, stage, pad: document.getElementById('pad'), config: playerConfig });
    const audio = createAudio(musicTable);
    const sceneManager = createSceneManager({ scene, camera, controls, audio, ui, scenesTable });
    world = sceneManager;

    // Carga una escena y deja listas sus puertas
    async function enterScene(id, spawn) {
      await sceneManager.loadScene(id, { spawn });
      doors.setup(sceneManager.current, sceneManager.root);
      // El jugador aparece en el punto de inicio de la escena (sp está a la altura de los ojos)
      // Colisiones: se leen las propiedades `colision` de los objetos del .glb (ver collision.js)
      const scol = sceneManager.current.collision ?? {};
      const cworld = buildCollision(sceneManager.root, {
        defaultSolid: scol.default === undefined ? true : scol.default !== 'none' && scol.default !== false,
        maxSlope: playerConfig.collision?.maxSlope,
        ignore: (node) => isSkyName(node.name),
      });
      if (!cworld.hasGround) console.warn('Colisiones: la escena no tiene ninguna superficie de suelo sólida; el jugador no cambia de altura.');
      console.info(`Colisiones de "${sceneManager.current.id}":`, cworld.stats);
      collisionDebug?.attach(sceneManager.root, cworld);
      player.setWorld(cworld);
      npcs.setWorld(cworld); // las rutas de los NPC esquivan los objetos con colisión
      // NPC: Empties npc_* del .glb + "actors" del JSON (ver src/actors/npc.js). Van después de armar las colisiones.
      const npcInfo = await npcs.setup(sceneManager.root, sceneManager.current, sceneManager.shade);
      player.setObstacles(npcs.obstacles);
      dialogue.setup(); // los NPC con diálogo (npc_texto / npc_dialogo)
      if (npcInfo.missing.length) ui.setStatus(`NPC: no se pudo cargar ${npcInfo.missing.join(', ')}`);
      player.setShade(sceneManager.shade); // mismo tono y brillo que la escena
      const sp = sceneManager.spawn;
      if (sp) player.place([sp.position[0], sp.position[1] - EYE, sp.position[2]], sp.yaw ?? 0);
    }
    // Puerta (se activa con la tecla E): fundido a negro -> cambiar de escena -> fundido desde negro
    doors = createDoors({
      stage,
      dev,
      blocked: () => dialogue?.blocked ?? false, // las charlas con NPC usan la misma tecla E
      onEnter: async (door) => {
        player.frozen = true; // no se mueve durante el fundido
        await fade.fadeOut();
        try {
          await enterScene(door.target, door.spawn);
        } catch (err) { // destino inexistente: nos quedamos donde estábamos, sin pantalla negra eterna
          console.error(err);
          ui.setStatus(String(err.message || err));
        }
        await fade.fadeIn();
        player.frozen = false;
      },
    });

    if (dev) {
      try {
        const { createInspector } = await import('./systems/inspector.js');
        inspector = createInspector({ scene, camera, getRoot: () => sceneManager.root });
        const { createCollisionDebug } = await import('./systems/collision-debug.js');
        collisionDebug = createCollisionDebug();
      } catch (err) {
        // Si el inspector no carga, el mundo igual se muestra
        console.error(err);
        ui.setStatus('No se pudo cargar el inspector (falta src/systems/inspector.js).');
      }
    }

    const startId = Object.keys(scenesTable).find((id) => scenesTable[id].start) ?? Object.keys(scenesTable)[0];
    await enterScene(startId);
    setMode(dev ? 'free' : 'player');
    // si el personaje o sus animaciones tienen problemas, se avisa en pantalla
    const notice = player.loadError ?? player.animNotice;
    if (notice) ui.setStatus(notice);
  } catch (err) {
    console.error(err);
    ui.setStatus(String(err.message || err));
  }
  // Para las herramientas del modo desarrollador (panel de NPC, etc.)
  return { npcs, camera, controls, scene, getRoot: () => world?.root ?? null };
}
