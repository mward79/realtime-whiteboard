const PALETTE = ['#1d1d1b', '#2557d6', '#d6352a', '#1f8a4c', '#e58a00', '#8a3ffc'];

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const cursorsEl = document.getElementById('cursors');
const peopleEl = document.getElementById('people');
const statusEl = document.getElementById('status');

// ---------- Room and identity ----------
const params = new URLSearchParams(location.search);
let roomId = params.get('room');
if (!roomId) {
  roomId = Math.random().toString(36).slice(2, 8);
  params.set('room', roomId);
  history.replaceState(null, '', `?${params}`);
}
document.getElementById('room-name').textContent = roomId;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function loadName() {
  try {
    const saved = localStorage.getItem('wb-name');
    if (saved) return saved;
  } catch {}
  const name = `${pick(['Quick', 'Calm', 'Bold', 'Sly', 'Bright', 'Lucky'])} ${pick(['Otter', 'Heron', 'Lynx', 'Moth', 'Newt', 'Finch'])}`;
  try { localStorage.setItem('wb-name', name); } catch {}
  return name;
}
const myName = loadName();
const newId = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

const state = {
  me: null,
  users: new Map(),
  strokes: new Map(),
  myStrokeIds: [],
  color: PALETTE[0],
  size: 4,
  erasing: false,
  current: null,
  pending: [],
};

// ---------- Rendering ----------
function drawFrom(s, start) {
  const p = s.points;
  ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ctx.fillStyle = s.erase ? '#000' : s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], s.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const from = Math.max(1, start);
  ctx.beginPath();
  ctx.moveTo(p[from - 1][0], p[from - 1][1]);
  for (let i = from; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
  ctx.stroke();
}

function redraw() {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  for (const s of state.strokes.values()) drawFrom(s, 0);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}
addEventListener('resize', resize);
resize();

// ---------- Networking ----------
let ws;
let retry = 0;

function setStatus(text) { statusEl.textContent = text; }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(myName)}`);
  ws.onopen = () => { retry = 0; setStatus(''); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    setStatus('Connection lost. Reconnecting…');
    const delay = Math.min(1000 * 2 ** retry++, 10000);
    setTimeout(connect, delay);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      state.me = msg.you;
      state.users = new Map(msg.users.map((u) => [u.id, u]));
      state.strokes = new Map(msg.strokes.map((s) => [s.id, s]));
      state.myStrokeIds = [];
      state.current = null;
      for (const id of [...cursorEls.keys()]) removeCursor(id);
      renderPeople();
      redraw();
      break;
    case 'user:join':
      state.users.set(msg.user.id, msg.user);
      renderPeople();
      break;
    case 'user:leave':
      state.users.delete(msg.userId);
      removeCursor(msg.userId);
      renderPeople();
      break;
    case 'cursor':
      moveCursor(msg.userId, msg.x, msg.y);
      break;
    case 'stroke:begin':
      state.strokes.set(msg.stroke.id, msg.stroke);
      drawFrom(msg.stroke, 0);
      break;
    case 'stroke:points': {
      const s = state.strokes.get(msg.id);
      if (!s) break;
      const start = s.points.length;
      s.points.push(...msg.points);
      drawFrom(s, start);
      break;
    }
    case 'stroke:remove':
    case 'stroke:rejected':
      state.myStrokeIds = state.myStrokeIds.filter((id) => id !== msg.id);
      if (state.strokes.delete(msg.id)) redraw();
      break;
    case 'clear':
      state.strokes.clear();
      state.myStrokeIds = [];
      redraw();
      break;
  }
}

// ---------- Drawing input ----------
const pt = (e) => [Math.round(e.clientX * 10) / 10, Math.round(e.clientY * 10) / 10];

let flushQueued = false;
function scheduleFlush() {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(flush);
}
// Batch points once per frame instead of one message per mousemove.
function flush() {
  flushQueued = false;
  const s = state.current;
  if (!s) return;
  while (state.pending.length) {
    send({ type: 'stroke:points', id: s.id, points: state.pending.splice(0, 200) });
  }
}

let cursorPos = null;
let cursorTimer = null;
function queueCursor(p) {
  cursorPos = p;
  if (cursorTimer) return;
  cursorTimer = setTimeout(() => {
    cursorTimer = null;
    send({ type: 'cursor', x: cursorPos[0], y: cursorPos[1] });
  }, 40);
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.me) return;
  canvas.setPointerCapture(e.pointerId);
  const point = pt(e);
  const s = {
    id: newId(),
    userId: state.me.id,
    color: state.color,
    size: state.erasing ? state.size * 4 : state.size,
    erase: state.erasing,
    points: [point],
  };
  state.current = s;
  state.pending = [];
  state.strokes.set(s.id, s);
  drawFrom(s, 0);
  send({ type: 'stroke:begin', id: s.id, color: s.color, size: s.size, erase: s.erase, point });
});

canvas.addEventListener('pointermove', (e) => {
  queueCursor(pt(e));
  const s = state.current;
  if (!s) return;
  const events = e.getCoalescedEvents?.() ?? [e];
  const start = s.points.length;
  for (const ev of events) {
    const p = pt(ev);
    const last = s.points[s.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) continue;
    s.points.push(p);
    state.pending.push(p);
  }
  if (s.points.length > start) {
    drawFrom(s, start);
    scheduleFlush();
  }
});

function endStroke() {
  const s = state.current;
  if (!s) return;
  flush();
  send({ type: 'stroke:end', id: s.id });
  state.myStrokeIds.push(s.id);
  state.current = null;
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// ---------- Presence ----------
const cursorEls = new Map();

function moveCursor(id, x, y) {
  const user = state.users.get(id);
  if (!user) return;
  let el = cursorEls.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cursor';
    el.style.setProperty('--c', user.color);
    el.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 2 L16 8 L9.5 10 L7.5 16 Z" style="fill:var(--c)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span>';
    el.querySelector('span').textContent = user.name;
    cursorsEl.append(el);
    cursorEls.set(id, el);
  }
  el.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
  el.classList.remove('idle');
  clearTimeout(el.idleTimer);
  el.idleTimer = setTimeout(() => el.classList.add('idle'), 4000);
}

function removeCursor(id) {
  cursorEls.get(id)?.remove();
  cursorEls.delete(id);
}

function renderPeople() {
  const initials = (n) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  peopleEl.replaceChildren(
    ...[...state.users.values()].map((u) => {
      const li = document.createElement('li');
      li.style.setProperty('--c', u.color);
      li.textContent = initials(u.name);
      li.title = u.id === state.me?.id ? `${u.name} (you)` : u.name;
      return li;
    })
  );
}

// ---------- Toolbar ----------
const swatchesEl = document.getElementById('swatches');
const eraserBtn = document.getElementById('eraser');

function selectColor(color) {
  state.color = color;
  state.erasing = false;
  eraserBtn.setAttribute('aria-pressed', 'false');
  for (const b of swatchesEl.children) b.setAttribute('aria-pressed', String(b.dataset.color === color));
}

PALETTE.forEach((color, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.color = color;
  b.style.setProperty('--c', color);
  b.setAttribute('aria-label', `Color ${i + 1}`);
  b.addEventListener('click', () => selectColor(color));
  swatchesEl.append(b);
});
selectColor(PALETTE[0]);

eraserBtn.addEventListener('click', () => {
  state.erasing = !state.erasing;
  eraserBtn.setAttribute('aria-pressed', String(state.erasing));
});

document.getElementById('size').addEventListener('input', (e) => (state.size = Number(e.target.value)));

function undo() {
  const id = state.myStrokeIds.pop();
  if (!id) return;
  state.strokes.delete(id);
  redraw();
  send({ type: 'stroke:remove', id });
}
document.getElementById('undo').addEventListener('click', undo);

document.getElementById('clear').addEventListener('click', () => {
  if (!confirm('Clear the board for everyone in this room?')) return;
  state.strokes.clear();
  state.myStrokeIds = [];
  redraw();
  send({ type: 'clear' });
});

const shareBtn = document.getElementById('share');
shareBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    shareBtn.textContent = 'Link copied';
  } catch {
    shareBtn.textContent = 'Copy the URL from your address bar';
  }
  setTimeout(() => (shareBtn.textContent = 'Copy invite link'), 2000);
});

addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  }
});

connect();
