import { describe, expect, test } from 'vitest';
import type { PiwiContext } from '../src/context';
import { statusAlarm } from '../src/server';

type Failure = { testCaseId: number; source?: 'baseline' | 'overlay'; runId?: number; isNew?: boolean };

/** A context reading CI run #41, the runs laid over it, and the editor's own runs among them. */
const contextOf = (failures: Failure[], ownRuns: number[] = [42], resolved: Array<{ testCaseId: number }> = []) =>
  ({
    failures: { run: { id: 41, origin: 'ci' }, failures, overlays: [], resolved },
    ownRuns: new Set(ownRuns),
  }) as unknown as PiwiContext;

describe('the status item’s alarm', () => {
  const ownNew: Failure = { testCaseId: 1, source: 'overlay', runId: 42, isNew: true };

  test('with new, only for a test the editor’s own run failed that the baseline does not fail', () => {
    expect(statusAlarm(contextOf([ownNew]), 'new')).toBe(true);
    // CI run #41's own failures, new on the instance or not: counted, never the alarm.
    expect(statusAlarm(contextOf([{ testCaseId: 1, source: 'baseline', runId: 41, isNew: true }]), 'new')).toBe(false);
    // A teammate's run, or a CI run laid over the baseline.
    expect(statusAlarm(contextOf([{ ...ownNew, runId: 43 }]), 'new')).toBe(false);
    // A test the baseline failed too on this project.
    expect(statusAlarm(contextOf([{ ...ownNew, isNew: false }]), 'new')).toBe(false);
    // A test the baseline fails on another Playwright project.
    expect(
      statusAlarm(contextOf([ownNew, { testCaseId: 1, source: 'baseline', runId: 41, isNew: false }]), 'new'),
    ).toBe(false);
    // A test the baseline failed on another project that a later run failed again, or fixed since.
    expect(statusAlarm(contextOf([ownNew, { ...ownNew, isNew: false }]), 'new')).toBe(false);
    expect(statusAlarm(contextOf([ownNew], [42], [{ testCaseId: 1 }]), 'new')).toBe(false);
    // Once a run fixed it, the test is no longer listed.
    expect(statusAlarm(contextOf([]), 'new')).toBe(false);
  });

  test('with any, for any failing test; never with never', () => {
    const ci = contextOf([{ testCaseId: 1, source: 'baseline', runId: 41, isNew: false }]);
    expect(statusAlarm(ci, 'any')).toBe(true);
    expect(statusAlarm(contextOf([]), 'any')).toBe(false);
    expect(statusAlarm(contextOf([ownNew]), 'never')).toBe(false);
  });
});
