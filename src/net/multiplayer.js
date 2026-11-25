// Multijugador sin servidor propio: los navegadores se conectan entre sí (WebRTC) con Trystero.
// Para encontrarse usan relays públicos de Nostr y trackers de WebTorrent (gratis, sin cuentas). Ver src/vendor/trystero.js.
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

const APP_ID = 'coronda-mirkuwu-3d';
const SEND_EVERY = 0.1;      // s entre envíos de posición (10 por segundo)
const HEARTBEAT = 2;         // s: aunque no te muevas, se avisa que seguís ahí
const TIMEOUT = 8;           // s sin noticias -> se lo saca
const NAME_HEIGHT = 2.05;    // m: altura de la etiqueta con el nombre

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

// Se entra a la sala por dos caminos a la vez (Nostr y BitTorrent): si uno anda mal, el otro igual conecta.
// Desde afuera se ve como una sola sala; un jugador conectado por los dos caminos cuenta una vez.
function mergeRooms(rooms, selfId, status) {
  const via = new Map(); // peerId -> Set(índice de sala)
  const actions = new Map();
  const merged = {
    selfId,
    onPeerJoin: null,
    onPeerLeave: null,
    status,
    get peers() { return via.size; },
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
    r.onPeerJoin = (id) => {
      const set = via.get(id) ?? new Set();
      const isNew = !set.size;
      set.add(i); via.set(id, set);
      console.info(`Multijugador: se conectó ${id} (${i ? 'BitTorrent' : 'Nostr'})`);
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
  const local = new URLSearchParams(location.search).get('mp') === 'local';
  if (local) return localRoom(roomId);
  const t = await import('../vendor/trystero.js');
  const rooms = [];
  try { rooms.push(t.joinNostr({ appId: APP_ID, relayConfig: { urls: NOSTR_RELAYS } }, roomId)); } catch (err) { console.warn('Multijugador (Nostr):', err); }
  try { rooms.push(t.joinTorrent({ appId: APP_ID }, roomId)); } catch (err) { console.warn('Multijugador (BitTorrent):', err); }
  if (!rooms.length) throw new Error('no se pudo entrar a la sala');
  // Cuántos relays/trackers están conectados (para ver si la red anda)
  const status = () => {
    let open = 0, total = 0;
    for (const get of [t.nostrSockets, t.torrentSockets]) {
      for (const ws of Object.values(get?.() ?? {})) { total++; if (ws?.readyState === 1) open++; }
    }
    return { open, total };
  };
  const room = mergeRooms(rooms, t.selfId, status);
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
  const peers = new Map();                    // peerId -> { last, data, avatar }
  let me = null, scene3d = null, shade = null, playing = false;
  let sendT = 0, beatT = 0, lastSent = '';
  const templates = new Map();                // modelo -> Promise<gltf>

  const net = {
    selfId: room.selfId,
    onCount: null,
    // { open, total } relays/trackers conectados, y con cuántos navegadores hay conexión directa
    get network() { return { ...(room.status?.() ?? { open: 1, total: 1 }), peers: peers.size }; },
    // Cuántos están adentro del mundo (sin contar los que miran el menú). Si vos estás jugando, te cuenta.
    get count() { let n = playing ? 1 : 0; for (const p of peers.values()) if (p.data?.playing) n++; return n; },
    start(opts) { scene3d = opts.scene; me = opts.me; playing = true; sendNow(); emitCount(); },
    setShade(s) { shade = s; for (const p of peers.values()) if (p.avatar?.model) setShade(p.avatar.model, shade); },
    update,
    leave() { try { room.leave(); } catch { /* nada */ } },
  };
  const emitCount = () => net.onCount?.(net.count);

  room.onPeerJoin = (id) => {
    peers.set(id, { last: performance.now(), data: null, avatar: null });
    if (playing) sendNow(id); // que el nuevo te vea enseguida
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
    return s ? { playing: true, ...s } : { playing: false };
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
    // Enviar lo tuyo: 10 veces por segundo si cambió, y cada 2 s aunque no cambie
    if (playing) {
      sendT += dt; beatT += dt;
      if (sendT >= SEND_EVERY) {
        sendT = 0;
        const s = myState();
        const j = JSON.stringify(s);
        if (j !== lastSent || beatT >= HEARTBEAT) { lastSent = j; beatT = 0; state.send(s); }
      }
    }
    const myScene = playing ? me?.()?.s : null;
    for (const [id, p] of peers) {
      p.id = id;
      if (now - p.last > TIMEOUT * 1000 && p.data) { drop(id); emitCount(); continue; }
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
    }
  }

  return net;
}
