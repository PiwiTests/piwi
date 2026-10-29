import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FAST, TITLE_BAR, pieces, planCut, world } from '../lib/cut-plan.mjs';

const WINDOWS = {
  vscode: { x: 0, y: 0, width: 2160, height: 1440 },
  dashboard: { x: 0, y: 174, width: 3840, height: 1986 },
  runs: { x: 2160, y: 1080, width: 1600, height: 1000 },
  'test-browser': { x: 2160, y: 174, width: 1600, height: 906 },
};

/** A take of one beat on the dashboard, a click at its start, between the two cards. */
const take = () => ({
  screen: { width: 3840, height: 2160, scale: 2 },
  windows: WINDOWS,
  master: { fps: 24 },
  flash: { t: 1000, box: { x: 0, y: 0, width: 10, height: 10 } },
  story: [
    { id: 'title', title: 'Piwi', card: true, seconds: 4, focus: ['card'], lines: ['Hello there.'] },
    { id: 'red-run', title: 'The red run', card: false, seconds: 10, focus: ['dashboard'], lines: ['A line.'] },
    { id: 'end', title: 'Get Piwi', card: true, seconds: 3, focus: ['card'], lines: ['Bye.'] },
  ],
  beats: [{ id: 'red-run', start: 2000, end: 12_000, lines: [{ text: 'A line.', start: 2000, ms: 867 }] }],
  gestures: [{ beat: 'red-run', kind: 'click', window: 'dashboard', t: 2050, act: 2950, point: { x: 800, y: 1400 } }],
  raises: [{ t: 1500, up: 'dashboard', window: 'dashboard' }],
  presence: [],
});

describe('a beat’s pace', () => {
  test('a quiet stretch past its limit plays fast, but for its ends', () => {
    const parts = pieces(0, 10_000, [
      [0, 1000],
      [9000, 10_000],
    ]);
    assert.deepEqual(parts, [
      { a: 0, b: 1000 + FAST.keepMs, rate: 1 },
      { a: 1000 + FAST.keepMs, b: 9000 - FAST.keepMs, rate: FAST.rate },
      { a: 9000 - FAST.keepMs, b: 10_000, rate: 1 },
    ]);
  });

  test('a short quiet stretch, and overlapping busy ones, play as they were', () => {
    const parts = pieces(0, 5000, [
      [0, 2000],
      [1500, 3000],
      [4000, 5000],
    ]);
    assert.deepEqual(parts, [{ a: 0, b: 5000, rate: 1 }]);
  });
});

describe('the stage’s world', () => {
  test('moves the right column off VS Code, and the Runs window off the test’s browser, with room for the bar', () => {
    const placed = world(WINDOWS);
    const vscode = placed.vscode.frame;
    const test = placed['test-browser'].frame;
    const runs = placed.runs.frame;
    assert.ok(test.x > vscode.x + vscode.width, 'a gap right of VS Code');
    assert.ok(runs.y > test.y + test.height, 'a gap under the test’s browser');
    assert.equal(placed.runs.content.y - runs.y, TITLE_BAR);
    assert.deepEqual(placed.runs.crop, WINDOWS.runs);
  });

  test('cuts VS Code’s own title bar off', () => {
    const { crop } = world(WINDOWS, 2).vscode;
    assert.equal(crop.y, 70);
    assert.equal(crop.height, 1440 - 70);
  });

  test('gives a test’s browser no beat reached its tile', () => {
    const { 'test-browser': missing, ...rest } = WINDOWS;
    assert.ok(missing);
    const { crop } = world(rest)['test-browser'];
    assert.deepEqual(crop, { x: 2160, y: 174, width: 1600, height: 906 });
  });
});

describe('the plan', () => {
  const plan = planCut(take(), { flashFrame: 24, frames: 10_000 });
  const beat = plan.segments.find((s) => s.id === 'red-run');
  const at = (t) => plan.frames[Math.round(t * 30)];

  test('is the title card, the beat, the end card, the beat’s quiet stretch fast', () => {
    assert.deepEqual(
      plan.segments.map((s) => [s.kind, s.id]),
      [
        ['card', 'title'],
        ['beat', 'red-run'],
        ['card', 'end'],
      ],
    );
    assert.equal(beat.start, 4);
    assert.ok(beat.end - beat.start < 10, `the beat lasts ${beat.end - beat.start} s of its 10`);
    assert.equal(plan.frames.length, Math.round(plan.duration * 30));
  });

  test('shows the master’s frames in order, the flash’s frame at the flash', () => {
    const frames = plan.frames.map((s) => s.frame);
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i] >= frames[i - 1], `frame ${i} goes back`);
    // The flash is drawn half a frame before frame 24 shows it; the beat starts 1 s, 24 frames, after it.
    assert.equal(at(4).frame, 48);
    assert.equal(at(0).frame, 48, 'the title card holds the beat’s first frame');
  });

  test('zooms on a click at the beat’s start, then shows the window whole', () => {
    assert.ok(at(3).scale < 0.5, `the dashboard whole under the title card (${at(3).scale})`);
    assert.ok(Math.abs(at(5.1).scale - 0.75) < 0.01, `zoomed in as it clicks (${at(5.1).scale})`);
    assert.ok(at(7.5).scale < 0.5, `whole again (${at(7.5).scale})`);
  });

  test('draws the pointer to the click, a ring as it clicks, and the window over the card’s fade', () => {
    assert.ok(at(5).pointer, 'the pointer');
    assert.equal(at(5.1).rings.length, 1);
    assert.equal(at(1).card.id, 'title');
    assert.deepEqual(
      at(5).windows.map((w) => w.id),
      ['dashboard'],
    );
  });

  test('badges the fast stretch, and the chapter of the beat', () => {
    assert.equal(at(8).fast?.rate, FAST.rate);
    assert.equal(at(4.5).fast, null);
    assert.equal(at(5).chapter.title, 'The red run');
    assert.equal(at(1).chapter, null);
  });

  test('refuses a master that ends before the take’s last beat', () => {
    assert.throws(() => planCut(take(), { flashFrame: 24, frames: 200 }), /its capture stopped early/);
    assert.doesNotThrow(() => planCut(take(), { flashFrame: 24, frames: 288 }));
  });

  test('times the cues, the cards’ marked as such', () => {
    assert.deepEqual(
      plan.cues.map((c) => [c.text, c.card]),
      [
        ['Hello there.', true],
        ['A line.', false],
        ['Bye.', true],
      ],
    );
    const line = plan.cues[1];
    assert.equal(line.start, 4);
    assert.ok(Math.abs(line.end - (4 + 0.867 - 0.1)) < 1e-9);
  });
});
