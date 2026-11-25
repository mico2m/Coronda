// Comandos de admin en el chat (solo en el servidor). Los cambios los ven todos los jugadores.
//
//   /admin CLAVE                 entrar como admin (la clave la controla el worker: secreto ADMIN_KEY en Cloudflare)
//   /salir                       dejar de ser admin en este navegador
//   /time set 19  ·  /time set 19:59    poner la hora del juego para todos
//   /time reset                  volver a la hora normal (la de data/tables/tiempo.json)
//   /anuncio texto               cartel para todos
//   /madera Ana 20               darle madera a un jugador (o "todos")
//   /resistencia Ana             recargar la resistencia del hacha de un jugador (o "todos")
//   /ayuda                       la lista
//
// Seguridad (no hay cuentas ni servidor propio): la clave nunca está en el juego ni en GitHub. El worker
// (servidor-ia/worker.js) la compara y FIRMA cada comando (HMAC con ADMIN_KEY). El comando viaja por la red con su firma
// y cada jugador le pregunta al worker si la firma es válida antes de aplicarlo: un comando inventado o copiado se
// descarta. La hora queda guardada en el broker (retained), así la ven también los que entran después.
// Lo que empieza con "/" nunca se manda al chat de los demás.
import { loadJSON } from '../core/assets.js';

const KEY = 'coronda.admin';          // clave guardada en este navegador (sessionStorage: se borra al cerrar)
const FRESCO = 2 * 60 * 1000;          // un comando de un solo uso (anuncio, madera…) vale 2 minutos
const norm = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function createAdmin({ net, chat, myName, tiempo = null, inventario = null, getBosque = () => null, stage = null, notify = () => {} }) {
  let endpoint = '';
  const listo = loadJSON('data/tables/ia.json').then((c) => { endpoint = String(c?.endpoint ?? '').replace(/\/+$/, ''); }).catch(() => {});
  let clave = '';
  try { clave = sessionStorage.getItem(KEY) || ''; } catch { /* nada */ }
  const sys = (t) => chat?.add?.('', t, false, true);

  async function llamar(ruta, body) {
    await listo;
    if (!endpoint) throw new Error('no hay worker configurado (data/tables/ia.json > endpoint)');
    const r = await fetch(`${endpoint}${ruta}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { /* nada */ }
    if (r.status === 429) throw new Error('demasiados intentos, esperá un minuto');
    return { status: r.status, ...(j ?? {}) };
  }

  // ---------- Aplicar (todos, después de verificar) ----------
  let horaT = 0;              // momento del último comando de hora aplicado (los más viejos se ignoran)
  let desfaseBase = null;     // el desfase de tiempo.json, para /time reset
  const vistos = new Set();   // ids de comandos de un solo uso ya aplicados

  const banner = document.createElement('div');
  banner.className = 'admin-anuncio'; banner.hidden = true;
  (stage ?? document.querySelector('.app') ?? document.body).appendChild(banner);
  let bannerT = null;
  function anunciar(texto) {
    banner.textContent = `📢 ${texto}`; banner.hidden = false;
    clearTimeout(bannerT); bannerT = setTimeout(() => { banner.hidden = true; }, 7000);
    sys(`📢 Anuncio: ${texto}`);
  }
  const esParaMi = (j) => { const n = norm(j); return n === 'todos' || n === norm(myName); };

  function aplicar(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.tipo === 'hora') {
      if (!tiempo || !(cmd.t > horaT)) return;
      horaT = cmd.t;
      if (desfaseBase === null) desfaseBase = tiempo.config.desfase_horas;
      if (cmd.hora === null || cmd.hora === undefined) { tiempo.setConfig({ desfase_horas: desfaseBase }); return; }
      // que en el momento del comando sea esa hora: desfase = hora - horas que pasaron hasta ese momento
      const dayMs = tiempo.config.dia_minutos * 60000;
      const d = (((Number(cmd.hora) - (cmd.t / dayMs) * 24) % 24) + 24) % 24;
      tiempo.setConfig({ desfase_horas: d });
      return;
    }
    // Comandos de un solo uso: frescos y una sola vez
    if (vistos.has(cmd.id) || Math.abs(Date.now() - Number(cmd.t)) > FRESCO) return;
    vistos.add(cmd.id);
    if (cmd.tipo === 'anuncio') anunciar(String(cmd.texto ?? '').slice(0, 140));
    else if (cmd.tipo === 'madera' && esParaMi(cmd.jugador)) {
      const n = Math.max(1, Math.min(999, Math.round(Number(cmd.cantidad) || 0)));
      inventario?.add('recursos', 'madera', n);
      notify(`🪵 El admin te dio ${n} de madera.`); sys(`🪵 ${cmd.de || 'El admin'} te dio ${n} de madera.`);
    } else if (cmd.tipo === 'resistencia' && esParaMi(cmd.jugador)) {
      getBosque()?.recargar?.();
      notify('⚡ El admin te recargó la resistencia del hacha.'); sys('⚡ Resistencia del hacha recargada.');
    }
  }

  // ---------- Recibir (verificando la firma con el worker) ----------
  // Lo verificado es el par comando + firma (si alguien copia una firma y cambia el comando, no vale)
  const canon = (o) => JSON.stringify(Object.keys(o).sort().reduce((x, k) => { x[k] = o[k]; return x; }, {}));
  const firmasOk = new Map(); // firma|comando -> true/false
  async function recibir(d) {
    const cmd = d?.cmd, firma = String(d?.firma ?? '');
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || !/^[0-9a-f]{64}$/.test(firma)) return;
    const k = `${firma}|${canon(cmd)}`;
    if (!firmasOk.has(k)) {
      try { const r = await llamar('/admin/verificar', { cmd, firma }); firmasOk.set(k, r.ok === true); } catch { return; }
    }
    if (firmasOk.get(k)) aplicar(cmd);
  }
  const C = net?.admin;
  if (C) {
    const { messages, saved } = C.take();
    C.onMessage = (d) => recibir(d);
    C.onPersisted = (k, d) => recibir(d);
    messages.forEach(({ data }) => recibir(data));
    saved.forEach(([, d]) => recibir(d));
  }

  // ---------- Mandar (solo el admin) ----------
  async function mandar(cmd, guardar = false) {
    const full = { ...cmd, id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, t: Date.now(), de: String(myName).slice(0, 20) };
    const r = await llamar('/admin/firmar', { clave, cmd: full });
    if (!r.ok || !r.firma) {
      if (r.status === 403) { clave = ''; try { sessionStorage.removeItem(KEY); } catch { /* nada */ } sys('Tu clave de admin ya no vale: entrá de nuevo con /admin CLAVE.'); return false; }
      throw new Error(r.error || 'el worker no firmó el comando');
    }
    firmasOk.set(`${r.firma}|${canon(full)}`, true);
    aplicar(full);                         // a mí
    C?.send({ cmd: full, firma: r.firma }); // a los demás
    if (guardar) C?.persist(guardar, { cmd: full, firma: r.firma }); // para los que entren después
    return true;
  }

  const AYUDA = 'Comandos: /time set 19 (o 19:59) · /time reset · /anuncio texto · /madera Jugador 20 · /resistencia Jugador (o todos) · /salir';

  // Devuelve true si el texto era un comando (nunca va al chat de los demás)
  async function comando(texto) {
    const t = String(texto ?? '').trim();
    if (!t.startsWith('/')) return false;
    const [cmd0, ...resto] = t.slice(1).split(/\s+/);
    const cmd = norm(cmd0), args = resto;
    try {
      if (cmd === 'admin') {
        const k = t.slice(1).replace(/^\S+\s*/, '');
        if (!k) { sys('Escribí /admin y tu clave.'); return true; }
        const r = await llamar('/admin/login', { clave: k });
        if (r.ok) { clave = k; try { sessionStorage.setItem(KEY, k); } catch { /* nada */ } sys(`✅ Sos admin. ${AYUDA}`); }
        else sys(r.status === 500 ? `⚠️ ${r.error || 'El worker no tiene ADMIN_KEY configurado.'}` : '❌ Clave incorrecta.');
        return true;
      }
      if (cmd === 'ayuda' || cmd === 'help') { sys(clave ? AYUDA : 'Para usar comandos entrá como admin: /admin CLAVE'); return true; }
      if (cmd === 'salir') { clave = ''; try { sessionStorage.removeItem(KEY); } catch { /* nada */ } sys('Dejaste de ser admin.'); return true; }
      if (!clave) { sys('Ese comando es de admin. Entrá con /admin CLAVE.'); return true; }
      if (cmd === 'time' || cmd === 'hora') {
        const sub = norm(args[0]);
        if (sub === 'reset') { if (await mandar({ tipo: 'hora', hora: null }, 'hora')) sys('🕐 Hora normal para todos.'); return true; }
        const v = sub === 'set' ? args[1] : args[0];
        const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(v ?? ''));
        if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) { sys('Uso: /time set 19 · /time set 19:59 · /time reset'); return true; }
        const hora = Number(m[1]) + Number(m[2] ?? 0) / 60;
        if (await mandar({ tipo: 'hora', hora }, 'hora')) sys(`🕐 Ahora son las ${m[1].padStart(2, '0')}:${m[2] ?? '00'} para todos.`);
        return true;
      }
      if (cmd === 'anuncio') {
        const texto = t.slice(1).replace(/^\S+\s*/, '').slice(0, 140);
        if (!texto) { sys('Uso: /anuncio texto'); return true; }
        await mandar({ tipo: 'anuncio', texto });
        return true;
      }
      if (cmd === 'madera') {
        const n = Number(args.at(-1)), jugador = args.slice(0, -1).join(' ');
        if (!jugador || !(n > 0)) { sys('Uso: /madera Jugador 20 (o /madera todos 20)'); return true; }
        if (await mandar({ tipo: 'madera', jugador, cantidad: Math.round(n) })) sys(`🪵 Mandaste ${Math.round(n)} de madera a ${jugador}.`);
        return true;
      }
      if (cmd === 'resistencia') {
        const jugador = args.join(' ');
        if (!jugador) { sys('Uso: /resistencia Jugador (o /resistencia todos)'); return true; }
        if (await mandar({ tipo: 'resistencia', jugador })) sys(`⚡ Recargaste la resistencia de ${jugador}.`);
        return true;
      }
      sys(`No conozco /${cmd0}. ${clave ? AYUDA : ''}`);
    } catch (err) { sys(`⚠️ ${err.message || err}`); }
    return true;
  }

  return { comando, get esAdmin() { return !!clave; } };
}
