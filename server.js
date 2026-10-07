import express from 'express';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createBackend } from './backend.js';
import { Hub } from './hub.js';

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const { storage, cluster } = await createBackend(REDIS_URL, { serverId: process.env.SERVER_ID });

const app = express();
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
app.get('/health', (_req, res) => res.set('X-Server-Id', cluster.serverId).send('ok'));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const socketsByRoom = new Map(); // roomId -> Map<userId, WebSocket>, this server's clients only

const clean = (v, max) => (v ?? '').toString().replace(/[^\w\- ]/g, '').trim().slice(0, max);

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const hub = new Hub({
  storage,
  cluster,
  deliver(roomId, msg, exceptUserId) {
    const data = JSON.stringify(msg);
    for (const [userId, ws] of socketsByRoom.get(roomId) ?? []) {
      if (userId !== exceptUserId && ws.readyState === ws.OPEN) ws.send(data);
    }
  },
});
hub.start();

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = clean(url.searchParams.get('room'), 32).toLowerCase() || 'lobby';
  const name = clean(url.searchParams.get('name'), 24) || 'Guest';

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  let joined;
  try {
    joined = await hub.join(roomId, name);
  } catch (err) {
    console.error(`Could not load room ${roomId}:`, err.message);
    ws.close(1011, 'Could not load board');
    return;
  }
  const { user, welcome } = joined;
  // They may have given up while the board was loading.
  if (ws.readyState !== ws.OPEN) {
    hub.leave(roomId, user.id);
    return;
  }

  if (!socketsByRoom.has(roomId)) socketsByRoom.set(roomId, new Map());
  socketsByRoom.get(roomId).set(user.id, ws);
  send(ws, welcome);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const reply = hub.handle(roomId, user.id, msg);
    if (reply) send(ws, reply);
  });

  ws.on('close', () => {
    const peers = socketsByRoom.get(roomId);
    peers?.delete(user.id);
    if (peers?.size === 0) socketsByRoom.delete(roomId);
    hub.leave(roomId, user.id);
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

// On deploys: everyone leaves properly (unfinished strokes saved, presence
// removed, other servers told), then the connections close.
async function shutdown() {
  clearInterval(heartbeat);
  await hub.close();
  for (const ws of wss.clients) ws.close(1012, 'Server restarting');
  server.close();
  await cluster.close().catch(() => {});
  await storage.close().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`Whiteboard running at http://localhost:${PORT} (server ${cluster.serverId.slice(0, 8)}, ${storage.constructor.name})`);
});
