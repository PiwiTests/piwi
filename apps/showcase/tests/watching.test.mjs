import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STOP_WORDS, laneLogProblems, watchedProblems } from '../lib/watching.mjs';

/** A lane panel's log: an image every second through two tests, then the run's end, said as the view says it. */
function laneLog({ frames = [], said = ['', 'The run ended.', 'The run passed: 3 tests.'] } = {}) {
  const shown = frames.length ? frames : Array.from({ length: 12 }, (_, i) => ({ t: 1000 * i, ended: i < 6 ? 0 : 1 }));
  const end = shown[shown.length - 1].t;
  return { frames: shown, statuses: said.map((text, i) => ({ t: end + i, text, ended: 2 })) };
}

describe('the dashboard’s live view of a CI run’s lane', () => {
  test('has no problem when images came through each test until the view said the run passed', () => {
    assert.deepEqual(laneLogProblems(laneLog()), []);
  });

  test('ended before the run, or never said the run passed', () => {
    assert.match(laneLogProblems(laneLog({ said: ['', 'The test ended.'] })).join('\n'), /never said how the run/);
    assert.match(laneLogProblems(laneLog({ said: ['', 'The test ended.'] })).join('\n'), /ended before the run/);
    const failed = laneLogProblems(laneLog({ said: ['', 'The run failed: 1 of 3 tests failed.'] }));
    assert.match(failed.join('\n'), /did not pass/);
  });

  test('showed no image, or none of a test of its lane, or none for a long while', () => {
    assert.match(laneLogProblems({ frames: [], statuses: laneLog().statuses }).join('\n'), /showed 0 images/);
    const firstTestOnly = Array.from({ length: 6 }, (_, i) => ({ t: 1000 * i, ended: 0 }));
    assert.match(laneLogProblems(laneLog({ frames: firstTestOnly })).join('\n'), /no image of the lane's test 2 of 2/);
    const paused = laneLog().frames.map((f, i) => ({ ...f, t: f.t + (i >= 6 ? 20_000 : 0) }));
    assert.match(laneLogProblems(laneLog({ frames: paused })).join('\n'), /no image for 21 s/);
  });

  test('froze before the run ended, though it showed each test', () => {
    const log = laneLog();
    const frozen = { ...log, statuses: log.statuses.map((status) => ({ ...status, t: status.t + 16_000 })) };
    assert.match(laneLogProblems(frozen).join('\n'), /no image for 16.001 s/);
  });

  test('watched a lane that ran a single test, which hands over to no next one', () => {
    const one = Array.from({ length: 4 }, (_, i) => ({ t: 1000 * i, ended: 0 }));
    const statuses = [
      { t: 0, text: '', ended: 0 },
      { t: 4000, text: 'The run passed: 3 tests.', ended: 1 },
    ];
    assert.match(laneLogProblems({ frames: one, statuses }).join('\n'), /ran 1 test while watched/);
  });
});

describe('the Runs window’s live view of a running test', () => {
  /** A look every `every` ms, each showing `src(i)`, the test stopped at `stopped` of them. */
  const looks = (count, src, { every = 250, stopped = 0 } = {}) =>
    Array.from({ length: count }, (_, i) => ({ t: i * every, src: src(i), stopped }));

  test('has no problem when it showed the page changing through the watch, the test unstopped', () => {
    assert.deepEqual(watchedProblems(looks(20, (i) => `data:${Math.floor(i / 4)}`)), []);
  });

  test('judges the images and their times, however few looks the watch took', () => {
    assert.deepEqual(watchedProblems(looks(13, (i) => `data:${i}`, { every: 400 })), []);
    assert.deepEqual(watchedProblems(looks(6, (i) => `data:${i}`, { every: 1000 })), []);
  });

  test('showed no image, the same one, or the test stopped', () => {
    assert.match(watchedProblems(looks(20, () => null)).join('\n'), /showed at 0 of 20 looks/);
    assert.match(watchedProblems(looks(20, () => 'data:1')).join('\n'), /showed 1 images/);
    const stopped = watchedProblems(looks(20, (i) => `data:${i}`, { stopped: 1 }));
    assert.match(stopped.join('\n'), /stopped while it was watched/);
  });

  test('froze for most of the watch, then changed at its end', () => {
    const frozen = looks(20, (i) => (i < 17 ? 'data:0' : `data:${i}`));
    assert.match(watchedProblems(frozen).join('\n'), /showed one image for 4.25 s/);
  });
});

describe('the words of a stop in the Runs window', () => {
  test('match every way a worker stands at a stop or its failure', () => {
    for (const said of [
      'Stopped at a breakpoint',
      'Stopped after a step',
      'Paused',
      'Paused by the agent',
      'Stopped',
      'Stopped at page.pause()',
      'Stopped at the line the agent ran it to',
      'Failed, held at its line',
      'Failed at checkout-page.ts:12',
    ]) {
      assert.match(said, STOP_WORDS);
    }
  });

  test('match no other state, nor a control', () => {
    for (const said of ['Running', 'Between tests', 'Pausing…', 'Pause', 'Pause all', 'Resume']) {
      assert.doesNotMatch(said, STOP_WORDS);
    }
  });
});
