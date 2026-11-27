// Menú de Esc: ajustes del juego. Por ahora, el chat de voz (micrófono abierto, apretar para hablar o apagado,
// escuchar a los demás y el volumen). Se abre con Esc cuando no hay otra cosa abierta (una charla, la mochila, el
// chat…: ahí Esc cierra eso). En el celular, con el botón ⚙️ (o tocando 🎙️ con el micrófono apagado).
//
// opts: stage, voz (systems/voz.js, o null jugando solo), blocked() (otra cosa usa Esc), onOpen() / onClose()
// extras: [{ texto, accion }] botones de otras ventanas (ej. Nivel y aptitudes), arriba de "Volver al juego"
// salir: { texto, aviso, accion } botón rojo para salir del servidor (pide confirmar con un segundo toque)
export function createMenu({ stage, voz = null, extras = [], salir = null, blocked = () => false, onOpen = () => {}, onClose = () => {} }) {
  const el = document.createElement('div');
  el.className = 'menu-esc'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Menú');
  (stage ?? document.body).append(el);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tactil = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  function dibujar() {
    const a = voz?.ajustes;
    const modos = [
      ['apagado', 'Apagado', 'No te escuchan.'],
      ['ptt', 'Apretar para hablar', tactil() ? 'Mantené apretado 🎙️ mientras hablás.' : 'Mantené la tecla V (o el botón 🎙️) mientras hablás.'],
      ['abierto', 'Micrófono abierto', 'Te escuchan siempre que estés cerca. Tocá 🎙️ para silenciarte.'],
    ];
    el.innerHTML = `
      <div class="menu-card">
        <div class="menu-head"><b>Menú</b><button type="button" class="menu-x" aria-label="Cerrar">✕</button></div>
        <section>
          <h3>Chat de voz</h3>
          ${voz ? `
          <p class="menu-nota">Escuchás a los que están cerca, en la misma escena (hasta ${voz.alcance} m). Más lejos, más bajo.</p>
          <div class="menu-sub">Tu micrófono</div>
          <div class="menu-modos" role="radiogroup" aria-label="Micrófono">
            ${modos.map(([v, t, d]) => `<label class="menu-modo${a.mic === v ? ' sel' : ''}"><input type="radio" name="mic" value="${v}"${a.mic === v ? ' checked' : ''}><span><b>${t}</b><small>${d}</small></span></label>`).join('')}
          </div>
          <div class="menu-nivel${a.mic === 'apagado' ? ' off' : ''}" aria-hidden="true"><i></i></div>
          <label class="menu-fila"><input type="checkbox" name="escuchar"${a.escuchar ? ' checked' : ''}> Escuchar a los demás</label>
          <label class="menu-fila">Volumen de las voces <input type="range" name="volumen" min="0" max="1.5" step="0.05" value="${a.volumen}"></label>
          <div class="menu-cerca"></div>` : '<p class="menu-nota">El chat de voz funciona en el servidor, con otros jugadores.</p>'}
        </section>
        ${extras.map((x, i) => `<button type="button" class="menu-extra" data-extra="${i}">${esc(x.texto)}</button>`).join('')}
        <button type="button" class="menu-volver">Volver al juego</button>
        ${salir ? `<button type="button" class="menu-salir">${esc(salir.texto)}</button>` : ''}
      </div>`;
    dibujarCerca();
  }
  function dibujarCerca() {
    const box = el.querySelector('.menu-cerca');
    if (!box || !voz) return;
    const l = voz.cerca();
    box.innerHTML = l.length
      ? `<div class="menu-sub">Cerca tuyo</div>${l.map((p) => `<div class="menu-par">${p.habla ? '🔊' : p.conectado ? '🟢' : '⏳'} ${esc(p.nombre)}</div>`).join('')}`
      : '<div class="menu-sub">Nadie cerca por ahora</div>';
  }
  // Medidor de tu micrófono y lista de los que están cerca, mientras el menú está abierto
  setInterval(() => {
    if (el.hidden || !voz) return;
    const bar = el.querySelector('.menu-nivel i');
    if (bar) bar.style.width = `${Math.round(voz.nivel() * 100)}%`;
    bar?.parentElement.classList.toggle('al-aire', voz.transmitiendo());
    dibujarCerca();
  }, 120);
  voz?.onChange(() => { if (!el.hidden) dibujar(); });

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'mic') voz?.set({ mic: t.value });
    else if (t.name === 'escuchar') voz?.set({ escuchar: t.checked });
  });
  el.addEventListener('input', (e) => { if (e.target.name === 'volumen') voz?.set({ volumen: e.target.value }); });
  el.addEventListener('click', (e) => {
    const x = e.target.closest('[data-extra]');
    if (x) { cerrar(); setTimeout(() => extras[Number(x.dataset.extra)]?.accion?.(), 0); return; }
    const s = e.target.closest('.menu-salir');
    if (s) { // dos toques: el primero pide confirmar
      if (!s.classList.contains('seguro')) { s.classList.add('seguro'); s.textContent = salir?.aviso ?? '¿Seguro? Tocá de nuevo para salir'; setTimeout(() => { if (s.isConnected) { s.classList.remove('seguro'); s.textContent = salir?.texto ?? 'Salir'; } }, 4000); return; }
      cerrar(); salir?.accion?.(); return;
    }
    if (e.target.closest('.menu-x, .menu-volver')) cerrar();
  });
  el.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === el) cerrar(); }); // clic en lo oscuro: cierra
  el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  const abierto = () => !el.hidden;
  function abrir() { if (abierto()) return; el.hidden = false; dibujar(); onOpen(); el.querySelector('.menu-volver')?.focus({ preventScroll: true }); }
  function cerrar() { if (!abierto()) return; el.hidden = true; onClose(); }

  // Otra cosa abierta que usa Esc (una charla, la mochila, la lista de casas…): Esc es de esa cosa
  const otraCosa = () => blocked() || [...document.querySelectorAll('[role="dialog"]')].some((d) => d !== el && !d.hidden && d.offsetParent !== null);
  addEventListener('keydown', (e) => {
    const escribiendo = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) && e.target.type !== 'radio' && e.target.type !== 'checkbox' && e.target.type !== 'range';
    if (e.code === 'Escape' && !e.repeat) {
      if (abierto()) { cerrar(); e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (escribiendo || otraCosa()) return;
      abrir(); e.preventDefault(); e.stopImmediatePropagation();
      return;
    }
    // Con el menú abierto, las teclas no llegan al juego (moverse, E…); las flechas igual mueven entre las opciones
    if (abierto() && !escribiendo) e.stopImmediatePropagation();
  }, true);

  // En el celular no hay Esc: botón ⚙️ (solo se ve en pantallas táctiles, ver css)
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'menu-btn'; btn.textContent = '⚙️';
  btn.title = 'Menú (Esc)'; btn.setAttribute('aria-label', 'Abrir el menú');
  (stage ?? document.body).append(btn);
  btn.addEventListener('pointerdown', (e) => e.stopPropagation()); // que la cámara no se quede con el toque
  btn.addEventListener('click', () => (abierto() ? cerrar() : abrir()));

  return { abrir, cerrar, abierto };
}
