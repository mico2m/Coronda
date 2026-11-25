// Menú de inicio (solo index.html): elegir personaje, entrar con tu cuenta (o crear una) y jugar en el servidor.
//   - Personajes: el de siempre (data/tables/player.json) y TODOS los NPC del juego: se buscan solos en los
//     .glb de todas las escenas (Empties npc_…, con su npc_modelo / npc_nombre / npc_escala / npc_giro / npc_anim)
//     y en los "actors" de cada escena. No hay que anotarlos en ningún lado.
//   - Cuenta: nombre + contraseña. Cada jugador tiene su id en el servidor: su nombre, mochila, casa y progreso son
//     suyos y nadie más puede usarlos (el nombre no se puede repetir). La sesión queda abierta en este navegador
//     (solo un token: el servidor lo verifica) hasta que toques "Cambiar de cuenta".
//   - Si el servidor está apagado, se avisa y no se puede entrar (ver src/net/servidor.js).
// Devuelve una promesa con { online: true, net, name, character: { id, name, model, scale, yawOffset, idle } }.
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
          <p class="sm-server"><i class="sm-dot"></i><span class="sm-count-text">Buscando el servidor…</span></p>
          <div class="sm-cuenta" hidden>
            <p class="sm-yo">Entraste como <b class="sm-yo-n"></b></p>
            <button type="button" class="sm-link sm-cambiar">Cambiar de cuenta</button>
          </div>
          <form class="sm-login" hidden autocomplete="on">
            <div class="sm-tabs" role="tablist">
              <button type="button" role="tab" class="sm-tab" data-modo="login" aria-selected="true">Entrar</button>
              <button type="button" role="tab" class="sm-tab" data-modo="registro" aria-selected="false">Crear cuenta</button>
            </div>
            <label class="sm-field">Nombre
              <input class="sm-input sm-nombre" name="username" maxlength="20" autocomplete="username" spellcheck="false" required>
            </label>
            <label class="sm-field">Contraseña
              <input class="sm-input sm-clave" name="password" type="password" maxlength="72" autocomplete="current-password" required>
            </label>
            <label class="sm-field sm-repetir" hidden>Repetí la contraseña
              <input class="sm-input sm-clave2" type="password" maxlength="72" autocomplete="new-password">
            </label>
            <p class="sm-hint sm-hint-reg" hidden>3 a 20 letras o números. El nombre es tuyo para siempre: nadie más puede usarlo. La contraseña, de 6 letras o más.</p>
          </form>
          <p class="sm-err" aria-live="assertive"></p>
          <button type="button" class="sm-btn sm-primary sm-go" disabled>Entrar al mundo</button>
          <p class="sm-note">Ves a los demás jugadores y ellos te ven a vos, con el personaje que elijas. Tu mochila, tu casa y tu progreso se guardan en el servidor.</p>
        </div>
      </div>
    </div>`;
  document.body.append(el);

  const $ = (q) => el.querySelector(q);
  const listEl = $('.sm-list');
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

  const errEl = $('.sm-err'), go = $('.sm-go'), form = $('.sm-login'), cuentaEl = $('.sm-cuenta');
  const nombreIn = $('.sm-nombre'), claveIn = $('.sm-clave'), clave2In = $('.sm-clave2');
  nombreIn.value = saved.name ?? '';
  let modo = 'login', net = null, sesion = null, busy = false;
  function setModo(m) {
    modo = m;
    el.querySelectorAll('.sm-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.modo === m)));
    $('.sm-repetir').hidden = m !== 'registro';
    $('.sm-hint-reg').hidden = m !== 'registro';
    claveIn.autocomplete = m === 'registro' ? 'new-password' : 'current-password';
    go.textContent = m === 'registro' ? 'Crear cuenta y entrar' : 'Entrar al mundo';
    errEl.textContent = '';
  }
  el.querySelectorAll('.sm-tab').forEach((b) => { b.onclick = () => setModo(b.dataset.modo); });
  function mostrarSesion(s) {
    sesion = s;
    cuentaEl.hidden = !s; form.hidden = !!s;
    if (s) { $('.sm-yo-n').textContent = s.nombre; go.textContent = 'Entrar al mundo'; }
    else setModo(modo);
  }
  $('.sm-cambiar').onclick = () => { net?.salirCuenta(); location.reload(); };

  // Servidor: cuántos juegan; si hay una sesión guardada, se usa sola
  const countText = $('.sm-count-text'), dot = $('.sm-dot');
  const setCount = (n) => { countText.textContent = `Servidor encendido · ${n === 1 ? '1 jugando' : `${n} jugando`}`; dot.classList.add('on'); };
  connect().then(async (n) => {
    net = n;
    setCount(n.count);
    n.onCount = (c) => { if (el.isConnected) setCount(c); };
    if (!n.registroAbierto) { el.querySelector('[data-modo="registro"]').hidden = true; }
    if (n.tokenGuardado()) {
      countText.textContent = 'Recuperando tu sesión…';
      const r = await n.conToken();
      setCount(n.count);
      if (r.ok) mostrarSesion({ nombre: r.nombre }); else mostrarSesion(null);
    } else mostrarSesion(null);
    go.disabled = false;
  }).catch(() => {
    countText.textContent = 'El servidor está apagado. Probá más tarde.';
    dot.classList.add('off');
    errEl.textContent = 'No se puede jugar mientras el servidor esté apagado.';
    go.disabled = true;
    setTimeout(() => location.reload(), 30000); // vuelve a probar solo
  });

  return new Promise((resolve) => {
    const keyNav = (e) => {
      if (e.target?.tagName === 'INPUT') { if (e.key === 'Enter') { e.preventDefault(); entrar(); } else errEl.textContent = ''; return; }
      if (e.target?.tagName === 'BUTTON' && e.key === 'Enter') return;
      if (e.key === 'ArrowLeft') select(index - 1);
      else if (e.key === 'ArrowRight') select(index + 1);
      else if (e.key === 'Enter') entrar();
    };
    addEventListener('keydown', keyNav);
    form.addEventListener('submit', (e) => { e.preventDefault(); entrar(); });
    async function entrar() {
      if (busy || !net || go.disabled) return;
      const character = characters[index];
      if (!sesion) {
        const nombre = nombreIn.value.trim().replace(/\s+/g, ' '), clave = claveIn.value;
        if (nombre.length < 3) { errEl.textContent = 'Escribí tu nombre (3 letras o más).'; nombreIn.focus(); return; }
        if (clave.length < 6) { errEl.textContent = 'La contraseña tiene que tener 6 letras o más.'; claveIn.focus(); return; }
        if (modo === 'registro' && clave !== clave2In.value) { errEl.textContent = 'Las dos contraseñas no son iguales.'; clave2In.focus(); return; }
        busy = true; go.disabled = true;
        errEl.textContent = modo === 'registro' ? 'Creando tu cuenta…' : 'Entrando…';
        const r = modo === 'registro' ? await net.registrar(nombre, clave) : await net.entrar(nombre, clave);
        busy = false; go.disabled = false;
        if (!r.ok) { errEl.textContent = r.error || 'No se pudo entrar.'; (r.ocupado ? nombreIn : claveIn).focus(); if (r.ocupado) nombreIn.select(); return; }
        sesion = { nombre: r.nombre };
        claveIn.value = ''; clave2In.value = '';
      }
      errEl.textContent = '';
      try { localStorage.setItem(STORE, JSON.stringify({ model: character.model, name: sesion.nombre })); } catch { /* nada */ }
      removeEventListener('keydown', keyNav);
      preview.dispose();
      el.classList.add('sm-out');
      setTimeout(() => el.remove(), 300);
      resolve({ online: true, net, name: sesion.nombre, character });
    }
    go.onclick = entrar;
  });
}
