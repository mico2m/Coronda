// Menú de inicio (solo index.html): elegir personaje y entrar solo o al servidor.
//   - Personajes: el de siempre (data/tables/player.json) y TODOS los NPC del juego: se buscan solos en los
//     .glb de todas las escenas (Empties npc_…, con su npc_modelo / npc_nombre / npc_escala / npc_giro / npc_anim)
//     y en los "actors" de cada escena. No hay que anotarlos en ningún lado.
//   - "Jugar en el servidor" muestra cuántas personas están jugando (ver src/net/multiplayer.js).
// Devuelve una promesa con { online, name, character: { id, name, model, scale, yawOffset, idle } }.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLB, loadJSON } from '../core/assets.js';
import { makeUnlit } from '../systems/shading.js';

const DIR = 'assets/models/objects/';
const STORE = 'coronda.menu';
const NPC_RE = /^npc_(.+?)(?:\.\d+)?$/i;

const humanize = (id) => { const t = String(id).replace(/^npc_/i, '').replace(/[_-]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Lee solo el JSON de un .glb (los nodos y sus Custom Properties), sin armar la escena
async function glbNodes(url) {
  const res = await fetch(url);
  if (!res.ok) return [];
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) return []; // "glTF"
  const len = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
  return json.nodes ?? [];
}

async function exists(url) {
  try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch { return false; }
}

// "villager1" -> assets/models/objects/villager1.glb (o npc_villager1.glb si es ese el que existe)
async function resolveModel(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/[\\/]/.test(s)) return (await exists(s)) ? s : null;
  const base = s.replace(/\.glb$/i, '');
  for (const name of [base, /^npc_/i.test(base) ? null : `npc_${base}`]) {
    if (name && await exists(`${DIR}${name}.glb`)) return `${DIR}${name}.glb`;
  }
  return null;
}

export async function findCharacters(playerConfig) {
  const list = [{ id: 'personaje', name: 'Personaje', model: playerConfig.model ?? `${DIR}personaje.glb`, scale: playerConfig.scale ?? 1, yawOffset: playerConfig.yawOffset ?? 0, idle: null, tag: 'Protagonista' }];
  const found = new Map(); // modelo -> personaje
  const add = async (raw) => {
    const model = await resolveModel(raw.model);
    if (!model || model === list[0].model || found.has(model)) return;
    found.set(model, { id: raw.id, name: raw.name || humanize(raw.id), model, scale: Number(raw.scale) || 1, yawOffset: Number(raw.yawOffset) || 0, idle: raw.idle || null, tag: 'NPC' });
  };
  try {
    const scenes = await loadJSON('data/tables/scenes.json');
    const jobs = [];
    for (const entry of Object.values(scenes)) {
      if (!entry?.file) continue;
      jobs.push((async () => {
        const data = await loadJSON(entry.file).catch(() => null);
        if (!data) return;
        const raws = [];
        for (const room of data.rooms ?? []) {
          if (!room.model) continue;
          for (const n of await glbNodes(room.model).catch(() => [])) {
            const m = NPC_RE.exec(n.name ?? '');
            if (!m) continue;
            const u = n.extras ?? {};
            raws.push({ id: m[1].toLowerCase(), model: u.npc_modelo || m[1], name: u.npc_nombre, scale: u.npc_escala, yawOffset: u.npc_giro, idle: u.npc_anim });
          }
        }
        for (const a of data.actors ?? []) {
          if (a.model) raws.push({ id: a.id ?? a.model, model: a.model, name: a.name, scale: a.scale, yawOffset: a.yawOffset, idle: a.animation });
        }
        for (const r of raws) await add(r);
      })());
    }
    await Promise.all(jobs);
  } catch (err) { console.warn('Menú: no se pudieron buscar los NPC', err); }
  return [...list, ...[...found.values()].sort((a, b) => a.name.localeCompare(b.name))];
}

// Vista del personaje elegido, girando despacio
function createPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  const holder = new THREE.Group();
  scene.add(holder);
  const cache = new Map();
  let mixer = null, token = 0, raf = 0, last = performance.now(), alive = true;

  function size() {
    const w = canvas.clientWidth || 260, h = canvas.clientHeight || 320;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  async function show(ch) {
    const my = ++token;
    holder.clear(); mixer = null;
    if (!cache.has(ch.model)) cache.set(ch.model, loadGLB(ch.model, null, { pad: false }).then((g) => { makeUnlit(g.scene); return g; }).catch(() => null));
    const g = await cache.get(ch.model);
    if (my !== token || !alive) return;
    if (!g) return;
    const model = cloneSkinned(g.scene);
    model.scale.setScalar(ch.scale || 1);
    model.rotation.y = THREE.MathUtils.degToRad(ch.yawOffset || 0);
    holder.add(model);
    if (g.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      const clip = g.animations.find((c) => c.name === ch.idle) ?? g.animations.find((c) => /^idle/i.test(c.name)) ?? g.animations[0];
      mixer.clipAction(clip).play();
      mixer.update(0);
    }
    // Encuadre: la caja del modelo
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    const h = Math.max(0.5, box.max.y - box.min.y);
    const cy = box.min.y + h * 0.5;
    const dist = (h * 0.62) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.set(0, cy + h * 0.08, dist);
    camera.lookAt(0, cy, 0);
  }
  function loop(now) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    holder.rotation.y += dt * 0.6;
    mixer?.update(dt);
    renderer.render(scene, camera);
  }
  size();
  addEventListener('resize', size);
  raf = requestAnimationFrame(loop);
  return {
    show,
    dispose() { alive = false; cancelAnimationFrame(raf); removeEventListener('resize', size); renderer.dispose(); },
  };
}

export function showStartMenu({ characters, connect }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { saved = {}; }
  let index = Math.max(0, characters.findIndex((c) => c.model === saved.model));

  const el = document.createElement('div');
  el.className = 'start-menu';
  el.innerHTML = `
    <div class="sm-card" role="dialog" aria-labelledby="smTitle">
      <h1 id="smTitle" class="sm-title">Coronda</h1>
      <div class="sm-body">
        <div class="sm-pick">
          <canvas class="sm-preview" aria-hidden="true"></canvas>
          <div class="sm-nav">
            <button type="button" class="sm-arrow" data-d="-1" aria-label="Personaje anterior">‹</button>
            <div class="sm-who"><b class="sm-name"></b><span class="sm-tag"></span></div>
            <button type="button" class="sm-arrow" data-d="1" aria-label="Personaje siguiente">›</button>
          </div>
          <div class="sm-list" role="listbox" aria-label="Personajes"></div>
        </div>
        <div class="sm-actions">
          <label class="sm-field">Tu nombre
            <input class="sm-input" maxlength="20" autocomplete="off" spellcheck="false" placeholder="Viajero">
          </label>
          <button type="button" class="sm-btn sm-primary" data-go="solo">Entrar al mundo</button>
          <button type="button" class="sm-btn" data-go="online">
            <span>Jugar en el servidor</span>
            <span class="sm-count"><i class="sm-dot"></i><span class="sm-count-text">Conectando…</span></span>
          </button>
          <p class="sm-net" aria-live="polite"></p>
          <p class="sm-note">En el servidor ves a los demás jugadores y ellos te ven a vos, con el personaje que elijas.</p>
        </div>
      </div>
    </div>`;
  document.body.append(el);

  const $ = (s) => el.querySelector(s);
  const listEl = $('.sm-list');
  const nameIn = $('.sm-input');
  nameIn.value = saved.name ?? '';
  characters.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sm-chip';
    b.setAttribute('role', 'option');
    b.innerHTML = esc(c.name);
    b.onclick = () => select(i);
    listEl.append(b);
  });

  const preview = createPreview($('.sm-preview'));
  function select(i) {
    index = (i + characters.length) % characters.length;
    const c = characters[index];
    $('.sm-name').textContent = c.name;
    $('.sm-tag').textContent = c.tag;
    listEl.querySelectorAll('.sm-chip').forEach((b, k) => b.setAttribute('aria-selected', String(k === index)));
    preview.show(c);
  }
  el.querySelectorAll('.sm-arrow').forEach((b) => { b.onclick = () => select(index + Number(b.dataset.d)); });
  select(index);

  // Servidor: contar cuántos juegan (mientras el menú está abierto)
  let net = null;
  const countText = $('.sm-count-text');
  const dot = $('.sm-dot');
  const setCount = (n) => { countText.textContent = n === 1 ? '1 jugando' : `${n} jugando`; dot.classList.toggle('on', n > 0); };
  const netReady = connect().then((n) => {
    net = n;
    // Encontrar a los demás tarda unos segundos: hasta entonces "Buscando…" (salvo que ya aparezca alguien)
    let searching = true;
    setTimeout(() => { searching = false; setCount(n.count); }, 4000);
    countText.textContent = 'Buscando…';
    n.onCount = (c) => { if (!searching || c > 0) { searching = false; setCount(c); } };
    // Estado de la red (para saber si el problema es la conexión)
    const netEl = $('.sm-net');
    const tick = () => {
      if (!el.isConnected) return;
      const s = n.network;
      netEl.textContent = s.open ? `Red: ${s.open} de ${s.total} puntos de encuentro · ${s.peers} conectado(s) con vos` : 'Red: conectando a los puntos de encuentro…';
      setTimeout(tick, 1000);
    };
    tick();
    return n;
  }).catch((err) => {
    console.warn('Multijugador:', err);
    countText.textContent = 'Sin conexión';
    $('[data-go="online"]').disabled = true;
    return null;
  });

  return new Promise((resolve) => {
    const keyNav = (e) => {
      if (e.target === nameIn) { if (e.key === 'Enter') go('solo'); return; }
      if (e.target?.tagName === 'BUTTON' && e.key === 'Enter') return; // el botón ya hace lo suyo
      if (e.key === 'ArrowLeft') select(index - 1);
      else if (e.key === 'ArrowRight') select(index + 1);
      else if (e.key === 'Enter') go('solo');
    };
    addEventListener('keydown', keyNav);
    async function go(mode) {
      const name = nameIn.value.trim().slice(0, 20) || 'Viajero';
      const character = characters[index];
      try { localStorage.setItem(STORE, JSON.stringify({ model: character.model, name: nameIn.value.trim() })); } catch { /* nada */ }
      removeEventListener('keydown', keyNav);
      const online = mode === 'online';
      const n = online ? await netReady : null;
      if (!online) netReady.then((x) => x?.leave());
      preview.dispose();
      el.classList.add('sm-out');
      setTimeout(() => el.remove(), 300);
      resolve({ online: !!(online && n), net: online ? n : null, name, character });
    }
    el.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go); });
  });
}
