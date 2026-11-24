// Paleta de comandos (Ctrl+K) y panel de Variables (los flags que leen y escriben diálogos y recorridos).
import { esc, baseName } from './ws-common.js';
import { icon } from './components.js';

// Coincidencia aproximada: las letras de la búsqueda, en orden (más puntos si van seguidas o al principio de palabra)
function score(q, text) {
  if (!q) return 1;
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let s = 0, i = 0, run = 0;
  for (const ch of q) {
    const j = t.indexOf(ch, i);
    if (j < 0) return 0;
    run = j === i ? run + 1 : 0;
    s += 1 + run * 2 + (j === 0 || /[\s_·/-]/.test(t[j - 1]) ? 3 : 0);
    i = j + 1;
  }
  return s - t.length * 0.02;
}

function overlay(cls) {
  const o = document.createElement('div');
  o.className = `pal-back ${cls}`;
  document.body.appendChild(o);
  const close = () => o.remove();
  o.addEventListener('mousedown', (e) => { if (e.target === o) close(); });
  return { o, close };
}

// commands(): [{ label, sub, icon, group, run }]
export function openPalette(commands) {
  const { o, close } = overlay('pal');
  o.innerHTML = `<div class="pal-box" role="dialog" aria-label="Comandos"><div class="pal-in">${icon('search', { size: 15 })}<input placeholder="Buscar comandos, escenas, objetos, diálogos…" spellcheck="false"><kbd>Esc</kbd></div><div class="pal-list"></div></div>`;
  const input = o.querySelector('input'), list = o.querySelector('.pal-list');
  const all = commands();
  let shown = [], sel = 0;
  function render() {
    const q = input.value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    shown = all.map((c) => ({ c, s: score(q, `${c.label} ${c.sub ?? ''} ${c.group ?? ''}`) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.c);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length ? shown.map((c, i) => `<div class="pal-it${i === sel ? ' on' : ''}" data-i="${i}">
        <span class="pal-ic">${icon(c.icon ?? 'chevron', { size: 14 })}</span><span class="pal-tx"><b>${esc(c.label)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</span>
        <span class="pal-g">${esc(c.group ?? '')}</span></div>`).join('') : '<div class="empty">Nada coincide.</div>';
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  function run(i) { const c = shown[i]; if (!c) return; close(); setTimeout(() => c.run(), 0); }
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    e.stopPropagation();
  });
  list.addEventListener('mousemove', (e) => { const it = e.target.closest('.pal-it'); if (it && +it.dataset.i !== sel) { sel = +it.dataset.i; list.querySelectorAll('.pal-it').forEach((x) => x.classList.toggle('on', +x.dataset.i === sel)); } });
  list.addEventListener('click', (e) => { const it = e.target.closest('.pal-it'); if (it) run(+it.dataset.i); });
  render();
  input.focus();
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
    app.openWsFile(b.dataset.kind === 'dialogue' ? 'dialogues' : 'routes', b.dataset.path);
  });
  render();
  input.focus();
}
