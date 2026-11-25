// Motor del juego, compartido por index.html (versión final) y dev.html (modo desarrollador).
// En modo dev se carga además el inspector; la versión final no descarga ese código.
import * as THREE from 'three';
import { loadJSON, forgetJSON, freshModels } from './core/assets.js';
import { createCameraControls } from './systems/camera.js';
import { createAudio } from './systems/audio.js';
import { createSceneManager } from './systems/scene-manager.js';
import { createUI } from './ui/ui.js';
import { createFade } from './systems/fade.js';
import { createDoors } from './systems/doors.js';
import { createLotes } from './systems/lotes.js';
import { createInventario } from './systems/inventario.js';
import { createTienda } from './systems/tienda.js';
import { createTiempo } from './systems/tiempo.js';
import { createBosque } from './systems/bosque.js';
import { createCasas } from './systems/casas.js';
import { createFollowers } from './systems/followers.js';
import { createPlayer } from './actors/player.js';
import { buildCollision } from './systems/collision.js';
import { createNpcs } from './actors/npc.js';
import { createDialogue } from './systems/dialogue.js';
import { createTextbox } from './ui/textbox.js';
import { isSkyName } from './systems/shading.js';
import { boot } from './ui/boot.js';
import { createTouchControls } from './ui/touch-controls.js';

const _focus = new THREE.Vector3();

// retro: { width, height, fps, antialias } -> se dibuja a esa resolución fija y se escala a toda la pantalla,
// con un máximo de fps cuadros por segundo (estilo consola vieja). null = resolución y fps completos.
export async function startGame({ dev = false, retro = null } = {}) {
  const stage = document.getElementById('stage');

  const renderer = new THREE.WebGLRenderer({ antialias: retro?.antialias ?? true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(retro ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  stage.appendChild(renderer.domElement);
  if (retro) stage.classList.add('retro');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  camera.position.set(0, 1.7, 8);

  // Celular: joystick + botón para centrar la cámara (ver ui/touch-controls.js). Lo usan el jugador y la cámara libre.
  const touch = createTouchControls({ pad: document.getElementById('pad'), onRecenter: () => player?.recenterCamera() });
  const controls = createCameraControls(camera, stage, {
    pad: document.getElementById('pad'),
    touch,
    speedOut: document.getElementById('speedOut'),
  });
  const ui = createUI();
  const fade = createFade({ duration: 0.6 });

  function resize() {
    if (retro) { // resolución interna fija; el navegador escala la imagen (ver css .retro)
      renderer.setSize(retro.width, retro.height, false);
      camera.aspect = retro.width / retro.height;
      camera.updateProjectionMatrix();
      return;
    }
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  let inspector = null;
  let collisionDebug = null;
  let spawnDebug = null;
  let routeDebug = null;
  let choice = null;   // lo elegido en el menú de inicio
  let net = null;      // multijugador (si elegiste jugar en el servidor)
  const npcs = createNpcs();
  const followers = createFollowers(); // objetos con la propiedad `seguir` (ver systems/followers.js)
  let dialogue = null;
  let inventario = null; // mochila del jugador (ver systems/inventario.js)
  let tienda = null;     // la Carpintería de Claude (ver systems/tienda.js)
  let tiempo = null;     // hora del juego y día/noche (ver systems/tiempo.js)
  let bosque = null;     // talar árboles (ver systems/bosque.js)
  let doors = null;
  let lotes = null; // lotes que los jugadores pueden adquirir (ver systems/lotes.js)
  let minimap = null; // ver ui/minimap.js
  let casas = null;   // interiores de las casas de los lotes (ver systems/casas.js)
  let claudeNpc = null; // Claude, el NPC de la plaza: uno solo para todo el servidor (ver systems/claude-npc.js)
  let player = null;
  let world = null; // gestor de escenas (para mover el cielo)
  let mode = 'free'; // 'player' (tercera persona) o 'free' (cámara libre)
  const hintFree = document.getElementById('hintFree');
  const hintPlayer = document.getElementById('hintPlayer');
  const EYE = 1.7; // altura de los ojos de la cámara libre sobre el suelo

  // Charlas con NPC (ver systems/dialogue.js): mientras dura, el jugador (o la cámara libre) no se mueve.
  // Se libera un instante después para que la tecla que cierra la charla no active otra cosa (ej. una acción 1, 2, 3).
  // La caja de texto se dibuja dentro de la imagen del juego (ui/textbox.js), encima del mundo y en el mismo cuadro
  const textbox = createTextbox({ renderer, retro });
  dialogue = createDialogue({
    stage,
    npcs,
    textbox,
    onStart: () => { player.frozen = true; if (mode === 'free') controls.setEnabled(false); },
    onEnd: () => setTimeout(() => { player.frozen = false; if (mode === 'free') controls.setEnabled(true); }, 0),
    onError: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 3000); },
    hooks: {
      gate: (e) => claudeNpc?.gate(e) ?? true,
      ended: (e) => claudeNpc?.ended(e),
      choiceOk: (c) => claudeNpc?.choiceOk(c) ?? c?.needs !== 'ia',
      ask: (e, t) => claudeNpc?.ask(e, t) ?? Promise.resolve({ text: '…' }),
      greeting: (e) => claudeNpc?.greeting(e) ?? null,
      dynamic: (e, name) => tienda?.dynamic(e, name) ?? null, // nodos de la tienda (catálogo, pedidos, retirar)
      idle: (e) => tienda?.idle(e) ?? null,                   // si no avanzás la charla con Claude, se corta
    },
  });

  function setMode(m) {
    mode = m;
    const asPlayer = m === 'player';
    touch.setRecenterVisible(asPlayer); // 🎥 solo con el personaje
    document.getElementById('pad')?.classList.toggle('free', !asPlayer); // ▲ ▼ solo en la cámara libre
    if (asPlayer) {
      // desde la cámara libre: el jugador aparece debajo de la cámara, mirando hacia donde mirabas
      player.place([camera.position.x, camera.position.y - EYE, camera.position.z], controls.getYaw());
    } else if (player.active) {
      controls.setLook(player.yaw, -0.2);
    }
    controls.setEnabled(!asPlayer);
    player.setActive(asPlayer);
    if (hintFree) hintFree.hidden = asPlayer;
    if (hintPlayer) hintPlayer.hidden = !asPlayer;
  }
  // En dev, C alterna entre cámara libre y personaje
  if (dev) window.addEventListener('keydown', (e) => { if (e.code === 'KeyC' && !e.repeat && player && !dialogue?.active) setMode(mode === 'player' ? 'free' : 'player'); });

  let last = performance.now();
  const interval = retro?.fps ? 1000 / retro.fps : 0;
  function frame(now) {
    requestAnimationFrame(frame);
    // Límite de cuadros: se salta el cuadro si todavía no pasó el intervalo (2 ms de margen por el redondeo del navegador)
    if (interval && now - last < interval - 2) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    controls.update(dt);
    player?.update(dt);
    claudeNpc?.update(dt, npcs.list);
    npcs.update(dt);
    net?.update(dt);
    inspector?.update(dt);
    world?.updateSky(camera.position);
    // Punto que se compara con puertas y NPC: el jugador (a la altura del pecho) o la cámara libre
    const focus = mode === 'player' && player ? _focus.copy(player.position).setY(player.position.y + 1) : camera.position;
    followers.update(focus, dt);
    dialogue?.update(focus, dt);
    doors?.tick(dt);
    const feetY = mode === 'player' && player ? player.position.y : camera.position.y - 1.7;
    doors?.update(focus, feetY);
    lotes?.update(focus, feetY, dt); // después de las puertas: si hay una puerta cerca, la E es de ella
    casas?.update(focus);
    tienda?.update(focus, dt);
    tiempo?.update(dt);
    bosque?.update(mode === 'player' && player ? player.position : null, dt);
    minimap?.update({
      me: mode === 'player' && player ? { x: player.position.x, z: player.position.z, facing: player.facing } : { x: camera.position.x, z: camera.position.z, facing: controls.getYaw() + Math.PI },
      others: net?.positions?.() ?? [],
      lots: lotes?.mapMarks?.() ?? [],
    });
    renderer.render(scene, camera);
    textbox.render(); // caja de diálogo, encima del mundo
  }
  requestAnimationFrame(frame);

  // Datos y escena inicial
  try {
    const [scenesTable, musicTable] = await Promise.all([
      loadJSON('data/tables/scenes.json'),
      loadJSON('data/tables/music.json'),
    ]);
    const playerConfig = await loadJSON('data/tables/player.json').catch(() => ({}));
    // Menú de inicio (index): elegir personaje y jugar solo o en el servidor (ver ui/start-menu.js y net/multiplayer.js).
    // En dev no aparece, salvo con ?menu en la dirección.
    const params = new URLSearchParams(location.search);
    // Aviso de actualización: cuando se sube una versión nueva, a los que están jugando les avisa (ver ui/update-notice.js)
    if (!dev) import('./ui/update-notice.js').then((m) => m.createUpdateNotice()).catch(() => {});
    // Guardar lo bajado en el dispositivo (sw.js): la próxima vez carga desde ahí. No en localhost (ahí modelás).
    if (!dev && 'serviceWorker' in navigator) {
      const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
      if (local) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      else {
        navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((err) => console.warn('No se pudo activar el guardado en el dispositivo:', err));
        navigator.storage?.persist?.().catch(() => {}); // que el navegador no lo borre por falta de espacio
      }
    }
    if (!dev || params.has('menu')) {
      const { findCharacters, showStartMenu } = await import('./ui/start-menu.js');
      const { connectServer } = await import('./net/multiplayer.js');
      boot.text('Buscando personajes…');
      const characters = await findCharacters(playerConfig);
      const menu = showStartMenu({ characters, connect: () => connectServer(params.get('sala') || 'coronda') });
      boot.hide(); // el menú ya está a la vista
      choice = await menu;
      boot.show(choice.online ? 'Entrando al servidor…' : 'Entrando al mundo…');
      const ch = choice.character;
      if (ch.id !== 'personaje') { // un NPC: su modelo, su escala y su idle (las acciones y clips de player.json son del personaje)
        playerConfig.model = ch.model;
        playerConfig.scale = ch.scale;
        playerConfig.yawOffset = ch.yawOffset;
        playerConfig.actions = {};
        playerConfig.animation = { ...playerConfig.animation, clips: { idle: ch.idle || '', walk: '', run: '' } };
      }
      net = choice.online ? choice.net : null;
    }
    player = await createPlayer({ scene, camera, stage, pad: document.getElementById('pad'), touch, config: playerConfig });
    const audio = createAudio(musicTable);
    const sceneManager = createSceneManager({ scene, camera, controls, audio, ui, scenesTable });
    if (!dev || /[?&]minimapa/.test(location.search)) { // en dev.html el inspector ocupa ese lugar (con ?minimapa aparece igual)
      const { createMinimap } = await import('./ui/minimap.js');
      minimap = createMinimap({ renderer, scene });
    }
    world = sceneManager;

    // Arma (o rehace) las colisiones de la escena actual. Se rehace cuando alguien adquiere o libera un lote (aparece o
    // desaparece una casa) sin cambiar de escena.
    function rebuildCollision() {
      if (!sceneManager.current || !sceneManager.root) return; // en medio de un cambio de escena
      // Colisiones: se leen las propiedades `colision` de los objetos del .glb (ver collision.js)
      const scol = sceneManager.current.collision ?? {};
      sceneManager.root.getObjectByName('collision-debug')?.removeFromParent(); // la capa de depuración anterior
      const cworld = buildCollision(sceneManager.root, {
        // Por defecto NADA colisiona: solo los col_… (mallas o Empties) y lo que tenga colision = 1. Para que todo choque: "default": "solid"
        defaultSolid: scol.default === 'solid' || scol.default === true,
        maxSlope: playerConfig.collision?.maxSlope,
        ignore: (node) => isSkyName(node.name),
      });
      if (!cworld.hasGround) console.warn('Colisiones: la escena no tiene ninguna superficie de suelo sólida; el jugador no cambia de altura.');
      console.info(`Colisiones de "${sceneManager.current.id}":`, cworld.stats);
      collisionDebug?.attach(sceneManager.root, cworld);
      player.setWorld(cworld);
      npcs.setWorld(cworld); // las rutas de los NPC esquivan los objetos con colisión
    }

    // Mientras algo carga detrás del fundido a negro: si tarda más que un instante aparece la pantalla de carga con su
    // barra (nunca una pantalla negra). La barra sigue a lo que va bajando (ver ui/boot.js).
    async function withLoading(go, text = 'Cargando…') {
      let shown = false;
      const t = setTimeout(() => { shown = true; boot.show(text, { tip: false }); }, 200);
      try { return await go(); } finally { clearTimeout(t); if (shown) await boot.hideNow(); }
    }

    // Carga una escena y deja listas sus puertas
    async function enterScene(id, spawn, spawnName) {
      await sceneManager.loadScene(id, { spawn, spawnName });
      doors.setup(sceneManager.current, sceneManager.root);
      // El jugador aparece en el punto de inicio de la escena (sp está a la altura de los ojos)
      // Colisiones del mapa primero (como siempre); las casas de los lotes se suman después y, si algo falla ahí, el mundo sigue igual
      rebuildCollision();
      try {
        if (await lotes.setup(sceneManager.current, sceneManager.root)) rebuildCollision(); // hay casas: pueden tener col_…
      } catch (err) {
        console.error('Lotes:', err);
        ui.setStatus(`Lotes: ${err.message || err}`);
      }
      casas?.afterScene(sceneManager.current.id);
      // Al entrar a una casa la cámara arranca con el zoom lo más cerca del personaje (como al hacer scroll hacia
      // adelante afuera); después se puede ajustar con la rueda
      player.setCameraPreset(casas?.inside ? { distance: player.minDistance } : null);
      minimap?.capture(sceneManager.root); // el mapa desde arriba, antes de que aparezcan los NPC
      spawnDebug?.attach(sceneManager.root, sceneManager.current, doors.list); // después de las colisiones: los postes no chocan
      // NPC: Empties npc_* del .glb + "actors" del JSON (ver src/actors/npc.js). Van después de armar las colisiones.
      const npcInfo = await npcs.setup(sceneManager.root, sceneManager.current, sceneManager.shade);
      player.setObstacles(npcs.obstacles);
      routeDebug?.attach(sceneManager.root, sceneManager.current, npcs.list); // recorridos de los NPC (tecla R)
      followers.setup(sceneManager.root); // objetos que giran para mirar al jugador (propiedad `seguir`)
      dialogue.setup(); // los NPC con diálogo (npc_texto / npc_dialogo)
      if (npcInfo.missing.length) ui.setStatus(`NPC: no se pudo cargar ${npcInfo.missing.join(', ')}`);
      player.setShade(sceneManager.shade); // mismo tono y brillo que la escena
      net?.setShade(sceneManager.shade);
      const sp = sceneManager.spawn;
      if (sp) player.place([sp.position[0], sp.position[1] - EYE, sp.position[2]], sp.yaw ?? 0);
    }
    // Mueve al jugador (o a la cámara libre) a un punto { position (ojos), yaw } sin cambiar de escena
    function moveTo(sp) {
      if (mode === 'player') player.place([sp.position[0], sp.position[1] - EYE, sp.position[2]], sp.yaw ?? 0);
      else { camera.position.set(...sp.position); controls.setLook(sp.yaw ?? 0, 0); }
    }

    // Puertas y teleports (ver systems/doors.js): fundido a negro -> viajar -> fundido desde negro.
    //  - mismo .glb: se mueve al jugador al spawn destino (ej. spawn_muelle)
    //  - otra escena: se carga su .glb y se aparece en el spawn pedido (o en el normal)
    doors = createDoors({
      stage,
      dev,
      blocked: () => (dialogue?.blocked ?? false) || (lotes?.blocked ?? false), // las charlas con NPC y el menú de casas usan la misma tecla E
      isScene: (id) => !!scenesTable[id],
      onEnter: async (door) => {
        player.frozen = true; // no se mueve durante la animación ni el fundido
        if (mode === 'free') controls.setEnabled(false);
        // Animación de abrir la puerta (ver doors.js > puerta_anim): mira a la puerta, la hace y recién ahí el fundido
        // ...y la puerta se abre (su propia animación del .glb, si tiene): se espera a la más larga de las dos
        const animar = mode !== 'free' && door.anim !== null;
        // 1) se para en el pos_jugador de la puerta (el más cercano), como cuando animaste a Link con la puerta
        const at = animar ? doors.pointFor(door, player.position) : null;
        if (at) await player.alignTo(at);
        // 2) Link y la puerta animan a la vez; el fundido espera a la más larga
        const doorSecs = doors.openDoor(door);
        const doorWait = new Promise((r) => setTimeout(r, (door.wait ?? doorSecs) * 1000));
        if (animar) await player.interact(door.anim, { face: at ? null : door.center, wait: door.wait });
        await doorWait;
        await fade.fadeOut();
        try {
          if (door.scene === sceneManager.current?.id) {
            const key = door.spawnName ?? ''; // '' = el spawn base de la escena
            const sp = door.spawn ?? sceneManager.findSpawnByName(key);
            if (!sp) throw new Error(`Teleport "${door.id}": no existe el Empty "${key ? 'spawn_' + key : 'spawn'}" en esta escena.`);
            moveTo(sp);
          } else {
            await withLoading(() => enterScene(door.scene, door.spawn, door.spawnName), `Cargando ${scenesTable[door.scene]?.name || 'el lugar'}…`);
          }
        } catch (err) { // destino inexistente: nos quedamos donde estábamos, sin pantalla negra eterna
          console.error(err);
          ui.setStatus(String(err.message || err));
        }
        player.endInteract(); // por si no hubo viaje (destino inexistente)
        doors.closeDoor(door); // al volver, la puerta está cerrada
        await fade.fadeIn();
        player.frozen = false;
        if (mode === 'free') controls.setEnabled(true);
      },
    });

    // Lotes (ver systems/lotes.js): los Empties lote_* del mapa se pueden adquirir y se reemplazan por una casa
    lotes = createLotes({
      stage,
      net,
      name: choice?.name ?? 'Viajero',
      dev,
      blocked: () => dialogue?.blocked ?? false,
      yieldE: () => !!doors?.near || !!doors?.busy, // si hay una puerta cerca, la E es de la puerta
      onOpen: () => { player.frozen = true; if (mode === 'free') controls.setEnabled(false); },
      onClose: () => setTimeout(() => { player.frozen = false; if (mode === 'free') controls.setEnabled(true); }, 0),
      onChange: () => rebuildCollision(),
      onRedraw: () => minimap?.capture(sceneManager.root),
      onEnterHouse: (key, info) => goToHouse(key, info),
      onReleased: (key) => casas?.clear(key),
      notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 2500); },
      getShade: () => sceneManager.shade,
    });

    // Inventario del jugador (recursos y muebles) y la tienda donde Claude fabrica los muebles
    inventario = createInventario({
      stage,
      dev,
      blocked: () => dialogue?.blocked ?? false,
      notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 1800); },
      // En la compu la mochila es un menú al centro: el personaje se queda quieto mientras está abierta
      onOpen: () => { player.frozen = true; if (mode === 'free') controls.setEnabled(false); },
      onClose: () => setTimeout(() => { player.frozen = false; if (mode === 'free') controls.setEnabled(true); }, 0),
    });
    // Hora del juego, día y noche y reloj (la misma hora para todos: sale del reloj de la compu)
    tiempo = createTiempo({ scene, stage, dev, getSceneData: () => sceneManager.current, getBaseShade: () => sceneManager.shade });
    window.corondaTiempo = tiempo;
    // Talar árboles (en cualquier escena que tenga arbol_001, arbol_002…)
    bosque = createBosque({
      stage, net, inventario, tiempo, getRoot: () => sceneManager.root, getSceneId: () => sceneManager.current?.id ?? null,
      getPlayer: () => (mode === 'player' ? player : null), blocked: () => !!dialogue?.active || !!casas?.inside,
      notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 1800); },
    });

    // Claude: uno solo para todo el servidor, charla de a uno y (si hay IA configurada) le podés escribir
    {
      const { createClaudeNpc } = await import('./systems/claude-npc.js');
      claudeNpc = createClaudeNpc({
        net, npcs, lotes, getPlayer: () => (mode === 'player' ? player : null), getSceneId: () => sceneManager.current?.id ?? null,
        myName: choice?.name ?? 'Viajero', notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 2500); },
        abrirCharla: (e, nodes, start) => dialogue.startCustom(e, nodes, start),
        getTienda: () => tienda, // la IA sabe tus pedidos de la Carpintería (la tienda se crea después: por eso es una función)
      });
      claudeNpc.precargarSaludo(); // el saludo de la IA se pide ya, mientras carga el juego
      window.corondaClaude = claudeNpc; // para revisar desde la consola: corondaClaude.state
    }

    // Interiores de las casas (ver systems/casas.js): se entra desde el menú del lote, se sale por la puerta
    casas = createCasas({
      net, uid: lotes.uid, lotes, stage, camera,
      getPlayer: () => (mode === 'player' ? player : null),
      getShade: () => sceneManager.shade,
      notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 2500); },
      blocked: () => (dialogue?.blocked ?? false) || (lotes?.blocked ?? false),
      onChange: () => { rebuildCollision(); minimap?.capture(sceneManager.root); },
      inventario,
    });
    // La Carpintería de Claude: pedidos de muebles a cambio de madera, retiro y notas en los buzones (ver systems/tienda.js)
    tienda = createTienda({
      stage, net, claude: claudeNpc, inventario, tiempo, lotes, casas, myName: choice?.name ?? 'Viajero', myUid: lotes.uid,
      getRoot: () => sceneManager.root, getSceneId: () => sceneManager.current?.id ?? null,
      getPlayer: () => (mode === 'player' ? player : null),
      notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 4500); },
    });
    async function travel(go, text) {
      player.frozen = true;
      if (mode === 'free') controls.setEnabled(false);
      await fade.fadeOut();
      try { await withLoading(go, text); } catch (err) { console.error(err); ui.setStatus(String(err.message || err)); }
      await fade.fadeIn();
      player.frozen = false;
      if (mode === 'free') controls.setEnabled(true);
    }
    function goToHouse(key, back) {
      const owner = lotes.record(key);
      const text = owner?.o === lotes.uid ? 'Entrando a tu casa…' : `Entrando a la casa de ${owner?.n || 'otro jugador'}…`;
      return travel(async () => {
        const entry = await casas.sceneEntry(key, back); // scene_lote<nro>_<dueño> (ver systems/casas.js)
        scenesTable[entry.id] = entry;
        await enterScene(entry.id);
      }, text);
    }
    casas.setOnExit(() => {
      const b = casas.inside?.back;
      if (!b) return travel(() => enterScene(Object.keys(scenesTable).find((id) => scenesTable[id].start) ?? Object.keys(scenesTable)[0]), 'Saliendo…');
      // Aparecés delante del lote, mirando hacia afuera
      const q = new THREE.Quaternion().fromArray(b.quat);
      const out = new THREE.Vector3(0, 0, 1).applyQuaternion(q).setY(0).normalize();
      const dist = Math.abs(b.size[2] || 6) / 2 + 1.5;
      const pos = [b.pos[0] + out.x * dist, b.pos[1] + 1.7, b.pos[2] + out.z * dist];
      return travel(() => enterScene(b.scene, { position: pos, yaw: Math.atan2(-out.x, -out.z) }), 'Saliendo…');
    });

    if (dev) {
      try {
        const { createInspector } = await import('./systems/inspector.js');
        inspector = createInspector({ scene, camera, getRoot: () => sceneManager.root });
        const { createCollisionDebug } = await import('./systems/collision-debug.js');
        collisionDebug = createCollisionDebug();
        const { createSpawnDebug } = await import('./systems/spawn-debug.js');
        spawnDebug = createSpawnDebug();
        const { createRouteDebug } = await import('./systems/route-debug.js');
        routeDebug = createRouteDebug();
      } catch (err) {
        // Si el inspector no carga, el mundo igual se muestra
        console.error(err);
        ui.setStatus('No se pudo cargar el inspector (falta src/systems/inspector.js).');
      }
    }

    // En vivo (solo dev): al exportar un .glb desde Blender, la escena se vuelve a armar sin recargar (systems/live.js)
    if (dev) {
      const { connectLive } = await import('./systems/live.js');
      const embedded = window.parent !== window; // dentro del Coronda Studio: él recarga lo demás
      let busy = null, again = false;
      // Vuelve a armar la escena actual sin moverte de donde estás
      async function refreshScene(why) {
        if (busy) { again = true; return busy; }
        const id = sceneManager.current?.id;
        if (!id || player.frozen) return; // en medio de una puerta o una charla: se deja para el próximo cambio
        const here = mode === 'player'
          ? { position: [player.position.x, player.position.y + EYE, player.position.z], yaw: player.yaw }
          : { position: camera.position.toArray(), yaw: controls.getYaw() };
        const pitch = controls.getPitch();
        busy = (async () => {
          const t0 = performance.now();
          freshModels();
          forgetJSON(scenesTable[id]?.file);
          await enterScene(id, here);
          if (mode === 'free') { camera.position.set(...here.position); controls.setLook(here.yaw, pitch); }
          ui.setStatus(`Actualizado desde ${why} (${Math.round(performance.now() - t0)} ms)`);
          setTimeout(() => ui.clearStatus(), 1500);
        })().catch((err) => { console.error(err); ui.setStatus(String(err.message || err)); });
        await busy;
        busy = null;
        if (again) { again = false; refreshScene(why); }
      }
      const live = connectLive({
        onFiles(paths) {
          const sceneFile = scenesTable[sceneManager.current?.id]?.file;
          const glbs = paths.filter((p) => /\.glb$/i.test(p));
          if (glbs.some((p) => p === playerConfig.model)) { location.reload(); return; } // el personaje: hay que empezar de nuevo
          if (glbs.length) { refreshScene(glbs.map((p) => p.split('/').pop()).join(', ')); return; }
          if (sceneFile && paths.includes(sceneFile)) { refreshScene(sceneFile.split('/').pop()); return; }
          if (!embedded && paths.some((p) => /\.(js|css|html)$/i.test(p) || /^data\/tables\//.test(p))) location.reload();
        },
      });
      window.addEventListener('pagehide', () => live?.close());
    }

    // Modo desarrollador: al recargar (guardaste un archivo en el Studio) seguís donde estabas, no desde el principio
    const KEEP = 'coronda.dev.lugar';
    let kept = null;
    if (dev) {
      try { kept = JSON.parse(sessionStorage.getItem(KEEP)); } catch { kept = null; }
      if (!kept || !scenesTable[kept.scene] || Date.now() - kept.t > 2 * 3600e3 || !Array.isArray(kept.pos)) kept = null;
      window.addEventListener('pagehide', () => {
        const id = sceneManager.current?.id;
        if (!id || !player) return;
        const asPlayer = mode === 'player';
        const pos = asPlayer ? [player.position.x, player.position.y + EYE, player.position.z] : camera.position.toArray();
        try { sessionStorage.setItem(KEEP, JSON.stringify({ t: Date.now(), scene: id, mode, pos, yaw: asPlayer ? player.yaw : controls.getYaw(), pitch: controls.getPitch() })); } catch { /* sin almacenamiento */ }
      });
    }
    const startId = kept?.scene ?? Object.keys(scenesTable).find((id) => scenesTable[id].start) ?? Object.keys(scenesTable)[0];
    await enterScene(startId, kept ? { position: kept.pos, yaw: kept.yaw } : undefined);
    setMode(kept?.mode ?? (dev ? 'free' : 'player'));
    if (kept && mode === 'free') controls.setLook(kept.yaw, kept.pitch ?? 0);
    // Si tenés casa: "¿Dónde querés aparecer?" → tu casa o la plaza (ver ui/spawn-choice.js)
    if (choice && !kept && mode === 'player') {
      const houses = lotes.myLots().map((key) => ({ key, label: lotes.spotInfo(key)?.label ?? 'Lote' }));
      if (houses.length) {
        const { askSpawn } = await import('./ui/spawn-choice.js');
        const key = await askSpawn({ houses, plazaName: scenesTable[startId]?.name || 'Plaza' });
        if (key && await lotes.ensureMine(key)) {
          boot.show('Entrando a tu casa…');
          try {
            const entry = await casas.sceneEntry(key, lotes.spotInfo(key));
            scenesTable[entry.id] = entry;
            await enterScene(entry.id);
          } catch (err) { console.error(err); await enterScene(startId); }
        }
      }
    }
    // El mundo ya está: se saca la pantalla de carga después de dibujarlo una vez
    requestAnimationFrame(() => requestAnimationFrame(() => boot.hide()));
    // Servidor: desde ahora los demás te ven (y vos a ellos)
    if (net) {
      const r = (v) => Math.round(v * 100) / 100;
      const ch = choice.character;
      net.setShade(sceneManager.shade);
      net.start({
        scene,
        me: () => (mode === 'player' && player ? {
          s: sceneManager.current?.id, p: [r(player.position.x), r(player.position.y), r(player.position.z)],
          f: r(player.facing), a: player.clipName, m: ch.model, sc: ch.scale, yo: ch.yawOffset, n: choice.name, cn: ch.name,
        } : null),
      });
      // Tab: lista de jugadores con su ping y su última conexión (ver ui/players.js)
      const { createPlayerList } = await import('./ui/players.js');
      createPlayerList({ net });
      // 5 minutos sin tocar nada: "¿Seguís ahí?" y, si no respondés, se te desconecta (ver ui/afk.js)
      const { createAfk } = await import('./ui/afk.js');
      createAfk({ onDisconnect: () => net.disconnect() });
      // Chat: Enter para escribir (ver ui/chat.js)
      const { createChat } = await import('./ui/chat.js');
      let admin = null;
      const chatUi = createChat({ net, myName: choice.name, blocked: () => !!dialogue?.active, onCommand: (t) => admin?.comando(t) });
      // Comandos de admin en el chat: /admin CLAVE, /time set 19, /anuncio… (ver systems/admin.js; los ven todos)
      const { createAdmin } = await import('./systems/admin.js');
      admin = createAdmin({ net, chat: chatUi, myName: choice.name, tiempo, inventario, getBosque: () => bosque, stage,
        notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 3500); } });
      // Claudito también charla por el chat de vez en cuando (la IA lo pide; ver systems/claude-npc.js)
      claudeNpc.onSay = (t) => chatUi.add('Claudito', t);
      const onChat0 = net.onChat;
      net.onChat = (n, t, peerId) => { onChat0?.(n, t, peerId); claudeNpc.heard(n, t); };
      const say0 = net.say;
      net.say = (t) => { const r = say0(t); if (r) claudeNpc.heard(choice.name, r); return r; };
    }
    // Chat de voz por proximidad (solo en el servidor, ver systems/voz.js) y menú de Esc con sus ajustes (ver ui/menu.js)
    let menu = null;
    let voz = null;
    if (net) {
      const { createVoz } = await import('./systems/voz.js');
      voz = createVoz({
        net, stage, getCamera: () => camera,
        blocked: () => !!dialogue?.active,
        onMenu: () => menu?.abrir(),
        notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 4000); },
      });
    }
    const { createMenu } = await import('./ui/menu.js');
    menu = createMenu({
      stage, voz,
      blocked: () => !!dialogue?.active || (lotes?.blocked ?? false) || (casas?.designing ?? false),
      onOpen: () => { player.frozen = true; if (mode === 'free') controls.setEnabled(false); },
      onClose: () => setTimeout(() => { player.frozen = false; if (mode === 'free') controls.setEnabled(true); }, 0),
    });
    // si el personaje o sus animaciones tienen problemas, se avisa en pantalla (con un NPC elegido en el menú
    // es normal que falten caminar/correr: no se avisa)
    const notice = player.loadError ?? (choice && choice.character.id !== 'personaje' ? null : player.animNotice);
    if (notice) ui.setStatus(notice);
  } catch (err) {
    console.error(err);
    boot.hide();
    ui.setStatus(String(err.message || err));
  }
  // Para las herramientas del modo desarrollador (panel de NPC, etc.)
  return { npcs, camera, controls, scene, getRoot: () => world?.root ?? null, getInventario: () => inventario, getTienda: () => tienda, getTiempo: () => tiempo, getBosque: () => bosque };
}