// Lets several server processes share rooms. Every implementation provides:
//
//   serverId                         unique per process; tags everything it publishes
//   start() / close()
//   subscribe(roomId, listener)      listener(event) gets events published by OTHER servers
//   unsubscribe(roomId)
//   publish(roomId, event)
//   addPresence(roomId, user)        presence = who is in a room, across all servers
//   removePresence(roomId, userId)   -> true only for the caller that actually removed it
//   presence(roomId)                 -> users whose server is still alive
//   reapDead(roomId)                 -> users of crashed servers that THIS call removed
//   assertPresence(roomId, users)    -> users that had gone missing and were re-added
//
// Servers prove they're alive with a heartbeat. When one stops (crash, kill -9,
// lost network), the others reap its users from presence. Removal is atomic, so
// exactly one server announces each departure.

import { randomUUID } from 'node:crypto';

export const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 5000;
const PRESENCE_TTL_SECONDS = 24 * 60 * 60; // backstop for rooms nobody reopens

const publicUser = ({ id, name, color }) => ({ id, name, color });

export class RedisCluster {
  // `client` is the shared connection for commands and publishing; subscribing
  // needs a connection of its own, which start() creates.
  constructor(client, { serverId = randomUUID(), heartbeatMs = HEARTBEAT_MS, prefix = 'wb:' } = {}) {
    this.client = client;
    this.serverId = serverId;
    this.heartbeatMs = heartbeatMs;
    this.prefix = prefix;
    this.listeners = new Map(); // roomId -> listener
    this.onMessage = this.onMessage.bind(this);
  }

  channel(roomId) { return `${this.prefix}room:${roomId}`; }
  presenceKey(roomId) { return `${this.prefix}presence:${roomId}`; }
  serverKey(serverId) { return `${this.prefix}server:${serverId}`; }

  async start() {
    this.sub = this.client.duplicate();
    this.sub.on('error', (err) => console.error('Redis subscriber error:', err.message));
    await this.sub.connect();
    await this.beat();
    this.timer = setInterval(() => this.beat().catch((err) => console.error('Heartbeat failed:', err.message)), this.heartbeatMs);
    this.timer.unref?.();
  }

  // Missing three beats in a row counts as dead.
  beat() {
    return this.client.set(this.serverKey(this.serverId), String(Date.now()), { PX: this.heartbeatMs * 3 });
  }

  async close() {
    clearInterval(this.timer);
    await this.client.del(this.serverKey(this.serverId)).catch(() => {});
    await this.sub?.close().catch(() => {});
  }

  onMessage(message, channel) {
    const roomId = channel.slice(this.channel('').length);
    const listener = this.listeners.get(roomId);
    if (!listener) return;
    let envelope;
    try {
      envelope = JSON.parse(message);
    } catch {
      return;
    }
    if (envelope.server !== this.serverId) listener(envelope.event);
  }

  async subscribe(roomId, listener) {
    this.listeners.set(roomId, listener);
    await this.sub.subscribe(this.channel(roomId), this.onMessage);
  }

  async unsubscribe(roomId) {
    this.listeners.delete(roomId);
    await this.sub.unsubscribe(this.channel(roomId), this.onMessage);
  }

  publish(roomId, event) {
    return this.client.publish(this.channel(roomId), JSON.stringify({ server: this.serverId, event }));
  }

  async addPresence(roomId, user) {
    const key = this.presenceKey(roomId);
    await this.client
      .multi()
      .hSet(key, user.id, JSON.stringify({ ...publicUser(user), server: this.serverId }))
      .expire(key, PRESENCE_TTL_SECONDS)
      .exec();
  }

  async removePresence(roomId, userId) {
    return (await this.client.hDel(this.presenceKey(roomId), userId)) === 1;
  }

  // -> [{ user, alive }] for every entry in the room's presence hash
  async entries(roomId) {
    const raw = await this.client.hGetAll(this.presenceKey(roomId));
    const entries = [];
    for (const json of Object.values(raw)) {
      try {
        entries.push(JSON.parse(json));
      } catch {}
    }
    const servers = [...new Set(entries.map((e) => e.server))];
    const beats = servers.length ? await this.client.mGet(servers.map((s) => this.serverKey(s))) : [];
    const alive = new Set(servers.filter((_, i) => beats[i] !== null));
    return entries.map((e) => ({ user: publicUser(e), alive: alive.has(e.server) }));
  }

  async presence(roomId) {
    return (await this.entries(roomId)).filter((e) => e.alive).map((e) => e.user);
  }

  async reapDead(roomId) {
    const reaped = [];
    for (const { user, alive } of await this.entries(roomId)) {
      if (!alive && (await this.removePresence(roomId, user.id))) reaped.push(user);
    }
    return reaped;
  }

  // If this server missed enough heartbeats (say Redis was unreachable for a
  // while), others may have reaped its users even though they're still here.
  async assertPresence(roomId, users) {
    if (!users.length) return [];
    const key = this.presenceKey(roomId);
    const tx = this.client.multi();
    for (const u of users) tx.hSet(key, u.id, JSON.stringify({ ...publicUser(u), server: this.serverId }));
    tx.expire(key, PRESENCE_TTL_SECONDS);
    const added = await tx.exec();
    return users.filter((_, i) => Number(added[i]) === 1);
  }
}

// In-process stand-in for Redis pub/sub and presence. One bus = one "Redis";
// several MemoryClusters on the same bus behave like servers sharing it. Used
// by REDIS_URL=memory:// (a single server) and by the tests (several).
export class MemoryBus {
  constructor() {
    this.subscribers = new Map(); // roomId -> Map<serverId, listener>
    this.presence = new Map(); // roomId -> Map<userId, { user, server }>
    this.alive = new Set();
  }
}

export class MemoryCluster {
  constructor(bus = new MemoryBus(), { serverId = randomUUID() } = {}) {
    this.bus = bus;
    this.serverId = serverId;
  }

  async start() { this.bus.alive.add(this.serverId); }

  async close() {
    this.bus.alive.delete(this.serverId);
    for (const subs of this.bus.subscribers.values()) subs.delete(this.serverId);
  }

  // Tests: stop like a crashed process would, without any cleanup.
  crash() {
    this.bus.alive.delete(this.serverId);
    for (const subs of this.bus.subscribers.values()) subs.delete(this.serverId);
  }

  async subscribe(roomId, listener) {
    if (!this.bus.subscribers.has(roomId)) this.bus.subscribers.set(roomId, new Map());
    this.bus.subscribers.get(roomId).set(this.serverId, listener);
  }

  async unsubscribe(roomId) {
    this.bus.subscribers.get(roomId)?.delete(this.serverId);
  }

  // Delivered asynchronously and in order, like Redis.
  async publish(roomId, event) {
    const copy = JSON.parse(JSON.stringify(event));
    for (const serverId of this.bus.subscribers.get(roomId)?.keys() ?? []) {
      if (serverId !== this.serverId) setImmediate(() => this.bus.subscribers.get(roomId)?.get(serverId)?.(copy));
    }
  }

  room(roomId) {
    if (!this.bus.presence.has(roomId)) this.bus.presence.set(roomId, new Map());
    return this.bus.presence.get(roomId);
  }

  async addPresence(roomId, user) {
    this.room(roomId).set(user.id, { user: publicUser(user), server: this.serverId });
  }

  async removePresence(roomId, userId) {
    return this.room(roomId).delete(userId);
  }

  async presence(roomId) {
    return [...this.room(roomId).values()].filter((e) => this.bus.alive.has(e.server)).map((e) => e.user);
  }

  async reapDead(roomId) {
    const reaped = [];
    for (const [id, e] of this.room(roomId)) {
      if (!this.bus.alive.has(e.server)) {
        this.room(roomId).delete(id);
        reaped.push(e.user);
      }
    }
    return reaped;
  }

  async assertPresence(roomId, users) {
    const missing = users.filter((u) => !this.room(roomId).has(u.id));
    for (const u of users) await this.addPresence(roomId, u);
    return missing;
  }
}
