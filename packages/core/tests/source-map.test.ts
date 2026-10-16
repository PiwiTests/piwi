import { describe, expect, test } from 'vitest';
import {
  decodeDataUrl,
  decodeSourceMap,
  lineStarts,
  normalizeSourcePath,
  offsetToPosition,
  sourceMappingUrl,
} from '../src/source-map';

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

/** Encode segments `[genCol, source?, originalLine?]` per generated line; the original line defaults to 1. */
function encode(lines: Array<Array<[number, number?, number?]>>): string {
  let prevSource = 0;
  let prevOrigLine = 0;
  return lines
    .map((segments) => {
      let prevCol = 0;
      return segments
        .map(([col, source, origLine = 1]) => {
          let out = vlq(col - prevCol);
          prevCol = col;
          if (source !== undefined) {
            out += vlq(source - prevSource) + vlq(origLine - prevOrigLine) + vlq(0);
            prevSource = source;
            prevOrigLine = origLine;
          }
          return out;
        })
        .join(',');
    })
    .join(';');
}

describe('decodeSourceMap', () => {
  const map = decodeSourceMap({
    version: 3,
    sourceRoot: 'webpack://shop/',
    sources: ['./src/Pay.vue', './node_modules/vue/index.js'],
    mappings: encode([[[0, 0], [10, 1], [20]], [], [[4, 1]]]),
  })!;

  test('applies the source root', () => {
    expect(map.sources).toEqual(['webpack://shop/./src/Pay.vue', 'webpack://shop/./node_modules/vue/index.js']);
  });

  test('finds the segment at or before a column', () => {
    expect(map.sourceAt(0, 0)).toBe(0);
    expect(map.sourceAt(0, 9)).toBe(0);
    expect(map.sourceAt(0, 15)).toBe(1);
    expect(map.sourceAt(0, 25)).toBeNull(); // a segment with no source
    expect(map.sourceAt(1, 3)).toBeNull(); // an empty line
    expect(map.sourceAt(2, 2)).toBeNull(); // before the line's first segment
    expect(map.sourceAt(2, 8)).toBe(1);
    expect(map.sourceAt(9, 0)).toBeNull();
  });

  test('reads the original lines a range of generated code spans, per source', () => {
    // Line 0: source 0 at original line 4, then source 1 at 40; line 1: source 0 at 6; line 2: source 0 at 5.
    const lines = decodeSourceMap({
      version: 3,
      sources: ['a.ts', 'b.ts'],
      mappings: encode([
        [
          [0, 0, 4],
          [10, 1, 40],
        ],
        [[2, 0, 6]],
        [[0, 0, 5]],
      ]),
    })!;
    expect(lines.originalLinesBetween(0, { line: 0, column: 0 }, { line: 2, column: 1 })).toEqual([4, 6]);
    expect(lines.originalLinesBetween(1, { line: 0, column: 0 }, { line: 2, column: 1 })).toEqual([40, 40]);
    expect(lines.originalLinesBetween(0, { line: 0, column: 0 }, { line: 1, column: 0 })).toEqual([4, 4]);
    expect(lines.originalLinesBetween(1, { line: 1, column: 0 }, { line: 2, column: 9 })).toBeNull();
  });

  test('reads an index map with sections', () => {
    const indexed = decodeSourceMap({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], mappings: encode([[[0, 0]]]) } },
        { offset: { line: 5, column: 0 }, map: { version: 3, sources: ['b.ts'], mappings: encode([[[0, 0]]]) } },
      ],
    })!;
    expect(indexed.sources).toEqual(['a.ts', 'b.ts']);
    expect(indexed.sourceAt(0, 3)).toBe(0);
    expect(indexed.sourceAt(5, 3)).toBe(1);
    // The lines between two sections have no segment.
    expect(indexed.sourceAt(3, 0)).toBeNull();
    expect(indexed.mapsBetween(1, { line: 0, column: 1 }, { line: 6, column: 0 })).toBe(true);
    expect(indexed.originalLinesBetween(0, { line: 1, column: 0 }, { line: 6, column: 0 })).toBeNull();
  });

  test('sorts a line whose segments come out of column order, with their original lines', () => {
    const unsorted = decodeSourceMap({
      version: 3,
      sources: ['a.ts', 'b.ts'],
      mappings: encode([
        [
          [20, 1, 9],
          [0, 0, 3],
        ],
      ]),
    })!;
    expect(unsorted.originalAt(0, 5)).toEqual({ source: 0, line: 3 });
    expect(unsorted.originalAt(0, 25)).toEqual({ source: 1, line: 9 });
    expect(unsorted.originalLinesBetween(1, { line: 0, column: 0 }, { line: 0, column: 30 })).toEqual([9, 9]);
  });

  test('answers nothing outside the generated lines', () => {
    expect(map.originalAt(-1, 0)).toBeNull();
    expect(map.originalAt(3, 0)).toBeNull();
    expect(map.mapsBetween(0, { line: -2, column: 0 }, { line: 0, column: 5 })).toBe(true);
  });

  test('refuses another version', () => {
    expect(decodeSourceMap({ version: 2, sources: [], mappings: '' })).toBeNull();
  });
});

describe('positions and comments', () => {
  test('offsetToPosition', () => {
    const starts = lineStarts('ab\ncde\n\nf');
    expect(starts).toEqual([0, 3, 7, 8]);
    expect(offsetToPosition(starts, 0)).toEqual({ line: 0, column: 0 });
    expect(offsetToPosition(starts, 5)).toEqual({ line: 1, column: 2 });
    expect(offsetToPosition(starts, 8)).toEqual({ line: 3, column: 0 });
  });

  test('sourceMappingUrl reads the last comment', () => {
    expect(sourceMappingUrl('a();\n//# sourceMappingURL=old.map\nb();\n//# sourceMappingURL=app.js.map\n')).toBe(
      'app.js.map',
    );
    expect(sourceMappingUrl('a();')).toBeNull();
  });

  test('decodeDataUrl', () => {
    const json = '{"version":3,"sources":["é.ts"]}';
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    expect(decodeDataUrl(`data:application/json;charset=utf-8;base64,${b64}`)).toBe(json);
    expect(decodeDataUrl(`data:application/json,${encodeURIComponent(json)}`)).toBe(json);
    expect(decodeDataUrl('app.js.map')).toBeNull();
  });

  test('normalizeSourcePath', () => {
    expect(normalizeSourcePath('webpack://shop/./src/Pay.vue?vue&type=script')).toBe('src/Pay.vue');
    expect(normalizeSourcePath('/@fs/home/me/app/src/a.ts?t=123')).toBe('/home/me/app/src/a.ts');
    expect(normalizeSourcePath('/@fs/C:/app/src/a.ts')).toBe('C:/app/src/a.ts');
    expect(normalizeSourcePath('file:///home/me/app/b.ts')).toBe('/home/me/app/b.ts');
    expect(normalizeSourcePath('../../src/c%20d.ts')).toBe('../../src/c d.ts');
    expect(normalizeSourcePath('turbopack:///[project]/app/page.tsx')).toBe('app/page.tsx');
  });
});

describe('code reach', async () => {
  const { executedFunctionOffsets, finalizeCodeReach, reachedSources, scriptRan } = await import('../src/code-reach');
  const source = 'import x from "./x";\nfunction pay() { return 1 }\nfunction idle() {}\npay();\n';
  const entry = {
    url: 'http://localhost:5173/src/pay.ts',
    source,
    functions: [
      { functionName: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
      { functionName: 'pay', ranges: [{ startOffset: 21, endOffset: 48, count: 1 }] },
      { functionName: 'idle', ranges: [{ startOffset: 49, endOffset: 67, count: 0 }] },
    ],
  };

  test('the top level and functions that did not run are left out', () => {
    expect(executedFunctionOffsets(entry)).toEqual([21]);
    expect(scriptRan(entry)).toBe(true);
    expect(scriptRan({ ...entry, functions: [entry.functions[0]!, entry.functions[2]!] })).toBe(false);
  });

  test('offsets map to sources through the map', () => {
    const map = decodeSourceMap({ version: 3, sources: ['a.ts', 'b.ts'], mappings: 'AAAA;ACAA' })!;
    // Line 1 (0-based) starts with source 1: the `pay` function.
    expect([...reachedSources(entry, map)]).toEqual([1]);
  });

  test('mapsBetween looks from a position up to an end, across lines', () => {
    // Line 0: source 0 at 0, source 1 at 10; line 1: nothing; line 2: source 0 at 4.
    const map = decodeSourceMap({
      version: 3,
      sources: ['a.ts', 'b.ts'],
      mappings: encode([
        [
          [0, 0],
          [10, 1],
        ],
        [],
        [[4, 0]],
      ]),
    })!;
    expect(map.mapsBetween(1, { line: 0, column: 5 }, { line: 0, column: 20 })).toBe(true);
    expect(map.mapsBetween(1, { line: 0, column: 5 }, { line: 0, column: 10 })).toBe(false);
    expect(map.mapsBetween(0, { line: 0, column: 5 }, { line: 2, column: 5 })).toBe(true);
    expect(map.mapsBetween(0, { line: 0, column: 5 }, { line: 2, column: 4 })).toBe(false);
  });

  test('generated code takes no source from the code before it', () => {
    // One minified line: cart.ts's function, a generated helper with no mapping, then main.ts's arrow whose body
    // calls code inlined from cart.ts.
    const line = 'function a(){return 1}var h=function(){return 2};var m=()=>function(){return 3}();';
    const segments: Array<[number, number?]> = [
      [0, 0],
      [9, 0],
      [13, 0],
      [49, 1],
      [59, 0],
      [70, 0],
      [79, 1],
    ];
    const map = decodeSourceMap({ version: 3, sources: ['cart.ts', 'main.ts'], mappings: encode([segments]) })!;
    const fn = (start: number, end: number) => ({
      functionName: '',
      ranges: [{ startOffset: start, endOffset: end, count: 1 }],
    });
    const bundle = { url: 'http://localhost/app.js', source: line, functions: [fn(0, line.length)] };
    const reached = (start: number, end: number) => [
      ...reachedSources({ ...bundle, functions: [...bundle.functions, fn(start, end)] }, map),
    ];
    // The helper at 28 starts after cart.ts's segment at 13 but holds none of its code.
    expect(reached(28, 48)).toEqual([]);
    // The arrow at 55 starts after main.ts's segment at 49 and holds main.ts code at 79, after the inlined function.
    expect(reached(55, 81)).toEqual([1]);
    // The inlined function at 59 is cart.ts's.
    expect(reached(59, 79)).toEqual([0]);
  });

  test('finalizeCodeReach keeps repository-relative paths', () => {
    expect(
      finalizeCodeReach(['src/b.ts', './src/a.ts', 'node_modules/vue/x.js', '../outside.ts', '/abs.ts', 'src/a.ts']),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
