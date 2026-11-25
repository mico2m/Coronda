// Claude, el NPC de la plaza: UNO SOLO para todo el servidor.
//
// - Lo "maneja" un solo jugador a la vez (el de id más chico entre los que están en la plaza): ese juego mueve a
//   Claude (su ruta, seguir a alguien, ir a una casa…) y les manda a los demás dónde está y qué animación hace.
//   Los demás solo lo dibujan. Si ese jugador se va, lo toma el siguiente. Jugando solo, lo manejás vos.
// - Charla de a uno: si alguien le está hablando, a los demás les dice "Claude está charlando con …".
// - IA (opcional): en su menú, "Decile algo" deja escribirle lo que quieras. La respuesta la da una IA a través de un
//   intermediario (ver servidor-ia/README.md y data/tables/ia.json). La IA puede pedirle cosas al NPC: seguir a alguien,
//   ir a la casa de alguien, ir a un lugar de la plaza, quedarse quieto o volver a su ruta.
//   Si la IA no está configurada o se le acabó el cupo gratis: "¡Me abrumaste jajaja! ¿En un rato seguimos, querés?"
//   y por un rato solo usa sus frases de siempre (data/dialogues/claude.json).
import * as THREE from 'three';
import { loadJSON } from '../core/assets.js';

const ID = 'claude';
const SEND_EVERY = 0.15;     // s entre envíos del estado de Claude
const INTERP = 0.25;         // s de suavizado al dibujarlo en los otros juegos
const TALK_KEEP = 8;         // s: el que charla avisa que sigue charlando
const TALK_LOST = 25;        // s sin aviso: se libera
const FOLLOW_NEAR = 1.8;     // m: distancia a la que se queda cuando te sigue
const STAY_SECS = 90;        // s que se queda en un lugar antes de volver a su ruta (si nadie le dice otra cosa)
const FOLLOW_SECS = 240;     // s máximos siguiendo a alguien
const REST_SECS = 10 * 60;   // s que la IA "descansa" después de agotarse
const REST_KEY = 'coronda.claude.ia.descanso';
const OVERLOAD = '¡Me abrumaste jajaja! ¿En un rato seguimos, querés?';
const norm = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const PLACE_NAMES = { casa: 'mi lugar de siempre', centro: 'el centro de la plaza', este: 'el lado este', norte: 'el lado norte', oeste: 'el lado oeste', cartel: 'el cartel de bienvenida', borde: 'el borde oeste' };

// opts: net (o null), npcs, lotes, getPlayer(), getSceneId(), myName, notify(msg)
export function createClaudeNpc({ net = null, npcs, lotes, getPlayer, getSceneId, myName = 'Viajero', notify = () => {} }) {
  const solo = !net;
  const myUid = net?.uid ?? 'yo';
  let cfg = { endpoint: '', activa: true };
  loadJSON('data/tables/ia.json').then((c) => { cfg = { ...cfg, ...c }; }).catch(() => {});

  // Estado compartido (lo decide el que maneja)
  const st = { x: 0, y: 0, z: 0, f: 0, a: '', m: 'route', w: null, wn: '', scene: null };
  let driving = false, entry = null, sendT = 0, lastHeard = 0;
  let mode = { type: 'route' };            // route | go { to, then } | follow { u, until } | stay { until }
  let talk = { u: null, n: '', keep: 0 };  // con quién charla (solo lo usa el que maneja)
  let remote = null;                        // último estado recibido { x, y, z, f, a, w, wn, t }
  const target = new THREE.Vector3();
  let myTalking = false, keepT = 0, waiters = [];

  // ---------- Quién lo maneja ----------
  function plazaScene() { return entry ? getSceneId() : null; }
  function roster() { return net ? net.roster() : [{ me: true, u: myUid, n: myName, s: getSceneId(), p: null }]; }
  function electDriver() {
    if (solo) return true;
    const here = getSceneId();
    const inPlaza = roster().filter((r) => r.s === here && r.u);
    if (!inPlaza.some((r) => r.me)) return false;
    return inPlaza.map((r) => r.u).sort()[0] === myUid;
  }
  function find(entryList) { return entryList.find((n) => n.id === ID) ?? null; }

  // ---------- Red ----------
  if (net) {
    const C = net.claude;
    const { messages } = C.take();
    C.onMessage = (d, peerId) => onMsg(d, peerId);
    messages.forEach(({ data, peerId }) => onMsg(data, peerId));
  }
  function send(d) { if (net) net.claude.send(d); }
  function onMsg(d) {
    if (!d || typeof d !== 'object') return;
    if (d.st && typeof d.st === 'object') { // estado de Claude (del que lo maneja)
      if (driving && d.from !== myUid && String(d.from) < myUid) driving = false; // otro con id menor ya lo maneja
      const s2 = d.st;
      if (!Number.isFinite(s2.x) || !Number.isFinite(s2.z)) return;
      remote = { x: s2.x, y: s2.y ?? 0, z: s2.z, f: s2.f ?? 0, a: String(s2.a ?? ''), w: s2.w ? String(s2.w) : null, wn: String(s2.wn ?? ''), m: s2.m };
      lastHeard = performance.now();
      if (!driving) { st.w = remote.w; st.wn = remote.wn; }
      flushWaiters();
      return;
    }
    if (!driving || !d.req) return;
    const u = String(d.u ?? '');
    if (d.req === 'talk') { if (!talk.u || talk.u === u || !alive(talk.u)) { talk = { u, n: String(d.n ?? 'alguien').slice(0, 20), keep: performance.now() }; } broadcast(); }
    else if (d.req === 'keep' && talk.u === u) talk.keep = performance.now();
    else if (d.req === 'end' && talk.u === u) { talk = { u: null, n: '', keep: 0 }; resumeAfterTalk(); broadcast(); }
    else if (d.req === 'act' && Array.isArray(d.actions)) run(d.actions.slice(0, 4), u, String(d.n ?? ''));
  }
  const alive = (u) => roster().some((r) => r.u === u);
  function broadcast() {
    if (!driving || !entry) return;
    const h = entry.holder;
    st.x = +h.position.x.toFixed(2); st.y = +h.position.y.toFixed(2); st.z = +h.position.z.toFixed(2);
    st.f = +entry.targetYaw.toFixed(3);
    st.a = entry.current?.getClip?.().name ?? '';
    st.w = talk.u; st.wn = talk.n; st.m = mode.type;
    send({ from: myUid, st: { x: st.x, y: st.y, z: st.z, f: st.f, a: st.a, w: st.w, wn: st.wn, m: st.m } });
    flushWaiters();
  }
  function flushWaiters() {
    const w = driving ? talk.u : st.w;
    waiters = waiters.filter((fn) => !fn(w));
  }

  // ---------- Charla de a uno ----------
  // Antes de abrir el diálogo: ¿está libre?
  async function gate(e) {
    if (e.id !== ID) return true;
    if (solo) return true;
    if (driving) {
      if (talk.u && talk.u !== myUid && alive(talk.u)) return `Claude está charlando con ${talk.n || 'alguien'}. Esperá un ratito.`;
      talk = { u: myUid, n: myName, keep: performance.now() };
      myTalking = true; broadcast();
      return true;
    }
    const busyWith = remote && performance.now() - lastHeard < 5000 ? remote.w : null;
    if (busyWith && busyWith !== myUid) return `Claude está charlando con ${remote.wn || 'alguien'}. Esperá un ratito.`;
    if (!remote || performance.now() - lastHeard > 5000) { myTalking = true; return true; } // nadie lo maneja: charla libre
    send({ req: 'talk', u: myUid, n: myName });
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 2500);
      waiters.push((w) => { if (!w) return false; clearTimeout(t); resolve(w === myUid ? true : 'otro'); return true; });
    });
    if (ok === true || ok === 'timeout') { myTalking = true; return true; }
    return `Claude está charlando con ${remote?.wn || 'alguien'}. Esperá un ratito.`;
  }
  function ended(e) {
    if (e.id !== ID || !myTalking) return;
    myTalking = false;
    if (driving) { talk = { u: null, n: '', keep: 0 }; resumeAfterTalk(); broadcast(); }
    else send({ req: 'end', u: myUid });
  }
  function holdRoute() { if (entry && !entry._held) { entry.route?.hold?.(true); entry._held = true; } }
  function resumeRoute() { if (entry) { entry._held = false; entry.route?.resume?.(); } }
  function resumeAfterTalk() {
    if (!entry) return;
    if (mode.type === 'route') resumeRoute();
  }

  // ---------- Acciones (las pide la IA) ----------
  function playerPos(u) {
    if (u === myUid) { const p = getPlayer(); return p ? { x: p.position.x, z: p.position.z, s: getSceneId() } : null; }
    const r = roster().find((x) => x.u === u);
    return r?.p ? { x: r.p[0], z: r.p[2], s: r.s } : null;
  }
  function uidByName(name, fallbackU) {
    const k = norm(name);
    if (!k || /^(yo|vos|mi|me|conmigo)$/.test(k)) return fallbackU;
    const r = roster().find((x) => norm(x.n) === k) ?? roster().find((x) => norm(x.n).startsWith(k));
    return r?.u ?? null;
  }
  function lotFront(ownerName, ownerUid) {
    const k = norm(ownerName);
    for (const sp of lotes.list ?? []) {
      const r = lotes.record(sp.key);
      if (!r?.o) continue;
      if ((ownerUid && r.o === ownerUid) || (k && norm(r.n) === k)) {
        const info = lotes.spotInfo(sp.key);
        const q = new THREE.Quaternion().fromArray(info.quat);
        const out = new THREE.Vector3(0, 0, 1).applyQuaternion(q).setY(0).normalize();
        const dist = Math.abs(info.size[2] || 6) / 2 + 2.2;
        return { x: info.pos[0] + out.x * dist, z: info.pos[2] + out.z * dist };
      }
    }
    return null;
  }
  function placePos(name) {
    const k = norm(name);
    const nodes = entry?.route?.data?.nodes ?? routeData?.nodes ?? {};
    for (const [id, n] of Object.entries(nodes)) {
      if (k && (norm(id) === k || norm(PLACE_NAMES[id]).includes(k))) if (Array.isArray(n.position)) return { x: n.position[0], z: n.position[2] };
    }
    const lot = /lote(\d+)/.exec(k);
    if (lot) {
      const sp = (lotes.list ?? []).find((x) => norm(x.label) === `lote${lot[1].padStart(2, '0')}` || norm(x.label) === `lote${lot[1]}`);
      if (sp) return { x: sp.pos.x, z: sp.pos.z + 6 };
    }
    return null;
  }
  // Ejecuta las acciones (solo el que maneja). Devuelve textos de error para el que habló.
  function run(actions, fromU, fromN) {
    const errs = [];
    for (const a of actions) {
      const t = String(a?.tipo ?? a?.type ?? '');
      if (t === 'seguir') {
        const u = uidByName(a.jugador, fromU);
        if (!u) { errs.push(`no encontré a ${a.jugador}`); continue; }
        mode = { type: 'follow', u, until: performance.now() + FOLLOW_SECS * 1000 };
      } else if (t === 'ir_a_casa') {
        const u = uidByName(a.jugador, fromU);
        const who = a.jugador && !/^(yo|vos|mi)$/i.test(a.jugador) ? a.jugador : fromN;
        const p = lotFront(who, u);
        if (!p) { errs.push(`no encontré la casa de ${who}`); continue; }
        mode = { type: 'go', to: p, then: 'stay' };
      } else if (t === 'ir_a') {
        const p = placePos(a.lugar);
        if (!p) { errs.push(`no sé dónde queda ${a.lugar}`); continue; }
        mode = { type: 'go', to: p, then: 'stay' };
      } else if (t === 'quedarse') {
        mode = { type: 'stay', until: performance.now() + STAY_SECS * 1000 };
      } else if (t === 'volver') {
        mode = { type: 'route' };
        if (!talk.u) resumeRoute();
      } else if (t === 'animar') {
        if (entry) npcs.play(entry, String(a.clip ?? 'talk'));
      }
    }
    if (mode.type !== 'route') holdRoute();
    broadcast();
    return errs;
  }
  // Pedido de acciones desde este juego (lo hace el que maneja, sea yo u otro)
  function act(actions) {
    if (!actions?.length) return [];
    if (driving || solo) return run(actions, myUid, myName);
    send({ req: 'act', u: myUid, n: myName, actions });
    return [];
  }

  // ---------- Lo que ve Claude (se lo cuenta a la IA para que sepa dónde está y qué tiene alrededor) ----------
  // Devuelve textos cortos: "Ana (4 m, enfrente)". Dirección desde donde mira Claude: enfrente / a mi derecha / a mi izquierda / a mi espalda.
  function vista() {
    if (!entry) return null;
    const me = entry.holder.position;
    const yaw = (driving ? entry.targetYaw : (remote?.f ?? entry.targetYaw)) - (entry.yawOffset || 0);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const dirTo = (x, z) => {
      const dx = x - me.x, dz = z - me.z;
      const deg = (Math.atan2(-dx * fz + dz * fx, dx * fx + dz * fz) * 180) / Math.PI; // + = a su derecha
      const ad = Math.abs(deg);
      return ad < 50 ? 'enfrente' : ad > 130 ? 'a mi espalda' : (deg > 0 ? 'a mi derecha' : 'a mi izquierda');
    };
    const item = (nombre, x, z, max) => {
      const d = Math.hypot(x - me.x, z - me.z);
      return d <= max ? { d, t: `${nombre} (${Math.round(d)} m, ${dirTo(x, z)})` } : null;
    };
    const top = (arr, n) => arr.filter(Boolean).sort((a, b) => a.d - b.d).slice(0, n).map((o) => o.t);
    const jugadores = top(roster().filter((r) => r.s === getSceneId()).map((r) => {
      const pos = r.me ? getPlayer()?.position : (r.p ? { x: r.p[0], z: r.p[2] } : null);
      return pos ? item(r.me ? `${r.n}, el que te habla` : r.n, pos.x, pos.z, 40) : null;
    }), 8);
    const casas = top((lotes.list ?? []).map((sp) => {
      const dueno = lotes.record(sp.key)?.n;
      return sp.pos ? item(`casa ${sp.label}${dueno ? ` de ${dueno}` : ' (libre)'}`, sp.pos.x, sp.pos.z, 30) : null;
    }), 4);
    const nodes = entry.route?.data?.nodes ?? routeData?.nodes ?? {};
    const lugares = top(Object.entries(nodes).map(([id, n]) => (Array.isArray(n.position) ? item(PLACE_NAMES[id] ?? id, n.position[0], n.position[2], 15) : null)), 3);
    const otros = top((npcs.list ?? []).filter((n) => n.id !== ID && n.holder).map((n) => item(n.talk?.speaker ?? n.id, n.holder.position.x, n.holder.position.z, 30)), 4);
    const h = new Date().getHours();
    const momento = h < 6 ? 'madrugada' : h < 12 ? 'mañana' : h < 14 ? 'mediodía' : h < 19 ? 'tarde' : h < 21 ? 'atardecer' : 'noche';
    return { momento, jugadores, casas, lugares, otros_npc: otros };
  }

  // ---------- IA ----------
  let lastAsk = 0;
  const history = [];
  let routeData = null;
  loadJSON('data/routes/claude.json').then((d) => { routeData = d; }).catch(() => {});
  function resting() { try { return Number(localStorage.getItem(REST_KEY) || 0) > Date.now(); } catch { return false; } }
  function rest() { try { localStorage.setItem(REST_KEY, String(Date.now() + REST_SECS * 1000)); } catch { /* nada */ } }
  const aiOn = () => !!cfg.endpoint && cfg.activa !== false && !resting();
  const overload = () => ({ text: OVERLOAD, choices: [{ text: 'Dale, contame algo', next: 'charla' }, { text: 'Chau', next: 'despedida' }] });

  async function ask(e, text) {
    if (e.id !== ID) return { text: '…' };
    if (!aiOn()) { rest(); return overload(); }
    if (performance.now() - lastAsk < 2500) await new Promise((r) => setTimeout(r, 2500 - (performance.now() - lastAsk)));
    lastAsk = performance.now();
    const here = roster().filter((r) => r.s === getSceneId()).map((r) => r.n).slice(0, 12);
    const owners = (lotes.list ?? []).map((sp) => ({ lote: sp.label, dueno: lotes.record(sp.key)?.n || null })).filter((x) => x.dueno);
    const places = Object.keys(routeData?.nodes ?? {}).map((id) => ({ id, nombre: PLACE_NAMES[id] ?? id }));
    const body = {
      jugador: myName, texto: String(text).slice(0, 200), historial: history.slice(-6),
      mundo: { jugadores_en_la_plaza: here, casas: owners, lugares: places, modo_actual: driving ? mode.type : (remote?.m ?? 'route'), vista: vista() },
    };
    let res;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) { rest(); return overload(); }
      res = await r.json();
    } catch { rest(); return overload(); }
    if (!res || typeof res.decir !== 'string') { rest(); return overload(); }
    const say = res.decir.trim().slice(0, 400) || '…';
    history.push({ de: myName, texto: body.texto }, { de: 'Claude', texto: say });
    while (history.length > 12) history.shift();
    const errs = act(Array.isArray(res.acciones) ? res.acciones : []);
    return { text: errs.length ? `${say}\n(Uy, ${errs.join(' y ')}.)` : say };
  }
  const choiceOk = (c) => (c?.needs === 'ia' ? aiOn() : true);

  // ---------- Cada cuadro ----------
  const _v = new THREE.Vector3();
  function moveTowards(x, z, speed, dt, stopAt) {
    const h = entry.holder;
    const dx = x - h.position.x, dz = z - h.position.z;
    const d = Math.hypot(dx, dz);
    if (d <= stopAt) { if (entry.current !== entry.idle) npcs.play(entry, null); return true; }
    const step = Math.min(d - stopAt, speed * dt);
    h.position.x += (dx / d) * step; h.position.z += (dz / d) * step;
    entry.targetYaw = Math.atan2(dx, dz) + entry.yawOffset;
    const walk = entry.walkName || entry.clips.find((c) => /walk|camina/i.test(c.name))?.name;
    if (walk && entry.current?.getClip?.().name !== walk) npcs.play(entry, walk);
    if (entry.obstacle) { entry.obstacle.x = h.position.x; entry.obstacle.z = h.position.z; }
    return false;
  }

  function update(dt, entryList) {
    entry = find(entryList);
    if (!entry) { driving = false; return; }
    const was = driving;
    driving = electDriver();
    entry.external = !driving; // npc.js: un NPC "externo" no corre su ruta (lo mueve la red)
    entry.keepHold = !driving || mode.type !== 'route';
    if (driving && !was && remote) { // lo tomo yo: arranco donde estaba
      entry.holder.position.set(remote.x, remote.y, remote.z);
      entry.targetYaw = remote.f;
      talk = remote.w && alive(remote.w) ? { u: remote.w, n: remote.wn, keep: performance.now() } : { u: null, n: '', keep: 0 };
      entry._held = false;
      if (remote.m && remote.m !== 'route') { mode = { type: 'stay', until: performance.now() + 20000 }; holdRoute(); }
      else resumeRoute();
    }
    if (myTalking && !solo && !driving) { keepT += dt; if (keepT > TALK_KEEP) { keepT = 0; send({ req: 'keep', u: myUid }); } }

    if (driving) {
      const now = performance.now();
      if (talk.u && talk.u !== myUid && (now - talk.keep > TALK_LOST * 1000 || !alive(talk.u))) { talk = { u: null, n: '', keep: 0 }; resumeAfterTalk(); }
      if (talk.u) { // charlando: quieto y mirando al que le habla (si es otro jugador; si sos vos, lo hace el diálogo)
        holdRoute();
        if (talk.u !== myUid) {
          const p = playerPos(talk.u);
          if (p) entry.targetYaw = Math.atan2(p.x - entry.holder.position.x, p.z - entry.holder.position.z) + entry.yawOffset;
          if (entry.current !== entry.idle && /walk|camina/i.test(entry.current?.getClip?.().name ?? '')) npcs.play(entry, null);
          const tk = entry.talk?.talkAnim;
          if (tk && entry.current?.getClip?.().name !== tk) npcs.play(entry, tk);
        }
      } else if (mode.type === 'follow') {
        const p = playerPos(mode.u);
        if (!p || now > mode.until) { mode = { type: 'stay', until: now + STAY_SECS * 1000 }; }
        else if (p.s !== getSceneId()) { mode = { type: 'stay', until: now + STAY_SECS * 1000 }; } // entró a su casa: lo espero acá
        else moveTowards(p.x, p.z, Math.hypot(p.x - entry.holder.position.x, p.z - entry.holder.position.z) > 6 ? 4.2 : 2.2, dt, FOLLOW_NEAR);
      } else if (mode.type === 'go') {
        if (moveTowards(mode.to.x, mode.to.z, 2.4, dt, 0.4)) mode = { type: 'stay', until: now + STAY_SECS * 1000 };
      } else if (mode.type === 'stay') {
        if (now > mode.until) { mode = { type: 'route' }; resumeRoute(); }
      }
      sendT += dt;
      if (sendT >= SEND_EVERY) { sendT = 0; broadcast(); }
    } else if (remote) { // lo dibujo como me dicen
      const h = entry.holder;
      const k = Math.min(1, dt / INTERP);
      target.set(remote.x, remote.y, remote.z);
      if (h.position.distanceTo(target) > 8) h.position.copy(target); else h.position.lerp(target, k);
      entry.targetYaw = remote.f;
      const cur = entry.current?.getClip?.().name ?? '';
      if (remote.a && remote.a !== cur) npcs.play(entry, remote.a === entry.idleName ? null : remote.a);
      if (entry.obstacle) { entry.obstacle.x = h.position.x; entry.obstacle.z = h.position.z; }
    }
  }

  return {
    update, gate, ended, ask, choiceOk, act,
    get driving() { return driving; },
    get state() { return { driving, mode: driving ? mode.type : remote?.m, talkingWith: driving ? talk.n : remote?.wn, ai: aiOn() }; },
  };
}
