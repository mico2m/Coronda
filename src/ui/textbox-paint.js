// Dibujo de la caja de diálogo en un lienzo 2D chico (sin three.js). Lo usan ui/textbox.js (el juego, que pinta este
// lienzo encima del mundo) y la vista previa de la pestaña Interfaz del motor: las dos se ven exactamente igual.
//
//   const p = createTextPainter();
//   p.fit(anchoPantalla, altoPantalla)   -> el lienzo mide STYLE.baseHeight de alto y el ancho que corresponda
//   p.paginate(texto, reservados)        -> páginas que entran en la caja
//   p.show(estado) / p.hide() / p.update(dt) / p.draw() (si p.dirty) / p.pick(x, y) en coordenadas del lienzo
//
// El aspecto se cambia con setStyle({...}) (lo hace el juego al leer data/ui.json). Letras: "spleen" (píxeles, como
// Ocarina) o cualquier otra (de Google o importada): esas se dibujan como texto y, con "crisp", se pasan a píxeles duros.
import { GLYPHS, FONT_HEIGHT, FONT_BASELINE } from './pixel-font.js';
import { DEFAULT_UI, BUILTIN_FONTS, fontCSS, fontScale } from './theme.js';

export const STYLE = { ...DEFAULT_UI.textbox };
let gen = 0; // cambia con cada setStyle: invalida medidas guardadas
export function setStyle(next = {}) {
  Object.assign(STYLE, DEFAULT_UI.textbox, next);
  gen++;
}

// Letras que la fuente de píxeles no tiene: se reemplazan por parecidas
const SUBS = { '“': '"', '”': '"', '«': '"', '»': '"', '‘': "'", '’': "'", '…': '...', '—': '-', '–': '-', '\t': ' ' };

const bitmap = () => !STYLE.font || !!BUILTIN_FONTS[STYLE.font]?.bitmap;
const fontPx = () => Math.max(5, Math.round((Number(STYLE.fontSize) || 11) * fontScale(STYLE.font)));
const vfont = () => `${STYLE.bold ? 700 : 400} ${fontPx()}px ${fontCSS(STYLE.font)}`;
// Alto de una letra (para la pestañita del nombre y la posición del texto en el renglón)
const cellH = () => (bitmap() ? FONT_HEIGHT : Math.round(fontPx() * 1.2));
const baseline = () => (bitmap() ? FONT_BASELINE : Math.round(fontPx() * 0.9));

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
const measure = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
const widths = new Map();
let widthsGen = -1, widthsFont = '';
function advance(ch) {
  if (bitmap()) return ch === ' ' ? STYLE.space ?? 3 : glyph(ch).w + 1;
  const f = vfont();
  if (widthsGen !== gen || widthsFont !== f) { widths.clear(); widthsGen = gen; widthsFont = f; }
  let w = widths.get(ch);
  if (w === undefined) { measure.font = f; w = measure.measureText(ch).width; widths.set(ch, w); }
  return w;
}
const normalizeText = (t) => {
  let out = '';
  const subs = bitmap();
  for (const ch of String(t).replace(/\r/g, '').replace(/\\n/g, '\n')) out += subs ? SUBS[ch] ?? ch : ch === '\t' ? ' ' : ch;
  return out;
};

// Medidas de la caja para una pantalla de W x H
function boxGeom(W, H, lineCount, named) {
  const w = Math.min(STYLE.maxWidth, W - 16);
  const inside = named && STYLE.nameStyle === 'inside' ? STYLE.lineHeight : 0;
  const h = STYLE.padY + inside + Math.max(STYLE.lines, lineCount) * STYLE.lineHeight + STYLE.padBottom;
  const tab = named && STYLE.nameStyle === 'tab' ? cellH() + 3 : 0;
  const y = STYLE.position === 'top' ? STYLE.bottom + tab : STYLE.position === 'middle' ? Math.round((H - h) / 2) : H - STYLE.bottom - h;
  return { x: Math.round((W - w) / 2), y, w, h, inside };
}

export function createTextPainter() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const layer = document.createElement('canvas'); // el texto, aparte (para pasarlo a píxeles duros)
  const lctx = layer.getContext('2d', { willReadFrequently: true });
  let W = 0, H = 0;
  let state = null;
  let blink = 0;
  let hits = [];
  let boxRect = null;
  let lastGen = gen;
  const p = { canvas, dirty: false };
  const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // El lienzo mide siempre STYLE.baseHeight (240) de alto y el ancho que corresponda a la pantalla: así la caja mide
  // lo mismo en proporción, sea cual sea la resolución del juego. Devuelve true si cambió de tamaño.
  p.fit = (sw, sh) => {
    const h = Math.max(60, Math.round(STYLE.baseHeight));
    const w = Math.max(1, Math.round((sw * h) / Math.max(1, sh)));
    if (lastGen !== gen) { lastGen = gen; p.dirty = true; }
    if (w === W && h === H) return false;
    W = canvas.width = layer.width = w;
    H = canvas.height = layer.height = h;
    p.dirty = true;
    return true;
  };
  p.size = () => ({ W, H });

  // ---- Armado de páginas ----
  // Devuelve [{ lines: [[{ ch, x }]], count, text }]; `reserve` = renglones libres en la última página (opciones)
  p.paginate = (text, reserve = 0) => {
    if (!W) p.fit(320, 240);
    const inner = boxGeom(W, H, 0, false).w - STYLE.padX * 2;
    const lines = [];
    for (const para of normalizeText(text).split('\n')) {
      let line = [], x = 0;
      const words = para.split(/( +)/).filter((q) => q !== '');
      if (!words.length) { lines.push([]); continue; }
      for (const word of words) {
        const ww = [...word].reduce((a, ch) => a + advance(ch), 0);
        if (word.trim() === '') { // espacios: solo si no empiezan un renglón
          if (line.length) { for (const ch of word) { line.push({ ch, x }); x += advance(ch); } }
          continue;
        }
        if (x + ww > inner && line.length) {
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
    const per = Math.max(1, STYLE.lines | 0);
    const pages = [];
    for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per));
    if (!pages.length) pages.push([]);
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
  };

  // ---- Dibujo ----
  const px = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  const inset = (row, h, r) => {
    const d = row < r ? r - row : row >= h - r ? row - (h - r) + 1 : 0;
    return d ? Math.round(r - Math.sqrt(Math.max(0, r * r - d * d))) : 0;
  };
  // Rectángulo con esquinas redondeadas, fila por fila (sin suavizado, sin pisar lo semitransparente)
  function roundRect(x, y, w, h, r, color) {
    r = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    ctx.fillStyle = color;
    for (let row = 0; row < h; row++) { const i = inset(row, h, r); ctx.fillRect(x + i, y + row, w - i * 2, 1); }
  }
  // Solo el borde (el relleno va adentro, sin superponerse: así un fondo translúcido no se mezcla con el borde)
  function ring(x, y, w, h, r, bw, color) {
    r = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    const ir = Math.max(0, r - bw), ih = h - bw * 2;
    ctx.fillStyle = color;
    for (let row = 0; row < h; row++) {
      const o = inset(row, h, r);
      if (row < bw || row >= h - bw) { ctx.fillRect(x + o, y + row, w - o * 2, 1); continue; }
      const i = bw + inset(row - bw, ih, ir);
      ctx.fillRect(x + o, y + row, i - o, 1);
      ctx.fillRect(x + w - i, y + row, i - o, 1);
    }
  }
  function panel(x, y, w, h, r) {
    const bw = STYLE.border ? Math.max(1, STYLE.borderWidth | 0) : 0;
    if (bw) { ring(x, y, w, h, r, bw, STYLE.border); roundRect(x + bw, y + bw, w - bw * 2, h - bw * 2, Math.max(0, r - bw), STYLE.box); }
    else roundRect(x, y, w, h, r, STYLE.box);
  }

  function drawGlyph(c, ch, x, y, color) {
    if (ch === ' ') return;
    const g = glyph(ch);
    c.fillStyle = color;
    for (let r = 0; r < FONT_HEIGHT; r++) {
      const bits = g.rows[r];
      if (!bits) continue;
      for (let k = 0; k < g.w; k++) if (bits >> k & 1) c.fillRect(x + k, y + r, 1, 1);
    }
  }
  // Escribe un renglón (hasta `limit` letras) en la capa de texto; y = arriba del renglón
  function drawRun(chars, x, y, color, limit = Infinity) {
    const n = Math.min(chars.length, limit);
    if (n <= 0) return;
    const passes = STYLE.shadow ? [[1, 1, STYLE.shadow], [0, 0, color]] : [[0, 0, color]];
    if (bitmap()) {
      for (const [dx, dy, col] of passes) for (let i = 0; i < n; i++) drawGlyph(lctx, chars[i].ch, Math.round(x + chars[i].x) + dx, y + dy, col);
      return;
    }
    lctx.font = vfont();
    lctx.textBaseline = 'alphabetic';
    const by = y + baseline();
    for (const [dx, dy, col] of passes) {
      lctx.fillStyle = col;
      for (let i = 0; i < n; i++) if (chars[i].ch !== ' ') lctx.fillText(chars[i].ch, Math.round(x + chars[i].x) + dx, by + dy);
    }
  }
  function layoutLine(str) {
    let x = 0; const out = [];
    for (const ch of normalizeText(str)) { out.push({ ch, x }); x += advance(ch); }
    return { chars: out, w: Math.ceil(x) };
  }
  // Pasa la capa de texto a píxeles duros (sin medios tonos), como una letra de consola
  function crispen() {
    if (bitmap() || !STYLE.crisp) return;
    const img = lctx.getImageData(0, 0, W, H);
    const a = img.data;
    for (let i = 3; i < a.length; i += 4) a[i] = a[i] > 100 ? 255 : 0;
    lctx.putImageData(img, 0, 0);
  }

  p.draw = () => {
    p.dirty = false;
    ctx.clearRect(0, 0, W, H);
    lctx.clearRect(0, 0, W, H);
    hits = [];
    boxRect = null;
    if (!state) return;
    const { page, choices = [] } = state;
    const named = !!state.name && STYLE.nameStyle !== 'none';
    const lineCount = page.lines.length + Math.max(state.reserve ?? 0, state.choicesVisible ? choices.length : 0);
    const b = boxGeom(W, H, lineCount, named);
    const boxLines = Math.max(STYLE.lines, lineCount);
    const top = b.y + STYLE.padY + b.inside + (STYLE.valign === 'center' ? Math.floor(((boxLines - lineCount) * STYLE.lineHeight) / 2) : 0);
    const inner = b.w - STYLE.padX * 2;
    const offsetX = (chars) => {
      if (STYLE.align !== 'center' || !chars.length) return 0;
      const last = chars[chars.length - 1];
      return Math.floor((inner - (last.x + advance(last.ch) - 1)) / 2);
    };
    boxRect = b;
    // Nombre: pestañita arriba (como Ocarina) o primer renglón adentro de la caja
    if (named && STYLE.nameStyle === 'tab') {
      const n = layoutLine(state.name);
      const tw = n.w + 10, th = cellH() + 3;
      panel(b.x + 6, b.y - th + 1, tw, th, 3);
    }
    panel(b.x, b.y, b.w, b.h, STYLE.radius);
    if (named && STYLE.nameStyle === 'tab') {
      const n = layoutLine(state.name);
      const th = cellH() + 3;
      drawRun(n.chars, b.x + 11, b.y - th + 3, STYLE.name);
    }
    if (named && STYLE.nameStyle === 'inside') {
      drawRun(layoutLine(state.name).chars, b.x + STYLE.padX, b.y + STYLE.padY, STYLE.name);
    }

    let left = state.shown;
    let y = top;
    for (const line of page.lines) {
      if (left > 0) drawRun(line, b.x + STYLE.padX + offsetX(line), y, STYLE.text, left);
      left -= line.length;
      y += STYLE.lineHeight;
    }

    const cursors = [];
    if (state.choicesVisible) {
      let budget = state.choiceShown ?? Infinity;
      const picking = state.picking ?? true;
      choices.forEach((c, i) => {
        const l = layoutLine(c);
        const cx = b.x + STYLE.padX + 12;
        if (budget > 0) drawRun(l.chars, cx, y, STYLE.choice, budget);
        budget -= l.chars.length;
        if (picking) hits.push({ i, x: b.x, y: y - 1, w: b.w, h: STYLE.lineHeight });
        if (picking && i === state.sel) cursors.push(y);
        y += STYLE.lineHeight;
      });
    }
    crispen();
    ctx.drawImage(layer, 0, 0);

    // Flechita ► de la opción elegida (centrada en el renglón)
    for (const cy of cursors) {
      const ax = b.x + STYLE.padX + (reduceMotion() ? 0 : Math.round(Math.sin(blink * 8) + 1) - 1);
      const mid = cy + Math.round(Math.min(STYLE.lineHeight, cellH()) / 2) - 3;
      for (let k = 0; k < 4; k++) px(ax + k, mid + k, 1, 7 - k * 2, STYLE.cursor);
    }

    // Indicador abajo a la derecha: "sigue" o "terminó"
    if (state.more) {
      const bx = b.x + b.w - 14;
      const t = reduceMotion() ? 0 : blink;
      const bounce = Math.round((Math.sin(t * 7) + 1));
      const by = b.y + b.h - 8 + bounce - 1;
      const st = STYLE.moreStyle;
      if (state.more === 'next') {
        if (st === 'arrow') { for (let k = 0; k < 4; k++) px(bx + 1 + k + (bounce - 1), b.y + b.h - 10 + k, 1, 7 - k * 2, STYLE.more); }
        else if (st === 'dot') { const r = 2 + (reduceMotion() ? 0 : Math.round((Math.sin(t * 6) + 1) / 2)); roundRect(bx + 3 - r, b.y + b.h - 7 - r, r * 2, r * 2, r, STYLE.more); }
        else {
          for (let k = 0; k < 4; k++) px(bx + k, by + k, 7 - k * 2, 1, STYLE.more);
          if (!STYLE.border) px(bx - 1, by - 1, 9, 1, 'rgba(0,0,0,0.5)');
        }
      } else if (st === 'dot') roundRect(bx + 1, b.y + b.h - 9, 4, 4, 2, STYLE.more);
      else px(bx + 1, b.y + b.h - 8, 5, 5, STYLE.more);
    }
  };

  p.show = (next) => { state = next; p.dirty = true; };
  p.hide = () => { state = null; p.dirty = true; };
  Object.defineProperty(p, 'visible', { get: () => !!state });
  p.update = (dt) => {
    if (!state) return;
    blink += dt;
    if (!reduceMotion() && (state.more || state.choicesVisible)) p.dirty = true;
  };
  // x, y en coordenadas del lienzo: { choice: i } si tocó una opción, { box: true } si tocó la caja, null si afuera
  p.pick = (x, y) => {
    if (!state) return null;
    for (const h of hits) if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return { choice: h.i };
    if (boxRect && x >= boxRect.x && x < boxRect.x + boxRect.w && y >= boxRect.y - 16 && y < boxRect.y + boxRect.h) return { box: true };
    return null;
  };
  return p;
}

// Un texto suelto con la letra de píxeles (para muestras en el motor). Devuelve un <canvas> a escala `scale`.
export function pixelTextCanvas(text, color = '#000', scale = 2) {
  const chars = [...normalizeTextBitmap(text)];
  let w = 0;
  for (const ch of chars) w += ch === ' ' ? 3 : glyph(ch).w + 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, w) * scale; c.height = FONT_HEIGHT * scale;
  const x2 = c.getContext('2d');
  x2.fillStyle = color;
  let x = 0;
  for (const ch of chars) {
    if (ch !== ' ') {
      const g = glyph(ch);
      for (let r = 0; r < FONT_HEIGHT; r++) for (let k = 0; k < g.w; k++) if (g.rows[r] >> k & 1) x2.fillRect((x + k) * scale, r * scale, scale, scale);
    }
    x += ch === ' ' ? 3 : glyph(ch).w + 1;
  }
  return c;
}
function normalizeTextBitmap(t) { let o = ''; for (const ch of String(t)) o += SUBS[ch] ?? ch; return o; }
