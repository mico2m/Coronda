// Modo desarrollador (dev.html): igual que la versión final, más el inspector y el editor de diálogos.
import { startGame } from './game.js';
import { createDialogueEditor } from './systems/dialogue-editor.js';

startGame({ dev: true });
createDialogueEditor();
