// Vista previa de la interfaz del juego (va dentro de un iframe en la pestaña Interfaz del motor).
// Recibe por postMessage { type: 'ui', theme, scene, sample, actions, sound, bg } y dibuja con el mismo código que el juego:
// css/style.css + ui/theme.js (avisos, botones, letras) + ui/textbox-paint.js (caja de diálogo) + ui/menus.js.
import { applyUI, promptHTML, iconHTML, setAssetBase, getUI, uiText, blip } from '/src/ui/theme.js';
import { createTextPainter, setStyle, STYLE } from '/src/ui/textbox-paint.js';
import { renderMenu, DEFAULT_MENUS } from '/src/ui/menus.js';

setAssetBase('/');
const $ = (id) => document.getElementById(id);
const app = $('app'), stage = $('stage'), tb = $('tb');
const painter = createTextPainter();
const tctx = tb.getContext('2d');

let cfg = {
  theme: {}, scene: 'charla', sound: false, bg: '',
  sample: { name: 'Tokse', text: '¡Hola, viajero! Bienvenido a Coronda. El muelle queda pasando la plaza, junto a la torre del reloj.', choices: ['¿Qué hay para hacer?', 'Nada, gracias'] },
  actions: [{ id: 'saludar', label: 'Saludar', key: '1' }, { id: 'sentarse', label: 'Sentarse', key: '2' }],
};
let menusDef = null;
fetch('/data/menus.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((m) => { menusDef = m ?? DEFAULT_MENUS; if (/pausa|titulo/.test(cfg.scene)) build(); });

// ---- Simulación de una charla (misma lógica de tiempos que systems/dialogue.js) ----
let sim = null;
function restart() {
  const withChoices = cfg.scene === 'opciones';
  const choices = withChoices ? (cfg.sample.choices ?? []).filter(Boolean) : [];
  const pages = painter.paginate(cfg.sample.text || ' ', choices.length);
  sim = { pages, page: 0, shown: 0, wait: 0, choices, choiceShown: 0, choiceTotal: choices.reduce((a, c) => a + [...c].length, 0), picking: false, sel: 0, t: 0 };
}
function paint() {
  if (!sim) return;
  const pg = sim.pages[sim.page];
  const done = sim.shown >= pg.count;
  const last = sim.page >= sim.pages.length - 1;
  const choicesNow = last && done && sim.choices.length;
  painter.show({
    name: cfg.sample.name || '',
    page: pg,
    shown: Math.floor(sim.shown),
    choices: sim.choices,
    choicesVisible: !!choicesNow && sim.wait <= 0,
    choiceShown: sim.picking ? Infinity : Math.floor(sim.choiceShown),
    picking: sim.picking,
    reserve: last ? sim.choices.length : 0,
    sel: sim.sel,
    more: !done || (last && sim.choices.length) ? null : last ? 'end' : 'next',
  });
}
function step(dt) {
  if (!sim || !/charla|opciones/.test(cfg.scene)) return;
  const pg = sim.pages[sim.page];
  const cps = Math.max(1, Number(STYLE.cps) || 45);
  const last = sim.page >= sim.pages.length - 1;
  if (sim.shown < pg.count) {
    const before = Math.floor(sim.shown);
    sim.shown = Math.min(pg.count, sim.shown + cps * dt);
    const now = Math.floor(sim.shown);
    if (cfg.sound && now !== before && STYLE.blip && STYLE.blip !== 'ninguno') {
      const flat = pg.lines.flat();
      for (let i = before; i < now; i++) if (i % 2 === 0 && flat[i]?.ch.trim()) { blip(STYLE.blip, STYLE.blipPitch ?? 1, 0.8); break; }
    }
    if (sim.shown >= pg.count) sim.wait = last && sim.choices.length ? 0.35 : 1.6;
    paint();
    return;
  }
  if (last && sim.choices.length) {
    if (sim.wait > 0) { sim.wait -= dt; if (sim.wait <= 0) paint(); return; }
    if (!sim.picking) {
      const before = Math.floor(sim.choiceShown);
      sim.choiceShown = Math.min(sim.choiceTotal, sim.choiceShown + cps * dt);
      if (sim.choiceShown >= sim.choiceTotal) { sim.picking = true; sim.t = 0; }
      if (sim.picking || Math.floor(sim.choiceShown) !== before) paint();
      return;
    }
    sim.t += dt;
    if (sim.t > 1.1) { sim.t = 0; sim.sel = (sim.sel + 1) % sim.choices.length; if (sim.sel === 0) sim.loops = (sim.loops ?? 0) + 1; paint(); }
    if ((sim.loops ?? 0) >= 2) restart();
    return;
  }
  sim.wait -= dt;
  if (sim.wait <= 0) { if (last) restart(); else { sim.page++; sim.shown = 0; } paint(); }
}

// ---- Armado de la pantalla ----
function build() {
  const t = getUI();
  const sc = cfg.scene;
  stage.classList.toggle('img', !!cfg.bg);
  stage.style.background = cfg.bg ? `#000 url("/${cfg.bg}") center / cover no-repeat` : '';
  const talking = /charla|opciones/.test(sc);
  app.classList.toggle('talking', talking);
  $('door').hidden = sc !== 'juego';
  $('talk').hidden = sc !== 'hablar';
  $('door').innerHTML = promptHTML({ label: uiText('door'), icon: t.icons.door });
  $('talk').innerHTML = promptHTML({ label: uiText('talk'), icon: t.icons.talk });
  const acts = $('actions');
  acts.hidden = !(sc === 'juego' || sc === 'hablar') || !cfg.actions.length;
  acts.innerHTML = '';
  for (const a of cfg.actions) {
    const b = document.createElement('button');
    b.type = 'button';
    if (a.key) { const k = document.createElement('kbd'); k.textContent = a.key; b.append(k, ' '); }
    const ic = t.icons.actions?.[a.id];
    if (ic) b.insertAdjacentHTML('beforeend', iconHTML(ic));
    const s = document.createElement('span'); s.textContent = a.label; b.append(s);
    acts.append(b);
  }
  $('hint').hidden = talking || /pausa|titulo/.test(sc);
  const host = $('menuHost');
  host.innerHTML = '';
  if (/pausa|titulo/.test(sc) && menusDef) {
    const kind = sc === 'pausa' ? 'pause' : 'title';
    const def = Object.values(menusDef.menus ?? {}).find((m) => m.kind === kind);
    if (def) renderMenu(host, def, { settings: menusDef.settings ?? {}, preview: true, selected: 0 });
  }
  if (talking) { if (!sim || sim.kind !== sc) { restart(); sim.kind = sc; } paint(); } else { sim = null; painter.hide(); }
}

let gen = 0;
async function apply() {
  const my = ++gen;
  const t = await applyUI(cfg.theme, { scope: '.app' });
  if (my !== gen) return;
  setStyle(t.textbox);
  sim = null; // otra letra u otro tamaño: hay que volver a partir el texto
  build();
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'ui') return;
  const { type, ...all } = e.data;
  const rest = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined));
  const sceneChanged = rest.scene && rest.scene !== cfg.scene;
  cfg = { ...cfg, ...rest };
  if (rest.reloadMenus) fetch('/data/menus.json', { cache: 'no-store' }).then((r) => r.json()).then((m) => { menusDef = m; build(); }).catch(() => {});
  if (rest.theme || rest.sample || sceneChanged) apply(); else build();
});

// Clic en una parte -> el motor abre esa sección
app.addEventListener('click', (e) => {
  const r = stage.getBoundingClientRect();
  const { W, H } = painter.size();
  const hit = painter.pick(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
  const sec = hit ? 'textbox' : e.target.closest('[data-sel]')?.dataset.sel;
  if (sec) parent.postMessage({ type: 'ui-pick', section: sec }, location.origin);
});

let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  painter.fit(stage.clientWidth || 320, stage.clientHeight || 240);
  step(dt);
  painter.update(dt);
  if (painter.dirty) {
    painter.draw();
    const { W, H } = painter.size();
    if (tb.width !== W || tb.height !== H) { tb.width = W; tb.height = H; }
    tctx.clearRect(0, 0, W, H);
    tctx.drawImage(painter.canvas, 0, 0);
  }
}
requestAnimationFrame(frame);
apply();
parent.postMessage({ type: 'ui-ready' }, location.origin);
