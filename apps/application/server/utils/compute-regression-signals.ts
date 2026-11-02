import { eq, inArray } from 'drizzle-orm';
import { projects, testRuns, testRunsCases } from '../database/schema';
import type { DbClient as DB } from '../database';
import { resolveRunBranch } from './run-branch';
import { resolveDefaultBranch } from './scm/default-branch';
import { FALLBACK_DEFAULT_BRANCH } from './scm/git-url';
import { selectBaselineRun } from './branch-baseline';
import { resolveFallbackBranch } from '#shared/handlers/baseline-scope';
import { finalAttempts, flakyFinalAttempts, testKey, testOutcomes } from '#shared/utils/test-counts';

/** Execution ids one flag UPDATE sets at most. */
const UPDATE_BATCH = 500;

/**
 * Compute the isNewRegression and isNewFlaky signals of a finished run, on the
 * final attempt of each repetition of its tests, by comparing against the
 * passing baseline the run-level ladder picks: the same environment first, and
 * within it the same branch, else the branch it forked from, else any branch.
 * The baseline is a complete run the `run-baseline` use reads (the whole suite,
 * no lab run, bisect step, reproduction or environment incident), and each test
 * is compared with its own outcome there in the same Playwright project.
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
    use: 'run-baseline',
  });
  if (!baseline) return;
  const baselineRun = baseline.run;

  // The baseline's outcome of each test per Playwright project: failed there when one of its repetitions failed
  const baselineRows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, baselineRun.id));
  const baselineFlaky = flakyFinalAttempts(baselineRows);

  const baselineByTest = new Map<string, { status: string; flaky: boolean }>();
  for (const bc of testOutcomes(baselineRows)) {
    baselineByTest.set(testKey(bc), { status: bc.status, flaky: baselineFlaky.has(bc) });
  }

  // Fetch current run's cases
  const currentCases = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, runId));
  const currentFlaky = flakyFinalAttempts(currentCases);

  const newRegressionIds: number[] = [];
  const newFlakyIds: number[] = [];

  // Each repetition's final attempt: an earlier attempt of a retried test is not a result of its own.
  for (const cc of finalAttempts(currentCases)) {
    const baseline = baselineByTest.get(testKey(cc));
    if (!baseline) continue;

    // isNewRegression: failed in current, passed in baseline
    const isFail = cc.status === 'failed' || cc.status === 'timedOut' || cc.status === 'timedout';
    if (isFail && baseline.status === 'passed') newRegressionIds.push(cc.id);

    // isNewFlaky: passed after a failed attempt in current, passed without one in baseline
    if (currentFlaky.has(cc) && baseline.status === 'passed' && !baseline.flaky) newFlakyIds.push(cc.id);
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
