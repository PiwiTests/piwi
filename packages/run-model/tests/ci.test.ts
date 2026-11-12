import { describe, expect, it } from 'vitest';
import {
  CI_READ_ONLY,
  MAX_CI_RUNS_LISTED,
  ciRunName,
  ciRunWhere,
  ciRunsListed,
  ciTally,
  isCiMetadata,
  isCiOrigin,
  type CiRun,
} from '../src/ci';
import { englishRunSpeaker as en } from '../src/words';

const run = (id: number, over: Partial<CiRun> = {}): CiRun => ({
  id,
  projectId: 7,
  project: 'Shop',
  branch: 'feature/pay',
  status: 'running',
  startTime: `2026-11-12T10:${String(id % 60).padStart(2, '0')}:00.000Z`,
  total: 40,
  done: 12,
  failed: 1,
  flaky: 0,
  url: `https://piwi.example/test-runs/${id}`,
  ...over,
});

describe('the CI runs of a project in progress', () => {
  it('counts a run’s tally from the instance’s counts, never past the tests it holds', () => {
    expect(
      ciTally({ totalTests: 40, passedTests: 9, failedTests: 1, skippedTests: 1, didNotRunTests: 1, flakyTests: 2 }),
    ).toEqual({ total: 40, done: 12, failed: 1, flaky: 2 });
    // Retries counted again by the instance, and counts it does not send.
    expect(ciTally({ totalTests: 3, passedTests: 3, failedTests: 2 })).toEqual({
      total: 5,
      done: 5,
      failed: 2,
      flaky: 0,
    });
    expect(ciTally({ totalTests: 'x', passedTests: -1 })).toEqual({ total: 0, done: 0, failed: 0, flaky: 0 });
  });

  it('tells a CI run by its origin, else by the CI it names', () => {
    expect(isCiMetadata({ piwiOrigin: { kind: 'ci' } })).toBe(true);
    expect(isCiMetadata({ piwiOrigin: { kind: 'ci-rerun' }, ci: null })).toBe(true);
    expect(isCiMetadata({ piwiOrigin: { kind: 'editor', ref: 'ed-1' }, ci: { provider: 'github' } })).toBe(false);
    expect(isCiMetadata({ ci: { provider: 'github' } })).toBe(true);
    expect(isCiMetadata({ piwiOrigin: { kind: 'nonsense' } })).toBe(false);
    expect(isCiMetadata(null)).toBe(false);
    // The origin the instance lists a run with.
    expect(['ci', 'ci-rerun', 'local', 'editor', 'request', ''].map(isCiOrigin)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('lists those still in progress, the newest first, a few at most', () => {
    const listed = ciRunsListed([
      run(1),
      run(3, { status: 'passed' }),
      run(2, { status: 'finalizing' }),
      ...Array.from({ length: 8 }, (_, i) => run(10 + i)),
    ]);
    expect(listed).toHaveLength(MAX_CI_RUNS_LISTED);
    expect(listed.map((r) => r.id)).toEqual([17, 16, 15, 14, 13]);
    expect(ciRunsListed([run(1), run(2, { status: 'finalizing' })]).map((r) => r.id)).toEqual([2, 1]);
  });

  it('names a run by its number, and says where it runs', () => {
    expect(ciRunName(run(78), en)).toBe('CI run #78');
    const where = (r: CiRun, several: boolean) => {
      const message = ciRunWhere(r, several);
      return message ? en.say(message.key, message.args) : null;
    };
    expect(where(run(78), false)).toBe('on feature/pay');
    expect(where(run(78), true)).toBe('Shop, on feature/pay');
    expect(where(run(78, { branch: null }), true)).toBe('Shop');
    expect(where(run(78, { branch: null }), false)).toBeNull();
    expect(en.say(CI_READ_ONLY.key)).toContain('Read-only');
  });
});
