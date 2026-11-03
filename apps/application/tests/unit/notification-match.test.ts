import { describe, test, expect } from 'vitest';
import {
  buildNotificationDedupeKey,
  passesSubscriptionFilters,
  matchesNamePattern,
  describeSubscriptionFilters,
  computePerfBaseline,
  notificationTargetPath,
  PERF_BASELINE_MIN_RUNS,
  type RunFinishedPayload,
  type ClusterNewPayload,
  type DiagnosisCompletedPayload,
  type AutoHealPrOpenedPayload,
} from '#shared/notification-events';

const runPayload: RunFinishedPayload = {
  runId: 7,
  projectId: 2,
  projectName: 'my-project',
  status: 'failed',
  totalTests: 10,
  failedTests: 2,
  passedTests: 8,
  flakyTests: 1,
  flakinessRate: 0.1,
};

const clusterPayload = (clusterId: number): ClusterNewPayload => ({
  clusterId,
  projectId: 2,
  projectName: 'my-project',
  signature: 'TimeoutError',
  runId: 7,
});

describe('buildNotificationDedupeKey', () => {
  test('run events dedupe on the run', () => {
    const a = buildNotificationDedupeKey('run.failed', runPayload, 1);
    const b = buildNotificationDedupeKey('run.failed', runPayload, 1);
    expect(a).toBe(b);
    expect(a).toContain('r7');
  });

  test('two new clusters from the same run get distinct keys per channel', () => {
    const a = buildNotificationDedupeKey('cluster.new', clusterPayload(11), 1);
    const b = buildNotificationDedupeKey('cluster.new', clusterPayload(12), 1);
    expect(a).not.toBe(b);
  });

  test('the same cluster stays deduped across channels but not across clusters', () => {
    const sameCluster = buildNotificationDedupeKey('cluster.new', clusterPayload(11), 1);
    expect(buildNotificationDedupeKey('cluster.new', clusterPayload(11), 1)).toBe(sameCluster);
    expect(buildNotificationDedupeKey('cluster.new', clusterPayload(11), 2)).not.toBe(sameCluster);
  });

  test('re-diagnoses of one cluster get distinct keys via completedAt', () => {
    const diag = (completedAt: number): DiagnosisCompletedPayload => ({ clusterId: 5, projectId: 2, completedAt });
    const first = buildNotificationDedupeKey('diagnosis.completed', diag(1000), 1);
    const second = buildNotificationDedupeKey('diagnosis.completed', diag(2000), 1);
    expect(first).not.toBe(second);
    expect(buildNotificationDedupeKey('diagnosis.completed', diag(1000), 1)).toBe(first);
  });

  test('run events on different channels get distinct keys', () => {
    expect(buildNotificationDedupeKey('run.finished', runPayload, 1)).not.toBe(
      buildNotificationDedupeKey('run.finished', runPayload, 2),
    );
  });
});

describe('passesSubscriptionFilters', () => {
  test('no filters passes everything', () => {
    expect(passesSubscriptionFilters(null, 'run.failed', runPayload)).toBe(true);
    expect(passesSubscriptionFilters(undefined, 'run.failed', runPayload)).toBe(true);
  });

  test('branch filter keeps runs on a listed branch', () => {
    const payload = { ...runPayload, branch: 'feature-x' };
    expect(passesSubscriptionFilters({ branches: ['main'] }, 'run.failed', payload)).toBe(false);
    expect(passesSubscriptionFilters({ branches: ['main', 'feature-x'] }, 'run.failed', payload)).toBe(true);
  });

  test('branch filter takes * patterns', () => {
    const release = { ...runPayload, branch: 'release/2.4' };
    expect(passesSubscriptionFilters({ branches: ['release/*'] }, 'run.failed', release)).toBe(true);
    expect(passesSubscriptionFilters({ branches: ['hotfix/*'] }, 'run.failed', release)).toBe(false);
  });

  test('environment filter keeps runs in a listed environment', () => {
    const staging = { ...runPayload, environment: 'staging' };
    expect(passesSubscriptionFilters({ environments: ['staging', 'production'] }, 'run.failed', staging)).toBe(true);
    expect(passesSubscriptionFilters({ environments: ['production'] }, 'run.failed', staging)).toBe(false);
    expect(passesSubscriptionFilters({ environments: ['stag*'] }, 'run.failed', staging)).toBe(true);
  });

  test('branch and environment filters must both match', () => {
    const filters = { branches: ['main'], environments: ['staging'] };
    expect(
      passesSubscriptionFilters(filters, 'run.failed', { ...runPayload, branch: 'main', environment: 'staging' }),
    ).toBe(true);
    expect(passesSubscriptionFilters(filters, 'run.failed', { ...runPayload, branch: 'main', environment: 'qa' })).toBe(
      false,
    );
  });

  test('a run that reported no branch or environment is on none of the listed ones', () => {
    expect(passesSubscriptionFilters({ branches: ['main'] }, 'run.failed', runPayload)).toBe(false);
    expect(passesSubscriptionFilters({ environments: ['staging'] }, 'run.failed', runPayload)).toBe(false);
  });

  test('branch and environment filters apply to every run-scoped event', () => {
    const filters = { branches: ['main'], environments: ['staging'] };
    const scope = { branch: 'feature-x', environment: 'staging' };
    expect(passesSubscriptionFilters(filters, 'flakiness.spike', { ...runPayload, ...scope })).toBe(false);
    expect(passesSubscriptionFilters(filters, 'perf.regression', { ...runPayload, ...scope })).toBe(false);
    expect(passesSubscriptionFilters(filters, 'cluster.new', { ...clusterPayload(11), ...scope })).toBe(false);
    expect(
      passesSubscriptionFilters(filters, 'cluster.new', {
        ...clusterPayload(11),
        branch: 'main',
        environment: 'staging',
      }),
    ).toBe(true);
    expect(
      passesSubscriptionFilters(filters, 'bug.looks_fixed', { projectId: 2, projectName: 'p', runId: 7, tests: [] }),
    ).toBe(false);
  });

  test('diagnosis and auto-heal events pass branch and environment filters', () => {
    const filters = { branches: ['main'], environments: ['staging'] };
    const diagnosis: DiagnosisCompletedPayload = { clusterId: 5, projectId: 2 };
    const pr: AutoHealPrOpenedPayload = {
      projectId: 2,
      projectName: 'p',
      runId: 7,
      prNumber: 3,
      prUrl: 'https://example.com/pr/3',
      branch: 'piwi/heal-7',
      editCount: 1,
    };
    expect(passesSubscriptionFilters(filters, 'diagnosis.completed', diagnosis)).toBe(true);
    expect(passesSubscriptionFilters(filters, 'auto_heal.pr_opened', pr)).toBe(true);
  });

  test('defaultBranchOnly drops non-default-branch runs', () => {
    expect(passesSubscriptionFilters({ defaultBranchOnly: true }, 'run.failed', runPayload)).toBe(false);
    expect(
      passesSubscriptionFilters({ defaultBranchOnly: true }, 'run.failed', { ...runPayload, isDefaultBranch: true }),
    ).toBe(true);
  });

  test('owner filter requires an owned failing test', () => {
    expect(passesSubscriptionFilters({ owners: ['team-a'] }, 'run.failed', runPayload)).toBe(false);
    expect(
      passesSubscriptionFilters({ owners: ['team-a'] }, 'run.failed', { ...runPayload, owners: ['team-a', 'team-b'] }),
    ).toBe(true);
  });

  test('owner filter applies to the non-run events that carry owners', () => {
    const filters = { owners: ['team-a'] };
    const otherTeam = { ...runPayload, owners: ['team-b'] };
    expect(passesSubscriptionFilters(filters, 'flakiness.spike', otherTeam)).toBe(false);
    expect(passesSubscriptionFilters(filters, 'perf.regression', { ...otherTeam, regressionPct: 40 })).toBe(false);
    expect(passesSubscriptionFilters(filters, 'flakiness.spike', { ...runPayload, owners: ['team-a'] })).toBe(true);

    const cluster = {
      clusterId: 4,
      projectId: 1,
      projectName: 'web',
      signature: 'Timeout',
      runId: 7,
      branch: 'main',
    };
    expect(passesSubscriptionFilters(filters, 'cluster.new', cluster)).toBe(false);
    expect(passesSubscriptionFilters(filters, 'cluster.new', { ...cluster, owners: ['team-b'] })).toBe(false);
    expect(passesSubscriptionFilters(filters, 'cluster.new', { ...cluster, owners: ['team-a'] })).toBe(true);
  });

  test('flakinessThreshold gates flakiness.spike on the rate', () => {
    expect(passesSubscriptionFilters({ flakinessThreshold: 0.2 }, 'flakiness.spike', runPayload)).toBe(false);
    expect(passesSubscriptionFilters({ flakinessThreshold: 0.05 }, 'flakiness.spike', runPayload)).toBe(true);
  });

  test('perfRegressionPct gates perf.regression on the slowdown', () => {
    const regressed = { ...runPayload, regressionPct: 30 };
    expect(passesSubscriptionFilters({ perfRegressionPct: 50 }, 'perf.regression', regressed)).toBe(false);
    expect(passesSubscriptionFilters({ perfRegressionPct: 25 }, 'perf.regression', regressed)).toBe(true);
  });
});

describe('matchesNamePattern', () => {
  test('a name without * matches exactly', () => {
    expect(matchesNamePattern('main', ['main'])).toBe(true);
    expect(matchesNamePattern('main-2', ['main'])).toBe(false);
  });

  test('* matches any characters, slashes included', () => {
    expect(matchesNamePattern('release/2.4/rc', ['release/*'])).toBe(true);
    expect(matchesNamePattern('feat-login-ui', ['feat-*-ui'])).toBe(true);
    expect(matchesNamePattern('anything', ['*'])).toBe(true);
  });

  test('other characters are literal', () => {
    expect(matchesNamePattern('release-2x4', ['release-2.4*'])).toBe(false);
    expect(matchesNamePattern('release-2.4.1', ['release-2.4*'])).toBe(true);
    expect(matchesNamePattern('env(a)', ['env(*)'])).toBe(true);
    expect(matchesNamePattern('rc1', ['rc?*'])).toBe(false);
    expect(matchesNamePattern('rc?1', ['rc?*'])).toBe(true);
  });

  test('case matters and the pattern names the whole name', () => {
    expect(matchesNamePattern('Release/1', ['release/*'])).toBe(false);
    expect(matchesNamePattern('hotfix/release/1', ['release/*'])).toBe(false);
    expect(matchesNamePattern('release/1-old', ['*1'])).toBe(false);
  });

  test('answers at once for a pattern a regular expression backtracks on', () => {
    // The fastest of three runs: a pause of the machine slows one of them, a backtracking matcher all three.
    let fastest = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      expect(matchesNamePattern('e'.repeat(26), ['*e*e*e*e*e*e*e*e*e*e*e*e*!'])).toBe(false);
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThan(50);
  });
});

describe('describeSubscriptionFilters', () => {
  test('names each filter that is set', () => {
    expect(
      describeSubscriptionFilters({
        branches: ['main', 'release/*'],
        environments: ['staging'],
        flakinessThreshold: 0.2,
      }),
    ).toEqual(['Branch: main, release/*', 'Environment: staging', 'Flakiness ≥ 20%']);
  });

  test('is empty without filters', () => {
    expect(describeSubscriptionFilters(null)).toEqual([]);
    expect(describeSubscriptionFilters({ branches: [] })).toEqual([]);
  });
});

describe('computePerfBaseline', () => {
  test('returns null below the minimum prior-run count', () => {
    const tooFew = Array.from({ length: PERF_BASELINE_MIN_RUNS - 1 }, () => 1000);
    expect(computePerfBaseline(tooFew, 2000)).toBeNull();
  });

  test('returns null for a non-positive current duration', () => {
    expect(computePerfBaseline([1000, 1000, 1000], 0)).toBeNull();
  });

  test('ignores non-positive prior durations', () => {
    expect(computePerfBaseline([0, -5, 1000], 2000)).toBeNull();
  });

  test('uses the median of prior durations', () => {
    const result = computePerfBaseline([1000, 4000, 1200], 1800);
    expect(result).not.toBeNull();
    expect(result!.baselineDurationMs).toBe(1200);
    expect(result!.regressionPct).toBeCloseTo(50);
  });

  test('averages the two middle values for an even count', () => {
    const result = computePerfBaseline([1000, 2000], 3000);
    expect(result!.baselineDurationMs).toBe(1500);
    expect(result!.regressionPct).toBeCloseTo(100);
  });

  test('reports a negative percentage for a faster run', () => {
    const result = computePerfBaseline([1000, 1000, 1000], 800);
    expect(result!.regressionPct).toBeCloseTo(-20);
  });
});

describe('notificationTargetPath', () => {
  test('run events link to the run', () => {
    expect(notificationTargetPath('run.failed', runPayload)).toBe('/test-runs/7');
  });

  test('cluster and diagnosis events link to the cluster', () => {
    expect(notificationTargetPath('cluster.new', clusterPayload(11))).toBe('/failure-clusters/11');
    expect(notificationTargetPath('diagnosis.completed', { clusterId: 5, projectId: 2 })).toBe('/failure-clusters/5');
  });
});
