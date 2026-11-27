# Servidor de Coronda

El servidor corre en tu PC y es la **única autoridad** del mundo: cuentas, mochilas, lotes, casas, cofres, pedidos de la
Carpintería, árboles, niveles, energía, hora del mundo y chat. Los navegadores solo muestran lo que él dice: cambiar
valores en F12 → Aplicación no sirve para nada (el navegador solo guarda el token de la sesión y preferencias de pantalla).

## Arrancar y apagar

**Lo más fácil:** doble clic en **`Iniciar servidor y enlace.bat`**. Prende el servidor, abre el túnel de Cloudflare, espera
a que el enlace ande, te lo abre en el navegador y lo copia (Ctrl+V para pasárselo a tus amigos; también queda en
`servidor/enlace-actual.txt`). Quedan dos ventanas abiertas: *Servidor de Coronda* y *Túnel de Coronda*; para apagar, cerralas.
**`Abrir Studio.bat`** abre el Studio y, si el servidor no está prendido, lo prende también (para la vista previa de `index.html`).

A mano:

- **Arrancar:** doble clic en `Servidor.bat` (en la carpeta de Coronda). Necesita [Node.js](https://nodejs.org) LTS (el mismo del Studio).
  O en una terminal: `node servidor/coronda-server.mjs`.
- **Jugar vos:** abrí `http://localhost:8080`.
- **Apagar:** cerrá la ventana o `Ctrl+C`. Guarda todo antes de salir. Mientras está apagado, el juego dice *"El servidor está apagado"*.

## Configuración: `servidor/config.json`

| campo | qué hace |
|---|---|
| `puerto` | dónde escucha (8080). El túnel apunta acá. |
| `admins` | nombres de las cuentas que pueden usar los comandos de admin (`/time set 19`, `/anuncio`, `/madera Nombre 20`, `/resistencia Nombre`, `/expulsar Nombre`, `/borrarpedido id`, `/lotes`, `/lote eliminar N`, `/claude reiniciar`). **Creá tu cuenta primero** (en `http://localhost:8080`, antes de abrir el túnel) y después poné tu nombre acá y reiniciá el servidor. |
| `registro_abierto` | `false` = nadie más puede crear cuentas. |
| `max_jugadores` | cuántos pueden estar adentro a la vez. |
| `escena_claude` | escena donde vive el NPC Claude. |

## Dónde se guardan los datos

`servidor/datos/` (no se sube a GitHub, ver `servidor/.gitignore`):

- `mundo.json`: todo el mundo. Se guarda de forma segura (archivo temporal + renombrar) al segundo de cada cambio y al apagar.
- `copias/`: una copia por hora (las últimas 48). Para volver atrás: apagá el servidor y copiá una sobre `mundo.json`.
- `fotos/`: fotos de perfil (128 × 128, comprimidas).

Las contraseñas se guardan con *scrypt* (nunca en texto). Hacé copias de `servidor/datos/` de vez en cuando (un pendrive, la nube).

## Que entren tus amigos desde sus casas: Cloudflare Tunnel (recomendado)

Así no abrís puertos en el router ni mostrás tu IP, y la dirección es `https://` (necesario para el micrófono del chat de voz).

1. Bajá `cloudflared` para Windows: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/> (es un solo `.exe`).
2. **Rápido, sin cuenta:** con el servidor prendido, en otra terminal:
   ```
   cloudflared tunnel --url http://localhost:8080
   ```
   Te da una dirección tipo `https://algo-al-azar.trycloudflare.com`. Pasásela a tus amigos. **Cambia cada vez** que lo arrancás.
3. **Dirección fija (si tenés un dominio en Cloudflare):**
   ```
   cloudflared tunnel login
   cloudflared tunnel create coronda
   cloudflared tunnel route dns coronda coronda.tudominio.com
   cloudflared tunnel run --url http://localhost:8080 coronda
   ```
   Si además querés que la versión publicada (GitHub Pages / Netlify) se conecte a tu PC, poné esa dirección en
   `data/tables/servidor.json`: `{ "url": "https://coronda.tudominio.com" }`.

Sin túnel, en tu misma red WiFi: `http://IP-de-tu-PC:8080` (ej. `http://192.168.0.10:8080`; Windows te va a preguntar si dejás pasar a Node por el firewall: "Redes privadas").

### Alternativa: abrir el puerto en el router

Redirigí el puerto TCP 8080 a tu PC y compartí `http://TU-IP-PUBLICA:8080`. No lo recomiendo: tu IP queda a la vista, la IP de tu casa suele cambiar, y sin `https` el navegador no deja usar el micrófono.

## Seguridad

- Solo se sirve lo público: `index.html`, `assets/`, `audio/`, `css/`, `data/`, `src/`. Nunca `servidor/` (cuentas), `.git`, `blender/`, `studio/`.
  `dev.html` solo se abre desde tu propia PC.
- Cada operación se valida en el servidor (dueño, cantidades, madera, distancia de tiempo entre hachazos, límites de pedidos, lugar en el cofre…).
  Los intercambios se hacen de una sola vez (o todo o nada) y se vuelven a comprobar al confirmar.
- Límites: 8 intentos de contraseña por minuto por dirección, 60 mensajes por segundo por conexión, chat cada 0,6 s, firmas cada 15 s.
- Si alguien entra con tu cuenta desde otro lugar, la sesión vieja se cierra (nunca hay dos a la vez).
- Mantené Windows y Node actualizados. Si sospechás de alguien: `/expulsar Nombre` y `registro_abierto: false`.

## Pruebas

`node servidor/pruebas/prueba-multijugador.mjs` levanta un servidor de prueba (con datos aparte) y conecta varios
jugadores a la vez: cuentas y nombres, hora, bosque, pedidos, entregas que caducan, intercambios, casas, cofres,
reconexión y que todo quede guardado al reiniciar. No toca tu `servidor/datos/`.
