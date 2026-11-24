// Búsqueda de caminos para NPC (A* sobre una grilla): rodea los objetos con colisión.
// No usa three.js; solo el mundo de colisión de systems/collision.js (groundAt + pushOut), así que se puede probar solo.
//
// findPath(world, a, b, opts) -> { points: [{x,z}, ...], found }
//   a, b = {x, y, z} (pies). points = puntos intermedios y el final, ya suavizados (sin zigzag).
//   Si el camino directo está libre devuelve solo [b]. Si no hay camino devuelve [b] con found:false (camina recto).
//   opts: extra [{x,z,r}] círculos que también bloquean · radius (0.4), height (1.6), stepHeight (0.4), cell (0.35 m), margin (máx(8 m, 80% del tramo)), maxCells (30000)

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) { const a = this.a; a.push(item); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

export function findPath(world, a, b, opts = {}) {
  const { radius = 0.4, height = 1.6, stepHeight = 0.4, maxCells = 30000, extra = [] } = opts; // extra: círculos {x,z,r} que también bloquean (ej. el jugador)
  const margin = opts.margin ?? Math.max(8, Math.hypot(b.x - a.x, b.z - a.z) * 0.8); // cuánto se puede alejar del tramo recto para rodear
  let cell = opts.cell ?? 0.35;
  const direct = { points: [{ x: b.x, z: b.z }], found: true };
  if (!world?.pushOut || !world?.groundAt) return direct;
  const refY = Math.max(a.y ?? 0, b.y ?? 0);
  // si ya está pegado al círculo (ej. el jugador justo adelante), puede alejarse: solo se bloquea acercarse más de lo que ya está
  const circles = extra.map((c) => ({ x: c.x, z: c.z, thr: Math.min(c.r + radius, Math.hypot(a.x - c.x, a.z - c.z) - 0.02) }));
  const tmp = { x: 0, y: 0, z: 0 };
  const body = { radius, height, stepHeight };

  // ¿se puede estar parado en (x, z)? hace falta suelo cerca de la altura de referencia y ninguna pared encima
  const freeAt = (x, z) => {
    for (const c of circles) if (Math.hypot(x - c.x, z - c.z) < c.thr) return false;
    const g = world.groundAt(x, z, refY + stepHeight + 0.3);
    if (g === null || g < Math.min(a.y ?? 0, b.y ?? 0) - 1.2) return false;
    tmp.x = x; tmp.y = g; tmp.z = z;
    return !world.pushOut(tmp, body);
  };

  const x0 = Math.min(a.x, b.x) - margin, z0 = Math.min(a.z, b.z) - margin;
  const x1 = Math.max(a.x, b.x) + margin, z1 = Math.max(a.z, b.z) + margin;
  while (Math.ceil((x1 - x0) / cell) * Math.ceil((z1 - z0) / cell) > maxCells) cell *= 1.25;
  const W = Math.ceil((x1 - x0) / cell) + 1, H = Math.ceil((z1 - z0) / cell) + 1;
  const state = new Uint8Array(W * H); // 0 sin mirar · 1 libre · 2 bloqueada
  const cx = (i) => x0 + i * cell, cz = (j) => z0 + j * cell;
  const ci = (x) => Math.min(W - 1, Math.max(0, Math.round((x - x0) / cell)));
  const cj = (z) => Math.min(H - 1, Math.max(0, Math.round((z - z0) / cell)));
  const sI = ci(a.x), sJ = cj(a.z), gI = ci(b.x), gJ = cj(b.z);
  const free = (i, j) => {
    if (i < 0 || j < 0 || i >= W || j >= H) return false;
    const k = j * W + i;
    if ((i === sI && j === sJ) || (i === gI && j === gJ)) return true; // donde está y a donde va, siempre
    if (!state[k]) state[k] = freeAt(cx(i), cz(j)) ? 1 : 2;
    return state[k] === 1;
  };
  // ¿el tramo recto entre dos puntos está libre?
  const clear = (ax, az, bx, bz) => {
    const d = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(d / (cell * 0.5)));
    for (let s = 1; s < n; s++) { const t = s / n; if (!free(ci(ax + (bx - ax) * t), cj(az + (bz - az) * t))) return false; }
    return true;
  };
  if (clear(a.x, a.z, b.x, b.z)) return direct;

  // A* con 8 vecinos (sin cortar esquinas)
  const g = new Float32Array(W * H).fill(Infinity), from = new Int32Array(W * H).fill(-1), closed = new Uint8Array(W * H);
  const hFn = (i, j) => { const dx = Math.abs(i - gI), dz = Math.abs(j - gJ); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
  const open = new Heap();
  g[sJ * W + sI] = 0; open.push({ k: sJ * W + sI, f: hFn(sI, sJ) });
  const N = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
  let reached = false;
  while (open.size) {
    const { k } = open.pop();
    if (closed[k]) continue; closed[k] = 1;
    const i = k % W, j = (k / W) | 0;
    if (i === gI && j === gJ) { reached = true; break; }
    for (const [di, dj, c] of N) {
      const ni = i + di, nj = j + dj;
      if (!free(ni, nj)) continue;
      if (di && dj && !(free(i + di, j) && free(i, j + dj))) continue;
      const nk = nj * W + ni;
      if (closed[nk]) continue;
      const ng = g[k] + c;
      if (ng < g[nk]) { g[nk] = ng; from[nk] = k; open.push({ k: nk, f: ng + hFn(ni, nj) }); }
    }
  }
  if (!reached) return { points: [{ x: b.x, z: b.z }], found: false };

  const raw = [];
  for (let k = gJ * W + gI; k !== -1; k = from[k]) raw.push({ x: cx(k % W), z: cz((k / W) | 0) });
  raw.reverse();
  raw[0] = { x: a.x, z: a.z }; raw[raw.length - 1] = { x: b.x, z: b.z };
  // suavizado: desde cada punto, salta al más lejano al que se llega en línea recta
  const out = []; let at = 0;
  while (at < raw.length - 1) {
    let nx = at + 1;
    for (let k = raw.length - 1; k > at + 1; k--) if (clear(raw[at].x, raw[at].z, raw[k].x, raw[k].z)) { nx = k; break; }
    out.push(raw[nx]); at = nx;
  }
  return { points: out, found: true };
}
