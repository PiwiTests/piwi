import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { captureProblem, progressReader } from '../lib/capture.mjs';

describe('ffmpeg’s progress', () => {
  test('reads a line cut between two chunks whole', () => {
    const progress = progressReader();
    progress.read('frame=12\ndup_fr');
    assert.equal(progress.values.frame, '12');
    assert.equal(progress.values.dup_fr, undefined, 'half a line waits');
    progress.read('ames=3\ndrop_frames=1\nprogress=cont');
    assert.equal(progress.values.dup_frames, '3');
    assert.equal(progress.values.drop_frames, '1');
    progress.read('inue\n');
    assert.equal(progress.values.progress, 'continue');
  });

  test('keeps the latest value of a key', () => {
    const progress = progressReader();
    progress.read('frame=1\nframe=2\n');
    assert.equal(progress.values.frame, '2');
  });
});

describe('a capture’s problem', () => {
  const sound = { frames: 240, dup: 0, drop: 0, code: 0, signal: null, error: null, early: false, errors: '' };
  const times = { running: 0, stopped: 10_000, fps: 24 };

  test('none for a capture that ran to its stop', () => {
    assert.equal(captureProblem(sound, times), null);
  });

  test('an ffmpeg that did not run, ended before the take, or failed', () => {
    assert.match(captureProblem({ ...sound, error: 'spawn ffmpeg ENOENT' }, times), /did not run/);
    assert.match(captureProblem({ ...sound, early: true, code: 1 }, times), /ended before the take/);
    assert.match(captureProblem({ ...sound, code: 1 }, times), /exited with 1/);
  });

  test('a master shorter than 95 % of the time it ran', () => {
    assert.equal(captureProblem({ ...sound, frames: 229 }, times), null);
    assert.match(captureProblem({ ...sound, frames: 227 }, times), /227 frames for 240/);
  });
});
