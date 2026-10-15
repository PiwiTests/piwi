import { describe, expect, test } from 'vitest';
import type { CoverageCapture, CoverageFile } from '@piwitests/core/coverage';
import {
  bestExplanation,
  compactFileCoverage,
  coverageLoss,
  divergeCaptures,
  divergenceMarkdown,
  explainableGroups,
  failuresFollow,
  nearestTest,
  parseTargetLines,
  reachOfTargets,
  subtractLineRanges,
  varyingCode,
  type CoverageDivergenceAnswer,
  type VariationExecution,
} from '#shared/coverage-insights';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASKET = 'src/Services/BasketService.cs';
const ORDERS = 'src/Services/OrderService.cs';
const LAYOUT = 'src/Web/Views/_Layout.cshtml';

const server = (path: string, blob: string, lines: Array<[number, number]>, functions?: Array<[number, number]>) =>
  ({ path, runtime: 'server', blob, lines, ...(functions ? { functions } : {}) }) as CoverageFile;
const capture = (files: CoverageFile[], incomplete = false): CoverageCapture =>
  incomplete ? { v: 1, files, incomplete: true } : { v: 1, files };

describe('range helpers', () => {
  test('subtracts ranges', () => {
    expect(
      subtractLineRanges(
        [
          [1, 10],
          [20, 30],
        ],
        [
          [3, 4],
          [8, 22],
          [25, 25],
        ],
      ),
    ).toEqual([
      [1, 2],
      [5, 7],
      [23, 24],
      [26, 30],
    ]);
    expect(subtractLineRanges([[1, 5]], [])).toEqual([[1, 5]]);
    expect(subtractLineRanges([[1, 5]], [[1, 9]])).toEqual([]);
  });

  test('parses target lines', () => {
    expect(parseTargetLines('57-59, 63,58')).toEqual([
      [57, 59],
      [63, 63],
    ]);
    expect(parseTargetLines('')).toBeNull();
    expect(parseTargetLines('5-3')).toBeNull();
    expect(parseTargetLines('abc')).toBeNull();
  });
});

describe('divergeCaptures', () => {
  test('lists the files and lines only one side ran, and marks a file whose version changed', () => {
    const here = capture([
      server(BASKET, A, [
        [10, 20],
        [40, 45],
      ]),
      server(ORDERS, A, [[1, 5]]),
      server(LAYOUT, A, [[1, 9]]),
    ]);
    const baseline = capture([
      server(BASKET, A, [
        [10, 20],
        [30, 35],
      ]),
      server(LAYOUT, B, [[1, 9]]),
      server('src/Services/PaymentService.cs', A, [[7, 8]]),
    ]);
    const result = divergeCaptures(here, baseline);
    expect(result.summary).toEqual({
      filesCompared: 1,
      filesOnlyHere: 1,
      filesOnlyBaseline: 1,
      filesDiverged: 1,
      filesChanged: 1,
      linesOnlyHere: 11,
      linesOnlyBaseline: 8,
      functionsOnlyHere: 0,
      functionsOnlyBaseline: 0,
    });
    expect(result.files.map((f) => [f.status, f.path])).toEqual([
      ['only-here', ORDERS],
      ['diverged', BASKET],
      ['only-baseline', 'src/Services/PaymentService.cs'],
      ['changed', LAYOUT],
    ]);
    expect(result.files[1]).toMatchObject({ linesOnlyHere: [[40, 45]], linesOnlyBaseline: [[30, 35]] });
    expect(result.files[3]).toMatchObject({ blob: A, baselineBlob: B });
  });

  test('an incomplete side yields no claim that the other side ran something it did not', () => {
    const here = capture([server(BASKET, A, [[1, 5]]), server(ORDERS, A, [[1, 2]])], true);
    const baseline = capture([server(BASKET, A, [[1, 9]]), server(LAYOUT, A, [[1, 3]])]);
    const result = divergeCaptures(here, baseline);
    // The failing execution's capture is incomplete: what only the baseline ran is not claimed.
    expect(result.files.map((f) => f.status)).toEqual(['only-here']);
    expect(result.summary.linesOnlyBaseline).toBe(0);

    const reversed = divergeCaptures(baseline, here);
    expect(reversed.files.map((f) => [f.status, f.path])).toEqual([['only-baseline', ORDERS]]);
    expect(reversed.summary.linesOnlyHere).toBe(0);
  });

  test('the AI context section names the baseline and the code only this run took', () => {
    const answer: CoverageDivergenceAnswer = {
      available: true,
      executionId: 9,
      baseline: {
        executionId: 4,
        runId: 2,
        startedAt: '2026-09-01T00:00:00.000Z',
        branch: 'main',
        commit: 'c'.repeat(40),
        project: 'chromium',
        sameProject: true,
        sameBranch: true,
      },
      ...divergeCaptures(
        capture([server(BASKET, A, [[1, 9]]), server(ORDERS, A, [[3, 4]])]),
        capture([server(BASKET, A, [[1, 5]])]),
      ),
    };
    const markdown = divergenceMarkdown(answer)!;
    expect(markdown).toContain('## Code Paths vs the Last Passing Run');
    expect(markdown).toContain('execution #4, run #2');
    expect(markdown).toContain(`- \`${ORDERS}\` (server) (whole file) lines 3-4`);
    expect(markdown).toContain(`- \`${BASKET}\` (server) lines 6-9`);
    expect(divergenceMarkdown({ ...answer, available: false, files: [] })).toBeNull();
  });
});

describe('varyingCode and its explanation', () => {
  /** Eight executions: the even ones ran the discount branch (lines 50-60), the odd ones did not. */
  function executions(): VariationExecution[] {
    return Array.from({ length: 8 }, (_, i) => ({
      id: 100 - i,
      failed: i % 2 === 0 && i < 6,
      startedAt: 1_000 * (8 - i),
      capture: capture([
        server(
          BASKET,
          A,
          i % 2 === 0
            ? [
                [10, 20],
                [50, 60],
              ]
            : [[10, 20]],
        ),
        // A file whose version changed across the runs is left out.
        server(ORDERS, i < 4 ? A : B, [[1, 3]]),
      ]),
    }));
  }

  test('groups the code by the executions that ran it', () => {
    const { groups, files } = varyingCode(executions());
    expect(files).toEqual({ compared: 1, changedVersion: 1 });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.code).toMatchObject({
      ranIn: 4,
      failedIn: 3,
      lines: 11,
      files: [{ path: BASKET, blob: A, lines: [[50, 60]] }],
      examples: { ran: [100, 98, 96], notRan: [99, 97, 95] },
    });
  });

  test('names the earlier test whose having run predicts the split, by the best relation', () => {
    const list = executions();
    const { groups } = varyingCode(list);
    const universe = 0b11111111;
    const explainable = explainableGroups(groups, universe);
    expect(explainable).toEqual([0]);
    const evens = 0b01010101;
    const found = bestExplanation(
      groups,
      explainable,
      [
        // Ran before every even execution in the run, and before one odd one on the worker only.
        { testCaseId: 7, run: evens, worker: evens | 0b10 },
        // Ran before the odd ones: predicts the code by its absence.
        { testCaseId: 3, run: ~evens & universe, worker: 0 },
        // Ran before every execution: never a candidate.
        { testCaseId: 5, run: universe, worker: universe },
      ],
      universe,
    );
    expect(found).toEqual({
      varying: 0,
      testCaseId: 3,
      relation: 'earlier-in-run',
      effect: 'prevents-code',
      agreement: 1,
      before: { executions: 4, ranCode: 0 },
      notBefore: { executions: 4, ranCode: 4 },
    });
  });

  test('needs three executions on each side and 90% agreement', () => {
    const list = executions().slice(0, 5);
    const { groups } = varyingCode(list);
    expect(explainableGroups(groups, 0b11111)).toEqual([]);
    const { groups: eight } = varyingCode(executions());
    // Agrees on 7 of 8 executions: below 90%.
    expect(bestExplanation(eight, [0], [{ testCaseId: 7, run: 0b01010111, worker: 0 }], 0xff)).toBeNull();
  });

  test('says when the failures fall on one side of the code', () => {
    const list = executions();
    const { groups } = varyingCode(list);
    expect(failuresFollow(groups, list, 0)).toEqual({ varying: 0, side: 'ran', failed: 3, onSide: 3 });
    const mixed = list.map((e, i) => ({ ...e, failed: i < 2 }));
    expect(failuresFollow(groups, mixed, 0)).toBeNull();
  });

  test('compares functions when the executions recorded no lines, and files without ranges', () => {
    const list: VariationExecution[] = [0, 1, 2].map((i) => ({
      id: i + 1,
      failed: false,
      startedAt: null,
      capture: capture([
        {
          path: BASKET,
          runtime: 'server',
          blob: A,
          functions:
            i === 0
              ? [
                  [1, 9],
                  [20, 30],
                ]
              : [[1, 9]],
        },
        ...(i === 2 ? [{ path: 'src/app.js', runtime: 'browser' } as CoverageFile] : []),
      ]),
    }));
    const { groups } = varyingCode(list);
    expect(groups.map((g) => g.code.files)).toEqual([
      [{ path: BASKET, runtime: 'server', blob: A, functions: [[20, 30]] }],
      [{ path: 'src/app.js', runtime: 'browser', file: true }],
    ]);
  });
});

describe('coverageLoss', () => {
  const counts = (entries: Array<[string, number, number]>) =>
    new Map(entries.map(([path, steady, flaky]) => [`server\x00${path}`, { steady, flaky }]));

  test('the lines no other trusted test runs, those only flaky tests run, and files no other test reaches', () => {
    const ours = [
      server(BASKET, A, [[1, 20]], [[1, 20]]),
      server(ORDERS, A, [[1, 5]]),
      server(LAYOUT, A, [[1, 9]]),
      server('src/Services/Refunds.cs', A, [[3, 4]]),
    ];
    const others = [
      { ...server(BASKET, A, [[1, 10]], [[1, 20]]), steady: 2, flaky: 0 },
      { ...server(BASKET, A, [[11, 15]]), steady: 0, flaky: 1 },
      { ...server(LAYOUT, B, [[1, 9]]), steady: 3, flaky: 0 },
      { ...server('src/Services/Refunds.cs', A, [[1, 9]]), steady: 0, flaky: 2 },
    ];
    const result = coverageLoss(
      ours,
      others,
      counts([
        [BASKET, 2, 1],
        [LAYOUT, 3, 0],
        ['src/Services/Refunds.cs', 0, 2],
      ]),
    );
    expect(result.files).toEqual([
      {
        path: ORDERS,
        runtime: 'server',
        blob: A,
        status: 'only-these',
        lines: [[1, 5]],
        otherTests: { steady: 0, flaky: 0 },
      },
      {
        path: 'src/Services/Refunds.cs',
        runtime: 'server',
        blob: A,
        status: 'only-flaky',
        onlyFlakyLines: [[3, 4]],
        otherTests: { steady: 0, flaky: 2 },
      },
      {
        path: BASKET,
        runtime: 'server',
        blob: A,
        status: 'partial',
        lines: [[16, 20]],
        onlyFlakyLines: [[11, 15]],
        otherTests: { steady: 2, flaky: 1 },
      },
      { path: LAYOUT, runtime: 'server', blob: A, status: 'uncertain', otherTests: { steady: 3, flaky: 0 } },
    ]);
    expect(result.summary).toMatchObject({
      files: 4,
      filesCovered: 0,
      filesOnlyThese: 1,
      filesOnlyFlaky: 1,
      filesPartial: 1,
      filesUncertain: 1,
      lines: 10,
      onlyFlakyLines: 7,
    });
  });

  test('a file other steady tests run every line of is covered', () => {
    const result = coverageLoss(
      [server(BASKET, A, [[1, 5]])],
      [{ ...server(BASKET, A, [[1, 9]]), steady: 1, flaky: 0 }],
      counts([[BASKET, 1, 0]]),
    );
    expect(result.files).toEqual([]);
    expect(result.summary.filesCovered).toBe(1);
  });

  test('a function other tests ran a line of, recorded by line, is not lost', () => {
    const functionsOnly = {
      path: BASKET,
      runtime: 'server',
      blob: A,
      functions: [
        [1, 10],
        [20, 30],
      ],
    } as CoverageFile;
    const result = coverageLoss(
      [functionsOnly],
      [{ ...server(BASKET, A, [[4, 6]]), steady: 1, flaky: 0 }],
      counts([[BASKET, 1, 0]]),
    );
    expect(result.files).toMatchObject([{ path: BASKET, status: 'partial', functions: [[20, 30]] }]);
    expect(result.summary.functions).toBe(1);
  });

  test('a file these tests recorded both by line and by file alone counts once', () => {
    const result = coverageLoss(
      [server(BASKET, A, [[1, 5]]), { path: BASKET, runtime: 'server' } as CoverageFile],
      [{ ...server(BASKET, A, [[1, 9]]), steady: 1, flaky: 0 }],
      counts([[BASKET, 1, 0]]),
    );
    expect(result.summary).toMatchObject({ files: 1, filesCovered: 1 });
  });
});

describe('reachOfTargets', () => {
  const entry = server(BASKET, A, [[50, 60]], [[40, 80]]);

  test('splits the target lines into ran and not ran, setting aside lines that cannot run', () => {
    expect(
      reachOfTargets(
        entry,
        true,
        [[55, 65]],
        [
          [40, 58],
          [62, 80],
        ],
      ),
    ).toEqual({
      granularity: 'lines',
      ran: [[55, 58]],
      notRan: [[62, 65]],
      unknown: [],
      notExecutable: [[59, 61]],
      allRan: false,
    });
  });

  test('an incomplete capture turns what it did not record into unknown', () => {
    expect(reachOfTargets(entry, false, [[59, 62]], null)).toEqual({
      granularity: 'lines',
      ran: [[59, 60]],
      notRan: [],
      unknown: [[61, 62]],
      allRan: false,
    });
  });

  test('a file the execution did not reach ran none of the lines', () => {
    expect(reachOfTargets(null, true, [[1, 2]], null)).toMatchObject({ ran: [], notRan: [[1, 2]], allRan: false });
  });

  test('functions say a line ran when a function around it ran', () => {
    const functionsOnly = { path: BASKET, runtime: 'server', blob: A, functions: [[40, 80]] } as CoverageFile;
    expect(reachOfTargets(functionsOnly, true, [[79, 82]], null)).toMatchObject({
      granularity: 'functions',
      ran: [[79, 80]],
      notRan: [[81, 82]],
    });
  });
});

describe('nearestTest and compactFileCoverage', () => {
  const view = {
    file: BASKET,
    branch: 'main',
    executable: [{ path: BASKET, runtime: 'server' as const, blob: A, lines: [[1, 100]] as Array<[number, number]> }],
    fragments: [
      { ...server(BASKET, A, [[40, 50]], [[40, 80]]), tests: [0] },
      { ...server(BASKET, A, [[40, 70]], [[40, 80]]), tests: [1] },
      { ...server(BASKET, B, [[1, 99]]), tests: [2] },
    ],
    tests: [
      { id: 11, title: 'adds an item', file: 'tests/basket.spec.ts', status: 'passed' as const },
      { id: 12, title: 'applies a coupon', file: 'tests/basket.spec.ts', status: 'flaky' as const },
      { id: 13, title: 'old', file: 'tests/old.spec.ts', status: 'passed' as const },
    ],
  };

  test('names the test running most of the function around the target, at the target version', () => {
    expect(nearestTest(view, [[75, 76]], { blob: A })).toEqual({
      testCaseId: 12,
      title: 'applies a coupon',
      filePath: 'tests/basket.spec.ts',
      status: 'flaky',
      function: [40, 80],
      executedLines: 31,
      ranTarget: [],
      sameVersion: true,
    });
    expect(nearestTest(view, [[75, 76]], { blob: A, excludeTestId: 12 })?.testCaseId).toBe(11);
  });

  test('falls back to any version when no test ran the target version', () => {
    expect(nearestTest(view, [[5, 6]], { blob: 'f'.repeat(40) })).toMatchObject({
      testCaseId: 13,
      sameVersion: false,
      function: null,
    });
  });

  test('compacts a file’s coverage into ranges grouped by the tests that ran them', () => {
    const compact = compactFileCoverage(view);
    expect(compact.tests.map((t) => t.testCaseId)).toEqual([11, 12, 13]);
    expect(compact.versions[0]).toEqual({
      path: BASKET,
      runtime: 'server',
      blob: A,
      executable: '1-100',
      lines: [
        { lines: '40-50', tests: [0, 1] },
        { lines: '51-70', tests: [1] },
      ],
    });
  });
});
