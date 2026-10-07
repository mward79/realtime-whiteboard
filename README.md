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

Boards are saved to Redis, so start one locally first (any Redis 6+ or Valkey works):

```bash
docker run -d --name whiteboard-redis -p 6379:6379 redis:7   # or: brew install redis && brew services start redis
npm install
npm run dev      # http://localhost:3000, uses redis://localhost:6379
npm test         # no Redis needed
```

Open the page in two browser windows to see syncing.

| Variable    | Default                  | What it does |
|-------------|--------------------------|--------------|
| `REDIS_URL` | `redis://localhost:6379` | Where boards are saved. Use `rediss://…` for TLS. Set it to `memory://` to run without Redis (boards are lost when the server stops). |
| `PORT`      | `3000`                   | HTTP port. |

If Redis can't be reached at startup the server exits with an error saying so. If Redis drops out while it's running, people can keep drawing: writes queue up and are sent when it reconnects.

To also run the storage tests against a real Redis (they're skipped otherwise):

```bash
TEST_REDIS_URL=redis://localhost:6379 npm test
```

The tests only touch keys under a unique `wb:test:` prefix and delete them afterwards.

## Deploying on Render

1. In the Render dashboard, create a **Key Value** instance (Render's Redis-compatible store) in the same region as the web service.
2. Copy its **Internal Key Value URL** (`redis://red-…:6379`).
3. On the web service, add an environment variable `REDIS_URL` with that URL, and redeploy.

> **Free Key Value instances have no disk persistence.** Data lives only in memory, so every board is wiped whenever the instance restarts (maintenance, upgrades, or a crash). That's fine for trying things out; use a paid instance, which persists to disk, if boards need to survive restarts. On a small instance, an `allkeys-lru` eviction policy drops the least recently used boards when memory fills up, instead of refusing new writes.

Web service restarts and redeploys are safe either way: the server saves strokes still being drawn on `SIGTERM` before exiting, and boards reload from Redis when people reconnect.

## How it works

The server (Node, `ws`) keeps each room's strokes in memory. Clients draw locally right away for zero-latency feel, then stream the stroke to the server in batches (one message per animation frame, not per mouse event). The server validates every message (ownership, palette, size, coordinate bounds, payload limits) and relays it to everyone else in the room. Late joiners receive a full snapshot, including strokes still being drawn. Cursor updates are throttled to ~25/s. A heartbeat drops dead connections, and clients reconnect with exponential backoff.

Shapes and text are sent as a single `item:add` message once finished, and the server validates them the same way. Everything is stored in world coordinates, so each person can pan and zoom independently.

Room logic lives in `rooms.js` with no networking, so it's unit tested in isolation.

### Persistence

The in-memory rooms are the live state; Redis is the durable copy. `storage.js` defines a small interface (`load`, `putItem`, `removeItem`, `clear`) with two implementations, `RedisStorage` and `MemoryStorage` (used by the tests and by `REDIS_URL=memory://`), and the server is the only thing that calls it:

- **Loading**: the first person to join a room loads it from storage; people joining at the same time share that one load. When the last person leaves, the room is dropped from memory.
- **Saving**: items are written once they're finished: freehand and eraser strokes on `stroke:end` (or when their author disconnects mid-stroke), shapes and text when they're added. Undo deletes the item and *Clear board* deletes the whole board. Points still being drawn aren't written, so Redis traffic stays at one write per finished item.
- **Draw order**: each item gets a per-room sequence number when it's started, and a reload sorts by it. Strokes that finish out of order still come back in the order they were drawn, which matters for the eraser.
- **Expiry**: each board is one Redis hash (`wb:board:<room>`, item id → JSON) with a 7-day TTL that is pushed back whenever the board is opened or changed. Idle boards expire on their own; there's nothing to clean up.

This is a single-server design: one process owns each room's live state. Running several servers would need pub/sub to relay messages between them, which isn't built yet.

## Project structure

```
server.js        HTTP + WebSocket server, message routing, saving
rooms.js         live room state and validation
storage.js       board storage: Redis and in-memory implementations
rooms.test.js    unit tests (node:test)
storage.test.js  storage tests (Redis ones run when TEST_REDIS_URL is set)
public/
  main.js        picks the start menu or the board based on ?room=
  lobby.js       start menu: new board, join by code or link, recent boards
  board.js       canvas, camera (pan/zoom), tools, presence
  shared.js      room codes, saved name, recent boards
```
