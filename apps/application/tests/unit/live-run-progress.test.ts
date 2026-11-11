import { describe, expect, test } from 'vitest';
import {
  MAX_KEPT_TALLIES,
  isLiveRun,
  keepTally,
  liveProgress,
  withLiveTally,
  type RunTally,
} from '../../app/utils/live-run-progress';

/**
 * How a runs list shows a running run from the tallies of the instance stream (`run-progress`): the row takes the
 * latest tally while its run runs, never one with fewer results than the row read, and says "120 of 400 · 2 failed".
 */

const counts = (passed: number, failed = 0, total = 400): RunTally => ({
  totalTests: total,
  passedTests: passed,
  failedTests: failed,
  skippedTests: 0,
  didNotRunTests: 0,
});

const row = (status: string, tally: RunTally) => ({ id: 93, status, projectName: 'shop', ...tally });

describe('withLiveTally', () => {
  test('gives a running run’s row the counts of its latest tally, and keeps its other fields', () => {
    const shown = withLiveTally(row('running', counts(10)), counts(118, 2));
    expect(shown).toEqual({ id: 93, status: 'running', projectName: 'shop', ...counts(118, 2) });
  });

  test('takes the tally of a run that initializes or finalizes too', () => {
    expect(withLiveTally(row('initializing', counts(0, 0, 0)), counts(3)).passedTests).toBe(3);
    expect(withLiveTally(row('finalizing', counts(390)), counts(398, 2)).passedTests).toBe(398);
  });

  test('keeps the row a read gave after the tally, with more results', () => {
    const read = row('running', counts(130, 2));
    expect(withLiveTally(read, counts(120, 2))).toBe(read);
  });

  test('takes a tally with as many results and a grown total, as a sharded run’s next shard starts', () => {
    const shown = withLiveTally(row('running', counts(50, 0, 200)), counts(50, 0, 400));
    expect(shown.totalTests).toBe(400);
  });

  test('keeps an ended run’s row, and a row with no tally, as the list read them', () => {
    const ended = row('passed', counts(400));
    expect(withLiveTally(ended, counts(410))).toBe(ended);
    const running = row('running', counts(10));
    expect(withLiveTally(running, undefined)).toBe(running);
  });
});

describe('liveProgress', () => {
  test('counts the results so far against the planned total, with the failed ones', () => {
    expect(liveProgress(counts(118, 2))).toEqual({ done: 120, total: 400, failed: 2, label: '120 of 400' });
    expect(liveProgress({ ...counts(100, 0), skippedTests: 15, didNotRunTests: 5 }).label).toBe('120 of 400');
  });

  test('never says more results than the planned total, as retries count again', () => {
    expect(liveProgress(counts(395, 12)).label).toBe('400 of 400');
  });

  test('counts the results alone before the run says its total', () => {
    expect(liveProgress(counts(7, 0, 0))).toEqual({ done: 7, total: 0, failed: 0, label: '7 done' });
  });
});

describe('keepTally', () => {
  test('keeps each run’s latest tally, and only its counts', () => {
    const tallies = new Map<number, RunTally>();
    keepTally(tallies, 5, { ...counts(1), runId: 5, projectId: 1, type: 'run-progress' } as RunTally);
    keepTally(tallies, 5, counts(2));
    expect([...tallies]).toEqual([[5, counts(2)]]);
  });

  test('lets the run heard from longest ago go past the most it keeps', () => {
    const tallies = new Map<number, RunTally>();
    for (let runId = 1; runId <= MAX_KEPT_TALLIES; runId++) keepTally(tallies, runId, counts(runId));
    // Run 1 is heard from again, so run 2 is now the oldest.
    keepTally(tallies, 1, counts(5));
    keepTally(tallies, MAX_KEPT_TALLIES + 1, counts(1));
    expect(tallies.size).toBe(MAX_KEPT_TALLIES);
    expect(tallies.has(1)).toBe(true);
    expect(tallies.has(2)).toBe(false);
  });
});

describe('isLiveRun', () => {
  test('names a run that initializes, runs or finalizes, and no ended one', () => {
    expect(['initializing', 'running', 'finalizing'].map((status) => isLiveRun({ status }))).toEqual([
      true,
      true,
      true,
    ]);
    expect(['passed', 'failed', 'interrupted', 'cancelled'].map((status) => isLiveRun({ status }))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
