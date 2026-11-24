// Acceso a los archivos del proyecto a través de studio/server.js
const q = (p) => `/__api/file?p=${encodeURIComponent(p)}`;

export const api = {
  async tree() {
    const r = await fetch('/__api/tree', { cache: 'no-store' });
    if (!r.ok) throw new Error('No se pudo leer el proyecto (¿está corriendo node studio/server.js?)');
    return r.json();
  },
  async read(p) {
    const r = await fetch(q(p), { cache: 'no-store' });
    if (!r.ok) throw new Error(`No se pudo leer ${p}`);
    return r.text();
  },
  async readJSON(p) { return JSON.parse(await this.read(p)); },
  async write(p, body) {
    const r = await fetch(q(p), { method: 'PUT', body });
    if (!r.ok) throw new Error(`No se pudo guardar ${p}: ${await r.text()}`);
  },
  async exists(p) {
    const r = await fetch(`/${p}`, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
    return !!r?.ok;
  },
  // Cambios en el proyecto (lo que guarda el Studio y lo que exporta Blender)
  events(cb) {
    try {
      const es = new EventSource('/__events');
      es.onmessage = (e) => { try { cb(JSON.parse(e.data)); } catch { /* mensaje inválido */ } };
      return es;
    } catch { return null; }
  },
};

export const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
