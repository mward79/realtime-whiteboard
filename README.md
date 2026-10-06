![Tests](https://github.com/mward79/realtime-whiteboard/actions/workflows/test.yml/badge.svg)

(https://realtime-whiteboard-kddd.onrender.com)

# Real-time collaborative whiteboard

Draw together in the browser. Start a board from the menu, share the room code or link, and everyone sees each other's strokes, shapes, text and cursors live.

## Using it

- **Start or join**: the home page lets you start a new board or join one by typing its room code or pasting an invite link. Boards you've visited are listed under *Recent boards*. Click the room code in the top bar to copy it.
- **Tools**: pen (P), move (H), text (T), rectangle (R), ellipse (O), line (L), arrow (A), eraser (E). The size slider sets line width and text size.
- **Text**: pick the text tool and click where you want it. Enter places it, Shift+Enter adds a line, Escape cancels.
- **Moving around**: the board is infinite. Scroll to pan (Shift+scroll goes sideways), or drag with the move tool, Space+drag, the middle mouse button, two fingers, or the arrow keys. Ctrl/Cmd+scroll, pinch, the +/− buttons, or the +/− keys zoom; 0 or clicking the percentage resets the view.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
npm test
```

Open the page in two browser windows to see syncing.

## How it works

The server (Node, `ws`) keeps each room's strokes in memory. Clients draw locally right away for zero-latency feel, then stream the stroke to the server in batches (one message per animation frame, not per mouse event). The server validates every message (ownership, palette, size, coordinate bounds, payload limits) and relays it to everyone else in the room. Late joiners receive a full snapshot, including strokes still being drawn. Cursor updates are throttled to ~25/s. A heartbeat drops dead connections, and clients reconnect with exponential backoff.

Shapes and text are sent as a single `item:add` message once finished, and the server validates them the same way. Everything is stored in world coordinates, so each person can pan and zoom independently.

Room logic lives in `rooms.js` with no networking, so it's unit tested in isolation.

## Project structure

```
server.js        HTTP + WebSocket server, message routing
rooms.js         room state and validation
rooms.test.js    unit tests (node:test)
public/
  main.js        picks the start menu or the board based on ?room=
  lobby.js       start menu: new board, join by code or link, recent boards
  board.js       canvas, camera (pan/zoom), tools, presence
  shared.js      room codes, saved name, recent boards
```
