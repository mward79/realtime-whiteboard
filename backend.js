import { MemoryStorage, RedisStorage } from './storage.js';
import { MemoryCluster, RedisCluster } from './cluster.js';

// REDIS_URL=memory:// keeps boards and presence in process memory: one server,
// nothing survives a restart. Anything else is a Redis URL.
export async function createBackend(url, { serverId } = {}) {
  if (url.startsWith('memory:')) {
    const cluster = new MemoryCluster(undefined, { serverId });
    await cluster.start();
    return { storage: new MemoryStorage(), cluster };
  }

  const client = await connectRedis(url);
  const cluster = new RedisCluster(client, { serverId });
  await cluster.start(); // opens the separate subscriber connection
  return { storage: new RedisStorage(client), cluster };
}

async function connectRedis(url) {
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
  return client;
}
