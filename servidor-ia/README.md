# IA de Claude (el NPC de la plaza)

Con esto, en el menú de Claude aparece **"Decile algo (escribile)"**: le escribís lo que quieras y contesta una IA. También puede moverse si se lo pedís ("cheee vení a mi casa", "seguime", "andá al cartel", "quedate acá", "volvé a pasear").

Cómo funciona: el juego le manda tu mensaje a un **intermediario** (`worker.js`, corre gratis en Cloudflare), que le pregunta a la IA (**Groq**, plan gratis) y devuelve lo que Claude dice y hace. La clave de Groq queda guardada en Cloudflare: **nunca** va en el juego ni en GitHub.

Si la IA no responde o se acabó el cupo gratis, Claude dice *"¡Me abrumaste jajaja! ¿En un rato seguimos, querés?"* y durante 10 minutos ese jugador solo ve sus frases de siempre.

## Pasos (una sola vez)

1. **Clave de Groq**
   - Entrá a **console.groq.com** y creá una cuenta (gratis, sin tarjeta).
   - En **API Keys** tocá **Create API Key** y copiala. Guardala: se ve una sola vez.
2. **Intermediario en Cloudflare**
   - Entrá a **dash.cloudflare.com** y creá una cuenta gratis.
   - Andá a **Workers & Pages** → **Create** → **Create Worker**. Ponele de nombre `coronda-claude` y tocá **Deploy**.
   - Tocá **Edit code**, borrá todo lo que hay, pegá el contenido de `servidor-ia/worker.js` y tocá **Deploy**.
   - En el Worker, andá a **Settings** → **Variables and Secrets** → **Add**: tipo **Secret**, nombre `GROQ_API_KEY`, valor = la clave de Groq. Guardá.
   - (Opcional) Agregá una variable `ORIGENES` con la dirección de tu juego publicado (por ejemplo `https://usuario.github.io`), así solo tu juego lo puede usar.
   - Copiá la dirección del Worker (algo como `https://coronda-claude.tu-cuenta.workers.dev`).
3. **En el juego**
   - Abrí `data/tables/ia.json` y pegá esa dirección en `"endpoint"`. Enviá con el Studio.

Los nombres de los menús de Cloudflare y Groq pueden cambiar un poco; si algo no aparece igual, buscá algo parecido.

## Ajustes

- **Modelo:** por defecto usa `llama-3.3-70b-versatile`. Si Groq lo da de baja, en el Worker agregá una variable `MODELO` con otro de la lista de modelos de Groq que soporte *tool use*.
- **Límite:** 6 mensajes por minuto por jugador (`POR_MINUTO` en `worker.js`). Groq además tiene su propio límite diario del plan gratis.
- **Apagarla sin borrar nada:** en `data/tables/ia.json`, `"activa": false`.
- **Personalidad:** está en `PERSONA`, dentro de `worker.js`.
