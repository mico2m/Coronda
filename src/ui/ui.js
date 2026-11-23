// Interfaz: mensajes de estado. Los paneles del editor irán acá más adelante.
export function createUI() {
  const el = document.getElementById('loading');
  return {
    setStatus(text) {
      el.textContent = text;
      el.hidden = false;
    },
    clearStatus() {
      el.hidden = true;
      el.textContent = '';
    },
  };
}
