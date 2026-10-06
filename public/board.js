import { PALETTE, newId, loadName, roomFromUrl, roomUrl, rememberRoom } from './shared.js';

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const cursorsEl = document.getElementById('cursors');
const peopleEl = document.getElementById('people');
const statusEl = document.getElementById('status');
const zoomLabel = document.getElementById('zoom-level');

// ---------- Room and identity ----------
const roomId = roomFromUrl();
if (new URLSearchParams(location.search).get('room') !== roomId) history.replaceState(null, '', roomUrl(roomId));
document.getElementById('board-ui').hidden = false;
document.getElementById('room-name').textContent = roomId;
document.title = `${roomId} · Whiteboard`;
rememberRoom(roomId);

const myName = loadName();

const SHAPES = ['rect', 'ellipse', 'line', 'arrow'];
const FONT = "'Bricolage Grotesque', system-ui, sans-serif";
const LINE_HEIGHT = 1.25;
const textSize = () => 12 + state.size * 2;

const state = {
  me: null,
  users: new Map(),
  strokes: new Map(), // every item on the board (paths, shapes, text), in draw order
  myStrokeIds: [],
  color: PALETTE[0],
  size: 4,
  tool: 'pen',
  current: null, // freehand stroke being drawn
  preview: null, // shape being dragged out, not yet sent
  pending: [],
};
const cursorEls = new Map(); // userId -> remote cursor element

// The camera maps world coordinates (what's stored and sent) to the screen.
const cam = { x: 0, y: 0, z: 1 };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const WORLD_LIMIT = 90000; // server rejects coordinates beyond ±100000

const toWorld = (sx, sy) => [sx / cam.z + cam.x, sy / cam.z + cam.y];
const toScreen = (wx, wy) => [(wx - cam.x) * cam.z, (wy - cam.y) * cam.z];
const round = (v) => Math.round(v * 10) / 10;
const pt = (e) => toWorld(e.clientX, e.clientY).map(round);

// ---------- Rendering ----------
let dpr = 1;

function applyCamera() {
  const k = dpr * cam.z;
  ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
}

function setInk(s) {
  ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ctx.fillStyle = s.erase ? '#000' : s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function drawPath(s, start) {
  const p = s.points;
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

function drawShape(s) {
  const [[x1, y1], [x2, y2]] = s.points;
  ctx.beginPath();
  if (s.kind === 'rect') {
    ctx.rect(x1, y1, x2 - x1, y2 - y1);
  } else if (s.kind === 'ellipse') {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    if (s.kind === 'arrow') {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(12, s.size * 3);
      for (const side of [-1, 1]) {
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(angle + (side * Math.PI) / 6), y2 - head * Math.sin(angle + (side * Math.PI) / 6));
      }
    }
  }
  ctx.stroke();
}

function drawText(s) {
  const [x, y] = s.points[0];
  const lh = s.size * LINE_HEIGHT;
  ctx.font = `${s.size}px ${FONT}`;
  ctx.textBaseline = 'top';
  // Offset matches how the text editor centers glyphs in its line box.
  s.text.split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * lh + (lh - s.size) / 2));
}

function drawItem(s, start = 0) {
  setInk(s);
  if (s.kind === 'text') drawText(s);
  else if (SHAPES.includes(s.kind)) drawShape(s);
  else drawPath(s, start);
}

function redraw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyCamera();
  for (const s of state.strokes.values()) drawItem(s);
  if (state.preview) drawItem(state.preview);
}

let redrawQueued = false;
function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    redraw();
  });
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  redraw();
}
addEventListener('resize', resize);
resize();
document.fonts?.ready.then(redraw);

// ---------- Camera ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function cameraChanged() {
  cam.x = clamp(cam.x, -WORLD_LIMIT, WORLD_LIMIT - innerWidth / cam.z);
  cam.y = clamp(cam.y, -WORLD_LIMIT, WORLD_LIMIT - innerHeight / cam.z);
  const body = document.body.style;
  body.setProperty('--grid-x', `${-cam.x * cam.z}px`);
  body.setProperty('--grid-y', `${-cam.y * cam.z}px`);
  body.setProperty('--grid-minor', `${24 * cam.z}px`);
  body.setProperty('--grid-major', `${120 * cam.z}px`);
  document.body.classList.toggle('zoomed-out', cam.z < 0.5);
  zoomLabel.textContent = `${Math.round(cam.z * 100)}%`;
  for (const id of cursorEls.keys()) placeCursor(id);
  placeEditor();
  scheduleRedraw();
}

function panBy(dx, dy) {
  cam.x += dx / cam.z;
  cam.y += dy / cam.z;
  cameraChanged();
}

// Zoom while keeping the world point under (sx, sy) fixed on screen.
function zoomAt(sx, sy, z) {
  const [wx, wy] = toWorld(sx, sy);
  cam.z = clamp(z, MIN_ZOOM, MAX_ZOOM);
  cam.x = wx - sx / cam.z;
  cam.y = wy - sy / cam.z;
  cameraChanged();
}

const zoomCenter = (factor) => zoomAt(innerWidth / 2, innerHeight / 2, cam.z * factor);

function resetView() {
  cam.x = cam.y = 0;
  cam.z = 1;
  cameraChanged();
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel notch is ~100,
    // so cap the step to keep one notch around 25%.
    if (e.ctrlKey || e.metaKey) return zoomAt(e.clientX, e.clientY, cam.z * Math.exp(-clamp(dy, -22, 22) * 0.01));
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    panBy(dx, dy);
  },
  { passive: false }
);

document.getElementById('zoom-in').addEventListener('click', () => zoomCenter(1.25));
document.getElementById('zoom-out').addEventListener('click', () => zoomCenter(0.8));
zoomLabel.addEventListener('click', resetView);

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
      state.preview = null;
      gesture = null;
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
      drawItem(msg.stroke);
      break;
    case 'item:add':
      state.strokes.set(msg.item.id, msg.item);
      drawItem(msg.item);
      break;
    case 'stroke:points': {
      const s = state.strokes.get(msg.id);
      if (!s) break;
      const start = s.points.length;
      s.points.push(...msg.points);
      drawItem(s, start);
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

// ---------- Board items ----------
function addItem(fields) {
  if (!state.me) return;
  const item = { id: newId(), userId: state.me.id, color: state.color, erase: false, ...fields };
  state.strokes.set(item.id, item);
  state.myStrokeIds.push(item.id);
  scheduleRedraw();
  const { id, kind, color, size, points, text } = item;
  send({ type: 'item:add', id, kind, color, size, points, text });
}

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

function beginStroke(point) {
  const erase = state.tool === 'eraser';
  const s = {
    id: newId(),
    userId: state.me.id,
    kind: 'path',
    color: state.color,
    size: erase ? state.size * 4 : state.size,
    erase,
    points: [point],
  };
  state.current = s;
  state.pending = [];
  state.strokes.set(s.id, s);
  drawItem(s);
  send({ type: 'stroke:begin', id: s.id, color: s.color, size: s.size, erase: s.erase, point });
}

function extendStroke(e) {
  const s = state.current;
  const events = e.getCoalescedEvents?.() ?? [e];
  const start = s.points.length;
  for (const ev of events) {
    const p = pt(ev);
    const last = s.points[s.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5 / cam.z) continue;
    s.points.push(p);
    state.pending.push(p);
  }
  if (s.points.length > start) {
    applyCamera();
    drawItem(s, start);
    scheduleFlush();
  }
}

function endStroke() {
  const s = state.current;
  if (!s) return;
  flush();
  send({ type: 'stroke:end', id: s.id });
  state.myStrokeIds.push(s.id);
  state.current = null;
}

// A second finger landed mid-stroke: it was meant as a pinch, not a drawing.
function abortStroke() {
  const s = state.current;
  if (!s) return;
  send({ type: 'stroke:end', id: s.id });
  send({ type: 'stroke:remove', id: s.id });
  state.strokes.delete(s.id);
  state.current = null;
  scheduleRedraw();
}

// ---------- Text editor ----------
let editor = null; // { el, point, size, color }
const measureCtx = document.createElement('canvas').getContext('2d');

function openEditor(point) {
  const el = document.createElement('textarea');
  el.className = 'text-editor';
  el.rows = 1;
  el.maxLength = 1000;
  el.spellcheck = false;
  el.setAttribute('aria-label', 'Text on the board. Enter to place, Shift+Enter for a new line, Escape to cancel.');
  editor = { el, point, size: textSize(), color: state.color };
  el.style.color = editor.color;
  el.addEventListener('input', placeEditor);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor(false);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      closeEditor(true);
    }
  });
  el.addEventListener('blur', () => closeEditor(true));
  document.getElementById('board-ui').append(el);
  placeEditor();
  requestAnimationFrame(() => el.focus());
}

function placeEditor() {
  if (!editor) return;
  const { el, point, size } = editor;
  const [sx, sy] = toScreen(...point);
  const fontPx = size * cam.z;
  measureCtx.font = `${fontPx}px ${FONT}`;
  const lines = el.value.split('\n');
  const width = Math.max(...lines.map((l) => measureCtx.measureText(l).width));
  Object.assign(el.style, {
    left: `${sx}px`,
    top: `${sy}px`,
    fontSize: `${fontPx}px`,
    width: `${Math.ceil(width + fontPx)}px`,
    height: `${Math.ceil(lines.length * fontPx * LINE_HEIGHT)}px`,
  });
}

function closeEditor(keep) {
  if (!editor) return;
  const { el, point, size, color } = editor;
  editor = null; // before remove(), which fires blur
  el.remove();
  const text = el.value.replace(/\s+$/, '');
  if (keep && text.trim()) addItem({ kind: 'text', points: [point], size, color, text });
}

// ---------- Pointer input ----------
const pointers = new Map(); // pointerId -> [clientX, clientY], for two-finger pan/zoom
let gesture = null; // { type: 'draw' | 'shape' | 'pan' | 'pinch', ... }
let spaceDown = false;

function pinchInfo() {
  const [[x1, y1], [x2, y2]] = [...pointers.values()];
  return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, dist: Math.hypot(x2 - x1, y2 - y1) || 1 };
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (editor) return closeEditor(true); // clicking away finishes the text

  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  canvas.setPointerCapture(e.pointerId);

  if (pointers.size === 2) {
    abortStroke();
    state.preview = null;
    const p = pinchInfo();
    gesture = { type: 'pinch', ...p, camX: cam.x, camY: cam.y, z: cam.z };
    return;
  }
  if (pointers.size > 2) return;

  if (e.button === 1 || state.tool === 'hand' || spaceDown) {
    gesture = { type: 'pan', x: e.clientX, y: e.clientY };
    canvas.classList.add('panning');
    return;
  }
  if (e.button !== 0 || !state.me) return;

  const point = pt(e);
  if (state.tool === 'text') {
    openEditor(point);
  } else if (SHAPES.includes(state.tool)) {
    state.preview = { kind: state.tool, color: state.color, size: state.size, points: [point, point] };
    gesture = { type: 'shape' };
  } else {
    beginStroke(point);
    gesture = { type: 'draw' };
  }
});

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

canvas.addEventListener('pointermove', (e) => {
  queueCursor(pt(e));
  const prev = pointers.get(e.pointerId);
  if (prev) pointers.set(e.pointerId, [e.clientX, e.clientY]);

  switch (gesture?.type) {
    case 'draw':
      if (state.current) extendStroke(e);
      break;
    case 'shape':
      state.preview.points[1] = pt(e);
      scheduleRedraw();
      break;
    case 'pan':
      panBy(gesture.x - e.clientX, gesture.y - e.clientY);
      gesture.x = e.clientX;
      gesture.y = e.clientY;
      break;
    case 'pinch': {
      if (pointers.size < 2) break;
      const g = gesture;
      const p = pinchInfo();
      const z = clamp((g.z * p.dist) / g.dist, MIN_ZOOM, MAX_ZOOM);
      // Keep the world point that was under the fingers' midpoint under it.
      cam.z = z;
      cam.x = g.camX + g.cx / g.z - p.cx / z;
      cam.y = g.camY + g.cy / g.z - p.cy / z;
      cameraChanged();
      break;
    }
  }
});

function pointerEnd(e) {
  pointers.delete(e.pointerId);
  switch (gesture?.type) {
    case 'draw':
      endStroke();
      break;
    case 'shape': {
      const s = state.preview;
      state.preview = null;
      const [[x1, y1], [x2, y2]] = s.points;
      // Ignore accidental clicks that would make an invisible shape.
      if (e.type === 'pointerup' && Math.hypot(x2 - x1, y2 - y1) * cam.z > 3) addItem(s);
      scheduleRedraw();
      break;
    }
    case 'pinch':
      if (pointers.size > 0) return; // wait for every finger to lift
      break;
  }
  gesture = null;
  canvas.classList.remove('panning');
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

// ---------- Presence ----------

function placeCursor(id) {
  const el = cursorEls.get(id);
  const [x, y] = toScreen(el.wx, el.wy);
  el.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
}

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
  el.wx = x;
  el.wy = y;
  placeCursor(id);
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
const toolButtons = [...document.querySelectorAll('[data-tool]')];

function selectTool(tool) {
  if (editor) closeEditor(true);
  state.tool = tool;
  canvas.dataset.tool = tool;
  for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
}
for (const b of toolButtons) b.addEventListener('click', () => selectTool(b.dataset.tool));
selectTool('pen');

function selectColor(color) {
  state.color = color;
  if (state.tool === 'eraser' || state.tool === 'hand') selectTool('pen');
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

function flashLabel(btn, text, original) {
  btn.textContent = text;
  clearTimeout(btn.flashTimer);
  btn.flashTimer = setTimeout(() => (btn.textContent = original), 2000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const shareBtn = document.getElementById('share');
shareBtn.addEventListener('click', async () => {
  const ok = await copy(roomUrl(roomId));
  flashLabel(shareBtn, ok ? 'Link copied' : 'Copy the URL from your address bar', 'Copy invite link');
});

const codeBtn = document.getElementById('room-code');
codeBtn.addEventListener('click', async () => {
  const label = document.getElementById('room-name');
  if (await copy(roomId)) flashLabel(label, 'copied', roomId);
});

const TOOL_KEYS = { p: 'pen', h: 'hand', t: 'text', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', e: 'eraser' };
const PAN_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, [contenteditable]');
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod && !e.shiftKey && key === 'z') {
    e.preventDefault();
    undo();
  } else if (mod || e.altKey) {
    // leave other browser shortcuts alone
  } else if (e.key === ' ') {
    e.preventDefault();
    if (!spaceDown) canvas.classList.add('space-pan');
    spaceDown = true;
  } else if (PAN_KEYS[e.key]) {
    e.preventDefault();
    const step = e.shiftKey ? 400 : 100;
    panBy(PAN_KEYS[e.key][0] * step, PAN_KEYS[e.key][1] * step);
  } else if (key === '=' || key === '+') {
    zoomCenter(1.25);
  } else if (key === '-') {
    zoomCenter(0.8);
  } else if (key === '0') {
    resetView();
  } else if (TOOL_KEYS[key]) {
    selectTool(TOOL_KEYS[key]);
  }
});
addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false;
    canvas.classList.remove('space-pan');
  }
});
addEventListener('blur', () => {
  spaceDown = false;
  canvas.classList.remove('space-pan');
});

cameraChanged();
connect();
