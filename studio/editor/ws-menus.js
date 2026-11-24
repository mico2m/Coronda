// Espacio "Menús": pantalla de título, pausa y opciones del juego (data/menus.json), con vista previa en vivo
import { listPane, fileDoc, esc, slug, fieldRow, options } from './ws-common.js';
import { icon } from './components.js';
import { renderMenu, DEFAULT_MENUS } from '/src/ui/menus.js';
import { fontList, resolveUI, applyUI } from '/src/ui/theme.js';

const PATH = 'data/menus.json';
const KINDS = [['title', 'Pantalla de título'], ['pause', 'Pausa (Esc)'], ['panel', 'Submenú']];
const ACTIONS = [
  ['start', 'Empezar a jugar'], ['newgame', 'Nueva partida (borra lo recordado)'], ['resume', 'Continuar'],
  ['menu', 'Abrir otro menú…'], ['scene', 'Ir a una escena…'], ['volume', 'Volumen de la música'],
  ['fullscreen', 'Pantalla completa'], ['back', 'Volver'], ['title', 'Volver al título'],
];
const KIND_ICON = { title: 'flag', pause: 'stop', panel: 'layers' };

export function createMenusWorkspace(app, el) {
  el.innerHTML = `<aside class="wsl"></aside>
    <section class="wsc"><div class="wsbar"><b class="wst"></b><span class="wsu"></span><span class="spacer"></span><span class="muted">Clic en un ítem de la vista previa para editarlo</span></div>
      <div class="wsbody center"><div class="mstage"><div class="mprev"></div></div></div></section>
    <aside class="wsr panel"><div class="minsp"></div></aside>`;
  let doc = null, cur = null, item = 0, uiTheme = resolveUI({});
  const pane = listPane(el.querySelector('.wsl'), { title: 'Menús', addLabel: 'Menú nuevo', onAdd: create, onSelect: (id) => { cur = id; item = 0; render(); } });
  const prev = el.querySelector('.mprev'), insp = el.querySelector('.minsp');
  const data = () => { try { const d = JSON.parse(doc.text); d.settings ??= {}; d.menus ??= {}; return d; } catch { return structuredClone(DEFAULT_MENUS); } };
  const write = (fn, newStep = true) => { const d = data(); fn(d); if (doc.set(`${JSON.stringify(d, null, 2)}\n`, newStep)) { app.wsChanged(); render(); } };
  const textures = () => app.files.filter((p) => /^assets\/.*\.(png|jpe?g|webp|gif)$/i.test(p));

  function renderList() {
    const d = data();
    pane.set([
      { id: '__settings', label: 'Ajustes', sub: 'Título al abrir, pausa, color y letra', icon: 'reset', color: '#5b6478' },
      ...Object.entries(d.menus).map(([id, m]) => ({ id, label: id, sub: KINDS.find((k) => k[0] === m.kind)?.[1] ?? 'Submenú', icon: KIND_ICON[m.kind] ?? 'layers', color: m.kind === 'title' ? '#3d6df2' : m.kind === 'pause' ? '#e08a1e' : '#7c5cd6' })),
    ], cur);
  }
  function renderPreview(d) {
    prev.innerHTML = '';
    const id = cur === '__settings' ? Object.keys(d.menus).find((k) => d.menus[k].kind === 'title') : cur;
    const def = d.menus[id];
    prev.classList.toggle('scenebg', (def?.backdrop ?? (def?.kind === 'title' ? 'scene' : 'pause')) !== 'color');
    if (!def) { prev.innerHTML = '<div class="empty" style="color:#fff">Sin menú</div>'; return; }
    renderMenu(prev, def, { settings: d.settings, preview: true, selected: item, onPick: (i) => { item = i; renderInspector(d); } });
  }
  function itemRow(it, i, d, n) {
    const [act, param] = String(it.action ?? '').split(':');
    const base = act === 'menu' || act === 'scene' ? act : (it.action ?? 'start');
    const paramCtl = base === 'menu' ? `<select data-i="${i}" data-k="param">${options(Object.keys(d.menus).filter((k) => k !== cur), param, 'Elegí un menú')}</select>`
      : base === 'scene' ? `<select data-i="${i}" data-k="param">${options(Object.keys(app.scenes), param, 'Elegí una escena')}</select>` : '';
    return `<div class="mitem${i === item ? ' on' : ''}" data-i="${i}">
      <div class="mhead"><span class="mnum">${i + 1}</span><input data-i="${i}" data-k="label" value="${esc(it.label)}" spellcheck="false">
        <button class="ib sm" data-act="up" data-i="${i}" title="Subir"${i === 0 ? ' disabled' : ''}>${icon('chevron', { size: 12, stroke: 1.8 }).replace('class="ic"', 'class="ic" style="transform:rotate(-90deg)"')}</button>
        <button class="ib sm" data-act="down" data-i="${i}" title="Bajar"${i === n - 1 ? ' disabled' : ''}>${icon('chevron', { size: 12, stroke: 1.8 }).replace('class="ic"', 'class="ic" style="transform:rotate(90deg)"')}</button>
        <button class="ib sm" data-act="rm" data-i="${i}" title="Quitar">${icon('x', { size: 12 })}</button></div>
      <div class="mact"><select data-i="${i}" data-k="action">${options(ACTIONS, base)}</select>${paramCtl}</div></div>`;
  }
  function renderInspector(d) {
    if (cur === '__settings') {
      const s = d.settings;
      insp.innerHTML = `<div class="ih"><span class="big" style="background:#5b64781a;color:#5b6478">${icon('reset', { size: 18 })}</span><div class="tt"><b>Ajustes de los menús</b><div class="kind">Valen para todos</div></div></div>
        <div class="sb" style="display:block;padding:12px">
          ${fieldRow('Título al abrir', `<label class="switch"><input type="checkbox" data-s="titleOnStart"${s.titleOnStart !== false ? ' checked' : ''}><span></span></label>`)}
          ${fieldRow('Pausa con Esc', `<label class="switch"><input type="checkbox" data-s="pause"${s.pause !== false ? ' checked' : ''}><span></span></label>`)}
          ${fieldRow('Color de acento', `<input type="color" data-s="accent" value="${esc(s.accent ?? '#ffd34d')}">`)}
          ${fieldRow('Letra', `<select data-s="font">${options([['moderna', 'Moderna'], ['pixel', 'Pixel (retro)'], ['clasica', 'Clásica'], ...fontList(uiTheme).filter((f) => !f.bitmap).map((f) => [f.id, `${f.name}${f.custom ? ' · importada' : ''}`])], s.font ?? 'moderna')}</select>`, 'Las letras importadas se agregan en la pestaña <b>Interfaz → Letras</b>.')}
          <p class="help" style="margin-top:12px">El título aparece al abrir el juego (index.html), con la escena de fondo. En el ▶ Jugar del motor y en dev.html se saltea.</p>
        </div>`;
      return;
    }
    const m = d.menus[cur];
    if (!m) { insp.innerHTML = ''; return; }
    const back = m.backdrop ?? (m.kind === 'title' ? 'scene' : 'pause');
    const items = m.items ?? [];
    insp.innerHTML = `<div class="ih"><span class="big" style="background:#3d6df21a;color:#3d6df2">${icon(KIND_ICON[m.kind] ?? 'layers', { size: 18 })}</span>
        <div class="tt"><input data-m="id" value="${esc(cur)}" spellcheck="false"><div class="kind">${esc(KINDS.find((k) => k[0] === m.kind)?.[1] ?? 'Submenú')}</div></div>
        <div class="acts"><button class="ib" data-act="del" title="Borrar menú">${icon('trash')}</button></div></div>
      <div class="sb" style="display:block;padding:10px 12px">
        ${fieldRow('Tipo', `<select data-m="kind">${options(KINDS, m.kind ?? 'panel')}</select>`)}
        ${fieldRow('Título', `<input data-m="title" value="${esc(m.title ?? '')}" spellcheck="false">`)}
        ${fieldRow('Subtítulo', `<input data-m="subtitle" value="${esc(m.subtitle ?? '')}" placeholder="opcional" spellcheck="false">`)}
        ${fieldRow('Fondo', `<select data-m="backdrop">${options([['scene', 'La escena, oscurecida'], ['pause', 'La escena, con desenfoque'], ['color', 'Color'], ['image', 'Imagen']], back)}</select>`)}
        ${back === 'color' ? fieldRow('Color', `<input type="color" data-m="background" value="${esc(m.background ?? '#0b1424')}">`) : ''}
        ${back === 'image' ? fieldRow('Imagen', `<select data-m="image">${options(textures(), m.image, textures().length ? 'Elegí una imagen' : 'Importá una imagen en Assets')}</select>`) : ''}
        ${m.kind === 'title' ? fieldRow('Música', `<select data-m="music">${options(Object.keys(app.music).filter((k) => !k.startsWith('_')), m.music, 'La de la escena')}</select>`) : ''}
      </div>
      <div class="sec open"><div class="sh" style="cursor:default"><span class="ttl">Opciones del menú</span><span class="chip">${items.length}</span></div>
        <div class="sb" style="display:block">${items.map((it, i) => itemRow(it, i, d, items.length)).join('')}<button class="linkbtn" data-act="add">+ Opción</button></div></div>`;
  }
  function render() {
    const d = data();
    if (cur !== '__settings' && !d.menus[cur]) cur = Object.keys(d.menus)[0] ?? '__settings';
    renderList();
    el.querySelector('.wst').textContent = cur === '__settings' ? 'Ajustes' : cur;
    el.querySelector('.wsu').textContent = doc.dirty ? 'Sin guardar' : '';
    renderPreview(d);
    renderInspector(d);
  }

  insp.addEventListener('change', (ev) => {
    const t = ev.target, v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.s) return write((d) => { d.settings[t.dataset.s] = v; });
    if (t.dataset.m === 'id') {
      const n = slug(v); if (!n || n === cur) return render();
      if (data().menus[n]) { app.toast(`Ya existe el menú ${n}`, true); return render(); }
      const old = cur;
      write((d) => {
        d.menus[n] = d.menus[old]; delete d.menus[old];
        for (const m of Object.values(d.menus)) for (const it of m.items ?? []) if (it.action === `menu:${old}`) it.action = `menu:${n}`;
      });
      cur = n; return render();
    }
    if (t.dataset.m) return write((d) => { const m = d.menus[cur]; if (v === '' && t.dataset.m !== 'title') delete m[t.dataset.m]; else m[t.dataset.m] = v; });
    if (t.dataset.i !== undefined) {
      const i = +t.dataset.i; item = i;
      write((d) => {
        const it = d.menus[cur].items[i];
        if (t.dataset.k === 'label') it.label = v;
        if (t.dataset.k === 'action') it.action = v === 'menu' || v === 'scene' ? `${v}:` : v;
        if (t.dataset.k === 'param') it.action = `${it.action.split(':')[0]}:${v}`;
      });
    }
  });
  insp.addEventListener('input', (ev) => { // texto en vivo en la vista previa
    const t = ev.target;
    if (t.dataset.m === 'title' || t.dataset.m === 'subtitle' || t.dataset.k === 'label' || t.type === 'color') {
      const d = data();
      if (t.dataset.s) d.settings[t.dataset.s] = t.value;
      else if (t.dataset.m) d.menus[cur][t.dataset.m] = t.value;
      else d.menus[cur].items[+t.dataset.i].label = t.value;
      renderPreview(d);
    }
  });
  insp.addEventListener('focusin', (ev) => { const i = ev.target.closest('.mitem')?.dataset.i; if (i !== undefined && +i !== item) { item = +i; renderPreview(data()); insp.querySelectorAll('.mitem').forEach((x) => x.classList.toggle('on', +x.dataset.i === item)); } });
  insp.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const i = +b.dataset.i;
    if (b.dataset.act === 'add') { write((d) => { (d.menus[cur].items ??= []).push({ label: 'Opción', action: 'back' }); }); item = data().menus[cur].items.length - 1; render(); }
    if (b.dataset.act === 'rm') { write((d) => { d.menus[cur].items.splice(i, 1); }); item = Math.max(0, i - 1); render(); }
    if (b.dataset.act === 'up' || b.dataset.act === 'down') {
      const j = b.dataset.act === 'up' ? i - 1 : i + 1;
      write((d) => { const a = d.menus[cur].items; [a[i], a[j]] = [a[j], a[i]]; });
      item = j; render();
    }
    if (b.dataset.act === 'del') {
      const r = await app.ask('Borrar menú', `¿Borrar <b>${esc(cur)}</b>? Las opciones que lo abren quedan sin destino.`, [['cancel', 'Cancelar'], ['ok', 'Borrar', 'danger']]);
      if (r === 'ok') { write((d) => { delete d.menus[cur]; }); cur = null; render(); }
    }
  });

  async function create() {
    const r = await app.ask('Menú nuevo', 'Nombre corto (ej. <b>creditos</b>). Después agregá una opción "Abrir otro menú…" que lo abra.', [['cancel', 'Cancelar'], ['ok', 'Crear', 'primary']], { input: { placeholder: 'creditos' } });
    if (r.value !== 'ok') return;
    const n = slug(r.text); if (!n) return;
    if (data().menus[n]) { app.toast(`Ya existe ${n}`, true); return; }
    write((d) => { d.menus[n] = { kind: 'panel', title: r.text, items: [{ label: 'Volver', action: 'back' }] }; });
    cur = n; item = 0; render();
  }

  return {
    async show() {
      if (!doc) {
        const text = await app.api.read(PATH).catch(() => null);
        doc = fileDoc(PATH, text ?? '');
        if (!text) { doc.set(`${JSON.stringify(DEFAULT_MENUS, null, 2)}\n`); app.toast('Todavía no había menús: armé título, pausa y opciones para empezar (guardá para usarlos)'); app.wsChanged(); }
      }
      // letras del juego (data/ui.json): las importadas también sirven para los menús
      try { uiTheme = resolveUI(JSON.parse(await app.api.read('data/ui.json'))); } catch { uiTheme = resolveUI({}); }
      applyUI(uiTheme, { scope: '.mprev' }).catch(() => {}); // carga las letras (sin esperar)
      if (!cur) cur = Object.keys(data().menus)[0] ?? '__settings';
      render();
    },
    get dirty() { return !!doc?.dirty; },
    async save() {
      if (!doc?.dirty) return;
      await app.api.write(PATH, doc.text); doc.saved = doc.text; app.markOwnWrite(PATH);
      app.wsChanged(); render(); app.toast('Menús guardados');
    },
    undo() { if (doc?.undoOne()) { app.wsChanged(); render(); } },
    redo() { if (doc?.redoOne()) { app.wsChanged(); render(); } },
    async external(path) { if (path === PATH && doc && !doc.dirty) { doc.text = doc.saved = await app.api.read(PATH); render(); } },
    refresh: () => doc && render(),
  };
}
