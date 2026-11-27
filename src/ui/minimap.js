// Minimapa: arriba a la derecha, el mapa visto desde arriba (vista cenital) en baja resolución, con el norte arriba.
//   - El dibujo del mapa se saca UNA vez por escena (y otra vez cuando aparece o desaparece una casa): una cámara
//     ortográfica mira hacia abajo y pinta la escena en una imagen chica (RES × RES píxeles).
//   - Cada cuadro se recorta el pedazo alrededor tuyo y se dibujan encima: vos (flecha), los otros jugadores (puntos)
//     y los lotes libres (cuadraditos amarillos).
//   - Tecla M: abre el mapa en grande (cuadrado, en el centro de la pantalla, con toda la escena); M otra vez (o Esc) vuelve
//     al minimapa de siempre.
import * as THREE from 'three';
import { isSkyName } from '../systems/shading.js';

const RES = 256;            // píxeles del dibujo del mapa entero (baja resolución a propósito)
const VIEW = 70;            // metros que entran de lado a lado en el minimapa
const MAX_SIZE = 600;       // m: si la escena es más grande, se dibuja este cuadrado alrededor del centro
const SIZE_PX = 168;        // tamaño en pantalla
const BIG_PX = 640;         // resolución del dibujo cuando el mapa está en grande (en pantalla se ajusta al tamaño de la ventana, ver css)
// Lo que no va en el mapa: cielo, ayudas del modo desarrollador, flechas de lotes, globos y nombres
const SKIP_RE = /^(?:lote-flecha|lote-helper|collision-debug|route-debug|spawn-debug|jugador:)/i;

export function createMinimap({ renderer, scene }) {
  const app = document.querySelector('.app') ?? document.body;
  const wrap = document.createElement('div');
  wrap.className = 'minimap';
  const view = document.createElement('canvas');
  view.width = view.height = SIZE_PX;
  wrap.append(view);
  const north = document.createElement('span');
  north.className = 'minimap-n';
  north.textContent = 'N';
  wrap.append(north);
  app.append(wrap);
  const vctx = view.getContext('2d');

  const map = document.createElement('canvas'); // el mapa entero, chiquito
  map.width = map.height = RES;
  const mctx = map.getContext('2d');
  let area = null; // { minX, minZ, size }
  const visible = true;
  let big = false;     // mapa en grande (tecla M)
  function setBig(on) {
    big = on;
    wrap.classList.toggle('grande', on);
    view.width = view.height = on ? BIG_PX : SIZE_PX; // al cambiar el tamaño del canvas se borra: el próximo cuadro lo vuelve a dibujar
    lastDraw = 0;
  }
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    setBig(!big);
  });
  // Esc cierra el mapa grande (antes de que el menú de Esc se abra)
  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || !big) return;
    setBig(false); e.preventDefault(); e.stopImmediatePropagation();
  }, true);

  const rt = new THREE.WebGLRenderTarget(RES, RES);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
  cam.up.set(0, 0, -1); // el norte (-Z) queda arriba
  const pixels = new Uint8Array(RES * RES * 4);

  // Dibuja el mapa de la escena (root = el grupo de la escena actual)
  function capture(root) {
    if (!root) return;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const hidden = [];
    root.traverse((o) => {
      if (!o.visible) return;
      if (isSkyName(o.name) || SKIP_RE.test(o.name ?? '') || o.isSprite || o.isLine || o.isPoints) { o.visible = false; hidden.push(o); return; }
      if (o.isMesh && o.geometry) {
        o.geometry.computeBoundingBox?.();
        if (o.geometry.boundingBox) box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
    });
    if (box.isEmpty()) { hidden.forEach((o) => { o.visible = true; }); return; }
    const c = box.getCenter(new THREE.Vector3());
    const size = Math.min(MAX_SIZE, Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 10)) * 1.04;
    area = { minX: c.x - size / 2, minZ: c.z - size / 2, size };
    cam.left = -size / 2; cam.right = size / 2; cam.top = size / 2; cam.bottom = -size / 2;
    cam.position.set(c.x, box.max.y + 50, c.z);
    cam.far = box.max.y - box.min.y + 100;
    cam.lookAt(c.x, box.min.y, c.z);
    cam.updateProjectionMatrix();

    const fog = scene.fog, bg = scene.background;
    scene.fog = null;
    // Solo la escena (sin el jugador, los otros jugadores ni nada de afuera)
    const others = scene.children.filter((o) => o !== root && o.visible);
    others.forEach((o) => { if (!o.isLight) o.visible = false; });
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(bg?.isColor ? bg : new THREE.Color('#2b3a2b'), 1);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, RES, RES, pixels);
    renderer.setRenderTarget(prevRT);
    others.forEach((o) => { o.visible = true; });
    hidden.forEach((o) => { o.visible = true; });
    scene.fog = fog;

    // La imagen sale dada vuelta (el píxel 0 es abajo): se da vuelta al copiarla
    const img = mctx.createImageData(RES, RES);
    for (let y = 0; y < RES; y++) img.data.set(pixels.subarray((RES - 1 - y) * RES * 4, (RES - y) * RES * 4), y * RES * 4);
    mctx.putImageData(img, 0, 0);
  }

  let lastDraw = 0;
  // me: { x, z, facing } · others: [{ x, z }] · lots: [{ x, z, color }]
  function update({ me, others = [], lots = [] }) {
    if (!visible || !area || !me) return;
    const now = performance.now();
    if (now - lastDraw < 66) return; // ~15 veces por segundo alcanza
    lastDraw = now;
    if (big) return drawBig(me, others, lots);
    const k = RES / area.size;              // píxeles del mapa por metro
    const half = (VIEW / 2) * k;            // medio lado del recorte, en píxeles del mapa
    const cx = (me.x - area.minX) * k, cz = (me.z - area.minZ) * k;
    const s = SIZE_PX / (2 * half);         // píxeles de pantalla por píxel del mapa
    vctx.imageSmoothingEnabled = false;     // que se vean los píxeles (baja resolución)
    vctx.fillStyle = '#0d1418';
    vctx.fillRect(0, 0, SIZE_PX, SIZE_PX);
    vctx.drawImage(map, cx - half, cz - half, half * 2, half * 2, 0, 0, SIZE_PX, SIZE_PX);
    const toScreen = (x, z) => [SIZE_PX / 2 + ((x - me.x) * k) * s, SIZE_PX / 2 + ((z - me.z) * k) * s];
    for (const l of lots) {
      const [x, y] = toScreen(l.x, l.z);
      vctx.fillStyle = l.color ?? '#ffd23f';
      vctx.fillRect(Math.round(x) - 3, Math.round(y) - 3, 6, 6);
    }
    for (const o of others) {
      const [x, y] = toScreen(o.x, o.z);
      vctx.fillStyle = '#7dd3fc';
      vctx.strokeStyle = '#0b1215';
      vctx.lineWidth = 2;
      vctx.beginPath(); vctx.arc(x, y, 4, 0, Math.PI * 2); vctx.fill(); vctx.stroke();
    }
    // Vos: una flecha que apunta hacia donde mirás
    vctx.save();
    vctx.translate(SIZE_PX / 2, SIZE_PX / 2);
    vctx.rotate(Math.PI - me.facing);
    vctx.fillStyle = '#ffd43b';
    vctx.strokeStyle = '#0b1215';
    vctx.lineWidth = 2;
    vctx.beginPath(); vctx.moveTo(0, -8); vctx.lineTo(6, 6); vctx.lineTo(0, 3); vctx.lineTo(-6, 6); vctx.closePath();
    vctx.fill(); vctx.stroke();
    vctx.restore();
  }

  // Mapa en grande: toda la escena (no un recorte alrededor tuyo), con vos, los otros jugadores y los lotes
  function drawBig(me, others, lots) {
    const S = BIG_PX, k = S / area.size;
    vctx.imageSmoothingEnabled = false;
    vctx.fillStyle = '#0d1418';
    vctx.fillRect(0, 0, S, S);
    vctx.drawImage(map, 0, 0, RES, RES, 0, 0, S, S);
    const toScreen = (x, z) => [(x - area.minX) * k, (z - area.minZ) * k];
    for (const l of lots) {
      const [x, y] = toScreen(l.x, l.z);
      vctx.fillStyle = l.color ?? '#ffd23f';
      vctx.strokeStyle = '#0b1215'; vctx.lineWidth = 2;
      vctx.fillRect(Math.round(x) - 6, Math.round(y) - 6, 12, 12);
      vctx.strokeRect(Math.round(x) - 6, Math.round(y) - 6, 12, 12);
    }
    for (const o of others) {
      const [x, y] = toScreen(o.x, o.z);
      vctx.fillStyle = '#7dd3fc'; vctx.strokeStyle = '#0b1215'; vctx.lineWidth = 2.5;
      vctx.beginPath(); vctx.arc(x, y, 7, 0, Math.PI * 2); vctx.fill(); vctx.stroke();
    }
    const [mx, my] = toScreen(me.x, me.z);
    vctx.save();
    vctx.translate(mx, my);
    vctx.rotate(Math.PI - me.facing);
    vctx.fillStyle = '#ffd43b'; vctx.strokeStyle = '#0b1215'; vctx.lineWidth = 2.5;
    vctx.beginPath(); vctx.moveTo(0, -15); vctx.lineTo(11, 11); vctx.lineTo(0, 6); vctx.lineTo(-11, 11); vctx.closePath();
    vctx.fill(); vctx.stroke();
    vctx.restore();
  }

  return { capture, update, get visible() { return visible; }, get grande() { return big; }, setBig };
}
