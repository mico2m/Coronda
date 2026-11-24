// En vivo (solo en dev.html y con el servidor del proyecto: node studio/server.js).
// Cuando exportás un .glb desde Blender, el servidor avisa por /__events y acá se vuelve a armar la escena SIN recargar
// la página: quedás en el mismo lugar, mirando hacia el mismo lado.
//
//   connectLive({ onFiles(paths) })
export function connectLive({ onFiles }) {
  if (!window.EventSource) return null;
  let opened = false, timer = 0;
  const pending = new Set();
  const es = new EventSource('/__events');
  es.onopen = () => { opened = true; };
  // Sin el servidor del proyecto (ej. Live Server o la página publicada) no hay a quién escuchar: se deja de intentar
  es.onerror = () => { if (!opened) es.close(); };
  es.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (!m.path) return;
    pending.add(m.path);
    clearTimeout(timer); // varios archivos juntos = una sola actualización
    timer = setTimeout(() => { const list = [...pending]; pending.clear(); onFiles?.(list); }, 200);
  };
  return { close: () => es.close() };
}
