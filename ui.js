// Panel de controles: conecta los sliders y botones con el suelo.
import { makeDefaultTexture, loadTextureFromFile } from './textures.js';

export function bindUI({ floor, renderer }) {
  const $ = (id) => document.getElementById(id);
  const num = (id) => Number($(id).value);

  function applyFloor() {
    const w = num('sizeX'), d = num('sizeZ'), rx = num('repX'), rz = num('repZ');
    floor.setSize(w, d);
    floor.setRepeat(rx, rz);
    $('sizeXOut').textContent = w + ' m';
    $('sizeZOut').textContent = d + ' m';
    $('repXOut').textContent = '×' + rx;
    $('repZOut').textContent = '×' + rz;
  }

  ['sizeX', 'sizeZ'].forEach((id) => $(id).addEventListener('input', applyFloor));

  const linkRepetition = (from, to) => () => {
    if ($('linkRep').checked) $(to).value = $(from).value;
    applyFloor();
  };
  $('repX').addEventListener('input', linkRepetition('repX', 'repZ'));
  $('repZ').addEventListener('input', linkRepetition('repZ', 'repX'));
  $('linkRep').addEventListener('change', (e) => {
    if (e.target.checked) linkRepetition('repX', 'repZ')();
  });

  $('gridOn').addEventListener('change', (e) => floor.setGrid(e.target.checked));

  const status = $('status');
  $('texFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    status.textContent = 'Cargando ' + file.name + '…';
    try {
      const t = await loadTextureFromFile(file, renderer);
      floor.setTexture(t, num('repX'), num('repZ'));
      status.textContent = `Textura: ${file.name} (${t.image.width}×${t.image.height} px)`;
    } catch {
      status.textContent = 'No se pudo leer ' + file.name + '. Probá con un PNG, JPG o WebP.';
    }
  });
  $('texReset').addEventListener('click', () => {
    floor.setTexture(makeDefaultTexture(renderer), num('repX'), num('repZ'));
    status.textContent = 'Textura de prueba.';
  });

  // Mostrar u ocultar el panel (empieza cerrado en pantallas angostas)
  const toggle = $('toggle'), body = $('panelBody');
  const setOpen = (open) => {
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Ocultar' : 'Mostrar';
  };
  toggle.addEventListener('click', () => setOpen(body.hidden));
  if (window.matchMedia('(max-width: 520px)').matches) setOpen(false);

  applyFloor();
}