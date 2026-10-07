// Owns this server's live rooms and keeps them in step with other servers.
//
// For a message from one of our clients: validate it against the room, show it
// to our other clients, save it if it's finished, and publish it so the other
// servers can do the same for theirs. For an event published by another server:
// apply it to our copy of the room and pass it on to our clients.
//
// A room is live on this server while any of our clients are in it: we're
// subscribed to its channel and hold its state in memory. When our last client
// leaves we unsubscribe and drop it; storage and presence keep the rest.

import { randomUUID } from 'node:crypto';
import { Room, isCoord } from './rooms.js';
import { HEARTBEAT_MS } from './cluster.js';

export class Hub {
  // deliver(roomId, msg, exceptUserId) sends to this server's clients in the room.
  constructor({ storage, cluster, deliver, sweepMs = HEARTBEAT_MS, log = console }) {
    this.storage = storage;
    this.cluster = cluster;
    this.deliver = deliver;
    this.sweepMs = sweepMs;
    this.log = log;
    this.rooms = new Map(); // roomId -> Room, for rooms we have clients in
    this.local = new Map(); // roomId -> Set<userId> connected to this server
    this.opening = new Map(); // roomId -> Promise<Room>, so simultaneous joins share one load
    this.pending = new Set();
  }

  start() {
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref?.();
  }

  // Storage writes and publishes run in the background. The room in memory is
  // what our clients see, so a failed write is logged rather than fatal.
  write(promise) {
    const p = promise.catch((err) => this.log.error('Redis write failed:', err.message));
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  publish(roomId, event) {
    this.write(this.cluster.publish(roomId, event));
  }

  async flush() {
    while (this.pending.size) await Promise.all(this.pending);
  }

  // ---------- Opening and closing rooms ----------

  async open(roomId) {
    const live = this.rooms.get(roomId);
    if (live) return live;
    if (!this.opening.has(roomId)) {
      this.opening.set(roomId, this.load(roomId).finally(() => this.opening.delete(roomId)));
    }
    return this.opening.get(roomId);
  }

  // Subscribe before reading the board and presence, so nothing published while
  // they load is missed. Events that arrive meanwhile are held and replayed on
  // top; applying one that the load already included is harmless.
  async load(roomId) {
    const held = [];
    let ready = false;
    await this.cluster.subscribe(roomId, (event) => (ready ? this.onRemote(roomId, event) : held.push(event)));
    try {
      const [items, users] = await Promise.all([this.storage.load(roomId), this.cluster.presence(roomId)]);
      const room = new Room(roomId);
      room.restore(items);
      for (const user of users) room.users.set(user.id, user);
      this.rooms.set(roomId, room);
      this.local.set(roomId, new Set());
      ready = true;
      for (const event of held) this.onRemote(roomId, event);
      return room;
    } catch (err) {
      await this.cluster.unsubscribe(roomId).catch(() => {});
      throw err;
    }
  }

  evict(roomId) {
    this.rooms.delete(roomId);
    this.local.delete(roomId);
    this.write(this.cluster.unsubscribe(roomId));
  }

  onRemote(roomId, event) {
    const msg = this.rooms.get(roomId)?.applyRemote(event);
    if (msg) this.deliver(roomId, msg);
  }

  // ---------- People ----------

  async join(roomId, name) {
    const room = await this.open(roomId);
    if (this.rooms.get(roomId) !== room) return this.join(roomId, name); // evicted while we waited
    const user = room.addUser(randomUUID(), name);
    this.local.get(roomId).add(user.id);
    this.deliver(roomId, { type: 'user:join', user }, user.id);
    // Presence is written before the join is published, and removed before the
    // leave is, so a server reading presence while subscribed never misses one.
    this.write(this.cluster.addPresence(roomId, user));
    this.publish(roomId, { type: 'user:join', user });
    // Late joiners get the full board state, including strokes still being drawn.
    return { user, welcome: { type: 'welcome', you: user, ...room.snapshot() } };
  }

  leave(roomId, userId) {
    const local = this.local.get(roomId);
    if (!local?.delete(userId)) return;
    this.write(this.cluster.removePresence(roomId, userId));
    this.depart(roomId, userId);
    if (local.size === 0) this.evict(roomId);
  }

  // Someone left, from this server or (when reaped) a crashed one. Their
  // unfinished strokes are finished, saved, and sent in full to the other servers.
  depart(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const stroke of room.removeUser(userId)) {
      this.write(this.storage.putItem(roomId, stroke));
      this.publish(roomId, { type: 'stroke:end', stroke });
    }
    this.deliver(roomId, { type: 'user:leave', userId });
    this.publish(roomId, { type: 'user:leave', userId });
  }

  // Runs every heartbeat: reap users of crashed servers, put back any of ours
  // that were reaped by mistake, and correct our list if we missed a join or leave.
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const roomId of [...this.rooms.keys()]) {
        for (const user of await this.cluster.reapDead(roomId)) this.depart(roomId, user.id);

        const room = this.rooms.get(roomId);
        if (!room) continue;
        const ours = [...this.local.get(roomId)].map((id) => room.users.get(id)).filter(Boolean);
        for (const user of await this.cluster.assertPresence(roomId, ours)) {
          this.publish(roomId, { type: 'user:join', user });
        }

        // Joins and leaves can arrive while this read is in flight, so only
        // correct entries the read can speak for: drop people we knew about
        // before it started, and never re-add someone we've seen leave.
        const knownBefore = [...room.users.keys()];
        const present = await this.cluster.presence(roomId);
        if (this.rooms.get(roomId) !== room) continue;
        const ids = new Set(present.map((u) => u.id));
        for (const user of present) {
          if (!room.users.has(user.id) && !room.departed.has(user.id)) this.onRemote(roomId, { type: 'user:join', user });
        }
        for (const id of knownBefore) {
          if (!ids.has(id) && room.users.has(id) && !this.local.get(roomId).has(id)) {
            this.onRemote(roomId, { type: 'user:leave', userId: id });
          }
        }
      }
    } catch (err) {
      this.log.error('Presence sweep failed:', err.message);
    } finally {
      this.sweeping = false;
    }
  }

  // ---------- Board messages from our clients ----------

  // Returns a reply for the sender, if any.
  handle(roomId, userId, msg) {
    const room = this.rooms.get(roomId);
    if (!room || !this.local.get(roomId).has(userId)) return;

    // Show it to our other clients and publish it to the other servers.
    const relay = (event, forClients = event) => {
      this.deliver(roomId, forClients, userId);
      this.publish(roomId, event);
    };

    switch (msg.type) {
      case 'cursor':
        if (isCoord(msg.x) && isCoord(msg.y)) relay({ type: 'cursor', userId, x: msg.x, y: msg.y });
        return;

      case 'stroke:begin': {
        const stroke = room.beginStroke(userId, msg);
        if (!stroke) return { type: 'stroke:rejected', id: msg.id };
        relay({ type: 'stroke:begin', stroke });
        return;
      }

      case 'stroke:points':
        if (room.addPoints(userId, msg.id, msg.points)) relay({ type: 'stroke:points', id: msg.id, points: msg.points });
        return;

      // Saved before it's published, so a server that loads the board after
      // missing the message still finds it in storage.
      case 'stroke:end': {
        const stroke = room.endStroke(userId, msg.id);
        if (!stroke) return;
        this.write(this.storage.putItem(roomId, stroke));
        this.publish(roomId, { type: 'stroke:end', stroke });
        return;
      }

      case 'item:add': {
        const item = room.addItem(userId, msg);
        if (!item) return { type: 'stroke:rejected', id: msg.id };
        this.write(this.storage.putItem(roomId, item));
        relay({ type: 'item:add', item });
        return;
      }

      case 'stroke:remove':
        if (room.removeStroke(userId, msg.id)) {
          this.write(this.storage.removeItem(roomId, msg.id));
          relay({ type: 'stroke:remove', id: msg.id });
        }
        return;

      case 'clear': {
        const upTo = room.clear();
        this.write(this.storage.clear(roomId));
        relay({ type: 'clear', upTo }, { type: 'clear' });
        return;
      }
    }
  }

  // Graceful shutdown: everyone here leaves properly (strokes saved, presence
  // removed, departures published) before the connections close.
  async close() {
    clearInterval(this.timer);
    for (const [roomId, users] of [...this.local]) {
      for (const userId of [...users]) this.leave(roomId, userId);
    }
    await this.flush();
  }
}
