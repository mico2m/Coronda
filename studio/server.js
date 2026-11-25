// Coronda Studio: servidor local sin dependencias (solo Node 18+).
// Uso, desde la carpeta del proyecto:   node studio/server.js        (o:  node studio/server.js ruta/al/proyecto)
// Después abrí  http://localhost:5173/__studio   (diálogos con nodos: http://localhost:5173/__dialogos)
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PORT = Number(process.env.PORT) || 5173;
const IGNORE = new Set(['node_modules', '.git', 'studio', '.DS_Store']);
const TEXT = new Set(['js', 'mjs', 'json', 'html', 'css', 'md', 'txt', 'svg', 'csv', 'glsl', 'frag', 'vert', 'py']);
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
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
  // GitHub: estado del repositorio y "Enviar a GitHub" (add + commit + pull --rebase + push). Ver gitRun más abajo.
  if (pathname.startsWith('/__git/')) {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, 'Host no permitido');
    const reply = (p) => p.then((r) => send(res, 200, JSON.stringify(r), MIME.json)).catch((e) => send(res, 200, JSON.stringify({ ok: false, error: e.message }), MIME.json));
    if (pathname === '/__git/estado' && req.method === 'GET') return reply(gitStatus());
    if ((pathname === '/__git/enviar' || pathname === '/__git/traer') && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let m = {}; try { m = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* vacío */ }
        reply(pathname === '/__git/enviar' ? gitSend(String(m.mensaje || '').trim()) : gitPull());
      });
      return;
    }
    return send(res, 404, 'No existe');
  }
  if (pathname === '/__studio') return serve(res, path.join(__dirname, 'studio.html'));
  if (pathname === '/__dialogos') { res.writeHead(302, { Location: '/studio/dialogos/' }); return res.end(); } // editor de diálogos (nodos + probar + variables)

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
  console.log(`Coronda Studio\n  Proyecto: ${ROOT}\n  Abrí:     http://localhost:${PORT}/__studio\n  Diálogos: http://localhost:${PORT}/__dialogos\n  (Ctrl+C para cerrar)`);
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

// ---------------- GitHub (git en esta PC) ----------------
// Usa el git instalado (o el que trae GitHub Desktop) con tu usuario de siempre: nada de contraseñas acá.
const { execFile } = require('child_process');
let gitExe = null;
function findGit() {
  if (gitExe) return gitExe;
  const cands = ['git'];
  const local = process.env.LOCALAPPDATA;
  if (local) { // GitHub Desktop trae su propio git
    try {
      const d = path.join(local, 'GitHubDesktop');
      const apps = fs.readdirSync(d).filter((n) => /^app-/.test(n)).sort().reverse();
      for (const a of apps) cands.push(path.join(d, a, 'resources', 'app', 'git', 'cmd', 'git.exe'));
    } catch { /* no está */ }
  }
  for (const p of ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']) cands.push(p);
  return cands;
}
function git(args, timeout = 90000) {
  const list = gitExe ? [gitExe] : findGit();
  return new Promise((resolve, reject) => {
    const tryAt = (i) => {
      if (i >= list.length) return reject(new Error('No encuentro git. Instalá Git (git-scm.com) o GitHub Desktop.'));
      execFile(list[i], args, { cwd: ROOT, timeout, windowsHide: true, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return tryAt(i + 1);
        gitExe = list[i];
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout), err: String(stderr) });
      });
    };
    tryAt(0);
  });
}
async function gitStatus() {
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code) return { ok: false, error: 'Esta carpeta no es un repositorio de git.' };
  const st = await git(['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  const lines = st.out.split('\n').filter(Boolean);
  const head = lines.shift() || '';
  const m = /^## ([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head) || [];
  const ahead = +(/ahead (\d+)/.exec(m[3] || '')?.[1] || 0), behind = +(/behind (\d+)/.exec(m[3] || '')?.[1] || 0);
  const remote = (await git(['remote', 'get-url', 'origin'])).out.trim();
  const files = lines.map((l) => ({ code: l.slice(0, 2).trim() || '?', path: l.slice(3).replace(/^"|"$/g, '') }));
  return { ok: true, branch: m[1] || '?', upstream: m[2] || null, ahead, behind, remote, files };
}
const explainGit = (t) => {
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|denied/i.test(t)) return 'GitHub no aceptó tu usuario desde acá. Los cambios quedaron guardados en un commit: abrí GitHub Desktop y apretá "Push origin" (o iniciá sesión en Git una vez).';
  if (/Please tell me who you are|user\.email/i.test(t)) return 'Git no sabe tu nombre: en GitHub Desktop andá a File > Options > Git y completá nombre y email.';
  if (/CONFLICT|could not apply|Resolve all conflicts/i.test(t)) return 'Tus cambios chocan con cambios que ya estaban en GitHub. Resolvelo en GitHub Desktop.';
  if (/Could not resolve host|unable to access/i.test(t)) return 'Sin conexión con GitHub.';
  return '';
};
// version.json: cada envío a GitHub le pone una versión nueva. Los jugadores que tienen el juego abierto la revisan cada
// minuto y, si cambió, les aparece "Hay una nueva actualización" (ver src/ui/update-notice.js). Se escribe después de
// traer lo de GitHub, en su propio commit, así nunca choca con otro cambio.
async function stampVersion(message, step) {
  const v = { v: Date.now(), fecha: new Date().toISOString(), mensaje: String(message || '').slice(0, 200) };
  fs.writeFileSync(path.join(ROOT, 'version.json'), JSON.stringify(v, null, 2) + '\n');
  await step('versión', ['add', 'version.json']);
  await step('versión', ['commit', '-m', `Versión ${new Date(v.v).toLocaleString('es-AR')}`]);
}
async function gitSend(message) {
  const log = [];
  const step = async (label, args) => { const r = await git(args); log.push(`$ git ${args.join(' ')}`, (r.out + r.err).trim()); if (r.code) { const e = new Error(explainGit(r.out + r.err) || `Falló: ${label}`); e.log = log; throw e; } return r; };
  try {
    const st = await gitStatus();
    if (!st.ok) return st;
    if (st.files.length) {
      await step('agregar', ['add', '-A']);
      await step('commit', ['commit', '-m', message || `Cambios desde el Studio (${new Date().toLocaleString('es-AR')})`]);
    } else if (!st.ahead) return { ok: true, nothing: true, log: ['No hay cambios para enviar.'] };
    if (st.upstream) {
      const pull = await git(['pull', '--rebase', '--autostash']);
      log.push('$ git pull --rebase --autostash', (pull.out + pull.err).trim());
      if (pull.code) { await git(['rebase', '--abort']); throw Object.assign(new Error(explainGit(pull.out + pull.err) || 'No se pudo traer lo que había en GitHub.'), { log }); }
      await stampVersion(message, step);
      await step('enviar', ['push']);
    } else {
      await stampVersion(message, step);
      await step('enviar', ['push', '-u', 'origin', st.branch]);
    }
    return { ok: true, log };
  } catch (e) {
    return { ok: false, error: e.message, log: e.log || log };
  }
}
async function gitPull() {
  const r = await git(['pull', '--rebase', '--autostash']);
  const t = (r.out + r.err).trim();
  if (r.code) { await git(['rebase', '--abort']); return { ok: false, error: explainGit(t) || 'No se pudo traer los cambios.', log: ['$ git pull --rebase --autostash', t] }; }
  return { ok: true, log: ['$ git pull --rebase --autostash', t] };
}
