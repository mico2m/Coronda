// Lista de jugadores del servidor: se ve mientras mantenés apretado Tab (en celular, con el botón 👥).
// Muestra a los conectados con su ping y a los que estuvieron antes con su última conexión (ver net.players()).
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'hace un momento';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return `hace ${d} día${d > 1 ? 's' : ''}`;
  return new Date(t).toLocaleDateString('es-AR');
}
const pingClass = (ms) => (ms == null ? '' : ms < 120 ? 'ok' : ms < 300 ? 'mid' : 'bad');
// "coronda_plaza" -> "Plaza", "casa~coronda_plaza.lote_01" -> "Casa (lote 01)"
function place(id) {
  const s = String(id ?? '');
  const casa = /^casa_.*lote_(.+)$/i.exec(s);
  if (casa) return `Casa (lote ${casa[1]})`;
  const t = s.replace(/^scene_/, '').replace(/^coronda_/, '').replace(/[_.-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

export function createPlayerList({ net }) {
  const app = document.querySelector('.app') ?? document.body;
  const el = document.createElement('div');
  el.className = 'players';
  el.hidden = true;
  app.append(el);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'players-open';
  btn.setAttribute('aria-label', 'Jugadores');
  btn.textContent = '👥';
  app.append(btn);

  let open = false, timer = 0;
  function render() {
    const list = net.players();
    const online = list.filter((p) => p.online).length;
    el.innerHTML = `
      <div class="players-card">
        <div class="players-head"><b>Jugadores</b><span>${online} conectado${online === 1 ? '' : 's'}</span></div>
        <table>
          <thead><tr><th>Nombre</th><th>Personaje</th><th>Dónde</th><th>Ping</th><th>Última conexión</th></tr></thead>
          <tbody>${list.map((p) => `
            <tr class="${p.online ? 'on' : 'off'}${p.me ? ' me' : ''}">
              <td><i class="dot"></i>${esc(p.n)}${p.me ? ' <small>(vos)</small>' : ''}</td>
              <td>${esc(p.c)}</td>
              <td>${esc(p.online ? place(p.s) : '')}</td>
              <td class="ping ${pingClass(p.me ? null : p.ping)}">${p.me ? '—' : p.online ? (p.ping == null ? '…' : `${p.ping} ms`) : ''}</td>
              <td>${p.online ? 'Conectado' : esc(ago(p.t))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div class="players-foot">Soltá <kbd>Tab</kbd> para cerrar</div>
      </div>`;
  }
  function show() { if (open) return; open = true; render(); el.hidden = false; timer = setInterval(render, 1000); }
  function hide() { if (!open) return; open = false; el.hidden = true; clearInterval(timer); }

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Tab' || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    e.preventDefault(); // que Tab no mueva el foco entre botones
    show();
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Tab') hide(); });
  window.addEventListener('blur', hide);
  btn.addEventListener('click', () => (open ? hide() : show()));
  el.addEventListener('click', hide);
  return { show, hide };
}
