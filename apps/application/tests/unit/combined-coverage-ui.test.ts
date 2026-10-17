import { describe, expect, test } from 'vitest';
import { combineCoverage, coverageTreeLevel, leastCoveredFiles, type SuiteFile } from '#shared/coverage-combine';
import {
  coverageFileLink,
  coverageLink,
  dataNoteSentence,
  enclosingFunction,
  fileViewNotes,
  gapSteps,
  plural,
  totalsSentence,
  withLineage,
} from '~/utils/combined-coverage';

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

describe('plural', () => {
  test('writes one noun for one, the plural for every other count', () => {
    expect(plural(1, 'line')).toBe('1 line');
    expect(plural(0, 'line')).toBe('0 lines');
    expect(plural(1204, 'line')).toBe('1,204 lines');
  });

  test('reads the same in the totals sentence', () => {
    const totals = { executableLines: 1, linePercent: 100 } as never;
    expect(totalsSentence({ totals, suites: [{}] as never })).toBe('100.0% of 1 executable line ran, across 1 suite.');
  });
});

describe('coverageLink', () => {
  test('keeps the pinned commit, the branch and the area beside the query', () => {
    expect(coverageLink(5, { commit: 'abc1234', branch: 'feat', area: 'front' }, { folder: 'src' })).toEqual({
      path: '/projects/5/coverage',
      query: { commit: 'abc1234', branch: 'feat', area: 'front', folder: 'src' },
    });
  });

  test('leaves out what the context does not hold, and lets the query clear a key', () => {
    expect(coverageLink(5, { commit: null, branch: '', area: 'front' }, { area: undefined })).toEqual({
      path: '/projects/5/coverage',
      query: { commit: undefined, branch: undefined, area: undefined },
    });
  });

  test('opens a file marked by suite at the same commit', () => {
    expect(coverageFileLink(5, { commit: 'abc1234' }, 'src/a.ts').query).toEqual({
      commit: 'abc1234',
      branch: undefined,
      area: undefined,
      file: 'src/a.ts',
      marks: 'suites',
    });
  });
});

describe('withLineage', () => {
  test('adds the folder and its parents to the saved open folders', () => {
    expect(withLineage(['x', 'y'], 'a/b')).toEqual(['x', 'y', 'a', 'a/b']);
  });

  test('keeps the saved folders as they are when the lineage is already open', () => {
    const open = ['a', 'a/b', 'x'];
    expect(withLineage(open, 'a/b')).toBe(open);
    expect(withLineage(open, '')).toBe(open);
  });
});

describe('dataNoteSentence', () => {
  const text = (parts: ReturnType<typeof dataNoteSentence>) =>
    parts.map((p) => (typeof p === 'string' ? p : `[${p.commit.slice(0, 7)}]`)).join('');

  test('says each note in one plain sentence, the commits it names apart', () => {
    const sha = 'f'.repeat(40);
    expect(text(dataNoteSentence({ kind: 'detail-removed', supersededBy: sha }, 'feature/pay'))).toBe(
      'Only this commit’s totals are kept: its file detail went when [fffffff] arrived on feature/pay.',
    );
    expect(text(dataNoteSentence({ kind: 'detail-removed', supersededBy: sha }, null))).toContain(
      'arrived on the default branch.',
    );
    expect(text(dataNoteSentence({ kind: 'carried', suite: 'unit-front', from: sha, files: 12 }, null))).toBe(
      'unit-front: 12 files carried from [fffffff], an earlier commit.',
    );
    expect(text(dataNoteSentence({ kind: 'incomplete', suite: 'unit-back' }, null))).toMatch(
      /^unit-back: the report is incomplete/,
    );
    expect(text(dataNoteSentence({ kind: 'missing-suite', suite: 'unit-front' }, null))).toBe(
      'unit-front: no coverage for this commit or an earlier one.',
    );
    expect(text(dataNoteSentence({ kind: 'no-inventory' }, null))).toBe(
      'No inventory uploaded: files no suite names are not counted.',
    );
    expect(text(dataNoteSentence({ kind: 'scope-changed' }, null))).toMatch(/earlier coverage scope or areas/);
    expect(text(dataNoteSentence({ kind: 'runs-not-counted', partial: 1, lab: 0 }, null))).toBe(
      '1 end-to-end run of this commit doesn’t count: 1 partial or unfinished.',
    );
    expect(text(dataNoteSentence({ kind: 'runs-not-counted', partial: 1, lab: 2 }, null))).toBe(
      '3 end-to-end runs of this commit don’t count: 1 partial or unfinished, 2 from a lab or a probe.',
    );
  });

  test('keeps the notes about the totals off a file’s view', () => {
    expect(
      fileViewNotes([{ kind: 'no-inventory' }, { kind: 'scope-changed' }, { kind: 'missing-suite', suite: 'e2e' }]),
    ).toEqual([{ kind: 'missing-suite', suite: 'e2e' }]);
  });
});
