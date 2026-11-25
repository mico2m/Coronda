// Editor de diálogos: lista de archivos + editor de nodos (el del Studio clásico) + Probar + Variables
import { listPane, fileDoc, esc, baseName } from './ws-common.js';
import { projectIndex, clipsOf } from './project-index.js';
import { createDialogueTester } from './dlg-tester.js';
import { openVariables } from './variables.js';
import { icon } from './icons.js';

const DLG = (n) => `{\n  "speaker": "${n.charAt(0).toUpperCase() + n.slice(1).replace(/_+/g, ' ')}",\n  "start": "inicio",\n  "nodes": {\n    "inicio": { "text": "Hola." }\n  }\n}\n`;
const RT = () => `{\n  "speed": 1.4,\n  "start": "a",\n  "nodes": {\n    "a": { "point": "", "wait": 2 }\n  }\n}\n`;

export async function createGraphWorkspace(app, el, mode) {
  const isDlg = mode === 'dialogue';
  const dir = isDlg ? 'data/dialogues' : 'data/routes';
  const what = isDlg ? 'diálogo' : 'recorrido';
  el.innerHTML = `<aside class="wsl"></aside><section class="wsc"><div class="wsbar"><b class="wst"></b><span class="wsu"></span><span class="spacer"></span>
      <button class="ghost" data-act="vars" title="Qué recuerda el juego (flags) y quién lo usa">${icon('flag', { size: 13 })}Variables</button>
      ${isDlg ? `<button class="ghost" data-act="test" title="Reproducir la charla acá mismo">${icon('play', { size: 13 })}Probar</button>` : `<button class="ghost on" data-act="map" title="Ver el recorrido desde arriba">${icon('target', { size: 13 })}Mapa</button>`}</div><div class="graph"></div></section>
    ${isDlg ? '<aside class="wsr panel dtw" hidden></aside>' : '<aside class="wsr panel rmap"></aside>'}`;
  if (!isDlg) el.classList.add('has-right', 'wide-right');
  const docs = new Map();
  let cur = null, curName = null, index = null, clips = { npc: null, clips: [] }, flags = [];

  const pane = listPane(el.querySelector('.wsl'), {
    title: isDlg ? 'Diálogos' : 'Rutas', addLabel: isDlg ? 'Diálogo nuevo' : 'Ruta nueva',
    empty: isDlg ? 'Todavía no hay diálogos. Creá uno con +.' : 'Todavía no hay recorridos. Creá uno con +.',
    onAdd: create, onSelect: open,
  });
  const host = el.querySelector('.graph');
  // Probador (solo diálogos)
  let tester = null;
  const testerEl = el.querySelector('.dtw');
  const dataOf = () => { try { return JSON.parse(cur?.text ?? '{}'); } catch { return {}; } };
  const npcOf = () => { const u = curName ? users(curName)[0] : null; return u ? { id: u.id, label: dataOf().speaker } : { id: curName, label: dataOf().speaker }; };
  if (testerEl) tester = createDialogueTester(testerEl, { getData: dataOf, getNpc: npcOf });
  function toggleTester(on = testerEl.hidden) {
    testerEl.hidden = !on; el.classList.toggle('has-right', on);
    el.querySelector('[data-act="test"]').classList.toggle('on', on);
    if (on) tester.open(); else tester.stop();
  }
  el.querySelector('[data-act="test"]')?.addEventListener('click', () => toggleTester());
  el.querySelector('[data-act="vars"]').addEventListener('click', () => openVariables(app));
  const opts = {
    onChange(text, newStep) { if (!cur) return; if (cur.set(text, newStep)) { app.wsChanged(); renderList(); if (tester && !testerEl.hidden) tester.refresh(); if (map && !mapEl.hidden) map.render(); } },
    onUndo: () => ws.undo(), onRedo: () => ws.redo(),
    clips: () => clips,
  };
  let ed;
  if (isDlg) ed = (await import('/studio/dialogue-editor.js')).createNodeEditor(host, opts);
  else ed = (await import('/studio/route-editor.js')).createRouteEditor(host, {
    ...opts,
    points: () => (index?.points ?? []).filter((p) => !p.scene || p.scene === app.sceneId || /^ruta_/i.test(p.name)),
    flags: () => flags,
    onShow: (on) => { if (on) app.toast('Para ver el recorrido, probalo con ▶ Jugar'); },
  });

  const map = null, mapEl = null;

  const files = () => app.files.filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.json')).sort();
  function users(name) {
    const list = (index?.npcs ?? []).filter((n) => (isDlg ? n.dialogue : n.route) === name);
    return list;
  }
  function renderList() {
    pane.set(files().map((p) => {
      const n = baseName(p), us = users(n), d = docs.get(p);
      return { id: p, label: n, icon: isDlg ? 'chat' : 'route', color: isDlg ? '#0e9aa7' : '#8b5cf6', dirty: d?.dirty,
        sub: us.length ? us.map((u) => `${u.name}${u.modelFile ? ` (${u.modelFile})` : ''} · ${u.scene}${u.sceneFile ? ` (${u.sceneFile})` : ''}`).join(', ') : `Ningún NPC lo usa`,
        warn: us.length ? '' : `Para usarlo, poné ${isDlg ? 'npc_dialogo' : 'npc_ruta'} = ${n} en un NPC (componente NPC del inspector)` };
    }), cur?.path);
  }
  function header() {
    el.querySelector('.wst').textContent = curName ?? '';
    const us = curName ? users(curName) : [];
    el.querySelector('.wsu').innerHTML = curName ? (us.length ? `Lo usa ${us.map((u) => `<b>${esc(u.name)}</b>${u.modelFile ? ` <span class="muted">(${esc(u.modelFile)})</span>` : ''} en ${esc(u.scene)}${u.sceneFile ? ` <span class="muted">(${esc(u.sceneFile)})</span>` : ''}`).join(', ')}` : `<span class="muted">Ningún NPC lo usa todavía</span>`) : '';
  }

  async function prepare(name) { // animaciones reales del NPC que lo usa
    const u = users(name)[0];
    clips = u ? { npc: u.id, clips: (await clipsOf(u.model)).filter((c) => c.kind !== 'junk') } : { npc: null, clips: [] };
  }
  async function collectFlags() {
    const names = new Set();
    for (const n of index?.npcs ?? []) { names.add(`hablo_${n.id}`); names.add(`veces_${n.id}`); }
    for (const p of app.files.filter((f) => /^data\/dialogues\/[^/]+\.json$/.test(f))) {
      try {
        const d = JSON.parse(docs.get(p)?.text ?? await app.api.read(p));
        names.add(`hablo_${baseName(p)}`); names.add(`veces_${baseName(p)}`);
        for (const node of Object.values(d.nodes ?? {})) if (node?.set && typeof node.set === 'object') Object.keys(node.set).forEach((k) => names.add(k));
      } catch { /* un archivo con error: se ignora */ }
    }
    flags = [...names].sort();
  }

  async function open(path) {
    if (!docs.has(path)) {
      try { docs.set(path, fileDoc(path, await app.api.read(path))); } catch (err) { app.toast(err.message, true); return; }
    }
    cur = docs.get(path); curName = baseName(path);
    await prepare(curName);
    if (!isDlg) await collectFlags();
    ed.load(cur.text, curName); ed.show?.();
    header(); renderList();
    app.wsChanged();
    if (tester && !testerEl.hidden) tester.open();
    if (map && !mapEl.hidden) map.render();
  }
  async function create() {
    const r = await app.ask(isDlg ? 'Diálogo nuevo' : 'Recorrido nuevo',
      `Nombre corto, sin espacios. Es el que después va en <b>${isDlg ? 'npc_dialogo' : 'npc_ruta'}</b> del NPC (ej. <b>maria</b>).`,
      [['cancel', 'Cancelar'], ['ok', 'Crear', 'primary']], { input: { placeholder: isDlg ? 'maria' : 'maria_paseo' } });
    if (r.value !== 'ok' || !r.text) return;
    const n = r.text.trim().replace(/\s+/g, '_').replace(/\.json$/i, '').replace(/[^\p{L}\p{N}_-]/gu, '');
    if (!n) return;
    const p = `${dir}/${n}.json`;
    if (app.files.includes(p)) { app.toast(`Ya existe ese ${what}`, true); open(p); return; }
    try { await app.api.write(p, isDlg ? DLG(n) : RT(n)); } catch (err) { app.toast(err.message, true); return; }
    await app.refreshFiles();
    await open(p);
    app.toast(`${isDlg ? 'Diálogo' : 'Recorrido'} ${n} creado`);
  }

  const ws = {
    async show() {
      index = await projectIndex(app);
      renderList();
      if (!cur) { const first = files()[0]; if (first) await open(first); else { header(); } }
      else { ed.load(cur.text, curName); ed.show?.(); header(); }
      if (map && !mapEl.hidden) { map.reshoot(); map.render(); }
    },
    get dirty() { return [...docs.values()].some((d) => d.dirty); },
    async save() {
      for (const d of docs.values()) {
        if (!d.dirty) continue;
        try { JSON.parse(d.text); } catch (err) { app.toast(`${baseName(d.path)}: JSON inválido, no se guardó (${err.message})`, true); continue; }
        await app.api.write(d.path, d.text); d.saved = d.text; app.markOwnWrite(d.path);
      }
      renderList(); app.wsChanged();
      app.toast('Guardado');
    },
    undo() { if (cur?.undoOne()) { ed.load(cur.text, curName); renderList(); app.wsChanged(); map?.render(); } },
    redo() { if (cur?.redoOne()) { ed.load(cur.text, curName); renderList(); app.wsChanged(); map?.render(); } },
    // el archivo cambió en el disco (otro programa): si no hay cambios acá, se recarga
    async external(path) {
      const d = docs.get(path);
      if (d && !d.dirty) { d.text = d.saved = await app.api.read(path); if (d === cur) ed.load(d.text, curName); }
      renderList();
    },
    refresh: () => { renderList(); header(); },
    hide: () => tester?.stop(),
    openFile: (path) => open(path),
  };
  return ws;
}
