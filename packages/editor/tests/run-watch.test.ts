import { describe, expect, test } from 'vitest';
import { catalogCaseOf, exitVerdict, repeatVerdict } from '../src/run-watch';

describe('the test a live run event names by its title', () => {
  const cases = [
    { id: 1, title: 'pays', filePath: 'tests/checkout.spec.ts', suitePath: 'guest' },
    { id: 2, title: 'pays', filePath: 'tests/checkout.spec.ts', suitePath: 'member\x1fwith a coupon' },
    { id: 3, title: 'refunds', filePath: 'tests/checkout.spec.ts', suitePath: '' },
  ];

  test('is the case of its title and suite path, in a file that repeats the title across describe blocks', () => {
    expect(catalogCaseOf(cases, 'pays', ['guest'])).toBe(1);
    expect(catalogCaseOf(cases, 'pays', ['member', 'with a coupon'])).toBe(2);
    expect(catalogCaseOf(cases, 'refunds', [])).toBe(3);
  });

  test('is none when the title is ambiguous, or nothing matches', () => {
    expect(catalogCaseOf(cases, 'pays', null)).toBeNull();
    expect(catalogCaseOf(cases, 'pays', ['member'])).toBeNull();
    expect(catalogCaseOf(cases, 'ships', ['guest'])).toBeNull();
  });

  test('is read by its title alone from a catalog without suite paths', () => {
    const titled = cases.map(({ suitePath: _suite, ...c }) => c);
    expect(catalogCaseOf(titled, 'refunds', ['anywhere'])).toBe(3);
    expect(catalogCaseOf(titled, 'pays', ['guest'])).toBeNull();
  });
});

describe('the verdict of a run of each test several times', () => {
  const run = (failedTests: number, totalTests = 1, skippedTests = 0) => ({ totalTests, failedTests, skippedTests });

  const verdict = (...args: Parameters<typeof repeatVerdict>) => repeatVerdict(...args).verdict;

  test('counts the runs its stream brought', () => {
    expect(repeatVerdict(3, { passed: 3, failed: 0, skipped: 0 }, run(0))).toEqual({
      verdict: 'Passed 3 of 3',
      failed: false,
    });
    expect(repeatVerdict(3, { passed: 2, failed: 1, skipped: 0 }, run(1))).toEqual({
      verdict: 'Failed 1 of 3',
      failed: true,
    });
    // Two tests, or one test on two Playwright projects.
    expect(verdict(3, { passed: 4, failed: 2, skipped: 0 }, run(1, 2))).toBe('Failed 2 of 6');
    expect(verdict(3, { passed: 3, failed: 0, skipped: 3 }, run(0, 2, 1))).toBe('Passed 3 of 6, 3 skipped');
    expect(verdict(3, { passed: 0, failed: 0, skipped: 3 }, run(0, 1, 1))).toBe('Skipped 3 of 3');
  });

  test('says what the run is sure of when its stream did not bring every result', () => {
    expect(verdict(3, { passed: 1, failed: 0, skipped: 0 }, run(0))).toBe('Passed 3 of 3');
    expect(repeatVerdict(3, { passed: 1, failed: 0, skipped: 0 }, run(1))).toEqual({
      verdict: 'Failed at least 1 of 3',
      failed: true,
    });
    expect(verdict(3, { passed: 0, failed: 0, skipped: 0 }, run(0, 0))).toBe('No test ran');
  });

  test('is read from the exit code when the run reached no instance', () => {
    expect(exitVerdict(3, 0, 'tests/checkout.spec.ts:42')).toEqual({
      severity: 'information',
      message: 'Passed 3 of 3: tests/checkout.spec.ts:42',
    });
    expect(exitVerdict(3, 1, 'tests/checkout.spec.ts:42')).toEqual({
      severity: 'warning',
      message: 'Failed at least 1 of 3: tests/checkout.spec.ts:42 (exit code 1)',
    });
    expect(exitVerdict(3, null, 'tests/checkout.spec.ts:42').message).toBe(
      'The 3 runs of tests/checkout.spec.ts:42 ended without an exit code: see the output.',
    );
  });
});
