// Sala por MQTT (brokers públicos por WebSocket): un camino que NO usa conexión directa entre navegadores.
// Sirve cuando WebRTC no puede conectar (Brave con su protección de IP, redes con NAT estricto, dos navegadores
// en la misma PC, etc.): los mensajes pasan por el broker. Imita la parte de la API de Trystero que usa multiplayer.js.
// Cliente MQTT 3.1.1 mínimo (CONNECT, SUBSCRIBE, PUBLISH QoS 0, PINGREQ), sin librerías.

const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];
const KEEPALIVE = 30;       // s (el broker te da por caído si no hay nada en 1,5 veces esto)
const SILENCE = 75;         // s sin mensajes de alguien -> se fue (una pestaña en segundo plano avisa poco)

const enc = new TextEncoder();
const dec = new TextDecoder();

function varLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return out;
}
const str = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
const packet = (type, body) => new Uint8Array([type, ...varLen(body.length), ...body]);

function connectPacket(clientId, willTopic, willMsg) {
  const flags = 0x02 | 0x04; // sesión limpia + testamento (lo publica el broker si te desconectás de golpe)
  const body = [...str('MQTT'), 4, flags, KEEPALIVE >> 8, KEEPALIVE & 255, ...str(clientId), ...str(willTopic), ...str(willMsg)];
  return packet(0x10, body);
}
const subscribePacket = (topic, id = 1) => packet(0x82, [0, id, ...str(topic), 0]);
// retain = true: el broker guarda el mensaje y se lo entrega a todo el que se suscriba después (así persiste el estado
// de los lotes aunque no haya nadie conectado)
function publishPacket(topic, text, retain = false) {
  const payload = enc.encode(text);
  const body = new Uint8Array(2 + enc.encode(topic).length + payload.length);
  const t = str(topic);
  body.set(t, 0);
  body.set(payload, t.length);
  return packet(retain ? 0x31 : 0x30, [...body]);
}

// Una conexión a un broker. onPublish(topic, text)
function brokerSocket(url, clientId, willTopic, willMsg, subTopic, onPublish) {
  let ws = null, ping = 0, retry = 0, closed = false, buf = new Uint8Array(0);
  const api = { get open() { return ws?.readyState === 1 && api.ready; }, ready: false, send: null, close: null };

  function parse() {
    while (buf.length >= 2) {
      let mult = 1, len = 0, i = 1, b;
      do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mult; mult *= 128; } while (b & 128);
      if (buf.length < i + len) return;
      const hdr = buf[0], type = hdr >> 4, body = buf.subarray(i, i + len);
      buf = buf.slice(i + len);
      if (type === 2) { // CONNACK
        if (body[1] === 0) { api.ready = true; [].concat(subTopic).forEach((t, i) => ws.send(subscribePacket(t, i + 1))); retry = 0; }
      } else if (type === 3) { // PUBLISH
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tl));
        const qos = (hdr >> 1) & 3; // (QoS 0 siempre en esta sala)
        const start = 2 + tl + (qos ? 2 : 0);
        try { onPublish(topic, dec.decode(body.subarray(start))); } catch (err) { console.warn('MQTT:', err); }
      }
    }
  }
  function open() {
    if (closed) return;
    try { ws = new WebSocket(url, ['mqtt']); } catch { schedule(); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(connectPacket(clientId, willTopic, willMsg));
      ping = setInterval(() => { if (ws.readyState === 1) ws.send(new Uint8Array([0xc0, 0])); }, (KEEPALIVE - 5) * 1000);
    };
    ws.onmessage = (e) => {
      const chunk = new Uint8Array(e.data);
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf); next.set(chunk, buf.length);
      buf = next;
      parse();
    };
    ws.onclose = () => { api.ready = false; clearInterval(ping); buf = new Uint8Array(0); schedule(); };
    ws.onerror = () => { /* onclose reintenta */ };
  }
  function schedule() {
    if (closed) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(open, 1000 * 2 ** retry);
  }
  api.send = (topic, text, retain = false) => { if (api.open) ws.send(publishPacket(topic, text, retain)); };
  api.close = () => { closed = true; clearInterval(ping); try { if (ws?.readyState === 1) ws.send(new Uint8Array([0xe0, 0])); ws?.close(); } catch { /* nada */ } };
  open();
  return api;
}

export function joinMqtt(appId, roomId, selfId, brokers = BROKERS) {
  const base = `${appId}/${roomId}`;
  const bye = JSON.stringify({ id: selfId, t: 'bye' });
  const seen = new Map(); // peerId -> último mensaje (ms)
  const actions = new Map();
  const room = {
    selfId,
    onPeerJoin: null,
    onPeerLeave: null,
    onPersisted: null,   // (clave, dato) para cada mensaje guardado en el broker (llegan al suscribirse y cuando cambian)
    // Guarda un dato en el broker (retained) bajo `<sala>/guardado/<clave>`; lo recibe todo el que entre después
    // data = null lo borra del broker (mensaje retenido vacío)
    persist(key, data) { const text = data === null ? '' : JSON.stringify(data); sockets.forEach((s) => s.send(`${base}/guardado/${key}`, text, true)); },
    makeAction(name) {
      const a = { onMessage: null, send(data) { const text = JSON.stringify({ id: selfId, t: name, d: data }); sockets.forEach((s) => s.send(`${base}/${selfId}`, text)); } };
      actions.set(name, a);
      return a;
    },
    leave() {
      sockets.forEach((s) => { s.send(`${base}/${selfId}`, bye); s.close(); });
      clearInterval(sweep);
    },
    sockets: () => Object.fromEntries(brokers.map((u, i) => [u, { readyState: sockets[i].open ? 1 : 0 }])),
  };
  const keep = `${base}/guardado/`;
  const onPublish = (topic, text) => {
    if (topic.startsWith(keep)) { // un dato guardado (no es un mensaje de un jugador)
      let d = null; if (text !== '') { try { d = JSON.parse(text); } catch { return; } }
      room.onPersisted?.(topic.slice(keep.length), d);
      return;
    }
    const m = JSON.parse(text);
    if (!m?.id || m.id === selfId) return;
    if (m.t === 'bye') { if (seen.delete(m.id)) room.onPeerLeave?.(m.id); return; }
    if (!seen.has(m.id)) { seen.set(m.id, performance.now()); room.onPeerJoin?.(m.id); }
    seen.set(m.id, performance.now());
    actions.get(m.t)?.onMessage?.(m.d, { peerId: m.id });
  };
  const clientId = `coronda-${selfId}`.slice(0, 23);
  const sockets = brokers.map((url) => brokerSocket(url, clientId, `${base}/${selfId}`, bye, [`${base}/+`, `${keep}+`], onPublish));
  const sweep = setInterval(() => {
    const now = performance.now();
    for (const [id, t] of seen) if (now - t > SILENCE * 1000) { seen.delete(id); room.onPeerLeave?.(id); }
  }, 5000);
  return room;
}
