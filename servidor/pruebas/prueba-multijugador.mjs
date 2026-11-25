// Pruebas del servidor con varios jugadores a la vez (clientes WebSocket de verdad contra un servidor de verdad).
//   node servidor/pruebas/prueba-multijugador.mjs
// Arma una copia temporal del proyecto (con tiempos cortos para no esperar minutos), levanta el servidor, conecta
// jugadores, prueba cada regla y al final reinicia el servidor para comprobar que todo quedó guardado.
// Necesita Node 22 o más nuevo (usa el WebSocket que trae Node).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'coronda-prueba-'));
const PORT = 8200 + Math.floor(Math.random() * 500);
let ok = 0, mal = 0;
const check = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { mal++; console.log(`  ✘ ${msg}`); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Copia del proyecto con tablas de prueba ----------
for (const d of ['data', 'src/shared', 'servidor']) fs.cpSync(path.join(ROOT, d), path.join(TMP, d), { recursive: true, filter: (s) => !s.includes(`${path.sep}datos`) && !s.endsWith('config.json') });
const json = (rel, fn) => { const f = path.join(TMP, rel); const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j)); };
json('data/muebles.json', (j) => { for (const m of j.muebles) m.tiempo_min = 0.005; }); // 0,3 s por mueble
json('data/tables/tiempo.json', (j) => { j.tienda = { abre: 0, cierra: 24 }; });         // siempre abierta
json('data/tables/tienda.json', (j) => { j.entrega_caduca_seg = 2; j.max_pedidos_por_jugador = 3; });
fs.writeFileSync(path.join(TMP, 'servidor/config.json'), JSON.stringify({ puerto: PORT, admins: ['Ana'], registro_abierto: true, max_jugadores: 10, escena_claude: 'coronda_plaza' }));

let proc = null;
async function arrancar() {
  proc = spawn(process.execPath, [path.join(TMP, 'servidor/coronda-server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (b) => { log += b; });
  proc.stderr.on('data', (b) => { process.stderr.write(b); });
  for (let i = 0; i < 50 && !log.includes('Servidor de Coronda'); i++) await espera(100);
}
async function parar() { proc.kill('SIGINT'); await new Promise((r) => proc.on('exit', r)); }

// ---------- Cliente de prueba ----------
function cliente(nombre) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const msgs = [];
  const esperando = new Map();
  let rid = 0;
  const c = {
    nombre, msgs, ws, u: null, yo: null, kv: new Map(), chat: [],
    abierto: new Promise((r) => ws.addEventListener('open', r)),
    send(m) { ws.send(JSON.stringify(m)); },
    rpc(op, a = {}) { const id = ++rid; c.send({ t: 'rpc', id, op, a }); return new Promise((r) => esperando.set(id, r)); },
    async espera(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { const m = msgs.find(fn); if (m) return m; await espera(20); } return null; },
    cerrar() { ws.close(); },
  };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    msgs.push(m);
    if (m.t === 'rpc') esperando.get(m.id)?.(m), esperando.delete(m.id);
    if (m.t === 'yo') c.yo = m;
    if (m.t === 'kv') { for (const x of m.lista ?? [{ k: m.k, d: m.d }]) c.kv.set(x.k, x.d); }
    if (m.t === 'chat') c.chat.push(m);
  });
  return c;
}
async function entrar(nombre, clave, modo = 'registro') {
  const c = cliente(nombre);
  await c.abierto;
  c.send({ t: modo, nombre, clave });
  const s = await c.espera((m) => m.t === 'sesion');
  c.sesion = s; c.u = s?.u; c.token = s?.token;
  return c;
}
const estado = (c, s, p = [0, 0, 0]) => c.send({ t: 'a', n: 'estado', d: { playing: true, s, p, f: 0, a: 'idle', m: 'assets/models/objects/personaje.glb', n: 'TRAMPA', u: 'otro' } });

try {
  await arrancar();
  console.log('\n1. Cuentas y nombres');
  const ana = await entrar('Ana', 'secreta1');
  check(ana.sesion?.ok && ana.u && ana.token, 'Ana se registra y recibe un id propio y un token');
  const dup = await entrar('ána', 'otra123');
  check(dup.sesion?.ok === false && /ocupado/.test(dup.sesion.error), 'No se puede registrar "ána" (mismo nombre con tilde/mayúscula)');
  dup.cerrar();
  const bad = await entrar('Ana', 'incorrecta', 'login');
  check(bad.sesion?.ok === false, 'Contraseña incorrecta: no entra');
  bad.cerrar();
  const corta = await entrar('Pepe', '123');
  check(corta.sesion?.ok === false, 'Contraseña de menos de 6 letras: rechazada');
  corta.cerrar();
  const beto = await entrar('Beto', 'clave123');
  check(beto.sesion?.ok && beto.u !== ana.u, 'Beto tiene otro id distinto del de Ana');

  console.log('\n2. Entrar al mundo, avisos y estado');
  ana.send({ t: 'entrar', personaje: 'Link' });
  await ana.espera((m) => m.t === 'kv' && m.lista);
  beto.send({ t: 'entrar', personaje: 'Zelda' });
  const unido = await ana.espera((m) => m.t === 'chat' && m.sys && /Beto se ha unido/.test(m.txt));
  check(!!unido, 'Ana ve en el chat "Beto se ha unido al mundo"');
  check(!!(await ana.espera((m) => m.t === 'join' && m.from === beto.u)), 'Ana recibe que Beto entró (para dibujarlo)');
  estado(beto, 'coronda_plaza', [1, 0, 1]);
  const est = await ana.espera((m) => m.t === 'a' && m.n === 'estado' && m.from === beto.u);
  check(est?.d.n === 'Beto' && est?.d.u === beto.u, 'El servidor pisa nombre e id del estado: Beto no puede hacerse pasar por otro');
  estado(ana, 'coronda_plaza', [0, 0, 0]);

  console.log('\n3. Misma hora para todos');
  const ha = ana.msgs.find((m) => m.t === 'hora'), hb = beto.msgs.find((m) => m.t === 'hora');
  check(ha && hb && JSON.stringify(ha.cfg) === JSON.stringify(hb.cfg), 'Los dos reciben la misma configuración de hora del servidor');
  ana.send({ t: 'sync', c: 123 });
  const sy = await ana.espera((m) => m.t === 'sync');
  check(sy && Math.abs(sy.s - Date.now()) < 2000, 'Sincronización del reloj con el servidor');
  const ht = await ana.rpc('admin', { cmd: '/time set 19:30' });
  const h2a = await ana.espera((m) => m.t === 'hora' && m !== ha), h2b = await beto.espera((m) => m.t === 'hora' && m !== hb);
  check(ht.ok && h2a && h2b && h2a.cfg.desfase_horas === h2b.cfg.desfase_horas, '/time set del admin llega igual a todos');
  const noAdmin = await beto.rpc('admin', { cmd: '/madera Beto 999' });
  check(!noAdmin.ok, 'Beto no es admin: no puede darse madera');

  console.log('\n4. Bosque (madera validada por el servidor)');
  const lejos = await beto.rpc('bosque.hachazo', { k: 'bosque_coronda.arbol_001' });
  check(!lejos.ok, 'No se puede talar un árbol de otra escena');
  estado(beto, 'bosque_coronda', [0, 0, 0]);
  await espera(100);
  let madera = 0;
  for (let i = 0; i < 3; i++) { const r = await beto.rpc('bosque.hachazo', { k: 'bosque_coronda.arbol_001' }); madera += r.r?.madera ?? 0; await espera(470); }
  check(madera === 2, '3 hachazos = 2 de madera');
  const rap = await beto.rpc('bosque.hachazo', { k: 'bosque_coronda.arbol_001' });
  const rap2 = await beto.rpc('bosque.hachazo', { k: 'bosque_coronda.arbol_001' });
  check(rap.ok && !rap2.ok, 'Hachazos demasiado seguidos: rechazados');
  for (let i = 0; i < 5; i++) { await espera(470); await beto.rpc('bosque.hachazo', { k: 'bosque_coronda.arbol_001' }); }
  const cayo = await ana.espera((m) => m.t === 'kv' && m.k === 'bosque~bosque_coronda.arbol_001' && m.d?.hasta);
  check(!!cayo, 'El árbol cae y Ana (en otra escena) se entera');
  await espera(470);
  const caido = await beto.rpc('bosque.hachazo', { k: 'bosque_coronda.arbol_001' });
  check(!caido.ok, 'Un árbol caído no se puede talar');
  check(beto.yo.inv.recursos.madera === 6, `Mochila de Beto en el servidor: ${beto.yo.inv.recursos.madera} de madera`);

  console.log('\n5. Carpintería: pedidos, cantidades y mismo progreso para todos');
  const sinMadera = await beto.rpc('tienda.encargar', { items: [{ m: 'mesa', q: 1 }] });
  check(!sinMadera.ok && /Te faltan/.test(sinMadera.error), 'Sin madera suficiente: el pedido se rechaza');
  await ana.rpc('admin', { cmd: '/madera Beto 100' });
  await espera(100);
  const ped = await beto.rpc('tienda.encargar', { items: [{ m: 'silla', q: 5 }] });
  check(ped.ok && beto.yo.inv.recursos.madera === 106 - 20, `Encargo de 5 sillas de una vez: pagó ${ped.r?.pago?.madera} de madera`);
  const id = ped.r.ids[0];
  await espera(150);
  const pa = ana.kv.get(`tienda~${id}`), pb = beto.kv.get(`tienda~${id}`);
  check(pa && pb && pa.start === pb.start && pa.end === pb.end && pa.q === 5, 'Ana y Beto reciben el mismo inicio y fin del pedido (calculado por el servidor)');
  const muchos = await beto.rpc('tienda.encargar', { items: [{ m: 'silla', q: 1 }, { m: 'silla', q: 1 }, { m: 'silla', q: 1 }] });
  check(!muchos.ok, 'Más pedidos que el máximo: rechazado');
  const falso = await beto.rpc('tienda.encargar', { items: [{ m: 'silla', q: -50 }] });
  check(!falso.ok || falso.r.pago.madera > 0, 'Cantidades negativas no regalan madera');

  console.log('\n6. Entregas de Claude: caducidad y recoger');
  await espera(2000); // el pedido (5 × 0,3 s) ya está listo
  const ret = await beto.rpc('tienda.retirar', { ids: [id] });
  check(ret.ok, `Beto pide retirar su pedido listo ${ret.error ?? ""}`);
  const ret2 = await beto.rpc('tienda.retirar', { ids: [id] });
  check(!ret2.ok, 'No se puede pedir dos veces el mismo retiro');
  const noCond = await beto.rpc('tienda.enMostrador', { id });
  check(!noCond.ok, 'Beto (en el bosque) no maneja a Claude: no puede marcar la entrega');
  const mos = await ana.rpc('tienda.enMostrador', { id });
  check(mos.ok, 'Ana (en la plaza, id más chico o única ahí) maneja a Claude y lo deja en el mostrador');
  const roba = await ana.rpc('tienda.recoger', { id });
  check(!roba.ok, 'Ana no puede recoger el pedido de Beto');
  await espera(3200); // caduca a los 2 s
  const vencio = await beto.espera((m) => m.t === 'aviso' && /a tiempo/.test(m.txt));
  check(!!vencio, 'Si nadie lo recoge, la entrega caduca y se avisa al dueño');
  check(!ana.kv.get('claude~trabajo')?.length, 'Claude queda libre (no hay trabajos pendientes)');
  check(ana.kv.get(`tienda~${id}`)?.est === null, 'El pedido vuelve al taller (no se pierde)');
  await beto.rpc('tienda.retirar', { ids: [id] });
  await ana.rpc('tienda.enMostrador', { id });
  const rec = await beto.rpc('tienda.recoger', { id });
  check(rec.ok && beto.yo.inv.muebles.silla === 5, 'Beto recoge: 5 sillas a su mochila');
  const dosVeces = await beto.rpc('tienda.recoger', { id });
  check(!dosVeces.ok && beto.yo.inv.muebles.silla === 5, 'Recoger dos veces no duplica');

  console.log('\n7. Intercambio seguro');
  await ana.rpc('admin', { cmd: '/madera Ana 10' });
  const t1 = await ana.rpc('trato.pedir', { u: beto.u });
  const inv = await beto.espera((m) => m.t === 'trato' && m.invitacion);
  check(t1.ok && !!inv, 'Beto recibe la invitación de Ana');
  const otro = await entrar('Caro', 'clave123'); otro.send({ t: 'entrar' }); await otro.espera((m) => m.t === 'kv' && m.lista);
  const ocupado = await otro.rpc('trato.pedir', { u: beto.u });
  check(!ocupado.ok, 'No se puede abrir un segundo intercambio con alguien ocupado');
  await beto.rpc('trato.responder', { id: inv.invitacion.id, si: true });
  const mal1 = await ana.rpc('trato.ofrecer', { oferta: { 'recursos:madera': 500 } });
  check(!mal1.ok, 'No se puede ofrecer más de lo que se tiene');
  await ana.rpc('trato.ofrecer', { oferta: { 'recursos:madera': 10 } });
  await beto.rpc('trato.ofrecer', { oferta: { 'muebles:silla': 2 } });
  await ana.rpc('trato.listo', {});
  await beto.rpc('trato.ofrecer', { oferta: { 'muebles:silla': 1 } }); // cambia la oferta después de que Ana confirmó
  const r1 = await beto.rpc('trato.listo', {});
  check(r1.ok && r1.r.hecho === false, 'Si alguien cambia su oferta, el otro tiene que volver a confirmar');
  const r2 = await ana.rpc('trato.listo', {});
  await espera(100);
  check(r2.r?.hecho && ana.yo.inv.muebles.silla === 1 && (ana.yo.inv.recursos.madera ?? 0) === 0 && beto.yo.inv.muebles.silla === 4, 'Intercambio hecho: Ana 1 silla, Beto 4 sillas, la madera pasó');
  // Duplicar: ofrecer y gastar antes de confirmar
  await ana.rpc('admin', { cmd: '/madera Ana 8' });
  const t2 = await ana.rpc('trato.pedir', { u: beto.u });
  const inv2 = await beto.espera((m) => m.t === 'trato' && m.invitacion && m.invitacion.id === t2.r.id);
  await beto.rpc('trato.responder', { id: inv2.invitacion.id, si: true });
  await ana.rpc('trato.ofrecer', { oferta: { 'recursos:madera': 8 } });
  const maderaBeto = beto.yo.inv.recursos.madera ?? 0;
  const gasto = await ana.rpc('tienda.encargar', { items: [{ m: 'mesa', q: 1 }] }); // gasta los 8 antes de confirmar
  await ana.rpc('trato.listo', {}); const r3 = await beto.rpc('trato.listo', {});
  await espera(100);
  check(gasto.ok && r3.r?.hecho === false && (beto.yo.inv.recursos.madera ?? 0) === maderaBeto, `Ofrecer madera y gastarla antes de confirmar: el intercambio se cancela (no se duplica) ${gasto.error ?? ''}`);

  console.log('\n8. Casa, muebles y cofre');
  const lote = await beto.rpc('lote.adquirir', { k: 'coronda_plaza.lote_01', m: 'casa_model01' });
  check(lote.ok, 'Beto adquiere un lote');
  const robaLote = await ana.rpc('lote.adquirir', { k: 'coronda_plaza.lote_01', m: 'casa_model01' });
  check(!robaLote.ok, 'Ana no puede quedarse con el lote de Beto');
  const sinMueble = await beto.rpc('casa.guardar', { k: 'coronda_plaza.lote_01', items: [{ i: 'a', m: 'cama', p: [0, 0], y: 0 }] });
  check(!sinMueble.ok, 'No se puede poner un mueble que no está en la mochila');
  const pone = await beto.rpc('casa.guardar', { k: 'coronda_plaza.lote_01', items: [{ i: 'a', m: 'silla', p: [0, 0], y: 0 }, { i: 'b', m: 'silla', p: [1, 0], y: 0 }] });
  check(pone.ok && beto.yo.inv.muebles.silla === 2, 'Poner 2 sillas las saca de la mochila');
  const ajena = await ana.rpc('casa.guardar', { k: 'coronda_plaza.lote_01', items: [] });
  check(!ajena.ok, 'Ana no puede diseñar la casa de Beto');
  await beto.rpc('casa.guardar', { k: 'coronda_plaza.lote_01', items: [{ i: 'a', m: 'silla', p: [0, 0], y: 0 }] });
  check(beto.yo.inv.muebles.silla === 3, 'Quitar una silla la devuelve a la mochila');
  await ana.rpc('admin', { cmd: '/madera Beto 30' });
  const pc = await beto.rpc('tienda.encargar', { items: [{ m: 'cofre', q: 1 }] });
  check(pc.ok, 'El carpintero fabrica cofres');
  await espera(800);
  await beto.rpc('tienda.retirar', { ids: pc.r.ids }); await ana.rpc('tienda.enMostrador', { id: pc.r.ids[0] }); await beto.rpc('tienda.recoger', { id: pc.r.ids[0] });
  check(beto.yo.inv.muebles.cofre === 1, 'Beto retira su cofre');
  await beto.rpc('casa.guardar', { k: 'coronda_plaza.lote_01', items: [{ i: 'a', m: 'silla', p: [0, 0], y: 0 }, { i: 'c', m: 'cofre', p: [2, 0], y: 0 }] });
  const mad0 = beto.yo.inv.recursos.madera;
  const g = await beto.rpc('cofre.mover', { k: 'coronda_plaza.lote_01', i: 'c', dir: 'guardar', kind: 'recursos', id: 'madera', n: 10 });
  check(g.ok && g.r.items['recursos:madera'] === 10 && beto.yo.inv.recursos.madera === mad0 - 10, 'Guardar 10 de madera en el cofre');
  const gm = await beto.rpc('cofre.mover', { k: 'coronda_plaza.lote_01', i: 'c', dir: 'retirar', kind: 'recursos', id: 'madera', n: 11 });
  check(!gm.ok, 'No se puede sacar más de lo que hay en el cofre');
  const cajena = await ana.rpc('cofre.ver', { k: 'coronda_plaza.lote_01', i: 'c' });
  check(!cajena.ok, 'Ana no puede abrir el cofre de Beto');
  const quitar = await beto.rpc('casa.guardar', { k: 'coronda_plaza.lote_01', items: [{ i: 'a', m: 'silla', p: [0, 0], y: 0 }] });
  check(!quitar.ok, 'Un cofre con cosas no se puede sacar');

  console.log('\n9. Perfil y firmas');
  const f = await ana.rpc('perfil.firmar', { u: beto.u, txt: '¡Linda casa!' });
  const vacia = await ana.rpc('perfil.firmar', { u: beto.u, txt: '   ' });
  const pv = await ana.rpc('perfil.ver', { u: beto.u });
  check(f.ok && !vacia.ok && pv.r.firmas[0]?.txt === '¡Linda casa!' && pv.r.nombre === 'Beto', 'Firmar el perfil (vacío no se permite) y verlo');
  check(!!(await beto.espera((m) => m.t === 'aviso' && /firmó tu perfil/.test(m.txt))), 'Beto recibe el aviso de la firma');

  console.log('\n10. Sesiones, reconexión y doble ingreso');
  const ana2 = await entrar('Ana', 'secreta1', 'login');
  check(!!(await ana.espera((m) => m.t === 'expulsado')), 'Si Ana entra desde otro lado, la sesión vieja se cierra (nunca dos a la vez)');
  check(!beto.chat.some((m) => /Ana ha abandonado/.test(m.txt)), 'Eso cuenta como reconexión: nadie ve "Ana ha abandonado"');
  ana2.cerrar();
  await espera(300);
  const tok = await entrar('', '', 'token'); // sin token: falla
  tok.cerrar();
  const ana3 = cliente('Ana'); await ana3.abierto; ana3.send({ t: 'token', token: ana2.token });
  const s3 = await ana3.espera((m) => m.t === 'sesion');
  check(s3?.ok && s3.reconexion, 'Volver con el token dentro de los 20 s: reconexión sin avisos');
  check(!beto.chat.some((m) => /Ana ha abandonado/.test(m.txt)), 'Beto no vio salir a Ana');
  otro.cerrar();
  await espera(21500);
  check(beto.chat.filter((m) => /Caro ha abandonado el mundo/.test(m.txt)).length === 1, 'Caro se fue de verdad: "Caro ha abandonado el mundo", una sola vez');

  console.log('\n11. Todo queda guardado al reiniciar el servidor');
  const maderaAntes = beto.yo.inv.recursos.madera;
  beto.cerrar(); ana3.cerrar();
  await parar(); await arrancar();
  const b2 = await entrar('Beto', 'clave123', 'login');
  await b2.espera((m) => m.t === 'yo');
  check(b2.yo.inv.recursos.madera === maderaAntes && b2.yo.inv.muebles.silla === 3, 'Mochila de Beto igual después de reiniciar');
  b2.send({ t: 'entrar' });
  await b2.espera((m) => m.t === 'kv' && m.lista);
  check(b2.kv.get('coronda_plaza.lote_01')?.o === b2.u && b2.kv.get('casa~coronda_plaza.lote_01')?.items.length === 2, 'Su lote y los muebles de su casa siguen ahí');
  const pv2 = await b2.rpc('cofre.ver', { k: 'coronda_plaza.lote_01', i: 'c' });
  check(pv2.r?.items['recursos:madera'] === 10, 'El cofre conserva su contenido');
  b2.cerrar();
} catch (e) {
  mal++; console.error(e);
} finally {
  if (proc) await parar().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${ok} bien · ${mal} mal`);
  process.exit(mal ? 1 : 0);
}
