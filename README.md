![Tests](https://github.com/mward79/realtime-whiteboard/actions/workflows/test.yml/badge.svg)

(https://realtime-whiteboard-kddd.onrender.com)

# Real-time collaborative whiteboard

![Two servers syncing a board through Redis pub/sub](docs/whiteboard.gif)

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
| `HEARTBEAT_MS` | `5000`                | How often each server proves it's alive and checks for crashed ones. A crashed server's users disappear after about 3–4 heartbeats. |
| `SERVER_ID` | random                   | Name this server uses on the pub/sub bus. Must be unique per running process; leave it unset unless you need stable names in logs. |

If Redis can't be reached at startup the server exits with an error saying so. If Redis drops out while it's running, people can keep drawing: writes queue up and are sent when it reconnects.

To also run the Redis tests (storage, plus the multi-server suite over real pub/sub; they're skipped otherwise):

```bash
TEST_REDIS_URL=redis://localhost:6379 npm test
```

The tests only touch keys under a unique `wb:test:` prefix and delete them afterwards.

### Testing with two servers

Several servers can share rooms through Redis. To try it locally with Redis running:

```bash
npm run dev:cluster    # starts servers on :3000 and :3001, sharing one Redis
```

1. Open `http://localhost:3000/?room=test` in one window and `http://localhost:3001/?room=test` in another. Different ports count as different sites to the browser, so each window gets its own name. You can also use a private window.
2. Each window shows both avatars. Draw, type and add shapes in one, and they appear in the other along with its cursor. Undo and *Clear board* carry across too.
3. Open a third window on either port: it gets the whole board, including a stroke someone on the other server is still drawing.
4. To simulate a crash, run the `kill -9 <pid>` command printed at startup for one server. Its users vanish from the other window within about 20 seconds (3 missed heartbeats plus one check), and anything they were halfway through drawing is kept. Ctrl+C stops both servers cleanly.

To see what the servers keep in Redis: `redis-cli hgetall wb:presence:test` (who's in the room, and on which server), `redis-cli keys 'wb:server:*'` (live servers), and `redis-cli subscribe wb:room:test` (every event as it's published).

## Deploying on Render

1. In the Render dashboard, create a **Key Value** instance (Render's Redis-compatible store) in the same region as the web service.
2. Copy its **Internal Key Value URL** (`redis://red-…:6379`).
3. On the web service, add an environment variable `REDIS_URL` with that URL, and redeploy.

> **Free Key Value instances have no disk persistence.** Data lives only in memory, so every board is wiped whenever the instance restarts (maintenance, upgrades, or a crash). That's fine for trying things out; use a paid instance, which persists to disk, if boards need to survive restarts. On a small instance, an `allkeys-lru` eviction policy drops the least recently used boards when memory fills up, instead of refusing new writes.

To run more than one instance, give them all the same `REDIS_URL`. Any instance can serve any client, so the load balancer needs no sticky sessions.

Web service restarts and redeploys are safe either way: the server saves strokes still being drawn on `SIGTERM` before exiting, and boards reload from Redis when people reconnect.

## How it works

The server (Node, `ws`) keeps each room's strokes in memory. Clients draw locally right away for zero-latency feel, then stream the stroke to the server in batches (one message per animation frame, not per mouse event). The server validates every message (ownership, palette, size, coordinate bounds, payload limits) and relays it to everyone else in the room. Late joiners receive a full snapshot, including strokes still being drawn. Cursor updates are throttled to ~25/s. A heartbeat drops dead connections, and clients reconnect with exponential backoff.

Shapes and text are sent as a single `item:add` message once finished, and the server validates them the same way. Everything is stored in world coordinates, so each person can pan and zoom independently.

Room logic lives in `rooms.js` with no networking, so it's unit tested in isolation.

### Persistence

The in-memory rooms are the live state; Redis is the durable copy. `storage.js` defines a small interface (`load`, `putItem`, `removeItem`, `clear`) with two implementations, `RedisStorage` and `MemoryStorage` (used by the tests and by `REDIS_URL=memory://`), and the server is the only thing that calls it:

- **Loading**: the first person to join a room loads it from storage; people joining at the same time share that one load. When the last person leaves, the room is dropped from memory.
- **Saving**: items are written once they're finished: freehand and eraser strokes on `stroke:end` (or when their author disconnects mid-stroke), shapes and text when they're added. Undo deletes the item and *Clear board* deletes the whole board. Points still being drawn aren't written, so Redis traffic stays at one write per finished item.
- **Draw order**: each item gets a sequence number when it's started, and a reload sorts by it. Strokes that finish out of order still come back in the order they were drawn, which matters for the eraser. Numbers come from the server's clock, but never fall below a number that server has already seen in the room, so items from several servers sort consistently without a round trip to Redis.
- **Expiry**: each board is one Redis hash (`wb:board:<room>`, item id → JSON) with a 7-day TTL that is pushed back whenever the board is opened or changed. Idle boards expire on their own; there's nothing to clean up.

### Multiple servers

`hub.js` holds each server's live rooms, and `cluster.js` connects the servers. It has a Redis implementation and an in-memory one, used for `memory://` and to test several "servers" in one process.

- **Relaying**: a message from a client is validated and saved as before, then published to the room's channel `wb:room:<room>`, tagged with the server's id. Each server subscribes to the channels of rooms it has users in, on a second Redis connection (subscribing ties up a connection), and unsubscribes when its last user there leaves. Events from other servers are applied to its copy of the room and passed on to its clients; its own come back from Redis and are ignored.
- **One write per change**: only the server that received a change saves it. When a stroke finishes, the whole stroke is published, so a server that opened the room halfway through still ends up with all of it.
- **Joining a room**: the server subscribes first, then loads the board and presence. Anything published during the load is held and replayed afterwards. A replayed *Clear board* only removes items drawn before it, so it can't wipe newer ones.
- **Presence**: `wb:presence:<room>` is a Redis hash of user → name, color and server, written before a join is announced and removed before a leave is. Everyone in a room is listed in the welcome, wherever they're connected, and colors are picked to differ across servers.
- **Crashes**: each server refreshes `wb:server:<id>` every heartbeat, with a 3-heartbeat expiry. Every heartbeat, each server checks the presence of its open rooms and removes users whose server's key has expired. Removal is an atomic `HDEL`, so exactly one server wins. That server saves the users' unfinished strokes and announces they've left. The same check puts back the server's own users if they were removed by mistake (say Redis was unreachable for a while), and corrects any join or leave a server missed.

Pub/sub delivers each message at most once: events published while a server's subscriber is reconnecting are lost to it. The board catches up as strokes finish (each carries the full stroke) and presence on the next heartbeat check. A stroke that was undone during that gap can stay visible on that server until the room is reopened.

## Project structure

```
server.js        HTTP + WebSocket server: connections in, messages to the hub
hub.js           live rooms: validate, save, publish, apply other servers' events
rooms.js         room state and validation (no I/O)
cluster.js       pub/sub, presence and heartbeats: Redis and in-memory implementations
storage.js       board storage: Redis and in-memory implementations
backend.js       picks Redis or in-memory from REDIS_URL
scripts/
  dev-cluster.js npm run dev:cluster: two servers on :3000 and :3001
*.test.js        node:test suites (Redis ones run when TEST_REDIS_URL is set)
public/
  main.js        picks the start menu or the board based on ?room=
  lobby.js       start menu: new board, join by code or link, recent boards
  board.js       canvas, camera (pan/zoom), tools, presence
  shared.js      room codes, saved name, recent boards
```
