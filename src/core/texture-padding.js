// Relleno de bordes de UV ("edge padding" / "dilation").
//
// Problema: en Blender se pinta solo lo que se ve (las islas del UV) y el resto de la
// textura queda negro. Al alejarse, la placa de video usa versiones achicadas de la
// textura (mipmaps) que mezclan píxeles vecinos: en los bordes de cada isla se cuela
// ese fondo negro y aparecen líneas oscuras en las costuras del modelo.
//
// Solución: al cargar un .glb, por cada textura se dibujan los triángulos del UV para
// saber qué parte se usa, y todo lo que queda afuera se rellena con el color del borde
// de la isla más cercana. Así los mipmaps ya no tienen negro que mezclar.
// No hace falta tocar nada en Blender: se aplica solo a cada modelo que se carga.

const done = new WeakSet();   // texturas ya procesadas (los clones de NPC comparten textura)
const SOLID = 200;            // cobertura mínima (0-255) para que un píxel cuente como "dentro" del UV
const DARK = 12;              // por debajo de esto, un píxel fuera del UV se toma como fondo sin pintar

export function padUVTextures(root) {
  const byTexture = new Map();

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.uv) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const t = m?.map;
      if (!t || done.has(t) || t.channel) continue;   // solo el primer UV
      if (!byTexture.has(t)) byTexture.set(t, []);
      byTexture.get(t).push(o.geometry);
    }
  });

  for (const [tex, geometries] of byTexture) {
    done.add(tex);
    try { padTexture(tex, geometries); }
    catch (e) { console.warn('[texturas] no se pudo rellenar el borde de', tex.name, e); }
  }
}

function padTexture(tex, geometries) {
  const img = tex.image;
  const W = img?.width, H = img?.height;
  if (!W || !H) return;

  // Máscara: qué píxeles cubre el UV. Se pinta de a tandas de triángulos: un solo camino con decenas de miles
  // de triángulos superpuestos hace que el navegador tarde muchísimo en rellenarlo (con 85.000 eran 10 s).
  const maskCanvas = makeCanvas(W, H);
  const mctx = maskCanvas.getContext('2d');
  mctx.fillStyle = '#fff';
  const BATCH = 200;
  let inPath = 0;
  mctx.beginPath();
  for (const g of geometries) {
    const uv = g.attributes.uv;
    const idx = g.index;
    const n = idx ? idx.count : uv.count;
    for (let i = 0; i < n; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      const u0 = uv.getX(a), v0 = uv.getY(a), u1 = uv.getX(b), v1 = uv.getY(b), u2 = uv.getX(c), v2 = uv.getY(c);
      // Texturas que se repiten (pasto, piso): el UV se sale de 0..1 y no necesitan relleno
      if (u0 < -0.001 || u0 > 1.001 || v0 < -0.001 || v0 > 1.001 || u1 < -0.001 || u1 > 1.001 || v1 < -0.001 || v1 > 1.001
        || u2 < -0.001 || u2 > 1.001 || v2 < -0.001 || v2 > 1.001) return;
      // glTF: el origen del UV está arriba a la izquierda (flipY = false), igual que el canvas
      const f = tex.flipY;
      mctx.moveTo(u0 * W, (f ? 1 - v0 : v0) * H);
      mctx.lineTo(u1 * W, (f ? 1 - v1 : v1) * H);
      mctx.lineTo(u2 * W, (f ? 1 - v2 : v2) * H);
      mctx.closePath();
      if (++inPath >= BATCH) { mctx.fill(); mctx.beginPath(); inPath = 0; }
    }
  }
  if (inPath) mctx.fill();
  const mask = mctx.getImageData(0, 0, W, H).data;

  // Píxeles de la textura
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H);
  const px = data.data;

  // Fuente = dentro del UV, o fuera pero ya pintado (el "bleed" que agrega Blender).
  // El resto (fondo negro sin pintar) se rellena desde la fuente más cercana.
  const N = W * H;
  const filled = new Uint8Array(N);
  const queue = new Int32Array(N);
  let head = 0, tail = 0, empty = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const inside = mask[o + 3] >= SOLID;
    const painted = px[o] > DARK || px[o + 1] > DARK || px[o + 2] > DARK;
    if (inside || (painted && mask[o + 3] === 0)) { filled[i] = 1; queue[tail++] = i; }
    else empty++;
  }
  if (!empty || !tail) return;

  // Crecimiento por anillos (BFS): cada píxel vacío toma el color del vecino ya relleno
  while (head < tail) {
    const i = queue[head++];
    const x = i % W, y = (i / W) | 0;
    if (x > 0) grow(i, i - 1);
    if (x < W - 1) grow(i, i + 1);
    if (y > 0) grow(i, i - W);
    if (y < H - 1) grow(i, i + W);
  }
  function grow(from, to) {
    if (filled[to]) return;
    filled[to] = 1;
    const a = from * 4, b = to * 4;
    px[b] = px[a]; px[b + 1] = px[a + 1]; px[b + 2] = px[a + 2]; px[b + 3] = px[a + 3];
    queue[tail++] = to;
  }

  ctx.putImageData(data, 0, 0);
  tex.image = canvas;
  tex.needsUpdate = true;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
