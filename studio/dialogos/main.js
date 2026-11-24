// Editor de diálogos de Coronda (http://localhost:5173/__dialogos): los nodos del Studio clásico para editar textos,
// opciones y condiciones, más "Probar" (reproduce la charla acá mismo) y "Variables" (qué flags se cambian y se miran).
// Las escenas se siguen armando en Blender; esta página solo toca data/dialogues/*.json.
import { api } from './api.js';
import { icon } from './icons.js';
import { esc } from './ws-common.js';
import { createGraphWorkspace } from './ws-graph.js';
import { forgetIndex } from './project-index.js';

const $ = (id) => document.getElementById(id);
const app = { files: [], scenes: {}, sceneId: null, api, lists: {} };
window.addEventListener('error', (e) => app.toast?.(e.message, true));

let toastT;
app.toast = (msg, err = false) => {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), err ? 5200 : 2400);
};
app.ask = (title, html, buttons, { input } = {}) => new Promise((resolve) => {
  const d = $('dlg');
  $('dlgTitle').textContent = title;
  $('dlgBody').innerHTML = html + (input ? `<input id="dlgInput" value="${esc(input.value ?? '')}" placeholder="${esc(input.placeholder ?? '')}" spellcheck="false">` : '');
  $('dlgActions').innerHTML = buttons.map(([v, t, c]) => `<button value="${esc(v)}" class="${c ?? ''}">${esc(t)}</button>`).join('');
  d.onclose = () => resolve(input ? { value: d.returnValue, text: $('dlgInput')?.value.trim() ?? '' } : d.returnValue);
  d.returnValue = '';
  d.showModal();
  if (input) { const i = $('dlgInput'); i.focus(); i.select(); i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); d.close(buttons.at(-1)[0]); } }; }
});
const ownWrites = new Map();
app.markOwnWrite = (p) => ownWrites.set(p, Date.now());
app.refreshFiles = async () => {
  const t = await api.tree();
  app.files = t.files.map((f) => f.p);
  app.lists.dialogues = app.files.filter((p) => /^data\/dialogues\/[^/]+\.json$/i.test(p)).map((p) => p.split('/').pop().replace(/\.json$/i, '')).sort();
};

let ws = null;
app.wsChanged = () => { $('bSave').classList.toggle('dirty', !!ws?.dirty); };
app.openFile = (path) => ws?.openFile?.(path);

async function save() {
  try { await ws?.save(); app.wsChanged(); } catch (err) { app.toast(err.message, true); }
}
$('bUndo').innerHTML = icon('undo'); $('bRedo').innerHTML = icon('redo');
$('bUndo').addEventListener('click', () => ws?.undo());
$('bRedo').addEventListener('click', () => ws?.redo());
$('bSave').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  if (e.code === 'KeyS') { e.preventDefault(); save(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (typing) return;
  if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); ws?.undo(); }
  else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); ws?.redo(); }
});
window.addEventListener('beforeunload', (e) => { if (ws?.dirty) { e.preventDefault(); e.returnValue = ''; } });

api.events(async (m) => {
  const p = m.path ?? '';
  if (/^data\//.test(p) || /\.glb$/i.test(p)) forgetIndex();
  if (/^(assets|data)\//.test(p)) await app.refreshFiles();
  if (Date.now() - (ownWrites.get(p) ?? 0) > 1500) ws?.external?.(p);
});

(async () => {
  try {
    await app.refreshFiles();
    app.scenes = await api.readJSON('data/tables/scenes.json').catch(() => ({}));
    const el = document.createElement('div');
    el.className = 'wsv';
    $('ws').appendChild(el);
    ws = await createGraphWorkspace(app, el, 'dialogue');
    await ws.show();
    const want = decodeURIComponent(location.hash.slice(1));
    if (want) ws.openFile(`data/dialogues/${want}.json`);
  } catch (err) {
    app.toast(err.message, true);
    console.error(err);
  }
})();
