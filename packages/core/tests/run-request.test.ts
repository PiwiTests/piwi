import { describe, expect, test } from 'vitest';
import { parseRunOriginRef } from '../src/wire';
import {
  RUN_REQUEST_LIMITS,
  isRelativeSpecPath,
  isRunRequestBranch,
  isRunRequestCommit,
  parseRunRequest,
  parseRunRequestOptions,
  parseRunRequestTest,
  specFileArgument,
  specFilePattern,
} from '../src/run-request';

const ID = '0123456789abcdef0123456789abcdef';

const request = {
  id: ID,
  kind: 'run',
  projectId: 7,
  tests: [{ filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' }],
  options: { headed: true, trace: 'retain-on-failure', repeatEach: 3, workers: 2, project: 'chromium' },
  source: { runId: 4213, executionId: 99, branch: 'main', commit: '9f8e7d6' },
};

function problemsOf(value: unknown): string[] {
  const parsed = parseRunRequest(value);
  return parsed.ok ? [] : parsed.problems;
}

describe('parseRunRequest', () => {
  test('reads a whole request', () => {
    const parsed = parseRunRequest(request);
    expect(parsed).toEqual({ ok: true, value: request });
  });

  test('fills the defaults: headed on, no source, a null line and project', () => {
    const parsed = parseRunRequest({
      id: ID,
      kind: 'run',
      projectId: 7,
      tests: [{ filePath: 'a.spec.ts', title: 'a' }],
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        id: ID,
        kind: 'run',
        projectId: 7,
        tests: [{ filePath: 'a.spec.ts', title: 'a', line: null, projectName: null }],
        options: { headed: true },
        source: {},
      },
    });
  });

  test('an id is a valid run ref', () => {
    expect(parseRunOriginRef(ID)).toBe(ID);
  });

  test('refuses an unknown field at every level', () => {
    expect(problemsOf({ ...request, command: 'rm -rf /' })).toEqual(['command is not a field of a run request.']);
    expect(problemsOf({ ...request, options: { ...request.options, grep: 'x' } })).toEqual([
      'options.grep is not a field of a run request.',
    ]);
    expect(problemsOf({ ...request, tests: [{ ...request.tests[0], env: { A: '1' } }] })).toEqual([
      'tests[0].env is not a field of a run request.',
    ]);
    expect(problemsOf({ ...request, source: { url: 'https://example.com' } })).toEqual([
      'source.url is not a field of a run request.',
    ]);
  });

  test('refuses a kind this version does not know', () => {
    expect(problemsOf({ ...request, kind: 'debug' })).toEqual([
      'kind "debug" is not a kind this version knows: update to run it.',
    ]);
  });

  test.each([
    '-x.spec.ts',
    '/etc/passwd',
    '\\\\server\\share\\a.spec.ts',
    'C:\\tests\\a.spec.ts',
    'c:/tests/a.spec.ts',
    '../outside.spec.ts',
    'tests/../../outside.spec.ts',
    'tests\\..\\a.spec.ts',
    'a\0.spec.ts',
    '',
    '.',
    './a.spec.ts',
    'tests//a.spec.ts',
    'tests/',
    ' a.spec.ts',
    'a.spec.ts ',
    'tests/ a/b.spec.ts',
    '.*',
    'a|b',
    'tests/*.spec.ts',
    'a?.spec.ts',
    'a.spec.ts\nrm -rf ~',
    'a\t.spec.ts',
    'a\u001b[2J.spec.ts',
    'a\u0085.spec.ts',
    'a\u2028.spec.ts',
    'a\u202e.spec.ts',
    'a\u200b.spec.ts',
    'a\u034f.spec.ts',
    'a\u3164.spec.ts',
    'a\ufe0f.spec.ts',
    'a\u{e0100}.spec.ts',
    'a&calc.spec.ts',
    '%PATH%.spec.ts',
    '$(touch x).spec.ts',
    '`id`.spec.ts',
    'a"b.spec.ts',
    'a<b.spec.ts',
    'a^b.spec.ts',
    'a!b.spec.ts',
    'a.spec.ts:12',
  ])('refuses the spec path %j', (filePath) => {
    expect(isRelativeSpecPath(filePath)).toBe(false);
    expect(problemsOf({ ...request, tests: [{ ...request.tests[0], filePath }] })).toEqual([
      'tests[0].filePath must be a spec path relative to the Playwright config.',
    ]);
  });

  test('accepts the usual project names and branches', () => {
    expect(parseRunRequestOptions({ project: 'Mobile Safari' }).ok).toBe(true);
    expect(parseRunRequestOptions({ project: 'e2e/setup-db' }).ok).toBe(true);
    expect(parseRunRequest({ ...request, source: { branch: 'feature/pay-v2' } }).ok).toBe(true);
  });

  test('accepts a spec path inside the folder', () => {
    expect(isRelativeSpecPath('tests/checkout/pay.spec.ts')).toBe(true);
    expect(isRelativeSpecPath('a..b.spec.ts')).toBe(true);
    expect(isRelativeSpecPath('app/(auth)/[locale]/sign in.spec.ts')).toBe(true);
    expect(isRelativeSpecPath('tests/a+b.spec.ts')).toBe(true);
  });

  test('accepts the project names Playwright users write', () => {
    for (const project of ['Pixel 5 (mobile)', 'Édge', 'Mobile Chrome', 'setup:db', 'Desktop 日本語']) {
      expect(parseRunRequestOptions({ project }).ok, project).toBe(true);
    }
    for (const project of ['(mobile)', 'chrom*', 'a\u202eb', '-x', 'Chrome\u180b', 'a\u115fb']) {
      expect(parseRunRequestOptions({ project }).ok, project).toBe(false);
    }
  });

  test.each(['main', 'feature/pay-v2', 'release/1.2', 'user@host-fix', 'v1.0'])('accepts the branch %j', (branch) => {
    expect(isRunRequestBranch(branch)).toBe(true);
  });

  test.each([
    '',
    '@',
    '-x',
    '/main',
    'main/',
    'feature//x',
    'a..b',
    'x.lock',
    'feature/x.lock/y',
    '.hidden',
    'feature/.x',
    'main.',
    'a b',
    'a~1',
    'a^2',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a@{1}',
    '" & calc.exe & "',
    '$(touch x);`id`',
    'main\u202e',
    'main\u2028x',
    'main\u0085',
    'x'.repeat(256),
  ])('refuses the branch %j', (branch) => {
    expect(isRunRequestBranch(branch)).toBe(false);
    expect(problemsOf({ ...request, source: { branch } })).toEqual(['source.branch must be a branch name.']);
  });

  test('takes a SHA-1 or SHA-256 commit', () => {
    expect(isRunRequestCommit('9f8e7d6')).toBe(true);
    expect(isRunRequestCommit('a'.repeat(40))).toBe(true);
    expect(isRunRequestCommit('a'.repeat(64))).toBe(true);
    expect(isRunRequestCommit('a'.repeat(65))).toBe(false);
    expect(isRunRequestCommit('9f8e7d')).toBe(false);
  });

  test('refuses an array with holes, as every caller reads it', () => {
    // oxlint-disable-next-line unicorn/no-new-array
    expect(problemsOf({ ...request, tests: new Array(3) })).toEqual([
      'tests[0] must be an object.',
      'tests[1] must be an object.',
      'tests[2] must be an object.',
    ]);
    // oxlint-disable-next-line no-sparse-arrays
    expect(problemsOf({ ...request, tests: [, request.tests[0]] })).toEqual(['tests[0] must be an object.']);
  });

  test('keeps the shell syntax of a title, which never reaches a command line', () => {
    expect(parseRunRequest({ ...request, tests: [{ ...request.tests[0], title: 'shows "Saved" & $5 off!' }] }).ok).toBe(
      true,
    );
  });

  test('refuses fewer than 1 or more than 200 tests', () => {
    const one = request.tests[0];
    expect(problemsOf({ ...request, tests: [] })).toEqual(['tests must list 1 to 200 tests.']);
    expect(
      problemsOf({ ...request, tests: Array.from({ length: RUN_REQUEST_LIMITS.tests.max + 1 }, () => one) }),
    ).toEqual(['tests must list 1 to 200 tests.']);
    expect(parseRunRequest({ ...request, tests: Array.from({ length: 200 }, () => one) }).ok).toBe(true);
  });

  test.each([
    [{ repeatEach: 0 }, 'options.repeatEach must be a whole number from 1 to 10.'],
    [{ repeatEach: 11 }, 'options.repeatEach must be a whole number from 1 to 10.'],
    [{ repeatEach: 2.5 }, 'options.repeatEach must be a whole number from 1 to 10.'],
    [{ workers: 5 }, 'options.workers must be a whole number from 1 to 4.'],
    [{ workers: '2' }, 'options.workers must be a whole number from 1 to 4.'],
    [{ trace: 'off' }, "options.trace must be 'on' or 'retain-on-failure'."],
    [{ headed: 'yes' }, 'options.headed must be true or false.'],
    [{ project: 'chromium; rm -rf /' }, 'options.project is not a Playwright project name.'],
    [{ project: '--headed' }, 'options.project is not a Playwright project name.'],
    [{ project: ' chromium' }, 'options.project is not a Playwright project name.'],
  ])('refuses the option %j', (option, problem) => {
    expect(problemsOf({ ...request, options: { ...request.options, ...option } })).toEqual([problem]);
  });

  test.each<[Record<string, unknown>, string]>([
    [{ id: 'ABCDEF0123456789abcdef0123456789' }, 'id must be 32 lowercase hex digits.'],
    [{ id: 'short' }, 'id must be 32 lowercase hex digits.'],
    [{ projectId: 0 }, 'projectId must be a project id.'],
    [{ projectId: 2_147_483_648 }, 'projectId must be a project id.'],
    [{ source: { commit: 'not-a-sha' } }, 'source.commit must be a commit SHA.'],
    [{ source: { runId: -1 } }, 'source.runId must be a run id.'],
    [{ source: { branch: '--upload-pack=touch x' } }, 'source.branch must be a branch name.'],
    [{ source: { branch: 'main\nfeature' } }, 'source.branch must be a branch name.'],
    ...['pays\u001b[2J', 'pays\nwith a card', 'pays\u0085', 'pays\u2028', 'pays \u202ewith', 'pays\u2066'].map(
      (title): [Record<string, unknown>, string] => [
        { tests: [{ ...request.tests[0], title }] },
        'tests[0].title must be at most 500 characters, with no control or invisible character.',
      ],
    ),
  ])('refuses %j', (patch, problem) => {
    expect(problemsOf({ ...request, ...patch })).toEqual([problem]);
  });

  test('names every problem at once', () => {
    expect(problemsOf({ ...request, kind: 'x', projectId: 'a', options: { workers: 9 } })).toHaveLength(3);
  });

  test('refuses a value that is not an object', () => {
    expect(problemsOf(null)).toEqual(['A run request must be an object.']);
    expect(problemsOf([request])).toEqual(['A run request must be an object.']);
  });
});

describe('parseRunRequestOptions', () => {
  test('defaults to headed', () => {
    expect(parseRunRequestOptions(undefined)).toEqual({ ok: true, value: { headed: true } });
    expect(parseRunRequestOptions({ headed: false, workers: 4 })).toEqual({
      ok: true,
      value: { headed: false, workers: 4 },
    });
  });

  test('refuses an unknown option', () => {
    expect(parseRunRequestOptions({ timeout: 1 })).toEqual({
      ok: false,
      problems: ['options.timeout is not a field of a run request.'],
    });
  });
});

describe('parseRunRequestTest', () => {
  test('reads one test, or names what is wrong with it', () => {
    expect(parseRunRequestTest({ filePath: 'a.spec.ts', title: 'a', line: 3, projectName: null })).toEqual({
      ok: true,
      value: { filePath: 'a.spec.ts', title: 'a', line: 3, projectName: null },
    });
    expect(parseRunRequestTest({ filePath: '.*', title: 'a' })).toEqual({
      ok: false,
      problems: ['test.filePath must be a spec path relative to the Playwright config.'],
    });
  });
});

describe('specFileArgument', () => {
  /** What Playwright 1.64 does with a file argument: `parseLocationArg`, then `forceRegExp` on the file part. */
  function playwrightReads(arg: string): { re: RegExp; line: number | null } {
    const location = /^(.*?):(\d+):?(\d+)?$/.exec(arg);
    const file = location ? location[1]! : arg;
    const literal = /^\/(.*)\/([gi]*)$/.exec(file);
    return {
      re: literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(file, 'gi'),
      line: location ? Number(location[2]) : null,
    };
  }

  test('matches the one spec file, at its line', () => {
    const arg = specFileArgument('/home/me/shop/tests/a.spec.ts', 12);
    expect(arg).toBe('/^\\/home\\/me\\/shop\\/tests\\/a\\.spec\\.ts$/:12');
    const { re, line } = playwrightReads(arg);
    expect(line).toBe(12);
    expect(re.test('/home/me/shop/tests/a.spec.ts')).toBe(true);
    for (const other of [
      '/home/me/shop/other-tests/a.spec.ts',
      '/home/me/shop/tests/a.spec.tsx',
      '/x/home/me/shop/tests/a.spec.ts',
    ]) {
      expect(re.test(other), other).toBe(false);
    }
  });

  test('escapes what a regular expression reads, and writes Windows separators as /', () => {
    const { re, line } = playwrightReads(specFileArgument('C:\\shop\\app\\(auth)\\[id]+x.spec.ts', 3));
    expect(line).toBe(3);
    expect(re.test('C:/shop/app/(auth)/[id]+x.spec.ts')).toBe(true);
    expect(re.test('C:/shop/app/auth/i+x.spec.ts')).toBe(false);
  });

  test('without a line, matches every test of the one spec file', () => {
    const { re, line } = playwrightReads(specFilePattern('/home/me/shop/tests/a.spec.ts'));
    expect(line).toBe(null);
    expect(re.test('/home/me/shop/tests/a.spec.ts')).toBe(true);
    expect(re.test('/home/me/shop/tests/a.spec.tsx')).toBe(false);
  });

  test('refuses a line that is not a line number', () => {
    expect(() => specFileArgument('/home/me/a.spec.ts', 0)).toThrow(RangeError);
    expect(() => specFileArgument('/home/me/a.spec.ts', 1.5)).toThrow(RangeError);
  });
});
