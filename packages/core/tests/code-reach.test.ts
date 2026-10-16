import { describe, expect, test } from 'vitest';
import { reachedFunctionLines, reachedSources, scriptRan, scriptText, type JsCoverageEntry } from '../src/code-reach';
import { decodeSourceMap } from '../src/source-map';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

describe('reachedFunctionLines', () => {
  const source = 'function pay() {\n  done();\n}\nfunction idle() {}\npay();\n';
  const entry: JsCoverageEntry = {
    url: 'http://localhost:5173/src/pay.js',
    source,
    functions: [
      { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
      { functionName: 'pay', ranges: [{ startOffset: 0, endOffset: 29, count: 1 }] },
      { functionName: 'idle', ranges: [{ startOffset: 30, endOffset: 48, count: 0 }] },
    ],
  };

  test('reads the lines of the script itself without a map, not counting its top level', () => {
    expect([...reachedFunctionLines(entry, null)]).toEqual([[-1, [[1, 3]]]]);
  });

  test('reads the original lines the function maps to through a map', () => {
    // Generated lines 0 to 2 map to original lines 9 to 11 of source 0.
    const mappings = [`AA${vlq(9)}A`, `AA${vlq(1)}A`, `AA${vlq(1)}A`].join(';');
    const map = decodeSourceMap({ version: 3, sources: ['src/pay.ts'], mappings })!;
    expect([...reachedFunctionLines(entry, map)]).toEqual([[0, [[10, 12]]]]);
  });

  test('starts a function on the line of the code it begins in', () => {
    // The declaration maps to original line 8, the body to lines 10 and 11.
    const mappings = [`AA${vlq(8)}A`, `AA${vlq(2)}A`, `AA${vlq(1)}A`].join(';');
    const map = decodeSourceMap({ version: 3, sources: ['src/pay.ts'], mappings })!;
    expect([...reachedFunctionLines(entry, map)]).toEqual([[0, [[9, 12]]]]);
  });

  test('is empty without the script source', () => {
    expect(reachedFunctionLines({ ...entry, source: undefined }, null).size).toBe(0);
  });

  test('reads the same lines from a cached script text as from the source', () => {
    const mappings = [`AA${vlq(8)}A`, `AA${vlq(2)}A`, `AA${vlq(1)}A`].join(';');
    const map = decodeSourceMap({ version: 3, sources: ['src/pay.ts'], mappings })!;
    const cached = scriptText(source);
    const withoutSource = { ...entry, source: undefined };
    expect([...reachedFunctionLines(withoutSource, map, cached)]).toEqual([[0, [[9, 12]]]]);
    expect([...reachedFunctionLines(withoutSource, null, cached)]).toEqual([[-1, [[1, 3]]]]);
    expect(scriptRan(withoutSource, cached)).toBe(true);
    expect([...reachedSources(withoutSource, map, cached)]).toEqual([0]);
  });

  test('leaves out a function whose start maps to no source', () => {
    // Line 0 has a segment with no source, so the function starting there maps nowhere.
    const mappings = ['A', `AA${vlq(2)}A`, 'AAEA'].join(';');
    const map = decodeSourceMap({ version: 3, sources: ['src/pay.ts'], mappings })!;
    expect(reachedFunctionLines(entry, map).size).toBe(0);
  });
});
