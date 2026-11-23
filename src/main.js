// Punto de entrada: arma el motor y carga la escena inicial.
import * as THREE from 'three';
import { loadJSON } from './core/assets.js';
import { createCameraControls } from './systems/camera.js';
import { createAudio } from './systems/audio.js';
import { createSceneManager } from './systems/scene-manager.js';
import { createUI } from './ui/ui.js';

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

function resize() {
  const w = stage.clientWidth || 1;
  const h = stage.clientHeight || 1;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  controls.update(dt);
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
  const audio = createAudio(musicTable);
  const sceneManager = createSceneManager({ scene, camera, controls, audio, ui, scenesTable });
  const startId = Object.keys(scenesTable).find((id) => scenesTable[id].start) ?? Object.keys(scenesTable)[0];
  await sceneManager.loadScene(startId);
} catch (err) {
  console.error(err);
  ui.setStatus(String(err.message || err));
}
