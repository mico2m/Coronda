// Panel de gestión del servidor (solo admins) — src/systems/panel-gestion.js
// Habla con el servidor por net.rpc('gestion', {...}) (ver gestion.mjs). No depende de ningún framework:
// arma el DOM a mano y usa textContent (nunca innerHTML con datos del servidor).
//
// Uso:
//   import { crearPanelGestion } from './panel-gestion.js';
//   const panel = crearPanelGestion({ net });   // net.rpc debe devolver una promesa con la respuesta
//   panel.abrir();  // por ejemplo desde un comando /gestion o un botón visible solo para admins
//   panel.cerrar();

const CSS = `
.pg{position:fixed;inset:5% 8%;z-index:9999;display:flex;flex-direction:column;background:#14181d;color:#e8edf2;
  border:1px solid #2c3540;border-radius:10px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 10px 40px #000a}
.pg *{box-sizing:border-box}
.pg-top{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #2c3540}
.pg-top h2{margin:0;font-size:16px;flex:1}
.pg button{background:#232b34;color:inherit;border:1px solid #34404c;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
.pg button:hover{background:#2d3844}
.pg button.on{background:#2f6f4f;border-color:#3d8a63}
.pg button.peligro{background:#6b2a2a;border-color:#8a3a3a}
.pg button.peligro:hover{background:#823434}
.pg-cuerpo{flex:1;overflow:auto;padding:12px 14px}
.pg table{width:100%;border-collapse:collapse}
.pg th,.pg td{text-align:left;padding:6px 8px;border-bottom:1px solid #222a33;white-space:nowrap}
.pg th{position:sticky;top:0;background:#14181d;cursor:pointer;user-select:none;color:#9fb0c0}
.pg .num{text-align:right}
.pg .tarjetas{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.pg .tarjeta{background:#1b222a;border:1px solid #2c3540;border-radius:8px;padding:10px 12px}
.pg .tarjeta b{display:block;font-size:22px;margin-top:2px}
.pg .tarjeta span{color:#9fb0c0;font-size:12px}
.pg .barra{display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap}
.pg input[type=search]{background:#0f1317;color:inherit;border:1px solid #34404c;border-radius:6px;padding:5px 8px;min-width:220px}
.pg .tag{display:inline-block;border-radius:10px;padding:0 8px;font-size:12px;background:#2a333d}
.pg .tag.ok{background:#1f4d37}.pg .tag.warn{background:#6b5a1f}.pg .tag.libre{background:#2a333d;color:#9fb0c0}
.pg .msg{margin:8px 0;padding:8px 10px;border-radius:6px;background:#1f3a52}
.pg .msg.error{background:#5a2323}
.pg h3{margin:14px 0 6px;font-size:14px;color:#9fb0c0}
.pg .dos{display:grid;grid-template-columns:1fr 1fr;gap:16px}
`;

const h = (tag, attrs, ...hijos) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of hijos.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const fmtDur = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${hh} h ${m} min` : hh ? `${hh} h ${m} min` : `${m} min ${s % 60} s`;
};
const fmtFecha = (ms) => (ms ? new Date(ms).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');
const hace = (ms, ahora) => (ms ? `hace ${fmtDur(ahora - ms)}` : 'nunca');

// onAbrir / onCerrar: para congelar al jugador y los controles mientras el panel está abierto (igual que ui/menu.js).
export function crearPanelGestion({ net, onAbrir = () => {}, onCerrar = () => {} }) {
  let raiz = null, cuerpo = null, tab = 'mundo', aviso = null, timer = null;
  let ordenLotes = { col: 'nro', asc: true }, ordenJug = { col: 'ultimo', asc: false };
  let filtroLotes = '', filtroJug = '';
  let reloj = { ahora: Date.now(), tomado: Date.now() }; // para que "tiempo encendido" avance sin pedir cada segundo

  const rpc = (p) => net.rpc('gestion', p);
  const decir = (txt, error = false) => { aviso = { txt, error }; };
  const ordenar = (arr, { col, asc }) => [...arr].sort((a, b) => {
    const x = a[col] ?? '', y = b[col] ?? '';
    const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es');
    return asc ? r : -r;
  });
  const th = (txt, col, ord, redibujar, cls) => h('th', { class: cls, onclick: () => { ord.asc = ord.col === col ? !ord.asc : true; ord.col = col; redibujar(); } },
    txt, ord.col === col ? (ord.asc ? ' ▲' : ' ▼') : '');

  async function envolver(fn) {
    try { return await fn(); } catch (e) { decir(e?.message || String(e), true); return null; }
  }

  // ---------- Mundo ----------
  async function vistaMundo() {
    const r = await envolver(() => rpc({ a: 'resumen' }));
    cuerpo.replaceChildren(aviso && msg(), ...(r ? [mundoDom(r)] : []));
  }
  function mundoDom(r) {
    reloj = { ahora: r.ahora, tomado: Date.now() };
    const encendido = h('b', {}, fmtDur(r.ahora - r.iniciado));
    clearInterval(timer);
    timer = setInterval(() => { encendido.textContent = fmtDur(reloj.ahora - r.iniciado + (Date.now() - reloj.tomado)); }, 1000);
    const t = (titulo, valor, sub) => h('div', { class: 'tarjeta' }, h('span', {}, titulo), valor.nodeType ? valor : h('b', {}, valor), sub ? h('span', {}, sub) : null);
    return h('div', {},
      h('div', { class: 'tarjetas' },
        t('Hora del mundo', r.hora, r.horaPuesta ? 'fijada por un admin' : `día de ${r.diaMinutos} min`),
        t('Servidor encendido hace', encendido, `desde ${fmtFecha(r.iniciado)}`),
        t('Conectados ahora', String(r.conectados), `${r.cuentas} cuentas en total`),
        t('Lotes en el mapa', String(r.lotes.total)),
        t('Lotes adquiridos', String(r.lotes.ocupados), `${r.lotes.total ? Math.round(100 * r.lotes.ocupados / r.lotes.total) : 0}% del total`),
        t('Lotes libres', String(r.lotes.libres))));
  }

  // ---------- Lotes ----------
  let cacheLotes = null;
  async function vistaLotes(recargar = true) {
    if (recargar || !cacheLotes) cacheLotes = await envolver(() => rpc({ a: 'lotes' }));
    const r = cacheLotes;
    if (!r) { cuerpo.replaceChildren(aviso && msg()); return; }
    const q = filtroLotes.trim().toLowerCase();
    let filas = r.lista.map((f) => ({ ...f, nroOrd: f.nro ?? 0, dueñoOrd: f.dueño ?? '' }));
    if (q) filas = filas.filter((f) => `${f.label} ${f.escena} ${f.dueño ?? ''} ${f.modelo ?? ''}`.toLowerCase().includes(q));
    const col = { nro: 'nroOrd', dueño: 'dueñoOrd' }[ordenLotes.col] ?? ordenLotes.col;
    filas = ordenar(filas, { col, asc: ordenLotes.asc });
    const redib = () => vistaLotes(false);
    const buscar = h('input', { type: 'search', placeholder: 'Buscar lote, escena o dueño…', value: filtroLotes, oninput: (e) => { filtroLotes = e.target.value; redib().then(() => cuerpo.querySelector('input')?.focus()); } });
    cuerpo.replaceChildren(
      aviso && msg(),
      h('div', { class: 'barra' }, buscar, h('button', { onclick: () => vistaLotes(true) }, '↻ Actualizar'),
        h('span', {}, `${r.ocupados} adquiridos · ${r.libres} libres · ${r.total} en total`)),
      h('table', {},
        h('thead', {}, h('tr', {}, th('Lote', 'nro', ordenLotes, redib), th('Escena', 'escena', ordenLotes, redib), th('Dueño', 'dueño', ordenLotes, redib),
          th('Casa', 'modelo', ordenLotes, redib), th('Muebles', 'muebles', ordenLotes, redib, 'num'), h('th', {}, 'Estado'), h('th', {}, 'Acciones'))),
        h('tbody', {}, filas.map((f) => h('tr', {},
          h('td', {}, f.label), h('td', {}, f.escena), h('td', {}, f.dueño ?? '—'), h('td', {}, f.modelo ?? '—'), h('td', { class: 'num' }, f.dueño ? f.muebles : ''),
          h('td', {}, f.dueño ? h('span', { class: `tag ${f.conectado ? 'ok' : ''}` }, f.conectado ? 'conectado' : 'ocupado') : h('span', { class: 'tag libre' }, 'libre'),
            !f.enMapa ? h('span', { class: 'tag warn', title: 'Tiene dueño pero ya no está en el mapa' }, ' fuera del mapa') : null),
          h('td', {}, f.dueño ? [
            h('button', { onclick: () => accionLote('despojar', f) }, 'Despojar'), ' ',
            h('button', { class: 'peligro', onclick: () => accionLote('eliminar', f) }, 'Eliminar'),
          ] : '')))))
    );
  }
  async function accionLote(a, f) {
    const ok = a === 'despojar'
      ? confirm(`¿Despojar a ${f.dueño} del ${f.label}?\n\nEl lote queda libre y se le devuelven a su mochila los muebles y lo de los cofres.`)
      : confirm(`¿ELIMINAR el ${f.label} de ${f.dueño}?\n\nSe borra la casa y los muebles se PIERDEN (lo de los cofres vuelve al dueño). Esto no se puede deshacer.`);
    if (!ok) return;
    const r = await envolver(() => rpc({ a, k: f.k }));
    if (r) decir(r.txt);
    await vistaLotes(true);
  }

  // ---------- Jugadores ----------
  let cacheJug = null;
  async function vistaJugadores(recargar = true) {
    if (recargar || !cacheJug) cacheJug = await envolver(() => rpc({ a: 'jugadores' }));
    const r = cacheJug;
    if (!r) { cuerpo.replaceChildren(aviso && msg()); return; }
    const ahora = reloj.ahora + (Date.now() - reloj.tomado);
    const q = filtroJug.trim().toLowerCase();
    let filas = r.lista;
    if (q) filas = filas.filter((f) => `${f.n} ${f.escena}`.toLowerCase().includes(q));
    filas = ordenar(filas, ordenJug);
    const redib = () => vistaJugadores(false);
    cuerpo.replaceChildren(
      aviso && msg(),
      h('div', { class: 'barra' },
        h('input', { type: 'search', placeholder: 'Buscar jugador…', value: filtroJug, oninput: (e) => { filtroJug = e.target.value; redib().then(() => cuerpo.querySelector('input')?.focus()); } }),
        h('button', { onclick: () => vistaJugadores(true) }, '↻ Actualizar'),
        h('span', {}, `${filas.filter((f) => f.conectado).length} conectados · ${r.lista.length} cuentas`)),
      h('table', {},
        h('thead', {}, h('tr', {}, th('Jugador', 'n', ordenJug, redib), th('Estado', 'conectado', ordenJug, redib), th('Última conexión', 'ultimo', ordenJug, redib),
          th('Escena', 'escena', ordenJug, redib), th('Lotes', 'lotes', ordenJug, redib, 'num'), th('Creada', 'creado', ordenJug, redib), h('th', {}, ''))),
        h('tbody', {}, filas.map((f) => h('tr', {},
          h('td', {}, f.n), h('td', {}, h('span', { class: `tag ${f.conectado ? 'ok' : 'libre'}` }, f.conectado ? 'conectado' : 'desconectado')),
          h('td', { title: fmtFecha(f.ultimo) }, f.conectado ? 'ahora' : `${fmtFecha(f.ultimo)} (${hace(f.ultimo, ahora)})`),
          h('td', {}, f.escena || '—'), h('td', { class: 'num' }, f.lotes), h('td', {}, fmtFecha(f.creado)),
          h('td', {}, h('button', { onclick: () => verJugador(f.u) }, 'Inventario'))))))
    );
  }
  async function verJugador(u) {
    const j = await envolver(() => rpc({ a: 'jugador', u }));
    if (!j) { await vistaJugadores(false); return; }
    const lista = (items) => items.length
      ? h('table', {}, h('tbody', {}, items.map((i) => h('tr', {}, h('td', {}, i.nombre), h('td', { class: 'num' }, `× ${i.n}`)))))
      : h('p', {}, 'Vacío.');
    cuerpo.replaceChildren(
      aviso && msg(),
      h('div', { class: 'barra' }, h('button', { onclick: () => vistaJugadores(false) }, '← Volver'), h('b', {}, j.n),
        h('span', { class: `tag ${j.conectado ? 'ok' : 'libre'}` }, j.conectado ? 'conectado' : 'desconectado')),
      h('div', { class: 'tarjetas' },
        h('div', { class: 'tarjeta' }, h('span', {}, 'Nivel'), h('b', {}, String(j.nivel)), h('span', {}, `${j.xp} xp`)),
        h('div', { class: 'tarjeta' }, h('span', {}, 'Última conexión'), h('b', {}, j.conectado ? 'ahora' : fmtFecha(j.ultimo))),
        h('div', { class: 'tarjeta' }, h('span', {}, 'Cuenta creada'), h('b', {}, fmtFecha(j.creado))),
        h('div', { class: 'tarjeta' }, h('span', {}, 'Escena'), h('b', {}, j.escena || '—'))),
      h('div', { class: 'dos' },
        h('div', {}, h('h3', {}, 'Recursos'), lista(j.recursos)),
        h('div', {}, h('h3', {}, 'Muebles'), lista(j.muebles))),
      h('h3', {}, `Lotes (${j.lotes.length})`),
      j.lotes.length ? h('table', {}, h('tbody', {}, j.lotes.map((l) => h('tr', {}, h('td', {}, l.nro != null ? `Lote ${l.nro}` : l.k), h('td', {}, l.modelo))))) : h('p', {}, 'No tiene lotes.')
    );
  }

  // ---------- Marco ----------
  const msg = () => h('div', { class: `msg${aviso.error ? ' error' : ''}` }, aviso.txt);
  async function dibujar() {
    clearInterval(timer);
    for (const b of raiz.querySelectorAll('.pg-tab')) b.classList.toggle('on', b.dataset.tab === tab);
    cuerpo.replaceChildren(h('p', {}, 'Cargando…'));
    if (tab === 'mundo') await vistaMundo();
    else if (tab === 'lotes') await vistaLotes(true);
    else await vistaJugadores(true);
    aviso = null;
  }
  function abrir() {
    if (raiz) return;
    const estilo = h('style', {}, CSS);
    cuerpo = h('div', { class: 'pg-cuerpo' });
    const tabBtn = (id, txt) => h('button', { class: 'pg-tab', 'data-tab': id, onclick: () => { tab = id; dibujar(); } }, txt);
    raiz = h('div', { class: 'pg', role: 'dialog', 'aria-label': 'Gestión del servidor' }, estilo,
      h('div', { class: 'pg-top' }, h('h2', {}, '🛠️ Gestión del servidor'), tabBtn('mundo', 'Mundo'), tabBtn('lotes', 'Lotes'), tabBtn('jugadores', 'Jugadores'),
        h('button', { onclick: cerrar, 'aria-label': 'Cerrar' }, '✕')),
      cuerpo);
    document.body.append(raiz);
    document.addEventListener('keydown', onKey);
    onAbrir();
    dibujar();
  }
  const onKey = (e) => { if (e.key === 'Escape') cerrar(); };
  function cerrar() {
    if (!raiz) return;
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    raiz.remove(); raiz = cuerpo = null; cacheLotes = cacheJug = null;
    onCerrar();
  }
  return { abrir, cerrar, get abierto() { return !!raiz; } };
}
