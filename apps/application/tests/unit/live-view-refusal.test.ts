import { describe, expect, test } from 'vitest';
import { LIVE_VIEW_END_TEXT } from '#shared/live-view';
import { liveViewRefusalText } from '~/utils/live-view-refusal';

/** Why a view did not open, as the live view panel says it from the run's live view state or the refusal's status. */

const view = { shard: null, worker: 3, slot: 1, name: 'worker 2', hadImage: false };
const lane = { shard: null, worker: 3, slot: 1, connected: true, paused: null };
const open = { enabled: true, workers: [lane], viewers: 2, maxViewers: 16 };

describe('a view the instance refused', () => {
  test('says the person signed out, lost the run, or the instance does not answer', () => {
    expect(liveViewRefusalText({ status: 401 }, view)).toBe('You are signed out: sign in again to watch this run.');
    expect(liveViewRefusalText({ status: 403 }, view)).toBe('You can no longer open this run.');
    expect(liveViewRefusalText({ status: 404 }, view)).toBe('This run is no longer on the instance.');
    expect(liveViewRefusalText({ status: null }, view)).toBe(
      'The view did not open, and the instance does not answer.',
    );
  });

  test('says the live view was turned off, or the worker is gone from its lane', () => {
    expect(liveViewRefusalText({ ...open, enabled: false }, view)).toBe(LIVE_VIEW_END_TEXT.off);
    expect(liveViewRefusalText({ ...open, workers: [] }, view)).toBe(
      'Worker 2 is not in the run’s live view now: its tests may have ended.',
    );
    expect(liveViewRefusalText({ ...open, workers: [] }, { ...view, hadImage: true })).toBe(
      LIVE_VIEW_END_TEXT['worker-left'],
    );
  });

  test('finds a lane by its slot whichever worker holds it, and a view of a worker by its index', () => {
    const restarted = { ...lane, worker: 9 };
    expect(liveViewRefusalText({ ...open, workers: [restarted] }, view)).toBe('The view did not open. Try again.');
    expect(liveViewRefusalText({ ...open, workers: [restarted] }, { ...view, slot: null })).toContain(
      'is not in the run’s live view now',
    );
  });

  test('says the run has as many views as it allows', () => {
    expect(liveViewRefusalText({ ...open, viewers: 16 }, view)).toBe(
      '16 people at most watch one run at a time, and as many views of this run are open. Try again once one closes.',
    );
  });
});
