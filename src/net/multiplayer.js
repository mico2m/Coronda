// Multijugador con servidor propio (servidor/coronda-server.mjs, en la PC del dueño del mundo).
// La conexión, la sesión y el reloj están en net/servidor.js; acá se dibuja a los demás jugadores.
//
// Qué se comparte en vivo: posición, hacia dónde mira, la animación, el personaje y la escena (el servidor les pone
// el nombre y el id de la cuenta: nadie puede hacerse pasar por otro). Todo lo que vale algo (mochila, lotes, pedidos,
// árboles…) lo decide el servidor: los sistemas del juego le piden cosas con net.rpc(op, datos) y reciben los cambios
// por sus canales (onPersisted), igual que antes recibían los datos guardados del broker.
//
// Uso (lo hace game.js):
//   const net = await connectServer();          // al abrir el menú: ya cuenta cuántos están jugando
//   await net.entrar(nombre, clave)             // o net.registrar / net.conToken (ver ui/start-menu.js)
//   net.start({ scene, me: () => estado })      // al entrar al mundo
//   net.update(dt)                              // en cada cuadro
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLB } from '../core/assets.js';
import { makeUnlit, setShade } from '../systems/shading.js';
import { conectar } from './servidor.js';

const SEND_EVERY = 0.1;      // s entre envíos de posición (10 por segundo)
const HEARTBEAT = 2;         // s: aunque no te muevas, se avisa que seguís ahí
const INTERP_DELAY = 140;    // ms: los demás se dibujan este tiempo "atrás", interpolando entre dos posiciones recibidas
const TIMEOUT = 75;          // s sin noticias de alguien conectado -> deja de contarse
const NAME_HEIGHT = 2.05;    // m: altura de la etiqueta con el nombre
const CHAT_MAX = 120;        // letras por mensaje
const PING_EVERY = 3;        // s entre mediciones de ping a cada jugador
const BUBBLE_SECS = 6;       // s que se ve el globo de chat arriba de alguien

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

// Se conecta al servidor. Desde acá ya se sabe cuántos están jugando. Si no responde: Error('apagado').
export async function connectServer() {
  const srv = await conectar();
  const actions = new Map();                  // nombre -> { onMessage }
  const makeAction = (name) => {
    if (!actions.has(name)) actions.set(name, { onMessage: null, send(data, opts) { srv.send({ t: 'a', n: name, d: data, ...(opts?.target ? { to: opts.target } : {}) }); } });
    return actions.get(name);
  };
  const state = makeAction('estado');         // { s: escena, p: [x,y,z], f: giro, a: clip, m: modelo, … }
  const pingAct = makeAction('ping');         // { q: hora } pregunta · { r: hora } respuesta (para medir el ping)
  const peers = new Map();                    // uid -> { last, data, avatar }
  let me = null, scene3d = null, shade = null, playing = false;
  let beatT = 0, lastSent = '';
  const templates = new Map();                // modelo -> Promise<gltf>
  let yo = null;                              // lo privado: { inv, niveles, energia, stats, foto, admin }
  const yoListeners = new Set();

  const net = {
    get selfId() { return srv.sesion?.u ?? ''; },
    get uid() { return srv.sesion?.u ?? ''; },
    get nombre() { return srv.sesion?.nombre ?? ''; },
    get admin() { return !!srv.sesion?.admin; },
    get token() { return srv.sesion?.token ?? ''; },
    base: srv.base,
    onCount: null,
    onEstado: null,           // ('conectado' | 'reconectando' | 'expulsado', texto) para avisar en pantalla
    onAviso: null,            // (texto) avisos del servidor (ej. "Tu pedido volvió al taller")
    onAnuncio: null,          // (texto) anuncios del admin
    onClaudeReset: null,      // () un admin reinició a Claude (/claude reiniciar)
    onTrato: null,            // (msg) intercambios (ver ui/social.js)
    onFoto: null,             // (uid, versión) alguien cambió su foto de perfil
    get network() { return { open: srv.conectado ? 1 : 0, total: 1, peers: peers.size }; },
    get count() { return srv.jugadores; },
    // ----- sesión (ver ui/start-menu.js) -----
    registrar: (n, c) => srv.registrar(n, c),
    entrar: (n, c) => srv.entrar(n, c),
    conToken: () => srv.conToken(),
    tokenGuardado: () => srv.tokenGuardado(),
    salirCuenta: () => srv.salirCuenta(),
    get registroAbierto() { return srv.registroAbierto; },
    // ----- servidor -----
    rpc: (op, a) => srv.rpc(op, a),
    ahora: () => srv.ahora(),
    foto: (u, v) => srv.foto(u, v),
    get yo() { return yo; },
    onYo(fn) { yoListeners.add(fn); if (yo) fn(yo); return () => yoListeners.delete(fn); },
    start(opts) {
      scene3d = opts.scene; me = opts.me; playing = true;
      srv.entrarAlMundo(opts.personaje ?? '');
      sendNow();
      // Envío con un reloj propio (no con los cuadros): sigue andando aunque la pestaña quede en segundo plano
      setInterval(() => {
        if (!playing) return;
        beatT += SEND_EVERY;
        const s = myState();
        const j = JSON.stringify(s);
        if (j !== lastSent || beatT >= HEARTBEAT) { lastSent = j; beatT = 0; state.send(stamp(s)); }
      }, SEND_EVERY * 1000);
    },
    setShade(s) { shade = s; for (const p of peers.values()) if (p.avatar?.model) setShade(p.avatar.model, shade); },
    update,
    onChat: null,   // (nombre, texto, uid) cuando alguien escribe en el chat
    onSystem: null, // (texto) avisos del chat ("Martín se ha unido al mundo")
    say(text) {
      const t = String(text ?? '').trim().slice(0, CHAT_MAX);
      if (!t || !playing) return null;
      srv.send({ t: 'chat', txt: t });
      return t;
    },
    leave() { srv.cerrar(); },
    // Salir del servidor en pleno juego (ej. por inactividad): los demás dejan de verte y vos a ellos
    disconnect() {
      if (!playing) return;
      playing = false;
      for (const p of peers.values()) removeAvatar(p);
      peers.clear();
      setTimeout(() => srv.cerrar(), 200);
    },
  };
  srv.onCuenta = (n) => net.onCount?.(n);
  srv.onEstado = (e, txt) => net.onEstado?.(e, txt);

  // Canales de los sistemas del juego (lotes, casas…). Lo que guarda el servidor llega por onPersisted (clave, dato);
  // send() solo sirve en los canales en vivo (claude, voz): en los demás, los cambios se piden con net.rpc().
  // Lo que llega antes de que el juego arme el sistema (mientras estás en el menú) se guarda y se entrega con take().
  const channels = [];
  function channel(name, prefix, live = false) {
    const act = live ? makeAction(name) : null;
    const inbox = [], saved = new Map();
    const ch = {
      prefix,
      send(data, target) { if (act) act.send(data, target ? { target } : undefined); },
      persist() { console.warn(`Canal ${name}: los datos los guarda el servidor (usá net.rpc).`); },
      onMessage: null,   // (data, uid)
      onPersisted: null, // (clave, dato)
      onPeer: null,      // (uid) alguien nuevo entró
      take() { const a = inbox.splice(0), b = [...saved]; saved.clear(); return { messages: a, saved: b }; },
      _saved(key, data) { if (ch.onPersisted) ch.onPersisted(key, data); else saved.set(key, data); },
    };
    if (act) act.onMessage = (data, { peerId }) => { if (ch.onMessage) ch.onMessage(data, peerId); else if (inbox.length < 200) inbox.push({ data, peerId }); };
    channels.push(ch);
    return ch;
  }
  net.lotes = channel('lotes', '');               // ver systems/lotes.js
  net.claude = channel('claude', 'claude~', true); // ver systems/claude-npc.js (el NPC Claude: lo mueve un jugador, lo ven todos)
  net.casas = channel('casas', 'casa~');          // ver systems/casas.js (interiores)
  net.bosque = channel('bosque', 'bosque~');      // ver systems/bosque.js (árboles caídos)
  net.tienda = channel('tienda', 'tienda~');      // ver systems/tienda.js (pedidos de muebles)
  net.voz = channel('voz', 'voz~', true);         // ver systems/voz.js (señales para armar las llamadas de voz)
  const SEEN = 'visto~';                          // última conexión de cada jugador (ver players())
  const FOTO = 'foto~';
  const fotos = new Map();                        // uid -> versión de su foto
  function persisted(key, data) {
    if (key.startsWith(SEEN)) { seenFromServer(key.slice(SEEN.length), data); return; }
    if (key.startsWith(FOTO)) { fotos.set(key.slice(FOTO.length), data); net.onFoto?.(key.slice(FOTO.length), data); return; }
    const ch = channels.find((c) => c.prefix && key.startsWith(c.prefix)) ?? net.lotes;
    ch._saved(ch.prefix ? key.slice(ch.prefix.length) : key, data);
  }

  // Mensajes del servidor
  srv.onMensaje = (m) => {
    switch (m.t) {
      case 'a': {
        if (m.n === 'estado') onState(m.d, m.from);
        else actions.get(m.n)?.onMessage?.(m.d, { peerId: m.from });
        return;
      }
      case 'join': if (!peers.has(m.from)) peers.set(m.from, { last: performance.now(), data: null, avatar: null }); channels.forEach((c) => c.onPeer?.(m.from)); emitCount(); return;
      case 'leave': drop(m.from); emitCount(); return;
      case 'kv': for (const x of m.lista ?? [{ k: m.k, d: m.d }]) persisted(x.k, x.d); return;
      case 'yo': yo = m; if (m.foto !== undefined) fotos.set(m.u, m.foto); yoListeners.forEach((f) => { try { f(yo); } catch (e) { console.error(e); } }); return;
      case 'hora': net.hora = m.cfg; net.onHora?.(m.cfg); return;
      case 'chat': {
        if (m.sys) { net.onSystem?.(m.txt); return; }
        const t = String(m.txt ?? '').slice(0, CHAT_MAX);
        if (!t) return;
        net.onChat?.(m.n, t, m.from);
        const p = peers.get(m.from);
        if (p?.avatar) showBubble(p.avatar, t);
        return;
      }
      case 'aviso': net.onAviso?.(m.txt); return;
      case 'anuncio': net.onAnuncio?.(m.txt); return;
      case 'claude-reset': net.onClaudeReset?.(); return;
      case 'trato': net.onTrato?.(m); return;
      default:
    }
  };
  net.fotoDe = (u) => { const v = fotos.get(u); return v ? net.foto(u, v) : ''; };

  // ---------- Lista de jugadores (Tab): ping y última conexión ----------
  const seen = new Map(); // uid -> { n, c, s, t }
  function seenFromServer(u, d) {
    if (!d || typeof d !== 'object') return;
    seen.set(u, { n: String(d.n ?? 'Jugador').slice(0, 20), c: String(d.c ?? '').slice(0, 30), s: String(d.s ?? '').slice(0, 60), t: Number(d.t) || 0 });
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
  // Jugadores conectados (vos incluido) con su id, nombre, escena y posición: para el NPC Claude (systems/claude-npc.js)
  net.roster = () => {
    const out = [];
    const mine = me?.();
    if (playing && mine) out.push({ me: true, u: net.uid, n: net.nombre, s: mine.s, p: mine.p, peerId: net.uid });
    for (const [peerId, p] of peers) {
      const d = p.data;
      if (!d?.playing || !d.u || performance.now() - p.last > 15000) continue;
      out.push({ me: false, u: String(d.u), n: d.n ?? 'Jugador', s: d.s, p: d.p, peerId });
    }
    return out;
  };
  // El personaje dibujado de otro jugador (ya interpolado): para el sonido 3D, el ícono de "hablando" y el clic (ui/social.js)
  net.avatarRoot = (peerId) => peers.get(peerId)?.avatar?.root ?? null;
  net.avatars = () => [...peers].filter(([, p]) => p.avatar?.root?.visible).map(([u, p]) => ({ u, n: p.data?.n ?? 'Jugador', root: p.avatar.root }));
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
    if (playing && mine) { list.push({ me: true, online: true, u: net.uid, n: net.nombre, c: mine.cn ?? '', s: mine.s, ping: 0, t: Date.now() }); online.add(net.uid); }
    for (const [u, p] of peers) {
      const d = p.data;
      if (!d?.playing) continue;
      online.add(u);
      list.push({ online: true, u, n: d.n ?? 'Jugador', c: d.cn ?? '', s: d.s, ping: p.ping ?? null, t: Date.now() });
    }
    const off = [...seen].filter(([u]) => !online.has(u)).map(([u, r]) => ({ online: false, u, ...r, ping: null }));
    off.sort((a, b) => b.t - a.t);
    return [...list, ...off.slice(0, 40)];
  };
  const emitCount = () => net.onCount?.(net.count);
  // Para revisar desde la consola (F12): corondaNet.debug()
  net.debug = () => ({ yo: net.uid, servidor: srv.base, conectado: srv.conectado, jugando: playing, desfaseReloj: Math.round(srv.ahora() - Date.now()), otros: [...peers].map(([id, p]) => ({ id, jugando: !!p.data?.playing, escena: p.data?.s, nombre: p.data?.n, hace: Math.round((performance.now() - p.last) / 100) / 10 })) });
  window.corondaNet = net;

  function onState(data, peerId) {
    let p = peers.get(peerId);
    if (!p) { p = { last: 0, data: null, avatar: null }; peers.set(peerId, p); }
    if (Number.isFinite(data?.q) && Number.isFinite(p.q) && data.q <= p.q && data.q > 1) return; // copia vieja
    if (Number.isFinite(data?.q)) p.q = data.q;
    const wasPlaying = !!p.data?.playing;
    p.last = performance.now();
    p.data = data;
    if (data?.playing && Array.isArray(data.p) && Number.isFinite(data.t)) {
      const off = Date.now() - data.t; // diferencia de relojes + demora de la red
      p.off = p.off == null ? off : Math.min(off, p.off + 1);
      (p.snaps ??= []).push({ t: data.t, p: data.p, f: data.f ?? 0, s: data.s, a: data.a });
    }
    if (wasPlaying !== !!data?.playing) emitCount();
    if (p.avatar && p.avatar.modelUrl !== data.m) { removeAvatar(p); }
  }

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
    return s ? { playing: true, u: net.uid, ...s } : { playing: false };
  }
  // Cada envío lleva la hora (t) y un número que crece (q): así el que recibe descarta las copias viejas
  // (cada mensaje llega por varios caminos, y el más lento llega tarde) y sabe cuándo pasó cada posición.
  let seq = 0;
  const stamp = (s) => ({ ...s, t: Date.now(), q: ++seq });
  function sendNow(target) {
    const s = myState();
    lastSent = JSON.stringify(s);
    state.send(stamp(s), target ? { target } : undefined);
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
      // Se dibuja un poquito en el pasado (INTERP_DELAY) entre las dos posiciones recibidas que rodean ese momento:
      // así se mueve parejo aunque los mensajes lleguen a los saltos o desordenados.
      const sn = p.snaps;
      if (sn?.length && p.off != null) {
        const rt = Date.now() - p.off - INTERP_DELAY;
        while (sn.length > 2 && sn[1].t <= rt) sn.shift(); // ya pasaron
        let a = sn[0], b = sn[1];
        let x, y, z, f;
        if (!b || rt <= a.t) { [x, y, z] = a.p; f = a.f; }
        else {
          const k = Math.min(1, (rt - a.t) / Math.max(1, b.t - a.t));
          const jump = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]) > 6 || a.s !== b.s; // teleport: sin deslizar
          const u = jump ? (k < 1 ? 0 : 1) : k;
          x = a.p[0] + (b.p[0] - a.p[0]) * u; y = a.p[1] + (b.p[1] - a.p[1]) * u; z = a.p[2] + (b.p[2] - a.p[2]) * u;
          const df = ((b.f - a.f + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
          f = a.f + df * u;
        }
        av.root.position.set(x, y, z);
        av.pivot.rotation.y = f;
        av.clipNow = (b && rt > a.t ? (rt - a.t) / Math.max(1, b.t - a.t) > 0.5 ? b : a : a).a; // la animación de ese momento
        if (sn.length > 60) sn.splice(0, sn.length - 60);
      } else { // versión vieja sin hora: se acerca suave a la última posición
        const k = Math.min(1, dt * 12);
        av.root.position.x += (d.p[0] - av.root.position.x) * k;
        av.root.position.y += (d.p[1] - av.root.position.y) * k;
        av.root.position.z += (d.p[2] - av.root.position.z) * k;
        av.pivot.rotation.y = d.f ?? av.pivot.rotation.y;
      }
      playOn(av, av.clipNow ?? d.a);
      av.mixer?.update(dt);
      if (av.bubble && now > av.bubbleUntil) { av.root.remove(av.bubble); av.bubble.material.map.dispose(); av.bubble.material.dispose(); av.bubble = null; }
    }
  }

  return net;
}
