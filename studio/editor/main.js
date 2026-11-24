// Coronda · Motor — editor de escenas. Abrí http://localhost:5173/studio/editor/ con `node studio/server.js` corriendo.
// La escena se guarda en data/scenes/<id>.json > "entities" (ver src/systems/entities.js). El juego la lee tal cual.
import { api, json } from './api.js';
import { createViewport } from './viewport.js';
import { createHierarchy } from './hierarchy.js';
import { createInspector } from './inspector.js';
import { createAssets } from './assets.js';
import { icon, kindOf, KIND } from './components.js';
import { loadGLB } from '/src/core/assets.js';
import { DEG } from '/src/systems/entities.js';
import * as THREE from 'three';
import { createGraphWorkspace } from './ws-graph.js';
import { createMusicWorkspace } from './ws-music.js';
import { createMenusWorkspace } from './ws-menus.js';
import { createProjectWorkspace } from './ws-project.js';
import { createUIWorkspace } from './ws-ui.js';
import { openPalette, openVariables } from './palette.js';
import { TEMPLATES } from './components.js';
import { forgetIndex } from './project-index.js';

const $ = (id) => document.getElementById(id);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(`coronda.editor.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`coronda.editor.${k}`, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const app = {
  api,
  doc: { entities: [] },
  sceneId: null, sceneFile: null,
  scenes: {}, music: {}, files: [],
  lists: { models: [], objects: [], dialogues: [], routes: [] },
  selected: null,
  editorHidden: new Set(),
  dirty: false,
};
let seq = 0;
const newId = () => `e${Date.now().toString(36)}${(seq++).toString(36)}`;

// ---------- avisos, menús, diálogos ----------
let toastT;
app.toast = (msg, err = false) => {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), err ? 5200 : 2400);
};
app.status = (msg) => { $('stMsg').textContent = msg; };
app.closeMenus = () => document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; if (m.dataset.float) m.remove(); });
app.toggleMenu = (m) => { const was = m.hidden; app.closeMenus(); m.hidden = !was; };
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu') && !e.target.closest('.menuwrap > button, .menuwrap > .ib')) app.closeMenus(); });
app.contextMenu = (x, y, items) => {
  app.closeMenus();
  const m = document.createElement('div');
  m.className = 'menu'; m.dataset.float = '1';
  m.style.cssText = `position:fixed;left:${x}px;top:${y}px;right:auto`;
  m.innerHTML = items.filter(Boolean).map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}"${it[3] === 'danger' ? ' style="color:#d92d20"' : ''}>${esc(it[0])}${it[1] ? `<small><kbd>${esc(it[1])}</kbd></small>` : ''}</button>`)).join('');
  const list = items.filter(Boolean);
  m.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; app.closeMenus(); list[+b.dataset.i][2](); });
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  if (r.bottom > innerHeight) m.style.top = `${innerHeight - r.height - 8}px`;
  if (r.right > innerWidth) m.style.left = `${innerWidth - r.width - 8}px`;
};
// diálogo: buttons = [[valor, texto, clase]]; con input: devuelve { value, text }
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

// ---------- historial ----------
const undo = [], redo = [];
let liveBefore = null;
const snap = () => JSON.stringify(app.doc);
function pushHistory(label, before) {
  undo.push({ label, before }); if (undo.length > 200) undo.shift();
  redo.length = 0;
  setDirty(true);
}
app.commit = (label, fn) => {
  const before = snap();
  fn(app.doc);
  if (snap() !== before) pushHistory(label, before);
  refresh();
};
app.beginLive = () => { liveBefore = snap(); };
app.setLive = (fn) => { fn(app.doc); viewport.sync(app.doc); inspector.refresh(); };
app.endLive = (label) => {
  if (liveBefore !== null && liveBefore !== snap()) pushHistory(label, liveBefore);
  liveBefore = null;
  refresh();
};
function doUndo() {
  const u = undo.pop(); if (!u) return;
  redo.push({ label: u.label, before: snap() });
  app.doc = JSON.parse(u.before); setDirty(true); refresh();
  app.status(`Deshecho: ${u.label}`);
}
function doRedo() {
  const r = redo.pop(); if (!r) return;
  undo.push({ label: r.label, before: snap() });
  app.doc = JSON.parse(r.before); setDirty(true); refresh();
  app.status(`Rehecho: ${r.label}`);
}
function setDirty(v) {
  app.dirty = v;
  document.title = `${v ? '● ' : ''}${app.sceneId ?? ''} · Coronda Motor`;
  app.wsChanged?.();
}

// ---------- entidades ----------
app.entity = (id) => (app.doc.entities ?? []).find((e) => e.id === id) ?? null;
Object.defineProperty(app, 'selectedEntity', { get: () => app.entity(app.selected) });
const descendants = (id) => {
  const out = [], ents = app.doc.entities ?? [];
  (function walk(p) { for (const e of ents) if (e.parent === p) { out.push(e); walk(e.id); } })(id);
  return out;
};
function uniqueName(base, except = null) {
  const names = new Set((app.doc.entities ?? []).filter((e) => e.id !== except).map((e) => e.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) { const n = `${stem}.${String(i).padStart(3, '0')}`; if (!names.has(n)) return n; }
}
app.addEntity = (partial, { at = null, parent = null, select = true, label = 'Agregar' } = {}) => {
  const e = { id: newId(), name: uniqueName(partial.name ?? 'vacio'), position: at ?? partial.position ?? [0, 0, 0] };
  for (const k of ['rotation', 'scale', 'model', 'node', 'props']) if (partial[k] !== undefined) e[k] = structuredClone(partial[k]);
  if (parent) e.parent = parent;
  app.commit(label, (doc) => { (doc.entities ??= []).push(e); });
  if (select) app.select(e.id);
  return e.id;
};
// "puerta_casa.glb" -> "Puerta casa": el nombre de archivo tal cual podría activar una regla por nombre
// (puerta_…, npc_…, col_…, spawn…) que el usuario no pidió
const niceName = (base) => { const t = base.replace(/[_-]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
app.addModel = (path, at) => {
  const name = niceName(path.split('/').pop().replace(/\.[^.]+$/, ''));
  app.addEntity({ name, model: path }, { at, label: `Agregar ${name}` });
};
app.remove = (id) => {
  const e = app.entity(id); if (!e) return;
  const gone = new Set([id, ...descendants(id).map((d) => d.id)]);
  app.commit(`Borrar ${e.name}`, (doc) => { doc.entities = doc.entities.filter((x) => !gone.has(x.id)); });
  if (gone.has(app.selected)) app.select(null);
};
app.duplicate = (id) => {
  const e = app.entity(id); if (!e) return;
  const map = new Map();
  const group = [e, ...descendants(id)];
  for (const x of group) map.set(x.id, newId());
  app.commit(`Duplicar ${e.name}`, (doc) => {
    for (const x of group) {
      const c = structuredClone(x);
      c.id = map.get(x.id);
      if (x.parent && map.has(x.parent)) c.parent = map.get(x.parent);
      c.name = uniqueName(x.name);
      doc.entities.push(c);
    }
  });
  app.select(map.get(id));
};
app.rename = (id, name) => {
  const e = app.entity(id); if (!e || e.name === name) { refresh(); return; }
  app.commit('Renombrar', (doc) => { doc.entities.find((x) => x.id === id).name = uniqueName(name, id); });
};
// cambiar de padre sin que el objeto se mueva en el mundo
app.reparent = (id, parentId) => {
  if (id === parentId) return;
  if (parentId && descendants(id).some((d) => d.id === parentId)) { app.toast('No se puede poner un objeto adentro de su propio hijo', true); return; }
  const e = app.entity(id); if (!e || (e.parent ?? null) === parentId) return;
  const world = viewport.worldTransformOf(id);
  const pWorld = parentId ? viewport.worldTransformOf(parentId) : new THREE.Matrix4();
  const local = pWorld.clone().invert().multiply(world);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  local.decompose(p, q, s);
  const r = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  app.commit(parentId ? 'Emparentar' : 'Sacar del padre', (doc) => {
    const t = doc.entities.find((x) => x.id === id);
    if (parentId) t.parent = parentId; else delete t.parent;
    t.position = p.toArray().map(r4);
    t.rotation = [r.x, r.y, r.z].map((v) => Math.round((v / DEG) * 100) / 100);
    t.scale = s.toArray().map(r4);
  });
};
app.toggleEditorHidden = (id) => {
  const set = app.editorHidden;
  const all = [id, ...descendants(id).map((d) => d.id)];
  const hide = !set.has(id);
  for (const x of all) hide ? set.add(x) : set.delete(x);
  viewport.setEditorHidden(set);
  hierarchy.render();
};
app.select = (id) => {
  app.selected = id && app.entity(id) ? id : null;
  viewport.select(app.selected);
  hierarchy.render();
  inspector.refresh();
  const e = app.selectedEntity;
  app.status(e ? `${e.name} · ${KIND[kindOf(e)].label}` : '');
  showRoutePath(e);
};
// Recorrido del NPC elegido, dibujado en el visor (las paradas que son entidades de esta escena)
let pathReq = 0;
async function showRoutePath(e) {
  const my = ++pathReq;
  const r = e?.props?.npc_ruta ? String(e.props.npc_ruta).replace(/\.json$/i, '') : '';
  if (!r) { viewport.showPath([]); return; }
  let d; try { d = await api.readJSON(`data/routes/${r}.json`); } catch { viewport.showPath([]); return; }
  if (my !== pathReq) return;
  const nodes = d.nodes ?? {};
  const nx = (n) => (typeof n?.next === 'string' ? n.next : Array.isArray(n?.next) ? n.next[0]?.to : null);
  const order = [], seen = new Set();
  let c = d.start && nodes[d.start] ? d.start : Object.keys(nodes)[0];
  while (c && nodes[c] && !seen.has(c)) { seen.add(c); order.push(c); c = nx(nodes[c]); }
  const loops = c && seen.has(c);
  const byName = new Map((app.doc.entities ?? []).map((x) => [x.name, x.id]));
  const pts = [];
  const v = new THREE.Vector3();
  for (const id of [...order, ...(loops ? [c] : [])]) {
    const eid = byName.get(nodes[id]?.point); if (!eid) continue;
    const m = viewport.worldTransformOf(eid); if (!m) continue;
    v.setFromMatrixPosition(m); pts.push({ x: v.x, y: v.y, z: v.z });
  }
  viewport.showPath(pts);
}

// ---------- refresco general ----------
function refresh() {
  if (app.selected && !app.entity(app.selected)) app.selected = null;
  viewport.sync(app.doc);
  viewport.select(app.selected);
  hierarchy.render();
  inspector.refresh();
  assets.renderGrid();
  if (wsId === 'scene') {
    $('bUndo').disabled = !undo.length; $('bRedo').disabled = !redo.length;
    $('bUndo').title = undo.length ? `Deshacer: ${undo.at(-1).label} (Ctrl+Z)` : 'Deshacer (Ctrl+Z)';
  }
  $('stCount').textContent = `${(app.doc.entities ?? []).length} entidades`;
}

// ---------- archivos del proyecto ----------
app.refreshFiles = async () => {
  const t = await api.tree();
  app.files = t.files.map((f) => f.p);
  const base = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');
  app.lists.models = app.files.filter((p) => p.startsWith('assets/') && /\.glb$/i.test(p)).sort();
  app.lists.objects = app.files.filter((p) => /^assets\/models\/objects\/[^/]+\.glb$/i.test(p)).map(base).sort();
  app.lists.dialogues = app.files.filter((p) => /^data\/dialogues\/[^/]+\.json$/i.test(p)).map(base).sort();
  app.lists.routes = app.files.filter((p) => /^data\/routes\/[^/]+\.json$/i.test(p)).map(base).sort();
  assets.setFiles(app.files);
};

// ---------- escenas ----------
async function loadScenes() {
  app.scenes = await api.readJSON('data/tables/scenes.json');
  app.music = await api.readJSON('data/tables/music.json').catch(() => ({}));
  $('sceneSel').innerHTML = Object.keys(app.scenes).map((id) => `<option value="${esc(id)}">${esc(id)}${app.scenes[id].start ? ' · inicio' : ''}</option>`).join('');
}
async function openScene(id) {
  const entry = app.scenes[id];
  if (!entry) { app.toast(`No existe la escena ${id}`, true); return; }
  const doc = await api.readJSON(entry.file);
  doc.entities ??= [];
  for (const e of doc.entities) e.id ??= newId();
  app.doc = doc; app.sceneId = id; app.sceneFile = entry.file;
  app.selected = null; app.editorHidden = new Set(); viewport.setEditorHidden(app.editorHidden);
  undo.length = 0; redo.length = 0;
  setDirty(false);
  $('sceneSel').value = id;
  $('openGame').href = `/dev.html?scene=${encodeURIComponent(id)}`;
  history.replaceState(null, '', `#${id}`);
  store.set('scene', id);
  viewport.resetFraming();
  refresh();
  app.status(`Escena ${id}`);
}
async function confirmLeave() {
  if (!app.dirty) return true;
  const r = await app.ask('Hay cambios sin guardar', `La escena <b>${esc(app.sceneId)}</b> tiene cambios.`, [['cancel', 'Cancelar'], ['discard', 'Descartar'], ['save', 'Guardar', 'primary']]);
  if (r === 'save') { await save(); return true; }
  return r === 'discard';
}
async function save() {
  try {
    await api.write(app.sceneFile, json(app.doc));
    ignoreSelf = Date.now(); app.markOwnWrite(app.sceneFile); forgetIndex();
    setDirty(false);
    app.toast(`Guardado · ${app.sceneFile}`);
  } catch (err) { app.toast(err.message, true); throw err; }
}
let ignoreSelf = 0;
app.saveScene = () => save();
async function newScene() {
  const r = await app.ask('Escena nueva', 'Nombre corto, sin espacios (ej. <b>scene_casa2</b>). Se crea con un punto de aparición y un piso de colisión.', [['cancel', 'Cancelar'], ['ok', 'Crear', 'primary']], { input: { placeholder: 'scene_nueva' } });
  if (r.value !== 'ok' || !r.text) return;
  const id = r.text.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '');
  if (!id) return;
  if (app.scenes[id]) { app.toast(`Ya existe ${id}`, true); return; }
  if (!(await confirmLeave())) return;
  const file = `data/scenes/${id}.json`;
  const doc = {
    id, name: r.text,
    environment: { shading: 'unlit', tint: '#ffffff', brightness: 1, background: '#9fc6e8' },
    collision: { default: 'none' },
    entities: [
      { id: newId(), name: 'spawn', position: [0, 0, 0] },
      { id: newId(), name: 'col_suelo', position: [0, -0.1, 0], scale: [50, 0.1, 50] },
    ],
  };
  await api.write(file, json(doc));
  app.scenes[id] = { file };
  await api.write('data/tables/scenes.json', json(app.scenes));
  await loadScenes();
  await openScene(id);
  app.toast(`Escena ${id} creada`);
}

// ---------- convertir una escena de Blender (.glb) en entidades ----------
app.convertRooms = async () => {
  const rooms = (app.doc.rooms ?? []).filter((r) => r.model);
  if (!rooms.length) return;
  const backup = `data/scenes/${app.sceneId}.antes-de-convertir.json`;
  const ok = await app.ask('Convertir en entidades',
    `Cada objeto de <b>${esc(rooms.map((r) => r.model.split('/').pop()).join(', '))}</b> pasa a ser una entidad que podés mover y editar acá, con sus mismas propiedades (puertas, NPC, colisiones, spawns…).
     <br><br>Desde ahí la escena la arma el motor: si después cambiás algo en Blender, importalo como asset.
     <br><br>Antes guardo una copia en <b>${esc(backup)}</b>.`,
    [['cancel', 'Cancelar'], ['ok', 'Convertir', 'primary']]);
  if (ok !== 'ok') return;
  try {
    await api.write(backup, json(app.doc));
    const ents = [];
    for (const room of rooms) {
      const gltf = await loadGLB(`/${room.model}`);
      for (const node of gltf.scene.children) {
        let hasMesh = false;
        node.traverse((o) => { if (o.isMesh) hasMesh = true; });
        const props = { ...node.userData };
        delete props.name;
        const isPrefab = typeof props.objeto === 'string' && props.objeto.trim();
        const e = {
          id: newId(), name: node.name,
          position: node.position.toArray().map(r4),
          rotation: [node.rotation.x, node.rotation.y, node.rotation.z].map((v) => Math.round((v / DEG) * 100) / 100),
          scale: node.scale.toArray().map(r4),
        };
        if (e.rotation.every((v) => v === 0)) delete e.rotation;
        if (e.scale.every((v) => v === 1)) delete e.scale;
        if (hasMesh && !isPrefab) { e.model = room.model; e.node = node.name; }
        if (Object.keys(props).length) e.props = props;
        ents.push(e);
      }
    }
    app.commit('Convertir escena', (doc) => { doc.entities = [...(doc.entities ?? []), ...ents]; doc.rooms = []; });
    await save();
    app.toast(`Listo: ${ents.length} entidades. Copia en ${backup}`);
  } catch (err) { console.error(err); app.toast(`No se pudo convertir: ${err.message}`, true); }
};

// ---------- jugar ----------
let playing = false;
async function play() {
  if (playing) return stop();
  if (app.dirty) { try { await save(); } catch { return; } }
  let url = `/index.html?scene=${encodeURIComponent(app.sceneId)}&play=1`;
  if ($('fromView').checked) {
    const p = viewport.centerPoint(), cam = viewport.cameraPose();
    url += `&from=${p[0]},${p[1]},${p[2]},${cam.yawDeg}`;
  }
  playing = true;
  $('playFrame').src = url;
  $('playView').hidden = false;
  $('playScene').textContent = app.sceneId;
  document.body.classList.add('playing');
  $('bPlay').classList.add('playing');
  $('bPlay').querySelector('.pl').textContent = 'Detener';
  $('bPlay').querySelector('.pi').innerHTML = icon('stop', { size: 13, color: '#fff', stroke: 2 });
  viewport.setPaused(true);
  setTimeout(() => $('playFrame').focus(), 300);
}
function stop() {
  playing = false;
  $('playFrame').src = 'about:blank';
  $('playView').hidden = true;
  document.body.classList.remove('playing');
  $('bPlay').classList.remove('playing');
  $('bPlay').querySelector('.pl').textContent = 'Jugar';
  $('bPlay').querySelector('.pi').innerHTML = icon('play', { size: 13, color: '#fff', stroke: 2 });
  viewport.setPaused(wsId !== 'scene');
}

// ---------- espacios de trabajo (pestañas) ----------
const WS = [
  { id: 'scene', label: 'Escena', icon: 'cube' },
  { id: 'dialogues', label: 'Diálogos', icon: 'chat', make: (el) => createGraphWorkspace(app, el, 'dialogue') },
  { id: 'routes', label: 'Rutas', icon: 'route', make: (el) => createGraphWorkspace(app, el, 'route') },
  { id: 'music', label: 'Música', icon: 'music', make: (el) => createMusicWorkspace(app, el) },
  { id: 'menus', label: 'Menús', icon: 'menu', make: (el) => createMenusWorkspace(app, el), right: true },
  { id: 'ui', label: 'Interfaz', icon: 'palette', make: (el) => createUIWorkspace(app, el), right: true },
  { id: 'project', label: 'Proyecto', icon: 'gear', make: (el) => createProjectWorkspace(app, el) },
];
const wsInst = new Map(); // id -> { el, api }
let wsId = 'scene';
const ownWrites = new Map();
app.markOwnWrite = (p) => ownWrites.set(p, Date.now());
const activeWs = () => (wsId === 'scene' ? null : wsInst.get(wsId)?.api ?? null);
const anyDirty = () => app.dirty || [...wsInst.values()].some((w) => w.api?.dirty);
app.wsChanged = () => {
  for (const b of document.querySelectorAll('#wsTabs button')) {
    const id = b.dataset.ws;
    b.classList.toggle('dirty', id === 'scene' ? app.dirty : !!wsInst.get(id)?.api?.dirty);
  }
  const w = activeWs();
  $('bSave').classList.toggle('dirty', w ? w.dirty : app.dirty);
  if (w) { $('bUndo').disabled = false; $('bRedo').disabled = false; $('bUndo').title = 'Deshacer (Ctrl+Z)'; }
};
async function setWorkspace(id) {
  if (!WS.some((w) => w.id === id)) id = 'scene';
  wsId = id; store.set('ws', id);
  document.querySelectorAll('#wsTabs button').forEach((b) => b.classList.toggle('on', b.dataset.ws === id));
  const other = id !== 'scene';
  $('app').classList.toggle('other', other);
  $('ws').hidden = !other;
  for (const [k, w] of wsInst) if (k !== id) { w.el.hidden = true; w.api?.hide?.(); }
  $('stCount').hidden = other;
  if (other) $('stHint').innerHTML = '<kbd>Ctrl+S</kbd> guardar · <kbd>Ctrl+Z</kbd> deshacer · <kbd>Ctrl+Y</kbd> rehacer · <kbd>Ctrl+P</kbd> jugar la escena abierta'; else hint();
  viewport.setPaused(other || playing);
  if (!other) { refresh(); return; }
  let w = wsInst.get(id);
  if (!w) {
    const def = WS.find((x) => x.id === id);
    const el = document.createElement('div');
    el.className = `wsv${def.right ? ' has-right' : ''}`;
    $('ws').appendChild(el);
    w = { el, api: null };
    wsInst.set(id, w);
    try { w.api = await def.make(el); } catch (err) { console.error(err); el.innerHTML = `<div class="empty"><b>No se pudo abrir ${esc(def.label)}</b>${esc(err.message)}</div>`; return; }
  }
  w.el.hidden = false;
  try { await w.api?.show(); } catch (err) { console.error(err); app.toast(err.message, true); }
  app.wsChanged();
}
app.openSceneWs = async (sceneId) => {
  await setWorkspace('scene');
  if (sceneId && sceneId !== app.sceneId && (await confirmLeave())) openScene(sceneId);
};
app.importFiles = (files, folder) => assets.importFiles(files, folder);
// Abrir un archivo en su espacio (ej. el diálogo de un NPC desde el inspector)
app.openWsFile = async (wsIdTo, path) => {
  await setWorkspace(wsIdTo);
  const w = wsInst.get(wsIdTo)?.api;
  if (path && w?.openFile) { if (!app.files.includes(path)) await app.refreshFiles(); await w.openFile(path); }
};

// ---------- copiar y pegar entidades (entre escenas también: queda en el navegador) ----------
const CLIP = 'coronda.clipboard';
function copySelection() {
  const e = app.selectedEntity; if (!e) return;
  const group = [e, ...descendants(e.id)];
  localStorage.setItem(CLIP, JSON.stringify({ from: app.sceneId, root: e.id, entities: group }));
  app.toast(`Copiado: ${e.name}${group.length > 1 ? ` (+${group.length - 1})` : ''}`);
}
function pasteClipboard() {
  let c; try { c = JSON.parse(localStorage.getItem(CLIP)); } catch { c = null; }
  if (!c?.entities?.length) { app.toast('No hay nada copiado (Ctrl+C sobre una entidad)', true); return; }
  const map = new Map(c.entities.map((x) => [x.id, newId()]));
  const names = new Set((app.doc.entities ?? []).map((x) => x.name));
  app.commit(`Pegar ${c.entities[0].name}`, (doc) => {
    doc.entities ??= [];
    for (const x of c.entities) {
      const n = structuredClone(x);
      n.id = map.get(x.id);
      if (x.id === c.root || !map.has(x.parent)) delete n.parent; else n.parent = map.get(x.parent);
      if (names.has(n.name)) n.name = uniqueName(n.name);
      names.add(n.name);
      doc.entities.push(n);
    }
  });
  app.select(map.get(c.root));
  app.toast(c.from && c.from !== app.sceneId ? `Pegado desde ${c.from}` : 'Pegado');
}
// Apoyar en el suelo (Fin): baja (o sube) la entidad hasta lo que tenga debajo
function dropToGround() {
  const e = app.selectedEntity; if (!e) return;
  const g = viewport.groundBelow(e.id);
  if (!g) { app.toast('No hay nada debajo para apoyarlo', true); return; }
  const m = viewport.worldTransformOf(e.id);
  const wy = new THREE.Vector3().setFromMatrixPosition(m).y;
  const dy = g.y + g.offset - wy;
  if (Math.abs(dy) < 1e-4) return;
  app.commit(`Apoyar ${e.name} en el suelo`, (doc) => {
    const t = doc.entities.find((x) => x.id === e.id);
    const pos = [...(t.position ?? [0, 0, 0])];
    pos[1] = Math.round((pos[1] + dy) * 1e4) / 1e4; // con padre rotado no es exacto, pero alcanza para piezas apoyadas
    t.position = pos;
  });
}

// ---------- paleta de comandos (Ctrl+K) ----------
function commands() {
  const out = [];
  const add = (group, label, run, extra = {}) => out.push({ group, label, run, ...extra });
  add('Acción', 'Guardar', () => saveActive(), { icon: 'file', sub: 'Ctrl+S' });
  add('Acción', playing ? 'Detener el juego' : 'Jugar la escena', () => play(), { icon: 'play', sub: 'Ctrl+P' });
  add('Acción', 'Escena nueva', () => newScene(), { icon: 'plus' });
  add('Acción', 'Variables del juego', () => openVariables(app), { icon: 'flag', sub: 'Qué recuerda el juego y quién lo usa' });
  add('Acción', 'Abrir el juego (dev.html)', () => window.open('/dev.html', '_blank', 'noopener'), { icon: 'globe' });
  add('Acción', 'Atajos de teclado', () => $('bShortcuts').click(), { icon: 'menu' });
  for (const w of WS) add('Espacio', `Ir a ${w.label}`, () => setWorkspace(w.id), { icon: w.icon });
  for (const id of Object.keys(app.scenes ?? {})) add('Escena', `Abrir escena ${id}`, async () => { await setWorkspace('scene'); if (id !== app.sceneId && (await confirmLeave())) openScene(id); }, { icon: 'layers', sub: app.scenes[id].file });
  add('Vista', 'Ver toda la escena', () => { setWorkspace('scene'); viewport.frameAll(); }, { icon: 'target', sub: 'Inicio' });
  for (const [k, l, key] of [['top', 'Vista desde arriba', 'Num 7'], ['front', 'Vista de frente', 'Num 1'], ['right', 'Vista de costado', 'Num 3'], ['back', 'Vista de atrás', 'Ctrl+Num 1']]) add('Vista', l, () => { setWorkspace('scene'); viewport.viewPreset(k); }, { icon: 'eye', sub: key });
  for (const e of app.doc?.entities ?? []) add('Objeto', e.name, () => { setWorkspace('scene'); app.select(e.id); viewport.focus(e.id); }, { icon: KIND[kindOf(e)]?.icon ?? 'cube', sub: KIND[kindOf(e)]?.label });
  for (const t of TEMPLATES ?? []) add('Agregar', `Agregar ${t.label}`, () => { setWorkspace('scene'); app.addEntity(typeof t.make === 'function' ? t.make() : (t.entity ?? { name: t.label }), { at: viewport.centerPoint(), label: `Agregar ${t.label}` }); }, { icon: t.icon ?? 'plus' });
  for (const m of app.lists.objects ?? []) add('Agregar', `Agregar modelo ${m}`, () => { setWorkspace('scene'); app.addModel(`assets/models/objects/${m}.glb`, viewport.centerPoint()); }, { icon: 'cube' });
  for (const d of app.lists.dialogues ?? []) add('Diálogo', d, () => app.openWsFile('dialogues', `data/dialogues/${d}.json`), { icon: 'chat' });
  for (const r of app.lists.routes ?? []) add('Recorrido', r, () => app.openWsFile('routes', `data/routes/${r}.json`), { icon: 'route' });
  return out;
}
app.openPalette = () => openPalette(commands);
$('wsTabs').innerHTML = WS.map((w) => `<button data-ws="${w.id}" title="${esc(w.label)}">${icon(w.icon, { size: 14 })}<span>${esc(w.label)}</span></button>`).join('');
$('wsTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-ws]'); if (b) setWorkspace(b.dataset.ws); });
async function saveActive() {
  const w = activeWs();
  try { if (w) await w.save(); else await save(); } catch (err) { app.toast(err.message, true); }
}

// ---------- armado ----------
const viewport = createViewport($('viewport'), {
  onPick: (id) => app.select(id),
  onGizmoStart: () => app.beginLive(),
  onGizmoChange: (id, tr) => {
    const e = app.entity(id); if (!e) return;
    Object.assign(e, tr);
    inspector.refresh();
  },
  onGizmoEnd: (id, tr) => {
    const e = app.entity(id); if (e) Object.assign(e, tr);
    app.endLive({ translate: 'Mover', rotate: 'Rotar', scale: 'Escalar' }[viewport.tool] ?? 'Transformar');
  },
  onSpeed: (s) => { $('hudSpeed').textContent = `Vuelo ${s.toFixed(1)} m/s`; clearTimeout(onSpeedT); onSpeedT = setTimeout(() => { $('hudSpeed').textContent = ''; }, 1400); },
});
let onSpeedT;
app.viewport = viewport;
const hierarchy = createHierarchy(app);
const inspector = createInspector(app);
const assets = createAssets(app);

// barra superior
$('bNewScene').innerHTML = icon('plus');
$('bUndo').innerHTML = icon('undo'); $('bRedo').innerHTML = icon('redo');
$('bMore').innerHTML = icon('more', { stroke: 2.4 });
$('bPlay').querySelector('.pi').innerHTML = icon('play', { size: 13, color: '#fff', stroke: 2 });
$('bStop').querySelector('.si').innerHTML = icon('stop', { size: 11, stroke: 2 });
const toolBtns = [...document.querySelectorAll('#tools button')];
toolBtns.forEach((b) => { b.innerHTML = icon({ translate: 'move', rotate: 'rotate', scale: 'scale' }[b.dataset.tool]); });
function setTool(t) {
  viewport.setTool(t); store.set('tool', t);
  toolBtns.forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $('hudTool').textContent = { translate: 'Mover', rotate: 'Rotar', scale: 'Escalar' }[t];
  hint();
}
function setSpace(s) {
  viewport.setSpace(s); store.set('space', s);
  $('bSpace').innerHTML = icon(s === 'world' ? 'globe' : 'local');
  $('bSpace').classList.toggle('on', s === 'local');
  $('bSpace').title = s === 'world' ? 'Ejes globales (X para locales)' : 'Ejes locales (X para globales)';
}
function setSnap(v) { viewport.setSnap(v); store.set('snap', v); $('bSnap').innerHTML = icon('magnet'); $('bSnap').classList.toggle('on', v); }
toolBtns.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('bSpace').addEventListener('click', () => setSpace(viewport.space === 'world' ? 'local' : 'world'));
$('bSnap').addEventListener('click', () => setSnap(!viewport.snap));
$('bUndo').addEventListener('click', () => { const w = activeWs(); if (w) w.undo?.(); else doUndo(); });
$('bRedo').addEventListener('click', () => { const w = activeWs(); if (w) w.redo?.(); else doRedo(); });
$('bSave').addEventListener('click', saveActive);
$('bPlay').addEventListener('click', play);
$('bStop').addEventListener('click', stop);
$('fromView').checked = store.get('fromView', false);
$('fromView').addEventListener('change', () => store.set('fromView', $('fromView').checked));
$('bNewScene').addEventListener('click', newScene);
$('sceneSel').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!(await confirmLeave())) { e.target.value = app.sceneId; return; }
  openScene(id);
});
$('bMore').addEventListener('click', (e) => { e.stopPropagation(); app.toggleMenu($('moreMenu')); });
$('bPalette').addEventListener('click', () => { app.closeMenus(); app.openPalette(); });
$('bVars').addEventListener('click', () => { app.closeMenus(); openVariables(app); });
$('bShortcuts').addEventListener('click', () => {
  app.closeMenus();
  const rows = [['W / E / R', 'Mover / rotar / escalar'], ['X', 'Ejes globales o locales'], ['Ctrl (mantener)', 'Ajuste a la grilla'], ['F', 'Enfocar la selección'], ['Inicio', 'Ver toda la escena'],
    ['Clic derecho + WASD · Q E', 'Volar (Shift rápido, rueda = velocidad)'], ['Ruedita apretada', 'Desplazar'], ['Alt + clic', 'Orbitar'],
    ['Fin', 'Apoyar en el suelo'], ['Num 7 / 1 / 3', 'Vista de arriba / frente / costado'], ['Ctrl+C / Ctrl+V', 'Copiar y pegar (también a otra escena)'], ['Ctrl+K', 'Buscar comandos, objetos, escenas…'],
    ['Ctrl+D', 'Duplicar'], ['Supr', 'Borrar'], ['F2', 'Renombrar'], ['Ctrl+Z / Ctrl+Y', 'Deshacer / rehacer'], ['Ctrl+S', 'Guardar'], ['Ctrl+P', 'Jugar / detener'], ['Esc', 'Deseleccionar']];
  app.ask('Atajos de teclado', `<table>${rows.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table>`, [['ok', 'Listo', 'primary']]);
});
function hint() {
  $('stHint').innerHTML = 'Clic: elegir · <kbd>W</kbd><kbd>E</kbd><kbd>R</kbd> herramienta · Clic derecho + <kbd>WASD</kbd> volar · <kbd>F</kbd> enfocar · Arrastrá modelos desde Assets';
}

// soltar modelos (desde Assets o desde la PC) en el visor
const center = $('center');
center.addEventListener('dragover', (e) => {
  const types = [...e.dataTransfer.types];
  if (playing || !(types.includes('application/x-coronda-asset') || types.includes('Files'))) return;
  e.preventDefault(); $('drop').hidden = false;
});
center.addEventListener('dragleave', (e) => { if (!center.contains(e.relatedTarget)) $('drop').hidden = true; });
center.addEventListener('drop', async (e) => {
  $('drop').hidden = true;
  const path = e.dataTransfer.getData('application/x-coronda-asset');
  const at = viewport.dropPoint(e.clientX, e.clientY);
  if (path) { e.preventDefault(); app.addModel(path, at); return; }
  if (e.dataTransfer.files.length) {
    e.preventDefault();
    const ok = await assets.importFiles([...e.dataTransfer.files], 'assets/models/objects');
    ok.filter((p) => /\.glb$/i.test(p)).forEach((p, i) => app.addModel(p, [at[0] + i * 1.5, at[1], at[2]]));
  }
});

// paneles redimensionables
function splitter(el, prop, axis, min, max, invert = false) {
  const appEl = $('app');
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('drag');
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startV = parseFloat(getComputedStyle(appEl).getPropertyValue(prop));
    const move = (m) => {
      const d = (axis === 'x' ? m.clientX : m.clientY) - start;
      const v = Math.max(min, Math.min(max, startV + (invert ? -d : d)));
      appEl.style.setProperty(prop, `${v}px`);
    };
    const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); store.set(prop, appEl.style.getPropertyValue(prop)); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  const saved = store.get(prop, null); if (saved) appEl.style.setProperty(prop, saved);
}
splitter($('splitL'), '--left', 'x', 180, 480);
splitter($('splitR'), '--right', 'x', 260, 560, true);
splitter($('splitB'), '--bottom', 'y', 120, 520, true);

// atajos
window.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.code === 'KeyS') { e.preventDefault(); saveActive(); return; }
  if (ctrl && e.code === 'KeyP') { e.preventDefault(); play(); return; }
  if (ctrl && e.code === 'KeyK') { e.preventDefault(); if (!$('dlg').open && !document.querySelector('.pal-back')) app.openPalette(); return; }
  if (playing || typing || $('dlg').open) return;
  const w = activeWs();
  if (w) { // otros espacios: solo deshacer / rehacer
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? w.redo?.() : w.undo?.(); }
    else if (ctrl && e.code === 'KeyY') { e.preventDefault(); w.redo?.(); }
    return;
  }
  if (viewport.flying) return; // clic derecho + WASD vuela: no cambia de herramienta
  if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if (ctrl && e.code === 'KeyY') { e.preventDefault(); doRedo(); return; }
  if (ctrl && e.code === 'KeyD') { e.preventDefault(); if (app.selected) app.duplicate(app.selected); return; }
  if (ctrl && e.code === 'KeyC') { if (app.selected && !window.getSelection()?.toString()) { e.preventDefault(); copySelection(); } return; }
  if (ctrl && e.code === 'KeyV') { e.preventDefault(); pasteClipboard(); return; }
  if (e.code === 'Numpad1') { e.preventDefault(); viewport.viewPreset(ctrl ? 'back' : 'front'); return; }
  if (ctrl || e.altKey) return;
  switch (e.code) {
    case 'KeyW': setTool('translate'); break;
    case 'KeyE': setTool('rotate'); break;
    case 'KeyR': setTool('scale'); break;
    case 'KeyX': setSpace(viewport.space === 'world' ? 'local' : 'world'); break;
    case 'KeyF': if (app.selected) viewport.focus(app.selected); else viewport.frameAll(); break;
    case 'Home': viewport.frameAll(); break;
    case 'End': if (app.selected) { e.preventDefault(); dropToGround(); } break;
    case 'Numpad7': viewport.viewPreset('top'); break;
    case 'Numpad3': viewport.viewPreset('right'); break;
    case 'Delete': case 'Backspace': if (app.selected) { e.preventDefault(); app.remove(app.selected); } break;
    case 'F2': if (app.selected) { e.preventDefault(); hierarchy.startRename(app.selected); } break;
    case 'Escape': app.closeMenus(); app.select(null); break;
    default: return;
  }
});
window.addEventListener('beforeunload', (e) => { if (anyDirty()) { e.preventDefault(); e.returnValue = ''; } });

// cambios en el proyecto: Blender exportó un .glb, se guardó una escena desde otro lado, etc.
api.events(async (m) => {
  const p = m.path ?? '';
  if (/^data\//.test(p)) forgetIndex();
  if (Date.now() - (ownWrites.get(p) ?? 0) > 1500) for (const w of wsInst.values()) w.api?.external?.(p);
  if (/\.glb$/i.test(p)) { viewport.invalidate(p); assets.forget(p); await app.refreshFiles(); return; }
  if (p === app.sceneFile && m.ext && Date.now() - ignoreSelf > 1500) {
    if (app.dirty) app.toast('La escena cambió en el disco; tus cambios sin guardar siguen acá', true);
    else { const sel = app.selected; await openScene(app.sceneId); if (sel) app.select(sel); app.toast('Escena recargada desde el disco'); }
    return;
  }
  if (/^(assets|audio|data)\//.test(p)) app.refreshFiles();
});

// arranque
(async () => {
  setTool(store.get('tool', 'translate'));
  setSpace(store.get('space', 'world'));
  setSnap(store.get('snap', false));
  hint();
  try {
    await loadScenes();
    await app.refreshFiles();
    const want = decodeURIComponent(location.hash.slice(1)) || store.get('scene', null);
    const id = app.scenes[want] ? want : Object.keys(app.scenes).find((k) => app.scenes[k].start) ?? Object.keys(app.scenes)[0];
    await openScene(id);
    await setWorkspace(store.get('ws', 'scene'));
  } catch (err) {
    console.error(err);
    app.toast(err.message, true);
    $('tree').innerHTML = `<div class="empty"><b>No se pudo abrir el proyecto</b>${esc(err.message)}<br><br>Corré <kbd>node studio/server.js</kbd> en la carpeta de Coronda y abrí esta página desde <b>localhost:5173</b>.</div>`;
  }
})();
