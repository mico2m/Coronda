// Versión final (index.html): se dibuja con pocos píxeles (los mismos que width × height, con la forma de la ventana: sin
// franjas negras) y se escala a pantalla completa.
// Para cambiarlo, editá estos números. Con `retro: null` se ve a resolución y fps completos.
import { startGame } from './game.js';

startGame({ retro: { width: 800, height: 600, fps: 60, antialias: true } });
