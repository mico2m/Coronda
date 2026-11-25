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
import { createFollowers } from './systems/followers.js';
import { createPlayer } from './actors/player.js';
import { buildCollision } from './systems/collision.js';
import { createNpcs } from './actors/npc.js';
import { createDialogue } from './systems/dialogue.js';
import { createTextbox } from './ui/textbox.js';
import { isSkyName } from './systems/shading.js';
import { boot } from './ui/boot.js';

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

  const controls = createCameraControls(camera, stage, {
    pad: document.getElementById('pad'),
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
  let doors = null;
  let lotes = null; // lotes que los jugadores pueden adquirir (ver systems/lotes.js)
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
    onError: (msg) => ui.setStatus(msg),
  });

  function setMode(m) {
    mode = m;
    const asPlayer = m === 'player';
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
    lotes?.update(focus, feetY); // después de las puertas: si hay una puerta cerca, la E es de ella
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
    player = await createPlayer({ scene, camera, stage, pad: document.getElementById('pad'), config: playerConfig });
    const audio = createAudio(musicTable);
    const sceneManager = createSceneManager({ scene, camera, controls, audio, ui, scenesTable });
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
            await enterScene(door.scene, door.spawn, door.spawnName);
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
      notify: (msg) => { ui.setStatus(msg); setTimeout(() => ui.clearStatus(), 2500); },
      getShade: () => sceneManager.shade,
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
          f: r(player.facing), a: player.clipName, m: ch.model, sc: ch.scale, yo: ch.yawOffset, n: choice.name,
        } : null),
      });
      const pill = document.createElement('div');
      pill.className = 'online-pill';
      pill.title = 'Jugadores en el servidor';
      const show = (n) => { pill.innerHTML = `<i></i>${n === 1 ? 'Solo vos en el servidor' : `${n} en el servidor`}`; };
      show(net.count);
      net.onCount = show;
      document.querySelector('.app')?.append(pill);
      // Chat: Enter para escribir (ver ui/chat.js)
      const { createChat } = await import('./ui/chat.js');
      createChat({ net, myName: choice.name, blocked: () => !!dialogue?.active });
    }
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
  return { npcs, camera, controls, scene, getRoot: () => world?.root ?? null };
}
