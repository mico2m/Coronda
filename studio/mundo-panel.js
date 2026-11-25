// Panel "Mundo" del Coronda Studio: configuración en vivo de la hora (día/noche y horario de la tienda), del talado
// de árboles, de la Carpintería (charla, reparto, precios y tiempos de cada mueble) y vista en tiempo real de la
// tienda (lo que hace Claude, el stock del taller y los pedidos).
// Todo lo que cambiás se aplica al toque en la vista previa y se guarda en su JSON (data/tables/tiempo.json,
// bosque.json, tienda.json y data/muebles.json), conservando el resto del archivo.
const FILES = { tiempo: 'data/tables/tiempo.json', bosque: 'data/tables/bosque.json', tienda: 'data/tables/tienda.json', muebles: 'data/muebles.json' };
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// opts: root (elemento), game() -> iframe.contentWindow.coronda, api(path) -> url, quiet (Map), toast(msg, err)
export function createMundoPanel({ root, game, api, quiet, toast = () => {} }) {
  const data = {}; // lo leído de cada archivo
  const timers = {};
  root.innerHTML = `
    <div class="mp-sec mp-live"><b>En vivo</b><div id="mpLive" class="mp-grid"><span class="k">Esperando la vista previa…</span></div></div>
    <div class="mp-sec"><b>Pedidos de la Carpintería</b><div id="mpPedidos"></div></div>
    <form class="mp-sec" data-f="tiempo"><b>Día y noche · horario</b>
      <label>Minutos reales por día <input type="number" min="1" max="1440" step="1" data-k="dia_minutos"></label>
      <label>Adelantar el reloj (horas) <input type="number" min="-24" max="24" step="0.5" data-k="desfase_horas"></label>
      <label>Tienda abre (hora) <input type="number" min="0" max="23.99" step="0.5" data-k="tienda.abre"></label>
      <label>Tienda cierra (hora) <input type="number" min="0" max="23.99" step="0.5" data-k="tienda.cierra"></label>
      <div class="mp-row"><button type="button" data-ir="8">Ir a las 8</button><button type="button" data-ir="13">13</button><button type="button" data-ir="19">19</button><button type="button" data-ir="20.2">20:15</button><button type="button" data-ir="23">23</button></div>
    </form>
    <form class="mp-sec" data-f="bosque"><b>Talar árboles</b>
      <label>Golpes por tanda <input type="number" min="1" max="50" step="1" data-k="golpes_por_tanda"></label>
      <label>Madera por tanda <input type="number" min="1" max="100" step="1" data-k="madera_por_tanda"></label>
      <label>Tandas hasta que cae <input type="number" min="1" max="50" step="1" data-k="tandas_por_arbol"></label>
      <label>Vuelve a crecer (min) <input type="number" min="0.1" max="600" step="0.5" data-k="rebrote_minutos"></label>
      <label>Animación del personaje <input type="text" data-k="animacion"></label>
    </form>
    <form class="mp-sec" data-f="tienda"><b>Carpintería</b>
      <label>Corta la charla tras (s) <input type="number" min="5" max="600" step="1" data-k="inactividad_seg"></label>
      <label>Espera para volver a hablar (s) <input type="number" min="0" max="120" step="1" data-k="espera_seg"></label>
      <label>Horas de reparto tras el cierre <input type="number" min="0.5" max="12" step="0.5" data-k="reparto_horas"></label>
      <label>Pedidos por jugador <input type="number" min="1" max="50" step="1" data-k="max_pedidos_por_jugador"></label>
    </form>
    <div class="mp-sec"><b>Precios y tiempos (data/muebles.json)</b><div id="mpMuebles"></div></div>
    <div class="mp-sec"><b>Mochila de la vista previa</b><div id="mpInv"></div>
      <div class="mp-row"><button type="button" id="mpMadera">+10 madera</button><button type="button" id="mpVaciar">Vaciar</button></div></div>`;
  const $ = (s) => root.querySelector(s);

  const get = (o, k) => k.split('.').reduce((a, p) => a?.[p], o);
  const set = (o, k, v) => { const ps = k.split('.'); let a = o; ps.slice(0, -1).forEach((p) => { a[p] ??= {}; a = a[p]; }); a[ps.at(-1)] = v; };

  async function load(name) {
    try { data[name] = JSON.parse(await (await fetch(api(FILES[name]))).text()); } catch { data[name] = {}; }
    const form = root.querySelector(`form[data-f="${name}"]`);
    form?.querySelectorAll('[data-k]').forEach((i) => { const v = get(data[name], i.dataset.k); i.value = v ?? ''; });
  }
  function save(name) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(async () => {
      quiet.set(FILES[name], Date.now());
      const r = await fetch(api(FILES[name]), { method: 'PUT', body: JSON.stringify(data[name], null, 2) + '\n' });
      quiet.set(FILES[name], Date.now());
      try { game()?.forgetJSON?.(FILES[name]); } catch { /* nada */ }
      toast(r.ok ? `Guardado ${FILES[name]} ✓` : `No se pudo guardar ${FILES[name]}`, !r.ok);
    }, 500);
  }
  // Aplica en vivo en el juego
  function live(name) {
    const g = game(); if (!g) return;
    try {
      if (name === 'tiempo') g.getTiempo?.()?.setConfig(data.tiempo);
      if (name === 'bosque') g.getBosque?.()?.setConfig(data.bosque);
      if (name === 'tienda') g.getTienda?.()?.setConfig?.(data.tienda);
      if (name === 'muebles') g.getTienda?.()?.setCatalog?.(data.muebles.muebles ?? []);
    } catch { /* la vista previa todavía no cargó */ }
  }
  root.querySelectorAll('form[data-f]').forEach((form) => {
    const name = form.dataset.f;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('input', (e) => {
      const i = e.target.closest('[data-k]'); if (!i) return;
      const v = i.type === 'number' ? Number(i.value) : i.value;
      if (i.type === 'number' && !Number.isFinite(v)) return;
      set(data[name], i.dataset.k, v);
      live(name); save(name);
    });
  });
  // Saltar a una hora: cambia desfase_horas para que ahora sea esa hora
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ir]'); if (!b) return;
    const t = game()?.getTiempo?.(); if (!t) return toast('La vista previa todavía no cargó', true);
    const want = Number(b.dataset.ir);
    data.tiempo.desfase_horas = Math.round((((Number(data.tiempo.desfase_horas) || 0) + want - t.hora()) % 24 + 24) % 24 * 100) / 100;
    $('[data-k="desfase_horas"]').value = data.tiempo.desfase_horas;
    live('tiempo'); save('tiempo');
  });

  // Precios y tiempos de cada mueble
  function drawMuebles() {
    const list = data.muebles?.muebles ?? [];
    $('#mpMuebles').innerHTML = `<table class="mp-t"><tr><th>Mueble</th><th>Madera</th><th>Min</th></tr>${list.map((m, i) => `<tr><td>${esc(m.nombre ?? m.id)}</td>
      <td><input type="number" min="0" max="999" step="1" data-i="${i}" data-c="madera" value="${esc(m.costo?.madera ?? 0)}"></td>
      <td><input type="number" min="0.1" max="600" step="0.5" data-i="${i}" data-c="tiempo_min" value="${esc(m.tiempo_min ?? 1)}"></td></tr>`).join('')}</table>`;
  }
  $('#mpMuebles').addEventListener('input', (e) => {
    const i = e.target.closest('[data-i]'); if (!i) return;
    const m = data.muebles.muebles[Number(i.dataset.i)]; const v = Number(i.value); if (!m || !Number.isFinite(v)) return;
    if (i.dataset.c === 'madera') { m.costo ??= {}; m.costo.madera = Math.max(0, Math.round(v)); } else m.tiempo_min = Math.max(0.1, v);
    live('muebles'); save('muebles');
  });

  $('#mpMadera').onclick = () => { try { game().getInventario().add('recursos', 'madera', 10); } catch { toast('La vista previa todavía no cargó', true); } };
  $('#mpVaciar').onclick = () => { try { game().getInventario().reset(); } catch { toast('La vista previa todavía no cargó', true); } };
  $('#mpPedidos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    if (!confirm('¿Sacar este pedido? (no se devuelve la madera)')) return;
    try { game().getTienda().borrar(b.dataset.del); } catch { /* nada */ }
  });

  // ---------- En vivo (cada segundo) ----------
  const hhmm = (g, ms) => { try { return g.getTiempo().texto(g.getTiempo().hora(ms)); } catch { return ''; } };
  function tick() {
    if (root.closest('[hidden]')) return;
    const g = game();
    if (!g?.getTiempo?.()) { $('#mpLive').innerHTML = '<span class="k">Esperando la vista previa (dev.html o index.html)…</span>'; return; }
    const t = g.getTiempo(), tienda = g.getTienda?.();
    const cl = (() => { try { return document.querySelector('#pv').contentWindow.corondaClaude?.state; } catch { return null; } })();
    const peds = tienda?.pedidos?.() ?? [];
    const listos = peds.filter((p) => p.listo).length, fab = peds.filter((p) => p.fabricando).length;
    const slots = tienda?.slots?.().length || 50;
    $('#mpLive').innerHTML = `
      <span class="k">Hora</span><span><b>${esc(t.texto())}</b> · ${esc(t.momento())}</span>
      <span class="k">Tienda</span><span>${t.abierta() ? '<b class="ok">abierta</b>' : '<b class="no">cerrada</b>'} (${esc(t.config.tienda.abre)} a ${esc(t.config.tienda.cierra)} h)</span>
      <span class="k">Claude</span><span>${esc(tienda?.claudeHace ?? '—')} · ${esc(cl?.mode ?? '—')}${cl?.talkingWith ? ` · hablando con ${esc(cl.talkingWith)}` : ''}${cl?.driving === false ? ' · (lo maneja otro jugador)' : ''}</span>
      <span class="k">Taller</span><span>${listos} listos sin retirar · ${fab} fabricándose · ${peds.length - listos - fab} en fila · ${slots - peds.length} slots libres de ${slots}</span>`;
    $('#mpPedidos').innerHTML = peds.length ? `<table class="mp-t"><tr><th>#</th><th>Jugador</th><th>Mueble</th><th>Estado</th><th></th></tr>${peds.map((p) => `<tr>
      <td>${p.slot}</td><td>${esc(p.jugador)}</td><td>${esc(p.nombre)}</td>
      <td>${p.listo ? `listo ✓${p.aviso ? ' · nota 📬' : ''}` : p.fabricando ? `<span class="mp-bar"><i style="width:${Math.round(p.progreso * 100)}%"></i></span> ${Math.round(p.progreso * 100)}% · ${esc(hhmm(g, p.termina))}` : `en fila · ${esc(hhmm(g, p.termina))}`}</td>
      <td><button type="button" data-del="${esc(p.id)}" title="Sacar el pedido">✕</button></td></tr>`).join('')}</table>` : '<span class="k">Sin pedidos</span>';
    try {
      const inv = g.getInventario?.()?.snapshot?.() ?? {};
      const fmt = (o) => Object.entries(o ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${esc(k)} ×${n}`).join(' · ') || '—';
      $('#mpInv').innerHTML = `<div><span class="k">Recursos</span> ${fmt(inv.recursos)}</div><div><span class="k">Muebles</span> ${fmt(inv.muebles)}</div>`;
    } catch { /* nada */ }
  }
  setInterval(tick, 1000);

  async function refresh() { await Promise.all(Object.keys(FILES).map(load)); drawMuebles(); tick(); }
  refresh();
  return { refresh };
}
