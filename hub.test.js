// Several Hubs sharing one storage and one bus behave like several server
// processes sharing one Redis. The suite runs on the in-memory bus always, and
// on real Redis pub/sub too when TEST_REDIS_URL is set.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from './hub.js';
import { MemoryBus, MemoryCluster, RedisCluster } from './cluster.js';
import { MemoryStorage, RedisStorage } from './storage.js';
import { PALETTE } from './rooms.js';

const silent = { error() {} };
const P = PALETTE[0];

// Polls until fn() stops throwing, so tests don't depend on exact timing.
async function eventually(fn, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

const memoryBackend = {
  name: 'in-memory bus',
  async create() {
    const bus = new MemoryBus();
    const storage = new MemoryStorage();
    return {
      storage,
      async cluster() {
        const cluster = new MemoryCluster(bus);
        await cluster.start();
        return cluster;
      },
      crash: (cluster) => cluster.crash(),
      presenceIds: async (roomId) => [...bus.presence.get(roomId)?.keys() ?? []],
      subscribed: async (cluster, roomId) => bus.subscribers.get(roomId)?.has(cluster.serverId) ?? false,
      dropPresence: async (roomId, userId) => bus.presence.get(roomId).delete(userId),
      async close() {},
    };
  },
};

const redisUrl = process.env.TEST_REDIS_URL;
const redisBackend = {
  name: 'Redis',
  skip: !redisUrl && 'set TEST_REDIS_URL to run against Redis',
  async create() {
    const { createClient } = await import('redis');
    const prefix = `wb:test:${process.pid}:${Math.random().toString(36).slice(2)}:`;
    const clients = [];
    const connect = async () => {
      const c = createClient({ url: redisUrl });
      await c.connect();
      clients.push(c);
      return c;
    };
    const admin = await connect();
    const clusters = [];
    return {
      storage: new RedisStorage(await connect(), { prefix: `${prefix}board:` }),
      async cluster() {
        const cluster = new RedisCluster(await connect(), { prefix, heartbeatMs: 200 });
        await cluster.start();
        clusters.push(cluster);
        return cluster;
      },
      // Like kill -9: no cleanup, heartbeat stops, the key expires on its own.
      async crash(cluster) {
        clearInterval(cluster.timer);
        cluster.sub.destroy();
        await eventually(async () => assert.equal(await admin.exists(cluster.serverKey(cluster.serverId)), 0), 2000);
      },
      presenceIds: async (roomId) => admin.hKeys(`${prefix}presence:${roomId}`),
      subscribed: async (cluster, roomId) => (await admin.pubSubNumSub(`${prefix}room:${roomId}`))[`${prefix}room:${roomId}`] > 0,
      dropPresence: (roomId, userId) => admin.hDel(`${prefix}presence:${roomId}`, userId),
      async close() {
        for (const c of clusters) {
          clearInterval(c.timer);
          if (c.sub.isOpen) await c.sub.close();
        }
        const keys = await admin.keys(`${prefix}*`);
        if (keys.length) await admin.del(keys);
        for (const c of clients) if (c.isOpen) await c.close();
      },
    };
  },
};

for (const backend of [memoryBackend, redisBackend]) {
  describe(`Hubs sharing rooms (${backend.name})`, { skip: backend.skip }, () => {
    const envs = [];
    after(async () => {
      for (const env of envs) await env.close();
    });

    // A fake server: a Hub plus an inbox per connected user standing in for their socket.
    async function setup() {
      const env = await backend.create();
      envs.push(env);
      const servers = [];
      env.server = async () => {
        const cluster = await env.cluster();
        const inbox = new Map();
        const hub = new Hub({
          storage: env.storage,
          cluster,
          log: silent,
          deliver(roomId, msg, except) {
            for (const [id, box] of inbox) if (id !== except && box.roomId === roomId) box.push(msg);
          },
        });
        const server = {
          hub,
          cluster,
          async join(roomId, name) {
            const { user, welcome } = await hub.join(roomId, name);
            const box = [];
            box.roomId = roomId;
            inbox.set(user.id, box);
            return { ...user, welcome, inbox: box, send: (msg) => hub.handle(roomId, user.id, msg), leave: () => (inbox.delete(user.id), hub.leave(roomId, user.id)) };
          },
        };
        servers.push(server);
        return server;
      };
      return env;
    }

    const types = (box) => box.map((m) => m.type);

    test('board changes reach clients on the other server, and are never echoed back', async () => {
      const env = await setup();
      const a = await env.server();
      const b = await env.server();
      const ada = await a.join('r1', 'Ada');
      const bo = await b.join('r1', 'Bo');

      ada.send({ type: 'cursor', x: 1, y: 2 });
      ada.send({ type: 'stroke:begin', id: 's1', color: P, size: 4, point: [0, 0] });
      ada.send({ type: 'stroke:points', id: 's1', points: [[1, 1]] });
      ada.send({ type: 'stroke:end', id: 's1' });
      ada.send({ type: 'item:add', id: 'box', kind: 'rect', color: P, size: 2, points: [[0, 0], [9, 9]] });
      ada.send({ type: 'item:add', id: 'note', kind: 'text', color: P, size: 20, points: [[3, 3]], text: 'hi' });
      ada.send({ type: 'stroke:remove', id: 'box' });

      await eventually(() =>
        assert.deepEqual(types(bo.inbox).filter((t) => t !== 'user:join'), ['cursor', 'stroke:begin', 'stroke:points', 'item:add', 'item:add', 'stroke:remove'])
      );
      assert.deepEqual(bo.inbox.find((m) => m.type === 'cursor'), { type: 'cursor', userId: ada.id, x: 1, y: 2 });
      assert.deepEqual([...b.hub.rooms.get('r1').strokes.keys()], ['s1', 'note']);
      assert.equal(b.hub.rooms.get('r1').strokes.get('s1').points.length, 2);

      bo.send({ type: 'clear' });
      await eventually(() => assert.equal(a.hub.rooms.get('r1').strokes.size, 0));
      assert.deepEqual(types(ada.inbox), ['user:join', 'clear'], 'Ada only hears from Bo, never her own messages');
      assert.ok(!types(bo.inbox).includes('clear'));
    });

    test('only the server that received a change saves it', async () => {
      const env = await setup();
      const a = await env.server();
      const b = await env.server();
      const ada = await a.join('r2', 'Ada');
      await b.join('r2', 'Bo');
      let writes = 0;
      const put = env.storage.putItem.bind(env.storage);
      env.storage.putItem = (...args) => (writes++, put(...args));

      ada.send({ type: 'item:add', id: 'x', kind: 'line', color: P, size: 2, points: [[0, 0], [1, 1]] });
      await eventually(async () => assert.ok(b.hub.rooms.get('r2').strokes.has('x')));
      await a.hub.flush();
      await b.hub.flush();
      assert.equal(writes, 1);
      assert.deepEqual((await env.storage.load('r2')).map((i) => i.id), ['x']);
    });

    test('presence is shared: people on other servers are in the welcome and join/leave live', async () => {
      const env = await setup();
      const a = await env.server();
      const b = await env.server();
      const ada = await a.join('r3', 'Ada');
      await a.hub.flush();
      const bo = await b.join('r3', 'Bo');
      assert.deepEqual(bo.welcome.users.map((u) => u.name).sort(), ['Ada', 'Bo']);
      assert.notEqual(bo.color, ada.color, 'colors are picked across servers');

      await eventually(() => assert.ok(ada.inbox.some((m) => m.type === 'user:join' && m.user.id === bo.id)));
      bo.leave();
      await eventually(() => assert.ok(ada.inbox.some((m) => m.type === 'user:leave' && m.userId === bo.id)));
      assert.deepEqual([...a.hub.rooms.get('r3').users.keys()], [ada.id]);
      await b.hub.flush();
      assert.deepEqual(await env.presenceIds('r3'), [ada.id]);
    });

    test('a server subscribes while it has clients in a room and unsubscribes after the last leaves', async () => {
      const env = await setup();
      const a = await env.server();
      const one = await a.join('r4', 'One');
      const two = await a.join('r4', 'Two');
      assert.equal(await env.subscribed(a.cluster, 'r4'), true);
      one.leave();
      assert.equal(await env.subscribed(a.cluster, 'r4'), true);
      two.leave();
      await a.hub.flush();
      assert.equal(await env.subscribed(a.cluster, 'r4'), false);
      assert.ok(!a.hub.rooms.has('r4'));

      await a.join('r4', 'Three');
      assert.equal(await env.subscribed(a.cluster, 'r4'), true);
    });

    test('a stroke started before another server opened the room arrives whole when it ends', async () => {
      const env = await setup();
      const a = await env.server();
      const b = await env.server();
      const ada = await a.join('r5', 'Ada');
      ada.send({ type: 'stroke:begin', id: 'long', color: P, size: 4, point: [0, 0] });
      ada.send({ type: 'stroke:points', id: 'long', points: [[1, 1], [2, 2]] });

      const bo = await b.join('r5', 'Bo'); // B had no copy of the room until now
      assert.ok(!bo.welcome.strokes.some((s) => s.id === 'long'));
      ada.send({ type: 'stroke:end', id: 'long' });
      await eventually(() => {
        const added = bo.inbox.find((m) => m.type === 'item:add');
        assert.equal(added?.item.id, 'long');
        assert.equal(added.item.points.length, 3);
      });
    });

    test('a crashed server\'s users are removed everywhere, announced once, and their strokes kept', async () => {
      const env = await setup();
      const a = await env.server();
      const b = await env.server();
      const c = await env.server();
      const ada = await a.join('r6', 'Ada');
      const cy = await c.join('r6', 'Cy');
      const bo = await b.join('r6', 'Bo');
      bo.send({ type: 'stroke:begin', id: 'cut', color: P, size: 4, point: [0, 0] });
      bo.send({ type: 'stroke:points', id: 'cut', points: [[5, 5]] });
      await eventually(() => assert.equal(a.hub.rooms.get('r6').strokes.get('cut')?.points.length, 2));
      await eventually(() => assert.equal(c.hub.rooms.get('r6').strokes.get('cut')?.points.length, 2));

      await env.crash(b.cluster);
      await Promise.all([a.hub.sweep(), c.hub.sweep()]);

      for (const box of [ada.inbox, cy.inbox]) {
        await eventually(() => assert.equal(box.filter((m) => m.type === 'user:leave' && m.userId === bo.id).length, 1));
      }
      assert.deepEqual((await env.presenceIds('r6')).sort(), [ada.id, cy.id].sort());
      await a.hub.flush();
      await c.hub.flush();
      const saved = await env.storage.load('r6');
      assert.deepEqual(saved.map((s) => s.id), ['cut'], 'the unfinished stroke is saved by whoever reaped Bo');
      assert.equal(saved[0].points.length, 2);
    });

    test('a server puts its users back if they were reaped by mistake', async () => {
      const env = await setup();
      const a = await env.server();
      const b = await env.server();
      const ada = await a.join('r7', 'Ada');
      const bo = await b.join('r7', 'Bo');
      await a.hub.flush();
      await env.dropPresence('r7', ada.id); // as if A's heartbeat had lapsed
      bo.inbox.length = 0;

      await a.hub.sweep();
      await eventually(async () => assert.ok((await env.presenceIds('r7')).includes(ada.id)));
      await eventually(() => assert.ok(b.hub.rooms.get('r7').users.has(ada.id)));
    });

    test('sweeps fix a missed leave without dropping our own users', async () => {
      const env = await setup();
      const a = await env.server();
      const ada = await a.join('r8', 'Ada');
      await a.hub.flush();
      const room = a.hub.rooms.get('r8');
      room.users.set('ghost', { id: 'ghost', name: 'Ghost', color: P }); // a leave we never heard about
      await a.hub.sweep();
      assert.deepEqual([...room.users.keys()], [ada.id]);
      assert.ok(ada.inbox.some((m) => m.type === 'user:leave' && m.userId === 'ghost'));
    });

    test('everything drawn on any server reloads in the same order every server shows', async () => {
      const env = await setup();
      const a = await env.server();
      const b = await env.server();
      const ada = await a.join('r9', 'Ada');
      const bo = await b.join('r9', 'Bo');
      ada.send({ type: 'stroke:begin', id: 'a1', color: P, size: 4, point: [0, 0] });
      await eventually(() => assert.ok(b.hub.rooms.get('r9').strokes.has('a1')));
      bo.send({ type: 'stroke:begin', id: 'b1', color: null, erase: true, size: 4, point: [0, 0] });
      bo.send({ type: 'stroke:end', id: 'b1' });
      await eventually(() => assert.ok(a.hub.rooms.get('r9').strokes.has('b1')));
      ada.send({ type: 'item:add', id: 'a2', kind: 'rect', color: P, size: 2, points: [[0, 0], [1, 1]] });
      ada.send({ type: 'stroke:end', id: 'a1' });
      await eventually(() => assert.ok(b.hub.rooms.get('r9').strokes.has('a2')));

      const order = (hub) => hub.rooms.get('r9').snapshot().strokes.map((s) => s.id);
      assert.deepEqual(order(a.hub), ['a1', 'b1', 'a2']);
      assert.deepEqual(order(b.hub), ['a1', 'b1', 'a2']);
      await a.hub.flush();
      await b.hub.flush();
      assert.deepEqual((await env.storage.load('r9')).map((s) => s.id), ['a1', 'b1', 'a2']);
    });

    test('changes made while a server is loading a room are not lost, and a late clear wipes only older items', async () => {
      const env = await setup();
      const a = await env.server();
      const b = await env.server();
      const ada = await a.join('r10', 'Ada');
      ada.send({ type: 'item:add', id: 'old', kind: 'line', color: P, size: 2, points: [[0, 0], [1, 1]] });
      await a.hub.flush();

      // Hold B's board load open until Ada has cleared and drawn something new.
      let release;
      const gate = new Promise((r) => (release = r));
      const load = env.storage.load.bind(env.storage);
      env.storage.load = async (id) => {
        const items = await load(id);
        await gate;
        return items;
      };
      const joining = b.join('r10', 'Bo');
      await eventually(async () => assert.equal(await env.subscribed(b.cluster, 'r10'), true));
      ada.send({ type: 'clear' });
      ada.send({ type: 'item:add', id: 'new', kind: 'line', color: P, size: 2, points: [[0, 0], [1, 1]] });
      await a.hub.flush();
      await new Promise((r) => setTimeout(r, 50)); // let B hold those events
      release();
      const bo = await joining;
      env.storage.load = load;

      assert.deepEqual(bo.welcome.strokes.map((s) => s.id), ['new']);
    });

    test('simultaneous joins share one load, and a failed load is retried by the next join', async () => {
      const env = await setup();
      const a = await env.server();
      let loads = 0;
      const load = env.storage.load.bind(env.storage);
      env.storage.load = async (id) => {
        loads++;
        if (loads === 1) throw new Error('down');
        return load(id);
      };
      await assert.rejects(a.join('r11', 'Ada'));
      assert.equal(await env.subscribed(a.cluster, 'r11'), false, 'unsubscribed after the failure');
      const [one, two] = await Promise.all([a.join('r11', 'One'), a.join('r11', 'Two')]);
      env.storage.load = load;
      assert.equal(loads, 2);
      assert.deepEqual(two.welcome.users.map((u) => u.id).sort(), [one.id, two.id].sort());
    });
  });
}
