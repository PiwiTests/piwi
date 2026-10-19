import { describe, expect, it } from 'vitest';
import { parseCoverageReport } from './coverage-report';
import { writeCobertura, writeLcov, type WrittenFile } from '../src/coverage-writers';

const files: WrittenFile[] = [
  {
    path: 'src/cart/Cart.cs',
    executable: [
      [2, 4],
      [6, 8],
    ],
    lines: [[2, 4]],
    allFunctions: [
      [2, 4],
      [6, 8],
    ],
    functions: [[2, 4]],
  },
  { path: 'Program.cs', executable: [[1, 1]], lines: [], allFunctions: [], functions: [] },
];

describe('writeLcov', () => {
  it('writes each executable line with a hit of 1 when it ran, and each function by its lines', () => {
    const text = writeLcov(files);
    expect(text).toContain(
      'SF:src/cart/Cart.cs\nFN:2,4,lines_2_4\nFN:6,8,lines_6_8\nFNDA:1,lines_2_4\nFNDA:0,lines_6_8',
    );
    expect(text).toContain('DA:4,1\nDA:6,0');
    expect(text).toContain('LF:6\nLH:3\nend_of_record');
  });

  it('reads back to the same files', () => {
    expect(parseCoverageReport(writeLcov(files))?.files).toEqual(files);
  });

  it('writes nothing for no files', () => {
    expect(writeLcov([])).toBe('');
  });
});

describe('writeCobertura', () => {
  it('writes one class per file in a package per folder, with the totals', () => {
    const text = writeCobertura(files, 1_700_000_000.5);
    expect(text).toContain('lines-covered="3" lines-valid="7"');
    expect(text).toContain('timestamp="1700000000"');
    expect(text).toContain('<package name="src.cart"');
    expect(text).toContain('<class name="Cart.cs" filename="src/cart/Cart.cs" line-rate="0.5"');
    expect(text).toContain('<package name=""');
  });

  it('reads back to the same files, from the source `.`', () => {
    const report = parseCoverageReport(writeCobertura(files, 0));
    expect(report?.sources).toEqual(['.']);
    expect(report?.files).toEqual(files);
  });

  it('escapes a path for XML', () => {
    const text = writeCobertura([{ ...files[1]!, path: 'src/a&b<c>.ts' }], 0);
    expect(text).toContain('filename="src/a&amp;b&lt;c&gt;.ts"');
    expect(parseCoverageReport(text)?.files[0]?.path).toBe('src/a&b<c>.ts');
  });
});
