// Base de datos del mundo: un archivo JSON en servidor/datos/mundo.json.
// - Se guarda de forma atómica (se escribe un archivo temporal y se renombra): si se corta la luz a mitad de un
//   guardado, queda el archivo anterior entero, nunca uno a medio escribir.
// - Se guarda poco después de cada cambio (agrupando los cambios seguidos) y al cerrar el servidor.
// - Una copia por hora en servidor/datos/copias/ (se guardan las últimas 48).
import fs from 'node:fs';
import path from 'node:path';

export const VACIA = () => ({
  version: 1,
  creada: Date.now(),
  cuentas: {},     // id -> cuenta (ver nuevaCuenta en coronda-server.mjs)
  nombres: {},     // nombre normalizado -> id de cuenta
  sesiones: {},    // hash del token -> { u, exp }
  lotes: {},       // clave del lote -> { o, n, m, v, c }
  casas: {},       // clave del lote -> { c, o, v, items, mu }
  pedidos: {},     // id -> pedido de la Carpintería
  arboles: {},     // escena.arbol -> { hasta, golpes, tandas }
  cofres: {},      // id del cofre -> { o, items: { 'recursos:madera': 3 } }
  mundo: { desfase: null, seq: 0 }, // desfase de la hora puesto por el admin (null = el de tiempo.json)
});

export function abrirDB(dir) {
  const file = path.join(dir, 'mundo.json');
  const copias = path.join(dir, 'copias');
  fs.mkdirSync(copias, { recursive: true });
  let data;
  try {
    data = { ...VACIA(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    if (fs.existsSync(file)) {
      // Archivo roto: se aparta (no se pisa) y se arranca con la última copia buena si hay
      const roto = `${file}.roto-${Date.now()}`;
      fs.renameSync(file, roto);
      console.error(`⚠ mundo.json no se pudo leer (${e.message}). Se apartó como ${path.basename(roto)}.`);
      const ult = fs.readdirSync(copias).filter((f) => f.endsWith('.json')).sort().pop();
      if (ult) { data = { ...VACIA(), ...JSON.parse(fs.readFileSync(path.join(copias, ult), 'utf8')) }; console.error(`  Se usó la copia ${ult}.`); }
    }
    data ??= VACIA();
  }
  let timer = null, sucio = false;
  function guardarYa() {
    clearTimeout(timer); timer = null;
    if (!sucio) return;
    sucio = false;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  function cambio() {
    sucio = true;
    if (!timer) timer = setTimeout(() => { try { guardarYa(); } catch (e) { console.error('No se pudo guardar el mundo:', e); } }, 1500);
  }
  function copia() {
    try {
      guardarYa();
      if (!fs.existsSync(file)) return;
      const nombre = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
      fs.copyFileSync(file, path.join(copias, nombre));
      const todas = fs.readdirSync(copias).filter((f) => f.endsWith('.json')).sort();
      for (const f of todas.slice(0, -48)) fs.unlinkSync(path.join(copias, f));
    } catch (e) { console.error('No se pudo hacer la copia:', e.message); }
  }
  setInterval(copia, 3600e3).unref();
  return { data, cambio, guardarYa, copia };
}
