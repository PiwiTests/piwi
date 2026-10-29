import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { POINTER, arcPoint, keyCaps, keysAt, pointerAt, ringsAt } from '../lib/cursor.mjs';

const near = (a, b, epsilon = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < epsilon;

describe('the pointer’s path', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 1000, y: 0 };

  test('an arc from one point to the other, off the straight line in its middle', () => {
    assert.ok(near(arcPoint(from, to, 0), from));
    assert.ok(near(arcPoint(from, to, 1), to));
    const middle = arcPoint(from, to, 0.5);
    assert.equal(middle.x, 500);
    assert.ok(Math.abs(middle.y) > 30, String(middle.y));
  });

  const moves = [
    { t: 1, act: 1.9, to: { x: 100, y: 100 }, click: true },
    { t: 3, act: 3.9, to: { x: 900, y: 500 }, click: true },
  ];

  test('arrives before the gesture acts, and stays there', () => {
    assert.ok(near(pointerAt(moves, 1 + POINTER.travel), moves[0].to));
    assert.ok(near(pointerAt(moves, 2.5), moves[0].to));
    assert.ok(near(pointerAt(moves, 3.9), moves[1].to));
  });

  test('leaves from where the last move left it', () => {
    assert.ok(near(pointerAt(moves, 3), moves[0].to));
    const halfway = pointerAt(moves, 3 + POINTER.travel / 2);
    assert.ok(halfway.x > 100 && halfway.x < 900);
  });

  test('moves along its path without a jump', () => {
    let last = pointerAt(moves, 0.9);
    for (let t = 0.9; t < 6; t += 0.001) {
      const now = pointerAt(moves, t);
      if (now && last) assert.ok(Math.hypot(now.x - last.x, now.y - last.y) < 5, `a jump at ${t.toFixed(3)} s`);
      last = now;
    }
  });

  test('fades in before its first move, and out once idle', () => {
    assert.equal(pointerAt(moves, 0), null);
    assert.ok(pointerAt(moves, 1 - POINTER.fade / 2).opacity < 1);
    assert.equal(pointerAt(moves, 2).opacity, 1);
    assert.equal(pointerAt(moves, 3.9 + POINTER.idle + POINTER.fade + 0.01), null);
  });

  test('is pressed for a moment as it clicks', () => {
    assert.equal(pointerAt(moves, 1.95).pressed, true);
    assert.equal(pointerAt(moves, 2.5).pressed, false);
  });
});

describe('the click rings', () => {
  const moves = [
    { t: 0, act: 1, to: { x: 10, y: 20 }, click: true },
    { t: 2, act: 3, to: { x: 50, y: 50 }, click: false },
  ];

  test('grow and fade after each click, and only clicks', () => {
    assert.deepEqual(ringsAt(moves, 0.5), []);
    const [ring] = ringsAt(moves, 1 + POINTER.ring / 2);
    assert.deepEqual([ring.x, ring.y], [10, 20]);
    assert.ok(Math.abs(ring.progress - 0.5) < 1e-9);
    assert.deepEqual(ringsAt(moves, 3.1), []);
  });
});

describe('the key strip', () => {
  test('names the keys as a person reads them', () => {
    assert.deepEqual(keyCaps('Control+Shift+Alt+K'), ['Ctrl', 'Shift', 'Alt', 'K']);
    assert.deepEqual(keyCaps('F9'), ['F9']);
    assert.deepEqual(keyCaps('ArrowRight'), ['→']);
  });

  test('shows the latest keys for a moment, faded in and out', () => {
    const keys = [
      { at: 1, caps: ['F9'] },
      { at: 1.5, caps: ['Ctrl', 'P'] },
    ];
    assert.equal(keysAt(keys, 0.5), null);
    assert.deepEqual(keysAt(keys, 1.6).caps, ['Ctrl', 'P']);
    assert.ok(keysAt(keys, 1.55).opacity < 1);
    assert.equal(keysAt(keys, 2).opacity, 1);
    assert.equal(keysAt(keys, 4), null);
  });
});
