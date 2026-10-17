import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CoverageReportReader,
  detectCoverageFormat,
  mergeReportedFiles,
  parseCoverageReport,
  reportPathCandidates,
  type CoverageReport,
} from '../src/coverage-formats';

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'coverage-reports');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

/** A report fed in chunks of `size` characters, as a stream delivers it. */
function readInChunks(text: string, size: number): CoverageReport {
  const reader = new CoverageReportReader(detectCoverageFormat(text)!);
  for (let at = 0; at < text.length; at += size) reader.write(text.slice(at, at + size));
  return reader.end();
}

describe('detectCoverageFormat', () => {
  it('tells Cobertura from LCOV by the first bytes', () => {
    expect(detectCoverageFormat(fixture('vitest.cobertura.xml'))).toBe('cobertura');
    expect(detectCoverageFormat(fixture('microsoft.cobertura.xml'))).toBe('cobertura');
    expect(detectCoverageFormat(fixture('vitest.lcov.info'))).toBe('lcov');
    expect(detectCoverageFormat(fixture('coverlet.lcov.info'))).toBe('lcov');
    expect(detectCoverageFormat('<html><body></body></html>')).toBeNull();
    expect(detectCoverageFormat('{"v":1}')).toBeNull();
  });
});

describe('Cobertura', () => {
  it("reads Vitest's report: the root as source, every included file, methods by their declaration line", () => {
    const report = parseCoverageReport(fixture('vitest.cobertura.xml'))!;
    expect(report.format).toBe('cobertura');
    expect(report.sources).toEqual(['/home/ci/repo/apps/web']);
    expect(report.files).toEqual([
      {
        path: 'src/math.ts',
        executable: [
          [2, 2],
          [6, 7],
          [9, 9],
          [12, 12],
        ],
        lines: [
          [2, 2],
          [6, 6],
          [9, 9],
          [12, 12],
        ],
        functions: [
          [1, 1],
          [5, 5],
        ],
        allFunctions: [
          [1, 1],
          [5, 5],
          [12, 12],
        ],
      },
      { path: 'src/unused.ts', executable: [[2, 2]], lines: [], functions: [], allFunctions: [[1, 1]] },
    ]);
  });

  it("reads coverlet's report: class lines only, a method spanning its lines", () => {
    const report = parseCoverageReport(fixture('coverlet.cobertura.xml'))!;
    expect(report.sources).toEqual(['/']);
    expect(report.files).toEqual([
      {
        path: 'home/ci/repo/src/Lib/Prices.cs',
        executable: [
          [6, 9],
          [12, 13],
          [16, 18],
        ],
        lines: [
          [6, 7],
          [12, 13],
        ],
        functions: [[6, 13]],
        allFunctions: [
          [6, 13],
          [16, 18],
        ],
      },
    ]);
  });

  it("reads Microsoft code coverage's report: absolute file names, no source, a byte order mark", () => {
    const report = parseCoverageReport(fixture('microsoft.cobertura.xml'))!;
    expect(report.sources).toEqual([]);
    expect(report.files.map((file) => file.path)).toEqual([
      '/home/ci/repo/src/Lib.Tests/PricesTests.cs',
      '/home/ci/repo/src/Lib/Prices.cs',
    ]);
    const prices = report.files[1]!;
    expect(prices.executable).toEqual([
      [6, 9],
      [12, 13],
      [16, 18],
    ]);
    expect(prices.lines).toEqual([
      [6, 7],
      [12, 13],
    ]);
  });

  it('gives the same result whatever the chunks the report arrives in', () => {
    for (const name of ['vitest.cobertura.xml', 'coverlet.cobertura.xml', 'microsoft.cobertura.xml']) {
      const whole = parseCoverageReport(fixture(name));
      for (const size of [1, 7, 64, 1000]) expect(readInChunks(fixture(name), size)).toEqual(whole);
    }
  });

  it('merges the classes of one file and keeps a line that ran in any of them', () => {
    const report = parseCoverageReport(`<?xml version="1.0"?>
      <coverage><packages><package><classes>
        <class name="A" filename="src/Shop.cs"><lines><line number="3" hits="0"/><line number="4" hits="2"/></lines></class>
        <class name="A.B" filename="src/Shop.cs"><lines><line number="3" hits="1"/><line number="9" hits="0"/></lines></class>
      </classes></package></packages></coverage>`)!;
    expect(report.files).toEqual([
      {
        path: 'src/Shop.cs',
        executable: [
          [3, 4],
          [9, 9],
        ],
        lines: [[3, 4]],
        functions: [],
        allFunctions: [],
      },
    ]);
  });

  it('decodes the predefined entities and character references, and expands no other entity', () => {
    const report = parseCoverageReport(`<?xml version="1.0"?>
      <!DOCTYPE coverage [<!ENTITY big "aaaaaaaaaa">]>
      <!-- <class filename="ignored.cs"> -->
      <coverage><sources><source>/repo/a&amp;b</source></sources><packages><package><classes>
        <class filename="src/R&amp;D&#47;x.cs"><lines><line number="1" hits="1"/></lines></class>
        <class filename="src/&big;.cs"><lines><line number="1" hits="1"/></lines></class>
      </classes></package></packages></coverage>`)!;
    expect(report.sources).toEqual(['/repo/a&b']);
    expect(report.files.map((file) => file.path)).toEqual(['src/R&D/x.cs', 'src/&big;.cs']);
  });

  it('reads quotes of the other kind and a > inside a quoted value, wherever the chunks split', () => {
    const text = `<?xml version="1.0"?>
      <coverage><sources><source>/repo</source></sources><packages><package><classes>
        <class filename="src/O'Brien/a.ts"><lines><line number="1" hits="1"/></lines></class>
        <!-- a comment's > and ' -->
        <class filename='src/6" disk/b.ts' note="a > b"><lines><line number='2' hits='0'/></lines></class>
        <class filename="src/c.ts"><lines><![CDATA[ > ' " ]]><line number="3" hits="2"/></lines></class>
      </classes></package></packages></coverage>`;
    const whole = parseCoverageReport(text)!;
    expect(whole.files).toEqual([
      { path: "src/O'Brien/a.ts", executable: [[1, 1]], lines: [[1, 1]], functions: [], allFunctions: [] },
      { path: 'src/6" disk/b.ts', executable: [[2, 2]], lines: [], functions: [], allFunctions: [] },
      { path: 'src/c.ts', executable: [[3, 3]], lines: [[3, 3]], functions: [], allFunctions: [] },
    ]);
    for (let at = 0; at <= text.length; at++) {
      const reader = new CoverageReportReader('cobertura');
      reader.write(text.slice(0, at));
      reader.write(text.slice(at));
      expect(reader.end(), `split at ${at}`).toEqual(whole);
    }
    expect(readInChunks(text, 1)).toEqual(whole);
  });

  it('reads a 10 MB report in 1 MB chunks in a single pass', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `<line number="${i + 1}" hits="${i % 3}" branch="false"/>`);
    const classes = Array.from(
      { length: 450 },
      (_, i) => `<class name="C${i}" filename="src/f${i}.cs"><methods/><lines>${lines.join('\n')}</lines></class>`,
    );
    const text = `<?xml version="1.0"?><coverage><packages><package><classes>${classes.join('\n')}</classes></package></packages></coverage>`;
    expect(text.length).toBeGreaterThan(9 * 1024 * 1024);
    const started = performance.now();
    const report = readInChunks(text, 1024 * 1024);
    // Generous: one forward scan reads it in a few hundred milliseconds.
    expect(performance.now() - started).toBeLessThan(1500);
    expect(report.files).toHaveLength(450);
    expect(report.files[449]!.executable).toEqual([[1, 500]]);
  });

  it('refuses a tag longer than 1 MB rather than holding it', () => {
    const reader = new CoverageReportReader('cobertura');
    expect(() => reader.write(`<class filename="${'a'.repeat(1024 * 1024 + 10)}`)).toThrow(/longer than 1 MB/);
  });
});

describe('LCOV', () => {
  it("reads Vitest's report: every included file, functions by their start line", () => {
    const report = parseCoverageReport(fixture('vitest.lcov.info'))!;
    expect(report).toEqual({
      format: 'lcov',
      sources: [],
      files: [
        {
          path: 'src/math.ts',
          executable: [
            [2, 2],
            [6, 7],
            [9, 9],
            [12, 12],
          ],
          lines: [
            [2, 2],
            [6, 6],
            [9, 9],
            [12, 12],
          ],
          functions: [
            [1, 1],
            [5, 5],
          ],
          allFunctions: [
            [1, 1],
            [5, 5],
            [12, 12],
          ],
        },
        { path: 'src/unused.ts', executable: [[2, 2]], lines: [], functions: [], allFunctions: [[1, 1]] },
      ],
    });
  });

  it("reads coverlet's report, whose function names hold commas", () => {
    const [prices] = parseCoverageReport(fixture('coverlet.lcov.info'))!.files;
    expect(prices).toEqual({
      path: '/home/ci/repo/src/Lib/Prices.cs',
      executable: [
        [6, 9],
        [12, 13],
        [16, 18],
      ],
      lines: [
        [6, 7],
        [12, 13],
      ],
      functions: [[5, 5]],
      allFunctions: [
        [5, 5],
        [15, 15],
      ],
    });
  });

  it('reads end lines from FN records that give them, and the FNL and FNA records', () => {
    const report = parseCoverageReport(
      [
        'SF:src/a.ts',
        'FN:1,4,first',
        'FNDA:3,first',
        'FN:6,8,second',
        'FNDA:0,second',
        'FNL:0,10,12',
        'FNA:0,1,third',
        'DA:2,3',
        'end_of_record',
        '',
      ].join('\r\n'),
    )!;
    expect(report.files[0]!.functions).toEqual([
      [1, 4],
      [10, 12],
    ]);
    expect(report.files[0]!.allFunctions).toEqual([
      [1, 4],
      [6, 8],
      [10, 12],
    ]);
  });

  it('counts the n-th FNDA of a name for the n-th FN of that name', () => {
    const report = parseCoverageReport(
      ['SF:src/view.ts', 'FN:1,render', 'FN:40,render', 'FNDA:0,render', 'FNDA:3,render', 'end_of_record', ''].join(
        '\n',
      ),
    )!;
    expect(report.files[0]!.allFunctions).toEqual([
      [1, 1],
      [40, 40],
    ]);
    expect(report.files[0]!.functions).toEqual([[40, 40]]);
  });

  it('merges two records of one file', () => {
    const report = parseCoverageReport('SF:a.ts\nDA:1,0\nend_of_record\nSF:a.ts\nDA:1,1\nDA:2,0\nend_of_record\n')!;
    expect(report.files).toEqual([
      { path: 'a.ts', executable: [[1, 2]], lines: [[1, 1]], functions: [], allFunctions: [] },
    ]);
  });

  it('gives the same result whatever the chunks the report arrives in', () => {
    for (const name of ['vitest.lcov.info', 'coverlet.lcov.info']) {
      const whole = parseCoverageReport(fixture(name));
      for (const size of [1, 5, 100]) expect(readInChunks(fixture(name), size)).toEqual(whole);
    }
  });
});

describe('reportPathCandidates', () => {
  const repoRoot = '/home/ci/repo';

  it('tries a relative path against each base, inside the repository only', () => {
    expect(
      reportPathCandidates('src/math.ts', {
        repoRoot,
        bases: ['/home/ci/repo/apps/web', '/home/ci/repo', '/elsewhere', '/home/ci/repo/apps/web'],
      }),
    ).toEqual(['apps/web/src/math.ts', 'src/math.ts']);
  });

  it("makes an absolute path relative to the repository root, and reads .NET's deterministic /_/ root as it", () => {
    expect(reportPathCandidates('/home/ci/repo/src/Lib/Prices.cs', { repoRoot, bases: [] })).toEqual([
      'src/Lib/Prices.cs',
    ]);
    expect(reportPathCandidates('/_/src/Lib/Prices.cs', { repoRoot, bases: [] })).toEqual(['src/Lib/Prices.cs']);
    expect(reportPathCandidates('/opt/other/Prices.cs', { repoRoot, bases: [] })).toEqual([]);
  });

  it("reads the /_/ root of a coverlet deterministic report's <source>", () => {
    expect(reportPathCandidates('Services/Foo.cs', { repoRoot, bases: ['/_/src/App/', repoRoot] })).toEqual([
      'src/App/Services/Foo.cs',
      'Services/Foo.cs',
    ]);
    expect(reportPathCandidates('../../../etc/passwd', { repoRoot, bases: ['/_/src/App/'] })).toEqual([]);
  });

  it('reads Windows paths: backslashes and drive letters in any case', () => {
    expect(reportPathCandidates('d:\\a\\repo\\src\\Lib\\Prices.cs', { repoRoot: 'D:\\a\\repo', bases: [] })).toEqual([
      'src/Lib/Prices.cs',
    ]);
    expect(reportPathCandidates('src\\Lib\\Prices.cs', { repoRoot: 'D:\\a\\repo', bases: ['D:\\a\\repo'] })).toEqual([
      'src/Lib/Prices.cs',
    ]);
  });

  it("resolves coverlet's paths against its / source", () => {
    expect(reportPathCandidates('home/ci/repo/src/Lib/Prices.cs', { repoRoot, bases: ['/', repoRoot] })).toEqual([
      'src/Lib/Prices.cs',
      'home/ci/repo/src/Lib/Prices.cs',
    ]);
  });

  it('stands for nothing when the path climbs out of the repository', () => {
    expect(reportPathCandidates('../../etc/passwd', { repoRoot, bases: [repoRoot] })).toEqual([]);
    expect(reportPathCandidates('', { repoRoot, bases: [repoRoot] })).toEqual([]);
  });
});

describe('mergeReportedFiles', () => {
  it('is the union of both entries', () => {
    expect(
      mergeReportedFiles(
        { path: 'a', executable: [[1, 2]], lines: [[1, 1]], functions: [], allFunctions: [[1, 2]] },
        { path: 'b', executable: [[3, 3]], lines: [[3, 3]], functions: [[3, 3]], allFunctions: [[3, 3]] },
      ),
    ).toEqual({
      path: 'a',
      executable: [[1, 3]],
      lines: [
        [1, 1],
        [3, 3],
      ],
      functions: [[3, 3]],
      allFunctions: [
        [1, 2],
        [3, 3],
      ],
    });
  });
});

describe('Piwi run-level reports', () => {
  const report = JSON.stringify({
    v: 1,
    files: [
      { path: '/_/src/Shop.cs', runtime: 'server', functions: [[2, 4]], lines: [[3, 3]], executable: [[3, 4]] },
      {
        path: '/_/src/Shop.cs',
        runtime: 'server',
        lines: [[4, 4]],
        allFunctions: [
          [2, 4],
          [6, 8],
        ],
      },
      { runtime: 'server' },
    ],
  });

  it('is detected from its first bytes', () => {
    expect(detectCoverageFormat(report.slice(0, 40))).toBe('piwi');
    expect(detectCoverageFormat('{"name":"package"}')).toBeNull();
  });

  it('reads each file once, its entries merged, and skips an entry without a path', () => {
    expect(parseCoverageReport(report)).toEqual({
      format: 'piwi',
      sources: [],
      files: [
        {
          path: '/_/src/Shop.cs',
          executable: [[3, 4]],
          lines: [[3, 4]],
          functions: [[2, 4]],
          allFunctions: [
            [2, 4],
            [6, 8],
          ],
        },
      ],
    });
  });

  it('refuses text that is not a report', () => {
    expect(() => parseCoverageReport('{"v": 1', 'piwi')).toThrow(/not JSON/);
    expect(() => parseCoverageReport('{"v": 1}', 'piwi')).toThrow(/no "files"/);
  });
});
