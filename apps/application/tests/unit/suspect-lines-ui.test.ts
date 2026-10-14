import { describe, expect, test } from 'vitest';
import type { SuspectLine, SuspectLinesAnswer } from '#shared/suspect-lines';
import { parsePatchLines } from '~/utils';
import {
  lineRangesText,
  patchHeadLines,
  suspectGranularityLabel,
  suspectLinesSentence,
  suspectMarks,
} from '~/utils/suspect-lines';

const BASKET = 'src/ApplicationCore/Services/BasketService.cs';

function suspect(over: Partial<SuspectLine> = {}): SuspectLine {
  return {
    path: BASKET,
    runtime: 'server',
    hunk: [57, 59],
    lines: [[57, 59]],
    granularity: 'lines',
    failing: 1,
    passing: 2,
    score: 0.577,
    ...over,
  };
}

function answer(suspects: SuspectLine[], summary: Partial<SuspectLinesAnswer['summary']> = {}): SuspectLinesAnswer {
  return {
    available: true,
    range: { from: 'a'.repeat(40), to: 'b'.repeat(40) },
    summary: {
      changedFiles: 4,
      changedLines: 13,
      hunks: 5,
      executedHunks: suspects.length,
      executedLines: 3,
      failingWithCoverage: 1,
      passingWithCoverage: 13,
      ...summary,
    },
    suspects,
  };
}

/** The sentence as the page reads it, the file in backticks. */
function read(a: SuspectLinesAnswer, subject: 'cluster' | 'execution'): string | null {
  const s = suspectLinesSentence(a, subject);
  if (!s) return null;
  const first = s.first
    ? `\`${s.first.name}\` ${s.first.lines}${s.first.granularity ? ` (${s.first.granularity})` : ''}`
    : '';
  return `${s.lead}${first}${s.more}`.replace(/\u00a0/g, ' ');
}

describe('the What changed sentence', () => {
  test('counts the changed lines the failing test ran, and names the first suspect', () => {
    expect(read(answer([suspect()]), 'cluster')).toBe(
      '3 of the 13 changed lines ran in the failing test: `BasketService.cs` 57 to 59',
    );
  });

  test('on an execution page it says since when, of this test', () => {
    expect(read(answer([suspect()]), 'execution')).toBe(
      '3 of the 13 lines changed since the last passing run ran in this test: `BasketService.cs` 57 to 59',
    );
  });

  test('says how many more suspects there are, and speaks of the failing tests when several have coverage', () => {
    const a = answer([suspect(), suspect({ path: 'src/Web/Basket.cs', hunk: [10, 12], lines: [[10, 10]] })], {
      executedLines: 4,
      failingWithCoverage: 2,
    });
    expect(read(a, 'cluster')).toBe(
      '4 of the 13 changed lines ran in the failing tests: `BasketService.cs` 57 to 59 and 1 more',
    );
  });

  test('counts every executed hunk in "more", past the suspects listed', () => {
    expect(read(answer([suspect()], { executedHunks: 60 }), 'cluster')).toMatch(/ and 59 more$/);
  });

  test('says all, or the changed line, when the failing test ran every changed line', () => {
    expect(read(answer([suspect()], { changedLines: 3 }), 'cluster')).toMatch(/^All 3 changed lines ran in/);
    const one = answer([suspect({ hunk: [57, 57], lines: [[57, 57]] })], { changedLines: 1, executedLines: 1 });
    expect(read(one, 'cluster')).toBe('The changed line ran in the failing test: `BasketService.cs` 57');
  });

  test('with a coarser granularity it counts the hunks reached and names the first one’s', () => {
    const a = answer(
      [
        suspect({ path: 'src/components/modal-controller.ts', hunk: [4, 5], lines: [[4, 5]], granularity: 'files' }),
        suspect({ granularity: 'lines' }),
      ],
      { hunks: 2, failingWithCoverage: 2 },
    );
    expect(read(a, 'cluster')).toBe(
      'The failing tests reached all 2 changed hunks: `modal-controller.ts` 4 to 5 (file reached) and 1 more',
    );
    expect(read(answer([suspect({ granularity: 'functions' })], { executedLines: 0 }), 'execution')).toBe(
      'This test reached 1 of the 5 hunks changed since the last passing run: `BasketService.cs` 57 to 59 (a function it ran)',
    );
  });

  test('says so when the coverage includes none of the changed lines', () => {
    const none = answer([], { executedHunks: 0, executedLines: 0 });
    expect(read(none, 'cluster')).toBe('The failing test’s coverage includes none of the 13 changed lines.');
    expect(read({ ...none, summary: { ...none.summary, failingWithCoverage: 3 } }, 'cluster')).toBe(
      'The failing tests’ coverage includes none of the 13 changed lines.',
    );
    expect(read(none, 'execution')).toBe(
      'This test’s coverage includes none of the 13 lines changed since the last passing run.',
    );
  });

  test('says nothing without an answer, or when suspect lines are not available', () => {
    expect(suspectLinesSentence(null, 'cluster')).toBeNull();
    expect(suspectLinesSentence({ ...answer([]), available: false, reason: 'no-coverage' }, 'cluster')).toBeNull();
  });
});

describe('suspect lines in words', () => {
  test('granularities', () => {
    expect(suspectGranularityLabel('lines')).toBe('lines it ran');
    expect(suspectGranularityLabel('functions')).toBe('a function it ran');
    expect(suspectGranularityLabel('files')).toBe('file reached');
  });

  test('line ranges, each kept on one line', () => {
    expect(
      lineRangesText([
        [57, 59],
        [64, 64],
      ]),
    ).toBe('57\u00a0to\u00a059, 64');
  });
});

describe('marking the suspect lines in a diff', () => {
  const PATCH = [
    '@@ -54,8 +54,9 @@ public class BasketService : IBasketService',
    '         {',
    '-            item.SetQuantity(quantity);',
    '+            var newQuantity = item.Quantity + quantity;',
    '+            item.SetQuantity(newQuantity);',
    '         }',
    '@@ -90,2 +91,2 @@',
    '-    return a;',
    '+    return b;',
    '\\ No newline at end of file',
  ].join('\n');

  test('each row gets its head-side line, none for removed rows, headers and notes', () => {
    expect(patchHeadLines(parsePatchLines(PATCH))).toEqual([null, 54, null, 55, 56, 57, null, null, 91, null]);
  });

  test('the marks of a file merge its suspects’ lines, normalized', () => {
    const marks = suspectMarks([
      suspect({ lines: [[60, 61]] }),
      suspect({ lines: [[55, 57]] }),
      suspect({ path: 'src/b.ts', lines: [[1, 1]] }),
    ]);
    expect(marks).toEqual({
      [BASKET]: [
        [55, 57],
        [60, 61],
      ],
      'src/b.ts': [[1, 1]],
    });
  });
});
