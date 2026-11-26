// Conexión con el servidor de Coronda (servidor/coronda-server.mjs), que corre en la PC del dueño del mundo.
//
// El servidor es la autoridad: guarda las cuentas, la mochila, los lotes, los pedidos… y la hora del mundo.
// Este archivo solo habla con él: WebSocket, inicio de sesión, reloj sincronizado, pedidos (rpc) y reconexión.
//
// Dónde está el servidor:
//   1) Si la página la sirvió el propio servidor (lo normal: http://localhost:8080 o tu dirección del túnel), es el mismo sitio.
//   2) En tu PC desde el Studio (localhost:5173): el servidor del juego en localhost:8080.
//   3) Si no (ej. la abriste desde GitHub Pages), se usa "url" de data/tables/servidor.json (ej. "https://coronda.tudominio.com").
// Si no responde: "El servidor está apagado".
import { loadJSON } from '../core/assets.js';

const TOKEN = 'coronda.sesion';     // solo el token de la sesión (no es un dato del juego: el servidor lo verifica)
const SYNC_CADA = 15000;            // ms entre sincronizaciones del reloj

async function buscarServidor() {
  const probar = async (base) => {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(`${base}/__coronda/estado`, { cache: 'no-store', signal: ctl.signal });
      clearTimeout(to);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const aqui = location.origin;
  if (/^https?:/.test(aqui) && await probar(aqui)) return aqui;
  // En tu PC con otro servidor (ej. la vista previa del Studio en :5173): el servidor del juego en el puerto 8080
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.port !== '8080') {
    const local = `http://${location.hostname}:8080`;
    if (await probar(local)) return local;
  }
  const cfg = await loadJSON('data/tables/servidor.json').catch(() => null);
  const url = String(cfg?.url ?? '').trim().replace(/\/+$/, '');
  if (url && await probar(url)) return url;
  return null;
}

// Devuelve la conexión o lanza Error('apagado')
export async function conectar() {
  const base = await buscarServidor();
  if (!base) throw new Error('apagado');
  const wsUrl = base.replace(/^http/, 'ws') + '/ws';
  let ws = null, abierta = false, cerrada = false, reintento = 0;
  let rid = 0;
  const esperando = new Map(); // id -> { ok, mal, t }
  const cola = [];             // mensajes que esperan a que la conexión abra
  // Reloj del servidor = performance.now() + relojBase. Se usa el reloj interno del navegador (que no se puede adelantar ni
  // atrasar) en vez de la hora de la compu: aunque alguien cambie la hora de su PC, la del mundo no se mueve.
  let relojBase = Date.now() - performance.now(), mejorRtt = Infinity;
  let sesion = null;           // { u, nombre, token, admin }
  let dentro = false;          // ya mandó "entrar"
  let personaje = '';

  const c = {
    base,
    get conectado() { return abierta; },
    get sesion() { return sesion; },
    jugadores: 0,
    registroAbierto: true,
    // eventos (los asigna multiplayer.js y el resto del juego)
    onMensaje: null,           // (m) todo lo que no se maneja acá
    onCuenta: null,            // (n) jugadores adentro
    onEstado: null,            // ('conectando' | 'conectado' | 'reconectando' | 'apagado' | 'expulsado', texto)
    onSesion: null,            // (sesion) después de entrar o reconectar
    ahora: () => performance.now() + relojBase, // reloj del servidor
    foto: (u, v) => (v ? `${base}/fotos/${u}.img?v=${v}` : ''),
    send(m) { if (abierta) ws.send(JSON.stringify(m)); else if (cola.length < 50) cola.push(m); },
    rpc(op, a = {}) {
      const id = ++rid;
      return new Promise((ok, mal) => {
        esperando.set(id, { ok, mal, t: performance.now() });
        c.send({ t: 'rpc', id, op, a });
      });
    },
    // Sesión: registro / entrar / volver con el token guardado
    async registrar(nombre, clave) { return iniciar({ t: 'registro', nombre, clave }); },
    async entrar(nombre, clave) { return iniciar({ t: 'login', nombre, clave }); },
    tokenGuardado() { try { return localStorage.getItem(TOKEN) || ''; } catch { return ''; } },
    async conToken() { const token = c.tokenGuardado(); return token ? iniciar({ t: 'token', token }) : { ok: false }; },
    salirCuenta() { const token = c.tokenGuardado(); try { localStorage.removeItem(TOKEN); } catch { /* nada */ } c.send({ t: 'salir', token }); },
    entrarAlMundo(p) { personaje = p ?? ''; dentro = true; c.send({ t: 'entrar', personaje }); },
    cerrar() { cerrada = true; try { ws?.close(); } catch { /* nada */ } },
  };

  let esperaSesion = null;
  function iniciar(msg) {
    return new Promise((resolve) => {
      esperaSesion = resolve;
      c.send(msg);
      setTimeout(() => { if (esperaSesion === resolve) { esperaSesion = null; resolve({ ok: false, error: 'El servidor no contestó.' }); } }, 15000);
    });
  }

  function abrir() {
    c.onEstado?.(reintento ? 'reconectando' : 'conectando');
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      abierta = true; reintento = 0;
      // si ya teníamos sesión (se cortó y volvió): se reengancha con el token
      if (sesion) ws.send(JSON.stringify({ t: 'token', token: sesion.token }));
      while (cola.length) ws.send(JSON.stringify(cola.shift()));
      sincronizar();
      c.onEstado?.('conectado');
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      recibir(m);
    };
    ws.onclose = (ev) => {
      const era = abierta;
      if (era) console.warn(`Servidor: se cortó la conexión (código ${ev?.code ?? '?'})`);
      abierta = false;
      for (const [, p] of esperando) p.mal(new Error('Se cortó la conexión.'));
      esperando.clear();
      if (cerrada) return;
      reintento++;
      c.onEstado?.(era || sesion ? 'reconectando' : 'apagado', 'Se cortó la conexión con el servidor. Reconectando…');
      setTimeout(abrir, Math.min(15000, 600 * 2 ** Math.min(reintento, 5)));
    };
  }

  function recibir(m) {
    switch (m.t) {
      case 'hola': c.jugadores = m.jugadores; c.registroAbierto = m.registro; c.onCuenta?.(m.jugadores); return;
      case 'cuenta': c.jugadores = m.n; c.onCuenta?.(m.n); return;
      case 'sync': {
        const t = performance.now(), rtt = t - m.c;
        // la muestra con menos demora es la más confiable (si no hay una mejor, se va aceptando de a poco)
        if (rtt <= mejorRtt + 30) { mejorRtt = Math.min(mejorRtt, rtt); relojBase = m.s + rtt / 2 - t; }
        else mejorRtt += 5;
        return;
      }
      case 'sesion': {
        if (m.ok) {
          const reconecta = !!sesion;
          sesion = { u: m.u, nombre: m.nombre, token: m.token, admin: m.admin };
          try { localStorage.setItem(TOKEN, m.token); } catch { /* nada */ }
          // volvió después de un corte y el servidor ya lo daba por perdido: vuelve a entrar al mundo
          if (reconecta && dentro && !m.reconexion) c.send({ t: 'entrar', personaje });
          if (reconecta) c.onSesion?.(sesion);
        } else if (m.vencida) { try { localStorage.removeItem(TOKEN); } catch { /* nada */ } }
        const r = esperaSesion; esperaSesion = null;
        r?.(m);
        if (!m.ok && sesion && !r) { c.onEstado?.('expulsado', m.error); c.cerrar(); }
        return;
      }
      case 'rpc': {
        const p = esperando.get(m.id);
        if (!p) return;
        esperando.delete(m.id);
        if (m.ok) p.ok(m.r); else p.mal(Object.assign(new Error(m.error || 'Error'), { juego: true }));
        return;
      }
      case 'expulsado': cerrada = true; c.onEstado?.('expulsado', m.motivo); return;
      case 'apagado': c.onEstado?.('reconectando', 'El servidor se está reiniciando…'); return;
      default: c.onMensaje?.(m);
    }
  }
  function sincronizar() { if (abierta) ws.send(JSON.stringify({ t: 'sync', c: performance.now() })); }
  setInterval(sincronizar, SYNC_CADA);
  // las primeras muestras seguidas, para que el reloj quede bien desde el principio
  [300, 900, 1800].forEach((ms) => setTimeout(sincronizar, ms));

  abrir();
  await new Promise((r, rej) => {
    const t0 = performance.now();
    (function mirar() { if (abierta) r(); else if (performance.now() - t0 > 8000) rej(new Error('apagado')); else setTimeout(mirar, 50); })();
  });
  return c;
}
