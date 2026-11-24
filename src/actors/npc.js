// NPC: personajes que no controla el jugador, con su modelo y su animación.
//
// Cómo agregar uno (sin tocar código):
//  1. Exportá el modelo a assets/models/objects/<nombre>.glb (origen en los pies, frente hacia -Y de Blender,
//     con la animación dentro, por ejemplo una acción llamada `idle`).
//  2. En el .glb de la escena poné un Empty llamado `npc_<nombre>` (ej. npc_vecino) en el SUELO, donde va a estar.
//     El NPC mira hacia donde apunta la flecha verde (eje Y) del Empty, igual que empty_spawn.
//     Si copiás el Empty, Blender le agrega .001 / .002: el juego lo ignora (npc_vecino.001 sigue siendo "vecino").
//  3. Opcional: Custom Properties en el Empty (acordate de tildar Include > Custom Properties al exportar):
//       npc_modelo = otro_nombre    usa assets/models/objects/otro_nombre.glb (con o sin .glb; o una ruta completa)
//       npc_anim   = idle           qué clip es el idle (si no lo ponés, se detecta solo; ver actors/npc-anim.js)
//       npc_escala = 1              tamaño
//       npc_radio  = 0.4            qué tan "ancho" es para que el jugador no lo atraviese (m)
//       npc_giro   = 0              grados extra de giro
//       npc_ruta   = tokse          camina por data/routes/tokse.json (ver actors/npc-route.js)
//     Para hablarle (npc_texto, npc_texto_repetir, npc_pone, npc_dialogo, npc_nombre, npc_hablar_radio, npc_hablar_texto, npc_mirar, npc_anim_hablar) ver src/systems/dialogue.js.
//
// También se pueden definir/ajustar en el JSON de la escena (data/scenes/*.json > "actors"):
//   { "empty": "npc_vecino", "animation": "idle", "scale": 1 }                 ajusta el que viene del .glb
//   { "id": "gato", "model": "gato", "position": [3, 0, 5], "yaw": 90 }        NPC que no está en el .glb
//   (para diálogos también: "dialogue", "text", "speaker", "talkRadius", "talkLabel", "look", "talkAnim")
// (yaw en grados; 0 mira hacia el frente de Blender, -Y).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLB, loadJSON, forgetJSON } from '../core/assets.js';
import { makeUnlit, setShade } from '../systems/shading.js';
import { findClip, pickIdle, describeClips, isOneShot } from './npc-anim.js';
import { createRoute } from './npc-route.js';

const NAME_RE = /^npc_(.+)$/i;
const DIR = 'assets/models/objects/';
const DEG = Math.PI / 180;

const modelPath = (v, id) => {
  const s = String(v ?? '').trim();
  if (!s) return `${DIR}${id}.glb`;
  if (/[\\/]/.test(s)) return s; // ruta completa (assets/models/objects/otro.glb)
  return `${DIR}${s.replace(/\.glb$/i, '')}.glb`; // "personaje" y "personaje.glb" valen lo mismo
};
const flag = (v, d) => (v === undefined || v === '' || v === null ? d : !(v === false || v === 0 || /^(?:0|false|no|off)$/i.test(String(v).trim())));
const humanize = (id) => { const t = String(id).replace(/_+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
// "Hola|¿Cómo andás?" -> ["Hola", "¿Cómo andás?"]; un \n escrito en Blender (barra y n) es un salto de línea
const splitPages = (v) => String(v ?? '').split('|').map((t) => t.replace(/\\n/g, '\n').trim()).filter(Boolean);
const TALK_KEYS = ['speaker', 'text', 'repeatText', 'setFlag', 'dialogue', 'talkRadius', 'talkLabel', 'look', 'talkAnim', 'route'];
const ANIM_FADE = 0.2; // segundos de transición entre animaciones
const TAU = Math.PI * 2;
const num = (v, d) => (v !== undefined && v !== '' && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);

export function createNpcs() {
  let list = [];       // { id, holder, mixer }
  let obstacles = [];  // { x, z, r }: para que el jugador no los atraviese (los NPC que caminan los actualizan)
  let rootRef = null;  // grupo de la escena actual (para buscar los Empties de los recorridos)

  const api = {
    get obstacles() { return obstacles; },
    get list() { return list; },

    // Llamar después de cargar cada escena. Los NPC se agregan dentro del grupo de la escena
    // (se liberan solos al cambiar de escena). Devuelve { count, missing: [archivos que no cargaron] }.
    async setup(sceneRoot, data = {}, shade = {}) {
      list = [];
      obstacles = [];
      rootRef = sceneRoot;
      sceneRoot.updateMatrixWorld(true);

      // 1) Empties npc_* del .glb
      const defs = [];
      sceneRoot.traverse((o) => {
        if (o.isMesh) return;
        const m = NAME_RE.exec(o.name ?? '');
        if (!m) return;
        const u = o.userData ?? {};
        const p = o.getWorldPosition(new THREE.Vector3());
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
        defs.push({
          name: o.name,
          id: m[1].replace(/\d{3}$/, ''), // npc_vecino.001 -> (three lo guarda como npc_vecino001) -> vecino
          model: u.npc_modelo, animation: u.npc_anim, scale: u.npc_escala, radius: u.npc_radio, yawOffset: u.npc_giro,
          speaker: u.npc_nombre, text: u.npc_texto, repeatText: u.npc_texto_repetir, setFlag: u.npc_pone, dialogue: u.npc_dialogo,
          talkRadius: u.npc_hablar_radio, talkLabel: u.npc_hablar_texto, look: u.npc_mirar, talkAnim: u.npc_anim_hablar, route: u.npc_ruta,
          position: p, yaw: Math.atan2(f.x, f.z),
        });
      });

      // 2) Ajustes y NPC extra del JSON
      for (const a of data.actors ?? []) {
        const name = a.empty ?? a.name;
        const found = name && defs.find((d) => d.name === THREE.PropertyBinding.sanitizeNodeName(name));
        if (found) {
          for (const k of ['model', 'animation', 'scale', 'radius', 'yawOffset', ...TALK_KEYS]) if (a[k] !== undefined) found[k] = a[k];
          if (a.id) found.id = a.id;
        } else if (Array.isArray(a.position)) {
          defs.push({
            name: a.id ?? name ?? 'npc', id: a.id ?? (String(name ?? '').replace(/^npc_/i, '') || 'npc'),
            model: a.model, animation: a.animation, scale: a.scale, radius: a.radius, yawOffset: a.yawOffset,
            speaker: a.speaker, text: a.text, repeatText: a.repeatText, setFlag: a.setFlag, dialogue: a.dialogue, talkRadius: a.talkRadius, talkLabel: a.talkLabel, look: a.look, talkAnim: a.talkAnim, route: a.route,
            position: new THREE.Vector3(...a.position), yaw: (a.yaw ?? 0) * DEG,
          });
        } else if (name) {
          console.warn(`actors: "${name}" no está en el .glb ni tiene "position" en el JSON.`);
        }
      }
      const group = new THREE.Group();
      group.name = 'npcs';
      sceneRoot.add(group);

      // Cada modelo se descarga y se prepara una sola vez; los NPC iguales lo clonan
      const templates = new Map();
      const template = (path) => {
        if (!templates.has(path)) {
          templates.set(path, loadGLB(path).then((g) => {
            makeUnlit(g.scene);               // sin luces, como el resto del mundo
            setShade(g.scene, shade);         // mismo tono y brillo que la escena
            return g;
          }).catch((err) => { console.warn(`NPC: ${err.message}`); return null; }));
        }
        return templates.get(path);
      };

      // Tabla opcional por modelo (data/tables/npcs.json): { "tokse": { "idle": "idle" } }. Vale para todos los NPC que usan ese .glb.
      let modelTable = {};
      try { modelTable = await loadJSON('data/tables/npcs.json'); } catch { /* es opcional */ }
      const logged = new Set();

      const missing = new Set();
      for (const d of defs) {
        const path = modelPath(d.model, d.id);
        const g = await template(path);
        if (!g) { missing.add(path); continue; }

        const model = cloneSkinned(g.scene);
        model.scale.setScalar(num(d.scale, 1));
        const holder = new THREE.Group();
        holder.name = `npc:${d.id}`;
        holder.add(model);
        holder.position.copy(d.position);
        holder.rotation.y = d.yaw + num(d.yawOffset, 0) * DEG;
        group.add(holder);

        // Animación idle. Prioridad: lo definido en este NPC (npc_anim / "animation" del JSON)
        // > lo definido para el modelo (data/tables/npcs.json) > detección automática por nombre.
        let mixer = null;
        let idle = null;
        let idleInfo = { clip: null, how: null };
        const modelKey = path.split('/').pop().replace(/\.glb$/i, '').toLowerCase();
        const fromTable = modelTable?.[modelKey]?.idle ?? modelTable?.[d.id]?.idle;
        const tableTalk = String(modelTable?.[modelKey]?.talk ?? modelTable?.[d.id]?.talk ?? '').trim();
        const tableWalk = String(modelTable?.[modelKey]?.walk ?? modelTable?.[d.id]?.walk ?? '').trim();
        const idleSource = d.animation ? 'npc' : fromTable ? 'modelo' : 'auto'; // quién decidió el idle
        if (g.animations.length) {
          mixer = new THREE.AnimationMixer(model);
          idleInfo = pickIdle(g.animations, d.animation || fromTable);
          if (idleInfo.clip) {
            const act = mixer.clipAction(idleInfo.clip);
            act.setLoop(THREE.LoopRepeat, Infinity);
            act.play();
            act.time = Math.random() * idleInfo.clip.duration; // NPC iguales no se mueven al unísono
            idle = act;
          }
        }
        // Un resumen por modelo y por escena en la consola (F12), para ver qué detectó el motor
        if (!logged.has(path)) {
          logged.add(path);
          const info = describeClips(g.animations, idleInfo.clip);
          if (!g.animations.length) console.warn(`NPC "${d.id}": ${path} no trae animaciones (exportá con Animation > Actions).`);
          else if (!idleInfo.clip) console.warn(`NPC "${d.id}": ${idleInfo.reason}. Definí el idle con npc_anim en el Empty o en data/tables/npcs.json. Clips en ${path}:`, info);
          else {
            const how = { definido: 'definido por vos', auto: 'detectado solo', primero: 'adivinado' }[idleInfo.how];
            (idleInfo.reason || idleInfo.how === 'primero' ? console.warn : console.info)(`NPC "${d.id}": idle = "${idleInfo.clip.name}" (${how})${idleInfo.reason ? ` — ${idleInfo.reason}` : ''}. Clips en ${path}:`, info);
          }
        }

        // Datos para hablarle (ver systems/dialogue.js); null = no tiene nada que decir
        const pages = Array.isArray(d.text) ? d.text.map(String) : splitPages(d.text);
        const dialogue = String(d.dialogue ?? '').trim();
        const talk = (dialogue || pages.length) ? {
          speaker: String(d.speaker ?? '').trim() || null,   // el que pusiste vos (npc_nombre)
          defaultSpeaker: humanize(d.id),                    // si no pusiste nombre
          pages, dialogue: dialogue || null,
          repeatPages: Array.isArray(d.repeatText) ? d.repeatText.map(String) : splitPages(d.repeatText), // 2ª vez en adelante
          sets: (Array.isArray(d.setFlag) ? d.setFlag : String(d.setFlag ?? '').split(',')).map((f) => String(f).trim()).filter(Boolean),
          radius: num(d.talkRadius, 2.5),
          label: String(d.talkLabel ?? '').trim() || 'Hablar',
          look: flag(d.look, true),
          talkAnim: String(d.talkAnim ?? '').trim() || tableTalk || null, // animación mientras habla (npc_anim_hablar, o la del modelo en npcs.json)
        } : null;
        const yawOffset = num(d.yawOffset, 0) * DEG;
        const entry = { id: d.id, holder, mixer, talk, yawOffset, baseYaw: holder.rotation.y, targetYaw: holder.rotation.y,
          clips: g.animations, idle, idleName: idleInfo.clip?.name ?? null, idleHow: idleInfo.how, idleSource, modelKey, path, talkOwn: !!String(d.talkAnim ?? '').trim(), current: idle,
          walkName: tableWalk || null, routeName: String(d.route ?? '').trim() || null, route: null, obstacle: null };
        // Un clip "…_vuelve" se reproduce una vez y el NPC vuelve solo a su idle
        mixer?.addEventListener('finished', (e) => { if (e.action === entry.current && entry.current !== entry.idle) api.play(entry, null); });
        list.push(entry);
        entry.obstacle = { x: d.position.x, z: d.position.z, r: num(d.radius, 0.4) };
        obstacles.push(entry.obstacle);
      }
      for (const e of list) if (e.routeName) await api.attachRoute(e); // recorridos (necesitan que todos los NPC existan)
      return { count: list.length, missing: [...missing] };
    },

    // Girar hacia un punto (el jugador, mientras hablan) y volver a la posición original
    faceTowards(n, x, z) { n.targetYaw = Math.atan2(x - n.holder.position.x, z - n.holder.position.z) + n.yawOffset; },
    // Empieza una charla: el NPC que camina se frena (el diálogo lo llama antes de girarlo)
    hold(n) { n.route?.hold(true); },
    // Girar hacia un ángulo (en el eje Y del mundo)
    turnTo(n, yaw) { n.targetYaw = yaw; },
    // Fin de la charla: vuelve a su posición y a su animación de siempre (si camina, sigue su recorrido)
    release(n) {
      api.play(n, null);
      if (n.route) n.route.resume(); else n.targetYaw = n.baseYaw;
    },

    // --- Recorridos (data/routes/<nombre>.json) -----------------------------------------------
    async attachRoute(n) {
      n.route = null;
      if (!n.routeName || !rootRef) return;
      try {
        const data = await loadJSON(`data/routes/${n.routeName.replace(/\.json$/i, '')}.json`);
        n.route = createRoute(n, data, rootRef, api, { name: n.routeName });
      } catch (err) { console.warn(`NPC "${n.id}": no se pudo cargar la ruta "${n.routeName}" (${err.message})`); }
    },
    // El Studio guardó la ruta: se vuelve a leer y los NPC que la usan la empiezan de nuevo desde donde están
    async reloadRoute(name) {
      forgetJSON(`data/routes/${String(name).replace(/\.json$/i, '')}.json`);
      for (const n of list) if (n.routeName === name) { api.play(n, null); await api.attachRoute(n); }
    },

    // Reproduce un clip del .glb del NPC con transición. Sin nombre vuelve al idle.
    // Acepta mayúsculas/minúsculas y que el nombre empiece así. Un clip que termina en "_vuelve" se reproduce una vez.
    // opts.loop = true: repite el clip sin fin aunque termine en "_vuelve" (lo usan las paradas con "loop" de una ruta)
    play(n, name, opts = {}) {
      if (!n.mixer) return;
      const want = String(name ?? '').trim().toLowerCase();
      let next = n.idle;
      if (want) {
        const clip = findClip(n.clips, want);
        if (!clip) {
          const names = n.clips.map((c) => c.name);
          console.warn(`NPC "${n.id}": no hay un clip llamado "${want}". Clips: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}`);
          return;
        }
        next = n.mixer.clipAction(clip);
        const once = isOneShot(clip.name) && !opts.loop;
        next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
        next.clampWhenFinished = false;
      }
      if (!next || (next === n.current && next.isRunning())) return;
      next.reset().setEffectiveWeight(1).fadeIn(ANIM_FADE).play();
      if (n.current && n.current !== next) n.current.fadeOut(ANIM_FADE);
      n.current = next;
    },

    // --- Para el modo studio / inspector -------------------------------------------------------
    // Lista los clips del NPC con lo que detectó el motor: [{ name, duration, kind, once, isIdle }]
    clipsOf(n) { return describeClips(n.clips, n.idle ? n.clips.find((c) => c.name === n.idleName) : null); },

    // Cambia cuál es el idle de este NPC (en vivo). Devuelve false si el clip no existe.
    // Para que quede guardado, escribilo en data/tables/npcs.json (por modelo) o en npc_anim / "animation" (por NPC).
    setIdle(n, name) {
      if (!n.mixer) return false;
      const want = String(name ?? '').trim();
      let clip;
      if (want) {
        clip = findClip(n.clips, want);
        if (!clip) { console.warn(`NPC "${n.id}": no hay un clip llamado "${want}".`); return false; }
      } else {
        clip = pickIdle(n.clips, '').clip;   // vacío = que lo detecte solo otra vez
        if (!clip) return false;
      }
      const act = n.mixer.clipAction(clip);
      act.setLoop(THREE.LoopRepeat, Infinity);
      act.clampWhenFinished = false;
      const wasIdle = !n.current || n.current === n.idle;
      n.idle = act; n.idleName = clip.name; n.idleHow = want ? 'definido' : 'auto';
      if (wasIdle) {
        if (n.current && n.current !== act) n.current.fadeOut(ANIM_FADE);
        act.reset().setEffectiveWeight(1).fadeIn(ANIM_FADE).play();
        n.current = act;
      }
      return true;
    },

    // Lo mismo, para todos los NPC que usan el mismo modelo (clave = nombre del .glb sin extensión).
    // role = 'idle' | 'talk'. Los NPC con su propio npc_anim / npc_anim_hablar no se tocan (esos mandan).
    // name vacío = quitar la definición (idle: vuelve a detectarse solo; talk: no usa animación al hablar).
    setModelRole(modelKey, role, name) {
      let n = 0;
      for (const e of list) {
        if (e.modelKey !== modelKey) continue;
        if (role === 'idle' && e.idleSource !== 'npc') { if (api.setIdle(e, name)) { e.idleSource = String(name ?? '').trim() ? 'modelo' : 'auto'; n++; } }
        if (role === 'talk' && e.talk && !e.talkOwn) { e.talk.talkAnim = String(name ?? '').trim() || null; n++; }
        if (role === 'walk') { e.walkName = String(name ?? '').trim() || null; n++; }
      }
      return n; // a cuántos NPC se les aplicó
    },

    update(dt) {
      for (const n of list) {
        n.route?.update(dt);
        n.mixer?.update(dt);
        const cur = n.holder.rotation.y;
        if (cur === n.targetYaw) continue;
        const diff = ((n.targetYaw - cur + Math.PI) % TAU + TAU) % TAU - Math.PI; // camino corto
        n.holder.rotation.y = Math.abs(diff) < 0.003 ? n.targetYaw : cur + diff * Math.min(1, dt * 10);
      }
    },
  };
  return api;
}
