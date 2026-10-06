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
    this.expiry = null;
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

  removeUser(id) {
    this.users.delete(id);
    // Finish any stroke they were mid-way through so it can't be appended to later.
    for (const s of this.strokes.values()) if (s.userId === id) s.done = true;
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

    const item = { id, userId, kind, color, size, erase: false, points: points.map(([x, y]) => [x, y]), done: true };
    if (SHAPES.includes(kind)) {
      if (points.length !== 2) return null;
    } else if (kind === 'text') {
      if (points.length !== 1) return null;
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) return null;
      item.text = text;
    } else {
      return null;
    }
    this.strokes.set(id, item);
    return item;
  }

  endStroke(userId, strokeId) {
    const s = this.strokes.get(strokeId);
    if (!s || s.userId !== userId) return false;
    s.done = true;
    return true;
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

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  get(id) {
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id);
      this.rooms.set(id, room);
    }
    if (room.expiry) {
      clearTimeout(room.expiry);
      room.expiry = null;
    }
    return room;
  }

  // Keep an empty room around for a while so a refresh doesn't wipe the drawing.
  release(id, delayMs = 10 * 60 * 1000) {
    const room = this.rooms.get(id);
    if (!room || !room.isEmpty) return;
    clearTimeout(room.expiry);
    room.expiry = setTimeout(() => {
      if (room.isEmpty) this.rooms.delete(id);
    }, delayMs);
    room.expiry.unref?.();
  }
}
