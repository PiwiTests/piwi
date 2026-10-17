import { describe, expect, test } from 'vitest';
import { combineCoverage, type SuiteFile } from '#shared/coverage-combine';
import {
  computePatchCoverage,
  patchChangedLines,
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

  test('stops listing a changed file a suite ran a changed line of', () => {
    const cc: PrChangeCoverage = {
      totalFiles: 2,
      uncoveredFiles: 1,
      reachedFiles: 1,
      ticketCount: 0,
      windowRuns: 30,
      baseBranch: 'main',
      patchCoverage: pc,
      tickets: [
        {
          ticket: null,
          files: [
            {
              filePath: 'src/cart.ts',
              additions: 3,
              deletions: 0,
              reachedInRun: false,
              reachedCountHistory: 0,
              suites: ['unit-front'],
            },
            {
              filePath: 'src/pay.ts',
              additions: 1,
              deletions: 0,
              reachedInRun: false,
              reachedCountHistory: 0,
              suites: [],
            },
          ],
        },
      ],
    };
    const section = renderChangeCoverage(cc)!;
    expect(section).toContain('**Patch coverage 66.7%**');
    expect(section).toContain("the lines the head commit's coverage suites ran");
    expect(section).toContain('`src/pay.ts`');
    expect(section).not.toContain('`src/cart.ts`');
  });
});

describe('detectChangedUnreached', () => {
  test('opens no gap for a file a suite ran a changed line of', () => {
    const gaps = detectChangedUnreached(
      [
        {
          filePath: 'src/cart.ts',
          additions: 3,
          deletions: 0,
          reachedInRun: false,
          reachedCountHistory: 0,
          suites: ['unit-front'],
        },
        { filePath: 'src/pay.ts', additions: 1, deletions: 0, reachedInRun: false, reachedCountHistory: 0, suites: [] },
      ],
      7,
    );
    expect(gaps.map((g) => g.key)).toEqual(['src/pay.ts']);
  });
});
