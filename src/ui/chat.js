// Chat del servidor: Enter abre el cuadro, escribís, Enter manda (Esc cancela).
// Los mensajes aparecen abajo a la izquierda (se van apagando) y en un globo arriba del personaje de quien escribió.
// En celular hay un botón 💬. Solo existe cuando jugás en el servidor (ver net/multiplayer.js).
const SHOW_SECS = 12;   // s que queda visible cada mensaje en la lista
const MAX_LINES = 7;

export function createChat({ net, myName, blocked = () => false, onCommand = null }) {
  const app = document.querySelector('.app') ?? document.body;
  const box = document.createElement('div');
  box.className = 'chat';
  box.innerHTML = `
    <ol class="chat-log" aria-live="polite"></ol>
    <form class="chat-form" hidden>
      <input class="chat-input" maxlength="120" autocomplete="off" spellcheck="false" placeholder="Escribí y apretá Enter · Esc para cancelar" aria-label="Mensaje">
    </form>
    <button type="button" class="chat-open" aria-label="Escribir un mensaje">💬</button>`;
  app.append(box);
  const log = box.querySelector('.chat-log');
  const form = box.querySelector('.chat-form');
  const input = box.querySelector('.chat-input');
  let open = false;

  function add(name, text, mine = false, system = false) {
    const li = document.createElement('li');
    if (system) { li.className = 'chat-sys'; li.textContent = text; }
    else {
      const b = document.createElement('b');
      b.textContent = `${name}: `;
      if (mine) li.className = 'chat-mine';
      li.append(b, document.createTextNode(text));
    }
    log.append(li);
    while (log.children.length > 30) log.firstChild.remove();
    li._t = performance.now();
    refresh();
  }
  // Solo se ven los últimos mensajes; con el cuadro abierto se ven todos los recientes
  function refresh() {
    const now = performance.now();
    const items = [...log.children];
    items.forEach((li, i) => {
      const recent = now - li._t < SHOW_SECS * 1000;
      const inTail = i >= items.length - MAX_LINES;
      li.classList.toggle('chat-old', !(inTail && (open || recent)));
    });
  }
  setInterval(refresh, 1000);

  function show() {
    if (open || blocked()) return;
    open = true;
    form.hidden = false;
    box.classList.add('chat-on');
    refresh();
    input.value = '';
    setTimeout(() => input.focus(), 0);
  }
  function hide() {
    open = false;
    form.hidden = true;
    box.classList.remove('chat-on');
    input.blur();
    refresh();
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    // "/algo" = comando (ver systems/admin.js): nunca se manda al chat de los demás
    if (text.trim().startsWith('/')) { hide(); onCommand?.(text); return; }
    const sent = net.say(text);
    if (sent) add(myName, sent, true);
    hide();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
    e.stopPropagation(); // las letras no mueven al personaje ni abren puertas
  });
  input.addEventListener('blur', () => { if (open) setTimeout(() => { if (document.activeElement !== input) hide(); }, 100); });
  box.querySelector('.chat-open').addEventListener('click', () => (open ? hide() : show()));
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.repeat || open) return;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target?.tagName)) return;
    if (blocked()) return; // en una charla con un NPC, Enter pasa el texto
    e.preventDefault();
    show();
  });

  net.onChat = (name, text) => add(name, text);
  add('', 'Apretá Enter para escribir un mensaje.', false, true);
  return { add, show, hide, get open() { return open; } };
}
