// Panel de NPC (solo dev.html, botón "NPC" arriba a la izquierda).
// Elegís un NPC de la escena, ves todos los clips de su .glb (con el tipo que detectó el motor),
// los probás con ▶ y marcás con un clic cuál es el idle (★) y cuál se usa al hablar (💬).
// Los cambios se ven al instante y se guardan por modelo en data/tables/npcs.json
// (en Chrome/Edge escribe directo en la carpeta; en otros navegadores descarga el archivo).
//
// Qué cambia cada botón:
//   ★ Idle   -> todos los NPC que usan ese .glb (salvo los que tienen npc_anim propio, que mandan).
//   💬 Hablar -> lo mismo para la animación durante una charla (solo NPC con diálogo, salvo npc_anim_hablar propio).
import { loadJSON, forgetJSON } from '../core/assets.js';

const TABLE_URL = 'data/tables/npcs.json';
const hasDirPicker = () => typeof window.showDirectoryPicker === 'function';
const KIND_LABEL = { idle: 'idle', talk: 'habla', greet: 'saludo', walk: 'camina', run: 'corre', junk: 'basura', other: 'otro' };

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

export function createNpcEditor({ npcs, camera, controls, host = document.querySelector('.app') ?? document.body } = {}) {
  if (!npcs) return null;
  let table = {};          // contenido de npcs.json (se edita en memoria hasta Guardar)
  let dirty = false;
  let dirHandle = null;
  let selected = null;     // entrada de npcs.list
  let listRef = null;      // para notar que cambió la escena
  let timer = null;
  let previewing = null;   // nombre del clip que se está probando

  // ---------- Estructura ----------
  const toggle = el('button', 'ne-toggle', host, 'NPC');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');

  const root = el('aside', 'ne', host);
  root.hidden = true;
  root.setAttribute('aria-label', 'Editor de NPC');
  // El panel tapa parte del juego: que sus teclas y clics no lleguen a la cámara
  for (const t of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu']) root.addEventListener(t, (e) => e.stopPropagation());

  const head = el('div', 'ne-head', root);
  el('strong', 'ne-title', head, 'NPC');
  const sel = el('select', 'ne-sel', head);
  sel.title = 'NPC de la escena';
  const bGo = el('button', 'ne-btn', head, 'Ir'); bGo.type = 'button'; bGo.title = 'Lleva la cámara libre frente al NPC';
  const bRef = el('button', 'ne-btn', head, '↻'); bRef.type = 'button'; bRef.title = 'Actualizar la lista (después de cambiar de escena)';

  const info = el('div', 'ne-info', root);
  const body = el('div', 'ne-body', root);
  const foot = el('div', 'ne-foot', root);
  const bDir = el('button', 'ne-btn', foot, 'Carpeta'); bDir.type = 'button'; bDir.title = 'Elegí la carpeta data/tables de tu proyecto (Chrome / Edge)';
  const bSave = el('button', 'ne-btn ne-primary', foot, 'Guardar'); bSave.type = 'button'; bSave.title = 'Guarda data/tables/npcs.json';
  const status = el('span', 'ne-status', foot);
  const setStatus = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

  // ---------- Datos ----------
  async function loadTable() {
    forgetJSON(TABLE_URL);
    try { table = structuredClone(await loadJSON(TABLE_URL)); } catch { table = {}; }
    dirty = false;
  }
  const roleOf = (key, role) => String(table[key]?.[role] ?? '');
  function setRole(key, role, name) {
    if (!table[key] || typeof table[key] !== 'object') table[key] = {};
    if (name) table[key][role] = name; else delete table[key][role];
    if (!Object.keys(table[key]).length) delete table[key];
    dirty = true;
    const n = npcs.setModelRole(key, role, name);
    setStatus(`${role === 'idle' ? 'Idle' : 'Hablar'} de "${key}": ${name || '(automático)'} — ${n} NPC. Falta Guardar.`);
    bSave.classList.toggle('dirty', dirty);
  }

  // ---------- Dibujo ----------
  function refreshSelect() {
    listRef = npcs.list;
    const keep = selected && npcs.list.includes(selected) ? selected : null;
    sel.replaceChildren();
    npcs.list.forEach((n, i) => sel.append(new Option(`${n.id}${npcs.list.filter((o) => o.id === n.id).length > 1 ? ` #${i + 1}` : ''}${n.path ? ` · ${String(n.path).split('/').pop()}` : ''}`, String(i))));
    selected = keep ?? npcs.list[0] ?? null;
    if (selected) sel.value = String(npcs.list.indexOf(selected));
    draw();
  }

  function draw() {
    stopPreview(false);
    info.replaceChildren();
    body.replaceChildren();
    if (!selected) { el('p', 'ne-empty', body, 'No hay NPC en esta escena (empties npc_… en el .glb o "actors" en el JSON).'); bGo.disabled = true; return; }
    bGo.disabled = false;
    const n = selected;
    const idleSrc = { npc: 'definido en este NPC (npc_anim / JSON): pisa la tabla', modelo: 'definido para el modelo', auto: 'detectado solo' }[n.idleSource] ?? '';
    const l1 = el('div', 'ne-line', info); el('span', 'ne-k', l1, 'Modelo'); el('code', '', l1, n.path ? String(n.path).split('/').pop() : n.modelKey); if (n.path) l1.title = n.path; // el archivo .glb, al lado
    if (n.objeto) { const l2 = el('div', 'ne-line', info); el('span', 'ne-k', l2, 'Objeto'); el('code', '', l2, n.objeto); el('span', '', l2, n.objetoGlb ? ` · en ${String(n.objetoGlb).split('/').pop()}` : ' · del JSON'); }
    const l2 = el('div', 'ne-line', info); el('span', 'ne-k', l2, 'Idle'); el('b', '', l2, n.idleName ?? '(ninguno)'); el('span', 'ne-muted', l2, n.idleName ? ` · ${idleSrc}` : '');
    const l3 = el('div', 'ne-line', info); el('span', 'ne-k', l3, 'Hablar'); el('b', '', l3, n.talk ? (n.talk.talkAnim ?? '(sigue en idle)') : '(sin diálogo)');

    const clips = npcs.clipsOf(n);
    if (!clips.length) { el('p', 'ne-empty', body, 'El .glb no trae animaciones (exportá con Animation > Actions).'); return; }
    for (const c of clips) {
      const row = el('div', `ne-row${c.isIdle ? ' is-idle' : ''}${c.kind === 'junk' ? ' is-junk' : ''}`, body);
      const play = el('button', 'ne-mini', row, '▶'); play.type = 'button'; play.title = 'Probar'; play.dataset.clip = c.name;
      play.addEventListener('click', () => togglePreview(c.name, play));
      const nm = el('div', 'ne-name', row);
      el('span', 'ne-clip', nm, c.name);
      const meta = el('span', 'ne-meta', nm, `${KIND_LABEL[c.kind] ?? c.kind} · ${c.duration}s${c.once ? ' · una vez' : ''}`);
      meta.dataset.kind = c.kind;
      const star = el('button', `ne-mini${c.isIdle ? ' on' : ''}`, row, '★'); star.type = 'button';
      star.title = c.isIdle ? 'Es el idle (clic: volver a detectarlo solo)' : 'Usar como idle (todos los NPC con este modelo)';
      star.addEventListener('click', () => { setRole(n.modelKey, 'idle', c.isIdle ? '' : c.name); draw(); });
      const talkOn = !!n.talk && n.talk.talkAnim === c.name;
      const talk = el('button', `ne-mini${talkOn ? ' on' : ''}`, row, '💬'); talk.type = 'button';
      talk.disabled = !n.talk;
      talk.title = !n.talk ? 'Este NPC no tiene diálogo' : talkOn ? 'Es la animación de hablar (clic: quitarla)' : 'Usar al hablar (todos los NPC con este modelo y diálogo)';
      talk.addEventListener('click', () => { setRole(n.modelKey, 'talk', talkOn ? '' : c.name); draw(); });
    }
    if (n.idleSource === 'npc') el('p', 'ne-note', body, 'Este NPC tiene su idle fijado con npc_anim o "animation" en la escena: ★ no lo cambia. Quitá ese valor para que mande la tabla.');
  }

  // ---------- Probar clips ----------
  function togglePreview(name, btn) {
    if (!selected) return;
    if (previewing === name) { stopPreview(true); return; }
    stopPreview(false);
    npcs.play(selected, name);
    previewing = name;
    btn.textContent = '■';
    btn.classList.add('on');
  }
  function stopPreview(restore) {
    if (previewing && restore && selected) npcs.play(selected, null);
    previewing = null;
    body.querySelectorAll?.('[data-clip]').forEach((b) => { b.textContent = '▶'; b.classList.remove('on'); });
  }

  // ---------- Guardar ----------
  const serialize = () => `${JSON.stringify(table, null, 2)}\n`;
  async function pickDir() {
    if (!hasDirPicker()) { setStatus('Este navegador no abre carpetas: Guardar descarga npcs.json para copiarlo a data/tables (Chrome o Edge sí pueden).', true); return; }
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'coronda-tablas', mode: 'readwrite', startIn: dirHandle ?? 'documents' });
      setStatus(`Carpeta: ${dirHandle.name}`);
    } catch (err) { if (err.name !== 'AbortError') setStatus(`Carpeta: ${err.message}`, true); }
  }
  async function save() {
    const text = serialize();
    try {
      if (dirHandle) {
        const fh = await dirHandle.getFileHandle('npcs.json', { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        forgetJSON(TABLE_URL); // la próxima escena que cargues lee la versión nueva
        setStatus(`Guardado en ${dirHandle.name}/npcs.json`);
      } else {
        const a = el('a', '', null);
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        a.download = 'npcs.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        setStatus('Descargado npcs.json: copialo a data/tables/ (o usá Carpeta para guardar directo).');
      }
      dirty = false;
      bSave.classList.remove('dirty');
    } catch (err) { setStatus(`No se pudo guardar: ${err.message}`, true); }
  }

  // ---------- Eventos ----------
  sel.addEventListener('change', () => { selected = npcs.list[Number(sel.value)] ?? null; draw(); });
  bRef.addEventListener('click', refreshSelect);
  bDir.addEventListener('click', pickDir);
  bSave.addEventListener('click', save);
  bGo.addEventListener('click', () => {
    if (!selected || !camera) return;
    // Frente al NPC: hacia donde mira (su rotación en Y), a 3 m y a la altura de la cabeza
    const r = selected.holder.rotation.y, p = selected.holder.position;
    camera.position.set(p.x + Math.sin(r) * 3, p.y + 1.4, p.z + Math.cos(r) * 3);
    controls?.setLook(r, -0.1); // la cámara mira hacia -Z cuando yaw = 0: con yaw = r queda de frente al NPC
  });
  root.addEventListener('keydown', (e) => {
    if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });

  toggle.addEventListener('click', async () => {
    const open = root.hidden;
    root.hidden = !open;
    toggle.setAttribute('aria-pressed', String(open));
    if (open) {
      await loadTable();
      refreshSelect();
      setStatus(dirHandle ? `Carpeta: ${dirHandle.name}` : 'Elegí Carpeta (data/tables) para guardar directo.');
      timer = setInterval(() => { if (npcs.list !== listRef) refreshSelect(); }, 1000); // cambió la escena
    } else {
      stopPreview(true);
      clearInterval(timer);
    }
  });

  return { open: () => toggle.click(), refresh: refreshSelect };
}
