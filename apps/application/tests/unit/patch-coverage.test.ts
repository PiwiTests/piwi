import { describe, expect, test } from 'vitest';
import { combineCoverage, type SuiteFile } from '#shared/coverage-combine';
import {
  changedLinesOf,
  computePatchCoverage,
  lineRangesText,
  patchChangedLines,
  unreachedLinesText,
  patchCoverageWarning,
  suitesOnChangedLines,
} from '#shared/patch-coverage';
import { renderChangeCoverage, renderPatchCoverage, type PrChangeCoverage } from '#shared/pr-feedback';
import { detectChangedUnreached } from '#shared/handlers/scenario-gaps';

const BLOB = 'a'.repeat(40);

function file(path: string, over: Partial<SuiteFile> = {}): SuiteFile {
  return { path, blob: BLOB, executable: [], lines: [], functions: [], allFunctions: [], linesRecorded: true, ...over };
}

/** `src/cart.ts`: lines 1-10 executable; the unit suite ran 1-4, the end-to-end suite 3-6. */
const combined = combineCoverage({
  inventory: null,
  inScope: () => true,
  spanTable: new Map(),
  suites: [
    { name: 'unit-front', kind: 'unit', files: [file('src/cart.ts', { executable: [[1, 10]], lines: [[1, 4]] })] },
    { name: 'e2e', kind: 'e2e', files: [file('src/cart.ts', { executable: [[1, 10]], lines: [[3, 6]] })] },
  ],
});
const suites = combined.suites.map((s) => ({ name: s.name, kind: s.kind }));

describe('patchChangedLines', () => {
  test('reads the new file’s added lines, skipping context and removed lines', () => {
    const patch = ['@@ -1,4 +1,5 @@', ' a', '-b', '+B', '+C', ' d', '@@ -10,2 +11,2 @@', ' x', '+y'].join('\n');
    expect(patchChangedLines('src/cart.ts', patch)).toEqual([2, 3, 12]);
    expect(patchChangedLines('src/cart.ts', undefined)).toEqual([]);
  });
});

describe('changedLinesOf', () => {
  test('counts a file’s changed reference lines, those that ran, and names the ranges no suite ran', () => {
    // Line 12 is not executable; 7, 8 and 10 ran in no suite.
    expect(changedLinesOf(combined.files[0]!, [2, 5, 7, 8, 10, 12])).toEqual({
      changed: 5,
      ran: 2,
      undetermined: 0,
      notRun: [
        [7, 8],
        [10, 10],
      ],
    });
  });

  test('is null when no changed line is a reference line', () => {
    expect(changedLinesOf(combined.files[0]!, [12, 40])).toBeNull();
  });

  test('says what an unreached file’s lines did, the undetermined ones apart', () => {
    expect(unreachedLinesText({ changed: 4, undetermined: 0 })).toBe('none of its 4 changed lines ran');
    expect(unreachedLinesText({ changed: 4, undetermined: 1 })).toBe(
      '3 of its 4 changed lines ran in no suite, 1 undetermined',
    );
  });

  test('words the ranges as the dashboard does', () => {
    expect(
      lineRangesText([
        [7, 8],
        [10, 10],
      ]),
    ).toBe('7\u00a0to\u00a08, 10');
  });
});

describe('computePatchCoverage', () => {
  test('counts the changed reference lines that ran, per kind and per suite', () => {
    // Lines 2, 5, 8 and 12: 12 is not executable, 8 ran in no suite.
    const pc = computePatchCoverage('c0ffee', combined.files, suites, new Map([['src/cart.ts', [2, 5, 8, 12]]]));
    expect(pc).toMatchObject({
      commit: 'c0ffee',
      changedLines: 3,
      executedLines: 2,
      unitLines: 1,
      e2eLines: 1,
      undeterminedLines: 0,
      files: 1,
    });
    expect(pc!.suites).toEqual([
      { name: 'unit-front', kind: 'unit', executedLines: 1 },
      { name: 'e2e', kind: 'e2e', executedLines: 1 },
    ]);
  });

  test('counts each named area’s changed lines', () => {
    const pc = computePatchCoverage('c0ffee', combined.files, suites, new Map([['src/cart.ts', [2, 5, 8]]]), {
      names: ['front', 'back'],
      areaOf: (path) => (path.startsWith('src/') ? 'front' : null),
    });
    expect(pc!.areas).toEqual([{ name: 'front', changedLines: 3, executedLines: 2 }]);
    expect(renderPatchCoverage(pc!)).toContain('By area: front 2 of 3.');
  });

  test('is null when no changed line is a reference line', () => {
    expect(computePatchCoverage('c0ffee', combined.files, suites, new Map([['src/cart.ts', [12]]]))).toBeNull();
    expect(computePatchCoverage('c0ffee', combined.files, suites, new Map([['src/other.ts', [1]]]))).toBeNull();
  });

  test('names the suites that ran a changed line of a file', () => {
    expect(suitesOnChangedLines(combined.files[0]!, [1])).toEqual(['unit-front']);
    expect(suitesOnChangedLines(combined.files[0]!, [3, 9])).toEqual(['e2e', 'unit-front']);
    expect(suitesOnChangedLines(combined.files[0]!, [9])).toEqual([]);
  });
});

describe('patchCoverageWarning', () => {
  const pc = computePatchCoverage('c0ffee', combined.files, suites, new Map([['src/cart.ts', [2, 5, 8]]]))!;

  test('warns under the minimum, never at or over it', () => {
    expect(patchCoverageWarning(pc, 80)).toBe(
      'Patch coverage 66.7%: 2 of the 3 changed lines ran (minimum 80%) — warn-only.',
    );
    expect(patchCoverageWarning(pc, 60)).toBeNull();
  });

  test('compares the lines that ran, not the rounded percentage, with the minimum', () => {
    const almost = { ...pc, changedLines: 2000, executedLines: 1999 };
    expect(patchCoverageWarning(almost, 100)).toBe(
      'Patch coverage 99.9%: 1999 of the 2000 changed lines ran (minimum 100%) — warn-only.',
    );
    expect(patchCoverageWarning({ ...pc, changedLines: 2000, executedLines: 2000 }, 100)).toBeNull();
    expect(patchCoverageWarning({ ...pc, changedLines: 3, executedLines: 2 }, 66.7)).toBe(
      'Patch coverage 66.7%: 2 of the 3 changed lines ran (minimum 66.7%) — warn-only.',
    );
  });

  test('says so when the coverage names no changed line', () => {
    expect(patchCoverageWarning(null, 80)).toMatch(/could not be counted/);
  });
});

describe('the pull-request comment', () => {
  const pc = computePatchCoverage('c0ffee1234', combined.files, suites, new Map([['src/cart.ts', [2, 5, 8]]]))!;

  test('renders the patch coverage line with each kind', () => {
    expect(renderPatchCoverage(pc)).toBe(
      '**Patch coverage 66.7%**: 2 of the 3 changed lines ran (unit 1, end to end 1), at `c0ffee1`.',
    );
  });

  const cartLines = changedLinesOf(combined.files[0]!, [2, 5, 8])!;
  const section = (over: Partial<PrChangeCoverage> = {}): PrChangeCoverage => ({
    fileReach: true,
    totalFiles: 2,
    uncoveredFiles: 1,
    reachedFiles: 1,
    notCounted: { notObservable: 0, outOfScope: 0, deleted: 0 },
    ticketCount: 0,
    windowRuns: 30,
    patchCoverage: pc,
    tickets: [
      {
        ticket: null,
        files: [
          { filePath: 'src/cart.ts', additions: 3, deletions: 0, reach: 'reached', lines: cartLines },
          { filePath: 'src/pay.ts', additions: 1, deletions: 0, reach: 'unreached', lines: null },
        ],
      },
    ],
    ...over,
  });

  test('lists the uncovered file, then the changed lines no suite ran of a reached one', () => {
    const text = renderChangeCoverage(section())!;
    expect(text).toContain('**Patch coverage 66.7%**');
    expect(text).toContain("and changed lines no suite ran, in the head commit's coverage");
    expect(text).toContain('- `src/pay.ts` · changed (+1 −0) · 0 tests in 30 runs');
    expect(text).toContain('**Changed lines no suite ran**\n- `src/cart.ts` · 2 of 3 ran · not run: 8');
    expect(text).not.toContain('Gate');
  });

  test('keeps the changed lines when the file list is withheld', () => {
    const text = renderChangeCoverage(section({ fileReach: false }))!;
    expect(text.split('\n')[0]).toBe('#### 🟣 Uncovered changes · patch coverage 66.7%');
    expect(text).toContain("Changed lines no suite ran, in the head commit's coverage.");
    expect(text).toContain('`src/cart.ts` · 2 of 3 ran');
    expect(text).not.toContain('`src/pay.ts`');
  });

  test('renders nothing without a file list or a patch coverage', () => {
    expect(renderChangeCoverage(section({ fileReach: false, patchCoverage: null }))).toBeNull();
    expect(
      renderChangeCoverage(section({ totalFiles: 0, uncoveredFiles: 0, reachedFiles: 0, patchCoverage: null })),
    ).toBeNull();
  });

  test('says which changed files it did not count, and why', () => {
    const text = renderChangeCoverage(section({ notCounted: { notObservable: 2, outOfScope: 1, deleted: 1 } }))!;
    expect(text).toContain(
      'Not counted: 2 files Piwi cannot observe, 1 file outside the coverage scope, 1 file deleted.',
    );
  });
});

describe('detectChangedUnreached', () => {
  test('opens a gap for an uncovered change only', () => {
    const gaps = detectChangedUnreached(
      [
        { filePath: 'src/cart.ts', additions: 3, deletions: 0, reach: 'reached' },
        {
          filePath: 'src/pay.ts',
          additions: 1,
          deletions: 0,
          reach: 'unreached',
          lines: { changed: 4, undetermined: 0 },
        },
        { filePath: 'src/narrowed.ts', additions: 1, deletions: 0, reach: 'reached-earlier' },
        { filePath: 'README.md', additions: 9, deletions: 0, reach: 'not-observable' },
        { filePath: 'src/cart.test.ts', additions: 2, deletions: 0, reach: 'out-of-scope' },
      ],
      7,
    );
    expect(gaps.map((g) => g.key)).toEqual(['src/pay.ts']);
    expect(gaps[0]!.evidence).toEqual([
      '+1 −0 · no test in run #7 or in the last 30 runs — observed reach.',
      "In the head commit's coverage, none of its 4 changed lines ran.",
    ]);
  });
});
