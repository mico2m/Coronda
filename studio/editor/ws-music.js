// Espacio "Música": las pistas de data/tables/music.json (archivo, loop, volumen) y en qué escenas suenan
import { listPane, fileDoc, esc, slug, fieldRow, options } from './ws-common.js';
import { projectIndex, forgetIndex } from './project-index.js';
import { icon } from './components.js';

const PATH = 'data/tables/music.json';
const isAudio = (p) => /\.(mp3|ogg|wav|m4a)$/i.test(p);

export function createMusicWorkspace(app, el) {
  el.innerHTML = `<aside class="wsl"></aside><section class="wsc"><div class="wsbar"><b class="wst"></b><span class="wsu"></span><span class="spacer"></span>
      <button class="ghost" data-act="import">${icon('upload', { size: 14 })}Importar audio</button><input type="file" accept="audio/*" multiple hidden></div>
    <div class="wsbody"><div class="card-c"></div></div></section>`;
  let doc = null, cur = null, index = null;
  const audio = new Audio();
  const pane = listPane(el.querySelector('.wsl'), { title: 'Música', addLabel: 'Pista nueva', onAdd: create, onSelect: (id) => { cur = id; render(); }, empty: 'No hay pistas. Importá un audio y creá una pista con +.' });
  const body = el.querySelector('.card-c');
  const data = () => { try { return JSON.parse(doc.text); } catch { return {}; } };
  const write = (fn, newStep = true) => { const d = data(); fn(d); if (doc.set(`${JSON.stringify(d, null, 2)}\n`, newStep)) { app.wsChanged(); render(); } };
  const audioFiles = () => app.files.filter((p) => p.startsWith('audio/') && isAudio(p)).sort();
  const problem = (e) => {
    if (!e?.file) return 'No tiene archivo';
    if (!isAudio(e.file)) return `"${e.file}" no es un archivo de audio (¿falta el nombre del archivo?)`;
    if (!app.files.includes(e.file)) return `No existe ${e.file}`;
    return '';
  };

  function renderList() {
    const d = data();
    pane.set(Object.entries(d).filter(([k]) => !k.startsWith('_')).map(([id, e]) => ({
      id, label: id, icon: 'music', color: '#d9690c', sub: (index?.music.get(id) ?? []).join(', ') || 'Ninguna escena', warn: problem(e), dirty: false,
    })), cur);
  }
  function render() {
    renderList();
    const d = data(), e = d[cur];
    el.querySelector('.wst').textContent = cur ?? '';
    el.querySelector('.wsu').textContent = doc?.dirty ? 'Sin guardar' : '';
    if (!e) { body.innerHTML = `<div class="empty"><b>Elegí una pista</b>o creá una nueva con +.</div>`; return; }
    const scenes = index?.music.get(cur) ?? [];
    const pb = problem(e);
    const vol = Number.isFinite(Number(e.volume)) ? Number(e.volume) : 1;
    body.innerHTML = `
      ${pb ? `<div class="warnline">${icon('warn', { size: 14 })}<span>${esc(pb)}. Elegí el archivo correcto abajo.</span></div>` : ''}
      <div class="player">
        <button class="pp" data-act="play" title="Escuchar">${icon(audio.dataset.id === cur && !audio.paused ? 'stop' : 'play', { size: 16, color: '#fff', stroke: 2 })}</button>
        <div class="pinfo"><b>${esc(e.file?.split('/').pop() || 'Sin archivo')}</b><small>${esc(e.file ?? '')}</small><div class="bar"><i style="width:${audio.dataset.id === cur && audio.duration ? (audio.currentTime / audio.duration) * 100 : 0}%"></i></div></div>
      </div>
      <div class="sec open"><div class="sb" style="display:block;padding-top:12px">
        ${fieldRow('Nombre', `<input data-k="id" value="${esc(cur)}" spellcheck="false">`)}
        ${fieldRow('Archivo', `<select data-k="file">${options(audioFiles(), e.file, 'Elegí un audio')}</select>`)}
        ${fieldRow('Repetir', `<label class="switch"><input type="checkbox" data-k="loop"${e.loop !== false ? ' checked' : ''}><span></span></label>`)}
        ${fieldRow('Volumen', `<input type="range" min="0" max="1" step="0.05" data-k="volume" value="${vol}"><span class="unit" style="width:36px;text-align:right">${Math.round(vol * 100)}%</span>`)}
      </div></div>
      <div class="sec open"><div class="sh" style="cursor:default"><span class="ttl">Suena en</span></div><div class="sb" style="display:block">
        ${scenes.length ? `<div class="chips">${scenes.map((s) => `<span class="chip">${icon('layers', { size: 12 })}${esc(s)}</span>`).join('')}</div>` : '<p class="help">Ninguna escena usa esta pista.</p>'}
        ${app.sceneId && !scenes.includes(app.sceneId) ? `<button class="linkbtn" data-act="assign">Usarla en ${esc(app.sceneId)}</button>` : ''}
      </div></div>`;
  }
  body.addEventListener('change', (ev) => {
    const k = ev.target.dataset.k; if (!k) return;
    const v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
    if (k === 'id') {
      const n = slug(v); if (!n || n === cur) { render(); return; }
      if (data()[n]) { app.toast(`Ya existe la pista ${n}`, true); render(); return; }
      const old = cur;
      write((d) => { d[n] = d[old]; delete d[old]; });
      cur = n; app.toast('Ojo: las escenas que usaban el nombre anterior hay que cambiarlas en su inspector'); render();
      return;
    }
    write((d) => {
      const e = d[cur];
      if (k === 'file') e.file = v;
      if (k === 'loop') e.loop = !!v;
      if (k === 'volume') e.volume = Number(v);
    });
  });
  body.addEventListener('input', (ev) => {
    if (ev.target.dataset.k !== 'volume') return;
    ev.target.nextElementSibling.textContent = `${Math.round(ev.target.value * 100)}%`;
    if (audio.dataset.id === cur) audio.volume = 0.6 * Number(ev.target.value);
  });
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'play') {
      const e = data()[cur];
      if (audio.dataset.id === cur && !audio.paused) { audio.pause(); render(); return; }
      if (problem(e)) { app.toast(problem(e), true); return; }
      audio.src = `/${e.file}`; audio.dataset.id = cur; audio.loop = e.loop !== false; audio.volume = 0.6 * (e.volume ?? 1);
      audio.play().then(render).catch(() => app.toast('No se pudo reproducir', true));
    }
    if (act === 'assign') {
      app.commit('Música de la escena', (d) => { d.music = cur; });
      await app.saveScene();
      forgetIndex(); index = await projectIndex(app); render();
    }
    if (act === 'import') el.querySelector('input[type=file]').click();
  });
  el.querySelector('input[type=file]').addEventListener('change', async (ev) => {
    const ok = await app.importFiles([...ev.target.files], 'audio/music');
    ev.target.value = '';
    if (ok.length) { render(); app.toast('Audio importado: creá una pista con + o elegilo en Archivo'); }
  });
  audio.addEventListener('timeupdate', () => { const i = body.querySelector('.player .bar i'); if (i && audio.duration) i.style.width = `${(audio.currentTime / audio.duration) * 100}%`; });
  audio.addEventListener('ended', render);

  async function create() {
    const files = audioFiles();
    const r = await app.ask('Pista nueva', `Nombre de la pista (es el que se elige en cada escena).${files.length ? '' : '<br><br>Todavía no hay audios: importá uno primero.'}`, [['cancel', 'Cancelar'], ['ok', 'Crear', 'primary']], { input: { placeholder: 'plaza_dia' } });
    if (r.value !== 'ok') return;
    const n = slug(r.text); if (!n) return;
    if (data()[n]) { app.toast(`Ya existe ${n}`, true); return; }
    const guess = files.find((p) => p.includes(n)) ?? files[0] ?? '';
    write((d) => { d[n] = { file: guess, loop: true, volume: 0.8 }; });
    cur = n; render();
  }

  return {
    async show() {
      if (!doc) doc = fileDoc(PATH, await app.api.read(PATH).catch(() => '{}\n'));
      index = await projectIndex(app);
      if (!cur) cur = Object.keys(data()).find((k) => !k.startsWith('_')) ?? null;
      render();
    },
    hide() { audio.pause(); },
    get dirty() { return !!doc?.dirty; },
    async save() {
      if (!doc?.dirty) return;
      await app.api.write(PATH, doc.text); doc.saved = doc.text; app.markOwnWrite(PATH);
      app.music = data(); app.wsChanged(); render(); app.toast('Música guardada');
    },
    undo() { if (doc?.undoOne()) { app.wsChanged(); render(); } },
    redo() { if (doc?.redoOne()) { app.wsChanged(); render(); } },
    async external(path) { if (path === PATH && doc && !doc.dirty) { doc.text = doc.saved = await app.api.read(PATH); render(); } },
    refresh: () => doc && render(),
  };
}
