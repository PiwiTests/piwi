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

  /** `mappings` for one generated line, from its segments: generated column and original 0-based line, source 0. */
  function lineMappings(segments: Array<[column: number, line: number]>): string {
    let column = 0;
    let line = 0;
    return segments
      .map(([c, l]) => {
        const out = `${vlq(c - column)}A${vlq(l - line)}A`;
        column = c;
        line = l;
        return out;
      })
      .join(',');
  }

  /** A one-line script with its functions' ranges, from the text each function starts and ends with. */
  function oneLine(script: string, functions: Array<[start: string, end: string]>): JsCoverageEntry {
    return {
      url: 'http://localhost:5173/assets/index.js',
      source: script,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: script.length, count: 1 }] },
        ...functions.map(([from, to]) => {
          const startOffset = script.indexOf(from);
          return {
            functionName: '',
            ranges: [{ startOffset, endOffset: script.indexOf(to, startOffset) + to.length, count: 1 }],
          };
        }),
      ],
    };
  }

  test('takes the lines of its own code for a function whose start borrows a later line', () => {
    // A template compiled after its script: the render function's start has no segment and takes the mapping of the
    // script's last statement, on original line 30.
    const script = 'function a(){x()}let r=(t)=>(y(),z());';
    const at = (text: string) => script.indexOf(text);
    const mappings = lineMappings([
      [at('function a'), 29],
      [at('x()'), 30],
      [at('}let'), 31],
      [at('y()'), 2],
      [at('z()'), 7],
    ]);
    const map = decodeSourceMap({ version: 3, sources: ['src/App.vue'], mappings })!;
    const entry = oneLine(script, [
      ['function a', '}'],
      ['(t)=>', 'z())'],
    ]);
    expect([...reachedFunctionLines(entry, map)]).toEqual([
      [
        0,
        [
          [30, 32],
          [3, 8],
        ],
      ],
    ]);
  });

  test('leaves out the code inlined from above a function whose start borrows an earlier line', () => {
    // The render function's start takes the mapping of the statement before it (line 6); a minifier inlined into it
    // a function of lines 8 to 11.
    const script = 'let n=c(0);return(t)=>(u(),function(e){p()}(e),v())';
    const at = (text: string) => script.indexOf(text);
    const mappings = lineMappings([
      [at('let n'), 5],
      [at('u()'), 18],
      [at('function(e)'), 7],
      [at('p()'), 8],
      [at('}(e)'), 10],
      [at('v()'), 24],
    ]);
    const map = decodeSourceMap({ version: 3, sources: ['src/List.vue'], mappings })!;
    const entry = oneLine(script, [['(t)=>', 'v())']]);
    expect([...reachedFunctionLines(entry, map)]).toEqual([[0, [[19, 25]]]]);
  });

  test('starts a function on the line its start borrows when its own code begins there or on the next line', () => {
    // A minified arrow function: its start has no segment, the assignment before it maps to its header line.
    const script = 'const f=(a)=>{g(a);h(a)};';
    const at = (text: string) => script.indexOf(text);
    const mappings = lineMappings([
      [at('const f'), 4],
      [at('g(a)'), 5],
      [at('h(a)'), 6],
      [at('};'), 7],
    ]);
    const map = decodeSourceMap({ version: 3, sources: ['src/cart.ts'], mappings })!;
    expect([...reachedFunctionLines(oneLine(script, [['(a)=>', '}']]), map)]).toEqual([[0, [[5, 8]]]]);
  });

  test('leaves out a function whose start maps to no source', () => {
    // Line 0 has a segment with no source, so the function starting there maps nowhere.
    const mappings = ['A', `AA${vlq(2)}A`, 'AAEA'].join(';');
    const map = decodeSourceMap({ version: 3, sources: ['src/pay.ts'], mappings })!;
    expect(reachedFunctionLines(entry, map).size).toBe(0);
  });
});
