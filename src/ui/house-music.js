// Música de las casas: el dueño pega un enlace de YouTube y suena para todos los que estén adentro.
// Cada uno maneja lo suyo (pausa, silencio y volumen son solo para vos; el volumen y el silencio se recuerdan).
// Usa el reproductor oficial de YouTube (iframe), chiquito en la esquina de arriba a la izquierda.
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
  return v || l ? { v, l } : null;
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
    <div class="cm-video"><div class="cm-player"></div></div>
    <div class="cm-row">
      <button type="button" data-a="play" class="cm-play" aria-label="Pausa">⏸</button>
      <button type="button" data-a="mute" class="cm-mute" aria-label="Silenciar">🔊</button>
      <input class="cm-vol" type="range" min="0" max="100" step="1" aria-label="Volumen">
      <button type="button" data-a="video" class="cm-toggle" aria-label="Mostrar u ocultar el video" title="Mostrar/ocultar video">▾</button>
    </div>
    <p class="cm-msg" hidden></p>
    <form class="cm-set" hidden>
      <input class="cm-url" type="url" inputmode="url" placeholder="Enlace de YouTube" aria-label="Enlace de YouTube para la música de la casa">
      <button type="submit">Poner</button>
      <button type="button" data-a="clear" class="cm-clear">Quitar</button>
    </form>
    <button type="button" data-a="edit" class="cm-edit" hidden>🎵 Música</button>`;
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

  let started = false, player = null, playerReady = false, want = null, owner = false, active = false, playing = false, showVideo = true, token = 0;
  const same = (a, b) => (a?.v ?? '') === (b?.v ?? '') && (a?.l ?? '') === (b?.l ?? '');

  function draw() {
    box.hidden = !active || (!want && !owner);
    $('.cm-row').hidden = !want;
    $('.cm-video').hidden = !want || !showVideo;
    $('.cm-toggle').textContent = showVideo ? '▾' : '▸';
    $('.cm-play').textContent = playing ? '⏸' : '▶';
    $('.cm-play').setAttribute('aria-label', playing ? 'Pausa' : 'Reproducir');
    $('.cm-mute').textContent = muted || volume === 0 ? '🔇' : '🔊';
    $('.cm-mute').setAttribute('aria-label', muted ? 'Activar sonido' : 'Silenciar');
    $('.cm-mute').setAttribute('aria-pressed', String(muted));
    $('.cm-edit').hidden = !owner || !$('.cm-set').hidden;
    $('.cm-edit').textContent = want ? '🎵 Cambiar música' : '🎵 Poner música';
    $('.cm-clear').hidden = !want;
  }
  function msg(t) { const p = $('.cm-msg'); p.textContent = t ?? ''; p.hidden = !t; }
  function applyVolume() {
    if (!playerReady) return;
    player.setVolume(volume);
    if (muted) player.mute(); else player.unMute();
  }
  function destroy() {
    token++;
    try { player?.destroy(); } catch { /* nada */ }
    player = null; playerReady = false; playing = false; started = false;
  }
  async function start(mu) {
    destroy();
    const my = token;
    msg('');
    let YT;
    try { YT = await loadApi(); } catch { if (my === token) { msg('No se pudo cargar YouTube'); draw(); } return; }
    if (my !== token || !same(want, mu)) return;
    $('.cm-video').innerHTML = '<div class="cm-player"></div>';
    const vars = { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, loop: 1 };
    if (mu.l) Object.assign(vars, { listType: 'playlist', list: mu.l });
    else vars.playlist = mu.v; // un video solo: se repite
    player = new YT.Player($('.cm-player'), {
      width: 200, height: 113, videoId: mu.v || undefined, playerVars: vars,
      events: {
        onReady: () => { if (my !== token) return; playerReady = true; applyVolume(); try { player.playVideo(); } catch { /* nada */ } },
        onStateChange: (e) => {
          if (my !== token) return;
          playing = e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.BUFFERING;
          if (playing) { started = true; msg(''); }
          draw();
        },
        onError: (e) => {
          if (my !== token) return;
          msg(e.data === 101 || e.data === 150 ? 'Ese video no se puede reproducir fuera de YouTube' : 'No se pudo reproducir ese video');
          draw();
        },
        onAutoplayBlocked: () => { if (my === token) { msg('Tocá ▶ para escuchar la música'); draw(); } },
      },
    });
    // Si el navegador no deja arrancar solo, a los segundos se avisa
    setTimeout(() => { if (my === token && playerReady && !started && $('.cm-msg').hidden) { msg('Tocá ▶ para escuchar la música'); draw(); } }, 4000);
  }

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'play') { if (!playerReady) { if (want) start(want); } else if (playing) player.pauseVideo(); else { player.playVideo(); msg(''); } }
    else if (a === 'mute') {
      muted = !muted;
      if (!muted && volume === 0) { volume = 40; vol.value = '40'; }
      try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); localStorage.setItem(VOL_KEY, String(volume)); } catch { /* nada */ }
      applyVolume();
    } else if (a === 'video') showVideo = !showVideo;
    else if (a === 'edit') { $('.cm-set').hidden = false; $('.cm-url').value = ''; draw(); $('.cm-url').focus(); return; }
    else if (a === 'clear') { $('.cm-set').hidden = true; onSet?.(null); }
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
      draw();
    },
    enter(isOwner) { active = true; owner = !!isOwner; $('.cm-set').hidden = true; draw(); },
    leave() { active = false; want = null; owner = false; destroy(); msg(''); $('.cm-set').hidden = true; draw(); },
    get playing() { return playing; },
    get state() { return { want, playing, volume, muted, owner, active }; },
  };
}
