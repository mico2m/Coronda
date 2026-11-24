// Espacio "Interfaz": el diseño de la interfaz del juego (data/ui.json). Estilos listos, caja de diálogo (letra, colores,
// forma, velocidad y sonido de las letras), avisos y botones, textos, íconos y letras importadas. La vista previa es un
// iframe que dibuja con el mismo código que el juego (ui-preview.html), así que lo que se ve acá es lo que sale.
import { listPane, fileDoc, esc, slug, fieldRow, options } from './ws-common.js';
import { icon } from './components.js';
import { json } from './api.js';
import {
  resolveUI, applyPreset, PRESETS, DEFAULT_UI, fontList, fontCSS, ensureFont, setAssetBase, ICONS, ICON_GROUPS,
  iconHTML, BLIP_KINDS, blip, BUILTIN_FONTS,
} from '/src/ui/theme.js';
import { pixelTextCanvas } from '/src/ui/textbox-paint.js';
import { parseActionName, humanize, DOOR_CLIP_RE } from '/src/actors/player.js';
import { clipsOf } from './project-index.js';

setAssetBase('/');
const PATH = 'data/ui.json';
const SECTIONS = [
  { id: 'estilo', label: 'Estilo', sub: 'Puntos de partida completos', icon: 'palette', color: '#d6456b', scene: null },
  { id: 'textbox', label: 'Caja de diálogo', sub: 'Letra, colores, forma, velocidad, sonido', icon: 'chat', color: '#3d6df2', scene: 'charla' },
  { id: 'hud', label: 'Avisos y botones', sub: '"E Entrar", acciones, ayuda de teclas', icon: 'menu', color: '#1f9d61', scene: 'juego' },
  { id: 'texts', label: 'Textos', sub: 'Lo que dicen los avisos', icon: 'file', color: '#7c5cd6', scene: 'juego' },
  { id: 'icons', label: 'Íconos', sub: 'Puertas, charlas y acciones', icon: 'star', color: '#e08a1e', scene: 'juego' },
  { id: 'fonts', label: 'Letras', sub: 'De fábrica e importadas', icon: 'type', color: '#0f766e', scene: null },
];
const SCENES = [['charla', 'Charla'], ['opciones', 'Opciones'], ['juego', 'Puerta'], ['hablar', 'Hablar'], ['pausa', 'Pausa'], ['titulo', 'Título']];
const SAMPLE_KEY = 'coronda.ui.sample';
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

// ---------- colores ----------
function parseColor(c) {
  const s = String(c ?? '').trim();
  let m;
  if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s))) return { hex: `#${m[1].toLowerCase()}`, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s))) return { hex: `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase(), a: 1 };
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/i.exec(s))) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, '0');
    const a = m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4];
    return { hex: `#${h(m[1])}${h(m[2])}${h(m[3])}`, a: Math.max(0, Math.min(1, a)) };
  }
  return { hex: '#000000', a: 1 };
}
function fmtColor(hex, a) {
  if (a >= 0.995) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${Math.round(a * 100) / 100})`;
}
const getP = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
function setP(o, path, v) {
  const ks = path.split('.');
  let t = o;
  for (const k of ks.slice(0, -1)) t = t[k] && typeof t[k] === 'object' ? t[k] : (t[k] = {});
  if (v === undefined) delete t[ks[ks.length - 1]]; else t[ks[ks.length - 1]] = v;
}

export function createUIWorkspace(app, el) {
  el.innerHTML = `<aside class="wsl"></aside>
    <section class="wsc"><div class="wsbar"><b class="wst"></b><span class="wsu"></span><span class="spacer"></span>
        <div class="seg txt" data-scenes>${SCENES.map(([k, l]) => `<button data-scene="${k}">${l}</button>`).join('')}</div>
        <select class="sm" data-aspect title="Proporción de la pantalla"><option value="16/9">16:9</option><option value="4/3">4:3 (retro)</option></select>
        <select class="sm" data-bg title="Fondo de la vista previa"></select>
        <button class="ib toggle" data-sound title="Sonido de las letras en la vista previa">${icon('music', { size: 14 })}</button></div>
      <div class="wsbody center uibody"><div class="uistage"><iframe class="uiframe" src="ui-preview.html" title="Vista previa de la interfaz"></iframe></div>
        <p class="muted uihint">Clic en una parte de la vista previa para editarla · se ve con el mismo código que el juego</p></div></section>
    <aside class="wsr panel"><div class="uinsp"></div></aside>`;
  let doc = null, sec = 'estilo', scene = 'charla', aspect = localStorage.getItem('coronda.ui.aspect') || '16/9', sound = false, bg = '';
  let iconTarget = 'door', actions = [], ready = false;
  let lastKey = '', lastT = 0;
  let sample = (() => { try { return JSON.parse(localStorage.getItem(SAMPLE_KEY)) ?? null; } catch { return null; } })();
  const pane = listPane(el.querySelector('.wsl'), { title: 'Interfaz', onSelect: (id) => select(id) });
  const insp = el.querySelector('.uinsp'), frame = el.querySelector('.uiframe'), stageEl = el.querySelector('.uistage');
  const raw = () => { try { const d = JSON.parse(doc?.text || '{}'); return d && typeof d === 'object' ? d : {}; } catch { return {}; } };
  const ui = () => resolveUI(raw());

  // ---- escribir (con pasos de deshacer agrupados mientras se arrastra un control) ----
  function write(fn, key = '', rerender = false) {
    const d = raw();
    fn(d);
    const now = performance.now();
    const step = !key || key !== lastKey || now - lastT > 900;
    lastKey = key; lastT = now;
    if (doc.set(json(d), step)) { app.wsChanged(); bar(); renderList(); send(); }
    if (rerender) renderInspector();
  }
  const setVal = (path, v, key, rerender) => write((d) => setP(d, path, v), key ?? path, rerender);

  // ---- vista previa ----
  function send(extra = {}) {
    if (!ready) return;
    frame.contentWindow?.postMessage({ type: 'ui', theme: raw(), scene, sound, bg, actions: actions.slice(0, 4), sample: sample ?? undefined, ...extra }, location.origin);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    if (e.data?.type === 'ui-ready') { ready = true; send(); }
    if (e.data?.type === 'ui-pick') select(e.data.section);
  });
  function setScene(s) {
    scene = s;
    el.querySelectorAll('[data-scene]').forEach((b) => b.classList.toggle('on', b.dataset.scene === s));
    send({ scene: s });
  }
  el.querySelector('[data-scenes]').addEventListener('click', (e) => { const b = e.target.closest('[data-scene]'); if (b) setScene(b.dataset.scene); });
  const aspectSel = el.querySelector('[data-aspect]');
  aspectSel.value = aspect;
  const applyAspect = () => { stageEl.style.aspectRatio = aspect.replace('/', ' / '); };
  applyAspect();
  aspectSel.addEventListener('change', () => { aspect = aspectSel.value; localStorage.setItem('coronda.ui.aspect', aspect); applyAspect(); });
  const bgSel = el.querySelector('[data-bg]');
  bgSel.addEventListener('change', () => { bg = bgSel.value; send(); });
  const soundBtn = el.querySelector('[data-sound]');
  soundBtn.addEventListener('click', () => { sound = !sound; soundBtn.classList.toggle('on', sound); send(); });

  function bar() {
    el.querySelector('.wst').textContent = SECTIONS.find((s) => s.id === sec)?.label ?? 'Interfaz';
    el.querySelector('.wsu').innerHTML = doc?.dirty ? 'Sin guardar' : doc?.text ? `<b>${PATH}</b>` : 'Todavía con los valores de fábrica';
  }
  function renderList() {
    const t = ui();
    pane.set(SECTIONS.map((s) => ({ ...s, sub: s.id === 'estilo' ? `${PRESETS[raw().preset ?? 'ocarina']?.name ?? 'Propio'} · ${s.sub}` : s.id === 'fonts' ? `${t.fonts.length} importada${t.fonts.length === 1 ? '' : 's'} · ${s.sub}` : s.sub })), sec);
  }
  function select(id) {
    if (!SECTIONS.some((s) => s.id === id)) return;
    sec = id;
    const s = SECTIONS.find((x) => x.id === id);
    if (s.scene && !(id === 'textbox' && scene === 'opciones') && !(id === 'icons' && scene === 'hablar') && !(id === 'hud' && scene === 'hablar') && !(id === 'texts' && scene === 'hablar')) setScene(s.scene);
    renderList(); bar(); renderInspector();
  }

  // ---- controles ----
  const head = (s) => `<div class="ih"><span class="big" style="background:${s.color}1a;color:${s.color}">${icon(s.icon, { size: 18 })}</span>
      <div class="tt"><b>${esc(s.label)}</b><div class="kind">${esc(s.sub)}</div></div>
      ${s.id !== 'estilo' && s.id !== 'fonts' ? `<div class="acts"><button class="ib" data-act="reset" title="Volver a los valores del estilo de fábrica">${icon('reset')}</button></div>` : ''}</div>`;
  const group = (title, body, open = true) => `<div class="sec${open ? ' open' : ''}"><div class="sh"><span class="chev">${icon('chevron', { size: 12 })}</span><span class="ttl">${esc(title)}</span></div><div class="sb">${body}</div></div>`;
  const val = (path) => getP(ui(), path);
  const range = (path, min, max, step = 1, unit = '') => {
    const v = val(path);
    return `<input type="range" min="${min}" max="${max}" step="${step}" value="${esc(v)}" data-p="${path}" data-num><output class="unit uo">${esc(v)}${unit}</output>`;
  };
  const sw = (path) => `<label class="switch"><input type="checkbox" data-p="${path}"${val(path) ? ' checked' : ''}><span></span></label>`;
  const sel = (path, list) => `<select data-p="${path}">${options(list, String(val(path) ?? ''))}</select>`;
  const color = (path, { alpha = true, none = false } = {}) => {
    const v = val(path);
    const off = none && !v;
    const c = parseColor(v || '#000000');
    return `<span class="colora${off ? ' off' : ''}">${none ? `<label class="switch" title="Usar"><input type="checkbox" data-none="${path}"${off ? '' : ' checked'}><span></span></label>` : ''}
      <input type="color" value="${c.hex}" data-c="${path}"${off ? ' disabled' : ''}>
      ${alpha ? `<input type="range" min="0" max="100" value="${Math.round(c.a * 100)}" data-ca="${path}" title="Opacidad"${off ? ' disabled' : ''}><output class="unit">${Math.round(c.a * 100)}%</output>` : ''}</span>`;
  };
  function fontSelect(path) {
    const cur = val(path);
    const groups = new Map();
    for (const f of fontList(ui())) { const g = f.tag ?? 'otras'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); }
    return `<select data-p="${path}" class="fontsel">${[...groups].map(([g, list]) => `<optgroup label="${esc(g[0].toUpperCase() + g.slice(1))}">${list.map((f) => `<option value="${esc(f.id)}"${f.id === cur ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
  }

  // ---- secciones ----
  function presetCard(id, p) {
    const t = resolveUI(applyPreset({}, id));
    const tb = t.textbox, h = t.hud;
    const on = (raw().preset ?? 'ocarina') === id;
    ensureFont(tb.font, t); ensureFont(h.font, t);
    const tbFont = BUILTIN_FONTS[tb.font]?.bitmap ? "'Press Start 2P', monospace" : fontCSS(tb.font, t);
    return `<button class="pcard${on ? ' on' : ''}" data-preset="${id}">
      <span class="pv" style="--box:${esc(tb.box)};--bd:${esc(tb.border || 'transparent')};--tx:${esc(tb.text)};--nm:${esc(tb.name)};--ch:${esc(tb.choice)};--r:${Math.min(10, tb.radius)}px;--f:${esc(tbFont)}">
        <span class="pnm">Ana</span><span class="pbox"><span>¡Hola! ¿Viste el muelle?</span><span class="pch">› Sí, vamos</span></span>
        <span class="phud" style="background:${esc(h.panel)};color:${esc(h.text)};border-color:${esc(h.border)};border-radius:${Math.min(12, h.radius)}px;font-family:${esc(fontCSS(h.font, t))}"><i style="border-color:${esc(h.accent)};${h.keyStyle !== 'outline' ? `background:${esc(h.accent)};color:${esc(h.panel)}` : ''}">E</i>Entrar</span></span>
      <span class="pt"><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></span></button>`;
  }
  function renderEstilo() {
    return `<div class="sb" style="display:block;padding:12px">
      <p class="help">Elegí un punto de partida: cambia la caja de diálogo y los avisos de una vez. Después ajustá cada detalle en las otras secciones (se puede deshacer).</p>
      <div class="pgrid">${Object.entries(PRESETS).map(([id, p]) => presetCard(id, p)).join('')}</div>
      <button class="ghost wide" data-act="factory" style="margin-top:12px">${icon('reset', { size: 14 })}Todo como viene de fábrica</button></div>`;
  }
  function renderTextbox() {
    const t = ui().textbox;
    const bmp = !!BUILTIN_FONTS[t.font]?.bitmap;
    const s = sample ?? {};
    return group('Letra', `
        ${fieldRow('Letra', fontSelect('textbox.font'))}
        ${bmp ? '<p class="help sm">Letra de píxeles proporcional, como la de Ocarina: incluye acentos, ñ, ¿ y ¡.</p>' : `
        ${fieldRow('Tamaño', range('textbox.fontSize', 5, 24, 1, ' px'))}
        ${fieldRow('Negrita', sw('textbox.bold'))}
        ${fieldRow('Píxeles duros', sw('textbox.crisp'), 'Sin bordes suavizados: cualquier letra queda como de consola vieja.')}`}
        ${fieldRow('Escala', range('textbox.baseHeight', 160, 360, 10), 'Alto de pantalla en que se dibuja la caja: <b>menos = caja y letra más grandes</b>. Ocarina: 240.')}`)
      + group('Colores', `
        ${fieldRow('Fondo', color('textbox.box'))}
        ${fieldRow('Borde', color('textbox.border', { none: true }))}
        ${t.border ? fieldRow('Grosor del borde', range('textbox.borderWidth', 1, 4, 1, ' px')) : ''}
        ${fieldRow('Texto', color('textbox.text', { alpha: false }))}
        ${fieldRow('Sombra', color('textbox.shadow', { none: true }))}
        ${fieldRow('Nombre', color('textbox.name', { alpha: false }))}
        ${fieldRow('Opciones', color('textbox.choice', { alpha: false }))}
        ${fieldRow('Flechita', color('textbox.cursor', { alpha: false }))}
        ${fieldRow('Indicador', color('textbox.more', { alpha: false }))}`)
      + group('Forma', `
        ${fieldRow('Posición', sel('textbox.position', [['bottom', 'Abajo'], ['top', 'Arriba'], ['middle', 'Al medio']]))}
        ${fieldRow('Nombre', sel('textbox.nameStyle', [['tab', 'Pestañita arriba'], ['inside', 'Primer renglón'], ['none', 'No mostrar']]))}
        ${fieldRow('Indicador', sel('textbox.moreStyle', [['triangle', '▼ Triángulo'], ['arrow', '► Flecha'], ['dot', '● Punto']]))}
        ${fieldRow('Renglones', range('textbox.lines', 1, 8))}
        ${fieldRow('Alto de renglón', range('textbox.lineHeight', 8, 24, 1, ' px'))}
        ${fieldRow('Ancho máximo', range('textbox.maxWidth', 120, 420, 4, ' px'))}
        ${fieldRow('Esquinas', range('textbox.radius', 0, 16, 1, ' px'))}
        ${fieldRow('Margen lateral', range('textbox.padX', 2, 30, 1, ' px'))}
        ${fieldRow('Margen arriba', range('textbox.padY', 2, 24, 1, ' px'))}
        ${fieldRow('Margen abajo', range('textbox.padBottom', 2, 24, 1, ' px'))}
        ${fieldRow('Al borde', range('textbox.bottom', 0, 60, 1, ' px'))}
        ${fieldRow('Alinear', sel('textbox.align', [['left', 'Izquierda'], ['center', 'Centro']]))}
        ${fieldRow('Texto corto', sel('textbox.valign', [['center', 'Al medio de la caja'], ['top', 'Arriba']]))}`, false)
      + group('Escritura y sonido', `
        ${fieldRow('Velocidad', range('textbox.cps', 10, 120, 1, ' letras/s'), 'Ocarina escribe a unas 45 letras por segundo.')}
        ${fieldRow('Sonido', `${sel('textbox.blip', BLIP_KINDS)}<button class="ib" data-act="blip" title="Escuchar">${icon('play', { size: 13 })}</button>`)}
        ${t.blip && t.blip !== 'ninguno' ? fieldRow('Tono', range('textbox.blipPitch', 0.5, 2, 0.05, '×')) : ''}`)
      + group('Texto de prueba', `
        <p class="help sm">Solo para la vista previa (no se guarda en el juego).</p>
        ${fieldRow('Quién habla', `<input data-sample="name" value="${esc(s.name ?? 'Tokse')}" spellcheck="false">`)}
        ${fieldRow('Texto', `<textarea data-sample="text" spellcheck="false">${esc(s.text ?? '¡Hola, viajero! Bienvenido a Coronda. El muelle queda pasando la plaza, junto a la torre del reloj.')}</textarea>`)}
        ${fieldRow('Opción 1', `<input data-sample="c0" value="${esc(s.choices?.[0] ?? '¿Qué hay para hacer?')}" spellcheck="false">`)}
        ${fieldRow('Opción 2', `<input data-sample="c1" value="${esc(s.choices?.[1] ?? 'Nada, gracias')}" spellcheck="false">`)}`, false);
  }
  function renderHud() {
    return group('Letra', `
        ${fieldRow('Letra', fontSelect('hud.font'))}
        ${fieldRow('Tamaño', range('hud.size', 10, 28, 1, ' px'))}
        ${fieldRow('Grosor', sel('hud.weight', [['400', 'Normal'], ['500', 'Medio'], ['600', 'Semi negrita'], ['700', 'Negrita']]))}
        ${fieldRow('Mayúsculas', sw('hud.uppercase'))}`)
      + group('Colores', `
        ${fieldRow('Fondo', color('hud.panel'))}
        ${fieldRow('Texto', color('hud.text', { alpha: false }))}
        ${fieldRow('Texto suave', color('hud.muted', { alpha: false }))}
        ${fieldRow('Acento', color('hud.accent', { alpha: false }))}
        ${fieldRow('Borde', color('hud.border'))}`)
      + group('Forma', `
        ${fieldRow('Esquinas', range('hud.radius', 0, 30, 1, ' px'))}
        ${fieldRow('Tecla', sel('hud.keyStyle', [['outline', 'Contorno'], ['solid', 'Llena'], ['round', 'Redonda']]))}
        ${fieldRow('Desenfoque', sw('hud.blur'), 'El fondo de los avisos difumina el juego de atrás.')}
        ${fieldRow('Sombra', sw('hud.shadow'))}
        ${fieldRow('Altura del aviso', range('hud.promptBottom', 4, 60, 1, ' %'))}
        ${fieldRow('Íconos en avisos', sw('hud.promptIcon'))}`)
      + group('Qué se muestra', `
        ${fieldRow('Ayuda de teclas', sw('hud.showHint'))}
        ${fieldRow('Botones de acciones', sw('hud.showActions'))}
        ${fieldRow('Lado de los botones', sel('hud.actionsSide', [['right', 'Derecha'], ['left', 'Izquierda']]))}
        <p class="help sm">Los botones de acciones salen solos de las animaciones <b>accion_*</b> del personaje.</p>`);
  }
  function renderTexts() {
    const t = ui().texts;
    return `<div class="sb" style="display:block;padding:12px">
      ${fieldRow('Puerta', `<input data-t="door" value="${esc(t.door)}" spellcheck="false">`)}
      ${fieldRow('Hablar', `<input data-t="talk" value="${esc(t.talk)}" spellcheck="false">`)}
      ${fieldRow('Tecla', `<input data-t="key" value="${esc(t.key)}" spellcheck="false" maxlength="8">`)}
      <p class="help" style="margin-top:10px">Son los textos de todos los avisos. Una puerta o un NPC pueden tener el suyo propio (<b>puerta_texto</b>, <b>npc_hablar_texto</b>): ese gana.</p></div>`;
  }
  function iconCell(ref, cur) {
    return `<button class="icell${ref === cur ? ' on' : ''}" data-icon="${esc(ref)}" title="${esc(ref.startsWith('file:') ? ref.slice(5).split('/').pop() : ref)}">${iconHTML(ref, { size: 20, stroke: 1.8 })}</button>`;
  }
  function renderIcons() {
    const t = ui();
    const slots = [
      { id: 'door', label: 'Aviso de puerta', ref: t.icons.door },
      { id: 'talk', label: 'Aviso de hablar', ref: t.icons.talk },
      ...actions.map((a) => ({ id: `action:${a.id}`, label: a.label, sub: 'Acción', ref: t.icons.actions[a.id] ?? '' })),
    ];
    if (!slots.some((s) => s.id === iconTarget)) iconTarget = 'door';
    const cur = slots.find((s) => s.id === iconTarget)?.ref ?? '';
    const mine = app.files.filter((p) => /^assets\/icons\/[^/]+\.(svg|png|webp|gif)$/i.test(p));
    return group('Dónde va', `<div class="islots">${slots.map((s) => `<button class="islot${s.id === iconTarget ? ' on' : ''}" data-slot="${esc(s.id)}">
          <span class="iv">${s.ref ? iconHTML(s.ref, { size: 18, stroke: 1.8 }) : '<i>—</i>'}</span><span class="tx"><b>${esc(s.label)}</b>${s.sub ? `<small>${s.sub}</small>` : ''}</span></button>`).join('')}</div>
        ${actions.length ? '' : '<p class="help sm">El personaje no tiene animaciones accion_* (los botones de acciones aparecen solos cuando las tiene).</p>'}
        ${fieldRow('Íconos en avisos', sw('hud.promptIcon'))}`)
      + group('Elegí un ícono', `<div class="igrid"><button class="icell none${!cur ? ' on' : ''}" data-icon="" title="Sin ícono">${icon('x', { size: 14 })}</button></div>
        ${ICON_GROUPS.map(([g, list]) => `<div class="igt">${esc(g)}</div><div class="igrid">${list.map((r) => iconCell(r, cur)).join('')}</div>`).join('')}
        <div class="igt">Importados <span class="muted">assets/icons</span></div>
        <div class="igrid">${mine.map((p) => iconCell(`file:${p}`, cur)).join('')}<button class="icell add" data-act="importIcon" title="Importar .svg o .png">${icon('upload', { size: 15 })}</button></div>
        <p class="help sm">Un ícono .svg se pinta con el color de acento si usa <b>currentColor</b>; un .png se ve tal cual.</p>`);
  }
  function renderFonts() {
    const t = ui();
    const used = (id) => [t.textbox.font === id && 'Caja', t.hud.font === id && 'Avisos'].filter(Boolean);
    const rows = fontList(t).map((f) => {
      const u = used(f.id);
      return `<div class="frow${u.length ? ' used' : ''}" data-font="${esc(f.id)}">
        <div class="fs" ${f.bitmap ? 'data-pixel' : `style="font-family:${esc(f.css)}"`}>${f.bitmap ? '' : 'Aa ¡Qué buen día en Coronda!'}</div>
        <div class="fm"><b>${esc(f.name)}</b><span class="chip">${esc(f.tag ?? '')}</span>${f.file ? `<small class="muted">${esc(f.file)}</small>` : ''}</div>
        <div class="fa"><button class="tg${t.textbox.font === f.id ? ' on' : ''}" data-use="textbox.font">Caja</button><button class="tg${t.hud.font === f.id ? ' on' : ''}" data-use="hud.font"${f.bitmap ? ' disabled title="La letra de píxeles es solo para la caja"' : ''}>Avisos</button>
          ${f.custom ? `<button class="ib sm" data-act="rmfont" title="Quitar de la lista (el archivo queda)">${icon('trash', { size: 13 })}</button>` : ''}</div></div>`;
    }).join('');
    return `<div class="sb" style="display:block;padding:12px">
      <button class="primary wide" data-act="importFont">${icon('upload', { size: 14, color: '#fff' })}Importar letra (.ttf .otf .woff .woff2)</button>
      <p class="help sm" style="margin:8px 0 12px">Se copia a <b>assets/fonts</b> y queda disponible para la caja, los avisos y los menús (pestaña Menús → Ajustes → Letra). Las de Google se descargan solas.</p>
      <div class="flist">${rows}</div></div>`;
  }
  function renderInspector() {
    const s = SECTIONS.find((x) => x.id === sec);
    const body = { estilo: renderEstilo, textbox: renderTextbox, hud: renderHud, texts: renderTexts, icons: renderIcons, fonts: renderFonts }[sec]();
    const open = new Set([...insp.querySelectorAll('.sec')].map((x, i) => (x.classList.contains('open') ? i : -1)));
    const keepOpen = insp.dataset.sec === sec;
    const scroll = keepOpen ? insp.parentElement.scrollTop : 0;
    insp.innerHTML = head(s) + body;
    insp.dataset.sec = sec;
    if (keepOpen) insp.querySelectorAll('.sec').forEach((x, i) => x.classList.toggle('open', open.has(i)));
    insp.parentElement.scrollTop = scroll;
    // muestras de letras
    const t = ui();
    insp.querySelectorAll('[data-pixel]').forEach((d) => d.append(pixelTextCanvas('Aa ¡Qué buen día en Coronda!', '#1c2130', 2)));
    if (sec === 'fonts') for (const f of fontList(t)) if (!f.bitmap) ensureFont(f.id, t);
  }

  // ---- eventos del inspector ----
  insp.addEventListener('click', async (e) => {
    const sh = e.target.closest('.sh');
    if (sh && !e.target.closest('button')) { sh.parentElement.classList.toggle('open'); return; }
    const p = e.target.closest('[data-preset]');
    if (p) { write((d) => { Object.assign(d, applyPreset(d, p.dataset.preset)); }, '', true); app.toast(`Estilo: ${PRESETS[p.dataset.preset].name}`); return; }
    const slot = e.target.closest('[data-slot]');
    if (slot) { iconTarget = slot.dataset.slot; renderInspector(); return; }
    const ic = e.target.closest('[data-icon]');
    if (ic) {
      const ref = ic.dataset.icon;
      write((d) => {
        d.icons ??= {};
        if (iconTarget.startsWith('action:')) { d.icons.actions ??= {}; const id = iconTarget.slice(7); if (ref) d.icons.actions[id] = ref; else delete d.icons.actions[id]; }
        else d.icons[iconTarget] = ref;
      }, '', true);
      return;
    }
    const use = e.target.closest('[data-use]');
    if (use && !use.disabled) { const id = use.closest('[data-font]').dataset.font; setVal(use.dataset.use, id, '', true); return; }
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'blip') blip(ui().textbox.blip, ui().textbox.blipPitch);
    if (act === 'factory') {
      const r = await app.ask('Todo de fábrica', 'La caja, los avisos, los textos y los íconos vuelven al estilo <b>Ocarina</b>. Las letras importadas se quedan.', [['cancel', 'Cancelar'], ['ok', 'Volver', 'primary']]);
      if (r === 'ok') write((d) => { for (const k of ['textbox', 'hud', 'texts', 'icons']) delete d[k]; d.preset = 'ocarina'; }, '', true);
    }
    if (act === 'reset') {
      const key = sec === 'textbox' ? 'textbox' : sec === 'hud' ? 'hud' : sec === 'texts' ? 'texts' : 'icons';
      write((d) => { const pr = PRESETS[d.preset ?? 'ocarina']; if (key === 'textbox' || key === 'hud') d[key] = { ...DEFAULT_UI[key], ...(pr?.[key] ?? {}) }; else delete d[key]; }, '', true);
    }
    if (act === 'importIcon') pickFiles('.svg,.png,.webp,.gif', async (files) => {
      const ok = await app.importFiles(files, 'assets/icons');
      if (ok?.length) { write((d) => { const ref = `file:${ok[ok.length - 1]}`; d.icons ??= {}; if (iconTarget.startsWith('action:')) { (d.icons.actions ??= {})[iconTarget.slice(7)] = ref; } else d.icons[iconTarget] = ref; }, '', true); }
    });
    if (act === 'importFont') pickFiles('.ttf,.otf,.woff,.woff2', importFonts);
    if (act === 'rmfont') {
      const id = b.closest('[data-font]').dataset.font;
      write((d) => {
        d.fonts = (d.fonts ?? []).filter((f) => f.id !== id);
        if (d.textbox?.font === id) d.textbox.font = 'spleen';
        if (d.hud?.font === id) d.hud.font = 'inter';
      }, '', true);
    }
  });
  function pickFiles(accept, cb) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.multiple = true;
    inp.onchange = () => { if (inp.files.length) cb([...inp.files]); };
    inp.click();
  }
  async function importFonts(files) {
    const added = [];
    for (const f of files) {
      if (!FONT_EXT.test(f.name)) { app.toast(`${f.name}: no es una letra (.ttf .otf .woff .woff2)`, true); continue; }
      const path = `assets/fonts/${f.name.replace(/[^\w.\- ]+/g, '_')}`;
      try { await app.api.write(path, f); } catch (err) { app.toast(err.message, true); continue; }
      const nice = f.name.replace(FONT_EXT, '').replace(/[-_]+/g, ' ').replace(/\b(regular|webfont)\b/ig, '').trim();
      added.push({ id: slug(nice) || slug(f.name), name: nice || f.name, file: path });
    }
    if (!added.length) return;
    await app.refreshFiles?.();
    write((d) => {
      d.fonts = (d.fonts ?? []).filter((x) => !added.some((a) => a.id === x.id));
      d.fonts.push(...added);
    }, '', true);
    app.toast(`Letra importada: ${added.map((a) => a.name).join(', ')} — elegí dónde usarla`);
  }

  insp.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.p && t.type === 'range') {
      const v = t.step && +t.step < 1 ? Math.round(+t.value * 100) / 100 : +t.value;
      const o = t.parentElement.querySelector('.uo');
      if (o) o.textContent = `${v}${o.textContent.replace(/^[-\d.]+/, '')}`;
      setVal(t.dataset.p, v);
      return;
    }
    if (t.dataset.c || t.dataset.ca) {
      const path = t.dataset.c ?? t.dataset.ca;
      const box = t.closest('.colora');
      const hex = box.querySelector('[data-c]').value;
      const a = box.querySelector('[data-ca]') ? +box.querySelector('[data-ca]').value / 100 : 1;
      const out = box.querySelector('output'); if (out) out.textContent = `${Math.round(a * 100)}%`;
      setVal(path, fmtColor(hex, a));
      return;
    }
    if (t.dataset.t) { write((d) => { (d.texts ??= {})[t.dataset.t] = t.value; }, `t.${t.dataset.t}`); return; }
    if (t.dataset.sample) {
      sample = {
        name: insp.querySelector('[data-sample="name"]').value,
        text: insp.querySelector('[data-sample="text"]').value,
        choices: [insp.querySelector('[data-sample="c0"]').value, insp.querySelector('[data-sample="c1"]').value],
      };
      localStorage.setItem(SAMPLE_KEY, JSON.stringify(sample));
      send();
    }
  });
  insp.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.none) {
      const path = t.dataset.none;
      const def = { 'textbox.border': '#ffffff', 'textbox.shadow': 'rgba(0, 0, 0, 0.85)' }[path] ?? '#000000';
      setVal(path, t.checked ? def : '', '', true);
      return;
    }
    if (!t.dataset.p || t.type === 'range') return;
    const v = t.type === 'checkbox' ? t.checked : t.dataset.p === 'hud.weight' ? +t.value : t.value;
    setVal(t.dataset.p, v, '', true);
  });

  // ---- datos del proyecto que usa la sección Íconos ----
  async function loadActions() {
    try {
      const cfg = await app.api.readJSON('data/tables/player.json').catch(() => ({}));
      const clips = await clipsOf(cfg.model ?? 'assets/models/objects/personaje.glb');
      const found = clips.map((c) => ({ name: c.name, ...parseActionName(c.name) })).filter((a) => a.id && !DOOR_CLIP_RE.test(a.name));
      for (const [id, o] of Object.entries(cfg.actions ?? {})) if (o?.clip && !found.some((f) => f.id === id)) found.push({ id });
      found.sort((a, b) => a.id.localeCompare(b.id));
      let i = 0;
      actions = found.filter((a) => !cfg.actions?.[a.id]?.hidden).map((a) => {
        const o = cfg.actions?.[a.id] ?? {};
        const n = i++;
        return { id: a.id, label: o.label ?? humanize(a.id), key: (o.key ?? (n < 9 ? `Digit${n + 1}` : '')).replace(/^(?:Digit|Key)/, '') };
      });
    } catch { actions = []; }
  }
  function fillBackgrounds() {
    const imgs = app.files.filter((p) => /^assets\/.*\.(png|jpe?g|webp)$/i.test(p) && !/^assets\/icons\//.test(p));
    bgSel.innerHTML = `<option value="">Paisaje</option>${imgs.map((p) => `<option value="${esc(p)}"${p === bg ? ' selected' : ''}>${esc(p.split('/').pop())}</option>`).join('')}`;
  }

  return {
    async show() {
      if (!doc) {
        const text = await app.api.read(PATH).catch(() => null);
        doc = fileDoc(PATH, text ?? '');
        await loadActions();
      }
      fillBackgrounds();
      setScene(scene);
      renderList(); bar(); renderInspector();
      send({ reloadMenus: true });
    },
    get dirty() { return !!doc?.dirty; },
    async save() {
      if (!doc?.dirty) return;
      await app.api.write(PATH, doc.text); doc.saved = doc.text; app.markOwnWrite(PATH);
      app.wsChanged(); bar(); app.toast('Interfaz guardada: el juego ya la usa');
    },
    undo() { if (doc?.undoOne()) { app.wsChanged(); bar(); renderList(); renderInspector(); send(); } },
    redo() { if (doc?.redoOne()) { app.wsChanged(); bar(); renderList(); renderInspector(); send(); } },
    async external(path) {
      if (path === PATH && doc && !doc.dirty) { doc.text = doc.saved = await app.api.read(PATH); renderList(); renderInspector(); send(); }
      if (path === 'data/menus.json') send({ reloadMenus: true });
    },
    refresh: () => { if (doc) { fillBackgrounds(); renderInspector(); } },
  };
}
