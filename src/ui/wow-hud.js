// HUD estilo WoW (solo index.html; el aspecto está en css/wow.css). En la compu acomoda el HUD como un MMO:
//   arriba a la izquierda  marco del jugador: retrato, nombre y la barra de energía (hachazos que quedan hoy)
//   arriba a la derecha    nombre de la zona, minimapa con aro dorado y el reloj debajo
//   arriba al centro       micro-menú: 🎒 mochila · 👥 jugadores · 🎙️ voz · ⚙️ menú
//   abajo a la izquierda   chat
// En el celular no mueve nada (el HUD táctil ya está acomodado para el pulgar): solo cambia el aspecto.
// Los elementos los crean otros sistemas, algunos más tarde (chat, 👥, 🎙️ solo en el servidor): un MutationObserver
// los va metiendo en su lugar cuando aparecen.
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const humanizar = (id) => String(id ?? '').replace(/^scene_/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// opts: stage, nombre (del jugador), personaje (nombre del personaje elegido), getZona() -> nombre de la escena
export function createWowHud({ stage, nombre = 'Viajero', personaje = '', getZona = () => '', nivel = 1 }) {
  const app = stage?.closest('.app') ?? document.querySelector('.app') ?? document.body;
  app.classList.add('wow');
  const compu = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

  // Nombre de la zona arriba del minimapa (también en el celular)
  const zona = document.createElement('div');
  zona.className = 'wow-zona';
  stage.append(zona);
  let zonaTxt = '';
  setInterval(() => { const z = getZona() || ''; if (z !== zonaTxt) { zonaTxt = z; zona.textContent = z; zona.hidden = !z; } }, 500);

  if (!compu) return { compu };

  // Marco del jugador
  const marco = document.createElement('div');
  marco.className = 'wow-player';
  const inicial = (String(nombre).trim()[0] ?? '?').toUpperCase();
  marco.innerHTML = `<div class="wow-retrato" aria-hidden="true"><span>${esc(inicial)}</span><b class="wow-nivel" title="Nivel">${esc(nivel)}</b></div>
    <div class="wow-pinfo"><div class="wow-pnombre">${esc(nombre)}</div>${personaje ? `<div class="wow-pclase">${esc(personaje)}</div>` : ''}<div class="wow-pbarras"></div></div>`;
  stage.append(marco);
  const barras = marco.querySelector('.wow-pbarras');

  // Micro-menú arriba al centro
  const micro = document.createElement('div');
  micro.className = 'wow-micro';
  micro.setAttribute('role', 'toolbar'); micro.setAttribute('aria-label', 'Menú');
  stage.append(micro);
  // Está dentro de #stage: sin esto la cámara se queda con el clic (setPointerCapture) y los botones no responden
  for (const el of [marco, micro]) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  const ORDEN = ['inv-btn', 'apt-btn', 'players-open', 'voz-btn', 'menu-btn'];

  function acomodar() {
    const en = document.querySelector('.energia');
    if (en && en.parentElement !== barras) { en.classList.add('en-marco'); barras.append(en); }
    for (const cls of ORDEN) {
      const b = app.querySelector(`.${cls}`);
      if (b && b.parentElement !== micro) micro.append(b);
    }
    // siempre en el mismo orden
    const hijos = ORDEN.map((c) => micro.querySelector(`.${c}`)).filter(Boolean);
    if (hijos.some((h, i) => micro.children[i] !== h)) micro.append(...hijos);
  }
  acomodar();
  new MutationObserver(acomodar).observe(app, { childList: true, subtree: true });

  return { compu, marco, micro };
}
