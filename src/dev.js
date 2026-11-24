// Modo desarrollador (dev.html): igual que la versión final, más el inspector.
// Los editores (diálogos por nodos, NPC y animaciones) viven en el Coronda Studio:  node studio/server.js
import { startGame } from './game.js';
import { createStudioBridge } from './systems/studio-bridge.js';

const game = await startGame({ dev: true });   // devuelve los motores para el Studio
window.coronda = createStudioBridge(game);
