// Interacción entre jugadores (solo en el servidor): clic sobre otro jugador → menú con
//   A. Ver perfil        estadísticas, nivel, personaje, foto, firmas y lo que lleva en la mochila
//   B. Dejar una firma   un comentario en su perfil (el dueño lo ve y lo puede borrar)
//   C. Intercambiar      los dos ponen objetos y cantidades; los dos confirman; lo hace el SERVIDOR de una sola vez
// También: tu propio perfil (botón 👤 / tecla 4) con la foto de perfil (se recorta cuadrada, se achica a 128 × 128 y
// se comprime a WebP antes de subirla: nunca se manda la foto original).
//
// Todo lo que cambia algo pasa por el servidor (net.rpc): perfil.ver / perfil.firmar / perfil.borrarFirma /
// perfil.foto / trato.pedir / trato.responder / trato.ofrecer / trato.listo / trato.cancelar.
import * as THREE from 'three';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FIRMA_MAX = 200;
const FOTO_LADO = 128;           // px de la foto guardada
const FOTO_MAX_BYTES = 60 * 1024; // el servidor acepta hasta 64 KB
const FOTO_ORIGEN_MAX = 15 * 1024 * 1024; // no se abre una imagen de más de 15 MB

function fecha(t) { return t ? new Date(t).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function horas(ms) { const h = ms / 3600e3; return h < 1 ? `${Math.max(1, Math.round(ms / 60000))} min` : `${Math.round(h * 10) / 10} h`; }

// Foto de perfil: recorte cuadrado al centro, 128 × 128, WebP (o JPEG si el navegador no sabe WebP), lo más liviana posible
export async function prepararFoto(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('Elegí una imagen (JPG, PNG o WebP).');
  if (file.size > FOTO_ORIGEN_MAX) throw new Error('La imagen es demasiado grande (más de 15 MB).');
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('No se pudo leer la imagen.');
  const lado = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = FOTO_LADO;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (bmp.width - lado) / 2, (bmp.height - lado) / 2, lado, lado, 0, 0, FOTO_LADO, FOTO_LADO);
  bmp.close?.();
  for (const [tipo, q] of [['image/webp', 0.82], ['image/webp', 0.65], ['image/jpeg', 0.8], ['image/jpeg', 0.6], ['image/jpeg', 0.45]]) {
    const url = c.toDataURL(tipo, q);
    if (!url.startsWith(`data:${tipo}`)) continue; // ese formato no lo sabe hacer este navegador
    if ((url.length * 3) / 4 <= FOTO_MAX_BYTES) return url;
  }
  throw new Error('No se pudo achicar la imagen lo suficiente.');
}

export function createSocial({ net, stage, camera, inventario, notify = () => {}, onOpen = () => {}, onClose = () => {}, blocked = () => false }) {
  const app = stage.closest('.app') ?? document.body;
  const icono = (kind, id) => inventario?.icono?.(kind, id) ?? '';
  const nombreDe = (kind, id) => inventario?.nameOf?.(kind, id) ?? id;

  // ---------- Ventana genérica ----------
  const win = document.createElement('div');
  win.className = 'cw'; win.hidden = true;
  win.setAttribute('role', 'dialog');
  app.append(win);
  let abierta = null; // 'perfil' | 'trato' | 'menu'
  function abrir(tipo, html, titulo) {
    if (!abierta) onOpen();
    abierta = tipo;
    win.setAttribute('aria-label', titulo);
    win.innerHTML = `<div class="cw-card cw-${tipo}"><div class="cw-head"><b>${esc(titulo)}</b><button type="button" class="cw-x" aria-label="Cerrar">✕</button></div><div class="cw-body">${html}</div></div>`;
    win.hidden = false;
  }
  function cerrar() {
    if (!abierta) return;
    if (abierta === 'trato' && trato && !trato.fin) net.rpc('trato.cancelar').catch(() => {});
    abierta = null; win.hidden = true; win.innerHTML = '';
    onClose();
  }
  win.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === win) cerrar(); });
  win.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  win.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') cerrar(); });
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && abierta) { e.preventDefault(); e.stopImmediatePropagation(); cerrar(); } }, true);

  // ---------- Perfil ----------
  const fotoHtml = (u, v, nombre, clase = 'cw-foto') => (v ? `<img class="${clase}" src="${esc(net.foto(u, v))}" alt="Foto de ${esc(nombre)}">` : `<span class="${clase} cw-foto-vacia" aria-hidden="true">${esc((String(nombre).trim()[0] ?? '?').toUpperCase())}</span>`);
  function invHtml(inv) {
    const items = [...Object.entries(inv?.recursos ?? {}).map(([id, n]) => ['recursos', id, n]), ...Object.entries(inv?.muebles ?? {}).map(([id, n]) => ['muebles', id, n])].filter((x) => x[2] > 0);
    if (!items.length) return '<p class="cw-vacio">La mochila está vacía.</p>';
    return `<div class="cw-items">${items.map(([k, id, n]) => `<div class="cw-item" title="${esc(nombreDe(k, id))} ×${n}">${icono(k, id)}<b>${n}</b></div>`).join('')}</div>`;
  }
  async function verPerfil(u) {
    abrir('perfil', '<p class="cw-cargando">Cargando…</p>', 'Perfil');
    let p;
    try { p = await net.rpc('perfil.ver', { u }); } catch (e) { abrir('perfil', `<p class="cw-error">${esc(e.message)}</p>`, 'Perfil'); return; }
    const mio = p.u === net.uid;
    const s = p.stats ?? {};
    abrir('perfil', `
      <div class="cw-perfil-top">
        ${fotoHtml(p.u, p.foto, p.nombre)}
        <div><div class="cw-nombre">${esc(p.nombre)}</div>
          <div class="cw-sub">${p.personaje ? `${esc(p.personaje)} · ` : ''}Nivel ${p.nivel}</div>
          <div class="cw-sub">${p.conectado ? '<i class="cw-on"></i> Conectado' : `Última vez: ${fecha(p.ultimo)}`} · Desde ${fecha(p.creado)}</div></div>
      </div>
      ${mio ? `<div class="cw-foto-acc"><label class="cw-btn">📷 Cambiar foto<input type="file" accept="image/*" class="cw-foto-in" hidden></label>${p.foto ? '<button type="button" class="cw-btn cw-sinfoto">Quitar foto</button>' : ''}<small>Se recorta cuadrada y se achica sola.</small></div>` : ''}
      <div class="cw-stats">
        <div><b>${Math.floor(p.xp)}</b><small>XP</small></div><div><b>${s.arboles ?? 0}</b><small>árboles</small></div>
        <div><b>${s.madera ?? 0}</b><small>madera juntada</small></div><div><b>${s.muebles ?? 0}</b><small>muebles retirados</small></div>
        <div><b>${s.intercambios ?? 0}</b><small>intercambios</small></div><div><b>${horas(p.jugado ?? 0)}</b><small>jugado</small></div>
      </div>
      <div class="cw-sec">Mochila</div>${invHtml(p.inv)}
      <div class="cw-sec">Firmas (${p.firmas.length})</div>
      ${mio ? '' : `<form class="cw-firmar"><textarea maxlength="${FIRMA_MAX}" rows="2" placeholder="Dejale un mensaje a ${esc(p.nombre)}…" required></textarea><div><small class="cw-cuenta">0 / ${FIRMA_MAX}</small><button type="submit" class="cw-btn cw-pri">✍ Firmar</button></div></form>`}
      <ul class="cw-firmas">${p.firmas.map((f) => `<li><b>${esc(f.n)}</b> <small>${fecha(f.t)}</small>${mio ? `<button type="button" class="cw-borrar" data-i="${esc(f.i)}" aria-label="Borrar firma">✕</button>` : ''}<p>${esc(f.txt)}</p></li>`).join('') || '<li class="cw-vacio">Todavía nadie firmó.</li>'}</ul>
      ${mio ? '' : `<div class="cw-acciones"><button type="button" class="cw-btn cw-pri cw-trato" data-u="${esc(p.u)}"${p.conectado ? '' : ' disabled'}>🤝 Intercambiar</button></div>`}`, mio ? 'Mi perfil' : `Perfil de ${p.nombre}`);
    const ta = win.querySelector('.cw-firmar textarea');
    ta?.addEventListener('input', () => { win.querySelector('.cw-cuenta').textContent = `${ta.value.length} / ${FIRMA_MAX}`; });
    win.querySelector('.cw-firmar')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const txt = ta.value.trim();
      if (!txt) { notify('Escribí algo antes de firmar.'); return; }
      try { await net.rpc('perfil.firmar', { u: p.u, txt }); notify(`Firmaste el perfil de ${p.nombre}.`); verPerfil(p.u); } catch (err) { notify(err.message); }
    });
    win.querySelectorAll('.cw-borrar').forEach((b) => b.addEventListener('click', async () => { try { await net.rpc('perfil.borrarFirma', { i: b.dataset.i }); verPerfil(p.u); } catch (err) { notify(err.message); } }));
    win.querySelector('.cw-trato')?.addEventListener('click', () => pedirTrato(p.u, p.nombre));
    win.querySelector('.cw-foto-in')?.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try { const img = await prepararFoto(f); await net.rpc('perfil.foto', { img }); notify('Foto de perfil actualizada.'); verPerfil(p.u); } catch (err) { notify(err.message); }
    });
    win.querySelector('.cw-sinfoto')?.addEventListener('click', async () => { try { await net.rpc('perfil.foto', { img: null }); verPerfil(p.u); } catch (err) { notify(err.message); } });
  }
  async function firmar(u, nombre) {
    abrir('perfil', `<form class="cw-firmar"><textarea maxlength="${FIRMA_MAX}" rows="3" placeholder="Dejale un mensaje a ${esc(nombre)}…" required></textarea><div><small class="cw-cuenta">0 / ${FIRMA_MAX}</small><button type="submit" class="cw-btn cw-pri">✍ Firmar</button></div></form>`, `Firmar el perfil de ${nombre}`);
    const ta = win.querySelector('textarea');
    setTimeout(() => ta.focus(), 30);
    ta.addEventListener('input', () => { win.querySelector('.cw-cuenta').textContent = `${ta.value.length} / ${FIRMA_MAX}`; });
    win.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const txt = ta.value.trim();
      if (!txt) { notify('Escribí algo antes de firmar.'); return; }
      try { await net.rpc('perfil.firmar', { u, txt }); notify(`Firmaste el perfil de ${nombre}.`); cerrar(); } catch (err) { notify(err.message); }
    });
  }

  // ---------- Intercambio ----------
  let trato = null;      // lo último que mandó el servidor
  let miOferta = {};     // { 'recursos:madera': 3 }
  function pedirTrato(u, nombre) {
    net.rpc('trato.pedir', { u }).then(() => { miOferta = {}; abrir('trato', `<p class="cw-cargando">Esperando a que ${esc(nombre)} acepte…</p><div class="cw-acciones"><button type="button" class="cw-btn cw-cancelar">Cancelar</button></div>`, 'Intercambio'); win.querySelector('.cw-cancelar').onclick = cerrar; })
      .catch((e) => notify(e.message));
  }
  function dibujarTrato() {
    const t = trato;
    if (!t) return;
    const yo = net.uid, otro = t.a === yo ? t.b : t.a;
    const nOtro = t.a === yo ? t.nb : t.na;
    const mio = t.oferta[yo] ?? {}, suyo = t.oferta[otro] ?? {};
    const lista = (of) => {
      const e = Object.entries(of);
      return e.length ? `<div class="cw-items">${e.map(([cl, n]) => { const [k, id] = cl.split(':'); return `<div class="cw-item" title="${esc(nombreDe(k, id))} ×${n}">${icono(k, id)}<b>${n}</b></div>`; }).join('')}</div>` : '<p class="cw-vacio">Nada todavía</p>';
    };
    const inv = inventario?.snapshot?.() ?? { recursos: {}, muebles: {} };
    const propios = [...Object.entries(inv.recursos).map(([id, n]) => ['recursos', id, n]), ...Object.entries(inv.muebles).map(([id, n]) => ['muebles', id, n])].filter((x) => x[2] > 0);
    abrir('trato', `
      <div class="cw-trato-cols">
        <section><h3>Vos ofrecés ${t.listo[yo] ? '<span class="cw-ok">✔ listo</span>' : ''}</h3>${lista(mio)}</section>
        <section><h3>${esc(nOtro)} ofrece ${t.listo[otro] ? '<span class="cw-ok">✔ listo</span>' : ''}</h3>${lista(suyo)}</section>
      </div>
      <div class="cw-sec">Tu mochila: elegí qué y cuánto ofrecer</div>
      <div class="cw-elegir">${propios.map(([k, id, n]) => { const cl = `${k}:${id}`; return `<label class="cw-elige">${icono(k, id)}<span>${esc(nombreDe(k, id))}<small> (tenés ${n})</small></span><input type="number" min="0" max="${n}" step="1" value="${miOferta[cl] ?? 0}" data-cl="${esc(cl)}" aria-label="Cantidad de ${esc(nombreDe(k, id))}"></label>`; }).join('') || '<p class="cw-vacio">No tenés nada para ofrecer.</p>'}</div>
      <p class="cw-nota">Si alguien cambia su oferta, los dos tienen que volver a confirmar. El intercambio lo hace el servidor recién cuando los dos confirman.</p>
      <div class="cw-acciones"><button type="button" class="cw-btn cw-actualizar">Actualizar mi oferta</button>
        <button type="button" class="cw-btn cw-pri cw-listo">${t.listo[yo] ? 'Esperando al otro…' : '✔ Aceptar'}</button>
        <button type="button" class="cw-btn cw-cancelar">Cancelar</button></div>`, `Intercambio con ${nOtro}`);
    win.querySelector('.cw-actualizar').onclick = () => {
      const of = {};
      win.querySelectorAll('[data-cl]').forEach((i) => { const n = Math.floor(Number(i.value)); if (n > 0) of[i.dataset.cl] = Math.min(n, Number(i.max)); });
      miOferta = of;
      net.rpc('trato.ofrecer', { oferta: of }).catch((e) => notify(e.message));
    };
    win.querySelector('.cw-listo').onclick = () => net.rpc('trato.listo', { si: !t.listo[yo] }).catch((e) => notify(e.message));
    win.querySelector('.cw-cancelar').onclick = cerrar;
  }
  const prevTrato = net.onTrato;
  net.onTrato = (m) => {
    prevTrato?.(m);
    if (m.invitacion) {
      const inv = m.invitacion;
      if (abierta && abierta !== 'menu') { net.rpc('trato.responder', { id: inv.id, si: false }).catch(() => {}); return; } // ocupado
      abrir('trato', `<p><b>${esc(inv.n)}</b> quiere intercambiar objetos con vos.</p><div class="cw-acciones"><button type="button" class="cw-btn cw-pri cw-si">Aceptar</button><button type="button" class="cw-btn cw-no">No, gracias</button></div>`, 'Intercambio');
      win.querySelector('.cw-si').onclick = () => { miOferta = {}; net.rpc('trato.responder', { id: inv.id, si: true }).catch((e) => notify(e.message)); };
      win.querySelector('.cw-no').onclick = () => { net.rpc('trato.responder', { id: inv.id, si: false }).catch(() => {}); trato = { fin: true }; cerrar(); };
      return;
    }
    if (m.fin) {
      trato = { fin: true };
      notify(m.motivo || (m.hecho ? '¡Intercambio hecho!' : 'Intercambio cancelado.'));
      if (abierta === 'trato') cerrar();
      return;
    }
    if (m.trato) { trato = m.trato; if (trato.aceptado) dibujarTrato(); }
  };
  inventario?.onChange?.(() => { if (abierta === 'trato' && trato?.aceptado) dibujarTrato(); });

  // ---------- Clic sobre otro jugador: menú ----------
  const menu = document.createElement('div');
  menu.className = 'cw-menu'; menu.hidden = true;
  menu.setAttribute('role', 'menu');
  app.append(menu);
  function abrirMenu(u, nombre, x, y) {
    menu.innerHTML = `<div class="cw-menu-n">${esc(nombre)}</div>
      <button type="button" role="menuitem" data-a="perfil">👤 Ver perfil</button>
      <button type="button" role="menuitem" data-a="firmar">✍ Dejar una firma</button>
      <button type="button" role="menuitem" data-a="trato">🤝 Intercambiar</button>`;
    const r = app.getBoundingClientRect();
    menu.style.left = `${Math.min(x - r.left, r.width - 190)}px`;
    menu.style.top = `${Math.min(y - r.top, r.height - 160)}px`;
    menu.hidden = false;
    menu.querySelector('button').focus();
    menu.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      menu.hidden = true;
      if (a === 'perfil') verPerfil(u); else if (a === 'firmar') firmar(u, nombre); else if (a === 'trato') pedirTrato(u, nombre);
    };
  }
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());
  addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; }, true);
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && !menu.hidden) { menu.hidden = true; e.stopImmediatePropagation(); } }, true);

  // Clic (no arrastre) sobre el personaje de otro jugador
  const ray = new THREE.Raycaster();
  let down = null;
  stage.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.button === 2) down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  stage.addEventListener('pointerup', (e) => {
    if (!down || blocked() || abierta) { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 600;
    down = null;
    if (moved) return; // fue para girar la cámara
    const r = stage.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    let best = null;
    for (const a of net.avatars()) {
      const hit = ray.intersectObject(a.root, true)[0];
      // los personajes animados (skinned) a veces no dan en el raycast: también vale tocar cerca de su centro
      const d = hit ? hit.distance : distanciaAlRayo(a.root);
      if (d !== null && (!best || d < best.d)) best = { ...a, d };
    }
    if (best) abrirMenu(best.u, best.n, e.clientX, e.clientY);
  });
  const _c = new THREE.Vector3();
  function distanciaAlRayo(root) {
    root.getWorldPosition(_c); _c.y += 0.9;
    return ray.ray.distanceSqToPoint(_c) < 0.45 * 0.45 ? ray.ray.origin.distanceTo(_c) : null;
  }

  return { verPerfil, miPerfil: () => verPerfil(net.uid), firmar, pedirTrato, cerrar, get abierta() { return !!abierta; } };
}
