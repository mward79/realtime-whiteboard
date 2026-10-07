import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, RedisStorage, BOARD_TTL_SECONDS } from './storage.js';
import { Room, RoomManager, PALETTE } from './rooms.js';

const item = (id, seq, extra = {}) => ({
  id,
  seq,
  userId: 'u',
  kind: 'path',
  color: PALETTE[0],
  size: 4,
  erase: false,
  points: [[0, 0], [10, 10]],
  done: true,
  ...extra,
});

// The same behaviour is required of every storage implementation.
function storageContract(makeStorage) {
  let storage;
  before(async () => (storage = await makeStorage()));

  test('an unknown board loads empty', async () => {
    assert.deepEqual(await storage.load('nothing-here'), []);
  });

  test('items load back in draw order, not save order', async () => {
    await storage.putItem('order', item('c', 2));
    await storage.putItem('order', item('a', 0));
    await storage.putItem('order', item('b', 1, { erase: true, color: null }));
    const loaded = await storage.load('order');
    assert.deepEqual(loaded.map((i) => i.id), ['a', 'b', 'c']);
    assert.equal(loaded[1].erase, true);
  });

  test('saved items round-trip without live-only fields', async () => {
    const text = item('t', 0, { kind: 'text', points: [[5, 5]], text: 'hi\nthere' });
    await storage.putItem('roundtrip', text);
    const [loaded] = await storage.load('roundtrip');
    const { done, ...expected } = text;
    assert.deepEqual(loaded, expected);
  });

  test('removeItem deletes one item (undo)', async () => {
    await storage.putItem('undo', item('a', 0));
    await storage.putItem('undo', item('b', 1));
    await storage.removeItem('undo', 'a');
    await storage.removeItem('undo', 'missing');
    assert.deepEqual((await storage.load('undo')).map((i) => i.id), ['b']);
  });

  test('clear deletes the whole board, and only that board', async () => {
    await storage.putItem('clear-me', item('a', 0));
    await storage.putItem('keep-me', item('a', 0));
    await storage.clear('clear-me');
    assert.deepEqual(await storage.load('clear-me'), []);
    assert.equal((await storage.load('keep-me')).length, 1);
  });

  test('saving an item twice keeps one copy', async () => {
    await storage.putItem('twice', item('a', 0));
    await storage.putItem('twice', item('a', 0));
    assert.equal((await storage.load('twice')).length, 1);
  });

  return () => storage;
}

describe('MemoryStorage', () => {
  storageContract(() => new MemoryStorage());

  test('a board expires after the TTL without activity', async () => {
    let now = 0;
    const storage = new MemoryStorage({ ttlSeconds: 60, now: () => now });
    await storage.putItem('r', item('a', 0));
    now = 59_000;
    assert.equal((await storage.load('r')).length, 1, 'still there just before the TTL');
    now = 59_000 + 60_000;
    assert.deepEqual(await storage.load('r'), [], 'gone once idle for the TTL');
  });

  test('opening or changing a board pushes its expiry back', async () => {
    let now = 0;
    const storage = new MemoryStorage({ ttlSeconds: 60, now: () => now });
    await storage.putItem('r', item('a', 0));
    for (let i = 0; i < 5; i++) {
      now += 50_000;
      await storage.load('r');
    }
    assert.equal((await storage.load('r')).length, 1);
  });

  test('the default TTL is 7 days', () => {
    assert.equal(BOARD_TTL_SECONDS, 604800);
  });
});

// Runs only when a Redis is available, e.g. TEST_REDIS_URL=redis://localhost:6379 npm test
const redisUrl = process.env.TEST_REDIS_URL;
describe('RedisStorage', { skip: !redisUrl && 'set TEST_REDIS_URL to run against Redis' }, () => {
  let client;
  const prefix = `wb:test:${process.pid}:${Date.now()}:`;

  const getStorage = storageContract(async () => {
    const { createClient } = await import('redis');
    client = createClient({ url: redisUrl });
    await client.connect();
    return new RedisStorage(client, { prefix });
  });

  after(async () => {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) await client.del(keys);
    await client.close();
  });

  test('writes and loads set a 7-day TTL on the board key', async () => {
    const storage = getStorage();
    await storage.putItem('ttl', item('a', 0));
    await client.expire(`${prefix}ttl`, 10);
    await storage.load('ttl');
    const ttl = await client.ttl(`${prefix}ttl`);
    assert.ok(ttl > BOARD_TTL_SECONDS - 5 && ttl <= BOARD_TTL_SECONDS, `ttl was ${ttl}`);
  });

  test('a corrupt entry is skipped instead of failing the load', async () => {
    const storage = getStorage();
    await storage.putItem('corrupt', item('a', 0));
    await client.hSet(`${prefix}corrupt`, 'bad', '{not json');
    assert.deepEqual((await storage.load('corrupt')).map((i) => i.id), ['a']);
  });
});

describe('RoomManager with storage', () => {
  test('a room is loaded from storage the first time someone joins', async () => {
    const storage = new MemoryStorage();
    await storage.putItem('r', item('old', 0));
    const rooms = new RoomManager(storage);
    const room = await rooms.open('r');
    assert.deepEqual([...room.strokes.keys()], ['old']);
    assert.equal(room.strokes.get('old').done, true, 'loaded strokes cannot be extended');
  });

  test('simultaneous joins share one load and one room', async () => {
    const storage = new MemoryStorage();
    let loads = 0;
    const load = storage.load.bind(storage);
    storage.load = (id) => (loads++, load(id));
    const rooms = new RoomManager(storage);
    const [a, b] = await Promise.all([rooms.open('r'), rooms.open('r')]);
    assert.equal(a, b);
    await rooms.open('r');
    assert.equal(loads, 1, 'cached after the first load');
  });

  test('an empty room is dropped from memory and reloaded from storage', async () => {
    const storage = new MemoryStorage();
    const rooms = new RoomManager(storage);
    const room = await rooms.open('r');
    room.addUser('a', 'Ada');
    rooms.release('r');
    assert.ok(rooms.rooms.has('r'), 'kept while someone is in it');
    room.removeUser('a');
    rooms.release('r');
    assert.ok(!rooms.rooms.has('r'));
    assert.notEqual(await rooms.open('r'), room);
  });

  test('a failed load is not cached, so the next join retries', async () => {
    const storage = new MemoryStorage();
    storage.load = async () => {
      throw new Error('down');
    };
    const rooms = new RoomManager(storage);
    await assert.rejects(rooms.open('r'));
    delete storage.load;
    assert.ok(await rooms.open('r'));
  });

  test('draw order survives a reload even when strokes finish out of order', async () => {
    const storage = new MemoryStorage();
    const room = new Room('r');
    const begin = (user, id, extra = {}) =>
      room.beginStroke(user, { id, color: PALETTE[0], size: 4, point: [0, 0], ...extra });

    begin('a', 'first');
    begin('b', 'eraser', { erase: true });
    await storage.putItem('r', room.endStroke('b', 'eraser'));
    await storage.putItem('r', room.addItem('b', { id: 'box', kind: 'rect', color: PALETTE[1], size: 2, points: [[0, 0], [5, 5]] }));
    await storage.putItem('r', room.endStroke('a', 'first')); // finished last, drawn first

    const reloaded = new Room('r');
    reloaded.restore(await storage.load('r'));
    assert.deepEqual([...reloaded.strokes.keys()], [...room.strokes.keys()]);
    assert.deepEqual([...reloaded.strokes.keys()], ['first', 'eraser', 'box']);

    // New items after a reload still go on top.
    const next = reloaded.addItem('c', { id: 'later', kind: 'line', color: PALETTE[0], size: 2, points: [[0, 0], [1, 1]] });
    assert.ok(next.seq > reloaded.strokes.get('box').seq);
  });
});

describe('Room events the server persists', () => {
  test('endStroke returns the stroke only the first time', () => {
    const room = new Room('r');
    room.beginStroke('a', { id: 's', color: PALETTE[0], size: 4, point: [0, 0] });
    assert.equal(room.endStroke('a', 's').id, 's');
    assert.equal(room.endStroke('a', 's'), null);
    assert.equal(room.endStroke('b', 's'), null);
  });

  test('leaving returns the strokes it cut off so they can be saved', () => {
    const room = new Room('r');
    room.addUser('a', 'Ada');
    room.beginStroke('a', { id: 'done', color: PALETTE[0], size: 4, point: [0, 0] });
    room.endStroke('a', 'done');
    room.beginStroke('a', { id: 'open', color: PALETTE[0], size: 4, point: [0, 0] });
    assert.deepEqual(room.removeUser('a').map((s) => s.id), ['open']);
  });
});
