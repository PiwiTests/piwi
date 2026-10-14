/**
 * The database reads behind the suspect lines of an execution or a failure
 * cluster: the run whose commit is the head of the range, the failing
 * executions whose coverage is joined with the changed lines, the coverage of
 * the run's passing executions, and the join of a range's changes with them.
 * The server adds the range and the changes from source control
 * (`server/utils/suspect-lines.ts`); the demo joins the changes of its canned
 * history (`app/demo/api/suspect-lines.ts`).
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { CoverageCapture } from '@piwitests/core/coverage';
import { diffFileFromPatch, type DiffFile } from '@piwitests/core/diff-anchors';
import { suspectLines, type SuspectChange } from '@piwitests/core/suspect-lines';
import { testRuns, testRunsCases } from '../../server/database/schema';
import { getExecutionsCoverage } from '../../server/utils/coverage';
import { FAILED_STATUS_KEYS, isFailedStatus } from '../utils/test-counts';
import { unavailableSuspectLines, type SuspectLinesAnswer, type SuspectLinesReason } from '../suspect-lines';
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

/** A range's changed files, as a source control provider gives them. */
export interface SuspectRangeChanges {
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    blob?: string;
  }>;
  /** true when the provider left out every patch, the diff being too large. */
  patchesOmitted?: boolean;
}

/** A provider's file status as the diff names it. */
function changeStatus(status: string): DiffFile['status'] {
  if (status === 'removed' || status === 'deleted') return 'deleted';
  if (status === 'added' || status === 'renamed') return status;
  return 'modified';
}

/**
 * A provider's changed files, with the hunks of their patches (a file without
 * a patch has none) and the blob id at the head where the provider gives it.
 */
function suspectChangesOf(files: SuspectRangeChanges['files']): SuspectChange[] {
  return files.map((file) => {
    const status = changeStatus(file.status);
    const hunks = file.patch ? diffFileFromPatch(file.filename, file.patch, status).hunks : [];
    return { path: file.filename, status, hunks, ...(file.blob ? { headBlob: file.blob } : {}) };
  });
}

/**
 * Join a range's changes with the coverage of the failing executions and of
 * the run's passing ones. With no changed line on the head side, `no-scm` when
 * the provider left out the patches of files whose lines changed, `no-changes`
 * otherwise.
 */
export async function joinSuspectChanges(
  db: DrizzleDB,
  run: Pick<SuspectRun, 'id'>,
  failing: CoverageCapture[],
  changes: SuspectRangeChanges,
  known: Pick<SuspectLinesAnswer, 'range' | 'baselineRunId'>,
): Promise<SuspectLinesAnswer> {
  if (changes.patchesOmitted) return unavailableSuspectLines('no-scm', known);
  const changed = suspectChangesOf(changes.files);
  if (!changed.some((c) => c.status !== 'deleted' && c.hunks.length > 0)) {
    const unread = changes.files.some(
      (f) => !f.patch && changeStatus(f.status) !== 'deleted' && f.additions + f.deletions > 0,
    );
    return unavailableSuspectLines(unread ? 'no-scm' : 'no-changes', known);
  }
  const paths = changed.filter((c) => c.hunks.length > 0).map((c) => c.path);
  const passing = await readPassingCaptures(db, run.id, paths);
  const result = suspectLines({ changes: changed, failing, passing });
  if (result.summary.changedLines === 0) return unavailableSuspectLines('no-changes', known);
  return { available: true, ...known, summary: result.summary, suspects: result.suspects };
}
