/**
 * Suspect lines of an execution or a failure cluster: the lines changed since
 * the last green run that the failing tests executed, ranked by how many
 * passing tests of the same run executed them too
 * (`@piwitests/core/suspect-lines`).
 *
 * The range is the regression context's (`computeRegressionContext`, the
 * baseline ladder the rest of the dashboard uses), from the last green run's
 * commit to the commit of the run the coverage comes from; its changes come
 * from the project's source control provider. Answers are kept five minutes
 * per execution or cluster and range (one minute when the provider failed),
 * and a provider failure answers `no-scm`, never an error.
 */
import {
  clusterSuspectTarget,
  executionSuspectTarget,
  hasFiles,
  joinSuspectChanges,
  readFailingCaptures,
  type SuspectRun,
} from '#shared/handlers/suspect-lines';
import {
  fixPlanSuspectLines,
  unavailableSuspectLines,
  type ClusterSuspectLinesAnswer,
  type SuspectLinesAnswer,
  type SuspectLinesReason,
} from '#shared/suspect-lines';
import type { DbClient } from '../database';
import { computeRegressionContext } from './regression-context';
import type { RunMetadata } from './run-json-types';
import { createScmProvider } from './scm';
import type { ScmChanges } from './scm/ScmProvider';
import { TtlCache } from './ttl-cache';

const ANSWER_TTL_MS = 5 * 60 * 1000;
const FAILED_SCM_TTL_MS = 60 * 1000;
const MAX_CACHED_ANSWERS = 200;

const answers = new TtlCache<SuspectLinesAnswer>(ANSWER_TTL_MS, MAX_CACHED_ANSWERS);
const scmFailures = new TtlCache<SuspectLinesAnswer>(FAILED_SCM_TTL_MS, MAX_CACHED_ANSWERS);

/** The range of a run's suspect lines, or why there is none. */
type SuspectRange =
  | { from: string; to: string; repositoryUrl: string | null; baselineRunId: number }
  | { reason: SuspectLinesReason; known: Pick<SuspectLinesAnswer, 'range' | 'baselineRunId'> };

/** The range from the last green run's commit to the run's, as the regression context gives it. */
async function rangeOf(db: DbClient, run: SuspectRun): Promise<SuspectRange> {
  const regression = await computeRegressionContext(db, run);
  if (!regression.hasGreen) return { reason: 'no-baseline', known: {} };
  const baselineRunId = regression.lastGreenRunId;
  const { lastGreenCommit, currentCommit, commitRange } = regression;
  if (commitRange) {
    return {
      from: commitRange.fromSha,
      to: commitRange.toSha,
      repositoryUrl: commitRange.repositoryUrl,
      baselineRunId,
    };
  }
  if (lastGreenCommit && lastGreenCommit === currentCommit) {
    return { reason: 'no-changes', known: { range: { from: lastGreenCommit, to: currentCommit }, baselineRunId } };
  }
  return { reason: 'no-baseline', known: { baselineRunId } };
}

/** The changes of a range from the project's provider; null when there is none or it failed. */
async function fetchRangeChanges(
  db: DbClient,
  projectId: number,
  repositoryUrl: string | null,
  from: string,
  to: string,
): Promise<ScmChanges | null> {
  if (!repositoryUrl) return null;
  try {
    const provider = await createScmProvider(repositoryUrl, db, projectId);
    return provider ? await provider.fetchChanges(from, to) : null;
  } catch {
    return null;
  }
}

/** The suspect lines of a target's failing executions in its run, kept per `key` and range. */
async function suspectLinesOfRun(
  db: DbClient,
  key: string,
  run: SuspectRun,
  failingIds: number[],
): Promise<SuspectLinesAnswer> {
  const range = await rangeOf(db, run);
  if ('reason' in range) return unavailableSuspectLines(range.reason, range.known);
  const known = { range: { from: range.from, to: range.to }, baselineRunId: range.baselineRunId };
  const cacheKey = `${key}\x00${range.from}..${range.to}`;
  const cached = answers.get(cacheKey) ?? scmFailures.get(cacheKey);
  if (cached) return cached;

  const changes = await fetchRangeChanges(db, run.projectId, range.repositoryUrl, range.from, range.to);
  if (!changes) {
    // Without the changes, whether the failing executions recorded a file at all decides the reason.
    const recorded = (await readFailingCaptures(db, failingIds, [])).some(hasFiles);
    const answer = unavailableSuspectLines(recorded ? 'no-scm' : 'no-coverage', known);
    (recorded ? scmFailures : answers).set(cacheKey, answer);
    return answer;
  }
  const answer = await joinSuspectChanges(db, run, failingIds, changes, known);
  answers.set(cacheKey, answer);
  return answer;
}

/**
 * The suspect lines of one execution: the lines changed between the last
 * green run and its run that it executed, scored against the passing
 * executions of its run. Null when there is no such execution.
 */
export async function suspectLinesForExecution(db: DbClient, executionId: number): Promise<SuspectLinesAnswer | null> {
  const target = await executionSuspectTarget(db, executionId);
  if (!target) return null;
  if (target.reason) return unavailableSuspectLines(target.reason);
  return suspectLinesOfRun(db, `execution:${executionId}`, target.run, target.failingIds);
}

/**
 * The suspect lines of a failure cluster, read in the newest run in which it
 * has failing executions with coverage: the lines changed between the last
 * green run and that run that those executions executed, scored against the
 * passing executions of the run.
 */
export async function suspectLinesForCluster(db: DbClient, clusterId: number): Promise<ClusterSuspectLinesAnswer> {
  const target = await clusterSuspectTarget(db, clusterId);
  if (target.reason) return { ...unavailableSuspectLines(target.reason), runId: target.runId };
  const answer = await suspectLinesOfRun(db, `cluster:${clusterId}:${target.run.id}`, target.run, target.failingIds);
  return { ...answer, runId: target.run.id };
}

/**
 * The suspect lines of a cluster for changes already fetched for `range`:
 * joined with them when the run the cluster's coverage comes from tested the
 * range's head commit (kept per cluster, run and range), the cluster's own
 * answer otherwise, whose range then differs from `range`.
 */
export async function clusterSuspectLinesForChanges(
  db: DbClient,
  clusterId: number,
  changes: ScmChanges,
  range: { from: string; to: string },
): Promise<ClusterSuspectLinesAnswer> {
  const target = await clusterSuspectTarget(db, clusterId);
  if (target.reason) return { ...unavailableSuspectLines(target.reason), runId: target.runId };
  const commit = (target.run.metadata as RunMetadata | null)?.scm?.commit ?? null;
  if (commit !== range.to) return suspectLinesForCluster(db, clusterId);
  const cacheKey = `changes:cluster:${clusterId}:${target.run.id}\x00${range.from}..${range.to}`;
  let answer = answers.get(cacheKey);
  if (!answer) {
    answer = await joinSuspectChanges(db, target.run, target.failingIds, changes, { range });
    answers.set(cacheKey, answer);
  }
  return { ...answer, runId: target.run.id };
}

/**
 * A fix plan with its cluster's top suspect lines; the plan unchanged when
 * they cannot be read. They are read while `plan` resolves, when it is still
 * being built.
 */
export async function withFixPlanSuspectLines<T extends { suspectLines: ClusterSuspectLinesAnswer | null }>(
  db: DbClient,
  clusterId: number,
  plan: T | Promise<T>,
): Promise<T> {
  const [resolved, answer] = await Promise.all([plan, suspectLinesForCluster(db, clusterId).catch(() => null)]);
  return answer ? { ...resolved, suspectLines: fixPlanSuspectLines(answer) } : resolved;
}
