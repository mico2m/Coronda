// Diálogos con NPC. Al acercarte a un NPC con diálogo aparece "E Hablar"; al apretar E (o tocar el aviso)
// se abre la caja de texto. E / Espacio / Enter / tocar la pantalla avanzan. Escape la cierra.
// La caja se dibuja DENTRO de la imagen del juego, con letra de píxeles, como en Ocarina (ver ui/textbox.js):
// los textos largos se parten solos en varias cajas de 4 renglones.
//
// Cómo se arma, en Blender (Object Properties > Custom Properties del Empty npc_*; tildá Include > Custom Properties al exportar):
//   npc_texto         = "Hola|¿Cómo andás?"   frases sueltas; cada "|" es una página nueva (y "\n" un salto de línea)
//                       Con {clip} el NPC hace esa animación al llegar a esa página: "¡Hola!{saludar_vuelve}|¿Cómo andás?{}"
//                       ({} vuelve al idle). La marca no se ve en pantalla. También sirve dentro de los textos del JSON.
//   npc_dialogo       = "tokse"               conversación con opciones: usa data/dialogues/tokse.json (ver README)
//   npc_nombre        = "Tokse"               nombre que se ve arriba de la caja (por defecto, el del Empty sin "npc_")
//   npc_texto_repetir = "Ah, sos vos|¿Algo más?"  lo que dice de la 2ª vez en adelante (como los Kokiri de Ocarina)
//   npc_pone          = "conoce_tokse"       flag(s) que se prenden al hablarle (varios con coma); ver flags.js
//   npc_hablar_radio  = 2.5                   a cuántos metros aparece el aviso
//   npc_hablar_texto  = "Hablar"              lo que dice el aviso
//   npc_mirar         = 1                     0 = el NPC no se da vuelta hacia vos
//   npc_anim_hablar   = "hablar"              animación del NPC (un clip de su .glb) mientras dura la charla
// Si tiene las dos, manda npc_dialogo; si ese archivo no se puede leer, se usa npc_texto.
// También se puede definir en el JSON de la escena (actors): "dialogue", "text", "speaker", "talkRadius", "talkLabel", "look".
//
// Formato de data/dialogues/<id>.json:
//   { "speaker": "Tokse", "start": "inicio",
//     "nodes": {
//       "inicio": { "text": ["Hola.", "¿Qué necesitás?"], "next": "menu" },
//       "menu":   { "text": "Elegí.", "choices": [ { "text": "Nada", "next": "chau" }, { "text": "Contame", "next": "inicio" } ] },
//       "chau":   { "text": "Nos vemos." } } }
// Cada nodo tiene "text" (un texto o una lista de páginas), y opcionalmente "choices" (opciones), "next" (a qué nodo
// sigue al terminar de leer), "speaker" y "anim" (clip del NPC que se reproduce al llegar a ese nodo; "" = vuelve al idle;
// si termina en "_vuelve" se reproduce una vez y vuelve solo). Sin "next" ni "choices" la conversación termina.
// Una opción sin "next" también termina.
// Memoria (ver flags.js): "start" puede ser una lista de reglas; gana la primera cuya condición se cumple:
//   "start": [ { "if": { "hablo_tokse": true }, "goto": "otra_vez" }, { "goto": "inicio" } ]
// Un nodo puede tener "set": { "flag": true } (se aplica al llegar) y una opción puede tener "if" (solo aparece si se cumple). Al cerrarse la charla el NPC vuelve a su animación de siempre.
import { loadJSON } from '../core/assets.js';
import { flags } from './flags.js';

import { STYLE } from '../ui/textbox-paint.js';
import { promptHTML, uiText, getUI, blip } from '../ui/theme.js';
const DIR = 'data/dialogues/';
const cps = () => Math.max(1, Number(STYLE.cps) || 45); // letras por segundo de la máquina de escribir (data/ui.json)
const CHOICE_PAUSE = 0.35; // segundos de pausa entre la pregunta y las opciones (que después se escriben como el texto)
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const dialoguePath = (id) => (/[\\/]/.test(id) ? id : `${DIR}${id.replace(/\.json$/i, '')}.json`);

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  parent?.appendChild(e);
  return e;
}

export function createDialogue({ stage, npcs, textbox, onStart, onEnd, onError }) {
  const host = stage.parentElement;
  let entries = [];     // NPC con algo para decir
  let near = null;      // NPC al alcance
  let busy = false;     // cargando el archivo del diálogo
  let cooldownUntil = 0;
  const focus = { x: 0, y: 0, z: 0 };
  let s = null;         // conversación en curso

  // ---- Aviso "E Hablar" ----
  const prompt = el('button', 'talk-prompt', host);
  prompt.type = 'button';
  prompt.hidden = true;
  prompt.addEventListener('click', () => { if (near) start(near); });

  // ---- Caja de diálogo: la dibuja textbox (dentro del juego). Acá queda solo el texto para lectores de pantalla ----
  const sr = el('p', 'sr-only', host);
  sr.setAttribute('aria-live', 'polite');

  // Tocar o hacer clic en la pantalla durante la charla: elige la opción tocada o avanza (si no fue un arrastre)
  let down = null;
  stage.addEventListener('pointerdown', (e) => { if (s) down = { x: e.clientX, y: e.clientY }; });
  stage.addEventListener('pointerup', (e) => {
    if (!s || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 8) return;
    const hit = textbox.pick(e.clientX, e.clientY);
    if (hit?.choice !== undefined && s.picking) { s.sel = hit.choice; choose(hit.choice); } else advance();
  });
  stage.addEventListener('pointermove', (e) => { // con el mouse, la opción bajo el puntero queda elegida
    if (!s?.picking || e.pointerType !== 'mouse') return;
    const hit = textbox.pick(e.clientX, e.clientY);
    if (hit?.choice !== undefined && hit.choice !== s.sel) { s.sel = hit.choice; paint(); }
  });

  // ---- Armado de la conversación ----
  const asPages = (t) => (Array.isArray(t) ? t.map(String) : t === undefined || t === null ? [] : [String(t)]);

  function normalize(raw = {}) {
    return {
      speaker: raw.speaker ? String(raw.speaker) : null,
      pages: asPages(raw.text),
      next: raw.next ?? null,
      choices: (Array.isArray(raw.choices) ? raw.choices : [])
        .filter((c) => flags.check(c?.if))
        .map((c) => ({ text: String(c?.text ?? ''), next: c?.next ?? null }))
        .filter((c) => c.text),
    };
  }

  // "start" puede ser un nodo, o una lista de reglas { if, goto } evaluadas en orden con los flags
  function pickStart(start, nodes) {
    if (Array.isArray(start)) {
      for (const r of start) if (r?.goto && flags.check(r.if)) return r.goto;
      return Object.keys(nodes)[0];
    }
    return start ?? Object.keys(nodes)[0];
  }

  async function buildScript(entry) {
    const t = entry.talk;
    if (t.dialogue) {
      try {
        const data = await loadJSON(dialoguePath(t.dialogue));
        const nodes = data.nodes ?? {};
        const start = pickStart(data.start, nodes);
        if (!nodes[start]) throw new Error(`no tiene el nodo inicial "${start}"`);
        return { nodes, start, speaker: data.speaker ? String(data.speaker) : null };
      } catch (err) {
        console.warn(`Diálogo "${t.dialogue}" de ${entry.id}: ${err.message}`);
        if (!t.pages.length) throw err;
      }
    }
    const again = t.repeatPages.length && flags.get(`hablo_${entry.id}`);
    return { nodes: { start: { text: again ? t.repeatPages : t.pages } }, start: 'start', speaker: null };
  }

  // ---- Inicio y fin ----
  async function start(entry) {
    if (s || busy || performance.now() < cooldownUntil) return;
    busy = true;
    setNear(null);
    let script;
    try {
      script = await buildScript(entry);
    } catch (err) {
      console.error(err);
      onError?.(`Diálogo: ${err.message}`);
      busy = false;
      return;
    }
    busy = false;
    // Recordar que ya le hablaste (después de elegir qué decir, así la 1ª vez sale el texto de la 1ª vez)
    flags.set(`hablo_${entry.id}`, true);
    flags.inc(`veces_${entry.id}`);
    for (const f of entry.talk.sets) flags.set(f, true);
    host.classList.add('talking'); // esconde la ayuda y los botones mientras se habla
    s = { entry, script, node: null, pages: [], page: 0, count: 0, shown: 0, choices: [], sel: 0, picking: false };
    onStart?.(entry);
    npcs.hold?.(entry); // si el NPC está caminando, se frena
    if (entry.talk.look) npcs.faceTowards(entry, focus.x, focus.z);
    if (entry.talk.talkAnim) npcs.play(entry, entry.talk.talkAnim);
    goto(script.start);
  }

  function end() {
    if (!s) return;
    const entry = s.entry;
    s = null;
    host.classList.remove('talking');
    textbox.hide();
    sr.textContent = '';
    npcs.release(entry);
    cooldownUntil = performance.now() + 250; // evita que el mismo toque de E vuelva a abrir la charla
    onEnd?.(entry);
  }

  function goto(id) {
    const raw = s.script.nodes[id];
    if (!raw) { console.warn(`Diálogo: no existe el nodo "${id}".`); end(); return; }
    if (raw.set && typeof raw.set === 'object') for (const [k, v] of Object.entries(raw.set)) flags.set(k, v);
    s.node = normalize(raw);
    if (raw.anim !== undefined) npcs.play(s.entry, raw.anim); // sin "anim" sigue la que estaba
    // Cada página del texto se parte en las cajas que hagan falta (4 renglones). La última deja lugar a las opciones.
    // Una marca {clip} se saca del texto y se ejecuta al mostrar la primera caja de esa página.
    const src = s.node.pages.length ? s.node.pages : [''];
    s.pages = [];
    src.forEach((txt, i) => {
      let anim;
      const mark = /\{([^{}]*)\}/.exec(txt);
      if (mark) { anim = mark[1]; txt = (txt.slice(0, mark.index) + txt.slice(mark.index + mark[0].length)).trim(); }
      const last = i === src.length - 1;
      const boxes = textbox.paginate(txt, last ? s.node.choices.length : 0);
      boxes.forEach((b, j) => s.pages.push({ ...b, anim: j === 0 ? anim : undefined }));
    });
    s.page = 0;
    showPage();
  }

  function showPage() {
    const pg = s.pages[s.page];
    if (pg.anim !== undefined) npcs.play(s.entry, pg.anim);
    s.count = pg.count;
    s.shown = reduceMotion() ? s.count : 0;
    s.picking = false;
    s.choices = [];
    s.choiceTotal = 0;
    s.choiceShown = 0;
    s.choiceWait = 0;
    s.sel = 0;
    s.name = s.node.speaker ?? s.entry.talk.speaker ?? s.script.speaker ?? s.entry.talk.defaultSpeaker;
    sr.textContent = pg.text.replace(/\n/g, ' ');
    paint();
    if (s.shown >= s.count) pageDone();
  }

  // Le pasa a la caja lo que tiene que dibujar
  function paint() {
    const done = s.shown >= s.count;
    const more = !done || s.choices.length ? null
      : s.page < s.pages.length - 1 || s.node.next ? 'next' : 'end';
    textbox.show({
      name: s.name,
      page: s.pages[s.page],
      shown: Math.floor(s.shown),
      choices: s.choices.map((c) => c.text),
      choicesVisible: s.choices.length > 0,
      choiceShown: s.picking ? Infinity : Math.floor(s.choiceShown), // letras de las opciones ya escritas
      picking: s.picking, // la flechita aparece recién cuando se puede elegir
      reserve: s.page === s.pages.length - 1 ? s.node.choices.length : 0, // lugar para las opciones que vienen
      sel: s.sel,
      more,
    });
  }

  // La página terminó de escribirse: aparecen las opciones (en la última página) o el triángulo
  function pageDone() {
    const last = s.page >= s.pages.length - 1;
    if (last && s.node.choices.length) {
      // Las opciones se escriben después de la pregunta, con una pausita antes (como en Ocarina)
      s.choices = s.node.choices;
      s.choiceTotal = s.choices.reduce((a, c) => a + [...c.text].length, 0);
      s.choiceShown = 0;
      s.choiceWait = reduceMotion() ? 0 : CHOICE_PAUSE;
      if (reduceMotion()) { s.choiceShown = s.choiceTotal; s.picking = true; }
      sr.textContent = `${s.pages[s.page].text.replace(/\n/g, ' ')} Opciones: ${s.choices.map((c, i) => `${i + 1}. ${c.text}`).join('. ')}`;
    }
    paint();
  }

  function choose(i) {
    const c = s?.choices[i];
    if (!c) return;
    if (c.next) goto(c.next); else end();
  }

  function advance() {
    if (!s) return;
    if (s.shown < s.count) { s.shown = s.count; pageDone(); return; } // completa la página
    if (s.choices.length && !s.picking) { s.choiceShown = s.choiceTotal; s.picking = true; paint(); return; } // completa las opciones
    if (s.picking) { choose(s.sel); return; }
    if (s.page < s.pages.length - 1) { s.page++; showPage(); return; }
    if (s.node.next) goto(s.node.next); else end();
  }

  // ---- Teclado ----
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!s) {
      if (e.code === 'KeyE' && !e.repeat && near) start(near);
      return;
    }
    if (e.code === 'Escape') { end(); e.preventDefault(); return; }
    if (s.picking && /^Digit[1-9]$/.test(e.code)) {
      const i = Number(e.code.slice(5)) - 1;
      if (i < s.choices.length) { s.sel = i; choose(i); }
      e.preventDefault();
      return;
    }
    if (s.picking && (e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'ArrowDown' || e.code === 'KeyS')) {
      const dir = e.code === 'ArrowUp' || e.code === 'KeyW' ? -1 : 1;
      s.sel = (s.sel + dir + s.choices.length) % s.choices.length;
      paint();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') {
      if (!e.repeat) advance();
      e.preventDefault();
    }
  });

  // "Bip" de las letras (data/ui.json > textbox.blip): uno cada 2 letras que no sean espacios, como en los juegos de la época
  function letterSound(from, to) {
    if (!STYLE.blip || STYLE.blip === 'ninguno') return;
    const pg = s.pages[s.page];
    const flat = pg.lines.flat();
    for (let i = from; i < to; i++) if (i % 2 === 0 && flat[i] && flat[i].ch.trim()) { blip(STYLE.blip, STYLE.blipPitch ?? 1); break; }
  }

  // ---- Aviso de cercanía ----
  function setNear(entry) {
    if (entry === near) return;
    near = entry;
    prompt.hidden = !near;
    if (near) {
      prompt.innerHTML = promptHTML({ label: near.talk.label || uiText('talk'), icon: getUI().icons.talk });
    }
  }

  return {
    // Llamar después de cargar cada escena (npcs.setup).
    setup() {
      end();
      busy = false;
      setNear(null);
      entries = npcs.list.filter((n) => n.talk);
    },
    get active() { return !!s; },
    // true mientras haya una charla, se esté cargando una o haya un NPC al alcance: las puertas esperan.
    get blocked() { return !!s || busy || !!near; },

    // `p`: punto del jugador (o de la cámara libre) que se compara con cada NPC
    update(p, dt) {
      focus.x = p.x; focus.y = p.y; focus.z = p.z;
      if (s) {
        textbox.update(dt);
        if (s.shown < s.count) {
          const before = Math.floor(s.shown);
          s.shown = Math.min(s.count, s.shown + cps() * dt);
          if (Math.floor(s.shown) !== before) letterSound(before, Math.floor(s.shown));
          if (s.shown >= s.count) pageDone();
          else if (Math.floor(s.shown) !== before) paint();
        } else if (s.choices.length && !s.picking) { // escribiendo las opciones
          if (s.choiceWait > 0) s.choiceWait -= dt;
          else {
            const before = Math.floor(s.choiceShown);
            s.choiceShown = Math.min(s.choiceTotal, s.choiceShown + cps() * dt);
            if (s.choiceShown >= s.choiceTotal) s.picking = true;
            if (s.picking || Math.floor(s.choiceShown) !== before) paint();
          }
        }
        return;
      }
      let best = null, bestD = Infinity;
      if (!busy && performance.now() >= cooldownUntil) {
        for (const n of entries) {
          const hp = n.holder.position;
          const dy = p.y - hp.y;
          if (dy < -1.5 || dy > 4) continue; // otro piso
          const d = Math.hypot(p.x - hp.x, p.z - hp.z);
          if (d < n.talk.radius && d < bestD) { best = n; bestD = d; }
        }
      }
      setNear(best);
    },
  };
}
