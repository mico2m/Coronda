// Multijugador sin servidor propio: los navegadores se conectan entre sí (WebRTC) con Trystero.
// Para encontrarse usan relays públicos de Nostr y trackers de WebTorrent (gratis, sin cuentas). Ver src/vendor/trystero.js.
// Además todo viaja por brokers públicos de MQTT (src/net/mqtt.js): anda aunque la conexión directa no se pueda armar.
//
// Qué se comparte: posición, hacia dónde mira, la animación, el personaje elegido, el nombre y la escena.
// Cada jugador ve a los otros que están en su misma escena. Los diálogos, flags y NPC son de cada uno.
//
// Uso (lo hace game.js):
//   const net = await connectServer();          // al abrir el menú: ya cuenta cuántos están jugando
//   net.onCount = (n) => …                      // cambia cuando alguien entra o sale
//   net.start({ scene, me: () => estado })      // al entrar al mundo
//   net.update(dt)                              // en cada cuadro
//   net.setShade(shade)                         // tono de la escena (para que los otros se vean igual)
//
// Probar en una sola PC sin internet: abrí dos pestañas con ?mp=local (usa BroadcastChannel en vez de WebRTC).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLB } from '../core/assets.js';
import { makeUnlit, setShade } from '../systems/shading.js';
import { getUid } from './uid.js';

const APP_ID = 'coronda-mirkuwu-3d';
const SEND_EVERY = 0.1;      // s entre envíos de posición (10 por segundo)
const HEARTBEAT = 2;         // s: aunque no te muevas, se avisa que seguís ahí
const TIMEOUT = 75;          // s sin noticias de alguien conectado -> deja de contarse (la pestaña quedó congelada)
const NAME_HEIGHT = 2.05;    // m: altura de la etiqueta con el nombre
const CHAT_MAX = 120;        // letras por mensaje
const PING_EVERY = 3;        // s entre mediciones de ping a cada jugador
const SEEN_EVERY = 60;       // s entre avisos de "sigo conectado" guardados en el broker (para la última conexión)
const BUBBLE_SECS = 6;       // s que se ve el globo de chat arriba de alguien

// Sala de prueba entre pestañas (misma PC): imita la API de Trystero que usamos
function localRoom(roomId) {
  const id = Math.random().toString(36).slice(2, 10);
  const ch = new BroadcastChannel(`coronda-mp:${roomId}`);
  const actions = new Map();
  const known = new Set();
  const room = {
    selfId: id,
    onPeerJoin: null,
    onPeerLeave: null,
    makeAction(name) {
      const a = { onMessage: null, send(data, opts) { ch.postMessage({ from: id, to: opts?.target ?? null, name, data }); } };
      actions.set(name, a);
      return a;
    },
    leave() { ch.postMessage({ from: id, bye: true }); ch.close(); },
  };
  ch.onmessage = ({ data: m }) => {
    if (m.from === id) return;
    if (m.bye) { if (known.delete(m.from)) room.onPeerLeave?.(m.from); return; }
    if (!known.has(m.from)) { known.add(m.from); room.onPeerJoin?.(m.from); if (!m.hello) ch.postMessage({ from: id, hello: true, to: m.from }); }
    if (m.hello || (m.to && m.to !== id)) return;
    actions.get(m.name)?.onMessage?.(m.data, { peerId: m.from });
  };
  ch.postMessage({ from: id, hello: true });
  addEventListener('pagehide', () => room.leave());
  return room;
}

// Relays de Nostr conocidos y con mucho uso (los que Trystero elige solo a veces están caídos)
const NOSTR_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://purplerelay.com'];

// Se entra a la sala por varios caminos a la vez (MQTT, Nostr y BitTorrent): si uno anda mal, otro igual conecta.
// Desde afuera se ve como una sola sala; un jugador conectado por los dos caminos cuenta una vez.
function mergeRooms(rooms, selfId, status, names = []) {
  const via = new Map(); // peerId -> Set(índice de sala)
  const actions = new Map();
  const merged = {
    selfId,
    onPeerJoin: null,
    onPeerLeave: null,
    onPersisted: null,
    status,
    get peers() { return via.size; },
    // Datos guardados en el broker (solo el camino MQTT los soporta)
    persist(key, data) { rooms.forEach((r) => { try { r.persist?.(key, data); } catch { /* nada */ } }); },
    makeAction(name) {
      if (actions.has(name)) return actions.get(name);
      const parts = rooms.map((r) => r.makeAction(name));
      const a = {
        onMessage: null,
        send(data, opts) {
          parts.forEach((p, i) => {
            if (opts?.target && !via.get(opts.target)?.has(i)) return;
            try { p.send(data, opts); } catch { /* ese camino todavía no está listo */ }
          });
        },
      };
      parts.forEach((p) => { p.onMessage = (data, ctx) => a.onMessage?.(data, ctx); });
      actions.set(name, a);
      return a;
    },
    leave() { rooms.forEach((r) => { try { r.leave(); } catch { /* nada */ } }); },
  };
  rooms.forEach((r, i) => {
    r.onPersisted = (key, data) => merged.onPersisted?.(key, data);
    r.onPeerJoin = (id) => {
      const set = via.get(id) ?? new Set();
      const isNew = !set.size;
      set.add(i); via.set(id, set);
      console.info(`Multijugador: se conectó ${id} (${names[i] ?? i})`);
      if (isNew) merged.onPeerJoin?.(id);
    };
    r.onPeerLeave = (id) => {
      const set = via.get(id);
      if (!set) return;
      set.delete(i);
      if (!set.size) { via.delete(id); merged.onPeerLeave?.(id); }
    };
  });
  return merged;
}

async function openRoom(roomId) {
  const mode = new URLSearchParams(location.search).get('mp'); // local | p2p | mqtt (para probar un solo camino)
  if (mode === 'local') return localRoom(roomId);
  const t = await import('../vendor/trystero.js');
  const { joinMqtt } = await import('./mqtt.js');
  const rooms = [], names = [], sockets = [];
  const add = (name, fn, sock) => { try { rooms.push(fn()); names.push(name); if (sock) sockets.push(sock); } catch (err) { console.warn(`Multijugador (${name}):`, err); } };
  // 1) Por un broker MQTT: los mensajes pasan por un servidor público. Anda en cualquier red y navegador.
  if (mode !== 'p2p') add('MQTT', () => joinMqtt(APP_ID, roomId, t.selfId), () => rooms[names.indexOf('MQTT')]?.sockets());
  // 2) Directo entre navegadores (WebRTC), encontrándose por Nostr y por BitTorrent: más rápido cuando conecta.
  if (mode !== 'mqtt') {
    add('Nostr', () => t.joinNostr({ appId: APP_ID, relayConfig: { urls: NOSTR_RELAYS } }, roomId), t.nostrSockets);
    add('BitTorrent', () => t.joinTorrent({ appId: APP_ID }, roomId), t.torrentSockets);
  }
  if (!rooms.length) throw new Error('no se pudo entrar a la sala');
  const status = () => {
    let open = 0, total = 0;
    for (const get of sockets) for (const ws of Object.values(get?.() ?? {})) { total++; if (ws?.readyState === 1) open++; }
    return { open, total };
  };
  const room = mergeRooms(rooms, t.selfId, status, names);
  addEventListener('pagehide', () => room.leave());
  return room;
}

function nameTag(text) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const size = 30, pad = 12;
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
  c.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  c.height = size + pad * 2;
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(10,14,16,0.6)';
  ctx.beginPath(); ctx.roundRect(0, 0, c.width, c.height, c.height / 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  const h = 0.32;
  s.scale.set((h * c.width) / c.height, h, 1);
  s.position.y = NAME_HEIGHT;
  s.renderOrder = 10;
  return s;
}

// Se conecta a la sala ("servidor"). Desde acá ya se sabe cuántos están jugando.
export async function connectServer(roomId = 'coronda') {
  const room = await openRoom(roomId);
  const state = room.makeAction('estado');   // { s: escena, p: [x,y,z], f: giro, a: clip, m: modelo, n: nombre, … }
  const chat = room.makeAction('chat');      // { n: nombre, t: texto, s: escena }
  const pingAct = room.makeAction('ping');   // { q: hora } pregunta · { r: hora } respuesta (para medir el ping)
  const peers = new Map();                    // peerId -> { last, data, avatar }
  let me = null, scene3d = null, shade = null, playing = false;
  let beatT = 0, lastSent = '';
  const templates = new Map();                // modelo -> Promise<gltf>

  const net = {
    selfId: room.selfId,
    onCount: null,
    // { open, total } relays/trackers conectados, y con cuántos navegadores hay conexión directa
    get network() { return { ...(room.status?.() ?? { open: 1, total: 1 }), peers: peers.size }; },
    // Cuántos están adentro del mundo (sin contar los que miran el menú). Si vos estás jugando, te cuenta.
    get count() { let n = playing ? 1 : 0; for (const p of peers.values()) if (p.data?.playing) n++; return n; },
    start(opts) {
      scene3d = opts.scene; me = opts.me; playing = true; sendNow(); emitCount();
      saveSeen();
      setInterval(saveSeen, SEEN_EVERY * 1000);
      addEventListener('pagehide', saveSeen);
      // Envío con un reloj propio (no con los cuadros): sigue andando aunque la pestaña quede en segundo plano
      setInterval(() => {
        if (!playing) return;
        beatT += SEND_EVERY;
        const s = myState();
        const j = JSON.stringify(s);
        if (j !== lastSent || beatT >= HEARTBEAT) { lastSent = j; beatT = 0; state.send(s); }
      }, SEND_EVERY * 1000);
    },
    setShade(s) { shade = s; for (const p of peers.values()) if (p.avatar?.model) setShade(p.avatar.model, shade); },
    update,
    onChat: null,   // (nombre, texto, peerId) cuando alguien escribe en el chat
    // Manda un mensaje de chat a todos (y aparece en un globo arriba de tu personaje en las pantallas de los demás)
    say(text) {
      const t = String(text ?? '').trim().slice(0, CHAT_MAX);
      if (!t || !playing) return null;
      const s = me?.();
      chat.send({ n: s?.n ?? 'Jugador', t, s: s?.s ?? null, i: Math.random().toString(36).slice(2, 10) + Date.now().toString(36) }); // i: id único, para descartar copias
      return t;
    },
    leave() { try { room.leave(); } catch { /* nada */ } },
    // Salir del servidor en pleno juego (ej. por inactividad): los demás dejan de verte y vos a ellos
    disconnect() {
      if (!playing) return;
      try { state.send({ playing: false }); } catch { /* nada */ }
      saveSeen();
      playing = false;
      for (const p of peers.values()) removeAvatar(p);
      peers.clear();
      emitCount();
      setTimeout(() => net.leave(), 300);
    },
  };
  // Canales de datos de los sistemas del juego (lotes, casas…). Cada uno manda mensajes en vivo y puede guardar datos
  // en el broker MQTT (retained: siguen ahí aunque nadie esté conectado). Lo que llega antes de que el juego arme el
  // sistema (mientras estás en el menú) se guarda y se entrega con take().
  //   prefix: los datos guardados de ese canal van con esa marca en la clave (los lotes, sin marca, por compatibilidad)
  const channels = [];
  function channel(name, prefix) {
    const act = room.makeAction(name);
    const inbox = [], saved = new Map();
    const ch = {
      prefix,
      send(data, target) { act.send(data, target ? { target } : undefined); },
      persist(key, data) { room.persist?.(prefix + key, data); },
      onMessage: null,   // (data, peerId)
      onPersisted: null, // (clave, dato)
      onPeer: null,      // (peerId) alguien nuevo entró
      take() { const a = inbox.splice(0), b = [...saved]; saved.clear(); return { messages: a, saved: b }; },
      _saved(key, data) { if (ch.onPersisted) ch.onPersisted(key, data); else if (saved.size < 500) saved.set(key, data); },
    };
    act.onMessage = (data, { peerId }) => { if (ch.onMessage) ch.onMessage(data, peerId); else if (inbox.length < 200) inbox.push({ data, peerId }); };
    channels.push(ch);
    return ch;
  }
  net.lotes = channel('lotes', '');      // ver systems/lotes.js
  net.casas = channel('casas', 'casa~'); // ver systems/casas.js (interiores)
  const SEEN = 'visto~';                 // última conexión de cada jugador (ver players())
  const NAME = 'nombre~';                // registro de nombres: cada nombre es de un solo jugador (ver checkName)
  room.onPersisted = (key, data) => {
    if (key.startsWith(SEEN)) { seenFromBroker(key.slice(SEEN.length), data); return; }
    if (key.startsWith(NAME)) { nameFromBroker(key.slice(NAME.length), data); return; }
    const ch = channels.find((c) => c.prefix && key.startsWith(c.prefix)) ?? net.lotes;
    ch._saved(ch.prefix ? key.slice(ch.prefix.length) : key, data);
  };

  // ---------- Lista de jugadores (Tab): ping y última conexión ----------
  const uid = getUid();

  // ---------- Nombres únicos ----------
  // Base de datos de nombres guardada en el broker (retained, nombre~<nombre normalizado> = { u: id del jugador, n, t }).
  // Se va llenando sola: cada jugador que entra al servidor reserva su nombre. Un nombre reservado por otro id no se
  // puede usar, así nadie puede hacerse pasar por otro (ni quedarse con su lote: los lotes son del id, con ese nombre).
  const names = new Map(); // normalizado -> { u, n, t }
  let namesSince = 0;      // cuándo empezó a llegar el registro
  function nameFromBroker(k, d) {
    if (!d || typeof d !== 'object' || !d.u) return;
    const cur = names.get(k);
    const t = Number(d.t) || 0;
    if (!cur || t < cur.t) names.set(k, { u: String(d.u).slice(0, 40), n: String(d.n ?? '').slice(0, 20), t }); // gana el primero que lo reservó
  }
  net.normName = (name) => String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  // 'libre' · 'tuyo' · 'ocupado' (lo tiene otro jugador, en el registro o conectado ahora con ese nombre)
  net.checkName = (name) => {
    const k = net.normName(name);
    if (!k) return 'invalido';
    const r = names.get(k);
    if (r && r.u !== uid) return 'ocupado';
    for (const p of peers.values()) if (p.data?.u && p.data.u !== uid && net.normName(p.data.n) === k) return 'ocupado';
    return r ? 'tuyo' : 'libre';
  };
  net.claimName = (name) => {
    const k = net.normName(name);
    if (!k || net.checkName(name) === 'ocupado') return false;
    const rec = names.get(k) ?? { u: uid, n: String(name).slice(0, 20), t: Date.now() };
    names.set(k, rec);
    room.persist?.(NAME + k, rec);
    return true;
  };
  // ¿Ya llegó el registro? (unos segundos después de conectarse a un broker MQTT)
  const watchNames = setInterval(() => { if (!namesSince && (room.status?.().open ?? 1) > 0) { namesSince = performance.now(); clearInterval(watchNames); } }, 200);
  net.namesReady = () => {
    if (!room.status) return true; // prueba local entre pestañas
    return namesSince > 0 && performance.now() - namesSince > 2500;
  };
  // Busca a un jugador por su nombre (registro de nombres o conectado ahora): { u: id, n: nombre } o null
  net.findPlayer = (name) => {
    const k = net.normName(name);
    if (!k) return null;
    const r = names.get(k);
    if (r) return { u: r.u, n: r.n || name };
    for (const p of peers.values()) if (p.data?.u && net.normName(p.data.n) === k) return { u: p.data.u, n: p.data.n };
    return null;
  };
  // Un nombre libre de la forma "Viajero 1234"
  net.freeName = (base = 'Viajero') => {
    for (let i = 0; i < 50; i++) { const n = `${base} ${Math.floor(1000 + Math.random() * 9000)}`; if (net.checkName(n) === 'libre') return n; }
    return `${base} ${uid.slice(0, 4)}`;
  };
  const seen = new Map(); // uid -> { n, c, s, t } (t = Date.now() de su última señal)
  function seenFromBroker(u, d) {
    if (!/^[a-z0-9]{4,40}$/i.test(u) || !d || typeof d !== 'object') return;
    const t = Number(d.t);
    if (!Number.isFinite(t)) return;
    const cur = seen.get(u);
    if (!cur || t > cur.t) seen.set(u, { n: String(d.n ?? 'Jugador').slice(0, 20), c: String(d.c ?? '').slice(0, 30), s: String(d.s ?? '').slice(0, 60), t });
  }
  function saveSeen() {
    const s = me?.();
    if (!s || !playing) return;
    const rec = { n: s.n, c: s.cn ?? '', s: s.s ?? '', t: Date.now() };
    seen.set(uid, rec);
    room.persist?.(SEEN + uid, rec);
  }
  pingAct.onMessage = (data, { peerId }) => {
    if (data?.q !== undefined) { pingAct.send({ r: data.q }, { target: peerId }); return; }
    const p = peers.get(peerId);
    if (p && data?.r !== undefined && data.r === p.pingAsk) { p.ping = Math.round(performance.now() - data.r); p.pingAsk = null; }
  };
  setInterval(() => {
    for (const [id, p] of peers) {
      if (!p.data?.playing) continue;
      p.pingAsk = performance.now();
      pingAct.send({ q: p.pingAsk }, { target: id });
    }
  }, PING_EVERY * 1000);
  // Todos los jugadores: los conectados (con su ping) y los que estuvieron antes (con su última conexión), los más recientes primero
  // Posiciones de los otros jugadores que están en tu misma escena (para el minimapa)
  net.positions = () => {
    const mine = me?.()?.s;
    const out = [];
    for (const p of peers.values()) if (p.data?.playing && p.data.s === mine && p.data.p) out.push({ x: p.data.p[0], z: p.data.p[2] });
    return out;
  };
  net.players = () => {
    const list = [];
    const online = new Set();
    const mine = me?.();
    if (playing && mine) { list.push({ me: true, online: true, n: mine.n, c: mine.cn ?? '', s: mine.s, ping: 0, t: Date.now() }); online.add(uid); }
    for (const p of peers.values()) {
      const d = p.data;
      if (!d?.playing) continue;
      if (d.u) online.add(d.u);
      list.push({ online: true, n: d.n ?? 'Jugador', c: d.cn ?? '', s: d.s, ping: p.ping ?? null, t: Date.now() });
    }
    const off = [...seen].filter(([u]) => !online.has(u)).map(([, r]) => ({ online: false, ...r, ping: null }));
    off.sort((a, b) => b.t - a.t);
    return [...list, ...off.slice(0, 40)];
  };
  const emitCount = () => net.onCount?.(net.count);
  // Para revisar desde la consola (F12): corondaNet.debug()
  net.debug = () => ({ yo: room.selfId, jugando: playing, red: net.network, otros: [...peers].map(([id, p]) => ({ id, jugando: !!p.data?.playing, escena: p.data?.s, nombre: p.data?.n, hace: Math.round((performance.now() - p.last) / 100) / 10 })) });
  window.corondaNet = net;

  room.onPeerJoin = (id) => {
    peers.set(id, { last: performance.now(), data: null, avatar: null });
    if (playing) sendNow(id); // que el nuevo te vea enseguida
    channels.forEach((c) => c.onPeer?.(id));
  };
  room.onPeerLeave = (id) => { drop(id); emitCount(); };
  state.onMessage = (data, { peerId }) => {
    let p = peers.get(peerId);
    if (!p) { p = { last: 0, data: null, avatar: null }; peers.set(peerId, p); }
    const wasPlaying = !!p.data?.playing;
    p.last = performance.now();
    p.data = data;
    if (wasPlaying !== !!data?.playing) emitCount();
    if (p.avatar && p.avatar.modelUrl !== data.m) { removeAvatar(p); }
  };

  // Cada mensaje llega una vez por cada camino (MQTT en 2 brokers, Nostr, BitTorrent): se muestra solo la primera copia.
  // Los mensajes traen un id (i). Si viene de una versión vieja sin id, se descarta el mismo texto del mismo jugador a los 3 s.
  const chatSeen = new Map(); // clave -> hasta cuándo se recuerda (ms)
  function chatDuplicate(peerId, data, t) {
    const now = performance.now();
    for (const [k, until] of chatSeen) if (until < now) chatSeen.delete(k);
    const id = typeof data?.i === 'string' && data.i ? data.i.slice(0, 40) : null;
    const key = id ? `${peerId}:${id}` : `${peerId}|${t}`;
    if (chatSeen.has(key)) return true;
    chatSeen.set(key, now + (id ? 120000 : 3000));
    return false;
  }
  chat.onMessage = (data, { peerId }) => {
    const t = String(data?.t ?? '').trim().slice(0, CHAT_MAX);
    if (!t) return;
    if (chatDuplicate(peerId, data, t)) return;
    const p = peers.get(peerId);
    const name = String(data?.n || p?.data?.n || 'Jugador').slice(0, 20);
    net.onChat?.(name, t, peerId);
    if (p?.avatar) showBubble(p.avatar, t);
  };

  // Globo con el mensaje arriba de la cabeza (encima del nombre)
  function showBubble(av, text) {
    if (av.bubble) { av.root.remove(av.bubble); av.bubble.material.map.dispose(); av.bubble.material.dispose(); }
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const size = 28, pad = 14, maxW = 520;
    ctx.font = `500 ${size}px Inter, system-ui, sans-serif`;
    const words = text.split(/\s+/), lines = [];
    let line = '';
    for (const w of words) { const t = line ? `${line} ${w}` : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line);
    const shown = lines.slice(0, 4);
    const w = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l).width))) + pad * 2;
    const lh = size * 1.25, h = shown.length * lh + pad * 2 + 12;
    c.width = Math.ceil(w); c.height = Math.ceil(h);
    ctx.font = `500 ${size}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.roundRect(0, 0, c.width, c.height - 12, 16); ctx.fill();
    ctx.beginPath(); ctx.moveTo(c.width / 2 - 10, c.height - 12); ctx.lineTo(c.width / 2, c.height); ctx.lineTo(c.width / 2 + 10, c.height - 12); ctx.fill();
    ctx.fillStyle = '#12212b'; ctx.textBaseline = 'top';
    shown.forEach((l, i) => ctx.fillText(l, pad, pad + i * lh));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
    const k = 0.0062; // metros por píxel
    s.scale.set(c.width * k, c.height * k, 1);
    s.center.set(0.5, 0);
    s.position.y = NAME_HEIGHT + 0.25;
    s.renderOrder = 11;
    av.root.add(s);
    av.bubble = s;
    av.bubbleUntil = performance.now() + BUBBLE_SECS * 1000;
  }

  function drop(id) {
    const p = peers.get(id);
    if (p) removeAvatar(p);
    peers.delete(id);
  }
  function removeAvatar(p) {
    if (!p.avatar) return;
    p.avatar.root.parent?.remove(p.avatar.root);
    p.avatar.tag.material.map.dispose(); p.avatar.tag.material.dispose();
    p.avatar = null;
  }

  function myState() {
    const s = me?.();
    return s ? { playing: true, u: uid, ...s } : { playing: false };
  }
  function sendNow(target) {
    const s = myState();
    lastSent = JSON.stringify(s);
    state.send(s, target ? { target } : undefined);
  }

  // Muestra a un jugador con su personaje (el .glb se descarga una vez y se clona)
  function avatarFor(p) {
    if (p.avatar || p.loading) return;
    const d = p.data;
    const url = d.m;
    if (!templates.has(url)) {
      templates.set(url, loadGLB(url).then((g) => { makeUnlit(g.scene); return g; }).catch((err) => { console.warn(`Multijugador: ${err.message}`); return null; }));
    }
    p.loading = true;
    templates.get(url).then((g) => {
      p.loading = false;
      if (p.avatar || ![...peers.values()].includes(p) || !p.data) return; // se fue mientras cargaba
      const root = new THREE.Group();
      root.name = `jugador:${d.n ?? ''}`;
      const pivot = new THREE.Group();
      root.add(pivot);
      let model, mixer = null, clips = [];
      if (g) {
        model = cloneSkinned(g.scene);
        model.scale.setScalar(Number(d.sc) || 1);
        model.rotation.y = THREE.MathUtils.degToRad(Number(d.yo) || 0);
        clips = g.animations;
        if (clips.length) mixer = new THREE.AnimationMixer(model);
      } else { // no se pudo cargar su personaje: una cápsula
        model = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1, 4, 12), new THREE.MeshBasicMaterial({ color: 0xe0a458 }));
        model.position.y = 0.85;
      }
      if (shade) setShade(model, shade);
      pivot.add(model);
      const tag = nameTag(d.n || 'Jugador');
      root.add(tag);
      root.position.fromArray(d.p);
      pivot.rotation.y = d.f ?? 0;
      scene3d?.add(root);
      p.avatar = { root, pivot, model, mixer, clips, action: null, clip: null, modelUrl: url, name: d.n, tag };
    });
  }

  function playOn(av, name) {
    if (!av.mixer || av.clip === name) return;
    const clip = av.clips.find((c) => c.name === name) ?? av.clips.find((c) => /idle/i.test(c.name)) ?? av.clips[0];
    if (!clip) return;
    av.clip = name;
    const next = av.mixer.clipAction(clip);
    if (next === av.action) return;
    next.reset().setEffectiveWeight(1).fadeIn(0.2).play();
    av.action?.fadeOut(0.2);
    av.action = next;
  }

  function update(dt) {
    const now = performance.now();
    const myScene = playing ? me?.()?.s : null;
    for (const [id, p] of peers) {
      p.id = id;
      // Sin noticias hace mucho: no se cuenta ni se muestra (la conexión la cierra onPeerLeave)
      if (p.data?.playing && now - p.last > TIMEOUT * 1000) { p.data = { playing: false }; removeAvatar(p); emitCount(); continue; }
      const d = p.data;
      const visible = playing && d?.playing && d.s === myScene;
      if (!visible) { if (p.avatar) p.avatar.root.visible = false; continue; }
      if (d.n !== p.avatar?.name && p.avatar) { removeAvatar(p); }
      if (!p.avatar) { avatarFor(p); continue; }
      const av = p.avatar;
      av.root.visible = true;
      // Se acerca suave a la última posición recibida (si está muy lejos, salta: un teleport)
      const tx = d.p[0], ty = d.p[1], tz = d.p[2];
      const far = Math.hypot(tx - av.root.position.x, tz - av.root.position.z) > 6;
      const k = far ? 1 : Math.min(1, dt * 12);
      av.root.position.x += (tx - av.root.position.x) * k;
      av.root.position.y += (ty - av.root.position.y) * k;
      av.root.position.z += (tz - av.root.position.z) * k;
      let dy = ((d.f - av.pivot.rotation.y + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      av.pivot.rotation.y += dy * Math.min(1, dt * 12);
      playOn(av, d.a);
      av.mixer?.update(dt);
      if (av.bubble && now > av.bubbleUntil) { av.root.remove(av.bubble); av.bubble.material.map.dispose(); av.bubble.material.dispose(); av.bubble = null; }
    }
  }

  return net;
}
