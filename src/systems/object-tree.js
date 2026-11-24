// Árbol de objetos del modo desarrollador (dev.html, tecla O): todos los objetos de la escena tal como vienen del
// .glb, con sus "códigos" (las Custom Properties de Blender: puerta, objeto, colision, npc_dialogo…).
//
// Los códigos se editan acá y se guardan en tiempo real EN BLENDER: el cambio viaja al addon "Coronda en vivo"
// (blender/coronda_vivo.py), que lo pone en el objeto, vuelve a exportar el .glb y el juego se actualiza solo.
// Así Blender sigue siendo el original: no hay una copia de los datos que se pise con la próxima exportación.
// (Para que quede también en el .blend, guardalo en Blender con Ctrl+S.)
import * as THREE from 'three';

// Códigos que entiende el juego (para sugerirlos al escribir). Ver el README de cada sistema.
const KNOWN = {
  puerta: 'Destino al apretar E: spawn_x, una escena o escena:spawn_x',
  puerta_texto: 'Texto del aviso (en vez de "Entrar")',
  puerta_modo: 'E (con tecla) o auto (al pasar)',
  puerta_radio: 'Distancia para que aparezca el aviso (m)',
  puerta_anim: 'Animación del personaje al abrir (vacío = ninguna)',
  puerta_anim_objeto: 'Animación de la puerta misma',
  puerta_espera: 'Segundos antes del fundido',
  teleport: 'Destino al pasar por encima',
  teleport_texto: 'Texto del aviso', teleport_modo: 'E o auto', teleport_radio: 'Distancia (m)',
  objeto: 'Objeto reutilizable: assets/models/objects/<nombre>.glb',
  colision: '1 = choca aunque no se llame col_; 0 = no choca',
  colision_forma: 'caja, cilindro o malla',
  colision_invisible: '1 = choca pero no se ve',
  npc_nombre: 'Nombre que aparece al hablar', npc_modelo: '.glb del NPC', npc_dialogo: 'Diálogo (data/dialogues/<id>.json)',
  npc_texto: 'Texto simple, sin diálogo', npc_texto_repetir: 'Lo que dice la segunda vez', npc_ruta: 'Recorrido (data/routes/<id>.json)',
  npc_anim: 'Animación quieto', npc_anim_hablar: 'Animación al hablar', npc_escala: 'Tamaño', npc_giro: 'Giro (grados)',
  npc_mirar: '1 = te mira al hablar', npc_radio: 'Radio para chocar (m)', npc_hablar_radio: 'Distancia para hablar (m)',
  npc_hablar_texto: 'Texto del aviso (en vez de "Hablar")', npc_pone: 'Pose',
};
const HIDE_KEYS = /^(name|isRoomRoot|animations|sourceFile|roomId|objectFile|objectPlaced|__|baseColor)/;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const blenderName = (o) => o.userData?.name ?? o.name; // el nombre de Blender (three.js saca puntos y espacios)
const codesOf = (o) => Object.entries(o.userData ?? {}).filter(([k, v]) => !HIDE_KEYS.test(k) && (typeof v !== 'object' || v === null));
// Texto -> valor: números y true/false como tales; lo demás, texto
function parseValue(t) {
  const s = String(t).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  return s;
}

export function createObjectTree({ scene, camera, controls, setStatus }) {
  let root = null, selected = null, filter = '', open = false;
  const collapsed = new Set();
  const box = new THREE.BoxHelper(undefined, 0xffd400);
  box.visible = false; box.material.depthTest = false; box.renderOrder = 999; box.name = 'tree-highlight';
  scene.add(box);

  // ---- botón y panel ----
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'inspect-toggle tree-toggle'; btn.id = 'treeToggle';
  btn.setAttribute('aria-pressed', 'false');
  btn.textContent = 'Objetos (O)';
  const panel = document.createElement('aside');
  panel.className = 'otree'; panel.hidden = true; panel.setAttribute('aria-label', 'Árbol de objetos');
  panel.innerHTML = `<div class="ot-head"><b>Objetos</b><span class="ot-link" title="Los códigos se guardan en Blender (addon Coronda en vivo)"></span></div>
    <input class="ot-search" type="search" placeholder="Buscar por nombre o código" spellcheck="false">
    <div class="ot-list" role="tree"></div><div class="ot-edit"></div>
    <datalist id="otKeys">${Object.entries(KNOWN).map(([k, d]) => `<option value="${k}">${esc(d)}</option>`).join('')}</datalist>`;
  const app = document.querySelector('.app') ?? document.body;
  app.append(btn, panel);
  const list = panel.querySelector('.ot-list'), edit = panel.querySelector('.ot-edit'), link = panel.querySelector('.ot-link');
  // lo que se escribe en el panel no mueve la cámara ni dispara atajos del juego
  panel.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') e.target.blur?.(); });
  panel.addEventListener('keyup', (e) => e.stopPropagation());

  function place() { // a la derecha del último botón de arriba
    const prev = document.getElementById('spawnToggle') ?? document.getElementById('collisionToggle') ?? document.getElementById('inspectToggle');
    if (!prev) return;
    const pr = btn.parentElement.getBoundingClientRect();
    btn.style.left = `${Math.round(prev.getBoundingClientRect().right - pr.left + 8)}px`;
  }
  function toggle(v = !open) {
    open = v; panel.hidden = !open; btn.setAttribute('aria-pressed', String(open));
    btn.textContent = open ? 'Objetos: abierto (O)' : 'Objetos (O)';
    if (open) render(); else { box.visible = false; }
    place();
  }
  btn.addEventListener('click', () => toggle());
  addEventListener('keydown', (e) => { if (e.code === 'KeyO' && !e.repeat && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) toggle(); });
  addEventListener('resize', place);
  setTimeout(place, 0);

  // ---- árbol ----
  const skip = (o) => o.isBone || o === box || /^(door-helpers|spawn-debug|collision-debug|studio:)/.test(o.name) || o.userData?.debugHelper;
  function rows() {
    const out = [];
    const q = filter.trim().toLowerCase();
    const matches = (o) => !q || blenderName(o).toLowerCase().includes(q) || codesOf(o).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(q));
    const visit = (o, depth) => {
      if (skip(o)) return false;
      const kids = o.children.filter((c) => !skip(c));
      const start = out.length;
      out.push({ o, depth, kids: kids.length });
      let any = false;
      if (!collapsed.has(o.uuid) || q) for (const c of kids) any = visit(c, depth + 1) || any;
      if (q && !matches(o) && !any) { out.length = start; return false; }
      return true;
    };
    for (const r of root?.children.filter((c) => c.userData?.isRoomRoot) ?? []) {
      for (const c of r.children) visit(c, 0);
    }
    return out;
  }
  function icon(o) {
    if (o.userData?.objeto) return '◈';
    if (/^col_/i.test(o.name)) return '▦';
    if (/^npc_/i.test(o.name)) return '☺';
    if (/^spawn/i.test(o.name)) return '⚑';
    if (o.isMesh || o.getObjectByProperty('isMesh', true)) return '■';
    return '✛';
  }
  function render() {
    if (!open) return;
    const rs = rows();
    list.innerHTML = rs.length ? rs.map(({ o, depth, kids }) => {
      const codes = codesOf(o);
      return `<div class="ot-row${o === selected ? ' on' : ''}" role="treeitem" data-id="${o.uuid}" style="--d:${depth}">
        <span class="ot-tw">${kids ? (collapsed.has(o.uuid) && !filter ? '▸' : '▾') : ''}</span><span class="ot-ic">${icon(o)}</span>
        <span class="ot-name">${esc(blenderName(o))}</span>${codes.length ? `<span class="ot-n" title="${esc(codes.map(([k, v]) => `${k} = ${v}`).join('\n'))}">${codes.length}</span>` : ''}</div>`;
    }).join('') : `<p class="ot-empty">${filter ? 'Nada coincide.' : 'La escena todavía no cargó.'}</p>`;
    renderEdit();
  }
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.ot-row'); if (!row) return;
    const o = root?.getObjectByProperty('uuid', row.dataset.id); if (!o) return;
    if (e.target.closest('.ot-tw') && o.children.length) { collapsed.has(o.uuid) ? collapsed.delete(o.uuid) : collapsed.add(o.uuid); render(); return; }
    select(o);
  });
  list.addEventListener('dblclick', (e) => { const row = e.target.closest('.ot-row'); if (row) goTo(root?.getObjectByProperty('uuid', row.dataset.id)); });
  panel.querySelector('.ot-search').addEventListener('input', (e) => { filter = e.target.value; render(); });

  function select(o) {
    selected = o;
    box.visible = !!o;
    if (o) { box.setFromObject(o); }
    render();
    if (o) send({ cmd: 'select', object: blenderName(o) }, true); // en Blender también queda elegido
  }
  // La cámara libre se acerca a mirar el objeto (doble clic o botón Ir)
  function goTo(o) {
    if (!o) return;
    const b = new THREE.Box3().setFromObject(o);
    const c = b.isEmpty() ? o.getWorldPosition(new THREE.Vector3()) : b.getCenter(new THREE.Vector3());
    const size = b.isEmpty() ? 2 : Math.max(2, b.getSize(new THREE.Vector3()).length());
    const yaw = controls.getYaw();
    camera.position.set(c.x + Math.sin(yaw) * size, c.y + size * 0.45, c.z + Math.cos(yaw) * size);
    controls.setLook(yaw, -0.35);
  }

  // ---- códigos del objeto elegido ----
  let pending = null; // { object, key } esperando que Blender lo exporte
  function renderEdit() {
    const o = selected;
    if (!o) { edit.innerHTML = '<p class="ot-hint">Elegí un objeto para ver y cambiar sus códigos. Doble clic: ir a verlo.</p>'; return; }
    const codes = codesOf(o);
    edit.innerHTML = `<div class="ot-eh"><b>${esc(blenderName(o))}</b><button type="button" class="ot-btn" data-a="go">Ir</button></div>
      ${codes.map(([k, v]) => `<div class="ot-code" data-k="${esc(k)}"><label title="${esc(KNOWN[k] ?? '')}">${esc(k)}</label>
        <input value="${esc(v)}" spellcheck="false" aria-label="${esc(k)}"><button type="button" class="ot-x" data-a="del" title="Borrar este código">×</button></div>`).join('')}
      <form class="ot-add"><input name="k" list="otKeys" placeholder="código nuevo" spellcheck="false" aria-label="Nombre del código"><input name="v" placeholder="valor" spellcheck="false" aria-label="Valor"><button type="submit" class="ot-btn">+</button></form>
      <p class="ot-hint ot-msg">${pending ? 'Guardando en Blender…' : 'Enter guarda. Se guarda en Blender y se ve al instante.'}</p>`;
  }
  edit.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'go') goTo(selected);
    if (a === 'del') { const k = e.target.closest('.ot-code').dataset.k; setCode(k, null); }
  });
  edit.addEventListener('change', (e) => {
    const row = e.target.closest('.ot-code'); if (!row) return;
    setCode(row.dataset.k, parseValue(e.target.value));
  });
  edit.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('.ot-code')) e.target.blur(); });
  edit.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, k = f.k.value.trim();
    if (!/^[A-Za-z_][\w]*$/.test(k)) { msg('El nombre del código va sin espacios ni acentos (ej. puerta_texto)', true); return; }
    setCode(k, parseValue(f.v.value));
  });
  function msg(t, err = false) { const m = edit.querySelector('.ot-msg'); if (m) { m.textContent = t; m.classList.toggle('err', err); } }

  async function setCode(key, value) {
    if (!selected) return;
    const object = blenderName(selected);
    // se ve enseguida en el panel; el mundo se arma de nuevo cuando Blender exporta
    if (value === null) delete selected.userData[key]; else selected.userData[key] = value;
    pending = { object, key };
    renderEdit();
    const r = await send({ cmd: 'setprop', object, key, value });
    if (!r.ok) { pending = null; msg(r.text, true); return; }
    setTimeout(() => { if (pending?.key === key) { pending = null; msg('Blender todavía no respondió: ¿está abierto con "Coronda en vivo"?', true); } }, 6000);
  }
  async function send(body, quiet = false) {
    try {
      const res = await fetch('/__blender', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const text = await res.text();
      if (res.ok) return { ok: true };
      return { ok: false, text: res.status === 409 ? 'Blender no está conectado: abrí el .blend con el addon "Coronda en vivo".' : text };
    } catch {
      return { ok: false, text: quiet ? '' : 'Sin servidor: abrí el juego con node studio/server.js (o "Abrir Coronda" en Blender).' };
    }
  }
  async function blenderState() {
    try { const r = await fetch('/__blender/estado'); const j = await r.json(); link.textContent = j.blender ? '● Blender conectado' : '○ Blender sin conectar'; link.classList.toggle('on', !!j.blender); }
    catch { link.textContent = ''; }
  }
  setInterval(() => { if (open) blenderState(); }, 2000);

  return {
    toggle,
    // La escena se armó (o se volvió a armar después de exportar): se recuerda qué objeto estaba elegido
    setRoot(r) {
      root = r;
      const name = selected ? blenderName(selected) : null;
      selected = null; box.visible = false;
      if (name && root) {
        let found = null;
        root.traverse((o) => { if (!found && blenderName(o) === name && !skip(o)) found = o; });
        if (found) { selected = found; box.setFromObject(found); box.visible = open; }
      }
      if (pending) { pending = null; setStatus?.('Código guardado en Blender'); }
      render();
    },
    update() { if (box.visible && selected) box.setFromObject(selected); },
  };
}
