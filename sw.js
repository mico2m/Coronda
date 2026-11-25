// Coronda: guarda en el dispositivo de cada jugador lo que el juego baja (modelos, texturas, código, datos), así la
// próxima vez carga desde ahí en vez de bajar todo de nuevo. Lo registra src/game.js (solo en index.html publicado:
// en localhost / dev.html no hace nada, para que mientras modelás veas siempre lo último).
//
// Cómo se mantiene al día: cada vez que se abre el juego se lee version.json (el Studio lo cambia al "Enviar").
// Si cambió, cada archivo guardado se vuelve a confirmar con el servidor la próxima vez que se usa: si no cambió
// (304) no se baja de nuevo; si cambió, se baja solo ese. Además, cada archivo se reconfirma como mucho cada 6 horas.
// Nunca se guarda: version.json, lo pedido con cache "no-store", audio/video (se piden por partes), y nada de otros
// sitios salvo three.js y las fuentes (lotes, casas, chat, pósters y YouTube vienen siempre de internet).
const CACHE = 'coronda-archivos-v2'; // v2: servidor propio (cambió todo el código de red)
const META = '__coronda_version__';
const MAX_AGE = 6 * 3600 * 1000;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(self.location.hostname);
const FOREVER = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/three@[\d.]+\/|fonts\.gstatic\.com\/|fonts\.googleapis\.com\/)/;
const BASE = new URL('./', self.location).href;

let version = null; // la versión publicada que vio este dispositivo la última vez

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('coronda-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

async function storedVersion() {
  if (version !== null) return version;
  const r = await (await caches.open(CACHE)).match(META);
  version = r ? await r.text() : '';
  return version;
}
async function refreshVersion() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`${BASE}version.json?sw=${Date.now()}`, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return storedVersion();
    const v = String((await r.json())?.v ?? '');
    if (v && v !== await storedVersion()) {
      version = v;
      await (await caches.open(CACHE)).put(META, new Response(v));
    }
  } catch { /* sin internet: se sigue con lo guardado */ }
  return storedVersion();
}

// Copia de la respuesta con la marca de cuándo y con qué versión se confirmó
function stamp(res, v) {
  const h = new Headers(res.headers);
  h.set('x-coronda-v', v);
  h.set('x-coronda-t', String(Date.now()));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function handle(req, forever) {
  const cache = await caches.open(CACHE);
  const v = await storedVersion();
  const hit = await cache.match(req);
  if (hit && (forever || (hit.headers.get('x-coronda-v') === v && Date.now() - Number(hit.headers.get('x-coronda-t') || 0) < MAX_AGE))) return hit;
  try {
    const headers = {};
    const etag = hit?.headers.get('etag');
    const lm = hit?.headers.get('last-modified');
    if (etag) headers['If-None-Match'] = etag;
    if (lm) headers['If-Modified-Since'] = lm;
    const res = await fetch(req.url, { headers, cache: 'no-store', credentials: 'same-origin', mode: forever ? 'cors' : 'same-origin' });
    if (res.status === 304 && hit) { await cache.put(req, stamp(hit.clone(), v)); return hit; }
    if (res.ok && res.status === 200) { await cache.put(req, stamp(res.clone(), v)); }
    return res;
  } catch (err) {
    if (hit) return hit; // sin internet: lo que había
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (LOCAL || req.method !== 'GET' || req.headers.has('range') || req.cache === 'no-store') return;
  if (req.destination === 'audio' || req.destination === 'video') return;
  const url = req.url;
  if (FOREVER.test(url)) { e.respondWith(handle(req, true)); return; }
  if (!url.startsWith(BASE)) return; // otros sitios: siempre de internet
  const path = url.slice(BASE.length).split(/[?#]/)[0];
  if (path === 'version.json' || path === 'sw.js' || path.startsWith('dev.html') || path.startsWith('studio/') || path.startsWith('api/')) return;
  // lo del servidor del juego (estado, fotos de perfil) siempre fresco: nunca se guarda
  if (path.startsWith('__coronda/') || path.startsWith('fotos/') || path === 'ws') return;
  if (req.mode === 'navigate') { e.respondWith(refreshVersion().then(() => handle(req, false))); return; }
  e.respondWith((async () => {
    // lo que pide dev.html no se guarda (por si alguien lo abre publicado)
    const c = e.clientId ? await self.clients.get(e.clientId) : null;
    if (c && /\/dev\.html/.test(c.url)) return fetch(req);
    return handle(req, false);
  })());
});
