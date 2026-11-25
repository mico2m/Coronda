# IA de Claude (el NPC de la plaza)

Con esto, en el menú de Claude aparece **"Decile algo (escribile)"**: le escribís lo que quieras y contesta una IA. También puede moverse si se lo pedís ("cheee vení a mi casa", "seguime", "andá al cartel", "quedate acá", "volvé a pasear").

Cómo funciona: el juego le manda tu mensaje a un **intermediario** (`worker.js`, corre gratis en Cloudflare), que le pregunta a la IA de Cloudflare (**Workers AI**, gratis hasta 10.000 "neuronas" por día: con mensajes cortos como los de Claude alcanza para unas mil respuestas) y devuelve lo que Claude dice y hace. No hay claves en el juego ni en GitHub.

Si la IA no responde o se acabó el cupo del día, Claude dice *"¡Me abrumaste jajaja! ¿En un rato seguimos, querés?"* y durante 10 minutos ese jugador solo ve sus frases de siempre. El cupo se renueva todos los días a las 21:00 (hora argentina).

## Pasos (una sola vez)

1. **Crear el Worker:** en **dash.cloudflare.com**, **Workers & Pages** → **Create** → **Create Worker** (plantilla "Hello World"). Nombre: `coronda-claude` → **Deploy**.
2. **Conectarle la IA:** en el Worker, **Settings** → **Bindings** → **Add binding** → **Workers AI**. Nombre de la variable: `AI` → **Add Binding**.
3. **Pegar el código:** arriba a la derecha, **Edit code**. Borrá todo (Ctrl+A, Supr), pegá el contenido de `servidor-ia/worker.js` y tocá **Deploy**.
4. **En el juego:** en `data/tables/ia.json`, poné en `"endpoint"` la dirección del Worker (`https://coronda-claude.TU-CUENTA.workers.dev`) y Enviá con el Studio.

Los menús de Cloudflare pueden cambiar un poco de nombre; si algo no aparece igual, buscá algo parecido.

**Más cupo (opcional):** creá una clave gratis en **console.groq.com** (API Keys) y guardala en el Worker como **Secret** llamado `GROQ_API_KEY` (**Settings** → **Variables and Secrets**). Con eso usa Groq en vez de la IA de Cloudflare.

## Ajustes

- **Modelo:** con la IA de Cloudflare usa `@cf/zai-org/glm-4.7-flash` (variable `MODELO_CF` para cambiarlo); con Groq, `llama-3.3-70b-versatile` (variable `MODELO`).
- **Límite:** 6 mensajes por minuto por jugador (`POR_MINUTO` en `worker.js`). La IA además tiene su propio límite diario del plan gratis.
- **Apagarla sin borrar nada:** en `data/tables/ia.json`, `"activa": false`.
- **Personalidad:** está en `PERSONA`, dentro de `worker.js`.
