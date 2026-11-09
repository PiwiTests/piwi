import { describe, test, expect } from 'vitest';
import { evaluateGatePolicy, formatGateResult, isEmptyPolicy, type GateFacts, type GatePolicy } from '../src/gate';

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    runId: 42,
    runUrl: 'https://piwi.example.com/test-runs/42',
    projectName: 'checkout',
    status: 'passed',
    totalTests: 100,
    failedTests: 0,
    newRegressions: 0,
    newFlaky: 0,
    newClusters: 0,
    failingByTag: {},
    unmatchedTags: [],
    quarantinedFailures: 0,
    quarantinedTotal: 0,
    flakyTests: 0,
    ...overrides,
  };
}

describe('isEmptyPolicy', () => {
  test('an empty policy protects nothing and must be rejected by callers', () => {
    expect(isEmptyPolicy({})).toBe(true);
    expect(isEmptyPolicy({ requireTags: [] })).toBe(true);
    expect(isEmptyPolicy({ failOnNewCluster: false })).toBe(true);
  });

  test('any single rule makes it non-empty', () => {
    const policies: GatePolicy[] = [
      { requireTags: ['critical'] },
      { maxFailed: 0 },
      { maxNewRegressions: 0 },
      { maxNewFlaky: 0 },
      { failOnNewCluster: true },
      { requireSelection: 'smoke' },
    ];
    for (const policy of policies) expect(isEmptyPolicy(policy)).toBe(false);
  });

  test('a zero threshold is a real rule, not an absent one', () => {
    expect(isEmptyPolicy({ maxFailed: 0 })).toBe(false);
  });
});

describe('evaluateGatePolicy', () => {
  test('passes when nothing is violated', () => {
    const result = evaluateGatePolicy(facts(), { maxFailed: 0, failOnNewCluster: true });
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('a threshold is a maximum, not a target', () => {
    expect(evaluateGatePolicy(facts({ failedTests: 3 }), { maxFailed: 3 }).passed).toBe(true);
    expect(evaluateGatePolicy(facts({ failedTests: 4 }), { maxFailed: 3 }).passed).toBe(false);
  });

  test('reports a required tag whose tests failed', () => {
    const result = evaluateGatePolicy(
      facts({
        failedTests: 1,
        failingByTag: { critical: [{ title: 'checkout works', filePath: 'tests/a.spec.ts', executionId: 7 }] },
      }),
      { requireTags: ['critical'] },
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatchObject({ rule: 'required-tag', actual: 1 });
    expect(result.violations[0]!.message).toContain('checkout works');
  });

  test('truncates a long required-tag failure list', () => {
    const failing = Array.from({ length: 6 }, (_, i) => ({
      title: `test ${i}`,
      filePath: 'tests/a.spec.ts',
      executionId: i,
    }));
    const result = evaluateGatePolicy(facts({ failingByTag: { critical: failing } }), { requireTags: ['critical'] });
    expect(result.violations[0]!.message).toContain('+3 more');
  });

  // A misspelled tag that matches nothing would otherwise pass silently, which
  // is the worst possible outcome for a rule meant to block merges.
  test('an unmatched required tag is itself a violation', () => {
    const result = evaluateGatePolicy(facts({ unmatchedTags: ['critcal'] }), { requireTags: ['critcal'] });
    expect(result.passed).toBe(false);
    expect(result.violations[0]!.rule).toBe('unmatched-tag');
    expect(result.violations[0]!.message).toContain('@critcal');
  });

  test('reports every violation rather than stopping at the first', () => {
    const result = evaluateGatePolicy(facts({ failedTests: 9, newRegressions: 4, newFlaky: 2, newClusters: 1 }), {
      maxFailed: 0,
      maxNewRegressions: 0,
      maxNewFlaky: 0,
      failOnNewCluster: true,
    });
    expect(result.violations.map((v) => v.rule)).toEqual([
      'max-failed',
      'max-new-regressions',
      'max-new-flaky',
      'new-cluster',
    ]);
  });

  test('an unset threshold is not enforced', () => {
    const result = evaluateGatePolicy(facts({ failedTests: 50, newFlaky: 9 }), { maxNewRegressions: 0 });
    expect(result.passed).toBe(true);
  });

  test('failOnNewCluster only fires when a cluster is new', () => {
    expect(evaluateGatePolicy(facts({ newClusters: 0 }), { failOnNewCluster: true }).passed).toBe(true);
    expect(evaluateGatePolicy(facts({ newClusters: 2 }), { failOnNewCluster: true }).passed).toBe(false);
  });

  test('failOnFlaky fires on any flaky test and stays quiet otherwise', () => {
    expect(evaluateGatePolicy(facts(), { failOnFlaky: true }).passed).toBe(true);
    const failed = evaluateGatePolicy(facts({ flakyTests: 3 }), { failOnFlaky: true });
    expect(failed.passed).toBe(false);
    expect(failed.violations[0]).toMatchObject({ rule: 'flaky', actual: 3, limit: 0 });
    // A flaky test alone never trips the other rules.
    expect(evaluateGatePolicy(facts({ flakyTests: 1 }), { maxFailed: 0 }).passed).toBe(true);
  });

  test('carries the facts through for the caller to render', () => {
    const result = evaluateGatePolicy(facts({ failedTests: 1 }), { maxFailed: 0 });
    expect(result.facts.runId).toBe(42);
  });
});

describe('requireSelection', () => {
  const withSelection = (selection: NonNullable<GateFacts['selection']>) => facts({ selection });

  test('passes when every matched test ran and passed', () => {
    const result = evaluateGatePolicy(withSelection({ key: 'smoke', matched: 42, notRun: [], failed: [] }), {
      requireSelection: 'smoke',
    });
    expect(result.passed).toBe(true);
  });

  test('fails when a matched test did not run — the shrunk-smoke case', () => {
    const result = evaluateGatePolicy(
      withSelection({ key: 'smoke', matched: 42, notRun: [{ title: 'checkout', filePath: 'a.spec.ts' }], failed: [] }),
      { requireSelection: 'smoke' },
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatchObject({ rule: 'selection-not-run', actual: 1 });
    expect(result.violations[0]!.message).toContain('checkout');
  });

  test('fails when a matched test ran and failed', () => {
    const result = evaluateGatePolicy(
      withSelection({
        key: 'smoke',
        matched: 42,
        notRun: [],
        failed: [{ title: 'pay', filePath: 'a.spec.ts', executionId: 7 }],
      }),
      { requireSelection: 'smoke' },
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.rule).toBe('selection-failed');
  });

  test('fails when the selection matches no tests at all', () => {
    const result = evaluateGatePolicy(withSelection({ key: 'smoke', matched: 0, notRun: [], failed: [] }), {
      requireSelection: 'smoke',
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.rule).toBe('selection-empty');
  });

  test('does nothing without the policy flag', () => {
    const result = evaluateGatePolicy(
      withSelection({ key: 'smoke', matched: 1, notRun: [{ title: 'x', filePath: 'a.spec.ts' }], failed: [] }),
      { maxFailed: 0 },
    );
    expect(result.passed).toBe(true);
  });
});

describe('quarantine', () => {
  test('caps how much quarantine debt a suite may carry', () => {
    expect(evaluateGatePolicy(facts({ quarantinedTotal: 3 }), { maxQuarantined: 3 }).passed).toBe(true);
    const over = evaluateGatePolicy(facts({ quarantinedTotal: 4 }), { maxQuarantined: 3 });
    expect(over.passed).toBe(false);
    expect(over.violations[0]?.rule).toBe('max-quarantined');
  });

  test('a quarantine ceiling on its own is a real policy', () => {
    expect(isEmptyPolicy({ maxQuarantined: 0 })).toBe(false);
  });

  // A green gate that silently ignored failures would be untrustworthy, so the
  // exclusion is always stated in the log.
  test('reports failures excluded by quarantine', () => {
    const output = formatGateResult(
      evaluateGatePolicy(facts({ quarantinedFailures: 2, quarantinedTotal: 5 }), { maxFailed: 0 }),
    );
    expect(output).toContain('2 failing tests are quarantined and did not count');
  });

  test('says nothing about quarantine when none was excluded', () => {
    const output = formatGateResult(evaluateGatePolicy(facts(), { maxFailed: 0 }));
    expect(output).not.toContain('quarantined');
  });
});

describe('formatGateResult', () => {
  test('leads with the verdict and ends with the run URL', () => {
    const output = formatGateResult(evaluateGatePolicy(facts(), { maxFailed: 0 }));
    expect(output.split('\n')[0]).toContain('✔ Piwi gate passed');
    expect(output.trimEnd().endsWith('https://piwi.example.com/test-runs/42')).toBe(true);
  });

  test('lists each violation', () => {
    const output = formatGateResult(
      evaluateGatePolicy(facts({ failedTests: 2, newClusters: 1 }), { maxFailed: 0, failOnNewCluster: true }),
    );
    expect(output).toContain('✖ Piwi gate failed');
    expect(output).toContain('2 failing tests (limit 0)');
    expect(output).toContain('1 new failure cluster');
  });

  test('renders warnings without failing the verdict', () => {
    const result = {
      ...evaluateGatePolicy(facts(), { maxFailed: 0 }),
      warnings: ['3 uncovered changed files (threshold 1) — observed reach, warn-only.'],
    };
    const output = formatGateResult(result);
    expect(output).toContain('✔ Piwi gate passed');
    expect(output).toContain('⚠ 3 uncovered changed files (threshold 1)');
    // The warning line sits before the run URL, and the run still passes.
    expect(result.passed).toBe(true);
    expect(output.trimEnd().endsWith('https://piwi.example.com/test-runs/42')).toBe(true);
  });
});

describe('leak rules', () => {
  const leak = (site: string, tests = 1) => ({ where: site, site, tests });
  const resources = (leaks: ReturnType<typeof leak>[], newLeaks: ReturnType<typeof leak>[]) => ({
    reported: true,
    leaks,
    newLeaks,
    baseBranch: 'main',
  });

  test('count the leaks, and the ones the base branch never showed, each against its limit', () => {
    const run = facts({
      resources: resources([leak('tests/a.spec.ts:3'), leak('tests/b.spec.ts:9', 4)], [leak('tests/b.spec.ts:9', 4)]),
    });
    expect(evaluateGatePolicy(run, { maxLeaks: 2, maxNewLeaks: 1 }).passed).toBe(true);

    const result = evaluateGatePolicy(run, { maxLeaks: 1, maxNewLeaks: 0 });
    expect(result.violations.map((v) => v.rule)).toEqual(['max-leaks', 'max-new-leaks']);
    expect(result.violations[1]!.message).toBe('1 new leak, never seen on main (limit 0): tests/b.spec.ts:9');
    expect(formatGateResult(result)).toContain('  2 leaks, 1 new');
  });

  test('a run that sent no resource report fails a leak rule rather than passing on silence', () => {
    const run = facts({ resources: { reported: false, leaks: [], newLeaks: [], baseBranch: null } });
    expect(evaluateGatePolicy(run, { maxLeaks: 5 }).violations.map((v) => v.rule)).toEqual(['no-resource-report']);
    expect(isEmptyPolicy({ maxNewLeaks: 0 })).toBe(false);
  });

  test('a project that declined the resources capability fails a leak rule as not measured', () => {
    const run = facts({ resources: { reported: false, declined: true, leaks: [], newLeaks: [], baseBranch: null } });
    const [violation, ...rest] = evaluateGatePolicy(run, { maxNewLeaks: 0 }).violations;
    expect(rest).toEqual([]);
    expect(violation).toEqual({
      rule: 'resources-declined',
      message:
        'the project declined the Resources capability, so its leaks are not measured — turn it on in Settings → Capabilities, or drop the leak rules',
    });
  });
});

describe('an environment incident', () => {
  const incident = {
    rule: 'host-unreachable',
    reason: '41 of 44 tests failed, 39 of them navigating or connecting to staging.example.test (connection refused).',
    host: 'staging.example.test',
  };

  test('is inconclusive, distinct from a pass and a fail, whatever the policy says', () => {
    const result = evaluateGatePolicy(facts({ failedTests: 41, newClusters: 1, incident }), {
      maxFailed: 0,
      failOnNewCluster: true,
    });
    expect(result.verdict).toBe('inconclusive');
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([]);
  });

  test('a run that is not one keeps its verdict', () => {
    expect(evaluateGatePolicy(facts(), { maxFailed: 0 }).verdict).toBe('passed');
    expect(evaluateGatePolicy(facts({ failedTests: 2 }), { maxFailed: 0 }).verdict).toBe('failed');
  });

  test('the summary says why', () => {
    const output = formatGateResult(evaluateGatePolicy(facts({ failedTests: 41, incident }), { maxFailed: 0 }));
    expect(output).toContain('? Piwi gate inconclusive — checkout run #42');
    expect(output).toContain('The run is an environment incident: 41 of 44 tests failed');
    expect(output).not.toContain('✖');
  });
});
