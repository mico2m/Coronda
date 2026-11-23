# Coronda

Mundo virtual 3D en la web (three.js). El mundo se modela en Blender, se exporta a `.glb` y se carga desde la página.

## Cómo está organizado

Cada tipo de elemento vive en su propia carpeta, al estilo de Ocarina of Time: los **datos** (qué hay en el mundo), los **assets** (modelos, texturas), la **música** y el **código** van por separado.

```
Coronda/
├── index.html              versión final
├── dev.html                modo desarrollador (inspector con mira)
├── css/                    estilos (style.css = común, dev.css = solo modo dev)
├── assets/                 todo lo visual
│   ├── models/worlds/      salas/mundos exportados de Blender (.glb)
│   ├── models/objects/     objetos reutilizables (árboles, cofres, personajes)
│   ├── textures/           texturas sueltas
│   └── skyboxes/           cielos
├── audio/
│   ├── music/              música de cada escena
│   ├── sfx/                efectos de sonido
│   └── ambience/           sonido ambiente (viento, pájaros)
├── data/                   propiedades del mundo (JSON, sin código)
│   ├── tables/
│   │   ├── scenes.json     lista de escenas y cuál arranca
│   │   └── music.json      id de música → archivo
│   └── scenes/             una escena por archivo (ambiente, spawn, salas, música)
└── src/                    código
    ├── main.js             arranque de la versión final
    ├── dev.js              arranque del modo desarrollador
    ├── game.js             motor compartido por los dos
    ├── core/               utilidades base (carga de archivos)
    ├── systems/            cámara, audio, gestor de escenas, colisiones, inspector (solo dev)
    ├── actors/             personajes y objetos con comportamiento (próximamente)
    └── ui/                 interfaz
```

## Qué tomamos de Ocarina of Time

| En Ocarina of Time | Acá |
|---|---|
| Escena = zona grande; sala = parte de la escena | `data/scenes/*.json` con una lista de `rooms` (cada una es un `.glb`) |
| Cabecera de escena: luz, niebla, cielo, música, punto de inicio | bloque `environment`, `music` y `spawn` del JSON de la escena |
| Tablas centrales (escenas, objetos, actores) | `data/tables/` |
| Objects (modelos y animaciones) separados de los Actors (lógica) | `assets/models/objects/` por un lado, `src/actors/` por el otro |
| Secuencias de música y efectos aparte | `audio/music`, `audio/sfx`, `audio/ambience` |

## Agregar una escena nueva

1. Exportá la sala desde Blender a `assets/models/worlds/mi_sala.glb`.
2. Copiá `data/scenes/coronda_plaza.json` a `data/scenes/mi_escena.json` y ajustá `rooms`, `environment`, `music` y `spawn`.
3. Registrala en `data/tables/scenes.json`.
4. Si tiene música nueva, ponela en `audio/music/` y agregala a `data/tables/music.json`.

## Aspecto sin luces, tono y brillo

Como en las consolas de la época, el mundo **no usa luces dinámicas**: cada superficie muestra su textura tal cual (lo que cargues como *Base Color / diffuse* en Blender). El personaje también.

En `environment` de cada escena (`data/scenes/*.json`):
- `"shading": "unlit"` (por defecto) o `"lit"` (usa las luces `ambient` y `sun`, por si alguna vez las querés).
- `"tint": "#ffffff"`: el tono. Se multiplica por el color de todo (ej. `"#ffcc88"` = atardecer cálido, `"#8899dd"` = noche).
- `"brightness": 1`: el brillo (0.5 = a media luz, 1.2 = más claro).
- Para dar sombras o relieve, pintá **colores de vértice** en Blender (se exportan y se respetan), como hacía el juego original en vez de luces.

**Cielo:** nombrá el objeto `cielo_…` o `sky_…` (ej. una esfera con la textura). Siempre acompaña a la cámara, no recibe niebla ni tapa a nada, y se ve desde adentro aunque las normales estén invertidas. También le afectan el tono y el brillo.

## Look retro (320x240 a 20 fps)

`index.html` dibuja el mundo a **320×240** y a un máximo de **20 cuadros por segundo**, y escala la imagen a toda la pantalla con píxeles nítidos (manteniendo la proporción 4:3; en pantallas anchas quedan barras negras a los costados). La lógica del juego también avanza a esos 20 fps. La interfaz (avisos, ayuda) se ve a resolución normal.

- Para cambiarlo, editá la línea `startGame({ retro: { width: 320, height: 240, fps: 20 } })` en `src/main.js`. Con `retro: null` se ve a resolución y fps completos.
- `dev.html` no usa el modo retro, para que el inspector sea cómodo.
- `antialias: true` suaviza los bordes dentro de los 320×240 (con `false` quedan dentados, más crudo).

## Personaje (jugador)

El jugador se mueve en tercera persona con la cámara siguiéndolo. Código en `src/actors/player.js`; parámetros en `data/tables/player.json`.

- **Controles:** `W A S D` (o flechas) mover relativo a la cámara · `Shift` correr · arrastrar para girar la cámara · rueda para el zoom · `E` interactuar (puertas).
- **Modelo:** exportá el personaje a `assets/models/objects/personaje.glb` (o cambiá `model` en `player.json`). Hasta que exista se ve una cápsula con una "nariz" que marca el frente.
- **Origen y orientación en Blender:** el origen del personaje en los **pies**; el frente hacia **-Y** de Blender (vista frontal, que es lo normal), que en el juego queda como +Z. Si en el juego camina de espaldas, poné `"yawOffset": 180` en `player.json`.
- **Tamaño:** se respeta el de Blender (1 unidad = 1 m). Si hace falta, `scale` en `player.json`.
- **Suelo y paredes:** el personaje camina sobre las superficies sólidas (escalones y rampas incluidos), cae si no hay suelo y choca con las paredes. Ver **Colisiones** más abajo.
- **Animaciones:** el juego busca en el `.glb` acciones llamadas **`idle`** (quieto), **`walk`** (caminar) y **`run`** (correr con Shift), sin importar mayúsculas ni sufijos (`walk.001` sirve). Cambia entre ellas con una transición de `fade` segundos. Si falta alguna se avisa en pantalla qué clips trae el archivo; si falta `run` se usa `walk`.
  - Si el modelo trae muchos clips con otros nombres (por ejemplo un personaje descargado), indicá cuál usar en `player.json > animation.clips`: `"walk": "nombre_exacto_del_clip"`. La lista completa de clips sale en la consola del navegador (F12).
  - En Blender: una acción por animación (con el escudo *Fake User* activado), el personaje sin avanzar en el lugar, y al exportar glTF: *Animation > Mode: Actions*.
  - Para que los pies no resbalen, en `player.json > animation` poné `walkAnimSpeed` / `runAnimSpeed` = la velocidad (m/s) a la que está animado cada ciclo. Con 0 no se ajusta.
- **Modo dev:** `dev.html` arranca con la cámara libre; la tecla `C` alterna con el personaje. `index.html` arranca directo con el personaje.

## Colisiones

Qué objetos son sólidos se decide **en Blender**, con propiedades personalizadas (las mismas que usan las puertas). Código: `src/systems/collision.js`.

**En Blender:** seleccioná el objeto > *Object Properties* > *Custom Properties* > **+** y agregá:

| Propiedad | Valor | Qué hace |
|---|---|---|
| `colision` | `1` | Sólido: no se atraviesa y se camina sobre sus superficies |
| `colision` | `0` | Sin colisión: se ve pero se atraviesa (pasto, carteles, humo) |
| `colision_forma` | `caja` | Usa la caja envolvente en vez de la malla exacta (por defecto `malla`). Ideal para objetos complicados o cóncavos |
| `colision_invisible` | `1` | El objeto no se dibuja pero sí colisiona (paredes invisibles) |

Al exportar el `.glb` tildá **Include > Custom Properties** (igual que con las puertas).

- **Herencia:** lo que pongas en un objeto padre (ej. un Empty) lo heredan sus hijos, salvo que el hijo tenga su propio valor.
- **Atajo por nombre:** un objeto llamado `col_algo` o `colision_algo` es sólido e invisible.
- **Sin propiedad:** vale el valor por defecto de la escena, en `data/scenes/<escena>.json`: `"collision": { "default": "solid" }` (todo sólido salvo lo marcado con `0`) o `"none"` (nada sólido salvo lo marcado con `1`). Los objetos `cielo_…` / `sky_…` nunca colisionan.
- **Suelo o pared:** lo decide la pendiente de cada triángulo. Hasta `maxSlope` grados (50 por defecto) es suelo; más empinado es pared; los techos no frenan. Las **normales** tienen que mirar hacia afuera (en Blender: *Overlay > Face Orientation*, todo azul).
- **Escalones:** el personaje sube sin saltar hasta `stepHeight` (0,5 m). Algo más alto es pared.
- **Ajustes del cuerpo** en `data/tables/player.json > collision`: `radius`, `height`, `stepHeight`, `maxSlope`, `gravity`.

**Ver las colisiones:** en `dev.html` la tecla **K** dibuja lo que el juego tomó como colisión (rojo = paredes, verde = suelo), y el inspector (**I**) muestra `Colisión: sí/no` del objeto al que apuntás. En la consola del navegador (F12) aparece un resumen por escena.

Por ahora la cámara en tercera persona no choca con las paredes (atraviesa los muros).

## Acciones interactivas (acostarse, saludar…)

Agregar una acción no requiere tocar el código. En Blender creá la animación (con *Fake User*, en el lugar) y **nombrala `accion_<nombre>`**; al exportar el `.glb` con *Animation > Mode: Actions* el juego la detecta sola, crea un **botón en pantalla** y le asigna una **tecla** (1, 2, 3… en orden alfabético). Moverte la cancela (te levantás).

| Nombre del clip | Comportamiento |
|---|---|
| `accion_acostarse` o `accion_acostarse_quieto` | se reproduce una vez y queda en la última pose hasta que te movés |
| `accion_saludar_vuelve` | se reproduce una vez y vuelve solo a quieto |
| `accion_bailar_loop` | se repite hasta que te movés |

Para cambiar tecla o texto, o para enlazar un clip que ya existe sin renombrarlo, usá `data/tables/player.json > actions`:
```json
"actions": {
  "acostarse": { "key": "KeyL", "label": "Acostarse" },
  "caer": { "clip": "gPlayerAnim_link_normal_back_downA", "label": "Caerse", "hold": true }
}
```
(`loop` y `hold` también se pueden poner ahí.) Si un clip no se encuentra, la consola (F12) avisa. Código: `src/actors/player.js`.

## NPC (personajes con animación)

Un NPC es un modelo `.glb` con su animación, puesto en la escena con un Empty de Blender. Código: `src/actors/npc.js`.

1. Exportá el modelo a `assets/models/objects/vecino.glb` (origen en los pies, frente hacia -Y de Blender) con una animación en bucle, por ejemplo una acción llamada `idle`.
2. En el `.glb` de la escena poné un **Empty llamado `npc_vecino`** en el suelo, donde va a estar. El NPC mira hacia donde apunta la **flecha verde (eje Y)** del Empty, igual que `empty_spawn`. Duplicá el Empty para tener más de uno (`npc_vecino.001` sigue siendo "vecino"; el modelo se descarga una sola vez).
3. Opcional, en *Custom Properties* del Empty (tildá *Include > Custom Properties* al exportar):

| Propiedad | Qué hace |
|---|---|
| `npc_modelo` | otro archivo: `gato` usa `assets/models/objects/gato.glb` (o una ruta completa) |
| `npc_anim` | el clip que reproduce en bucle (por defecto `idle`; acepta que el nombre empiece así) |
| `npc_escala` | tamaño (1 por defecto) |
| `npc_radio` | ancho para que el jugador no lo atraviese, en metros (0,4 por defecto) |
| `npc_giro` | grados extra de giro |

También se puede ajustar o crear desde `data/scenes/<escena>.json > "actors"`:
```json
"actors": [
  { "empty": "npc_vecino", "animation": "idle", "scale": 1 },
  { "id": "gato", "model": "gato", "position": [3, 0, 5], "yaw": 90 }
]
```
La primera línea ajusta un NPC que viene del `.glb`; la segunda crea uno que no está en el `.glb` (`yaw` en grados). Si un clip no existe, la consola (F12) lista los que trae el archivo. Por ahora los NPC están quietos en su lugar y el jugador los rodea; hablarles y que caminen es el paso siguiente.

## Puertas (cambio de escena)

Una puerta es un objeto normal y visible al que le das la propiedad de interactuable. Al acercarte aparece **"E Entrar"**; al apretar **E** (o tocar el aviso en celular) se hace un fundido a negro y se carga la escena destino. El código no oculta ni modifica el objeto.

**En Blender** (forma recomendada): seleccioná el objeto > *Object Properties* > *Custom Properties* y agregá
- `puerta` = `scene_casa1` (id de la escena destino, registrada en `data/tables/scenes.json`)
- opcional: `puerta_radio` = `3` (metros, por defecto 3) y `puerta_texto` = `Entrar`

Al exportar el `.glb` tildá **Include > Custom Properties**. Se puede poner en cualquier objeto (la puerta, un cartel, un empty).

**Por nombre** (atajo): un objeto llamado `puerta_casa1` o `empty_puerta_casa1` lleva a `scene_casa1` (`puerta_X` → `scene_X`). Si existen los dos, cuentan como la misma puerta.

**Ajustes en el JSON** de la escena (pisan lo anterior), útiles para dónde aparecés al llegar:
```json
"doors": [
  { "empty": "puerta_casa1", "spawn": { "position": [0, 1.7, 4], "yaw": 0 } }
]
```
Sin `spawn` se usa el empty de spawn de la escena destino (ver más abajo). `position` sirve si el objeto todavía no está en el `.glb`. La distancia se mide hasta la superficie del objeto. En `dev.html` cada puerta muestra una caja con su zona de activación.

Código: `src/systems/doors.js` y `src/systems/fade.js`.

## Punto de aparición (spawn)

En el `.glb` de cada escena poné un Empty llamado **`empty_spawn`** (el mismo nombre en todas las escenas). Al entrar a la escena, el jugador aparece ahí.

- Poné el empty **en el suelo**: la cámara se ubica 1,7 m más arriba.
- Mira hacia donde apunta la **flecha verde (eje Y)** del empty en Blender. Rotalo sobre Z para girar la vista.
- Opcional: `empty_spawn_casa1` se usa solo cuando llegás **desde** `scene_casa1` (se quita el `scene_` del nombre). Sirve para reaparecer afuera de la puerta correcta. Si no existe, se usa `empty_spawn`.

Orden de prioridad: `spawn` de la puerta en el JSON → `empty_spawn_<origen>` → `empty_spawn` → `spawn` del JSON de la escena (que queda como respaldo si el `.glb` no tiene empty).

## Versión final y modo desarrollador

- `index.html`: la versión final, limpia y sin herramientas.
- `dev.html`: el mismo mundo con un **inspector**. Hay una mira en el centro y, al apuntar a un objeto, muestra su nombre, archivo de origen, tamaño en metros, texturas, triángulos y distancia. Se activa y desactiva con la tecla **I**.

Los dos usan el mismo motor (`src/game.js`). La versión final no descarga el código del inspector.

## Probar en local

Los módulos y los `.glb` no cargan abriendo el `index.html` con doble clic. Usá un servidor local:

```
npx serve
```
o la extensión Live Server de VS Code. Después abrí `/` para la versión final o `/dev.html` para el modo desarrollador.
