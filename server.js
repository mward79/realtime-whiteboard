import express from 'express';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { RoomManager, isCoord } from './rooms.js';

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
app.get('/health', (_req, res) => res.send('ok'));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const rooms = new RoomManager();
const socketsByRoom = new Map(); // roomId -> Set<WebSocket>

const clean = (v, max) => (v ?? '').toString().replace(/[^\w\- ]/g, '').trim().slice(0, max);

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(roomId, msg, except) {
  const data = JSON.stringify(msg);
  for (const peer of socketsByRoom.get(roomId) ?? []) {
    if (peer !== except && peer.readyState === peer.OPEN) peer.send(data);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = clean(url.searchParams.get('room'), 32).toLowerCase() || 'lobby';
  const name = clean(url.searchParams.get('name'), 24) || 'Guest';

  const room = rooms.get(roomId);
  const userId = randomUUID();
  const user = room.addUser(userId, name);

  if (!socketsByRoom.has(roomId)) socketsByRoom.set(roomId, new Set());
  socketsByRoom.get(roomId).add(ws);

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

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
        if (item) broadcast(roomId, { type: 'item:add', item }, ws);
        else send(ws, { type: 'stroke:rejected', id: msg.id });
        break;
      }

      case 'stroke:end':
        room.endStroke(userId, msg.id);
        break;

      case 'stroke:remove':
        if (room.removeStroke(userId, msg.id)) {
          broadcast(roomId, { type: 'stroke:remove', id: msg.id }, ws);
        }
        break;

      case 'clear':
        room.clear();
        broadcast(roomId, { type: 'clear' }, ws);
        break;
    }
  });

  ws.on('close', () => {
    room.removeUser(userId);
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

server.listen(PORT, () => console.log(`Whiteboard running at http://localhost:${PORT}`));
