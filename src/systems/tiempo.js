// Hora del juego y ciclo de día y noche.
//
// En el servidor (index.html) la hora la manda el SERVIDOR: su configuración (con el /time del admin) llega por
// net.onHora y el reloj es el del servidor (net.ahora(), sincronizado; no el de la compu de cada uno). Así todos ven
// exactamente la misma hora aunque el reloj de alguna compu esté corrido, y al reconectar se recupera sola.
// Sin servidor (dev.html) usa data/tables/tiempo.json y el reloj de la compu.
// Configuración: data/tables/tiempo.json (también desde el Studio):
//   dia_minutos     cuántos minutos reales dura un día entero del juego (24 = 1 minuto real por hora)
//   desfase_horas   corre el reloj (ej. 6 = el juego va 6 horas adelantado)
//   tienda          { abre, cierra }  horario de la Carpintería de Claude (horas del juego)
//   momentos        [{ hora, nombre, tinte, brillo, fondo }] cómo se ve el mundo a cada hora (se mezcla entre uno y otro)
//
// Cómo se ve: el mundo no usa luces (ver shading.js): cada objeto tiene un "tono" y un "brillo". El día y la noche
// multiplican el tono/brillo de la escena por los del momento del día, y cambian el color del cielo y la niebla.
// Las escenas con environment.ciclo = false (ej. adentro de las casas) no cambian.
//
// API:  tiempo.hora()        -> 13.5 (hora decimal del juego)      tiempo.texto() -> "13:30"
//       tiempo.momento()     -> "Tarde"                            tiempo.abierta() -> ¿la tienda está abierta?
//       tiempo.hastaHora(h)  -> ms reales hasta que sean las h      tiempo.dia() -> número de día del juego
//       tiempo.setConfig(c)  -> cambia la configuración en vivo (Studio)
import * as THREE from 'three';
import { loadJSON } from '../core/assets.js';
import { setShade } from './shading.js';

export const TIEMPO_DEFAULT = {
  dia_minutos: 24,
  desfase_horas: 0,
  tienda: { abre: 8, cierra: 20 },
  momentos: [
    { hora: 0, nombre: 'Noche', tinte: '#5d6fa8', brillo: 0.45, fondo: '#0e1729' },
    { hora: 5, nombre: 'Madrugada', tinte: '#7480b4', brillo: 0.55, fondo: '#26315a' },
    { hora: 6.5, nombre: 'Amanecer', tinte: '#ffc29a', brillo: 0.82, fondo: '#f2a882' },
    { hora: 8, nombre: 'Mañana', tinte: '#ffffff', brillo: 1, fondo: null },
    { hora: 12, nombre: 'Mediodía', tinte: '#ffffff', brillo: 1.04, fondo: null },
    { hora: 16, nombre: 'Tarde', tinte: '#fff3dc', brillo: 1, fondo: null },
    { hora: 18.8, nombre: 'Atardecer', tinte: '#ffa877', brillo: 0.82, fondo: '#e8845e' },
    { hora: 20.3, nombre: 'Anochecer', tinte: '#8b80bb', brillo: 0.6, fondo: '#2d3058' },
    { hora: 22, nombre: 'Noche', tinte: '#5d6fa8', brillo: 0.45, fondo: '#0e1729' },
  ],
};

const _a = new THREE.Color(), _b = new THREE.Color(), _c = new THREE.Color();

export function createTiempo({ scene, net = null, getSceneData = () => null, getBaseShade = () => ({ tint: '#ffffff', brightness: 1 }), stage = null, dev = false } = {}) {
  let cfg = structuredClone(TIEMPO_DEFAULT);
  const reloj = net ? () => net.ahora() : () => Date.now();
  // con servidor, la configuración es la del servidor (no la del archivo local)
  const ready = net ? Promise.resolve() : loadJSON('data/tables/tiempo.json').then((c) => setConfig(c)).catch(() => {});
  if (net) { if (net.hora) queueMicrotask(() => setConfig(net.hora)); const prev = net.onHora; net.onHora = (c) => { prev?.(c); setConfig(c); }; }
  const listeners = new Set();

  function setConfig(c) {
    if (!c || typeof c !== 'object') return;
    const n = { ...cfg, ...c };
    n.dia_minutos = Math.max(1, Number(n.dia_minutos) || 24);
    n.desfase_horas = Number(n.desfase_horas) || 0;
    n.tienda = { abre: Number(n.tienda?.abre ?? 8), cierra: Number(n.tienda?.cierra ?? 20) };
    if (!Array.isArray(n.momentos) || !n.momentos.length) n.momentos = TIEMPO_DEFAULT.momentos;
    n.momentos = n.momentos.map((m) => ({ ...m, hora: Number(m.hora) || 0 })).sort((a, b) => a.hora - b.hora);
    cfg = n;
    lastKey = '';
    listeners.forEach((fn) => fn(cfg));
  }

  // ---------- Hora ----------
  const dayMs = () => cfg.dia_minutos * 60000;
  function horasTotales(t = reloj()) { return (t / dayMs()) * 24 + cfg.desfase_horas; }
  function hora(t) { const h = horasTotales(t) % 24; return h < 0 ? h + 24 : h; }
  function dia(t) { return Math.floor(horasTotales(t) / 24); }
  function texto(h = hora()) { const m = Math.floor((h % 1) * 60); return `${String(Math.floor(h)).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }
  function enRango(h, desde, hasta) { return desde <= hasta ? h >= desde && h < hasta : h >= desde || h < hasta; }
  function abierta(h = hora()) { return enRango(h, cfg.tienda.abre, cfg.tienda.cierra); }
  // ms reales que faltan para que sea la hora h (siempre hacia adelante)
  function hastaHora(h, t = reloj()) { let d = (h - hora(t)) % 24; if (d <= 0) d += 24; return (d / 24) * dayMs(); }
  // Momento del día: los dos que rodean a la hora y cuánto se mezclan
  function tramo(h = hora()) {
    const ms = cfg.momentos;
    let i = ms.length - 1;
    for (let k = 0; k < ms.length; k++) if (ms[k].hora <= h) i = k;
    const a = ms[i], b = ms[(i + 1) % ms.length];
    let span = b.hora - a.hora; if (span <= 0) span += 24;
    let t = h - a.hora; if (t < 0) t += 24;
    return { a, b, k: Math.min(1, Math.max(0, t / span)) };
  }
  function momento(h = hora()) { const { a, b, k } = tramo(h); return (k > 0.5 ? b : a).nombre ?? ''; }

  // ---------- Cómo se ve ----------
  let lastKey = '', lastData = null, acc = 0, enabled = true;
  function look(h = hora()) {
    const env = getSceneData()?.environment ?? {};
    const sceneBg = env.background ?? '#9fc6e8';
    const { a, b, k } = tramo(h);
    _a.set(a.tinte ?? '#ffffff'); _b.set(b.tinte ?? '#ffffff');
    const tint = _c.copy(_a).lerp(_b, k);
    const brillo = (a.brillo ?? 1) + ((b.brillo ?? 1) - (a.brillo ?? 1)) * k;
    _a.set(a.fondo ?? sceneBg); _b.set(b.fondo ?? sceneBg);
    const fondo = _a.clone().lerp(_b, k);
    return { tint: `#${tint.getHexString()}`, brillo, fondo };
  }
  function apply(force = false) {
    const data = getSceneData();
    if (!data || !scene) return;
    const env = data.environment ?? {};
    if (!enabled || env.ciclo === false || env.shading === 'lit') return;
    if (data !== lastData) { lastData = data; force = true; } // escena nueva: todo recién cargado con el tono base
    const l = look();
    const key = `${l.tint}|${l.brillo.toFixed(3)}|${l.fondo.getHexString()}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    const base = getBaseShade() ?? {};
    _a.set(base.tint ?? '#ffffff').multiply(_b.set(l.tint));
    setShade(scene, { tint: `#${_a.getHexString()}`, brightness: (base.brightness ?? 1) * l.brillo });
    if (scene.background?.isColor) scene.background.copy(l.fondo);
    if (scene.fog) scene.fog.color.copy(l.fondo);
  }

  // ---------- Reloj en pantalla ----------
  let clock = null;
  if (stage && !dev) {
    clock = document.createElement('div');
    clock.className = 'reloj';
    clock.setAttribute('role', 'timer');
    clock.setAttribute('aria-live', 'off');
    clock.innerHTML = '<span class="reloj-ico" aria-hidden="true">☀</span><b class="reloj-h">--:--</b><small class="reloj-m"></small>';
    stage.appendChild(clock);
  }
  function drawClock() {
    if (!clock) return;
    const h = hora();
    clock.querySelector('.reloj-h').textContent = texto(h);
    clock.querySelector('.reloj-m').textContent = momento(h);
    clock.querySelector('.reloj-ico').textContent = h >= 6.5 && h < 19.5 ? '☀' : '☾';
    clock.classList.toggle('noche', !(h >= 6.5 && h < 19.5));
  }

  function update(dt) {
    acc += dt;
    if (acc < 0.5) return;
    acc = 0;
    apply();
    drawClock();
  }

  return {
    ready, update, apply: () => apply(true), setConfig: (c) => { if (!net) setConfig(c); }, // (Studio) con servidor, la hora la cambia el servidor onConfig: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    hora, dia, texto, momento, abierta, hastaHora, enRango, ahora: reloj,
    get config() { return structuredClone(cfg); },
    set enabled(v) { enabled = !!v; if (enabled) apply(true); },
  };
}
