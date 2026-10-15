import { describe, expect, test } from 'vitest';
import type {
  CoverageDivergenceAnswer,
  CoverageLossAnswer,
  CoverageLossSummary,
  LossFile,
  PathVariationAnswer,
  VaryingCode,
} from '#shared/coverage-insights';
import {
  changedFilesText,
  coverageLossKey,
  coverageLossPreview,
  divergenceIncompleteText,
  divergenceRowText,
  divergenceRows,
  explanationRelationText,
  linesPhrase,
  orderDependentText,
  pathVariationHeadline,
  varyingCodeText,
  varyingFileLine,
  varyingFilePhrase,
} from '~/utils/coverage-insights';

const NBSP = ' ';

function divergence(files: CoverageDivergenceAnswer['files'], extra: Partial<CoverageDivergenceAnswer> = {}) {
  return {
    available: true,
    executionId: 10,
    summary: {
      filesCompared: 0,
      filesOnlyHere: 0,
      filesOnlyBaseline: 0,
      filesDiverged: 0,
      filesChanged: 0,
      linesOnlyHere: 0,
      linesOnlyBaseline: 0,
      functionsOnlyHere: 0,
      functionsOnlyBaseline: 0,
    },
    files,
    ...extra,
  } satisfies CoverageDivergenceAnswer;
}

function summary(over: Partial<CoverageLossSummary> = {}): CoverageLossSummary {
  return {
    files: 0,
    filesCovered: 0,
    filesOnlyThese: 0,
    filesOnlyFlaky: 0,
    filesPartial: 0,
    filesUncertain: 0,
    lines: 0,
    functions: 0,
    onlyFlakyLines: 0,
    onlyFlakyFunctions: 0,
    ...over,
  };
}

function loss(files: LossFile[], over: Partial<CoverageLossSummary> = {}, tests = 1): CoverageLossAnswer {
  return {
    available: true,
    projectId: 5,
    branch: 'main',
    tests: Array.from({ length: tests }, (_, i) => ({
      testCaseId: i + 1,
      title: `test ${i + 1}`,
      filePath: 'tests/a.spec.ts',
      quarantined: false,
      hasCoverage: true,
    })),
    summary: summary(over),
    files,
  };
}

const lossFile = (path: string, over: Partial<LossFile> = {}): LossFile => ({
  path,
  runtime: 'server',
  blob: 'b1',
  status: 'partial',
  otherTests: { steady: 1, flaky: 0 },
  ...over,
});

describe('linesPhrase', () => {
  test('names one line, several, or none', () => {
    expect(linesPhrase([[54, 54]])).toBe('line 54');
    expect(
      linesPhrase([
        [58, 59],
        [62, 62],
      ]),
    ).toBe(`lines 58${NBSP}to${NBSP}59, 62`);
    expect(linesPhrase([])).toBe('');
    expect(linesPhrase(undefined)).toBe('');
  });
});

describe('a failure against its last pass', () => {
  test('a row says which side ran what', () => {
    expect(
      divergenceRowText({ path: 'a.cs', runtime: 'server', status: 'only-here', blob: 'b', linesOnlyHere: [[3, 4]] }),
    ).toBe(`only in this execution · lines 3${NBSP}to${NBSP}4`);
    expect(
      divergenceRowText({
        path: 'a.cs',
        runtime: 'server',
        status: 'diverged',
        blob: 'b',
        linesOnlyHere: [[58, 59]],
        linesOnlyBaseline: [[54, 54]],
      }),
    ).toBe(`here: lines 58${NBSP}to${NBSP}59 · in the pass: line 54`);
    expect(
      divergenceRowText({
        path: 'src/a.ts',
        runtime: 'browser',
        status: 'only-baseline',
        functionsOnlyBaseline: [
          [1, 4],
          [6, 9],
        ],
        moreRanges: 2,
      }),
    ).toBe('browser · only in the passing run · 2 functions (and 2 more ranges)');
    expect(divergenceRowText({ path: 'src/b.ts', runtime: 'browser', status: 'only-here' })).toBe(
      'browser · only in this execution',
    );
  });

  test('the rows keep the answer order, set changed files apart, and unfold only files both ran with lines', () => {
    const { rows, changed } = divergenceRows(
      divergence([
        { path: 'here.cs', runtime: 'server', status: 'only-here', blob: 'b', linesOnlyHere: [[3, 4]] },
        {
          path: 'both.cs',
          runtime: 'server',
          status: 'diverged',
          blob: 'b',
          linesOnlyBaseline: [[9, 9]],
        },
        { path: 'fns.cs', runtime: 'server', status: 'diverged', blob: 'b', functionsOnlyHere: [[1, 5]] },
        { path: 'old.cs', runtime: 'server', status: 'changed', blob: 'b', baselineBlob: 'c' },
      ]),
    );
    expect(rows.map((r) => [r.file.path, r.firstLine, r.comparable])).toEqual([
      ['here.cs', 3, false],
      ['both.cs', 9, true],
      ['fns.cs', 1, false],
    ]);
    expect(changed.map((f) => f.path)).toEqual(['old.cs']);
    expect(changedFilesText(1)).toBe('1 file ran at another version in the passing run, not compared.');
    expect(changedFilesText(2)).toBe('2 files ran at another version in the passing run, not compared.');
  });

  test('an incomplete side is said in one sentence', () => {
    expect(divergenceIncompleteText(divergence([]))).toBeNull();
    expect(divergenceIncompleteText(divergence([], { incomplete: { execution: true, baseline: false } }))).toMatch(
      /^This execution’s coverage is incomplete/,
    );
    expect(divergenceIncompleteText(divergence([], { incomplete: { execution: false, baseline: true } }))).toMatch(
      /^The passing run’s coverage is incomplete/,
    );
  });
});

describe('a path that varies', () => {
  const code = (over: Partial<VaryingCode> = {}): VaryingCode => ({
    ranIn: 3,
    failedIn: 3,
    lines: 2,
    functions: 0,
    files: [{ path: 'api/P.cs', runtime: 'server', blob: 'b', lines: [[58, 59]] }],
    examples: { ran: [832], notRan: [808] },
    ...over,
  });
  const answer = (over: Partial<PathVariationAnswer> = {}): PathVariationAnswer => ({
    available: true,
    testCaseId: 53,
    project: 'Chromium',
    executions: { compared: 10, incomplete: 0, failed: 3 },
    files: { compared: 6, changedVersion: 0 },
    varying: [code()],
    orderDependent: false,
    ...over,
  });

  test('the headline counts the less common side of the most evenly split code', () => {
    expect(pathVariationHeadline(answer())).toBe('Takes a different path in 3 of 10 recent executions');
    expect(pathVariationHeadline(answer({ varying: [code({ ranIn: 8 })] }))).toBe(
      'Takes a different path in 2 of 10 recent executions',
    );
    expect(pathVariationHeadline(answer({ varying: [] }))).toBeNull();
    expect(pathVariationHeadline(answer({ available: false }))).toBeNull();
  });

  test('a group says how many ran it and how many of those failed', () => {
    expect(varyingCodeText(code(), 10)).toBe('Ran in 3 of 10 executions, all 3 failed');
    expect(varyingCodeText(code({ failedIn: 1 }), 10)).toBe('Ran in 3 of 10 executions, 1 failed');
    expect(varyingCodeText(code({ failedIn: 0 }), 10)).toBe('Ran in 3 of 10 executions');
    expect(varyingCodeText(code({ ranIn: 1, failedIn: 1 }), 10)).toBe('Ran in 1 of 10 executions, which failed');
  });

  test('a file names its lines, else its functions, else the file', () => {
    expect(varyingFilePhrase({ path: 'a', runtime: 'server', lines: [[58, 59]] })).toBe(`lines 58${NBSP}to${NBSP}59`);
    expect(varyingFilePhrase({ path: 'a', runtime: 'server', functions: [[1, 9]], moreRanges: 1 })).toBe(
      '1 function (and 1 more range)',
    );
    expect(varyingFilePhrase({ path: 'a', runtime: 'browser', file: true })).toBe('the file');
    expect(varyingFileLine({ path: 'a', runtime: 'server', functions: [[7, 9]] })).toBe(7);
    expect(varyingFileLine({ path: 'a', runtime: 'browser', file: true })).toBeNull();
  });

  test('the relation reads as where the earlier test finished', () => {
    expect(explanationRelationText('earlier-in-run')).toBe('finished earlier in the run');
    expect(explanationRelationText('earlier-on-worker')).toBe('finished earlier on the same worker');
  });

  test('an order-dependent test says its failures follow the difference', () => {
    expect(orderDependentText(answer())).toBeNull();
    const follows = answer({
      orderDependent: true,
      failuresFollow: { varying: 0, side: 'ran', failed: 3, onSide: 3 },
    });
    expect(orderDependentText(follows)).toBe(
      'Its failures follow that difference: all 3 of its failed executions ran that code. The test depends on what an earlier test leaves behind, the order flaky root cause.',
    );
    expect(
      orderDependentText(
        answer({ orderDependent: true, failuresFollow: { varying: 0, side: 'not-ran', failed: 10, onSide: 9 } }),
      ),
    ).toMatch(/^Its failures follow that difference: 9 of its 10 failed executions did not run that code\./);
  });
});

describe('the coverage-loss preview', () => {
  test('a quarantine names the lines no other trusted test runs, the worst files first', () => {
    const preview = coverageLossPreview(
      loss(
        [
          lossFile('api/P.cs', { status: 'only-these', lines: [[29, 31]], otherTests: { steady: 0, flaky: 0 } }),
          lossFile('api/O.cs', { lines: [[44, 44]], onlyFlakyLines: [[28, 31]] }),
          lossFile('api/X.cs', { functions: [[1, 9]] }),
          lossFile('api/Y.cs', { lines: [[2, 2]] }),
          lossFile('api/U.cs', { status: 'uncertain' }),
        ],
        { lines: 5, functions: 1, onlyFlakyLines: 4, filesUncertain: 1 },
      ),
      'quarantine',
    )!;
    expect(preview.headline).toBe('Leaves 5 lines in 4 files run by no other trusted test');
    expect(preview.files.map((f) => [f.file.path, f.text, f.firstLine])).toEqual([
      ['api/P.cs', `lines 29${NBSP}to${NBSP}31`, 29],
      ['api/O.cs', 'line 44', 44],
      ['api/X.cs', '1 function', 1],
    ]);
    expect(preview.extra).toBe(
      'Only flaky tests run 4 more lines · 1 file other tests ran only at another version, not compared',
    );
  });

  test('a release says what it covers again, and nothing when it covers nothing', () => {
    const answer = loss([lossFile('api/P.cs', { status: 'only-these', lines: [[29, 31]] })], { lines: 3 });
    expect(coverageLossPreview(answer, 'release')!.headline).toBe(
      'Covers again 3 lines in 1 file no other trusted test runs',
    );
    expect(coverageLossPreview(loss([]), 'release')).toBeNull();
  });

  test('a file run by no other test at file granularity counts as a file', () => {
    const preview = coverageLossPreview(
      loss([lossFile('src/a.ts', { runtime: 'browser', status: 'only-these' })], { filesOnlyThese: 1 }),
      'quarantine',
    )!;
    expect(preview.headline).toBe('Leaves 1 file run by no other trusted test');
    expect(preview.files[0]!.text).toBe('the file');
  });

  test('code only flaky tests run besides these is the answer when nothing else is lost', () => {
    const preview = coverageLossPreview(
      loss([lossFile('api/O.cs', { status: 'only-flaky', onlyFlakyLines: [[28, 31]] })], { onlyFlakyLines: 4 }),
      'quarantine',
    )!;
    expect(preview.headline).toBe('Leaves 4 lines run only by flaky tests');
    expect(preview.files[0]!.text).toBe(`lines 28${NBSP}to${NBSP}31`);
  });

  test('with nothing lost, a quarantine says so in one sentence', () => {
    expect(coverageLossPreview(loss([]), 'quarantine')).toEqual({
      headline: 'Every line it runs is run by another test too',
      files: [],
      extra: null,
    });
    expect(coverageLossPreview(loss([], {}, 2), 'quarantine')!.headline).toBe(
      'Every line they run is run by another test too',
    );
    expect(
      coverageLossPreview(loss([lossFile('a', { status: 'uncertain' })], { filesUncertain: 1 }), 'quarantine'),
    ).toEqual({
      headline: 'Other tests ran 1 of its files only at another version, so no line is compared',
      files: [],
      extra: null,
    });
  });

  test('no coverage, no preview', () => {
    expect(coverageLossPreview({ ...loss([]), available: false, reason: 'no-coverage' }, 'quarantine')).toBeNull();
    expect(coverageLossPreview(null, 'quarantine')).toBeNull();
  });

  test('the read names its tests once, in order', () => {
    expect(coverageLossKey([40, 12, 15, 12])).toBe('12,15,40');
    expect(coverageLossKey([])).toBe('');
  });
});
