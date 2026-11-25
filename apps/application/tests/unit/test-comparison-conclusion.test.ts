/**
 * Compare with team instance, read on the desktop app: the team history in one row per CI environment, the local
 * run's first, the teammates' runs last; and the conclusion of a failing local execution, each rule in its order.
 */
import { describe, expect, test } from 'vitest';
import {
  sameCommit,
  teamConclusion,
  teamHistoryRows,
  type LocalExecutionFacts,
} from '#shared/test-comparison-conclusion';
import type { TestComparison, TestComparisonResult } from '#shared/test-comparison';

const COMMIT = 'c0ffee0000000000000000000000000000000001';
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
    startTime: 1_000_000 - id,
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
    playwrightProjectMatched: true,
    history: [],
    fingerprintComparable: true,
    cluster: null,
    closestPass: null,
    ...values,
  };
}

const local = (values: Partial<LocalExecutionFacts> = {}): LocalExecutionFacts => ({
  status: 'failed',
  environment: null,
  commit: COMMIT,
  worktree: 'clean',
  fingerprinted: true,
  ...values,
});

describe('teamHistoryRows', () => {
  test('one row per CI environment, the local run’s first, no environment last, the teammates’ runs apart', () => {
    const rows = teamHistoryRows(
      [
        result({ environment: 'mco', status: 'failed' }),
        result({ environment: 'integration' }),
        result({ source: 'local' }),
        result({ environment: null }),
        result({ environment: 'MCO', flaky: true }),
        result({ environment: 'integration', status: 'skipped' }),
      ],
      'integration',
    );
    expect(rows.map((row) => [row.source, row.environment, row.isLocalEnvironment, row.results.length])).toEqual([
      ['ci', 'integration', true, 2],
      ['ci', 'mco', false, 2],
      ['ci', null, false, 1],
      ['local', null, false, 1],
    ]);
    expect(rows[0]).toMatchObject({ passRate: 1, flakyRate: 0 });
    expect(rows[1]).toMatchObject({ passRate: 0.5, flakyRate: 0.5 });
  });

  test('an environment row with no passed or failed result has no rate', () => {
    expect(teamHistoryRows([result({ status: 'skipped' })], null)[0]).toMatchObject({
      passRate: null,
      flakyRate: null,
    });
  });
});

describe('teamConclusion', () => {
  test('says nothing of a local execution that did not fail', () => {
    expect(teamConclusion(comparison(), local({ status: 'passed' }))).toBeNull();
  });

  test('1. the same error in CI comes first', () => {
    const cluster = {
      id: 4,
      title: null,
      status: 'open',
      ciOccurrences: 12,
      ciFirstSeen: 1,
      ciLastSeen: 2,
      ciTests: 3,
      path: '/failure-clusters/4',
    };
    const answer = teamConclusion(comparison({ cluster, history: [result({ commit: COMMIT })] }), local());
    expect(answer).toMatchObject({
      rule: 'same-error-in-ci',
      text: 'Same error in CI, seen 12 times: not specific to this machine',
    });
    expect(teamConclusion(comparison({ cluster: { ...cluster, ciOccurrences: 0 } }), local())?.rule).toBe(
      'no-ci-result',
    );
  });

  test('2. a CI pass on the local commit, said apart for a checkout with uncommitted changes', () => {
    const pass = result({ commit: COMMIT.slice(0, 12) });
    const history = [result({ status: 'failed' }), pass];
    expect(teamConclusion(comparison({ history }), local())).toMatchObject({ rule: 'passes-on-commit', result: pass });
    expect(teamConclusion(comparison({ history }), local({ worktree: 'dirty' }))?.rule).toBe('passes-on-commit-dirty');
  });

  test('3. the latest CI result failed: another error only when the fingerprint was compared', () => {
    const history = [result({ status: 'timedOut' }), result()];
    expect(teamConclusion(comparison({ history }), local())?.text).toBe('Fails in CI too, with another error');
    expect(teamConclusion(comparison({ history }), local({ fingerprinted: false }))?.text).toBe('Fails in CI too');
    expect(teamConclusion(comparison({ history, fingerprintComparable: false }), local())?.text).toBe(
      'Fails in CI too',
    );
  });

  test('4. the latest CI result passed on another commit', () => {
    const history = [result({ status: 'skipped' }), result({ commit: 'abcdef1234567' })];
    expect(teamConclusion(comparison({ history }), local())).toMatchObject({
      rule: 'passes-on-other-commit',
      text: 'Passes in CI on main, on another commit: the commits differ',
    });
  });

  test('a run marked as an environment incident never counts', () => {
    const history = [result({ status: 'failed', incident: true }), result({ commit: 'abcdef1234567' })];
    expect(teamConclusion(comparison({ history }), local())?.rule).toBe('passes-on-other-commit');
  });

  test('5. no CI result; the teammates’ runs never count', () => {
    expect(teamConclusion(comparison({ history: [result({ source: 'local' })] }), local())?.rule).toBe('no-ci-result');
  });

  test('reads the local run’s environment alone when it has one', () => {
    const history = [
      result({ environment: 'mco', status: 'failed' }),
      result({ environment: 'integration', commit: COMMIT }),
    ];
    expect(teamConclusion(comparison({ history }), local({ environment: 'Integration' }))).toMatchObject({
      rule: 'passes-on-commit',
      environment: 'Integration',
      text: 'Passes in CI on this commit (Integration): the failure is likely specific to this machine',
    });
    expect(teamConclusion(comparison({ history }), local({ environment: 'mco' }))?.rule).toBe('fails-in-ci-too');
    expect(teamConclusion(comparison({ history }), local({ environment: 'recette' }))?.text).toBe(
      'No CI result in recette to compare with',
    );
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
