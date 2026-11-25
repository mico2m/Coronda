// Servidor de Coronda: corre en tu PC y es la ÚNICA autoridad del mundo.
//
//   node servidor/coronda-server.mjs        (o doble clic en Servidor.bat)
//
// - Sirve el juego (index.html, modelos, código) y el WebSocket del multijugador en el mismo puerto (8080).
// - Cuentas con nombre + contraseña: cada jugador tiene un id propio, independiente del nombre visible.
// - Guarda TODO lo importante: mochila, nivel, energía, lotes, casas, pedidos, árboles, cofres, perfiles.
//   El navegador solo muestra lo que el servidor dice; nada de lo que haya en F12 → Aplicación cuenta.
// - La hora del mundo y el progreso de los pedidos salen del reloj del servidor (los navegadores lo sincronizan).
//
// Configuración: servidor/config.json (se crea solo la primera vez). Datos: servidor/datos/ (no se suben a GitHub).
// Cómo abrirlo a internet (Cloudflare Tunnel): ver servidor/README.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { aceptarWebSocket } from './ws.mjs';
import { abrirDB } from './db.mjs';
import * as R from '../src/shared/reglas.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(AQUI, '..');
const DATOS = path.resolve(process.env.CORONDA_DATOS || path.join(AQUI, 'datos'));
const FOTOS = path.join(DATOS, 'fotos');
fs.mkdirSync(FOTOS, { recursive: true });

// ---------- Configuración ----------
const CONFIG_FILE = process.env.CORONDA_CONFIG || path.join(AQUI, 'config.json');
const CONFIG_DEFAULT = {
  _ayuda: 'Configuración del servidor de Coronda. puerto = donde escucha (el túnel de Cloudflare apunta acá). admins = nombres de las cuentas que pueden usar los comandos de admin (/time, /anuncio, /madera…). registro_abierto = false para que nadie más pueda crear cuentas. max_jugadores = cuántos pueden estar adentro a la vez. escena_claude = escena donde vive el NPC Claude.',
  puerto: 8080,
  admins: [],
  registro_abierto: true,
  max_jugadores: 40,
  escena_claude: 'coronda_plaza',
};
let config = { ...CONFIG_DEFAULT };
try { config = { ...CONFIG_DEFAULT, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG_DEFAULT, null, 2)); }
const PUERTO = Number(process.env.PORT) || Number(config.puerto) || 8080;
const esAdmin = (cuenta) => (config.admins ?? []).some((n) => R.normNombre(n) === cuenta.norm);

// ---------- Tablas del juego (las mismas que lee el navegador) ----------
const leer = (rel, def) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return def; } };
const T = {};
function cargarTablas() {
  T.tiempo = { dia_minutos: 24, desfase_horas: 0, tienda: { abre: 8, cierra: 20 }, ...leer('data/tables/tiempo.json', {}) };
  T.tienda = { max_pedidos_por_jugador: 5, max_cantidad: 20, slots: 50, entrega_caduca_seg: 60, trabajo_max_seg: 300, ...leer('data/tables/tienda.json', {}) };
  T.bosque = { golpes_por_tanda: 3, madera_por_tanda: 2, tandas_por_arbol: 3, rebrote_minutos: 5, recurso: 'madera', resistencia_por_dia: 30, recupera_quieto_por_seg: 2, ...leer('data/tables/bosque.json', {}) };
  T.niveles = { xp_por_hachazo: 2, xp_por_arbol: 10, xp_por_mueble: 15, xp_base: 50, xp_exponente: 1.5, nivel_max: 30, puntos_por_nivel: 1, aptitudes: {}, ...leer('data/tables/niveles.json', {}) };
  T.recursos = leer('data/tables/recursos.json', { recursos: {} }).recursos ?? {};
  T.muebles = new Map((leer('data/muebles.json', { muebles: [] }).muebles ?? []).filter((m) => m?.id).map((m) => [m.id, m]));
  const casas = leer('data/casas.json', { casas: [] });
  T.casas = { max: Math.max(1, Number(casas.maxPorJugador) || 1), ids: new Set((casas.casas ?? []).map((c) => c.id)) };
}
cargarTablas();
// Si cambiás una tabla (a mano o desde el Studio) el servidor la vuelve a leer sola
let recarga = null;
try {
  fs.watch(path.join(ROOT, 'data'), { recursive: true }, () => {
    clearTimeout(recarga);
    recarga = setTimeout(() => { cargarTablas(); enviarHora(); recalcularFila(); console.log('Tablas recargadas.'); }, 400);
  });
} catch { /* fs.watch recursivo no está en todos los sistemas: hay que reiniciar para tomar cambios */ }

// ---------- Base de datos ----------
const db = abrirDB(DATOS);
const D = db.data;

// ---------- Reloj del mundo ----------
const ahora = () => Date.now();
function tiempoCfg() {
  const c = structuredClone(T.tiempo);
  if (D.mundo.desfase !== null && D.mundo.desfase !== undefined) c.desfase_horas = D.mundo.desfase;
  return c;
}
const abierta = (t = ahora()) => { const c = tiempoCfg(); return R.enRango(R.hora(c, t), c.tienda.abre, c.tienda.cierra); };

// ---------- Utilidades ----------
const ID_RE = /^[a-z0-9_.-]{1,80}$/i;
const nuevoId = (n = 12) => crypto.randomBytes(n).toString('hex').slice(0, n * 2);
const entero = (v, min, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null; };
const texto = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
class ErrorJuego extends Error {}
const falla = (msg) => { throw new ErrorJuego(msg); };

// ---------- Cuentas ----------
function nuevaCuenta(nombre) {
  const id = nuevoId(8);
  return {
    id, nombre, norm: R.normNombre(nombre), creado: ahora(), ultimo: 0, jugado: 0,
    inv: { recursos: {}, muebles: {} },
    niveles: { xp: 0, gastados: {} },
    energia: { usados: 0, t: ahora() },
    stats: { hachazos: 0, arboles: 0, madera: 0, muebles: 0, intercambios: 0 },
    perfil: { foto: 0, personaje: '' },
    firmas: [],
  };
}
const scrypt = (clave, sal) => new Promise((res, rej) => crypto.scrypt(clave, sal, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
function nuevoToken(u) {
  const token = crypto.randomBytes(32).toString('base64url');
  D.sesiones[sha(token)] = { u, exp: ahora() + 30 * 864e5 };
  db.cambio();
  return token;
}
setInterval(() => { const t = ahora(); for (const [k, s] of Object.entries(D.sesiones)) if (s.exp < t) delete D.sesiones[k]; db.cambio(); }, 3600e3).unref();

// Intentos de entrar: 8 por minuto por dirección (contra adivinar contraseñas)
const intentos = new Map();
function limiteIntentos(ip) {
  const t = ahora(), l = (intentos.get(ip) ?? []).filter((x) => t - x < 60000);
  l.push(t); intentos.set(ip, l);
  return l.length <= 8;
}

// ---------- Inventario (siempre en el servidor) ----------
const RECURSO_MAX = (id) => Math.max(1, Number(T.recursos[id]?.max) || 999);
const MUEBLE_MAX = 999;
const tope = (kind, id) => (kind === 'recursos' ? RECURSO_MAX(id) : MUEBLE_MAX);
const existeItem = (kind, id) => (kind === 'recursos' ? !!T.recursos[id] : T.muebles.has(id));
const cuenta = (c, kind, id) => c.inv[kind]?.[id] ?? 0;
function sumar(c, kind, id, n) {
  const have = cuenta(c, kind, id);
  const put = Math.max(0, Math.min(n, tope(kind, id) - have));
  if (put > 0) c.inv[kind][id] = have + put;
  return put;
}
function sacar(c, kind, id, n) {
  if (!(n > 0) || cuenta(c, kind, id) < n) return false;
  const left = cuenta(c, kind, id) - n;
  if (left > 0) c.inv[kind][id] = left; else delete c.inv[kind][id];
  return true;
}
const alcanza = (c, costo) => Object.entries(costo ?? {}).every(([id, n]) => cuenta(c, 'recursos', id) >= n);
function pagar(c, costo) {
  if (!alcanza(c, costo)) return false;
  for (const [id, n] of Object.entries(costo ?? {})) if (n > 0) sacar(c, 'recursos', id, n);
  return true;
}
const multiplicar = (costo, q) => Object.fromEntries(Object.entries(costo ?? {}).map(([k, v]) => [k, Math.max(0, Math.floor(Number(v) || 0)) * q]));

// ---------- Niveles y energía ----------
function ganarXp(c, que, cant = 1) {
  const xp = (Number(T.niveles[`xp_por_${que}`]) || 0) * cant;
  if (xp > 0) c.niveles.xp = Math.round((c.niveles.xp + xp) * 100) / 100;
  return xp;
}
const bonusEnergia = (c) => (Number(c.niveles.gastados.energia) || 0) * (Number(T.niveles.aptitudes?.energia?.por_punto) || 0);
const energiaMax = (c) => (Number(T.bosque.resistencia_por_dia) || 0) + bonusEnergia(c);
// La energía se recupera sola con el tiempo (como mucho a la velocidad de "quieto"); talar gasta 1 por hachazo.
function energia(c, t = ahora()) {
  const rate = Math.max(0, Number(T.bosque.recupera_quieto_por_seg) || 0);
  const usados = Math.max(0, c.energia.usados - (rate * (t - c.energia.t)) / 1000);
  c.energia = { usados: Math.min(energiaMax(c), usados), t };
  return c.energia;
}

// ---------- Jugadores conectados ----------
// jugadores: u -> { c (cuenta), ws, dentro (en el mundo), est (último estado), grace (timer de reconexión), … }
const jugadores = new Map();
const conexiones = new Set(); // todas (también las del menú, sin cuenta)
const GRACIA_MS = 20000;      // si se corta la conexión, 20 s para volver sin que los demás lo vean salir

function enviar(ws, msg) { if (ws?.abierto) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function aTodos(msg, filtro = () => true) {
  const s = JSON.stringify(msg);
  for (const j of jugadores.values()) if (j.dentro && j.ws && filtro(j)) enviar(j.ws, s);
}
const enLinea = () => [...jugadores.values()].filter((j) => j.dentro).length;
function contar() { const s = JSON.stringify({ t: 'cuenta', n: enLinea() }); for (const ws of conexiones) enviar(ws, s); }
function avisoChat(txt) { aTodos({ t: 'chat', sys: true, txt }); }

// Lo privado de cada jugador (solo a él)
function enviarYo(j) {
  if (!j?.ws) return;
  const c = j.c;
  enviar(j.ws, { t: 'yo', u: c.id, nombre: c.nombre, inv: c.inv, niveles: c.niveles, energia: energia(c), stats: c.stats, foto: c.perfil.foto, admin: esAdmin(c) });
}
function enviarHora(ws) {
  const msg = { t: 'hora', cfg: tiempoCfg() };
  if (ws) enviar(ws, msg); else for (const w of conexiones) enviar(w, msg);
}

// ---------- Datos públicos (kv): lotes, casas, pedidos, árboles, última conexión ----------
// El navegador los recibe con la misma forma que antes tenían los mensajes "retained" del broker.
function kvTodos() {
  const out = [];
  for (const [k, r] of Object.entries(D.lotes)) out.push({ k, d: r });
  for (const [k, r] of Object.entries(D.casas)) out.push({ k: `casa~${k}`, d: r });
  for (const o of filaActual()) out.push({ k: `tienda~${o.id}`, d: publicoPedido(o) });
  const t = ahora();
  for (const [k, a] of Object.entries(D.arboles)) if (a.hasta > t) out.push({ k: `bosque~${k}`, d: { hasta: a.hasta } });
  for (const c of Object.values(D.cuentas)) if (c.ultimo) out.push({ k: `visto~${c.id}`, d: visto(c) });
  out.push({ k: 'claude~trabajo', d: trabajosPublicos() });
  return out;
}
const visto = (c) => ({ n: c.nombre, c: c.perfil.personaje ?? '', s: c.ultimaEscena ?? '', t: c.ultimo });
function kv(k, d) { aTodos({ t: 'kv', k, d }); }

// ---------- Carpintería ----------
let fila = [];
function recalcularFila() {
  const taller = R.crearTaller(tiempoCfg(), tiempoCfg().tienda);
  const antes = new Map(fila.map((o) => [o.id, `${o.start}|${o.end}`]));
  fila = taller.fila(Object.values(D.pedidos));
  for (const o of fila) if (antes.get(o.id) !== `${o.start}|${o.end}`) kv(`tienda~${o.id}`, publicoPedido(o));
}
const filaActual = () => fila;
const publicoPedido = (o) => ({ id: o.id, u: o.u, n: o.n, m: o.m, q: o.q, t: o.t, d: o.d, s: o.s, h: o.h, aviso: !!o.aviso, est: o.est ?? null, hasta: o.hasta ?? null, start: o.start, end: o.end, pos: o.pos });
function estadoPedido(id, t = ahora()) {
  const o = fila.find((x) => x.id === id);
  if (!o) return null;
  const taller = R.crearTaller(tiempoCfg(), tiempoCfg().tienda);
  return { ...o, ...taller.estado(o, t) };
}
function guardarPedido(p) { D.pedidos[p.id] = p; db.cambio(); recalcularFila(); const o = fila.find((x) => x.id === p.id); if (o) kv(`tienda~${p.id}`, publicoPedido(o)); }
function borrarPedido(id) { delete D.pedidos[id]; db.cambio(); recalcularFila(); kv(`tienda~${id}`, null); }
recalcularFila();

// Trabajos de Claude: buscar pedidos listos y traerlos al mostrador (los hace el juego que maneja a Claude)
let trabajos = []; // { id, u, n, ids, creado }
const trabajosPublicos = () => trabajos.map((j) => ({ id: j.id, u: j.u, n: j.n, ids: j.ids }));
function publicarTrabajos() { kv('claude~trabajo', trabajosPublicos()); }
function cancelarTrabajo(j, motivo) {
  trabajos = trabajos.filter((x) => x !== j);
  for (const id of j.ids) {
    const p = D.pedidos[id];
    if (p?.est) { p.est = null; p.hasta = null; guardarPedido(p); }
  }
  publicarTrabajos();
  if (motivo) { const dueño = jugadores.get(j.u); if (dueño?.ws) enviar(dueño.ws, { t: 'aviso', txt: motivo }); }
}
// Quién maneja a Claude: el jugador de id más chico entre los que están en su escena (igual que decide el juego)
function conductor() {
  const ids = [...jugadores.values()].filter((j) => j.dentro && j.est?.s === config.escena_claude).map((j) => j.c.id).sort();
  return ids[0] ?? null;
}
// Vencimientos: entregas no retiradas y trabajos colgados
setInterval(() => {
  const t = ahora();
  for (const j of [...trabajos]) {
    const enMostrador = j.ids.map((id) => D.pedidos[id]).find((p) => p?.est === 'mostrador');
    if (enMostrador && enMostrador.hasta < t) {
      cancelarTrabajo(j, `No retiraste ${nombreMueble(enMostrador.m)} a tiempo: Claude lo volvió a guardar en el taller. Pedíselo de nuevo cuando quieras.`);
      continue;
    }
    if (t - j.creado > (Number(T.tienda.trabajo_max_seg) || 300) * 1000) cancelarTrabajo(j, 'Claude no pudo terminar la entrega. Tus pedidos siguen listos en el taller.');
  }
  // árboles que volvieron a crecer
  for (const [k, a] of Object.entries(D.arboles)) if (a.hasta && a.hasta <= t) { delete D.arboles[k]; db.cambio(); kv(`bosque~${k}`, null); }
}, 1000).unref();
const nombreMueble = (m) => T.muebles.get(m)?.nombre ?? m;

// ---------- Intercambios (en memoria: se cancelan si alguien se va) ----------
const tratos = new Map(); // u -> trato  { id, a, b, oferta: { [u]: { 'recursos:madera': n } }, listo: { [u]: bool }, t }
function enviarTrato(tr) {
  for (const u of [tr.a, tr.b]) {
    const j = jugadores.get(u);
    if (j?.ws) enviar(j.ws, { t: 'trato', trato: { id: tr.id, a: tr.a, b: tr.b, na: D.cuentas[tr.a]?.nombre, nb: D.cuentas[tr.b]?.nombre, oferta: tr.oferta, listo: tr.listo, aceptado: tr.aceptado } });
  }
}
function cerrarTrato(tr, motivo, hecho = false) {
  tratos.delete(tr.a); tratos.delete(tr.b);
  for (const u of [tr.a, tr.b]) { const j = jugadores.get(u); if (j?.ws) enviar(j.ws, { t: 'trato', fin: true, id: tr.id, hecho, motivo }); }
}
function validarOferta(c, oferta) {
  const out = {};
  for (const [clave, nRaw] of Object.entries(oferta ?? {}).slice(0, 30)) {
    const [kind, id] = String(clave).split(':');
    const n = entero(nRaw, 0, 999);
    if (!['recursos', 'muebles'].includes(kind) || !ID_RE.test(id ?? '') || !existeItem(kind, id) || !n) continue;
    if (cuenta(c, kind, id) < n) falla(`No tenés ${n} de ${kind === 'muebles' ? nombreMueble(id) : id}.`);
    out[`${kind}:${id}`] = n;
  }
  return out;
}

// ---------- Cofres ----------
const cofreId = (k, c, i) => `${k}|${c}|${i}`;
const CAPACIDAD = () => Math.max(1, Number(T.muebles.get('cofre')?.capacidad) || 27);
function cofreDe(u, k, i) {
  const lot = D.lotes[k];
  if (!lot || lot.o !== u) falla('Solo el dueño de la casa puede usar sus cofres.');
  const casa = D.casas[k];
  if (!casa || casa.c !== lot.c || !casa.items.some((it) => it.i === i && it.m === 'cofre')) falla('Ese cofre no está en tu casa.');
  const id = cofreId(k, lot.c, i);
  D.cofres[id] ??= { o: u, items: {} };
  return D.cofres[id];
}
// Al destruir o ceder la casa: lo que había en sus cofres vuelve a la mochila del dueño anterior
function vaciarCofresDe(k, c, dueño) {
  const cuentaD = D.cuentas[dueño];
  let perdido = 0;
  for (const [id, cf] of Object.entries(D.cofres)) {
    if (!id.startsWith(`${k}|${c}|`)) continue;
    for (const [clave, n] of Object.entries(cf.items)) {
      const [kind, it] = clave.split(':');
      const put = cuentaD ? sumar(cuentaD, kind, it, n) : 0;
      perdido += n - put;
    }
    delete D.cofres[id];
  }
  db.cambio();
  return perdido;
}

// ---------- Validación de las casas (muebles que salen y entran de la mochila) ----------
const MAX_ITEMS = 150;
function limpiarPoster(k) {
  const f = ['cuadrado', 'rectangular', 'circular'].includes(k?.f) ? k.f : 'cuadrado';
  let u = texto(k?.u, 500);
  if (!/^https:\/\/[^\s"'<>]+$/i.test(u)) u = '';
  const h = Number.isFinite(Number(k?.h)) ? Math.min(2.6, Math.max(0.6, Math.round(Number(k.h) * 10) / 10)) : 1.6;
  return { f, u, h };
}
function limpiarMusica(mu) {
  if (!mu || typeof mu !== 'object') return null;
  const v = /^[\w-]{6,20}$/.test(mu.v ?? '') ? mu.v : '';
  const l = /^[\w-]{10,64}$/.test(mu.l ?? '') ? mu.l : '';
  const r = Number.isInteger(mu.r) && mu.r > 0 ? mu.r % 1e9 : 0;
  return v || l ? { v, l, p: !!mu.p, ...(r ? { r } : {}) } : null;
}
function limpiarItems(items) {
  if (!Array.isArray(items) || items.length > MAX_ITEMS) falla('Demasiados muebles en la casa.');
  const vistos = new Set();
  return items.map((it) => {
    const i = texto(it?.i, 16), m = texto(it?.m, 60);
    if (!i || vistos.has(i)) falla('Mueble repetido.');
    vistos.add(i);
    if (m !== 'poster' && !T.muebles.has(m)) falla(`El mueble "${m}" no existe.`);
    const x = Number(it?.p?.[0]), z = Number(it?.p?.[1]), y = Number(it?.y) || 0;
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 60 || Math.abs(z) > 60) falla('Posición inválida.');
    return { i, m, p: [Math.round(x * 100) / 100, Math.round(z * 100) / 100], y: Math.round(y * 10) / 10, ...(m === 'poster' ? { k: limpiarPoster(it.k) } : {}) };
  });
}
const contarMuebles = (items) => { const c = {}; for (const it of items) if (it.m !== 'poster') c[it.m] = (c[it.m] ?? 0) + 1; return c; };

// ---------- Operaciones (rpc): todo lo que cambia el mundo pasa por acá ----------
const OPS = {
  // ----- Lotes -----
  'lote.adquirir'(j, { k, m }) {
    k = String(k ?? '');
    if (!ID_RE.test(k) || !/lote_/i.test(k)) falla('Lote inválido.');
    if (!T.casas.ids.has(m)) falla('Ese modelo de casa no existe.');
    const cur = D.lotes[k];
    if (cur?.o && cur.o !== j.c.id) falla('Ese lote ya tiene dueño.');
    const mios = Object.entries(D.lotes).filter(([kk, r]) => r.o === j.c.id && kk !== k).length;
    if (mios >= T.casas.max) falla(`Solo podés tener ${T.casas.max} lote${T.casas.max > 1 ? 's' : ''}.`);
    const c = cur?.o === j.c.id && cur.c ? cur.c : nuevoId(6);
    D.lotes[k] = { o: j.c.id, n: j.c.nombre, m, v: (cur?.v ?? 0) + 1, c };
    db.cambio(); kv(k, D.lotes[k]);
    return D.lotes[k];
  },
  'lote.liberar'(j, { k }) {
    const cur = D.lotes[k];
    if (!cur || cur.o !== j.c.id) falla('Ese lote no es tuyo.');
    const perdido = vaciarCofresDe(k, cur.c, j.c.id);
    D.lotes[k] = { o: null, n: '', m: null, v: cur.v + 1 };
    delete D.casas[k];
    db.cambio(); kv(k, D.lotes[k]); kv(`casa~${k}`, null); enviarYo(j);
    return { perdido };
  },
  'lote.ceder'(j, { k, nombre }) {
    const cur = D.lotes[k];
    if (!cur || cur.o !== j.c.id) falla('Ese lote no es tuyo.');
    const otroId = D.nombres[R.normNombre(nombre)];
    const otro = otroId && D.cuentas[otroId];
    if (!otro) return { r: 'nadie' };
    if (otro.id === j.c.id) return { r: 'vos' };
    if (Object.values(D.lotes).filter((r) => r.o === otro.id).length >= T.casas.max) return { r: 'lleno' };
    vaciarCofresDe(k, cur.c, j.c.id);
    D.lotes[k] = { o: otro.id, n: otro.nombre, m: cur.m, v: cur.v + 1, c: nuevoId(6) };
    delete D.casas[k];
    db.cambio(); kv(k, D.lotes[k]); kv(`casa~${k}`, null); enviarYo(j);
    return { r: 'ok' };
  },

  // ----- Interior de la casa: los muebles salen y vuelven a la mochila según lo que cambió -----
  'casa.guardar'(j, { k, items, mu }) {
    const lot = D.lotes[k];
    if (!lot || lot.o !== j.c.id || !lot.c) falla('Solo el dueño puede diseñar la casa.');
    const nuevos = limpiarItems(items);
    const prev = D.casas[k]?.c === lot.c ? D.casas[k] : { items: [] };
    const antes = contarMuebles(prev.items), despues = contarMuebles(nuevos);
    // un cofre que se saca tiene que estar vacío
    for (const it of prev.items) {
      if (it.m !== 'cofre' || nuevos.some((x) => x.i === it.i)) continue;
      const cf = D.cofres[cofreId(k, lot.c, it.i)];
      if (cf && Object.keys(cf.items).length) falla('Vaciá el cofre antes de sacarlo.');
      delete D.cofres[cofreId(k, lot.c, it.i)];
    }
    // primero se comprueba todo, después se mueve (o todo o nada)
    for (const m of new Set([...Object.keys(antes), ...Object.keys(despues)])) {
      const d = (despues[m] ?? 0) - (antes[m] ?? 0);
      if (d > 0 && cuenta(j.c, 'muebles', m) < d) falla(`No tenés ${nombreMueble(m)} en la mochila.`);
    }
    for (const m of new Set([...Object.keys(antes), ...Object.keys(despues)])) {
      const d = (despues[m] ?? 0) - (antes[m] ?? 0);
      if (d > 0) sacar(j.c, 'muebles', m, d); else if (d < 0) sumar(j.c, 'muebles', m, -d);
    }
    const rec = { c: lot.c, o: j.c.id, v: (D.casas[k]?.v ?? 0) + 1, items: nuevos, mu: mu === undefined ? (prev.mu ?? null) : limpiarMusica(mu) };
    D.casas[k] = rec;
    db.cambio(); kv(`casa~${k}`, rec); enviarYo(j);
    return { v: rec.v };
  },

  // ----- Carpintería -----
  'tienda.encargar'(j, { items }) {
    const t = ahora();
    if (!abierta(t)) falla('La Carpintería está cerrada.');
    const lista = (Array.isArray(items) ? items : []).slice(0, 8).map((x) => ({ m: String(x?.m ?? ''), q: entero(x?.q ?? 1, 1, Number(T.tienda.max_cantidad) || 20) }))
      .filter((x) => T.muebles.get(x.m)?.costo && x.q);
    if (!lista.length) falla('No pediste ningún mueble que se fabrique.');
    const max = Number(T.tienda.max_pedidos_por_jugador) || 5;
    const mios = Object.values(D.pedidos).filter((p) => p.u === j.c.id).length;
    if (mios + lista.length > max) falla(`Podés tener ${max} pedidos a la vez (ya tenés ${mios}).`);
    const usados = new Set(Object.values(D.pedidos).map((p) => p.s));
    const libres = []; for (let s = 1; s <= (Number(T.tienda.slots) || 50) && libres.length < lista.length; s++) if (!usados.has(s)) libres.push(s);
    if (libres.length < lista.length) falla('El taller está lleno. Volvé cuando retiren algo.');
    const total = {};
    for (const x of lista) for (const [k, v] of Object.entries(multiplicar(T.muebles.get(x.m).costo, x.q))) total[k] = (total[k] ?? 0) + v;
    if (!pagar(j.c, total)) {
      const falta = Object.entries(total).map(([k, v]) => `${Math.max(0, v - cuenta(j.c, 'recursos', k))} de ${k}`).filter((s) => !s.startsWith('0 ')).join(' y ');
      falla(`Te faltan ${falta}.`);
    }
    let last = Math.max(t, ...Object.values(D.pedidos).map((p) => p.t + 1));
    const hechos = lista.map((x, i) => {
      const m = T.muebles.get(x.m);
      const p = { id: `p${nuevoId(5)}`, u: j.c.id, n: j.c.nombre, m: x.m, q: x.q, t: last++, d: Math.max(0.005, Number(m.tiempo_min) || 3) * 60000 * x.q, s: libres[i], h: 1, aviso: false, est: null, hasta: null };
      D.pedidos[p.id] = p;
      return p.id;
    });
    db.cambio(); recalcularFila();
    for (const id of hechos) { const o = fila.find((x) => x.id === id); kv(`tienda~${id}`, publicoPedido(o)); }
    enviarYo(j);
    return { ids: hechos, pago: total, pedidos: hechos.map((id) => publicoPedido(fila.find((x) => x.id === id))) };
  },
  'tienda.retirar'(j, { ids }) {
    if (trabajos.some((x) => x.u === j.c.id)) falla('Claude ya está buscando tus pedidos.');
    const t = ahora();
    const ok = (Array.isArray(ids) ? ids : []).slice(0, 10).map(String).filter((id) => { const e = estadoPedido(id, t); return e && e.u === j.c.id && e.listo && !e.est; });
    if (!ok.length) falla('No hay nada listo para retirar.');
    const tr = { id: nuevoId(4), u: j.c.id, n: j.c.nombre, ids: ok, creado: t };
    trabajos.push(tr); publicarTrabajos();
    return { id: tr.id, ids: ok };
  },
  // Claude (el juego que lo maneja) llegó al mostrador con el pedido: empieza a correr el tiempo para retirarlo
  'tienda.enMostrador'(j, { id }) {
    if (conductor() !== j.c.id) falla('No manejás a Claude.');
    const tr = trabajos.find((x) => x.ids.includes(id));
    const p = D.pedidos[id];
    if (!tr || !p) falla('Ese pedido no está en un trabajo.');
    p.est = 'mostrador'; p.hasta = ahora() + (Number(T.tienda.entrega_caduca_seg) || 60) * 1000;
    guardarPedido(p);
    return { hasta: p.hasta };
  },
  'tienda.recoger'(j, { id }) {
    const p = D.pedidos[id];
    if (!p || p.u !== j.c.id) falla('Ese pedido no es tuyo.');
    if (p.est !== 'mostrador') falla('Claude todavía no lo trajo al mostrador.');
    const q = p.q || 1;
    if (cuenta(j.c, 'muebles', p.m) + q > MUEBLE_MAX) falla('No te entra en la mochila.');
    sumar(j.c, 'muebles', p.m, q);
    const xp = ganarXp(j.c, 'mueble', q);
    j.c.stats.muebles += q;
    borrarPedido(id);
    const tr = trabajos.find((x) => x.ids.includes(id));
    if (tr) { tr.ids = tr.ids.filter((x) => x !== id); if (!tr.ids.length) trabajos = trabajos.filter((x) => x !== tr); publicarTrabajos(); }
    enviarYo(j);
    return { m: p.m, q, xp };
  },
  // El juego que maneja a Claude terminó (o abandonó) un trabajo
  'tienda.finTrabajo'(j, { id }) {
    const tr = trabajos.find((x) => x.id === id);
    if (!tr) return {};
    if (conductor() !== j.c.id && tr.u !== j.c.id) falla('No es tu trabajo.');
    cancelarTrabajo(tr);
    return {};
  },
  // Claude dejó la nota en el buzón de estos pedidos (lo informa el que lo maneja)
  'tienda.aviso'(j, { ids }) {
    if (conductor() !== j.c.id) falla('No manejás a Claude.');
    const t = ahora();
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 50)) {
      const e = estadoPedido(String(id), t);
      if (e?.listo && !D.pedidos[e.id].aviso) { D.pedidos[e.id].aviso = true; guardarPedido(D.pedidos[e.id]); }
    }
    return {};
  },

  // ----- Bosque -----
  'bosque.hachazo'(j, { k }) {
    k = String(k ?? '');
    const m = /^([a-z0-9_]+)\.(arbol_\d+)$/i.exec(k);
    if (!m) falla('Árbol inválido.');
    if (j.est?.s !== m[1]) falla('No estás en ese bosque.');
    const t = ahora();
    if (t - (j.ultimoHachazo ?? 0) < 450) falla('Más despacio.');
    j.ultimoHachazo = t;
    const a = D.arboles[k] ?? { hasta: 0, golpes: 0, tandas: 0 };
    if (a.hasta > t) falla('Ese árbol ya cayó.');
    const e = energia(j.c, t);
    if ((Number(T.bosque.resistencia_por_dia) || 0) && energiaMax(j.c) - e.usados < 1) return { agotado: true, energia: e };
    if (Number(T.bosque.resistencia_por_dia) || 0) j.c.energia.usados += 1;
    j.c.stats.hachazos++;
    let xp = ganarXp(j.c, 'hachazo');
    let madera = 0, cayo = false;
    a.golpes++;
    if (a.golpes >= T.bosque.golpes_por_tanda) {
      a.golpes = 0; a.tandas++;
      madera = sumar(j.c, 'recursos', T.bosque.recurso, Number(T.bosque.madera_por_tanda) || 0);
      j.c.stats.madera += madera;
      if (a.tandas >= T.bosque.tandas_por_arbol) {
        cayo = true; a.golpes = 0; a.tandas = 0; a.hasta = t + Number(T.bosque.rebrote_minutos) * 60000;
        xp += ganarXp(j.c, 'arbol'); j.c.stats.arboles++;
        kv(`bosque~${k}`, { hasta: a.hasta });
      }
    }
    D.arboles[k] = a;
    db.cambio(); enviarYo(j);
    return { golpes: a.golpes, tandas: a.tandas, madera, cayo, xp, energia: j.c.energia };
  },

  // ----- Niveles -----
  'niveles.mejorar'(j, { id }) {
    const a = T.niveles.aptitudes?.[id];
    if (!a) falla('Esa aptitud no existe.');
    const { nivel } = R.nivelDe(T.niveles, j.c.niveles.xp);
    const total = (nivel - 1) * (Number(T.niveles.puntos_por_nivel) || 0);
    const gastados = Object.values(j.c.niveles.gastados).reduce((x, y) => x + (Number(y) || 0), 0);
    if (total - gastados <= 0) falla('No tenés puntos para gastar.');
    if ((Number(j.c.niveles.gastados[id]) || 0) >= (Number(a.max_puntos) || 0)) falla('Esa aptitud ya está al máximo.');
    j.c.niveles.gastados[id] = (Number(j.c.niveles.gastados[id]) || 0) + 1;
    db.cambio(); enviarYo(j);
    return j.c.niveles;
  },

  // ----- Perfil y firmas -----
  'perfil.ver'(j, { u, nombre }) {
    const id = u && D.cuentas[u] ? u : D.nombres[R.normNombre(nombre)];
    const c = D.cuentas[id];
    if (!c) falla('Ese jugador no existe.');
    const nv = R.nivelDe(T.niveles, c.niveles.xp);
    const conectado = jugadores.get(c.id)?.dentro ?? false;
    return {
      u: c.id, nombre: c.nombre, personaje: c.perfil.personaje ?? '', foto: c.perfil.foto, creado: c.creado, ultimo: c.ultimo, conectado,
      nivel: nv.nivel, xp: c.niveles.xp, stats: c.stats, jugado: c.jugado + (conectado ? ahora() - (jugadores.get(c.id).desde ?? ahora()) : 0),
      lotes: Object.values(D.lotes).filter((r) => r.o === c.id).length,
      firmas: c.firmas.slice(-50).reverse(),
      // la mochila es pública (como en los MMO, para poder ofrecer intercambios)
      inv: c.inv,
    };
  },
  'perfil.firmar'(j, { u, txt }) {
    const c = D.cuentas[u];
    if (!c) falla('Ese jugador no existe.');
    const t = texto(txt, 200);
    if (!t) falla('Escribí algo.');
    const now = ahora();
    if (now - (j.ultimaFirma ?? 0) < 15000) falla('Esperá unos segundos antes de firmar de nuevo.');
    j.ultimaFirma = now;
    c.firmas.push({ i: nuevoId(4), de: j.c.id, n: j.c.nombre, txt: t, t: now });
    if (c.firmas.length > 100) c.firmas.splice(0, c.firmas.length - 100);
    db.cambio();
    const dueño = jugadores.get(c.id);
    if (dueño?.ws && dueño !== j) enviar(dueño.ws, { t: 'aviso', txt: `✍ ${j.c.nombre} firmó tu perfil.` });
    return { ok: true };
  },
  'perfil.borrarFirma'(j, { i }) {
    const n = j.c.firmas.length;
    j.c.firmas = j.c.firmas.filter((f) => f.i !== i);
    if (j.c.firmas.length === n) falla('Esa firma no está.');
    db.cambio();
    return { ok: true };
  },
  // Foto de perfil: llega ya recortada y comprimida (WebP o JPEG de 128 × 128, ver src/ui/perfil.js)
  'perfil.foto'(j, { img }) {
    if (img === null) { j.c.perfil.foto = 0; try { fs.unlinkSync(path.join(FOTOS, `${j.c.id}.img`)); } catch { /* nada */ } db.cambio(); enviarYo(j); kv(`foto~${j.c.id}`, 0); return { foto: 0 }; }
    const m = /^data:image\/(webp|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(img ?? ''));
    if (!m) falla('Formato de imagen inválido.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 64 * 1024) falla('La imagen es demasiado grande (máximo 64 KB).');
    const okWebp = m[1] === 'webp' && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
    const okJpeg = m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8;
    if (!okWebp && !okJpeg) falla('La imagen no es válida.');
    fs.writeFileSync(path.join(FOTOS, `${j.c.id}.img`), buf);
    fs.writeFileSync(path.join(FOTOS, `${j.c.id}.tipo`), m[1]);
    j.c.perfil.foto = ahora();
    db.cambio(); enviarYo(j); kv(`foto~${j.c.id}`, j.c.perfil.foto);
    return { foto: j.c.perfil.foto };
  },

  // ----- Intercambio entre dos jugadores -----
  'trato.pedir'(j, { u }) {
    const otro = jugadores.get(u);
    if (!otro?.dentro || otro === j) falla('Ese jugador no está conectado.');
    if (tratos.has(j.c.id)) falla('Ya estás en un intercambio.');
    if (tratos.has(u)) falla(`${otro.c.nombre} está en otro intercambio.`);
    const tr = { id: nuevoId(4), a: j.c.id, b: u, oferta: { [j.c.id]: {}, [u]: {} }, listo: { [j.c.id]: false, [u]: false }, aceptado: false, t: ahora() };
    tratos.set(j.c.id, tr); tratos.set(u, tr);
    enviar(otro.ws, { t: 'trato', invitacion: { id: tr.id, de: j.c.id, n: j.c.nombre } });
    enviarTrato(tr);
    return { id: tr.id };
  },
  'trato.responder'(j, { id, si }) {
    const tr = tratos.get(j.c.id);
    if (!tr || tr.id !== id || tr.b !== j.c.id) falla('Esa invitación ya no está.');
    if (!si) { cerrarTrato(tr, `${j.c.nombre} no quiso intercambiar.`); return {}; }
    tr.aceptado = true; tr.t = ahora(); enviarTrato(tr);
    return {};
  },
  'trato.ofrecer'(j, { oferta }) {
    const tr = tratos.get(j.c.id);
    if (!tr?.aceptado) falla('No estás en un intercambio.');
    tr.oferta[j.c.id] = validarOferta(j.c, oferta);
    tr.listo[tr.a] = false; tr.listo[tr.b] = false; // cambió la oferta: los dos tienen que volver a confirmar
    tr.t = ahora(); enviarTrato(tr);
    return {};
  },
  'trato.listo'(j, { si = true }) {
    const tr = tratos.get(j.c.id);
    if (!tr?.aceptado) falla('No estás en un intercambio.');
    tr.listo[j.c.id] = !!si; tr.t = ahora();
    if (!(tr.listo[tr.a] && tr.listo[tr.b])) { enviarTrato(tr); return { hecho: false }; }
    // Los dos confirmaron: se vuelve a comprobar todo y se hace de una sola vez (nadie puede quedar a medias)
    const A = D.cuentas[tr.a], B = D.cuentas[tr.b];
    try { validarOferta(A, tr.oferta[tr.a]); } catch (e) { cerrarTrato(tr, `${A.nombre} ya no tiene lo que ofrecía.`); return { hecho: false }; }
    try { validarOferta(B, tr.oferta[tr.b]); } catch (e) { cerrarTrato(tr, `${B.nombre} ya no tiene lo que ofrecía.`); return { hecho: false }; }
    const entra = (quien, oferta) => Object.entries(oferta).every(([cl, n]) => { const [kind, id] = cl.split(':'); return cuenta(quien, kind, id) + n <= tope(kind, id); });
    if (!entra(B, tr.oferta[tr.a]) || !entra(A, tr.oferta[tr.b])) { cerrarTrato(tr, 'A alguno no le entra lo que recibe en la mochila.'); return { hecho: false }; }
    const mover = (de, a, oferta) => { for (const [cl, n] of Object.entries(oferta)) { const [kind, id] = cl.split(':'); sacar(de, kind, id, n); sumar(a, kind, id, n); } };
    mover(A, B, tr.oferta[tr.a]); mover(B, A, tr.oferta[tr.b]);
    A.stats.intercambios++; B.stats.intercambios++;
    db.cambio();
    console.log(`Intercambio ${A.nombre} ⇄ ${B.nombre}:`, JSON.stringify(tr.oferta));
    cerrarTrato(tr, '¡Intercambio hecho!', true);
    enviarYo(jugadores.get(tr.a)); enviarYo(jugadores.get(tr.b));
    return { hecho: true };
  },
  'trato.cancelar'(j) {
    const tr = tratos.get(j.c.id);
    if (tr) cerrarTrato(tr, `${j.c.nombre} canceló el intercambio.`);
    return {};
  },

  // ----- Cofres -----
  'cofre.ver'(j, { k, i }) {
    const cf = cofreDe(j.c.id, String(k), String(i));
    return { items: cf.items, capacidad: CAPACIDAD() };
  },
  'cofre.mover'(j, { k, i, dir, kind, id, n }) {
    const cf = cofreDe(j.c.id, String(k), String(i));
    if (!['recursos', 'muebles'].includes(kind) || !ID_RE.test(String(id)) || !existeItem(kind, id)) falla('Objeto inválido.');
    if (kind === 'muebles' && id === 'cofre') falla('Un cofre no entra en otro cofre.');
    n = entero(n, 1, 999);
    if (!n) falla('Cantidad inválida.');
    const clave = `${kind}:${id}`;
    if (dir === 'guardar') {
      if (cuenta(j.c, kind, id) < n) falla('No tenés tanto.');
      if (!cf.items[clave] && Object.keys(cf.items).length >= CAPACIDAD()) falla(`El cofre está lleno (${CAPACIDAD()} lugares).`);
      if ((cf.items[clave] ?? 0) + n > 999) falla('No entra más de eso en un lugar del cofre.');
      sacar(j.c, kind, id, n); cf.items[clave] = (cf.items[clave] ?? 0) + n;
    } else if (dir === 'retirar') {
      if ((cf.items[clave] ?? 0) < n) falla('El cofre no tiene tanto.');
      if (cuenta(j.c, kind, id) + n > tope(kind, id)) falla('No te entra en la mochila.');
      cf.items[clave] -= n; if (!cf.items[clave]) delete cf.items[clave];
      sumar(j.c, kind, id, n);
    } else falla('Acción inválida.');
    db.cambio(); enviarYo(j);
    return { items: cf.items, capacidad: CAPACIDAD() };
  },

  // ----- Admin (cuentas de config.admins) -----
  admin(j, { cmd }) {
    if (!esAdmin(j.c)) falla('No sos admin.');
    const partes = texto(cmd, 200).replace(/^\//, '').split(/\s+/);
    const [c0, ...rest] = partes;
    const buscar = (n) => { if (/^todos$/i.test(n)) return [...jugadores.values()].filter((x) => x.dentro).map((x) => x.c); const id = D.nombres[R.normNombre(n)]; return id ? [D.cuentas[id]] : []; };
    if (c0 === 'time' && rest[0] === 'set') {
      const [hh, mm = '0'] = String(rest[1] ?? '').split(':');
      const h = Number(hh) + Number(mm) / 60;
      if (!(h >= 0 && h < 24)) falla('Uso: /time set 19 o /time set 19:30');
      D.mundo.desfase = R.desfaseParaHora(T.tiempo, h, ahora()); db.cambio(); enviarHora(); recalcularFila();
      avisoChat(`🕒 El admin puso la hora en ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}.`);
      return { ok: true };
    }
    if (c0 === 'time' && rest[0] === 'reset') { D.mundo.desfase = null; db.cambio(); enviarHora(); recalcularFila(); avisoChat('🕒 La hora volvió a la normal.'); return { ok: true }; }
    if (c0 === 'anuncio') { const t = rest.join(' ').slice(0, 140); if (!t) falla('Uso: /anuncio texto'); aTodos({ t: 'anuncio', txt: t }); return { ok: true }; }
    if (c0 === 'madera') {
      const n = entero(rest.at(-1), 1, 999), quienes = buscar(rest.slice(0, -1).join(' '));
      if (!n || !quienes.length) falla('Uso: /madera Nombre 20  (o todos)');
      for (const c of quienes) { sumar(c, 'recursos', 'madera', n); const jj = jugadores.get(c.id); enviarYo(jj); if (jj?.ws) enviar(jj.ws, { t: 'aviso', txt: `🪵 El admin te dio ${n} de madera.` }); }
      db.cambio(); return { ok: true, a: quienes.map((c) => c.nombre) };
    }
    if (c0 === 'resistencia') {
      const quienes = buscar(rest.join(' '));
      if (!quienes.length) falla('Uso: /resistencia Nombre  (o todos)');
      for (const c of quienes) { c.energia = { usados: 0, t: ahora() }; const jj = jugadores.get(c.id); enviarYo(jj); if (jj?.ws) enviar(jj.ws, { t: 'aviso', txt: '⚡ El admin te recargó la energía.' }); }
      db.cambio(); return { ok: true };
    }
    if (c0 === 'expulsar') {
      const [c] = buscar(rest.join(' '));
      const jj = c && jugadores.get(c.id);
      if (!jj?.ws) falla('Ese jugador no está conectado.');
      enviar(jj.ws, { t: 'expulsado', motivo: 'El admin te sacó del servidor.' }); jj.ws.close(); return { ok: true };
    }
    if (c0 === 'borrarpedido') { if (!D.pedidos[rest[0]]) falla('Ese pedido no existe.'); borrarPedido(rest[0]); return { ok: true }; }
    falla('Comandos: /time set 19 · /time reset · /anuncio texto · /madera Nombre 20 · /resistencia Nombre · /expulsar Nombre · /borrarpedido id');
  },
};

// ---------- Mensajes ----------
const RELAY = new Set(['estado', 'ping', 'voz', 'claude']);
function limpiarEstado(j, d) {
  if (!d || typeof d !== 'object') return null;
  if (d.playing === false) return { playing: false };
  const p = Array.isArray(d.p) && d.p.length === 3 && d.p.every(Number.isFinite) ? d.p.map((v) => Math.round(v * 100) / 100) : null;
  if (!p || p.some((v) => Math.abs(v) > 5000)) return null;
  const m = typeof d.m === 'string' && /^assets\/models\/[\w/.-]+\.glb$/.test(d.m) && !d.m.includes('..') ? d.m : 'assets/models/objects/personaje.glb';
  return {
    playing: true, u: j.c.id, n: j.c.nombre, s: texto(d.s, 60), p, f: Number.isFinite(d.f) ? d.f : 0, a: texto(d.a, 40), m,
    sc: Number.isFinite(d.sc) ? Math.min(10, Math.max(0.05, d.sc)) : 1, yo: Number.isFinite(d.yo) ? d.yo : 0, cn: texto(d.cn, 30),
    t: Number.isFinite(d.t) ? d.t : ahora(), q: Number.isFinite(d.q) ? d.q : 0,
  };
}

function alEntrar(j, reconexion) {
  const nuevo = !j.dentro;
  j.dentro = true;
  j.desde ??= ahora();
  if (!j.ws) return;
  enviarYo(j);
  enviarHora(j.ws);
  enviar(j.ws, { t: 'kv', lista: kvTodos() });
  // los que ya están: que los vea enseguida (con su último estado)
  for (const o of jugadores.values()) {
    if (o === j || !o.dentro) continue;
    enviar(j.ws, { t: 'join', from: o.c.id });
    if (o.est) enviar(j.ws, { t: 'a', n: 'estado', from: o.c.id, d: o.est });
  }
  if (nuevo && !reconexion) {
    aTodos({ t: 'join', from: j.c.id }, (o) => o !== j);
    avisoChat(`${j.c.nombre} se ha unido al mundo`);
    console.log(`+ ${j.c.nombre} entró (${enLinea()} adentro)`);
  }
  j.c.ultimo = ahora(); db.cambio(); kv(`visto~${j.c.id}`, visto(j.c));
  contar();
}
function alSalir(j, motivo = 'ha abandonado el mundo') {
  if (j.ws) return; // volvió a tiempo
  jugadores.delete(j.c.id);
  if (j.dentro) {
    j.c.ultimo = ahora(); j.c.jugado += ahora() - (j.desde ?? ahora()); db.cambio();
    aTodos({ t: 'leave', from: j.c.id });
    avisoChat(`${j.c.nombre} ${motivo}`);
    kv(`visto~${j.c.id}`, visto(j.c));
    console.log(`- ${j.c.nombre} salió (${enLinea()} adentro)`);
  }
  const tr = tratos.get(j.c.id); if (tr) cerrarTrato(tr, `${j.c.nombre} se desconectó.`);
  for (const t of trabajos.filter((x) => x.u === j.c.id)) cancelarTrabajo(t);
  contar();
}

// Sesión autenticada: se engancha al jugador (o lo crea). Si la cuenta ya estaba conectada en otro lado, la conexión
// vieja se cierra (nadie puede estar dos veces ni con el mismo nombre al mismo tiempo).
function engancharCuenta(ws, c) {
  let j = jugadores.get(c.id);
  let reconexion = false;
  if (j) {
    if (j.ws && j.ws !== ws) { enviar(j.ws, { t: 'expulsado', motivo: 'Entraste con tu cuenta desde otro lugar.', otroLugar: true }); const viejo = j.ws; j.ws = null; viejo.close(4001); }
    clearTimeout(j.grace); j.grace = null;
    reconexion = j.dentro;
  } else {
    if (enLinea() >= (Number(config.max_jugadores) || 40)) return { error: 'El servidor está lleno. Probá en un rato.' };
    j = { c, ws: null, dentro: false, est: null, cubeta: { n: 60, t: ahora() } };
    jugadores.set(c.id, j);
  }
  j.ws = ws;
  ws.jugador = j;
  return { j, reconexion };
}

async function alMensaje(ws, texto0, ip) {
  // Límite de mensajes por conexión (contra inundar el servidor): 60 por segundo, con reserva
  const cb = ws.cubeta;
  const t0 = ahora();
  cb.n = Math.min(120, cb.n + ((t0 - cb.t) / 1000) * 60); cb.t = t0;
  if ((cb.n -= 1) < 0) { if (!ws.avisoLimite) { ws.avisoLimite = true; console.warn(`Demasiados mensajes desde ${ip}`); } return; }
  let m; try { m = JSON.parse(texto0); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const j = ws.jugador;

  if (m.t === 'sync') { enviar(ws, { t: 'sync', c: m.c, s: ahora() }); return; }
  if (m.t === 'registro' || m.t === 'login' || m.t === 'token') {
    if (j) return;
    if (m.t !== 'token' && !limiteIntentos(ip)) { enviar(ws, { t: 'sesion', ok: false, error: 'Demasiados intentos. Esperá un minuto.' }); return; }
    let c = null;
    try {
      if (m.t === 'token') {
        const s = D.sesiones[sha(String(m.token ?? ''))];
        if (!s || s.exp < ahora() || !D.cuentas[s.u]) { enviar(ws, { t: 'sesion', ok: false, error: 'Tu sesión venció. Entrá de nuevo.', vencida: true }); return; }
        c = D.cuentas[s.u];
      } else {
        const clave = String(m.clave ?? '');
        if (clave.length < 6 || clave.length > 72) { enviar(ws, { t: 'sesion', ok: false, error: 'La contraseña tiene que tener entre 6 y 72 caracteres.' }); return; }
        if (m.t === 'registro') {
          if (!config.registro_abierto) { enviar(ws, { t: 'sesion', ok: false, error: 'El registro de cuentas nuevas está cerrado.' }); return; }
          const nombre = R.nombreValido(m.nombre);
          if (!nombre) { enviar(ws, { t: 'sesion', ok: false, error: 'El nombre tiene que tener entre 3 y 20 letras o números.' }); return; }
          const norm = R.normNombre(nombre);
          if (D.nombres[norm]) { enviar(ws, { t: 'sesion', ok: false, error: `"${nombre}" ya está ocupado. Elegí otro nombre.`, ocupado: true }); return; }
          const sal = crypto.randomBytes(16).toString('hex');
          const hash = await scrypt(clave, sal);
          if (D.nombres[norm]) { enviar(ws, { t: 'sesion', ok: false, error: `"${nombre}" ya está ocupado. Elegí otro nombre.`, ocupado: true }); return; } // (alguien lo tomó mientras tanto)
          c = nuevaCuenta(nombre); c.sal = sal; c.hash = hash;
          D.cuentas[c.id] = c; D.nombres[norm] = c.id; db.cambio();
          console.log(`Cuenta nueva: ${nombre}`);
        } else {
          const id = D.nombres[R.normNombre(m.nombre)];
          const cand = id && D.cuentas[id];
          const hash = await scrypt(clave, cand?.sal ?? 'sin-cuenta');
          if (!cand || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(cand.hash, 'hex'))) { enviar(ws, { t: 'sesion', ok: false, error: 'Nombre o contraseña incorrectos.' }); return; }
          c = cand;
        }
      }
    } catch (e) { console.error(e); enviar(ws, { t: 'sesion', ok: false, error: 'Error del servidor.' }); return; }
    if (!ws.abierto) return;
    const r = engancharCuenta(ws, c);
    if (r.error) { enviar(ws, { t: 'sesion', ok: false, error: r.error }); return; }
    const token = m.t === 'token' ? m.token : nuevoToken(c.id);
    enviar(ws, { t: 'sesion', ok: true, token, u: c.id, nombre: c.nombre, admin: esAdmin(c), reconexion: r.reconexion });
    enviarYo(r.j);
    if (r.reconexion) alEntrar(r.j, true); // volvió después de un corte: sigue adentro, sin avisos
    return;
  }
  if (m.t === 'salir') { if (m.token) { delete D.sesiones[sha(String(m.token))]; db.cambio(); } ws.close(); return; }
  if (!j) return; // lo demás necesita una cuenta

  if (m.t === 'entrar') {
    j.c.perfil.personaje = texto(m.personaje, 30);
    alEntrar(j, false);
    return;
  }
  if (!j.dentro) return;
  if (m.t === 'a' && RELAY.has(m.n)) {
    let d = m.d;
    if (JSON.stringify(d ?? null).length > 16000) return;
    if (m.n === 'estado') {
      d = limpiarEstado(j, d); if (!d) return;
      if (d.playing) { j.est = d; j.c.ultimaEscena = d.s; }
    }
    if (m.n === 'claude' && d && typeof d === 'object' && (d.st || d.say) && conductor() !== j.c.id) return; // solo el que lo maneja mueve a Claude
    const out = JSON.stringify({ t: 'a', n: m.n, from: j.c.id, d });
    if (m.to) { const o = jugadores.get(String(m.to)); if (o?.dentro) enviar(o.ws, out); return; }
    for (const o of jugadores.values()) if (o !== j && o.dentro && o.ws) enviar(o.ws, out);
    return;
  }
  if (m.t === 'chat') {
    const txt = texto(m.txt, 120);
    const t = ahora();
    if (!txt || t - (j.ultimoChat ?? 0) < 600) return;
    j.ultimoChat = t;
    aTodos({ t: 'chat', from: j.c.id, n: j.c.nombre, txt, i: nuevoId(4) }, (o) => o !== j);
    return;
  }
  if (m.t === 'rpc') {
    const op = OPS[m.op];
    if (!op) { enviar(ws, { t: 'rpc', id: m.id, ok: false, error: 'Operación desconocida.' }); return; }
    try {
      const r = op(j, m.a && typeof m.a === 'object' ? m.a : {});
      enviar(ws, { t: 'rpc', id: m.id, ok: true, r });
    } catch (e) {
      if (!(e instanceof ErrorJuego)) console.error(`Error en ${m.op}:`, e);
      enviar(ws, { t: 'rpc', id: m.id, ok: false, error: e instanceof ErrorJuego ? e.message : 'Error del servidor.' });
    }
  }
}

// ---------- HTTP: el juego y las fotos ----------
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', txt: 'text/plain; charset=utf-8',
};
// Solo esto se sirve al público. Nunca: servidor/ (cuentas y contraseñas), .git, blender, studio, servidor-ia.
const PUBLICO = /^\/(index\.html|sw\.js|version\.json|favicon\.ico|(assets|audio|css|data|src)\/.+)$/;
const esLocal = (req) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? '');
const ipDe = (req) => (esLocal(req) && req.headers['cf-connecting-ip']) || req.socket.remoteAddress || '?';
function servir(req, res) {
  const u = new URL(req.url, 'http://x');
  let p; try { p = decodeURIComponent(u.pathname); } catch { res.writeHead(400).end(); return; }
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
  if (p === '/__coronda/estado') {
    res.writeHead(200, { ...base, 'Content-Type': MIME.json, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, jugadores: enLinea(), registro: !!config.registro_abierto })); return;
  }
  const foto = /^\/fotos\/([a-f0-9]{16})\.img$/.exec(p);
  if (foto) {
    const f = path.join(FOTOS, `${foto[1]}.img`);
    let tipo = 'webp'; try { tipo = fs.readFileSync(path.join(FOTOS, `${foto[1]}.tipo`), 'utf8'); } catch { /* nada */ }
    fs.readFile(f, (e, b) => {
      if (e) { res.writeHead(404, base).end(); return; }
      res.writeHead(200, { ...base, 'Content-Type': tipo === 'jpeg' ? 'image/jpeg' : 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      res.end(b);
    });
    return;
  }
  if (p === '/' ) p = '/index.html';
  // dev.html solo desde esta misma PC (es el modo desarrollador)
  const devLocal = p === '/dev.html' && esLocal(req) && !req.headers['cf-connecting-ip'];
  if (!devLocal && !PUBLICO.test(p)) { res.writeHead(404, { ...base, 'Content-Type': MIME.txt }).end('No existe'); return; }
  const file = path.join(ROOT, p);
  // doble control: después de resolver la ruta, tiene que seguir adentro de una carpeta pública (nada de "..")
  const primera = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || !(['assets', 'audio', 'css', 'data', 'src', 'index.html', 'sw.js', 'version.json', 'favicon.ico'].includes(primera) || (devLocal && primera === 'dev.html'))) { res.writeHead(403, base).end(); return; }
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { ...base, 'Content-Type': MIME.txt }).end('No existe'); return; }
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const ext = path.extname(file).slice(1).toLowerCase();
    const h = { ...base, 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h).end(); return; }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(servir);
server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
  const ip = ipDe(req);
  aceptarWebSocket(req, socket, (ws) => {
    ws.cubeta = { n: 60, t: ahora() };
    conexiones.add(ws);
    enviar(ws, { t: 'hola', v: 1, ahora: ahora(), jugadores: enLinea(), registro: !!config.registro_abierto });
    enviarHora(ws);
    ws.onmessage = (t) => { alMensaje(ws, t, ip).catch((e) => console.error(e)); };
    ws.onclose = () => {
      conexiones.delete(ws);
      const j = ws.jugador;
      if (!j || j.ws !== ws) return;
      j.ws = null;
      if (!j.dentro) { jugadores.delete(j.c.id); return; }
      // se cortó: tiene unos segundos para volver (reconexión) antes de que los demás lo vean salir
      j.grace = setTimeout(() => alSalir(j), GRACIA_MS);
    };
  });
});
// Conexiones muertas (sin señales en 60 s) se cierran; las vivas reciben un ping
setInterval(() => { const t = ahora(); for (const ws of conexiones) { if (t - ws.ultimo > 60000) ws.close(1001); else ws.ping(); } }, 20000).unref();
// Última conexión de los que están jugando, cada minuto
setInterval(() => { for (const j of jugadores.values()) if (j.dentro) { j.c.ultimo = ahora(); } db.cambio(); }, 60000).unref();

server.listen(PUERTO, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log(`  │  Servidor de Coronda en http://localhost:${PUERTO}  │`);
  console.log('  └──────────────────────────────────────────────┘');
  console.log(`  Cuentas: ${Object.keys(D.cuentas).length} · Admins: ${(config.admins ?? []).join(', ') || '(ninguno: agregalos en servidor/config.json)'}`);
  console.log('  Para cerrarlo: Ctrl+C (guarda todo antes de salir).');
});
function cerrar() {
  console.log('\nGuardando el mundo…');
  try { db.guardarYa(); } catch (e) { console.error(e); }
  for (const ws of conexiones) { enviar(ws, { t: 'apagado' }); ws.close(1001); }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);

export { OPS, D, jugadores }; // (para las pruebas)
