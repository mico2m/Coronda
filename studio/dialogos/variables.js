// Panel de Variables: los flags que leen y escriben diálogos y recorridos, con un clic para ir a cada lugar.
import { esc, baseName } from './ws-common.js';
import { icon } from './icons.js';

function overlay(cls) {
  const o = document.createElement('div');
  o.className = `pal-back ${cls}`;
  document.body.appendChild(o);
  const close = () => o.remove();
  o.addEventListener('mousedown', (e) => { if (e.target === o) close(); });
  return { o, close };
}

// ---------- Variables ----------
const condKeys = (c) => {
  if (!c) return [];
  if (typeof c === 'object') return Object.keys(c);
  return String(c).split(',').map((p) => p.trim().replace(/^!/, '').split(/\s*(?:>=|<=|==|!=|=|>|<)\s*/)[0]).filter(Boolean);
};
export async function scanVariables(app) {
  const vars = new Map(); // nombre -> { writes: [], reads: [], auto }
  const get = (k) => { if (!vars.has(k)) vars.set(k, { name: k, writes: [], reads: [], auto: /^(hablo|veces)_/.test(k) }); return vars.get(k); };
  const files = app.files.filter((p) => /^data\/(dialogues|routes)\/[^/]+\.json$/.test(p));
  for (const p of files) {
    let d; try { d = JSON.parse(await app.api.read(p)); } catch { continue; }
    const isDlg = p.startsWith('data/dialogues/');
    const where = (node, what) => ({ path: p, file: baseName(p), kind: isDlg ? 'dialogue' : 'route', node, what });
    if (isDlg) {
      get(`hablo_${baseName(p)}`).writes.push(where('', 'al terminar cada charla (automático)'));
      get(`veces_${baseName(p)}`).writes.push(where('', 'suma 1 en cada charla (automático)'));
      for (const r of Array.isArray(d.start) ? d.start : []) for (const k of condKeys(r?.if)) get(k).reads.push(where(r.goto ?? '', `elige el inicio → ${r.goto ?? '?'}`));
    }
    for (const [id, n] of Object.entries(d.nodes ?? {})) {
      if (n?.set && typeof n.set === 'object') for (const [k, v] of Object.entries(n.set)) get(k).writes.push(where(id, `= ${JSON.stringify(v)}`));
      for (const c of Array.isArray(n?.choices) ? n.choices : []) for (const k of condKeys(c?.if)) get(k).reads.push(where(id, `muestra la opción «${c.text ?? ''}»`));
      for (const c of Array.isArray(n?.next) ? n.next : []) for (const k of condKeys(c?.if)) get(k).reads.push(where(id, `elige el camino → ${c.to ?? '?'}`));
    }
  }
  return [...vars.values()].sort((a, b) => (a.auto - b.auto) || a.name.localeCompare(b.name));
}

export async function openVariables(app) {
  const { o, close } = overlay('vars');
  o.innerHTML = `<div class="pal-box wide" role="dialog" aria-label="Variables"><div class="pal-h"><b>Variables</b><span class="muted">Lo que el juego recuerda (flags): quién las cambia y quién las mira</span><span class="spacer"></span>
      <label class="chk"><input type="checkbox" data-auto> Mostrar automáticas</label><button class="ib" data-x title="Cerrar">${icon('x')}</button></div>
    <div class="pal-in">${icon('search', { size: 15 })}<input placeholder="Buscar variable" spellcheck="false"></div><div class="var-list"><div class="empty">Leyendo diálogos y recorridos…</div></div></div>`;
  o.querySelector('[data-x]').addEventListener('click', close);
  o.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
  const input = o.querySelector('.pal-in input'), list = o.querySelector('.var-list'), autoChk = o.querySelector('[data-auto]');
  const vars = await scanVariables(app);
  const loc = (w) => `<button class="var-loc" data-path="${esc(w.path)}" data-kind="${w.kind}" title="Abrir ${esc(w.file)}">${icon(w.kind === 'dialogue' ? 'chat' : 'route', { size: 12 })}<b>${esc(w.file)}</b>${w.node ? ` · ${esc(w.node)}` : ''}<span>${esc(w.what)}</span></button>`;
  function render() {
    const q = input.value.trim().toLowerCase();
    const shown = vars.filter((v) => (autoChk.checked || !v.auto || v.reads.length) && (!q || v.name.toLowerCase().includes(q)));
    list.innerHTML = shown.length ? shown.map((v) => `<div class="var-row${!v.writes.length || !v.reads.length ? ' warn' : ''}">
        <div class="var-n"><code>${esc(v.name)}</code>${v.auto ? '<span class="chip">automática</span>' : ''}
          ${!v.writes.length ? '<span class="chip w">nadie la cambia</span>' : !v.reads.length && !v.auto ? '<span class="chip w">nadie la mira</span>' : ''}</div>
        <div class="var-c"><small>La cambia</small>${v.writes.map(loc).join('') || '<i class="muted">—</i>'}</div>
        <div class="var-c"><small>La mira</small>${v.reads.map(loc).join('') || '<i class="muted">—</i>'}</div></div>`).join('')
      : `<div class="empty"><b>${q ? 'Nada coincide' : 'Todavía no hay variables'}</b>Se crean con «set» en un nodo de diálogo y se usan en las condiciones (opciones, inicio, caminos del recorrido).</div>`;
  }
  input.addEventListener('input', render);
  autoChk.addEventListener('change', render);
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.var-loc'); if (!b) return;
    close();
    if (b.dataset.kind === 'dialogue') app.openFile(b.dataset.path); else window.open('/__studio', '_blank', 'noopener'); // los recorridos siguen en el Studio clásico
  });
  render();
  input.focus();
}
