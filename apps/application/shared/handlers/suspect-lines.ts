/**
 * The database reads behind the suspect lines of an execution or a failure
 * cluster: the run whose commit is the head of the range, the failing
 * executions whose coverage is joined with the changed lines, and the coverage
 * of the run's passing executions. The server adds the
 * range and the changes from source control (`server/utils/suspect-lines.ts`);
 * the demo, which reads no source control, answers from this alone.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { CoverageCapture } from '@piwitests/core/coverage';
import { testRuns, testRunsCases } from '../../server/database/schema';
import { getExecutionsCoverage } from '../../server/utils/coverage';
import { FAILED_STATUS_KEYS, isFailedStatus } from '../utils/test-counts';
import type { SuspectLinesReason } from '../suspect-lines';
import type { DrizzleDB } from './db';

/** Failing executions of a cluster's run whose coverage is read, at most. */
const SUSPECT_FAILING_EXECUTIONS = 50;

/** Passing executions of the run whose coverage is read, at most. */
const SUSPECT_PASSING_EXECUTIONS = 200;

/** The run the range ends at, with the fields the regression context reads. */
export interface SuspectRun {
  id: number;
  projectId: number;
  status: string;
  startTime: Date;
  environment: string | null;
  branch: string | null;
  metadata: unknown;
}

/** The run and failing executions to read, or why there are none. */
type SuspectTarget =
  | { reason: SuspectLinesReason; runId: number | null }
  | { reason?: undefined; run: SuspectRun; failingIds: number[] };

async function loadRun(db: DrizzleDB, runId: number): Promise<SuspectRun | null> {
  const [run] = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      status: testRuns.status,
      startTime: testRuns.startTime,
      environment: testRuns.environment,
      branch: testRuns.branch,
      metadata: testRuns.metadata,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  return run ?? null;
}

/**
 * The target of one execution's suspect lines: its run and itself, when it
 * failed and recorded coverage. Null when there is no such execution.
 */
export async function executionSuspectTarget(db: DrizzleDB, executionId: number): Promise<SuspectTarget | null> {
  const [execution] = await db
    .select({
      status: testRunsCases.status,
      runId: testRunsCases.testRunId,
      coveragePayloadId: testRunsCases.coveragePayloadId,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, executionId));
  if (!execution) return null;
  if (!isFailedStatus(execution.status)) return { reason: 'not-failing', runId: execution.runId };
  if (execution.coveragePayloadId == null) return { reason: 'no-coverage', runId: execution.runId };
  const run = await loadRun(db, execution.runId);
  if (!run) return null;
  return { run, failingIds: [executionId] };
}

/** The condition of a cluster's failing executions with coverage. */
function clusterFailingWithCoverage(clusterId: number) {
  return and(
    eq(testRunsCases.failureClusterId, clusterId),
    isNotNull(testRunsCases.coveragePayloadId),
    inArray(testRunsCases.status, [...FAILED_STATUS_KEYS]),
  );
}

/**
 * The target of a cluster's suspect lines: the newest run in which the
 * cluster has failing executions with coverage, and those executions.
 */
export async function clusterSuspectTarget(db: DrizzleDB, clusterId: number): Promise<SuspectTarget> {
  const [newest] = await db
    .select({ runId: testRunsCases.testRunId })
    .from(testRunsCases)
    .where(clusterFailingWithCoverage(clusterId))
    .orderBy(desc(testRunsCases.testRunId))
    .limit(1);
  if (!newest) return { reason: 'no-coverage', runId: null };
  const run = await loadRun(db, newest.runId);
  if (!run) return { reason: 'no-coverage', runId: null };
  const failing = await db
    .select({ id: testRunsCases.id })
    .from(testRunsCases)
    .where(and(clusterFailingWithCoverage(clusterId), eq(testRunsCases.testRunId, run.id)))
    .orderBy(asc(testRunsCases.id))
    .limit(SUSPECT_FAILING_EXECUTIONS);
  return { run, failingIds: failing.map((row) => row.id) };
}

/** The coverage of the failing executions of a target, every file with its ranges. */
export async function readFailingCaptures(db: DrizzleDB, failingIds: number[]): Promise<CoverageCapture[]> {
  const coverage = await getExecutionsCoverage(db, failingIds);
  return failingIds.flatMap((id) => {
    const capture = coverage.get(id);
    return capture ? [capture] : [];
  });
}

/**
 * The coverage of the run's passing executions, the first
 * {@link SUSPECT_PASSING_EXECUTIONS} by id; only the files matching `paths`
 * keep their ranges.
 */
export async function readPassingCaptures(db: DrizzleDB, runId: number, paths: string[]): Promise<CoverageCapture[]> {
  const passing = await db
    .select({ id: testRunsCases.id })
    .from(testRunsCases)
    .where(
      and(
        eq(testRunsCases.testRunId, runId),
        sql`${testRunsCases.status} = 'passed'`,
        isNotNull(testRunsCases.coveragePayloadId),
      ),
    )
    .orderBy(asc(testRunsCases.id))
    .limit(SUSPECT_PASSING_EXECUTIONS);
  const ids = passing.map((row) => row.id);
  const coverage = await getExecutionsCoverage(db, ids, { rangesFor: paths });
  return ids.flatMap((id) => {
    const capture = coverage.get(id);
    return capture ? [capture] : [];
  });
}
