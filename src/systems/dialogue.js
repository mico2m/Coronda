// Diálogos con NPC. Al acercarte a un NPC con diálogo aparece "E Hablar"; al apretar E (o tocar el aviso)
// se abre una caja de texto abajo. E / Espacio / Enter / tocar la caja avanzan. Escape la cierra.
//
// Cómo se arma, en Blender (Object Properties > Custom Properties del Empty npc_*; tildá Include > Custom Properties al exportar):
//   npc_texto         = "Hola|¿Cómo andás?"   frases sueltas; cada "|" es una página nueva (y "\n" un salto de línea)
//   npc_dialogo       = "tokse"               conversación con opciones: usa data/dialogues/tokse.json (ver README)
//   npc_nombre        = "Tokse"               nombre que se ve arriba de la caja (por defecto, el del Empty sin "npc_")
//   npc_hablar_radio  = 2.5                   a cuántos metros aparece el aviso
//   npc_hablar_texto  = "Hablar"              lo que dice el aviso
//   npc_mirar         = 1                     0 = el NPC no se da vuelta hacia vos
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
// sigue al terminar de leer) y "speaker". Sin "next" ni "choices" la conversación termina. Una opción sin "next" también termina.
import { loadJSON } from '../core/assets.js';

const DIR = 'data/dialogues/';
const CPS = 45; // letras por segundo de la máquina de escribir
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const dialoguePath = (id) => (/[\\/]/.test(id) ? id : `${DIR}${id.replace(/\.json$/i, '')}.json`);

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  parent?.appendChild(e);
  return e;
}

export function createDialogue({ stage, npcs, onStart, onEnd, onError }) {
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

  // ---- Caja de diálogo ----
  const box = el('div', 'dialogue', host);
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Diálogo');
  const nameEl = el('div', 'dialogue-name', box);
  const textEl = el('p', 'dialogue-text', box);
  textEl.setAttribute('aria-hidden', 'true'); // se escribe letra por letra: los lectores de pantalla leen sr (abajo)
  const shownEl = el('span', 'dialogue-shown', textEl);
  const restEl = el('span', 'dialogue-rest', textEl); // el resto, invisible, para que la caja no cambie de tamaño
  const choicesEl = el('div', 'dialogue-choices', box);
  const moreEl = el('span', 'dialogue-more', box);
  moreEl.textContent = '▼';
  moreEl.hidden = true;
  const sr = el('p', 'sr-only', box);
  sr.setAttribute('aria-live', 'polite');
  box.addEventListener('click', (e) => { if (!e.target.closest('.dialogue-choice')) advance(); });

  // ---- Armado de la conversación ----
  const asPages = (t) => (Array.isArray(t) ? t.map(String) : t === undefined || t === null ? [] : [String(t)]);

  function normalize(raw = {}) {
    return {
      speaker: raw.speaker ? String(raw.speaker) : null,
      pages: asPages(raw.text),
      next: raw.next ?? null,
      choices: (Array.isArray(raw.choices) ? raw.choices : [])
        .map((c) => ({ text: String(c?.text ?? ''), next: c?.next ?? null }))
        .filter((c) => c.text),
    };
  }

  async function buildScript(entry) {
    const t = entry.talk;
    if (t.dialogue) {
      try {
        const data = await loadJSON(dialoguePath(t.dialogue));
        const nodes = data.nodes ?? {};
        const start = data.start ?? Object.keys(nodes)[0];
        if (!nodes[start]) throw new Error(`no tiene el nodo inicial "${start}"`);
        return { nodes, start, speaker: data.speaker ? String(data.speaker) : null };
      } catch (err) {
        console.warn(`Diálogo "${t.dialogue}" de ${entry.id}: ${err.message}`);
        if (!t.pages.length) throw err;
      }
    }
    return { nodes: { start: { text: t.pages } }, start: 'start', speaker: null };
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
    host.classList.add('talking'); // esconde la ayuda y los botones mientras se habla
    s = { entry, script, node: null, pages: [], page: 0, text: '', shown: 0, choices: [], sel: 0, picking: false };
    box.hidden = false;
    onStart?.(entry);
    if (entry.talk.look) npcs.faceTowards(entry, focus.x, focus.z);
    goto(script.start);
  }

  function end() {
    if (!s) return;
    const entry = s.entry;
    s = null;
    host.classList.remove('talking');
    box.hidden = true;
    choicesEl.replaceChildren();
    npcs.release(entry);
    cooldownUntil = performance.now() + 250; // evita que el mismo toque de E vuelva a abrir la charla
    onEnd?.(entry);
  }

  function goto(id) {
    const raw = s.script.nodes[id];
    if (!raw) { console.warn(`Diálogo: no existe el nodo "${id}".`); end(); return; }
    s.node = normalize(raw);
    s.pages = s.node.pages.length ? s.node.pages : [''];
    s.page = 0;
    showPage();
  }

  function showPage() {
    s.text = s.pages[s.page];
    s.shown = reduceMotion() ? s.text.length : 0;
    s.picking = false;
    s.choices = [];
    s.sel = 0;
    choicesEl.replaceChildren();
    moreEl.hidden = true;
    nameEl.textContent = s.node.speaker ?? s.entry.talk.speaker ?? s.script.speaker ?? s.entry.talk.defaultSpeaker;
    sr.textContent = s.text;
    paint();
    if (s.shown >= s.text.length) pageDone();
  }

  function paint() {
    const n = Math.floor(s.shown);
    shownEl.textContent = s.text.slice(0, n);
    restEl.textContent = s.text.slice(n);
  }

  // La página terminó de escribirse: aparecen las opciones (en la última página) o la flechita
  function pageDone() {
    const last = s.page >= s.pages.length - 1;
    if (last && s.node.choices.length) {
      s.picking = true;
      s.choices = s.node.choices;
      choicesEl.replaceChildren();
      s.choices.forEach((c, i) => {
        const b = el('button', 'dialogue-choice', choicesEl);
        b.type = 'button';
        const k = el('kbd', '', b);
        k.textContent = i < 9 ? String(i + 1) : '·';
        b.append(' ', c.text); // el texto viene de un archivo externo: nunca como HTML
        b.addEventListener('mousedown', (e) => e.preventDefault()); // no robar el foco del teclado
        b.addEventListener('mouseenter', () => { s.sel = i; markSel(); });
        b.addEventListener('click', () => choose(i));
      });
      markSel();
    } else {
      moreEl.hidden = false;
    }
  }

  function markSel() {
    [...choicesEl.children].forEach((b, i) => {
      b.classList.toggle('sel', i === s.sel);
      b.setAttribute('aria-current', i === s.sel ? 'true' : 'false');
    });
  }

  function choose(i) {
    const c = s?.choices[i];
    if (!c) return;
    if (c.next) goto(c.next); else end();
  }

  function advance() {
    if (!s) return;
    if (s.shown < s.text.length) { s.shown = s.text.length; paint(); pageDone(); return; } // completa la página
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
      markSel();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') {
      if (!e.repeat) advance();
      e.preventDefault();
    }
  });

  // ---- Aviso de cercanía ----
  function setNear(entry) {
    if (entry === near) return;
    near = entry;
    prompt.hidden = !near;
    if (near) {
      prompt.replaceChildren();
      const k = el('kbd', '', prompt);
      k.textContent = 'E';
      prompt.append(' ', near.talk.label);
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
        if (s.shown < s.text.length) {
          s.shown = Math.min(s.text.length, s.shown + CPS * dt);
          paint();
          if (s.shown >= s.text.length) pageDone();
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
