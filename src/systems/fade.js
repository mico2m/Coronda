// Fundido a negro. fadeOut() oscurece la pantalla y espera a que termine; fadeIn() la aclara.
export function createFade({ duration = 0.6 } = {}) {
  const el = document.createElement('div');
  el.className = 'fade';
  el.style.setProperty('--fade-time', `${duration}s`);
  document.querySelector('.app').appendChild(el);

  function run(opaque) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; el.removeEventListener('transitionend', finish); resolve(); } };
      el.addEventListener('transitionend', finish);
      setTimeout(finish, duration * 1000 + 100); // por si el navegador no dispara transitionend (pestaña en segundo plano)
      el.classList.toggle('on', opaque);
    });
  }

  return {
    fadeOut: () => run(true),
    fadeIn: () => run(false),
  };
}
