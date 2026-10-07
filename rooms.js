// Pure room state: no networking here, so it's easy to unit test.

export const PALETTE = ['#1d1d1b', '#2557d6', '#d6352a', '#1f8a4c', '#e58a00', '#8a3ffc'];
const USER_COLORS = ['#2557d6', '#d6352a', '#1f8a4c', '#e58a00', '#8a3ffc', '#0e8a8a', '#c2185b'];

const MAX_POINTS_PER_STROKE = 4000;
const MAX_STROKES_PER_ROOM = 10000;
const MAX_POINTS_PER_MESSAGE = 200;
const MAX_SIZE = 128;
const MAX_TEXT_LENGTH = 1000;

export const SHAPES = ['rect', 'ellipse', 'line', 'arrow'];

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
export const isCoord = (v) => Number.isFinite(v) && Math.abs(v) <= 100000;
const isPoint = (p) => Array.isArray(p) && p.length === 2 && isCoord(p[0]) && isCoord(p[1]);

export class Room {
  constructor(id) {
    this.id = id;
    this.strokes = new Map(); // insertion order = draw order (matters for the eraser)
    this.users = new Map();
    this.colorIndex = 0;
    this.nextSeq = 0; // stored with each item so draw order survives a reload
  }

  // Fill a freshly created room with finished items loaded from storage.
  restore(items) {
    for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
      this.strokes.set(item.id, { ...item, done: true });
      this.nextSeq = Math.max(this.nextSeq, item.seq + 1);
    }
  }

  get isEmpty() {
    return this.users.size === 0;
  }

  addUser(id, name) {
    const color = USER_COLORS[this.colorIndex++ % USER_COLORS.length];
    const user = { id, name, color };
    this.users.set(id, user);
    return user;
  }

  // Returns the strokes this finished, so the caller can save them.
  removeUser(id) {
    this.users.delete(id);
    // Finish any stroke they were mid-way through so it can't be appended to later.
    const finished = [];
    for (const s of this.strokes.values()) {
      if (s.userId === id && !s.done) {
        s.done = true;
        finished.push(s);
      }
    }
    return finished;
  }

  beginStroke(userId, { id, color, size, point, erase }) {
    if (!isId(id) || this.strokes.has(id)) return null;
    if (this.strokes.size >= MAX_STROKES_PER_ROOM) return null;
    if (!erase && !PALETTE.includes(color)) return null;
    if (!Number.isFinite(size) || size < 1 || size > MAX_SIZE) return null;
    if (!isPoint(point)) return null;

    const stroke = {
      id,
      userId,
      kind: 'path',
      color: erase ? null : color,
      size,
      erase: Boolean(erase),
      points: [point],
      seq: this.nextSeq++,
      done: false,
    };
    this.strokes.set(id, stroke);
    return stroke;
  }

  addPoints(userId, strokeId, points) {
    const s = this.strokes.get(strokeId);
    if (!s || s.userId !== userId || s.done) return false;
    if (!Array.isArray(points) || points.length === 0 || points.length > MAX_POINTS_PER_MESSAGE) return false;
    if (!points.every(isPoint)) return false;
    if (s.points.length + points.length > MAX_POINTS_PER_STROKE) return false;
    s.points.push(...points);
    return true;
  }

  // Shapes and text arrive complete in one message, unlike freehand strokes.
  addItem(userId, { id, kind, color, size, points, text }) {
    if (!isId(id) || this.strokes.has(id)) return null;
    if (this.strokes.size >= MAX_STROKES_PER_ROOM) return null;
    if (!PALETTE.includes(color)) return null;
    if (!Number.isFinite(size) || size < 1 || size > MAX_SIZE) return null;
    if (!Array.isArray(points) || !points.every(isPoint)) return null;

    const item = { id, userId, kind, color, size, erase: false, points: points.map(([x, y]) => [x, y]), seq: 0, done: true };
    if (SHAPES.includes(kind)) {
      if (points.length !== 2) return null;
    } else if (kind === 'text') {
      if (points.length !== 1) return null;
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) return null;
      item.text = text;
    } else {
      return null;
    }
    item.seq = this.nextSeq++;
    this.strokes.set(id, item);
    return item;
  }

  // Returns the stroke the first time it's finished, so it's saved exactly once.
  endStroke(userId, strokeId) {
    const s = this.strokes.get(strokeId);
    if (!s || s.userId !== userId || s.done) return null;
    s.done = true;
    return s;
  }

  removeStroke(userId, strokeId) {
    const s = this.strokes.get(strokeId);
    if (!s || s.userId !== userId) return false;
    this.strokes.delete(strokeId);
    return true;
  }

  clear() {
    this.strokes.clear();
  }

  snapshot() {
    return { strokes: [...this.strokes.values()], users: [...this.users.values()] };
  }
}

// Live rooms are cached in memory while anyone is in them. The first person to
// join a room loads it from storage; when the last person leaves it's dropped
// from memory, and storage's TTL decides how long the board survives.
export class RoomManager {
  constructor(storage) {
    this.storage = storage;
    this.rooms = new Map();
    this.loading = new Map(); // roomId -> Promise<Room>, so simultaneous joins share one load
  }

  async open(id) {
    const cached = this.rooms.get(id);
    if (cached) return cached;
    if (!this.loading.has(id)) {
      const load = this.storage
        .load(id)
        .then((items) => {
          const room = new Room(id);
          room.restore(items);
          this.rooms.set(id, room);
          return room;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, load);
    }
    return this.loading.get(id);
  }

  release(id) {
    if (this.rooms.get(id)?.isEmpty) this.rooms.delete(id);
  }
}
