// Pure room state: no networking or storage here, so it's easy to unit test.

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

// Draw order: items sort by seq, ties broken by id so every server agrees.
export const byDrawOrder = (a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Room {
  constructor(id, { now = Date.now } = {}) {
    this.id = id;
    this.strokes = new Map();
    this.users = new Map(); // everyone in the room, on this server or another
    this.departed = new Set(); // ids that have left; user ids are never reused
    this.now = now;
    this.nextSeq = 0;
  }

  // Each item gets a seq when it's started; it's stored with the item so draw
  // order survives a reload. Several servers hand out seqs for the same room, so
  // they're based on the clock and never go below anything this room has seen
  // from another server: an item started after you saw someone else's sorts
  // after it, without a round trip to Redis.
  takeSeq() {
    this.nextSeq = Math.max(this.nextSeq, this.now() * 1000);
    return this.nextSeq++;
  }

  observeSeq(seq) {
    if (Number.isFinite(seq)) this.nextSeq = Math.max(this.nextSeq, seq + 1);
  }

  // Fill a freshly created room with finished items loaded from storage.
  restore(items) {
    for (const item of [...items].sort(byDrawOrder)) {
      this.strokes.set(item.id, { ...item, done: true });
      this.observeSeq(item.seq);
    }
  }

  // Picks a color nobody in the room (on any server) is using, if there is one.
  addUser(id, name) {
    const used = new Set([...this.users.values()].map((u) => u.color));
    const color = USER_COLORS.find((c) => !used.has(c)) ?? USER_COLORS[this.users.size % USER_COLORS.length];
    const user = { id, name, color };
    this.users.set(id, user);
    return user;
  }

  // Returns the strokes this finished, so the caller can save them.
  removeUser(id) {
    this.users.delete(id);
    this.departed.add(id);
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
      seq: this.takeSeq(),
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
    item.seq = this.takeSeq();
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

  // Removes everything drawn before `upTo` (a seq). Returns the seq to send along,
  // so another server replaying a late copy of this clear can't wipe anything newer.
  clear(upTo = this.takeSeq()) {
    for (const [id, s] of this.strokes) if (s.seq < upTo) this.strokes.delete(id);
    return upTo;
  }

  snapshot() {
    return { strokes: [...this.strokes.values()].sort(byDrawOrder), users: [...this.users.values()] };
  }

  // Applies an event another server already validated and published. Returns the
  // message for this server's clients, or null when there's nothing new to show.
  // Safe to apply twice, since a room that's still loading replays what it buffered.
  applyRemote(event) {
    switch (event.type) {
      case 'user:join':
        this.departed.delete(event.user.id); // re-announced after being reaped by mistake
        this.users.set(event.user.id, event.user);
        return { type: 'user:join', user: event.user };

      case 'user:leave':
        this.removeUser(event.userId);
        return { type: 'user:leave', userId: event.userId };

      case 'cursor':
        return { type: 'cursor', userId: event.userId, x: event.x, y: event.y };

      case 'stroke:begin': {
        const { stroke } = event;
        if (this.strokes.has(stroke.id)) return null;
        this.strokes.set(stroke.id, { ...stroke, points: [...stroke.points], done: false });
        this.observeSeq(stroke.seq);
        return { type: 'stroke:begin', stroke };
      }

      case 'stroke:points': {
        const s = this.strokes.get(event.id);
        if (!s || s.done) return null;
        s.points.push(...event.points);
        return { type: 'stroke:points', id: event.id, points: event.points };
      }

      // Carries the whole finished stroke, so a server that joined the room
      // mid-stroke (and missed its start) still ends up with all of it.
      case 'stroke:end': {
        const { stroke } = event;
        const known = this.strokes.has(stroke.id);
        this.strokes.set(stroke.id, { ...stroke, done: true });
        this.observeSeq(stroke.seq);
        return known ? null : { type: 'item:add', item: stroke };
      }

      case 'item:add': {
        const { item } = event;
        if (this.strokes.has(item.id)) return null;
        this.strokes.set(item.id, { ...item, done: true });
        this.observeSeq(item.seq);
        return { type: 'item:add', item };
      }

      case 'stroke:remove':
        return this.strokes.delete(event.id) ? { type: 'stroke:remove', id: event.id } : null;

      case 'clear':
        this.observeSeq(event.upTo - 1);
        this.clear(event.upTo);
        return { type: 'clear' };

      default:
        return null;
    }
  }
}
