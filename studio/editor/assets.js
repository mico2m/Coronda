// Panel "Assets": carpetas del proyecto, miniaturas 3D de los .glb, importar y arrastrar a la escena
import * as THREE from 'three';
import { loadGLB } from '/src/core/assets.js';
import { makeUnlit } from '/src/systems/shading.js';
import { icon } from './components.js';

const ROOTS = ['assets', 'audio', 'data'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const extOf = (p) => (p.split('.').pop() || '').toLowerCase();
const TYPE = (p) => {
  const x = extOf(p);
  if (x === 'glb' || x === 'gltf') return 'model';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(x)) return 'image';
  if (['ttf', 'otf', 'woff', 'woff2'].includes(x)) return 'font';
  if (['mp3', 'ogg', 'wav'].includes(x)) return 'audio';
  if (x === 'json') return p.startsWith('data/dialogues/') ? 'dialogue' : p.startsWith('data/routes/') ? 'route' : 'data';
  return 'file';
};
const TYPE_ICON = { font: 'type', model: 'cube', image: 'image', audio: 'music', dialogue: 'chat', route: 'route', data: 'file', file: 'file' };
const TYPE_LABEL = { font: 'Letra', model: '3D', image: 'Imagen', audio: 'Audio', dialogue: 'Diálogo', route: 'Ruta', data: 'Datos', file: 'Archivo' };
// a dónde va cada archivo importado si la carpeta elegida es una raíz
const IMPORT_DIR = { model: 'assets/models/objects', image: 'assets/textures', audio: 'audio/sfx', font: 'assets/fonts' };

// ---------- miniaturas ----------
const thumbs = new Map(); // ruta -> dataURL | Promise
let thumbRenderer = null;
const queue = [];
let busy = false;
function thumbFor(path) {
  if (thumbs.has(path)) return Promise.resolve(thumbs.get(path));
  const p = new Promise((resolve) => { queue.push({ path, resolve }); pump(); });
  thumbs.set(path, p);
  p.then((url) => thumbs.set(path, url));
  return p;
}
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const { path, resolve } = queue.shift();
  try { resolve(await renderThumb(path)); } catch { resolve(null); }
  busy = false;
  pump();
}
async function renderThumb(path) {
  const S = 192;
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(S, S);
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const gltf = await loadGLB(`/${path}`);
  const obj = gltf.scene;
  makeUnlit(obj);
  const scene = new THREE.Scene();
  scene.add(obj);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj, true);
  if (box.isEmpty()) return null;
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.length() / 2, 0.01);
  const cam = new THREE.PerspectiveCamera(30, 1, r / 100, r * 20);
  const dir = new THREE.Vector3(0.9, 0.62, 1.15).normalize();
  cam.position.copy(c).addScaledVector(dir, (r / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02);
  cam.lookAt(c);
  thumbRenderer.setClearColor(0x000000, 0);
  thumbRenderer.render(scene, cam);
  const url = thumbRenderer.domElement.toDataURL('image/png');
  obj.traverse((o) => { o.geometry?.dispose?.(); });
  return url;
}
export function forgetThumb(path) { thumbs.delete(path); }

export function createAssets(app) {
  const folders = document.getElementById('folders');
  const grid = document.getElementById('grid');
  const crumbs = document.getElementById('crumbs');
  const filter = document.getElementById('aFilter');
  const importBtn = document.getElementById('bImport');
  const importInput = document.getElementById('importInput');
  document.querySelector('#bottom .search .si').innerHTML = icon('search', { size: 13 });
  importBtn.querySelector('.si').innerHTML = icon('upload', { size: 14 });

  let files = [];         // rutas del proyecto
  let dirs = new Set();
  let cur = 'assets/models/objects';
  let selected = null;
  const openDirs = new Set(['assets', 'assets/models']);

  function setFiles(list) {
    files = list.filter((p) => ROOTS.some((r) => p.startsWith(`${r}/`)) && !/(^|\/)\.gitkeep$/.test(p));
    dirs = new Set(ROOTS);
    for (const p of list) {
      if (!ROOTS.some((r) => p.startsWith(`${r}/`))) continue;
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    if (!dirs.has(cur)) cur = 'assets';
    render();
  }

  const childDirs = (d) => [...dirs].filter((x) => x.startsWith(`${d}/`) && !x.slice(d.length + 1).includes('/')).sort();
  const countIn = (d) => files.filter((p) => p.startsWith(`${d}/`)).length;

  function renderFolders() {
    const out = [];
    (function walk(d, depth) {
      const kids = childDirs(d);
      const isOpen = openDirs.has(d) || cur.startsWith(`${d}/`);
      out.push(`<div class="fd${d === cur ? ' sel' : ''}" data-d="${esc(d)}" style="padding-left:${8 + depth * 14}px">
        <span style="width:12px;color:var(--faint)">${kids.length ? icon('chevron', { size: 11, stroke: 1.8 }).replace('class="ic"', `class="ic" style="transform:rotate(${isOpen ? 90 : 0}deg)"`) : ''}</span>
        ${icon('folder', { size: 14, color: '#7c8aa5' })}<span>${esc(d.split('/').pop())}</span><span class="n">${countIn(d) || ''}</span></div>`);
      if (isOpen) for (const k of kids) walk(k, depth + 1);
    })('assets', 0);
    for (const r of ['audio', 'data']) if (dirs.has(r)) (function walk(d, depth) {
      const kids = childDirs(d);
      const isOpen = openDirs.has(d) || cur.startsWith(`${d}/`);
      out.push(`<div class="fd${d === cur ? ' sel' : ''}" data-d="${esc(d)}" style="padding-left:${8 + depth * 14}px">
        <span style="width:12px;color:var(--faint)">${kids.length ? icon('chevron', { size: 11, stroke: 1.8 }).replace('class="ic"', `class="ic" style="transform:rotate(${isOpen ? 90 : 0}deg)"`) : ''}</span>
        ${icon('folder', { size: 14, color: '#7c8aa5' })}<span>${esc(d.split('/').pop())}</span><span class="n">${countIn(d) || ''}</span></div>`);
      if (isOpen) for (const k of kids) walk(k, depth + 1);
    })(r, 0);
    folders.innerHTML = out.join('');
  }

  function renderCrumbs() {
    const parts = cur.split('/');
    crumbs.innerHTML = parts.map((p, i) => i === parts.length - 1
      ? `<span class="cur">${esc(p)}</span>`
      : `<button data-d="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button><span>/</span>`).join('');
  }

  function usedModels() {
    const s = new Set();
    for (const e of app.doc.entities ?? []) {
      if (e.model) s.add(e.model);
      if (e.props?.objeto) s.add(`assets/models/objects/${String(e.props.objeto).replace(/\.glb$/i, '')}.glb`);
    }
    return s;
  }

  function renderGrid() {
    const q = filter.value.trim().toLowerCase();
    const used = usedModels();
    let items;
    if (q) items = files.filter((p) => p.toLowerCase().includes(q)).map((p) => ({ p, file: true }));
    else items = [
      ...childDirs(cur).map((d) => ({ p: d, file: false })),
      ...files.filter((p) => p.startsWith(`${cur}/`) && !p.slice(cur.length + 1).includes('/')).map((p) => ({ p, file: true })),
    ];
    if (!items.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><b>${q ? 'Sin resultados' : 'Carpeta vacía'}</b>${q ? '' : 'Arrastrá archivos acá desde tu PC (.glb, imágenes, audio) o usá Importar.'}</div>`;
      return;
    }
    grid.innerHTML = items.map(({ p, file }) => {
      const name = p.split('/').pop();
      if (!file) return `<div class="card folder" data-d="${esc(p)}"><div class="th">${icon('folder', { size: 34, color: '#8b98b0', stroke: 1.1 })}</div><div class="nm">${esc(name)}</div></div>`;
      const t = TYPE(p);
      const thumb = t === 'image' ? `<img src="/${esc(p)}" alt="" loading="lazy">` : icon(TYPE_ICON[t], { size: 30, stroke: 1.1 });
      return `<div class="card${t === 'image' ? '' : ''}${used.has(p) ? ' used' : ''}${p === selected ? ' sel' : ''}" data-p="${esc(p)}" data-t="${t}" draggable="${t === 'model'}" title="${esc(p)}${used.has(p) ? ' · en uso en esta escena' : ''}">
        <div class="th${t === 'image' ? ' photo' : ''}">${thumb}</div><div class="nm">${esc(name.replace(/\.[^.]+$/, ''))}</div><div class="ty">${TYPE_LABEL[t]}</div></div>`;
    }).join('');
    // miniaturas 3D (de a una, en segundo plano)
    grid.querySelectorAll('.card[data-t="model"]').forEach((card) => {
      const p = card.dataset.p;
      const v = thumbs.get(p);
      const put = (url) => { if (url && card.isConnected) card.querySelector('.th').innerHTML = `<img src="${url}" alt="">`; };
      if (typeof v === 'string') put(v); else if (v !== null) thumbFor(p).then(put);
    });
  }

  function render() { renderFolders(); renderCrumbs(); renderGrid(); }

  function go(d) { cur = d; openDirs.add(d); filter.value = ''; render(); }
  folders.addEventListener('click', (e) => {
    const fd = e.target.closest('.fd'); if (!fd) return;
    const d = fd.dataset.d;
    if (e.target.closest('svg') && childDirs(d).length && d === cur) { openDirs.has(d) ? openDirs.delete(d) : openDirs.add(d); renderFolders(); return; }
    go(d);
  });
  crumbs.addEventListener('click', (e) => { const b = e.target.closest('button[data-d]'); if (b) go(b.dataset.d); });
  filter.addEventListener('input', renderGrid);
  grid.addEventListener('click', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    if (c.dataset.p) { selected = c.dataset.p; grid.querySelectorAll('.card.sel').forEach((x) => x.classList.remove('sel')); c.classList.add('sel'); app.status(`${c.dataset.p}`); }
  });
  let audio = null;
  grid.addEventListener('dblclick', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    if (c.dataset.d) return go(c.dataset.d);
    const p = c.dataset.p, t = c.dataset.t;
    if (t === 'model') app.addModel(p, app.viewport.centerPoint());
    else if (t === 'audio') { audio?.pause(); audio = new Audio(`/${p}`); audio.play().catch(() => {}); app.status(`▶ ${p.split('/').pop()}`); }
    else if (t === 'dialogue' || t === 'route') window.open('/__studio', '_blank', 'noopener');
    else if (t === 'image') window.open(`/${p}`, '_blank', 'noopener');
  });
  grid.addEventListener('dragstart', (e) => {
    const c = e.target.closest('.card[data-t="model"]'); if (!c) return;
    e.dataTransfer.setData('application/x-coronda-asset', c.dataset.p);
    e.dataTransfer.effectAllowed = 'copy';
    const img = c.querySelector('img'); if (img) e.dataTransfer.setDragImage(img, 40, 40);
  });

  // ---------- importar ----------
  async function importFiles(list, folder = cur) {
    const ok = [], bad = [];
    for (const f of list) {
      const t = TYPE(f.name);
      if (/\.blend\d?$/i.test(f.name)) { bad.push(`${f.name} (exportalo a .glb desde Blender)`); continue; }
      if (t === 'file' || t === 'data') { bad.push(f.name); continue; }
      const dir = ROOTS.includes(folder) || folder === 'assets/models' ? (IMPORT_DIR[t] ?? folder) : folder;
      const path = `${dir}/${f.name.replace(/[^\w.\- ]+/g, '_')}`;
      try { await app.api.write(path, f); ok.push(path); forgetThumb(path); } catch (err) { bad.push(`${f.name}: ${err.message}`); }
    }
    if (ok.length) {
      await app.refreshFiles();
      const dir = ok[0].slice(0, ok[0].lastIndexOf('/'));
      go(dir);
      selected = ok[ok.length - 1]; renderGrid();
      app.toast(`Importado: ${ok.map((p) => p.split('/').pop()).join(', ')}`);
    }
    if (bad.length) app.toast(`No se importó: ${bad.join(' · ')}`, true);
    return ok;
  }
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => { importFiles([...importInput.files]); importInput.value = ''; });
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  grid.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); grid.classList.add('dropzone'); } });
  grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove('dropzone'); });
  grid.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); grid.classList.remove('dropzone'); importFiles([...e.dataTransfer.files]); });

  return { setFiles, render, renderGrid, importFiles, forget: forgetThumb, get folder() { return cur; } };
}
