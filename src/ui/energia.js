// Barra de energía en el HUD: la energía para talar y correr (resistencia del bosque, ver systems/bosque.js).
// Se recupera quieto (rápido) o caminando (más lento). Si la energía máxima es 0 (sin límite), no se ve.
export function createEnergia({ stage, getBosque }) {
  const el = document.createElement('div');
  el.className = 'energia'; el.hidden = true;
  el.setAttribute('role', 'meter'); el.setAttribute('aria-label', 'Energía para talar');
  el.innerHTML = '<span class="energia-ico" aria-hidden="true">⚡</span><div class="energia-bar"><i></i></div><span class="energia-n"></span>';
  (stage ?? document.body).append(el);
  const bar = el.querySelector('i'), num = el.querySelector('.energia-n');
  let antes = null;
  function dibujar() {
    const r = getBosque?.()?.resistencia;
    if (r?.infinita && r.max) { // modo estudio: energía infinita
      el.hidden = false; bar.style.width = '100%'; num.textContent = '∞';
      el.classList.remove('poca', 'vacia'); antes = null; return;
    }
    if (!r || r.quedan == null || !r.max) { el.hidden = true; return; }
    el.hidden = false;
    const k = Math.max(0, Math.min(1, (r.exacto ?? r.quedan) / r.max));
    bar.style.width = `${k * 100}%`;
    num.textContent = `${r.quedan}/${r.max}`;
    el.classList.toggle('poca', k <= 0.3 && k > 0);
    el.classList.toggle('vacia', r.quedan === 0);
    el.setAttribute('aria-valuenow', String(r.quedan)); el.setAttribute('aria-valuemax', String(r.max)); el.setAttribute('aria-valuemin', '0');
    if (antes != null && r.quedan < antes) { el.classList.remove('gasta'); void el.offsetWidth; el.classList.add('gasta'); } // un golpecito al gastar
    if (antes != null && r.quedan > antes && r.quedan >= r.max) { el.classList.remove('llena'); void el.offsetWidth; el.classList.add('llena'); } // se llenó
    antes = r.quedan;
  }
  setInterval(dibujar, 250);
  dibujar();
  return { el, dibujar };
}
