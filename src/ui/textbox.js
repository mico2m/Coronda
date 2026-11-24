// Caja de texto DENTRO del juego, como en Ocarina of Time: se dibuja en un lienzo chico (240 de alto, ver
// textbox-paint.js) con letra de píxeles, y ese lienzo se pinta encima del mundo 3D en el mismo cuadro.
// Así queda pixelada, escalada y recortada igual que el resto de la imagen (no flota encima como una página web).
//
// La usa systems/dialogue.js (la lógica de la charla); acá solo se dibuja:
//   paginate(texto, lineasReservadas)  -> parte un texto en páginas que entran en la caja (salto de línea automático)
//   show({ name, page, shown, choices, sel, more })  -> qué dibujar ("more": 'next' = sigue, 'end' = terminó)
//   hide(), render() (después de dibujar el mundo), pick(clientX, clientY) -> qué se tocó
//   setStyle({...}) -> aspecto (lo arma la pestaña Interfaz del motor en data/ui.json)
import * as THREE from 'three';
import { createTextPainter, STYLE, setStyle } from './textbox-paint.js';

export { STYLE };

export function createTextbox({ renderer, retro = null }) {
  const painter = createTextPainter();
  const canvas = painter.canvas;
  let texture = null;
  const hudScene = new THREE.Scene();
  const hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  hudScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  function makeTexture() {
    texture?.dispose();
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    mat.map = texture;
    mat.needsUpdate = true;
  }
  makeTexture();

  function fit() {
    const size = retro ? { x: retro.width, y: retro.height } : renderer.getDrawingBufferSize(new THREE.Vector2());
    if (painter.fit(size.x, size.y)) makeTexture(); // el lienzo cambió de tamaño: three.js necesita una textura nueva
  }

  // Pantalla -> coordenadas del lienzo (el canvas del juego puede estar escalado con barras negras)
  function toVirtual(clientX, clientY) {
    const el = renderer.domElement;
    const r = el.getBoundingClientRect();
    const bw = el.width, bh = el.height;
    const s = Math.min(r.width / bw, r.height / bh);
    const cw = bw * s, ch = bh * s;
    const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - ch) / 2;
    const { W, H } = painter.size();
    return { x: ((clientX - ox) / cw) * W, y: ((clientY - oy) / ch) * H };
  }

  return {
    STYLE,
    setStyle(next) { setStyle(next); fit(); painter.dirty = true; },
    paginate(text, reserve = 0) { fit(); return painter.paginate(text, reserve); },
    show(next) { painter.show(next); },
    hide() { painter.hide(); },
    get visible() { return painter.visible; },
    pick(clientX, clientY) { const p = toVirtual(clientX, clientY); return painter.pick(p.x, p.y); },
    update(dt) { painter.update(dt); },
    // Llamar después de renderer.render(mundo): pinta la caja encima, en el mismo cuadro
    render() {
      fit();
      if (painter.dirty) { painter.draw(); texture.needsUpdate = true; }
      if (!painter.visible) return;
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(hudScene, hudCam);
      renderer.autoClear = auto;
    },
  };
}
