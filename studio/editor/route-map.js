// Mapa de un recorrido visto desde arriba (pestaña Rutas): la escena fotografiada desde el cielo, todos sus puntos
// (Empties ruta_*, npc_*…), el camino que hace el NPC con sus paradas numeradas y las esperas.
// Clic en un punto = agregar una parada ahí (al final del recorrido). Rueda = zoom, arrastrar = mover.
import { esc } from './ws-common.js';
import { icon } from './components.js';

const nextsOf = (n) => (typeof n?.next === 'string' ? (n.next ? [{ to: n.next }] : []) : Array.isArray(n?.next) ? n.next.filter((c) => c?.to) : []);

export function createRouteMap(el, { app, getData, getScene, getPoints, getNpc, onAddStop, onPickStop }) {
  el.innerHTML = `<div class="ph"><h2>Mapa</h2><span class="rm-scene muted"></span><span class="spacer"></span>
      <button class="ib sm" data-act="fit" title="Ver todo">${icon('target', { size: 14 })}</button>
      <button class="ib sm" data-act="shot" title="Volver a fotografiar la escena">${icon('reset', { size: 14 })}</button></div>
    <div class="rm-view"><svg class="rm-svg" xmlns="http://www.w3.org/2000/svg"></svg><div class="rm-tip" hidden></div></div>
    <div class="rm-foot muted">Clic en un punto para agregar una parada · rueda: zoom · arrastrar: mover</div>`;
  const svg = el.querySelector('.rm-svg'), view = el.querySelector('.rm-view'), tip = el.querySelector('.rm-tip');
  let shot = null, shotScene = null, vb = null, hover = null;

  function bounds(points) {
    if (shot) return { minX: shot.minX, maxX: shot.maxX, minZ: shot.minZ, maxZ: shot.maxZ };
    if (!points.length) return { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    const xs = points.map((p) => p.x), zs = points.map((p) => p.z);
    const pad = Math.max(4, (Math.max(...xs) - Math.min(...xs) + Math.max(...zs) - Math.min(...zs)) * 0.08);
    return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
  }
  function takeShot() {
    const sc = getScene();
    shot = null; shotScene = sc;
    if (sc && sc === app.sceneId && app.viewport?.topView) {
      try { shot = app.viewport.topView(1100, getPoints()); } catch (err) { console.warn('Mapa:', err); }
    }
  }
  // Encuadre: las paradas del recorrido (con aire alrededor); si no hay, todos los puntos; si tampoco, la foto
  function fit() {
    const pts = getPoints(), d = getData();
    const used = new Set(Object.values(d.nodes ?? {}).map((n) => n?.point).filter(Boolean));
    const stops = pts.filter((p) => used.has(p.name));
    const set = stops.length >= 1 ? stops : pts;
    let b;
    if (set.length) {
      const xs = set.map((p) => p.x), zs = set.map((p) => p.z);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
      const pad = Math.max(6, span * 0.35);
      b = { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
    } else b = bounds(pts);
    vb = { x: b.minX, y: b.minZ, w: b.maxX - b.minX, h: b.maxZ - b.minZ };
  }

  function render() {
    const scene = getScene();
    if (shotScene !== scene) { takeShot(); vb = null; }
    if (!vb) fit();
    const pts = getPoints();
    const byName = new Map(pts.map((p) => [p.name, p]));
    const d = getData();
    const nodes = d.nodes ?? {};
    // orden de las paradas: desde el inicio, siguiendo el primer destino
    const order = [], seen = new Set();
    let c = d.start && nodes[d.start] ? d.start : Object.keys(nodes)[0];
    while (c && nodes[c] && !seen.has(c)) { seen.add(c); order.push(c); c = nextsOf(nodes[c])[0]?.to; }
    for (const id of Object.keys(nodes)) if (!seen.has(id)) order.push(id);
    const num = new Map(order.map((id, i) => [id, i + 1]));
    const u = Math.max(vb.w, vb.h) / 100; // unidad visual (1% del ancho)
    el.querySelector('.rm-scene').textContent = scene ? `${scene}${shot ? '' : ' · sin foto (abrí la escena en Escena)'}` : '';

    let g = '';
    if (shot) g += `<image href="${shot.url}" x="${shot.minX}" y="${shot.minZ}" width="${shot.maxX - shot.minX}" height="${shot.maxZ - shot.minZ}" preserveAspectRatio="none" opacity=".92"/>`;
    else {
      const step = Math.pow(10, Math.floor(Math.log10(Math.max(vb.w, vb.h) / 5)));
      for (let x = Math.ceil(vb.x / step) * step; x < vb.x + vb.w; x += step) g += `<line x1="${x}" y1="${vb.y - vb.h}" x2="${x}" y2="${vb.y + vb.h * 2}" class="rm-grid" stroke-width="${u * 0.1}"/>`;
      for (let z = Math.ceil(vb.y / step) * step; z < vb.y + vb.h; z += step) g += `<line x1="${vb.x - vb.w}" y1="${z}" x2="${vb.x + vb.w * 2}" y2="${z}" class="rm-grid" stroke-width="${u * 0.1}"/>`;
    }
    // caminos
    const arrowId = 'rmA';
    g += `<defs><marker id="${arrowId}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="${4}" markerHeight="${4}" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#7c3aed"/></marker></defs>`;
    for (const id of order) {
      const a = byName.get(nodes[id]?.point);
      if (!a) continue;
      for (const [i, n] of nextsOf(nodes[id]).entries()) {
        const b = byName.get(nodes[n.to]?.point);
        if (!b || b === a) continue;
        const cond = !!n.if || n.weight !== undefined || i > 0;
        const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1, r = u * 2.2;
        g += `<line x1="${a.x + dx / L * r}" y1="${a.z + dz / L * r}" x2="${b.x - dx / L * r}" y2="${b.z - dz / L * r}" class="rm-path${cond ? ' cond' : ''}" stroke-width="${u * 0.55}" ${cond ? `stroke-dasharray="${u * 1.4} ${u}"` : ''} marker-end="url(#${arrowId})"/>`;
      }
    }
    // puntos de la escena
    const used = new Map();
    for (const id of order) { const p = nodes[id]?.point; if (p) { if (!used.has(p)) used.set(p, []); used.get(p).push(id); } }
    const npc = getNpc();
    for (const p of pts) {
      const ids = used.get(p.name);
      const isNpc = npc && p.name === npc.name;
      const r = ids ? u * 2.2 : u * 1.1;
      g += `<g class="rm-pt${ids ? ' on' : ''}${hover === p.name ? ' hov' : ''}${/^ruta_/i.test(p.name) ? ' ruta' : ''}" data-pt="${esc(p.name)}">
        <circle cx="${p.x}" cy="${p.z}" r="${u * 3.2}" class="hit"/>
        ${isNpc ? `<circle cx="${p.x}" cy="${p.z}" r="${r + u * 1.2}" class="npc" stroke-width="${u * 0.4}"/>` : ''}
        <circle cx="${p.x}" cy="${p.z}" r="${r}" class="dot" stroke-width="${u * 0.35}"/>
        ${ids ? `<text x="${p.x}" y="${p.z}" dy=".35em" font-size="${u * 2.4}" class="num">${ids.map((i) => num.get(i)).join(',')}</text>` : ''}
        <text x="${p.x + r + u * 0.8}" y="${p.z - r * 0.2}" font-size="${u * 1.9}" class="lbl">${esc(p.name)}</text>
        ${ids ? ids.map((i, k) => { const w = nodes[i].wait; return w !== undefined && w !== '' ? `<text x="${p.x + r + u * 0.8}" y="${p.z + r * 0.9 + k * u * 2}" font-size="${u * 1.6}" class="wt">${esc(i)}: ${w}${nodes[i].waitMax ? `–${nodes[i].waitMax}` : ''} s</text>` : ''; }).join('') : ''}
      </g>`;
    }
    const missing = order.filter((id) => nodes[id]?.point && !byName.has(nodes[id].point));
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    svg.innerHTML = g;
    el.querySelector('.rm-foot').innerHTML = missing.length
      ? `${icon('warn', { size: 12 })} Paradas con un punto que no está en esta escena: ${missing.map((m) => `<b>${esc(m)}</b> (${esc(nodes[m].point)})`).join(', ')}`
      : 'Clic en un punto para agregar una parada · rueda: zoom · arrastrar: mover';
  }

  // ---- interacción ----
  const toWorld = (e) => { const r = svg.getBoundingClientRect(); const s = Math.max(vb.w / r.width, vb.h / r.height); const ox = (r.width * s - vb.w) / 2, oy = (r.height * s - vb.h) / 2; return { x: vb.x - ox + (e.clientX - r.left) * s, z: vb.y - oy + (e.clientY - r.top) * s, s }; };
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toWorld(e), k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    vb = { x: p.x - (p.x - vb.x) * k, y: p.z - (p.z - vb.y) * k, w: vb.w * k, h: vb.h * k };
    render();
  }, { passive: false });
  let drag = null;
  view.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vb: { ...vb }, moved: false }; view.setPointerCapture(e.pointerId); });
  view.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) { const s = toWorld(e).s; vb = { ...drag.vb, x: drag.vb.x - dx * s, y: drag.vb.y - dy * s }; render(); }
      return;
    }
    const pt = e.target.closest?.('[data-pt]')?.dataset.pt ?? null;
    if (pt !== hover) { hover = pt; render(); }
    tip.hidden = !pt;
    if (pt) { const r = view.getBoundingClientRect(); tip.style.left = `${e.clientX - r.left + 12}px`; tip.style.top = `${e.clientY - r.top + 12}px`; tip.textContent = `${pt} · clic: agregar parada`; }
  });
  view.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d || d.moved) return;
    const pt = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-pt]')?.dataset.pt;
    if (pt) (e.altKey ? onPickStop : onAddStop)?.(pt);
  });
  view.addEventListener('pointerleave', () => { tip.hidden = true; if (hover) { hover = null; render(); } });
  el.querySelector('[data-act="fit"]').addEventListener('click', () => { fit(); render(); });
  el.querySelector('[data-act="shot"]').addEventListener('click', () => { takeShot(); fit(); render(); });

  return { render, reshoot: () => { shotScene = null; } };
}
