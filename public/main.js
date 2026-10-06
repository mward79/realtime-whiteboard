import { roomFromUrl } from './shared.js';

// "/?room=abc" opens that board; plain "/" shows the start menu.
if (roomFromUrl()) import('./board.js');
else import('./lobby.js');
