// Inspector: propiedades de la entidad elegida (o de la escena, si no hay nada elegido)
import { kindOf, KIND, COMPONENTS, KNOWN_KEYS, icon } from './components.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '');
const parseVal = (s) => { const t = String(s).trim(); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t; };
const AX = ['x', 'y', 'z'];

export function createInspector(app) {
  const root = document.getElementById('inspector');
  const open = new Set(['transform', 'model', 'scene', 'env', 'fog', 'custom', ...COMPONENTS.map((c) => c.id)]);
  let sig = null, query = '', scaleLock = false;

  // ---------- armado ----------
  function signature() {
    const e = app.selectedEntity;
    if (!e) return `scene|${query}|${!!app.doc.environment?.fog}`;
    return [e.id, kindOf(e), Object.keys(e.props ?? {}).sort().join(','), e.model ?? '', query, scaleLock].join('|');
  }
  function refresh() {
    const s = signature();
    if (s !== sig) { sig = s; build(); } else update();
  }

  const section = (id, title, body, { ic, color, remove } = {}) => `
    <div class="sec${open.has(id) ? ' open' : ''}" data-sec="${id}">
      <div class="sh">${icon('chevron', { size: 12, stroke: 1.8 }).replace('class="ic"', 'class="ic chev"')}
        ${ic ? `<span class="ci" style="background:${color}1a;color:${color}">${icon(ic, { size: 13 })}</span>` : ''}
        <span class="ttl">${title}</span>
        ${remove ? `<button class="ib" data-act="rmcomp" data-c="${remove}" title="Quitar componente">${icon('x', { size: 13 })}</button>` : ''}
      </div>
      <div class="sb">${body}</div>
    </div>`;
  const fieldT = (label, ctl) => `<div class="f tr" data-label="${esc(label.toLowerCase())}"><label title="${esc(label)}">${esc(label)}</label><div class="ctl">${ctl}</div></div>`;
  const field = (label, ctl, extra = '') => `<div class="f" data-label="${esc(label.toLowerCase())}"${extra}><label title="${esc(label)}">${esc(label)}</label><div class="ctl">${ctl}</div></div>`;

  function xyzRow(label, key) {
    return fieldT(label, `<div class="xyz">${AX.map((a, i) => `<div class="num ${a}"><i data-scrub="${key}.${i}">${a.toUpperCase()}</i><input type="number" step="any" data-k="${key}.${i}"></div>`).join('')}</div>
      ${key === 'scale' ? `<button class="ib${scaleLock ? ' toggle on' : ''}" data-act="lock" title="Escala uniforme">${icon('layers', { size: 13 })}</button>` : `<button class="ib" data-act="reset" data-r="${key}" title="Restablecer">${icon('reset', { size: 13 })}</button>`}`);
  }

  function options(list, cur, emptyLabel) {
    const vals = new Set(list.map((o) => (Array.isArray(o) ? o[0] : o)));
    const extra = cur && !vals.has(cur) ? `<option value="${esc(cur)}">${esc(cur)} (no encontrado)</option>` : '';
    return `${emptyLabel !== undefined ? `<option value="">${esc(emptyLabel)}</option>` : ''}${extra}${list.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}">${esc(l)}</option>`;
    }).join('')}`;
  }

  function control(f) {
    const k = `prop:${f.k}`;
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
    const unit = f.unit ? `<span class="unit">${esc(f.unit)}</span>` : '';
    switch (f.type) {
      case 'number': return `<input type="number" step="any" data-k="${k}"${ph}>${unit}`;
      case 'bool': return `<label class="switch"><input type="checkbox" data-k="${k}"><span></span></label>`;
      case 'select': return `<select data-k="${k}">${options(f.options.slice(1), '', f.options[0][1])}</select>`;
      case 'textarea': return `<textarea data-k="${k}"${ph} spellcheck="false"></textarea>`;
      case 'dest': return `<input data-k="${k}" list="dl-dest" placeholder="spawn_… o escena" spellcheck="false">`;
      case 'model': case 'prefab': return `<select data-k="${k}">${options(app.lists.objects, '', f.type === 'model' ? (f.placeholder ?? 'Automático') : 'Elegí un archivo')}</select>`;
      case 'dialogue': return `<select data-k="${k}">${options(app.lists.dialogues, '', 'Ninguno')}</select><button class="ib sm" data-act="openfile" data-ft="dialogue" title="Abrir en Diálogos">${icon('chat', { size: 13 })}</button>`;
      case 'route': return `<select data-k="${k}">${options(app.lists.routes, '', 'No camina')}</select><button class="ib sm" data-act="openfile" data-ft="route" title="Abrir en Rutas (con el mapa)">${icon('route', { size: 13 })}</button>`;
      default: return `<input data-k="${k}"${ph} spellcheck="false">`;
    }
  }

  function datalists() {
    const spawns = (app.doc.entities ?? []).filter((e) => kindOf(e) === 'spawn').map((e) => (e.props?.spawn ? `spawn_${e.props.spawn}` : e.name));
    const scenes = Object.keys(app.scenes).filter((id) => id !== app.sceneId);
    return `<datalist id="dl-dest">${[...new Set(spawns)].map((s) => `<option value="${esc(s)}">Esta escena</option>`).join('')}
      ${scenes.map((s) => `<option value="${esc(s)}">Otra escena</option>`).join('')}</datalist>`;
  }

  function buildEntity(e) {
    const k = kindOf(e), K = KIND[k];
    const props = e.props ?? {};
    let h = `<div class="ih">
      <span class="big" style="background:${K.color}1a;color:${K.color}">${icon(K.icon, { size: 18 })}</span>
      <div class="tt"><input data-k="name" spellcheck="false" title="Nombre (los sistemas lo leen: spawn_, npc_, col_, ruta_…)"><div class="kind">${esc(K.label)}${e.node ? ` · ${esc(e.node)}` : ''}</div></div>
      <div class="acts">
        <button class="ib" data-act="focus" title="Enfocar (F)">${icon('target')}</button>
        <button class="ib" data-act="dup" title="Duplicar (Ctrl+D)">${icon('copy')}</button>
        <button class="ib" data-act="del" title="Borrar (Supr)">${icon('trash')}</button>
      </div></div>
      <div class="search isearch"><span class="si">${icon('search', { size: 14 })}</span><input data-act="q" value="${esc(query)}" placeholder="Buscar propiedad" spellcheck="false"></div>`;
    h += section('transform', 'Transformación', xyzRow('Posición', 'position') + xyzRow('Rotación', 'rotation') + xyzRow('Escala', 'scale'));
    const modelBody = field('Archivo', `<select data-k="model">${options(app.lists.models, '', 'Sin modelo')}</select>`)
      + (e.model ? field('Parte del archivo', `<input data-k="node" placeholder="todo el archivo" spellcheck="false">`) : '')
      + field('Visible en el juego', `<label class="switch"><input type="checkbox" data-k="visible"><span></span></label>`);
    h += section('model', 'Modelo', modelBody);
    for (const c of COMPONENTS) {
      if (!c.has(props)) continue;
      let body = `<p class="help">${esc(c.help)}</p>`;
      if (c.needsName && !c.needsName.test(e.name)) {
        body += `<div class="warnline">${icon('warn', { size: 14 })}<span>El nombre tiene que empezar con <b>${c.namePrefix}</b> para que el juego lo cargue.</span><button data-act="fixname" data-p="${c.namePrefix}">Renombrar</button></div>`;
      }
      body += c.fields.map((f) => field(f.label, control(f))).join('');
      h += section(c.id, c.label, body, { ic: c.icon, color: c.color, remove: c.id });
    }
    const custom = Object.keys(props).filter((key) => !KNOWN_KEYS.has(key));
    const customBody = `<p class="help">Custom Properties que no son de ningún componente (las mismas que en Blender).</p>
      ${custom.map((key) => `<div class="kv" data-label="${esc(key.toLowerCase())}"><input value="${esc(key)}" data-ck="${esc(key)}" spellcheck="false"><input data-k="prop:${esc(key)}" spellcheck="false"><button class="ib" data-act="rmprop" data-p="${esc(key)}" title="Quitar">${icon('x', { size: 13 })}</button></div>`).join('')}
      <button class="linkbtn" data-act="addprop">+ Propiedad</button>`;
    h += section('custom', `Propiedades${custom.length ? ` <span class="chip">${custom.length}</span>` : ''}`, customBody);
    const missing = COMPONENTS.filter((c) => !c.has(props));
    if (missing.length) {
      h += `<div class="addc menuwrap"><button data-act="addcomp">${icon('plus', { size: 14 })}Agregar componente</button>
        <div class="menu" hidden>${missing.map((c) => `<button data-act="comp" data-c="${c.id}">${icon(c.icon, { color: c.color })}${esc(c.label)}</button>`).join('')}</div></div>`;
    }
    return h + datalists();
  }

  function buildScene() {
    const d = app.doc, env = d.environment ?? {};
    const music = Object.keys(app.music);
    let h = `<div class="ih">
      <span class="big" style="background:#3d6df21a;color:#3d6df2">${icon('layers', { size: 18 })}</span>
      <div class="tt"><input data-k="scene:name" spellcheck="false" placeholder="Nombre de la escena"><div class="kind">Escena · ${esc(app.sceneId)} · ${(d.entities ?? []).length} entidades</div></div></div>`;
    h += section('env', 'Ambiente', [
      field('Fondo', `<input type="color" data-k="env:background">`),
      field('Tono', `<input type="color" data-k="env:tint">`),
      field('Brillo', `<input type="number" step="0.05" min="0" data-k="env:brightness">`),
      field('Música', `<select data-k="scene:music">${options(music, '', 'Sin música')}</select>`),
      field('Colisión por defecto', `<select data-k="scene:coldef">${options([['solid', 'Todo choca']], '', 'Solo col_ y Colisión')}</select>`),
    ].join(''));
    h += section('fog', 'Niebla', [
      field('Activada', `<label class="switch"><input type="checkbox" data-k="fog:on"><span></span></label>`),
      env.fog ? field('Color', `<input type="color" data-k="fog:color">`) + field('Empieza', `<input type="number" step="1" data-k="fog:near"><span class="unit">m</span>`) + field('Termina', `<input type="number" step="1" data-k="fog:far"><span class="unit">m</span>`) : '',
    ].join(''));
    h += `<div class="empty" style="padding-top:18px">Elegí algo en la escena o en el visor para ver sus propiedades.<br><br>
      <span class="chip">W</span> mover · <span class="chip">E</span> rotar · <span class="chip">R</span> escalar · <span class="chip">F</span> enfocar</div>`;
    return h;
  }

  function build() {
    const e = app.selectedEntity;
    root.innerHTML = e ? buildEntity(e) : buildScene();
    update(true);
    applyQuery();
  }

  function applyQuery() {
    const q = query.trim().toLowerCase();
    root.querySelectorAll('.f, .kv').forEach((f) => f.classList.toggle('hide', !!q && !f.dataset.label?.includes(q)));
    if (q) root.querySelectorAll('.sec').forEach((s) => { const any = s.querySelector('.f:not(.hide), .kv:not(.hide)'); s.style.display = any ? '' : 'none'; if (any) s.classList.add('open'); });
    else root.querySelectorAll('.sec').forEach((s) => { s.style.display = ''; s.classList.toggle('open', open.has(s.dataset.sec)); });
  }

  // ---------- valores ----------
  function read(key) {
    const e = app.selectedEntity, d = app.doc, env = d.environment ?? {};
    if (key === 'name') return e.name;
    if (key === 'model') return e.model ?? '';
    if (key === 'node') return e.node ?? '';
    if (key === 'visible') return !e.hidden;
    if (key.startsWith('prop:')) return e.props?.[key.slice(5)];
    const m = /^(position|rotation|scale)\.(\d)$/.exec(key);
    if (m) return (e[m[1]] ?? (m[1] === 'scale' ? [1, 1, 1] : [0, 0, 0]))[+m[2]];
    if (key === 'scene:name') return d.name ?? '';
    if (key === 'scene:music') return d.music ?? '';
    if (key === 'scene:coldef') return d.collision?.default === 'solid' ? 'solid' : '';
    if (key === 'env:background') return env.background ?? '#9fc6e8';
    if (key === 'env:tint') return env.tint ?? '#ffffff';
    if (key === 'env:brightness') return env.brightness ?? 1;
    if (key === 'fog:on') return !!env.fog;
    if (key === 'fog:color') return env.fog?.color ?? env.background ?? '#9fc6e8';
    if (key === 'fog:near') return env.fog?.near ?? 80;
    if (key === 'fog:far') return env.fog?.far ?? 400;
    return '';
  }
  function update(all = false) {
    root.querySelectorAll('[data-k]').forEach((el) => {
      if (!all && el === document.activeElement) return;
      const v = read(el.dataset.k);
      if (el.type === 'checkbox') el.checked = el.dataset.k.startsWith('prop:') ? !(v === undefined || v === 0 || v === '0' || v === false || /^(no|false|off)$/i.test(String(v))) : !!v;
      else if (el.type === 'number') el.value = typeof v === 'number' ? fmt(v) : (v ?? '');
      else el.value = v ?? '';
    });
  }

  function write(key, el) {
    const e = app.selectedEntity;
    const raw = el.type === 'checkbox' ? el.checked : el.value;
    if (key === 'name') { if (String(raw).trim()) app.rename(e.id, String(raw).trim()); else update(true); return; }
    if (key.startsWith('scene:') || key.startsWith('env:') || key.startsWith('fog:')) return writeScene(key, raw);
    app.commit(labelFor(key), (doc) => {
      const t = doc.entities.find((x) => x.id === e.id);
      const m = /^(position|rotation|scale)\.(\d)$/.exec(key);
      if (m) {
        const arr = [...(t[m[1]] ?? (m[1] === 'scale' ? [1, 1, 1] : [0, 0, 0]))];
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        if (m[1] === 'scale' && scaleLock) { const old = arr[+m[2]] || 1; const f = n / old; for (let i = 0; i < 3; i++) arr[i] = i === +m[2] ? n : arr[i] * f; }
        else arr[+m[2]] = n;
        t[m[1]] = arr;
      } else if (key === 'model') { if (raw) { t.model = raw; delete t.node; } else { delete t.model; delete t.node; } }
      else if (key === 'node') { if (raw.trim()) t.node = raw.trim(); else delete t.node; }
      else if (key === 'visible') { if (raw) delete t.hidden; else t.hidden = true; }
      else if (key.startsWith('prop:')) {
        const p = key.slice(5);
        t.props ??= {};
        if (el.type === 'checkbox') { if (raw) t.props[p] = 1; else if (p === 'colision') t.props[p] = 0; else delete t.props[p]; }
        else if (raw === '' || raw === null) { const comp = COMPONENTS.find((c) => c.fields[0].k === p); if (comp) t.props[p] = ''; else delete t.props[p]; }
        else t.props[p] = el.type === 'number' ? Number(raw) : parseVal(raw);
        if (!Object.keys(t.props).length) delete t.props;
      }
    });
  }
  function writeScene(key, raw) {
    app.commit('Ajustes de la escena', (doc) => {
      doc.environment ??= {};
      const env = doc.environment;
      if (key === 'scene:name') doc.name = raw;
      else if (key === 'scene:music') { if (raw) doc.music = raw; else delete doc.music; }
      else if (key === 'scene:coldef') doc.collision = { ...(doc.collision ?? {}), default: raw || 'none' };
      else if (key === 'env:background') env.background = raw;
      else if (key === 'env:tint') env.tint = raw;
      else if (key === 'env:brightness') env.brightness = Number(raw) || 0;
      else if (key === 'fog:on') { if (raw) env.fog = { color: env.background ?? '#9fc6e8', near: 80, far: 400 }; else delete env.fog; }
      else if (key.startsWith('fog:') && env.fog) env.fog[key.slice(4)] = key === 'fog:color' ? raw : Number(raw);
    });
  }
  const labelFor = (key) => (key.startsWith('position') ? 'Mover' : key.startsWith('rotation') ? 'Rotar' : key.startsWith('scale') ? 'Escalar' : key === 'model' ? 'Cambiar modelo' : 'Cambiar propiedad');

  // ---------- eventos ----------
  root.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset.ck !== undefined) { // renombrar una propiedad personalizada
      const from = el.dataset.ck, to = el.value.trim();
      if (!to || to === from) { el.value = from; return; }
      app.commit('Renombrar propiedad', (doc) => {
        const t = doc.entities.find((x) => x.id === app.selected);
        const v = t.props[from]; delete t.props[from]; t.props[to] = v;
      });
      return;
    }
    if (el.dataset.k) write(el.dataset.k, el);
  });
  root.addEventListener('input', (ev) => {
    if (ev.target.dataset.act === 'q') { query = ev.target.value; applyQuery(); }
    if (ev.target.type === 'color' && ev.target.dataset.k) write(ev.target.dataset.k, ev.target); // color en vivo
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('input:not([type=checkbox])')) ev.target.blur();
    if (ev.key === 'Escape' && ev.target.matches('input, textarea')) { update(true); ev.target.blur(); }
  });
  root.addEventListener('click', (ev) => {
    const sh = ev.target.closest('.sh');
    const b = ev.target.closest('[data-act]');
    if (b && b.tagName === 'BUTTON') {
      const e = app.selectedEntity;
      switch (b.dataset.act) {
        case 'focus': app.viewport.focus(e.id); break;
        case 'openfile': {
          const v = b.parentElement.querySelector('select')?.value;
          const dlg = b.dataset.ft === 'dialogue';
          if (v) app.openWsFile(dlg ? 'dialogues' : 'routes', `data/${dlg ? 'dialogues' : 'routes'}/${v}.json`);
          else { app.openWsFile(dlg ? 'dialogues' : 'routes'); app.toast(`Creá uno con + y después elegilo acá`); }
          break;
        }
        case 'dup': app.duplicate(e.id); break;
        case 'del': app.remove(e.id); break;
        case 'lock': scaleLock = !scaleLock; refresh(); break;
        case 'reset': app.commit('Restablecer', (doc) => { const t = doc.entities.find((x) => x.id === e.id); delete t[b.dataset.r]; }); break;
        case 'rmcomp': {
          const c = COMPONENTS.find((x) => x.id === b.dataset.c);
          app.commit(`Quitar ${c.label}`, (doc) => {
            const t = doc.entities.find((x) => x.id === e.id);
            for (const f of c.fields) delete t.props?.[f.k];
            if (t.props && !Object.keys(t.props).length) delete t.props;
          });
          break;
        }
        case 'addcomp': app.toggleMenu(b.nextElementSibling); break;
        case 'comp': {
          const c = COMPONENTS.find((x) => x.id === b.dataset.c);
          app.closeMenus();
          open.add(c.id);
          app.commit(`Agregar ${c.label}`, (doc) => { const t = doc.entities.find((x) => x.id === e.id); t.props = { ...(t.props ?? {}), ...c.add }; });
          break;
        }
        case 'fixname': app.rename(e.id, b.dataset.p + e.name.replace(/^[^_]*_?/, '').replace(/^$/, 'nuevo')); break;
        case 'rmprop': app.commit('Quitar propiedad', (doc) => { const t = doc.entities.find((x) => x.id === e.id); delete t.props[b.dataset.p]; if (!Object.keys(t.props).length) delete t.props; }); break;
        case 'addprop': app.commit('Agregar propiedad', (doc) => {
          const t = doc.entities.find((x) => x.id === e.id); t.props ??= {};
          let n = 'propiedad', i = 1; while (n in t.props) n = `propiedad_${++i}`;
          t.props[n] = '';
        }); break;
      }
      return;
    }
    if (sh) {
      const sec = sh.parentElement, id = sec.dataset.sec;
      sec.classList.toggle('open');
      if (sec.classList.contains('open')) open.add(id); else open.delete(id);
    }
  });

  // Arrastrar la letra X / Y / Z cambia el valor (Shift = fino)
  root.addEventListener('pointerdown', (ev) => {
    const i = ev.target.closest('[data-scrub]'); if (!i) return;
    ev.preventDefault();
    const key = i.dataset.scrub, [what, idx] = key.split('.');
    const step = what === 'rotation' ? 0.5 : what === 'scale' ? 0.01 : 0.02;
    const e = app.selectedEntity;
    const start = (e[what] ?? (what === 'scale' ? [1, 1, 1] : [0, 0, 0]))[+idx];
    let acc = 0;
    app.beginLive();
    i.setPointerCapture(ev.pointerId);
    const move = (m) => {
      acc += m.movementX * (m.shiftKey ? 0.1 : 1);
      const v = Math.round((start + acc * step) * 1000) / 1000;
      app.setLive((doc) => {
        const t = doc.entities.find((x) => x.id === e.id);
        const arr = [...(t[what] ?? (what === 'scale' ? [1, 1, 1] : [0, 0, 0]))];
        if (what === 'scale' && scaleLock) { const f = v / (arr[+idx] || 1); for (let k = 0; k < 3; k++) arr[k] = k === +idx ? v : Math.round(arr[k] * f * 1000) / 1000; } else arr[+idx] = v;
        t[what] = arr;
      });
    };
    const up = () => { i.removeEventListener('pointermove', move); i.removeEventListener('pointerup', up); i.removeEventListener('pointercancel', up); app.endLive(labelFor(key)); };
    i.addEventListener('pointermove', move); i.addEventListener('pointerup', up); i.addEventListener('pointercancel', up);
  });

  return { refresh, rebuild: () => { sig = null; refresh(); } };
}
