import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RunProgressBroadcast } from '../../server/utils/run-events';

/**
 * A CI run's pending commit status: the first tally goes at once, the next at most once a minute with the latest tally,
 * none once the run stopped, and the one on its way lands before `stop` resolves; its words say how far the run is.
 */

delete process.env.PIWI_DATABASE_URL;
const { PendingStatuses, closingStatusDescription, pendingStatusDescription } =
  await import('../../server/utils/scm/pending-status');

const tally = (runId: number, passed: number, failed = 0): RunProgressBroadcast => ({
  runId,
  projectId: 1,
  totalTests: 10,
  passedTests: passed,
  failedTests: failed,
  skippedTests: 0,
  didNotRunTests: 0,
});

afterEach(() => vi.useRealTimers());

describe('a run’s pending status', () => {
  test('goes at once, then once a minute with the latest tally, each run on its own', async () => {
    vi.useFakeTimers();
    const posted: RunProgressBroadcast[] = [];
    const statuses = new PendingStatuses(async (progress) => {
      posted.push(progress);
      return true;
    }, Date.now);
    statuses.progress(tally(7, 1));
    statuses.progress(tally(7, 2));
    statuses.progress(tally(7, 3, 1));
    statuses.progress(tally(8, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toEqual([tally(7, 1), tally(8, 1)]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(posted).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posted.at(-1)).toEqual(tally(7, 3, 1));
    expect(posted).toHaveLength(3);
  });

  test('stops with the run: the one on its way lands first, none goes after, and it says whether one went', async () => {
    vi.useFakeTimers();
    let land: (posted: boolean) => void = () => {};
    const posts: RunProgressBroadcast[] = [];
    const statuses = new PendingStatuses(
      (progress) =>
        new Promise<boolean>((resolve) => {
          posts.push(progress);
          land = resolve;
        }),
      Date.now,
    );
    statuses.progress(tally(7, 1));
    statuses.progress(tally(7, 2));
    let stopped: boolean | null = null;
    const stopping = statuses.stop(7).then((posted) => (stopped = posted));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBeNull();
    land(true);
    await stopping;
    expect(stopped).toBe(true);
    // A late tally of the stopped run, and the minute's send, post nothing.
    statuses.progress(tally(7, 5));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts).toEqual([tally(7, 1)]);
    expect(await statuses.stop(7)).toBe(false);
  });

  test('says no status went when the project posts none', async () => {
    const statuses = new PendingStatuses(async () => false, Date.now);
    statuses.progress(tally(9, 1));
    expect(await statuses.stop(9)).toBe(false);
  });
});

describe('what the statuses say', () => {
  test('how many tests ended of how many, and the failures once there are some', () => {
    expect(pendingStatusDescription(tally(7, 4))).toBe('Running: 4 of 10 tests');
    expect(pendingStatusDescription({ ...tally(7, 4, 2), skippedTests: 1, didNotRunTests: 1 })).toBe(
      'Running: 8 of 10 tests, 2 failed',
    );
  });

  test('how a run ended with no result', () => {
    expect(closingStatusDescription(7, 'cancelled')).toBe('Run #7 was cancelled before it ended');
    expect(closingStatusDescription(7, 'interrupted')).toBe('Run #7 was interrupted before it ended');
    expect(closingStatusDescription(7, 'passed')).toBe('Run #7 ended with no result to report');
  });
});
