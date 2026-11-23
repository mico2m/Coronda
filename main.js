// Proyecto final: arma la escena y conecta los módulos.
// Cada etapa nueva (modelos, personajes, diálogos...) es un archivo nuevo que se importa acá.
import * as THREE from 'three';
import { createCameraControls } from './camera.js';
import { createFloor } from './floor.js';
import { makeDefaultTexture } from './textures.js';
import { bindUI } from './ui.js';

const stage = document.getElementById('stage');

// Renderer, escena y cámara
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcccccc, 120, 500);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
camera.position.set(0, 1.7, 16);

// El color del fondo sale del tema (variable CSS --scene), claro u oscuro.
function applyTheme() {
  const c = getComputedStyle(document.documentElement).getPropertyValue('--scene').trim() || '#c9d4d9';
  scene.background = new THREE.Color(c);
  scene.fog.color = new THREE.Color(c);
}
applyTheme();
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// Módulos
const controls = createCameraControls(camera, stage, {
  pad: document.getElementById('pad'),
  speedOut: document.getElementById('speedOut'),
});
const floor = createFloor(scene);
floor.setTexture(makeDefaultTexture(renderer));
bindUI({ floor, renderer });

// Tamaño del canvas
function resize() {
  const w = stage.clientWidth || 1;
  const h = stage.clientHeight || 1;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

// Bucle
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  controls.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);