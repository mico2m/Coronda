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

const _focus = new THREE.Vector3();

export async function startGame({ dev = false } = {}) {
  const stage = document.getElementById('stage');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.appendChild(renderer.domElement);

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
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  let inspector = null;
  let doors = null;
  let player = null;
  let mode = 'free'; // 'player' (tercera persona) o 'free' (cámara libre)
  const hintFree = document.getElementById('hintFree');
  const hintPlayer = document.getElementById('hintPlayer');
  const EYE = 1.7; // altura de los ojos de la cámara libre sobre el suelo

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
  if (dev) window.addEventListener('keydown', (e) => { if (e.code === 'KeyC' && !e.repeat && player) setMode(mode === 'player' ? 'free' : 'player'); });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    controls.update(dt);
    player?.update(dt);
    inspector?.update(dt);
    if (doors) {
      if (mode === 'player' && player) doors.update(_focus.copy(player.position).setY(player.position.y + 1));
      else doors.update(camera.position);
    }
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
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

    // Carga una escena y deja listas sus puertas
    async function enterScene(id, spawn) {
      await sceneManager.loadScene(id, { spawn });
      doors.setup(sceneManager.current, sceneManager.root);
      // El jugador aparece en el punto de inicio de la escena (sp está a la altura de los ojos)
      player.setWorld(sceneManager.root);
      const sp = sceneManager.spawn;
      if (sp) player.place([sp.position[0], sp.position[1] - EYE, sp.position[2]], sp.yaw ?? 0);
    }
    // Puerta (se activa con la tecla E): fundido a negro -> cambiar de escena -> fundido desde negro
    doors = createDoors({
      stage,
      dev,
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
      } catch (err) {
        // Si el inspector no carga, el mundo igual se muestra
        console.error(err);
        ui.setStatus('No se pudo cargar el inspector (falta src/systems/inspector.js).');
      }
    }

    const startId = Object.keys(scenesTable).find((id) => scenesTable[id].start) ?? Object.keys(scenesTable)[0];
    await enterScene(startId);
    setMode(dev ? 'free' : 'player');
    if (player.loadError) ui.setStatus(player.loadError); // si el personaje no cargó, se avisa en pantalla
  } catch (err) {
    console.error(err);
    ui.setStatus(String(err.message || err));
  }
}
