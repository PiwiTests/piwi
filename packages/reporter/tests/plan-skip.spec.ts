import * as path from 'node:path';
import type { TestCase } from '@playwright/test/reporter';
import { describe, expect, it } from 'vitest';
import {
  parseTestListLine,
  planSkipReasons,
  planToSkip,
  skipPlannedTests,
  testListName,
} from '../src/internal/support/plan-skip.js';

/** A test as Playwright hands it to `preprocess`, with what the names read. */
function testCase(file: string, title: string, id = title): TestCase {
  return { id, title, location: { file, line: 1, column: 1 } } as unknown as TestCase;
}

describe('planToSkip', () => {
  it('names the plan only beside PIWI_PLAN_SKIP', () => {
    expect(planToSkip({ PIWI_PLAN: '9', PIWI_PLAN_SKIP: 'true' })).toBe(9);
    expect(planToSkip({ PIWI_PLAN: '9', PIWI_PLAN_SKIP: '1' })).toBe(9);
    expect(planToSkip({ PIWI_PLAN: '9' })).toBeNull();
    expect(planToSkip({ PIWI_PLAN: '9', PIWI_PLAN_SKIP: 'false' })).toBeNull();
    expect(planToSkip({ PIWI_PLAN: 'nine', PIWI_PLAN_SKIP: 'true' })).toBeNull();
    expect(planToSkip({ PIWI_PLAN_SKIP: 'true' })).toBeNull();
  });
});

describe('parseTestListLine', () => {
  it('reads a line as Playwright reads a test list', () => {
    expect(parseTestListLine('[chromium] › tests/a.spec.ts › cart › adds')).toEqual({
      project: 'chromium',
      file: 'tests/a.spec.ts',
      titles: ['cart', 'adds'],
    });
    expect(parseTestListLine('  tests/a.spec.ts:12:3 > adds  ')).toEqual({
      project: null,
      file: 'tests/a.spec.ts',
      titles: ['adds'],
    });
    expect(parseTestListLine('# a comment')).toBeNull();
    expect(parseTestListLine('   ')).toBeNull();
    expect(parseTestListLine('[chromium › tests/a.spec.ts › adds')).toBeNull();
  });
});

describe('the tests a plan skips', () => {
  const root = path.resolve('/work/e2e');
  const tests = [
    { test: testCase(path.join(root, 'tests/a.spec.ts'), 'adds'), project: 'chromium', suitePath: ['cart'] },
    { test: testCase(path.join(root, 'tests/a.spec.ts'), 'adds', 'adds-ff'), project: 'firefox', suitePath: ['cart'] },
    { test: testCase(path.join(root, 'tests/a.spec.ts'), 'pays'), project: 'chromium', suitePath: [] },
    // Named by a line's start only: a test the plan does not name exactly runs.
    { test: testCase(path.join(root, 'tests/a.spec.ts'), 'twice'), project: 'chromium', suitePath: ['cart', 'adds'] },
  ].map(({ test, project, suitePath }) => ({ test, name: testListName(test, root, project, suitePath) }));

  it('skips each test a line names, in its project, with the run whose pass stands in for it', () => {
    const reasons = planSkipReasons(
      {
        skip: ['[chromium] › tests/a.spec.ts › cart › adds', '[chromium] › tests/a.spec.ts › pays'],
        reused: [
          {
            testCaseId: 1,
            sourceRunId: 41,
            projects: ['chromium'],
            skip: ['[chromium] › tests/a.spec.ts › cart › adds'],
          },
        ],
      },
      9,
    );
    const calls: Array<[string, string]> = [];
    const skipped = skipPlannedTests((test, reason) => calls.push([test.id, reason]), tests, reasons);
    expect(calls).toEqual([
      ['adds', 'passed in run #41'],
      // An answer that names no run beside a line: the plan's.
      ['pays', 'passed in an earlier run (pass reuse plan 9)'],
    ]);
    expect(skipped.map((test) => test.id)).toEqual(['adds', 'pays']);
  });

  it('names a file from Playwright’s root with forward slashes', () => {
    expect(tests[0]!.name).toEqual({ project: 'chromium', file: 'tests/a.spec.ts', titles: ['cart', 'adds'] });
  });

  it('refuses an answer that is not a plan', () => {
    expect(() => planSkipReasons({ message: 'Pass reuse is off for this project' }, 9)).toThrow(/not a plan/);
    expect(() => planSkipReasons(null, 9)).toThrow(/not a plan/);
  });
});
