// Comandos de admin en el chat. Los ejecuta el SERVIDOR (servidor/coronda-server.mjs > OPS.admin).
//
//   /time set 19  ·  /time set 19:30   poner la hora del mundo para todos
//   /time reset                        volver a la hora normal (la de data/tables/tiempo.json)
//   /anuncio texto                     cartel para todos
//   /madera Ana 20                     darle madera a un jugador (o "todos")
//   /resistencia Ana                   recargar la energía de un jugador (o "todos")
//   /expulsar Ana                      sacarlo del servidor
//   /borrarpedido id                   sacar un pedido de la Carpintería
//   /ayuda                             la lista
//
// Quién es admin: las cuentas anotadas en servidor/config.json > "admins" (por nombre). No hay clave que escribir en el
// juego: el servidor sabe con qué cuenta entraste. Un jugador común que escribe un comando recibe "No sos admin".
// Lo que empieza con "/" nunca se manda al chat de los demás.

export function createAdmin({ net, chat, stage = null, notify = () => {} }) {
  const sys = (t) => chat?.add?.('', t, false, true);

  const banner = document.createElement('div');
  banner.className = 'admin-anuncio'; banner.hidden = true;
  (stage ?? document.querySelector('.app') ?? document.body).appendChild(banner);
  let bannerT = null;
  function anunciar(texto) {
    banner.textContent = `📢 ${texto}`; banner.hidden = false;
    clearTimeout(bannerT); bannerT = setTimeout(() => { banner.hidden = true; }, 7000);
    sys(`📢 Anuncio: ${texto}`);
  }
  if (net) {
    const prevA = net.onAnuncio; net.onAnuncio = (t) => { prevA?.(t); anunciar(t); };
  }

  const AYUDA = 'Comandos de admin: /time set 19 (o 19:30) · /time reset · /anuncio texto · /madera Jugador 20 · /resistencia Jugador · /expulsar Jugador · /borrarpedido id';

  // Devuelve true si el texto era un comando (nunca va al chat de los demás)
  async function comando(texto) {
    const t = String(texto ?? '').trim();
    if (!t.startsWith('/')) return false;
    const cmd = t.slice(1).split(/\s+/)[0].toLowerCase();
    if (cmd === 'ayuda' || cmd === 'help') { sys(net?.admin ? AYUDA : 'Los comandos son para los admins del servidor.'); return true; }
    if (cmd === 'admin') { sys('Ya no hace falta clave: los admins se anotan en servidor/config.json > "admins" (con el nombre de su cuenta).'); return true; }
    if (!net) { sys('Los comandos solo andan en el servidor.'); return true; }
    try {
      const r = await net.rpc('admin', { cmd: t });
      if (/^\/madera/i.test(t)) sys(`🪵 Listo (${(r?.a ?? []).join(', ') || 'hecho'}).`);
      else if (/^\/(resistencia|expulsar|borrarpedido)/i.test(t)) sys('✅ Hecho.');
    } catch (e) { sys(`❌ ${e.message}`); }
    return true;
  }

  return { comando, anunciar };
}
