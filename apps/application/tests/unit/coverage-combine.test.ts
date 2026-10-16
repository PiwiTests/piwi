import { describe, expect, test } from 'vitest';
import type { LineRange } from '@piwitests/core/coverage';
import {
  combineCoverage,
  coveragePercent,
  folderBreakdown,
  subtractLineRanges,
  type SuiteFile,
  type SuiteInput,
} from '#shared/coverage-combine';

const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);
const all = () => true;

function file(path: string, over: Partial<SuiteFile> = {}): SuiteFile {
  return {
    path,
    blob: BLOB_A,
    executable: [],
    lines: [],
    functions: [],
    allFunctions: [],
    linesRecorded: true,
    ...over,
  };
}

const unit = (files: SuiteFile[], name = 'unit-back'): SuiteInput => ({ name, kind: 'unit', files });
const e2e = (files: SuiteFile[]): SuiteInput => ({ name: 'e2e', kind: 'e2e', files });

describe('subtractLineRanges', () => {
  test('leaves the lines of the first ranges the second do not hold', () => {
    expect(
      subtractLineRanges(
        [[1, 10]],
        [
          [3, 4],
          [8, 12],
        ],
      ),
    ).toEqual([
      [1, 2],
      [5, 7],
    ]);
    expect(
      subtractLineRanges(
        [
          [1, 3],
          [5, 6],
        ],
        [],
      ),
    ).toEqual([
      [1, 3],
      [5, 6],
    ]);
    expect(subtractLineRanges([[1, 3]], [[1, 3]])).toEqual([]);
  });
});

describe('combineCoverage', () => {
  test('counts every suite on the span table’s lines when a run recorded them, ignoring a tool’s other lines', () => {
    // The unit tool counts braces (lines 1, 5, 9) the span table does not.
    const span = new Map<string, LineRange[]>([
      [
        `src/Shop.cs\0${BLOB_A}`,
        [
          [2, 4],
          [6, 8],
        ],
      ],
    ]);
    const result = combineCoverage({
      inventory: null,
      inScope: all,
      spanTable: span,
      suites: [
        unit([file('src/Shop.cs', { executable: [[1, 9]], lines: [[1, 5]] })]),
        e2e([file('src/Shop.cs', { lines: [[6, 7]] })]),
      ],
    });
    const [shop] = result.files;
    expect(shop).toMatchObject({
      reference: 'span-table',
      executable: [
        [2, 4],
        [6, 8],
      ],
      executed: [
        [2, 4],
        [6, 7],
      ],
    });
    expect(shop!.classes).toEqual({
      unitOnly: [[2, 4]],
      e2eOnly: [[6, 7]],
      both: [],
      none: [[8, 8]],
      undetermined: [],
    });
    expect(result.totals).toMatchObject({ executableLines: 6, executedLines: 5, unitOnlyLines: 3, e2eOnlyLines: 2 });
    expect(result.suites.map((s) => [s.name, s.executedLines, s.executableLines])).toEqual([
      ['unit-back', 3, 6],
      ['e2e', 2, 6],
    ]);
    expect(result.filesReferencedByReports).toBe(0);
  });

  test('takes the reports’ lines for a version no run recorded, the union when two tools report it', () => {
    const result = combineCoverage({
      inventory: null,
      inScope: all,
      spanTable: new Map(),
      suites: [
        unit([file('src/a.ts', { executable: [[1, 4]], lines: [[1, 1]] })], 'unit-a'),
        unit([file('src/a.ts', { executable: [[3, 6]], lines: [[6, 6]] })], 'unit-b'),
      ],
    });
    expect(result.files[0]).toMatchObject({
      reference: 'report',
      executable: [[1, 6]],
      executed: [
        [1, 1],
        [6, 6],
      ],
    });
    expect(result.filesReferencedByReports).toBe(1);
  });

  test('marks unrun lines inside a function the browser suite ran as undetermined, never as run', () => {
    const result = combineCoverage({
      inventory: null,
      inScope: all,
      spanTable: new Map(),
      suites: [
        unit([
          file('src/cart.ts', {
            executable: [
              [2, 3],
              [6, 7],
              [10, 11],
            ],
            lines: [[2, 2]],
          }),
        ]),
        e2e([
          file('src/cart.ts', {
            linesRecorded: false,
            functions: [[5, 8]],
            allFunctions: [
              [1, 4],
              [5, 8],
              [9, 12],
            ],
          }),
        ]),
      ],
    });
    const [cart] = result.files;
    expect(cart!.classes.undetermined).toEqual([[6, 7]]);
    expect(cart!.classes.none).toEqual([
      [3, 3],
      [10, 11],
    ]);
    expect(result.totals).toMatchObject({ executedLines: 1, undeterminedLines: 2, knownFunctions: 3, runFunctions: 1 });
  });

  test('matches functions across suites by their start line', () => {
    const result = combineCoverage({
      inventory: null,
      inScope: all,
      spanTable: new Map(),
      suites: [
        // Vitest gives a function its declaration line only.
        unit([
          file('src/a.ts', {
            executable: [[2, 2]],
            functions: [[1, 1]],
            allFunctions: [
              [1, 1],
              [5, 5],
            ],
          }),
        ]),
        e2e([
          file('src/a.ts', {
            linesRecorded: false,
            functions: [[5, 9]],
            allFunctions: [
              [1, 3],
              [5, 9],
            ],
          }),
        ]),
      ],
    });
    expect(result.files[0]!.knownFunctions).toEqual([
      [1, 3],
      [5, 9],
    ]);
    expect(result.files[0]!.runFunctions).toHaveLength(2);
    expect(result.suites.map((s) => s.runFunctions)).toEqual([1, 1]);
  });

  test('reads the version the inventory names, counts the files no suite names, and keeps out-of-scope files', () => {
    const result = combineCoverage({
      inventory: new Map([
        ['src/a.ts', BLOB_B],
        ['src/b.ts', BLOB_A],
        ['src/a.test.ts', BLOB_A],
      ]),
      inScope: (path) => !path.includes('.test.'),
      spanTable: new Map(),
      suites: [
        unit([
          file('src/a.ts', { blob: BLOB_A, executable: [[1, 2]], lines: [[1, 1]] }),
          file('src/a.test.ts', { executable: [[1, 1]], lines: [[1, 1]] }),
        ]),
      ],
    });
    // The report's lines are of another version of src/a.ts: they do not count.
    expect(result.files).toEqual([expect.objectContaining({ path: 'src/a.ts', blob: BLOB_B, reference: 'none' })]);
    expect(result.filesWithoutData).toEqual(['src/b.ts']);
  });

  test('breaks a commit down by folder, folders first', () => {
    const result = combineCoverage({
      inventory: null,
      inScope: all,
      spanTable: new Map(),
      suites: [
        unit([
          file('apps/web/src/a.ts', { executable: [[1, 4]], lines: [[1, 2]] }),
          file('apps/web/src/b.ts', { executable: [[1, 2]], lines: [[1, 2]] }),
          file('apps/web/main.ts', { executable: [[1, 1]] }),
          file('README.ts', { executable: [[1, 1]], lines: [[1, 1]] }),
        ]),
      ],
    });
    expect(folderBreakdown(result.files, '').map((e) => [e.path, e.kind, e.executedLines, e.executableLines])).toEqual([
      ['apps', 'folder', 4, 7],
      ['README.ts', 'file', 1, 1],
    ]);
    expect(folderBreakdown(result.files, 'apps/web').map((e) => [e.path, e.executedLines, e.executableLines])).toEqual([
      ['apps/web/src', 4, 6],
      ['apps/web/main.ts', 0, 1],
    ]);
  });
});

describe('coveragePercent', () => {
  test('is a percentage with one decimal, null with nothing to count', () => {
    expect(coveragePercent(422, 755)).toBe(55.9);
    expect(coveragePercent(0, 0)).toBeNull();
  });
});
