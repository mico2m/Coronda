// WebSocket mínimo (RFC 6455) sobre el servidor HTTP de Node, sin dependencias.
// Solo mensajes de texto (JSON), ping/pong y cierre. Mensajes de más de MAX_FRAME bytes cierran la conexión.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 256 * 1024; // 256 KB (la foto de perfil comprimida entra de sobra)

export function aceptarWebSocket(req, socket, onConexion) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const ws = crearConexion(socket);
  onConexion(ws, req);
}

function crearConexion(socket) {
  let buf = Buffer.alloc(0);
  let partes = [];       // fragmentos de un mensaje partido
  let abierto = true;
  const ws = {
    onmessage: null, onclose: null,
    get abierto() { return abierto; },
    send(texto) {
      if (!abierto) return;
      const data = Buffer.from(texto, 'utf8');
      let head;
      if (data.length < 126) head = Buffer.from([0x81, data.length]);
      else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
      socket.write(Buffer.concat([head, data]));
    },
    close(code = 1000) {
      if (!abierto) return;
      const b = Buffer.alloc(2); b.writeUInt16BE(code, 0);
      try { socket.write(Buffer.concat([Buffer.from([0x88, 2]), b])); } catch { /* nada */ }
      terminar();
      setTimeout(() => socket.destroy(), 200);
    },
    ping() { if (abierto) socket.write(Buffer.from([0x89, 0])); },
    ultimo: Date.now(),
  };
  function terminar() {
    if (!abierto) return;
    abierto = false;
    try { ws.onclose?.(); } catch (e) { console.error(e); }
  }
  socket.on('data', (chunk) => {
    ws.ultimo = Date.now();
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) { ws.close(1009); return; } len = Number(big); off = 10; }
      if (len > MAX_FRAME || !masked) { ws.close(len > MAX_FRAME ? 1009 : 1002); return; } // el cliente siempre enmascara
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) { ws.close(); return; }
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; } // ping -> pong
      if (op === 0xa) continue; // pong
      if (op === 0x1 || op === 0x0) {
        partes.push(data);
        if (partes.reduce((a, b) => a + b.length, 0) > MAX_FRAME) { ws.close(1009); return; }
        if (!fin) continue;
        const texto = Buffer.concat(partes).toString('utf8');
        partes = [];
        try { ws.onmessage?.(texto); } catch (e) { console.error('Mensaje:', e); }
      } else if (op === 0x2) { ws.close(1003); return; } // binario: no se usa
    }
  });
  socket.on('close', terminar);
  socket.on('error', terminar);
  return ws;
}
