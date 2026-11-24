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
│   ├── scenes/             una escena por archivo (ambiente, spawn, salas, música)
│   └── dialogues/          conversaciones con opciones de los NPC (un JSON por NPC)
└── src/                    código
    ├── main.js             arranque de la versión final
    ├── dev.js              arranque del modo desarrollador
    ├── game.js             motor compartido por los dos
    ├── core/               utilidades base (carga de archivos)
    ├── systems/            cámara, audio, gestor de escenas, colisiones, puertas, diálogos, inspector (solo dev)
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

## Objetos reutilizables (prefabs)

Un objeto que se modela **una sola vez** en su propio archivo y se usa en todas las escenas que quieras (puertas, cofres, faroles, árboles…). Código: `src/systems/scene-manager.js`.

1. Modelalo (y animalo, si hace falta) en un `.blend` propio y exportalo a `assets/models/objects/<nombre>.glb`, con **Custom Properties** y **Animation** tildados. El origen del archivo es el punto que se apoya en la escena (por ejemplo, el piso en el centro de la puerta).
2. En la escena, poné un **Empty** (*Display As: Plain Axes* o *Arrows*, **escala 1**) donde va el objeto y agregale la Custom Property **`objeto` = `<nombre>`** (ej. `puerta_casa`). El juego carga el archivo y pone una copia ahí, con la posición y el giro del Empty.

- **Lo que va adentro del archivo** viaja con él: su animación, sus colisiones (`col_…`), sus propiedades fijas.
- **Lo que cambia en cada escena va en el Empty.** Por ejemplo, una puerta reutilizable: Empty con `objeto = puerta_casa` + `puerta = scene_casa1`. La animación de abrir que trae `puerta_casa.glb` se reproduce sola al apretar E, y cada copia se abre por separado.
- Si escalás el Empty, el objeto también se escala.
- **Dónde se para Link para abrir una puerta:** dentro de la puerta (en `puerta_casa.blend`), un Empty **`pos_jugador`** en el piso, justo donde estaban los pies de Link cuando animaste los dos juntos, con la **flecha verde** hacia donde mira Link. Al apretar E, Link se desliza ahí, gira, y recién entonces arrancan su animación y la de la puerta, a la vez. Para abrirla desde los dos lados: `pos_jugador_1` y `pos_jugador_2` (usa el más cercano). Sin `pos_jugador`, la abre desde donde esté, girando hacia la puerta.
- **Origen del archivo vs. origen de la puerta:** el objeto se coloca en la escena desde el **0,0,0 del mundo** de su `.blend` (ponelo en el piso, en el centro de la puerta), no desde el origen del objeto. La hoja de la puerta puede tener su origen en la bisagra para girar bien.
- **Para verlo en Blender mientras lo ubicás** (recomendado): guardá la puerta en una colección (ej. `puerta_casa`) de su `.blend`. En la escena, *File > Link* > ese `.blend` > *Collection* > `puerta_casa`, y después *Add > Collection Instance > puerta_casa*. Esa instancia es un Empty que **muestra** la puerta: movela, girala y ponele ahí las Custom Properties (`objeto`, `puerta`). Si cambiás el `.blend` de la puerta, se actualiza en todas las escenas. Si al exportar Blender mete una copia de la puerta adentro del Empty, el juego la reemplaza por la de `puerta_casa.glb`, así no queda duplicada.

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
- **Malla de colisión aparte (como en Ocarina):** para objetos muy detallados, modelá al lado una versión simple (cajas, pocos polígonos) y llamala `col_<nombre>`. El objeto detallado **deja de colisionar solo** si:
  - se llama igual sin el prefijo: `casa` + `col_casa` (o varias piezas `col_casa_1`, `col_casa_2`…), o
  - la malla `col_…` es **hija** del objeto detallado en Blender (*Ctrl+P > Object*).
  Si al detallado le pusiste `colision` a mano, se respeta lo que pusiste. En la consola, `replaced` dice cuántos objetos quedaron reemplazados.
- **Empties como colisión:** un Empty **sin hijos** llamado `col_…` es un bloque sólido e invisible, sin modelar nada.
  - **Caja:** en Blender, *Object Data > Display As: Cube* con *Size = 1*. El tamaño y el giro se los das con Escala (S) y Rotación (R): lo que ves en Blender es lo que choca. Ideal para paredes invisibles, límites del mapa, bloques de escaleras.
  - **Cilindro:** agregale la Custom Property `colision_forma = cilindro` (de guía, *Display As: Circle*, *Size = 1*). Radio = escala X, alto = escala Z (el centro del Empty queda a mitad de altura). Ideal para postes, troncos, columnas.
  - Su parte de arriba es suelo (se puede caminar encima). También cuenta para reemplazar al detallado: un Empty `col_arbol` hace que `arbol` deje de colisionar. En la consola, `empties` dice cuántos encontró.
- **Sin propiedad:** vale el valor por defecto de la escena, en `data/scenes/<escena>.json`. **Por defecto es `"none"`: las mallas que se ven no chocan**, la colisión la hacen solo los `col_…` (mallas o Empties) y lo que tenga `colision = 1`, como en Ocarina. Con `"collision": { "default": "solid" }` todo choca salvo lo marcado con `0`. Los objetos `cielo_…` / `sky_…` nunca colisionan.
- **El suelo también necesita su colisión:** un Empty `col_suelo` (*Display As: Cube*, Size 1) estirado con la escala y con la cara de arriba a la altura del piso, o ponerle `colision = 1` al plano del suelo. Sin suelo el personaje no sube ni baja y los NPC no encuentran camino (la consola avisa).
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
2. En el `.glb` de la escena poné un **Empty llamado `npc_vecino`** en el suelo, donde va a estar. El NPC mira hacia donde apunta la **flecha verde (eje Y)** del Empty, igual que los spawns. Duplicá el Empty para tener más de uno (`npc_vecino.001` sigue siendo "vecino"; el modelo se descarga una sola vez).
3. Opcional, en *Custom Properties* del Empty (tildá *Include > Custom Properties* al exportar):

| Propiedad | Qué hace |
|---|---|
| `npc_modelo` | otro archivo: `gato` usa `assets/models/objects/gato.glb` (o una ruta completa) |
| `npc_anim` | qué clip es el idle. Si no lo ponés, el motor lo **detecta solo** (ver **Animación idle del NPC**) |
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
La primera línea ajusta un NPC que viene del `.glb`; la segunda crea uno que no está en el `.glb` (`yaw` en grados). Si un clip no existe, la consola (F12) lista los que trae el archivo. Los NPC están quietos en su lugar y el jugador los rodea. Para hablarles, ver **Diálogos con NPC** (abajo); que caminen es un paso que viene después.

### Animación idle del NPC (detección automática)

El motor lee los clips del `.glb` del NPC y elige el idle solo (`src/actors/npc-anim.js`). Orden de prioridad:

1. **Definido en el NPC:** `npc_anim` en el Empty, o `"animation"` en `data/scenes/<escena>.json > actors`.
2. **Definido por modelo:** `data/tables/npcs.json`, por ejemplo `{ "npc_tokse": { "idle": "idle" } }` (clave = nombre del `.glb` sin extensión; vale para todos los NPC con ese modelo).
3. **Automático:** puntúa los nombres (`idle` > `idle_algo` > `espera`/`reposo`/`respirar` > `wait`/`stand`), descarta transiciones (`walk2wait`), clips de una sola vez (`_vuelve`) y los que Blender crea solos (`Action`, `PlaneAction`…). Si no hay ninguno que parezca idle pero hay un único clip real, usa ese.

Si lo que definiste no existe, usa el automático y avisa. Si no encuentra nada, el NPC queda sin animación y la consola (F12) muestra la lista de clips con su tipo (`idle`, `talk`, `greet`, `walk`, `run`, `junk`, `other`). Para el studio: `npcs.clipsOf(npc)` devuelve esa lista y `npcs.setIdle(npc, "clip")` cambia el idle en vivo.

### Panel de NPC (modo desarrollador)

En `dev.html`, el botón **NPC** (arriba a la izquierda, debajo de *Diálogos*) abre un panel para hacer lo mismo sin tocar archivos:

- Elegí un NPC de la lista (**Ir** lleva la cámara libre frente a él, **↻** actualiza la lista después de cambiar de escena).
- Se ven todos los clips de su `.glb` con el tipo que detectó el motor y su duración. **▶** lo prueba en el NPC (**■** para volver), **★** lo marca como idle y **💬** como la animación al hablar. Un clic más en ★ / 💬 lo quita (el idle vuelve a detectarse solo).
- Los cambios se aplican en vivo a todos los NPC que usan ese modelo. Los que tienen `npc_anim` / `npc_anim_hablar` propios (en Blender o en el JSON de la escena) no se tocan: esos mandan.
- **Guardar** (o `Ctrl+S`) escribe `data/tables/npcs.json`. En Chrome/Edge, **Carpeta** te deja elegir `data/tables` y guarda directo; en otros navegadores descarga el archivo para copiarlo.

`data/tables/npcs.json` guarda por modelo `{ "tokse": { "idle": "idle", "talk": "saludar" } }`. Código: `src/systems/npc-editor.js`.

## Diálogos con NPC

**Editor de diálogos con nodos:** con `node studio/server.js` corriendo, abrí **http://localhost:5173/__dialogos**. A la izquierda los diálogos; al medio los nodos (textos, opciones, condiciones, qué variables cambia cada nodo, animaciones del NPC); **Probar** reproduce la charla ahí mismo (como primera vez o como si ya hablaste, cambiando las variables a mano) y **Variables** lista cada flag, quién lo cambia y quién lo mira. `Ctrl+S` guarda en `data/dialogues/<id>.json`. Código: `studio/dialogos/`. Los recorridos siguen en el Studio clásico (`/__studio`).

Se arma igual que las puertas y las colisiones: con **propiedades personalizadas en Blender**, en el mismo Empty `npc_…` del NPC. Al acercarte (2,5 m por defecto) aparece **"E Hablar"**; al apretar **E** (o tocar el aviso) se abre la caja de texto abajo y el NPC se da vuelta hacia vos. Mientras hablás el personaje no se mueve y las puertas esperan. Código: `src/systems/dialogue.js`.

**La caja de texto es parte de la imagen del juego**, como en Ocarina: se dibuja a la misma resolución (320×240), con letra de píxeles, y se escala y recorta junto con el mundo. Código: `src/ui/textbox.js` (dibujo) y `src/ui/pixel-font.js` (la fuente, Spleen 6×12 con acentos, ñ, ¿ y ¡).
- Los renglones se cortan solos según el ancho de la caja, y si un texto no entra en **4 renglones** sigue en otra caja (no hace falta partirlo a mano). La última caja deja lugar a las opciones.
- Las opciones no aparecen de golpe: después de la pregunta hay una pausita y se escriben letra por letra; recién ahí aparece la flechita para elegir (`E` las completa al instante). La pausa se cambia en `CHOICE_PAUSE`, arriba de `src/systems/dialogue.js`.
- La caja mide lo mismo en proporción a la pantalla aunque el juego corra a otra resolución (ej. 800×600): se dibuja como si la pantalla tuviera 240 de alto. Para agrandarla o achicarla, cambiá `baseHeight` en `STYLE` (menos = más grande).
- El nombre del que habla va en una pestañita arriba; las opciones en verde con una flechita ▶; abajo a la derecha, **▼** = sigue y **■** = termina.
- La caja mide siempre lo mismo (4 renglones); si el texto es corto queda **centrado en el medio**, como en Ocarina.
- Colores, tamaño, renglones por caja y márgenes, y la alineación (`valign`: `center`/`top`; `align`: `left`/`center`) se cambian en `STYLE`, arriba de `src/ui/textbox.js`.
- Las comillas tipográficas, `…` y `—` se cambian solas por `"`, `...` y `-` (la fuente no las tiene).

**En Blender:** seleccioná el Empty del NPC (ej. `npc_prueba`) > *Object Properties* > *Custom Properties* > **+** y agregá lo que necesites. Al exportar el `.glb` tildá **Include > Custom Properties** (como siempre).

| Propiedad | Ejemplo | Qué hace |
|---|---|---|
| `npc_texto` | `Hola, vecino.\|¿Cómo andás?` | Frases sueltas. Cada `\|` es una página nueva; un `\n` es un salto de línea. Es lo más rápido para un NPC que solo habla |
| `npc_dialogo` | `tokse` | Conversación con opciones: usa `data/dialogues/tokse.json` (formato abajo) |
| `npc_nombre` | `Don Tokse` | Nombre que se ve arriba de la caja. Si falta: el del archivo de diálogo o el del Empty (`npc_prueba` → "Prueba") |
| `npc_hablar_radio` | `3` | Metros a los que aparece el aviso (2,5 por defecto) |
| `npc_hablar_texto` | `Charlar` | Lo que dice el aviso (por defecto "Hablar") |
| `npc_mirar` | `0` | `0` = el NPC no se da vuelta hacia vos (por defecto sí) |
| `npc_anim_hablar` | `hablar` | Animación del NPC mientras dura la charla (ver **Animaciones del NPC al hablar**) |

Si tiene `npc_texto` y `npc_dialogo`, manda `npc_dialogo`; si ese archivo no se puede leer, se usa `npc_texto` y la consola (F12) avisa. Un NPC sin ninguna de las dos no tiene aviso y se comporta como antes.

**Controles:** `E` / `Espacio` / `Enter` o tocar la pantalla: avanzar (si el texto se está escribiendo, lo completa) · `1`–`9` o click/toque: elegir una opción · `↑` `↓` (o `W` `S`) y `E`: elegir con teclado · `Esc`: cerrar. Con "reducir movimiento" activado en el sistema, el texto aparece de una vez.

### Conversaciones con opciones (`data/dialogues/<id>.json`)

Es un conjunto de **nodos**; cada nodo es lo que dice el NPC y a dónde va después:

```json
{
  "speaker": "Tokse",
  "start": "inicio",
  "nodes": {
    "inicio": { "text": ["¡Hola!", "¿Primera vez por acá?"], "next": "menu" },
    "menu": {
      "text": "¿Necesitás algo?",
      "choices": [
        { "text": "¿Qué hay para hacer?", "next": "que_hacer" },
        { "text": "Nada, gracias.", "next": "chau" }
      ]
    },
    "que_hacer": { "text": "Caminá y mirá todo.", "next": "menu" },
    "chau": { "text": "¡Nos vemos!" }
  }
}
```

- `text`: un texto, o una lista (cada elemento es una página).
- `choices`: opciones que aparecen al terminar de leer. Una opción sin `next` cierra la charla.
- `next`: nodo al que sigue al terminar de leer. Sin `next` ni `choices`, la charla termina.
- `speaker`: nombre del que habla (arriba del archivo para todos los nodos, o en un nodo para ese solo).
- `anim`: clip del NPC que se reproduce al llegar a ese nodo (ver abajo).
- `start`: nodo inicial (por defecto, el primero).
- Hay un ejemplo en `data/dialogues/tokse.json`.

También se puede definir desde `data/scenes/<escena>.json > "actors"` (pisa lo que venga de Blender): `"dialogue"`, `"text"` (texto o lista), `"speaker"`, `"talkRadius"`, `"talkLabel"`, `"look"`, `"talkAnim"`:
```json
"actors": [ { "empty": "npc_prueba", "dialogue": "tokse", "speaker": "Tokse" } ]
```

Si el NPC y una puerta están cerca a la vez, gana el NPC; al alejarte vuelve el aviso de la puerta.

### Animaciones del NPC al hablar

Cualquier animación que ya esté dentro del `.glb` del NPC se puede usar, sin tocar código. Lo mismo que con el jugador: una acción por animación en Blender (con *Fake User*) y al exportar *Animation > Mode: Actions*. El nombre se escribe como se llama el clip (sin importar mayúsculas; sirve que empiece igual, `hablar` encuentra `hablar.001`).

- **Durante toda la charla:** propiedad `npc_anim_hablar` = `hablar` en el Empty. Al abrir el diálogo el NPC pasa de su `npc_anim` (idle) a ese clip, en bucle, con transición. Al cerrar la charla (o con `Esc`) vuelve al idle.
- **En una frase puntual, desde Blender:** escribí el clip entre llaves dentro de `npc_texto`, pegado a la frase donde querés que ocurra. Las llaves no se ven en pantalla y `{}` vuelve al idle:
  `¡Hola!{saludar_vuelve}|¿Cómo andás?|Bueno, chau.{}`
  (en la primera página saluda una vez; la segunda sigue en idle; la tercera vuelve a idle). Una marca vale desde esa página hasta que otra la cambie.
- **En un momento puntual, desde el JSON:** `"anim"` en un nodo del JSON de diálogo. Se reproduce al llegar a ese nodo y sigue hasta que otro nodo la cambie. `"anim": ""` vuelve al idle.
  ```json
  "inicio": { "text": "¡Hola!", "anim": "saludar_vuelve", "next": "menu" },
  "menu":   { "text": "¿Necesitás algo?", "anim": "", "choices": [ ... ] }
  ```
- **Una sola vez:** si el nombre del clip termina en `_vuelve` (como `saludar_vuelve`), se reproduce una vez y el NPC regresa solo al idle. Sin ese sufijo, el clip se repite.
- Las llaves `{clip}` también funcionan dentro de los textos de un JSON de diálogo.
Si el clip no existe, la consola (F12) lista los que trae el archivo y el NPC sigue como estaba.

## Objetos que siguen al jugador

Un objeto que gira para mirarte: un cartel, la cabeza de una estatua, un girasol o una torreta. Se configura **en Blender** con propiedades personalizadas, en el objeto (o en el Empty de un `objeto`, y entonces gira la copia entera). Código: `src/systems/followers.js`.

**En Blender**: seleccioná el objeto > *Object Properties* > *Custom Properties* y agregá

| Propiedad | Valor | Por defecto |
|---|---|---|
| `seguir` | eje local sobre el que gira: `x`, `y` o `z`. Con dos o tres (`xz`, `todos`) te apunta de lleno, sin ladearse | `1` = `z` (gira de costado) |
| `seguir_frente` | lado del objeto que te mira: `x`, `-x`, `y`, `-y`, `z`, `-z` | `-y` (el frente de Blender, vista *Front*) |
| `seguir_velocidad` | `0` = al instante; más alto = más rápido (3 a 8 queda suave) | `0` |
| `seguir_distancia` | metros: solo te sigue si estás más cerca; si te alejás vuelve a como estaba | `0` = siempre |
| `seguir_giro` | grados extra, por si el modelo quedó torcido | `0` |

Los ejes son los **locales del objeto, como los ves en Blender**: el juego los convierte solo. Si el objeto está rotado, gira sobre su propio eje (por ejemplo, un cartel inclinado gira sobre su eje inclinado).

Ejemplos:
- Cartel que siempre te da la cara: `seguir` = `z`.
- Cabeza que te mira, también hacia arriba y hacia abajo: `seguir` = `todos`, `seguir_velocidad` = `5`, `seguir_distancia` = `8`.
- Rueda o tapa que se inclina hacia vos: `seguir` = `x`.

En modo libre (`C` en `dev.html`) siguen a la cámara. Las colisiones del objeto no giran con él.

Al exportar el `.glb` tildá **Include > Custom Properties**.

## Puertas y teleports

Un objeto normal y visible (o un Empty) que te lleva a otro punto: de la **misma escena** o de **otra escena** (otro `.glb`). Siempre con fundido a negro. El código no oculta ni modifica el objeto.

Hay dos modos:
- **`auto`**: se activa solo al entrar en la zona, sin apretar nada (una baldosa, un portal, el borde de un camino).
- **`E`**: al acercarte aparece **"E Entrar"** y viajás al apretar **E** (o tocar el aviso en celular).

**En Blender**: seleccioná el objeto > *Object Properties* > *Custom Properties* y agregá

| Propiedad | Valor | Por defecto |
|---|---|---|
| `teleport` | destino (ver abajo) | modo `auto`; en un Empty se activa al entrar en su cubo, en un objeto visible a 1 m |
| `puerta` | destino (ver abajo) | modo `E`, radio 3 m |
| `teleport_modo` / `puerta_modo` | `auto` o `E` | |
| `teleport_radio` / `puerta_radio` | metros | |
| `teleport_texto` / `puerta_texto` | texto del aviso (solo modo `E`) | `Entrar` |

El **destino** es el nombre de un Empty spawn (ver la sección siguiente):
- `spawn_muelle` → el `spawn_muelle` de la **misma escena**. Te mueve ahí sin recargar nada.
- `spawn` → el spawn base de la misma escena.
- `scene_casa1:spawn_cocina` → otra escena (registrada en `data/tables/scenes.json`), en su `spawn_cocina`.
- `scene_casa1:spawn` → otra escena, en su spawn base.
- `scene_casa1` → otra escena, en su spawn normal (`spawn_<origen>` si existe, si no `spawn`).

Al exportar el `.glb` tildá **Include > Custom Properties**.

Ejemplos:
- Teleport automático en la plaza: Empty `tp_fuente` con `teleport` = `spawn_techo`, y un Empty `spawn_techo` donde querés aparecer.
- Interactuar con un objeto para ir a otro punto: el cartel con `teleport` = `spawn_muelle` y `teleport_modo` = `E`.
- Interactuar para cambiar de escena: la puerta con `puerta` = `scene_casa1:spawn`.

**Zona de un Empty:** en Blender usá *Display As = Cube* con *Size = 1* y escalalo: ese cubo es la zona (la misma regla que los Empties `col_`). **No le pongas `col_` a un teleport**: `col_` lo vuelve una pared sólida e invisible y nunca vas a poder entrar. Usá otro nombre, por ejemplo `tp_montana`.

**Ida y vuelta:** el spawn destino puede estar dentro de otro teleport automático. Después de cada viaje (y al entrar a una escena) los automáticos esperan a que salgas de su zona, así que no rebotás.

**Por nombre** (atajo): un objeto llamado `puerta_casa1` o `empty_puerta_casa1` lleva a `scene_casa1` (`puerta_X` → `scene_X`) con modo `E`.

**Ajustes en el JSON** de la escena (pisan lo de Blender):
```json
"doors": [
  { "empty": "puerta_casa1", "target": "scene_casa1:spawn_entrada", "mode": "E", "radius": 2,
    "spawn": { "position": [0, 1.7, 4], "yaw": 0 } }
]
```
`spawn` fija el punto exacto de llegada (a la altura de los ojos) y gana sobre el spawn del destino. `position` sirve si el objeto todavía no está en el `.glb`. La distancia se mide hasta la superficie del objeto; un Empty cuenta como una columna de 2 m desde el suelo. En `dev.html` cada uno muestra su zona: **verde agua** = con E, **naranja** = automático. La consola (F12) lista todos los de la escena con su destino.

Código: `src/systems/doors.js`, `src/systems/fade.js` y `src/game.js`.

## Puntos de aparición (spawns)

Todos los lugares donde puede aparecer el jugador siguen la misma regla: son **Empties en el suelo** (la cámara se ubica 1,7 m más arriba) y el jugador mira hacia su **flecha verde (eje Y)**. Rotalo sobre Z para girar la vista.

| Nombre del Empty | Para qué |
|---|---|
| `spawn` | el spawn base de la escena (aparecés ahí al empezar o si no se pide otro) |
| `spawn_muelle`, `spawn_techo`, … | otros puntos, para teleports y puertas: `teleport` = `spawn_muelle` |
| `spawn_casa1` | (opcional) se usa solo cuando llegás **desde** `scene_casa1` sin pedir un spawn, para reaparecer afuera de la puerta correcta |

- El prefijo `empty_` es opcional: `empty_spawn` y `empty_spawn_casa1` siguen funcionando.
- **Por propiedad** (si no querés depender del nombre del objeto): a cualquier Empty agregale `spawn` = `spawn_muelle`. Con `spawn` = `1` (o vacío) es el spawn base.

Orden de prioridad al llegar a una escena: `spawn` de la puerta en el JSON → spawn pedido por el teleport (`scene_x:spawn_cocina` o `scene_x:spawn`) → `spawn_<origen>` → `spawn` → `spawn` del JSON de la escena (respaldo si el `.glb` no tiene ningún empty).

Código: `src/systems/spawns.js`.

**Ver los spawns** (solo `dev.html`): botón **Spawns** o tecla **P**. Cada spawn es un poste de la altura del jugador con una flecha en el suelo hacia donde vas a mirar y su nombre encima (se ve a través de las paredes). Amarillo = `spawn` base · celeste = los demás · gris = el `spawn` de respaldo del JSON. Las líneas naranjas unen cada teleport con el spawn al que lleva; los que van a otra escena muestran su destino en una etiqueta. Con el **inspector**, apuntá a un poste para ver su objeto de Blender, posición, hacia dónde mira y cómo escribirlo en un `teleport`. Código: `src/systems/spawn-debug.js`.

## Versión final y modo desarrollador

- `index.html`: la versión final, limpia y sin herramientas.
- **Editor de diálogos por nodos** (solo `dev.html`, botón **Diálogos** arriba a la izquierda): cada cuadro es un nodo de `data/dialogues/<nombre>.json`.
  Se conectan arrastrando desde el círculo de una salida hasta otro nodo (soltando en el vacío se crea uno nuevo; un clic en el círculo desconecta).
  Un clic en el texto de un nodo abre una caja grande para escribir: lo que va entre `{}` (animaciones) sale de otro color, los saltos de línea se marcan con ↵ (también podés escribir `\n`) y las páginas con ¶.
  Una línea en blanco en el texto separa las páginas; las condiciones y flags se escriben en una línea (`hablo_tokse, !tiene_espada, veces_tokse>=3`).
  En Chrome/Edge, **Carpeta** te deja elegir `data/dialogues` una vez y **Guardar** escribe directo en el archivo (también `Ctrl+S`); en otros navegadores
  usá **Abrir…** y **Guardar** (descarga el `.json` para copiarlo a la carpeta). La posición de los nodos se guarda en el mismo JSON, bajo `"editor"`.
  Al guardar, el juego lee la versión nueva la próxima vez que le hablás a un NPC (no hace falta recargar).
- `dev.html`: el mismo mundo con un **inspector**. Hay una mira en el centro y, al apuntar a un objeto, muestra su nombre, archivo de origen, tamaño en metros, texturas, triángulos y distancia. Se activa y desactiva con la tecla **I**.

Los dos usan el mismo motor (`src/game.js`). La versión final no descarga el código del inspector.

## Studio: editar y ver al instante

Con `node studio/server.js` corriendo, abrí **http://localhost:5173/__studio**: a la izquierda el árbol de archivos, al medio el editor (código, o nodos para diálogos y rutas) y a la derecha el juego.

- **Cada vez que guardás** (`Ctrl+S`, o con *Autoguardar*), el juego se actualiza solo **y seguís donde estabas**: misma escena, mismo lugar, mirando para el mismo lado (no vuelve a empezar). Los estilos (`.css`) y los diálogos se cambian sin recargar siquiera; los `.glb` que exportás desde Blender rearman el mundo sin recargar la página (`src/systems/live.js`).
- **Desde el inicio** (arriba de la vista previa) arranca de nuevo desde el spawn de la escena inicial.
- **Pestaña GitHub:** muestra qué archivos cambiaron y con **Enviar a GitHub** los sube: guarda todo en un commit (con el mensaje que escribas), trae lo que haya en GitHub y lo sube. **Traer** baja lo que haya en GitHub que todavía no tenés. Usa el git de tu PC (o el de GitHub Desktop) con tu usuario de siempre; si GitHub no acepta el usuario desde ahí, el commit igual queda hecho y lo subís con *Push origin* en GitHub Desktop.

## Probar en local

Los módulos y los `.glb` no cargan abriendo el `index.html` con doble clic. Usá un servidor local:

```
npx serve
```
o la extensión Live Server de VS Code. Después abrí `/` para la versión final o `/dev.html` para el modo desarrollador.
