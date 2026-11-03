import { describe, test, expect } from 'vitest';
import { buildSituation, type SituationInput, type SituationLine } from '#shared/situation';
import type { FailureVerdict } from '#shared/failure-verdict';
import type { LatestExecution } from '#shared/latest-execution';

const NOW = new Date('2026-09-06T12:00:00Z');
const ONE_DAY_AGO = new Date('2026-09-05T12:00:00Z');
const MINUTES_AGO = new Date('2026-09-06T11:07:00Z');

function since(overrides: Partial<FailureVerdict['since']> = {}): FailureVerdict['since'] {
  return {
    firstFailingRunId: 4,
    firstFailingAt: ONE_DAY_AGO,
    isFirstFailure: true,
    commit: { sha: 'a1b2c3d4e5', shortSha: 'a1b2c3d', author: 'Alice Chen', message: null, branch: 'main' },
    fixedBefore: null,
    ...overrides,
  };
}

function latest(overrides: Partial<LatestExecution> = {}): LatestExecution {
  return {
    isLatest: true,
    newest: null,
    failedAgainRunIds: [],
    failedAgainCount: 0,
    failedAgainInOtherClusterCount: 0,
    laterInOtherProject: false,
    projectName: 'Chromium',
    ...overrides,
  };
}

function newer(
  runIds: number[],
  newest: Partial<NonNullable<LatestExecution['newest']>> = {},
  overrides: Partial<LatestExecution> = {},
): LatestExecution {
  return latest({
    isLatest: false,
    newest: {
      executionId: 13,
      runId: runIds[0] ?? 2,
      status: 'failed',
      retries: 0,
      passedAfterFailure: false,
      at: MINUTES_AGO,
      sameRun: false,
      sameCluster: true,
      ...newest,
    },
    failedAgainRunIds: runIds,
    failedAgainCount: runIds.length,
    ...overrides,
  });
}

function base(overrides: Partial<SituationInput> = {}): SituationInput {
  return {
    why: 'new-regression',
    since: since(),
    cluster: { id: 1, name: 'checkout timeout', otherTestsInRun: 1 },
    owner: { name: '@checkout-team', source: 'annotation' },
    clusterStatus: 'open',
    assignee: null,
    latest: latest(),
    now: NOW,
    ...overrides,
  };
}

const all = (s: ReturnType<typeof buildSituation>): SituationLine[] =>
  [s.since, s.latest, s.cluster].filter((l): l is SituationLine => l != null);

describe('the since line', () => {
  test('a new regression on its first run names the commit it started at', () => {
    expect(buildSituation(base()).since.text).toBe('New regression since a1b2c3d by Alice Chen, 1 day ago');
  });

  test('a first failure without a why', () => {
    expect(buildSituation(base({ why: null })).since.text).toBe(
      'First failed in this run, on a1b2c3d by Alice Chen, 1 day ago',
    );
  });

  test('a first failure with no commit recorded', () => {
    expect(buildSituation(base({ why: null, since: since({ commit: null }) })).since.text).toBe(
      'First failed in this run, 1 day ago',
    );
    expect(buildSituation(base({ since: since({ commit: null }) })).since.text).toBe(
      'New regression, first failed in this run, 1 day ago',
    );
  });

  test('an older failure says since which run, then this run commit', () => {
    const line = buildSituation(
      base({ why: null, since: since({ isFirstFailure: false, firstFailingRunId: 4 }) }),
    ).since;
    expect(line.text).toBe('Failing since run #4, 1 day ago, this run on a1b2c3d by Alice Chen');
    expect(line.parts.find((p) => p.kind === 'run')).toMatchObject({ id: 4, href: '/test-runs/4' });
  });

  test.each([
    ['passed-on-retry', 'Passed on retry, first failed in this run'],
    ['new-flaky', 'Newly flaky, first failed in this run'],
    ['infrastructure', 'Infrastructure failure, first failed in this run'],
  ] as const)('the %s why leads the line', (why, lead) => {
    expect(buildSituation(base({ why })).since.text.startsWith(lead)).toBe(true);
  });

  test('the commit appears once, as a part with its full sha', () => {
    const s = buildSituation(base());
    expect(s.text.match(/a1b2c3d/g)?.length).toBe(1);
    expect(s.since.parts.find((p) => p.kind === 'commit')).toMatchObject({ id: 'a1b2c3d4e5', text: 'a1b2c3d' });
  });

  test('without a cluster, the owner ends the since line', () => {
    const s = buildSituation(base({ cluster: null }));
    expect(s.cluster).toBeNull();
    expect(s.since.text).toBe('New regression since a1b2c3d by Alice Chen, 1 day ago. Owner @checkout-team');
  });
});

describe('the since line of a retry pass', () => {
  const retryPass = (overrides: Partial<SituationInput> = {}) =>
    base({
      why: 'passed-on-retry',
      cluster: null,
      attempt: { failedRetry: 0, failedExecutionId: 41, passedRetry: 1 },
      ...overrides,
    });

  test('says which attempt failed and which passed, then the commit and the owner', () => {
    const line = buildSituation(retryPass()).since;
    expect(line.text).toBe('Failed on attempt 1, passed on attempt 2, on a1b2c3d by Alice Chen. Owner @checkout-team');
    expect(line.text).not.toContain('Passed on retry');
    expect(line.text).not.toContain('first failed in this run');
  });

  test('links the failed attempt to its execution', () => {
    const line = buildSituation(retryPass()).since;
    expect(line.parts.find((p) => p.kind === 'attempt')).toEqual({
      kind: 'attempt',
      text: 'attempt 1',
      id: 41,
      href: '/test-run-cases/41',
    });
    expect(line.parts.filter((p) => p.href)).toHaveLength(1);
  });

  test('a newly flaky test leads with it, and only then', () => {
    expect(buildSituation(retryPass({ newFlaky: true })).since.text).toBe(
      'Newly flaky, failed on attempt 1, passed on attempt 2, on a1b2c3d by Alice Chen. Owner @checkout-team',
    );
    expect(buildSituation(retryPass({ newFlaky: false })).since.text).not.toContain('Newly flaky');
  });

  test('a later attempt, with no commit recorded', () => {
    const input = retryPass({
      since: since({ commit: null }),
      owner: null,
      attempt: { failedRetry: 1, failedExecutionId: 42, passedRetry: 2 },
    });
    expect(buildSituation(input).since.text).toBe('Failed on attempt 2, passed on attempt 3');
  });

  test('has no cluster line', () => {
    expect(buildSituation(retryPass()).cluster).toBeNull();
  });
});

describe('the latest line', () => {
  test('the latest execution says so, with no link', () => {
    const line = buildSituation(base()).latest!;
    expect(line.text).toBe('Latest execution of this test');
    expect(line.parts.some((p) => p.href)).toBe(false);
  });

  test('another project ran later: the line names its own project', () => {
    expect(buildSituation(base({ latest: latest({ laterInOtherProject: true }) })).latest!.text).toBe(
      'Latest Chromium execution of this test',
    );
  });

  test('failed again in one and in two later runs', () => {
    expect(buildSituation(base({ latest: newer([2]) })).latest!.text).toBe(
      'Not the latest: failed again in run #2, 53 minutes ago',
    );
    expect(buildSituation(base({ latest: newer([2, 1]) })).latest!.text).toBe(
      'Not the latest: failed again in run #2 and run #1, 53 minutes ago',
    );
  });

  test('more than two later runs are counted', () => {
    expect(buildSituation(base({ latest: newer([9, 8, 7, 6]) })).latest!.text).toBe(
      'Not the latest: failed again in 4 later runs, most recently run #9, 53 minutes ago',
    );
  });

  test('a later failure in another cluster is another error', () => {
    const other = newer([2], { sameCluster: false }, { failedAgainInOtherClusterCount: 1 });
    expect(buildSituation(base({ latest: other })).latest!.text).toBe(
      'Not the latest: failed again with another error in run #2, 53 minutes ago',
    );
  });

  test('another error is said of the runs it holds for', () => {
    const text = (runIds: number[], otherCount: number) =>
      buildSituation(
        base({ latest: newer(runIds, { sameCluster: false }, { failedAgainInOtherClusterCount: otherCount }) }),
      ).latest!.text;
    // Every run of the streak in another cluster.
    expect(text([6, 5], 2)).toBe(
      'Not the latest: failed again with another error in run #6 and run #5, 53 minutes ago',
    );
    expect(text([8, 7, 6, 5], 4)).toBe(
      'Not the latest: failed again with another error in 4 later runs, most recently run #8, 53 minutes ago',
    );
    // Only the newest in another cluster.
    expect(text([6, 5], 1)).toBe(
      'Not the latest: failed again in run #6 and run #5, most recently with another error, 53 minutes ago',
    );
    expect(text([8, 7, 6, 5], 1)).toBe(
      'Not the latest: failed again in 4 later runs, most recently with another error in run #8, 53 minutes ago',
    );
  });

  test('a later failure whose cluster is unknown is not called another error', () => {
    expect(buildSituation(base({ latest: newer([6, 5], { sameCluster: null }) })).latest!.text).toBe(
      'Not the latest: failed again in run #6 and run #5, 53 minutes ago',
    );
  });

  test('another project ran later: the not-the-latest form names its own project', () => {
    expect(buildSituation(base({ latest: newer([2, 1], {}, { laterInOtherProject: true }) })).latest!.text).toBe(
      'Not the latest Chromium execution: failed again in run #2 and run #1, 53 minutes ago',
    );
    const sameRun = newer([], { runId: 4, status: 'passed', retries: 1, sameRun: true }, { laterInOtherProject: true });
    expect(buildSituation(base({ latest: sameRun })).latest!.text).toBe(
      'Not the latest Chromium execution: attempt 2 of this run passed',
    );
  });

  test('passed, passed on retry, skipped', () => {
    const one = (newest: Partial<NonNullable<LatestExecution['newest']>>) =>
      buildSituation(base({ latest: newer([], { runId: 62, ...newest }) })).latest!.text;
    expect(one({ status: 'passed' })).toBe('Not the latest: passed in run #62, 53 minutes ago');
    expect(one({ status: 'passed', retries: 1, passedAfterFailure: true })).toBe(
      'Not the latest: passed on retry in run #62, 53 minutes ago',
    );
    expect(one({ status: 'passed', retries: 1, passedAfterFailure: false })).toBe(
      'Not the latest: passed in run #62, 53 minutes ago',
    );
    expect(one({ status: 'skipped' })).toBe('Not the latest: was skipped in run #62, 53 minutes ago');
    expect(one({ status: 'didnotrun' })).toBe('Not the latest: did not run in run #62, 53 minutes ago');
  });

  test('a later attempt of the same run', () => {
    const s = buildSituation(
      base({ latest: newer([], { runId: 4, status: 'passed', retries: 1, sameRun: true, executionId: 38 }) }),
    );
    expect(s.latest!.text).toBe('Not the latest: attempt 2 of this run passed');
  });

  test('one link, to the newest execution, and no run link', () => {
    const line = buildSituation(base({ latest: newer([2, 1]) })).latest!;
    const links = line.parts.filter((p) => p.href);
    expect(links).toEqual([{ kind: 'execution', text: 'Open the latest', id: 13, href: '/test-run-cases/13' }]);
    expect(line.parts.some((p) => p.kind === 'run')).toBe(false);
    // The link is the page's, not part of the sentence.
    expect(line.text).not.toContain('Open the latest');
  });

  test('no summary: no latest line', () => {
    expect(buildSituation(base({ latest: null })).latest).toBeNull();
  });
});

describe('the cluster line', () => {
  test('names the other tests of the run and links the cluster', () => {
    const line = buildSituation(base()).cluster!;
    expect(line.text).toBe('Same failure in 1 other test of this run: cluster #1, open. Owner @checkout-team.');
    expect(line.parts.find((p) => p.kind === 'cluster')).toMatchObject({ id: 1, href: '/failure-clusters/1' });
    expect(line.parts.filter((p) => p.href)).toHaveLength(1);
  });

  test('no other test: the cluster leads, capitalized', () => {
    const cluster = { id: 2, name: 'pay button', otherTestsInRun: 0 };
    expect(buildSituation(base({ cluster, owner: null })).cluster!.text).toBe('Cluster #2, open.');
    const three = { id: 2, name: 'pay button', otherTestsInRun: 3 };
    expect(buildSituation(base({ cluster: three, owner: null })).cluster!.text).toBe(
      'Same failure in 3 other tests of this run: cluster #2, open.',
    );
  });

  test('an assignee is named only when one is set, and never "unassigned"', () => {
    expect(buildSituation(base({ assignee: 'Avery' })).cluster!.text).toContain('cluster #1, open, assigned to Avery.');
    expect(buildSituation(base({ assignee: '  ' })).cluster!.text).toContain('cluster #1, open.');
    expect(buildSituation(base()).text).not.toContain('unassigned');
  });

  test('a fix that did not hold', () => {
    const input = base({
      since: since({ fixedBefore: { commit: 'demo001', commitShort: 'demo001', runId: 3, at: null } }),
    });
    expect(buildSituation(input).cluster!.text).toContain('open. A fix landed once and did not hold. Owner');
  });

  test('the owner ends it, as a part', () => {
    const line = buildSituation(base()).cluster!;
    expect(line.text).toMatch(/Owner @checkout-team\.$/);
    expect(line.parts.find((p) => p.kind === 'owner')).toMatchObject({ text: '@checkout-team' });
  });

  test('the tracked issue is not part of it: the issue line follows it', () => {
    expect(buildSituation(base()).text).not.toContain('Tracked in');
  });
});

describe('buildSituation: whole examples', () => {
  test('a regression that failed again, in a cluster whose fix did not hold', () => {
    const input = base({
      latest: newer([2, 1]),
      since: since({ fixedBefore: { commit: 'demo001', commitShort: 'demo001', runId: 3, at: null } }),
    });
    expect(buildSituation(input).text).toBe(
      'New regression since a1b2c3d by Alice Chen, 1 day ago. ' +
        'Not the latest: failed again in run #2 and run #1, 53 minutes ago. ' +
        'Same failure in 1 other test of this run: cluster #1, open. A fix landed once and did not hold. ' +
        'Owner @checkout-team.',
    );
  });

  test('a clustered failure with an assignee, owned through CODEOWNERS', () => {
    const input = base({
      why: null,
      since: since({ isFirstFailure: false, firstFailingRunId: 4 }),
      cluster: { id: 2, name: 'pay button', otherTestsInRun: 0 },
      owner: { name: '@payments', source: 'codeowners' },
      assignee: 'Avery',
      latest: newer([], { runId: 62, status: 'passed' }),
    });
    expect(buildSituation(input).text).toBe(
      'Failing since run #4, 1 day ago, this run on a1b2c3d by Alice Chen. ' +
        'Not the latest: passed in run #62, 53 minutes ago. ' +
        'Cluster #2, open, assigned to Avery. Owner @payments.',
    );
  });

  test('a plain, unclustered, unowned failure', () => {
    const input = base({ why: null, cluster: null, owner: null, latest: null });
    expect(buildSituation(input).text).toBe('First failed in this run, on a1b2c3d by Alice Chen, 1 day ago.');
  });

  test('no long dash and no arrow in any line', () => {
    const inputs = [
      base(),
      base({ latest: newer([2, 1], { sameCluster: false }, { failedAgainInOtherClusterCount: 1 }) }),
      base({ why: 'passed-on-retry', cluster: null }),
      base({ since: since({ isFirstFailure: false }), assignee: 'Avery' }),
    ];
    for (const input of inputs) {
      const s = buildSituation(input);
      for (const text of [s.text, ...all(s).flatMap((l) => l.parts.map((p) => p.text))]) {
        expect(text).not.toMatch(/[—→]/);
      }
    }
  });
});
