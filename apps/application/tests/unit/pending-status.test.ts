import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RunProgressBroadcast } from '../../server/utils/run-events';
import type { PendingPoster, StatusTarget } from '../../server/utils/scm/pending-status';

/**
 * A CI run's pending commit status: the first tally goes at once, the next at most once a minute with the latest tally,
 * none once the run stopped for good, and the one on its way lands before `stop` resolves with where it went; a second
 * stop resolves as the first; a run the project posts no status for is let go; a run stopped for its silence posts
 * again once it goes on. Its words say how far the run is.
 */

delete process.env.PIWI_DATABASE_URL;
const { PendingStatuses, closingStatusDescription, pendingStatusDescription } =
  await import('../../server/utils/scm/pending-status');

const tally = (runId: number, passed: number, failed = 0, total = 10): RunProgressBroadcast => ({
  runId,
  projectId: 1,
  totalTests: total,
  passedTests: passed,
  failedTests: failed,
  skippedTests: 0,
  didNotRunTests: 0,
});

const target = { commit: 'abc', context: 'piwi' } as StatusTarget;

/** A poster that records each post, answering `posted`; `targets` says which runs have a target. */
function poster(posted = true, targets: (runId: number) => boolean = () => true) {
  const posts: RunProgressBroadcast[] = [];
  const looked: number[] = [];
  const it: PendingPoster = {
    target: async (runId) => {
      looked.push(runId);
      return targets(runId) ? target : null;
    },
    post: async (_target, progress) => {
      posts.push(progress);
      return posted;
    },
  };
  return { it, posts, looked };
}

afterEach(() => vi.useRealTimers());

describe('a run’s pending status', () => {
  test('goes at once, then once a minute with the latest tally, each run on its own', async () => {
    vi.useFakeTimers();
    const { it, posts } = poster();
    const statuses = new PendingStatuses(it, Date.now);
    statuses.progress(tally(7, 1));
    statuses.progress(tally(7, 2));
    statuses.progress(tally(7, 3, 1));
    statuses.progress(tally(8, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toEqual([tally(7, 1), tally(8, 1)]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(posts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posts.at(-1)).toEqual(tally(7, 3, 1));
    expect(posts).toHaveLength(3);
  });

  test('stops with the run: the one on its way lands first, none goes after, and a second stop learns the same', async () => {
    vi.useFakeTimers();
    let land: (posted: boolean) => void = () => {};
    const posts: RunProgressBroadcast[] = [];
    const statuses = new PendingStatuses(
      {
        target: async () => target,
        post: (_target, progress) =>
          new Promise<boolean>((resolve) => {
            posts.push(progress);
            land = resolve;
          }),
      },
      Date.now,
    );
    statuses.progress(tally(7, 1));
    statuses.progress(tally(7, 2));
    await vi.advanceTimersByTimeAsync(0);
    let first: StatusTarget | null | undefined;
    let second: StatusTarget | null | undefined;
    void statuses.stop(7).then((stopped) => (first = stopped));
    void statuses.stop(7).then((stopped) => (second = stopped));
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toBeUndefined();
    land(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toBe(target);
    expect(second).toBe(target);
    // A late tally of the stopped run, and the minute's send, post nothing.
    statuses.progress(tally(7, 5));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts).toEqual([tally(7, 1)]);
    expect(await statuses.stop(7)).toBeNull();
  });

  test('says no status went when none was taken, and lets go of a run the project posts none for', async () => {
    vi.useFakeTimers();
    const refused = poster(false);
    const statuses = new PendingStatuses(refused.it, Date.now);
    statuses.progress(tally(9, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(await statuses.stop(9)).toBeNull();

    const none = poster(true, (runId) => runId !== 5);
    const others = new PendingStatuses(none.it, Date.now);
    others.progress(tally(5, 1));
    await vi.advanceTimersByTimeAsync(0);
    others.progress(tally(5, 2));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(none.looked).toEqual([5]);
    expect(none.posts).toEqual([]);
  });

  test('a run stopped for its silence posts again once it goes on', async () => {
    vi.useFakeTimers();
    const { it, posts } = poster();
    const statuses = new PendingStatuses(it, Date.now);
    statuses.progress(tally(7, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(await statuses.stop(7, false)).toBe(target);
    statuses.progress(tally(7, 4));
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toEqual([tally(7, 1), tally(7, 4)]);
  });
});

describe('what the statuses say', () => {
  test('how many tests have a result, at most the total, and how many results failed', () => {
    expect(pendingStatusDescription(tally(7, 4))).toBe('Running: 4 of 10 tests');
    expect(pendingStatusDescription({ ...tally(7, 4, 2), skippedTests: 1, didNotRunTests: 1 })).toBe(
      'Running: 8 of 10 tests, 2 failed',
    );
    expect(pendingStatusDescription(tally(7, 11, 2))).toBe('Running: 10 of 10 tests, 2 failed');
    expect(pendingStatusDescription(tally(7, 7, 0, 0))).toBe('Running: 7 done');
  });

  test('how a run ended with no result', () => {
    expect(closingStatusDescription(7, 'cancelled')).toBe('Run #7 was cancelled before it ended');
    expect(closingStatusDescription(7, 'interrupted')).toBe('Run #7 was interrupted before it ended');
    expect(closingStatusDescription(7, null)).toBe('Run #7 was deleted before it ended');
    expect(closingStatusDescription(7, 'passed')).toBe('Run #7 ended with no result to report');
  });
});
