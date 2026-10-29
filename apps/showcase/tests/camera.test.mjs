import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ASPECT, MOVE_S, between, clamp, ease, fit, moveSeconds, union, viewAt, viewRect } from '../lib/camera.mjs';

const close = (actual, expected, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not ${expected}`);

describe('the easing', () => {
  test('starts at 0 and ends at 1, flat at both ends, half way at the middle', () => {
    close(ease(0), 0);
    close(ease(1), 1);
    close(ease(0.5), 0.5);
    assert.ok(ease(0.05) < 0.05 && ease(0.95) > 0.95);
  });

  test('holds outside 0 to 1', () => {
    assert.equal(ease(-1), 0);
    assert.equal(ease(2), 1);
  });

  test('never goes back', () => {
    for (let x = 0; x < 1; x += 0.01) assert.ok(ease(x + 0.01) >= ease(x));
  });
});

describe('a shot', () => {
  test('fits a window whole at the output’s aspect, with its margin', () => {
    const view = fit({ x: 0, y: 0, width: 1600, height: 1000 }, 0.05);
    assert.deepEqual([view.cx, view.cy], [800, 500]);
    close(view.width, 1000 * 1.1 * ASPECT);
    const rect = viewRect(view);
    assert.ok(rect.width >= 1600 * 1.1 && rect.height >= 1000 * 1.1);
  });

  test('of several windows holds them all', () => {
    const all = union([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 200, y: 50, width: 100, height: 200 },
    ]);
    assert.deepEqual(all, { x: 0, y: 0, width: 300, height: 250 });
  });

  test('is never closer than the master’s pixels', () => {
    assert.equal(clamp({ cx: 0, cy: 0, width: 800 }, { minWidth: 1920 }).width, 1920);
    assert.equal(clamp({ cx: 0, cy: 0, width: 2400 }, { minWidth: 1920 }).width, 2400);
    assert.equal(clamp({ cx: 0, cy: 0, width: 9000 }, { minWidth: 1920, maxWidth: 4000 }).width, 4000);
  });
});

describe('the camera', () => {
  const span = 4000;
  const limits = { minWidth: 1920 };
  const a = { cx: 1000, cy: 600, width: 2200 };
  const b = { cx: 3000, cy: 1200, width: 3600 };
  const shots = [
    { t: 0, view: a },
    { t: 10, view: b },
  ];

  test('a move lasts 0.6 to 0.9 s, longer the further it goes', () => {
    const small = moveSeconds(a, { ...a, cx: a.cx + 10 }, span);
    const large = moveSeconds(a, { cx: 9000, cy: 9000, width: 9000 }, span);
    assert.ok(small >= MOVE_S.min && small < 0.62, String(small));
    close(large, MOVE_S.max);
  });

  test('holds a shot until the next starts, then eases to it', () => {
    assert.deepEqual(viewAt(shots, 5, { limits, span }), a);
    const seconds = moveSeconds(a, b, span);
    const early = viewAt(shots, 10 + seconds * 0.1, { limits, span });
    const middle = viewAt(shots, 10 + seconds / 2, { limits, span });
    close(middle.cx, (a.cx + b.cx) / 2);
    close(middle.width, Math.sqrt(a.width * b.width));
    assert.ok(early.cx - a.cx < (b.cx - a.cx) * 0.1, 'slow at the start');
    assert.deepEqual(viewAt(shots, 10 + seconds, { limits, span }), b);
    assert.deepEqual(viewAt(shots, 60, { limits, span }), b);
  });

  test('a shot that starts mid-move eases on from where the camera is', () => {
    const c = { cx: 500, cy: 500, width: 2000 };
    const seconds = moveSeconds(a, b, span);
    const cut = [...shots, { t: 10 + seconds / 2, view: c }];
    const there = viewAt(shots, 10 + seconds / 2, { limits, span });
    const after = viewAt(cut, 10 + seconds / 2 + 1e-9, { limits, span });
    close(after.cx, there.cx, 1e-3);
    assert.deepEqual(viewAt(cut, 30, { limits, span }), c);
  });

  test('every view along a move stays within the clamp', () => {
    const tight = [
      { t: 0, view: { cx: 0, cy: 0, width: 500 } },
      { t: 1, view: { cx: 900, cy: 0, width: 4000 } },
    ];
    for (let t = 0; t < 3; t += 0.05) assert.ok(viewAt(tight, t, { limits, span }).width >= 1920 - 1e-9);
    assert.equal(viewAt(tight, 0, { limits, span }).width, 1920);
  });

  test('between keeps the zoom even: the width in proportion, not in a line', () => {
    close(between({ cx: 0, cy: 0, width: 1000 }, { cx: 0, cy: 0, width: 4000 }, 0.5).width, 2000);
  });
});
