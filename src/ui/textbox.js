// Caja de texto DENTRO del juego, como en Ocarina of Time: se dibuja en un lienzo chico (la misma resolución
// del juego, ej. 320x240) con letra de píxeles, y ese lienzo se pinta encima del mundo 3D en el mismo cuadro.
// Así queda pixelada, escalada y recortada igual que el resto de la imagen (no flota encima como una página web).
//
// La usa systems/dialogue.js (la lógica de la charla); acá solo se dibuja:
//   paginate(texto, lineasReservadas)  -> parte un texto en páginas que entran en la caja (salto de línea automático)
//   show({ name, page, shown, choices, sel, more })  -> qué dibujar ("more": 'next' = triángulo, 'end' = cuadrado)
//   hide(), render(renderer) (después de dibujar el mundo), pick(clientX, clientY) -> qué se tocó
//
// Para ajustar el aspecto, cambiá STYLE.
import * as THREE from 'three';
import { GLYPHS, FONT_HEIGHT, FONT_BASELINE } from './pixel-font.js';

export const STYLE = {
  lines: 4,              // renglones por caja (Ocarina usa 4)
  lineHeight: 13,        // píxeles entre renglones
  maxWidth: 272,         // ancho máximo de la caja (a 320 de ancho deja un margen a los costados)
  padX: 12, padY: 7,     // margen interno
  padBottom: 10,         // margen de abajo (ahí va el triángulo, sin pisar el texto)
  bottom: 10,            // distancia al borde de abajo
  radius: 5,             // esquinas redondeadas
  space: 3,              // ancho del espacio
  box: 'rgba(0, 0, 0, 0.66)',
  text: '#ffffff',
  shadow: 'rgba(0, 0, 0, 0.85)',
  name: '#f7d774',       // nombre del que habla (en una pestañita arriba de la caja)
  choice: '#6be36b',     // opciones (verdes, como en Ocarina)
  cursor: '#58d6ff',     // flechita de la opción elegida
  more: '#58e070',       // triángulo "sigue" / cuadrado "terminó"
  baseHeight: 240,       // sin modo retro: alto virtual de la pantalla (se usa un múltiplo entero del tamaño real)
};

// Letras que la fuente no tiene: se reemplazan por parecidas
const SUBS = { '“': '"', '”': '"', '«': '"', '»': '"', '‘': "'", '’': "'", '…': '...', '—': '-', '–': '-', '\t': ' ' };

const glyphCache = new Map();
function glyph(ch) {
  let g = glyphCache.get(ch);
  if (g) return g;
  const code = GLYPHS[ch] ?? GLYPHS['?'];
  const rows = [];
  for (let i = 0; i < FONT_HEIGHT; i++) rows.push(parseInt(code.slice(1 + i * 2, 3 + i * 2), 16));
  g = { w: parseInt(code[0], 16), rows };
  glyphCache.set(ch, g);
  return g;
}
const advance = (ch) => (ch === ' ' ? STYLE.space : glyph(ch).w + 1);

function normalizeText(t) {
  let out = '';
  for (const ch of String(t).replace(/\r/g, '').replace(/\\n/g, '\n')) out += SUBS[ch] ?? ch;
  return out;
}

// Medidas de la caja para una pantalla de W x H
function boxGeom(W, H, lineCount) {
  const w = Math.min(STYLE.maxWidth, W - 16);
  const h = STYLE.padY + Math.max(STYLE.lines, lineCount) * STYLE.lineHeight + STYLE.padBottom;
  return { x: Math.round((W - w) / 2), y: H - STYLE.bottom - h, w, h };
}

export function createTextbox({ renderer, retro = null }) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  const hudScene = new THREE.Scene();
  const hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  hudScene.add(quad);

  let W = 0, H = 0;
  let state = null;     // lo que se está mostrando (null = caja cerrada)
  let dirty = false;
  let blink = 0;        // reloj para el triángulo que rebota
  let hits = [];        // zonas de las opciones, para el mouse / toque
  let boxRect = null;
  const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Resolución virtual: la del modo retro, o un múltiplo entero de la pantalla real (para que los píxeles sean parejos)
  function fit() {
    let w, h;
    if (retro) { w = retro.width; h = retro.height; }
    else {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      const k = Math.max(1, Math.round(size.y / STYLE.baseHeight));
      w = Math.max(1, Math.floor(size.x / k));
      h = Math.max(1, Math.floor(size.y / k));
    }
    if (w !== W || h !== H) {
      W = canvas.width = w;
      H = canvas.height = h;
      texture.dispose(); // el lienzo cambió de tamaño: three.js tiene que volver a crear la textura
      dirty = true;
    }
  }

  // ---- Armado de páginas ----
  // Devuelve una lista de páginas; cada una es { lines: [[{ ch, x }]], count, text } donde count = letras a escribir.
  // `reserve`: renglones que quedan libres en la última página (para las opciones).
  function paginate(text, reserve = 0) {
    fit();
    const inner = boxGeom(W, H, 0).w - STYLE.padX * 2;
    const lines = [];
    for (const para of normalizeText(text).split('\n')) {
      let line = [], x = 0;
      const words = para.split(/( +)/).filter((p) => p !== '');
      if (!words.length) { lines.push([]); continue; }
      for (const word of words) {
        const ww = [...word].reduce((a, ch) => a + advance(ch), 0);
        if (word.trim() === '') { // espacios: se ponen solo si no empiezan un renglón
          if (line.length) { for (const ch of word) { line.push({ ch, x }); x += advance(ch); } }
          continue;
        }
        if (x + ww > inner && line.length) { // no entra: renglón nuevo (sin los espacios del final)
          while (line.length && line[line.length - 1].ch === ' ') line.pop();
          lines.push(line); line = []; x = 0;
        }
        for (const ch of word) { // palabra más larga que la caja: se corta donde haga falta
          if (x + advance(ch) - 1 > inner && line.length) { lines.push(line); line = []; x = 0; }
          line.push({ ch, x }); x += advance(ch);
        }
      }
      while (line.length && line[line.length - 1].ch === ' ') line.pop();
      lines.push(line);
    }
    // Repartir en cajas de STYLE.lines renglones; la última deja lugar a las opciones (si no entran, va una caja más)
    const per = STYLE.lines;
    const pages = [];
    for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per));
    const keep = Math.max(1, per - reserve);
    if (reserve && pages[pages.length - 1].length > keep) {
      const last = pages.pop();
      pages.push(last.slice(0, last.length - keep), last.slice(last.length - keep));
    }
    return pages.map((pl) => ({
      lines: pl,
      count: pl.reduce((a, l) => a + l.length, 0),
      text: pl.map((l) => l.map((g) => g.ch).join('')).join('\n'),
    }));
  }

  // ---- Dibujo ----
  function px(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); }

  // Rectángulo con esquinas redondeadas, fila por fila (sin suavizado, y sin pisar el semitransparente)
  function roundRect(x, y, w, h, r, color) {
    ctx.fillStyle = color;
    for (let row = 0; row < h; row++) {
      const d = row < r ? r - row : row >= h - r ? row - (h - r) + 1 : 0;
      const inset = d ? Math.round(r - Math.sqrt(Math.max(0, r * r - d * d))) : 0;
      ctx.fillRect(x + inset, y + row, w - inset * 2, 1);
    }
  }

  function drawGlyph(ch, x, y, color) {
    if (ch === ' ') return;
    const g = glyph(ch);
    ctx.fillStyle = color;
    for (let r = 0; r < FONT_HEIGHT; r++) {
      const bits = g.rows[r];
      if (!bits) continue;
      for (let c = 0; c < g.w; c++) if (bits >> c & 1) ctx.fillRect(x + c, y + r, 1, 1);
    }
  }
  function drawRun(chars, x, y, color, limit = Infinity) {
    let n = 0;
    for (const g of chars) { if (n++ >= limit) break; drawGlyph(g.ch, x + g.x + 1, y + 1, STYLE.shadow); }
    n = 0;
    for (const g of chars) { if (n++ >= limit) break; drawGlyph(g.ch, x + g.x, y, color); }
  }
  function layoutLine(str) {
    let x = 0; const out = [];
    for (const ch of normalizeText(str)) { out.push({ ch, x }); x += advance(ch); }
    return { chars: out, w: x };
  }

  function draw() {
    dirty = false;
    ctx.clearRect(0, 0, W, H);
    hits = [];
    boxRect = null;
    if (!state) return;
    const { page, choices = [] } = state;
    const lineCount = page.lines.length + (state.choicesVisible ? choices.length : 0);
    const b = boxGeom(W, H, lineCount);
    boxRect = b;
    roundRect(b.x, b.y, b.w, b.h, STYLE.radius, STYLE.box);

    // Nombre en una pestañita arriba a la izquierda
    if (state.name) {
      const n = layoutLine(state.name);
      const tw = n.w + 10, th = FONT_HEIGHT + 3;
      roundRect(b.x + 6, b.y - th + 1, tw, th, 3, STYLE.box);
      drawRun(n.chars, b.x + 11, b.y - th + 3, STYLE.name);
    }

    // Texto (solo las letras ya "escritas")
    let left = state.shown;
    let y = b.y + STYLE.padY;
    for (const line of page.lines) {
      if (left > 0) drawRun(line, b.x + STYLE.padX, y, STYLE.text, left);
      left -= line.length;
      y += STYLE.lineHeight;
    }

    // Opciones
    if (state.choicesVisible) {
      choices.forEach((c, i) => {
        const l = layoutLine(c);
        const cx = b.x + STYLE.padX + 12;
        drawRun(l.chars, cx, y, STYLE.choice);
        hits.push({ i, x: b.x, y: y - 1, w: b.w, h: STYLE.lineHeight });
        if (i === state.sel) { // flechita ►
          const ax = b.x + STYLE.padX + (reduceMotion() ? 0 : Math.round(Math.sin(blink * 8) + 1) - 1);
          for (let k = 0; k < 4; k++) px(ax + k, y + 2 + k, 1, 7 - k * 2, STYLE.cursor);
        }
        y += STYLE.lineHeight;
      });
    }

    // Indicador abajo a la derecha: ▼ (sigue) o ■ (terminó)
    if (state.more) {
      const bx = b.x + b.w - 14;
      const bounce = reduceMotion() ? 0 : Math.round((Math.sin(blink * 7) + 1) * 1);
      const by = b.y + b.h - 8 + bounce - 1;
      if (state.more === 'next') {
        for (let k = 0; k < 4; k++) px(bx + k, by + k, 7 - k * 2, 1, STYLE.more);
        px(bx - 1, by - 1, 9, 1, 'rgba(0,0,0,0.5)');
      } else {
        px(bx + 1, by, 5, 5, STYLE.more);
      }
    }
  }

  // Pantalla -> coordenadas del lienzo virtual (el canvas del juego puede estar escalado con barras negras)
  function toVirtual(clientX, clientY) {
    const el = renderer.domElement;
    const r = el.getBoundingClientRect();
    const bw = el.width, bh = el.height;
    const s = Math.min(r.width / bw, r.height / bh);
    const cw = bw * s, ch = bh * s;
    const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - ch) / 2;
    return { x: ((clientX - ox) / cw) * W, y: ((clientY - oy) / ch) * H };
  }

  return {
    STYLE,
    paginate,
    show(next) { state = next; dirty = true; },
    hide() { state = null; dirty = true; },
    get visible() { return !!state; },
    // { choice: i } si se tocó una opción, { box: true } si se tocó la caja, null si fue afuera
    pick(clientX, clientY) {
      if (!state) return null;
      const p = toVirtual(clientX, clientY);
      for (const h of hits) if (p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h) return { choice: h.i };
      if (boxRect && p.x >= boxRect.x && p.x < boxRect.x + boxRect.w && p.y >= boxRect.y - 14 && p.y < boxRect.y + boxRect.h) return { box: true };
      return null;
    },
    update(dt) {
      if (!state) return;
      blink += dt;
      if (!reduceMotion() && (state.more || state.choicesVisible)) dirty = true; // el triángulo y la flechita se mueven
    },
    // Llamar después de renderer.render(mundo): pinta la caja encima, en el mismo cuadro
    render() {
      fit();
      if (dirty) { draw(); texture.needsUpdate = true; }
      if (!state) return;
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(hudScene, hudCam);
      renderer.autoClear = auto;
    },
  };
}
