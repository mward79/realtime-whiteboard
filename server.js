import express from 'express';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { RoomManager, isCoord } from './rooms.js';
import { createStorage } from './storage.js';

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const app = express();
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
app.get('/health', (_req, res) => res.send('ok'));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const storage = await createStorage(REDIS_URL);
const rooms = new RoomManager(storage);
const socketsByRoom = new Map(); // roomId -> Set<WebSocket>

const clean = (v, max) => (v ?? '').toString().replace(/[^\w\- ]/g, '').trim().slice(0, max);

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Storage writes run in the background; the live room in memory is the source of
// truth while people are connected, so a failed write is logged, not fatal.
function persist(promise) {
  promise.catch((err) => console.error('Storage write failed:', err.message));
}

function broadcast(roomId, msg, except) {
  const data = JSON.stringify(msg);
  for (const peer of socketsByRoom.get(roomId) ?? []) {
    if (peer !== except && peer.readyState === peer.OPEN) peer.send(data);
  }
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = clean(url.searchParams.get('room'), 32).toLowerCase() || 'lobby';
  const name = clean(url.searchParams.get('name'), 24) || 'Guest';

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  let room;
  try {
    room = await rooms.open(roomId);
  } catch (err) {
    console.error(`Could not load room ${roomId}:`, err.message);
    ws.close(1011, 'Could not load board');
    return;
  }
  // They may have given up while the board was loading.
  if (ws.readyState !== ws.OPEN) {
    rooms.release(roomId);
    return;
  }

  const userId = randomUUID();
  const user = room.addUser(userId, name);

  if (!socketsByRoom.has(roomId)) socketsByRoom.set(roomId, new Set());
  socketsByRoom.get(roomId).add(ws);

  // Late joiners get the full board state, including strokes still being drawn.
  send(ws, { type: 'welcome', you: user, ...room.snapshot() });
  broadcast(roomId, { type: 'user:join', user }, ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'cursor':
        if (isCoord(msg.x) && isCoord(msg.y)) {
          broadcast(roomId, { type: 'cursor', userId, x: msg.x, y: msg.y }, ws);
        }
        break;

      case 'stroke:begin': {
        const stroke = room.beginStroke(userId, msg);
        if (stroke) broadcast(roomId, { type: 'stroke:begin', stroke }, ws);
        else send(ws, { type: 'stroke:rejected', id: msg.id });
        break;
      }

      case 'stroke:points':
        if (room.addPoints(userId, msg.id, msg.points)) {
          broadcast(roomId, { type: 'stroke:points', id: msg.id, points: msg.points }, ws);
        }
        break;

      case 'item:add': {
        const item = room.addItem(userId, msg);
        if (item) {
          broadcast(roomId, { type: 'item:add', item }, ws);
          persist(storage.putItem(roomId, item));
        } else {
          send(ws, { type: 'stroke:rejected', id: msg.id });
        }
        break;
      }

      case 'stroke:end': {
        const stroke = room.endStroke(userId, msg.id);
        if (stroke) persist(storage.putItem(roomId, stroke));
        break;
      }

      case 'stroke:remove':
        if (room.removeStroke(userId, msg.id)) {
          broadcast(roomId, { type: 'stroke:remove', id: msg.id }, ws);
          persist(storage.removeItem(roomId, msg.id));
        }
        break;

      case 'clear':
        room.clear();
        broadcast(roomId, { type: 'clear' }, ws);
        persist(storage.clear(roomId));
        break;
    }
  });

  ws.on('close', () => {
    for (const stroke of room.removeUser(userId)) persist(storage.putItem(roomId, stroke));
    const peers = socketsByRoom.get(roomId);
    peers.delete(ws);
    if (peers.size === 0) socketsByRoom.delete(roomId);
    broadcast(roomId, { type: 'user:leave', userId });
    rooms.release(roomId);
  });
});

// Drop connections that silently died (closed laptop lid, lost wifi).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// On deploys, save strokes still being drawn and let queued writes finish.
async function shutdown() {
  clearInterval(heartbeat);
  for (const roomId of socketsByRoom.keys()) {
    const room = rooms.rooms.get(roomId);
    for (const user of room ? [...room.users.keys()] : []) {
      for (const stroke of room.removeUser(user)) persist(storage.putItem(roomId, stroke));
    }
  }
  for (const ws of wss.clients) ws.close(1012, 'Server restarting');
  server.close();
  await storage.close().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

server.listen(PORT, () => console.log(`Whiteboard running at http://localhost:${PORT} (storage: ${storage.constructor.name})`));
