// Música de las casas: el dueño pega un enlace de YouTube y suena para todos los que estén adentro.
// Pausar, cambiar o quitar la música: solo el dueño (para todos). Volumen y silencio: cada uno el suyo (se recuerdan).
// Usa el reproductor oficial de YouTube (iframe) escondido: solo se ve "♪ Sonando: título" y ⋯ con las opciones.
const VOL_KEY = 'coronda.musica.vol';
const MUTE_KEY = 'coronda.musica.mute';
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ID = /^[A-Za-z0-9_-]{11}$/;
const LIST = /^[A-Za-z0-9_-]{10,64}$/;

// Enlace de YouTube -> { v: id del video, l: id de la lista } (o null si no se entiende)
export function parseYouTube(text) {
  const t = String(text ?? '').trim();
  if (ID.test(t)) return { v: t, l: '' };
  let u;
  try { u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let v = '';
  if (host === 'youtu.be') v = u.pathname.split('/')[1] ?? '';
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    v = u.searchParams.get('v') ?? '';
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
    if (!v && m) v = m[2];
  } else return null;
  const l = u.searchParams.get('list') ?? '';
  const out = { v: ID.test(v) ? v : '', l: LIST.test(l) ? l : '' };
  return out.v || out.l ? out : null;
}
export function cleanMusic(mu) {
  if (!mu || typeof mu !== 'object') return null;
  const v = ID.test(mu.v ?? '') ? mu.v : '';
  const l = LIST.test(mu.l ?? '') ? mu.l : '';
  const r = Number.isInteger(mu.r) && mu.r > 0 ? mu.r % 1e9 : 0;
  return v || l ? { v, l, p: !!mu.p, ...(r ? { r } : {}) } : null; // p: en pausa · r: el dueño la volvió a poner (para todos)
}

let apiPromise = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('No se pudo cargar YouTube')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

// opts: parent (contenedor), onSet(mu | null) (el dueño cambió la música), notify(msg)
export function createHouseMusic({ parent, onSet, notify = () => {} }) {
  const box = document.createElement('div');
  box.className = 'casa-music';
  box.hidden = true;
  box.innerHTML = `
    <div class="cm-player-wrap" aria-hidden="true"><div class="cm-player"></div></div>
    <div class="cm-now">
      <span class="cm-note" aria-hidden="true">♪</span>
      <span class="cm-title"><small>Sonando:</small> <b class="cm-name">…</b></span>
      <button type="button" data-a="menu" class="cm-more" aria-label="Opciones de la música" aria-expanded="false">⋯</button>
    </div>
    <div class="cm-menu" hidden>
      <div class="cm-row">
        <button type="button" data-a="play" class="cm-play" aria-label="Pausa">⏸</button>
        <button type="button" data-a="again" class="cm-again" aria-label="Volver a escucharla" title="Volver a escucharla">↺</button>
        <button type="button" data-a="mute" class="cm-mute" aria-label="Silenciar">🔊</button>
        <input class="cm-vol" type="range" min="0" max="100" step="1" aria-label="Volumen (solo para vos)" title="Volumen (solo para vos)">
      </div>
      <button type="button" data-a="edit" class="cm-edit cm-own">🎵 Cambiar música</button>
      <button type="button" data-a="clear" class="cm-clear cm-own">Quitar música</button>
    </div>
    <button type="button" data-a="listen" class="cm-listen" hidden>▶ Tocá para escuchar</button>
    <p class="cm-msg" hidden></p>
    <form class="cm-set" hidden>
      <input class="cm-url" type="url" inputmode="url" placeholder="Enlace de YouTube" aria-label="Enlace de YouTube para la música de la casa">
      <button type="submit">Poner</button>
      <button type="button" data-a="close" class="cm-cancel">Cancelar</button>
    </form>
    <button type="button" data-a="edit" class="cm-start" hidden>🎵 Poner música</button>`;
  parent.appendChild(box);
  const $ = (s) => box.querySelector(s);
  const vol = $('.cm-vol');

  let volume = 60, muted = false;
  try {
    const n = Number(localStorage.getItem(VOL_KEY));
    if (localStorage.getItem(VOL_KEY) !== null && n >= 0 && n <= 100) volume = n;
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch { /* nada */ }
  vol.value = String(volume);

  let ended = false, blocked = false, started = false, player = null, playerReady = false, want = null, owner = false, active = false, playing = false, menuOpen = false, title = '', token = 0;
  const same = (a, b) => (a?.v ?? '') === (b?.v ?? '') && (a?.l ?? '') === (b?.l ?? '') && (a?.r ?? 0) === (b?.r ?? 0);

  function draw() {
    const editing = !$('.cm-set').hidden;
    box.hidden = !active || (!want && !owner);
    $('.cm-now').hidden = !want;
    $('.cm-name').textContent = title || (playerReady ? 'música' : 'cargando…');
    $('.cm-name').title = title;
    $('.cm-note').classList.toggle('on', playing);
    $('.cm-title small').textContent = ended ? 'Terminó:' : want?.p ? 'En pausa:' : 'Sonando:';
    $('.cm-listen').hidden = !blocked || !want || want.p;
    $('.cm-menu').hidden = !want || !menuOpen;
    $('.cm-more').setAttribute('aria-expanded', String(menuOpen));
    box.querySelectorAll('.cm-own').forEach((b) => { b.hidden = !owner || editing; });
    $('.cm-start').hidden = !owner || !!want || editing;
    $('.cm-play').hidden = !owner || ended;
    $('.cm-again').hidden = !owner || !ended;
    $('.cm-play').textContent = want?.p ? '▶' : '⏸';
    $('.cm-play').setAttribute('aria-label', want?.p ? 'Reproducir para todos' : 'Pausar para todos');
    $('.cm-play').title = want?.p ? 'Reproducir (para todos)' : 'Pausar (para todos)';
    $('.cm-mute').textContent = muted || volume === 0 ? '🔇' : '🔊';
    $('.cm-mute').setAttribute('aria-label', muted ? 'Activar sonido' : 'Silenciar');
    $('.cm-mute').setAttribute('aria-pressed', String(muted));
  }
  function msg(t) { const p = $('.cm-msg'); p.textContent = t ?? ''; p.hidden = !t; }
  function applyVolume() {
    if (!playerReady) return;
    player.setVolume(volume);
    if (muted) player.mute(); else player.unMute();
  }
  function destroy() {
    token++;
    try { player?.stopVideo?.(); } catch { /* nada */ }
    try { player?.destroy(); } catch { /* nada */ }
    $('.cm-player-wrap').innerHTML = ''; // que no quede ningún iframe sonando
    player = null; ended = false; playerReady = false; playing = false; started = false; title = ''; blocked = false;
  }
  async function start(mu) {
    destroy();
    const my = token;
    msg('Cargando música…');
    let YT;
    try { YT = await loadApi(); } catch { if (my === token) { msg('No se pudo cargar YouTube'); draw(); } return; }
    if (my !== token || !same(want, mu)) return;
    $('.cm-player-wrap').innerHTML = '<div class="cm-player"></div>';
    const vars = { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1 }; // sin loop: cuando termina, termina
    if (mu.l) Object.assign(vars, { listType: 'playlist', list: mu.l });
    player = new YT.Player($('.cm-player'), {
      width: 200, height: 200, videoId: mu.v || undefined, playerVars: vars,
      events: {
        onReady: () => { if (my !== token) return; playerReady = true; msg(''); applyVolume(); if (!want?.p) try { player.playVideo(); } catch { /* nada */ } draw(); },
        onStateChange: (e) => {
          if (my !== token) return;
          playing = e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.BUFFERING;
          if (playing) ended = false;
          if (e.data === YT.PlayerState.ENDED) ended = true;
          if (playing) { started = true; msg(''); }
          if (playing && want?.p) { player.pauseVideo(); playing = false; } // el dueño la tiene en pausa
          try { const t = player.getVideoData?.()?.title; if (t) title = t; } catch { /* nada */ }
          draw();
        },
        onError: (e) => {
          if (my !== token) return;
          msg(e.data === 101 || e.data === 150 ? 'Ese video no se puede reproducir fuera de YouTube' : 'No se pudo reproducir ese video');
          draw();
        },
        onAutoplayBlocked: () => { if (my === token) { blocked = true; draw(); } },
      },
    });
    // Si el navegador no deja arrancar solo, a los segundos se avisa
    setTimeout(() => { if (my === token && playerReady && !started && !want?.p && $('.cm-msg').hidden) { blocked = true; draw(); } }, 4000);
  }

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'play') { if (owner && want) onSet?.({ ...want, p: !want.p }); } // pausa para todos: solo el dueño
    else if (a === 'again') { if (owner && want) { ended = false; onSet?.({ ...want, p: false, r: (Date.now() % 1e9) || 1 }); } }
    else if (a === 'listen') { blocked = false; if (!playerReady) { if (want) start(want); } else player.playVideo(); } // el navegador no la dejó arrancar sola
    else if (a === 'mute') {
      muted = !muted;
      if (!muted && volume === 0) { volume = 40; vol.value = '40'; }
      try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); localStorage.setItem(VOL_KEY, String(volume)); } catch { /* nada */ }
      applyVolume();
    } else if (a === 'menu') menuOpen = !menuOpen;
    else if (a === 'edit') { menuOpen = false; $('.cm-set').hidden = false; $('.cm-url').value = ''; draw(); $('.cm-url').focus(); return; }
    else if (a === 'close') $('.cm-set').hidden = true;
    else if (a === 'clear') { menuOpen = false; $('.cm-set').hidden = true; onSet?.(null); }
    draw();
    if (b.type !== 'submit') b.blur();
  });
  vol.addEventListener('input', () => {
    volume = Number(vol.value);
    if (muted && volume > 0) muted = false;
    try { localStorage.setItem(VOL_KEY, String(volume)); localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* nada */ }
    applyVolume();
    draw();
  });
  $('.cm-set').addEventListener('submit', (e) => {
    e.preventDefault();
    const mu = parseYouTube($('.cm-url').value);
    if (!mu) { notify('Ese enlace no es de YouTube'); $('.cm-url').focus(); return; }
    $('.cm-set').hidden = true;
    menuOpen = false;
    onSet?.(mu);
    draw();
  });
  // Escribir el enlace no mueve al personaje ni abre el chat; Esc cierra el campo
  box.addEventListener('keydown', (e) => {
    if (e.target === $('.cm-url')) {
      e.stopPropagation();
      if (e.key === 'Escape') { $('.cm-set').hidden = true; draw(); }
    }
    if (e.target === vol) e.stopPropagation();
  });

  return {
    // Adentro de una casa: qué música tiene y si sos el dueño. Afuera: show(null).
    show(mu, isOwner = false) {
      const next = mu ? cleanMusic(mu) : null;
      owner = !!isOwner;
      if (!same(next, want)) { want = next; if (want) start(want); else { destroy(); msg(''); } }
      else if (next && !!next.p !== !!want?.p) { // el dueño pausó o volvió a poner play
        want = next;
        if (playerReady) { if (want.p) player.pauseVideo(); else player.playVideo(); }
      }
      draw();
    },
    enter(isOwner) { active = true; owner = !!isOwner; menuOpen = false; $('.cm-set').hidden = true; draw(); },
    leave() { active = false; want = null; owner = false; menuOpen = false; destroy(); msg(''); $('.cm-set').hidden = true; draw(); },
    get playing() { return playing; },
    get state() { return { want, playing, volume, muted, owner, active, title }; },
  };
}
