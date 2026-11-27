// Gestión del servidor (solo admins): datos para el panel del juego (src/ui/panel-gestion.js).
// Se engancha en coronda-server.mjs como la operación "gestion" (OPS.gestion) y nunca cambia nada por su cuenta:
// las únicas operaciones que modifican datos son "despojar" y "eliminar", y solo las ejecuta un admin.
//
//   net.rpc('gestion', { a: 'resumen' })                 mundo (hora, tiempo encendido, conectados) y totales de lotes
//   net.rpc('gestion', { a: 'lotes' })                   todos los lotes del mapa: dueño, modelo de casa, muebles
//   net.rpc('gestion', { a: 'jugadores' })               todas las cuentas: conexión, última conexión, lotes
//   net.rpc('gestion', { a: 'jugador', u: '<id>' })      una cuenta con su mochila completa
//   net.rpc('gestion', { a: 'despojar', k: '<lote>' })   le saca el lote al dueño y le DEVUELVE a la mochila los muebles y lo de los cofres
//   net.rpc('gestion', { a: 'eliminar', k: '<lote>' })   libera el lote y borra la casa (lo de los cofres vuelve al dueño; los muebles se pierden)
//
// "Cuántos lotes hay en total" sale de los Empties lote_NN que traen los .glb de las escenas (se leen solo las
// cabeceras del .glb, no el modelo entero). Un lote con dueño que ya no está en el mapa aparece igual, marcado.
//
// Cambios respecto a la versión anterior:
//  - data/casas.json se lee una sola vez por consulta (antes una vez por lote).
//  - La versión del lote (v) ya no puede dar NaN.
//  - Las búsquedas por clave usan Object.hasOwn (no aceptan "constructor", "__proto__", etc.).
//  - Si la cuenta del dueño no existe, los muebles se cuentan como perdidos (antes se perdían sin avisar).
//  - Se valida el largo del bloque JSON del .glb contra el tamaño real del archivo.
//  - Cada despojo/eliminación queda anotado en data/gestion-registro.log (además de la consola).
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^(?:empty_)?lote_(.+)$/i; // el mismo criterio que src/systems/lotes.js
const sano = (t) => String(t).toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
const tiene = (obj, k) => obj != null && Object.hasOwn(obj, k);
const MAX_JSON_GLB = 8 * 1024 * 1024; // tope razonable para la cabecera JSON de un .glb

// Nombres de los nodos de un .glb que son lotes: [{ base, label }] (solo se lee el bloque JSON del archivo)
function nodosDeLote(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 20) return [];
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    if (head.toString('latin1', 0, 4) !== 'glTF') return [];
    if (head.toString('latin1', 16, 20) !== 'JSON') return [];
    const len = head.readUInt32LE(12);
    if (len <= 0 || len > MAX_JSON_GLB || 20 + len > size) return []; // archivo dañado
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 20);
    const gltf = JSON.parse(buf.toString('utf8'));
    const out = [];
    for (const n of gltf.nodes ?? []) {
      // El navegador (GLTFLoader) limpia los nombres de los nodos: espacios -> "_" y saca [ ] . : /
      // ("lote_01.001" de Blender llega como "lote_01001"). Acá se hace igual para que la clave del lote coincida.
      const nombre = String(n.name ?? '').replace(/\s/g, '_').replace(/[\[\].:/]/g, '');
      const m = NAME_RE.exec(nombre);
      const marcado = n.extras?.lote !== undefined && n.extras.lote !== false && n.extras.lote !== 0;
      if (m) out.push({ base: `lote_${sano(m[1])}`, label: `Lote ${m[1]}` });
      else if (marcado) out.push({ base: sano(nombre), label: nombre });
    }
    return out;
  } finally { fs.closeSync(fd); }
}

export function crearGestion(ctx) {
  const { D, db, T, R, ROOT, jugadores, esAdmin, falla, ahora, leer, tiempoCfg, numeroLote, liberarLoteAdmin, vaciarCofresDe, sumar, contarMuebles, kv, enviarYo, enviar, enLinea } = ctx;
  // El registro va en servidor/datos/ (privado, no se sube a GitHub). NUNCA en data/: esa carpeta se sirve al público
  // y el servidor la vigila para recargar las tablas cada vez que algo cambia adentro.
  const DATOS = ctx.DATOS ?? path.join(ROOT, 'servidor', 'datos');
  const INICIO = ahora();
  let quien = 'un admin'; // el admin que está operando (para el registro de la consola)
  const cache = new Map(); // archivo -> { mtime, nodos }
  let casasMemo = null;    // data/casas.json, leído una sola vez por consulta

  const nodos = (rel) => {
    const file = path.join(ROOT, rel);
    try {
      const mt = fs.statSync(file).mtimeMs, c = cache.get(file);
      if (c?.mtime === mt) return c.nodos;
      const n = nodosDeLote(file);
      cache.set(file, { mtime: mt, nodos: n });
      return n;
    } catch { return []; }
  };

  // Todos los lotes del mapa: Map(clave -> { escena, label })
  function lotesDelMapa() {
    const out = new Map();
    const tabla = leer('data/tables/scenes.json', {});
    for (const [id, ent] of Object.entries(tabla)) {
      const esc = leer(ent?.file ?? '', null);
      if (!esc) continue;
      const sceneId = esc.id ?? id;
      for (const room of esc.rooms ?? []) {
        if (!room?.model) continue;
        for (const n of nodos(room.model)) {
          const key = `${sceneId}.${n.base}`.slice(0, 80);
          if (!out.has(key)) out.set(key, { escena: sceneId, label: n.label });
        }
      }
    }
    return out;
  }

  const nombreCasa = (id) => {
    if (!casasMemo) casasMemo = leer('data/casas.json', { casas: [] }).casas ?? [];
    return casasMemo.find((c) => c.id === id)?.nombre ?? id;
  };
  const loteReg = (k) => (tiene(D.lotes, k) ? D.lotes[k] : undefined);
  const cuentaReg = (id) => (tiene(D.cuentas, id) ? D.cuentas[id] : undefined);
  const casaDe = (k) => { const l = loteReg(k), c = tiene(D.casas, k) ? D.casas[k] : undefined; return l?.o && c && c.c === l.c ? c : null; };

  function filaLote(k, info) {
    const r = loteReg(k);
    const casa = casaDe(k);
    return {
      k, nro: numeroLote(k), escena: info?.escena ?? k.split('.')[0], label: info?.label ?? k,
      enMapa: !!info,
      dueño: r?.o ? r.n || cuentaReg(r.o)?.nombre || '(sin nombre)' : null,
      dueñoId: r?.o ?? null,
      conectado: !!(r?.o && jugadores.get(r.o)?.dentro),
      modelo: r?.o ? nombreCasa(r.m) : null,
      muebles: casa ? Object.values(contarMuebles(casa.items)).reduce((a, b) => a + b, 0) : 0,
    };
  }

  function lotes() {
    const mapa = lotesDelMapa();
    const filas = [...mapa].map(([k, info]) => filaLote(k, info));
    for (const [k, r] of Object.entries(D.lotes)) if (r.o && !mapa.has(k)) filas.push(filaLote(k, null)); // con dueño pero ya no está en el mapa
    filas.sort((a, b) => a.escena.localeCompare(b.escena) || (a.nro ?? 0) - (b.nro ?? 0) || a.k.localeCompare(b.k));
    const ocupados = filas.filter((f) => f.dueño).length;
    return { total: filas.length, ocupados, libres: filas.length - ocupados, lista: filas };
  }

  function resumen() {
    const cfg = tiempoCfg();
    const h = R.hora(cfg, ahora());
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    const l = lotes();
    return {
      ahora: ahora(), iniciado: INICIO,
      hora: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      horaPuesta: D.mundo.desfase !== null && D.mundo.desfase !== undefined, // un admin la fijó con /time set
      diaMinutos: cfg.dia_minutos,
      conectados: enLinea(), cuentas: Object.keys(D.cuentas).length,
      lotes: { total: l.total, ocupados: l.ocupados, libres: l.libres },
    };
  }

  const lotesDe = (id) => Object.entries(D.lotes).filter(([, r]) => r.o === id).map(([k]) => k);

  function jugadoresLista() {
    const lista = Object.values(D.cuentas).map((c) => ({
      u: c.id, n: c.nombre, ultimo: c.ultimo || 0, creado: c.creado || 0, jugado: c.jugado || 0,
      conectado: !!jugadores.get(c.id)?.dentro, escena: c.ultimaEscena ?? '', lotes: lotesDe(c.id).length,
    }));
    lista.sort((a, b) => Number(b.conectado) - Number(a.conectado) || b.ultimo - a.ultimo || String(a.n).localeCompare(String(b.n)));
    return lista;
  }

  function jugador(u) {
    const c = cuentaReg(String(u ?? ''));
    if (!c) falla('Esa cuenta no existe.');
    const items = (kind, tabla) => Object.entries(c.inv?.[kind] ?? {}).filter(([, n]) => n > 0)
      .map(([id, n]) => ({ id, n, nombre: tabla(id) })).sort((a, b) => a.nombre.localeCompare(b.nombre));
    const niv = R.nivelDe(T.niveles, c.niveles?.xp ?? 0);
    return {
      u: c.id, n: c.nombre, ultimo: c.ultimo || 0, creado: c.creado || 0, jugado: c.jugado || 0,
      conectado: !!jugadores.get(c.id)?.dentro, escena: c.ultimaEscena ?? '',
      nivel: niv.nivel, xp: c.niveles?.xp ?? 0, stats: c.stats ?? {},
      recursos: items('recursos', (id) => T.recursos[id]?.nombre ?? id),
      muebles: items('muebles', (id) => T.muebles.get(id)?.nombre ?? id),
      lotes: lotesDe(c.id).map((k) => ({ k, nro: numeroLote(k), modelo: nombreCasa(D.lotes[k].m) })),
    };
  }

  const lotePropio = (k) => {
    k = String(k ?? '');
    const cur = loteReg(k);
    if (!cur?.o) falla('Ese lote no tiene dueño.');
    return { k, cur };
  };

  // Registro de auditoría: consola + archivo (si el archivo falla, no se rompe la operación)
  function registrar(msg) {
    const linea = `[${new Date(ahora()).toISOString()}] ${msg}`;
    console.log(`Gestión: ${msg}`);
    try { fs.appendFileSync(path.join(DATOS, 'gestion-registro.log'), linea + '\n'); } catch { /* sin registro en disco */ }
  }

  // Despojar: el lote vuelve a quedar libre, pero el dueño no pierde nada: los muebles de la casa y lo de los cofres
  // vuelven a su mochila (lo que no entre por el tope de la mochila se pierde, y se informa).
  function despojar(k0) {
    const { k, cur } = lotePropio(k0);
    const dueño = cuentaReg(cur.o);
    const casa = casaDe(k);
    let devueltos = 0, perdidos = vaciarCofresDe(k, cur.c, cur.o) || 0;
    if (casa) {
      for (const [m, n] of Object.entries(contarMuebles(casa.items))) {
        if (dueño) { const put = sumar(dueño, 'muebles', m, n); devueltos += put; perdidos += n - put; }
        else perdidos += n; // la cuenta ya no existe: no hay a quién devolverle
      }
    }
    const nombre = cur.n || dueño?.nombre || '(sin nombre)';
    D.lotes[k] = { o: null, n: '', m: null, v: (Number(cur.v) || 0) + 1 };
    delete D.casas[k];
    db.cambio(); kv(k, D.lotes[k]); kv(`casa~${k}`, null);
    const jj = dueño && jugadores.get(dueño.id);
    if (jj?.ws) {
      enviarYo(jj);
      enviar(jj.ws, { t: 'aviso', txt: `🏚️ Un admin te quitó el lote ${numeroLote(k) ?? ''}. Tus muebles y lo de los cofres volvieron a tu mochila${perdidos ? ` (${perdidos} cosas no entraron)` : ''}.` });
    }
    registrar(`${quien} despojó a ${nombre} del lote ${k} (${devueltos} muebles devueltos, ${perdidos} perdidos).`);
    return { txt: `Lote ${numeroLote(k) ?? k}: ${nombre} fue despojado. Se le devolvieron ${devueltos} muebles${perdidos ? ` (${perdidos} cosas no se pudieron devolver)` : ''}.` };
  }

  function eliminar(k0) {
    const { k } = lotePropio(k0);
    const r = liberarLoteAdmin(k);
    registrar(`${quien} eliminó el lote ${k} (era de ${r.dueño}).`);
    return { txt: `Lote ${numeroLote(k) ?? k} eliminado (era de ${r.dueño}): la casa se borró y el lote quedó libre.` };
  }

  return function gestion(j, { a, k, u } = {}) {
    if (!esAdmin(j.c)) falla('No sos admin.');
    quien = j.c.nombre;
    casasMemo = null; // cada consulta lee casas.json de nuevo, una sola vez
    switch (a) {
      case 'resumen': return resumen();
      case 'lotes': return lotes();
      case 'jugadores': return { lista: jugadoresLista() };
      case 'jugador': return jugador(u);
      case 'despojar': return despojar(k);
      case 'eliminar': return eliminar(k);
      default: return falla('Operación de gestión desconocida.');
    }
  };
}
