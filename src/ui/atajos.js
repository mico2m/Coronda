// Atajos con los números para los apartados del menú (los botones siguen andando igual):
//   1  🎒 Mochila
//   2  ⭐ Nivel y aptitudes
//   3  👥 Jugadores
//   4  👤 Mi perfil
//   5  ⚙️ Menú (opciones, voz)
// No hacen nada mientras escribís (chat, formularios, cualquier campo de texto), en una charla con un NPC (ahí los
// números eligen la respuesta) ni con otra ventana abierta que use los números (el menú del lote).
// Las acciones del personaje (saludar, acostarse…) pasaron a Mayús + número (⇧1, ⇧2…), ver actors/player.js.
export const ATAJOS = [
  { tecla: 'Digit1', clase: 'inv-btn', nombre: 'Mochila' },
  { tecla: 'Digit2', clase: 'apt-btn', nombre: 'Nivel y aptitudes' },
  { tecla: 'Digit3', clase: 'players-open', nombre: 'Jugadores' },
  { tecla: 'Digit4', clase: 'perfil-btn', nombre: 'Mi perfil' },
  { tecla: 'Digit5', clase: 'menu-btn', nombre: 'Menú' },
];

export function createAtajos({ app = document.querySelector('.app') ?? document.body, ocupado = () => false } = {}) {
  const escribiendo = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (escribiendo(e.target) || escribiendo(document.activeElement)) return;
    const a = ATAJOS.find((x) => x.tecla === e.code || x.tecla.replace('Digit', 'Numpad') === e.code);
    if (!a || ocupado()) return;
    const b = app.querySelector(`.${a.clase}`);
    if (!b || b.disabled || b.offsetParent === null) return;
    e.preventDefault();
    b.click();
  });
  // El número de cada atajo, chiquito sobre su botón
  const marcar = () => {
    for (const [i, a] of ATAJOS.entries()) {
      const b = app.querySelector(`.${a.clase}`);
      if (b && b.dataset.tecla !== String(i + 1)) { b.dataset.tecla = String(i + 1); b.title = `${b.title || a.nombre} (${i + 1})`.replace(/\s*\(\d\)\s*\((\d)\)$/, ' ($1)'); }
    }
  };
  marcar();
  new MutationObserver(marcar).observe(app, { childList: true, subtree: true });
}
