/**
 * Compare with team instance, as the desktop app reads the team instance's answer (`TestComparison`): the test's team
 * history grouped by environment, and the one-line conclusion a failing local execution gets. Pure, so the desktop
 * app's server and its pages read it the same way.
 *
 * The local run's environment is the one the team instance resolved its label to (`localEnvironment`), so an alias
 * reads as its environment. The conclusion reads the reference results (`source: 'ci'`) alone, of that environment
 * when the run has one, leaving out the runs marked as an environment incident, and takes the first rule that applies:
 * 1. the CI saw the same error recently, in that environment (the cluster of the same fingerprint);
 * 2. the latest CI result on the local commit passed (said differently when the local checkout had uncommitted
 *    changes);
 * 3. the latest CI result on the local commit, else the latest one, failed;
 * 4. the latest CI result passed, on another commit or one that cannot be compared;
 * 5. no CI result.
 */
import type { TestComparison, TestComparisonResult, TestComparisonSource } from './test-comparison';

/** The results counted as failed by every pass rate: failed and timed out. */
const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'timedOut']);

/** How recent the CI's last sight of the same error must be for rule 1. */
export const SAME_ERROR_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/** A row of the team history: one environment's CI results, or the teammates' shared runs. */
export interface TeamHistoryRow {
  source: TestComparisonSource;
  /** The environment's key; null for the results with none, and for the teammates' row. */
  environment: string | null;
  /** The local run's environment. */
  isLocalEnvironment: boolean;
  /** Newest first. */
  results: TestComparisonResult[];
}

const sameEnvironment = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** The local run's environment as the team instance resolved it, else as the run labelled it. */
function localEnvironmentOf(comparison: TestComparison, label: string | null): string | null {
  return label === null ? null : (comparison.localEnvironment ?? label);
}

/**
 * The team history in rows: one row per environment the CI ran the test in, the local run's environment first, then
 * the others by their latest result, the results with no environment last; then the teammates' shared runs in one
 * row. Each row keeps its results newest first.
 */
export function teamHistoryRows(comparison: TestComparison, localLabel: string | null): TeamHistoryRow[] {
  const localEnvironment = localEnvironmentOf(comparison, localLabel);
  const ci = new Map<string, TestComparisonResult[]>();
  const local: TestComparisonResult[] = [];
  for (const result of comparison.history) {
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
    const environment = source === 'ci' ? (results[0]?.environment ?? null) : null;
    return { source, environment, isLocalEnvironment: sameEnvironment(environment, localEnvironment), results };
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
  /** The local run's environment label. */
  environment: string | null;
  commit: string | null;
  /** Whether the local checkout matched its commit; null when the reporter did not tell. */
  worktree: 'clean' | 'dirty' | null;
  /** The local failure's fingerprint was sent with the question. */
  fingerprinted: boolean;
  /** Now, epoch ms: rule 1 reads only a recent sight of the same error. */
  now: number;
}

/** Two commits are the same when one starts with the other (a short and a full SHA), at seven characters at least. */
export function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 7 && long.toLowerCase().startsWith(short.toLowerCase());
}

const decided = (result: TestComparisonResult) => result.status === 'passed' || FAILED_STATUSES.has(result.status);

/**
 * The conclusion of a local execution compared with the team instance; null for one that did not fail, which has
 * nothing to explain.
 */
export function teamConclusion(comparison: TestComparison, local: LocalExecutionFacts): TeamConclusion | null {
  if (!FAILED_STATUSES.has(local.status)) return null;
  const environment = localEnvironmentOf(comparison, local.environment);
  const where = environment ? ` (${environment})` : '';

  const cluster = comparison.cluster;
  if (
    cluster &&
    cluster.ciOccurrences > 0 &&
    cluster.ciLastSeen !== null &&
    local.now - cluster.ciLastSeen <= SAME_ERROR_WITHIN_MS &&
    (environment === null || cluster.ciEnvironments.some((seen) => sameEnvironment(seen, environment)))
  ) {
    const times = cluster.ciOccurrences === 1 ? 'once' : `${cluster.ciOccurrences} times`;
    return {
      rule: 'same-error-in-ci',
      text: `Same error in CI${where}, seen ${times}: not specific to this machine`,
      environment,
      result: null,
    };
  }

  const reference = comparison.history.filter(
    (result) =>
      result.source === 'ci' &&
      !result.incident &&
      decided(result) &&
      (environment === null || sameEnvironment(result.environment, environment)),
  );
  const onCommit = reference.find((result) => sameCommit(result.commit, local.commit));
  if (onCommit?.status === 'passed') {
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

  const latest = onCommit ?? reference[0];
  if (latest && FAILED_STATUSES.has(latest.status)) {
    const onThisCommit = latest === onCommit ? ' on this commit' : '';
    const another = local.fingerprinted && comparison.fingerprintComparable ? ', with another error' : '';
    return {
      rule: 'fails-in-ci-too',
      text: `Fails in CI too${onThisCommit}${where}${another}`,
      environment,
      result: latest,
    };
  }
  if (latest) {
    const on = latest.branch ? ` on ${latest.branch}` : '';
    const commits =
      local.commit && latest.commit ? 'on another commit: the commits differ' : 'but the commits cannot be compared';
    return {
      rule: 'passes-on-other-commit',
      text: `Passes in CI${on}${where}, ${commits}`,
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
