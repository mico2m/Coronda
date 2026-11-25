// Controles táctiles (celular / tablet): joystick analógico + botón para centrar la cámara.
//
//  - Joystick flotante: tocá en cualquier lugar de la zona de abajo a la izquierda y el joystick aparece debajo del
//    dedo. Inclinarlo un poco = caminar despacio; llevarlo hasta el borde = correr. Cualquier dirección (analógico).
//    Si el dedo se va más allá del borde, la base lo sigue (no hay que volver al centro para cambiar de dirección).
//  - Botón 🎥: pone la cámara detrás del personaje (como la tecla Z).
//  - El resto de la pantalla es para la cámara (ver actors/player.js): un dedo gira, dos dedos hacen zoom.
//
// Se muestra solo en pantallas táctiles (css: pointer coarse). El jugador y la cámara libre leen `move`.
const RADIUS = 52;      // px: cuánto se puede alejar la perilla del centro
const DEAD = 0.12;      // zona muerta (0-1): movimientos chiquitos del pulgar no mueven al personaje
const RUN_AT = 0.85;    // desde acá (0-1) corre

export function createTouchControls({ pad, onRecenter } = {}) {
  const move = { x: 0, y: 0, mag: 0, run: false }; // x = derecha, y = adelante, mag 0-1 (sin zona muerta)
  if (!pad) return { move, reset() {}, setRecenterVisible() {} };

  const zone = document.createElement('div');
  zone.className = 'joy-zone';
  const base = document.createElement('div');
  base.className = 'joy-base';
  const knob = document.createElement('div');
  knob.className = 'joy-knob';
  base.append(knob);
  zone.append(base);

  const recenter = document.createElement('button');
  recenter.type = 'button';
  recenter.className = 'joy-recenter';
  recenter.setAttribute('aria-label', 'Centrar la cámara detrás del personaje');
  recenter.textContent = '🎥';
  recenter.addEventListener('click', () => { onRecenter?.(); recenter.blur(); });

  pad.prepend(zone);
  pad.append(recenter);

  let id = null;        // dedo que maneja el joystick
  let cx = 0, cy = 0;   // centro de la base (px, relativo a la zona)

  function home() {     // posición de reposo: se ve dónde está, aunque no lo estés tocando
    base.style.left = '';
    base.style.top = '';
    base.classList.remove('on', 'run');
    knob.style.transform = '';
  }
  function reset() {
    id = null;
    move.x = move.y = move.mag = 0;
    move.run = false;
    home();
  }

  function place(x, y) {
    cx = x; cy = y;
    base.style.left = `${x}px`;
    base.style.top = `${y}px`;
  }

  function update(x, y) {
    let dx = x - cx, dy = y - cy;
    let d = Math.hypot(dx, dy);
    if (d > RADIUS) { // el dedo se pasó del borde: la base lo sigue
      const k = (d - RADIUS) / d;
      place(cx + dx * k, cy + dy * k);
      dx = x - cx; dy = y - cy; d = RADIUS;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const raw = Math.min(1, d / RADIUS);
    const mag = raw < DEAD ? 0 : (raw - DEAD) / (1 - DEAD);
    move.mag = mag;
    move.x = mag ? (dx / d) * mag : 0;
    move.y = mag ? (-dy / d) * mag : 0;
    move.run = mag >= RUN_AT;
    base.classList.toggle('run', move.run);
  }

  const local = (e) => { const r = zone.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  zone.addEventListener('pointerdown', (e) => {
    if (id !== null) return;
    e.preventDefault();
    id = e.pointerId;
    try { zone.setPointerCapture(id); } catch {}
    const [x, y] = local(e);
    place(x, y);
    base.classList.add('on');
    update(x, y);
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const [x, y] = local(e);
    update(x, y);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    zone.addEventListener(ev, (e) => { if (e.pointerId === id) reset(); });
  }
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  zone.addEventListener('contextmenu', (e) => e.preventDefault()); // mantener apretado no abre el menú del celular

  return {
    move,
    reset,
    setRecenterVisible(v) { recenter.hidden = !v; },
  };
}
