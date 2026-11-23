// Colisiones: qué objetos son sólidos se decide en Blender, con propiedades personalizadas.
//
// En Blender: seleccioná el objeto > Object Properties > Custom Properties, agregá
//   colision           = 1   sólido (el jugador no lo atraviesa y puede caminar sobre sus superficies)
//   colision           = 0   sin colisión (se ve, pero se atraviesa; ej. pasto, carteles, humo)
//   colision_forma     = "caja"   usa la caja envolvente en vez de la malla exacta (más simple y rápido).
//                                 Por defecto es "malla" (los triángulos reales).
//   colision_invisible = 1   el objeto no se dibuja pero sí colisiona (paredes invisibles)
// Al exportar el .glb tildá Include > Custom Properties.
//
// Atajos:
//  - Una propiedad puesta en un objeto padre (ej. un Empty) la heredan todos sus hijos,
//    salvo que el hijo la tenga puesta con otro valor.
//  - Un objeto cuyo nombre empieza con `col_` o `colision_` es sólido e invisible.
//  - Si un objeto no tiene la propiedad, se usa el valor por defecto de la escena:
//    data/scenes/<escena>.json > "collision": { "default": "solid" | "none" }   (por defecto "solid")
//  - Los objetos `cielo_…` / `sky_…` nunca colisionan.
//
// Cómo se usa el resultado:
//  - Triángulos casi horizontales (pendiente <= maxSlope) = SUELO: el jugador camina sobre ellos
//    (escalones, rampas). Tienen que mirar hacia arriba (normales hacia afuera en Blender).
//  - Triángulos más empinados = PARED: el jugador choca y se desliza a lo largo.
//  - Techos (miran hacia abajo) no frenan al jugador.
//
// Este archivo no depende de three.js (usa solo matrices y arreglos), así que se puede probar solo.

const CELL = 4;               // tamaño (m) de las celdas de la grilla espacial
const MAX_CELLS_PER_TRI = 1024; // un triángulo gigante va a una lista global en vez de a miles de celdas
const STRIDE = 12;            // por triángulo: 3 vértices (9) + normal (3)

// ---------- Propiedades de Blender ----------

const OFF = /^(?:0+(?:\.0*)?|false|no|none|off|nada|ninguna?)$/i;
const ON = /^(?:true|si|sí|yes|on|solid|solido|sólido)$/i;

// 1, 1.0, "1", true, "si" -> true · 0, "0.0", false, "no" -> false · vacío o desconocido -> undefined
export function parseFlag(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim();
  if (!s) return undefined;
  if (OFF.test(s)) return false;
  if (ON.test(s)) return true;
  if (/^-?\d*\.?\d+$/.test(s)) return Number(s) !== 0;
  return undefined;
}

const PROXY_NAME = /^(?:col|colision)_/i;

function ownFlags(node) {
  const u = node.userData ?? {};
  const f = {};
  const solid = parseFlag(u.colision);
  if (solid !== undefined) f.solid = solid;
  const hidden = parseFlag(u.colision_invisible);
  if (hidden !== undefined) f.hidden = hidden;
  if (typeof u.colision_forma === 'string') {
    const s = u.colision_forma.trim().toLowerCase();
    if (/^(?:caja|box|aabb)$/.test(s)) f.shape = 'caja';
    else if (/^(?:malla|mesh|exacta)$/.test(s)) f.shape = 'malla';
    else console.warn(`Objeto "${node.name}": colision_forma = "${u.colision_forma}" no es válida (usá "malla" o "caja").`);
  }
  if (PROXY_NAME.test(node.name ?? '')) { f.solid ??= true; f.hidden ??= true; }
  return f;
}

// ---------- Geometría ----------

const _cp = [0, 0, 0];

// Punto del triángulo ABC más cercano a P (Ericson, Real-Time Collision Detection). Resultado en _cp.
function closestOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
function set(x, y, z) { _cp[0] = x; _cp[1] = y; _cp[2] = z; }

// ---------- Grilla espacial (en X/Z) ----------

const cellKey = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);

function makeGrid(tris) {
  const n = tris.length / STRIDE;
  const cells = new Map();
  const global = [];
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    const minX = Math.min(tris[o], tris[o + 3], tris[o + 6]), maxX = Math.max(tris[o], tris[o + 3], tris[o + 6]);
    const minZ = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]), maxZ = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > MAX_CELLS_PER_TRI) { global.push(i); continue; }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = cellKey(ix, iz);
        const list = cells.get(k);
        if (list) list.push(i); else cells.set(k, [i]);
      }
    }
  }
  return { tris, count: n, cells, global, stamp: new Int32Array(n), mark: 0 };
}

// Llena `out` con los índices (sin repetir) de los triángulos cuyas celdas toca la caja [x0..x1]×[z0..z1]
function collect(grid, x0, z0, x1, z1, out) {
  out.length = 0;
  if (!grid.count) return out;
  const m = ++grid.mark;
  const { stamp } = grid;
  for (const i of grid.global) { stamp[i] = m; out.push(i); }
  const ix0 = Math.floor(x0 / CELL), ix1 = Math.floor(x1 / CELL);
  const iz0 = Math.floor(z0 / CELL), iz1 = Math.floor(z1 / CELL);
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iz = iz0; iz <= iz1; iz++) {
      const list = grid.cells.get(cellKey(ix, iz));
      if (!list) continue;
      for (const i of list) if (stamp[i] !== m) { stamp[i] = m; out.push(i); }
    }
  }
  return out;
}

// ---------- Construcción del mundo de colisión ----------

// Recorre el árbol de objetos (salas cargadas con GLTFLoader) y arma el mundo de colisión.
//   root:   el grupo de la escena (Object3D)
//   opciones:
//     defaultSolid: qué pasa con objetos sin propiedad `colision` (true por defecto)
//     maxSlope:     grados; más empinado que esto es pared, no suelo (50 por defecto)
//     ignore(node): true para objetos que nunca colisionan (ej. el cielo)
// Efectos: marca cada malla con userData.collision = { solid, shape } (lo muestra el inspector)
//          y oculta las que tienen colision_invisible.
export function buildCollision(root, { defaultSolid = true, maxSlope = 50, ignore = null } = {}) {
  root.updateMatrixWorld(true);
  const cosSlope = Math.cos((maxSlope * Math.PI) / 180);
  const walls = [], floors = [];
  const stats = { solidMeshes: 0, nonSolidMeshes: 0, boxes: 0, walls: 0, floors: 0, ceilings: 0 };
  const boxes = new Map(); // nodo dueño -> { min, max }

  function addTri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return; // triángulo degenerado
    nx /= len; ny /= len; nz /= len;
    let target;
    if (ny >= cosSlope) { target = floors; stats.floors++; }
    else if (ny <= -cosSlope) { stats.ceilings++; return; } // techo: no frena
    else { target = walls; stats.walls++; }
    target.push(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz);
  }

  function visit(node, inherited) {
    const own = ownFlags(node);
    const flags = {
      solid: own.solid ?? inherited.solid,
      shape: own.shape ?? inherited.shape,
      hidden: own.hidden ?? inherited.hidden,
      owner: own.shape !== undefined ? node : inherited.owner,
    };

    if (node.isMesh && !node.isSkinnedMesh && !node.isInstancedMesh) {
      const solid = flags.solid && !(ignore && ignore(node));
      node.userData.collision = { solid, shape: flags.shape };
      if (flags.hidden && solid) node.visible = false;
      if (solid) {
        stats.solidMeshes++;
        const pos = node.geometry?.attributes?.position;
        if (pos) {
          const m = node.matrixWorld.elements;
          const n = pos.count;
          const P = new Float64Array(n * 3);
          for (let i = 0; i < n; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            P[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
            P[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            P[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          }
          if (flags.shape === 'caja') {
            let b = boxes.get(flags.owner);
            if (!b) boxes.set(flags.owner, (b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
            for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
              const v = P[i * 3 + k];
              if (v < b.min[k]) b.min[k] = v;
              if (v > b.max[k]) b.max[k] = v;
            }
          } else {
            // escala negativa en Blender (espejo) invierte el sentido de los triángulos: lo corregimos
            const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
            const flip = det < 0;
            const idx = node.geometry.index;
            const tc = idx ? idx.count / 3 : n / 3;
            for (let t = 0; t < tc; t++) {
              let a = idx ? idx.getX(t * 3) : t * 3;
              let b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
              let c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
              if (flip) [b, c] = [c, b];
              addTri(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2], P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
            }
          }
        }
      } else stats.nonSolidMeshes++;
    }
    for (const child of node.children) visit(child, flags);
  }
  visit(root, { solid: defaultSolid, shape: 'malla', hidden: false, owner: null });

  // Cajas: 12 triángulos por caja (la cara de arriba es suelo; las laterales, paredes)
  for (const { min, max } of boxes.values()) {
    if (!isFinite(min[0])) continue;
    stats.boxes++;
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const quad = (a, b, c, d) => { addTri(...a, ...b, ...c); addTri(...a, ...c, ...d); };
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // arriba
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // abajo
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +X
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // -Z
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  }

  return createWorld(new Float32Array(walls), new Float32Array(floors), stats);
}

// ---------- Consultas ----------

// También se puede armar directo desde listas de triángulos (para pruebas)
export function createWorld(wallTris, floorTris, stats = {}) {
  const wallGrid = makeGrid(wallTris);
  const floorGrid = makeGrid(floorTris);
  const list = [];
  const spheres = [];

  return {
    stats,
    triangles: { walls: wallTris, floors: floorTris },
    get hasGround() { return floorGrid.count > 0; },

    // Altura del suelo en (x, z): la superficie más alta que esté a `maxY` o menos. null si no hay.
    groundAt(x, z, maxY = Infinity) {
      collect(floorGrid, x, z, x, z, list);
      const t = floorGrid.tris;
      let best = null;
      for (const i of list) {
        const o = i * STRIDE;
        const ax = t[o], ay = t[o + 1], az = t[o + 2];
        const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
        const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-5 || l2 < -1e-5 || l3 < -1e-5) continue;
        const y = l1 * ay + l2 * by + l3 * cy;
        if (y <= maxY + 1e-4 && (best === null || y > best)) best = y;
      }
      return best;
    },

    // Empuja a `pos` ({x,y,z} = pies) fuera de las paredes. Modifica pos.x y pos.z. Devuelve true si chocó.
    // El cuerpo es una cápsula vertical aproximada con esferas de radio `radius` entre `stepHeight` y `height`:
    // lo que esté más bajo que stepHeight no frena (se sube como escalón).
    pushOut(pos, { radius: r, height, stepHeight }) {
      if (!wallGrid.count) return false;
      const yLo = pos.y + stepHeight + r;
      const yHi = Math.max(yLo, pos.y + height - r);
      const n = Math.max(2, Math.ceil((yHi - yLo) / (r * 1.2)) + 1);
      spheres.length = 0;
      for (let i = 0; i < n; i++) spheres.push(yLo + ((yHi - yLo) * i) / (n - 1));

      const t = wallGrid.tris;
      let hit = false;
      for (let iter = 0; iter < 4; iter++) {
        collect(wallGrid, pos.x - r, pos.z - r, pos.x + r, pos.z + r, list);
        let moved = false;
        for (const cy of spheres) {
          for (const i of list) {
            const o = i * STRIDE;
            closestOnTriangle(pos.x, cy, pos.z, t[o], t[o + 1], t[o + 2], t[o + 3], t[o + 4], t[o + 5], t[o + 6], t[o + 7], t[o + 8]);
            const dx = pos.x - _cp[0], dy = cy - _cp[1], dz = pos.z - _cp[2];
            const dh2 = dx * dx + dz * dz;
            const rh2 = r * r - dy * dy;       // radio horizontal disponible a esa altura
            if (rh2 <= 0 || dh2 >= rh2) continue;
            const dh = Math.sqrt(dh2);
            let nx, nz;
            if (dh > 1e-5) { nx = dx / dh; nz = dz / dh; }
            else { // justo encima/debajo de un borde: usamos la normal del triángulo
              const l = Math.hypot(t[o + 9], t[o + 11]);
              if (l < 1e-6) continue;
              nx = t[o + 9] / l; nz = t[o + 11] / l;
            }
            const push = Math.sqrt(rh2) - dh;
            if (push < 1e-6) continue;
            pos.x += nx * push; pos.z += nz * push;
            moved = hit = true;
          }
        }
        if (!moved) break;
      }
      return hit;
    },
  };
}
