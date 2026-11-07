import { describe, expect, test } from 'vitest';
import { parseRunOriginRef } from '../src/wire';
import { RUN_REQUEST_LIMITS, isRelativeSpecPath, parseRunRequest, parseRunRequestOptions } from '../src/run-request';

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
  ])('refuses the spec path %j', (filePath) => {
    expect(isRelativeSpecPath(filePath)).toBe(false);
    expect(problemsOf({ ...request, tests: [{ ...request.tests[0], filePath }] })).toEqual([
      'tests[0].filePath must be a spec path relative to the Playwright config.',
    ]);
  });

  test('accepts a spec path inside the folder', () => {
    expect(isRelativeSpecPath('tests/checkout/pay.spec.ts')).toBe(true);
    expect(isRelativeSpecPath('a..b.spec.ts')).toBe(true);
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
  ])('refuses the option %j', (option, problem) => {
    expect(problemsOf({ ...request, options: { ...request.options, ...option } })).toEqual([problem]);
  });

  test.each([
    [{ id: 'ABCDEF0123456789abcdef0123456789' }, 'id must be 32 lowercase hex digits.'],
    [{ id: 'short' }, 'id must be 32 lowercase hex digits.'],
    [{ projectId: 0 }, 'projectId must be a project id.'],
    [{ projectId: 2_147_483_648 }, 'projectId must be a project id.'],
    [{ source: { commit: 'not-a-sha' } }, 'source.commit must be a commit SHA.'],
    [{ source: { runId: -1 } }, 'source.runId must be a run id.'],
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
