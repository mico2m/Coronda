// Id de jugador que se guarda en el navegador (no hay cuentas): lo usan los lotes, las casas y la lista de jugadores.
// Borrar los datos del sitio = id nuevo (y perder los lotes).
const UID_STORE = 'coronda.uid';
let cached = null;

export function getUid() {
  if (cached) return cached;
  const r = () => Math.random().toString(36).slice(2, 10);
  try {
    // Prueba con dos pestañas en la misma PC (?mp=local): cada pestaña es otro jugador, con su propio id
    const store = /[?&]mp=local/.test(location.search) ? sessionStorage : localStorage;
    let u = store.getItem(UID_STORE);
    if (!u) { u = (globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16)) || (r() + r()); store.setItem(UID_STORE, u); }
    cached = u;
  } catch { cached = r() + r(); }
  return cached;
}
