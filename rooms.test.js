import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, PALETTE } from './rooms.js';

const begin = (room, userId, overrides = {}) =>
  room.beginStroke(userId, { id: 's1', color: PALETTE[0], size: 4, point: [10, 10], ...overrides });

test('a user can start a stroke and append points', () => {
  const room = new Room('r');
  room.addUser('a', 'Ada');
  assert.ok(begin(room, 'a'));
  assert.equal(room.addPoints('a', 's1', [[11, 11], [12, 12]]), true);
  assert.equal(room.strokes.get('s1').points.length, 3);
});

test('a user cannot add points to someone else\'s stroke', () => {
  const room = new Room('r');
  begin(room, 'a');
  assert.equal(room.addPoints('b', 's1', [[1, 1]]), false);
});

test('invalid strokes are rejected', () => {
  const room = new Room('r');
  assert.equal(begin(room, 'a', { color: 'red' }), null);
  assert.equal(begin(room, 'a', { size: 0 }), null);
  assert.equal(begin(room, 'a', { point: [NaN, 1] }), null);
  assert.equal(begin(room, 'a', { id: 'x'.repeat(65) }), null);
});

test('eraser strokes do not need a palette color', () => {
  const room = new Room('r');
  assert.ok(begin(room, 'a', { color: undefined, erase: true }));
});

test('duplicate stroke ids are rejected', () => {
  const room = new Room('r');
  assert.ok(begin(room, 'a'));
  assert.equal(begin(room, 'b'), null);
});

test('only the owner can remove a stroke', () => {
  const room = new Room('r');
  begin(room, 'a');
  assert.equal(room.removeStroke('b', 's1'), false);
  assert.equal(room.removeStroke('a', 's1'), true);
  assert.equal(room.strokes.size, 0);
});

test('leaving finishes in-progress strokes', () => {
  const room = new Room('r');
  room.addUser('a', 'Ada');
  begin(room, 'a');
  room.removeUser('a');
  assert.equal(room.addPoints('a', 's1', [[1, 1]]), false);
});

test('snapshot preserves draw order', () => {
  const room = new Room('r');
  begin(room, 'a', { id: 'first' });
  begin(room, 'a', { id: 'second' });
  assert.deepEqual(room.snapshot().strokes.map((s) => s.id), ['first', 'second']);
});

const add = (room, userId, overrides = {}) =>
  room.addItem(userId, { id: 'i1', kind: 'rect', color: PALETTE[1], size: 3, points: [[0, 0], [50, 40]], ...overrides });

test('shapes are added complete and cannot be extended', () => {
  const room = new Room('r');
  for (const kind of ['rect', 'ellipse', 'line', 'arrow']) assert.ok(add(room, 'a', { id: kind, kind }));
  assert.equal(room.addPoints('a', 'rect', [[1, 1]]), false);
  assert.deepEqual(room.snapshot().strokes.map((s) => s.kind), ['rect', 'ellipse', 'line', 'arrow']);
});

test('invalid shapes are rejected', () => {
  const room = new Room('r');
  assert.equal(add(room, 'a', { kind: 'star' }), null);
  assert.equal(add(room, 'a', { points: [[0, 0]] }), null);
  assert.equal(add(room, 'a', { points: [[0, 0], [Infinity, 1]] }), null);
  assert.equal(add(room, 'a', { color: 'red' }), null);
  assert.equal(add(room, 'a', { size: 500 }), null);
});

test('text items need a single point and non-empty text', () => {
  const room = new Room('r');
  const text = { kind: 'text', points: [[5, 5]], size: 20 };
  assert.equal(add(room, 'a', { ...text, text: '   ' }), null);
  assert.equal(add(room, 'a', { ...text, text: 'x'.repeat(1001) }), null);
  assert.equal(add(room, 'a', { ...text, points: [[5, 5], [6, 6]], text: 'hi' }), null);
  assert.equal(add(room, 'a', { ...text, text: 'hello\nworld' }).text, 'hello\nworld');
});

test('only the owner can remove a shape or text', () => {
  const room = new Room('r');
  add(room, 'a');
  assert.equal(room.removeStroke('b', 'i1'), false);
  assert.equal(room.removeStroke('a', 'i1'), true);
});

test('seqs follow the clock and stay above anything seen from another server', () => {
  let now = 1000;
  const room = new Room('r', { now: () => now });
  const a = begin(room, 'a', { id: 'a' });
  const b = begin(room, 'a', { id: 'b' });
  assert.ok(b.seq > a.seq, 'increasing within one millisecond');
  room.applyRemote({ type: 'item:add', item: { id: 'far', seq: 5_000_000, kind: 'line', points: [[0, 0], [1, 1]] } });
  assert.ok(begin(room, 'a', { id: 'c' }).seq > 5_000_000, 'a server with a slow clock still sorts after what it saw');
  now = 9000;
  assert.ok(begin(room, 'a', { id: 'd' }).seq >= 9_000_000);
});

test('remote events are applied once and translated for local clients', () => {
  const room = new Room('r');
  const stroke = { id: 's', userId: 'x', kind: 'path', color: PALETTE[0], size: 4, erase: false, points: [[0, 0]], seq: 1 };
  assert.equal(room.applyRemote({ type: 'stroke:begin', stroke }).type, 'stroke:begin');
  assert.equal(room.applyRemote({ type: 'stroke:begin', stroke }), null, 'duplicate ignored');
  assert.ok(room.applyRemote({ type: 'stroke:points', id: 's', points: [[1, 1]] }));
  assert.equal(room.applyRemote({ type: 'stroke:end', stroke: { ...stroke, points: [[0, 0], [1, 1]] } }), null, 'clients already have it');
  assert.equal(room.applyRemote({ type: 'stroke:points', id: 's', points: [[2, 2]] }), null, 'finished strokes stay finished');
  assert.deepEqual(room.applyRemote({ type: 'stroke:end', stroke: { ...stroke, id: 'missed' } }).type, 'item:add', 'unknown strokes are sent whole');
  assert.deepEqual(room.applyRemote({ type: 'stroke:remove', id: 's' }), { type: 'stroke:remove', id: 's' });
  assert.equal(room.applyRemote({ type: 'stroke:remove', id: 's' }), null);
});

test('a clear only removes items drawn before it', () => {
  const room = new Room('r');
  room.applyRemote({ type: 'item:add', item: { id: 'old', seq: 10, points: [] } });
  room.applyRemote({ type: 'item:add', item: { id: 'new', seq: 30, points: [] } });
  room.applyRemote({ type: 'clear', upTo: 20 });
  assert.deepEqual([...room.strokes.keys()], ['new']);
  assert.ok(begin(room, 'a', { id: 'after' }).seq > 20);
});

test('users get a color nobody else in the room has', () => {
  const room = new Room('r');
  room.applyRemote({ type: 'user:join', user: { id: 'remote', name: 'R', color: '#2557d6' } });
  const local = room.addUser('local', 'L');
  assert.notEqual(local.color, '#2557d6');
});
