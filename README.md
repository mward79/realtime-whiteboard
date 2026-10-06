# Real-time collaborative whiteboard

Draw together in the browser. Open a room, share the link, and everyone sees each other's strokes and cursors live.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
npm test
```

Open the page in two browser windows to see syncing.

## How it works

The server (Node, `ws`) keeps each room's strokes in memory. Clients draw locally right away for zero-latency feel, then stream the stroke to the server in batches (one message per animation frame, not per mouse event). The server validates every message (ownership, palette, size, coordinate bounds, payload limits) and relays it to everyone else in the room. Late joiners receive a full snapshot, including strokes still being drawn. Cursor updates are throttled to ~25/s. A heartbeat drops dead connections, and clients reconnect with exponential backoff.

Room logic lives in `rooms.js` with no networking, so it's unit tested in isolation.

## Project structure

```
server.js        HTTP + WebSocket server, message routing
rooms.js         room state and validation
rooms.test.js    unit tests (node:test)
public/          client (canvas, toolbar, presence)
```
