// Pantalla de carga (index.html): se ve desde el primer instante (está en el HTML, no espera al código)
// hasta que aparece el menú, otra vez mientras se arma el mundo después de elegir, y cada vez que algo tarda en
// cargar (entrar a una casa, cambiar de escena: ver withLoading en game.js). La barra avanza con lo que va bajando (THREE.DefaultLoadingManager).
import * as THREE from 'three';

const el = () => document.getElementById('boot');
let done = 0, total = 0, base = 0; // base: lo que ya estaba cargado cuando se volvió a mostrar

const mgr = THREE.DefaultLoadingManager;
const prevStart = mgr.onStart, prevProgress = mgr.onProgress;

// Qué se está bajando ahora: los .glb y texturas (LoadingManager) y los .json (assets.js avisa con 'coronda:carga').
// Se muestra abajo, en chiquito: "Cargando Coronda_Plaza.glb, personaje.glb · 12 de 30"
const enCurso = new Map(); // url -> veces
let ultimo = '', listos = 0, pedidos = 0;
const nombre = (url) => {
  const s = String(url ?? '');
  if (/^(blob|data):/.test(s)) return null; // texturas de adentro de un .glb: no tienen nombre propio
  try { return decodeURIComponent(s.split(/[?#]/)[0].split('/').pop()) || null; } catch { return s.split('/').pop(); }
};
function empieza(url) { const n = nombre(url); if (!n) return; enCurso.set(n, (enCurso.get(n) ?? 0) + 1); pedidos++; archivos(); }
function termina(url) {
  const n = nombre(url); if (!n) return;
  const v = (enCurso.get(n) ?? 1) - 1;
  if (v > 0) enCurso.set(n, v); else enCurso.delete(n);
  ultimo = n; listos++; archivos();
}
for (const k of ['itemStart', 'itemEnd', 'itemError']) {
  const orig = mgr[k].bind(mgr);
  mgr[k] = (url) => { orig(url); if (k === 'itemStart') empieza(url); else if (k === 'itemEnd') termina(url); }; // con error three llama a itemError y después a itemEnd
}
addEventListener('coronda:carga', (e) => (e.detail?.on ? empieza(e.detail.url) : termina(e.detail?.url)));
function archivos() {
  const b = el();
  if (!b || b.hidden) return;
  let f = b.querySelector('.boot-files');
  if (!f) { f = document.createElement('div'); f.className = 'boot-files'; f.setAttribute('aria-hidden', 'true'); b.append(f); }
  const lista = [...enCurso.keys()];
  const cuenta = pedidos ? ` · ${listos} de ${pedidos}` : '';
  f.textContent = lista.length
    ? `Cargando ${lista.slice(-3).join(', ')}${lista.length > 3 ? ` y ${lista.length - 3} más` : ''}${cuenta}`
    : ultimo ? `Listo: ${ultimo}${cuenta}` : '';
}
mgr.onStart = (url, loaded, all) => { prevStart?.(url, loaded, all); total = all; done = loaded; paint(); };
mgr.onProgress = (url, loaded, all) => { prevProgress?.(url, loaded, all); total = all; done = loaded; paint(); };

// dev.html no la trae en el HTML: se arma la primera vez que hace falta (al cambiar de escena)
function make() {
  const b = document.createElement('div');
  b.className = 'boot'; b.id = 'boot'; b.hidden = true;
  b.setAttribute('role', 'status'); b.setAttribute('aria-live', 'polite');
  b.innerHTML = '<div class="boot-card"><div class="boot-title">Coronda</div><div class="boot-bar"><i></i></div><div class="boot-text">Cargando…</div><div class="boot-tip" hidden></div></div>';
  document.body.append(b);
  return b;
}

function paint() {
  const b = el();
  if (!b) return;
  const bar = b.querySelector('.boot-bar i');
  const all = total - base;
  if (bar && all > 0) bar.style.width = `${Math.max(8, Math.round(((done - base) / all) * 100))}%`;
}

export const boot = {
  // Muestra la pantalla con un texto (si estaba oculta, vuelve a aparecer)
  show(text, { tip = true } = {}) {
    const b = el() ?? make();
    if (!b) return;
    b.hidden = false;
    const tipEl = b.querySelector('.boot-tip');
    if (tipEl) tipEl.hidden = !tip;
    base = done;
    listos = 0; pedidos = enCurso.size; ultimo = ''; archivos(); // la cuenta arranca de nuevo con esta carga
    b.classList.remove('boot-out');
    if (text) b.querySelector('.boot-text').textContent = text;
    const bar = b.querySelector('.boot-bar i');
    if (bar) bar.style.width = '8%';
  },
  text(t) { const b = el(); if (b) b.querySelector('.boot-text').textContent = t; },
  // Se saca enseguida (abajo ya hay un fundido a negro que se encarga de la transición)
  hideNow() {
    const b = el();
    if (b) { b.classList.remove('boot-out'); b.hidden = true; }
    return new Promise((r) => requestAnimationFrame(() => r()));
  },
  // Se apaga con un fundido
  hide() {
    const b = el();
    if (!b || b.hidden) return;
    b.classList.add('boot-out');
    setTimeout(() => { if (b.classList.contains('boot-out')) b.hidden = true; }, 450);
  },
};
