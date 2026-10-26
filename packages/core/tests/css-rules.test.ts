import { describe, expect, test } from 'vitest';
import { allCssRules, cssRuleLines, parseCssRules, usedCssRules } from '../src/css-rules';
import { decodeSourceMap } from '../src/source-map';

// The same sheet the rule usage of a real Chromium was read on: each used range below is what it reported.
const SHEET = [
  '/* header { not a rule } */', // 1
  '.a { color: red; }', //          2
  '.b,', //                         3
  '.c {', //                        4
  '  color: blue;', //              5
  '}', //                           6
  '@media (min-width: 1px) {', //   7
  '  .d { color: green; }', //      8
  '  .e { color: green; }', //      9
  '}', //                          10
  '@import url("x.css");', //      11
  '@layer base { .h { margin: 0 } }', // 12
  '@font-face { font-family: "X;{"; src: url(x.woff) }', // 13
  '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }', // 14
  '.n { color: red; &:hover { color: blue } }', // 15
].join('\n');

const at = (needle: string, from = 0) => SHEET.indexOf(needle, from);

describe('parseCssRules', () => {
  test('lists style and grouping rules, nested ones included, and leaves other at-rules and comments out', () => {
    const rules = parseCssRules(SHEET).map((rule) => [rule.kind, SHEET.slice(rule.start, rule.open).trim()]);
    expect(rules).toEqual([
      ['style', '.a'],
      ['style', '.b,\n.c'],
      ['group', '@media (min-width: 1px)'],
      ['style', '.d'],
      ['style', '.e'],
      ['group', '@layer base'],
      ['style', '.h'],
      ['style', '.n'],
      ['style', '&:hover'],
    ]);
  });
});

describe('usedCssRules', () => {
  const rules = parseCssRules(SHEET);

  test('takes a style rule whole, a grouping rule at its start only, and drops a range that names no rule', () => {
    const used = [
      { startOffset: at('.b,'), endOffset: at('}', at('.b,')) + 1 },
      { startOffset: at('(min-width'), endOffset: at('{', at('(min-width')) },
      { startOffset: at('.d'), endOffset: at('}', at('.d')) + 1 },
      // A layer's entry spans from its name to the end of its block.
      { startOffset: at('base {'), endOffset: at('} }') + 3 },
      { startOffset: at('header'), endOffset: at('header') + 6 },
    ];
    const lines = cssRuleLines(SHEET, usedCssRules(rules, used));
    expect(lines).toEqual(
      new Map([
        [
          -1,
          [
            [3, 6],
            [7, 7],
            [8, 8],
            [12, 12],
          ],
        ],
      ]),
    );
  });

  test('every rule, for the executable side, the same way', () => {
    expect(cssRuleLines(SHEET, allCssRules(rules)).get(-1)).toEqual([
      [2, 2],
      [3, 6],
      [7, 7],
      [8, 8],
      [9, 9],
      [12, 12],
      [12, 12],
      [15, 15],
      [15, 15],
    ]);
  });
});

describe('cssRuleLines', () => {
  test('shifts the lines of a <style> element to its place in the page', () => {
    const text = '\n.inline { color: red }\n';
    const rules = parseCssRules(text);
    expect(cssRuleLines(text, allCssRules(rules), { lineOffset: 9 }).get(-1)).toEqual([[11, 11]]);
  });

  test('maps the lines through the sheet’s source map, to its sources', () => {
    // A preprocessor's output: `.a{color:red}` on line 1 comes from line 3 of a.scss, `.b{…}` on line 2 from line 7.
    const text = '.a{color:red}\n.b{color:blue}\n';
    const lookup = decodeSourceMap({
      version: 3,
      sources: ['a.scss'],
      // Line 0: column 0 → a.scss line 2; line 1: column 0 → line 6, column 13 (the closing brace) → line 8.
      mappings: 'AAEA;AAIA,aAEA',
    });
    const rules = parseCssRules(text);
    expect(cssRuleLines(text, allCssRules(rules), { lookup })).toEqual(
      new Map([
        [
          0,
          [
            [3, 3],
            [7, 9],
          ],
        ],
      ]),
    );
  });
});
