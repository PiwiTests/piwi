import { describe, expect, test } from 'vitest';
import { nearestTest } from '#shared/coverage-insights';
import {
  fileCoverageSentence,
  fileCoverageVersions,
  fileVersionLabel,
  lineSelectionQuery,
  lineTestCounts,
  linesText,
  nearestTestSentence,
  parseLineSelection,
  testsOnLines,
  type FileCoverageInput,
} from '~/utils/file-coverage';

/**
 * A file's coverage page in numbers and words: the versions the tests
 * recorded and their order, how many tests ran each line, the tests of a
 * selected range, the lines no test runs, the sentences, and `?line=`.
 */

const A = 'a1b2c3d'.padEnd(40, '0');
const B = '9f8e7d6'.padEnd(40, '0');
const PATH = 'api/Users/UsersEndpoints.cs';

const tests = [
  { id: 1, title: 'lists users', file: 'tests/users.spec.ts', suite: [], status: 'passed' as const },
  { id: 2, title: 'pages users', file: 'tests/users.spec.ts', suite: [], status: 'failed' as const },
  { id: 3, title: 'filters users', file: 'tests/users.spec.ts', suite: [], status: 'flaky' as const },
  { id: 4, title: 'invites a user', file: 'tests/invite.spec.ts', suite: [], status: null },
];

const view: FileCoverageInput & { tests: typeof tests } = {
  fragments: [
    {
      path: PATH,
      runtime: 'server',
      blob: A,
      functions: [[8, 20]],
      lines: [
        [10, 12],
        [15, 15],
      ],
      tests: [0, 1],
    },
    { path: PATH, runtime: 'server', blob: A, functions: [[8, 20]], lines: [[10, 11]], tests: [2] },
    { path: PATH, runtime: 'server', blob: B, functions: [[8, 22]], lines: [[30, 31]], tests: [3] },
  ],
  executable: [{ path: PATH, runtime: 'server', blob: A, lines: [[10, 18]] }],
  tests,
};

describe('the versions of a file', () => {
  test('one per blob, the one the most tests recorded first, with its tests, lines and functions', () => {
    const [first, second] = fileCoverageVersions(view);
    expect(first).toMatchObject({
      path: PATH,
      runtime: 'server',
      blob: A,
      granularity: 'lines',
      tests: [0, 1, 2],
      executed: [
        [10, 12],
        [15, 15],
      ],
      functions: [[8, 20]],
      executable: [[10, 18]],
      notExecuted: [
        [13, 14],
        [16, 18],
      ],
    });
    expect(second).toMatchObject({ blob: B, tests: [3], executable: null, notExecuted: null });
    expect(fileVersionLabel(first!)).toBe('a1b2c3d · 3 tests');
    expect(fileVersionLabel(second!, true)).toBe(`${PATH} · 9f8e7d6 · 1 test`);
  });

  test('coverage that names no lines is a version of its own, by file', () => {
    const [version] = fileCoverageVersions({
      fragments: [{ path: 'src/pages/users.vue', runtime: 'browser', tests: [0, 1] }],
      executable: [],
    });
    expect(version).toMatchObject({ blob: null, granularity: 'files', executed: [], notExecuted: null });
    expect(fileVersionLabel(version!)).toBe('by file · 2 tests');
    expect(fileCoverageSentence(version!, 'main')).toBe('2 tests run code of this file on main, by file only.');
  });

  test('a file recorded by function counts the tests on the lines of the functions that ran', () => {
    const [version] = fileCoverageVersions({
      fragments: [
        { path: PATH, runtime: 'server', blob: A, functions: [[3, 5]], tests: [0] },
        {
          path: PATH,
          runtime: 'server',
          blob: A,
          functions: [
            [3, 5],
            [9, 9],
          ],
          tests: [1, 2],
        },
      ],
      executable: [],
    });
    expect(version!.granularity).toBe('functions');
    expect(version!.functions).toEqual([
      [3, 5],
      [9, 9],
    ]);
    expect([...lineTestCounts(version!)]).toEqual([
      [3, 3],
      [4, 3],
      [5, 3],
      [9, 2],
    ]);
    expect(fileCoverageSentence(version!, 'main')).toBe('3 tests run 2 functions of this file on main.');
  });
});

describe('the tests of each line', () => {
  const [version] = fileCoverageVersions(view);

  test('how many tests ran each line', () => {
    const counts = lineTestCounts(version!);
    expect(counts.get(10)).toBe(3);
    expect(counts.get(12)).toBe(2);
    expect(counts.get(15)).toBe(2);
    expect(counts.has(13)).toBe(false);
  });

  test('the tests that ran a line, or at least one line of a range', () => {
    expect(testsOnLines(version!, [12, 12])).toEqual([0, 1]);
    expect(testsOnLines(version!, [11, 11])).toEqual([0, 1, 2]);
    expect(testsOnLines(version!, [13, 14])).toEqual([]);
    expect(testsOnLines(version!, [14, 15])).toEqual([0, 1]);
  });

  test('the sentence counts the executable lines the tests run', () => {
    expect(fileCoverageSentence(version!, 'main')).toBe('3 tests run 4 of its 9 executable lines on main.');
    const [, other] = fileCoverageVersions(view);
    expect(fileCoverageSentence(other!, 'main')).toBe('1 test runs 2 lines of this file on main.');
  });

  test('the nearest test to copy for a line no test runs, in words', () => {
    const nearest = nearestTest(view, [[13, 13]], { blob: A });
    expect(nearest).toMatchObject({ testCaseId: 1, function: [8, 20], executedLines: 4, sameVersion: true });
    expect(nearestTestSentence(nearest!, [13, 13], 'ListUsers')).toBe(
      'It runs 4 lines of ListUsers, the function around line 13.',
    );
    expect(nearestTestSentence(nearest!, [13, 14], null)).toBe(
      'It runs 4 lines of the function around lines 13 to 14 (lines 8 to 20).',
    );
  });
});

describe('the selected lines in the address', () => {
  test('a line or a range, either way round', () => {
    expect(parseLineSelection('40')).toEqual([40, 40]);
    expect(parseLineSelection('42-40')).toEqual([40, 42]);
    expect(parseLineSelection(' 7 ')).toEqual([7, 7]);
    expect(parseLineSelection('0')).toBeNull();
    expect(parseLineSelection('x')).toBeNull();
    expect(parseLineSelection(['40'])).toBeNull();
    expect(lineSelectionQuery([40, 40])).toBe('40');
    expect(lineSelectionQuery([40, 42])).toBe('40-42');
    expect(linesText([3, 3])).toBe('line 3');
    expect(linesText([3, 5])).toBe('lines 3 to 5');
  });
});
