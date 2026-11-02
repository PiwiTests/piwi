import { describe, expect, test } from 'vitest';
import { parseByteRange } from '../../server/utils/byte-range';

describe('parseByteRange', () => {
  test('reads a closed, an open and a suffix range, held to the file', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 });
    expect(parseByteRange('Bytes=1-2', 1000)).toEqual({ start: 1, end: 2 });
  });

  test('finds a range starting past the end unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  test('ignores what it does not serve: no header, another unit, several ranges, nonsense', () => {
    for (const header of [
      undefined,
      null,
      '',
      'bytes=',
      'bytes=-',
      'items=0-1',
      'bytes=0-1,4-5',
      'bytes=9-3',
      'bytes=a-b',
    ]) {
      expect(parseByteRange(header, 1000), String(header)).toBeNull();
    }
  });
});
