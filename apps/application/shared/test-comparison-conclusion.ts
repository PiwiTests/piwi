/**
 * Compare with team instance, as the desktop app reads the team instance's answer (`TestComparison`): the test's team
 * history grouped by environment, and the one-line conclusion a failing local execution gets. Pure, so the desktop
 * app's server and its pages read it the same way.
 *
 * The conclusion reads the reference results (`source: 'ci'`) alone, of the local run's environment when it has one,
 * leaving out the runs marked as an environment incident, and takes the first rule that applies:
 * 1. the CI saw the same error (the cluster of the same fingerprint has reference occurrences);
 * 2. the test passed in CI on the local commit (said differently when the local checkout had uncommitted changes);
 * 3. its latest CI result failed;
 * 4. its latest CI result passed, on another commit;
 * 5. no CI result.
 */
import { flakyRate, passRate } from './utils/pass-rate';
import type { TestComparison, TestComparisonResult, TestComparisonSource } from './test-comparison';

/** The results counted as failed by every pass rate: failed and timed out. */
const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'timedOut']);

/** A row of the team history: one environment's CI results, or the teammates' shared runs. */
export interface TeamHistoryRow {
  source: TestComparisonSource;
  /** The environment's key; null for the results with none, and for the teammates' row. */
  environment: string | null;
  /** The local run's environment. */
  isLocalEnvironment: boolean;
  results: TestComparisonResult[];
  passRate: number | null;
  flakyRate: number | null;
}

function rateCounts(results: readonly TestComparisonResult[]) {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  for (const result of results) {
    if (result.status === 'passed') {
      passed++;
      if (result.flaky) flaky++;
    } else if (FAILED_STATUSES.has(result.status)) failed++;
  }
  return { passed, failed, flaky };
}

const sameEnvironment = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The team history in rows: one row per environment the CI ran the test in, the local run's environment first, then
 * the others by their latest result, the results with no environment last; then the teammates' shared runs in one
 * row. Each row keeps its results newest first, with its pass rate and flaky rate.
 */
export function teamHistoryRows(
  history: readonly TestComparisonResult[],
  localEnvironment: string | null,
): TeamHistoryRow[] {
  const ci = new Map<string, TestComparisonResult[]>();
  const local: TestComparisonResult[] = [];
  for (const result of history) {
    if (result.source === 'local') {
      local.push(result);
      continue;
    }
    const key = result.environment?.toLowerCase() ?? '';
    const list = ci.get(key);
    if (list) list.push(result);
    else ci.set(key, [result]);
  }
  const row = (source: TestComparisonSource, results: TestComparisonResult[]): TeamHistoryRow => {
    const counts = rateCounts(results);
    const environment = source === 'ci' ? (results[0]?.environment ?? null) : null;
    return {
      source,
      environment,
      isLocalEnvironment: sameEnvironment(environment, localEnvironment),
      results,
      passRate: passRate(counts),
      flakyRate: flakyRate(counts),
    };
  };
  const latest = (results: readonly TestComparisonResult[]) => results[0]?.startTime ?? 0;
  const rows = [...ci.values()]
    .map((results) => row('ci', results))
    .sort(
      (a, b) =>
        Number(b.isLocalEnvironment) - Number(a.isLocalEnvironment) ||
        Number(a.environment === null) - Number(b.environment === null) ||
        latest(b.results) - latest(a.results),
    );
  if (local.length) rows.push(row('local', local));
  return rows;
}

/** Which rule of the conclusion applied. */
export type TeamConclusionRule =
  | 'same-error-in-ci'
  | 'passes-on-commit'
  | 'passes-on-commit-dirty'
  | 'fails-in-ci-too'
  | 'passes-on-other-commit'
  | 'no-ci-result';

/** The conclusion of a failing local execution, with the facts its sentence names. */
export interface TeamConclusion {
  rule: TeamConclusionRule;
  /** The sentence, in English. */
  text: string;
  /** The environment whose CI results the rule read; null when it read every environment's. */
  environment: string | null;
  /** The CI result the rule names (rules 2 to 4); null otherwise. */
  result: TestComparisonResult | null;
}

/** What the conclusion reads of the local execution. */
export interface LocalExecutionFacts {
  status: string;
  environment: string | null;
  commit: string | null;
  /** Whether the local checkout matched its commit; null when the reporter did not tell. */
  worktree: 'clean' | 'dirty' | null;
  /** The local failure's fingerprint was sent with the question. */
  fingerprinted: boolean;
}

/** Two commits are the same when one starts with the other (a short and a full SHA), at seven characters at least. */
export function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 7 && long.toLowerCase().startsWith(short.toLowerCase());
}

/**
 * The conclusion of a local execution compared with the team instance; null for one that did not fail, which has
 * nothing to explain.
 */
export function teamConclusion(comparison: TestComparison, local: LocalExecutionFacts): TeamConclusion | null {
  if (!FAILED_STATUSES.has(local.status)) return null;
  const environment = local.environment;
  const where = environment ? ` (${environment})` : '';

  if (comparison.cluster && comparison.cluster.ciOccurrences > 0) {
    const times = comparison.cluster.ciOccurrences === 1 ? 'once' : `${comparison.cluster.ciOccurrences} times`;
    return {
      rule: 'same-error-in-ci',
      text: `Same error in CI, seen ${times}: not specific to this machine`,
      environment: null,
      result: null,
    };
  }

  const reference = comparison.history.filter(
    (result) =>
      result.source === 'ci' &&
      !result.incident &&
      (environment === null || sameEnvironment(result.environment, environment)),
  );
  const onCommit = reference.find((result) => result.status === 'passed' && sameCommit(result.commit, local.commit));
  if (onCommit) {
    return local.worktree === 'dirty'
      ? {
          rule: 'passes-on-commit-dirty',
          text: `Passes in CI on this commit${where}, but your checkout has uncommitted changes`,
          environment,
          result: onCommit,
        }
      : {
          rule: 'passes-on-commit',
          text: `Passes in CI on this commit${where}: the failure is likely specific to this machine`,
          environment,
          result: onCommit,
        };
  }

  const latest = reference.find((result) => result.status === 'passed' || FAILED_STATUSES.has(result.status));
  if (latest && FAILED_STATUSES.has(latest.status)) {
    const another = local.fingerprinted && comparison.fingerprintComparable ? ', with another error' : '';
    return {
      rule: 'fails-in-ci-too',
      text: `Fails in CI too${where}${another}`,
      environment,
      result: latest,
    };
  }
  if (latest) {
    const on = latest.branch ? ` on ${latest.branch}` : '';
    return {
      rule: 'passes-on-other-commit',
      text: `Passes in CI${on}${where}, on another commit: the commits differ`,
      environment,
      result: latest,
    };
  }
  return {
    rule: 'no-ci-result',
    text: environment ? `No CI result in ${environment} to compare with` : 'No CI result to compare with',
    environment,
    result: null,
  };
}
