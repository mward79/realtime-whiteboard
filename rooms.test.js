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
