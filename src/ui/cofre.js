// Ventana del cofre (un mueble que fabrica Claude, ver data/muebles.json > "cofre"): guardar y sacar cosas.
// Lo que hay adentro lo guarda el SERVIDOR (cofre.ver / cofre.mover): queda aunque cierres el juego, y solo el dueño
// de la casa lo puede abrir. Capacidad: muebles.json > cofre.capacidad (cuántos tipos de objeto distintos entran).
// Clic en un objeto = mueve 1 · Mayús + clic = todo · o elegís la cantidad en el número de abajo.
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createCofre({ net, stage, inventario, notify = () => {}, onOpen = () => {}, onClose = () => {} }) {
  const app = stage.closest('.app') ?? document.body;
  const win = document.createElement('div');
  win.className = 'cw'; win.hidden = true;
  win.setAttribute('role', 'dialog'); win.setAttribute('aria-label', 'Cofre');
  app.append(win);
  let actual = null; // { k, i, items, capacidad }
  const icono = (kind, id) => inventario?.icono?.(kind, id) ?? '';
  const nombre = (kind, id) => inventario?.nameOf?.(kind, id) ?? id;

  function celdas(entries, total, lado) {
    let html = '';
    for (let n = 0; n < total; n++) {
      const e = entries[n];
      if (!e) { html += '<div class="cf-slot"></div>'; continue; }
      const [kind, id, cant] = e;
      html += `<button type="button" class="cf-slot lleno" data-lado="${lado}" data-kind="${esc(kind)}" data-id="${esc(id)}" data-n="${cant}" title="${esc(nombre(kind, id))} ×${cant}">${icono(kind, id)}${cant > 1 ? `<b>${cant}</b>` : ''}</button>`;
    }
    return html;
  }
  function dibujar() {
    if (!actual) return;
    const enCofre = Object.entries(actual.items).map(([cl, n]) => [...cl.split(':'), n]);
    const inv = inventario?.snapshot?.() ?? { recursos: {}, muebles: {} };
    const mochila = [...Object.entries(inv.recursos).map(([id, n]) => ['recursos', id, n]), ...Object.entries(inv.muebles).map(([id, n]) => ['muebles', id, n])].filter((x) => x[2] > 0 && x[1] !== 'cofre');
    win.innerHTML = `<div class="cw-card cw-cofre">
      <div class="cw-head"><b>Cofre</b><span class="cf-cap">${enCofre.length} / ${actual.capacidad} lugares</span><button type="button" class="cw-x" aria-label="Cerrar">✕</button></div>
      <div class="cw-body">
        <div class="cw-sec">En el cofre <small>(clic para sacar)</small></div>
        <div class="cf-grid">${celdas(enCofre, Math.max(9, Math.ceil(actual.capacidad / 9) * 9), 'cofre')}</div>
        <div class="cw-sec">Tu mochila <small>(clic para guardar)</small></div>
        <div class="cf-grid">${celdas(mochila, Math.max(9, Math.ceil(mochila.length / 9) * 9), 'mochila')}</div>
        <div class="cf-pie"><label>Cantidad por clic <input type="number" class="cf-cant" min="1" max="999" value="1"></label><small>Mayús + clic: todo</small></div>
      </div></div>`;
  }
  async function mover(lado, kind, id, max, todo) {
    const cant = Math.max(1, Math.min(max, todo ? max : Math.floor(Number(win.querySelector('.cf-cant')?.value) || 1)));
    try {
      const r = await net.rpc('cofre.mover', { k: actual.k, i: actual.i, dir: lado === 'cofre' ? 'retirar' : 'guardar', kind, id, n: cant });
      actual.items = r.items; actual.capacidad = r.capacidad;
      dibujar();
    } catch (e) { notify(e.message); }
  }
  async function abrir(k, i) {
    if (!net) { notify('Los cofres guardan en el servidor: jugá en el servidor para usarlos.'); return; }
    try {
      const r = await net.rpc('cofre.ver', { k, i });
      if (!actual) onOpen();
      actual = { k, i, items: r.items, capacidad: r.capacidad };
      win.hidden = false;
      dibujar();
    } catch (e) { notify(e.message); }
  }
  function cerrar() { if (!actual) return; actual = null; win.hidden = true; win.innerHTML = ''; onClose(); }
  win.addEventListener('click', (e) => {
    if (e.target.closest('.cw-x') || e.target === win) { cerrar(); return; }
    const b = e.target.closest('.cf-slot.lleno');
    if (b) mover(b.dataset.lado, b.dataset.kind, b.dataset.id, Number(b.dataset.n), e.shiftKey);
  });
  win.addEventListener('pointerdown', (e) => e.stopPropagation());
  win.addEventListener('keydown', (e) => e.stopPropagation());
  addEventListener('keydown', (e) => { if (actual && (e.code === 'Escape' || e.code === 'KeyE') && e.target?.tagName !== 'INPUT') { e.preventDefault(); e.stopImmediatePropagation(); cerrar(); } }, true);
  inventario?.onChange?.(() => { if (actual) dibujar(); });
  return { abrir, cerrar, get abierto() { return !!actual; } };
}
