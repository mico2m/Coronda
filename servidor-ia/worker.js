// Intermediario de la IA de Claude (el NPC de Coronda). Corre gratis en Cloudflare Workers.
// El juego le manda lo que escribió el jugador; este Worker le pregunta a la IA (Groq, plan gratis) y devuelve
//   { "decir": "texto de Claude", "acciones": [ { "tipo": "seguir", "jugador": "Ana" }, … ] }
// La clave de Groq queda guardada acá como secreto (GROQ_API_KEY): nunca está en el juego ni en GitHub.
// Variables opcionales: MODELO (por defecto llama-3.3-70b-versatile), ORIGENES (direcciones del juego, separadas por coma).
// Pasos para publicarlo: ver servidor-ia/README.md.

const MODELO = 'llama-3.3-70b-versatile';
const POR_MINUTO = 6;            // preguntas por minuto por jugador (para no gastar el cupo gratis)
const recientes = new Map();     // ip -> [horas]

const PERSONA = `Sos Claude, un NPC de Coronda, un juego 3D de una plaza argentina (inspirada en Coronda, Santa Fe, la ciudad de las frutillas).
Sos un muñequito naranja con cara crema y una chispa amarilla en la cabeza. Sos una inteligencia artificial que se mudó a la plaza.
Hablás en castellano rioplatense (vos, che), con buena onda, corto: una o dos oraciones, como en un juego. Sin emojis.
Nunca pidas ni repitas datos personales (dirección real, teléfono, contraseñas). No hablás de política ni de temas para adultos: cambiás de tema con humor.
Si te piden algo que no podés hacer, decilo con gracia.
Podés moverte por la plaza con estas acciones: seguir (a un jugador), ir_a_casa (de un jugador que tenga casa), ir_a (un lugar de la lista), quedarse (quieto donde estás), volver (a tu recorrido de siempre), animar (clip "talk" para gesticular).
Usá acciones solo si el jugador te pide moverte o tiene sentido. "Vení", "seguime", "acompañame" = seguir a ese jugador. "Vení a mi casa" = ir_a_casa del jugador que habla.
Para "jugador" usá el nombre exacto de la lista, o "yo" si es el que te habla. Para "lugar" usá un id de la lista de lugares.
Siempre respondés llamando a la función responder.`;

const HERRAMIENTA = {
  type: 'function',
  function: {
    name: 'responder',
    description: 'Lo que Claude dice y hace.',
    parameters: {
      type: 'object',
      properties: {
        decir: { type: 'string', description: 'Lo que Claude contesta, corto (máximo dos oraciones).' },
        acciones: {
          type: 'array',
          description: 'Acciones para el NPC (puede estar vacío).',
          items: {
            type: 'object',
            properties: {
              tipo: { type: 'string', enum: ['seguir', 'ir_a_casa', 'ir_a', 'quedarse', 'volver', 'animar'] },
              jugador: { type: 'string' },
              lugar: { type: 'string' },
              clip: { type: 'string' },
            },
            required: ['tipo'],
          },
        },
      },
      required: ['decir'],
    },
  },
};

function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const ok = !env.ORIGENES || env.ORIGENES.split(',').map((s) => s.trim()).includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: h });
    if (req.method !== 'POST') return json({ error: 'usar POST' }, 405, h);
    if (!env.GROQ_API_KEY) return json({ error: 'falta la clave GROQ_API_KEY' }, 500, h);

    // Límite por jugador (aproximado: por IP)
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const now = Date.now();
    const list = (recientes.get(ip) || []).filter((t) => now - t < 60000);
    if (list.length >= POR_MINUTO) return json({ error: 'limite' }, 429, h);
    list.push(now); recientes.set(ip, list);
    if (recientes.size > 5000) recientes.clear();

    let body;
    try { body = await req.json(); } catch { return json({ error: 'json' }, 400, h); }
    const texto = String(body?.texto ?? '').slice(0, 200).trim();
    if (!texto) return json({ error: 'vacío' }, 400, h);
    const jugador = String(body?.jugador ?? 'Jugador').slice(0, 20);
    const mundo = body?.mundo ?? {};
    const contexto = `Te habla: ${jugador}.
Jugadores en la plaza: ${(mundo.jugadores_en_la_plaza ?? []).slice(0, 12).join(', ') || 'solo él'}.
Casas (lote y dueño): ${(mundo.casas ?? []).slice(0, 30).map((c) => `${c.lote}: ${c.dueno}`).join('; ') || 'ninguna'}.
Lugares (id: nombre): ${(mundo.lugares ?? []).slice(0, 20).map((l) => `${l.id}: ${l.nombre}`).join('; ')}.
Ahora estás: ${mundo.modo_actual ?? 'paseando'}.`;
    const mensajes = [
      { role: 'system', content: PERSONA },
      { role: 'system', content: contexto },
      ...(Array.isArray(body?.historial) ? body.historial.slice(-6) : []).map((m) => ({
        role: m?.de === 'Claude' ? 'assistant' : 'user', content: String(m?.texto ?? '').slice(0, 400),
      })),
      { role: 'user', content: texto },
    ];

    let r;
    try {
      r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.MODELO || MODELO, messages: mensajes, temperature: 0.8, max_tokens: 300,
          tools: [HERRAMIENTA], tool_choice: { type: 'function', function: { name: 'responder' } },
        }),
      });
    } catch { return json({ error: 'sin conexión con la IA' }, 502, h); }
    if (r.status === 429) return json({ error: 'limite' }, 429, h);
    if (!r.ok) return json({ error: `IA ${r.status}` }, 502, h);
    const data = await r.json();
    const msg = data?.choices?.[0]?.message;
    let out = null;
    try { out = JSON.parse(msg?.tool_calls?.[0]?.function?.arguments ?? 'null'); } catch { out = null; }
    if (!out?.decir && msg?.content) out = { decir: String(msg.content), acciones: [] };
    if (!out?.decir) return json({ error: 'respuesta vacía' }, 502, h);
    const acciones = (Array.isArray(out.acciones) ? out.acciones : []).slice(0, 4)
      .filter((a) => ['seguir', 'ir_a_casa', 'ir_a', 'quedarse', 'volver', 'animar'].includes(a?.tipo))
      .map((a) => ({ tipo: a.tipo, jugador: a.jugador ? String(a.jugador).slice(0, 20) : undefined, lugar: a.lugar ? String(a.lugar).slice(0, 30) : undefined, clip: a.clip ? String(a.clip).slice(0, 20) : undefined }));
    return json({ decir: String(out.decir).slice(0, 400), acciones }, 200, h);
  },
};
