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
    ├── systems/            cámara, audio, gestor de escenas, inspector (solo dev)
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

## Personaje (jugador)

El jugador se mueve en tercera persona con la cámara siguiéndolo. Código en `src/actors/player.js`; parámetros en `data/tables/player.json`.

- **Controles:** `W A S D` (o flechas) mover relativo a la cámara · `Shift` correr · arrastrar para girar la cámara · rueda para el zoom · `E` interactuar (puertas).
- **Modelo:** exportá el personaje a `assets/models/objects/personaje.glb` (o cambiá `model` en `player.json`). Hasta que exista se ve una cápsula con una "nariz" que marca el frente.
- **Origen y orientación en Blender:** el origen del personaje en los **pies**; el frente hacia **-Y** de Blender (vista frontal, que es lo normal), que en el juego queda como +Z. Si en el juego camina de espaldas, poné `"yawOffset": 180` en `player.json`.
- **Tamaño:** se respeta el de Blender (1 unidad = 1 m). Si hace falta, `scale` en `player.json`.
- **Suelo:** el personaje se pega a la altura de las superficies de la escena (también sirve para escalones y rampas). Todavía **no hay colisiones con paredes**.
- **Animaciones:** quedan para la próxima etapa; las que traiga el `.glb` ya se cargan en `player.animations`.
- **Modo dev:** `dev.html` arranca con la cámara libre; la tecla `C` alterna con el personaje. `index.html` arranca directo con el personaje.

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
