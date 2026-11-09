import { describe, expect, test } from 'vitest';
import { fileVersionId, forecastReuse, type ForecastResult } from '../../shared/reuse-forecast';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);
const OPTS = { from: T0, maxSourceAgeMs: 14 * DAY };

const v = (path: string, blob: string) => fileVersionId('browser', path, blob);

let nextId = 1;
function result(overrides: Partial<ForecastResult> & { at: number }): ForecastResult {
  const id = nextId++;
  return {
    executionId: id,
    runId: id,
    testCaseId: 1,
    browserName: 'chromium',
    scope: 'default-branch',
    outcome: 'passed',
    durationMs: 1_000,
    versions: new Set([v('src/cart.ts', 'a'), v('src/api.ts', 'b')]),
    ciCommit: null,
    ...overrides,
  };
}

describe('forecastReuse', () => {
  test('a result that ran the versions of an earlier pass is reusable', () => {
    const out = forecastReuse([result({ at: T0 + DAY }), result({ at: T0 + 2 * DAY, durationMs: 3_000 })], OPTS);
    expect(out.total).toMatchObject({
      results: 2,
      comparable: 2,
      reusable: 1,
      durationMs: 4_000,
      reusableDurationMs: 3_000,
    });
    expect(out.tests).toEqual([]);
  });

  test('a changed version of a file the pass ran makes the result run', () => {
    const out = forecastReuse(
      [
        result({ at: T0 + DAY }),
        result({ at: T0 + 2 * DAY, versions: new Set([v('src/cart.ts', 'c'), v('src/api.ts', 'b')]) }),
      ],
      OPTS,
    );
    expect(out.total.reusable).toBe(0);
  });

  test('a result that ran more files than the pass is still reusable: the pass’s code had not changed', () => {
    const out = forecastReuse(
      [
        result({ at: T0 + DAY }),
        result({
          at: T0 + 2 * DAY,
          versions: new Set([v('src/cart.ts', 'a'), v('src/api.ts', 'b'), v('src/x.ts', 'd')]),
        }),
      ],
      OPTS,
    );
    expect(out.total.reusable).toBe(1);
  });

  test('a pass older than the maximum age stands in for nothing', () => {
    const out = forecastReuse([result({ at: T0 }), result({ at: T0 + 15 * DAY })], OPTS);
    expect(out.total.reusable).toBe(0);
  });

  test('a pass of the same run, another project or another test stands in for nothing', () => {
    const out = forecastReuse(
      [
        result({ at: T0 + DAY, runId: 50 }),
        result({ at: T0 + DAY + 1, runId: 50 }),
        result({ at: T0 + DAY + 2, browserName: 'firefox' }),
        result({ at: T0 + DAY + 3, testCaseId: 2 }),
      ],
      OPTS,
    );
    expect(out.total.reusable).toBe(0);
  });

  test('within one run, the pass of an earlier run stands in', () => {
    const out = forecastReuse(
      [
        result({ at: T0 + DAY, runId: 40 }),
        result({ at: T0 + 2 * DAY, runId: 50 }),
        result({ at: T0 + 2 * DAY + 1, runId: 50 }),
      ],
      OPTS,
    );
    expect(out.total.reusable).toBe(2);
  });

  test('a retried pass or a failure is no source, and an incomparable result is not reusable', () => {
    const out = forecastReuse(
      [
        result({ at: T0 + DAY, outcome: 'flaky' }),
        result({ at: T0 + 2 * DAY, outcome: 'failed' }),
        result({ at: T0 + 3 * DAY }),
        result({ at: T0 + 4 * DAY, versions: null }),
        result({ at: T0 + 5 * DAY, versions: new Set() }),
      ],
      OPTS,
    );
    expect(out.total).toMatchObject({ results: 5, comparable: 3, reusable: 0 });
  });

  test('any pass of the last 14 days counts, not only the newest', () => {
    const out = forecastReuse(
      [
        result({ at: T0 + DAY }),
        result({
          at: T0 + 2 * DAY,
          scope: 'other-branches',
          versions: new Set([v('src/cart.ts', 'c'), v('src/api.ts', 'b')]),
        }),
        result({ at: T0 + 3 * DAY }),
      ],
      OPTS,
    );
    expect(out.total.reusable).toBe(1);
    expect(out.scopes['default-branch'].reusable).toBe(1);
  });

  test('a failure that stopped early is reusable at the CI commit of a pass, and only there', () => {
    const early = new Set([v('src/cart.ts', 'a')]);
    const out = forecastReuse(
      [
        result({ at: T0 + DAY, ciCommit: 'c1' }),
        result({ at: T0 + 2 * DAY, ciCommit: 'c1', outcome: 'failed', versions: early }),
        result({ at: T0 + 3 * DAY, ciCommit: 'c2', outcome: 'failed', versions: early }),
        result({ at: T0 + 4 * DAY, ciCommit: null, outcome: 'failed', versions: null }),
      ],
      OPTS,
    );
    expect(out.total).toMatchObject({ results: 4, comparable: 3, reusable: 1, failed: 1 });
  });

  test('failures and retried passes with the code unchanged are counted and listed by test', () => {
    const pass = result({ at: T0 + DAY });
    const failed = result({ at: T0 + 2 * DAY, outcome: 'failed' });
    const flaky = result({ at: T0 + 3 * DAY, outcome: 'flaky' });
    const other = result({ at: T0 + 3 * DAY, testCaseId: 2 });
    const otherFailed = result({ at: T0 + 4 * DAY, testCaseId: 2, outcome: 'failed' });
    const out = forecastReuse([otherFailed, flaky, pass, failed, other], OPTS);
    expect(out.total).toMatchObject({ reusable: 3, failed: 2, flaky: 1 });
    expect(out.tests).toEqual([
      {
        testCaseId: 1,
        browserName: 'chromium',
        failed: 1,
        flaky: 1,
        lastExecutionId: flaky.executionId,
        sourceExecutionId: pass.executionId,
      },
      {
        testCaseId: 2,
        browserName: 'chromium',
        failed: 1,
        flaky: 0,
        lastExecutionId: otherFailed.executionId,
        sourceExecutionId: other.executionId,
      },
    ]);
  });

  test('results before the window serve as passes only, and each scope counts its own results', () => {
    const out = forecastReuse(
      [result({ at: T0 - DAY }), result({ at: T0 + DAY, scope: 'other-branches' }), result({ at: T0 + 2 * DAY })],
      OPTS,
    );
    expect(out.total).toMatchObject({ results: 2, reusable: 2 });
    expect(out.scopes['default-branch']).toMatchObject({ results: 1, reusable: 1 });
    expect(out.scopes['other-branches']).toMatchObject({ results: 1, reusable: 1 });
  });
});
