import { describe, expect, test } from 'vitest';
import {
  ciActionRefProblem,
  ciBranchMode,
  ciBranchOptions,
  ciDispatchInputsProblem,
  ciDispatchInputValues,
  ciDispatchSourceKind,
  ciRefProblem,
  MAX_CI_BRANCHES,
  offeredCiAction,
  parseCiDispatchRequest,
  parseCiDispatchSource,
} from '#shared/ci-dispatch-request';
import type { CiAction, CiActionTarget } from '#shared/ci-actions';

const github: CiActionTarget = { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' };
const jenkins = (job: string, ref?: string): CiActionTarget => ({
  type: 'ci-server',
  preset: 'jenkins',
  fields: { job, ...(ref ? { ref } : {}) },
});
const custom = (request: Record<string, unknown>): CiActionTarget => ({
  type: 'ci-server',
  preset: 'custom',
  fields: {},
  custom: { auth: 'bearer', request: { method: 'POST', path: 'build', ...request } as never },
});
const action = (target: CiActionTarget, inputs: CiAction['inputs'] = []): CiAction => ({
  id: 'smoke',
  name: 'Smoke',
  target,
  inputs,
  accepts: ['tests'],
});

describe('a dispatch source', () => {
  test('names one place in a body, and the kind follows from it', () => {
    const cases: Array<[unknown, unknown, string]> = [
      [{ clusterId: 3 }, { from: 'cluster', clusterId: 3 }, 'tests'],
      [{ executionId: 4, scope: 'test' }, { from: 'execution', executionId: 4, scope: 'test' }, 'tests'],
      [{ executionId: 4, scope: 'cluster' }, { from: 'execution', executionId: 4, scope: 'cluster' }, 'tests'],
      [{ runId: 5, tests: 'failed' }, { from: 'run-failed', runId: 5 }, 'tests'],
      [{ runId: 5 }, { from: 'run-suite', runId: 5 }, 'suite'],
      [{ testCaseId: 6, flakeLab: 'verify' }, { from: 'flake-lab', testCaseId: 6, flakeLab: 'verify' }, 'flakeLab'],
      [{}, { from: 'project' }, 'suite'],
    ];
    for (const [raw, source, kind] of cases) {
      const parsed = parseCiDispatchSource(raw);
      expect(parsed, JSON.stringify(raw)).toEqual({ ok: true, value: source });
      expect(parsed.ok && ciDispatchSourceKind(parsed.value)).toBe(kind);
    }
  });

  test('reads the ids of a query as a route reads its path', () => {
    expect(parseCiDispatchSource({ executionId: '12', scope: 'test' })).toEqual({
      ok: true,
      value: { from: 'execution', executionId: 12, scope: 'test' },
    });
    for (const id of ['012', '12abc', '0', '-1', '2147483648', ['1', '2']]) {
      expect(parseCiDispatchSource({ clusterId: id }), String(id)).toMatchObject({ ok: false });
    }
    expect(parseCiDispatchSource({ clusterId: 1.5 })).toMatchObject({ ok: false });
  });

  test('refuses a key no shape names, two places, and a shape left incomplete', () => {
    expect(parseCiDispatchSource({ clusterId: 1, runId: 2 })).toMatchObject({ ok: false, message: /not several/ });
    expect(parseCiDispatchSource({ projectId: 1 })).toMatchObject({
      ok: false,
      message: 'source has no key "projectId".',
    });
    expect(parseCiDispatchSource({ clusterId: 1, scope: 'test' })).toMatchObject({
      ok: false,
      message: /beside clusterId/,
    });
    expect(parseCiDispatchSource({ scope: 'test' })).toMatchObject({ ok: false, message: /names no place/ });
    expect(parseCiDispatchSource({ executionId: 1 })).toMatchObject({ ok: false, message: /scope/ });
    expect(parseCiDispatchSource({ runId: 1, tests: 'all' })).toMatchObject({
      ok: false,
      message: /tests must be failed/,
    });
    expect(parseCiDispatchSource({ testCaseId: 1 })).toMatchObject({ ok: false, message: /flakeLab/ });
    expect(parseCiDispatchSource(null)).toMatchObject({ ok: false });
    expect(parseCiDispatchSource([])).toMatchObject({ ok: false });
  });
});

describe('a dispatch request', () => {
  test('carries its action, branch and inputs', () => {
    expect(
      parseCiDispatchRequest({
        source: { clusterId: 1 },
        action: ' Smoke ',
        kind: 'tests',
        ref: 'feature/coupon',
        inputs: { SUITE: 'full' },
      }),
    ).toEqual({
      ok: true,
      value: {
        source: { from: 'cluster', clusterId: 1 },
        action: 'Smoke',
        ref: 'feature/coupon',
        inputs: { SUITE: 'full' },
      },
    });
    expect(parseCiDispatchRequest({ source: {}, action: '', ref: null })).toEqual({
      ok: true,
      value: { source: { from: 'project' }, action: null, ref: null, inputs: null },
    });
    // An empty branch is none, as an empty action is.
    expect(parseCiDispatchRequest({ source: {}, ref: '' })).toMatchObject({ ok: true, value: { ref: null } });
  });

  test('refuses a kind its source does not start', () => {
    expect(parseCiDispatchRequest({ source: { runId: 1 }, kind: 'tests' })).toEqual({
      ok: false,
      message: 'This source starts a suite dispatch, not tests.',
    });
    expect(parseCiDispatchRequest({ source: { clusterId: 1 }, kind: 'everything' })).toMatchObject({
      ok: false,
      message: 'kind must be one of tests, suite, flakeLab.',
    });
    expect(parseCiDispatchRequest({ source: { testCaseId: 1, flakeLab: 'reproduce' }, kind: 'flakeLab' }).ok).toBe(
      true,
    );
  });

  test('refuses a missing source, an unknown key, a bad action, branch or inputs', () => {
    expect(parseCiDispatchRequest({})).toMatchObject({ ok: false, message: /source is required/ });
    expect(parseCiDispatchRequest(null)).toMatchObject({ ok: false });
    expect(parseCiDispatchRequest({ source: {}, branch: 'main' })).toMatchObject({ ok: false, message: /"branch"/ });
    expect(parseCiDispatchRequest({ source: {}, action: 7 })).toMatchObject({ ok: false, message: /action/ });
    expect(parseCiDispatchRequest({ source: {}, action: 'x'.repeat(101) })).toMatchObject({ ok: false });
    expect(parseCiDispatchRequest({ source: {}, ref: 'a..b' })).toMatchObject({ ok: false, message: /"\.\."/ });
    expect(parseCiDispatchRequest({ source: {}, ref: 3 })).toMatchObject({ ok: false, message: /branch name/ });
    expect(parseCiDispatchRequest({ source: {}, inputs: { SUITE: 1 } })).toMatchObject({
      ok: false,
      message: /inputs/,
    });
    expect(parseCiDispatchRequest({ source: {}, inputs: ['full'] })).toMatchObject({ ok: false, message: /inputs/ });
  });
});

describe('a branch name', () => {
  test('passes the names git takes', () => {
    for (const ref of ['main', 'feature/coupon', 'release-1.2', 'v2.0.1', 'ünïcode', 'a/b/c', 'x'.repeat(255), 'a@b']) {
      expect(ciRefProblem(ref), ref).toBeNull();
    }
  });

  test('refuses what `git check-ref-format --branch` refuses', () => {
    const refused = [
      '',
      '@',
      'HEAD',
      '-main',
      'feature x',
      'a\tb',
      'a\u0000b',
      'a\u007fb',
      'a~1',
      'a^1',
      'a:b',
      'a?',
      'a*',
      'a[b',
      'a\\b',
      'a..b',
      'a@{1}',
      '/main',
      'main/',
      'a//b',
      'main.',
      '.hidden',
      'a/.hidden',
      'main.lock',
      'a.lock/b',
      'é'.repeat(128),
    ];
    for (const ref of refused) expect(ciRefProblem(ref), JSON.stringify(ref)).not.toBeNull();
    expect(ciRefProblem('é'.repeat(127))).toBeNull();
  });
});

describe('the branch mode', () => {
  test('lists a repository host’s branches', () => {
    expect(ciBranchMode(github)).toBe('list');
    expect(ciBranchMode({ type: 'gitlab', ref: 'main', argsVariable: 'ARGS' })).toBe('list');
    expect(ciBranchMode({ type: 'bitbucket', pipeline: 'e2e', argsVariable: 'ARGS' })).toBe('list');
  });

  test('takes a typed branch where a CI server request names one, and none where its job runs its own', () => {
    expect(ciBranchMode(jenkins('polaris/e2e'))).toBe('fixed');
    expect(ciBranchMode(jenkins('polaris/e2e/{branch}', 'main'))).toBe('typed');
    expect(ciBranchMode(custom({}))).toBe('fixed');
    expect(ciBranchMode(custom({ path: 'job/{{ branchJob }}/build' }))).toBe('typed');
    expect(ciBranchMode(custom({ query: [['branch', '{{ref}}']] }))).toBe('typed');
    expect(ciBranchMode(custom({ body: { type: 'json', template: '{"ref":"{{ref}}"}' } }))).toBe('typed');
    expect(ciBranchMode(custom({ body: { type: 'form', fields: [['sha', '{{commit}}']] } }))).toBe('fixed');
    // The link a dispatch reads back names no branch the request sends.
    expect(ciBranchMode(custom({ link: { template: 'job/{{ref}}/' } }))).toBe('fixed');
  });

  test('refuses a branch to a fixed job, and one that climbs out of a job path', () => {
    expect(ciActionRefProblem(action(jenkins('e2e')), 'main')).toBe(
      'The CI action "Smoke" runs its job\'s configured branch, so it takes no branch.',
    );
    expect(ciActionRefProblem(action(jenkins('e2e/{branch}')), 'feature/x')).toBeNull();
    expect(ciActionRefProblem(action(jenkins('e2e/{branch}')), '%2e%2e')).toMatch(/climbs out/);
    expect(ciActionRefProblem(action(github), '%2e%2e')).toBeNull();
  });
});

describe('the inputs of a dispatch', () => {
  const staging = action(github, [
    { name: 'TARGET_ENV', kind: 'fixed', value: 'staging' },
    { name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'full' },
    { name: 'BROWSER', kind: 'choice', options: ['chromium', 'firefox'], default: 'chromium' },
  ]);

  test('sets only a choice, to one of its options', () => {
    expect(ciDispatchInputsProblem(staging, null)).toBeNull();
    expect(ciDispatchInputsProblem(staging, { SUITE: 'smoke' })).toBeNull();
    expect(ciDispatchInputsProblem(staging, { TARGET_ENV: 'prod' })).toBe(
      'The input "TARGET_ENV" of "Smoke" is fixed: it cannot be set.',
    );
    expect(ciDispatchInputsProblem(staging, { REGION: 'eu' })).toBe('The CI action "Smoke" has no input "REGION".');
    expect(ciDispatchInputsProblem(staging, { SUITE: 'nightly' })).toBe(
      '"nightly" is not an option of "SUITE": pick one of smoke, full.',
    );
    expect(ciDispatchInputsProblem(staging, { suite: 'smoke' })).toMatch(/no input "suite"/);
    expect(ciDispatchInputsProblem(staging, 'SUITE=smoke')).toMatch(/inputs must be an object/);
  });

  test('take the request’s choices, else those the source run was sent through this action, else the defaults', () => {
    const started = { actionId: 'smoke', inputs: { SUITE: 'smoke', BROWSER: 'firefox', TARGET_ENV: 'prod' } };
    expect(ciDispatchInputValues(staging, null, null)).toEqual({
      TARGET_ENV: 'staging',
      SUITE: 'full',
      BROWSER: 'chromium',
    });
    expect(ciDispatchInputValues(staging, { BROWSER: 'chromium' }, started)).toEqual({
      TARGET_ENV: 'staging',
      SUITE: 'smoke',
      BROWSER: 'chromium',
    });
    // The run was started by another action: its values are not this one's.
    expect(ciDispatchInputValues(staging, null, { ...started, actionId: 'nightly' })).toEqual({
      TARGET_ENV: 'staging',
      SUITE: 'full',
      BROWSER: 'chromium',
    });
  });

  test('are offered with the values a dispatch that sets none sends', () => {
    const offered = offeredCiAction(
      staging,
      { branch: 'feature/coupon', started: { actionId: 'smoke', inputs: { SUITE: 'smoke' } } },
      { available: true, reason: 'ignored' },
    );
    expect(offered).toEqual({
      id: 'smoke',
      name: 'Smoke',
      target: { type: 'github', label: 'GitHub · e2e.yml' },
      environment: null,
      branch: { mode: 'list', default: 'feature/coupon' },
      inputs: [
        { name: 'TARGET_ENV', kind: 'fixed', value: 'staging' },
        { name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'smoke' },
        { name: 'BROWSER', kind: 'choice', options: ['chromium', 'firefox'], default: 'chromium' },
      ],
      available: true,
      reason: null,
    });
  });

  test('offer each target’s branch default: the place’s, else the target’s, none for a fixed job', () => {
    const place = { branch: null, started: null };
    const unavailable = { available: false, reason: 'off' };
    expect(offeredCiAction(action(github), place, unavailable)).toMatchObject({
      branch: { mode: 'list', default: 'main' },
      available: false,
      reason: 'off',
    });
    expect(offeredCiAction(action(jenkins('e2e/{branch}', 'develop')), place, unavailable).branch).toEqual({
      mode: 'typed',
      default: 'develop',
    });
    expect(
      offeredCiAction(action(jenkins('e2e', 'develop')), { branch: 'main', started: null }, unavailable).branch,
    ).toEqual({ mode: 'fixed', default: null });
    expect(
      offeredCiAction(action({ type: 'bitbucket', pipeline: 'e2e', argsVariable: 'A' }), place, unavailable).branch,
    ).toEqual({ mode: 'list', default: null });
  });
});

describe('the branches a dispatch may run on', () => {
  test('lists the run branches first, then the repository’s, each once', () => {
    expect(ciBranchOptions(['feature/b', 'main'], ['main', 'release', 'feature/b', ''])).toEqual([
      { name: 'feature/b', source: 'runs' },
      { name: 'main', source: 'runs' },
      { name: 'release', source: 'repository' },
    ]);
  });

  test('keeps the names that hold the search, ignoring case and accents, at most fifty', () => {
    expect(ciBranchOptions(['Résumé-page', 'main'], ['feature/resume-v2'], ' RESUME ')).toEqual([
      { name: 'Résumé-page', source: 'runs' },
      { name: 'feature/resume-v2', source: 'repository' },
    ]);
    const many = Array.from({ length: 80 }, (_, i) => `b${i}`);
    expect(ciBranchOptions(many, ['zz'])).toHaveLength(MAX_CI_BRANCHES);
  });
});
