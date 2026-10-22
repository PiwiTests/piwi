import { describe, it, expect } from 'vitest';
import {
  resolveUnrunReason,
  linkBlockedTests,
  classifyStatus,
  resolveExpectedStatus,
  isExpectedFailurePassed,
  bugOutcome,
  lastAttempts,
  looksFixed,
  looksFixedTests,
  type BlockableCase,
} from '../src/status-classify.js';

describe('resolveUnrunReason', () => {
  it('reads a timed-out run as the global timeout', () => {
    expect(resolveUnrunReason('timedout', { maxFailures: 0, failures: 3 })).toBe('global-timeout');
    // A reached failure budget never overrides the global timeout.
    expect(resolveUnrunReason('timedout', { maxFailures: 2, failures: 5 })).toBe('global-timeout');
  });

  it('reads an interrupted run that hit its failure budget as max-failures', () => {
    expect(resolveUnrunReason('interrupted', { maxFailures: 3, failures: 3 })).toBe('max-failures');
    expect(resolveUnrunReason('interrupted', { maxFailures: 3, failures: 4 })).toBe('max-failures');
  });

  it('falls back to a generic interruption', () => {
    expect(resolveUnrunReason('interrupted', { maxFailures: 0, failures: 1 })).toBe('interrupted');
    expect(resolveUnrunReason('interrupted', { maxFailures: 5, failures: 2 })).toBe('interrupted');
    expect(resolveUnrunReason(undefined, { maxFailures: 0, failures: 0 })).toBe('interrupted');
  });
});

describe('linkBlockedTests', () => {
  it('links a cascade to the failing sibling in the same serial group', () => {
    const cases: BlockableCase[] = [
      { location: 'auth.spec.ts:3:1', suitePath: ['Login'], status: 'failed' },
      { location: 'auth.spec.ts:7:1', suitePath: ['Login'], status: 'didnotrun', didNotRunReason: 'previous-failure' },
      { location: 'auth.spec.ts:11:1', suitePath: ['Login'], status: 'didnotrun', didNotRunReason: 'previous-failure' },
    ];
    linkBlockedTests(cases);
    expect(cases[1]!.blockedBy).toBe('auth.spec.ts:3:1');
    expect(cases[2]!.blockedBy).toBe('auth.spec.ts:3:1');
  });

  it('matches a timed-out test as the blocker', () => {
    const cases: BlockableCase[] = [
      { location: 'flow.spec.ts:3:1', suitePath: ['Flow'], status: 'timedOut' },
      { location: 'flow.spec.ts:7:1', suitePath: ['Flow'], status: 'didnotrun', didNotRunReason: 'previous-failure' },
    ];
    linkBlockedTests(cases);
    expect(cases[1]!.blockedBy).toBe('flow.spec.ts:3:1');
  });

  it('links a nested serial describe to the parent-group failure via the deepest shared prefix', () => {
    const cases: BlockableCase[] = [
      { location: 'a.spec.ts:3:1', suitePath: ['Outer'], status: 'failed' },
      {
        location: 'a.spec.ts:9:1',
        suitePath: ['Outer', 'Inner'],
        status: 'didnotrun',
        didNotRunReason: 'previous-failure',
      },
    ];
    linkBlockedTests(cases);
    expect(cases[1]!.blockedBy).toBe('a.spec.ts:3:1');
  });

  it('leaves blockedBy null when no failure shares the file', () => {
    const cases: BlockableCase[] = [
      { location: 'other.spec.ts:3:1', suitePath: ['X'], status: 'failed' },
      { location: 'a.spec.ts:9:1', suitePath: ['A'], status: 'didnotrun', didNotRunReason: 'previous-failure' },
    ];
    linkBlockedTests(cases);
    expect(cases[1]!.blockedBy).toBeUndefined();
  });

  it('ignores non-cascade did-not-run cases (global timeout, max failures)', () => {
    const cases: BlockableCase[] = [
      { location: 'a.spec.ts:3:1', suitePath: ['A'], status: 'failed' },
      { location: 'a.spec.ts:9:1', suitePath: ['A'], status: 'didnotrun', didNotRunReason: 'global-timeout' },
    ];
    linkBlockedTests(cases);
    expect(cases[1]!.blockedBy).toBeUndefined();
  });
});

describe('expected status', () => {
  it('keeps the status Playwright reported', () => {
    expect(resolveExpectedStatus('failed', [])).toBe('failed');
    expect(resolveExpectedStatus('skipped', [{ type: 'fail' }])).toBe('skipped');
  });

  it('derives it from the annotations when none was reported', () => {
    expect(resolveExpectedStatus(undefined, [{ type: 'fail' }])).toBe('failed');
    expect(resolveExpectedStatus(null, [{ type: 'fail' }, { type: 'fixme' }])).toBe('skipped');
    expect(resolveExpectedStatus('bogus', null)).toBe('passed');
  });

  it('tells an expected failure that passed from every other row', () => {
    const passedBody = classifyStatus('passed', [{ type: 'fail' }]);
    const failedBody = classifyStatus('failed', [{ type: 'fail' }]);
    expect(isExpectedFailurePassed(passedBody, 'failed')).toBe(true);
    expect(isExpectedFailurePassed(failedBody, 'failed')).toBe(false);
    expect(isExpectedFailurePassed('failed', 'passed')).toBe(false);
    expect(isExpectedFailurePassed('failed', null)).toBe(false);
  });
});

describe('lastAttempts', () => {
  it('keeps the attempt with the most retries for each test', () => {
    const rows = [
      { testCaseId: 1, retries: 0, status: 'failed' },
      { testCaseId: 2, retries: null, status: 'passed' },
      { testCaseId: 1, retries: 1, status: 'passed' },
    ];
    expect(lastAttempts(rows)).toEqual([
      { testCaseId: 1, retries: 1, status: 'passed' },
      { testCaseId: 2, retries: null, status: 'passed' },
    ]);
  });
});

describe('lastAttempts per project', () => {
  it('keeps one last attempt per test and browser project', () => {
    const rows = [
      { testCaseId: 1, browserName: 'chromium', retries: 0, status: 'failed' },
      { testCaseId: 1, browserName: 'webkit', retries: 1, status: 'passed' },
      { testCaseId: 1, browserName: 'chromium', retries: 1, status: 'passed' },
      { testCaseId: 1, browserName: 'webkit', retries: 0, status: 'failed' },
    ];
    expect(lastAttempts(rows)).toEqual([
      { testCaseId: 1, browserName: 'chromium', retries: 1, status: 'passed' },
      { testCaseId: 1, browserName: 'webkit', retries: 1, status: 'passed' },
    ]);
  });

  it('breaks a tie on retries by the higher id, whatever the row order', () => {
    const a = { id: 5, testCaseId: 1, retries: 0 };
    const b = { id: 9, testCaseId: 1, retries: 0 };
    expect(lastAttempts([a, b])).toEqual([b]);
    expect(lastAttempts([b, a])).toEqual([b]);
  });
});

describe('lastAttempts per repetition', () => {
  it('keeps one last attempt per `--repeat-each` repetition, each with its own retries', () => {
    const rows = [
      { id: 1, testCaseId: 1, repeatEachIndex: 0, retries: 0, status: 'passed' },
      { id: 2, testCaseId: 1, repeatEachIndex: 1, retries: 0, status: 'failed' },
      { id: 3, testCaseId: 1, repeatEachIndex: 2, retries: 0, status: 'passed' },
      { id: 4, testCaseId: 1, repeatEachIndex: 1, retries: 1, status: 'failed' },
    ];
    expect(lastAttempts(rows).map((r) => r.id)).toEqual([1, 4, 3]);
  });

  it('reads a row without a repetition as the first one', () => {
    const a = { id: 5, testCaseId: 1, retries: 0 };
    const b = { id: 9, testCaseId: 1, repeatEachIndex: 0, retries: 0 };
    expect(lastAttempts([a, b])).toEqual([b]);
  });

  it('keeps the bug open while one repetition still reproduces it', () => {
    const rows = [
      { id: 1, testCaseId: 7, repeatEachIndex: 0, retries: 0, status: 'failed', expectedStatus: 'failed' },
      { id: 2, testCaseId: 7, repeatEachIndex: 1, retries: 0, status: 'passed', expectedStatus: 'failed' },
      { id: 3, testCaseId: 8, repeatEachIndex: 0, retries: 0, status: 'failed', expectedStatus: 'failed' },
      { id: 4, testCaseId: 8, repeatEachIndex: 1, retries: 0, status: 'failed', expectedStatus: 'failed' },
    ];
    expect(looksFixedTests(rows).map((r) => r.testCaseId)).toEqual([8]);
  });
});

describe('looksFixed', () => {
  const fixed = { status: 'failed', expectedStatus: 'failed' };
  const stillFails = { status: 'passed', expectedStatus: 'failed' };
  const plainPass = { status: 'passed', expectedStatus: 'passed' };
  const plainFail = { status: 'failed', expectedStatus: 'passed' };
  const skipped = { status: 'skipped', expectedStatus: 'failed' };

  it('needs every project that ran the test to agree', () => {
    expect(looksFixed([fixed])).toBe(true);
    expect(looksFixed([fixed, fixed])).toBe(true);
    expect(looksFixed([fixed, stillFails])).toBe(false);
    expect(looksFixed([stillFails, fixed])).toBe(false);
    expect(looksFixed([fixed, plainFail])).toBe(false);
  });

  it('lets a project without `test.fail()` that passed, or one that did not run, agree', () => {
    expect(looksFixed([fixed, plainPass])).toBe(true);
    expect(looksFixed([fixed, skipped])).toBe(true);
    expect(looksFixed([plainPass])).toBe(false);
    expect(looksFixed([])).toBe(false);
  });

  it('reads the last attempt of each project, whatever the row order', () => {
    const rows = [
      { id: 1, testCaseId: 7, browserName: 'chromium', retries: 0, ...fixed },
      { id: 2, testCaseId: 7, browserName: 'webkit', retries: 0, ...stillFails },
      { id: 3, testCaseId: 8, browserName: 'chromium', retries: 0, ...fixed },
      { id: 4, testCaseId: 8, browserName: 'webkit', retries: 0, ...fixed },
    ];
    expect(looksFixedTests(rows).map((r) => r.testCaseId)).toEqual([8]);
    expect(looksFixedTests([...rows].reverse()).map((r) => r.testCaseId)).toEqual([8]);
  });

  it('names where the attempts leave the bug', () => {
    expect(bugOutcome([fixed, plainPass])).toBe('looks-fixed');
    expect(bugOutcome([plainPass, plainPass])).toBe('passed');
    expect(bugOutcome([skipped])).toBe('not-run');
    expect(bugOutcome([fixed, stillFails])).toBe('fails');
    expect(bugOutcome([plainPass, plainFail])).toBe('fails');
  });
});
