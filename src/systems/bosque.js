// Talar árboles (Bosque de Coronda): acercate a un árbol, E, y el personaje hace su animación "talar".
//
// Un árbol es cualquier objeto llamado arbol_001, arbol_002… (Empty o malla padre) en el .glb de la escena.
// Adentro: lo que se llama *_tocon queda cuando se cae; el resto (tronco, copa) desaparece y vuelve a crecer.
// Configuración: data/tables/bosque.json (también desde el Studio):
//   golpes_por_tanda   cada cuántos golpes se recibe madera            (3)
//   madera_por_tanda   cuánta madera da cada tanda                      (2)
//   tandas_por_arbol   cuántas tandas aguanta un árbol antes de caerse  (3)
//   rebrote_minutos    minutos reales hasta que vuelve a crecer         (5)
//   animacion          clip del personaje al talar ("talar"; si tu personaje no lo tiene, el árbol igual se sacude)
//   radio              a cuántos metros del tronco aparece "E Talar"
//   resistencia_por_dia energía máxima (30; el nombre quedó de cuando se recargaba por día). Cada hachazo gasta 1.
//                      Se ve en la barra ⚡ y se guarda en el navegador. 0 = sin límite.
//   energia_correr_por_seg      cuánta energía gasta correr, por segundo (1; 0 = correr no gasta). Sin energía solo se camina.
//   recupera_quieto_por_seg     cuánta se recupera por segundo con el personaje quieto (2)
//   recupera_caminando_por_seg  y caminando (más lento: 0.5). Corriendo o talando no se recupera.
// Los árboles caídos son los mismos para todo el servidor (se guardan como los lotes: bosque~<escena>.<árbol>).
import * as THREE from 'three';
import { loadJSON } from '../core/assets.js';

export const BOSQUE_DEFAULT = { golpes_por_tanda: 3, madera_por_tanda: 2, tandas_por_arbol: 3, rebrote_minutos: 5, animacion: 'talar', radio: 1.6, recurso: 'madera', resistencia_por_dia: 30, energia_correr_por_seg: 1, recupera_quieto_por_seg: 2, recupera_caminando_por_seg: 0.5 };
const RES_KEY = 'coronda.bosque.resistencia'; // { dia, usados }
const TREE_RE = /^arbol_\d+$/i;
const STUMP_RE = /_tocon/i;
const _v = new THREE.Vector3();

// opts: stage, net, getRoot(), getSceneId(), getPlayer(), inventario, tiempo (reloj del juego), blocked(), notify(msg)
//       extraEnergia() (energía máxima extra: aptitud Energía, ver systems/niveles.js), onXp(que) ('hachazo' | 'arbol')
export function createBosque({ stage, net = null, getRoot, getSceneId, getPlayer, inventario, tiempo = null, blocked = () => false, notify = () => {}, extraEnergia = () => 0, onXp = () => {} }) {
  let cfg = { ...BOSQUE_DEFAULT };
  loadJSON('data/tables/bosque.json').then((c) => setConfig(c)).catch(() => {});
  function setConfig(c) {
    if (!c || typeof c !== 'object') return;
    cfg = { ...cfg, ...c };
    for (const k of ['golpes_por_tanda', 'madera_por_tanda', 'tandas_por_arbol']) cfg[k] = Math.max(1, Math.round(Number(cfg[k]) || BOSQUE_DEFAULT[k]));
    cfg.rebrote_minutos = Math.max(0.1, Number(cfg.rebrote_minutos) || BOSQUE_DEFAULT.rebrote_minutos);
    cfg.radio = Math.max(0.5, Number(cfg.radio) || BOSQUE_DEFAULT.radio);
    cfg.resistencia_por_dia = Math.max(0, Math.round(Number(cfg.resistencia_por_dia ?? BOSQUE_DEFAULT.resistencia_por_dia) || 0));
    cfg.energia_correr_por_seg = Math.max(0, Number(cfg.energia_correr_por_seg ?? BOSQUE_DEFAULT.energia_correr_por_seg) || 0);
    for (const k of ['recupera_quieto_por_seg', 'recupera_caminando_por_seg']) cfg[k] = Math.max(0, Number(cfg[k] ?? BOSQUE_DEFAULT[k]) || 0);
  }

  // ---------- Resistencia: hachazos por día del juego ----------
  const hoy = () => (tiempo ? tiempo.dia() : Math.floor(Date.now() / 864e5));
  let res = { dia: hoy(), usados: 0 };
  try { const g = JSON.parse(localStorage.getItem(RES_KEY)); if (g && Number.isFinite(g.dia)) res = { dia: g.dia, usados: Math.max(0, Number(g.usados) || 0) }; } catch { /* nada */ }
  const maxE = () => cfg.resistencia_por_dia + Math.max(0, Number(extraEnergia()) || 0); // la del día + la aptitud Energía
  function quedan() {
    if (!cfg.resistencia_por_dia) return Infinity;
    return Math.max(0, maxE() - res.usados);
  }
  function gastar() {
    if (!cfg.resistencia_por_dia) return;
    quedan(); res.usados++;
    try { localStorage.setItem(RES_KEY, JSON.stringify(res)); } catch { /* nada */ }
  }
  // Correr gasta energía de a poco (dt en segundos). Devuelve false si no queda: el personaje camina.
  let guardarT = 0, avisado = false;
  function correr(dt) {
    if (!cfg.resistencia_por_dia || !(cfg.energia_correr_por_seg > 0)) return true;
    if (quedan() <= 0) {
      if (!avisado) { avisado = true; notify(`Estás agotado: no podés correr. ${recupera()}`); }
      return false;
    }
    avisado = false;
    res.usados = Math.min(maxE(), res.usados + cfg.energia_correr_por_seg * dt);
    guardarT += dt;
    if (guardarT > 1) { guardarT = 0; try { localStorage.setItem(RES_KEY, JSON.stringify(res)); } catch { /* nada */ } }
    return true;
  }
  // Cómo se recupera: quieto rápido, caminando más lento (ver recuperar)
  const recupera = () => 'Quedate quieto un momento (o caminá) para recuperar energía.';
  // Recupera energía según lo que hace el personaje: 'quieto' | 'caminando' | 'corriendo' (dt en segundos)
  function recuperar(mov, dt) {
    if (!cfg.resistencia_por_dia || !res.usados || busy) return;
    const v = mov === 'quieto' ? cfg.recupera_quieto_por_seg : mov === 'caminando' ? cfg.recupera_caminando_por_seg : 0;
    if (!(v > 0)) return;
    res.usados = Math.max(0, res.usados - v * dt);
    guardarT += dt;
    if (guardarT > 1 || !res.usados) { guardarT = 0; try { localStorage.setItem(RES_KEY, JSON.stringify(res)); } catch { /* nada */ } }
  }

  // ---------- Árboles de la escena ----------
  let root = null, trees = [], rescan = 0; // trees: { id, key, obj, pos, parts, hits, tandas, shake }
  const fallen = new Map();          // key -> hasta (ms, Date.now())
  function scan(dt = 0) {
    const r = getRoot?.() ?? null;
    // la escena se arma de a poco (el .glb llega después): mientras no haya árboles se vuelve a mirar cada 1 s
    if (r === root && (trees.length || (rescan -= dt) > 0)) return;
    rescan = 1;
    root = r; trees = [];
    if (!root) return;
    const scene = getSceneId?.() ?? 'escena';
    root.traverse((o) => {
      if (!TREE_RE.test(o.name)) return;
      const parts = [];
      o.traverse((c) => { if (c !== o && c.isMesh && !STUMP_RE.test(c.name)) parts.push(c); });
      if (o.isMesh && !STUMP_RE.test(o.name)) parts.push(o);
      o.updateWorldMatrix(true, false);
      trees.push({ id: o.name, key: `${scene}.${o.name}`, obj: o, pos: o.getWorldPosition(new THREE.Vector3()), parts, hits: 0, tandas: 0, shake: 0, baseRot: o.rotation.clone() });
    });
    for (const t of trees) show(t);
  }
  const isDown = (t) => (fallen.get(t.key) ?? 0) > Date.now();
  function show(t) { const v = !isDown(t); for (const p of t.parts) p.visible = v; }

  // ---------- Red ----------
  if (net?.bosque) {
    const C = net.bosque;
    const { messages, saved } = C.take();
    const accept = (key, d) => {
      const hasta = Number(d?.hasta) || 0;
      if (hasta > Date.now()) fallen.set(key, hasta); else fallen.delete(key);
      const t = trees.find((x) => x.key === key); if (t) { if (!isDown(t)) { t.tandas = 0; t.hits = 0; } show(t); }
    };
    C.onMessage = (d) => { if (d?.k) accept(String(d.k), d); };
    C.onPersisted = (k, d) => accept(k, d);
    messages.forEach(({ data }) => data?.k && accept(String(data.k), data));
    saved.forEach(([k, d]) => accept(k, d));
  }
  function fell(t) {
    const hasta = Date.now() + cfg.rebrote_minutos * 60000;
    fallen.set(t.key, hasta);
    t.hits = 0; t.tandas = 0;
    show(t);
    if (net?.bosque) { net.bosque.send({ k: t.key, hasta }); net.bosque.persist(t.key, { hasta }); }
  }

  // ---------- Interacción ----------
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.className = 'door-prompt tala-prompt';
  prompt.setAttribute('aria-label', 'Talar');
  prompt.hidden = true;
  let promptHtml = ''; // se reescribe solo si cambia: rehacerlo en cada cuadro hace perder toques en el celular
  stage.appendChild(prompt);
  const pop = document.createElement('div');
  pop.className = 'tala-pop';
  pop.hidden = true;
  stage.appendChild(pop);
  let near = null, busy = false, popT = null;
  prompt.addEventListener('click', () => chop());
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE' || e.repeat || !near || busy || blocked()) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    chop();
  }, true);

  function toast(text) {
    pop.textContent = text; pop.hidden = false;
    pop.classList.remove('sube'); void pop.offsetWidth; pop.classList.add('sube');
    clearTimeout(popT); popT = setTimeout(() => { pop.hidden = true; }, 1400);
  }

  async function chop() {
    const t = near;
    const player = getPlayer?.();
    if (!t || busy || !player || isDown(t)) return;
    if (quedan() <= 0) { toast('😮‍💨 Sin fuerzas'); notify(`Estás agotado: no podés talar. ${recupera()}`); return; }
    gastar();
    onXp('hachazo');
    busy = true; // el botón sigue a la vista, atenuado, mientras da el hachazo
    const face = { x: t.pos.x, z: t.pos.z };
    let ok = false;
    try { ok = await player.interact(cfg.animacion, { face, wait: 0.55 }); } catch { ok = false; }
    if (!ok) await new Promise((r) => setTimeout(r, 450)); // personaje sin "talar": igual cuenta el golpe
    player.endInteract?.();
    t.shake = 0.35;
    t.hits++;
    if (t.hits >= cfg.golpes_por_tanda) {
      t.hits = 0; t.tandas++;
      inventario?.add('recursos', cfg.recurso, cfg.madera_por_tanda);
      toast(`+${cfg.madera_por_tanda} 🪵 ${cfg.recurso === 'madera' ? 'madera' : cfg.recurso}`);
      if (t.tandas >= cfg.tandas_por_arbol) { fell(t); toast(`¡Cayó el árbol! +${cfg.madera_por_tanda} 🪵`); onXp('arbol'); }
    } else toast(`${'●'.repeat(t.hits)}${'○'.repeat(cfg.golpes_por_tanda - t.hits)}`);
    const q = Math.ceil(quedan() - 1e-6);
    if (q === 0) setTimeout(() => notify(`Te quedaste sin fuerzas. ${recupera()}`), 900);
    else if (q === 5) setTimeout(() => notify('Te queda poca energía ⚡ (descansá para recuperarla)'), 900);
    busy = false;
  }

  function update(focus, dt) {
    scan(dt);
    recuperar(getPlayer?.()?.movimiento ?? 'quieto', dt); // con la cámara libre (dev) cuenta como quieto
    let best = null, bd = Infinity;
    for (const t of trees) {
      if (t.parts.length && t.parts[0].visible === isDown(t)) show(t); // se cayó o volvió a crecer
      if (t.shake > 0) {
        t.shake = Math.max(0, t.shake - dt);
        const a = Math.sin(t.shake * 40) * t.shake * 0.12;
        t.obj.rotation.x = t.baseRot.x + a; t.obj.rotation.z = t.baseRot.z + a * 0.6;
      }
      if (!focus || isDown(t)) continue;
      const d = Math.hypot(focus.x - t.pos.x, focus.z - t.pos.z);
      if (d < bd) { bd = d; best = t; }
    }
    near = best && bd <= cfg.radio + 0.4 && !blocked() ? best : null;
    const show2 = !!near && !!getPlayer?.();
    if (show2) {
      // 🪓 = botón: en la PC "🪓 E Talar 1/3"; en el celular un botón redondo con el hacha y el progreso (ver css .tala-prompt)
      // ⚡ = hachazos que te quedan hoy (resistencia)
      const q = quedan();
      const energia = Number.isFinite(q) ? `<b class="tala-res${q === 0 ? ' vacia' : q <= 5 ? ' poca' : ''}" title="Hachazos que te quedan hoy">⚡${q}</b>` : '';
      const html = `<span class="tala-ico" aria-hidden="true">🪓</span><kbd>E</kbd><span class="tala-txt">${q === 0 ? 'Sin fuerzas' : 'Talar'}</span><small>${near.tandas}/${cfg.tandas_por_arbol}</small>${energia}`;
      if (html !== promptHtml) { prompt.innerHTML = html; promptHtml = html; }
    }
    prompt.classList.toggle('busy', busy);
    prompt.classList.toggle('agotado', show2 && quedan() === 0);
    prompt.hidden = !show2;
  }

  return {
    update, setConfig,
    get config() { return { ...cfg }; },
    get near() { return !!near; },
    recargar() { res = { dia: hoy(), usados: 0 }; try { localStorage.setItem(RES_KEY, JSON.stringify(res)); } catch { /* nada */ } }, // (admin)
    correr,
    // quedan: entero (redondeado hacia arriba) para mostrar · exacto: con decimales (correr gasta de a poco)
    get resistencia() { const q = quedan(); return { quedan: Number.isFinite(q) ? Math.ceil(q - 1e-6) : null, exacto: Number.isFinite(q) ? q : null, max: cfg.resistencia_por_dia ? maxE() : 0, dia: res.dia }; },
    get trees() { return trees.map((t) => ({ id: t.id, caido: isDown(t), hasta: fallen.get(t.key) ?? 0 })); },
  };
}
