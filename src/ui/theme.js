// Diseño de la interfaz del juego: un solo archivo, data/ui.json (se edita en el motor, pestaña Interfaz).
// Lo usan la caja de diálogo (textbox.js), los avisos "E Entrar" / "E Hablar" (doors.js, dialogue.js), los botones de
// acciones del personaje (player.js), la ayuda de teclas y los menús (menus.js). La vista previa del motor usa este
// mismo archivo, así que lo que ves en el editor es exactamente lo que sale en el juego.
//
// data/ui.json (todo es opcional: lo que falta toma el valor de DEFAULT_UI):
//   { "preset": "ocarina",
//     "fonts":   [ { "id": "mi_letra", "name": "Mi letra", "file": "assets/fonts/MiLetra.ttf" } ],
//     "textbox": { "font": "spleen", "fontSize": 11, "cps": 45, "blip": "suave", "box": "rgba(0,0,0,0.66)", … },
//     "hud":     { "font": "inter", "size": 15, "panel": "#fafcfc", "text": "#172023", "accent": "#0f766e", … },
//     "texts":   { "door": "Entrar", "talk": "Hablar", "key": "E" },
//     "icons":   { "door": "door", "talk": "chat", "actions": { "saludar": "wave" } } }
//
// Íconos: el nombre de uno de ICONS (dibujos propios, de línea) o "file:assets/icons/algo.png|svg" (uno importado).

// ---------- Letras ----------
// "spleen" es la letra de píxeles de la caja (ui/pixel-font.js). El resto se dibuja como texto normal.
export const BUILTIN_FONTS = {
  spleen: { name: 'Spleen · píxel (Ocarina)', bitmap: true, css: "'Press Start 2P', monospace", tag: 'píxel' },
  pressstart: { name: 'Press Start 2P', css: "'Press Start 2P', monospace", google: 'Press+Start+2P', tag: 'píxel', scale: 0.8 },
  pixelify: { name: 'Pixelify Sans', css: "'Pixelify Sans', sans-serif", google: 'Pixelify+Sans:wght@400;600', tag: 'píxel' },
  silkscreen: { name: 'Silkscreen', css: "'Silkscreen', monospace", google: 'Silkscreen', tag: 'píxel' },
  vt323: { name: 'VT323', css: "'VT323', monospace", google: 'VT323', tag: 'píxel', scale: 1.35 },
  inter: { name: 'Inter', css: "Inter, system-ui, sans-serif", google: 'Inter:wght@400;500;600;700', tag: 'moderna' },
  grotesk: { name: 'Space Grotesk', css: "'Space Grotesk', Inter, sans-serif", google: 'Space+Grotesk:wght@400;500;600;700', tag: 'moderna' },
  nunito: { name: 'Nunito', css: "Nunito, system-ui, sans-serif", google: 'Nunito:wght@500;700;800', tag: 'redondeada' },
  fredoka: { name: 'Fredoka', css: "Fredoka, system-ui, sans-serif", google: 'Fredoka:wght@400;500;600', tag: 'redondeada' },
  cinzel: { name: 'Cinzel', css: "Cinzel, Georgia, serif", google: 'Cinzel:wght@500;700', tag: 'fantasía' },
  medieval: { name: 'MedievalSharp', css: "MedievalSharp, Georgia, serif", google: 'MedievalSharp', tag: 'fantasía' },
  garamond: { name: 'EB Garamond', css: "'EB Garamond', Georgia, serif", google: 'EB+Garamond:wght@400;500;700', tag: 'clásica' },
  georgia: { name: 'Georgia', css: "Georgia, 'Times New Roman', serif", tag: 'del sistema' },
  mono: { name: 'Monoespaciada', css: "ui-monospace, Menlo, Consolas, monospace", tag: 'del sistema' },
  system: { name: 'Del sistema', css: "system-ui, -apple-system, 'Segoe UI', sans-serif", tag: 'del sistema' },
};
const customFamily = (id) => `cf_${String(id).replace(/[^\w-]/g, '_')}`;

// Lista completa (las de fábrica + las importadas en ui.json)
export function fontList(theme = current) {
  const out = Object.entries(BUILTIN_FONTS).map(([id, f]) => ({ id, ...f }));
  for (const f of theme?.fonts ?? []) out.push({ id: f.id, name: f.name ?? f.id, file: f.file, css: `'${customFamily(f.id)}', system-ui, sans-serif`, tag: 'importada', custom: true });
  return out;
}
export function fontCSS(id, theme = current) {
  if (!id) return BUILTIN_FONTS.inter.css;
  if (BUILTIN_FONTS[id]) return BUILTIN_FONTS[id].css;
  if ((theme?.fonts ?? []).some((f) => f.id === id)) return `'${customFamily(id)}', system-ui, sans-serif`;
  return `${/[\s,'"]/.test(id) ? id : `'${id}'`}, system-ui, sans-serif`; // un nombre de familia escrito a mano
}
export const fontScale = (id) => BUILTIN_FONTS[id]?.scale ?? 1;

const loaded = new Map();
let base = ''; // prefijo de las rutas (el motor usa "/" porque vive en /studio/editor/)
export function setAssetBase(b) { base = b; }
const url = (p) => `${base}${String(p).replace(/^\/+/, '')}`;

// Carga una letra (de Google Fonts o un archivo importado). Devuelve una promesa que termina cuando ya se puede dibujar.
export function ensureFont(id, theme = current, doc = document) {
  const key = `${id}|${doc === document ? '' : 'x'}`;
  if (loaded.has(key)) return loaded.get(key);
  let p = Promise.resolve();
  const b = BUILTIN_FONTS[id];
  if (b?.google) {
    const l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.href = `https://fonts.googleapis.com/css2?family=${b.google}&display=swap`;
    doc.head.appendChild(l);
    p = new Promise((res) => { l.onload = res; l.onerror = res; setTimeout(res, 3000); })
      .then(() => doc.fonts?.load(`16px ${b.css.split(',')[0]}`)).catch(() => {});
  } else {
    const f = (theme?.fonts ?? []).find((x) => x.id === id);
    if (f?.file && typeof FontFace !== 'undefined') {
      const ff = new FontFace(customFamily(id), `url("${url(f.file)}")`);
      p = ff.load().then((x) => { doc.fonts.add(x); }).catch((err) => console.warn(`Letra ${f.file}:`, err.message));
    }
  }
  loaded.set(key, p);
  return p;
}

// ---------- Íconos (dibujos propios, de línea, 24x24) ----------
export const ICONS = {
  door: 'M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21M3 21h18M14.5 12.5v.01',
  arch: 'M5 21V10a7 7 0 0 1 14 0v11M3 21h18M9 21v-6a3 3 0 0 1 6 0v6',
  enter: 'M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5',
  chat: 'M4 5h16v10H9l-5 4z',
  talk: 'M7 9h10M7 13h6M21 12a8 8 0 0 1-11.8 7L4 20l1-4.2A8 8 0 1 1 21 12z',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5v-6a1.5 1.5 0 0 1 3 0V11m0-4.5a1.5 1.5 0 0 1 3 0V11m0-2.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L5 15.5a1.6 1.6 0 0 1 2.6-1.9L8 14',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  wave: 'M7 11.5V6a1.5 1.5 0 0 1 3 0v5M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V5.5a1.5 1.5 0 0 1 3 0V12M16 9.5a1.5 1.5 0 0 1 3 0v4.5a7 7 0 0 1-7 7 6 6 0 0 1-5-2.6l-3-4.4a1.6 1.6 0 0 1 2.6-1.8L7 13.5M3 7c.5-1.5 1.5-2.5 3-3M20 3c1 .6 1.6 1.4 2 2.5',
  bed: 'M3 19V6M3 15h18v4M21 15v-3a3 3 0 0 0-3-3h-7v6M7 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  sit: 'M8 4a2 2 0 1 0 0 .01M8 8v6h7l2 6M8 11h5M5 20h4',
  run: 'M14 4a2 2 0 1 0 0 .01M6 20l3-5 3 2 1-5 3 3h3M10 9l3-1 2 3M5 12l3-3',
  jump: 'M12 3a2 2 0 1 0 0 .01M9 21l2-6M15 21l-2-6M7 9l5 2 5-2M12 11v4M3 21h18',
  dance: 'M12 3a2 2 0 1 0 0 .01M8 21l3-7M16 21l-2-7M5 7l4 3h6l4-3M12 10v4',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  heart: 'M12 20s-7.5-4.6-9.2-9.2A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 9.2 4.2C19.5 15.4 12 20 12 20z',
  key: 'M15.5 8.5a4 4 0 1 1-5.4 3.8L3 19.4V21h3v-2h2v-2h2l1.7-1.7A4 4 0 0 1 15.5 8.5zM17 7.5v.01',
  chest: 'M3 10h18v10H3zM3 10V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v2M10 10v3h4v-3',
  coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1.1 0-2.1-.6-2.5-1.5M12 6.5V8M12 16v1.5',
  gem: 'M6 3h12l3 6-9 12L3 9zM3 9h18M9 3l3 18M15 3l-3 18',
  sword: 'M14.5 3H21v6.5L10 20.5 3.5 14zM5 19l-2 2M7.5 16.5 4 13M7.5 16.5l3.5 3.5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  bow: 'M5 3c9 0 16 7 16 16M5 3l16 16M5 3v4M5 3h4M14 10l-9 9M3 21l2-2',
  potion: 'M9 3h6M10 3v5L5 17a3 3 0 0 0 2.6 4h8.8A3 3 0 0 0 19 17l-5-9V3M7 14h10',
  bag: 'M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  home: 'M3 11l9-8 9 8M5 9.5V21h14V9.5M10 21v-6h4v6',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  ocarina: 'M4 13a8 6 0 0 1 14-4l3-2v4l-1.5 1A8 6 0 0 1 4 13zM9 12v.01M12 11v.01M12 15v.01M15 13v.01',
  book: 'M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-5a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h5z',
  scroll: 'M8 4h11a2 2 0 0 1 0 4h-1v11a2 2 0 0 1-2 2H6a2 2 0 0 1 0-4h1V6a2 2 0 0 0-2-2M5 4a2 2 0 0 0-2 2v1h4M10 11h5M10 14h5',
  letter: 'M3 5h18v14H3zM3 6l9 7 9-7',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8v.01',
  question: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01',
  alert: 'M12 3 2 20h20zM12 10v4M12 17v.01',
  check: 'M4 12.5 9.5 18 20 6',
  x: 'M6 6l12 12M18 6 6 18',
  play: 'M7 4v16l13-8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1.5v2M12 20.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1.5 12h2M20.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  leaf: 'M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19 14 10',
  fish: 'M2 12c3-4 7-6 11-6 4 0 7 3 8 6-1 3-4 6-8 6-4 0-8-2-11-6zM2 12l-1 4M2 12l-1-4M16 11v.01',
  hammer: 'M14 6 4 16l4 4L18 10M12 4l8 8 2-2-8-8z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  hourglass: 'M6 3h12M6 21h12M7 3c0 5 10 6 10 9s-10 4-10 9M17 3c0 5-10 6-10 9s10 4 10 9',
  person: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
};
export const ICON_GROUPS = [
  ['Lugares', ['door', 'arch', 'enter', 'home', 'map', 'compass', 'flag']],
  ['Hablar y mirar', ['chat', 'talk', 'eye', 'search', 'hand', 'question', 'info', 'alert', 'letter']],
  ['Acciones', ['wave', 'bed', 'sit', 'run', 'jump', 'dance', 'camera', 'music', 'ocarina']],
  ['Objetos', ['key', 'chest', 'coin', 'gem', 'sword', 'shield', 'bow', 'potion', 'bag', 'book', 'scroll', 'hammer', 'bell', 'hourglass', 'fish', 'leaf']],
  ['Interfaz', ['star', 'heart', 'gear', 'check', 'x', 'play', 'pause', 'arrow', 'up', 'sun', 'moon', 'person']],
];
const escAttr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const escHTML = escAttr;

// HTML de un ícono: uno de ICONS o "file:ruta" (imagen importada). size en px (o "1em").
export function iconHTML(ref, { size = '1.15em', stroke = 2, cls = 'ui-ic' } = {}) {
  if (!ref) return '';
  const s = typeof size === 'number' ? `${size}px` : size;
  if (String(ref).startsWith('file:')) {
    const p = String(ref).slice(5);
    return `<img class="${cls}" src="${escAttr(url(p))}" alt="" style="width:${s};height:${s};object-fit:contain">`;
  }
  const d = ICONS[ref];
  if (!d) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

// ---------- Tema por defecto y estilos de partida ----------
export const DEFAULT_UI = {
  preset: 'ocarina',
  fonts: [],
  textbox: {
    font: 'spleen', fontSize: 11, bold: false, crisp: true,
    cps: 45, blip: 'ninguno', blipPitch: 1,
    lines: 4, valign: 'center', align: 'left', position: 'bottom',
    lineHeight: 13, maxWidth: 256, padX: 12, padY: 7, padBottom: 10, bottom: 10, radius: 5,
    box: 'rgba(0, 0, 0, 0.66)', border: '', borderWidth: 1,
    text: '#ffffff', shadow: 'rgba(0, 0, 0, 0.85)',
    name: '#f7d774', nameStyle: 'tab', choice: '#6be36b', cursor: '#58d6ff', more: '#58e070', moreStyle: 'triangle',
    baseHeight: 240,
  },
  hud: {
    font: 'inter', size: 15, weight: 500, uppercase: false,
    panel: 'rgba(250, 252, 252, 0.92)', text: '#172023', muted: '#5b6b70', accent: '#0f766e', border: '#cdd7da',
    radius: 10, blur: true, shadow: false,
    keyStyle: 'outline', promptBottom: 18, promptIcon: true,
    actionsSide: 'right', showActions: true, showHint: true,
  },
  texts: { door: 'Entrar', talk: 'Hablar', key: 'E' },
  icons: { door: 'door', talk: 'chat', actions: {} },
};

// Estilos completos para empezar (cambian caja + avisos; las letras importadas y los textos se conservan)
export const PRESETS = {
  ocarina: { name: 'Ocarina', desc: 'Caja negra translúcida, letra de píxeles, opciones verdes', textbox: {}, hud: {} },
  pergamino: {
    name: 'Pergamino', desc: 'Papel antiguo, tinta oscura y letra de fantasía',
    textbox: { font: 'garamond', fontSize: 12, bold: true, crisp: false, box: '#efe2c2', border: '#7a5a2e', borderWidth: 2, text: '#3b2a16', shadow: '', name: '#8c2f1b', choice: '#245c2f', cursor: '#8c2f1b', more: '#7a5a2e', radius: 3, lineHeight: 14 },
    hud: { font: 'cinzel', panel: 'rgba(239, 226, 194, 0.95)', text: '#3b2a16', muted: '#6d5638', accent: '#8c2f1b', border: '#7a5a2e', radius: 4, blur: false, shadow: true, keyStyle: 'solid' },
  },
  moderno: {
    name: 'Moderno', desc: 'Tarjeta blanca, esquinas suaves, letra limpia',
    textbox: { font: 'inter', fontSize: 10, bold: true, crisp: false, box: 'rgba(255, 255, 255, 0.94)', text: '#1b2224', shadow: '', name: '#0f766e', nameStyle: 'inside', choice: '#0f766e', cursor: '#0f766e', more: '#0f766e', moreStyle: 'dot', radius: 10, lineHeight: 13, padX: 14 },
    hud: { font: 'inter', panel: 'rgba(255, 255, 255, 0.94)', text: '#1b2224', accent: '#0f766e', border: '#d8e0e2', radius: 999, shadow: true, keyStyle: 'round' },
  },
  noche: {
    name: 'Noche', desc: 'Azul profundo con bordes y acentos celestes',
    textbox: { font: 'spleen', box: 'rgba(10, 18, 40, 0.86)', border: '#5ec8ff', borderWidth: 1, text: '#e8f1ff', name: '#ffd479', choice: '#7fe0ff', cursor: '#ffd479', more: '#7fe0ff', radius: 4 },
    hud: { font: 'grotesk', panel: 'rgba(10, 18, 40, 0.82)', text: '#e8f1ff', muted: '#9db0d0', accent: '#5ec8ff', border: '#2c4470', radius: 8, keyStyle: 'solid' },
  },
  gameboy: {
    name: 'Portátil', desc: 'Cuatro verdes, todo en píxeles, sin transparencias',
    textbox: { font: 'pressstart', fontSize: 7, box: '#9bbc0f', border: '#0f380f', borderWidth: 2, text: '#0f380f', shadow: '', name: '#0f380f', choice: '#306230', cursor: '#0f380f', more: '#0f380f', moreStyle: 'arrow', radius: 0, lineHeight: 12, nameStyle: 'inside' },
    hud: { font: 'pressstart', size: 11, panel: '#9bbc0f', text: '#0f380f', muted: '#306230', accent: '#0f380f', border: '#0f380f', radius: 0, blur: false, keyStyle: 'solid', uppercase: true },
  },
  cuento: {
    name: 'Cuento', desc: 'Redondeado y cálido, para un juego amable',
    textbox: { font: 'fredoka', fontSize: 11, crisp: false, box: 'rgba(255, 248, 236, 0.96)', border: '#f0a35e', borderWidth: 2, text: '#4a3424', shadow: '', name: '#e06d3a', nameStyle: 'tab', choice: '#2f8f6a', cursor: '#e06d3a', more: '#e06d3a', moreStyle: 'dot', radius: 12, lineHeight: 14 },
    hud: { font: 'fredoka', panel: 'rgba(255, 248, 236, 0.96)', text: '#4a3424', muted: '#8a6a52', accent: '#e06d3a', border: '#f0c79a', radius: 16, shadow: true, keyStyle: 'round' },
  },
  contraste: {
    name: 'Alto contraste', desc: 'Para leer mejor: negro puro, amarillo y letra grande',
    textbox: { font: 'spleen', box: '#000000', border: '#ffffff', borderWidth: 1, text: '#ffffff', shadow: '', name: '#ffe500', choice: '#ffe500', cursor: '#ffffff', more: '#ffe500', baseHeight: 200, cps: 30 },
    hud: { font: 'inter', size: 18, weight: 600, panel: '#000000', text: '#ffffff', muted: '#dddddd', accent: '#ffe500', border: '#ffffff', radius: 6, blur: false, keyStyle: 'solid' },
  },
};

// Junta el archivo con los valores por defecto (nunca devuelve campos sin valor)
export function resolveUI(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    preset: r.preset ?? DEFAULT_UI.preset,
    fonts: Array.isArray(r.fonts) ? r.fonts.filter((f) => f && f.id) : [],
    textbox: { ...DEFAULT_UI.textbox, ...(r.textbox ?? {}) },
    hud: { ...DEFAULT_UI.hud, ...(r.hud ?? {}) },
    texts: { ...DEFAULT_UI.texts, ...(r.texts ?? {}) },
    icons: { ...DEFAULT_UI.icons, ...(r.icons ?? {}), actions: { ...(r.icons?.actions ?? {}) } },
  };
}
export function applyPreset(raw, id) {
  const p = PRESETS[id];
  if (!p) return raw;
  return { ...raw, preset: id, textbox: { ...DEFAULT_UI.textbox, ...p.textbox, cps: raw.textbox?.cps ?? DEFAULT_UI.textbox.cps, blip: raw.textbox?.blip ?? DEFAULT_UI.textbox.blip }, hud: { ...DEFAULT_UI.hud, ...p.hud } };
}

// ---------- Tema activo ----------
let current = resolveUI();
export const getUI = () => current;
export const uiText = (k) => current.texts[k] ?? DEFAULT_UI.texts[k] ?? '';
export const actionIcon = (id) => current.icons.actions?.[id] ?? '';

// HTML de un aviso: [tecla] [ícono] texto  (el texto se escapa: viene de archivos del juego)
export function promptHTML({ key = uiText('key'), label = '', icon = '' } = {}) {
  const ic = current.hud.promptIcon && icon ? iconHTML(icon) : '';
  return `<kbd>${escAttr(key)}</kbd>${ic}<span>${escAttr(label)}</span>`;
}

// CSS que pinta los avisos, la ayuda y los botones con el tema. `scope` = selector del contenedor del juego.
export function themeCSS(t = current, scope = '.app') {
  const h = t.hud;
  const fam = fontCSS(h.font, t);
  const size = Math.round((h.size ?? 15) * fontScale(h.font));
  const r = Number(h.radius) || 0;
  const key = h.keyStyle === 'solid'
    ? `background:${h.accent};color:${h.panel};border:1px solid ${h.accent};border-radius:${Math.min(r, 6)}px;`
    : h.keyStyle === 'round'
      ? `background:${h.accent};color:${h.panel};border:0;border-radius:999px;min-width:1.7em;text-align:center;`
      : `background:transparent;color:${h.text};border:1px solid ${h.accent};border-radius:${Math.min(r, 4)}px;`;
  const blur = h.blur ? 'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' : 'backdrop-filter:none;-webkit-backdrop-filter:none;';
  const shadow = h.shadow ? 'box-shadow:0 6px 22px rgba(0,0,0,.22);' : 'box-shadow:none;';
  const up = h.uppercase ? 'text-transform:uppercase;letter-spacing:.04em;' : '';
  return `
${scope} .door-prompt, ${scope} .talk-prompt, ${scope} .actions button, ${scope} .hint {
  font-family:${fam}; font-weight:${h.weight ?? 500}; background:${h.panel}; color:${h.text}; border:1px solid ${h.border};
  border-radius:${r}px; ${blur} ${shadow} ${up} }
${scope} .door-prompt, ${scope} .talk-prompt { font-size:${size}px; bottom:${h.promptBottom ?? 18}%; gap:.55em; cursor:pointer; }
${scope} .door-prompt kbd, ${scope} .talk-prompt kbd, ${scope} .actions kbd, ${scope} .hint kbd {
  font:600 .82em ${fam}; padding:.15em .5em; ${key} }
${scope} .hint { color:${h.muted ?? h.text}; font-size:${Math.max(10, size - 3)}px; ${h.showHint ? '' : 'display:none !important;'} }
${scope} .hint b { color:${h.text}; }
${scope} .actions { ${h.actionsSide === 'left' ? 'left:12px;right:auto;' : 'right:12px;left:auto;'} ${h.showActions ? '' : 'display:none !important;'} }
${scope} .actions button { font-size:${Math.max(10, size - 2)}px; display:flex; align-items:center; gap:.5em; }
${scope} .actions button:hover { border-color:${h.accent}; }
${scope} .ui-ic { flex:none; color:${h.accent}; }
`;
}

// Aplica el tema a la página del juego: guarda el activo, carga las letras y pone el CSS.
export function applyUI(raw, { doc = document, scope = '.app' } = {}) {
  current = resolveUI(raw);
  let st = doc.getElementById('ui-theme');
  if (!st) { st = doc.createElement('style'); st.id = 'ui-theme'; doc.head.appendChild(st); }
  st.textContent = themeCSS(current, scope);
  const fonts = new Set([current.hud.font, current.textbox.font]);
  return Promise.all([...fonts].map((f) => ensureFont(f, current, doc))).then(() => current);
}

// ---------- Sonido de las letras (como el "bip" de las charlas de la época), sintetizado: no usa archivos ----------
let actx = null;
const BLIPS = {
  suave: { type: 'sine', f: 520, dur: 0.035, vol: 0.05 },
  retro: { type: 'square', f: 440, dur: 0.03, vol: 0.025 },
  grave: { type: 'triangle', f: 220, dur: 0.05, vol: 0.07 },
  madera: { type: 'triangle', f: 880, dur: 0.02, vol: 0.05 },
};
export const BLIP_KINDS = [['ninguno', 'Sin sonido'], ['suave', 'Suave'], ['retro', 'Retro (8 bits)'], ['grave', 'Grave'], ['madera', 'Madera']];
export function blip(kind = current.textbox.blip, pitch = current.textbox.blipPitch ?? 1, volume = 1) {
  const b = BLIPS[kind];
  if (!b) return;
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = b.type;
    o.frequency.value = b.f * pitch * (0.97 + Math.random() * 0.06);
    g.gain.setValueAtTime(b.vol * volume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + b.dur);
    o.connect(g).connect(actx.destination);
    o.start(t); o.stop(t + b.dur + 0.01);
  } catch { /* sin audio */ }
}
