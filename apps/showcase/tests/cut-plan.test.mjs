import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FAST,
  RAIL_BAND,
  TITLE_BAR,
  agentPanel,
  partCardSeconds,
  partsOf,
  pieces,
  planCut,
  world,
} from '../lib/cut-plan.mjs';

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

  test('keeps VS Code’s own title bar, where Quick Open and the command palette drop', () => {
    assert.deepEqual(world(WINDOWS).vscode.crop, WINDOWS.vscode);
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

  test('shows the window whole for a click whose zoom it would leave at once', () => {
    // The zoom in, and back out 1.4 s after the click, are one move at most: the window whole.
    for (const t of [3, 5.1, 7.5]) assert.ok(at(t).scale < 0.5, `the dashboard whole at ${t} s (${at(t).scale})`);
    assert.equal(plan.moves.kept.length, 0);
    assert.ok(plan.moves.planned.length >= 2, 'the plan had the zoom in and out');
  });

  test('draws the pointer to the click, a ring as it clicks, and the window over the card’s fade', () => {
    assert.ok(at(5).pointer, 'the pointer');
    assert.equal(at(5.1).rings.length, 1);
    assert.deepEqual(
      at(1).cards.map((c) => c.id),
      ['title'],
    );
    assert.deepEqual(
      at(5).windows.map((w) => w.id),
      ['dashboard'],
    );
  });

  test('badges the fast stretch, and draws no rail without parts', () => {
    assert.equal(at(8).fast?.rate, FAST.rate);
    assert.equal(at(4.5).fast, null);
    assert.equal(at(5).rail, null);
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

describe('the parts', () => {
  const CI_IS_RED = { title: 'CI is red', what: 'A short line.' };
  const FIX_IT = { title: 'Fix it', what: 'Another short line.' };
  /** The take of one beat, then a second on the dashboard, each opening a part. */
  const parted = () => {
    const log = take();
    const fixed = { id: 'fixed', title: 'Fixed', card: false, seconds: 10, focus: ['dashboard'], lines: ['More.'] };
    log.story = [log.story[0], { ...log.story[1], part: CI_IS_RED }, { ...fixed, part: FIX_IT }, log.story[2]];
    log.beats.push({ id: 'fixed', start: 13_000, end: 23_000, lines: [{ text: 'More.', start: 13_000, ms: 733 }] });
    return log;
  };
  const plan = planCut(parted(), { flashFrame: 24, frames: 10_000 });
  const segment = (id) => plan.segments.find((s) => s.id === id);
  const at = (t) => plan.frames[Math.round(t * 30)];
  const [title, first, red, second, fixed, end] = ['title', 'part-1', 'red-run', 'part-2', 'fixed', 'end'].map(segment);

  test('are the beats from one that names a part to the next, cards and beats before any part left out', () => {
    const story = [
      { id: 'title', card: true },
      { id: 'warm-up' },
      { id: 'a', part: CI_IS_RED },
      { id: 'b' },
      { id: 'c', part: FIX_IT },
    ];
    assert.deepEqual(partsOf(story), [
      { number: 1, ...CI_IS_RED, beats: ['a', 'b'] },
      { number: 2, ...FIX_IT, beats: ['c'] },
    ]);
  });

  test('each open with their card, the first longer as it lists them all', () => {
    assert.deepEqual(
      plan.segments.map((s) => [s.kind, s.id]),
      [
        ['card', 'title'],
        ['part', 'part-1'],
        ['beat', 'red-run'],
        ['part', 'part-2'],
        ['beat', 'fixed'],
        ['card', 'end'],
      ],
    );
    assert.equal(first.end - first.start, partCardSeconds({ number: 1, ...CI_IS_RED }, 2));
    assert.ok(partCardSeconds({ number: 1, ...FIX_IT }, 5) > partCardSeconds({ number: 2, ...FIX_IT }, 5));
  });

  test('show a part’s card under the fading title card, and fade the next in over the beat before it', () => {
    const crossing = at(title.end + 0.3).cards;
    assert.deepEqual(
      crossing.map((c) => [c.id, c.part ?? null]),
      [
        ['title', null],
        ['part', 1],
      ],
    );
    assert.equal(crossing[1].opacity, 1);
    assert.ok(at(second.start + 0.3).cards[0].opacity < 0.6, 'the second part’s card fades in');
    assert.equal(at((second.start + second.end) / 2).cards[0].opacity, 1);
    assert.ok(at(fixed.start + 0.3).cards[0].opacity < 0.6, 'and fades out over its beat');
  });

  test('hold the beat before a part’s card for its first half, the beat after it for the rest', () => {
    assert.equal(at(second.start + 0.1).frame, at(second.start + 0.4).frame);
    assert.ok(at(second.start + 0.1).frame >= at(second.start - 0.1).frame);
    assert.equal(at(second.end - 0.1).frame, at(fixed.start).frame);
    assert.ok(at(second.end - 0.1).frame > at(second.start + 0.1).frame);
  });

  test('keep the rail on screen through the beats, the part’s progress and the beat’s title in it', () => {
    assert.equal(at(1).rail, null, 'none over the title card');
    const shown = at(red.start + 1).rail;
    assert.equal(shown.part, 1);
    assert.equal(shown.beat.title, 'The red run');
    assert.ok(shown.progress > 0 && shown.progress < 1, `its progress (${shown.progress})`);
    assert.equal(at((second.start + second.end) / 2).rail, null, 'none under a card shown whole');
    assert.equal(at(fixed.start + 1).rail.part, 2);
    assert.ok(at(fixed.end - 0.1).rail.progress > 0.95);
    const fading = at(end.start + 0.3).rail;
    assert.equal(fading.part, 2);
    assert.ok(fading.opacity < 0.6, 'fades out under the end card');
  });

  test('frame the windows below the rail', () => {
    const [dashboard] = at(red.start + 0.2).windows;
    assert.ok(dashboard.frame.y >= RAIL_BAND, `the dashboard's top at ${dashboard.frame.y}`);
  });

  test('are the chapters, from each part’s card', () => {
    assert.deepEqual(
      plan.chapters.map((c) => [c.title, c.card, c.start]),
      [
        ['Piwi', true, 0],
        ['CI is red', false, first.start],
        ['Fix it', false, second.start],
        ['Get Piwi', true, end.start],
      ],
    );
    assert.deepEqual(plan.parts, [
      { number: 1, ...CI_IS_RED },
      { number: 2, ...FIX_IT },
    ]);
  });
});

describe('the agent’s panel', () => {
  const notes = [
    { t: 1000, beat: 'agent', kind: 'note', agent: { task: 'Finish the test.' } },
    { t: 2000, beat: 'agent', kind: 'note', agent: { tool: 'run_list', say: 'Finds the run' } },
    { t: 3000, beat: 'agent', kind: 'note', agent: { tool: 'page_act', say: 'Clicks Orders' } },
    { t: 5000, beat: 'agent', kind: 'note', agent: { done: true } },
  ];
  const at = (n) => n.t / 1000;

  test('shows what the agent was asked and the calls it made by then, the last one running', () => {
    assert.deepEqual(agentPanel(notes, 3500, 10, at), {
      task: { text: 'Finish the test.', opacity: 1 },
      steps: [
        { tool: 'run_list', say: 'Finds the run', done: true, opacity: 1 },
        { tool: 'page_act', say: 'Clicks Orders', done: false, opacity: 1 },
      ],
    });
    assert.deepEqual(agentPanel(notes, 500, 0.5, at), { task: null, steps: [] });
  });

  test('marks every call done once the agent is, and fades each in from its time', () => {
    assert.ok(agentPanel(notes, 6000, 10, at).steps.every((step) => step.done));
    const fading = agentPanel(notes, 3000, 3.1, at).steps[1].opacity;
    assert.ok(fading > 0 && fading < 1, `the new call fades in (${fading})`);
  });

  test('is a window at the Runs window’s place, up from the agent’s first note, its calls off the key strip', () => {
    assert.deepEqual(world(WINDOWS).agent.frame, world(WINDOWS).runs.frame);
    assert.equal(world(WINDOWS).agent.crop, null);
    const log = take();
    log.story[1] = { ...log.story[1], focus: ['vscode', 'agent'] };
    log.raises = [{ t: 1500, up: 'tiles', window: 'vscode' }];
    log.gestures = notes.map((n) => ({ ...n, beat: 'red-run', t: n.t + 4000, what: 'the agent' }));
    const plan = planCut(log, { flashFrame: 24, frames: 10_000 });
    const red = plan.segments.find((s) => s.id === 'red-run');
    const late = plan.frames[Math.round((red.end - 0.1) * 30)];
    const agent = late.windows.find((w) => w.id === 'agent');
    assert.ok(agent, 'the panel is up at the beat’s end');
    assert.equal(agent.name, 'Coding agent · scripted for this video');
    assert.deepEqual(
      agent.agent.steps.map((step) => [step.say, step.done]),
      [
        ['Finds the run', true],
        ['Clicks Orders', true],
      ],
    );
    const early = plan.frames[Math.round((red.start + 0.2) * 30)];
    assert.equal(
      early.windows.some((w) => w.id === 'agent'),
      false,
      'not before its first note',
    );
    assert.ok(
      plan.frames.every((f) => !f.keys),
      'no key strip for the agent’s calls',
    );
  });
});
