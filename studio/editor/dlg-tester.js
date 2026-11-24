// Probador de diálogos: reproduce una charla con las mismas reglas que src/systems/dialogue.js, sin abrir el juego.
// (Como el modo "test" de Yarn Spinner / Twine.) Los flags son de prueba: no tocan los guardados del juego.
import { esc } from './ws-common.js';
import { icon } from './components.js';

const CMP = /^(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/;
function check(cond, data) {
  if (!cond || typeof cond !== 'object') return true;
  return Object.entries(cond).every(([k, want]) => {
    const have = data[k];
    if (typeof want === 'boolean') return Boolean(have) === want;
    if (typeof want === 'string') {
      const m = CMP.exec(want.trim());
      if (m) { const a = Number(have) || 0, b = Number(m[2]); return { '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b, '==': a === b, '!=': a !== b }[m[1]]; }
    }
    return have === want;
  });
}
const pagesOf = (t) => (Array.isArray(t) ? t.map(String) : t == null ? [] : [String(t)]);

// flags que menciona un diálogo (condiciones, reglas de inicio, "set")
export function flagsIn(data, npcId) {
  const out = new Map(); // nombre -> { read, write }
  const add = (k, kind) => { if (!out.has(k)) out.set(k, { read: false, write: false }); out.get(k)[kind] = true; };
  if (npcId) { add(`hablo_${npcId}`, 'write'); add(`veces_${npcId}`, 'write'); }
  if (Array.isArray(data?.start)) for (const r of data.start) for (const k of Object.keys(r?.if ?? {})) add(k, 'read');
  for (const n of Object.values(data?.nodes ?? {})) {
    for (const k of Object.keys(n?.set ?? {})) add(k, 'write');
    for (const c of n?.choices ?? []) for (const k of Object.keys(c?.if ?? {})) add(k, 'read');
  }
  return out;
}

export function createDialogueTester(el, { getData, getNpc }) {
  let flags = {};
  let st = null; // { script, node, nodeId, pages, page, shown, choices, sel, trail }
  let timer = null;
  el.innerHTML = `<div class="dt">
    <div class="dt-head"><b>Probar</b><span class="spacer"></span>
      <button class="ghost sm" data-act="first" title="Como si nunca le hubieras hablado">Primera vez</button>
      <button class="ghost sm" data-act="again" title="Como si ya le hubieras hablado una vez">Ya habló</button>
      <button class="ib sm" data-act="restart" title="Empezar de nuevo">${icon('reset', { size: 14 })}</button></div>
    <div class="dt-screen"><div class="dt-anim" hidden></div><div class="dt-box" tabindex="0"><div class="dt-name"></div><div class="dt-text"></div><ul class="dt-choices"></ul><div class="dt-more"></div></div></div>
    <p class="dt-tip">Clic o <kbd>Enter</kbd> para seguir · <kbd>↑</kbd><kbd>↓</kbd> elegir opción</p>
    <div class="dt-sec"><div class="dt-st">Flags <small>(de prueba)</small></div><div class="dt-flags"></div></div>
    <div class="dt-sec"><div class="dt-st">Recorrido</div><ol class="dt-trail"></ol></div>
  </div>`;
  const $ = (s) => el.querySelector(s);
  const box = $('.dt-box');

  function renderFlags() {
    const known = flagsIn(getData(), getNpc()?.id);
    for (const k of Object.keys(flags)) if (!known.has(k)) known.set(k, { read: false, write: false });
    $('.dt-flags').innerHTML = known.size ? [...known.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, u]) => {
      const v = flags[k];
      const isNum = /^veces_/.test(k) || typeof v === 'number';
      const ctl = isNum ? `<input type="number" data-f="${esc(k)}" value="${esc(v ?? 0)}" min="0">`
        : typeof v === 'string' ? `<input data-f="${esc(k)}" value="${esc(v)}">`
          : `<label class="switch"><input type="checkbox" data-f="${esc(k)}"${v ? ' checked' : ''}><span></span></label>`;
      return `<div class="dt-flag"><code title="${u.read ? 'se lee' : ''}${u.read && u.write ? ' y ' : ''}${u.write ? 'se escribe' : ''} en este diálogo">${esc(k)}</code>${ctl}</div>`;
    }).join('') : '<p class="help">Este diálogo no usa flags.</p>';
  }
  function renderTrail() {
    $('.dt-trail').innerHTML = (st?.trail ?? []).map((t) => `<li${t.kind ? ` class="${t.kind}"` : ''}>${t.html}</li>`).join('');
    const ol = $('.dt-trail'); ol.scrollTop = ol.scrollHeight;
  }
  function paint() {
    if (!st) { $('.dt-name').textContent = ''; $('.dt-text').innerHTML = '<span class="dt-end">Fin de la charla.</span>'; $('.dt-choices').innerHTML = ''; $('.dt-more').textContent = ''; return; }
    const pg = st.pages[st.page] ?? { text: '' };
    $('.dt-name').textContent = st.name ?? '';
    $('.dt-text').textContent = [...pg.text].slice(0, Math.floor(st.shown)).join('');
    const done = st.shown >= [...pg.text].length;
    const last = st.page >= st.pages.length - 1;
    const showChoices = done && last && st.choices.length;
    $('.dt-choices').innerHTML = showChoices ? st.choices.map((c, i) => `<li class="${i === st.sel ? 'on' : ''}" data-i="${i}">${esc(c.text)}</li>`).join('') : '';
    $('.dt-more').textContent = done && !showChoices ? (last && !st.node.next ? '■' : '▼') : '';
  }
  function anim(name) {
    const a = $('.dt-anim');
    a.hidden = name === undefined;
    if (name !== undefined) { a.innerHTML = `${icon('play', { size: 11 })} ${name === '' ? 'vuelve al idle' : esc(name)}`; a.classList.remove('pop'); void a.offsetWidth; a.classList.add('pop'); }
  }
  function type() {
    clearInterval(timer);
    const len = [...(st.pages[st.page]?.text ?? '')].length;
    timer = setInterval(() => { if (!st) return clearInterval(timer); st.shown = Math.min(len, st.shown + 1); paint(); if (st.shown >= len) clearInterval(timer); }, 28);
  }
  function goto(id) {
    const data = st.script;
    const raw = data.nodes?.[id];
    if (!raw) { st.trail.push({ kind: 'err', html: `No existe el nodo <b>${esc(id)}</b>` }); end(); return; }
    st.nodeId = id;
    st.trail.push({ html: `<b>${esc(id)}</b>` });
    if (raw.set && typeof raw.set === 'object') for (const [k, v] of Object.entries(raw.set)) { flags[k] = v; st.trail.push({ kind: 'set', html: `${esc(k)} = ${esc(JSON.stringify(v))}` }); }
    st.node = { next: raw.next ?? null, speaker: raw.speaker ?? null };
    st.choices = (raw.choices ?? []).filter((c) => check(c?.if, flags) && c?.text).map((c) => ({ text: String(c.text), next: c.next ?? null }));
    const hidden = (raw.choices ?? []).length - st.choices.length;
    if (hidden > 0) st.trail.push({ kind: 'note', html: `${hidden} opción${hidden > 1 ? 'es' : ''} oculta${hidden > 1 ? 's' : ''} por su condición` });
    if (raw.anim !== undefined) anim(raw.anim); else anim(undefined);
    st.pages = (pagesOf(raw.text).length ? pagesOf(raw.text) : ['']).map((txt) => {
      let a;
      const mark = /\{([^{}]*)\}/.exec(txt);
      if (mark) { a = mark[1]; txt = (txt.slice(0, mark.index) + txt.slice(mark.index + mark[0].length)).trim(); }
      return { text: txt.replace(/\\n/g, '\n'), anim: a };
    });
    st.page = 0; st.sel = 0;
    st.name = st.node.speaker ?? data.speaker ?? getNpc()?.label ?? '';
    showPage();
    renderFlags(); renderTrail();
  }
  function showPage() {
    const pg = st.pages[st.page];
    if (pg.anim !== undefined) anim(pg.anim);
    st.shown = matchMedia('(prefers-reduced-motion: reduce)').matches ? [...pg.text].length : 0;
    paint(); type();
  }
  function end() { clearInterval(timer); st = null; anim(undefined); paint(); renderFlags(); }
  function start() {
    clearInterval(timer);
    const data = getData();
    const npc = getNpc();
    st = { script: data, trail: [], page: 0, shown: 0, choices: [], sel: 0, pages: [] };
    let id = data.start;
    if (Array.isArray(data.start)) {
      id = undefined;
      for (const r of data.start) if (r?.goto && check(r.if, flags)) { id = r.goto; st.trail.push({ kind: 'note', html: `Arranca por la regla ${r.if ? esc(Object.entries(r.if).map(([k, v]) => `${k}${typeof v === 'string' && CMP.test(v) ? v : v === false ? ' = no' : v === true ? '' : ` = ${v}`}`).join(', ')) : 'sin condición'}` }); break; }
    }
    id ??= Object.keys(data.nodes ?? {})[0];
    if (npc?.id) { flags[`hablo_${npc.id}`] = true; flags[`veces_${npc.id}`] = (Number(flags[`veces_${npc.id}`]) || 0) + 1; }
    if (!id) { st.trail.push({ kind: 'err', html: 'El diálogo no tiene nodos' }); end(); return; }
    goto(id);
  }
  function advance() {
    if (!st) { start(); return; }
    const len = [...(st.pages[st.page]?.text ?? '')].length;
    if (st.shown < len) { st.shown = len; clearInterval(timer); paint(); return; }
    const last = st.page >= st.pages.length - 1;
    if (last && st.choices.length) { choose(st.sel); return; }
    if (!last) { st.page++; showPage(); return; }
    if (st.node.next) goto(st.node.next); else { st.trail.push({ kind: 'note', html: 'Fin' }); renderTrail(); end(); }
  }
  function choose(i) {
    const c = st.choices[i]; if (!c) return;
    st.trail.push({ kind: 'pick', html: `“${esc(c.text)}”` });
    if (c.next) goto(c.next); else { st.trail.push({ kind: 'note', html: 'Fin' }); renderTrail(); end(); }
  }

  box.addEventListener('click', (e) => { const li = e.target.closest('.dt-choices li'); if (li && st) { choose(+li.dataset.i); return; } advance(); });
  box.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyE') { e.preventDefault(); advance(); }
    if (st?.choices.length && (e.code === 'ArrowDown' || e.code === 'ArrowUp')) { e.preventDefault(); st.sel = (st.sel + (e.code === 'ArrowDown' ? 1 : -1) + st.choices.length) % st.choices.length; paint(); }
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const npc = getNpc();
    if (b.dataset.act === 'first') { flags = {}; start(); }
    if (b.dataset.act === 'again') { flags = npc?.id ? { [`hablo_${npc.id}`]: true, [`veces_${npc.id}`]: 1 } : {}; start(); }
    if (b.dataset.act === 'restart') start();
    box.focus();
  });
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.f; if (!k) return;
    flags[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
  });

  return {
    open() { flags = {}; start(); box.focus(); },
    refresh() { renderFlags(); }, // el diálogo cambió: los flags conocidos pueden ser otros (la charla sigue con el texto nuevo)
    stop() { clearInterval(timer); },
  };
}
