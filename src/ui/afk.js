// Inactividad en el servidor: si pasás 5 minutos sin tocar nada (teclado, mouse, pantalla) se te pregunta
// "¿Seguís ahí?". Si en 1 minuto no respondés, se te desconecta del servidor (los demás dejan de verte).
const IDLE_SECS = 5 * 60;
const ANSWER_SECS = 60;

export function createAfk({ onDisconnect }) {
  const app = document.querySelector('.app') ?? document.body;
  const el = document.createElement('div');
  el.className = 'afk';
  el.hidden = true;
  el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<div class="afk-card">
      <b class="afk-title">¿Seguís ahí?</b>
      <p class="afk-text"></p>
      <button type="button" class="afk-btn">Sigo acá</button>
    </div>`;
  app.append(el);
  const text = el.querySelector('.afk-text');
  const btn = el.querySelector('.afk-btn');

  let last = performance.now(), asking = 0, done = false;
  const activity = () => { if (!asking && !done) last = performance.now(); };
  for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) addEventListener(ev, activity, { passive: true });

  function ask() {
    asking = performance.now();
    el.hidden = false;
    btn.textContent = 'Sigo acá';
    btn.focus();
  }
  function answer() {
    if (done) { location.reload(); return; } // "Volver a conectar"
    asking = 0; last = performance.now(); el.hidden = true;
  }
  btn.addEventListener('click', answer);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); answer(); } e.stopPropagation(); });

  setInterval(() => {
    if (done) return;
    const now = performance.now();
    if (!asking) { if (now - last > IDLE_SECS * 1000) ask(); return; }
    const left = Math.ceil(ANSWER_SECS - (now - asking) / 1000);
    if (left > 0) { text.textContent = `Hace un rato que no te movés. Si no respondés en ${left} s, te desconectamos del servidor.`; return; }
    done = true;
    onDisconnect?.();
    el.querySelector('.afk-title').textContent = 'Te desconectamos';
    text.textContent = 'Saliste del servidor por estar inactivo. Los demás ya no te ven.';
    btn.textContent = 'Volver a conectar';
  }, 500);

  return { get disconnected() { return done; } };
}
