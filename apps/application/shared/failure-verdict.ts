/**
 * The verdict on one failing execution: the one-line headline plus the facts
 * the dashboard already stores about it — why it failed (a new regression, a
 * retry pass, a flaky start, an infrastructure error), since when (the
 * cluster's first failing run, the commit the run was on), which cluster it
 * shares with how many other tests in the run, and who owns the test. A test
 * that passed on retry gets the verdict of its failed attempt, which names
 * that attempt.
 *
 * Pure assembly over rows the caller has already loaded, so the server route,
 * the demo mirror and the MCP tools build the same object.
 */
import { describeCluster, type DescribableCluster } from '#shared/describe-cluster';
import {
  describeFailureText,
  failingStepParams,
  stepHeadlineContext,
  type FailureDescription,
  type HeadlineStepLike,
} from '#shared/describe-failure';
import { parsePlaywrightError, type ParsedErrorKind } from '#shared/error-parse';

export type FailureWhy = 'new-regression' | 'passed-on-retry' | 'new-flaky' | 'infrastructure';

export interface FailureVerdictCommit {
  sha: string;
  shortSha: string;
  author: string | null;
  message: string | null;
  branch: string | null;
}

export interface FailureVerdict extends FailureDescription {
  kind: ParsedErrorKind;
  /** The locator the error names, as Playwright code. */
  locator: string | null;
  isLocatorResolutionFailure: boolean;
  why: FailureWhy | null;
  since: {
    /** The first run the cluster failed in; this run for an unclustered failure. */
    firstFailingRunId: number;
    firstFailingAt: string | Date | null;
    /** True when this run is the first the failure was seen in. */
    isFirstFailure: boolean;
    /** The commit and author the run reported, when the reporter collected SCM metadata. */
    commit: FailureVerdictCommit | null;
    /**
     * The earlier fix that did not hold — set when the execution's cluster
     * carries a fix verification that later regressed. Null otherwise.
     */
    fixedBefore: {
      commit: string | null;
      commitShort: string | null;
      runId: number | null;
      at: string | Date | null;
    } | null;
  };
  cluster: {
    id: number;
    /** The cluster's display name — its AI title when it has one, else the deterministic title. */
    name: string;
    /** How many other tests in this run share the cluster. */
    otherTestsInRun: number;
  } | null;
  owner: VerdictOwner | null;
  /**
   * The attempt the headline comes from when it is not this execution: the
   * failed attempt of a test that passed on retry, with the execution that
   * holds it. Null when the headline is this execution's own error.
   */
  attempt: VerdictAttempt | null;
}

/** An attempt of the same run, test and browser, and the execution that holds it. */
export interface VerdictAttempt {
  /** Playwright's retry index: 0 is the first attempt. */
  retry: number;
  executionId: number;
}

/** Who owns a failing test, and where that came from. */
export interface VerdictOwner {
  name: string;
  source: 'annotation' | 'codeowners';
}

/**
 * The headline for a stored execution: the parsed error, read with the recorded
 * steps — the failed step's title feeds a test-timeout line, its params back the
 * locator where the error text names none, and a failure in a hook or a fixture
 * names it. Null when the execution has no error.
 */
export function caseHeadline(row: { error?: string | null; steps?: unknown }): FailureDescription | null {
  const steps = Array.isArray(row.steps) ? (row.steps as HeadlineStepLike[]) : null;
  return describeFailureText(row.error, stepHeadlineContext(steps, row.error));
}

export interface FailureVerdictInput {
  error: string | null | undefined;
  steps?: unknown;
  status: string;
  /** Passed after an earlier attempt of its result failed or timed out (`passed_after_failure`). */
  passedAfterFailure?: boolean | number | null;
  /** Stored as 0/1 in SQLite, so numbers are accepted alongside booleans. */
  isNewRegression?: boolean | number | null;
  isNewFlaky?: boolean | number | null;
  runId: number;
  /** `metadata.scm` of the run, as the reporter recorded it. */
  scm?: {
    commit?: string | null;
    branch?: string | null;
    author?: string | null;
    commitMessage?: string | null;
  } | null;
  cluster?:
    | (DescribableCluster & {
        id: number;
        firstSeenRunId: number;
        firstSeenAt?: string | Date | null;
        sameRunCaseCount: number;
        /** Fix-verification facts, so a regressed fix surfaces as `since.fixedBefore`. */
        fixVerification?: string | null;
        fixCommit?: string | null;
        fixLandedRunId?: number | null;
        fixLandedAt?: string | Date | null;
      })
    | null;
  /** The test's `piwi:owner` annotation, or an owner resolved elsewhere with its source. */
  owner?: string | VerdictOwner | null;
  /**
   * The attempt `error` and `steps` were read from, when it is not the
   * execution `status` describes (the failed attempt of a pass after a failure).
   */
  fromAttempt?: VerdictAttempt | null;
}

/** Cluster error kinds that point at the environment rather than the test or the app. */
const INFRASTRUCTURE_KINDS = new Set<ParsedErrorKind>(['crash', 'navigation']);

function classifyWhy(input: FailureVerdictInput, kind: ParsedErrorKind): FailureWhy | null {
  if (input.isNewRegression) return 'new-regression';
  if (input.status === 'passed' && input.passedAfterFailure) return 'passed-on-retry';
  if (input.isNewFlaky) return 'new-flaky';
  if (
    INFRASTRUCTURE_KINDS.has(kind) ||
    input.cluster?.errorType === 'crash' ||
    input.cluster?.errorType === 'navigation'
  )
    return 'infrastructure';
  return null;
}

/** Build the verdict for an execution, or null when it carries no error. */
export function buildFailureVerdict(input: FailureVerdictInput): FailureVerdict | null {
  if (!input.error || !input.error.trim()) return null;
  const steps = Array.isArray(input.steps) ? (input.steps as HeadlineStepLike[]) : null;
  const parsed = parsePlaywrightError(input.error, { stepParams: failingStepParams(steps, input.error) });
  const description = caseHeadline({ error: input.error, steps: input.steps });
  if (!description) return null;

  const sha = input.scm?.commit?.trim() || null;
  const cluster = input.cluster ?? null;

  // A cluster whose recorded fix regressed carries the "fixed once before, the
  // fix did not hold" fact; it belongs to the situation, not the clue list.
  const fixSha = cluster?.fixCommit?.trim() || null;
  const fixedBefore =
    cluster && cluster.fixVerification === 'regressed' && (fixSha || cluster.fixLandedRunId != null)
      ? {
          commit: fixSha,
          commitShort: fixSha ? fixSha.slice(0, 7) : null,
          runId: cluster.fixLandedRunId ?? null,
          at: cluster.fixLandedAt ?? null,
        }
      : null;

  return {
    ...description,
    kind: parsed.kind,
    locator: parsed.locator,
    isLocatorResolutionFailure: parsed.isLocatorResolutionFailure,
    why: classifyWhy(input, parsed.kind),
    since: {
      firstFailingRunId: cluster?.firstSeenRunId ?? input.runId,
      firstFailingAt: cluster?.firstSeenAt ?? null,
      isFirstFailure: (cluster?.firstSeenRunId ?? input.runId) === input.runId,
      commit: sha
        ? {
            sha,
            shortSha: sha.slice(0, 7),
            author: input.scm?.author?.trim() || null,
            message: input.scm?.commitMessage?.trim() || null,
            branch: input.scm?.branch?.trim() || null,
          }
        : null,
      fixedBefore,
    },
    cluster: cluster
      ? { id: cluster.id, name: describeCluster(cluster), otherTestsInRun: Math.max(0, cluster.sameRunCaseCount - 1) }
      : null,
    owner: !input.owner
      ? null
      : typeof input.owner === 'string'
        ? { name: input.owner, source: 'annotation' }
        : input.owner,
    attempt: input.fromAttempt ?? null,
  };
}
