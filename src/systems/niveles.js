// Niveles y aptitudes. Ganás experiencia (XP) haciendo cosas en el mundo (talar, retirar muebles); al juntar la XP
// necesaria subís de nivel y recibís puntos para mejorar aptitudes. Por ahora hay una: Energía (más energía máxima
// para talar y correr, ver systems/bosque.js).
//
// Configuración: data/tables/niveles.json (también desde el Studio, panel Mundo):
//   xp_por_hachazo, xp_por_arbol, xp_por_mueble   XP por cada cosa
//   xp_base, xp_exponente                         XP para pasar del nivel n al n+1 = xp_base × n^xp_exponente
//   nivel_max, puntos_por_nivel
//   aptitudes: { id: { nombre, icono, descripcion, por_punto, max_puntos } }
// Se guarda en el navegador (localStorage 'coronda.niveles'), como la mochila: { xp, gastados: { energia: 2 } }.
//
// API: niveles.ganar('hachazo' | 'arbol' | 'mueble' | número, cantidad) · niveles.bonus('energia') (lo que suma esa aptitud)
//      niveles.estado (nivel, xp, para el siguiente, puntos libres…) · niveles.abrir() / cerrar() / alternar() (tecla N)
//      niveles.mejorar('energia') · niveles.onChange(fn) · niveles.setConfig(c) · niveles.reiniciar()
import { loadJSON } from '../core/assets.js';

const STORE = 'coronda.niveles';
export const NIVELES_DEFAULT = {
  xp_por_hachazo: 2, xp_por_arbol: 10, xp_por_mueble: 15, xp_base: 50, xp_exponente: 1.5, nivel_max: 30, puntos_por_nivel: 1,
  aptitudes: { energia: { nombre: 'Energía', icono: '⚡', descripcion: 'Más energía máxima para talar y correr.', por_punto: 5, max_puntos: 10 } },
};
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// opts: stage, notify(msg), blocked() (charla abierta: la N no hace nada), onOpen() / onClose() (frenar al personaje)
export function createNiveles({ stage, notify = () => {}, blocked = () => false, onOpen = () => {}, onClose = () => {} } = {}) {
  let cfg = structuredClone(NIVELES_DEFAULT);
  let data = { xp: 0, gastados: {} };
  try { const d = JSON.parse(localStorage.getItem(STORE)); if (d && typeof d === 'object') data = { xp: Math.max(0, Number(d.xp) || 0), gastados: { ...(d.gastados ?? {}) } }; } catch { /* nada */ }
  const guardar = () => { try { localStorage.setItem(STORE, JSON.stringify(data)); } catch { /* modo privado */ } };
  const listeners = new Set();
  const avisar = () => { listeners.forEach((f) => { try { f(estado()); } catch (e) { console.error(e); } }); dibujar(); };

  function setConfig(c) {
    if (!c || typeof c !== 'object') return;
    cfg = { ...cfg, ...c, aptitudes: { ...cfg.aptitudes, ...(c.aptitudes ?? {}) } };
    for (const k of ['xp_por_hachazo', 'xp_por_arbol', 'xp_por_mueble']) cfg[k] = Math.max(0, Number(cfg[k]) || 0);
    cfg.xp_base = Math.max(1, Number(cfg.xp_base) || NIVELES_DEFAULT.xp_base);
    cfg.xp_exponente = Math.min(4, Math.max(0, Number(cfg.xp_exponente) || 0));
    cfg.nivel_max = Math.max(1, Math.round(Number(cfg.nivel_max) || NIVELES_DEFAULT.nivel_max));
    cfg.puntos_por_nivel = Math.max(0, Math.round(Number(cfg.puntos_por_nivel) || 0));
    for (const a of Object.values(cfg.aptitudes)) { a.por_punto = Number(a.por_punto) || 0; a.max_puntos = Math.max(0, Math.round(Number(a.max_puntos) || 0)); }
    avisar();
  }
  loadJSON('data/tables/niveles.json').then(setConfig).catch(() => {});

  // ---------- Cuentas ----------
  const paraSubir = (n) => Math.round(cfg.xp_base * Math.pow(n, cfg.xp_exponente)); // XP del nivel n al n+1
  function nivelDe(xp) {
    let n = 1, resto = xp;
    while (n < cfg.nivel_max && resto >= paraSubir(n)) { resto -= paraSubir(n); n++; }
    return { nivel: n, xpNivel: resto, siguiente: n < cfg.nivel_max ? paraSubir(n) : 0 };
  }
  const gastados = () => Object.values(data.gastados).reduce((a, b) => a + (Number(b) || 0), 0);
  function estado() {
    const { nivel, xpNivel, siguiente } = nivelDe(data.xp);
    const total = (nivel - 1) * cfg.puntos_por_nivel;
    return { nivel, xp: data.xp, xpNivel, siguiente, maximo: nivel >= cfg.nivel_max, puntos: Math.max(0, total - gastados()), puntosTotales: total, gastados: { ...data.gastados } };
  }
  const bonus = (id) => (Number(data.gastados[id]) || 0) * (cfg.aptitudes[id]?.por_punto || 0);

  // ---------- Ganar XP ----------
  function ganar(que, cant = 1) {
    const xp = typeof que === 'number' ? que : (cfg[`xp_por_${que}`] || 0) * cant;
    if (!(xp > 0)) return 0;
    const antes = nivelDe(data.xp).nivel;
    data.xp = Math.round((data.xp + xp) * 100) / 100;
    guardar();
    const ahora = nivelDe(data.xp).nivel;
    flotar(`+${xp} XP`);
    if (ahora > antes) subio(ahora);
    avisar();
    return xp;
  }
  function mejorar(id) {
    const a = cfg.aptitudes[id];
    const e = estado();
    if (!a || e.puntos <= 0 || (Number(data.gastados[id]) || 0) >= a.max_puntos) return false;
    data.gastados[id] = (Number(data.gastados[id]) || 0) + 1;
    guardar(); avisar();
    return true;
  }
  function reiniciar() { data = { xp: 0, gastados: {} }; guardar(); avisar(); }

  // ---------- Interfaz: barra de XP, cartel de nivel, ventana de aptitudes ----------
  const host = stage ?? document.body;
  const barra = document.createElement('div');
  barra.className = 'xp-bar';
  barra.innerHTML = '<i></i><span></span>';
  host.append(barra);
  const cartel = document.createElement('div');
  cartel.className = 'nivel-cartel'; cartel.hidden = true;
  host.append(cartel);
  const pop = document.createElement('div');
  pop.className = 'xp-pop'; pop.hidden = true;
  host.append(pop);
  const ventana = document.createElement('div');
  ventana.className = 'apt-panel'; ventana.hidden = true;
  ventana.setAttribute('role', 'dialog'); ventana.setAttribute('aria-label', 'Aptitudes');
  host.append(ventana);
  const boton = document.createElement('button');
  boton.type = 'button'; boton.className = 'apt-btn'; boton.textContent = '⭐';
  boton.title = 'Nivel y aptitudes (N)'; boton.setAttribute('aria-label', 'Nivel y aptitudes');
  host.append(boton);

  let popT = 0;
  function flotar(t) {
    pop.textContent = t; pop.hidden = false;
    pop.classList.remove('sube'); void pop.offsetWidth; pop.classList.add('sube');
    clearTimeout(popT); popT = setTimeout(() => { pop.hidden = true; }, 1300);
  }
  let cartelT = 0;
  function subio(n) {
    const e = estado();
    cartel.innerHTML = `<b>¡Nivel ${n}!</b><small>${e.puntos > 0 ? `Tenés ${e.puntos} punto${e.puntos > 1 ? 's' : ''} de aptitud: tocá ⭐ o la tecla N` : 'Seguí así'}</small>`;
    cartel.hidden = false;
    cartel.classList.remove('entra'); void cartel.offsetWidth; cartel.classList.add('entra');
    clearTimeout(cartelT); cartelT = setTimeout(() => { cartel.hidden = true; }, 4200);
    notify(`¡Subiste a nivel ${n}!`);
  }

  function dibujar() {
    const e = estado();
    const k = e.maximo ? 1 : e.siguiente ? e.xpNivel / e.siguiente : 0;
    barra.querySelector('i').style.width = `${Math.round(k * 1000) / 10}%`;
    barra.querySelector('span').textContent = e.maximo ? `Nivel ${e.nivel} · máximo` : `Nivel ${e.nivel} · ${Math.floor(e.xpNivel)} / ${e.siguiente} XP`;
    boton.classList.toggle('con-puntos', e.puntos > 0);
    boton.dataset.puntos = e.puntos > 0 ? String(e.puntos) : '';
    document.querySelectorAll('.wow-nivel').forEach((b) => { b.textContent = e.nivel; }); // insignia del retrato (ui/wow-hud.js)
    if (ventana.hidden) return;
    const apt = Object.entries(cfg.aptitudes).map(([id, a]) => {
      const n = Number(data.gastados[id]) || 0;
      const puede = e.puntos > 0 && n < a.max_puntos;
      return `<div class="apt-fila">
        <div class="apt-ico" aria-hidden="true">${esc(a.icono ?? '•')}</div>
        <div class="apt-txt"><b>${esc(a.nombre ?? id)}</b> <span class="apt-rango">${n} / ${a.max_puntos}</span>
          <small>${esc(a.descripcion ?? '')} <em>+${a.por_punto} por punto · ahora +${n * a.por_punto}</em></small></div>
        <button type="button" data-apt="${esc(id)}"${puede ? '' : ' disabled'} aria-label="Mejorar ${esc(a.nombre ?? id)}">+</button></div>`;
    }).join('');
    ventana.innerHTML = `<div class="apt-card">
      <div class="apt-head"><b>Nivel ${e.nivel}</b><button type="button" class="apt-x" aria-label="Cerrar">✕</button></div>
      <div class="apt-xp"><div class="apt-xp-bar"><i style="width:${Math.round(k * 100)}%"></i></div>
        <small>${e.maximo ? 'Nivel máximo' : `${Math.floor(e.xpNivel)} / ${e.siguiente} XP para el nivel ${e.nivel + 1}`}</small></div>
      <div class="apt-puntos">${e.puntos > 0 ? `Tenés <b>${e.puntos}</b> punto${e.puntos > 1 ? 's' : ''} para gastar` : 'Sin puntos libres: subí de nivel para ganar más'}</div>
      <div class="apt-sub">Aptitudes</div>${apt}
      <div class="apt-pie">Ganás XP talando (${cfg.xp_por_hachazo} por hachazo, ${cfg.xp_por_arbol} al voltear un árbol) y retirando muebles (${cfg.xp_por_mueble}). · N o Esc para cerrar</div>
    </div>`;
  }

  const abierto = () => !ventana.hidden;
  function abrir() { if (abierto() || blocked()) return; ventana.hidden = false; dibujar(); onOpen(); }
  function cerrar() { if (!abierto()) return; ventana.hidden = true; onClose(); }
  const alternar = () => (abierto() ? cerrar() : abrir());

  ventana.addEventListener('click', (e) => {
    const b = e.target.closest('[data-apt]');
    if (b) { if (mejorar(b.dataset.apt)) notify(`${cfg.aptitudes[b.dataset.apt]?.nombre ?? b.dataset.apt} mejorada`); return; }
    if (e.target.closest('.apt-x') || e.target === ventana) cerrar();
  });
  // Dentro de #stage: que la cámara no se quede con el clic
  for (const el of [ventana, boton, barra]) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  boton.addEventListener('click', alternar);
  barra.addEventListener('click', alternar); // en el celular no hay N: se toca la barra de XP
  addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    if (e.code === 'KeyN') { alternar(); e.preventDefault(); }
    else if (e.code === 'Escape' && abierto()) { cerrar(); e.preventDefault(); e.stopImmediatePropagation(); } // que el menú de Esc no se abra atrás
    else if (abierto()) e.stopImmediatePropagation(); // las teclas no mueven al personaje
  }, true);

  dibujar();
  return {
    ganar, mejorar, bonus, reiniciar, setConfig, abrir, cerrar, alternar, boton,
    get abierto() { return abierto(); },
    get estado() { return estado(); },
    get config() { return structuredClone(cfg); },
    paraSubir,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
