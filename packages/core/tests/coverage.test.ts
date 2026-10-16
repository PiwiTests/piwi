import { describe, expect, test } from 'vitest';
import { finalizeCodeReach } from '../src/code-reach';
import {
  MAX_COVERAGE_FILES,
  MAX_COVERAGE_RANGES,
  canonicalCoverageFile,
  countLines,
  coverageFiles,
  decodeFunctionRanges,
  decodeLineRanges,
  encodeLineRanges,
  granularityOf,
  intersectLineRanges,
  lineInRanges,
  mergeCoverage,
  normalizeCoveragePath,
  normalizeFunctionRanges,
  normalizeLineRanges,
  reduceCoverage,
  sanitizeCoverage,
  type CoverageCapture,
  type LineRange,
} from '../src/coverage';

const BLOB_A = '3b18e512dba79e4c8300dd08aeb37f8e728b8dad';
const BLOB_B = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const BLOB_SHA256 = 'a'.repeat(64);

/** `count` single-line ranges that never touch: 1, 3, 5, … */
function spacedRanges(count: number): LineRange[] {
  return Array.from({ length: count }, (_, i): LineRange => [2 * i + 1, 2 * i + 1]);
}

describe('normalizeLineRanges', () => {
  test('sorts and merges overlapping, contained and adjacent ranges', () => {
    expect(
      normalizeLineRanges([
        [20, 22],
        [1, 3],
        [4, 5],
        [10, 12],
        [11, 15],
        [30, 30],
        [13, 14],
      ]),
    ).toEqual([
      [1, 5],
      [10, 15],
      [20, 22],
      [30, 30],
    ]);
  });

  test('drops entries that are not integer pairs within 1 to 1,000,000', () => {
    expect(
      normalizeLineRanges([
        [0, 3],
        [5, 4],
        [1.5, 2],
        ['1', 2],
        [1],
        [1, 2, 3],
        null,
        {},
        [-1, 2],
        [Number.NaN, 2],
        [2, Number.POSITIVE_INFINITY],
        [1, 1_000_001],
        [1_000_000, 1_000_000],
        [7, 9],
      ]),
    ).toEqual([
      [7, 9],
      [1_000_000, 1_000_000],
    ]);
  });

  test('reads anything but an array as no ranges', () => {
    for (const raw of [null, undefined, 'x', 3, { 0: [1, 2] }]) expect(normalizeLineRanges(raw)).toEqual([]);
  });

  test('leaves its input as it was', () => {
    const input: LineRange[] = [
      [4, 6],
      [1, 4],
    ];
    normalizeLineRanges(input);
    expect(input).toEqual([
      [4, 6],
      [1, 4],
    ]);
  });
});

describe('normalizeFunctionRanges', () => {
  test('sorts and deduplicates, keeping nested, overlapping and adjacent functions apart', () => {
    expect(
      normalizeFunctionRanges([
        [10, 20],
        [1, 30],
        [10, 20],
        [12, 14],
        [15, 25],
        [31, 40],
      ]),
    ).toEqual([
      [1, 30],
      [10, 20],
      [12, 14],
      [15, 25],
      [31, 40],
    ]);
  });

  test('validates like line ranges', () => {
    expect(normalizeFunctionRanges([[0, 1], [2, 1], [3, '4'], [5, 6], 'x'])).toEqual([[5, 6]]);
    expect(normalizeFunctionRanges(undefined)).toEqual([]);
  });
});

describe('normalizeCoveragePath', () => {
  test('turns a path into a repository-relative POSIX path', () => {
    expect(normalizeCoveragePath('src\\Web\\Services\\BasketService.cs')).toBe('src/Web/Services/BasketService.cs');
    expect(normalizeCoveragePath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeCoveragePath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalizeCoveragePath('src/node_modules.ts')).toBe('src/node_modules.ts');
    const longest = `${'a'.repeat(497)}.ts`;
    expect(normalizeCoveragePath(longest)).toBe(longest);
  });

  test('rejects anything outside the repository or not a path', () => {
    for (const raw of [
      '',
      './',
      '../x.ts',
      '..\\x.ts',
      '/abs/x.ts',
      '\\abs\\x.ts',
      'C:/app/x.ts',
      'c:\\app\\x.ts',
      'node_modules/vue/index.js',
      'src/node_modules/x.js',
      'a'.repeat(501),
      'src/a\0.ts',
      42,
      null,
      undefined,
      ['src/a.ts'],
    ]) {
      expect(normalizeCoveragePath(raw), String(raw)).toBeNull();
    }
  });
});

describe('finalizeCodeReach', () => {
  test('normalizes, deduplicates and sorts paths', () => {
    expect(
      finalizeCodeReach([
        'src\\b.ts',
        './src/a.ts',
        'C:/x.ts',
        'src/node_modules/x.js',
        'src/a.ts',
        '',
        '../outside.ts',
        '/abs.ts',
      ]),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('applies the coverage path rule', () => {
    const samples = [
      'src/a.ts',
      './src/a.ts',
      'src\\a.ts',
      '../a.ts',
      'node_modules/a.js',
      'D:\\a.ts',
      'a'.repeat(501),
    ];
    for (const raw of samples) {
      const path = normalizeCoveragePath(raw);
      expect(finalizeCodeReach([raw])).toEqual(path === null ? [] : [path]);
    }
  });

  test('keeps the first 2,000 files in path order', () => {
    const files = Array.from({ length: 2001 }, (_, i) => `src/f${String(2000 - i).padStart(4, '0')}.ts`);
    const out = finalizeCodeReach(files);
    expect(out).toHaveLength(2000);
    expect(out[0]).toBe('src/f0000.ts');
    expect(out[1999]).toBe('src/f1999.ts');
  });
});

describe('sanitizeCoverage', () => {
  test('rejects input that is not a version 1 capture', () => {
    for (const raw of [
      null,
      undefined,
      'x',
      [],
      {},
      { v: 2, files: [{ path: 'a.ts', runtime: 'server' }] },
      { v: '1', files: [{ path: 'a.ts', runtime: 'server' }] },
      { v: 1 },
      { v: 1, files: { path: 'a.ts', runtime: 'server' } },
    ]) {
      expect(sanitizeCoverage(raw)).toBeNull();
    }
  });

  test('is null when no valid file remains', () => {
    expect(sanitizeCoverage({ v: 1, files: [] })).toBeNull();
    expect(
      sanitizeCoverage({
        v: 1,
        files: [
          { path: '../x.ts', runtime: 'server' },
          { path: 'a.ts', runtime: 'node' },
          { path: 'node_modules/a.js', runtime: 'browser' },
          { runtime: 'browser' },
          null,
          'a.ts',
        ],
        incomplete: true,
      }),
    ).toBeNull();
  });

  test('cleans each file and sorts by path then runtime', () => {
    expect(
      sanitizeCoverage({
        v: 1,
        extra: 'dropped',
        files: [
          {
            path: 'src\\Web\\Basket.cs',
            runtime: 'server',
            blob: BLOB_A,
            functions: [
              [31, 48],
              [22, 25],
              [22, 25],
            ],
            lines: [
              [40, 40],
              [23, 24],
              [33, 35],
              [36, 36],
              [0, 1],
            ],
            hits: 12,
          },
          { path: 'src/app.ts', runtime: 'server', blob: BLOB_A.toUpperCase(), lines: [[1, 2]] },
          { path: 'src/app.ts', runtime: 'browser', blob: BLOB_SHA256, functions: [[3, 9]], lines: [] },
          { path: './src/util.ts', runtime: 'browser', blob: 'not-a-blob', functions: 'x', lines: [] },
        ],
      }),
    ).toEqual({
      v: 1,
      files: [
        {
          path: 'src/Web/Basket.cs',
          runtime: 'server',
          blob: BLOB_A,
          functions: [
            [22, 25],
            [31, 48],
          ],
          lines: [
            [23, 24],
            [33, 36],
            [40, 40],
          ],
        },
        { path: 'src/app.ts', runtime: 'browser', blob: BLOB_SHA256, functions: [[3, 9]] },
        { path: 'src/app.ts', runtime: 'server', lines: [[1, 2]] },
        { path: 'src/util.ts', runtime: 'browser' },
      ],
    });
  });

  test('omits empty range lists and the incomplete flag when false', () => {
    const out = sanitizeCoverage({
      v: 1,
      files: [{ path: 'a.ts', runtime: 'browser', functions: [], lines: [] }],
      incomplete: 'yes',
    });
    expect(out).toStrictEqual({ v: 1, files: [{ path: 'a.ts', runtime: 'browser' }] });
  });

  test('merges entries of the same runtime and path', () => {
    expect(
      sanitizeCoverage({
        v: 1,
        files: [
          { path: 'src/a.cs', runtime: 'server', blob: BLOB_A, functions: [[1, 10]], lines: [[2, 3]] },
          { path: './src/a.cs', runtime: 'server', functions: [[1, 10]], lines: [[4, 6]] },
          { path: 'src/a.cs', runtime: 'browser', lines: [[8, 8]] },
        ],
      }),
    ).toEqual({
      v: 1,
      files: [
        { path: 'src/a.cs', runtime: 'browser', lines: [[8, 8]] },
        { path: 'src/a.cs', runtime: 'server', blob: BLOB_A, functions: [[1, 10]], lines: [[2, 6]] },
      ],
    });
  });

  test('drops the blob of duplicate entries that disagree on it, and marks the capture incomplete', () => {
    expect(
      sanitizeCoverage({
        v: 1,
        files: [
          { path: 'src/a.cs', runtime: 'server', blob: BLOB_A, lines: [[2, 3]] },
          { path: 'src/a.cs', runtime: 'server', blob: BLOB_B, lines: [[9, 9]] },
        ],
      }),
    ).toEqual({
      v: 1,
      files: [
        {
          path: 'src/a.cs',
          runtime: 'server',
          lines: [
            [2, 3],
            [9, 9],
          ],
        },
      ],
      incomplete: true,
    });
  });

  test('keeps the incomplete flag of its input', () => {
    expect(sanitizeCoverage({ v: 1, files: [{ path: 'a.ts', runtime: 'server' }], incomplete: true })?.incomplete).toBe(
      true,
    );
  });

  test('keeps at most 2,000 files, the first in path order, and marks the capture incomplete', () => {
    const files = Array.from({ length: MAX_COVERAGE_FILES + 1 }, (_, i) => ({
      path: `src/f${String(MAX_COVERAGE_FILES - i).padStart(4, '0')}.ts`,
      runtime: 'browser',
    }));
    const out = sanitizeCoverage({ v: 1, files })!;
    expect(out.files).toHaveLength(MAX_COVERAGE_FILES);
    expect(out.files[0]!.path).toBe('src/f0000.ts');
    expect(out.files[MAX_COVERAGE_FILES - 1]!.path).toBe('src/f1999.ts');
    expect(out.incomplete).toBe(true);
    expect(sanitizeCoverage({ v: 1, files: files.slice(1) })!.incomplete).toBeUndefined();
  });

  test('keeps the path only of a file whose ranges exceed the total, and marks the capture incomplete', () => {
    const out = sanitizeCoverage({
      v: 1,
      files: [
        { path: 'a.ts', runtime: 'server', blob: BLOB_A, functions: spacedRanges(1000), lines: spacedRanges(5000) },
        { path: 'b.ts', runtime: 'server', blob: BLOB_A, lines: spacedRanges(5000) },
        { path: 'c.ts', runtime: 'server', blob: BLOB_A, lines: spacedRanges(4000) },
      ],
    })!;
    expect(out.incomplete).toBe(true);
    expect(out.files.map(granularityOf)).toEqual(['lines', 'files', 'lines']);
    expect(out.files[1]).toEqual({ path: 'b.ts', runtime: 'server' });
    expect(out.files[2]!.lines).toHaveLength(4000);
  });

  test('accepts exactly 10,000 ranges as complete', () => {
    const out = sanitizeCoverage({
      v: 1,
      files: [
        { path: 'a.ts', runtime: 'server', functions: spacedRanges(MAX_COVERAGE_RANGES / 2) },
        { path: 'b.ts', runtime: 'server', lines: spacedRanges(MAX_COVERAGE_RANGES / 2) },
      ],
    })!;
    expect(out.incomplete).toBeUndefined();
    expect(out.files.map(granularityOf)).toEqual(['functions', 'lines']);
  });

  test('never throws on malformed input', () => {
    const odd = [
      { v: 1, files: [{ path: {}, runtime: 'server' }] },
      { v: 1, files: [{ path: 'a.ts', runtime: 'server', lines: 'x', functions: {}, blob: 5 }] },
      { v: 1, files: [{ path: 'a.ts', runtime: 'server', lines: [[1, 2], 'x', [null, null]] }] },
      { v: 1, files: [[], 0, true] },
    ];
    for (const raw of odd) expect(() => sanitizeCoverage(raw)).not.toThrow();
  });
});

describe('mergeCoverage', () => {
  const first: CoverageCapture = {
    v: 1,
    files: [
      { path: 'src/a.cs', runtime: 'server', blob: BLOB_A, functions: [[1, 10]], lines: [[2, 3]] },
      { path: 'src/b.ts', runtime: 'browser', functions: [[5, 6]] },
    ],
  };
  const second: CoverageCapture = {
    v: 1,
    files: [
      {
        path: 'src/a.cs',
        runtime: 'server',
        blob: BLOB_A,
        functions: [
          [1, 10],
          [3, 4],
        ],
        lines: [[4, 4]],
      },
      { path: 'src/a.cs', runtime: 'browser', lines: [[7, 7]] },
    ],
  };

  test('unions files per runtime and path, sorted by path then runtime', () => {
    expect(mergeCoverage(first, second)).toEqual({
      v: 1,
      files: [
        { path: 'src/a.cs', runtime: 'browser', lines: [[7, 7]] },
        {
          path: 'src/a.cs',
          runtime: 'server',
          blob: BLOB_A,
          functions: [
            [1, 10],
            [3, 4],
          ],
          lines: [[2, 4]],
        },
        { path: 'src/b.ts', runtime: 'browser', functions: [[5, 6]] },
      ],
    });
  });

  test('keeps a blob that the entries having one agree on', () => {
    const withoutBlob: CoverageCapture = { v: 1, files: [{ path: 'src/a.cs', runtime: 'server', lines: [[20, 21]] }] };
    expect(mergeCoverage(first, withoutBlob)!.files[0]!.blob).toBe(BLOB_A);
    expect(mergeCoverage(first, withoutBlob)!.incomplete).toBeUndefined();
  });

  test('drops a blob the entries disagree on and marks the result incomplete', () => {
    const other: CoverageCapture = {
      v: 1,
      files: [{ path: 'src/a.cs', runtime: 'server', blob: BLOB_B, lines: [[20, 21]] }],
    };
    const out = mergeCoverage(first, other)!;
    expect(out.files[0]).toEqual({
      path: 'src/a.cs',
      runtime: 'server',
      functions: [[1, 10]],
      lines: [
        [2, 3],
        [20, 21],
      ],
    });
    expect(out.incomplete).toBe(true);
  });

  test('is incomplete when any input is', () => {
    expect(mergeCoverage(first, { ...second, incomplete: true })!.incomplete).toBe(true);
    expect(mergeCoverage(first, null, undefined)!.incomplete).toBeUndefined();
  });

  test('is null when there is no file', () => {
    expect(mergeCoverage()).toBeNull();
    expect(mergeCoverage(null, undefined)).toBeNull();
    expect(mergeCoverage({ v: 1, files: [] }, { v: 1, files: [], incomplete: true })).toBeNull();
  });

  test('leaves its inputs as they were', () => {
    const before = JSON.stringify([first, second]);
    mergeCoverage(first, second);
    expect(JSON.stringify([first, second])).toBe(before);
  });
});

describe('coverageFiles and granularityOf', () => {
  const capture: CoverageCapture = {
    v: 1,
    files: [
      { path: 'src/a.cs', runtime: 'browser' },
      { path: 'src/a.cs', runtime: 'server', functions: [[1, 2]] },
      { path: 'src/b.cs', runtime: 'server', functions: [[1, 2]], lines: [[1, 1]] },
    ],
  };

  test('lists sorted unique paths, optionally of one runtime', () => {
    expect(coverageFiles(capture)).toEqual(['src/a.cs', 'src/b.cs']);
    expect(coverageFiles(capture, 'browser')).toEqual(['src/a.cs']);
    expect(coverageFiles(capture, 'server')).toEqual(['src/a.cs', 'src/b.cs']);
    expect(coverageFiles(null)).toEqual([]);
    expect(coverageFiles(undefined, 'server')).toEqual([]);
  });

  test('reads the granularity from the ranges a file carries', () => {
    expect(capture.files.map(granularityOf)).toEqual(['files', 'functions', 'lines']);
    expect(granularityOf({ path: 'a.ts', runtime: 'server', lines: [[1, 1]] })).toBe('lines');
    expect(granularityOf({ path: 'a.ts', runtime: 'server', functions: [], lines: [] })).toBe('files');
  });
});

describe('reduceCoverage', () => {
  const capture: CoverageCapture = {
    v: 1,
    files: [
      { path: 'src/a.cs', runtime: 'server', blob: BLOB_A, functions: [[1, 10]], lines: [[2, 3]] },
      { path: 'src/b.cs', runtime: 'server', blob: BLOB_A, lines: [[5, 5]] },
      { path: 'src/c.ts', runtime: 'browser', functions: [[4, 8]] },
    ],
    incomplete: true,
  };

  test('files keeps paths only, without line numbers or blobs', () => {
    expect(reduceCoverage(capture, 'files')).toEqual({
      v: 1,
      files: [
        { path: 'src/a.cs', runtime: 'server' },
        { path: 'src/b.cs', runtime: 'server' },
        { path: 'src/c.ts', runtime: 'browser' },
      ],
      incomplete: true,
    });
  });

  test('functions drops the line ranges', () => {
    expect(reduceCoverage(capture, 'functions').files).toEqual([
      { path: 'src/a.cs', runtime: 'server', blob: BLOB_A, functions: [[1, 10]] },
      { path: 'src/b.cs', runtime: 'server' },
      { path: 'src/c.ts', runtime: 'browser', functions: [[4, 8]] },
    ]);
  });

  test('lines keeps everything', () => {
    expect(reduceCoverage(capture, 'lines')).toEqual(capture);
  });
});

describe('encodeLineRanges and decodeLineRanges', () => {
  test('encodes a single line without a dash', () => {
    expect(
      encodeLineRanges([
        [12, 15],
        [20, 20],
        [33, 35],
      ]),
    ).toBe('12-15,20,33-35');
    expect(encodeLineRanges([])).toBe('');
  });

  test('encodes in the order given, without merging', () => {
    expect(
      encodeLineRanges([
        [1, 30],
        [10, 20],
      ]),
    ).toBe('1-30,10-20');
  });

  test('round-trips normalized line ranges', () => {
    const ranges = normalizeLineRanges([
      [40, 40],
      [1, 3],
      [7, 12],
      [999_999, 1_000_000],
    ]);
    expect(decodeLineRanges(encodeLineRanges(ranges))).toEqual(ranges);
    const functions = normalizeFunctionRanges([
      [10, 20],
      [1, 30],
      [12, 12],
    ]);
    expect(decodeFunctionRanges(encodeLineRanges(functions))).toEqual(functions);
  });

  test('decodes leniently, ignoring malformed parts, and normalizes', () => {
    expect(decodeLineRanges(' 3 - 5 ,x,7,,0,9-8,1-2-3,10-11, 12,-4,6-,1000001')).toEqual([
      [3, 5],
      [7, 7],
      [10, 12],
    ]);
    expect(decodeLineRanges('5,4,3')).toEqual([[3, 5]]);
    expect(decodeLineRanges('')).toEqual([]);
    expect(decodeLineRanges(null)).toEqual([]);
    expect(decodeLineRanges(undefined)).toEqual([]);
  });

  test('decodes function ranges without merging them', () => {
    expect(decodeFunctionRanges('10-20,1-30,10-20,21-25')).toEqual([
      [1, 30],
      [10, 20],
      [21, 25],
    ]);
  });
});

describe('canonicalCoverageFile', () => {
  test('is the same for the same content in any order', () => {
    const a = canonicalCoverageFile({
      path: 'src/a.cs',
      runtime: 'server',
      blob: BLOB_A,
      functions: [
        [10, 20],
        [1, 30],
      ],
      lines: [
        [12, 14],
        [2, 3],
        [4, 4],
      ],
    });
    const b = canonicalCoverageFile({
      lines: [
        [2, 4],
        [12, 13],
        [14, 14],
      ],
      functions: [
        [1, 30],
        [10, 20],
        [1, 30],
      ],
      blob: BLOB_A,
      runtime: 'server',
      path: 'src/a.cs',
    });
    expect(a).toBe(b);
    expect(a).toBe(JSON.stringify(['server', 'src/a.cs', BLOB_A, '1-30,10-20', '2-4,12-14']));
  });

  test('adds the executable lines and every known function only when a file names either', () => {
    const plain = { path: 'src/a.ts', runtime: 'server' as const, blob: BLOB_A, lines: [[2, 3]] as LineRange[] };
    expect(canonicalCoverageFile({ ...plain, executable: [], allFunctions: [] })).toBe(canonicalCoverageFile(plain));
    expect(canonicalCoverageFile({ ...plain, executable: [[1, 4]] })).toBe(
      JSON.stringify(['server', 'src/a.ts', BLOB_A, '', '2-3', '1-4', '']),
    );
    // A report's file nothing ran keeps its blob with its executable lines.
    expect(canonicalCoverageFile({ path: 'src/a.ts', runtime: 'server', blob: BLOB_A, executable: [[1, 4]] })).toBe(
      JSON.stringify(['server', 'src/a.ts', BLOB_A, '', '', '1-4', '']),
    );
  });

  test('differs when the runtime, the path, the blob or a range differs', () => {
    const base = { path: 'src/a.ts', runtime: 'browser' as const, blob: BLOB_A, functions: [[1, 5]] as LineRange[] };
    const canonical = canonicalCoverageFile(base);
    expect(canonicalCoverageFile({ ...base, runtime: 'server' })).not.toBe(canonical);
    expect(canonicalCoverageFile({ ...base, path: 'src/b.ts' })).not.toBe(canonical);
    expect(canonicalCoverageFile({ ...base, blob: BLOB_B })).not.toBe(canonical);
    expect(canonicalCoverageFile({ ...base, functions: [[1, 6]] })).not.toBe(canonical);
    expect(canonicalCoverageFile({ ...base, lines: [[2, 2]] })).not.toBe(canonical);
  });

  test('writes an empty blob for a file without one', () => {
    expect(canonicalCoverageFile({ path: 'src/a.ts', runtime: 'browser' })).toBe(
      JSON.stringify(['browser', 'src/a.ts', '', '', '']),
    );
  });
});

describe('line range queries', () => {
  const ranges: LineRange[] = [
    [1, 3],
    [10, 12],
    [20, 20],
  ];

  test('lineInRanges', () => {
    const hits = [0, 1, 3, 4, 9, 10, 12, 13, 19, 20, 21].filter((line) => lineInRanges(ranges, line));
    expect(hits).toEqual([1, 3, 10, 12, 20]);
    expect(lineInRanges([], 1)).toBe(false);
  });

  test('intersectLineRanges', () => {
    const a: LineRange[] = [
      [1, 5],
      [10, 20],
      [30, 40],
    ];
    const b: LineRange[] = [
      [3, 12],
      [15, 15],
      [18, 35],
    ];
    const expected: LineRange[] = [
      [3, 5],
      [10, 12],
      [15, 15],
      [18, 20],
      [30, 35],
    ];
    expect(intersectLineRanges(a, b)).toEqual(expected);
    expect(intersectLineRanges(b, a)).toEqual(expected);
    expect(intersectLineRanges(a, [])).toEqual([]);
    expect(intersectLineRanges([[1, 2]], [[3, 4]])).toEqual([]);
  });

  test('countLines', () => {
    expect(countLines(ranges)).toBe(7);
    expect(countLines([])).toBe(0);
  });
});
