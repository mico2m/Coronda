// Prende el servidor de Coronda y el túnel de Cloudflare (cada uno en su ventana), espera el enlace, lo abre en el
// navegador y lo copia. Lo usa "Iniciar servidor y enlace.bat" (doble clic). Solo Windows.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let puerto = 8080;
try { puerto = Number(JSON.parse(fs.readFileSync(path.join(ROOT, 'servidor/config.json'), 'utf8')).puerto) || 8080; } catch { /* el de siempre */ }
const LOCAL = `http://localhost:${puerto}`;
const METRICAS = '127.0.0.1:20241';
const LOG = path.join(os.tmpdir(), 'coronda-tunel.log');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function responde(url) {
  try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000); const r = await fetch(`${url}/__coronda/estado`, { signal: c.signal }); clearTimeout(t); return r.ok; } catch { return false; }
}
// Abre una ventana de cmd nueva con ese título y ese comando
function ventana(titulo, comando) {
  spawn('cmd.exe', ['/c', `start "${titulo}" cmd /k ${comando}`], { cwd: ROOT, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
}
const hay = (prog) => spawnSync('where', [prog], { stdio: 'ignore' }).status === 0;

console.log('\n  Coronda: servidor + enlace\n  ==========================\n');
if (!hay('cloudflared')) {
  console.log('  No está instalado cloudflared (el túnel). Instalalo con:');
  console.log('     winget install --id Cloudflare.cloudflared');
  console.log('  y después cerrá esta ventana y volvé a abrir el archivo.');
  process.exit(1);
}

// 1) El servidor
if (await responde(LOCAL)) console.log('  El servidor ya estaba prendido.');
else {
  console.log('  Prendiendo el servidor...');
  ventana('Servidor de Coronda (no cerrar)', 'node servidor\\coronda-server.mjs');
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) { await espera(1000); ok = await responde(LOCAL); }
  if (!ok) { console.log('  El servidor no arrancó. Mirá la ventana "Servidor de Coronda".'); process.exit(1); }
}
console.log(`  Servidor prendido: ${LOCAL}`);

// 2) El túnel
try { fs.unlinkSync(LOG); } catch { /* no estaba */ }
console.log('  Abriendo el túnel de Cloudflare...');
ventana('Tunel de Coronda (no cerrar)', `cloudflared tunnel --url ${LOCAL} --metrics ${METRICAS} --logfile "${LOG}"`);
let enlace = null;
for (let i = 0; i < 60 && !enlace; i++) {
  await espera(1000);
  try { const j = await (await fetch(`http://${METRICAS}/quicktunnel`)).json(); if (j?.hostname) enlace = `https://${j.hostname}`; } catch { /* todavía no */ }
  if (!enlace) { try { enlace = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(fs.readFileSync(LOG, 'utf8'))?.[0] ?? null; } catch { /* todavía no */ } }
}
if (!enlace) { console.log('  No apareció el enlace. Mirá la ventana "Tunel de Coronda".'); process.exit(1); }

// 3) Esperar a que el enlace ande, abrirlo y copiarlo
console.log(`  Enlace: ${enlace}  (activándose, puede tardar unos segundos...)`);
for (let i = 0; i < 40 && !(await responde(enlace)); i++) await espera(1000);
fs.writeFileSync(path.join(ROOT, 'servidor', 'enlace-actual.txt'), enlace + '\n');
try { spawnSync('clip', { input: enlace }); } catch { /* sin portapapeles */ }
spawn('cmd.exe', ['/c', `start "" "${enlace}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
console.log('\n  =====================================================');
console.log('   Enlace para tus amigos (ya está copiado, Ctrl+V):\n');
console.log(`     ${enlace}\n`);
console.log(`   Vos podés entrar también por  ${LOCAL}`);
console.log('  =====================================================\n');
console.log('  Dejá abiertas las ventanas "Servidor de Coronda" y "Tunel de Coronda".');
console.log('  Para apagar todo: cerrá esas dos ventanas. Esta la podés cerrar.');
console.log('  Cada vez que abrís el túnel el enlace cambia (queda en servidor\\enlace-actual.txt).');
