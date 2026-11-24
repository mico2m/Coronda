// En vivo con Blender (solo en dev.html y con el servidor del proyecto: node studio/server.js).
// El addon blender/coronda_vivo.py exporta el .glb cada vez que cambiás algo; el servidor avisa por /__events y acá
// se vuelve a armar la escena SIN recargar la página: quedás en el mismo lugar, mirando hacia el mismo lado.
// También recibe órdenes del addon: "view" (la cámara libre copia la vista de Blender) y "play" (el personaje aparece
// donde está el cursor 3D).
//
//   connectLive({ onFiles(paths), onBlender(msg) })
export function connectLive({ onFiles, onBlender }) {
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
    if (m.type === 'blender') { onBlender?.(m); return; }
    if (!m.path) return;
    pending.add(m.path);
    clearTimeout(timer); // varios archivos juntos (ej. el .glb y su .bin) = una sola actualización
    timer = setTimeout(() => { const list = [...pending]; pending.clear(); onFiles?.(list); }, 200);
  };
  return { close: () => es.close() };
}
