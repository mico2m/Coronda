// Espacio "Proyecto": escena inicial, el personaje (data/tables/player.json) y el idle de cada modelo de NPC (npcs.json)
import { listPane, fileDoc, esc, fieldRow, options, baseName } from './ws-common.js';
import { clipsOf } from './project-index.js';
import { icon } from './components.js';

const P = { scenes: 'data/tables/scenes.json', player: 'data/tables/player.json', npcs: 'data/tables/npcs.json' };
const SECTIONS = [
  { id: 'game', label: 'Juego', sub: 'Escena inicial y escenas', icon: 'flag', color: '#3d6df2' },
  { id: 'player', label: 'Personaje', sub: 'Modelo, velocidad, cámara, colisión', icon: 'user', color: '#1f9d61' },
  { id: 'anim', label: 'Animaciones', sub: 'Quieto, caminar, correr y acciones', icon: 'play', color: '#8b5cf6' },
  { id: 'npcs', label: 'NPC', sub: 'Animación de quieto por modelo', icon: 'user', color: '#e08a1e' },
];
const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, path, v) => { const ks = path.split('.'); let t = o; for (const k of ks.slice(0, -1)) t = t[k] ??= {}; if (v === '' || v === undefined) delete t[ks.at(-1)]; else t[ks.at(-1)] = v; };

export function createProjectWorkspace(app, el) {
  el.innerHTML = `<aside class="wsl"></aside><section class="wsc"><div class="wsbar"><b class="wst"></b><span class="wsu"></span></div><div class="wsbody"><div class="form"></div></div></section>`;
  const docs = {};
  let cur = 'game', playerClips = [];
  const order = [], redoOrder = []; // qué archivo cambió en cada paso (para deshacer en orden)
  const pane = listPane(el.querySelector('.wsl'), { title: 'Proyecto', onSelect: (id) => { cur = id; render(); } });
  const form = el.querySelector('.form');
  const json = (k) => { try { return JSON.parse(docs[k].text); } catch { return {}; } };
  const write = (k, fn) => { const d = json(k); fn(d); if (docs[k].set(`${JSON.stringify(d, null, 2)}\n`)) { order.push(k); redoOrder.length = 0; app.wsChanged(); render(); } };
  const models = () => app.files.filter((p) => /^assets\/models\/objects\/[^/]+\.glb$/i.test(p)).sort();
  const num = (k, path, label, unit = '', step = 'any', ph = '') => fieldRow(label, `<input type="number" step="${step}" data-f="${k}" data-p="${path}" value="${esc(get(json(k), path) ?? '')}" placeholder="${esc(ph)}">${unit ? `<span class="unit">${unit}</span>` : ''}`);
  const card = (title, body, help = '') => `<div class="fcard"><h3>${esc(title)}</h3>${help ? `<p class="help">${help}</p>` : ''}${body}</div>`;

  async function render() {
    pane.set(SECTIONS.map((s) => ({ ...s, dirty: false })), cur);
    el.querySelector('.wst').textContent = SECTIONS.find((s) => s.id === cur)?.label ?? '';
    el.querySelector('.wsu').textContent = Object.values(docs).some((d) => d.dirty) ? 'Sin guardar' : '';
    if (cur === 'game') {
      const sc = json('scenes');
      const start = Object.keys(sc).find((k) => sc[k].start) ?? Object.keys(sc)[0];
      form.innerHTML = card('Escena inicial', fieldRow('Arranca en', `<select data-act="start">${options(Object.keys(sc), start)}</select>`), 'Donde aparece el jugador al abrir el juego (después del título).')
        + card('Escenas del proyecto', `<div class="slist">${Object.entries(sc).map(([id, e]) => `<div class="srow">${icon('layers', { size: 14 })}<b>${esc(id)}</b><small>${esc(e.file)}</small>${id === start ? '<span class="chip">inicio</span>' : ''}<button class="linkbtn" data-open="${esc(id)}">Abrir</button></div>`).join('')}</div>`, 'Las escenas nuevas se crean con el + que está al lado del selector de escena.');
    } else if (cur === 'player') {
      form.innerHTML = card('Modelo', fieldRow('Archivo', `<select data-f="player" data-p="model">${options(models(), json('player').model)}</select>`) + num('player', 'scale', 'Escala', '', '0.05', '1') + num('player', 'yawOffset', 'Corrección de giro', '°', '1', '0'), 'Si el personaje mira para otro lado, corregilo con el giro (180 lo da vuelta).')
        + card('Movimiento', num('player', 'walkSpeed', 'Caminar', 'm/s', '0.1', '3') + num('player', 'runSpeed', 'Correr (Shift)', 'm/s', '0.1', '6.5') + num('player', 'turnSpeed', 'Rapidez al girar', '', '1', '12'))
        + card('Cámara', num('player', 'camera.distance', 'Distancia', 'm', '0.1', '4.5') + num('player', 'camera.minDistance', 'Zoom mínimo', 'm', '0.1', '1.5') + num('player', 'camera.maxDistance', 'Zoom máximo', 'm', '0.5', '12') + num('player', 'camera.height', 'Altura', 'm', '0.1', '1.5') + num('player', 'camera.pitch', 'Inclinación', 'rad', '0.05', '0.3'))
        + card('Cuerpo y colisión', num('player', 'collision.radius', 'Ancho (radio)', 'm', '0.01', '0.35') + num('player', 'collision.height', 'Altura', 'm', '0.05', '1.7') + num('player', 'collision.stepHeight', 'Escalón que sube', 'm', '0.05', '0.5') + num('player', 'collision.maxSlope', 'Pendiente máxima', '°', '1', '50') + num('player', 'collision.gravity', 'Gravedad', 'm/s²', '1', '25'));
    } else if (cur === 'anim') {
      const pl = json('player');
      playerClips = await clipsOf(pl.model ?? 'assets/models/objects/personaje.glb');
      const names = playerClips.map((c) => c.name);
      const actions = playerClips.filter((c) => /^(accion|action)_/i.test(c.name));
      const clipSel = (key, label) => fieldRow(label, `<select data-f="player" data-p="animation.clips.${key}">${options(names, get(pl, `animation.clips.${key}`) || '', `Automática (${key})`)}</select>`);
      form.innerHTML = card('Animaciones básicas', clipSel('idle', 'Quieto') + clipSel('walk', 'Caminar') + clipSel('run', 'Correr') + num('player', 'animation.fade', 'Transición', 's', '0.05', '0.2')
          + num('player', 'animation.walkAnimSpeed', 'Velocidad del ciclo caminar', 'm/s', '0.1', '0 = no ajustar') + num('player', 'animation.runAnimSpeed', 'Velocidad del ciclo correr', 'm/s', '0.1', '0 = no ajustar'),
          `${playerClips.length} clips en ${esc(baseName(pl.model ?? 'personaje.glb'))}. Las velocidades de ciclo evitan que los pies resbalen.`)
        + card('Acciones', actions.length ? actions.map((c) => {
          const id = c.name.replace(/^(accion|action)_/i, '').replace(/_(loop|vuelve|quieto)$/i, '').replace(/[._]\d+$/, '');
          const a = pl.actions?.[id] ?? {};
          const door = /abrir_?puerta/i.test(id);
          return `<div class="arow"><b>${esc(c.name)}</b>${door ? '<span class="chip">la usan las puertas</span>' : `
            <input data-act="alabel" data-id="${esc(id)}" value="${esc(a.label ?? '')}" placeholder="Texto del botón">
            <input data-act="akey" data-id="${esc(id)}" value="${esc((a.key ?? '').replace(/^(Digit|Key)/, ''))}" placeholder="Tecla" maxlength="1" style="width:60px">
            <label class="chk"><input type="checkbox" data-act="ahide" data-id="${esc(id)}"${a.hidden ? ' checked' : ''}> Sin botón</label>`}</div>`;
        }).join('') : '<p class="help">No hay clips accion_… en el modelo.</p>', 'Cada clip <b>accion_nombre</b> del personaje es una acción con botón y tecla (1, 2, 3…).');
    } else if (cur === 'npcs') {
      const t = json('npcs');
      const ms = models().filter((p) => !/personaje/i.test(p));
      const rows = await Promise.all(ms.map(async (p) => {
        const n = baseName(p), clips = (await clipsOf(p)).map((c) => c.name);
        return fieldRow(n, `<select data-act="idle" data-id="${esc(n)}">${options(clips, t[n]?.idle ?? '', 'Automática')}</select>`);
      }));
      form.innerHTML = card('Animación de quieto por modelo', rows.join('') || '<p class="help">No hay modelos.</p>', 'Vale para todos los NPC que usan ese modelo. El componente NPC de una entidad la puede cambiar.');
    }
  }

  form.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.f) {
      const v = t.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : t.value;
      return write(t.dataset.f, (d) => setPath(d, t.dataset.p, v));
    }
    const act = t.dataset.act, id = t.dataset.id;
    if (act === 'start') return write('scenes', (d) => { for (const k of Object.keys(d)) delete d[k].start; d[t.value].start = true; });
    if (act === 'idle') return write('npcs', (d) => { if (t.value) d[id] = { ...(d[id] ?? {}), idle: t.value }; else if (d[id]) { delete d[id].idle; if (!Object.keys(d[id]).length) delete d[id]; } });
    if (act === 'alabel' || act === 'akey' || act === 'ahide') {
      return write('player', (d) => {
        d.actions ??= {}; const a = d.actions[id] ??= {};
        if (act === 'alabel') { if (t.value.trim()) a.label = t.value.trim(); else delete a.label; }
        if (act === 'akey') { const k = t.value.trim().toUpperCase(); if (!k) delete a.key; else a.key = /\d/.test(k) ? `Digit${k}` : `Key${k}`; }
        if (act === 'ahide') { if (t.checked) a.hidden = true; else delete a.hidden; }
        if (!Object.keys(a).length) delete d.actions[id];
      });
    }
  });
  form.addEventListener('click', (ev) => { const b = ev.target.closest('[data-open]'); if (b) app.openSceneWs(b.dataset.open); });

  return {
    async show() {
      for (const [k, p] of Object.entries(P)) if (!docs[k]) docs[k] = fileDoc(p, await app.api.read(p).catch(() => '{}\n'));
      render();
    },
    get dirty() { return Object.values(docs).some((d) => d.dirty); },
    async save() {
      for (const d of Object.values(docs)) if (d.dirty) { await app.api.write(d.path, d.text); d.saved = d.text; app.markOwnWrite(d.path); }
      app.scenes = json('scenes'); app.wsChanged(); render(); app.toast('Proyecto guardado');
    },
    undo() { const k = order.pop(); if (k && docs[k].undoOne()) { redoOrder.push(k); app.wsChanged(); render(); } },
    redo() { const k = redoOrder.pop(); if (k && docs[k].redoOne()) { order.push(k); app.wsChanged(); render(); } },
    async external(path) { const k = Object.keys(P).find((x) => P[x] === path); if (k && docs[k] && !docs[k].dirty) { docs[k].text = docs[k].saved = await app.api.read(path); render(); } },
    refresh: () => Object.keys(docs).length && render(),
  };
}
