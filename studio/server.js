// Coronda Studio: servidor local sin dependencias (solo Node 18+).
// Uso, desde la carpeta del proyecto:   node studio/server.js        (o:  node studio/server.js ruta/al/proyecto)
// Después abrí  http://localhost:5173/__studio
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PORT = Number(process.env.PORT) || 5173;
const IGNORE = new Set(['node_modules', '.git', 'studio', '.DS_Store']);
const TEXT = new Set(['js', 'mjs', 'json', 'html', 'css', 'md', 'txt', 'svg', 'csv', 'glsl', 'frag', 'vert', 'py']);
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
};
const ext = (p) => path.extname(p).slice(1).toLowerCase();
const clients = new Set();      // pestañas del Studio escuchando cambios
const mine = new Map();         // archivos que guardó el propio Studio (para no avisar dos veces)

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};
const broadcast = (m) => clients.forEach((r) => r.write(`data: ${JSON.stringify(m)}\n\n`));
const resolveIn = (rel) => { const p = path.join(ROOT, rel); return p === ROOT || p.startsWith(ROOT + path.sep) ? p : null; };
const serve = (res, file) => {
  const s = fs.createReadStream(file);
  s.on('error', () => send(res, 404, 'No existe'));
  s.on('open', () => { res.writeHead(200, { 'Content-Type': MIME[ext(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); s.pipe(res); });
};
function walk(dir, base = '') {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel)); else out.push(rel);
  }
  return out;
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch { return send(res, 400, 'URL inválida'); }

  if (pathname === '/__events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (pathname === '/__studio') return serve(res, path.join(__dirname, 'studio.html'));
  if (pathname === '/__motor') { res.writeHead(302, { Location: '/studio/editor/' }); return res.end(); } // el motor (editor de escenas)

  if (pathname.startsWith('/__api/')) {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, 'Host no permitido');
    if (pathname === '/__api/tree') {
      return send(res, 200, JSON.stringify({ name: path.basename(ROOT), files: walk(ROOT).map((p) => ({ p, t: TEXT.has(ext(p)) })) }), MIME.json);
    }
    if (pathname === '/__api/file') {
      const rel = (u.searchParams.get('p') || '').replace(/^[\\/]+/, '');
      const f = resolveIn(rel);
      if (!f || f === ROOT || /(^|[\\/])\.git([\\/]|$)/.test(rel)) return send(res, 403, 'Ruta no permitida');
      if (req.method === 'GET') { try { return send(res, 200, fs.readFileSync(f, 'utf8')); } catch { return send(res, 404, 'No existe'); } }
      if (req.method === 'PUT') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, Buffer.concat(chunks));
            const key = rel.replace(/\\/g, '/');
            mine.set(key, Date.now());
            broadcast({ path: key });
            send(res, 200, 'ok');
          } catch (e) { send(res, 500, e.message); }
        });
        return;
      }
    }
    return send(res, 404, 'No existe');
  }

  // Todo lo demás: el proyecto, tal cual (así corre el juego en el previsualizador)
  let f = resolveIn(pathname.replace(/^[\\/]+/, ''));
  if (!f) return send(res, 403, 'Ruta no permitida');
  try { if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); } catch { /* 404 abajo */ }
  serve(res, f);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Coronda Studio\n  Proyecto: ${ROOT}\n  Motor:    http://localhost:${PORT}/__motor\n  Studio:   http://localhost:${PORT}/__studio  (diálogos y rutas)\n  (Ctrl+C para cerrar)`);
});

// Cambios hechos desde afuera (Blender exportando un .glb, VS Code, etc.) también refrescan la vista
let timer;
try {
  fs.watch(ROOT, { recursive: true }, (_ev, file) => {
    if (!file) return;
    const key = file.replace(/\\/g, '/');
    if (/(^|\/)(\.git|node_modules|studio)(\/|$)/.test(key) || Date.now() - (mine.get(key) || 0) < 700) return;
    clearTimeout(timer);
    timer = setTimeout(() => broadcast({ path: key, ext: true }), 150);
  });
} catch { console.log('  (Sin vigilancia de cambios externos: hace falta Node 20+ en Linux)'); }
