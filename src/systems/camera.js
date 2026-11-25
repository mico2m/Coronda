// Cámara libre: mirar arrastrando, moverse con WASD, subir con Espacio, bajar con Shift.
// La rueda del mouse cambia la velocidad. En pantallas táctiles: el joystick (`touch`, ver ui/touch-controls.js)
// mueve y los botones ▲ ▼ de `pad` suben y bajan.

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']);

export function createCameraControls(camera, stage, { pad, touch = null, speedOut } = {}) {
  camera.rotation.order = 'YXZ';
  let yaw = 0;
  let pitch = -0.2;
  let speed = 6; // metros por segundo
  let keys = {};
  let enabled = true;

  // Mirar arrastrando
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (!enabled) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    stage.classList.add('dragging');
    try { stage.setPointerCapture(e.pointerId); } catch {}
  });
  stage.addEventListener('pointermove', (e) => {
    if (!enabled || !dragging) return;
    const k = e.pointerType === 'touch' ? 0.007 : 0.004; // con el dedo, más sensible
    yaw -= (e.clientX - lastX) * k;
    pitch -= (e.clientY - lastY) * k;
    pitch = Math.max(-1.5, Math.min(1.5, pitch));
    lastX = e.clientX;
    lastY = e.clientY;
  });
  const endDrag = () => { dragging = false; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // Teclado
  const normalize = (code) => (code === 'ShiftRight' ? 'ShiftLeft' : code);
  window.addEventListener('keydown', (e) => {
    if (!enabled || !MOVE_KEYS.has(e.code)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable) return; // escribiendo: las letras no mueven
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    keys[normalize(e.code)] = true;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { delete keys[normalize(e.code)]; });
  window.addEventListener('blur', () => { keys = {}; });

  // Velocidad con la rueda
  stage.addEventListener('wheel', (e) => {
    if (!enabled) return;
    e.preventDefault();
    speed = Math.max(1, Math.min(60, speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (speedOut) speedOut.textContent = speed < 10 ? speed.toFixed(1) : Math.round(speed);
  }, { passive: false });

  // Botones táctiles
  pad?.querySelectorAll('button[data-key]').forEach((b) => {
    const k = b.dataset.key;
    b.addEventListener('pointerdown', (e) => {
      if (enabled) keys[k] = true;
      try { b.setPointerCapture(e.pointerId); } catch {}
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => {
      b.addEventListener(ev, () => { delete keys[k]; });
    });
  });

  return {
    setLook(y, p = 0) { yaw = y; pitch = p; },
    getYaw() { return yaw; },
    getPitch() { return pitch; },
    setEnabled(v) { enabled = v; keys = {}; dragging = false; stage.classList.remove('dragging'); },
    update(dt) {
      if (!enabled) return;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      const fx = -sy * cp, fy = sp, fz = -cy * cp; // hacia donde mira
      const rx = cy, rz = -sy;                     // derecha
      let mx = 0, my = 0, mz = 0;
      if (keys.KeyW) { mx += fx; my += fy; mz += fz; }
      if (keys.KeyS) { mx -= fx; my -= fy; mz -= fz; }
      if (keys.KeyD) { mx += rx; mz += rz; }
      if (keys.KeyA) { mx -= rx; mz -= rz; }
      if (keys.Space) my += 1;
      if (keys.ShiftLeft) my -= 1;
      // Joystick del celular (analógico): solo si no hay teclas de movimiento apretadas
      let amount = 1;
      const t = touch?.move;
      if (t?.mag && !mx && !mz) {
        mx += fx * t.y + rx * t.x; my += fy * t.y; mz += fz * t.y + rz * t.x;
        amount = t.mag;
      }
      const len = Math.hypot(mx, my, mz);
      if (len > 0) {
        const s = (speed * dt * amount) / len;
        camera.position.x += mx * s;
        camera.position.y += my * s;
        camera.position.z += mz * s;
      }
      camera.rotation.set(pitch, yaw, 0);
    },
  };
}
