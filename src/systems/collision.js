// Colisiones: qué objetos son sólidos se decide en Blender, con propiedades personalizadas.
//
// En Blender: seleccioná el objeto > Object Properties > Custom Properties, agregá
//   colision           = 1   sólido (el jugador no lo atraviesa y puede caminar sobre sus superficies)
//   colision           = "malla"     sólido usando su propia malla, triángulo por triángulo (lo mismo que 1)
//   colision           = "caja" / "cilindro"   sólido con esa forma (atajo de colision = 1 + colision_forma)
//   colision           = 0   sin colisión (se ve, pero se atraviesa; ej. pasto, carteles, humo)
//   colision_forma     = "caja"   usa la caja envolvente en vez de la malla exacta (más simple y rápido).
//                                 Por defecto es "malla" (los triángulos reales).
//   colision_invisible = 1   el objeto no se dibuja pero sí colisiona (paredes invisibles)
// Al exportar el .glb tildá Include > Custom Properties.
//
// Atajos:
//  - Una propiedad puesta en un objeto padre (ej. un Empty) la heredan todos sus hijos,
//    salvo que el hijo la tenga puesta con otro valor.
//  - Un objeto cuyo nombre empieza con `col_` o `colision_` es sólido e invisible (malla de colisión aparte,
//    como en Ocarina: una versión simple del objeto detallado).
//    Y el objeto detallado deja de colisionar SOLO (salvo que tenga `colision` puesta a mano) si:
//      · se llama igual sin el prefijo:  casa  +  col_casa  (o col_casa_1, col_casa_2… / col_casa.001), o
//      · la malla col_… es hija de esa malla en Blender.
//  - Un EMPTY sin hijos llamado `col_…` también es colisión: en Blender usá Display As = Cube con Size = 1
//    y dale el tamaño con Escala (S) y la rotación que quieras. Lo que ves en Blender es lo que choca.
//      colision_forma = "cilindro"  en el Empty -> cilindro parado (radio = escala X, alto = escala Z de Blender);
//                                   en Blender podés usar Display As = Circle de guía. Ideal para postes, troncos, columnas.
//  - Si un objeto no tiene la propiedad, se usa el valor por defecto de la escena:
//    data/scenes/<escena>.json > "collision": { "default": "none" | "solid" }   (por defecto "none":
//    las mallas que se ven NO chocan; la colisión la hacen los col_… — como en Ocarina — incluido el SUELO)
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

// "col_casa_2" / "col_casa001" -> ["casa_2", "casa"]: a qué objeto detallado reemplaza
function proxyTargets(name) {
  const base = String(name ?? '').replace(PROXY_NAME, '').toLowerCase();
  const out = [base];
  const bare = base.replace(/(?:_\d+|\.?\d{3})$/, '');
  if (bare && bare !== base) out.push(bare);
  return out;
}

function shapeWord(v) {
  const s = String(v).trim().toLowerCase();
  if (/^(?:caja|box|aabb)$/.test(s)) return 'caja';
  if (/^(?:cilindro|cylinder|cil)$/.test(s)) return 'cilindro';
  if (/^(?:malla|mesh|exacta|exacto)$/.test(s)) return 'malla';
  return null;
}

function ownFlags(node) {
  const u = node.userData ?? {};
  const f = {};
  // colision = "malla" / "caja" / "cilindro": sólido con esa forma (atajo de colision = 1 + colision_forma)
  const word = typeof u.colision === 'string' ? shapeWord(u.colision) : null;
  if (word) { f.solid = true; f.shape = word; }
  const solid = word ? true : parseFlag(u.colision);
  if (solid !== undefined) f.solid = solid;
  else if (u.colision !== undefined && String(u.colision).trim()) {
    console.warn(`Objeto "${node.name}": colision = "${u.colision}" no se entiende (usá 1, 0, "malla", "caja" o "cilindro").`);
  }
  const hidden = parseFlag(u.colision_invisible);
  if (hidden !== undefined) f.hidden = hidden;
  if (typeof u.colision_forma === 'string') {
    const w = shapeWord(u.colision_forma);
    if (w) f.shape = w;
    else console.warn(`Objeto "${node.name}": colision_forma = "${u.colision_forma}" no es válida (usá "malla", "caja" o "cilindro").`);
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
//     defaultSolid: qué pasa con objetos sin propiedad `colision` (false por defecto: solo chocan los col_…)
//     maxSlope:     grados; más empinado que esto es pared, no suelo (50 por defecto)
//     ignore(node): true para objetos que nunca colisionan (ej. el cielo)
// Efectos: marca cada malla con userData.collision = { solid, shape } (lo muestra el inspector)
//          y oculta las que tienen colision_invisible.
export function buildCollision(root, { defaultSolid = false, maxSlope = 50, ignore = null } = {}) {
  root.updateMatrixWorld(true);
  const cosSlope = Math.cos((maxSlope * Math.PI) / 180);
  const walls = [], floors = [];
  const stats = { solidMeshes: 0, nonSolidMeshes: 0, boxes: 0, walls: 0, floors: 0, ceilings: 0, replaced: 0, empties: 0 };
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

  // Objetos detallados que tienen su malla de colisión aparte (col_<nombre>): no colisionan ellos
  const replaced = new Set();
  root.traverse((n) => { if (PROXY_NAME.test(n.name ?? '')) for (const t of proxyTargets(n.name)) replaced.add(t); });

  // Empty -> cubo de ±1 (o cilindro de radio 1 y alto ±1) en sus coordenadas, transformado por su escala/rotación/posición.
  // glTF pasa el "arriba" de Blender (Z) a Y: el cilindro queda parado sobre el eje Y.
  const emptyBoxes = [];
  function addEmpty(node, cylinder) {
    const m = node.matrixWorld.elements;
    const T = (x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    const tri = (a, b, c) => (det < 0 ? addTri(...a, ...c, ...b) : addTri(...a, ...b, ...c));
    const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
    stats.empties++;
    if (cylinder) {
      const N = 16, top = [], bot = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2, x = Math.cos(a), z = -Math.sin(a);
        top.push(T(x, 1, z)); bot.push(T(x, -1, z));
      }
      const ct = T(0, 1, 0), cb = T(0, -1, 0);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        tri(ct, top[i], top[j]);              // tapa de arriba (suelo)
        tri(cb, bot[j], bot[i]);              // tapa de abajo
        quad(bot[i], bot[j], top[j], top[i]); // costado (pared)
      }
      return;
    }
    const c = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) c.push(T(x, y, z));
    const v = (x, y, z) => c[(x > 0 ? 4 : 0) + (y > 0 ? 2 : 0) + (z > 0 ? 1 : 0)];
    quad(v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1));     // arriba
    quad(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)); // abajo
    quad(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)); // -X
    quad(v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1));     // +X
    quad(v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)); // -Z
    quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1));     // +Z
    // si no está girado en diagonal, también sirve para detectar a quien quedó adentro
    const min = [0, 1, 2].map((k) => Math.min(...c.map((p) => p[k]))), max = [0, 1, 2].map((k) => Math.max(...c.map((p) => p[k])));
    const ax = Math.hypot(m[0], m[1], m[2]), ay = Math.hypot(m[4], m[5], m[6]), az = Math.hypot(m[8], m[9], m[10]);
    const vol = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
    if (vol <= 8 * ax * ay * az * 1.01) emptyBoxes.push({ min, max });
  }

  function visit(node, inherited) {
    const own = ownFlags(node);
    if (own.solid === undefined && !PROXY_NAME.test(node.name ?? '')) {
      const nm = String(node.name ?? '').toLowerCase();
      if ((nm && replaced.has(nm)) || (node.isMesh && node.children.some((c) => PROXY_NAME.test(c.name ?? '')))) {
        own.solid = false;
        stats.replaced++;
      }
    }
    const flags = {
      solid: own.solid ?? inherited.solid,
      shape: own.shape ?? inherited.shape,
      hidden: own.hidden ?? inherited.hidden,
      owner: own.shape !== undefined ? node : inherited.owner,
    };

    // Empty de colisión: un nodo sin malla ni hijos llamado col_… (ver arriba)
    if (!node.isMesh && !node.isBone && !node.isCamera && !node.isLight && node !== root
        && !node.children.length && PROXY_NAME.test(node.name ?? '') && flags.solid && !(ignore && ignore(node))) {
      addEmpty(node, own.shape === 'cilindro');
    }

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

  // Cajas: 12 triángulos por caja (la cara de arriba es suelo; las laterales, paredes).
  // Además se guardan enteras: así se detecta a alguien que quedó ADENTRO de una caja grande
  // (lejos de sus paredes, donde los triángulos solos no lo ven).
  const boxList = [...emptyBoxes];
  for (const { min, max } of boxes.values()) {
    if (!isFinite(min[0])) continue;
    stats.boxes++;
    boxList.push({ min: [...min], max: [...max] });
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const quad = (a, b, c, d) => { addTri(...a, ...b, ...c); addTri(...a, ...c, ...d); };
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // arriba
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // abajo
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +X
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // -Z
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  }

  return createWorld(new Float32Array(walls), new Float32Array(floors), stats, boxList);
}

// ---------- Consultas ----------

// También se puede armar directo desde listas de triángulos (para pruebas)
//   boxes: [{ min:[x,y,z], max:[x,y,z] }] cajas sólidas (colision_forma = "caja"), para detectar a quien quedó adentro
export function createWorld(wallTris, floorTris, stats = {}, boxes = []) {
  const wallGrid = makeGrid(wallTris);
  const floorGrid = makeGrid(floorTris);
  const list = [];
  const spheres = [];

  return {
    stats,
    triangles: { walls: wallTris, floors: floorTris },
    boxes,
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
      let hit = false;
      // Adentro de una caja sólida (más alta que un escalón): sale por el lado más cercano
      for (const b of boxes) {
        if (pos.y + stepHeight >= b.max[1] || pos.y + height <= b.min[1]) continue;
        if (pos.x < b.min[0] || pos.x > b.max[0] || pos.z < b.min[2] || pos.z > b.max[2]) continue;
        const dl = pos.x - b.min[0], dr = b.max[0] - pos.x, dn = pos.z - b.min[2], df = b.max[2] - pos.z;
        const m = Math.min(dl, dr, dn, df);
        if (m === dl) pos.x = b.min[0] - r; else if (m === dr) pos.x = b.max[0] + r;
        else if (m === dn) pos.z = b.min[2] - r; else pos.z = b.max[2] + r;
        hit = true;
      }
      if (!wallGrid.count) return hit;
      const yLo = pos.y + stepHeight + r;
      const yHi = Math.max(yLo, pos.y + height - r);
      const n = Math.max(2, Math.ceil((yHi - yLo) / (r * 1.2)) + 1);
      spheres.length = 0;
      for (let i = 0; i < n; i++) spheres.push(yLo + ((yHi - yLo) * i) / (n - 1));

      const t = wallGrid.tris;
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
