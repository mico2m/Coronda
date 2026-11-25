// Pantalla de carga (index.html): se ve desde el primer instante (está en el HTML, no espera al código)
// hasta que aparece el menú, y otra vez mientras se arma el mundo después de elegir. En dev.html no existe y
// estas funciones no hacen nada. La barra avanza con lo que va bajando (THREE.DefaultLoadingManager).
import * as THREE from 'three';

const el = () => document.getElementById('boot');
let done = 0, total = 0, base = 0; // base: lo que ya estaba cargado cuando se volvió a mostrar

const mgr = THREE.DefaultLoadingManager;
const prevStart = mgr.onStart, prevProgress = mgr.onProgress;
mgr.onStart = (url, loaded, all) => { prevStart?.(url, loaded, all); total = all; done = loaded; paint(); };
mgr.onProgress = (url, loaded, all) => { prevProgress?.(url, loaded, all); total = all; done = loaded; paint(); };

function paint() {
  const b = el();
  if (!b) return;
  const bar = b.querySelector('.boot-bar i');
  const all = total - base;
  if (bar && all > 0) bar.style.width = `${Math.max(8, Math.round(((done - base) / all) * 100))}%`;
}

export const boot = {
  // Muestra la pantalla con un texto (si estaba oculta, vuelve a aparecer)
  show(text) {
    const b = el();
    if (!b) return;
    b.hidden = false;
    base = done;
    b.classList.remove('boot-out');
    if (text) b.querySelector('.boot-text').textContent = text;
    const bar = b.querySelector('.boot-bar i');
    if (bar) bar.style.width = '8%';
  },
  text(t) { const b = el(); if (b) b.querySelector('.boot-text').textContent = t; },
  // Se apaga con un fundido
  hide() {
    const b = el();
    if (!b || b.hidden) return;
    b.classList.add('boot-out');
    setTimeout(() => { if (b.classList.contains('boot-out')) b.hidden = true; }, 450);
  },
};
