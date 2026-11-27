// Versión final (index.html): se dibuja a 320x240 y 20 cuadros por segundo, escalado a pantalla completa.
// Para cambiarlo, editá estos números. Con `retro: null` se ve a resolución y fps completos.
import { startGame } from './game.js';

startGame({ retro: { width: 800, height: 600, fps: 60, antialias: true } });
