// Reglas compartidas entre el servidor (servidor/coronda-server.mjs) y el juego (src/…).
// Son cuentas puras (sin three.js ni DOM): la hora del mundo, la fila de la Carpintería y los niveles.
// El servidor las usa para DECIDIR; el juego, para DIBUJAR lo mismo que decidió el servidor (con su reloj sincronizado).
// Extensión .mjs: así Node la carga como módulo sin tocar el resto del proyecto.

// ---------- Hora del mundo ----------
// cfg = data/tables/tiempo.json (+ el desfase que pone el admin). t = ms del reloj del SERVIDOR.
export function horasTotales(cfg, t) { return (t / (Math.max(1, Number(cfg.dia_minutos) || 24) * 60000)) * 24 + (Number(cfg.desfase_horas) || 0); }
export function hora(cfg, t) { const h = horasTotales(cfg, t) % 24; return h < 0 ? h + 24 : h; }
export function dia(cfg, t) { return Math.floor(horasTotales(cfg, t) / 24); }
export function enRango(h, desde, hasta) { return desde <= hasta ? h >= desde && h < hasta : h >= desde || h < hasta; }
export function hastaHora(cfg, h, t) {
  const dayMs = Math.max(1, Number(cfg.dia_minutos) || 24) * 60000;
  let d = (h - hora(cfg, t)) % 24; if (d <= 0) d += 24;
  return (d / 24) * dayMs;
}
// Desfase para que en el momento t sean las `h` (lo usa /time set del admin)
export function desfaseParaHora(cfg, h, t) {
  const dayMs = Math.max(1, Number(cfg.dia_minutos) || 24) * 60000;
  return (((Number(h) - (t / dayMs) * 24) % 24) + 24) % 24;
}

// ---------- Carpintería: fila de pedidos ----------
// Pedido: { id, u, n, m, q (cantidad), t (cuándo se pidió), d (duración total ms), s (slot), h (respeta horario) }
// horario = { abre, cierra } (tiempo.json > tienda). Se fabrica de a un pedido, por orden de llegada.
export function crearTaller(tcfg, horario) {
  const abiertaEn = (t) => !horario || enRango(hora(tcfg, t), horario.abre, horario.cierra);
  const proximaApertura = (t) => (!horario || abiertaEn(t) ? t : t + hastaHora(tcfg, horario.abre, t));
  function sumarTrabajo(t, dur) {
    if (!horario) return t + dur;
    let now = proximaApertura(t), left = dur;
    for (let i = 0; left > 0 && i < 400; i++) {
      const paso = Math.min(left, hastaHora(tcfg, horario.cierra, now));
      now += paso; left -= paso;
      if (left > 0) now = proximaApertura(now + 1);
    }
    return now;
  }
  function trabajoEntre(a, b) {
    if (!horario) return Math.max(0, b - a);
    let now = a, total = 0;
    for (let i = 0; now < b && i < 400; i++) {
      if (!abiertaEn(now)) { now = Math.min(b, now + hastaHora(tcfg, horario.abre, now)); continue; }
      const fin = Math.min(b, now + hastaHora(tcfg, horario.cierra, now));
      total += fin - now; now = fin;
    }
    return total;
  }
  // La fila con el inicio y el fin de cada pedido
  function fila(pedidos) {
    const list = [...pedidos].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
    let end = 0;
    return list.map((o, i) => {
      const desde = Math.max(o.t, end);
      const start = o.h ? proximaApertura(desde) : desde;
      end = o.h ? sumarTrabajo(start, o.d) : start + o.d;
      return { ...o, start, end, pos: i + 1 };
    });
  }
  // Progreso de un pedido (ya con start/end) en el momento `now`
  function estado(o, now) {
    const hecho = o.h ? trabajoEntre(o.start, Math.min(now, o.end)) : now - o.start;
    const progreso = Math.min(1, Math.max(0, hecho / o.d));
    return { progreso, listo: now >= o.end, fabricando: now >= o.start && now < o.end };
  }
  return { abiertaEn, proximaApertura, sumarTrabajo, trabajoEntre, fila, estado };
}

// ---------- Niveles ----------
export function paraSubir(ncfg, n) { return Math.round(ncfg.xp_base * Math.pow(n, ncfg.xp_exponente)); }
export function nivelDe(ncfg, xp) {
  let n = 1, resto = xp;
  while (n < ncfg.nivel_max && resto >= paraSubir(ncfg, n)) { resto -= paraSubir(ncfg, n); n++; }
  return { nivel: n, xpNivel: resto, siguiente: n < ncfg.nivel_max ? paraSubir(ncfg, n) : 0 };
}

// ---------- Nombres ----------
// "Martín Gómez" -> "martingomez": dos nombres que se ven iguales no pueden ser de jugadores distintos
export function normNombre(name) {
  return String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}
// Nombre visible permitido: 3 a 20 letras, números, espacios, guiones o puntos (sin caracteres invisibles)
export function nombreValido(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 3 || n.length > 20) return null;
  if (!/^[\p{L}\p{N} ._-]+$/u.test(n)) return null;
  if (normNombre(n).length < 3) return null;
  return n;
}
