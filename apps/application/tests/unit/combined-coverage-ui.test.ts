import { describe, expect, test } from 'vitest';
import { combineCoverage, coverageTreeLevel, leastCoveredFiles, type SuiteFile } from '#shared/coverage-combine';
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

describe('coverageTreeLevel', () => {
  const combined = combineCoverage({
    inventory: null,
    inScope: () => true,
    spanTable: new Map(),
    suites: [
      {
        name: 'unit',
        kind: 'unit',
        files: [file('src/a.ts', [[1, 10]], [[1, 4]]), file('src/lib/b.ts', [[1, 4]], [[1, 4]])],
      },
    ],
  });
  const withoutData = ['src/idle.ts', 'src/lib/old.ts', 'src/docs/readme.md'];

  test('lists a folder’s children with their lines not run, and the files no suite names in place', () => {
    expect(
      coverageTreeLevel(combined.files, withoutData, 'src').map((e) => [
        e.path,
        e.kind,
        e.executableLines,
        e.unrunLines,
        e.filesWithoutData,
        e.noData,
      ]),
    ).toEqual([
      ['src/docs', 'folder', 0, 0, 1, false],
      ['src/lib', 'folder', 4, 0, 1, false],
      ['src/a.ts', 'file', 10, 6, 0, false],
      ['src/idle.ts', 'file', 0, 0, 1, true],
    ]);
  });

  test('starts from the repository root', () => {
    expect(coverageTreeLevel(combined.files, withoutData, '').map((e) => [e.path, e.filesWithoutData])).toEqual([
      ['src', 3],
    ]);
  });
});
