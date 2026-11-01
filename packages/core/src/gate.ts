/**
 * CI gate — turn a finished run into a pass/fail verdict against a policy the
 * pipeline declares.
 *
 * The reporter never fails a build on its own: whether a red test should stop a
 * merge is a policy decision, and policy belongs in the pipeline that owns it.
 * This is the shared, pure half — the facts are gathered server-side and the
 * same evaluation runs for the API, the CLI and the tests.
 */

export interface GatePolicy {
  /**
   * Every test carrying each of these tags must pass. A tag nothing carries is
   * a violation in itself — a policy that silently matches no tests is worse
   * than one that fails loudly, because it looks like it is protecting you.
   */
  requireTags?: string[];
  /** Maximum failing tests tolerated. */
  maxFailed?: number;
  /** Maximum failures that were not failing in the last green run. */
  maxNewRegressions?: number;
  /** Maximum tests that newly started passing only on retry. */
  maxNewFlaky?: number;
  /** Fail when this run introduced a failure cluster never seen before. */
  failOnNewCluster?: boolean;
  /**
   * Fail when more than this many tests are quarantined. Quarantine is a debt,
   * not a solution — this is the ceiling on how much of it a suite may carry.
   */
  maxQuarantined?: number;
  /** Fail when the run contains any flaky test (passed after an earlier attempt failed). */
  failOnFlaky?: boolean;
  /**
   * Key of a selection every test of which must have run and passed in this run.
   * The server re-resolves the selection's current definition, so this catches
   * the failure mode tags cannot: a smoke job that silently shrank — a renamed
   * file or over-narrow filter dropping a test the selection still expects.
   */
  requireSelection?: string;
  /**
   * Maximum browsers, contexts, pages and API contexts the run left open past
   * the scope that opened them, counted per opening line. A run that sent no
   * resource report is a violation, so a pipeline that lost the capture does
   * not pass on silence.
   */
  maxLeaks?: number;
  /** Maximum of those leaks that no earlier run of the base branch showed. */
  maxNewLeaks?: number;
}

/** A leak named in a gate result: where it was opened and how many tests it spans. */
export interface GateLeak {
  where: string;
  site: string | null;
  tests: number;
}

/** What the server measured about the run, independent of any policy. */
export interface GateFacts {
  runId: number;
  runUrl: string;
  projectName: string;
  status: string;
  totalTests: number;
  failedTests: number;
  newRegressions: number;
  newFlaky: number;
  newClusters: number;
  /** Failing tests grouped by each required tag, keyed by tag. */
  failingByTag: Record<string, Array<{ title: string; filePath: string; executionId: number }>>;
  /** Required tags that matched no test in this run at all. */
  unmatchedTags: string[];
  /** Failing tests excluded from the verdict because they are quarantined. */
  quarantinedFailures: number;
  /** Tests currently quarantined in this project. */
  quarantinedTotal: number;
  /** Tests that passed only after a retry in this run. */
  flakyTests: number;
  /** Set when `requireSelection` was asked: how the named selection fared in this run. */
  selection?: {
    key: string;
    /** How many tests the selection currently resolves to. */
    matched: number;
    /** Matched tests that did not run in this run at all. */
    notRun: Array<{ title: string; filePath: string }>;
    /** Matched tests that ran but failed (and are not quarantined). */
    failed: Array<{ title: string; filePath: string; executionId: number }>;
  };
  /** Set when a leak rule was asked: what the run's resource report holds. */
  resources?: {
    /** False when the run sent no resource report. */
    reported: boolean;
    leaks: GateLeak[];
    /** Leaks no earlier run of the base branch showed. */
    newLeaks: GateLeak[];
    /** The branch new leaks are read against: the pull request's target, else the default branch. */
    baseBranch: string | null;
  };
  /**
   * Set when the run is an environment incident: its failures come from the
   * environment under test, so no policy can say whether the change is good.
   */
  incident?: GateIncident;
}

/** Why a run is an environment incident, as the gate reports it. */
export interface GateIncident {
  /** The rule that flagged the run, or `person` when someone marked it. */
  rule: string;
  reason: string;
  host: string | null;
}

interface GateViolation {
  /** Stable identifier, so a pipeline can branch on the kind of failure. */
  rule:
    | 'required-tag'
    | 'unmatched-tag'
    | 'max-failed'
    | 'max-new-regressions'
    | 'max-new-flaky'
    | 'new-cluster'
    | 'max-quarantined'
    | 'flaky'
    | 'selection-empty'
    | 'selection-not-run'
    | 'selection-failed'
    | 'max-leaks'
    | 'max-new-leaks'
    | 'no-resource-report';
  message: string;
  /** Observed value and the limit it exceeded, when the rule is a threshold. */
  actual?: number;
  limit?: number;
}

/**
 * `passed` and `failed` answer the policy; `inconclusive` means the run cannot
 * answer it (an environment incident). An inconclusive result has `passed:
 * false`, so a client that reads only `passed` blocks the merge.
 */
export type GateVerdict = 'passed' | 'failed' | 'inconclusive';

export interface GateResult {
  passed: boolean;
  verdict: GateVerdict;
  violations: GateViolation[];
  facts: GateFacts;
  /** Warn-only notices that never fail the gate (e.g. uncovered changed files). */
  warnings?: string[];
}

/** True when the policy asks for nothing — used to reject an empty invocation. */
export function isEmptyPolicy(policy: GatePolicy): boolean {
  return (
    (policy.requireTags?.length ?? 0) === 0 &&
    policy.maxFailed == null &&
    policy.maxNewRegressions == null &&
    policy.maxNewFlaky == null &&
    policy.maxQuarantined == null &&
    !policy.failOnNewCluster &&
    !policy.failOnFlaky &&
    !policy.requireSelection &&
    policy.maxLeaks == null &&
    policy.maxNewLeaks == null
  );
}

function overLimit(
  rule: GateViolation['rule'],
  [one, many]: [string, string],
  actual: number,
  limit: number | undefined,
): GateViolation | null {
  if (limit == null || actual <= limit) return null;
  return {
    rule,
    message: `${actual} ${actual === 1 ? one : many} (limit ${limit})`,
    actual,
    limit,
  };
}

/**
 * Apply a policy to the measured facts. Every rule is evaluated — the caller
 * gets the complete list of what is wrong, not just the first thing to trip.
 */
export function evaluateGatePolicy(facts: GateFacts, policy: GatePolicy): GateResult {
  const violations: GateViolation[] = [];

  for (const tag of policy.requireTags ?? []) {
    const failing = facts.failingByTag[tag] ?? [];
    if (failing.length > 0) {
      const names = failing
        .slice(0, 3)
        .map((entry) => entry.title)
        .join(', ');
      const more = failing.length > 3 ? `, +${failing.length - 3} more` : '';
      violations.push({
        rule: 'required-tag',
        message: `${failing.length} required @${tag} ${failing.length === 1 ? 'test' : 'tests'} failed: ${names}${more}`,
        actual: failing.length,
        limit: 0,
      });
    }
  }

  for (const tag of facts.unmatchedTags) {
    violations.push({
      rule: 'unmatched-tag',
      message: `no test in this run carries @${tag} — the tag is misspelled, or the run did not cover it`,
    });
  }

  const thresholds = [
    overLimit('max-failed', ['failing test', 'failing tests'], facts.failedTests, policy.maxFailed),
    overLimit(
      'max-new-regressions',
      ['new regression', 'new regressions'],
      facts.newRegressions,
      policy.maxNewRegressions,
    ),
    overLimit('max-new-flaky', ['newly flaky test', 'newly flaky tests'], facts.newFlaky, policy.maxNewFlaky),
  ];
  for (const violation of thresholds) if (violation) violations.push(violation);

  const quarantineViolation = overLimit(
    'max-quarantined',
    ['quarantined test', 'quarantined tests'],
    facts.quarantinedTotal,
    policy.maxQuarantined,
  );
  if (quarantineViolation) violations.push(quarantineViolation);

  if (policy.failOnNewCluster && facts.newClusters > 0) {
    violations.push({
      rule: 'new-cluster',
      message: `${facts.newClusters} new failure ${facts.newClusters === 1 ? 'cluster' : 'clusters'} appeared in this run`,
      actual: facts.newClusters,
      limit: 0,
    });
  }

  if (policy.failOnFlaky && facts.flakyTests > 0) {
    violations.push({
      rule: 'flaky',
      message: `${facts.flakyTests} flaky ${facts.flakyTests === 1 ? 'test' : 'tests'} detected in this run`,
      actual: facts.flakyTests,
      limit: 0,
    });
  }

  if (policy.requireSelection && facts.selection) {
    const { key, matched, notRun, failed } = facts.selection;
    if (matched === 0) {
      violations.push({
        rule: 'selection-empty',
        message: `selection "${key}" matches no tests — the definition is too narrow, or nothing in the project qualifies`,
      });
    }
    if (notRun.length > 0) {
      const names = notRun
        .slice(0, 3)
        .map((entry) => entry.title)
        .join(', ');
      const more = notRun.length > 3 ? `, +${notRun.length - 3} more` : '';
      violations.push({
        rule: 'selection-not-run',
        message: `${notRun.length} test${notRun.length === 1 ? '' : 's'} in selection "${key}" did not run: ${names}${more}`,
        actual: notRun.length,
        limit: 0,
      });
    }
    if (failed.length > 0) {
      const names = failed
        .slice(0, 3)
        .map((entry) => entry.title)
        .join(', ');
      const more = failed.length > 3 ? `, +${failed.length - 3} more` : '';
      violations.push({
        rule: 'selection-failed',
        message: `${failed.length} test${failed.length === 1 ? '' : 's'} in selection "${key}" failed: ${names}${more}`,
        actual: failed.length,
        limit: 0,
      });
    }
  }

  if ((policy.maxLeaks != null || policy.maxNewLeaks != null) && facts.resources) {
    violations.push(...leakViolations(facts.resources, policy));
  }

  if (facts.incident) return { passed: false, verdict: 'inconclusive', violations: [], facts };
  const passed = violations.length === 0;
  return { passed, verdict: passed ? 'passed' : 'failed', violations, facts };
}

/** `tests/cart.spec.ts:12, fixture "adminPage" at tests/fixtures.ts:21, +2 more`. */
function leakNames(leaks: GateLeak[]): string {
  const names = leaks
    .slice(0, 3)
    .map((leak) => leak.site ?? leak.where)
    .join(', ');
  return leaks.length > 3 ? `${names}, +${leaks.length - 3} more` : names;
}

function leakViolations(resources: NonNullable<GateFacts['resources']>, policy: GatePolicy): GateViolation[] {
  if (!resources.reported) {
    return [
      {
        rule: 'no-resource-report',
        message:
          'the run sent no resource report — the reporter is older than 0.45, or captureResources is off — so its leaks are unknown',
      },
    ];
  }
  const out: GateViolation[] = [];
  const { leaks, newLeaks } = resources;
  if (policy.maxLeaks != null && leaks.length > policy.maxLeaks) {
    out.push({
      rule: 'max-leaks',
      message: `${leaks.length} ${leaks.length === 1 ? 'leak' : 'leaks'} (limit ${policy.maxLeaks}): ${leakNames(leaks)}`,
      actual: leaks.length,
      limit: policy.maxLeaks,
    });
  }
  if (policy.maxNewLeaks != null && newLeaks.length > policy.maxNewLeaks) {
    const base = resources.baseBranch ? ` on ${resources.baseBranch}` : '';
    out.push({
      rule: 'max-new-leaks',
      message: `${newLeaks.length} new ${newLeaks.length === 1 ? 'leak' : 'leaks'}, never seen${base} (limit ${policy.maxNewLeaks}): ${leakNames(newLeaks)}`,
      actual: newLeaks.length,
      limit: policy.maxNewLeaks,
    });
  }
  return out;
}

/** Render a gate result for a CI log. Returns one line per fact or violation. */
export function formatGateResult(result: GateResult): string {
  const { facts } = result;
  const lines = [
    result.verdict === 'inconclusive'
      ? `? Piwi gate inconclusive — ${facts.projectName} run #${facts.runId}`
      : result.passed
        ? `✔ Piwi gate passed — ${facts.projectName} run #${facts.runId}`
        : `✖ Piwi gate failed — ${facts.projectName} run #${facts.runId}`,
    `  ${facts.totalTests} tests, ${facts.failedTests} failed, ${facts.newRegressions} new, ${facts.newFlaky} newly flaky, ${facts.flakyTests} flaky`,
  ];
  if (facts.quarantinedFailures > 0) {
    lines.push(
      `  ${facts.quarantinedFailures} failing ${facts.quarantinedFailures === 1 ? 'test is' : 'tests are'} quarantined and did not count`,
    );
  }
  if (facts.resources?.reported) {
    const { leaks, newLeaks } = facts.resources;
    lines.push(`  ${leaks.length} ${leaks.length === 1 ? 'leak' : 'leaks'}, ${newLeaks.length} new`);
  }
  if (facts.incident) {
    lines.push(`  ? The run is an environment incident: ${facts.incident.reason}`);
    lines.push('  Re-run once the environment is back, or clear the flag on the run page if it is wrong.');
  }
  for (const violation of result.violations) lines.push(`  ✖ ${violation.message}`);
  for (const warning of result.warnings ?? []) lines.push(`  ⚠ ${warning}`);
  lines.push(`  ${facts.runUrl}`);
  return lines.join('\n');
}
