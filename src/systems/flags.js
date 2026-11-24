// Memoria del mundo (como los "event flags" de Ocarina of Time): sí/no y contadores que el juego recuerda.
// Se guardan en localStorage, así que sobreviven al recargar la página.
//
// Flags automáticos de cada NPC con diálogo (el id es el nombre del Empty sin "npc_", ej. npc_tokse -> "tokse"):
//   hablo_<id>   true desde la primera vez que le hablás
//   veces_<id>   cuántas veces le hablaste (1, 2, 3...)
// Los demás los inventás vos: en un Empty con npc_pone = "tiene_espada" (o varios separados por coma),
// o en el JSON de un diálogo con "set": { "tiene_espada": true }.
//
// Condiciones ("if"): objeto { flag: valor }, se cumplen todas.
//   { "hablo_tokse": true }          prendido        { "tiene_espada": false }   apagado
//   { "veces_tokse": ">=3" }         comparación (>=, <=, >, <, ==, !=) con números
//   { "tokse_humor": "alegre" }      igualdad con un texto
// Para borrar todo mientras probás: en la consola del navegador, flags.reset()
const KEY = 'coronda:flags';
let data = {};
try { data = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { data = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* modo privado: queda en memoria */ } };

const CMP = /^(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/;

export const flags = {
  get(k) { return data[k]; },
  set(k, v = true) { data[k] = v; save(); },
  inc(k) { data[k] = (Number(data[k]) || 0) + 1; save(); return data[k]; },
  check(cond) {
    if (!cond || typeof cond !== 'object') return true;
    return Object.entries(cond).every(([k, want]) => {
      const have = data[k];
      if (typeof want === 'boolean') return Boolean(have) === want;
      if (typeof want === 'string') {
        const m = CMP.exec(want.trim());
        if (m) {
          const a = Number(have) || 0, b = Number(m[2]);
          return { '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b, '==': a === b, '!=': a !== b }[m[1]];
        }
      }
      return have === want;
    });
  },
  reset() { data = {}; save(); },
};
if (typeof window !== 'undefined') window.flags = flags; // para probar desde la consola
