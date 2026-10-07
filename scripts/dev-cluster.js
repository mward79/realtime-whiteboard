// Runs two whiteboard servers sharing one Redis, for trying multi-server rooms
// locally: npm run dev:cluster, then open :3000 and :3001 in two windows.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ports = [3000, 3001];
const server = fileURLToPath(new URL('../server.js', import.meta.url));
const children = new Set();
let stopping = false;

function start(port) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const prefix = `[${port}] `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => process.stdout.write(chunk.toString().replace(/^(?=.)/gm, prefix)));
  }
  console.log(`${prefix}pid ${child.pid} (kill -9 ${child.pid} to simulate a crash)`);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) console.log(`${prefix}exited (${signal ?? code}). The other server keeps running.`);
    if (children.size === 0) process.exit(0);
  });
}

function stop() {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (process.env.REDIS_URL?.startsWith('memory:')) {
  console.error('dev:cluster needs Redis: in-memory mode cannot share rooms between processes.');
  process.exit(1);
}
ports.forEach(start);
