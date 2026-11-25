// Al entrar al juego, si tenés casa: "¿Dónde querés aparecer?" → tu casa (una por lote) o la plaza.
// Se muestra sobre la pantalla de carga; devuelve la clave del lote elegido o null (plaza).
// Teclas: 1, 2… elige; Esc o Enter sobre la plaza.
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// houses: [{ key, label }]   plazaName: nombre de la escena de inicio
export function askSpawn({ houses, plazaName = 'Plaza' }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'spawn-choice';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'spawn-choice-t');
    const opts = [...houses.map((h) => ({ key: h.key, icon: '🏠', text: houses.length > 1 ? `Mi casa · ${h.label}` : 'Mi casa', sub: houses.length > 1 ? '' : h.label })),
      { key: null, icon: '⛲', text: plazaName, sub: 'Donde arrancan todos' }];
    el.innerHTML = `<div class="sc-card">
        <b class="sc-title" id="spawn-choice-t">¿Dónde querés aparecer?</b>
        <div class="sc-opts">${opts.map((o, n) => `<button type="button" class="sc-opt" data-n="${n}">
          <span class="sc-icon" aria-hidden="true">${o.icon}</span>
          <span class="sc-txt"><b>${esc(o.text)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span>
          <kbd>${n + 1}</kbd></button>`).join('')}</div>
      </div>`;
    document.body.append(el);
    const done = (n) => {
      removeEventListener('keydown', onKey, true);
      el.remove();
      resolve(opts[n]?.key ?? null);
    };
    el.addEventListener('click', (e) => { const b = e.target.closest('.sc-opt'); if (b) done(Number(b.dataset.n)); });
    function onKey(e) {
      const n = Number(e.key) - 1;
      if (n >= 0 && n < opts.length) done(n);
      else if (e.key === 'Escape') done(opts.length - 1);
      else if (e.key === 'Enter' && document.activeElement?.classList.contains('sc-opt')) done(Number(document.activeElement.dataset.n));
      else return;
      e.preventDefault(); e.stopPropagation();
    }
    addEventListener('keydown', onKey, true);
    el.querySelector('.sc-opt')?.focus();
  });
}
