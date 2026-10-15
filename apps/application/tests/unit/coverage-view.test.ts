import { describe, expect, test } from 'vitest';
import type { CoverageCapture } from '@piwitests/core/coverage';
import type { SuspectLinesAnswer } from '#shared/suspect-lines';
import {
  coverageFileRoute,
  coverageGroups,
  coverageRowCounts,
  coverageSummary,
  functionNameAt,
  subtractLineRanges,
} from '~/utils/coverage-view';
import { FAILURE_STORIES, sourceText } from '#shared/demo/failure-stories.mjs';
import { getDemoSourceAtBlob } from '~~/app/demo/demo-scm';

/**
 * The execution page's Coverage section in words: its rows and their order,
 * the summary sentence, the marks the suspect lines give, the lines that did
 * not run, the functions' names, and the demo's sources by blob.
 */

const BLOB = 'a'.repeat(40);

const capture: CoverageCapture = {
  v: 1,
  files: [
    {
      path: 'api/Auth/Session.cs',
      runtime: 'server',
      blob: BLOB,
      functions: [[22, 41]],
      lines: [
        [24, 24],
        [27, 30],
      ],
    },
    {
      path: 'api/Users/UsersEndpoints.cs',
      runtime: 'server',
      blob: BLOB,
      functions: [[28, 43]],
      lines: [
        [35, 36],
        [39, 42],
      ],
    },
    {
      path: 'api/Data/AdminDb.cs',
      runtime: 'server',
      blob: BLOB,
      functions: [
        [7, 7],
        [9, 9],
      ],
    },
    { path: 'api/Program.cs', runtime: 'server' },
    { path: 'src/pages/users/index.vue', runtime: 'browser' },
    { path: 'src/components/UsersTable.vue', runtime: 'browser' },
  ],
};

const suspects: SuspectLinesAnswer = {
  available: true,
  summary: {
    changedFiles: 2,
    changedLines: 13,
    hunks: 4,
    executedHunks: 1,
    executedLines: 3,
    failingWithCoverage: 1,
    passingWithCoverage: 2,
  },
  suspects: [
    {
      path: 'api/Users/UsersEndpoints.cs',
      runtime: 'server',
      hunk: [40, 42],
      lines: [[40, 42]],
      granularity: 'lines',
      failing: 1,
      passing: 2,
      score: 0.577,
    },
  ],
  changedPaths: ['api/Users/UsersEndpoints.cs', 'src/components/UsersTable.vue'],
};

describe('coverage rows', () => {
  test('server files by executed lines, most first, then functions; browser files by path', () => {
    const groups = coverageGroups(capture);
    expect(groups.server.map((r) => r.file.path)).toEqual([
      'api/Users/UsersEndpoints.cs',
      'api/Auth/Session.cs',
      'api/Data/AdminDb.cs',
      'api/Program.cs',
    ]);
    expect(groups.browser.map((r) => r.file.path)).toEqual([
      'src/components/UsersTable.vue',
      'src/pages/users/index.vue',
    ]);
    expect(groups.server.map((r) => [r.granularity, r.executedLines, r.functionCount, r.firstLine])).toEqual([
      ['lines', 6, 1, 35],
      ['lines', 5, 1, 24],
      ['functions', 0, 2, 7],
      ['files', 0, 0, null],
    ]);
    expect(groups.server.map(coverageRowCounts)).toEqual([
      '6 lines, 1 function',
      '5 lines, 1 function',
      '2 functions',
      '',
    ]);
  });

  test('the summary counts the server lines, else their functions, and the browser files', () => {
    expect(coverageSummary(coverageGroups(capture))).toBe('Ran 4 server files (11 lines) and 2 browser files.');
    const functionsOnly = { v: 1 as const, files: capture.files.filter((f) => !f.lines) };
    expect(coverageSummary(coverageGroups(functionsOnly))).toBe(
      'Ran 2 server files (2 functions) and 2 browser files.',
    );
    const one = { v: 1 as const, files: [capture.files[0]!] };
    expect(coverageSummary(coverageGroups(one))).toBe('Ran 1 server file (5 lines).');
    const browser = { v: 1 as const, files: [capture.files[4]!] };
    expect(coverageSummary(coverageGroups(browser))).toBe('Ran 1 browser file.');
    expect(coverageSummary(coverageGroups({ v: 1, files: [] }))).toBeNull();
    expect(coverageSummary(coverageGroups(null))).toBeNull();
  });

  test('marks the files the suspect lines name, then the files the range changed', () => {
    const groups = coverageGroups(capture, suspects);
    const marks = Object.fromEntries([...groups.server, ...groups.browser].map((r) => [r.file.path, r.mark]));
    expect(marks['api/Users/UsersEndpoints.cs']).toEqual({ kind: 'suspect', lines: [[40, 42]] });
    expect(marks['src/components/UsersTable.vue']).toEqual({ kind: 'changed' });
    expect(marks['api/Auth/Session.cs']).toBeNull();
    // An unavailable answer marks nothing.
    const none = coverageGroups(capture, { ...suspects, available: false, reason: 'no-scm' });
    expect([...none.server, ...none.browser].every((r) => r.mark === null)).toBe(true);
  });

  test('a file links its coverage view', () => {
    expect(coverageFileRoute(5, 'api/Users/UsersEndpoints.cs')).toEqual({
      path: '/projects/5/coverage',
      query: { file: 'api/Users/UsersEndpoints.cs' },
    });
    expect(coverageFileRoute(5, 'api/Users/UsersEndpoints.cs', 35)).toEqual({
      path: '/projects/5/coverage',
      query: { file: 'api/Users/UsersEndpoints.cs', line: '35' },
    });
    expect(coverageFileRoute(5, 'src/pages/users.vue', null).query).toEqual({ file: 'src/pages/users.vue' });
  });
});

describe('lines that did not run', () => {
  test('are the executable lines no executed range holds', () => {
    expect(
      subtractLineRanges(
        [
          [17, 17],
          [21, 25],
          [35, 42],
          [51, 52],
        ],
        [
          [21, 25],
          [35, 36],
          [39, 42],
        ],
      ),
    ).toEqual([
      [17, 17],
      [37, 38],
      [51, 52],
    ]);
    expect(subtractLineRanges([[1, 10]], [])).toEqual([[1, 10]]);
    expect(subtractLineRanges([[1, 10]], [[1, 10]])).toEqual([]);
    expect(
      subtractLineRanges(
        [[1, 10]],
        [
          [0, 3],
          [5, 5],
          [9, 12],
        ],
      ),
    ).toEqual([
      [4, 4],
      [6, 8],
    ]);
  });
});

describe('function names', () => {
  test('read from a function’s first line, in C# and in TypeScript', () => {
    expect(functionNameAt('    public static async Task<Ok<UserPage>> ListUsers(')).toBe('ListUsers');
    expect(functionNameAt('    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()')).toBe(
      'HandleAuthenticateAsync',
    );
    expect(functionNameAt('    public DbSet<User> Users => Set<User>();')).toBe('Users');
    expect(functionNameAt('    public int Count { get; set; }')).toBe('Count');
    expect(functionNameAt('    public T Find<T>(int id)')).toBe('Find');
    expect(functionNameAt('export async function listUsers(page = 1) {')).toBe('listUsers');
    expect(functionNameAt('const pay = async (card) => {')).toBe('pay');
    expect(functionNameAt('  async open() {')).toBe('open');
    expect(functionNameAt('  if (role) {')).toBeNull();
    expect(functionNameAt('{')).toBeNull();
    expect(functionNameAt(null)).toBeNull();
  });
});

describe('the demo serves each covered file by its blob', () => {
  const story = FAILURE_STORIES.find((s) => s.key === 'users-table-page-size')!;

  test('the source of every server file the users story’s run covered, at its blob', async () => {
    expect(story.runCoverage?.length).toBeGreaterThan(1);
    for (const file of story.runCoverage!) {
      const source = await getDemoSourceAtBlob(story.projectId, file.path, file.blob);
      expect(source, file.path).toEqual({ path: file.path, blob: file.blob, content: sourceText(file.path) });
    }
  });

  test('no other version, and no other project’s file', async () => {
    const file = story.runCoverage![0]!;
    expect(await getDemoSourceAtBlob(story.projectId, file.path, 'f'.repeat(40))).toBeNull();
    expect(await getDemoSourceAtBlob(3, file.path, file.blob)).toBeNull();
  });
});
