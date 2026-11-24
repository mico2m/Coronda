// Abre el motor (o el juego) como un programa: arranca el servidor sin ventana negra y abre una ventana propia,
// sin pestañas ni barra de direcciones (Edge o Chrome en modo aplicación). Al cerrar esa ventana se apaga el servidor.
// Lo usan "Coronda Motor.vbs" y "Coronda Juego.vbs" (doble clic, en la carpeta del proyecto).
//   node studio/launch.js          -> motor
//   node studio/launch.js juego    -> el juego (index.html)
const { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 5173;
const what = process.argv[2] === 'juego' ? 'juego' : 'motor';
const URL = `http://localhost:${PORT}/${what === 'juego' ? 'index.html' : 'studio/editor/'}`;
const LOG = path.join(__dirname, 'launch.log');
const log = (...a) => { try { fs.appendFileSync(LOG, `[${new Date().toLocaleString()}] ${a.join(' ')}\n`); } catch {} };

// ¿Ya hay un servidor de Coronda en ese puerto?
const alive = () => new Promise((res) => {
  const r = http.get(`http://127.0.0.1:${PORT}/__api/tree`, (x) => { x.resume(); res(x.statusCode === 200); });
  r.on('error', () => res(false));
  r.setTimeout(800, () => { r.destroy(); res(false); });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Edge viene con Windows; si no está, Chrome; si no, el navegador por defecto (con pestañas)
function findBrowser() {
  const pf = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  const cands = [];
  for (const b of pf) {
    cands.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    cands.push(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (process.platform === 'darwin') cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  if (process.platform === 'linux') cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

(async () => {
  try { if (fs.statSync(LOG).size > 200000) fs.unlinkSync(LOG); } catch {}
  let server = null;
  if (!(await alive())) {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js'), ROOT], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => log('servidor:', String(d).trim()));
    server.stderr.on('data', (d) => log('servidor (error):', String(d).trim()));
    server.on('exit', (c) => log('servidor cerrado, código', c));
    for (let i = 0; i < 40 && !(await alive()); i++) await wait(150);
    if (!(await alive())) { log('No arrancó el servidor (¿el puerto', PORT, 'está ocupado por otro programa?)'); process.exit(1); }
  } else log('El servidor ya estaba abierto: lo uso');

  const browser = findBrowser();
  if (!browser) { // sin Edge ni Chrome: el navegador de siempre
    log('Sin Edge ni Chrome: abro el navegador por defecto');
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL]] : process.platform === 'darwin' ? ['open', [URL]] : ['xdg-open', [URL]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    if (server) server.unref(); // el servidor queda andando (no hay forma de saber cuándo se cierra la pestaña)
    return;
  }
  // Perfil propio: así la ventana es un proceso aparte y sabemos cuándo se cierra
  const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Coronda', `perfil-${what}`);
  fs.mkdirSync(profile, { recursive: true });
  const args = [`--app=${URL}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    what === 'motor' ? '--start-maximized' : '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required'];
  log('Abriendo', path.basename(browser), URL);
  const win = spawn(browser, args, { stdio: 'ignore' });
  win.on('exit', async () => {
    // si había otra ventana del mismo perfil abierta, el proceso nuevo se cierra enseguida: esperamos a que no quede ninguna
    if (process.platform === 'win32') {
      // en Windows el "lockfile" del perfil queda trabado mientras haya una ventana viva de ese perfil
      for (;;) {
        await wait(2000);
        try { fs.unlinkSync(path.join(profile, 'lockfile')); break; } catch (e) { if (e.code === 'ENOENT') break; }
      }
    }
    log('Ventana cerrada');
    if (server) { server.kill(); log('Servidor apagado'); }
    process.exit(0);
  });
})().catch((e) => { log('Error:', e.stack || e.message); process.exit(1); });
