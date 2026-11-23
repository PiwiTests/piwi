/**
 * The database reads a CI re-run makes, shared by the server's dispatch
 * (`server/utils/ci-rerun.ts`) and the demo's: what an execution re-runs, and
 * the branch and commit a dispatch fills its request with. What a dispatch
 * records is `ci-dispatches.ts`. Nothing here sends a request.
 */
import { eq } from 'drizzle-orm';
import { testCases, testRuns, testRunsCases } from '../../server/database/schema';
import { resolveRunBranch } from '../../server/utils/run-branch';
import type { CiServerTarget, CiTemplateValues } from '#shared/ci-server';
import { toPosixPath, type RetryCase } from '#shared/retry-command';
import { runCommit } from '#shared/run-eligibility';
import type { DrizzleDB } from './db';

/** An execution's run, cluster and the one case a re-run of it runs, or null when it does not exist. */
export async function executionRerunTarget(db: DrizzleDB, executionId: number) {
  const [row] = await db
    .select({
      projectId: testRuns.projectId,
      runId: testRunsCases.testRunId,
      clusterId: testRunsCases.failureClusterId,
      line: testRunsCases.line,
      projectName: testRunsCases.browserName,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, executionId));
  if (!row) return null;
  const rerunCase: RetryCase = {
    filePath: row.filePath,
    title: row.title,
    line: row.line,
    projectName: row.projectName || null,
  };
  return { projectId: row.projectId, runId: row.runId, clusterId: row.clusterId, rerunCase };
}

/** The branch and the commit of the run a dispatch re-runs. */
export async function rerunRefAndCommit(
  db: DrizzleDB,
  runId: number | null,
): Promise<{ ref: string | null; commit: string | null }> {
  if (runId == null) return { ref: null, commit: null };
  const [run] = await db
    .select({ branch: testRuns.branch, metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return { ref: null, commit: null };
  return { ref: run.branch ?? resolveRunBranch(run.metadata) ?? null, commit: runCommit(run.metadata) ?? null };
}

/** The values a CI server template is filled with: the run's branch, else the target's `ref` field. */
export async function ciServerValues(
  db: DrizzleDB,
  runId: number | null,
  target: CiServerTarget,
  args: string,
  dispatchId: string,
): Promise<CiTemplateValues> {
  const { ref, commit } = await rerunRefAndCommit(db, runId);
  return { args, dispatchId, ref: ref ?? target.rerun.ref ?? '', commit: commit ?? '' };
}

/** The spec files a dispatch re-runs, as its record lists them. */
export function rerunFiles(cases: RetryCase[]): string[] {
  return [...new Set(cases.map((c) => toPosixPath(c.filePath)))].sort();
}
