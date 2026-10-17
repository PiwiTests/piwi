import { describe, expect, test } from 'vitest';
import { combineCoverage, leastCoveredFiles, type SuiteFile } from '#shared/coverage-combine';
import { enclosingFunction, gapSteps } from '~/utils/combined-coverage';

const BLOB = 'a'.repeat(40);
const file = (path: string, executable: number[][], lines: number[][]): SuiteFile => ({
  path,
  blob: BLOB,
  executable: executable as never,
  lines: lines as never,
  functions: [],
  allFunctions: [],
  linesRecorded: true,
});

describe('gapSteps', () => {
  const gaps: Array<[number, number]> = [
    [5, 6],
    [10, 12],
    [20, 20],
  ];

  test('makes the first gap next without a selection', () => {
    expect(gapSteps(gaps, null)).toEqual({ index: null, previous: null, next: [5, 6] });
  });

  test('steps from the gap a selection is in to the ones around it', () => {
    expect(gapSteps(gaps, [10, 12])).toEqual({ index: 1, previous: [5, 6], next: [20, 20] });
    expect(gapSteps(gaps, [20, 20])).toEqual({ index: 2, previous: [10, 12], next: null });
  });

  test('steps from a line between gaps', () => {
    expect(gapSteps(gaps, [8, 8])).toEqual({ index: null, previous: [5, 6], next: [10, 12] });
  });
});

describe('enclosingFunction', () => {
  test('takes the narrowest function holding the line', () => {
    expect(
      enclosingFunction(
        [
          [1, 30],
          [10, 15],
        ],
        12,
      ),
    ).toEqual([10, 15]);
    expect(enclosingFunction([[1, 5]], 9)).toBeNull();
  });
});

describe('leastCoveredFiles', () => {
  const combined = combineCoverage({
    inventory: null,
    inScope: () => true,
    spanTable: new Map(),
    suites: [
      {
        name: 'unit',
        kind: 'unit',
        files: [
          file('src/a.ts', [[1, 10]], [[1, 2]]),
          file('src/b.ts', [[1, 4]], [[1, 1]]),
          file('src/c.ts', [[1, 3]], [[1, 3]]),
          file('lib/d.ts', [[1, 20]], []),
        ],
      },
    ],
  });

  test('lists the files with the most lines no suite ran, leaving out a file every line of which ran', () => {
    expect(leastCoveredFiles(combined.files, '', 10).map((f) => [f.path, f.unrunLines])).toEqual([
      ['lib/d.ts', 20],
      ['src/a.ts', 8],
      ['src/b.ts', 3],
    ]);
  });

  test('keeps to a folder and a limit', () => {
    expect(leastCoveredFiles(combined.files, 'src', 1).map((f) => f.path)).toEqual(['src/a.ts']);
  });
});
