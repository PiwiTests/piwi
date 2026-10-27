import { describe, expect, test } from 'vitest';
import type { CoverageFile, CoverageRuntime, LineRange } from '@piwitests/core/coverage';
import { lineImpact, sameBlob, type LineImpactInput } from '../../shared/line-impact';

const BASE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function server(extra: Partial<CoverageFile> = {}): CoverageFile {
  return { path: 'src/Services/OrderService.cs', runtime: 'server', blob: BASE, ...extra };
}

function browser(extra: Partial<CoverageFile> = {}): CoverageFile {
  return { path: 'src/lib/cart.ts', runtime: 'browser', blob: BASE, ...extra };
}

/** Tests reaching the file in one runtime each, with the coverage they recorded there. */
function testsOf(...entries: Array<[number, CoverageRuntime, CoverageFile[]]>): LineImpactInput['tests'] {
  const tests: LineImpactInput['tests'] = new Map();
  for (const [id, runtime, files] of entries) {
    const byRuntime = tests.get(id) ?? new Map();
    byRuntime.set(runtime, files);
    tests.set(id, byRuntime);
  }
  return tests;
}

/** The selected tests as `id via lines` strings, ids ascending. */
function selection(result: ReturnType<typeof lineImpact>): string[] {
  return [...result.selected.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([id, d]) =>
        `${id} ${d.via}${d.lines ? ` ${d.lines.map(([s, e]) => (s === e ? s : `${s}-${e}`)).join(',')}` : ''}`,
    );
}

// One method, lines 10-30, whose executable statements are 12-14, 18 and 25-28.
const METHOD: LineRange = [10, 30];
const EXECUTABLE: LineRange[] = [
  [12, 14],
  [18, 18],
  [25, 28],
];
const VERSION = { runtime: 'server' as const, executable: EXECUTABLE, functions: [METHOD] };

describe('sameBlob', () => {
  test('matches a full id with its abbreviation, case aside, and nothing shorter than seven characters', () => {
    expect(sameBlob(BASE, 'AAAAAAA')).toBe(true);
    expect(sameBlob('aaaaaaa', BASE)).toBe(true);
    expect(sameBlob(BASE, 'aaaaaa')).toBe(false);
    expect(sameBlob(BASE, OTHER)).toBe(false);
    expect(sameBlob(BASE, null)).toBe(false);
  });
});

describe('lineImpact: line coverage', () => {
  const tests = testsOf(
    [1, 'server', [server({ functions: [METHOD], lines: [[12, 18]] })]],
    [2, 'server', [server({ functions: [METHOD], lines: [[25, 28]] })]],
    [3, 'server', [server({ functions: [[40, 50]], lines: [[41, 42]] })]],
  );

  test('a changed executable line selects only the tests that ran it', () => {
    const result = lineImpact({ changed: [[13, 13]], blob: BASE, tests, versions: [VERSION] });
    expect(selection(result)).toEqual(['1 lines 13']);
    expect(result.ruledOut).toEqual([2, 3]);
    expect(result.notRun).toEqual([]);
  });

  test('a changed line that is not a statement selects every test that ran its function', () => {
    // Line 20 sits in the method between statements: a declaration or a brace.
    const result = lineImpact({ changed: [[20, 20]], blob: BASE, tests, versions: [VERSION] });
    expect(selection(result)).toEqual(['1 functions 20', '2 functions 20']);
    expect(result.ruledOut).toEqual([3]);
  });

  test('an executable line no test ran is not run, and rules every test out', () => {
    const only = testsOf([1, 'server', [server({ functions: [METHOD], lines: [[12, 18]] })]]);
    const result = lineImpact({ changed: [[26, 26]], blob: BASE, tests: only, versions: [VERSION] });
    expect(selection(result)).toEqual([]);
    expect(result.ruledOut).toEqual([1]);
    expect(result.notRun).toEqual([[26, 26]]);
  });

  test('without the executable lines, a changed line goes by its function', () => {
    const result = lineImpact({
      changed: [[26, 26]],
      blob: BASE,
      tests,
      versions: [{ runtime: 'server', executable: [], functions: [METHOD] }],
    });
    expect(selection(result)).toEqual(['1 functions 26', '2 functions 26']);
  });
});

describe('lineImpact: what stays at file level', () => {
  test('a change outside every known function selects every test reaching the file', () => {
    // An attribute or a field initializer above the method.
    const tests = testsOf(
      [1, 'server', [server({ functions: [METHOD], lines: [[12, 14]] })]],
      [2, 'server', [server({ functions: [[40, 50]], lines: [[41, 42]] })]],
    );
    const result = lineImpact({
      changed: [
        [8, 8],
        [13, 13],
      ],
      blob: BASE,
      tests,
      versions: [VERSION],
    });
    expect(selection(result)).toEqual(['1 lines 13', '2 file']);
    expect(result.fileLevel).toEqual([[8, 8]]);
  });

  test('a test whose coverage is of another version, or has no ranges, cannot be ruled out', () => {
    const tests = testsOf(
      [1, 'server', [server({ functions: [METHOD], lines: [[12, 14]] })]],
      [2, 'server', [server({ blob: OTHER, functions: [METHOD], lines: [[25, 28]] })]],
      [3, 'server', [{ path: 'src/Services/OrderService.cs', runtime: 'server' }]],
      [4, 'server', []],
    );
    const result = lineImpact({ changed: [[26, 26]], blob: BASE, tests, versions: [VERSION] });
    expect(selection(result)).toEqual(['2 file', '3 file', '4 file']);
    expect(result.ruledOut).toEqual([1]);
  });

  test('a test whose capture was incomplete is never ruled out', () => {
    const tests = testsOf([1, 'server', [server({ functions: [METHOD], lines: [[12, 14]] })]]);
    const result = lineImpact({
      changed: [[26, 26]],
      blob: BASE,
      tests,
      versions: [VERSION],
      incomplete: new Set([1]),
    });
    expect(selection(result)).toEqual(['1 file']);
  });

  test('with no version of the file at the base blob, every line is at file level', () => {
    const tests = testsOf([1, 'server', [server({ blob: OTHER, functions: [METHOD], lines: [[12, 14]] })]]);
    const result = lineImpact({ changed: [[13, 13]], blob: BASE, tests, versions: [] });
    expect(selection(result)).toEqual(['1 file']);
    expect(result.fileLevel).toEqual([[13, 13]]);
  });

  test('no changed line at all keeps every test', () => {
    const tests = testsOf([1, 'server', [server({ functions: [METHOD], lines: [[12, 14]] })]]);
    expect(selection(lineImpact({ changed: [], blob: BASE, tests, versions: [VERSION] }))).toEqual(['1 file']);
  });
});

describe('lineImpact: a change between functions', () => {
  // Two functions with no line between them, the way a minifier-free module often ends one and opens the next.
  const ADJACENT = {
    runtime: 'browser' as const,
    executable: [],
    functions: [
      [1, 5],
      [6, 10],
    ] as LineRange[],
  };

  test('an insertion between two adjacent functions runs at module level: file level', () => {
    const tests = testsOf(
      [1, 'browser', [browser({ functions: [[1, 5]] })]],
      [2, 'browser', [browser({ functions: [[12, 20]] })]],
    );
    // hunkBaseLines gives an insertion after line 5 as the base lines 5 and 6.
    const result = lineImpact({ changed: [[5, 6]], blob: BASE, tests, versions: [ADJACENT] });
    expect(selection(result)).toEqual(['1 file', '2 file']);
    expect(result.fileLevel).toEqual([[5, 6]]);
    expect(result.notRun).toEqual([]);
  });

  test('an insertion between two closures of one function stays in that function', () => {
    const tests = testsOf(
      [
        1,
        'browser',
        [
          browser({
            functions: [
              [1, 20],
              [3, 6],
              [7, 9],
            ],
          }),
        ],
      ],
      [2, 'browser', [browser({ functions: [[30, 40]] })]],
    );
    const result = lineImpact({
      changed: [[6, 7]],
      blob: BASE,
      tests,
      versions: [
        {
          runtime: 'browser',
          executable: [],
          functions: [
            [1, 20],
            [3, 6],
            [7, 9],
            [30, 40],
          ],
        },
      ],
    });
    expect(selection(result)).toEqual(['1 functions 6-7']);
    expect(result.ruledOut).toEqual([2]);
  });
});

describe('lineImpact: tests reaching the file another way', () => {
  test('what they ran is not a gap, and they are never narrowed', () => {
    const tests = testsOf([1, 'server', [server({ functions: [METHOD], lines: [[12, 18]] })]]);
    const others = [server({ functions: [METHOD], lines: [[25, 28]] })];
    const result = lineImpact({ changed: [[26, 26]], blob: BASE, tests, versions: [VERSION], others });
    expect(result.ruledOut).toEqual([1]);
    expect(result.notRun).toEqual([]);
    expect(result.selected.size).toBe(0);
  });

  test('the functions they ran are known functions of the version', () => {
    const tests = testsOf([1, 'browser', [browser({ functions: [[3, 9]] })]]);
    const others = [browser({ functions: [[22, 30]] })];
    // Without the other test's coverage, line 25 sits in no known function: file level.
    expect(selection(lineImpact({ changed: [[25, 25]], blob: BASE, tests, versions: [] }))).toEqual(['1 file']);
    const result = lineImpact({ changed: [[25, 25]], blob: BASE, tests, versions: [], others });
    expect(result.ruledOut).toEqual([1]);
    expect(result.notRun).toEqual([]);
  });
});

describe('lineImpact: function coverage', () => {
  test('browser coverage selects the tests that ran a function around the changed lines', () => {
    const tests = testsOf(
      [1, 'browser', [browser({ functions: [[3, 9]] })]],
      [2, 'browser', [browser({ functions: [[12, 20]] })]],
    );
    const result = lineImpact({
      changed: [[5, 6]],
      blob: 'aaaaaaa',
      tests,
      versions: [
        {
          runtime: 'browser',
          executable: [],
          functions: [
            [3, 9],
            [12, 20],
            [22, 30],
          ],
        },
      ],
    });
    expect(selection(result)).toEqual(['1 functions 5-6']);
    expect(result.ruledOut).toEqual([2]);
  });

  test('a function only the version lists, which no test ran, rules every test out and is not run', () => {
    const tests = testsOf([1, 'browser', [browser({ functions: [[3, 9]] })]]);
    const result = lineImpact({
      changed: [[25, 25]],
      blob: BASE,
      tests,
      versions: [
        {
          runtime: 'browser',
          executable: [],
          functions: [
            [3, 9],
            [22, 30],
          ],
        },
      ],
    });
    expect(result.ruledOut).toEqual([1]);
    expect(result.notRun).toEqual([[25, 25]]);
  });

  test('a function no run listed and no test ran is unknown code: file level', () => {
    // Module top-level code, or a function V8 never compiled.
    const tests = testsOf([1, 'browser', [browser({ functions: [[3, 9]] })]]);
    const result = lineImpact({ changed: [[25, 25]], blob: BASE, tests, versions: [] });
    expect(selection(result)).toEqual(['1 file']);
  });

  test('a test reaching the file in two runtimes is kept when either one ran the change', () => {
    const tests = testsOf(
      [1, 'browser', [browser({ path: 'src/lib/cart.ts', functions: [[3, 9]] })]],
      [1, 'server', [server({ path: 'src/lib/cart.ts', functions: [[12, 20]] })]],
    );
    const result = lineImpact({
      changed: [[15, 15]],
      blob: BASE,
      tests,
      versions: [
        {
          runtime: 'browser',
          executable: [],
          functions: [
            [3, 9],
            [12, 20],
          ],
        },
        {
          runtime: 'server',
          executable: [],
          functions: [
            [3, 9],
            [12, 20],
          ],
        },
      ],
    });
    expect(selection(result)).toEqual(['1 functions 15']);
  });
});
