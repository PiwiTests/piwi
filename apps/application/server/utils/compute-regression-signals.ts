import { eq, inArray } from 'drizzle-orm';
import { projects, testRuns, testRunsCases } from '../database/schema';
import type { DbClient as DB } from '../database';
import { resolveRunBranch } from './run-branch';
import { resolveDefaultBranch } from './scm/default-branch';
import { FALLBACK_DEFAULT_BRANCH } from './scm/git-url';
import { selectBaselineRun } from './branch-baseline';
import { resolveFallbackBranch } from '#shared/handlers/baseline-scope';

/** Execution ids one flag UPDATE sets at most. */
const UPDATE_BATCH = 500;

/**
 * Compute isNewRegression and isNewFlaky signals for all test_runs_cases
 * in a finished run by comparing against the passing baseline the run-level
 * ladder picks: the same environment first, and within it the same branch,
 * else the branch it forked from, else any branch.
 */
export async function computeRegressionSignals(db: DB, runId: number): Promise<void> {
  const runResults: any[] = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      startTime: testRuns.startTime,
      branch: testRuns.branch,
      environment: testRuns.environment,
      metadata: testRuns.metadata,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));

  const run = runResults[0];
  if (!run) return;

  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const branch = run.branch ?? resolveRunBranch(run.metadata);
  const defaultBranch = project ? await resolveDefaultBranch(db, project, run.metadata) : FALLBACK_DEFAULT_BRANCH;

  const baseline = await selectBaselineRun(db, {
    projectId: run.projectId,
    before: run.startTime,
    branch,
    environment: run.environment ?? null,
    fallbackBranch: resolveFallbackBranch(run.metadata, defaultBranch).branch,
  });
  if (!baseline) return;
  const baselineRun = baseline.run;

  // Fetch baseline case statuses and retries
  const baselineCases: any[] = await db
    .select({ testCaseId: testRunsCases.testCaseId, status: testRunsCases.status, retries: testRunsCases.retries })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, baselineRun.id));

  const baselineByCaseId = new Map<number, { status: string; retries: number }>();
  for (const bc of baselineCases) {
    // Only keep the best result (passed beats failed)
    const existing = baselineByCaseId.get(bc.testCaseId);
    if (!existing || bc.status === 'passed') {
      baselineByCaseId.set(bc.testCaseId, { status: bc.status, retries: bc.retries ?? 0 });
    }
  }

  // Fetch current run's cases
  const currentCases: any[] = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, runId));

  const newRegressionIds: number[] = [];
  const newFlakyIds: number[] = [];

  for (const cc of currentCases) {
    const baseline = baselineByCaseId.get(cc.testCaseId);
    if (!baseline) continue;

    // isNewRegression: failed in current, passed in baseline
    const isFail = cc.status === 'failed' || cc.status === 'timedOut' || cc.status === 'timedout';
    if (isFail && baseline.status === 'passed') newRegressionIds.push(cc.id);

    // isNewFlaky: retry-pass in current, no retries + passed in baseline
    if (cc.status === 'passed' && (cc.retries ?? 0) > 0 && baseline.retries === 0 && baseline.status === 'passed') {
      newFlakyIds.push(cc.id);
    }
  }

  // One UPDATE per flag and batch of ids, within the database's bound-parameter limit.
  for (let i = 0; i < newRegressionIds.length; i += UPDATE_BATCH) {
    await db
      .update(testRunsCases)
      .set({ isNewRegression: 1 })
      .where(inArray(testRunsCases.id, newRegressionIds.slice(i, i + UPDATE_BATCH)));
  }
  for (let i = 0; i < newFlakyIds.length; i += UPDATE_BATCH) {
    await db
      .update(testRunsCases)
      .set({ isNewFlaky: 1 })
      .where(inArray(testRunsCases.id, newFlakyIds.slice(i, i + UPDATE_BATCH)));
  }
}
