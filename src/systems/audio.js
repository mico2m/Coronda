// Música de fondo. Los ids se definen en data/tables/music.json.
// Los navegadores bloquean el audio hasta que la persona interactúa con la página.
export function createAudio(musicTable = {}) {
  const el = new Audio();
  let master = 0.6;
  let currentId = null;
  let unlocked = false;
  let wantsPlay = false;

  const tryPlay = () => el.play().catch(() => {});
  const unlock = () => {
    unlocked = true;
    if (wantsPlay) tryPlay();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  return {
    playMusic(id) {
      const entry = musicTable[id];
      if (!entry || id === currentId) return;
      currentId = id;
      el.src = entry.file;
      el.loop = entry.loop !== false;
      el.volume = master * (entry.volume ?? 1);
      wantsPlay = true;
      if (unlocked) tryPlay();
    },
    stopMusic() {
      wantsPlay = false;
      currentId = null;
      el.pause();
    },
    setVolume(v) {
      master = Math.max(0, Math.min(1, v));
    },
  };
}
