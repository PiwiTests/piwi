/**
 * Compare with team instance, read on the desktop app: the team history in one row per CI environment, the local
 * run's first, the teammates' runs last; and the conclusion of a failing local execution, each rule in its order, the
 * local environment read as the team instance resolved it.
 */
import { describe, expect, test } from 'vitest';
import {
  SAME_ERROR_WITHIN_MS,
  sameCommit,
  teamConclusion,
  teamHistoryRows,
  type LocalExecutionFacts,
} from '#shared/test-comparison-conclusion';
import type { TestComparison, TestComparisonCluster, TestComparisonResult } from '#shared/test-comparison';

const COMMIT = 'c0ffee0000000000000000000000000000000001';
const NOW = Date.parse('2026-11-25T08:00:00Z');
let nextId = 0;

function result(values: Partial<TestComparisonResult> = {}): TestComparisonResult {
  const id = ++nextId;
  return {
    executionId: id,
    runId: id,
    source: 'ci',
    status: 'passed',
    flaky: false,
    incident: false,
    startTime: NOW - id * 1000,
    environment: null,
    branch: 'main',
    commit: null,
    playwrightProject: 'chromium',
    path: `/test-run-cases/${id}`,
    ...values,
  };
}

function comparison(values: Partial<TestComparison> = {}): TestComparison {
  return {
    testCase: null,
    defaultBranch: 'main',
    localEnvironment: null,
    playwrightProjectMatched: true,
    history: [],
    fingerprintComparable: true,
    cluster: null,
    closestPass: null,
    ...values,
  };
}

const cluster = (values: Partial<TestComparisonCluster> = {}): TestComparisonCluster => ({
  id: 4,
  title: null,
  status: 'open',
  ciOccurrences: 12,
  ciFirstSeen: NOW - 5 * 86_400_000,
  ciLastSeen: NOW - 86_400_000,
  ciTests: 3,
  ciEnvironments: ['mco'],
  path: '/failure-clusters/4',
  ...values,
});

const local = (values: Partial<LocalExecutionFacts> = {}): LocalExecutionFacts => ({
  status: 'failed',
  environment: null,
  commit: COMMIT,
  worktree: 'clean',
  fingerprinted: true,
  now: NOW,
  ...values,
});

describe('teamHistoryRows', () => {
  test('one row per CI environment, the local run’s first, no environment last, the teammates’ runs apart', () => {
    const rows = teamHistoryRows(
      comparison({
        localEnvironment: 'integration',
        history: [
          result({ environment: 'mco', status: 'failed' }),
          result({ environment: 'integration' }),
          result({ source: 'local' }),
          result({ environment: null }),
          result({ environment: 'MCO', flaky: true }),
          result({ environment: 'integration', status: 'skipped' }),
        ],
      }),
      'int',
    );
    expect(rows.map((row) => [row.source, row.environment, row.isLocalEnvironment, row.results.length])).toEqual([
      ['ci', 'integration', true, 2],
      ['ci', 'mco', false, 2],
      ['ci', null, false, 1],
      ['local', null, false, 1],
    ]);
  });
});

describe('teamConclusion', () => {
  test('says nothing of a local execution that did not fail', () => {
    expect(teamConclusion(comparison(), local({ status: 'passed' }))).toBeNull();
  });

  test('1. the same error seen recently in CI comes first, in the local run’s environment', () => {
    const history = [result({ commit: COMMIT, environment: 'mco' })];
    expect(teamConclusion(comparison({ cluster: cluster(), history }), local())).toMatchObject({
      rule: 'same-error-in-ci',
      text: 'Same error in CI, seen 12 times: not specific to this machine',
    });
    expect(
      teamConclusion(
        comparison({ cluster: cluster(), localEnvironment: 'mco', history }),
        local({ environment: 'MCO' }),
      ),
    ).toMatchObject({
      rule: 'same-error-in-ci',
      text: 'Same error in CI (mco), seen 12 times: not specific to this machine',
    });
    // Seen in another environment, long ago, or never in CI: the other rules read on.
    const elsewhere = comparison({ cluster: cluster(), localEnvironment: 'integration', history });
    expect(teamConclusion(elsewhere, local({ environment: 'integration' }))?.rule).toBe('no-ci-result');
    const old = comparison({ cluster: cluster({ ciLastSeen: NOW - SAME_ERROR_WITHIN_MS - 1 }), history });
    expect(teamConclusion(old, local())?.rule).toBe('passes-on-commit');
    expect(teamConclusion(comparison({ cluster: cluster({ ciOccurrences: 0 }) }), local())?.rule).toBe('no-ci-result');
  });

  test('2. the latest CI result on the local commit passed, said apart for a checkout with uncommitted changes', () => {
    const pass = result({ commit: COMMIT.slice(0, 12) });
    const history = [result({ status: 'failed' }), pass];
    expect(teamConclusion(comparison({ history }), local())).toMatchObject({ rule: 'passes-on-commit', result: pass });
    expect(teamConclusion(comparison({ history }), local({ worktree: 'dirty' }))?.rule).toBe('passes-on-commit-dirty');
  });

  test('3. a newer CI failure on the local commit outweighs an older pass there', () => {
    const failure = result({ commit: COMMIT, status: 'failed' });
    const history = [failure, result({ commit: COMMIT })];
    expect(teamConclusion(comparison({ history }), local())).toMatchObject({
      rule: 'fails-in-ci-too',
      text: 'Fails in CI too on this commit, with another error',
      result: failure,
    });
  });

  test('3. the latest CI result failed: another error only when the fingerprint was compared', () => {
    const history = [result({ status: 'timedOut' }), result()];
    expect(teamConclusion(comparison({ history }), local())?.text).toBe('Fails in CI too, with another error');
    expect(teamConclusion(comparison({ history }), local({ fingerprinted: false }))?.text).toBe('Fails in CI too');
    expect(teamConclusion(comparison({ history, fingerprintComparable: false }), local())?.text).toBe(
      'Fails in CI too',
    );
  });

  test('4. the latest CI result passed on another commit, or one that cannot be compared', () => {
    const history = [result({ status: 'skipped' }), result({ commit: 'abcdef1234567' })];
    expect(teamConclusion(comparison({ history }), local())).toMatchObject({
      rule: 'passes-on-other-commit',
      text: 'Passes in CI on main, on another commit: the commits differ',
    });
    expect(teamConclusion(comparison({ history }), local({ commit: null }))?.text).toBe(
      'Passes in CI on main, but the commits cannot be compared',
    );
  });

  test('a run marked as an environment incident never counts', () => {
    const history = [result({ status: 'failed', incident: true }), result({ commit: 'abcdef1234567' })];
    expect(teamConclusion(comparison({ history }), local())?.rule).toBe('passes-on-other-commit');
  });

  test('5. no CI result; the teammates’ runs never count', () => {
    expect(teamConclusion(comparison({ history: [result({ source: 'local' })] }), local())?.rule).toBe('no-ci-result');
  });

  test('reads the local run’s environment as the team instance resolved its label', () => {
    const history = [result({ environment: 'mco', status: 'failed' }), result({ environment: 'stg', commit: COMMIT })];
    expect(
      teamConclusion(comparison({ history, localEnvironment: 'stg' }), local({ environment: 'staging' })),
    ).toMatchObject({
      rule: 'passes-on-commit',
      environment: 'stg',
      text: 'Passes in CI on this commit (stg): the failure is likely specific to this machine',
    });
    expect(teamConclusion(comparison({ history, localEnvironment: 'mco' }), local({ environment: 'mco' }))?.rule).toBe(
      'fails-in-ci-too',
    );
    expect(
      teamConclusion(comparison({ history, localEnvironment: 'recette' }), local({ environment: 'recette' }))?.text,
    ).toBe('No CI result in recette to compare with');
  });
});

describe('sameCommit', () => {
  test('a short and a full SHA match, from seven characters', () => {
    expect(sameCommit(COMMIT, COMMIT.slice(0, 7))).toBe(true);
    expect(sameCommit(COMMIT.slice(0, 6), COMMIT)).toBe(false);
    expect(sameCommit(COMMIT, 'c0ffee1')).toBe(false);
    expect(sameCommit(null, COMMIT)).toBe(false);
  });
});
