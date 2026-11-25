// Chat de voz por proximidad: escuchás a los jugadores que están cerca, en tu misma escena, y la voz suena del lado
// donde está cada uno y más bajo cuanto más lejos (sonido 3D con Web Audio).
//
// Cómo viaja: el audio va directo de navegador a navegador (WebRTC, una llamada por cada jugador cercano). Para armar
// cada llamada se mandan unos mensajes cortos (oferta, respuesta, candidatos) por el canal net.voz del multijugador.
// No pasa por ningún servidor nuestro ni cuesta nada. En algunas redes (datos móviles, redes de facultad) la conexión
// directa no se puede armar: para eso haría falta un servidor de relevo (TURN), que se agrega en ICE_SERVERS.
//
// Ajustes (se cambian en el menú de Esc, ver ui/menu.js; se guardan en localStorage 'coronda.voz'):
//   escuchar  true/false        oír a los demás
//   mic       'apagado' | 'ptt' (apretar para hablar, tecla V o mantener el botón 🎙️) | 'abierto'
//   volumen   0..1.5            volumen de las voces
//
// API: voz.ajustes · voz.set({ mic, escuchar, volumen }) · voz.cerca() (con quiénes hay llamada) · voz.nivel() (tu mic, 0..1)
//      voz.onChange(fn) (cuando cambia algo para redibujar el menú) · voz.boton (el botón 🎙️ del HUD)
import * as THREE from 'three';

const STORE = 'coronda.voz';
const ALCANCE = 15;        // m: más lejos no se escucha nada
const PLENO = 3;           // m: hasta acá se escucha al volumen completo
const CONECTA = ALCANCE + 3; // m: se arma la llamada un poco antes de que se lo pueda oír
const CORTA = ALCANCE + 8;   // m: y se corta un poco después (para no conectar y desconectar en el borde)
const MAX_LLAMADAS = 8;      // con más gente cerca, solo los más cercanos
const ALTURA_BOCA = 1.6;
const ICE_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  // { urls: 'turn:…', username: '…', credential: '…' }, // servidor de relevo, si algún día hace falta
];

const AJUSTES = { escuchar: true, mic: 'apagado', volumen: 1 };
function cargar() {
  try { const a = JSON.parse(localStorage.getItem(STORE) || '{}'); return { ...AJUSTES, ...a, mic: ['apagado', 'ptt', 'abierto'].includes(a.mic) ? a.mic : 'apagado' }; } catch { return { ...AJUSTES }; }
}

// Ícono de "hablando" arriba de la cabeza de otro jugador
function iconoHablando() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,14,16,0.65)';
  ctx.beginPath(); ctx.arc(32, 32, 30, 0, Math.PI * 2); ctx.fill();
  ctx.font = '34px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🔊', 32, 35);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  s.scale.set(0.34, 0.34, 1);
  s.position.y = 2.5;
  s.renderOrder = 11;
  s.visible = false;
  return s;
}

// opts: net, getCamera() (el oído mira hacia donde mira la cámara), stage, notify(msg), blocked() (hay una charla o el
//       chat abierto: la V no habla), onMenu() (el botón 🎙️ con el mic apagado abre el menú)
export function createVoz({ net, getCamera, stage, notify = () => {}, blocked = () => false, onMenu = () => {} }) {
  const ajustes = cargar();
  const guardar = () => { try { localStorage.setItem(STORE, JSON.stringify(ajustes)); } catch { /* nada */ } };
  const listeners = new Set();
  const avisar = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

  // ---------- Audio ----------
  let ctx = null, salida = null;
  function audio() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    salida = ctx.createGain();
    salida.gain.value = ajustes.volumen;
    salida.connect(ctx.destination);
    return ctx;
  }
  // El navegador no deja sonar nada hasta que tocás algo: se destraba con el primer clic o tecla
  const destrabar = () => { const c = audio(); if (c?.state === 'suspended') c.resume().catch(() => {}); };
  addEventListener('pointerdown', destrabar, true);
  addEventListener('keydown', destrabar, true);

  // ---------- Micrófono ----------
  let micStream = null, micTrack = null, micPidiendo = null, micNivel = null;
  let hablando = false; // con 'ptt': la V o el botón apretados
  async function prenderMic() {
    if (micTrack) return true;
    if (micPidiendo) return micPidiendo;
    if (!navigator.mediaDevices?.getUserMedia) { notify('Este navegador no deja usar el micrófono'); return false; }
    micPidiendo = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((s) => {
        micStream = s; micTrack = s.getAudioTracks()[0];
        const c = audio();
        if (c) { const src = c.createMediaStreamSource(s); micNivel = c.createAnalyser(); micNivel.fftSize = 512; src.connect(micNivel); }
        aplicarMic();
        return true;
      })
      .catch((err) => {
        console.warn('Voz: micrófono', err);
        notify(err?.name === 'NotAllowedError' ? 'No hay permiso para el micrófono (se cambia en el candado de la barra de direcciones)' : 'No se encontró un micrófono');
        ajustes.mic = 'apagado'; guardar(); avisar();
        return false;
      })
      .finally(() => { micPidiendo = null; });
    return micPidiendo;
  }
  function apagarMic() {
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null; micTrack = null; micNivel = null;
    aplicarMic();
  }
  const transmitiendo = () => !!micTrack && (ajustes.mic === 'abierto' ? !silenciado : ajustes.mic === 'ptt' && hablando);
  let silenciado = false; // con 'abierto': el botón 🎙️ silencia sin cambiar el modo
  function aplicarMic() {
    if (micTrack) micTrack.enabled = transmitiendo();
    for (const l of llamadas.values()) {
      const t = l.pc.getTransceivers().find((x) => x.receiver.track?.kind === 'audio');
      if (t && t.sender.track !== micTrack) t.sender.replaceTrack(micTrack).catch(() => {});
    }
    dibujarBoton();
  }

  // ---------- Llamadas (una por jugador cercano) ----------
  const llamadas = new Map(); // peerId -> { pc, inicia, el, nodos, icono, hablaHasta, abierta }
  const espera = new Map();   // peerId -> hasta cuándo no reintentar (después de una llamada que falló)
  const vistos = new Set();   // ids de mensajes ya procesados (cada mensaje llega por varios caminos)
  const mid = () => Math.random().toString(36).slice(2, 10);
  const mandar = (peerId, data) => net.voz.send({ ...data, i: mid(), a: peerId }, peerId);

  function nueva(peerId, inicia) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const l = { pc, inicia, el: null, nodos: null, icono: null, hablaHasta: 0, iceRemoto: [], abierta: performance.now() };
    llamadas.set(peerId, l);
    pc.onicecandidate = (e) => { if (e.candidate) mandar(peerId, { t: 'ice', c: e.candidate.toJSON() }); };
    pc.ontrack = (e) => conectarAudio(l, e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { console.info('Voz: no se pudo conectar con', peerId); cerrar(peerId, false); espera.set(peerId, performance.now() + 20000); }
      if (pc.connectionState === 'connected') avisar();
    };
    return l;
  }
  function conectarAudio(l, stream) {
    const c = audio();
    if (!c || l.nodos) return;
    // Chrome no pasa el audio de una llamada a Web Audio si no está también en un <audio> (mudo)
    l.el = new Audio(); l.el.muted = true; l.el.srcObject = stream; l.el.play().catch(() => {});
    const src = c.createMediaStreamSource(stream);
    const panner = new PannerNode(c, { panningModel: 'HRTF', distanceModel: 'linear', refDistance: PLENO, maxDistance: ALCANCE, rolloffFactor: 1 });
    const analyser = c.createAnalyser(); analyser.fftSize = 512;
    src.connect(analyser);
    src.connect(panner).connect(salida);
    l.nodos = { src, panner, analyser };
  }
  async function llamar(peerId) {
    const l = nueva(peerId, true);
    const t = l.pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (micTrack) await t.sender.replaceTrack(micTrack);
    await l.pc.setLocalDescription(await l.pc.createOffer());
    mandar(peerId, { t: 'oferta', sdp: l.pc.localDescription.sdp });
  }
  function cerrar(peerId, avisarAlOtro = true) {
    const l = llamadas.get(peerId);
    if (!l) return;
    llamadas.delete(peerId);
    if (avisarAlOtro) mandar(peerId, { t: 'chau' });
    try { l.pc.close(); } catch { /* nada */ }
    try { l.nodos?.src.disconnect(); l.nodos?.panner.disconnect(); } catch { /* nada */ }
    if (l.el) l.el.srcObject = null;
    if (l.icono) { l.icono.parent?.remove(l.icono); l.icono.material.map.dispose(); l.icono.material.dispose(); }
    avisar();
  }
  async function iceGuardados(l) { for (const c of l.iceRemoto.splice(0)) await l.pc.addIceCandidate(c).catch(() => {}); }

  net.voz.onMessage = async (d, peerId) => {
    if (!d || typeof d !== 'object' || d.a !== net.selfId || !d.i || vistos.has(d.i)) return;
    vistos.add(d.i); if (vistos.size > 2000) vistos.clear();
    try {
      if (d.t === 'oferta' && typeof d.sdp === 'string') {
        if (!ajustes.escuchar || !estaCerca(peerId, CORTA)) { mandar(peerId, { t: 'chau' }); return; }
        if (llamadas.has(peerId)) cerrar(peerId, false); // el otro rearmó la llamada
        const l = nueva(peerId, false);
        await l.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        for (const t of l.pc.getTransceivers()) { t.direction = 'sendrecv'; if (micTrack) await t.sender.replaceTrack(micTrack); }
        await iceGuardados(l);
        await l.pc.setLocalDescription(await l.pc.createAnswer());
        mandar(peerId, { t: 'respuesta', sdp: l.pc.localDescription.sdp });
      } else if (d.t === 'respuesta' && typeof d.sdp === 'string') {
        const l = llamadas.get(peerId);
        if (!l?.inicia || l.pc.signalingState !== 'have-local-offer') return;
        await l.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        await iceGuardados(l);
      } else if (d.t === 'ice' && d.c) {
        const l = llamadas.get(peerId);
        if (!l) return;
        if (l.pc.remoteDescription) await l.pc.addIceCandidate(d.c).catch(() => {}); else l.iceRemoto.push(d.c);
      } else if (d.t === 'chau') {
        cerrar(peerId, false);
        espera.set(peerId, performance.now() + 5000);
      }
    } catch (err) { console.warn('Voz:', err); cerrar(peerId); }
  };
  // Lo que llegó antes de armar este sistema ya no sirve (eran llamadas viejas)
  net.voz.take();

  // ---------- Quién está cerca ----------
  const yo = () => net.roster().find((r) => r.me);
  function estaCerca(peerId, dist) {
    const m = yo(), o = net.roster().find((r) => r.peerId === peerId);
    if (!m?.p || !o?.p || m.s !== o.s) return false;
    return Math.hypot(o.p[0] - m.p[0], o.p[1] - m.p[1], o.p[2] - m.p[2]) <= dist;
  }
  function revisar() {
    const m = yo();
    const activo = ajustes.escuchar && !!m?.p;
    const otros = activo ? net.roster().filter((r) => !r.me && r.s === m.s && r.p)
      .map((r) => ({ id: r.peerId, d: Math.hypot(r.p[0] - m.p[0], r.p[1] - m.p[1], r.p[2] - m.p[2]) }))
      .sort((a, b) => a.d - b.d) : [];
    const quedan = new Set(otros.filter((o) => o.d <= CORTA).slice(0, MAX_LLAMADAS).map((o) => o.id));
    for (const id of [...llamadas.keys()]) if (!quedan.has(id)) cerrar(id);
    const ahora = performance.now();
    for (const o of otros.slice(0, MAX_LLAMADAS)) {
      if (o.d > CONECTA || llamadas.has(o.id) || (espera.get(o.id) ?? 0) > ahora) continue;
      if (net.selfId < o.id) llamar(o.id).catch((err) => { console.warn('Voz:', err); cerrar(o.id); }); // llama el de id menor; el otro espera la oferta
    }
    // Una llamada que nunca conectó en 25 s: se deja y se reintenta más tarde
    for (const [id, l] of llamadas) if (l.pc.connectionState !== 'connected' && ahora - l.abierta > 25000) { cerrar(id); espera.set(id, ahora + 20000); }
  }
  setInterval(revisar, 1000);

  // ---------- Sonido 3D y "hablando" (10 veces por segundo) ----------
  const _f = new THREE.Vector3(), _p = new THREE.Vector3();
  const buf = new Uint8Array(512);
  const nivelDe = (an) => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2; return Math.sqrt(s / buf.length); };
  setInterval(() => {
    if (!ctx || !llamadas.size) return;
    const t = ctx.currentTime;
    const m = yo();
    const L = ctx.listener;
    if (m?.p) {
      const [x, y, z] = m.p;
      if (L.positionX) { L.positionX.setTargetAtTime(x, t, 0.05); L.positionY.setTargetAtTime(y + ALTURA_BOCA, t, 0.05); L.positionZ.setTargetAtTime(z, t, 0.05); }
      else L.setPosition(x, y + ALTURA_BOCA, z);
      const cam = getCamera?.();
      if (cam) {
        cam.getWorldDirection(_f); _f.y = 0; if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1); _f.normalize();
        if (L.forwardX) { L.forwardX.setTargetAtTime(_f.x, t, 0.05); L.forwardY.setTargetAtTime(0, t, 0.05); L.forwardZ.setTargetAtTime(_f.z, t, 0.05); L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
        else L.setOrientation(_f.x, 0, _f.z, 0, 1, 0);
      }
    }
    const ahora = performance.now();
    for (const [id, l] of llamadas) {
      if (!l.nodos) continue;
      const root = net.avatarRoot(id);
      if (root) {
        root.getWorldPosition(_p);
        const pn = l.nodos.panner;
        pn.positionX.setTargetAtTime(_p.x, t, 0.05); pn.positionY.setTargetAtTime(_p.y + ALTURA_BOCA, t, 0.05); pn.positionZ.setTargetAtTime(_p.z, t, 0.05);
      }
      if (nivelDe(l.nodos.analyser) > 0.02) l.hablaHasta = ahora + 350;
      const habla = l.hablaHasta > ahora;
      if (root) {
        if (!l.icono) l.icono = iconoHablando();
        if (l.icono.parent !== root) root.add(l.icono);
        l.icono.visible = habla;
      }
    }
  }, 100);

  // ---------- Botón 🎙️ y tecla V ----------
  const boton = document.createElement('button');
  boton.type = 'button'; boton.className = 'voz-btn';
  (stage ?? document.body).append(boton);
  function dibujarBoton() {
    const modo = ajustes.mic;
    boton.classList.toggle('apagado', modo === 'apagado' || !micTrack || (modo === 'abierto' && silenciado));
    boton.classList.toggle('al-aire', transmitiendo());
    boton.textContent = '🎙️';
    boton.title = modo === 'apagado' ? 'Chat de voz: micrófono apagado (Esc para cambiarlo)'
      : modo === 'ptt' ? 'Mantené apretado (o la tecla V) para hablar' : silenciado ? 'Micrófono silenciado: tocá para activarlo' : 'Micrófono abierto: tocá para silenciarlo';
    boton.setAttribute('aria-label', boton.title);
  }
  const hablar = (on) => { if (hablando === on) return; hablando = on; aplicarMic(); };
  // Está dentro de #stage: sin esto la cámara se queda con el clic (setPointerCapture)
  boton.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (ajustes.mic === 'apagado') { onMenu(); return; }
    if (!micTrack) { prenderMic(); return; }
    if (ajustes.mic === 'ptt') { hablar(true); try { boton.setPointerCapture(e.pointerId); } catch { /* nada */ } }
    else { silenciado = !silenciado; aplicarMic(); }
  });
  const soltar = () => { if (ajustes.mic === 'ptt') hablar(false); };
  boton.addEventListener('pointerup', soltar);
  boton.addEventListener('pointercancel', soltar);
  boton.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyV' || e.repeat || ajustes.mic !== 'ptt' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable || blocked()) return;
    if (!micTrack) { prenderMic(); return; }
    hablar(true);
  });
  addEventListener('keyup', (e) => { if (e.code === 'KeyV') soltar(); });
  addEventListener('blur', soltar);

  // ---------- Ajustes ----------
  function set(cambios) {
    if ('volumen' in cambios) { ajustes.volumen = Math.max(0, Math.min(1.5, Number(cambios.volumen) || 0)); if (salida) salida.gain.value = ajustes.volumen; }
    if ('escuchar' in cambios) { ajustes.escuchar = !!cambios.escuchar; if (!ajustes.escuchar) for (const id of [...llamadas.keys()]) cerrar(id); }
    if ('mic' in cambios && ['apagado', 'ptt', 'abierto'].includes(cambios.mic)) {
      ajustes.mic = cambios.mic; silenciado = false; hablando = false;
      if (ajustes.mic === 'apagado') apagarMic(); else { destrabar(); prenderMic(); }
    }
    guardar(); dibujarBoton(); avisar();
    if ('escuchar' in cambios) revisar();
  }
  if (ajustes.mic !== 'apagado') prenderMic(); // lo elegiste la otra vez: el navegador recuerda el permiso
  dibujarBoton();

  const api = {
    get ajustes() { return { ...ajustes }; },
    set,
    alcance: ALCANCE,
    boton,
    cerca: () => [...llamadas].map(([id, l]) => ({ id, nombre: net.roster().find((r) => r.peerId === id)?.n ?? 'Jugador', conectado: l.pc.connectionState === 'connected', habla: l.hablaHasta > performance.now() })),
    nivel: () => (micNivel ? Math.min(1, nivelDe(micNivel) * 6) : 0),
    transmitiendo,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    debug: () => ({ yo: net.selfId, ajustes, mic: !!micTrack, audio: ctx?.state ?? null, llamadas: [...llamadas].map(([id, l]) => ({ id, inicia: l.inicia, estado: l.pc.connectionState, señal: l.pc.signalingState, audio: !!l.nodos })) }),
  };
  window.corondaVoz = api; // para revisar desde la consola (F12): corondaVoz.debug()
  return api;
}
