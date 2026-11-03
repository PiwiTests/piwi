import { describe, test, expect } from 'vitest';
import { describeDidNotRun } from '#shared/did-not-run';

const BLOCKER = { id: 7, title: 'adds the item to the cart' };

describe('describeDidNotRun', () => {
  test('a run that reached its maximum number of failures says how many failed', () => {
    expect(describeDidNotRun({ reason: 'max-failures', runFailedTests: 3 })).toEqual({
      text: 'The run reached its maximum number of failures (3 failed) and stopped before this test started.',
      parts: [
        {
          kind: 'text',
          text: 'The run reached its maximum number of failures (3 failed) and stopped before this test started.',
        },
      ],
      note: 'Reported by Playwright',
    });
    expect(describeDidNotRun({ reason: 'max-failures' }).text).toBe(
      'The run reached its maximum number of failures and stopped before this test started.',
    );
  });

  test('a global timeout and an interruption are run cutoffs Playwright reports', () => {
    expect(describeDidNotRun({ reason: 'global-timeout' })).toMatchObject({
      text: 'The run hit its global timeout before this test could start.',
      note: 'Reported by Playwright',
    });
    expect(describeDidNotRun({ reason: 'interrupted' })).toMatchObject({
      text: 'The run was interrupted before this test could start (a worker crashed or it was cancelled).',
      note: 'Reported by Playwright',
    });
  });

  test('an earlier failure in the serial group links the test that blocked it', () => {
    const d = describeDidNotRun({ reason: 'previous-failure', blockedByCase: BLOCKER });
    expect(d.text).toBe('Skipped after adds the item to the cart failed earlier in the same serial group.');
    expect(d.parts.find((p) => p.kind === 'test')).toEqual({
      kind: 'test',
      text: 'adds the item to the cart',
      id: 7,
      href: '/test-run-cases/7',
    });
    expect(d.note).toBeNull();
  });

  test('a failed beforeAll hook names the hook, and the note says what it does to the group', () => {
    const d = describeDidNotRun({
      reason: 'previous-failure',
      blockedByCase: { ...BLOCKER, failedIn: { hook: 'beforeAll' } },
    });
    expect(d.text).toBe('Skipped because the beforeAll hook failed while running adds the item to the cart.');
    expect(d.note).toBe('When a beforeAll hook fails, Playwright skips the rest of its group.');
  });

  test('a named hook or fixture is named, with no note', () => {
    const hook = describeDidNotRun({
      reason: 'previous-failure',
      blockedByCase: { ...BLOCKER, failedIn: { hook: 'hook "seed"' } },
    });
    expect(hook.text).toBe('Skipped because the "seed" hook failed while running adds the item to the cart.');
    expect(hook.note).toBeNull();
    const fixture = describeDidNotRun({
      reason: 'previous-failure',
      blockedByCase: { ...BLOCKER, failedIn: { hook: 'fixture "db"' } },
    });
    expect(fixture.text).toBe('Skipped because the "db" fixture failed while running adds the item to the cart.');
  });

  test('a failed project dependency links the test that failed there, and says what it does to its dependents', () => {
    const d = describeDidNotRun({ reason: 'dependency-failure', blockedByCase: BLOCKER });
    expect(d.text).toBe(
      "Skipped because adds the item to the cart failed in a project this test's project depends on.",
    );
    expect(d.parts.find((p) => p.kind === 'test')).toEqual({
      kind: 'test',
      text: 'adds the item to the cart',
      id: 7,
      href: '/test-run-cases/7',
    });
    expect(d.note).toBe('When a project fails, Playwright runs no test of the projects that depend on it.');
    expect(describeDidNotRun({ reason: 'dependency-failure' }).text).toBe(
      "Skipped because a project this test's project depends on failed.",
    );
  });

  test('an earlier failure with no blocker found', () => {
    expect(describeDidNotRun({ reason: 'previous-failure' })).toEqual({
      text: 'Skipped because an earlier test in its serial group failed.',
      parts: [{ kind: 'text', text: 'Skipped because an earlier test in its serial group failed.' }],
      note: null,
    });
  });

  test('no reason, or one it does not know', () => {
    for (const reason of [null, undefined, 'something-new']) {
      expect(describeDidNotRun({ reason })).toEqual({
        text: 'This test did not run; the reporter recorded no reason.',
        parts: [{ kind: 'text', text: 'This test did not run; the reporter recorded no reason.' }],
        note: null,
      });
    }
  });
});
