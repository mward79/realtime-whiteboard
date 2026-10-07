// Durable board storage. The live room state stays in memory (rooms.js); this
// layer only saves finished items and loads a board when its room is opened.
//
// Every implementation provides:
//   load(roomId)             -> Promise<item[]>  finished items, in draw order (by item.seq)
//   putItem(roomId, item)    -> Promise          save or overwrite one finished item
//   removeItem(roomId, id)   -> Promise          delete one item (undo)
//   clear(roomId)            -> Promise          delete the whole board
//   close()                  -> Promise
//
// load, putItem and removeItem push the board's expiry back, so a board
// disappears once nobody has opened or changed it for the TTL.

export const BOARD_TTL_SECONDS = 7 * 24 * 60 * 60;

const byDrawOrder = (a, b) => a.seq - b.seq;

// Stored items are always finished; `done` is live-only state.
const serialize = ({ done, ...item }) => JSON.stringify(item);

export class MemoryStorage {
  constructor({ ttlSeconds = BOARD_TTL_SECONDS, now = Date.now } = {}) {
    this.ttlMs = ttlSeconds * 1000;
    this.now = now;
    this.boards = new Map(); // roomId -> { items: Map<id, json>, expiresAt }
  }

  board(roomId, create) {
    let board = this.boards.get(roomId);
    if (board && board.expiresAt <= this.now()) {
      this.boards.delete(roomId);
      board = undefined;
    }
    if (!board && create) {
      board = { items: new Map(), expiresAt: 0 };
      this.boards.set(roomId, board);
    }
    if (board) board.expiresAt = this.now() + this.ttlMs;
    return board;
  }

  async load(roomId) {
    const board = this.board(roomId, false);
    if (!board) return [];
    return [...board.items.values()].map((json) => JSON.parse(json)).sort(byDrawOrder);
  }

  async putItem(roomId, item) {
    this.board(roomId, true).items.set(item.id, serialize(item));
  }

  async removeItem(roomId, id) {
    this.board(roomId, false)?.items.delete(id);
  }

  async clear(roomId) {
    this.boards.delete(roomId);
  }

  async close() {}
}

// One hash per board: field = item id, value = item JSON. Draw order comes from
// each item's seq, so removing an item never has to reshuffle anything.
export class RedisStorage {
  constructor(client, { ttlSeconds = BOARD_TTL_SECONDS, prefix = 'wb:board:' } = {}) {
    this.client = client;
    this.ttl = ttlSeconds;
    this.prefix = prefix;
  }

  key(roomId) {
    return this.prefix + roomId;
  }

  async load(roomId) {
    const key = this.key(roomId);
    const [fields] = await this.client.multi().hGetAll(key).expire(key, this.ttl).exec();
    const items = [];
    for (const json of Object.values(fields ?? {})) {
      try {
        items.push(JSON.parse(json));
      } catch {
        // skip a corrupt entry rather than losing the whole board
      }
    }
    return items.sort(byDrawOrder);
  }

  async putItem(roomId, item) {
    const key = this.key(roomId);
    await this.client.multi().hSet(key, item.id, serialize(item)).expire(key, this.ttl).exec();
  }

  async removeItem(roomId, id) {
    const key = this.key(roomId);
    await this.client.multi().hDel(key, id).expire(key, this.ttl).exec();
  }

  async clear(roomId) {
    await this.client.del(this.key(roomId));
  }

  async close() {
    await this.client.close();
  }
}

// REDIS_URL=memory:// keeps boards in process memory, for working without Redis.
export async function createStorage(url) {
  if (url.startsWith('memory:')) return new MemoryStorage();
  const { createClient } = await import('redis');
  let connected = false;
  const client = createClient({
    url,
    socket: {
      // Give up quickly at startup so a missing Redis is obvious; once running,
      // keep retrying (writes queue up meanwhile and are sent on reconnect).
      reconnectStrategy: (retries, err) => (!connected && retries >= 3 ? err : Math.min(200 * 2 ** retries, 5000)),
    },
  });
  client.on('error', (err) => {
    if (connected) console.error('Redis error:', err.message);
  });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Could not connect to Redis at ${url} (${err.message}). Start Redis, or set REDIS_URL=memory:// to run without it.`);
  }
  connected = true;
  return new RedisStorage(client);
}
