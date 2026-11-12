import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { laneLogProblems, watchedProblems } from '../lib/watching.mjs';

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
});

describe('the Runs window’s live view of a running test', () => {
  const every = 250;
  const ms = 5000;
  const looks = (count, src, stopped = 0) => Array.from({ length: count }, (_, i) => ({ src: src(i), stopped }));

  test('has no problem when it showed the page changing at each look, the test unstopped', () => {
    assert.deepEqual(
      watchedProblems(
        looks(20, (i) => `data:${Math.floor(i / 4)}`),
        { ms, every },
      ),
      [],
    );
  });

  test('showed no image, the same one, or the test stopped', () => {
    assert.match(
      watchedProblems(
        looks(20, () => null),
        { ms, every },
      ).join('\n'),
      /showed at 0 of 20 looks/,
    );
    assert.match(
      watchedProblems(
        looks(20, () => 'data:1'),
        { ms, every },
      ).join('\n'),
      /showed 1 images/,
    );
    const stopped = watchedProblems(
      looks(20, (i) => `data:${i}`, 1),
      { ms, every },
    );
    assert.match(stopped.join('\n'), /stopped while it was watched/);
  });
});
