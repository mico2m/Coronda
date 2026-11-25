// Aviso de actualización (index.html): cuando se sube una versión nueva a GitHub (el Studio escribe version.json al
// "Enviar"), a los que tienen el juego abierto les aparece "Hay una nueva actualización" con un botón para recargar.
// Se revisa cada minuto y cada vez que volvés a la pestaña.
const EVERY = 60 * 1000;
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function read() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.v ? d : null;
  } catch { return null; }
}

export async function createUpdateNotice() {
  const mine = await read(); // la versión con la que se abrió la página
  let snoozeUntil = 0, shown = null;
  const el = document.createElement('div');
  el.className = 'update-notice';
  el.hidden = true;
  el.setAttribute('role', 'status');
  (document.querySelector('.app') ?? document.body).append(el);

  function show(d) {
    shown = d;
    el.innerHTML = `<div class="update-text"><b>¡Hay una nueva actualización de Coronda!</b>${d.mensaje && !/^Cambios desde el Studio/i.test(d.mensaje) ? `<span>${esc(d.mensaje)}</span>` : '<span>Recargá para jugar con la última versión.</span>'}</div>
      <button type="button" class="update-go">Actualizar</button><button type="button" class="update-later" aria-label="Más tarde">Más tarde</button>`;
    el.hidden = false;
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('update-go')) location.reload();
    else { el.hidden = true; snoozeUntil = Date.now() + 10 * 60 * 1000; } // vuelve a avisar en 10 minutos
  });

  async function check() {
    if (Date.now() < snoozeUntil || !el.hidden) return;
    const now = await read();
    if (!now) return;
    if (!mine) return; // la página se abrió sin version.json: no hay con qué comparar
    if (now.v > mine.v) show(now);
  }
  setInterval(check, EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  return { check, get shown() { return shown; } };
}
