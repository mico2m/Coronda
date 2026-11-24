// Detección automática de animaciones de un .glb (sin three.js: solo mira nombres y duraciones).
// Lo usa actors/npc.js, y sirve igual para el modo studio (listar clips, marcar cuál es el idle).
//
// Un "clip" es cualquier objeto { name, duration }, o sea un THREE.AnimationClip tal cual viene del GLTFLoader.

export const stripSuffix = (n) => String(n ?? '').replace(/\.\d+$/, '');   // "idle.001" -> "idle"
const low = (n) => stripSuffix(n).toLowerCase();

// Acciones que Blender crea solas y casi nunca son una animación de verdad: "Action", "PlaneAction", "Armature", "Take 001"…
const JUNK_RE = /^(?:[a-z0-9_]*action|armature|animation|take[ _]?\d*|default|t-?pose)$/;
// Un clip que termina en _vuelve se reproduce una sola vez (ver npc.js): nunca es un buen idle.
export const isOneShot = (name) => /_vuelve$/i.test(stripSuffix(name));

// Busca un clip por nombre: igual (sin mayúsculas) -> igual sin ".001" -> que empiece así.
export function findClip(clips, name) {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) return null;
  return clips.find((c) => c.name.toLowerCase() === want)
    || clips.find((c) => low(c.name) === want)
    || clips.find((c) => c.name.toLowerCase().startsWith(want))
    || null;
}

// Qué parece ser un clip: idle | talk | greet | walk | run | junk | other
export function classifyClip(name) {
  const n = low(name);
  if (JUNK_RE.test(n)) return 'junk';
  if (/idle|espera|quiet[oa]|reposo|respir|breath|nwait|stand|(^|[^a-z])wait/.test(n)) return 'idle';
  if (/talk|habl|charl/.test(n)) return 'talk';
  if (/salud|wave|hello|greet/.test(n)) return 'greet';
  if (/walk|camin/.test(n)) return 'walk';
  if (/run|corr|jog|dash/.test(n)) return 'run';
  return 'other';
}

// Qué tan buen idle parece (0 = no parece uno). Mayor = mejor.
export function idleScore(name) {
  const n = low(name);
  if (JUNK_RE.test(n)) return 0;
  let s = 0;
  if (n === 'idle') s = 100;
  else if (/(^|[^a-z0-9])idle([^a-z0-9]|$)/.test(n)) s = 90;
  else if (/idle/.test(n)) s = 80;
  else if (/espera|quiet[oa]|reposo|respir|breath/.test(n)) s = 70;
  else if (/nwait|stand|(^|[^a-z])wait/.test(n)) s = 60;
  if (!s) return 0;
  if (/walk|run|talk|habl|salud|attack|hit|dead|die|jump|2wait|wait2/.test(n)) s -= 50; // transiciones y otras acciones
  if (isOneShot(name)) s -= 40;
  return Math.max(s, 1);
}

// Elige el idle. `wanted` = lo que definiste a mano (npc_anim, "animation" del JSON, tabla por modelo); si existe, manda.
// Devuelve { clip, how, reason } con how = 'definido' | 'auto' | 'primero' | null
export function pickIdle(clips, wanted) {
  if (!clips.length) return { clip: null, how: null, reason: 'el .glb no trae animaciones' };

  const w = String(wanted ?? '').trim();
  if (w) {
    const clip = findClip(clips, w);
    if (clip) return { clip, how: 'definido' };
    // si el nombre definido no existe, seguimos con la detección automática pero avisamos
    const auto = pickIdle(clips, '');
    return { ...auto, reason: `no existe el clip "${w}"${auto.clip ? `; se usó "${auto.clip.name}"` : ''}` };
  }

  let best = null, bestScore = 0;
  for (const c of clips) {
    const s = idleScore(c.name);
    // empate: gana el nombre más corto (el "idle" simple antes que "idle_mirando_atras"); si siguen empatados, el primero
    if (s > bestScore || (s === bestScore && best && c.name.length < best.name.length)) { best = c; bestScore = s; }
  }
  if (best) return { clip: best, how: 'auto' };

  // Ningún nombre parece idle: si hay un solo clip "de verdad", ese; si no, el primero que no sea basura ni de una sola vez
  const real = clips.filter((c) => classifyClip(c.name) !== 'junk');
  if (real.length === 1) return { clip: real[0], how: 'primero', reason: `ningún clip se llama como un idle; se usó el único que hay ("${real[0].name}")` };
  const first = real.find((c) => !isOneShot(c.name) && !['talk', 'greet', 'walk', 'run'].includes(classifyClip(c.name)));
  if (first) return { clip: first, how: 'primero', reason: `ningún clip se llama como un idle; se usó el primero ("${first.name}")` };
  return { clip: null, how: null, reason: 'ningún clip parece un idle' };
}

// Lista legible de los clips (para la consola o para un panel del studio).
export function describeClips(clips, idleClip = null) {
  return clips.map((c) => ({
    name: c.name,
    duration: Math.round((c.duration ?? 0) * 100) / 100,
    kind: classifyClip(c.name),
    once: isOneShot(c.name),
    isIdle: c === idleClip,
  }));
}
