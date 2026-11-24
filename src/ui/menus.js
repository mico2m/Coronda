// Menús del juego: pantalla de título, pausa y opciones. Se definen en data/menus.json (se editan en el motor, pestaña Menús).
//
// data/menus.json:
//   { "settings": { "titleOnStart": true, "pause": true, "accent": "#ffd34d", "font": "moderna" | "pixel" | "clasica" | una letra de data/ui.json },
//     "menus": {
//       "titulo": { "kind": "title", "title": "Coronda", "subtitle": "…", "backdrop": "scene" | "color" | "image",
//                   "background": "#0b1424", "image": "assets/textures/titulo.png", "music": "id de music.json",
//                   "items": [ { "label": "Jugar", "action": "start" }, { "label": "Opciones", "action": "menu:opciones" } ] },
//       "pausa":   { "kind": "pause", … }, "opciones": { "kind": "panel", … } } }
//
// Acciones de un ítem: start · newgame (borra los flags y empieza) · resume · back · title · menu:<id> · scene:<id> ·
//                      volume (barra de volumen de la música) · fullscreen
import { fontCSS, ensureFont as ensureThemeFont } from './theme.js';

const FONTS = {
  moderna: "'Space Grotesk', Inter, system-ui, sans-serif",
  clasica: "Georgia, 'Times New Roman', serif",
  pixel: "'Press Start 2P', 'Space Grotesk', monospace",
};
const CSS = `
.cm { position: absolute; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; color: #fff;
  font-family: var(--cm-font); -webkit-font-smoothing: antialiased; user-select: none; }
.cm.bg-scene { background: radial-gradient(ellipse at center, rgba(5,8,18,.35), rgba(5,8,18,.78)); }
.cm.bg-pause { background: rgba(5,8,18,.55); backdrop-filter: blur(3px); }
.cm .cm-in { display: flex; flex-direction: column; align-items: center; gap: clamp(14px, 3.2vh, 30px); padding: 4vh 5vw; max-width: 92%; animation: cm-in .35s ease-out; }
.cm.k-pause .cm-in, .cm.k-panel .cm-in { background: rgba(10,14,28,.72); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 4vh 4.5vw; min-width: min(420px, 80%); box-shadow: 0 20px 60px rgba(0,0,0,.45); }
.cm h1 { margin: 0; font-size: clamp(30px, 8.5vh, 92px); font-weight: 600; letter-spacing: -.02em; text-align: center; line-height: 1; text-shadow: 0 4px 24px rgba(0,0,0,.45); }
.cm.k-pause h1, .cm.k-panel h1 { font-size: clamp(20px, 4.6vh, 44px); }
.cm .cm-sub { margin: -0.6em 0 0; font-size: clamp(12px, 2.2vh, 20px); opacity: .78; text-align: center; letter-spacing: .02em; }
.cm ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: clamp(4px, 1vh, 10px); min-width: 220px; }
.cm li { position: relative; display: flex; align-items: center; justify-content: center; gap: 12px; padding: .5em 1.6em; border-radius: 9px; cursor: pointer;
  font-size: clamp(14px, 2.6vh, 24px); color: rgba(255,255,255,.72); transition: color .12s, background .12s; }
.cm li.on { color: var(--cm-accent); background: rgba(255,255,255,.07); }
.cm li.on::before { content: '▶'; position: absolute; left: .45em; font-size: .62em; animation: cm-blink 1s steps(2) infinite; }
.cm .cm-vol { display: inline-flex; gap: 3px; }
.cm .cm-vol i { width: .55em; height: .9em; border-radius: 2px; background: rgba(255,255,255,.22); }
.cm .cm-vol i.f { background: currentColor; }
.cm .cm-hint { position: absolute; bottom: 3vh; left: 0; right: 0; text-align: center; font-size: clamp(10px, 1.6vh, 14px); opacity: .55; letter-spacing: .04em; }
.cm-open .actions, .cm-open .hint, .cm-open .door-prompt, .cm-open .pad { visibility: hidden; }
.cm.font-pixel h1 { font-size: clamp(22px, 6vh, 62px); letter-spacing: 0; }
.cm.font-pixel li { font-size: clamp(10px, 2vh, 18px); }
@keyframes cm-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes cm-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .cm .cm-in, .cm li.on::before { animation: none; } }
`;
let cssDone = false;
function ensureCss() {
  if (cssDone) return; cssDone = true;
  const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
}
function ensureFont(font) {
  if (!FONTS[font]) { ensureThemeFont(font); return; } // una letra de la pestaña Interfaz (de Google o importada)
  if (font !== 'pixel' || document.getElementById('cm-pixel-font')) return;
  const l = document.createElement('link'); l.id = 'cm-pixel-font'; l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap';
  document.head.appendChild(l);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const DEFAULT_MENUS = {
  settings: { titleOnStart: true, pause: true, accent: '#ffd34d', font: 'moderna' },
  menus: {
    titulo: { kind: 'title', title: 'Coronda', subtitle: '', backdrop: 'scene', background: '#0b1424', items: [{ label: 'Jugar', action: 'start' }, { label: 'Opciones', action: 'menu:opciones' }] },
    pausa: { kind: 'pause', title: 'Pausa', items: [{ label: 'Continuar', action: 'resume' }, { label: 'Opciones', action: 'menu:opciones' }, { label: 'Volver al título', action: 'title' }] },
    opciones: { kind: 'panel', title: 'Opciones', items: [{ label: 'Música', action: 'volume' }, { label: 'Pantalla completa', action: 'fullscreen' }, { label: 'Volver', action: 'back' }] },
  },
};

// Dibuja un menú dentro de `host`. state: { volume } · onAction(action, item) · onPick(index) (vista previa del editor)
export function renderMenu(host, def, { settings = {}, volume = 0.6, selected = 0, onAction, onPick, preview = false } = {}) {
  ensureCss();
  const font = settings.font ?? 'moderna';
  ensureFont(font);
  const el = document.createElement('div');
  const kind = def.kind ?? 'panel';
  const back = def.backdrop ?? (kind === 'title' ? 'scene' : 'pause');
  el.className = `cm k-${kind} font-${font} ${back === 'scene' ? 'bg-scene' : kind === 'title' ? '' : 'bg-pause'}`;
  el.style.setProperty('--cm-accent', settings.accent ?? '#ffd34d');
  el.style.setProperty('--cm-font', FONTS[font] ?? fontCSS(font));
  if (back === 'color') el.style.background = def.background ?? '#0b1424';
  if (back === 'image' && def.image) el.style.background = `#000 url("/${String(def.image).replace(/^\/+/, '')}") center / cover no-repeat`;
  let sel = Math.min(selected, Math.max(0, (def.items ?? []).length - 1));
  let vol = volume;
  const items = def.items ?? [];
  const volBar = () => `<span class="cm-vol">${Array.from({ length: 10 }, (_, i) => `<i class="${i < Math.round(vol * 10) ? 'f' : ''}"></i>`).join('')}</span>`;
  function draw() {
    el.innerHTML = `<div class="cm-in">
      ${def.title ? `<h1>${esc(def.title)}</h1>` : ''}${def.subtitle ? `<p class="cm-sub">${esc(def.subtitle)}</p>` : ''}
      <ul>${items.map((it, i) => `<li class="${i === sel ? 'on' : ''}" data-i="${i}">${esc(it.label)}${it.action === 'volume' ? volBar() : ''}</li>`).join('')}</ul></div>
      ${kind === 'title' && !preview ? '<div class="cm-hint">↑ ↓ elegir · Enter aceptar</div>' : ''}`;
  }
  draw();
  el.addEventListener('pointermove', (e) => { const li = e.target.closest('li'); if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; draw(); } });
  el.addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    sel = +li.dataset.i; draw();
    if (preview) { onPick?.(sel); return; }
    act();
  });
  function act() { const it = items[sel]; if (it) onAction?.(it.action, it); }
  function key(e) {
    const k = e.code;
    if (k === 'ArrowDown' || k === 'KeyS') { sel = (sel + 1) % Math.max(1, items.length); draw(); return true; }
    if (k === 'ArrowUp' || k === 'KeyW') { sel = (sel - 1 + items.length) % Math.max(1, items.length); draw(); return true; }
    const it = items[sel];
    if (it?.action === 'volume' && (k === 'ArrowLeft' || k === 'KeyA' || k === 'ArrowRight' || k === 'KeyD')) {
      vol = Math.max(0, Math.min(1, Math.round((vol + (k === 'ArrowRight' || k === 'KeyD' ? 0.1 : -0.1)) * 10) / 10));
      draw(); onAction?.('volume:set', { value: vol }); return true;
    }
    if (k === 'Enter' || k === 'KeyE' || k === 'Space') { if (it?.action === 'volume') { vol = vol >= 1 ? 0 : Math.round((vol + 0.1) * 10) / 10; draw(); onAction?.('volume:set', { value: vol }); } else act(); return true; }
    if (k === 'Escape' || k === 'Backspace') { onAction?.('back'); return true; }
    return false;
  }
  host.appendChild(el);
  return { el, key, destroy: () => el.remove(), select: (i) => { sel = i; draw(); } };
}

// Controlador de menús del juego
export function createMenus({ host, defs, audio, onStart, onScene, onPauseChange }) {
  const data = { settings: { ...DEFAULT_MENUS.settings, ...(defs?.settings ?? {}) }, menus: defs?.menus ?? DEFAULT_MENUS.menus };
  let stack = [];      // ids abiertos (el último es el visible)
  let view = null;
  let mode = null;     // 'title' | 'pause' | null
  let volume = 0.6;
  try { const v = Number(localStorage.getItem('coronda.volumen')); if (localStorage.getItem('coronda.volumen') !== null && Number.isFinite(v)) volume = v; } catch { /* sin almacenamiento */ }
  audio?.setVolume(volume);

  function show(id) {
    view?.destroy();
    const def = data.menus[id];
    if (!def) { view = null; return; }
    view = renderMenu(host, def, { settings: data.settings, volume, onAction });
  }
  function open(id, m) { mode = m; stack = [id]; show(id); host.classList.add('cm-open'); }
  function close() { view?.destroy(); view = null; stack = []; host.classList.remove('cm-open'); const was = mode; mode = null; if (was === 'pause') onPauseChange?.(false); }
  function onAction(action, item) {
    if (!action) return;
    if (action === 'volume:set') { volume = item.value; audio?.setVolume(volume); try { localStorage.setItem('coronda.volumen', String(volume)); } catch { /* */ } return; }
    if (action === 'start' || action === 'newgame') {
      if (action === 'newgame') { try { window.flags?.reset?.(); } catch { /* */ } }
      close(); onStart?.(); return;
    }
    if (action === 'resume') { close(); return; }
    if (action === 'back') {
      if (stack.length > 1) { stack.pop(); show(stack.at(-1)); } else if (mode === 'pause') close();
      return;
    }
    if (action === 'title') { location.reload(); return; }
    if (action === 'fullscreen') { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())?.catch?.(() => {}); return; }
    if (action.startsWith('menu:')) { const id = action.slice(5); if (data.menus[id]) { stack.push(id); show(id); } return; }
    if (action.startsWith('scene:')) { close(); onScene?.(action.slice(6)); return; }
  }
  window.addEventListener('keydown', (e) => {
    if (view) { if (view.key(e)) { e.preventDefault(); e.stopImmediatePropagation(); } return; }
  }, true);

  const titleId = Object.keys(data.menus).find((k) => data.menus[k].kind === 'title');
  const pauseId = Object.keys(data.menus).find((k) => data.menus[k].kind === 'pause');
  return {
    get open() { return !!view; },
    get paused() { return mode === 'pause' || mode === 'title'; },
    get isTitle() { return mode === 'title'; },
    get titleOnStart() { return !!data.settings.titleOnStart && !!titleId; },
    get canPause() { return !!data.settings.pause && !!pauseId; },
    showTitle() {
      if (!titleId) return false;
      const def = data.menus[titleId];
      if (def.music) audio?.playMusic(def.music);
      open(titleId, 'title');
      return true;
    },
    pause() { if (!pauseId || view) return; open(pauseId, 'pause'); onPauseChange?.(true); },
    close,
  };
}
